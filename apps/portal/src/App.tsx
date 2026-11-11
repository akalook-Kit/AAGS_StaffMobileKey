import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { AccessPage } from './pages/Access';
import { LicenceBanner } from './components/Licence';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LIGHT_PAGES, type Permission } from '@smk/shared';
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
import { DemoPage } from './pages/Demo';
import { FeedbackButton } from './components/Feedback';
import { ReportsPage } from './pages/Reports';
import { DoorHistoryPage } from './pages/LockHistory';
import { LightHome } from './pages/LightHome';
import { LightSetupPage } from './pages/LightSetup';
import { TipLayer } from './components/Tips';
import { LANGS, hasLangChoice, lang, langChoice, setLang, tr, type LangChoice } from './i18n';

export interface Me {
  id: string; email: string; displayName: string; isPlatformAdmin: boolean; mfaEnabled: boolean;
  accessUntil?: string | null;
  hotels: { id: string; slug: string; name: string; kind?: 'hotel' | 'institution'; demo?: boolean; roles: string[]; permissions: Permission[]; hiddenModules?: string[]; mfaRequired?: boolean }[];
  modules?: Record<string, string>;
  roleLabels: Record<string, string>;
  prefs?: { hiddenNav?: string[]; theme?: 'system' | 'light' | 'dark'; lang?: LangChoice };
  /** 2.33 Edition (full / light) and open access (no sign-in on the hotel network). */
  edition?: { id: 'full' | 'light'; openAccess: boolean; isOpenAccess: boolean };
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
  const [, setLangTick] = useState(0);
  useEffect(() => { const f = () => setLangTick((n) => n + 1); window.addEventListener('smk:lang', f); return () => window.removeEventListener('smk:lang', f); }, []);
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
  // 2.33 Light edition: on the hotel network the reports open without signing in. "Administrator sign-in" (or signing
  // out) shows the sign-in page instead, for this browser tab.
  const [openTried, setOpenTried] = useState(false);
  useEffect(() => {
    if (token || openTried) return;
    let wantSignIn = false; try { wantSignIn = sessionStorage.getItem('smk.signin') === '1'; } catch { /* ignore */ }
    if (wantSignIn) { setOpenTried(true); return; }
    fetch('/api/v1/auth/open').then((r) => (r.ok ? r.json() : null)).then((r) => { if (r?.token) { try { sessionStorage.setItem('smk.openAvail', '1'); } catch { /* ignore */ } auth.set(r.token); setToken(r.token); } })
      .catch(() => undefined).finally(() => setOpenTried(true));
  }, [token, openTried]);
  // 2.14 The keycard request page behind the QR code needs no sign-in.
  const pub = /^\/request\/([A-Za-z0-9_-]{20,64})$/.exec(location.pathname);
  if (pub) return <PublicRequestPage token={pub[1]!} />;
  // 2.16 Invitation link: choose a password, then straight into the portal.
  if (invite && !inviteDone) return <InvitePage token={invite} onSignedIn={(t) => { setInviteDone(true); auth.set(t); setToken(t); }} />;
  if (setup === undefined && !token) return <div className="empty">Loading…</div>;
  if (setup?.needed) return setup.edition === 'light' ? <LightSetupPage info={setup} /> : <SetupPage info={setup} />;
  if (!token && !openTried) return <div className="empty">Loading…</div>;
  if (!token) return <Login light={setup?.edition === 'light'} onSignedIn={(t) => { try { sessionStorage.removeItem('smk.signin'); } catch { /* ignore */ } auth.set(t); setToken(t); }} />;
  if (!me) return <div className="empty">Loading…</div>;
  if (!me.hotels.length) return <div className="empty">Your account is not a member of any site yet. Ask an administrator to add you.</div>;
  return <BrowserRouter><Shell me={me} onSignOut={() => { try { sessionStorage.setItem('smk.signin', '1'); } catch { /* ignore */ } auth.set(null); setToken(null); setMe(null); }} /></BrowserRouter>;
}

function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  const [prefs, setPrefs] = useState(me.prefs ?? {});
  // A person's appearance follows them to any computer (unless this computer already has a choice).
  useEffect(() => { try { if (me.prefs?.theme && !localStorage.getItem('smk.theme')) setThemePref(me.prefs.theme); } catch { /* ignore */ } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (me.prefs?.lang && !hasLangChoice() && me.prefs.lang !== langChoice()) setLang(me.prefs.lang); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 2.33 Light edition: only its pages (reports, locks, Visionline cards, short administration).
  const light = me.edition?.id === 'light';
  const inEdition = (to: string) => !light || (LIGHT_PAGES as readonly string[]).includes('/' + (to.split(/[?#]/)[0]!.split('/')[1] ?? ''));
  const vis = (to: string) => !(prefs.hiddenNav ?? []).includes(to) && inEdition(to);
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
  useEffect(() => { applyBrand(b); }, [b]);
  const can = (p: Permission) => hotel.permissions.includes(p);
  // 2.17 Own charts for everyone who can read some data.
  const chartsOk = (['reports.read', 'events.read', 'maintenance.read', 'key.read', 'breakfast.read'] as Permission[]).some((p) => hotel.permissions.includes(p));
  // 2.27 A shorter menu (Armel, 4 Nov): a few groups, one open at a time; the group of the page you are on opens by itself.
  const activeGroup = /^\/(access|events|room-keycards|muster|emergency)/.test(loc.pathname) ? 'doors'
    : /^\/(visionline|keycards|idcards|staff|keys|attendance|breakfast)/.test(loc.pathname) ? 'people'
    : /^\/(battery|maintenance|lock-troubleshoot|locks-online)/.test(loc.pathname) ? 'locks'
    : /^\/(operators|connector|branding|settings|audit|usage|setup-report|demo)/.test(loc.pathname) ? 'admin' : '';
  const [openGroup, setOpenGroup] = useState(activeGroup);
  useEffect(() => { if (activeGroup) setOpenGroup(activeGroup); }, [activeGroup]);
  // 2.27.1 The menu counts critical alerts nobody has looked at yet ("Mark as seen" takes them off the count).
  const critical = mon.data?.alerts?.critical_unseen ?? mon.data?.alerts?.critical ?? 0;
  const pendingCount = pending.data?.length ?? 0;
  const keycardsOk = can('keycards.request') || can('keycards.read') || can('lockout.request') || can('lockout.approve');
  const reportsOk = can('reports.read') || can('events.read') || can('keycards.read') || can('battery.read') || can('settings.manage');
  type Item = { to: string; label: string; show: boolean; badge?: ReactNode; count?: number; tip?: string };
  const NAV: { id?: string; label: string; tip?: string; items: Item[] }[] = [
    { label: '', items: [
      { to: '/', label: 'Overview', tip: 'What needs you now, shortcuts to everyday tasks, notices and the site at a glance.', show: can('resources.read') || can('reports.read') || !can('muster.read') },
      { to: '/reports', label: 'Reports', tip: 'Daily and monthly reports: guest and staff keycards issued, who holds keycards, refused entries, batteries. Download as PDF or Excel, or have them e-mailed.', show: reportsOk },
      { to: '/monitoring', label: 'Alerts', tip: 'Problems the portal found: doors or connector offline, lock alarms, low batteries. Each alert closes by itself once fixed; Mark as seen takes it off the count.', show: can('alerts.read'), badge: critical > 0 ? <span className="count bad" title={tr('Critical alerts')}>{critical}</span> : null },
    ] },
    { id: 'doors', label: 'Doors & safety', tip: 'Who went where, who is in the building, emergencies and the event log.', items: [
      { to: '/access', label: 'Access history', tip: 'Who opened which door and when. Search by person, door or card number.', show: can('events.read') },
      { to: '/muster', label: 'Live occupancy', tip: 'Who is in the building now, from the last doors they used. Used for roll call in an emergency.', show: can('muster.read'), badge: emergency.data?.open ? <span className="count bad" title={tr('Emergency')}>!</span> : null, count: emergency.data?.open ? 1 : 0 },
      { to: '/emergency', label: 'Emergency', tip: 'Start a fire alarm or drill: roll call, doors and messages, then close it when it is over.', show: can('muster.read') },
      { to: '/events', label: 'Event log', tip: 'Every lock event received from Visionline, with filters. Print gives a PDF that can be checked later.', show: can('events.read') },
      { to: '/room-keycards', label: 'Keycards per room', tip: 'For one room: which keycards opened it, whose they are and who issued them.', show: can('events.read') },
    ] },
    { id: 'people', label: 'Keycards & people', tip: 'Staff keycards, Visionline people and cards, ID cards and mobile keys.', items: [
      { to: '/keycards', label: 'Staff keycards', tip: 'Ask for, issue, verify and extend staff keycards; returns and cancellations; the register of who holds which card.', show: keycardsOk },
      { to: '/visionline', label: 'Visionline cards & people', tip: 'The people and keycards in Visionline, which doors each card opens, and Card lookup by number or on the encoder.', show: can('reports.read') },
      { to: '/idcards', label: 'Staff ID cards', tip: 'Print staff ID cards with photo, name and department.', show: can('idcards.manage') },
      { to: '/staff', label: 'Staff', tip: 'People who use the staff app (mobile keys): invite, suspend or remove them.', show: can('staff.read') },
      { to: '/keys', label: 'Mobile keys', tip: 'Mobile keys on staff phones: issue, approve broad access, revoke.', show: can('key.read'), badge: pendingCount > 0 ? <span className="count" title={tr('Awaiting approval')}>{pendingCount}</span> : null, count: pendingCount },
      { to: '/attendance', label: 'Time & attendance', tip: 'Clock in and out, and attendance from the doors people used.', show: can('attendance.clock') },
      { to: '/breakfast', label: 'Breakfast', tip: 'The in-house guest list for the restaurant: mark breakfasts served.', show: can('breakfast.read') && Boolean(attention.data?.breakfast) && hotel.kind !== 'institution' },
    ] },
    { id: 'locks', label: 'Locks', tip: 'Batteries, online locks and gateways, troubleshooting and maintenance.', items: [
      { to: '/battery', label: 'Battery status', tip: "Battery state of every lock, from the locks' own alarms. Record new batteries here.", show: can('battery.read') && Boolean(attention.data?.batteryMonitoring), badge: (attention.data?.battery?.critical ?? 0) > 0 ? <span className="count" title={tr('Critical batteries')}>{attention.data.battery.critical}</span> : null, count: attention.data?.battery?.critical ?? 0 },
      { to: '/locks-online', label: 'Online locks & gateways', tip: 'Online locks and gateways that are out of contact, with their EEID, so engineering can find them.', show: can('resources.read'), badge: (attention.data?.offlineLocks ?? 0) > 0 ? <span className="count" title={tr('Locks offline now')}>{attention.data.offlineLocks}</span> : null, count: attention.data?.offlineLocks ?? 0 },
      { to: '/lock-troubleshoot', label: 'Lock troubleshooting', tip: "Find why a lock drains its batteries: battery changes, parts changed (elimination method) and the lock's event reports.", show: can('battery.read') },
      { to: '/maintenance', label: 'Maintenance', tip: 'Maintenance requests for locks and doors: open, assign, solve.', show: can('maintenance.read') && Boolean(attention.data?.maintenance), badge: (attention.data?.maintenance?.open ?? 0) > 0 ? <span className="count" title={tr('Open requests')}>{attention.data.maintenance.open}</span> : null, count: attention.data?.maintenance?.open ?? 0 },
    ] },
    { id: 'admin', label: 'Administration', tip: 'Users, settings, connector, setup reports and the audit trail (administrators).', items: [
      { to: '/operators', label: 'Users', tip: 'People who can sign in to this portal: invite, choose their role, reset passwords or two-step sign-in.', show: can('operators.manage') },
      { to: '/settings', label: 'Settings', tip: 'Visionline account, connector, alerts and e-mail, keycard rules, modules and the licence.', show: can('settings.manage') },
      { to: '/connector', label: 'Connector health', tip: 'The program on the Visionline server that links the portal and Visionline: version, last contact, errors.', show: can('connector.read') },
      { to: '/setup-report', label: 'System setup reports', tip: 'The Visionline setup report (version, AES, locks, user groups…) and the portal setup report. Printable.', show: can('settings.manage') },
      { to: '/audit', label: 'Audit trail', tip: 'Every sign-in and change, who did it and when. Cannot be altered.', show: can('audit.read') },
      { to: '/branding', label: 'Branding and logo', tip: 'Logo, colours and the name shown on the portal, the sign-in page and printed reports.', show: can('branding.manage') },
      { to: '/usage', label: 'Usage', tip: 'Which pages are used, and by how many people.', show: can('settings.manage') },
      { to: '/demo', label: 'Demo Hotel and testers', tip: 'A made-up hotel for people to try the portal, and their feedback.', show: me.isPlatformAdmin },
    ] },
  ];
  // 2.34 Light edition: a short menu, no groups (Armel: "hide everything that is not necessary").
  const LIGHT_NAV: { id?: string; label: string; tip?: string; items: Item[] }[] = [{ label: '', items: [
    { to: '/', label: 'Home', tip: 'The locks at a glance: what drains, reminders, batteries expected low, the Visionline connection.', show: true },
    { to: '/lock-troubleshoot', label: 'Locks', tip: 'Diagnose a lock: record work or a problem, follow the next step, upload its report.', show: can('battery.read') },
    { to: '/lock-troubleshoot?tab=day', label: 'Day report', tip: 'What was done and seen on a day: floor, door, parts, batteries, state. Print or Excel.', show: can('battery.read') },
    { to: '/battery', label: 'Battery status', tip: "Battery state of every lock, from the locks' own alarms.", show: can('battery.read') && Boolean(attention.data?.batteryMonitoring), badge: (attention.data?.battery?.critical ?? 0) > 0 ? <span className="count" title={tr('Critical batteries')}>{attention.data.battery.critical}</span> : null },
    { to: '/reports', label: 'Reports', tip: 'The locks and batteries report: PDF or Excel.', show: reportsOk },
  ] }];
  const initials = hotel.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  const pageList = ([
    ['/', 'Overview', true], ['/reports', 'Reports', reportsOk], ['/insights', 'Insights', can('reports.read')], ['/insights?page=mine', 'My reports', can('reports.read')], ['/insights?page=build', 'Build a report', can('reports.read')],
    ['/access', 'Access history', can('events.read')], ['/events', 'Event log', can('events.read')], ['/room-keycards', 'Keycards per room', can('events.read')], ['/charts', 'My charts', chartsOk], ['/monitoring', 'Monitoring', can('alerts.read')],
    ['/muster', 'Live occupancy', can('muster.read')], ['/emergency', 'Emergency', can('muster.read')],
    ['/visionline', 'Visionline cards & people', can('reports.read')], ['/visionline?tab=lookup', 'Card lookup', can('reports.read')], ['/idcards', 'Staff ID cards', can('idcards.manage')], ['/keycards', 'Staff keycards', can('keycards.request') || can('keycards.read') || can('lockout.request') || can('lockout.approve')], ['/staff', 'Staff', can('staff.read')], ['/keys', 'Mobile keys', can('key.read')],
    ['/attendance', 'Time & attendance', can('attendance.clock')], ['/breakfast', 'Breakfast', can('breakfast.read') && Boolean(attention.data?.breakfast) && hotel.kind !== 'institution'],
    ['/battery', 'Battery status', can('battery.read') && Boolean(attention.data?.batteryMonitoring)], ['/lock-troubleshoot', 'Lock troubleshooting', can('battery.read')], ['/locks-online', 'Online locks & gateways', can('resources.read')], ['/maintenance', 'Maintenance', can('maintenance.read') && Boolean(attention.data?.maintenance)],
    ['/operators', 'Users', can('operators.manage')], ['/connector', 'Connector health', can('connector.read')], ['/branding', 'Branding and logo', can('branding.manage')],
    ['/settings', 'Settings', can('settings.manage')], ['/settings?tab=licence', 'Licence', can('settings.manage')], ['/audit', 'Audit trail', can('audit.read')], ['/usage', 'Usage', can('settings.manage')], ['/setup-report', 'Visionline setup report', can('settings.manage')], ['/setup-report?view=portal', 'Portal setup report', can('settings.manage')], ['/demo', 'Demo Hotel and testers', me.isPlatformAdmin], ['/help', 'Help and manual', true], ['/account', 'My account', true],
  ] as [string, string, boolean][]).filter((x) => x[2] && inEdition(x[0])).map(([to, label]) => ({ to, label: tr(label) }));

  // 2.24 Each page has its own title (browser tabs, history, bookmarks).
  const here = `${loc.pathname}${loc.search}`;
  const pageLabel = pageList.find((p) => p.to === here)?.label ?? pageList.find((p) => p.to !== '/' && loc.pathname.startsWith(p.to.split('?')[0]!))?.label ?? (loc.pathname === '/' ? 'Overview' : null);
  useEffect(() => { const site = b?.portalTitle ?? `${hotel.name} · Access monitoring`; document.title = pageLabel ? `${pageLabel} · ${site}` : site; }, [pageLabel, b?.portalTitle, hotel.name]);

  return (
    <HotelCtx.Provider value={{ me: { ...me, prefs }, hotel, can, branding: b, reloadBranding: branding.reload, base, pages: pageList, setPrefs }}>
      <a className="skip" href="#main">{tr('Skip to the page')}</a>
      <div className="shell">
        <aside className={`rail${menu ? ' open' : ''}`}>
          <button className="menu-btn" aria-expanded={menu} aria-label={tr('Menu')} onClick={() => setMenu(!menu)}>{menu ? '✕' : '☰'}</button>
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
          <nav aria-label={tr('Main')}>
            {(light ? LIGHT_NAV : NAV).map((g) => {
              const items = g.items.filter((i) => i.show && vis(i.to));
              if (!items.length) return null;
              if (!g.id) return items.map((i) => <NavLink key={i.to} to={i.to} end={i.to === '/'} data-tip={i.tip}
                className={({ isActive }) => (light && i.to.includes('?') ? here === i.to : isActive && !(light && i.to === '/lock-troubleshoot' && loc.search.includes('tab=day'))) ? 'active' : ''}>{tr(i.label)} {i.badge}</NavLink>);
              const open = openGroup === g.id;
              const badges = items.reduce((n, i) => n + (i.count ?? 0), 0);
              return (
                <div key={g.id}>
                  <button type="button" className={`group${activeGroup === g.id ? ' here' : ''}`} data-tip={g.tip} aria-expanded={open} onClick={() => setOpenGroup(open ? '' : g.id!)}>
                    <span>{tr(g.label)}{!open && badges > 0 && <span className="count" aria-label={`${badges}`}>{badges}</span>}</span><span aria-hidden>{open ? '▾' : '▸'}</span>
                  </button>
                  <div className="navgroup" hidden={!open}>{items.map((i) => <NavLink key={i.to} to={i.to} data-tip={i.tip}>{tr(i.label)} {i.badge}</NavLink>)}</div>
                </div>
              );
            })}
          </nav>
          <div className="foot">
            <div>{me.edition?.isOpenAccess ? tr('Reports (no sign-in)') : <NavLink to="/account" style={{ color: 'inherit' }}>{me.displayName}</NavLink>}</div>
            <div style={{ opacity: 0.7 }}>{hotel.roles.map((r) => me.roleLabels[r] ?? r).join(', ')}</div>
            <NavLink to="/help" className="help-link">{tr('Help and manual')}</NavLink>
            <ThemeSwitch />
            <LangSwitch />
            {light && me.edition?.isOpenAccess ? null : me.edition?.isOpenAccess
              ? <button onClick={onSignOut} data-tip="Reports are open on the hotel network. Administrators sign in here to change settings.">{tr('Administrator sign-in')}</button>
              : <button onClick={onSignOut}>{tr('Sign out')}</button>}
          </div>
        </aside>
        <main className="content" id="main" tabIndex={-1} key={hotel.id}>
          {hotel.demo ? <div className="demo-band no-print" role="note"><strong>{tr('Demo Hotel')}</strong><span>{tr('Made-up doors, people and keycards for trying the portal. Nothing is real and nothing is sent to Visionline.')}{me.accessUntil ? ` Your test access ends ${new Date(me.accessUntil).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.` : ''}</span></div> : <LicenceBanner />}
          {hotel.mfaRequired && <div className="sys-banner no-print" role="alert"><strong>Two-step sign-in is required for administrators.</strong><span>Settings, Users and Branding open once it is on.</span><NavLink to="/account?tab=mfa">Turn it on →</NavLink></div>}
          {(banner.data ?? []).map((a) => (
            <div key={a.id} className="sys-banner no-print" role="alert"><strong>{a.title}</strong><span>{a.detail}</span><NavLink to="/monitoring?tab=system">Monitoring →</NavLink></div>
          ))}
          <ErrorBoundary key={loc.pathname} label="This page">
          <div className="page-enter" key={loc.pathname}>
          {!inEdition(loc.pathname) ? <Navigate to="/" replace /> : null}
          <Routes>
            <Route path="/" element={light ? <LightHome /> : !can('resources.read') && can('breakfast.read') ? <Navigate to="/breakfast" replace /> : !can('resources.read') && !can('reports.read') && can('muster.read') ? <Navigate to="/muster" replace /> : <Overview />} />
            <Route path="/staff" element={<StaffPage />} />
            <Route path="/keys" element={<KeysPage />} />
            <Route path="/keys/:keyId" element={<KeysPage />} />
            <Route path="/operators" element={<OperatorsPage />} />
            <Route path="/connector" element={<ConnectorPage />} />
            <Route path="/branding" element={<BrandingPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/insights" element={<InsightsPage />} />
            <Route path="/events" element={<EventLogPage />} />
            <Route path="/room-keycards" element={<RoomKeycardsPage />} />
            <Route path="/charts" element={<ChartsPage />} />
            <Route path="/monitoring" element={<MonitoringPage />} />
            <Route path="/battery" element={<BatteryPage />} />
            <Route path="/battery/:doorId" element={<BatteryPage />} />
            <Route path="/locks-online" element={<OnlineLocksPage />} />
            <Route path="/lock-troubleshoot" element={<LockTroubleshootPage />} />
            <Route path="/lock-troubleshoot/door/:doorId" element={<DoorHistoryPage />} />
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
            <Route path="/demo" element={me.isPlatformAdmin ? <DemoPage /> : <Navigate to="/" />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
          </div>
          </ErrorBoundary>
        </main>
      </div>
      <FeedbackButton />
      <TipLayer />
    </HotelCtx.Provider>
  );
}

/** Hotel shown on the sign-in page: ?hotel=<code> in the URL, else the build default, else this installation's hotel. */
const LOGIN_HOTEL = new URLSearchParams(location.search).get('hotel') ?? (import.meta.env.VITE_DEFAULT_HOTEL as string | undefined) ?? 'default';

function Login({ onSignedIn, light }: { onSignedIn: (t: string) => void; light?: boolean }) {
  const openAvail = (() => { try { return sessionStorage.getItem('smk.openAvail') === '1'; } catch { return false; } })();
  const [brand, setBrand] = useState<any>(null);
  useEffect(() => {
    api(`/mobile/v1/config?hotel=${encodeURIComponent(LOGIN_HOTEL)}`).then((c) => { setBrand({ ...c.branding, hotelName: c.property?.displayName ?? c.hotel?.name, kind: c.property?.kind, supportEmail: c.property?.supportEmail, supportPhone: c.property?.supportPhone }); applyBrand(c.branding); document.title = c.branding?.portalTitle ?? `${c.hotel?.name ?? 'Access Monitoring Tool'} · Sign in`; }).catch(() => {});
  }, []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [help, setHelp] = useState(false);
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
  const name = brand?.hotelName ?? null;
  const org = brand?.kind === 'institution' ? 'institution' : 'hotel';
  return (
    <div className="landing">
      <a className="skip" href="#signin">{tr('Skip to sign in')}</a>
      <section className="land-hero" aria-label={name ?? 'Access Monitoring Tool'}>
        <header className="land-top">
          {brand?.logo ? <img className="land-logo" src={brand.logo} alt={name ?? 'Logo'} /> : <strong className="land-name">{name ?? 'Access Monitoring Tool'}</strong>}
          <LangPicker />
        </header>
        <div className="land-copy">
          {light ? <>
            <h1>{name ? (lang() === 'fr' ? <>Les rapports et les serrures de {name}.</> : <>Reports and locks of {name}.</>) : tr('Reports and locks, in one place.')}</h1>
            <p>{tr('Keycards and people from Visionline, lock batteries and troubleshooting, and the reports. On the hotel network the reports open without signing in; administrators sign in here.')}</p>
          </> : <>
          <h1>{name ? (lang() === 'fr' ? <>Chaque porte, badge et serrure de {name}.</> : <>Every door, keycard and lock at {name}.</>) : tr('Every door, keycard and lock, in one place.')}</h1>
          <p>{tr('Who opened which door, which keycards are in use, which locks need batteries, and who is in the building in an emergency. Read from Visionline; nothing is changed without a person asking for it.')}</p>
          </>}
        </div>
        <TapScene logo={brand?.logo} name={name} />
      </section>
      <section className="land-form" id="signin" aria-label={tr('Sign in')}>
        <form onSubmit={submit}>
          <h2>{tr('Sign in')}</h2>
          <p className="muted small">{needTotp ? tr('Enter the code from your authenticator app.') : tr(`With the work e-mail address your ${org}'s administrator invited.`)}</p>
          <ErrorNote error={error} />
          {!needTotp ? (
            <>
              <div className="field"><label htmlFor="em">{tr('Work email')}</label><input id="em" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
              <div className="field"><label htmlFor="pw">{tr('Password')}</label><input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
            </>
          ) : (
            <div className="field"><label htmlFor="otp">{tr('Authentication code')}</label><input id="otp" inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} autoFocus required /><span className="hint">{tr('The 6-digit code from your authenticator app.')}</span></div>
          )}
          <button className="btn primary land-submit" disabled={busy}>{tr(busy ? 'Signing in…' : needTotp ? 'Verify' : 'Sign in')}</button>
          <button type="button" className="linklike" aria-expanded={help} onClick={() => setHelp(!help)}>{tr('Forgotten password or first time here?')}</button>
          {openAvail && <button type="button" className="linklike" onClick={() => { try { sessionStorage.removeItem('smk.signin'); } catch { /* ignore */ } location.assign('/'); }}>{tr('Back to the reports (no sign-in)')}</button>}
          {help && (
            <div className="land-help">
              <p><strong>{tr('First time:')}</strong> {tr('open the invitation link from your e-mail and choose your password there.')}</p>
              <p><strong>{tr('Forgotten password:')}</strong> {tr('ask an administrator for a password link (Users, then Password link). It works once.')}</p>
              <p><strong>{tr('Lost the phone with your authenticator app:')}</strong> {tr('an administrator can reset your two-step sign-in.')}</p>
              {(brand?.supportPhone || brand?.supportEmail) && !/\.(invalid|example)$/.test(brand?.supportEmail ?? '') && <p><strong>{tr('Help:')}</strong> {brand.supportPhone && <a href={`tel:${brand.supportPhone}`}>{brand.supportPhone}</a>}{brand.supportPhone && brand.supportEmail ? ', ' : ''}{brand.supportEmail && <a href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>}</p>}
            </div>
          )}
        </form>
        <div className="land-more">
          <LoginFeed />
          <ul className="land-roles">
            {(light ? LIGHT_ROLES : ROLES).map(([t, d]) => <li key={t}><strong>{tr(t!)}</strong><span>{tr(d!)}</span></li>)}
          </ul>
          <p className="land-foot small muted">{tr('Access Monitoring Tool. Every sign-in and every change is kept in the audit trail.')}</p>
        </div>
      </section>
    </div>
  );
}

/**
 * 2.24 The one moving thing on the sign-in page: a keycard with the property's logo is held to a lock and the light
 * turns green. Plays once; still with reduced motion.
 */
function TapScene({ logo, name }: { logo?: string; name: string | null }) {
  return (
    <div className="tap" aria-hidden>
      <div className="tap-card">
        {logo ? <img src={logo} alt="" /> : <span className="tap-mono">{(name ?? 'Staff').split(/\s+/).map((w) => w[0]).join('').slice(0, 3)}</span>}
        <span className="tap-label">Staff</span>
      </div>
      <div className="tap-lock"><span className="tap-led" /><span className="tap-handle" /></div>
    </div>
  );
}

/** 2.17 Notices (the site's public posts) and good-practice reminders, one after the other. */
const LOGIN_TIPS = [
  { kind: 'tip', title: 'Lost a keycard?', body: 'Tell front office or security at once: the card is cancelled in minutes and nobody can use it.' },
  { kind: 'tip', title: 'Leaving the company?', body: 'Your manager asks for your keycard to be returned and cancelled; it takes one minute.' },
  { kind: 'tip', title: 'Your password is yours', body: 'Never share it. Turn on two-step sign-in under Your account for extra protection.' },
  { kind: 'tip', title: 'Lock batteries', body: 'When a lock shows a battery alarm, report it: changing batteries in good time avoids lock-outs.' },
];
const ROLES = [
  ['Front office and security', 'Issue, verify and extend staff keycards, look up any card, see who is in the building.'],
  ['Engineering', 'Lock batteries, locks offline, troubleshooting reports and maintenance requests.'],
  ['Managers and HR', 'Keycard requests for their team, returns when someone leaves, reports and charts.'],
  ['Administrators', 'Users, settings, the setup report and the audit trail.'],
];
/** 2.33 Light edition (reports only). */
const LIGHT_ROLES = [
  ['Management and front office', 'Reports, Visionline keycards and people, look up any card.'],
  ['Engineering', 'Lock batteries, lock troubleshooting and maintenance requests.'],
  ['Administrators', 'Users, settings and the Visionline setup report.'],
];
function LoginFeed() {
  const [posts, setPosts] = useState<any[]>([]);
  const [i, setI] = useState(0);
  useEffect(() => { api(`/api/v1/public/notices?hotel=${encodeURIComponent(LOGIN_HOTEL)}`).then((r) => setPosts(r.notices ?? [])).catch(() => undefined); }, []);
  const slides = [...posts, ...LOGIN_TIPS];
  useEffect(() => { const t = setInterval(() => setI((x) => x + 1), 9000); return () => clearInterval(t); }, []);
  const cur = slides[i % slides.length]!;
  return (
    <div className="land-feed">
      <div className="login-slide" key={i % slides.length} aria-live="polite">
        {cur.image && <img src={cur.image} alt="" />}
        <span className={`notice-kind k-${cur.kind}`}>{tr(cur.kind === 'tip' ? 'Good to know' : cur.kind === 'important' ? 'Important' : cur.kind === 'event' ? 'Event' : 'News')}</span>
        <strong>{cur.kind === 'tip' ? tr(cur.title) : cur.title}</strong>
        {cur.body && <p>{cur.kind === 'tip' ? tr(cur.body) : cur.body}</p>}
      </div>
      <div className="login-dots" role="tablist" aria-label="Messages">{slides.map((_, k) => <button key={k} aria-label={`Message ${k + 1}`} aria-pressed={k === i % slides.length} onClick={() => setI(k)} />)}</div>
    </div>
  );
}

/** Appearance: follow the computer (System), or always Light / Dark. Remembered on this computer. */
function ThemeSwitch() {
  const { me, setPrefs } = useHotel();
  const [pref, setPref] = useState<ThemePref>(themePref());
  const choose = (p: ThemePref) => {
    setThemePref(p); setPref(p);
    const next = { ...me.prefs, hiddenNav: me.prefs?.hiddenNav ?? [], theme: p };
    setPrefs(next); void api('/api/v1/me/prefs', { method: 'PUT', body: next }).catch(() => undefined);
  };
  return (
    <div className="theme-switch" role="group" aria-label="Appearance">
      {(['system', 'light', 'dark'] as const).map((p) => <button key={p} aria-pressed={pref === p} onClick={() => choose(p)} data-tip={p === 'system' ? 'Light or dark like this computer' : p === 'light' ? 'Always light' : 'Always dark'}>{tr(p === 'system' ? 'Auto' : p === 'light' ? 'Light' : 'Dark')}</button>)}
    </div>
  );
}

/** 2.27 Language: English or French. Remembered on this computer and with the person's preferences. */
function LangSwitch() {
  const { me, setPrefs } = useHotel();
  const choose = (l: LangChoice) => {
    setLang(l);
    const next = { ...me.prefs, hiddenNav: me.prefs?.hiddenNav ?? [], theme: me.prefs?.theme ?? themePref(), lang: l };
    setPrefs(next); void api('/api/v1/me/prefs', { method: 'PUT', body: next }).catch(() => undefined);
  };
  return <LangPicker onPick={choose} />;
}
export function LangPicker({ onPick = setLang }: { onPick?: (l: LangChoice) => void }) {
  return (
    <div className="theme-switch lang-switch" role="group" aria-label={tr('Language')}>
      {LANGS.map((l) => <button key={l.id} lang={l.id === 'auto' ? undefined : l.id} aria-pressed={langChoice() === l.id} data-tip={l.id === 'auto' ? 'Follow this browser / computer language' : undefined} onClick={() => onPick(l.id)}>{l.id === 'auto' ? tr('Auto') : l.label}</button>)}
    </div>
  );
}
