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
  /**
   * 'public': connect to the Karlsen public node(s) shipped with this build (default).
   * 'custom': connect to the user's own node given in `nodeUrl`.
   */
  nodeMode: 'public' | 'custom';
  /** wRPC Borsh endpoint of the user's own karlsend node (used only when nodeMode is 'custom'). */
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

/**
 * Public node endpoints, tried in order until one answers (simple failover).
 * Build-time override: VITE_PUBLIC_NODE_URLS="wss://a/wrpc,wss://b/wrpc".
 * Default on https: the same origin's /wrpc path, proxied by nginx to karlsend, so
 * wallet.karlsencoin.org and any later domain each use their own endpoint.
 * Default on plain http (LAN preview): karlsend on the same host, port 43110.
 */
export function publicNodeUrls(): string[] {
  const fromEnv = (import.meta.env.VITE_PUBLIC_NODE_URLS as string | undefined) ?? '';
  const list = fromEnv.split(',').map((u) => u.trim()).filter(Boolean);
  if (list.length) return list;
  if (location.protocol === 'https:') return [`wss://${location.host}/wrpc`];
  return [`ws://${location.hostname || '127.0.0.1'}:43110`];
}

/** Endpoints the wallet should try for the given settings, in order. */
export function nodeCandidates(s: Settings): string[] {
  return s.nodeMode === 'custom' && s.nodeUrl ? [s.nodeUrl] : publicNodeUrls();
}

/**
 * Validates a custom node URL. Returns an i18n key describing the problem, or undefined if valid.
 * A page served over https may only open wss:// sockets (browsers block ws:// as mixed content),
 * except to localhost.
 */
export function validateNodeUrl(raw: string): 'nodeUrlInvalid' | 'nodeUrlNeedsWss' | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return 'nodeUrlInvalid';
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return 'nodeUrlInvalid';
  if (!u.hostname) return 'nodeUrlInvalid';
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (location.protocol === 'https:' && u.protocol === 'ws:' && !local) return 'nodeUrlNeedsWss';
  return undefined;
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
  const defaults: Settings = { nodeMode: 'public', nodeUrl: '', networkId: 'mainnet', lang: defaultLang(), theme: 'auto' };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaults;
    const stored = JSON.parse(raw) as Partial<Settings>;
    // Settings saved before nodeMode existed always carried a node URL; start them on the
    // public node so a stale LAN address cannot lock the wallet on "connecting…".
    if (!stored.nodeMode) stored.nodeMode = 'public';
    return { ...defaults, ...stored };
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

/**
 * Where the previous web wallet (m/44'/972, pwa.js) is served, unchanged, on the same origin.
 * Same origin matters: its encrypted wallet stays in this browser's storage and opens with the old password.
 */
export const LEGACY_WALLET_URL = (import.meta.env.VITE_LEGACY_WALLET_URL as string | undefined) ?? '/legacy';

/** True when this browser still holds a wallet created by the previous web wallet. */
export function hasLegacyWallet(): boolean {
  try {
    // Old wallet keys: "karlsen-wallet" and "karlsen-wallet-<timestamp>" (this wallet uses "karlsen-web-wallet.*").
    return Object.keys(localStorage).some((k) => k === 'karlsen-wallet' || /^karlsen-wallet-\d+$/.test(k));
  } catch {
    return false;
  }
}

/** App version shown on the WALLET tab (kept in sync with package.json). */
export const APP_VERSION = '2.0.0';

/** Donation address shown on the WALLET tab (Karlsen development fund). */
export const DONATION_ADDRESS = import.meta.env.VITE_DONATION_ADDRESS as string | undefined;
