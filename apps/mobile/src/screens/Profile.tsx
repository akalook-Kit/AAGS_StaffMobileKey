import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api } from '../api';
import { Ionicons } from '@expo/vector-icons';
import { ink, useBrand } from '../theme';
import { LANG_NAMES, useT, type Lang } from '../i18n';
import type { Session } from '../../App';

export function ProfileScreen({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const b = useBrand();
  const { t, lang, setLang, locale } = useT();
  const [notes, setNotes] = useState<any[]>([]);
  useEffect(() => { api('/mobile/v1/notifications').then(setNotes).catch(() => {}); void api('/mobile/v1/notifications/read', {}).catch(() => {}); }, []);
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 30 }}>
      <View style={[s.top, { backgroundColor: b.primary }]}>
        <Text style={[s.title, { color: b.onPrimary, fontFamily: b.font }]}>{session.staff.name}</Text>
        <Text style={{ color: b.onPrimary, opacity: 0.85 }}>{session.staff.jobRole} · {session.staff.email}</Text>
      </View>
      <View style={s.card}>
        <View style={s.hRow}><Ionicons name="phone-portrait-outline" size={18} color={b.primary} /><Text style={s.h}>{t.thisPhone}</Text></View>
        <Text style={s.t}>{t.readySince(session.endpoint?.activatedAt ? new Date(session.endpoint.activatedAt).toLocaleDateString(locale) : '—')}</Text>
        <Text style={s.small}>{t.changingPhones}</Text>
      </View>
      <View style={s.card}>
        <View style={s.hRow}><Ionicons name="language-outline" size={18} color={b.primary} /><Text style={s.h}>{t.language}</Text></View>
        <View style={s.seg} accessibilityRole="radiogroup">
          {(Object.keys(LANG_NAMES) as Lang[]).map((l) => (
            <Pressable key={l} onPress={() => setLang(l)} style={[s.segBtn, lang === l && { backgroundColor: b.primary }]} accessibilityRole="radio" accessibilityState={{ selected: lang === l }}>
              <Text style={{ color: lang === l ? b.onPrimary : ink.text, fontWeight: '600' }}>{LANG_NAMES[l]}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={s.card}>
        <View style={s.hRow}><Ionicons name="notifications-outline" size={18} color={b.primary} /><Text style={s.h}>{t.notifications}</Text></View>
        {notes.length ? notes.map((n) => (
          <View key={n.id} style={s.note}><Text style={{ fontWeight: n.read_at ? '400' : '700', color: ink.text }}>{n.title}</Text><Text style={s.small}>{n.body}</Text><Text style={s.tiny}>{new Date(n.created_at).toLocaleString(locale)}</Text></View>
        )) : <Text style={s.t}>{t.nothingYet}</Text>}
      </View>
      <Pressable onPress={onSignOut} style={s.out} accessibilityRole="button"><Ionicons name="log-out-outline" size={18} color={ink.bad} /><Text style={{ color: ink.bad, fontWeight: '600' }}>{t.signOut}</Text></Pressable>
    </ScrollView>
  );
}
const s = StyleSheet.create({
  top: { paddingTop: 64, paddingBottom: 24, paddingHorizontal: 22, gap: 4, borderBottomLeftRadius: 26, borderBottomRightRadius: 26 },
  title: { fontSize: 26, fontWeight: '700' },
  card: { margin: 16, marginBottom: 0, backgroundColor: '#fff', borderRadius: 16, padding: 18, gap: 6 },
  h: { fontSize: 17, fontWeight: '700', color: ink.text },
  t: { color: ink.muted, lineHeight: 21 },
  small: { color: ink.muted, fontSize: 13 },
  tiny: { color: ink.faint, fontSize: 12 },
  note: { paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ink.line, gap: 2 },
  out: { alignSelf: 'center', padding: 18, marginTop: 10, flexDirection: 'row', gap: 6, alignItems: 'center' },
  hRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  seg: { flexDirection: 'row', borderWidth: 1, borderColor: ink.line, borderRadius: 22, overflow: 'hidden', marginTop: 4 },
  segBtn: { flex: 1, paddingVertical: 10, alignItems: 'center' },
});
