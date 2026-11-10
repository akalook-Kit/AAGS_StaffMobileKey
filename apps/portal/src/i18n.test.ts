import { describe, expect, it } from 'vitest';
import { setLang, trAny } from './i18n';
import { FR_ALL } from './i18n-fr';

describe('2.33.1 French everywhere', () => {
  setLang('fr');

  it('translates whole texts, server errors and texts with values', () => {
    expect(trAny('Settings')).toBe('Paramètres');
    expect(trAny('Email or password is incorrect.')).toBe('E-mail ou mot de passe incorrect.');
    expect(trAny('Missing permission: key.issue')).toBe('Autorisation manquante : key.issue');
    expect(trAny('5 min ago')).toBe('il y a 5 min');
    expect(trAny('Last read: 3 min ago')).toBe('Dernière lecture : il y a 3 min');
    expect(trAny('Readiness · 1 of 7 ready')).toBe('État de préparation · 1 sur 7 prêts');
    expect(trAny('Reports:')).toBe('Rapports :');
  });

  it('a short pattern never rewrites one word inside a long sentence', () => {
    const s = 'Someone left the card reader cover open near the lobby door last night.';
    expect(trAny(s)).toBe(s);
  });

  it('names, numbers and unknown texts stay as they are', () => {
    for (const s of ['Amina Mbarga', '804', 'HK 001', 'La Falaise Hotel Bonapriso']) expect(trAny(s)).toBe(s);
  });

  it('every translation keeps the same {placeholders} and is not empty', () => {
    const ph = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join();
    for (const [en, fr] of Object.entries(FR_ALL)) {
      expect(fr.trim().length, en).toBeGreaterThan(0);
      expect(ph(fr), en).toBe(ph(en));
    }
  });

  it('English stays English', () => {
    setLang('en');
    expect(trAny('Settings')).toBe('Settings');
    setLang('fr');
  });
});
