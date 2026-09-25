// User-adjustable runtime settings, persisted in localStorage (non-sensitive only).

export type Lang = 'en' | 'tr';

export interface Settings {
  /** wRPC Borsh endpoint of a karlsend node, e.g. ws://192.168.1.25:43110 */
  nodeUrl: string;
  networkId: 'mainnet' | 'testnet-10' | 'testnet-11';
  lang: Lang;
}

/** Feature flags. The bridge tab stays hidden until the wKLS program and daemon are live. */
export const FEATURES = {
  bridge: import.meta.env.VITE_FEATURE_BRIDGE === 'true',
};

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
  return navigator.language?.toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

export function loadSettings(): Settings {
  const defaults: Settings = { nodeUrl: defaultNodeUrl(), networkId: 'mainnet', lang: defaultLang() };
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
