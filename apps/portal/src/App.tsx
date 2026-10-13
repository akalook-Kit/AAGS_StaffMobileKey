import { createContext, useContext, useEffect, useState, type FormEvent } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { Permission } from '@smk/shared';
import { api, auth } from './api';
import { ErrorNote, applyBrand, useApi } from './ui';
import { Overview } from './pages/Overview';
import { StaffPage } from './pages/Staff';
import { KeysPage } from './pages/Keys';
import { OperatorsPage } from './pages/Operators';
import { ConnectorPage } from './pages/Connector';
import { BrandingPage } from './pages/Branding';
import { SettingsPage } from './pages/Settings';
import { AuditPage } from './pages/Audit';
import { AccountPage } from './pages/Account';
import { BatteryPage } from './pages/Battery';
import { MaintenancePage } from './pages/Maintenance';

export interface Me {
  id: string; email: string; displayName: string; isPlatformAdmin: boolean; mfaEnabled: boolean;
  hotels: { id: string; slug: string; name: string; roles: string[]; permissions: Permission[] }[];
  roleLabels: Record<string, string>;
}
interface Ctx { me: Me; hotel: Me['hotels'][number]; can: (p: Permission) => boolean; branding: any; reloadBranding: () => void; base: string }
const HotelCtx = createContext<Ctx | null>(null);
export const useHotel = () => useContext(HotelCtx)!;

export function App() {
  const [token, setToken] = useState(auth.token);
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    const out = () => { setToken(null); setMe(null); };
    window.addEventListener('smk:signed-out', out);
    return () => window.removeEventListener('smk:signed-out', out);
  }, []);
  useEffect(() => { if (token) api<Me>('/api/v1/me').then(setMe).catch(() => setToken(null)); }, [token]);
  if (!token) return <Login onSignedIn={(t) => { auth.set(t); setToken(t); }} />;
  if (!me) return <div className="empty">Loading…</div>;
  if (!me.hotels.length) return <div className="empty">Your account is not a member of any hotel yet. Ask a hotel administrator to add you.</div>;
  return <BrowserRouter><Shell me={me} onSignOut={() => { auth.set(null); setToken(null); setMe(null); }} /></BrowserRouter>;
}

function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [hotelId, setHotelId] = useState(() => { try { return localStorage.getItem('smk.hotel') ?? me.hotels[0]!.id; } catch { return me.hotels[0]!.id; } });
  const hotel = me.hotels.find((h) => h.id === hotelId) ?? me.hotels[0]!;
  const base = `/api/v1/hotels/${hotel.id}`;
  const branding = useApi<any>(`${base}/config/branding`, [hotel.id]);
  const pending = useApi<any[]>(hotel.permissions.includes('key.approve_broad') ? `${base}/keys?status=PENDING_APPROVAL` : null, [hotel.id], 15_000);
  // Phase 2 modules appear only when the hotel has them switched on and the role allows them.
  const attention = useApi<any>(hotel.permissions.includes('resources.read') ? `${base}/attention` : null, [hotel.id], 30_000);
  const b = branding.data?.data;
  useEffect(() => {
    applyBrand(b);
    document.title = b?.portalTitle ?? `${hotel.name} · Staff access`;
  }, [b, hotel.name]);
  const can = (p: Permission) => hotel.permissions.includes(p);
  const initials = hotel.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  const pendingCount = pending.data?.length ?? 0;

  return (
    <HotelCtx.Provider value={{ me, hotel, can, branding: b, reloadBranding: branding.reload, base }}>
      <div className="shell">
        <aside className="rail">
          {b?.logo ? (
            <div className="hotel has-logo"><img src={b.logo} alt={hotel.name} /><span>{hotel.name} · Staff access</span></div>
          ) : (
            <div className="hotel">
              <div className="mark" aria-hidden>{initials}</div>
              <div><strong>{hotel.name}</strong><span>Staff access</span></div>
            </div>
          )}
          {me.hotels.length > 1 && (
            <select aria-label="Hotel" value={hotel.id} onChange={(e) => { setHotelId(e.target.value); try { localStorage.setItem('smk.hotel', e.target.value); } catch { /* ignore */ } }}>
              {me.hotels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          )}
          <nav aria-label="Main">
            <NavLink to="/" end>Overview</NavLink>
            {can('staff.read') && <NavLink to="/staff">Staff</NavLink>}
            {can('key.read') && <NavLink to="/keys">Mobile keys {pendingCount > 0 && <span className="count" title="Awaiting approval">{pendingCount}</span>}</NavLink>}
            {can('operators.manage') && <NavLink to="/operators">Operators</NavLink>}
            {can('connector.read') && <NavLink to="/connector">Connector health</NavLink>}
            {can('branding.manage') && <NavLink to="/branding">Mobile app settings</NavLink>}
            {can('settings.manage') && <NavLink to="/settings">Settings</NavLink>}
            {can('audit.read') && <NavLink to="/audit">Audit trail</NavLink>}
            {can('battery.read') && attention.data?.batteryMonitoring && <NavLink to="/battery">Battery status {(attention.data.battery?.critical ?? 0) > 0 && <span className="count" title="Critical lock batteries">{attention.data.battery.critical}</span>}</NavLink>}
            {can('maintenance.read') && attention.data?.maintenance && <NavLink to="/maintenance">Maintenance {(attention.data.maintenance?.open ?? 0) > 0 && <span className="count" title="Open requests">{attention.data.maintenance.open}</span>}</NavLink>}
          </nav>
          <div className="foot">
            <div><NavLink to="/account" style={{ color: 'inherit' }}>{me.displayName}</NavLink></div>
            <div style={{ opacity: 0.7 }}>{hotel.roles.map((r) => me.roleLabels[r] ?? r).join(', ')}</div>
            <button onClick={onSignOut}>Sign out</button>
          </div>
        </aside>
        <main className="content" key={hotel.id}>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/staff" element={<StaffPage />} />
            <Route path="/keys" element={<KeysPage />} />
            <Route path="/keys/:keyId" element={<KeysPage />} />
            <Route path="/operators" element={<OperatorsPage />} />
            <Route path="/connector" element={<ConnectorPage />} />
            <Route path="/branding" element={<BrandingPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/battery" element={<BatteryPage />} />
            <Route path="/battery/:doorId" element={<BatteryPage />} />
            <Route path="/maintenance" element={<MaintenancePage />} />
            <Route path="/maintenance/:ticketId" element={<MaintenancePage />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </HotelCtx.Provider>
  );
}

/** Hotel shown on the sign-in page: ?hotel=<slug> in the URL, else the build default. */
const LOGIN_HOTEL = new URLSearchParams(location.search).get('hotel') ?? (import.meta.env.VITE_DEFAULT_HOTEL as string | undefined) ?? 'k-hotel-bana';

function Login({ onSignedIn }: { onSignedIn: (t: string) => void }) {
  const [brand, setBrand] = useState<any>(null);
  useEffect(() => {
    api(`/mobile/v1/config?hotel=${encodeURIComponent(LOGIN_HOTEL)}`).then((c) => { setBrand({ ...c.branding, hotelName: c.hotel?.name }); applyBrand(c.branding); if (c.branding?.portalTitle) document.title = c.branding.portalTitle; }).catch(() => {});
  }, []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api('/api/v1/auth/login', { body: { email, password, ...(needTotp ? { totp } : {}) } });
      if (r.mfaRequired) setNeedTotp(true); else onSignedIn(r.token);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <div className="side">
        {brand?.logo ? <img className="brand-logo" src={brand.logo} alt={brand.hotelName ?? 'Hotel'} /> : <div className="keytag" aria-hidden>101</div>}
        <div>
          <h1 style={{ fontSize: 30, maxWidth: '16ch' }}>Door access for hotel staff, issued from one place.</h1>
          <p style={{ opacity: 0.8, marginTop: 10 }}>Issue and revoke staff mobile keys through your hotel's Visionline system, with an audit trail for every door.</p>
        </div>
      </div>
      <form onSubmit={submit}>
        <h1 style={{ marginBottom: 20 }}>Sign in</h1>
        <ErrorNote error={error} />
        {!needTotp ? (
          <>
            <div className="field"><label htmlFor="em">Work email</label><input id="em" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
            <div className="field"><label htmlFor="pw">Password</label><input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          </>
        ) : (
          <div className="field"><label htmlFor="otp">Authentication code</label><input id="otp" inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} autoFocus required /><span className="hint">The 6-digit code from your authenticator app.</span></div>
        )}
        <button className="btn primary" disabled={busy} style={{ width: '100%', justifyContent: 'center', padding: 10 }}>{busy ? 'Signing in…' : needTotp ? 'Verify' : 'Sign in'}</button>
      </form>
    </div>
  );
}
