// Legacy fund recovery for the deprecated key schemes:
//  - 'web972':    m/44'/972/0'/{type}'/{index}'  (old wallet.karlsencoin.org web wallet and Karlsen-Desktop v2)
//  - 'cli111111': m/44'/111111'/0'/{type}/{index} (original Go command-line wallet `karlsenwallet`,
//                 wallets created before karlsend v1.2.0 / March 2024, or later with `create --legacy`)
// Both schemes are scanned automatically, so the user does not need to know which wallet they used.
//
// Safety model:
//  1. 972 derivation runs in the rusty-karlsen gen0 implementation (WASM), which self-checks every
//     private key against the public derivation. 111111 derivation is plain BIP32 (same as the Go
//     wallet: BIP39 seed with an empty passphrase, Schnorr P2PK addresses) done with the SDK XPrv.
//  2. Every returned key must map to exactly the address found during the scan.
//  3. The destination is supplied by the caller from the unlocked wallet state (the
//     current 121337 account's receive address). It is never typed in by the user and
//     must not be one of the legacy addresses.
//  4. All transactions are signed and verified BEFORE any is submitted: every output of
//     every transaction must pay to the destination script, otherwise nothing is sent.
//  5. Total fees are capped relative to the swept amount.
//  6. Immature coinbase UTXOs are skipped (reported separately).
//  7. UTXOs are re-fetched from the node at sweep time; scan results are not trusted.
//  8. A test transfer (a single small UTXO) can be sent first to prove the keys and the
//     destination before the rest is moved.
import type { Sdk } from './sdk';

export type LegacyAddressType = 0 | 1; // 0 = receive, 1 = change
export type LegacyScheme = 'web972' | 'cli111111';

export interface LegacyFundedAddress {
  scheme: LegacyScheme;
  type: LegacyAddressType;
  index: number;
  path: string;
  address: string;
  balance: bigint;
  utxos: number;
}

export interface LegacyScanResult {
  funded: LegacyFundedAddress[];
  totalSompi: bigint;
  matureSompi: bigint;
  utxoCount: number;
  matureUtxoCount: number;
  immatureUtxoCount: number;
  scanned: { receive: number; change: number };
  /** Schemes that were actually scanned (972 needs a custom SDK build). */
  schemes: LegacyScheme[];
}

export interface LegacySweepPreview {
  totalSompi: bigint;
  feesSompi: bigint;
  finalSompi: bigint;
  transactions: number;
  utxos: number;
  destination: string;
  /** True when only a single small UTXO is moved (test transfer). */
  test: boolean;
}

interface DerivedAddress {
  type: number;
  index: number;
  path: string;
  address: string;
}

interface DerivedKey extends DerivedAddress {
  privateKey: string;
}

/** Addresses derived per type and scheme during a scan. */
export const DEFAULT_LEGACY_SCAN_COUNT = 1000;
/** Addresses per getUtxosByAddresses call. */
const RPC_CHUNK = 500;
/** Refuse to sign when total fees exceed this share of the swept amount (basis points, 100 = 1%). */
const MAX_FEE_BPS = 100n;
/** Test transfers prefer the smallest UTXO of at least this size (1 KLS), so fees stay far below the cap. */
const TEST_MIN_SOMPI = 100_000_000n;

/** Account path of the Go command-line wallet v1 (coin type inherited from Kaspa). */
const CLI_ACCOUNT_PATH = "m/44'/111111'/0'";

function normalizeMnemonic(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ');
}

function addressText(value: unknown): string {
  if (typeof value === 'string') return value;
  return String((value as { toString(): string })?.toString?.() ?? '');
}

function scriptHex(spk: unknown): string {
  const s = spk as { script?: unknown; toString?: () => string } | undefined;
  if (s && typeof s.script === 'string') return s.script.toLowerCase();
  return String(s?.toString?.() ?? '').toLowerCase();
}

function web972Api(sdk: Sdk) {
  const api = sdk as unknown as {
    deriveLegacyAddresses?: (m: string, n: string, t: number, start: number, count: number) => DerivedAddress[];
    deriveLegacyPrivateKeys?: (m: string, n: string, t: number, indexes: Uint32Array) => DerivedKey[];
  };
  if (!api.deriveLegacyAddresses || !api.deriveLegacyPrivateKeys) return null;
  return api as Required<typeof api>;
}

/** Account-level XPrv of the CLI scheme. Caller must free() it. */
function cliAccountXPrv(sdk: Sdk, phrase: string): any {
  const s = sdk as any;
  const mnemonic = new s.Mnemonic(phrase);
  const seed: string = mnemonic.toSeed(''); // Go wallet: bip39.NewSeed(mnemonic, "")
  mnemonic.free?.();
  const master = new s.XPrv(seed);
  const account = master.derivePath(CLI_ACCOUNT_PATH);
  master.free?.();
  return account;
}

/** Derives CLI addresses (and optionally keys) for one keychain. Non-hardened `type/index`, as in the Go wallet. */
function deriveCli(sdk: Sdk, phrase: string, networkId: string, type: number, indexes: number[], withKeys: boolean): DerivedKey[] {
  const account = cliAccountXPrv(sdk, phrase);
  const chain = account.deriveChild(type, false);
  account.free?.();
  const out: DerivedKey[] = [];
  try {
    for (const index of indexes) {
      const child = chain.deriveChild(index, false);
      const key = child.toPrivateKey();
      out.push({
        type,
        index,
        path: `${CLI_ACCOUNT_PATH}/${type}/${index}`,
        address: addressText(key.toAddress(networkId)), // Schnorr P2PK, same as the Go wallet default
        privateKey: withKeys ? String(key.toString()) : '',
      });
      key.free?.();
      child.free?.();
    }
  } finally {
    chain.free?.();
  }
  return out;
}

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

function deriveAddresses(sdk: Sdk, scheme: LegacyScheme, phrase: string, networkId: string, type: number, count: number): DerivedAddress[] {
  if (scheme === 'web972') return web972Api(sdk)!.deriveLegacyAddresses(phrase, networkId, type, 0, count);
  return deriveCli(sdk, phrase, networkId, type, range(0, count), false);
}

function deriveKeys(sdk: Sdk, scheme: LegacyScheme, phrase: string, networkId: string, type: number, indexes: number[]): DerivedKey[] {
  if (scheme === 'web972') return web972Api(sdk)!.deriveLegacyPrivateKeys(phrase, networkId, type, Uint32Array.from(indexes));
  return deriveCli(sdk, phrase, networkId, type, indexes, true);
}

function availableSchemes(sdk: Sdk): LegacyScheme[] {
  return web972Api(sdk) ? ['web972', 'cli111111'] : ['cli111111'];
}

async function fetchUtxos(rpc: any, addresses: string[]): Promise<any[]> {
  const all: any[] = [];
  for (let i = 0; i < addresses.length; i += RPC_CHUNK) {
    const { entries } = await rpc.getUtxosByAddresses({ addresses: addresses.slice(i, i + RPC_CHUNK) });
    all.push(...(entries ?? []));
  }
  return all;
}

async function maturityFilter(sdk: Sdk, rpc: any, networkId: string) {
  const { virtualDaaScore } = await rpc.getBlockDagInfo();
  const params = (sdk as any).getNetworkParams(networkId);
  const maturity = BigInt(params.coinbaseTransactionMaturityPeriodDaa);
  const virtual = BigInt(virtualDaaScore);
  return (entry: any) => !entry.isCoinbase || virtual - BigInt(entry.blockDaaScore) >= maturity;
}

/** Derives legacy addresses of every supported scheme and reports which of them hold funds. Read-only. */
export async function scanLegacyFunds(
  sdk: Sdk,
  rpc: any,
  networkId: string,
  mnemonic: string,
  count: number = DEFAULT_LEGACY_SCAN_COUNT,
): Promise<LegacyScanResult> {
  const phrase = normalizeMnemonic(mnemonic);
  const schemes = availableSchemes(sdk);

  const byAddress = new Map<string, DerivedAddress & { scheme: LegacyScheme }>();
  for (const scheme of schemes) {
    for (const type of [0, 1]) {
      for (const d of deriveAddresses(sdk, scheme, phrase, networkId, type, count)) {
        byAddress.set(d.address, { ...d, scheme });
      }
    }
  }

  const entries = await fetchUtxos(rpc, [...byAddress.keys()]);
  const isMature = await maturityFilter(sdk, rpc, networkId);

  const funded = new Map<string, LegacyFundedAddress>();
  let totalSompi = 0n;
  let matureSompi = 0n;
  let immatureUtxoCount = 0;

  for (const entry of entries) {
    const address = addressText(entry.address);
    const d = byAddress.get(address);
    if (!d) continue; // never happens unless the node returns unrelated entries
    const amount = BigInt(entry.amount);
    totalSompi += amount;
    if (isMature(entry)) matureSompi += amount;
    else immatureUtxoCount++;

    const row = funded.get(address) ?? {
      scheme: d.scheme,
      type: d.type as LegacyAddressType,
      index: d.index,
      path: d.path,
      address,
      balance: 0n,
      utxos: 0,
    };
    row.balance += amount;
    row.utxos += 1;
    funded.set(address, row);
  }

  return {
    funded: [...funded.values()].sort(
      (a, b) => a.scheme.localeCompare(b.scheme) || a.type - b.type || a.index - b.index,
    ),
    totalSompi,
    matureSompi,
    utxoCount: entries.length,
    matureUtxoCount: entries.length - immatureUtxoCount,
    immatureUtxoCount,
    scanned: { receive: count, change: count },
    schemes,
  };
}

/** Validates the destination against the scanned legacy addresses. */
function checkDestination(sdk: Sdk, destination: string, funded: LegacyFundedAddress[]): void {
  if (!(sdk as any).Address.validate(destination)) throw new Error('Invalid destination address.');
  if (funded.some((f) => f.address === destination)) {
    throw new Error('Destination must not be a legacy address.');
  }
}

/** Picks the UTXO for a test transfer: the smallest one of at least 1 KLS, else the largest one. */
function pickTestEntry(entries: any[]): any[] {
  const sorted = [...entries].sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
  const pick = sorted.find((e) => BigInt(e.amount) >= TEST_MIN_SOMPI) ?? sorted[sorted.length - 1];
  return pick ? [pick] : [];
}

/** Max inputs per sweep transaction; halved automatically when a chunk does not fit one transaction. */
const SWEEP_CHUNK_INPUTS = 80;

async function buildSignedSweep(
  sdk: Sdk,
  rpc: any,
  networkId: string,
  mnemonic: string,
  funded: LegacyFundedAddress[],
  destination: string,
  test: boolean,
) {
  const phrase = normalizeMnemonic(mnemonic);
  checkDestination(sdk, destination, funded);
  if (funded.length === 0) throw new Error('No legacy funds to move.');

  // Derive only the keys we need, then check each one maps to its scanned address.
  const keys: DerivedKey[] = [];
  for (const scheme of ['web972', 'cli111111'] as const) {
    for (const type of [0, 1] as const) {
      const rows = funded.filter((f) => f.scheme === scheme && f.type === type);
      if (rows.length === 0) continue;
      const derived = deriveKeys(sdk, scheme, phrase, networkId, type, rows.map((r) => r.index));
      derived.forEach((k, i) => {
        if (k.index !== rows[i].index || k.address !== rows[i].address || !k.privateKey) {
          throw new Error(`Key/address mismatch at ${rows[i].path}. Nothing was sent.`);
        }
      });
      keys.push(...derived);
    }
  }
  const privateKeys = keys.map((k) => new (sdk as any).PrivateKey(k.privateKey));

  try {
    // Fresh UTXO set from the node; only mature entries are spent.
    const entries = await fetchUtxos(rpc, funded.map((f) => f.address));
    const isMature = await maturityFilter(sdk, rpc, networkId);
    const mature = entries.filter(isMature);
    const spendable = test ? pickTestEntry(mature) : mature;
    if (spendable.length === 0) throw new Error('No mature legacy UTXOs available yet.');
    const totalSompi = spendable.reduce((sum, e) => sum + BigInt(e.amount), 0n);

    // Independent single transactions, each paying straight to the destination.
    // No chaining: every input is a legacy UTXO, so legacy keys alone sign everything.
    const fundedSet = new Set(funded.map((f) => f.address));
    const destinationScript = scriptHex((sdk as any).payToAddressScript(destination));
    const transactions: any[] = [];
    let feesSompi = 0n;
    let finalSompi = 0n;
    const outpointKey = (e: any): string => {
      const op = e?.outpoint ?? e?.entry?.outpoint;
      return `${op?.transactionId}:${op?.index}`;
    };
    let remaining = spendable;
    let chunkSize = SWEEP_CHUNK_INPUTS;

    while (remaining.length > 0) {
      const chunk = remaining.slice(0, chunkSize);
      // No outputs + changeAddress = the spent inputs go to the destination.
      const { transactions: built } = await (sdk as any).createTransactions({
        entries: chunk,
        outputs: [],
        changeAddress: destination,
        priorityFee: 0n,
        networkId,
      });
      if (built.length !== 1) {
        if (chunkSize === 1) throw new Error('Could not build a single-transaction sweep. Nothing was sent.');
        chunkSize = Math.max(1, Math.floor(chunkSize / 2));
        continue; // retry with a smaller chunk
      }

      const pending = built[0];
      pending.sign(privateKeys, true); // throws unless every input is signed
      for (const input of pending.addresses()) {
        if (!fundedSet.has(addressText(input))) {
          throw new Error('A transaction spends from an unexpected address. Nothing was sent.');
        }
      }

      // The generator may not spend every entry it was given: read the inputs from the transaction itself.
      const used: any[] = pending.getUtxoEntries();
      const chunkKeys = new Set(chunk.map(outpointKey));
      const usedKeys = new Set(used.map(outpointKey));
      if (usedKeys.size === 0 || [...usedKeys].some((k) => !chunkKeys.has(k))) {
        throw new Error('A transaction has unexpected inputs. Nothing was sent.');
      }
      const inputSompi = used.reduce((sum, e) => sum + BigInt(e.amount), 0n);

      let outputSompi = 0n;
      for (const output of pending.transaction.outputs) {
        if (scriptHex(output.scriptPublicKey) !== destinationScript) {
          throw new Error('A transaction output does not pay to your address. Nothing was sent.');
        }
        outputSompi += BigInt(output.value);
      }
      const txFee = inputSompi - outputSompi; // actual fee of this transaction
      if (txFee < 0n) throw new Error('A transaction pays out more than it spends. Nothing was sent.');

      transactions.push(pending);
      feesSompi += txFee;
      finalSompi += outputSompi;
      remaining = remaining.filter((e) => !usedKeys.has(outpointKey(e)));
    }

    if (feesSompi * 10_000n > totalSompi * MAX_FEE_BPS) {
      throw new Error(`Fee limit exceeded (${feesSompi} sompi for ${totalSompi} sompi). Nothing was sent.`);
    }
    if (finalSompi + feesSompi !== totalSompi) {
      throw new Error(`Sweep amounts do not add up (inputs ${totalSompi}, outputs ${finalSompi}, reported fees ${feesSompi}, difference ${totalSompi - finalSompi - feesSompi}). Nothing was sent.`);
    }

    const preview: LegacySweepPreview = {
      totalSompi,
      feesSompi,
      finalSompi,
      transactions: transactions.length,
      utxos: spendable.length,
      destination,
      test,
    };
    return { transactions, preview };
  } finally {
    // Signing is done (or failed): drop the key objects right away.
    privateKeys.forEach((k: any) => k.free?.());
  }
}

/** Builds, signs and verifies the sweep without submitting it (for the confirmation screen). */
export async function previewLegacySweep(
  sdk: Sdk,
  rpc: any,
  networkId: string,
  mnemonic: string,
  funded: LegacyFundedAddress[],
  destination: string,
  test = false,
): Promise<LegacySweepPreview> {
  const { preview } = await buildSignedSweep(sdk, rpc, networkId, mnemonic, funded, destination, test);
  return preview;
}

/** Builds, signs, verifies and submits the sweep. Returns transaction ids in submission order. */
export async function sweepLegacyFunds(
  sdk: Sdk,
  rpc: any,
  networkId: string,
  mnemonic: string,
  funded: LegacyFundedAddress[],
  destination: string,
  onProgress?: (done: number, total: number) => void,
  test = false,
): Promise<string[]> {
  const { transactions } = await buildSignedSweep(sdk, rpc, networkId, mnemonic, funded, destination, test);
  const ids: string[] = [];
  for (const pending of transactions) {
    ids.push(await pending.submit(rpc));
    onProgress?.(ids.length, transactions.length);
  }
  return ids;
}
