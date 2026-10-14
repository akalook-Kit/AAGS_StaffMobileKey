import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../api';
import { ink, useBrand } from '../theme';
import { useT } from '../i18n';

/**
 * Maintenance in the staff app (Phase 2): the tasks given to me, and "Report a problem".
 * Staff can acknowledge, start, put on hold and finish their own tasks; managers close them in the portal.
 */
interface Task {
  id: string; number: number; title: string; description: string; category: string; priority: string; status: string;
  doorName: string | null; doorGroup: string | null; location: string | null; asset: string | null; dueAt: string | null; overdue: boolean;
  assigneeName: string | null; batteryAlertId: string | null; comments: number;
}
const OPEN = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ON_HOLD'];
const MOVES: Record<string, { to: string; key: 'acknowledge' | 'startWork' | 'putOnHold' | 'resume' | 'resolve'; primary?: boolean }[]> = {
  OPEN: [{ to: 'ACKNOWLEDGED', key: 'acknowledge' }, { to: 'IN_PROGRESS', key: 'startWork', primary: true }],
  ACKNOWLEDGED: [{ to: 'ON_HOLD', key: 'putOnHold' }, { to: 'IN_PROGRESS', key: 'startWork', primary: true }],
  IN_PROGRESS: [{ to: 'ON_HOLD', key: 'putOnHold' }, { to: 'RESOLVED', key: 'resolve', primary: true }],
  ON_HOLD: [{ to: 'RESOLVED', key: 'resolve' }, { to: 'IN_PROGRESS', key: 'resume', primary: true }],
};
const PRIO_COLOR: Record<string, string> = { urgent: ink.bad, high: '#8A3B00', normal: ink.muted, low: ink.faint };
const STATUS_TONE: Record<string, [string, string]> = {
  OPEN: [ink.warnBg, ink.warn], ACKNOWLEDGED: [ink.warnBg, ink.warn], IN_PROGRESS: ['#E4ECF7', '#1F4E79'], ON_HOLD: ['#EEE7E3', ink.muted],
  RESOLVED: [ink.okBg, ink.ok], CLOSED: ['#EEE7E3', ink.muted], CANCELLED: ['#EEE7E3', ink.muted],
};

export function TasksScreen({ staffId }: { staffId: string }) {
  const b = useBrand();
  const { t, locale } = useT();
  const [data, setData] = useState<{ enabled: boolean; canReport?: boolean; tasks: Task[]; reported: Task[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await api('/mobile/v1/tasks')); setError(null); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); const i = setInterval(load, 15_000); return () => clearInterval(i); }, [load]);
  const when = (iso: string) => new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const where = (x: Task) => x.doorName ? `${x.doorName}${x.doorGroup ? ` · ${x.doorGroup}` : ''}` : x.location ?? '';
  const active = (data?.tasks ?? []).filter((x) => OPEN.includes(x.status));
  const done = (data?.tasks ?? []).filter((x) => !OPEN.includes(x.status));

  const card = (x: Task) => {
    const [bg, fg] = STATUS_TONE[x.status] ?? ['#EEE7E3', ink.muted];
    return (
      <Pressable key={x.id} style={[s.card, x.overdue && { borderLeftColor: ink.bad }]} onPress={() => setOpen(x.id)} accessibilityRole="button" accessibilityLabel={`${t.tasks} ${x.number}: ${x.title}`}>
        <View style={s.cardTop}>
          <Text style={s.num}>#{x.number}</Text>
          <Text style={[s.prio, { color: PRIO_COLOR[x.priority] }]}>{(t as any)[`p_${x.priority}`]}</Text>
          <View style={[s.pill, { backgroundColor: bg }]}><Text style={[s.pillT, { color: fg }]}>{(t as any)[`t_${x.status}`]}</Text></View>
        </View>
        <Text style={[s.title, { fontFamily: b.font }]}>{x.title}</Text>
        {!!where(x) && <View style={s.row}><Ionicons name="location-outline" size={15} color={ink.muted} /><Text style={s.meta}>{where(x)}</Text></View>}
        {x.dueAt && OPEN.includes(x.status) && <View style={s.row}><Ionicons name="time-outline" size={15} color={x.overdue ? ink.bad : ink.muted} /><Text style={[s.meta, x.overdue && { color: ink.bad, fontWeight: '700' }]}>{x.overdue ? `${t.overdue} · ` : ''}{t.due(when(x.dueAt))}</Text></View>}
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 30 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        <View style={[s.top, { backgroundColor: b.primary }]}>
          <Text style={[s.h1, { color: b.onPrimary, fontFamily: b.font }]}>{t.myTasks}</Text>
          {data?.canReport && (
            <Pressable style={[s.reportBtn, { borderColor: b.onPrimary }]} onPress={() => setReporting(true)} accessibilityRole="button">
              <Ionicons name="add-circle-outline" size={18} color={b.onPrimary} /><Text style={[s.reportT, { color: b.onPrimary }]}>{t.report}</Text>
            </Pressable>
          )}
        </View>
        {notice && <View style={[s.note, { backgroundColor: ink.okBg }]}><Text style={{ color: ink.ok }}>{notice}</Text></View>}
        {error && <View style={[s.note, { backgroundColor: ink.badBg }]}><Text style={{ color: ink.bad }}>{error}</Text></View>}
        {!data ? <ActivityIndicator style={{ marginTop: 30 }} color={b.primary} /> : (
          <>
            {active.length ? active.map(card) : (
              <View style={s.empty}><Ionicons name="construct-outline" size={34} color={ink.faint} /><Text style={s.emptyH}>{t.noTasksH}</Text><Text style={s.emptyT}>{t.noTasksT}</Text></View>
            )}
            {done.length > 0 && <Text style={s.section}>{t.earlier}</Text>}
            {done.map(card)}
            {(data.reported ?? []).length > 0 && <Text style={s.section}>{t.reportedByMe}</Text>}
            {(data.reported ?? []).map((x) => (
              <Pressable key={x.id} style={s.small} onPress={() => setOpen(x.id)}>
                <Text style={s.smallT} numberOfLines={1}>#{x.number} {x.title}</Text>
                <Text style={s.smallS}>{(t as any)[`t_${x.status}`]}{x.assigneeName ? ` · ${x.assigneeName}` : ` · ${t.unassigned}`}</Text>
              </Pressable>
            ))}
          </>
        )}
      </ScrollView>
      {open && <TaskDetail id={open} staffId={staffId} onClose={() => { setOpen(null); void load(); }} />}
      {reporting && <ReportProblem onClose={() => setReporting(false)} onSent={(n) => { setReporting(false); setNotice(t.reportSent(n)); void load(); }} />}
    </View>
  );
}

function TaskDetail({ id, staffId, onClose }: { id: string; staffId: string; onClose: () => void }) {
  const b = useBrand();
  const { t, locale } = useT();
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [move, setMove] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [replaced, setReplaced] = useState(true);
  const [comment, setComment] = useState('');
  const load = useCallback(async () => { try { setD(await api(`/mobile/v1/tasks/${id}`)); } catch (e) { setError((e as Error).message); } }, [id]);
  useEffect(() => { void load(); }, [load]);
  const run = async (fn: () => Promise<any>) => { setBusy(true); setError(null); try { setD(await fn()); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); } };
  const doMove = async (to: string) => {
    if ((to === 'RESOLVED' || to === 'ON_HOLD') && move !== to) { setMove(to); setNote(''); return; }
    if (await run(() => api(`/mobile/v1/tasks/${id}/status`, { status: to, note: note || null, ...(to === 'RESOLVED' && d.category === 'battery' ? { batteryReplaced: replaced } : {}) }))) setMove(null);
  };
  const mine = Boolean(d && d.assigneeStaffId === staffId);
  const when = (iso: string) => new Date(iso).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: b.background }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[s.modalTop, { backgroundColor: b.primary }]}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t.close} hitSlop={12}><Ionicons name="close" size={26} color={b.onPrimary} /></Pressable>
          <Text style={[s.modalH, { color: b.onPrimary, fontFamily: b.font }]} numberOfLines={2}>{d ? `#${d.number} ${d.title}` : '…'}</Text>
        </View>
        {!d ? <ActivityIndicator style={{ marginTop: 30 }} color={b.primary} /> : (
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 12 }} keyboardShouldPersistTaps="handled">
            {error && <View style={[s.note, { backgroundColor: ink.badBg, margin: 0 }]}><Text style={{ color: ink.bad }}>{error}</Text></View>}
            <View style={s.box}>
              <Text style={s.meta}>{(t as any)[`c_${d.category}`]} · {(t as any)[`p_${d.priority}`]} · {(t as any)[`t_${d.status}`]}</Text>
              {(d.doorName || d.location) && <View style={s.row}><Ionicons name="location-outline" size={16} color={ink.text} /><Text style={s.big}>{d.doorName ? `${d.doorName}${d.doorGroup ? ` · ${d.doorGroup}` : ''}` : d.location}</Text></View>}
              {d.asset && <Text style={s.meta}>{d.asset}</Text>}
              {d.dueAt && <Text style={[s.meta, d.overdue && { color: ink.bad, fontWeight: '700' }]}>{d.overdue ? `${t.overdue} · ` : ''}{t.due(when(d.dueAt))}</Text>}
              {!!d.description && <Text style={s.body}>{d.description}</Text>}
              {d.resolution && <Text style={[s.body, { color: ink.ok }]}>{d.resolution}</Text>}
            </View>

            {mine && MOVES[d.status] && !move && (
              <View style={s.actions}>{MOVES[d.status]!.map((m) => (
                <Pressable key={m.to} disabled={busy} onPress={() => doMove(m.to)} style={[s.act, m.primary ? { backgroundColor: b.primary, borderColor: b.primary } : null]} accessibilityRole="button">
                  <Text style={[s.actT, m.primary && { color: b.onPrimary }]}>{t[m.key]}</Text>
                </Pressable>
              ))}</View>
            )}
            {move && (
              <View style={s.box}>
                <Text style={s.label}>{move === 'RESOLVED' ? t.whatDone : t.whyHold}</Text>
                <TextInput placeholderTextColor={ink.faint} style={s.input} value={note} onChangeText={setNote} placeholder={move === 'RESOLVED' ? t.whatDonePh : t.whyHoldPh} multiline autoFocus maxLength={2000} />
                {move === 'RESOLVED' && d.category === 'battery' && (
                  <View style={[s.row, { justifyContent: 'space-between' }]}><Text style={s.body}>{t.batteryReplaced}</Text><Switch value={replaced} onValueChange={setReplaced} /></View>
                )}
                <View style={s.actions}>
                  <Pressable style={s.act} onPress={() => setMove(null)}><Text style={s.actT}>{t.cancel}</Text></Pressable>
                  <Pressable style={[s.act, { backgroundColor: b.primary, borderColor: b.primary }, (busy || (move === 'RESOLVED' && note.trim().length < 3)) && { opacity: 0.5 }]} disabled={busy || (move === 'RESOLVED' && note.trim().length < 3)} onPress={() => doMove(move)}>
                    <Text style={[s.actT, { color: b.onPrimary }]}>{t.confirm}</Text></Pressable>
                </View>
              </View>
            )}

            <Text style={s.section}>{t.activity}</Text>
            {d.activity.map((a: any) => (
              <View key={a.id} style={s.act1}>
                <Text style={s.meta}><Text style={{ fontWeight: '700', color: ink.text }}>{a.actorType === 'system' ? t.hotelInfo : a.actorName}</Text> {(t as any)[`a_${a.kind}`] ?? a.kind}{a.kind === 'status' && a.data?.to ? `: ${(t as any)[`t_${a.data.to}`] ?? a.data.to}` : ''} · {when(a.at)}</Text>
                {a.body && a.kind !== 'created' && <Text style={s.bubble}>{a.body}</Text>}
              </View>
            ))}
            {mine && (
              <View style={s.box}>
                <TextInput placeholderTextColor={ink.faint} style={s.input} value={comment} onChangeText={setComment} placeholder={t.addComment} multiline maxLength={2000} />
                <Pressable disabled={!comment.trim() || busy} style={[s.act, { alignSelf: 'flex-end' }, !comment.trim() && { opacity: 0.5 }]}
                  onPress={async () => { if (await run(() => api(`/mobile/v1/tasks/${id}/comments`, { body: comment }))) setComment(''); }}>
                  <Text style={s.actT}>{t.comment}</Text></Pressable>
              </View>
            )}
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const CATS = ['room', 'door', 'lock', 'electrical', 'plumbing', 'other'] as const;
function ReportProblem({ onClose, onSent }: { onClose: () => void; onSent: (n: number) => void }) {
  const b = useBrand();
  const { t } = useT();
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('room');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = title.trim().length >= 3 && location.trim().length >= 1;
  const send = async () => {
    setBusy(true); setError(null);
    try { const r = await api('/mobile/v1/reports', { title, location, description, category }); onSent(r.number); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: b.background }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[s.modalTop, { backgroundColor: b.primary }]}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t.close} hitSlop={12}><Ionicons name="close" size={26} color={b.onPrimary} /></Pressable>
          <Text style={[s.modalH, { color: b.onPrimary, fontFamily: b.font }]}>{t.reportH}</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled">
          {error && <View style={[s.note, { backgroundColor: ink.badBg, margin: 0 }]}><Text style={{ color: ink.bad }}>{error}</Text></View>}
          <Text style={s.label}>{t.whatsWrong}</Text>
          <TextInput placeholderTextColor={ink.faint} style={s.input} value={title} onChangeText={setTitle} placeholder={t.whatsWrongPh} maxLength={120} autoFocus />
          <Text style={s.label}>{t.where}</Text>
          <TextInput placeholderTextColor={ink.faint} style={s.input} value={location} onChangeText={setLocation} placeholder={t.wherePh} maxLength={120} />
          <View style={s.chips}>{CATS.map((c) => (
            <Pressable key={c} onPress={() => setCategory(c)} style={[s.chip, category === c && { backgroundColor: b.primary, borderColor: b.primary }]} accessibilityRole="radio" accessibilityState={{ selected: category === c }}>
              <Text style={[s.chipT, category === c && { color: b.onPrimary }]}>{(t as any)[`c_${c}`]}</Text></Pressable>
          ))}</View>
          <Text style={s.label}>{t.details}</Text>
          <TextInput placeholderTextColor={ink.faint} style={[s.input, { minHeight: 90 }]} value={description} onChangeText={setDescription} multiline maxLength={2000} />
          <Pressable disabled={!ok || busy} onPress={send} style={[s.sendBtn, { backgroundColor: b.primary }, (!ok || busy) && { opacity: 0.5 }]} accessibilityRole="button">
            <Text style={[s.sendT, { color: b.onPrimary }]}>{busy ? t.sending : t.send}</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  top: { paddingTop: 64, paddingBottom: 22, paddingHorizontal: 22, borderBottomLeftRadius: 26, borderBottomRightRadius: 26, gap: 12 },
  h1: { fontSize: 28, fontWeight: '700' },
  reportBtn: { alignSelf: 'flex-start', flexDirection: 'row', gap: 6, alignItems: 'center', borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7 },
  reportT: { fontWeight: '700' },
  note: { margin: 16, marginBottom: 0, borderRadius: 12, padding: 12 },
  card: { margin: 16, marginBottom: 0, backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 6, borderLeftWidth: 5, borderLeftColor: ink.line },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  num: { fontWeight: '700', color: ink.muted, fontSize: 15 },
  prio: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 },
  pill: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 },
  pillT: { fontSize: 13, fontWeight: '700' },
  title: { fontSize: 18, fontWeight: '700', color: ink.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { color: ink.muted, fontSize: 14 },
  big: { fontSize: 17, fontWeight: '600', color: ink.text },
  body: { color: ink.text, fontSize: 15, lineHeight: 21 },
  empty: { alignItems: 'center', padding: 30, gap: 8 },
  emptyH: { fontSize: 17, fontWeight: '700', color: ink.text },
  emptyT: { color: ink.muted, textAlign: 'center', lineHeight: 21 },
  section: { marginTop: 22, marginHorizontal: 18, fontSize: 13, fontWeight: '700', color: ink.muted, textTransform: 'uppercase', letterSpacing: 0.6 },
  small: { marginHorizontal: 16, marginTop: 8, backgroundColor: '#fff', borderRadius: 12, padding: 12 },
  smallT: { fontWeight: '600', color: ink.text },
  smallS: { color: ink.muted, fontSize: 13, marginTop: 2 },
  modalTop: { paddingTop: 56, paddingBottom: 18, paddingHorizontal: 18, flexDirection: 'row', gap: 14, alignItems: 'center' },
  modalH: { fontSize: 20, fontWeight: '700', flex: 1 },
  box: { backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 8 },
  actions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  act: { flexGrow: 1, borderWidth: 1, borderColor: ink.line, backgroundColor: '#fff', borderRadius: 26, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  actT: { fontWeight: '700', fontSize: 15, color: ink.text },
  act1: { gap: 4 },
  bubble: { backgroundColor: '#fff', borderRadius: 12, padding: 10, color: ink.text, borderWidth: StyleSheet.hairlineWidth, borderColor: ink.line },
  label: { fontWeight: '600', color: ink.text },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: ink.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: ink.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: ink.line, backgroundColor: '#fff', borderRadius: 18, paddingHorizontal: 12, paddingVertical: 7 },
  chipT: { color: ink.text, fontWeight: '600' },
  sendBtn: { marginTop: 10, borderRadius: 30, paddingVertical: 14, alignItems: 'center' },
  sendT: { fontWeight: '700', fontSize: 16 },
});
