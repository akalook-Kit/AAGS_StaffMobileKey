import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { DICTS, I18nCtx, loadLang, saveLang, type Lang } from './src/i18n';
import { api, tokenStore } from './src/api';
import { HOTEL_CODE } from './src/config';
import { BrandCtx, brandFrom, ink, type Brand } from './src/theme';
import { SignIn } from './src/screens/SignIn';
import { Setup } from './src/screens/Setup';
import { KeysScreen } from './src/screens/Keys';
import { SupportScreen } from './src/screens/Support';
import { ProfileScreen } from './src/screens/Profile';
import { TasksScreen } from './src/screens/Tasks';

export interface Session { staff: { id: string; name: string; email: string; jobRole: string }; endpoint: { endpointId: string; status: string; activatedAt?: string } | null }
type Tab = 'keys' | 'tasks' | 'support' | 'profile';

export default function App() {
  const [config, setConfig] = useState<any>(null);
  const [brand, setBrand] = useState<Brand>(brandFrom(null));
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<Tab>('keys');
  const [lang, setLangState] = useState<Lang>('en');
  const setLang = (l: Lang) => { setLangState(l); void saveLang(l); };
  const i18n = { lang, t: DICTS[lang], setLang, locale: lang === 'fr' ? 'fr-FR' : 'en-GB' };

  const loadConfig = useCallback(async (signedIn: boolean) => {
    try {
      const c = await api(signedIn ? '/mobile/v1/config' : `/mobile/v1/config?hotel=${HOTEL_CODE}`);
      setConfig(c); setBrand(brandFrom(c));
    } catch { /* keep last known configuration */ }
  }, []);
  const refreshSession = useCallback(async () => {
    try { setSession(await api<Session>('/mobile/v1/me')); } catch { await tokenStore.set(null); setSession(null); }
  }, []);

  useEffect(() => {
    (async () => {
      setLangState(await loadLang());
      const t = await tokenStore.get();
      await loadConfig(Boolean(t));
      if (t) await refreshSession();
      setBooting(false);
    })();
  }, [loadConfig, refreshSession]);

  const signOut = async () => { await tokenStore.set(null); setSession(null); setTab('keys'); };

  let body;
  if (booting) body = <View style={s.center}><ActivityIndicator color={brand.primary} /></View>;
  else if (!session) body = <SignIn config={config} onSignedIn={async () => { await loadConfig(true); await refreshSession(); }} />;
  else if (session.endpoint?.status !== 'ACTIVE') body = <Setup session={session} onRefresh={refreshSession} onSignOut={signOut} />;
  else body = (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        {tab === 'keys' && <KeysScreen session={session} config={config} />}
        {tab === 'tasks' && <TasksScreen staffId={session.staff.id} />}
        {tab === 'support' && <SupportScreen config={config} />}
        {tab === 'profile' && <ProfileScreen session={session} onSignOut={signOut} />}
      </View>
      <View style={s.tabbar} accessibilityRole="tablist">
        {([['keys', i18n.t.keys, 'key'], ...(config?.features?.maintenance ? [['tasks', i18n.t.tasks, 'construct']] : []), ['support', i18n.t.support, 'help-buoy'], ['profile', i18n.t.profile, 'person-circle']] as [Tab, string, string][]).map(([id, label, icon]) => (
          <Pressable key={id} style={s.tab} onPress={() => setTab(id)} accessibilityRole="tab" accessibilityState={{ selected: tab === id }} accessibilityLabel={label}>
            <View style={[s.tabIcon, tab === id && { backgroundColor: brand.primary }]}>
              <Ionicons name={(tab === id ? icon : `${icon}-outline`) as any} size={20} color={tab === id ? brand.onPrimary : ink.muted} />
            </View>
            <Text style={[s.tabText, { fontFamily: brand.font }, tab === id && { color: brand.primary, fontWeight: '700' }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );

  return (
    <I18nCtx.Provider value={i18n}>
    <BrandCtx.Provider value={brand}>
      <View style={[s.root, { backgroundColor: brand.background }]}>
        <StatusBar style="light" />
        {body}
      </View>
    </BrandCtx.Provider>
    </I18nCtx.Provider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabbar: { flexDirection: 'row', backgroundColor: '#fff', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ink.line, paddingBottom: 18, paddingTop: 6 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 4, gap: 3 },
  tabIcon: { width: 52, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  tabText: { fontSize: 12, color: ink.muted },
});
