// User-adjustable runtime settings, persisted in localStorage (non-sensitive only).

/** Supported UI languages, ordered by ISO 639-1 code, each shown by its native name. */
export const LANGUAGES = [
  { code: 'de', name: 'Deutsch' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'zh', name: '中文' },
] as const;

export type Lang = (typeof LANGUAGES)[number]['code'];

export interface Settings {
  /** wRPC Borsh endpoint of a karlsend node, e.g. ws://192.168.1.25:43110 */
  nodeUrl: string;
  networkId: 'mainnet' | 'testnet-10' | 'testnet-11';
  lang: Lang;
  /** Colour theme; 'auto' follows the operating system. */
  theme: 'auto' | 'light' | 'dark';
}

/** Feature flags. The bridge tab stays hidden until the wKLS program and daemon are live. */
export const FEATURES = {
  bridge: import.meta.env.VITE_FEATURE_BRIDGE === 'true',
};

/** Bridge daemon public API base URL, without trailing slash. */
export const BRIDGE_API_URL = ((import.meta.env.VITE_BRIDGE_API_URL as string | undefined) ?? '').replace(/\/+$/, '');

/** Appended to Solana explorer links (cluster selection for test validators). */
export const SOLANA_EXPLORER_SUFFIX = (import.meta.env.VITE_SOLANA_EXPLORER_SUFFIX as string | undefined) ?? '';

/** Storage file name used by the SDK wallet runtime (one wallet per browser for now). */
export const WALLET_FILENAME = 'karlsen-web-wallet';

const SETTINGS_KEY = 'kww.settings';

function defaultNodeUrl(): string {
  const fromEnv = import.meta.env.VITE_DEFAULT_NODE_URL as string | undefined;
  if (fromEnv) return fromEnv;
  // Same-host default is convenient when karlsend runs next to the dev server.
  return `ws://${location.hostname || '127.0.0.1'}:43110`;
}

function defaultLang(): Lang {
  // First browser language we support wins; English otherwise.
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of preferred) {
    const base = tag?.toLowerCase().split('-')[0];
    const hit = LANGUAGES.find((l) => l.code === base);
    if (hit) return hit.code;
  }
  return 'en';
}

export function loadSettings(): Settings {
  const defaults: Settings = { nodeUrl: defaultNodeUrl(), networkId: 'mainnet', lang: defaultLang(), theme: 'auto' };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings stay in memory for this session */
  }
}

/** App version shown on the WALLET tab (kept in sync with package.json). */
export const APP_VERSION = '0.2.0';

/** Donation address shown on the WALLET tab (Karlsen development fund). */
export const DONATION_ADDRESS = import.meta.env.VITE_DONATION_ADDRESS as string | undefined;
