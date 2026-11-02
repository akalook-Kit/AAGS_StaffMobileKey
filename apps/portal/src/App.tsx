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
import { LockTroubleshootPage } from './pages/LockTroubleshoot';
import { OnlineLocksPage } from './pages/OnlineLocks';
import { MaintenancePage } from './pages/Maintenance';
import { InsightsPage } from './pages/Insights';
import { EventLogPage } from './pages/EventLog';
import { RoomKeycardsPage } from './pages/RoomKeycards';
import { ChartsPage } from './pages/Charts';
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
import { InvitePage } from './pages/Invite';

export interface Me {
  id: string; email: string; displayName: string; isPlatformAdmin: boolean; mfaEnabled: boolean;
  hotels: { id: string; slug: string; name: string; kind?: 'hotel' | 'institution'; roles: string[]; permissions: Permission[]; hiddenModules?: string[]; mfaRequired?: boolean }[];
  modules?: Record<string, string>;
  roleLabels: Record<string, string>;
  prefs?: { hiddenNav?: string[]; theme?: 'system' | 'light' | 'dark' };
}
interface Ctx { me: Me; hotel: Me['hotels'][number]; can: (p: Permission) => boolean; branding: any; reloadBranding: () => void; base: string; pages: { to: string; label: string }[]; setPrefs: (p: NonNullable<Me['prefs']>) => void }
const HotelCtx = createContext<Ctx | null>(null);
export const useHotel = () => useContext(HotelCtx)!;
/** 2.16 Words that depend on the organisation: a hotel or an institution. Elsewhere the portal stays neutral. */
export function termsFor(kind: string | undefined) {
  const inst = kind === 'institution';
  return { institution: inst, org: inst ? 'institution' : 'hotel', Org: inst ? 'Institution' : 'Hotel', rooms: inst ? 'rooms' : 'guest rooms', Rooms: inst ? 'Rooms' : 'Guest rooms' };
}
export const useTerms = () => termsFor(useContext(HotelCtx)?.hotel.kind);

export function App() {
  const [token, setToken] = useState(auth.token);
  const [me, setMe] = useState<Me | null>(null);
  // 2.9 A new on-premises installation opens on the first-run setup page until the hotel is set up.
  const [setup, setSetup] = useState<any>(undefined);
  // 2.16 The invitation's secret is read once; the page then removes it from the address bar.
  const [invite] = useState(() => (location.pathname === '/invite' && location.hash.length > 20 ? location.hash.slice(1) : null));
  const [inviteDone, setInviteDone] = useState(false);
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
  // 2.16 Invitation link: choose a password, then straight into the portal.
  if (invite && !inviteDone) return <InvitePage token={invite} onSignedIn={(t) => { setInviteDone(true); auth.set(t); setToken(t); }} />;
  if (setup === undefined && !token) return <div className="empty">Loading…</div>;
  if (setup?.needed) return <SetupPage info={setup} />;
  if (!token) return <Login onSignedIn={(t) => { auth.set(t); setToken(t); }} />;
  if (!me) return <div className="empty">Loading…</div>;
  if (!me.hotels.length) return <div className="empty">Your account is not a member of any site yet. Ask an administrator to add you.</div>;
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
    document.title = b?.portalTitle ?? `${hotel.name} · Access monitoring`;
  }, [b, hotel.name]);
  const can = (p: Permission) => hotel.permissions.includes(p);
  // 2.17 Own charts for everyone who can read some data.
  const chartsOk = (['reports.read', 'events.read', 'maintenance.read', 'key.read', 'breakfast.read'] as Permission[]).some((p) => hotel.permissions.includes(p));
  // 2.16.1 Menu groups fold away (remembered on this computer); the group of the page you are on stays open.
  const [navClosed0, setNavClosed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('smk.nav.closed') ?? '[]')); } catch { return new Set(); } });
  const activeGroup = /^\/(muster|emergency)/.test(loc.pathname) ? 'safety' : /^\/(visionline|keycards|idcards|staff|keys|attendance|breakfast)/.test(loc.pathname) ? 'people'
    : /^\/(battery|maintenance|lock-troubleshoot|locks-online)/.test(loc.pathname) ? 'building' : /^\/(operators|connector|branding|settings|audit|usage|setup-report)/.test(loc.pathname) ? 'admin' : '';
  const navClosed = new Set([...navClosed0].filter((g) => g !== activeGroup));
  const toggleGroup = (g: string) => setNavClosed((cur) => {
    const n = new Set(cur); if (navClosed.has(g)) n.delete(g); else n.add(g);
    try { localStorage.setItem('smk.nav.closed', JSON.stringify([...n])); } catch { /* ignore */ }
    return n;
  });
  const initials = hotel.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  const pendingCount = pending.data?.length ?? 0;
  const pageList = ([
    ['/', 'Overview', true], ['/insights', 'Insights', can('reports.read')], ['/insights?page=mine', 'My reports', can('reports.read')], ['/insights?page=build', 'Build a report', can('reports.read')],
    ['/access', 'Access history', can('events.read')], ['/events', 'Event log', can('events.read')], ['/room-keycards', 'Keycards per room', can('events.read')], ['/charts', 'My charts', chartsOk], ['/monitoring', 'Monitoring', can('alerts.read')],
    ['/muster', 'Live occupancy', can('muster.read')], ['/emergency', 'Emergency', can('muster.read')],
    ['/visionline', 'Visionline cards & people', can('reports.read')], ['/visionline?tab=lookup', 'Card lookup', can('reports.read')], ['/idcards', 'Staff ID cards', can('idcards.manage')], ['/keycards', 'Staff keycards', can('keycards.request') || can('keycards.read') || can('lockout.request') || can('lockout.approve')], ['/staff', 'Staff', can('staff.read')], ['/keys', 'Mobile keys', can('key.read')],
    ['/attendance', 'Time & attendance', can('attendance.clock')], ['/breakfast', 'Breakfast', can('breakfast.read') && Boolean(attention.data?.breakfast) && hotel.kind !== 'institution'],
    ['/battery', 'Battery status', can('battery.read') && Boolean(attention.data?.batteryMonitoring)], ['/lock-troubleshoot', 'Lock troubleshooting', can('battery.read')], ['/locks-online', 'Online locks & gateways', can('resources.read')], ['/maintenance', 'Maintenance', can('maintenance.read') && Boolean(attention.data?.maintenance)],
    ['/operators', 'Users', can('operators.manage')], ['/connector', 'Connector health', can('connector.read')], ['/branding', 'Branding and logo', can('branding.manage')],
    ['/settings', 'Settings', can('settings.manage')], ['/settings?tab=licence', 'Licence', can('settings.manage')], ['/audit', 'Audit trail', can('audit.read')], ['/usage', 'Usage', can('settings.manage')], ['/setup-report', 'System setup report', can('settings.manage')], ['/help', 'Help and manual', true], ['/account', 'My account', true],
  ] as [string, string, boolean][]).filter((x) => x[2]).map(([to, label]) => ({ to, label }));

  return (
    <HotelCtx.Provider value={{ me: { ...me, prefs }, hotel, can, branding: b, reloadBranding: branding.reload, base, pages: pageList, setPrefs }}>
      <div className="shell">
        <aside className={`rail${menu ? ' open' : ''}`}>
          <button className="menu-btn" aria-expanded={menu} aria-label="Menu" onClick={() => setMenu(!menu)}>{menu ? '✕' : '☰'}</button>
          {b?.logo ? (
            <div className="hotel has-logo"><img src={b.logo} alt={hotel.name} style={{ width: ({ small: 120, medium: 168, large: 210 } as Record<string, number>)[b.logoSize?.portal ?? 'medium'] ?? 168 }} /><span>{hotel.name} · Access monitoring</span></div>
          ) : (
            <div className="hotel">
              <div className="mark" aria-hidden>{initials}</div>
              <div><strong>{hotel.name}</strong><span>Access monitoring</span></div>
            </div>
          )}
          {me.hotels.length > 1 && (
            <select aria-label="Site" value={hotel.id} onChange={(e) => { setHotelId(e.target.value); try { localStorage.setItem('smk.hotel', e.target.value); } catch { /* ignore */ } }}>
              {me.hotels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          )}
          <CommandPalette pages={pageList} />
          <nav aria-label="Main">
            {(can('resources.read') || can('reports.read') || !can('muster.read')) && <NavLink to="/" end>Overview</NavLink>}
            {vis('/insights') && can('reports.read') && <NavLink to="/insights">Insights</NavLink>}
            {vis('/access') && can('events.read') && <NavLink to="/access">Access history</NavLink>}
            {vis('/events') && can('events.read') && <NavLink to="/events">Event log</NavLink>}
            {vis('/room-keycards') && can('events.read') && <NavLink to="/room-keycards">Keycards per room</NavLink>}
            {vis('/charts') && chartsOk && <NavLink to="/charts">My charts</NavLink>}
            {vis('/monitoring') && can('alerts.read') && <NavLink to="/monitoring">Monitoring {(mon.data?.alerts?.critical ?? 0) > 0 && <span className="count bad" title="Critical alerts">{mon.data.alerts.critical}</span>}</NavLink>}
            {can('muster.read') && (vis('/muster') || vis('/emergency')) && <button type="button" className="group" aria-expanded={!navClosed.has('safety')} onClick={() => toggleGroup('safety')}>Safety<span aria-hidden>{navClosed.has('safety') ? '▸' : '▾'}</span></button>}
            <div className="navgroup" hidden={navClosed.has('safety')}>
            {vis('/muster') && can('muster.read') && <NavLink to="/muster">Live occupancy {emergency.data?.open && <span className="count bad" title="Emergency open">!</span>}</NavLink>}
            {vis('/emergency') && can('muster.read') && <NavLink to="/emergency">Emergency</NavLink>}
            </div>
            {(can('reports.read') || can('staff.read') || can('key.read') || can('attendance.clock') || can('breakfast.read') || can('idcards.manage') || can('keycards.request') || can('lockout.request')) && <button type="button" className="group" aria-expanded={!navClosed.has('people')} onClick={() => toggleGroup('people')}>People &amp; keys<span aria-hidden>{navClosed.has('people') ? '▸' : '▾'}</span></button>}
            <div className="navgroup" hidden={navClosed.has('people')}>
            {vis('/visionline') && can('reports.read') && <NavLink to="/visionline">Visionline cards & people</NavLink>}
            {vis('/keycards') && (can('keycards.request') || can('keycards.read') || can('lockout.request') || can('lockout.approve')) && <NavLink to="/keycards">Staff keycards</NavLink>}
            {vis('/idcards') && can('idcards.manage') && <NavLink to="/idcards">Staff ID cards</NavLink>}
            {vis('/staff') && can('staff.read') && <NavLink to="/staff">Staff</NavLink>}
            {vis('/keys') && can('key.read') && <NavLink to="/keys">Mobile keys {pendingCount > 0 && <span className="count" title="Awaiting approval">{pendingCount}</span>}</NavLink>}
            {vis('/attendance') && can('attendance.clock') && <NavLink to="/attendance">Time & attendance</NavLink>}
            {vis('/breakfast') && can('breakfast.read') && attention.data?.breakfast && hotel.kind !== 'institution' && <NavLink to="/breakfast">Breakfast</NavLink>}
            </div>
            {(can('battery.read') || can('resources.read') || (can('maintenance.read') && attention.data?.maintenance)) && <button type="button" className="group" aria-expanded={!navClosed.has('building')} onClick={() => toggleGroup('building')}>Building<span aria-hidden>{navClosed.has('building') ? '▸' : '▾'}</span></button>}
            <div className="navgroup" hidden={navClosed.has('building')}>
            {vis('/battery') && can('battery.read') && attention.data?.batteryMonitoring && <NavLink to="/battery">Battery status {(attention.data.battery?.critical ?? 0) > 0 && <span className="count" title="Critical lock batteries">{attention.data.battery.critical}</span>}</NavLink>}
            {vis('/locks-online') && can('resources.read') && <NavLink to="/locks-online">Online locks &amp; gateways {(attention.data?.offlineLocks ?? 0) > 0 && <span className="count" title="Locks or gateways offline">{attention.data.offlineLocks}</span>}</NavLink>}
            {vis('/lock-troubleshoot') && can('battery.read') && <NavLink to="/lock-troubleshoot">Lock troubleshooting</NavLink>}
            {vis('/maintenance') && can('maintenance.read') && attention.data?.maintenance && <NavLink to="/maintenance">Maintenance {(attention.data.maintenance?.open ?? 0) > 0 && <span className="count" title="Open requests">{attention.data.maintenance.open}</span>}</NavLink>}
            </div>
            {(can('operators.manage') || can('connector.read') || can('branding.manage') || can('settings.manage') || can('audit.read')) && <button type="button" className="group" aria-expanded={!navClosed.has('admin')} onClick={() => toggleGroup('admin')}>Administration<span aria-hidden>{navClosed.has('admin') ? '▸' : '▾'}</span></button>}
            <div className="navgroup" hidden={navClosed.has('admin')}>
            {vis('/operators') && can('operators.manage') && <NavLink to="/operators">Users</NavLink>}
            {vis('/connector') && can('connector.read') && <NavLink to="/connector">Connector health</NavLink>}
            {vis('/branding') && can('branding.manage') && <NavLink to="/branding">Branding and logo</NavLink>}
            {vis('/settings') && can('settings.manage') && <NavLink to="/settings">Settings</NavLink>}
            {vis('/audit') && can('audit.read') && <NavLink to="/audit">Audit trail</NavLink>}
            {vis('/usage') && can('settings.manage') && <NavLink to="/usage">Usage</NavLink>}
            {vis('/setup-report') && can('settings.manage') && <NavLink to="/setup-report">System setup report</NavLink>}

            </div>
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
          {hotel.mfaRequired && <div className="sys-banner no-print" role="alert"><strong>Two-step sign-in is required for administrators.</strong><span>Settings, Users and Branding open once it is on.</span><NavLink to="/account?tab=mfa">Turn it on →</NavLink></div>}
          {(banner.data ?? []).map((a) => (
            <div key={a.id} className="sys-banner no-print" role="alert"><strong>{a.title}</strong><span>{a.detail}</span><NavLink to="/monitoring?tab=system">Monitoring →</NavLink></div>
          ))}
          <ErrorBoundary key={loc.pathname} label="This page">
          <div className="page-enter" key={loc.pathname}>
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
            <Route path="/room-keycards" element={<RoomKeycardsPage />} />
            <Route path="/charts" element={<ChartsPage />} />
            <Route path="/monitoring" element={<MonitoringPage />} />
            <Route path="/battery" element={<BatteryPage />} />
            <Route path="/battery/:doorId" element={<BatteryPage />} />
            <Route path="/locks-online" element={<OnlineLocksPage />} />
            <Route path="/lock-troubleshoot" element={<LockTroubleshootPage />} />
            <Route path="/lock-troubleshoot/:reportId" element={<LockTroubleshootPage />} />
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
          </div>
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
        {brand?.logo ? <img className="brand-logo" src={brand.logo} alt={brand.hotelName ?? 'Logo'} /> : <div className="keytag" aria-hidden>101</div>}
        <LoginFeed />
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

/**
 * 2.17 The sign-in page is not a blank form: it shows the notice board's public posts (written by the site's
 * administrators), what people find inside, and good-practice reminders, one after the other.
 */
const LOGIN_TIPS = [
  { kind: 'tip', title: 'Lost a keycard?', body: 'Tell front office or security at once: the card is cancelled in minutes and nobody can use it.' },
  { kind: 'tip', title: 'Leaving the company?', body: 'Your manager asks for your keycard to be returned and cancelled; it takes one minute.' },
  { kind: 'tip', title: 'Your password is yours', body: 'Never share it. Turn on two-step sign-in under Your account for extra protection.' },
  { kind: 'tip', title: 'Lock batteries', body: 'When a lock shows a battery alarm, report it: changing batteries in good time avoids lock-outs.' },
];
const INSIDE = [
  ['Who opened which door', 'Event log and keycards per room, printable and verifiable.'],
  ['Keycards', 'Requests, register, returns and who holds what, made in Visionline.'],
  ['Safety', 'Live occupancy and roll call in an emergency.'],
  ['Locks', 'Battery status, alarms, doors offline and maintenance requests.'],
  ['Your charts', 'Build your own charts from the data you may see.'],
];
function LoginFeed() {
  const [posts, setPosts] = useState<any[]>([]);
  const [i, setI] = useState(0);
  useEffect(() => { api(`/api/v1/public/notices?hotel=${encodeURIComponent(LOGIN_HOTEL)}`).then((r) => setPosts(r.notices ?? [])).catch(() => undefined); }, []);
  const slides = [...posts, ...LOGIN_TIPS];
  useEffect(() => { const t = setInterval(() => setI((x) => x + 1), 8000); return () => clearInterval(t); }, []);
  const cur = slides[i % slides.length]!;
  return (
    <div className="login-feed">
      <h1 style={{ fontSize: 28, maxWidth: '18ch' }}>Doors, keycards and locks, in one place.</h1>
      <div className="login-slide" key={i % slides.length} aria-live="polite">
        {cur.image && <img src={cur.image} alt="" />}
        <span className={`notice-kind k-${cur.kind}`}>{cur.kind === 'tip' ? 'Good to know' : cur.kind === 'important' ? 'Important' : cur.kind === 'event' ? 'Event' : 'News'}</span>
        <strong>{cur.title}</strong>
        {cur.body && <p>{cur.body}</p>}
      </div>
      <div className="login-dots" role="tablist" aria-label="Messages">{slides.map((_, k) => <button key={k} aria-label={`Message ${k + 1}`} aria-pressed={k === i % slides.length} onClick={() => setI(k)} />)}</div>
      <ul className="login-inside">{INSIDE.map(([t, d]) => <li key={t}><strong>{t}</strong><span>{d}</span></li>)}</ul>
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
