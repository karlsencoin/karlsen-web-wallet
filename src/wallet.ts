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
  transactions: ITransactionRecord[];
}

export interface SendEstimate {
  fees: bigint;
  finalAmount?: bigint;
  transactions: number;
  utxos: number;
}

type Listener = (s: WalletState) => void;

const HISTORY_PAGE = 50n;

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
  state: WalletState = { phase: 'loading', connected: false, synced: false, transactions: [] };

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
    const v = kls.trim().replace(',', '.');
    if (!/^\d+(\.\d{1,8})?$/.test(v)) return undefined;
    return this.sdk.karlsenToSompi(v);
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

  async estimate(address: string, amount: bigint, feeRate?: number): Promise<SendEstimate> {
    const w = this.requireWallet();
    const { generatorSummary: s } = await w.accountsEstimate({
      accountId: this.requireAccount().accountId,
      destination: [{ address: address.trim(), amount }],
      priorityFeeSompi: 0n,
      ...(feeRate ? { feeRate } : {}),
    });
    return { fees: s.fees, finalAmount: s.finalAmount, transactions: s.transactions, utxos: s.utxos };
  }

  /** Sends KLS. The password is required again for every payment. */
  async send(walletSecret: string, address: string, amount: bigint, feeRate?: number): Promise<string[]> {
    const w = this.requireWallet();
    const res = await w.accountsSend({
      walletSecret,
      accountId: this.requireAccount().accountId,
      destination: [{ address: address.trim(), amount }],
      priorityFeeSompi: 0n,
      ...(feeRate ? { feeRate } : {}),
    });
    this.scheduleHistoryRefresh();
    return res.transactionIds;
  }

  /** Compounds all UTXOs of the account into a single change output. */
  async compound(walletSecret: string): Promise<string[]> {
    const w = this.requireWallet();
    const res = await w.accountsSend({
      walletSecret,
      accountId: this.requireAccount().accountId,
      priorityFeeSompi: 0n,
    });
    this.scheduleHistoryRefresh();
    return res.transactionIds;
  }

  async changePassword(oldWalletSecret: string, newWalletSecret: string): Promise<void> {
    await this.requireWallet().walletChangeSecret({ oldWalletSecret, newWalletSecret });
  }

  /** Encrypted wallet backup (hex). Can be restored with walletImport. */
  async exportBackup(walletSecret: string): Promise<string> {
    const { walletData } = await this.requireWallet().walletExport({
      walletSecret,
      includeTransactions: false,
    });
    return walletData;
  }

  async refreshHistory(): Promise<void> {
    const w = this.wallet;
    const account = this.state.account;
    if (!w || !account) return;
    try {
      const res = await w.transactionsDataGet({
        accountId: account.accountId,
        networkId: this.settings.networkId,
        start: 0n,
        end: HISTORY_PAGE,
      });
      const txs = [...res.transactions].sort((a, b) =>
        a.blockDaaScore === b.blockDaaScore ? 0 : a.blockDaaScore > b.blockDaaScore ? -1 : 1,
      );
      this.set({ transactions: txs });
    } catch {
      /* history is non-critical; keep the previous list */
    }
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
