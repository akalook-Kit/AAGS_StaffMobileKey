import { useState } from 'react';
import { PageHead } from '../ui';
import { Builder, MyReports, type Spec } from '../components/ReportBuilder';

/**
 * 2.17 My charts: anyone who can read some data (door events, keycards, maintenance, breakfast…) builds their own
 * charts from it, saves them, shares them and pins them to the Overview. Each data set keeps its own permission.
 */
export function ChartsPage() {
  const [mode, setMode] = useState<'list' | 'build'>('list');
  const [editing, setEditing] = useState<any>(null);
  const [start, setStart] = useState<Spec | null>(null);
  return (
    <>
      <PageHead title="My charts" intro="Build your own charts: choose the data, what to count, how to group it and the kind of chart. Save, share with colleagues, or pin to your Overview (★)." />
      {mode === 'build'
        ? <Builder key={editing?.id ?? JSON.stringify(start)} initial={editing?.spec ?? start ?? undefined} savedId={editing?.id} savedName={editing?.name}
            savedFlags={editing ? { pinned: editing.pinned, shared: editing.shared } : undefined} onSaved={() => { setMode('list'); setEditing(null); }} onCancel={() => { setMode('list'); setEditing(null); }} />
        : <MyReports onEdit={(r) => { setEditing(r); setMode('build'); }} onNew={(sp) => { setEditing(null); setStart(sp ?? null); setMode('build'); }} />}
    </>
  );
}
