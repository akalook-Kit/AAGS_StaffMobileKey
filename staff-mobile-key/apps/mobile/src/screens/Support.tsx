import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ink, useBrand } from '../theme';
import { useT } from '../i18n';

/** Support, escalation and privacy text from the hotel's configuration. Links are allow-listed (spec §13.4.2). */
export function SupportScreen({ config }: { config: any }) {
  const b = useBrand();
  const { t, lang } = useT();
  const p = config?.property ?? {};
  const pol = config?.appPolicy ?? {};
  const allowed = new Set<string>(pol.allowedLinkHosts ?? []);
  const openSafe = (url: string) => { try { if (allowed.has(new URL(url).hostname)) void Linking.openURL(url); } catch { /* ignore */ } };
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 30 }}>
      <View style={[s.top, { backgroundColor: b.primary }]}><Text style={[s.title, { color: b.onPrimary, fontFamily: b.font }]}>{lang === 'en' ? b.w.support : t.support}</Text></View>
      <View style={s.card}>
        <View style={s.hRow}><Ionicons name="lock-closed-outline" size={18} color={b.primary} /><Text style={s.h}>{t.doorWontOpen}</Text></View>
        <Text style={s.t}>{t.doorWontOpenT} {pol.supportEscalation}</Text>
        {p.supportPhone && <Pressable style={[s.btn, { backgroundColor: b.primary }]} onPress={() => Linking.openURL(`tel:${p.supportPhone.replace(/\s/g, '')}`)}><Ionicons name="call" size={16} color={b.onPrimary} /><Text style={[s.btnT, { color: b.onPrimary }]}>{t.call(p.displayName ?? t.theHotel)}</Text></Pressable>}
        {p.supportEmail && <Pressable onPress={() => Linking.openURL(`mailto:${p.supportEmail}`)}><Text style={[s.link, { color: b.primary }]}>{p.supportEmail}</Text></Pressable>}
      </View>
      {(pol.partnerLinks ?? []).length > 0 && (
        <View style={s.card}>{pol.partnerLinks.map((l: any) => <Pressable key={l.url} onPress={() => openSafe(l.url)}><Text style={[s.link, { color: b.primary }]}>{l.label}</Text></Pressable>)}</View>
      )}
      <View style={s.card}>
        <View style={s.hRow}><Ionicons name="shield-checkmark-outline" size={18} color={b.primary} /><Text style={s.h}>{t.privacy}</Text></View>
        <Text style={s.t}>{pol.privacyText || t.privacyDefault}</Text>
      </View>
    </ScrollView>
  );
}
const s = StyleSheet.create({
  top: { paddingTop: 64, paddingBottom: 24, paddingHorizontal: 22, borderBottomLeftRadius: 26, borderBottomRightRadius: 26 },
  title: { fontSize: 28, fontWeight: '700' },
  card: { margin: 16, marginBottom: 0, backgroundColor: '#fff', borderRadius: 16, padding: 18, gap: 8 },
  h: { fontSize: 17, fontWeight: '700', color: ink.text },
  t: { color: ink.muted, lineHeight: 21 },
  btn: { borderRadius: 30, paddingVertical: 13, alignItems: 'center', justifyContent: 'center', marginTop: 8, flexDirection: 'row', gap: 8 },
  hRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btnT: { fontWeight: '700', fontSize: 16 },
  link: { fontWeight: '600', paddingVertical: 6 },
});
