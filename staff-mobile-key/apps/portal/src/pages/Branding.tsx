import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { useHotel } from '../App';
import { ErrorNote, PageHead, fmt, useApi } from '../ui';

const FONTS: Record<string, string> = { system: 'system-ui, sans-serif', serif: 'Georgia, "Times New Roman", serif', rounded: '"Trebuchet MS", "Segoe UI", sans-serif' };

/** Runtime app branding with live preview (spec §13.4.1, §13.5). Every publish is a new version that can be rolled back. */
export function BrandingPage() {
  const { base, reloadBranding } = useHotel();
  const cfg = useApi<any>(`${base}/config/branding`);
  const policy = useApi<any>(`${base}/config/app_policy`);
  const [b, setB] = useState<any>(null);
  const [os, setOs] = useState<'android' | 'ios'>('android');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => { if (cfg.data?.data && !b) setB(cfg.data.data); }, [cfg.data, b]);
  if (!b) return <><PageHead title="Mobile app settings" /><ErrorNote error={cfg.error} /></>;
  const set = (k: string, v: unknown) => { setB({ ...b, [k]: v }); setSaved(null); };
  const setW = (k: string, v: string) => set('wording', { ...b.wording, [k]: v });
  const image = (k: 'logo' | 'heroImage', limitKb: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setError(new Error('Use a PNG, JPEG or WebP image.')); return; }
    if (file.size > limitKb * 1024) { setError(new Error(`That image is ${Math.ceil(file.size / 1024)} KB; the limit is ${limitKb} KB.`)); return; }
    const r = new FileReader();
    r.onload = () => { setError(null); set(k, r.result as string); };
    r.readAsDataURL(file);
  };
  const publish = async () => {
    setError(null);
    try { const r = await api(`${base}/config/branding`, { method: 'PUT', body: b }); setSaved(`Published as version ${r.version}. Phones pick it up the next time the app opens.`); await cfg.reload(); reloadBranding(); }
    catch (e) { setError(e); }
  };
  const rollback = async (v: number) => {
    try { await api(`${base}/config/branding/rollback/${v}`, { body: {} }); setB(null); await cfg.reload(); reloadBranding(); setSaved(`Version ${v} is live again.`); } catch (e) { setError(e); }
  };
  const vars = { '--p-primary': b.primaryColor, '--p-secondary': b.secondaryColor, '--p-bg': b.backgroundColor, '--p-on': b.textOnPrimary, '--p-font': FONTS[b.fontFamily] } as CSSProperties;
  const w = b.wording ?? {};

  return (
    <>
      <PageHead title="Mobile app settings" intro="How the staff app looks for this hotel. Changes apply without a new app release.">
        <button className="btn primary" onClick={publish}>Publish changes</button>
      </PageHead>
      <ErrorNote error={error} />
      {saved && <div className="alert ok">{saved}</div>}
      <div className="split" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px' }}>
        <div>
          <div className="panel">
            <h2>Identity</h2>
            <div className="field-row">
              <div className="field"><label htmlFor="an">App name</label><input id="an" value={b.appName} onChange={(e) => set('appName', e.target.value)} maxLength={30} /><span className="hint">Shown inside the app. The home-screen name is fixed in each signed release.</span></div>
              <div className="field"><label htmlFor="pt">Portal title</label><input id="pt" value={b.portalTitle} onChange={(e) => set('portalTitle', e.target.value)} /></div>
            </div>
            <div className="field-row">
              <div className="field"><label htmlFor="lg">Logo</label><input id="lg" type="file" accept="image/png,image/jpeg,image/webp" onChange={image('logo', 500)} /><span className="hint">PNG, JPEG or WebP, at least 64 px wide, up to 500 KB.</span>{b.logo && <button className="btn small" style={{ marginTop: 6, alignSelf: 'start' }} onClick={() => set('logo', null)}>Remove logo</button>}</div>
              <div className="field"><label htmlFor="hi">Hotel photo</label><input id="hi" type="file" accept="image/png,image/jpeg,image/webp" onChange={image('heroImage', 1500)} /><span className="hint">At least 600 px wide, up to 1.5 MB.</span>{b.heroImage && <button className="btn small" style={{ marginTop: 6, alignSelf: 'start' }} onClick={() => set('heroImage', null)}>Remove photo</button>}</div>
            </div>
          </div>
          <div className="panel">
            <h2>Colour and type</h2>
            <div className="field-row">
              {[['primaryColor', 'Primary'], ['secondaryColor', 'Accent'], ['textOnPrimary', 'Text on primary'], ['backgroundColor', 'Background']].map(([k, l]) => (
                <div className="field" key={k}><label htmlFor={k}>{l}</label><div className="row"><input id={k} type="color" value={b[k]} onChange={(e) => set(k, e.target.value.toUpperCase())} /><span className="mono">{b[k]}</span></div></div>
              ))}
            </div>
            <div className="field"><label htmlFor="ff">Typeface style</label><select id="ff" value={b.fontFamily} onChange={(e) => set('fontFamily', e.target.value)}><option value="system">Phone default</option><option value="serif">Classic serif</option><option value="rounded">Rounded</option></select></div>
            <p className="small muted">Text on the primary colour must reach WCAG AA contrast (4.5:1); publishing is refused otherwise.</p>
          </div>
          <div className="panel">
            <h2>Wording</h2>
            <div className="field-row">
              {[['keysTitle', 'Key list title'], ['accessAreas', 'Doors heading'], ['validUntil', 'Expiry label'], ['support', 'Support tab'], ['tapInstruction', 'Door-opening instruction']].map(([k, l]) => (
                <div className="field" key={k}><label htmlFor={`w-${k}`}>{l}</label><input id={`w-${k}`} value={w[k] ?? ''} onChange={(e) => setW(k, e.target.value)} /></div>
              ))}
            </div>
          </div>
          <div className="panel">
            <h2>Published versions</h2>
            <table className="grid small"><tbody>
              {(cfg.data?.history ?? []).map((h: any) => (
                <tr key={h.version}><td>Version {h.version}{h.version === cfg.data.version ? ' · live' : ''}</td><td className="muted">{fmt.dt(h.created_at)} · {h.created_by ?? 'setup'}</td>
                  <td style={{ textAlign: 'right' }}>{h.version !== cfg.data.version && <button className="btn small" onClick={() => rollback(h.version)}>Make live again</button>}</td></tr>
              ))}
            </tbody></table>
          </div>
          {policy.data?.data && (
            <div className="panel">
              <h2>App policy</h2>
              <dl className="kv"><dt>Privacy text</dt><dd>{policy.data.data.privacyText || '—'}</dd><dt>Escalation</dt><dd>{policy.data.data.supportEscalation || '—'}</dd><dt>Partner links</dt><dd>{policy.data.data.partnerLinks.length ? policy.data.data.partnerLinks.map((l: any) => l.label).join(', ') : 'None (module off)'}</dd></dl>
            </div>
          )}
        </div>
        <div style={{ position: 'sticky', top: 20 }}>
          <div className="row" style={{ justifyContent: 'center', marginBottom: 12 }}>
            <div className="seg" role="group" aria-label="Preview"><button aria-pressed={os === 'android'} onClick={() => setOs('android')}>Android</button><button aria-pressed={os === 'ios'} onClick={() => setOs('ios')}>iPhone</button></div>
          </div>
          <div className="phone" style={{ ...vars, borderRadius: os === 'ios' ? 44 : 28 }} aria-label="App preview">
            <div className="scr">
              <div className="top" style={{ paddingTop: os === 'ios' ? 44 : 30 }}>
                {b.logo && <img src={b.logo} alt="" />}
                <div className="t">{w.keysTitle}</div>
                <div style={{ opacity: 0.8, fontSize: 13 }}>Good morning, Amina</div>
              </div>
              {b.heroImage && <div className="hero" style={{ backgroundImage: `url(${b.heroImage})` }} />}
              <div className="card">
                <div style={{ fontSize: 12, color: '#5b6661' }}>{w.accessAreas}</div>
                <div className="rooms">101 – 110</div>
                <div style={{ fontSize: 13 }}>Floor 1 · Staff Entrance · Linen Store</div>
                <div style={{ fontSize: 12, color: '#5b6661', marginTop: 8 }}>{w.validUntil} 17:00 today</div>
              </div>
              <div className="tap">{w.tapInstruction}</div>
              <div style={{ textAlign: 'center', fontSize: 12, color: '#5b6661', marginTop: 8 }}>Bluetooth on · key ready</div>
              <div className="bar"><span style={{ color: b.primaryColor, fontWeight: 700 }}>{w.keysTitle}</span><span>{w.support}</span><span>Profile</span></div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
