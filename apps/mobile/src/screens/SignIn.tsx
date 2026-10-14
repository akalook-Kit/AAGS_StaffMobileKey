import { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, tokenStore } from '../api';
import { HOTEL_CODE } from '../config';
import { ink, useBrand } from '../theme';
import { useT } from '../i18n';

export function SignIn({ config, onSignedIn }: { config: any; onSignedIn: () => Promise<void> }) {
  const b = useBrand();
  const { t } = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api('/mobile/v1/login', { hotel: HOTEL_CODE, email: email.trim(), password });
      await tokenStore.set(r.token);
      await onSignedIn();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[s.top, { backgroundColor: b.primary }]}>
        {b.logo ? <Image source={{ uri: b.logo }} style={[s.logo, { width: 160 * b.logoScale, height: 56 * b.logoScale }]} resizeMode="contain" /> : (
          <View style={[s.tag, { borderColor: b.secondary }]}><View style={[s.hole, { borderColor: b.secondary }]} /><Text style={[s.tagText, { color: b.secondary }]}>KEY</Text></View>
        )}
        <Text style={[s.hotel, { color: b.onPrimary, fontFamily: b.font }]}>{config?.hotel?.name ?? t.hotelInfo}</Text>
        <Text style={{ color: b.onPrimary, opacity: 0.8, fontFamily: b.font }}>{b.appName}</Text>
      </View>
      <View style={s.form}>
        <Text style={[s.h, { fontFamily: b.font }]}>{t.signInH}</Text>
        {error && <Text style={s.err} accessibilityRole="alert">{error}</Text>}
        <Text style={s.label}>{t.workEmail}</Text>
        <TextInput style={s.input} value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" />
        <Text style={s.label}>{t.password}</Text>
        <TextInput style={s.input} value={password} onChangeText={setPassword} secureTextEntry textContentType="password" onSubmitEditing={submit} />
        <Pressable style={[s.btn, { backgroundColor: b.primary, opacity: busy || !email || !password ? 0.6 : 1 }]} disabled={busy || !email || !password} onPress={submit} accessibilityRole="button">
          <Text style={[s.btnText, { color: b.onPrimary }]}>{busy ? t.signingIn : t.signIn}</Text>
        </Pressable>
        <Text style={s.note}>{t.troubleSignIn(config?.property?.supportPhone)}</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  top: { paddingTop: 80, paddingBottom: 34, paddingHorizontal: 24, gap: 6, borderBottomLeftRadius: 28, borderBottomRightRadius: 28 },
  logo: { width: 160, height: 56, marginBottom: 14 },
  tag: { width: 54, height: 84, borderWidth: 2, borderRadius: 10, borderBottomLeftRadius: 28, borderBottomRightRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  hole: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, position: 'absolute', top: 10 },
  tagText: { fontWeight: '700', fontSize: 12, letterSpacing: 1, marginTop: 14 },
  hotel: { fontSize: 28, fontWeight: '700' },
  form: { padding: 24, gap: 6 },
  h: { fontSize: 18, fontWeight: '600', color: ink.text, marginBottom: 10 },
  label: { fontSize: 14, color: ink.muted, marginTop: 8 },
  input: { borderWidth: 1, borderColor: ink.line, backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  btn: { marginTop: 20, borderRadius: 30, paddingVertical: 15, alignItems: 'center' },
  btnText: { fontSize: 16, fontWeight: '700' },
  err: { backgroundColor: ink.badBg, color: ink.bad, padding: 12, borderRadius: 10 },
  note: { color: ink.faint, fontSize: 13, marginTop: 16, textAlign: 'center' },
});
