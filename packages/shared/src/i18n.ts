// Languages. Texts are written in English in the code; other languages map the English text
// to their own. The app has one language for everyone, picked by the owner (English by default).
import { CS } from './i18n.cs.ts';

export type Lang = 'en' | 'cs';
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'cs', label: 'Čeština' },
];
export const isLang = (v: unknown): v is Lang => v === 'en' || v === 'cs';

const DICTS: Record<Lang, Record<string, string>> = { en: {}, cs: CS };
let lang: Lang = 'en';

export function setLang(next: Lang): void {
  lang = next;
}

export function getLang(): Lang {
  return lang;
}

/** Locale for numbers and dates in the current language. */
export function locale(): string {
  return lang === 'cs' ? 'cs-CZ' : 'en-GB';
}

/** Translates an English text; {name} placeholders are filled from `params`. */
export function t(text: string, params?: Record<string, string | number>): string {
  const s = DICTS[lang][text] ?? text;
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;
}
