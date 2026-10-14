import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api } from '../api';
import { mobileAccess } from '../mobile-access';
import { ink, useBrand } from '../theme';
import { useT } from '../i18n';
import type { Session } from '../../App';

/**
 * Phone onboarding (spec §12.3 step 2, §13.2 steps 3–4): ask the platform for a Credential Services
 * invitation, hand the code straight to the vendor SDK, then wait for the endpoint to become ACTIVE.
 * The code is never shown, stored or logged.
 */
export function Setup({ session, onRefresh, onSignOut }: { session: Session; onRefresh: () => Promise<void>; onSignOut: () => void }) {
  const b = useBrand();
  const { t } = useT();
  const [step, setStep] = useState<'idle' | 'inviting' | 'personalizing' | 'activating'>('idle');
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setError(null);
    try {
      setStep('inviting');
      const inv = await api('/mobile/v1/onboarding', { deviceLabel: `${Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'Browser preview'} (${session.staff.name.split(' ')[0]})` });
      setStep('personalizing');
      await mobileAccess.personalize(inv.invitationCode, Platform.OS);
      setStep('activating');
      for (let i = 0; i < 40; i++) {
        const me = await api<Session>('/mobile/v1/me');
        if (me.endpoint?.status === 'ACTIVE') { await onRefresh(); return; }
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error(t.setupSlow);
    } catch (e) { setError((e as Error).message); setStep('idle'); }
  };
  const steps = [
    { label: t.stepSignedIn, done: true },
    { label: t.stepRegistered, done: step === 'activating', active: step === 'inviting' || step === 'personalizing' },
    { label: t.stepReady, done: false, active: step === 'activating' },
  ];
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={[s.top, { backgroundColor: b.primary }]}>
        <Text style={[s.title, { color: b.onPrimary, fontFamily: b.font }]}>{t.setupH}</Text>
        <Text style={{ color: b.onPrimary, opacity: 0.85, fontFamily: b.font }}>{t.setupIntro(session.staff.name.split(' ')[0]!)}</Text>
      </View>
      <View style={s.body}>
        {steps.map((x, i) => (
          <View key={x.label} style={s.step}>
            <View style={[s.dot, { borderColor: b.primary }, x.done && { backgroundColor: b.primary }]}><Text style={{ color: x.done ? b.onPrimary : b.primary, fontWeight: '700' }}>{x.done ? '✓' : i + 1}</Text></View>
            <Text style={[s.stepText, x.active && { fontWeight: '700' }]}>{x.label}{x.active ? '…' : ''}</Text>
          </View>
        ))}
        <View style={s.box}>
          <Text style={s.boxH}>{t.beforeStart}</Text>
          <Text style={s.boxT}>• {t.bs1}</Text>
          <Text style={s.boxT}>• {t.bs2}</Text>
          <Text style={s.boxT}>• {t.bs3}</Text>
        </View>
        {mobileAccess.mode === 'simulated' && <Text style={s.sim}>{t.simBuild}</Text>}
        {error && <Text style={s.err} accessibilityRole="alert">{error}</Text>}
        <Pressable style={[s.btn, { backgroundColor: b.primary, opacity: step !== 'idle' ? 0.6 : 1 }]} disabled={step !== 'idle'} onPress={start} accessibilityRole="button">
          <Text style={[s.btnText, { color: b.onPrimary }]}>{step === 'idle' ? t.setupBtn : t.settingUp}</Text>
        </Pressable>
        <Pressable onPress={onSignOut} style={{ alignSelf: 'center', marginTop: 18 }}><Text style={{ color: ink.muted }}>{t.signOut}</Text></Pressable>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  top: { paddingTop: 70, paddingBottom: 28, paddingHorizontal: 24, gap: 8 },
  title: { fontSize: 28, fontWeight: '700' },
  body: { padding: 24, gap: 14 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dot: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 16, color: ink.text },
  box: { backgroundColor: '#fff', borderRadius: 14, padding: 16, gap: 6, marginTop: 8 },
  boxH: { fontWeight: '700', color: ink.text, marginBottom: 2 },
  boxT: { color: ink.muted, lineHeight: 20 },
  sim: { color: ink.warn, backgroundColor: ink.warnBg, padding: 10, borderRadius: 10, fontSize: 13 },
  err: { backgroundColor: ink.badBg, color: ink.bad, padding: 12, borderRadius: 10 },
  btn: { borderRadius: 30, paddingVertical: 15, alignItems: 'center', marginTop: 6 },
  btnText: { fontSize: 16, fontWeight: '700' },
});
