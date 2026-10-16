import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Linking, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api } from '../api';
import { mobileAccess, type DoorAttempt } from '../mobile-access';
import { ink, useBrand } from '../theme';
import { useT } from '../i18n';
import type { Session } from '../../App';

interface Key { id: string; status: string; validFrom: string; validUntil: string; title: string; doors: { id: string; name: string; group: string | null }[]; failureCode: string | null; usedAtLock: boolean; regNo?: string | null; endedBy?: string | null }
type Tone = 'ok' | 'warn' | 'bad' | 'idle';
const TONE: Record<string, Tone> = { ISSUED: 'ok', ISSUING: 'warn', QUEUED: 'warn', SCHEDULED: 'warn', REVOKING: 'warn', REVOKED: 'idle', EXPIRED: 'idle', FAILED: 'bad' };
const native = Platform.OS !== 'web';

/** "101 – 110 · Staff Entrance · Linen Store": consecutive room numbers collapse into ranges. */
export function summarizeDoors(doors: Key['doors']) {
  const nums = doors.map((d) => d.name).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
  const named = doors.map((d) => d.name).filter((n) => !/^\d+$/.test(n));
  const runs: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
    runs.push(j > i ? `${nums[i]} ⁠–⁠ ${nums[j]}` : String(nums[i]));
    i = j + 1;
  }
  return { rooms: runs.join(', '), named };
}
/** Doors grouped by Visionline door group (floor), floors first in natural order. */
function byFloor(doors: Key['doors']) {
  const m = new Map<string, Key['doors']>();
  for (const d of doors) m.set(d.group ?? '—', [...(m.get(d.group ?? '—') ?? []), d]);
  const nat = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  return [...m.entries()].sort(([a], [b]) => (/^floor/i.test(a) === /^floor/i.test(b) ? nat(a, b) : /^floor/i.test(a) ? -1 : 1))
    .map(([g, ds]) => ({ group: g, doors: ds.sort((x, y) => nat(x.name, y.name)) }));
}

export function KeysScreen({ session, config }: { session: Session; config: any }) {
  const b = useBrand();
  const { t, lang, locale } = useT();
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [online, setOnline] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [picker, setPicker] = useState<Key | null>(null);
  const [attempt, setAttempt] = useState<DoorAttempt | null>(null);
  const [opening, setOpening] = useState(false);
  const [bt, setBt] = useState<'on' | 'off' | 'unknown'>('unknown');
  const [, tick] = useState(0);
  const endpointId = session.endpoint!.endpointId;

  const load = useCallback(async () => {
    try { setKeys(await api<Key[]>('/mobile/v1/keys')); setError(null); setOnline(true); }
    catch (e) { setOnline((e as any).code !== 'OFFLINE'); setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); const i = setInterval(load, 5000); return () => clearInterval(i); }, [load]);
  useEffect(() => { void mobileAccess.readiness().then((r) => setBt(r.bluetooth)).catch(() => {}); const i = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(i); }, []);

  const open = async (key: Key, doorId?: string) => {
    setOpening(true); setAttempt(null); setPicker(null);
    let r: DoorAttempt;
    try { r = await mobileAccess.openDoor(endpointId, doorId); } catch (e) { r = { result: 'DENIED', reason: (e as Error).message, door: '' }; }
    setAttempt(r); setOpening(false);
    if (native) void Haptics.notificationAsync(r.result === 'OPENED' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error).catch(() => {});
  };
  useEffect(() => { if (!attempt) return; const i = setTimeout(() => setAttempt(null), 8000); return () => clearTimeout(i); }, [attempt]);

  const all = keys ?? []; // newest first
  const readyIdx = all.findIndex((k) => k.status === 'ISSUED' && new Date(k.validFrom) <= new Date() && new Date(k.validUntil) > new Date());
  // A failed request older than the key in use is history, not something to act on.
  const live = all.filter((k, i) => ['ISSUED', 'ISSUING', 'QUEUED', 'SCHEDULED', 'REVOKING', 'FAILED'].includes(k.status) && new Date(k.validUntil) > new Date()
    && !(k.status === 'FAILED' && readyIdx >= 0 && i > readyIdx));
  const past = all.filter((k) => !live.includes(k));
  const ready = readyIdx >= 0 ? all[readyIdx] : undefined;
  const h = new Date().getHours();
  const hello = h < 12 ? t.goodMorning : h < 18 ? t.goodAfternoon : t.goodEvening;
  const title = lang === 'en' ? b.w.keysTitle : t.keys;

  return (
    <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />} contentContainerStyle={{ paddingBottom: 30 }}>
      <View style={[s.top, { backgroundColor: b.primary }]}>
        <View style={s.topRow}>
          {b.logo ? <Image source={{ uri: b.logo }} style={s.logo} resizeMode="contain" accessibilityIgnoresInvertColors /> : <Text style={[s.title, { color: b.onPrimary }]}>{config?.hotel?.name}</Text>}
          <Text style={[s.date, { color: b.onPrimary }]}>{new Date().toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}</Text>
        </View>
        <Text style={[s.hello, { color: b.onPrimary, fontFamily: b.font }]}>{hello}, {session.staff.name.split(' ')[0]}</Text>
        <Text style={[s.sub, { color: b.onPrimary, fontFamily: b.font }]}>{title}</Text>
        <View style={s.chips}>
          <Chip icon="bluetooth" label={bt === 'off' ? t.bluetoothOff : t.bluetoothOn} ok={bt !== 'off'} b={b} />
          <Chip icon={online ? 'cloud-done-outline' : 'cloud-offline-outline'} label={online ? t.online : t.offline} ok={online} b={b} />
          {ready && <Chip icon="key-outline" label={mobileAccess.mode === 'simulated' ? `${t.keyReady} · ${t.simulated}` : t.keyReady} ok b={b} />}
        </View>
      </View>

      {error && online && <Text style={s.err}>{error}</Text>}
      {keys && !live.length && (
        <View style={s.empty}>
          <View style={[s.emptyIcon, { backgroundColor: b.secondary + '33' }]}><Ionicons name="key-outline" size={28} color={b.primary} /></View>
          <Text style={[s.emptyH, { fontFamily: b.font }]}>{t.noKeyH}</Text>
          <Text style={s.emptyT}>{t.noKeyT}</Text>
        </View>
      )}

      {/* The usable key and its tap target come first; keys still arriving or failed follow. */}
      {ready && <KeyCard k={ready} config={config} />}
      {ready && (
        <TapZone opening={opening} attempt={attempt}
          label={opening ? t.talking : mobileAccess.mode === 'simulated' ? t.tapSim : lang === 'en' ? b.w.tapInstruction : t.tap}
          onPress={() => (mobileAccess.mode === 'simulated' ? setPicker(ready) : open(ready))} />
      )}
      {live.filter((k) => k !== ready).map((k) => <KeyCard key={k.id} k={k} config={config} />)}

      {past.length > 0 && (
        <View style={{ marginTop: 22 }}>
          <Text style={s.section}>{t.earlier}</Text>
          {past.map((k) => (
            <View key={k.id} style={s.pastRow}>
              <Ionicons name="time-outline" size={16} color={ink.faint} />
              <Text style={{ color: ink.muted, flex: 1 }}>{k.title} · {k.doors.length} {k.doors.length === 1 ? t.door : t.doorsN}</Text>
              <Text style={{ color: ink.faint, fontSize: 13 }}>{k.endedBy === 'wrong_door' ? t.endedWrongDoor : k.endedBy === 'visionline' ? t.endedVisionline : (t as any)[`st_${k.status}`] ?? k.status}</Text>
            </View>
          ))}
        </View>
      )}

      <Modal visible={Boolean(picker)} transparent animationType="slide" onRequestClose={() => setPicker(null)}>
        <View style={s.sheetWrap}>
          <View style={s.sheet}>
            <View style={s.grabber} />
            <Text style={[s.sheetH, { fontFamily: b.font }]}>{t.whichDoor}</Text>
            <Text style={{ color: ink.muted, marginBottom: 12 }}>{t.simOnly}</Text>
            <ScrollView style={{ maxHeight: 380 }}>
              {byFloor([...(picker?.doors ?? []), { id: '201', name: '201', group: t.notOnKey }, { id: 'GM Office', name: 'GM Office', group: t.notOnKey }]
                .filter((d, i, a) => a.findIndex((x) => x.id === d.id) === i)).map((f) => (
                <View key={f.group} style={{ marginBottom: 10 }}>
                  <Text style={s.floorH}>{f.group}</Text>
                  <View style={s.doorGrid}>
                    {f.doors.map((d) => (
                      <Pressable key={d.id} style={[s.door, f.group === t.notOnKey && { borderStyle: 'dashed' }]} onPress={() => picker && open(picker, d.id)} accessibilityRole="button">
                        <Text style={[s.doorT, { color: b.primary }]}>{d.name}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ))}
            </ScrollView>
            <Pressable onPress={() => setPicker(null)} style={{ alignSelf: 'center', padding: 14 }}><Text style={{ color: ink.muted }}>{t.cancel}</Text></Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function Chip({ icon, label, ok, b }: { icon: string; label: string; ok: boolean; b: ReturnType<typeof useBrand> }) {
  return (
    <View style={[s.chip, { borderColor: ok ? b.secondary + '88' : '#E5A39A' }]}>
      <Ionicons name={icon as any} size={13} color={ok ? b.secondary : '#F2B8AF'} />
      <Text style={[s.chipT, { color: ok ? b.onPrimary : '#F2B8AF' }]}>{label}</Text>
    </View>
  );
}

/** The key as a hotel key card: dark card, rose-gold edge, rooms large, time left as a bar. */
function KeyCard({ k, config }: { k: Key; config: any }) {
  const b = useBrand();
  const { t, locale } = useT();
  const [showDoors, setShowDoors] = useState(false);
  const sum = summarizeDoors(k.doors);
  const tone = TONE[k.status] ?? 'idle';
  const start = new Date(k.validFrom).getTime(), end = new Date(k.validUntil).getTime(), now = Date.now();
  const frac = Math.max(0, Math.min(1, (end - now) / Math.max(1, end - start)));
  const notStarted = start > now + 30_000;
  const left = Math.max(0, end - now), hh = Math.floor(left / 3600_000), mm = Math.floor((left % 3600_000) / 60_000);
  const groups = new Set(k.doors.map((d) => d.group).filter(Boolean));
  const building = (config?.property?.buildings ?? []).find((x: any) => (x.doorGroups ?? []).some((g: string) => groups.has(g)));
  const address = building?.address ?? config?.property?.address ?? null;
  const mapUrl: string | null = building?.mapUrl ?? null;
  return (
    <View style={s.cardWrap}>
      <View style={[s.card, { backgroundColor: b.primary, borderColor: b.secondary }]}>
        <View style={[s.stripe, { backgroundColor: b.secondary }]} />
        <View style={s.row}>
          <Text style={[s.kicker, { color: b.secondary }]}>{t.accessAreas.toUpperCase()}</Text>
          <Pill tone={notStarted && k.status === 'ISSUED' ? 'warn' : tone} label={notStarted && ['ISSUED', 'SCHEDULED'].includes(k.status) ? t.startsAt(new Date(k.validFrom).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' })) : (t as any)[`st_${k.status}`] ?? k.status} />
        </View>
        {sum.rooms ? <Text style={[s.rooms, { color: b.onPrimary, fontFamily: b.font }, sum.rooms.length > 14 && { fontSize: 26 }]} accessibilityLabel={`${sum.rooms}`}>{sum.rooms}</Text> : null}
        <Text style={[s.named, { color: b.onPrimary }]}>{[k.title, ...sum.named].filter(Boolean).join(' · ')}</Text>
        <View style={s.meta}>
          {notStarted && (
            <View style={{ flex: 1 }}>
              <Text style={[s.kicker, { color: b.secondary }]}>{t.validFrom}</Text>
              <Text style={[s.metaV, { color: b.onPrimary }]}>{new Date(k.validFrom).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</Text>
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={[s.kicker, { color: b.secondary }]}>{t.validUntil}</Text>
            <Text style={[s.metaV, { color: b.onPrimary }]}>{new Date(k.validUntil).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[s.kicker, { color: b.secondary }]}>{t.doors}</Text>
            <Text style={[s.metaV, { color: b.onPrimary }]}>{k.doors.length}</Text>
          </View>
        </View>
        {k.regNo ? <Text style={[s.regNo, { color: b.secondary }]} accessibilityLabel={`${t.regNo} ${k.regNo}`}>{t.regNo} {k.regNo}</Text> : null}
        {k.status === 'ISSUED' && !notStarted && (
          <View style={{ marginTop: 12 }}>
            <View style={s.bar}><View style={[s.barFill, { width: `${frac * 100}%`, backgroundColor: frac < 0.15 ? '#E8A08F' : b.secondary }]} /></View>
            <Text style={[s.left, { color: b.onPrimary }]}>{frac < 0.15 ? `${t.endsSoon} · ` : ''}{t.timeLeft(hh, mm)}</Text>
          </View>
        )}
      </View>
      {k.status === 'FAILED' && <Text style={s.hint}>{t.failedHint}</Text>}
      {k.status === 'ISSUING' && <Text style={s.hint}>{t.issuingHint}</Text>}
      <View style={s.under}>
        <Pressable style={s.underBtn} onPress={() => setShowDoors(!showDoors)} accessibilityRole="button">
          <Ionicons name={showDoors ? 'chevron-up' : 'chevron-down'} size={16} color={ink.muted} />
          <Text style={s.underT}>{showDoors ? t.hideDoors : t.showDoors}</Text>
        </Pressable>
        {address && (
          <Pressable style={[s.underBtn, { flexShrink: 1 }]} disabled={!mapUrl} onPress={() => mapUrl && Linking.openURL(mapUrl)} accessibilityRole={mapUrl ? 'link' : 'text'}>
            <Ionicons name="location-outline" size={16} color={ink.muted} />
            <Text style={[s.underT, mapUrl && { textDecorationLine: 'underline' }]} numberOfLines={1}>{address}</Text>
          </Pressable>
        )}
      </View>
      {showDoors && (
        <View style={s.floors}>
          {byFloor(k.doors).map((f) => (
            <View key={f.group} style={s.floorRow}>
              <Text style={s.floorH}>{f.group}</Text>
              <View style={s.doorGrid}>{f.doors.map((d) => <View key={d.id} style={s.doorTag}><Text style={[s.doorTagT, { color: b.primary }]}>{d.name}</Text></View>)}</View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/** Big tap target with a calm pulse while idle, a spin while talking to the lock, and a clear result. */
function TapZone({ opening, attempt, label, onPress }: { opening: boolean; attempt: DoorAttempt | null; label: string; onPress: () => void }) {
  const b = useBrand();
  const { t } = useT();
  const pulse = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: opening ? 900 : 2200, easing: Easing.out(Easing.ease), useNativeDriver: native }));
    pulse.setValue(0); loop.start();
    return () => loop.stop();
  }, [opening, pulse]);
  useEffect(() => {
    if (!attempt) return;
    pop.setValue(0);
    Animated.spring(pop, { toValue: 1, friction: 5, useNativeDriver: native }).start();
  }, [attempt, pop]);
  const ok = attempt?.result === 'OPENED';
  const color = attempt ? (ok ? ink.ok : ink.bad) : b.primary;
  const ring = (delay: number) => ({
    transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55 + delay] }) }],
    opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35 - delay / 2, 0] }),
  });
  return (
    <View style={s.tapWrap}>
      <View style={s.tapStage}>
        {!attempt && <Animated.View style={[s.ring, { borderColor: b.secondary }, ring(0)]} />}
        {!attempt && <Animated.View style={[s.ring, { borderColor: b.secondary }, ring(0.25)]} />}
        <Pressable onPress={onPress} disabled={opening} accessibilityRole="button" accessibilityLabel={label}
          style={({ pressed }) => [s.tapBtn, { backgroundColor: color, borderColor: b.secondary, transform: [{ scale: pressed ? 0.96 : 1 }] }]}>
          <Animated.View style={attempt ? { transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }] } : undefined}>
            <Ionicons name={attempt ? (ok ? 'lock-open' : 'close') : opening ? 'radio' : 'key'} size={46} color={attempt ? '#fff' : b.onPrimary} />
          </Animated.View>
        </Pressable>
      </View>
      <Pressable onPress={onPress} disabled={opening} accessible={false}>
        <Text style={[s.tapText, { fontFamily: b.font, color: attempt ? color : ink.text }]} accessibilityLiveRegion="polite">
          {attempt ? (ok ? t.opened(attempt.door) : t.notOpened(attempt.door)) : label}
        </Text>
      </Pressable>
      {attempt && !ok && <Text style={s.tapSub}>{attempt.reason}. {t.deniedHelp}</Text>}
    </View>
  );
}

function Pill({ tone, label }: { tone: Tone; label: string }) {
  const c = { ok: ['#0F4A33', '#BFE6D2'], warn: ['#5E3E00', '#F6DFA6'], bad: ['#6E1A12', '#F3C3BC'], idle: ['#3A3330', '#DCD4D0'] }[tone];
  return <View style={[s.pill, { backgroundColor: c[1] }]}><Text style={{ color: c[0], fontWeight: '700', fontSize: 12 }}>{label}</Text></View>;
}

const s = StyleSheet.create({
  top: { paddingTop: 58, paddingBottom: 20, paddingHorizontal: 20, borderBottomLeftRadius: 26, borderBottomRightRadius: 26 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  logo: { width: 104, height: 36, marginLeft: -4 },
  date: { opacity: 0.75, fontSize: 13 },
  title: { fontSize: 20, fontWeight: '700' },
  hello: { fontSize: 26, fontWeight: '700' },
  sub: { opacity: 0.8, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 14, paddingHorizontal: 9, paddingVertical: 4 },
  chipT: { fontSize: 12, fontWeight: '600' },
  err: { margin: 16, backgroundColor: ink.badBg, color: ink.bad, padding: 12, borderRadius: 10 },
  empty: { margin: 16, padding: 24, backgroundColor: '#fff', borderRadius: 18, gap: 8, alignItems: 'center' },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  emptyH: { fontSize: 18, fontWeight: '700', color: ink.text, textAlign: 'center' },
  emptyT: { color: ink.muted, lineHeight: 21, textAlign: 'center' },
  cardWrap: { marginHorizontal: 16, marginTop: 18 },
  card: { borderRadius: 20, padding: 20, paddingTop: 22, overflow: 'hidden', borderWidth: 1, shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
  stripe: { position: 'absolute', top: 0, left: 0, right: 0, height: 5 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  kicker: { fontSize: 12, letterSpacing: 0.6 },
  rooms: { fontSize: 38, fontWeight: '700', letterSpacing: -0.5, marginTop: 8 },
  named: { fontSize: 15, marginTop: 2, opacity: 0.9 },
  meta: { flexDirection: 'row', marginTop: 18, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(220,174,153,0.4)' },
  metaV: { fontSize: 16, fontWeight: '600', marginTop: 2 },
  bar: { height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.14)', overflow: 'hidden' },
  barFill: { height: 5, borderRadius: 3 },
  left: { fontSize: 12, opacity: 0.8, marginTop: 6 },
  regNo: { position: 'absolute', right: 20, bottom: 10, fontSize: 11, letterSpacing: 0.6, opacity: 0.75 },
  hint: { color: ink.muted, marginTop: 10, fontSize: 13, paddingHorizontal: 4 },
  under: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, marginTop: 10, paddingHorizontal: 4 },
  underBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4 },
  underT: { color: ink.muted, fontSize: 13 },
  floors: { backgroundColor: '#fff', borderRadius: 16, padding: 14, marginTop: 6, gap: 10 },
  floorRow: { gap: 6 },
  floorH: { color: ink.faint, fontSize: 12, fontWeight: '700', letterSpacing: 0.4, marginBottom: 6 },
  doorTag: { borderWidth: 1, borderColor: ink.line, borderRadius: 7, borderBottomLeftRadius: 14, borderBottomRightRadius: 14, paddingVertical: 6, paddingHorizontal: 10, minWidth: 48, alignItems: 'center' },
  doorTagT: { fontWeight: '700', fontSize: 14 },
  pill: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 },
  tapWrap: { alignItems: 'center', marginTop: 26, paddingHorizontal: 24 },
  tapStage: { width: 190, height: 190, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: 132, height: 132, borderRadius: 66, borderWidth: 2 },
  tapBtn: { width: 132, height: 132, borderRadius: 66, alignItems: 'center', justifyContent: 'center', borderWidth: 3, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
  tapText: { fontSize: 18, fontWeight: '700', textAlign: 'center', marginTop: 4 },
  tapSub: { color: ink.bad, textAlign: 'center', marginTop: 6, lineHeight: 20 },
  section: { marginHorizontal: 18, color: ink.muted, fontWeight: '700', marginBottom: 6 },
  pastRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: ink.line },
  sheetWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingTop: 10 },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: ink.line, marginBottom: 12 },
  sheetH: { fontSize: 20, fontWeight: '700', color: ink.text, marginBottom: 4 },
  doorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  door: { borderWidth: 1.5, borderColor: ink.line, borderRadius: 8, borderBottomLeftRadius: 18, borderBottomRightRadius: 18, paddingVertical: 12, paddingHorizontal: 14, minWidth: 64, alignItems: 'center' },
  doorT: { fontWeight: '700', fontSize: 16 },
});
