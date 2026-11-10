import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorNote } from '../ui';

/**
 * First-run setup (2.9): the hotel's details, the first administrator and, optionally, the Credential Services
 * account are entered here once, instead of in PowerShell. Needs the setup code the installer showed (the
 * installer opens this page with the code already filled in). Closed for good once done.
 */
const COUNTRIES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const TZ_COUNTRY: Record<string, string> = {
  'Africa/Nairobi': 'KE', 'Africa/Kigali': 'RW', 'Africa/Kampala': 'UG', 'Africa/Dar_es_Salaam': 'TZ', 'Africa/Douala': 'CM', 'Africa/Lagos': 'NG',
  'Africa/Johannesburg': 'ZA', 'Africa/Addis_Ababa': 'ET', 'Africa/Accra': 'GH', 'Africa/Abidjan': 'CI', 'Africa/Dakar': 'SN', 'Africa/Kinshasa': 'CD',
  'Africa/Lubumbashi': 'CD', 'Africa/Lusaka': 'ZM', 'Africa/Harare': 'ZW', 'Africa/Cairo': 'EG', 'Africa/Casablanca': 'MA', 'Africa/Bujumbura': 'BI',
  'Africa/Maputo': 'MZ', 'Africa/Luanda': 'AO', 'Africa/Libreville': 'GA', 'Africa/Tunis': 'TN', 'Africa/Algiers': 'DZ', 'Asia/Dubai': 'AE', 'Europe/Paris': 'FR', 'Europe/London': 'GB',
};
const slugify = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function SetupPage({ info }: { info: { version: string; serverTimeZone?: string; secretStore?: boolean; hotel?: { name: string } | null; suggest?: { name?: string; timeZone?: string; country?: string } } }) {
  const zones = useMemo(() => { try { return (Intl as any).supportedValuesOf('timeZone') as string[]; } catch { return [info.serverTimeZone ?? 'UTC']; } }, [info.serverTimeZone]);
  const countries = useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* old browser */ }
    return COUNTRIES.map((c) => ({ code: c, name: names?.of(c) ?? c })).sort((a, b) => a.name.localeCompare(b.name));
  }, []);
  const [code, setCode] = useState(() => new URLSearchParams(location.hash.slice(1)).get('code') ?? '');
  // 2.33 An edition installer (La Falaise) suggests the hotel's name, time zone and country.
  const sg = info.suggest;
  const tz0 = sg?.timeZone && zones.includes(sg.timeZone) ? sg.timeZone : info.serverTimeZone && zones.includes(info.serverTimeZone) ? info.serverTimeZone : 'Africa/Nairobi';
  const [h, setH] = useState({ kind: 'hotel' as 'hotel' | 'institution', name: sg?.name ?? '', code: '', timeZone: tz0, country: sg?.country ?? TZ_COUNTRY[tz0] ?? '', systemId: '', systemNumber: '', supportEmail: '', supportPhone: '' });
  const [codeTouched, setCodeTouched] = useState(false);
  const [a, setA] = useState({ name: '', email: '', password: '', again: '' });
  const [cs, setCs] = useState({ user: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ hotel: { name: string }; admin: { email: string } } | null>(null);
  useEffect(() => { document.title = 'Set up Access Monitoring Tool'; }, []);
  // The code is only needed in the address once; keep it out of the browser history afterwards.
  useEffect(() => { if (location.hash) history.replaceState(null, '', location.pathname); }, []);

  const hotelCode = codeTouched ? h.code : slugify(h.name);
  const pwProblem = a.password && a.password.length < 12 ? 'At least 12 characters.' : a.again && a.again !== a.password ? 'The two passwords differ.' : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pwProblem) return;
    setBusy(true); setError(null);
    try {
      const r = await api('/api/v1/setup', {
        body: {
          code,
          hotel: info.hotel ? undefined : { kind: h.kind, name: h.name, code: hotelCode, timeZone: h.timeZone, country: h.country, systemId: h.systemId ? Number(h.systemId) : 0, systemNumber: h.systemNumber || undefined, supportEmail: h.supportEmail, supportPhone: h.supportPhone || undefined },
          admin: { name: a.name, email: a.email, password: a.password },
          ...(cs.user || cs.password ? { credentialServices: cs } : {}),
        },
      });
      setA({ ...a, password: '', again: '' }); setCs({ user: '', password: '' });
      setDone(r);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  if (done) return (
    <div className="setup">
      <div className="setup-card">
        <div className="setup-mark" aria-hidden>✓</div>
        <h1>{done.hotel.name} is set up</h1>
        <p className="muted">Sign in as <strong>{done.admin.email}</strong> with the password you just chose. Then, in the portal:</p>
        <ol className="setup-next">
          <li><strong>Connector health</strong>: the connector on this server shows Online.</li>
          <li><strong>Settings → Visionline</strong>: enter the Visionline account (it is encrypted for the connector), then run discovery.</li>
          <li><strong>Branding</strong>: your logo and colours. <strong>Settings → Name &amp; details</strong>: address and report footer.</li>
          <li><strong>Account</strong>: turn on two-step sign-in.</li>
        </ol>
        <button className="btn primary" onClick={() => { location.replace('/'); }}>Go to sign in</button>
      </div>
    </div>
  );

  return (
    <div className="setup">
      <form className="setup-card" onSubmit={submit}>
        <p className="setup-kicker">Access Monitoring Tool {info.version} · first-run setup</p>
        <h1>Set up this installation</h1>
        <p className="muted">Enter your organisation's details and create the first administrator. Everything here can be changed later in the portal, except the short code.</p>
        <ErrorNote error={error} />

        <h2 className="section-title">Setup code</h2>
        <div className="field">
          <label htmlFor="sc">Code shown at the end of the installation</label>
          <input id="sc" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX" required style={{ fontFamily: 'ui-monospace, Consolas, monospace', letterSpacing: '0.08em' }} />
          <span className="hint">Also saved on this server in <code>C:\ProgramData\StaffMobileKey\Platform\setup-code.txt</code> (administrators only).</span>
        </div>

        {info.hotel ? (
          <><h2 className="section-title">Organisation</h2><p>{info.hotel.name} <span className="muted small">(already set up; change its details later in Settings → Name &amp; details)</span></p></>
        ) : <>
        <h2 className="section-title">Organisation</h2>
        <div className="field"><label>Type</label>
          <div className="seg" role="group" aria-label="Type">
            <button type="button" aria-pressed={h.kind === 'hotel'} onClick={() => setH({ ...h, kind: 'hotel' })}>Hotel</button>
            <button type="button" aria-pressed={h.kind === 'institution'} onClick={() => setH({ ...h, kind: 'institution' })}>Institution</button>
          </div>
          <span className="hint">{h.kind === 'hotel' ? 'Guest features (breakfast, unpaid guests, departures, Accounts report) are available.' : 'Offices, a hospital, a school… Guest features are left out. You can change this later.'}</span></div>
        <div className="field"><label htmlFor="hn">Name</label><input id="hn" value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} required minLength={2} maxLength={80} placeholder="Lakeview Resort Kigali" /><span className="hint">As shown in the portal, the staff app and on every report.</span></div>
        <div className="field-row">
          <div className="field"><label htmlFor="tz">Time zone</label>
            <select id="tz" value={h.timeZone} onChange={(e) => setH({ ...h, timeZone: e.target.value, country: h.country || TZ_COUNTRY[e.target.value] || '' })} required>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="co">Country</label>
            <select id="co" value={h.country} onChange={(e) => setH({ ...h, country: e.target.value })} required>
              <option value="">Choose…</option>
              {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </div>
        </div>
        <div className="field-row">
          <div className="field"><label htmlFor="sid">ASSA ABLOY System ID</label><input id="sid" inputMode="numeric" pattern="\d*" value={h.systemId} onChange={(e) => setH({ ...h, systemId: e.target.value.replace(/\D/g, '') })} placeholder="e.g. 3460" /><span className="hint">Visionline: Options → Mobile Access. Leave empty to add later.</span></div>
          <div className="field"><label htmlFor="sno">System number on reports</label><input id="sno" value={h.systemNumber} onChange={(e) => setH({ ...h, systemNumber: e.target.value })} maxLength={40} placeholder="Same as System ID" /></div>
        </div>
        <div className="field-row">
          <div className="field"><label htmlFor="se">Support e-mail for staff</label><input id="se" type="email" value={h.supportEmail} onChange={(e) => setH({ ...h, supportEmail: e.target.value })} placeholder="support@example.com" /></div>
          <div className="field"><label htmlFor="sp">Support phone for staff</label><input id="sp" value={h.supportPhone} onChange={(e) => setH({ ...h, supportPhone: e.target.value })} placeholder="+254 700 000 000" /></div>
        </div>
        <details className="setup-more">
          <summary>Short code: <code>{hotelCode || '…'}</code></summary>
          <div className="field" style={{ marginTop: 10 }}><label htmlFor="hc">Short code</label><input id="hc" value={hotelCode} onChange={(e) => { setCodeTouched(true); setH({ ...h, code: e.target.value.toLowerCase() }); }} pattern="[a-z0-9][a-z0-9\-]{1,39}" /><span className="hint">Used in links and by the staff app. Lower-case letters, digits and dashes. Cannot be changed later.</span></div>
        </details>
        </>}

        <h2 className="section-title">First administrator</h2>
        <div className="field-row">
          <div className="field"><label htmlFor="an">Full name</label><input id="an" value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} required minLength={2} autoComplete="name" /></div>
          <div className="field"><label htmlFor="ae">Work e-mail (sign-in)</label><input id="ae" type="email" value={a.email} onChange={(e) => setA({ ...a, email: e.target.value })} required autoComplete="username" /></div>
        </div>
        <div className="field-row">
          <div className="field"><label htmlFor="ap">Password</label><input id="ap" type="password" value={a.password} onChange={(e) => setA({ ...a, password: e.target.value })} required minLength={12} autoComplete="new-password" /><span className="hint">At least 12 characters.</span></div>
          <div className="field"><label htmlFor="ap2">Same password again</label><input id="ap2" type="password" value={a.again} onChange={(e) => setA({ ...a, again: e.target.value })} required autoComplete="new-password" /></div>
        </div>
        {pwProblem && <div className="alert warn">{pwProblem}</div>}

        <h2 className="section-title">ASSA ABLOY Credential Services <span className="muted small" style={{ fontWeight: 400 }}>(optional)</span></h2>
        {info.secretStore === false ? (
          <p className="muted small">This server keeps this account in its own settings. Add it later with the server tools.</p>
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>The account ASSA ABLOY gave you for mobile keys. Stored encrypted on this server; it can never be read back in the portal. You can also add it later in Settings → Credential Services.</p>
            <div className="field-row">
              <div className="field"><label htmlFor="cu">User</label><input id="cu" value={cs.user} onChange={(e) => setCs({ ...cs, user: e.target.value })} autoComplete="off" spellCheck={false} /></div>
              <div className="field"><label htmlFor="cp">Password</label><input id="cp" type="password" value={cs.password} onChange={(e) => setCs({ ...cs, password: e.target.value })} autoComplete="new-password" /></div>
            </div>
          </>
        )}

        <div className="row end" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={busy || Boolean(pwProblem)} style={{ padding: '10px 18px' }}>{busy ? 'Setting up…' : 'Set up'}</button>
        </div>
      </form>
    </div>
  );
}
