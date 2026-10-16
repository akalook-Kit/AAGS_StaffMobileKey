import { useState } from 'react';
import { api } from '../api';
import { useHotel } from '../App';
import { Drawer, ErrorNote } from '../ui';
import { parseCsv } from '../csv';

/** Target fields for a staff import, with header names we recognise (English and French). */
const TARGETS = [
  { k: 'fullName', label: 'Full name', match: ['full name', 'fullname', 'name', 'nom complet', 'staff name', 'employee name'] },
  { k: 'firstName', label: 'First name', match: ['first name', 'firstname', 'given name', 'prenom', 'prénom'] },
  { k: 'lastName', label: 'Last name', match: ['last name', 'lastname', 'surname', 'family name', 'nom', 'nom de famille'] },
  { k: 'email', label: 'Email', match: ['email', 'e-mail', 'mail', 'work email', 'courriel', 'adresse e-mail'] },
  { k: 'employeeNo', label: 'Employee number', match: ['employee no', 'employee number', 'employee id', 'staff id', 'matricule', 'id'] },
  { k: 'jobRole', label: 'Job role', match: ['job role', 'role', 'job title', 'title', 'position', 'poste', 'fonction'] },
  { k: 'userGroup', label: 'Visionline user group', match: ['user group', 'usergroup', 'group', 'visionline group', 'groupe', 'groupe utilisateur'] },
  { k: 'visionlineUser', label: 'Visionline user ID', match: ['visionline user', 'card holder', 'cardholder', 'visionline id'] },
] as const;
type Key = (typeof TARGETS)[number]['k'];

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[_.]/g, ' ').replace(/\s+/g, ' ').trim();
function autoMap(headers: string[]): Partial<Record<Key, number>> {
  const m: Partial<Record<Key, number>> = {};
  headers.forEach((h, i) => {
    const n = norm(h);
    for (const t of TARGETS) if (m[t.k] === undefined && t.match.some((x) => norm(x) === n)) { m[t.k] = i; break; }
  });
  return m;
}
/** "Mbarga, Eric" → "Eric Mbarga" (vendor import format "Last, First"). */
const flipName = (s: string) => { const [last, ...rest] = s.split(','); return rest.length ? `${rest.join(',').trim()} ${last!.trim()}` : s.trim(); };

const TEMPLATE = 'Full name,Email,Employee number,Job role,Visionline user group\r\n"Mbarga, Eric",eric.mbarga@khoteldouala.com,KHB-0101,Maintenance,Maintenance\r\n';

export function ImportStaff({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { base } = useHotel();
  const [rows, setRows] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState('');
  const [map, setMap] = useState<Partial<Record<Key, number>>>({});
  const [lastFirst, setLastFirst] = useState(false);
  const [mode, setMode] = useState<'skip' | 'update'>('skip');
  const [preview, setPreview] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  const load = async (f: File) => {
    setError(null); setPreview(null); setDone(null);
    if (f.size > 2_000_000) { setError(new Error('The file is larger than 2 MB. Split it or remove unused columns.')); return; }
    const r = parseCsv(await f.text());
    if (r.length < 2) { setError(new Error('No rows found. The first line must be the column headers.')); return; }
    setFileName(f.name); setRows(r);
    const m = autoMap(r[0]!);
    setMap(m);
    const nameCol = m.fullName;
    setLastFirst(nameCol !== undefined && r.slice(1, 20).filter((x) => (x[nameCol] ?? '').includes(',')).length > 0);
  };
  const headers = rows?.[0] ?? [];
  const body = (rows ?? []).slice(1);
  const build = () => body.map((r) => {
    const get = (k: Key) => (map[k] !== undefined ? (r[map[k]!] ?? '').trim() : '');
    let fullName = get('fullName');
    if (fullName && lastFirst) fullName = flipName(fullName);
    if (!fullName) fullName = [get('firstName'), get('lastName')].filter(Boolean).join(' ');
    return { fullName, email: get('email'), employeeNo: get('employeeNo') || null, jobRole: get('jobRole') || null, userGroup: get('userGroup') || null, visionlineUser: get('visionlineUser') || null };
  });
  const send = async (dryRun: boolean) => {
    setBusy(true); setError(null);
    try {
      const r = await api(`${base}/staff/import`, { body: { rows: build(), mode, dryRun } });
      if (dryRun) setPreview(r); else { setDone(r); onDone(); }
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob(['﻿' + TEMPLATE], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'staff-import-template.csv' });
    a.click(); URL.revokeObjectURL(url);
  };
  const ready = map.email !== undefined && (map.fullName !== undefined || map.firstName !== undefined || map.lastName !== undefined);
  const s = (done ?? preview)?.summary;
  const outcomeLabel: Record<string, string> = { create: 'Will be added', update: 'Will be updated', skip: 'Already exists — skipped', invalid: 'Cannot import' };

  return (
    <Drawer title="Import staff" onClose={onClose} footer={
      <>
        <button className="btn" onClick={download}>Download a template</button>
        <div className="row">
          <button className="btn" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
          {rows && !done && <button className="btn" disabled={!ready || busy} onClick={() => send(true)}>{busy && !preview ? 'Checking…' : 'Check file'}</button>}
          {preview && !done && <button className="btn primary" disabled={busy || !(preview.summary.create + preview.summary.update)} onClick={() => send(false)}>Import {preview.summary.create + preview.summary.update} {preview.summary.create + preview.summary.update === 1 ? 'person' : 'people'}</button>}
        </div>
      </>
    }>
      <ErrorNote error={error} />
      {done && <div className="alert ok">Import finished: {s.create} added, {s.update} updated, {s.skip} skipped, {s.invalid} not imported. Staff set up their phone by signing in to the app.</div>}
      {!done && (
        <label className={`dropzone ${over ? 'over' : ''}`} style={{ display: 'block', cursor: 'pointer' }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void load(f); }}>
          <input type="file" accept=".csv,text/csv,.txt" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); }} />
          {fileName ? <><strong>{fileName}</strong> · {body.length} rows. Choose another file to replace it.</> : <>Drop a CSV file here, or click to choose one.<div className="small" style={{ marginTop: 6 }}>From Excel: File → Save As → CSV UTF-8. Up to 5,000 people.</div></>}
        </label>
      )}
      {rows && !done && (
        <>
          <h3 className="section-title" style={{ marginTop: 18 }}>Match the columns</h3>
          <div className="field-row">
            {TARGETS.map((t) => (
              <div className="field" key={t.k}>
                <label htmlFor={`m-${t.k}`}>{t.label}{t.k === 'email' && ' *'}</label>
                <select id={`m-${t.k}`} value={map[t.k] ?? ''} onChange={(e) => { setPreview(null); setMap({ ...map, [t.k]: e.target.value === '' ? undefined : Number(e.target.value) }); }}>
                  <option value="">Not in file</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </div>
            ))}
          </div>
          {!ready && <div className="alert warn">Choose the Email column and a name column (Full name, or First and Last name).</div>}
          {map.fullName !== undefined && <label className="check"><input type="checkbox" checked={lastFirst} onChange={(e) => { setLastFirst(e.target.checked); setPreview(null); }} /><span>Names are written “Last, First” (e.g. “Mbarga, Eric”)</span></label>}
          <div className="field"><label>People already in the platform (same email)</label>
            <div className="seg" role="group"><button type="button" aria-pressed={mode === 'skip'} onClick={() => { setMode('skip'); setPreview(null); }}>Skip them</button><button type="button" aria-pressed={mode === 'update'} onClick={() => { setMode('update'); setPreview(null); }}>Update name, role and group</button></div></div>
        </>
      )}
      {preview && !done && (
        <>
          <div className="scope-sum" style={{ margin: '12px 0' }}><span className="big">{s.create}</span><span>to add · {s.update} to update · {s.skip} skipped · {s.invalid} with problems</span></div>
          <div className="panel flush" style={{ maxHeight: 360, overflow: 'auto' }}>
            <table className="grid">
              <thead><tr><th>Row</th><th>Person</th><th>Result</th></tr></thead>
              <tbody>
                {preview.results.map((r: any) => {
                  const p = build()[r.row - 1];
                  return (
                    <tr key={r.row} className={r.outcome === 'invalid' ? 'invalid' : ''}>
                      <td>{r.row + 1}</td>
                      <td><strong>{p?.fullName || '—'}</strong><span className="sub">{p?.email || 'no email'}{p?.userGroup ? ` · ${p.userGroup}` : ''}</span></td>
                      <td>{outcomeLabel[r.outcome]}{r.message && <span className="sub">{r.message}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small muted">Row numbers match the lines in your file (line 1 is the headers).</p>
        </>
      )}
    </Drawer>
  );
}
