// WalletService: a thin, UI-agnostic wrapper around the SDK Wallet runtime.
// Lifecycle mirrors the official SDK example (examples/nodejs/javascript/wallet/wallet.js):
//   walletCreate -> walletOpen -> accountsEnsureDefault -> connect -> start
//   -> accountsEnumerate -> accountsActivate -> events (balance, pending, maturity, ...)
import { loadSdk, type Sdk } from './sdk';
import { WALLET_FILENAME, type Settings } from './config';
import type {
  Wallet,
  IAccountDescriptor,
  IBalance,
  ITransactionRecord,
  IFeeRateEstimateResponse,
} from './karlsen-sdk';

export type Phase = 'loading' | 'no-wallet' | 'locked' | 'opening' | 'ready' | 'error';

export interface WalletState {
  phase: Phase;
  error?: string;
  connected: boolean;
  synced: boolean;
  nodeUrl?: string;
  daaScore?: bigint;
  account?: IAccountDescriptor;
  receiveAddress?: string;
  balance?: IBalance;
  /** Current history page (newest first). */
  transactions: ITransactionRecord[];
  /** Total number of stored transaction records. */
  txTotal: number;
  /** Zero-based index of the history page held in `transactions`. */
  txPage: number;
}

export interface DagInfo {
  network: string;
  virtualDaaScore: bigint;
  headerCount: bigint;
  blockCount: bigint;
  difficulty: number;
  pastMedianTime: bigint;
}

export interface SendEstimate {
  fees: bigint;
  finalAmount?: bigint;
  transactions: number;
  utxos: number;
}

type Listener = (s: WalletState) => void;

/** Transactions per history page (same density as the old web wallet). */
export const HISTORY_PAGE_SIZE = 10;

/**
 * localStorage key of the seed phrase, encrypted with the wallet password.
 * The SDK cannot return the mnemonic (prvKeyDataGet is unimplemented in the WASM bindings),
 * so the wallet keeps its own copy to support "Backup Seed".
 */
const SEED_KEY = 'kww.seed.v1';

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export class WalletService {
  private sdk!: Sdk;
  private wallet?: Wallet;
  private listeners = new Set<Listener>();
  private historyTimer?: number;
  /** Last balance per account id; balance events can arrive before the account is in state. */
  private balances = new Map<string, IBalance>();
  state: WalletState = { phase: 'loading', connected: false, synced: false, transactions: [], txTotal: 0, txPage: 0 };

  constructor(private settings: Settings) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<WalletState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
  }

  sdkVersion(): string {
    try {
      return this.sdk.version();
    } catch {
      return '?';
    }
  }

  get sdkHandle(): Sdk {
    return this.sdk;
  }

  /** RPC client of the connected wallet (used by legacy fund recovery). */
  get rpcClient(): any {
    return (this.requireWallet() as any).rpc;
  }

  get networkId(): string {
    return this.settings.networkId;
  }

  private initPromise?: Promise<void>;

  /** Load the SDK and decide between onboarding and unlock (idempotent). */
  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      this.sdk = await loadSdk();
      this.wallet = new this.sdk.Wallet({
        resident: false, // encrypted wallet file persisted in localStorage by the SDK
        networkId: this.settings.networkId,
      });
      this.wallet.addEventListener((event: { type: string; data: any }) => this.onEvent(event));
      const exists = await this.wallet.exists(WALLET_FILENAME);
      this.set({ phase: exists ? 'locked' : 'no-wallet' });
    } catch (e) {
      this.set({ phase: 'error', error: errText(e) });
    }
  }

  generateMnemonic(words: 12 | 24 = 24): string {
    return this.sdk.Mnemonic.random(words).phrase;
  }

  validateMnemonic(phrase: string): boolean {
    return this.sdk.Mnemonic.validate(phrase.trim().toLowerCase().replace(/\s+/g, ' '));
  }

  /** Create a new wallet file from a mnemonic (used by both "create" and "restore"). */
  async createFromMnemonic(walletSecret: string, mnemonic: string): Promise<void> {
    const w = this.requireWallet();
    const phrase = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    this.set({ phase: 'opening', error: undefined });
    try {
      await w.walletCreate({
        walletSecret,
        filename: WALLET_FILENAME,
        title: 'Karlsen Web Wallet',
        overwriteWalletStorage: true,
      });
      this.storeSeed(walletSecret, phrase);
      await this.openAndStart(walletSecret, phrase);
    } catch (e) {
      this.set({ phase: 'no-wallet', error: errText(e) });
      throw e;
    }
  }

  /** Unlock the existing wallet file with the user's password. */
  async unlock(walletSecret: string): Promise<void> {
    this.set({ phase: 'opening', error: undefined });
    try {
      await this.openAndStart(walletSecret);
    } catch (e) {
      this.set({ phase: 'locked', error: errText(e) });
      throw e;
    }
  }

  private async openAndStart(walletSecret: string, mnemonic?: string): Promise<void> {
    const w = this.requireWallet();
    const sdk = this.sdk;
    await w.walletOpen({ walletSecret, filename: WALLET_FILENAME, accountDescriptors: false });
    // Modern BIP-44 account only: m/44'/121337'/0'. No legacy (972) support by design.
    await w.accountsEnsureDefault({
      walletSecret,
      type: new sdk.AccountKind('bip32'),
      ...(mnemonic ? { mnemonic } : {}),
    });
    await w.connect({ url: this.settings.nodeUrl, blockAsyncConnect: true, retryInterval: 3000 });
    this.set({ connected: true, synced: !!w.isSynced });
    await w.start();
    const { accountDescriptors } = await w.accountsEnumerate({});
    const account = accountDescriptors[0];
    if (!account) throw new Error('No account found in wallet');
    // Put the account into state before activation so the first balance event is not dropped.
    this.set({
      phase: 'ready',
      account,
      receiveAddress: account.receiveAddress?.toString(),
      nodeUrl: this.settings.nodeUrl,
    });
    // Activate only after connect() and start() have completed, otherwise the account is never scanned.
    await this.activateCurrentAccount();
    const cached = this.balances.get(String(account.accountId));
    if (cached) this.set({ balance: cached });
    void this.refreshHistory();
  }

  /** (Re)activates the current account so its addresses are scanned and subscribed. */
  private async activateCurrentAccount(): Promise<void> {
    const accountId = this.state.account?.accountId;
    if (!this.wallet || !accountId) return;
    try {
      await this.wallet.accountsActivate({ accountIds: [accountId] });
    } catch (e) {
      console.warn('accountsActivate failed', e);
    }
  }

  async lock(): Promise<void> {
    const w = this.requireWallet();
    try {
      await w.stop();
      await w.disconnect();
      await w.walletClose({});
    } catch {
      /* best effort */
    }
    this.set({
      phase: 'locked',
      account: undefined,
      balance: undefined,
      transactions: [],
      txTotal: 0,
      txPage: 0,
      receiveAddress: undefined,
      connected: false,
      synced: false,
    });
  }

  async newReceiveAddress(): Promise<string> {
    const w = this.requireWallet();
    const account = this.requireAccount();
    const { address } = await w.accountsCreateNewAddress({
      accountId: account.accountId,
      addressKind: this.sdk.NewAddressKind.Receive as unknown as string,
    });
    const addr = address.toString();
    this.set({ receiveAddress: addr });
    return addr;
  }

  validateAddress(address: string): boolean {
    try {
      return this.sdk.Address.validate(address.trim());
    } catch {
      return false;
    }
  }

  parseAmount(kls: string): bigint | undefined {
    let v = kls.trim().replace(/[\s_]/g, '');
    // "26,563.60" -> grouping commas; "12,5" (no dot, single comma) -> decimal comma
    if (v.includes('.')) v = v.replace(/,/g, '');
    else if ((v.match(/,/g) ?? []).length === 1) v = v.replace(',', '.');
    else v = v.replace(/,/g, '');
    if (!/^\d+(\.\d{1,8})?$/.test(v)) return undefined;
    // Pure bigint conversion, no floats
    const [whole, frac = ''] = v.split('.');
    return BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, '0'));
  }

  /** Machine format for input fields: no grouping separators, trailing zeros trimmed. */
  formatAmountRaw(sompi: bigint | number | string | undefined): string {
    const s = BigInt(sompi ?? 0); // balance may arrive as number/string from the SDK
    const frac = (s % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
    return frac ? `${s / 100_000_000n}.${frac}` : `${s / 100_000_000n}`;
  }

  /** Fee setting: receiverPays deducts the network fee from the sent amount (send-all). */
  private feeSetting(receiverPays: boolean) {
    return receiverPays
      ? { amount: 0n, source: (this.sdk as any).FeeSource.ReceiverPays }
      : 0n;
  }

  formatAmount(sompi: bigint | undefined): string {
    return this.sdk ? this.sdk.sompiToKarlsenString(sompi ?? 0n) : '0';
  }

  async feeRates(): Promise<IFeeRateEstimateResponse | undefined> {
    try {
      return await this.requireWallet().feeRateEstimate({});
    } catch {
      return undefined;
    }
  }

  async estimate(address: string, amount: bigint, feeRate?: number, receiverPays = false): Promise<SendEstimate> {
    const w = this.requireWallet();
    const { generatorSummary: s } = await w.accountsEstimate({
      accountId: this.requireAccount().accountId,
      destination: [{ address: address.trim(), amount }],
      priorityFeeSompi: this.feeSetting(receiverPays) as any,
      ...(feeRate ? { feeRate } : {}),
    });
    return { fees: s.fees, finalAmount: s.finalAmount, transactions: s.transactions, utxos: s.utxos };
  }

  /** Sends KLS. The password is required again for every payment. */
  async send(walletSecret: string, address: string, amount: bigint, feeRate?: number, receiverPays = false): Promise<string[]> {
    const w = this.requireWallet();
    const res = await w.accountsSend({
      walletSecret,
      accountId: this.requireAccount().accountId,
      destination: [{ address: address.trim(), amount }],
      priorityFeeSompi: this.feeSetting(receiverPays) as any,
      ...(feeRate ? { feeRate } : {}),
    });
    this.scheduleHistoryRefresh();
    return res.transactionIds;
  }

  /**
   * Bridge deposit: pays the bridge deposit address and signs the deposit
   * intent inside WASM with the key of an input address (keys never reach JS).
   * Needs the SDK built from rusty-karlsen feat/wallet-bridge-sign-message.
   */
  async bridgeDeposit(walletSecret: string, vaultAddress: string, amountSompi: bigint, solanaDestination: string, feeRate?: number): Promise<BridgeDepositResult> {
    const w = this.requireWallet() as unknown as { accountsBridgeDeposit?: (req: unknown) => Promise<BridgeDepositResult> };
    if (typeof w.accountsBridgeDeposit !== 'function') {
      throw new Error('This wallet build has no bridge support (SDK without accountsBridgeDeposit).');
    }
    const res = await w.accountsBridgeDeposit({
      walletSecret,
      accountId: this.requireAccount().accountId,
      vaultAddress,
      amountSompi,
      solanaDestination,
      // A payment with an output needs an explicit fee source; 0n = SenderPays(0).
      priorityFeeSompi: 0n,
      ...(feeRate ? { feeRate } : {}),
    });
    this.scheduleHistoryRefresh();
    return res;
  }

  /** Compounds all UTXOs of the account into a single change output. */
  async compound(walletSecret: string): Promise<string[]> {
    const w = this.requireWallet();
    const res = await w.accountsSend({
      walletSecret,
      accountId: this.requireAccount().accountId,
      // No priorityFeeSompi: a sweep (no destination) only accepts Fees::None.
      // Passing 0n is read by the SDK as Fees::SenderPays(0) and rejected.
    });
    this.scheduleHistoryRefresh();
    return res.transactionIds;
  }

  async changePassword(oldWalletSecret: string, newWalletSecret: string): Promise<void> {
    // Decrypt first so a wrong old password fails before anything is changed.
    const seed = this.hasSeedBackup() ? this.revealSeed(oldWalletSecret) : undefined;
    await this.requireWallet().walletChangeSecret({ oldWalletSecret, newWalletSecret });
    if (seed) this.storeSeed(newWalletSecret, seed);
  }

  // ------------------------------------------------------------ seed backup

  private storeSeed(walletSecret: string, mnemonic: string): void {
    try {
      localStorage.setItem(SEED_KEY, this.sdk.encryptXChaCha20Poly1305(mnemonic, walletSecret));
    } catch (e) {
      console.warn('seed backup could not be stored', e);
    }
  }

  hasSeedBackup(): boolean {
    try {
      return !!localStorage.getItem(SEED_KEY);
    } catch {
      return false;
    }
  }

  /** Decrypts the stored seed phrase; throws on a wrong password (authenticated encryption). */
  revealSeed(walletSecret: string): string {
    const blob = localStorage.getItem(SEED_KEY);
    if (!blob) throw new Error('No seed backup is stored for this wallet.');
    try {
      return this.sdk.decryptXChaCha20Poly1305(blob, walletSecret);
    } catch {
      throw new Error('Wrong password.');
    }
  }

  /** Removes the wallet file and the seed backup from this browser. */
  forgetWallet(): void {
    Object.keys(localStorage)
      .filter((k) => k.includes(WALLET_FILENAME) || k === SEED_KEY)
      .forEach((k) => localStorage.removeItem(k));
  }

  // ------------------------------------------------------------ node / debug

  async dagInfo(): Promise<DagInfo> {
    const r = await this.rpcClient.getBlockDagInfo();
    return {
      network: r.network,
      virtualDaaScore: BigInt(r.virtualDaaScore),
      headerCount: BigInt(r.headerCount),
      blockCount: BigInt(r.blockCount),
      difficulty: Number(r.difficulty),
      pastMedianTime: BigInt(r.pastMedianTime),
    };
  }

  /** Version string reported by the connected karlsend node (e.g. "3.1.1"). */
  async nodeVersion(): Promise<string> {
    const r = await this.rpcClient.getServerInfo();
    return String(r.serverVersion ?? '?');
  }

  /** All UTXOs of the account, largest first. */
  async utxos(): Promise<{ address: string; txId: string; index: number; amount: bigint; daaScore: bigint; coinbase: boolean }[]> {
    const w = this.requireWallet();
    const { utxos } = await w.accountsGetUtxos({ accountId: this.requireAccount().accountId, addresses: [] });
    return (utxos as any[])
      .map((u) => {
        const e = typeof u.toJSON === 'function' ? u.toJSON() : u;
        return {
          address: String(e.address ?? ''),
          txId: String(e.outpoint?.transactionId ?? ''),
          index: Number(e.outpoint?.index ?? 0),
          amount: BigInt(e.amount ?? 0),
          daaScore: BigInt(e.blockDaaScore ?? 0),
          coinbase: !!e.isCoinbase,
        };
      })
      .sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  }

  /** Re-scans the account addresses (the SDK extends the scan window as it finds used addresses). */
  async rescan(): Promise<void> {
    await this.activateCurrentAccount();
    this.scheduleHistoryRefresh();
  }

  /** Converts a script public key to a Karlsen address string (empty on failure). */
  addressFromScript(spk: unknown): string {
    try {
      return this.sdk.addressFromScriptPublicKey(spk as any, this.settings.networkId)?.toString() ?? '';
    } catch {
      return '';
    }
  }

  /** Encrypted wallet backup (hex). Can be restored with walletImport. */
  async exportBackup(walletSecret: string): Promise<string> {
    const { walletData } = await this.requireWallet().walletExport({
      walletSecret,
      includeTransactions: false,
    });
    return walletData;
  }

  /** Reloads the current history page. */
  refreshHistory(): Promise<void> {
    return this.loadHistoryPage(this.state.txPage);
  }

  /** Loads one history page; records come newest first from the SDK store. */
  async loadHistoryPage(page: number): Promise<void> {
    const w = this.wallet;
    const account = this.state.account;
    if (!w || !account) return;
    try {
      const start = BigInt(Math.max(0, page) * HISTORY_PAGE_SIZE);
      const res = await w.transactionsDataGet({
        accountId: account.accountId,
        networkId: this.settings.networkId,
        start,
        end: start + BigInt(HISTORY_PAGE_SIZE),
      });
      this.set({ transactions: sortNewestFirst(res.transactions), txTotal: Number(res.total), txPage: page });
    } catch {
      /* history is non-critical; keep the previous page */
    }
  }

  /** Every stored transaction record, newest first (used by the CSV export). */
  async allTransactions(): Promise<ITransactionRecord[]> {
    const w = this.requireWallet();
    const account = this.requireAccount();
    const out: ITransactionRecord[] = [];
    const chunk = 500n;
    for (let start = 0n; ; start += chunk) {
      const res = await w.transactionsDataGet({
        accountId: account.accountId,
        networkId: this.settings.networkId,
        start,
        end: start + chunk,
      });
      out.push(...res.transactions);
      if (res.transactions.length === 0 || start + chunk >= BigInt(res.total)) break;
    }
    return sortNewestFirst(out);
  }

  private scheduleHistoryRefresh() {
    window.clearTimeout(this.historyTimer);
    this.historyTimer = window.setTimeout(() => void this.refreshHistory(), 750);
  }

  private onEvent({ type, data }: { type: string; data: any }) {
    switch (type) {
      case 'connect':
        this.set({ connected: true, nodeUrl: data?.url ?? this.state.nodeUrl });
        break;
      case 'disconnect':
        this.set({ connected: false, synced: false });
        break;
      case 'sync-state':
        // Node-side sync progress; wallet.isSynced is the authoritative flag.
        this.set({ synced: !!this.wallet?.isSynced });
        break;
      case 'server-status':
        this.set({ synced: !!data?.isSynced });
        break;
      case 'daa-score-change':
        this.set({ daaScore: data?.currentDaaScore });
        break;
      case 'balance':
        if (data?.id != null && data?.balance) {
          const id = String(data.id);
          this.balances.set(id, data.balance as IBalance);
          if (id === String(this.state.account?.accountId)) {
            this.set({ balance: data.balance as IBalance });
          }
        }
        break;
      case 'pending':
      case 'maturity':
      case 'discovery':
      case 'reorg':
      case 'stasis':
        this.scheduleHistoryRefresh();
        break;
      case 'utxo-index-not-enabled':
        this.set({ error: 'The node does not have --utxoindex enabled; balances cannot be tracked.' });
        break;
      default:
        break;
    }
  }

  private requireWallet(): Wallet {
    if (!this.wallet) throw new Error('Wallet runtime not initialized');
    return this.wallet;
  }

  private requireAccount(): IAccountDescriptor {
    if (!this.state.account) throw new Error('Wallet is locked');
    return this.state.account;
  }
}

/** Human-friendly amount and direction for a transaction record. */
/** Result of Wallet.accountsBridgeDeposit (subset used by the UI). */
export interface BridgeDepositResult {
  transactionIds: string[];
  intent: {
    networkId: string;
    karlsenTxId: string;
    vaultAddress: string;
    amountSompi: bigint;
    solanaDestination: string;
    timestampMs: bigint;
  };
  intentMessage: string;
  signerAddress: unknown;
  publicKey: string;
  signature: string;
}

export function txSummary(tx: ITransactionRecord): { direction: 'in' | 'out' | 'self'; value: bigint } {
  const t = tx.data?.type as string;
  const d = tx.data?.data as any;
  if (t === 'incoming' || t === 'external' || t === 'transfer-incoming') {
    return { direction: 'in', value: (d?.value ?? d?.paymentValue ?? tx.value) as bigint };
  }
  if (t === 'outgoing' || t === 'transfer-outgoing') {
    return { direction: 'out', value: (d?.paymentValue ?? tx.value) as bigint };
  }
  return { direction: 'self', value: (d?.changeValue ?? d?.paymentValue ?? tx.value ?? 0n) as bigint };
}

function sortNewestFirst(txs: ITransactionRecord[]): ITransactionRecord[] {
  const key = (t: ITransactionRecord) => (t.unixtimeMsec != null ? BigInt(t.unixtimeMsec) : 0n) || BigInt(t.blockDaaScore ?? 0);
  return [...txs].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka === kb ? 0 : ka > kb ? -1 : 1;
  });
}
