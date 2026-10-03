// Client for the bridge daemon public API (/v1/*) plus a small local outbox,
// so a signed intent is never lost if the payment succeeded but the POST failed.
import { BRIDGE_API_URL } from './config';
import type { BridgeDepositResult } from './wallet';

export interface BridgeStatus {
  /** @deprecated Same value as depositAddress; kept for daemon compatibility. */
  vaultAddress: string;
  depositAddress: string;
  coldVaultAddress: string;
  programId: string;
  wklsMint: string | null;
  minDepositKls: string;
  minBurnKls: string;
  confirmations: number;
  intentMaxAgeHours: number;
  maxPerTxKls: string;
  dailyCapKls: string;
  dailyRemainingKls: string;
  dailyPayoutCapKls: string;
  dailyPayoutRemainingKls: string;
  accepting: boolean;
  payingOut: boolean;
  chainPaused: boolean;
  softPaused: boolean;
  payoutsPaused: boolean;
  hotWalletKls: string;
  coldVaultKls: string;
  reservesKls: string;
  wklsSupplyKls: string;
  updatedAtMs: number;
}

export type DepositStatus = 'pending' | 'ready' | 'minted' | 'manual' | 'rejected';

export interface DepositView {
  karlsenTxId: string;
  status: DepositStatus;
  note: string | null;
  amountKls: string;
  solanaDestination: string;
  receivedAtMs: number;
  updatedAtMs: number;
  mintSignature: string | null;
  mintedAtMs: number | null;
}

export interface BurnView {
  burnId: number;
  status: string;
  note: string | null;
  amountKls: string;
  paidKls: string | null;
  destination: string;
  burner: string;
  payoutTxId: string | null;
  detectedAtMs: number;
  updatedAtMs: number;
}

/** Wire form of an intent: the daemon wants integers as decimal strings. */
export interface WireIntent {
  intent: {
    networkId: string;
    karlsenTxId: string;
    vaultAddress: string;
    amountSompi: string;
    solanaDestination: string;
    timestampMs: string;
  };
  signature: string;
  publicKey: string;
}

export function toWire(r: BridgeDepositResult): WireIntent {
  const i = r.intent;
  return {
    intent: {
      networkId: i.networkId,
      karlsenTxId: String(i.karlsenTxId).toLowerCase(),
      vaultAddress: i.vaultAddress,
      amountSompi: i.amountSompi.toString(),
      solanaDestination: i.solanaDestination,
      timestampMs: i.timestampMs.toString(),
    },
    signature: r.signature,
    publicKey: r.publicKey,
  };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!BRIDGE_API_URL) throw new Error('Bridge API URL is not configured (VITE_BRIDGE_API_URL).');
  const res = await fetch(BRIDGE_API_URL + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Bridge API error ${res.status}`);
  return body as T;
}

export const bridgeApi = {
  status: () => call<BridgeStatus>('/v1/status'),
  submit: (w: WireIntent) => call<DepositView>('/v1/intents', { method: 'POST', body: JSON.stringify(w) }),
  deposit: (txId: string) => call<DepositView>(`/v1/intents/${encodeURIComponent(txId)}`),
  deposits: (destination: string) => call<DepositView[]>(`/v1/intents?destination=${encodeURIComponent(destination)}`),
  burn: (id: string) => call<BurnView>(`/v1/burns/${encodeURIComponent(id)}`),
  burns: (burner: string) => call<BurnView[]>(`/v1/burns?burner=${encodeURIComponent(burner)}`),
};

// ------------------------------------------------------------------ outbox
// Signed intents are public data (no secret inside), so localStorage is fine.
// An entry stays until the daemon has accepted it.

const OUTBOX_KEY = 'kww.bridge.outbox';

export function outboxList(): WireIntent[] {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]') as WireIntent[];
  } catch {
    return [];
  }
}

function outboxSave(list: WireIntent[]): void {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: the intent is still shown on screen for manual retry */
  }
}

export function outboxPut(w: WireIntent): void {
  const list = outboxList().filter((x) => x.intent.karlsenTxId !== w.intent.karlsenTxId);
  outboxSave([...list, w]);
}

export function outboxRemove(txId: string): void {
  outboxSave(outboxList().filter((x) => x.intent.karlsenTxId !== txId));
}

/** Sends one intent; removes it from the outbox once the daemon has it. */
export async function submitWithOutbox(w: WireIntent): Promise<DepositView> {
  outboxPut(w);
  const view = await bridgeApi.submit(w);
  outboxRemove(w.intent.karlsenTxId);
  return view;
}

// ------------------------------------------------------------------ helpers

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** True if `value` is base58 decoding to exactly 32 bytes (a Solana public key). */
export function isSolanaAddress(value: string): boolean {
  const v = value.trim();
  if (v.length < 32 || v.length > 44) return false;
  const bytes: number[] = [];
  for (const c of v) {
    let carry = B58.indexOf(c);
    if (carry < 0) return false;
    for (let i = bytes.length - 1; i >= 0; i--) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.unshift(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < v.length && v[zeros] === '1') zeros++;
  return zeros + bytes.length === 32;
}

/** "1234567.50000000" -> 123456750000000n (exact, no floats). */
export function klsToSompi(kls: string): bigint {
  const [w, f = ''] = kls.split('.');
  return BigInt(w || '0') * 100_000_000n + BigInt((f + '00000000').slice(0, 8));
}
