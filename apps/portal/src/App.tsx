import { createContext, useContext, useEffect, useState, type FormEvent } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { AccessPage } from './pages/Access';
import { LicenceBanner } from './components/Licence';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Permission } from '@smk/shared';
import { api, auth } from './api';
import { ErrorNote, applyBrand, useApi , setThemePref, themePref, type ThemePref } from './ui';
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
import { InsightsPage } from './pages/Insights';
import { EventLogPage } from './pages/EventLog';
import { MonitoringPage } from './pages/Monitoring';
import { AttendancePage } from './pages/Attendance';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SetupPage } from './pages/Setup';
import { VisionlinePage } from './pages/Visionline';
import { BreakfastPage } from './pages/Breakfast';
import { MusterPage } from './pages/Muster';
import { EmergencyPage } from './pages/Emergency';
import { IdCardsPage } from './pages/IdCards';
import { UsagePage } from './pages/Usage';
import { HelpPage } from './pages/Help';
import { KeycardsPage } from './pages/Keycards';
import { SetupReportPage } from './pages/SetupReport';
import { PublicRequestPage } from './pages/PublicRequest';

export interface Me {
  id: string; email: string; displayName: string; isPlatformAdmin: boolean; mfaEnabled: boolean;
  hotels: { id: string; slug: string; name: string; roles: string[]; permissions: Permission[]; hiddenModules?: string[]; mfaRequired?: boolean }[];
  modules?: Record<string, string>;
  roleLabels: Record<string, string>;
  prefs?: { hiddenNav?: string[]; theme?: 'system' | 'light' | 'dark' };
}
interface Ctx { me: Me; hotel: Me['hotels'][number]; can: (p: Permission) => boolean; branding: any; reloadBranding: () => void; base: string; pages: { to: string; label: string }[]; setPrefs: (p: NonNullable<Me['prefs']>) => void }
const HotelCtx = createContext<Ctx | null>(null);
export const useHotel = () => useContext(HotelCtx)!;

export function App() {
  const [token, setToken] = useState(auth.token);
  const [me, setMe] = useState<Me | null>(null);
  // 2.9 A new on-premises installation opens on the first-run setup page until the hotel is set up.
  const [setup, setSetup] = useState<any>(undefined);
  useEffect(() => { api('/api/v1/setup').then(setSetup).catch(() => setSetup(null)); }, []);
  useEffect(() => {
    const out = () => { setToken(null); setMe(null); };
    window.addEventListener('smk:signed-out', out);
    return () => window.removeEventListener('smk:signed-out', out);
  }, []);
  useEffect(() => { if (token) api<Me>('/api/v1/me').then(setMe).catch(() => setToken(null)); }, [token]);
  // 2.14 The keycard request page behind the QR code needs no sign-in.
  const pub = /^\/request\/([A-Za-z0-9_-]{20,64})$/.exec(location.pathname);
  if (pub) return <PublicRequestPage token={pub[1]!} />;
  if (setup === undefined && !token) return <div className="empty">Loading…</div>;
  if (setup?.needed) return <SetupPage info={setup} />;
  if (!token) return <Login onSignedIn={(t) => { auth.set(t); setToken(t); }} />;
  if (!me) return <div className="empty">Loading…</div>;
  if (!me.hotels.length) return <div className="empty">Your account is not a member of any hotel yet. Ask a hotel administrator to add you.</div>;
  return <BrowserRouter><Shell me={me} onSignOut={() => { auth.set(null); setToken(null); setMe(null); }} /></BrowserRouter>;
}

function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  const [prefs, setPrefs] = useState(me.prefs ?? {});
  // A person's appearance follows them to any computer (unless this computer already has a choice).
  useEffect(() => { try { if (me.prefs?.theme && !localStorage.getItem('smk.theme')) setThemePref(me.prefs.theme); } catch { /* ignore */ } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const vis = (to: string) => !(prefs.hiddenNav ?? []).includes(to);
  useEffect(() => setMenu(false), [loc.pathname, loc.search]);
  const [hotelId, setHotelId] = useState(() => { try { return localStorage.getItem('smk.hotel') ?? me.hotels[0]!.id; } catch { return me.hotels[0]!.id; } });
  const hotel = me.hotels.find((h) => h.id === hotelId) ?? me.hotels[0]!;
  const base = `/api/v1/hotels/${hotel.id}`;
  // 2.13 Usage: which pages are opened (counted on this server, once a minute per page and person).
  useEffect(() => {
    const area = loc.pathname === '/' ? 'overview' : loc.pathname.split('/')[1];
    if (area) void api(`${base}/usage/ping`, { body: { area } }).catch(() => undefined);
  }, [loc.pathname, base]);
  const emergency = useApi<any>(hotel.permissions.includes('muster.read') ? `${base}/emergency/status` : null, [hotel.id], 30_000);
  const branding = useApi<any>(`${base}/config/branding`, [hotel.id]);
  const pending = useApi<any[]>(hotel.permissions.includes('key.approve_broad') ? `${base}/keys?status=PENDING_APPROVAL` : null, [hotel.id], 15_000);
  // Phase 2 modules appear only when the hotel has them switched on and the role allows them.
  const attention = useApi<any>(hotel.permissions.includes('resources.read') || hotel.permissions.includes('breakfast.read') ? `${base}/attention` : null, [hotel.id], 30_000);
  const mon = useApi<any>(hotel.permissions.includes('alerts.read') ? `${base}/monitoring/summary` : null, [hotel.id], 30_000);
  // Red band on every page while a critical system alert (disk space, connector, Visionline) is open.
  const banner = useApi<any[]>(hotel.permissions.includes('alerts.read') ? `${base}/monitoring/banner` : null, [hotel.id], 60_000);
  const b = branding.data?.data;
  useEffect(() => {
    applyBrand(b);
    document.title = b?.portalTitle ?? `${hotel.name} · Staff access`;
  }, [b, hotel.name]);
  const can = (p: Permission) => hotel.permissions.includes(p);
  const initials = hotel.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  const pendingCount = pending.data?.length ?? 0;
  const pageList = ([
    ['/', 'Overview', true], ['/insights', 'Insights', can('reports.read')], ['/insights?page=mine', 'My reports', can('reports.read')], ['/insights?page=build', 'Build a report', can('reports.read')],
    ['/access', 'Access history', can('events.read')], ['/events', 'Event log', can('events.read')], ['/monitoring', 'Monitoring', can('alerts.read')],
    ['/muster', 'Live occupancy', can('muster.read')], ['/emergency', 'Emergency', can('muster.read')],
    ['/visionline', 'Visionline cards & people', can('reports.read')], ['/visionline?tab=lookup', 'Card lookup', can('reports.read')], ['/idcards', 'Staff ID cards', can('idcards.manage')], ['/keycards', 'Staff keycards', can('keycards.request') || can('keycards.read') || can('lockout.request') || can('lockout.approve')], ['/staff', 'Staff', can('staff.read')], ['/keys', 'Mobile keys', can('key.read')],
    ['/attendance', 'Time & attendance', can('attendance.clock')], ['/breakfast', 'Breakfast', can('breakfast.read') && Boolean(attention.data?.breakfast)],
    ['/battery', 'Battery status', can('battery.read') && Boolean(attention.data?.batteryMonitoring)], ['/maintenance', 'Maintenance', can('maintenance.read') && Boolean(attention.data?.maintenance)],
    ['/operators', 'Operators', can('operators.manage')], ['/connector', 'Connector health', can('connector.read')], ['/branding', 'Branding and logo', can('branding.manage')],
    ['/settings', 'Settings', can('settings.manage')], ['/settings?tab=licence', 'Licence', can('settings.manage')], ['/audit', 'Audit trail', can('audit.read')], ['/usage', 'Usage', can('settings.manage')], ['/setup-report', 'System setup report', can('settings.manage')], ['/help', 'Help and manual', true], ['/account', 'My account', true],
  ] as [string, string, boolean][]).filter((x) => x[2]).map(([to, label]) => ({ to, label }));

  return (
    <HotelCtx.Provider value={{ me: { ...me, prefs }, hotel, can, branding: b, reloadBranding: branding.reload, base, pages: pageList, setPrefs }}>
      <div className="shell">
        <aside className={`rail${menu ? ' open' : ''}`}>
          <button className="menu-btn" aria-expanded={menu} aria-label="Menu" onClick={() => setMenu(!menu)}>{menu ? '✕' : '☰'}</button>
          {b?.logo ? (
            <div className="hotel has-logo"><img src={b.logo} alt={hotel.name} style={{ width: ({ small: 120, medium: 168, large: 210 } as Record<string, number>)[b.logoSize?.portal ?? 'medium'] ?? 168 }} /><span>{hotel.name} · Staff access</span></div>
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
          <CommandPalette pages={pageList} />
          <nav aria-label="Main">
            {(can('resources.read') || can('reports.read') || !can('muster.read')) && <NavLink to="/" end>Overview</NavLink>}
            {vis('/insights') && can('reports.read') && <NavLink to="/insights">Insights</NavLink>}
            {vis('/access') && can('events.read') && <NavLink to="/access">Access history</NavLink>}
            {vis('/events') && can('events.read') && <NavLink to="/events">Event log</NavLink>}
            {vis('/monitoring') && can('alerts.read') && <NavLink to="/monitoring">Monitoring {(mon.data?.alerts?.critical ?? 0) > 0 && <span className="count bad" title="Critical alerts">{mon.data.alerts.critical}</span>}</NavLink>}
            {can('muster.read') && (vis('/muster') || vis('/emergency')) && <div className="group">Safety</div>}
            {vis('/muster') && can('muster.read') && <NavLink to="/muster">Live occupancy {emergency.data?.open && <span className="count bad" title="Emergency open">!</span>}</NavLink>}
            {vis('/emergency') && can('muster.read') && <NavLink to="/emergency">Emergency</NavLink>}
            {(can('reports.read') || can('staff.read') || can('key.read') || can('attendance.clock') || can('breakfast.read') || can('idcards.manage') || can('keycards.request') || can('lockout.request')) && <div className="group">People &amp; keys</div>}
            {vis('/visionline') && can('reports.read') && <NavLink to="/visionline">Visionline cards & people</NavLink>}
            {vis('/keycards') && (can('keycards.request') || can('keycards.read') || can('lockout.request') || can('lockout.approve')) && <NavLink to="/keycards">Staff keycards</NavLink>}
            {vis('/idcards') && can('idcards.manage') && <NavLink to="/idcards">Staff ID cards</NavLink>}
            {vis('/staff') && can('staff.read') && <NavLink to="/staff">Staff</NavLink>}
            {vis('/keys') && can('key.read') && <NavLink to="/keys">Mobile keys {pendingCount > 0 && <span className="count" title="Awaiting approval">{pendingCount}</span>}</NavLink>}
            {vis('/attendance') && can('attendance.clock') && <NavLink to="/attendance">Time & attendance</NavLink>}
            {vis('/breakfast') && can('breakfast.read') && attention.data?.breakfast && <NavLink to="/breakfast">Breakfast</NavLink>}
            {((can('battery.read') && attention.data?.batteryMonitoring) || (can('maintenance.read') && attention.data?.maintenance)) && <div className="group">Building</div>}
            {vis('/battery') && can('battery.read') && attention.data?.batteryMonitoring && <NavLink to="/battery">Battery status {(attention.data.battery?.critical ?? 0) > 0 && <span className="count" title="Critical lock batteries">{attention.data.battery.critical}</span>}</NavLink>}
            {vis('/maintenance') && can('maintenance.read') && attention.data?.maintenance && <NavLink to="/maintenance">Maintenance {(attention.data.maintenance?.open ?? 0) > 0 && <span className="count" title="Open requests">{attention.data.maintenance.open}</span>}</NavLink>}
            {(can('operators.manage') || can('connector.read') || can('branding.manage') || can('settings.manage') || can('audit.read')) && <div className="group">Administration</div>}
            {vis('/operators') && can('operators.manage') && <NavLink to="/operators">Operators</NavLink>}
            {vis('/connector') && can('connector.read') && <NavLink to="/connector">Connector health</NavLink>}
            {vis('/branding') && can('branding.manage') && <NavLink to="/branding">Branding and logo</NavLink>}
            {vis('/settings') && can('settings.manage') && <NavLink to="/settings">Settings</NavLink>}
            {vis('/audit') && can('audit.read') && <NavLink to="/audit">Audit trail</NavLink>}
            {vis('/usage') && can('settings.manage') && <NavLink to="/usage">Usage</NavLink>}
            {vis('/setup-report') && can('settings.manage') && <NavLink to="/setup-report">System setup report</NavLink>}
          </nav>
          <div className="foot">
            <div><NavLink to="/account" style={{ color: 'inherit' }}>{me.displayName}</NavLink></div>
            <div style={{ opacity: 0.7 }}>{hotel.roles.map((r) => me.roleLabels[r] ?? r).join(', ')}</div>
            <NavLink to="/help" className="help-link">Help and manual</NavLink>
            <ThemeSwitch />
            <button onClick={onSignOut}>Sign out</button>
          </div>
        </aside>
        <main className="content" key={hotel.id}>
          <LicenceBanner />
          {hotel.mfaRequired && <div className="sys-banner no-print" role="alert"><strong>Two-step sign-in is required for administrators.</strong><span>Settings, Operators and Branding open once it is on.</span><NavLink to="/account?tab=mfa">Turn it on →</NavLink></div>}
          {(banner.data ?? []).map((a) => (
            <div key={a.id} className="sys-banner no-print" role="alert"><strong>{a.title}</strong><span>{a.detail}</span><NavLink to="/monitoring?tab=system">Monitoring →</NavLink></div>
          ))}
          <ErrorBoundary key={loc.pathname} label="This page">
          <Routes>
            <Route path="/" element={!can('resources.read') && can('breakfast.read') ? <Navigate to="/breakfast" replace /> : !can('resources.read') && !can('reports.read') && can('muster.read') ? <Navigate to="/muster" replace /> : <Overview />} />
            <Route path="/staff" element={<StaffPage />} />
            <Route path="/keys" element={<KeysPage />} />
            <Route path="/keys/:keyId" element={<KeysPage />} />
            <Route path="/operators" element={<OperatorsPage />} />
            <Route path="/connector" element={<ConnectorPage />} />
            <Route path="/branding" element={<BrandingPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/insights" element={<InsightsPage />} />
            <Route path="/events" element={<EventLogPage />} />
            <Route path="/monitoring" element={<MonitoringPage />} />
            <Route path="/battery" element={<BatteryPage />} />
            <Route path="/battery/:doorId" element={<BatteryPage />} />
            <Route path="/maintenance" element={<MaintenancePage />} />
            <Route path="/maintenance/:ticketId" element={<MaintenancePage />} />
            <Route path="/attendance" element={<AttendancePage />} />
            <Route path="/visionline" element={<VisionlinePage />} />
            <Route path="/access" element={<AccessPage />} />
            <Route path="/breakfast" element={<BreakfastPage />} />
            <Route path="/muster" element={<MusterPage />} />
            <Route path="/emergency" element={<EmergencyPage />} />
            <Route path="/idcards" element={<IdCardsPage />} />
            <Route path="/keycards" element={<KeycardsPage />} />
            <Route path="/setup-report" element={<SetupReportPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
          </ErrorBoundary>
        </main>
      </div>
    </HotelCtx.Provider>
  );
}

/** Hotel shown on the sign-in page: ?hotel=<code> in the URL, else the build default, else this installation's hotel. */
const LOGIN_HOTEL = new URLSearchParams(location.search).get('hotel') ?? (import.meta.env.VITE_DEFAULT_HOTEL as string | undefined) ?? 'default';

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

/** Appearance: follow the computer (System), or always Light / Dark. Remembered on this computer. */
function ThemeSwitch() {
  const { me, setPrefs } = useHotel();
  const [pref, setPref] = useState<ThemePref>(themePref());
  const choose = (p: ThemePref) => {
    setThemePref(p); setPref(p);
    const next = { hiddenNav: me.prefs?.hiddenNav ?? [], theme: p };
    setPrefs(next); void api('/api/v1/me/prefs', { method: 'PUT', body: next }).catch(() => undefined);
  };
  return (
    <div className="theme-switch" role="group" aria-label="Appearance">
      {(['system', 'light', 'dark'] as const).map((p) => <button key={p} aria-pressed={pref === p} onClick={() => choose(p)} title={p === 'system' ? 'Follow this computer' : undefined}>{p === 'system' ? 'Auto' : p === 'light' ? 'Light' : 'Dark'}</button>)}
    </div>
  );
}
