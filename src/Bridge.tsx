// wKLS bridge dialog: KLS -> wKLS deposits (pay + signed intent), wKLS -> KLS
// withdrawals (burn signed in Phantom, payout by the bridge), and history.
import { useCallback, useEffect, useState } from 'react';
import type { TKey } from './i18n';
import type { WalletService, WalletState } from './wallet';
import { SOLANA_EXPLORER_SUFFIX } from './config';
import {
  bridgeApi,
  isSolanaAddress,
  klsToSompi,
  outboxList,
  submitWithOutbox,
  toWire,
  type BridgeStatus,
  type BurnView,
  type DepositView,
  type WireIntent,
} from './bridge';
// solana-burn pulls in @solana/web3.js; it is loaded only when a withdrawal starts.
import type { BurnProgress, TxLanding } from './solana-burn';
const loadBurn = () => import('./solana-burn');

/** Phantom's injected provider, detected without loading web3.js. */
interface PhantomLite {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
}

function phantomProvider(): PhantomLite | undefined {
  const p = (window as unknown as { phantom?: { solana?: PhantomLite } }).phantom?.solana;
  return p?.isPhantom ? p : undefined;
}

type T = (k: TKey) => string;
type Tab = 'deposit' | 'withdraw' | 'history';

const KARLSEN_TX_URL = 'https://explorer.karlsencoin.org/txs/';
const solTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${SOLANA_EXPLORER_SUFFIX}`;
const SOL_ADDR_KEY = 'kww.bridge.solana';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtKls(s: string | null | undefined): string {
  if (s == null) return '–';
  const [w, f] = s.split('.');
  return w.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
}

function rememberedSolana(): string {
  try {
    return localStorage.getItem(SOL_ADDR_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberSolana(v: string): void {
  try {
    localStorage.setItem(SOL_ADDR_KEY, v);
  } catch {
    /* not critical */
  }
}

export function BridgeDialog({ t, service, state }: { t: T; service: WalletService; state: WalletState }) {
  const [tab, setTab] = useState<Tab>('deposit');
  const [status, setStatus] = useState<BridgeStatus>();
  const [statusErr, setStatusErr] = useState<string>();

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await bridgeApi.status());
      setStatusErr(undefined);
    } catch (e) {
      setStatusErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    const id = setInterval(loadStatus, 30_000);
    return () => clearInterval(id);
  }, [loadStatus]);

  return (
    <div className="stack bridge">
      <h2>{t('bridgeTitle')}</h2>
      <p className="muted small">{t('bridgeIntro')}</p>
      <nav className="utabs">
        {(['deposit', 'withdraw', 'history'] as Tab[]).map((id) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {t(({ deposit: 'bridgeTabDeposit', withdraw: 'bridgeTabWithdraw', history: 'bridgeTabHistory' } as const)[id])}
          </button>
        ))}
      </nav>
      {statusErr && <p className="error">{t('bridgeUnreachable')}: {statusErr}</p>}
      <Outbox t={t} />
      {tab === 'deposit' && <Deposit t={t} service={service} state={state} status={status} onChange={loadStatus} />}
      {tab === 'withdraw' && <Withdraw t={t} state={state} status={status} onChange={loadStatus} />}
      {tab === 'history' && <History t={t} />}
    </div>
  );
}

// ------------------------------------------------------------------ deposit

function Deposit({ t, service, state, status, onChange }: { t: T; service: WalletService; state: WalletState; status?: BridgeStatus; onChange: () => void }) {
  const [sol, setSol] = useState(rememberedSolana());
  const [amount, setAmount] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [warn, setWarn] = useState<string>();
  const [done, setDone] = useState<{ wire: WireIntent; view?: DepositView; submitErr?: string }>();

  if (done) return <DepositTracker t={t} wire={done.wire} initial={done.view} submitErr={done.submitErr} />;

  const check = (): bigint => {
    if (!status) throw new Error(t('bridgeUnreachable'));
    if (!status.accepting) throw new Error(t('bridgeNotAccepting'));
    if (!isSolanaAddress(sol)) throw new Error(t('bridgeBadSolana'));
    const sompi = service.parseAmount(amount);
    if (!sompi || sompi <= 0n) throw new Error(t('invalidAmount'));
    if (sompi < klsToSompi(status.minDepositKls)) throw new Error(`${t('bridgeBelowMin')} ${fmtKls(status.minDepositKls)} KLS`);
    if (state.balance && sompi > state.balance.mature) throw new Error(t('bridgeNoFunds'));
    return sompi;
  };

  // Warnings that do not block: above per-tx cap -> manual review; above today's remaining cap -> queued.
  const updateWarn = (value: string) => {
    const sompi = service.parseAmount(value);
    if (!status || !sompi) return setWarn(undefined);
    if (sompi > klsToSompi(status.maxPerTxKls)) return setWarn(`${t('bridgeAboveTxCap')} (${fmtKls(status.maxPerTxKls)} KLS)`);
    if (sompi > klsToSompi(status.dailyRemainingKls)) return setWarn(`${t('bridgeAboveDaily')} (${fmtKls(status.dailyRemainingKls)} KLS)`);
    setWarn(undefined);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(undefined);
    let sompi: bigint;
    try {
      sompi = check();
    } catch (x) {
      return setErr(errText(x));
    }
    setBusy(true);
    try {
      // Re-read the deposit address right before paying: it is what gets signed.
      const fresh = await bridgeApi.status();
      if (!fresh.accepting) throw new Error(t('bridgeNotAccepting'));
      const res = await service.bridgeDeposit(pw, fresh.depositAddress, sompi, sol.trim());
      setPw('');
      rememberSolana(sol.trim());
      const wire = toWire(res);
      try {
        const view = await submitWithOutbox(wire);
        setDone({ wire, view });
      } catch (x) {
        // Payment is on chain; the intent stays in the outbox for a retry.
        setDone({ wire, submitErr: errText(x) });
      }
      onChange();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      {status && (
        <table className="bridge-kv small">
          <tbody>
            <tr><td>{t('bridgeState')}</td><td className={status.accepting ? 'ok' : 'warning'}>{status.accepting ? t('bridgeOpen') : t('bridgeClosed')}</td></tr>
            <tr><td>{t('bridgeMinimum')}</td><td>{fmtKls(status.minDepositKls)} KLS</td></tr>
            <tr><td>{t('bridgeDailyLeft')}</td><td>{fmtKls(status.dailyRemainingKls)} / {fmtKls(status.dailyCapKls)} KLS</td></tr>
            <tr><td>{t('bridgeConfirmations')}</td><td>{status.confirmations} DAA (~{Math.max(1, Math.round(status.confirmations / 60))} min)</td></tr>
            <tr><td>{t('bridgeDepositAddress')}</td><td className="txid">{status.depositAddress}</td></tr>
          </tbody>
        </table>
      )}
      <label className="small">{t('bridgeSolanaLabel')}</label>
      <input value={sol} onChange={(e) => setSol(e.target.value)} placeholder="Solana wallet (base58)" spellCheck={false} autoComplete="off" />
      {sol && !isSolanaAddress(sol) && <p className="warning small">{t('bridgeBadSolana')}</p>}
      <label className="small">{t('bridgeAmountLabel')}</label>
      <input value={amount} inputMode="decimal" onChange={(e) => { setAmount(e.target.value); updateWarn(e.target.value); }} placeholder="100000" />
      <p className="muted small">{t('available')}: {service.formatAmount(state.balance?.mature)} KLS · {t('bridgeYouReceive')}</p>
      {warn && <p className="warning small">{warn}</p>}
      <input type="password" autoComplete="current-password" placeholder={t('enterPassword')} value={pw} onChange={(e) => setPw(e.target.value)} />
      <p className="muted small">{t('bridgeCustodial')}</p>
      {err && <p className="error">{err}</p>}
      <button className="dark" type="submit" disabled={busy || !pw || !status?.accepting}>
        {busy ? t('bridgeWorking') : t('bridgeDepositButton')}
      </button>
    </form>
  );
}

function statusText(t: T, s: string): string {
  const map: Record<string, TKey> = {
    pending: 'bridgeStPending',
    ready: 'bridgeStReady',
    minted: 'bridgeStMinted',
    manual: 'bridgeStManual',
    rejected: 'bridgeStRejected',
  };
  return map[s] ? t(map[s]) : s;
}

function DepositTracker({ t, wire, initial, submitErr }: { t: T; wire: WireIntent; initial?: DepositView; submitErr?: string }) {
  const tx = wire.intent.karlsenTxId;
  const [view, setView] = useState<DepositView | undefined>(initial);
  const [err, setErr] = useState<string | undefined>(submitErr);

  useEffect(() => {
    if (view && (view.status === 'minted' || view.status === 'rejected')) return;
    const poll = async () => {
      try {
        // Not accepted yet: resend (idempotent on the daemon side), otherwise poll.
        const v = err || !view ? await submitWithOutbox(wire) : await bridgeApi.deposit(tx);
        setView(v);
        setErr(undefined);
      } catch (e) {
        setErr(errText(e));
      }
    };
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, [tx, wire, view, err]);

  return (
    <div className="stack">
      <p className="ok">{t('bridgePaid')}</p>
      <table className="bridge-kv small">
        <tbody>
          <tr><td>{t('txId')}</td><td><a className="txid" href={KARLSEN_TX_URL + tx} target="_blank" rel="noreferrer noopener">{tx}</a></td></tr>
          <tr><td>{t('bridgeSolanaLabel')}</td><td className="txid">{wire.intent.solanaDestination}</td></tr>
          <tr><td>{t('bridgeStatus')}</td><td>{view ? statusText(t, view.status) : t('bridgeStSubmitting')}</td></tr>
          {view?.note && <tr><td>{t('bridgeNote')}</td><td>{view.note}</td></tr>}
          {view?.mintSignature && (
            <tr><td>{t('bridgeMintTx')}</td><td><a className="txid" href={solTx(view.mintSignature)} target="_blank" rel="noreferrer noopener">{view.mintSignature}</a></td></tr>
          )}
        </tbody>
      </table>
      {err && <p className="warning small">{t('bridgeRetrying')}: {err}</p>}
      <p className="muted small">{t('bridgeTrackerHint')}</p>
    </div>
  );
}

/** Intents that were signed and paid but never reached the daemon. */
function Outbox({ t }: { t: T }) {
  const [items, setItems] = useState<WireIntent[]>(outboxList());
  const [msg, setMsg] = useState<string>();
  if (!items.length) return null;
  const resend = async () => {
    setMsg(undefined);
    for (const w of items) {
      try {
        await submitWithOutbox(w);
      } catch (e) {
        setMsg(errText(e));
      }
    }
    setItems(outboxList());
  };
  return (
    <div className="stack warning">
      <p className="small">{t('bridgeOutbox')} ({items.length})</p>
      <button className="dark" type="button" onClick={resend}>{t('bridgeResend')}</button>
      {msg && <p className="error small">{msg}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ withdraw

const PHANTOM_URL = 'https://phantom.app/';

function burnStatusText(t: T, s: string): string {
  const map: Record<string, TKey> = {
    pending: 'bridgeBurnStPending',
    sending: 'bridgeBurnStSending',
    paid: 'bridgeBurnStPaid',
    done: 'bridgeBurnStDone',
    refund: 'bridgeBurnStRefund',
    refunded: 'bridgeBurnStRefunded',
    manual: 'bridgeStManual',
  };
  return map[s] ? t(map[s]) : s;
}

function progressText(t: T, p?: BurnProgress): string {
  if (!p) return t('bridgeWithdrawButton');
  switch (p.step) {
    case 'preparing':
      return p.attempt > 1 ? `${t('bridgeWdPreparing')} (${p.attempt})` : t('bridgeWdPreparing');
    case 'verifying':
      return t('bridgeWdVerifying');
    case 'signing':
      return t('bridgeWdSigning');
    case 'submitted':
      return t('bridgeWdSubmitted');
  }
}

function Withdraw({ t, state, status, onChange }: { t: T; state: WalletState; status?: BridgeStatus; onChange: () => void }) {
  const [owner, setOwner] = useState<string | undefined>(() => phantomProvider()?.publicKey?.toBase58());
  const [dest, setDest] = useState(state.receiveAddress ?? '');
  const [amount, setAmount] = useState('');
  const [progress, setProgress] = useState<BurnProgress>();
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<{ burnId: number; signature: string; lastValidBlockHeight: number; amountKls: string; dest: string }>();

  // The wallet's own receive address is the natural destination; fill it once it is known.
  useEffect(() => {
    if (!dest && state.receiveAddress) setDest(state.receiveAddress);
  }, [state.receiveAddress, dest]);

  if (done) return <BurnTracker t={t} {...done} onRetry={() => setDone(undefined)} />;

  const hasPhantom = !!phantomProvider();
  const busy = !!progress && progress.step !== 'submitted';

  const connect = async () => {
    setErr(undefined);
    try {
      const p = phantomProvider();
      if (!p) throw new Error(t('bridgeWdNoPhantom'));
      // Phantom only connects from a secure context (https or localhost).
      if (!window.isSecureContext) throw new Error(t('bridgeWdInsecure'));
      // Called directly in the click handler (no await before it) so the
      // Phantom approval window is tied to the user's click.
      const pk = (await p.connect()).publicKey.toBase58();
      setOwner(pk);
      rememberSolana(pk);
    } catch (e) {
      setErr(errText(e));
    }
  };

  const check = (): bigint => {
    if (!status) throw new Error(t('bridgeUnreachable'));
    if (!status.payingOut) throw new Error(t('bridgeNotPaying'));
    if (!/^\d+(\.\d{1,8})?$/.test(amount.trim())) throw new Error(t('invalidAmount'));
    const sompi = klsToSompi(amount.trim());
    if (sompi <= 0n) throw new Error(t('invalidAmount'));
    if (sompi < klsToSompi(status.minBurnKls)) throw new Error(`${t('bridgeBelowMin')} ${fmtKls(status.minBurnKls)} wKLS`);
    if (sompi > klsToSompi(status.dailyPayoutRemainingKls)) {
      throw new Error(`${t('bridgeWdAboveDaily')} (${fmtKls(status.dailyPayoutRemainingKls)} wKLS)`);
    }
    if (!dest.trim().startsWith('karlsen:')) throw new Error(t('bridgeWdBadDest'));
    return sompi;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(undefined);
    let sompi: bigint;
    try {
      sompi = check();
    } catch (x) {
      return setErr(errText(x));
    }
    try {
      const res = await (await loadBurn()).prepareAndBurn(sompi, dest.trim(), setProgress);
      setDone({ ...res, amountKls: amount.trim(), dest: dest.trim() });
      onChange();
    } catch (x) {
      // USER_REJECTED: nothing happened, no need for a loud error.
      if ((x as { code?: string })?.code === 'USER_REJECTED') setErr(t('bridgeWdRejected'));
      else setErr(errText(x));
    } finally {
      setProgress(undefined);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      {status && (
        <table className="bridge-kv small">
          <tbody>
            <tr><td>{t('bridgeState')}</td><td className={status.payingOut ? 'ok' : 'warning'}>{status.payingOut ? t('bridgeOpen') : t('bridgeClosed')}</td></tr>
            <tr><td>{t('bridgeMinimum')}</td><td>{fmtKls(status.minBurnKls)} wKLS</td></tr>
            <tr><td>{t('bridgeDailyLeft')}</td><td>{fmtKls(status.dailyPayoutRemainingKls)} / {fmtKls(status.dailyPayoutCapKls)} KLS</td></tr>
            <tr><td>wKLS mint</td><td className="txid">{status.wklsMint ?? '–'}</td></tr>
          </tbody>
        </table>
      )}
      <p className="muted small">{t('bridgeWithdrawIntro')}</p>

      {!hasPhantom && (
        <p className="warning small">
          {t('bridgeWdNoPhantom')}{' '}
          <a href={PHANTOM_URL} target="_blank" rel="noreferrer noopener">phantom.app</a>
        </p>
      )}
      {hasPhantom && !owner && (
        <button className="dark" type="button" onClick={connect}>{t('bridgeWdConnect')}</button>
      )}
      {owner && (
        <>
          <label className="small">{t('bridgeWdFrom')}</label>
          <div className="txid small">{owner}</div>

          <label className="small">{t('bridgeWdDestLabel')}</label>
          <input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="karlsen:q…" spellCheck={false} autoComplete="off" />
          {state.receiveAddress && dest.trim() !== state.receiveAddress && (
            <p className="warning small">
              {t('bridgeWdNotOwnAddress')}{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); setDest(state.receiveAddress ?? ''); }}>{t('bridgeWdUseOwn')}</a>
            </p>
          )}

          <label className="small">{t('bridgeWdAmountLabel')}</label>
          <input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} placeholder={status ? `${t('bridgeWdMinHint')} ${fmtKls(status.minBurnKls)}` : ''} />
          <p className="muted small">{t('bridgeWdYouReceive')}</p>

          <p className="muted small">{t('bridgeWdHowItWorks')}</p>
          {err && <p className="error">{err}</p>}
          <button className="dark" type="submit" disabled={busy || !status?.payingOut}>
            {busy ? progressText(t, progress) : t('bridgeWithdrawButton')}
          </button>
        </>
      )}
      {!owner && err && <p className="error">{err}</p>}
      <p className="muted small">{t('bridgeWithdrawRefund')}</p>
    </form>
  );
}

function BurnTracker({
  t,
  burnId,
  signature,
  lastValidBlockHeight,
  amountKls,
  dest,
  onRetry,
}: {
  t: T;
  burnId: number;
  signature: string;
  lastValidBlockHeight: number;
  amountKls: string;
  dest: string;
  onRetry: () => void;
}) {
  const [view, setView] = useState<BurnView>();
  const [landing, setLanding] = useState<TxLanding>('pending');
  const [waited, setWaited] = useState(0);
  const notLanded = landing === 'expired' || landing === 'failed';

  useEffect(() => {
    if (notLanded || (view && (view.status === 'done' || view.status === 'refunded'))) return;
    const poll = async () => {
      try {
        setView(await bridgeApi.burn(String(burnId)));
        return;
      } catch {
        // 404 until Solana finalizes the burn and the daemon picks it up (~30-60 s).
      }
      try {
        setLanding(await (await loadBurn()).burnTxState(signature, lastValidBlockHeight));
      } catch {
        /* daemon unreachable: keep waiting */
      }
      setWaited((w) => w + 1);
    };
    void poll();
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, [burnId, signature, lastValidBlockHeight, view, notLanded]);

  if (notLanded) {
    return (
      <div className="stack">
        <p className="warning">{landing === 'failed' ? t('bridgeWdTxFailed') : t('bridgeWdTxExpired')}</p>
        <table className="bridge-kv small">
          <tbody>
            <tr><td>{t('bridgeBurnTx')}</td><td className="txid">{signature}</td></tr>
          </tbody>
        </table>
        <button className="dark" type="button" onClick={onRetry}>{t('bridgeWdTryAgain')}</button>
      </div>
    );
  }

  const stateText = view
    ? burnStatusText(t, view.status)
    : landing === 'pending'
      ? t('bridgeBurnStLanding')
      : t('bridgeBurnStFinalizing');

  return (
    <div className="stack">
      <p className="ok">{view || landing !== 'pending' ? t('bridgeWdSent') : t('bridgeWdSubmittedWait')}</p>
      <table className="bridge-kv small">
        <tbody>
          <tr><td>{t('bridgeWdAmountLabel')}</td><td>{fmtKls(amountKls)} wKLS</td></tr>
          <tr><td>{t('bridgeWdDestLabel')}</td><td className="txid">{dest}</td></tr>
          <tr><td>{t('bridgeBurnTx')}</td><td><a className="txid" href={solTx(signature)} target="_blank" rel="noreferrer noopener">{signature}</a></td></tr>
          <tr><td>{t('bridgeStatus')}</td><td>{stateText}</td></tr>
          {view?.note && <tr><td>{t('bridgeNote')}</td><td>{view.note}</td></tr>}
          {view?.payoutTxId && (
            <tr><td>{t('bridgePayoutTx')}</td><td><a className="txid" href={KARLSEN_TX_URL + view.payoutTxId} target="_blank" rel="noreferrer noopener">{view.payoutTxId}</a></td></tr>
          )}
        </tbody>
      </table>
      {!view && waited >= 18 && <p className="warning small">{t('bridgeWdSlow')}</p>}
      <p className="muted small">{t('bridgeTrackerHint')}</p>
    </div>
  );
}

// ------------------------------------------------------------------ history

function History({ t }: { t: T }) {
  const [sol, setSol] = useState(rememberedSolana());
  const [deps, setDeps] = useState<DepositView[]>();
  const [burns, setBurns] = useState<BurnView[]>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setErr(undefined);
    if (!isSolanaAddress(sol)) return setErr(t('bridgeBadSolana'));
    setBusy(true);
    try {
      const [d, b] = await Promise.all([bridgeApi.deposits(sol.trim()), bridgeApi.burns(sol.trim())]);
      setDeps(d);
      setBurns(b);
      rememberSolana(sol.trim());
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const when = (ms: number) => new Date(ms).toLocaleString();
  return (
    <div className="stack">
      <label className="small">{t('bridgeSolanaLabel')}</label>
      <div className="row">
        <input value={sol} onChange={(e) => setSol(e.target.value)} spellCheck={false} />
        <button className="dark fit" onClick={load} disabled={busy}>{t('bridgeShow')}</button>
      </div>
      {err && <p className="error">{err}</p>}
      {deps && (
        <>
          <h4>{t('bridgeDeposits')}</h4>
          {!deps.length && <p className="muted small">{t('bridgeNone')}</p>}
          {deps.map((d) => (
            <div key={d.karlsenTxId} className="bridge-item small">
              <b>{fmtKls(d.amountKls)} KLS</b> · {statusText(t, d.status)} · {when(d.receivedAtMs)}
              <br />
              <a className="txid" href={KARLSEN_TX_URL + d.karlsenTxId} target="_blank" rel="noreferrer noopener">{d.karlsenTxId}</a>
              {d.mintSignature && (<><br /><a className="txid" href={solTx(d.mintSignature)} target="_blank" rel="noreferrer noopener">{d.mintSignature}</a></>)}
              {d.note && <><br /><span className="muted">{d.note}</span></>}
            </div>
          ))}
        </>
      )}
      {burns && (
        <>
          <h4>{t('bridgeBurns')}</h4>
          {!burns.length && <p className="muted small">{t('bridgeNone')}</p>}
          {burns.map((b) => (
            <div key={b.burnId} className="bridge-item small">
              <b>{fmtKls(b.amountKls)} wKLS</b> → {b.destination} · {burnStatusText(t, b.status)} · {when(b.detectedAtMs)}
              {b.payoutTxId && (<><br /><a className="txid" href={KARLSEN_TX_URL + b.payoutTxId} target="_blank" rel="noreferrer noopener">{b.payoutTxId}</a> ({fmtKls(b.paidKls)} KLS)</>)}
              {b.note && <><br /><span className="muted">{b.note}</span></>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
