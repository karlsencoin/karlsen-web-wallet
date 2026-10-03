// wKLS -> KLS burn flow for the web wallet.
//
// The bridge daemon builds an unsigned burn_wrapped transaction
// (POST /v1/burns/prepare). Because that transaction comes from a server,
// this module NEVER signs it blindly: it decodes the transaction and checks
// every account, flag and data byte against values derived locally from
// hard-coded constants. Any mismatch aborts before Phantom is asked to sign.
//
// burn_record is seeded by config.burn_nonce at prepare time, so a concurrent
// burn (or an expired blockhash) makes the transaction fail atomically with
// nothing burned. prepareAndBurn() re-prepares and retries in that case.
//
// Requires: npm i @solana/web3.js@1 buffer

// Must stay the first import: web3.js expects a global Buffer.
import './polyfills';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { BRIDGE_API_URL } from './config';

// ------------------------------------------------------------------ constants
// Hard-coded on purpose: values reported by the daemon are not trusted here.

export const BRIDGE_PROGRAM_ID = new PublicKey('CwBhyyJTYjQjrNNCCEbtD6hPieacgjQGQ8wTVpmMgErC');
export const WKLS_MINT = new PublicKey('5uAD2HRwkctuRzg9XshhDmUKJugPtnQpuUFfDDxdfbpk');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const COMPUTE_BUDGET_ID = new PublicKey('ComputeBudget111111111111111111111111111111');

const SEED_CONFIG = new TextEncoder().encode('config');
const SEED_BURN = new TextEncoder().encode('burn');

/** Must match MAX_KARLSEN_DESTINATION_LEN in burn_wrapped.rs. */
const MAX_DEST_LEN = 90;
const MAX_ATTEMPTS = 3;

/** Upper bounds for the compute-budget instructions the daemon may add. */
const MAX_CU_LIMIT = 200_000;
/** micro-lamports per CU; at MAX_CU_LIMIT this caps the priority fee at 0.0002 SOL. */
const MAX_CU_PRICE = 1_000_000n;

// ------------------------------------------------------------------ types

export interface BurnPrepareRequest {
  owner: string;
  amountSompi: string;
  karlsenDestination: string;
}

export interface BurnPrepareResponse {
  /** Unsigned legacy transaction, base64. Fee payer = owner. */
  txBase64: string;
  /** config.burn_nonce the transaction was built against. */
  burnId: number;
  burnRecord: string;
  lastValidBlockHeight: number;
}

export type BurnProgress =
  | { step: 'preparing'; attempt: number }
  | { step: 'verifying' }
  | { step: 'signing' }
  | { step: 'submitted'; signature: string; burnId: number };

export interface BurnSubmitted {
  signature: string;
  burnId: number;
  /** After this Solana block height an unconfirmed burn can no longer land. */
  lastValidBlockHeight: number;
}

export class BurnError extends Error {
  constructor(
    public readonly code:
      | 'NO_PHANTOM'
      | 'USER_REJECTED'
      | 'VERIFY_FAILED'
      | 'PREPARE_FAILED'
      | 'RETRIES_EXHAUSTED'
      | 'SEND_FAILED',
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ Phantom

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: PublicKey | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>;
  disconnect(): Promise<void>;
  signAndSendTransaction(tx: Transaction): Promise<{ signature: string }>;
}

export function phantom(): PhantomProvider | null {
  const p = (window as unknown as { phantom?: { solana?: PhantomProvider } }).phantom?.solana;
  return p?.isPhantom ? p : null;
}

export async function connectPhantom(): Promise<PublicKey> {
  const p = phantom();
  if (!p) throw new BurnError('NO_PHANTOM', 'Phantom wallet not found.');
  try {
    const { publicKey } = await p.connect();
    return publicKey;
  } catch (e) {
    throw mapWalletError(e);
  }
}

// ------------------------------------------------------------------ derivations

function u64Le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

function u32Le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_CONFIG], BRIDGE_PROGRAM_ID)[0];
}

export function burnRecordPda(burnId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_BURN, u64Le(burnId)], BRIDGE_PROGRAM_ID)[0];
}

export function wklsAta(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), WKLS_MINT.toBuffer()],
    ATA_PROGRAM_ID,
  )[0];
}

let discriminatorCache: Uint8Array | null = null;

/** Anchor instruction discriminator: sha256("global:burn_wrapped")[..8]. */
async function burnDiscriminator(): Promise<Uint8Array> {
  if (!discriminatorCache) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('global:burn_wrapped'));
    discriminatorCache = new Uint8Array(h).slice(0, 8);
  }
  return discriminatorCache;
}

export async function expectedBurnData(amountSompi: bigint, dest: string): Promise<Uint8Array> {
  const d = new TextEncoder().encode(dest);
  return concat(await burnDiscriminator(), u64Le(amountSompi), u32Le(d.length), d);
}

// ------------------------------------------------------------------ verification

/**
 * Throws BurnError('VERIFY_FAILED') unless `tx` is exactly one burn_wrapped
 * call (optionally preceded by compute-budget ixs) burning `amountSompi`
 * from the owner's own wKLS ATA towards `dest`, with the owner as the only signer.
 */
export async function verifyBurnTx(
  tx: Transaction,
  owner: PublicKey,
  amountSompi: bigint,
  dest: string,
  burnId: bigint,
): Promise<void> {
  const fail = (why: string): never => {
    throw new BurnError('VERIFY_FAILED', `Burn transaction rejected: ${why}`);
  };

  if (!tx.feePayer?.equals(owner)) fail('fee payer is not your wallet');

  const signers = tx.compileMessage().header.numRequiredSignatures;
  if (signers !== 1) fail(`expected 1 signer, got ${signers}`);

  // Compute-budget ixs are allowed only as one SetComputeUnitLimit (2) and one
  // SetComputeUnitPrice (3), both bounded, so a tampered tx cannot burn SOL on fees.
  const budget = tx.instructions.filter((ix) => ix.programId.equals(COMPUTE_BUDGET_ID));
  const seen = new Set<number>();
  for (const b of budget) {
    const d = new Uint8Array(b.data);
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (b.keys.length !== 0 || seen.has(d[0])) fail('unexpected compute budget instruction');
    seen.add(d[0]);
    if (d[0] === 2 && d.length === 5) {
      if (view.getUint32(1, true) > MAX_CU_LIMIT) fail('compute unit limit too high');
    } else if (d[0] === 3 && d.length === 9) {
      if (view.getBigUint64(1, true) > MAX_CU_PRICE) fail('priority fee too high');
    } else {
      fail('unexpected compute budget instruction');
    }
  }

  const main = tx.instructions.filter((ix) => !ix.programId.equals(COMPUTE_BUDGET_ID));
  if (main.length !== 1) fail(`expected 1 bridge instruction, got ${main.length}`);
  const ix = main[0];
  if (!ix.programId.equals(BRIDGE_PROGRAM_ID)) fail('unexpected program');

  // [pubkey, isSigner, isWritable] in the exact BurnWrapped account order.
  const expected: [PublicKey, boolean, boolean][] = [
    [configPda(), false, true],
    [WKLS_MINT, false, true],
    [wklsAta(owner), false, true],
    [burnRecordPda(burnId), false, true],
    [owner, true, true],
    [SystemProgram.programId, false, false],
    [TOKEN_PROGRAM_ID, false, false],
  ];
  if (ix.keys.length !== expected.length) fail('unexpected account count');
  expected.forEach(([key, signer, writable], i) => {
    const k = ix.keys[i];
    if (!k.pubkey.equals(key) || k.isSigner !== signer || k.isWritable !== writable) {
      fail(`account #${i} mismatch`);
    }
  });

  const data = await expectedBurnData(amountSompi, dest);
  if (!bytesEqual(new Uint8Array(ix.data), data)) fail('amount or destination mismatch');
}

// ------------------------------------------------------------------ API

async function prepare(req: BurnPrepareRequest): Promise<BurnPrepareResponse> {
  const res = await fetch(`${BRIDGE_API_URL}/v1/burns/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => ({}))) as Partial<BurnPrepareResponse> & {
    error?: string;
    code?: string;
  };
  if (!res.ok) {
    throw new BurnError('PREPARE_FAILED', body.error ?? `Bridge API error ${res.status}`);
  }
  return body as BurnPrepareResponse;
}

// ------------------------------------------------------------------ errors

function mapWalletError(e: unknown): BurnError {
  const err = e as { code?: number; message?: string };
  if (err?.code === 4001) return new BurnError('USER_REJECTED', 'Request rejected in Phantom.');
  return new BurnError('SEND_FAILED', err?.message ?? String(e));
}

/** Failures where nothing was burned and a fresh prepare can succeed. */
function isRetryable(e: unknown): boolean {
  const m = ((e as { message?: string })?.message ?? '').toLowerCase();
  return (
    m.includes('0x7d6') || // Anchor ConstraintSeeds (2006): burn_nonce moved on
    m.includes('constraintseeds') ||
    m.includes('already in use') || // burn_record PDA taken by a concurrent burn
    m.includes('blockhash not found') ||
    m.includes('block height exceeded')
  );
}

// ------------------------------------------------------------------ main flow

/**
 * Prepares, verifies, signs and submits a burn. Returns the Solana signature
 * and the burn id to poll via GET /v1/burns/{burnId}.
 */
export async function prepareAndBurn(
  amountSompi: bigint,
  karlsenDestination: string,
  onProgress?: (p: BurnProgress) => void,
): Promise<BurnSubmitted> {
  const p = phantom();
  if (!p) throw new BurnError('NO_PHANTOM', 'Phantom wallet not found.');
  const owner = p.publicKey ?? (await connectPhantom());

  const dest = karlsenDestination.trim();
  if (!dest.startsWith('karlsen:') || dest.length > MAX_DEST_LEN) {
    throw new BurnError('VERIFY_FAILED', 'Invalid Karlsen destination address.');
  }

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onProgress?.({ step: 'preparing', attempt });
    const prep = await prepare({
      owner: owner.toBase58(),
      amountSompi: amountSompi.toString(),
      karlsenDestination: dest,
    });

    onProgress?.({ step: 'verifying' });
    const tx = Transaction.from(Uint8Array.from(atob(prep.txBase64), (c) => c.charCodeAt(0)));
    await verifyBurnTx(tx, owner, amountSompi, dest, BigInt(prep.burnId));
    if (prep.burnRecord !== burnRecordPda(BigInt(prep.burnId)).toBase58()) {
      throw new BurnError('VERIFY_FAILED', 'Burn record address mismatch.');
    }

    onProgress?.({ step: 'signing' });
    try {
      const { signature } = await p.signAndSendTransaction(tx);
      onProgress?.({ step: 'submitted', signature, burnId: prep.burnId });
      return { signature, burnId: prep.burnId, lastValidBlockHeight: prep.lastValidBlockHeight };
    } catch (e) {
      const mapped = mapWalletError(e);
      if (mapped.code === 'USER_REJECTED') throw mapped;
      if (!isRetryable(e)) throw mapped;
      lastError = e;
    }
  }
  throw new BurnError(
    'RETRIES_EXHAUSTED',
    `Burn could not be submitted after ${MAX_ATTEMPTS} attempts: ${(lastError as Error)?.message ?? 'unknown'}`,
  );
}

// ------------------------------------------------------------------ landing

export type TxLanding = 'pending' | 'confirmed' | 'finalized' | 'failed' | 'expired';

/**
 * Whether a submitted burn made it on chain. 'expired' and 'failed' mean
 * nothing was burned (the tx is atomic) and the user can simply try again.
 */
export async function burnTxState(signature: string, lastValidBlockHeight: number): Promise<TxLanding> {
  const res = await fetch(
    `${BRIDGE_API_URL}/v1/burns/tx/${encodeURIComponent(signature)}?lastValidBlockHeight=${lastValidBlockHeight}`,
    { cache: 'no-store' },
  );
  if (!res.ok) throw new Error(`Bridge API error ${res.status}`);
  return ((await res.json()) as { state: TxLanding }).state;
}
