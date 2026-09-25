// Main wallet screen in the classic layout of the old wallet.karlsencoin.org PWA:
// left column = balance, receive address, QR, SEND / Scan QR, status;
// right column = TRANSACTIONS / WALLET / NETWORK / DEBUG tabs.
import { copyText } from './clipboard';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { ITransactionRecord } from './karlsen-sdk';
import { HISTORY_PAGE_SIZE, txSummary, type DagInfo, type WalletService, type WalletState } from './wallet';
import { APP_VERSION, DONATION_ADDRESS, FEATURES, LANGUAGES, saveSettings, type Settings } from './config';
import type { TKey } from './i18n';
import { LegacyMigrate } from './LegacyMigrate';
import { BridgeDialog } from './Bridge';

// Karlsen explorer is a kaspa-explorer fork: /txs/<id>.
export const EXPLORER_TX_URL = 'https://explorer.karlsencoin.org/txs/';

type T = (k: TKey) => string;
type RightTab = 'transactions' | 'wallet' | 'network' | 'debug';
type Dialog =
  | { kind: 'send'; to?: string; amount?: string }
  | { kind: 'scan' }
  | { kind: 'compound' }
  | { kind: 'seed' }
  | { kind: 'export' }
  | { kind: 'utxos' }
  | { kind: 'legacy' }
  | { kind: 'settings' }
  | { kind: 'bridge' };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------- main

export function Main({ t, service, state, settings }: { t: T; service: WalletService; state: WalletState; settings: Settings }) {
  const [tab, setTab] = useState<RightTab>('transactions');
  const [dialog, setDialog] = useState<Dialog>();
  const close = () => setDialog(undefined);

  return (
    <div className="classic">
      <section className="left">
        <BalanceBlock t={t} service={service} state={state} />
        <ReceiveBlock t={t} address={state.receiveAddress} />
        <div className="actions">
          <button className="dark" onClick={() => setDialog({ kind: 'send' })}>{t('sendButton')}</button>
          <button className="dark" onClick={() => setDialog({ kind: 'scan' })}>{t('scanQr')}</button>
        </div>
        <StatusBlock t={t} state={state} />
      </section>

      <section className="right">
        <nav className="utabs">
          {(['transactions', 'wallet', 'network', 'debug'] as RightTab[]).map((id) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {t(({ transactions: 'tabTransactions', wallet: 'tabWalletInfo', network: 'tabNetwork', debug: 'tabDebug' } as const)[id])}
            </button>
          ))}
        </nav>
        {state.error && <p className="error">{state.error}</p>}
        <div className="tabbody">
          {tab === 'transactions' && <Transactions t={t} service={service} state={state} />}
          {tab === 'wallet' && <WalletInfo t={t} service={service} state={state} settings={settings} open={setDialog} />}
          {tab === 'network' && <NetworkInfo t={t} service={service} />}
          {tab === 'debug' && <DebugInfo t={t} service={service} state={state} open={setDialog} />}
        </div>
      </section>

      {dialog && (
        <Modal onClose={close} t={t} wide={dialog.kind === 'legacy' || dialog.kind === 'utxos' || dialog.kind === 'bridge'}>
          {dialog.kind === 'send' && <Send t={t} service={service} state={state} initialTo={dialog.to} initialAmount={dialog.amount} onDone={close} />}
          {dialog.kind === 'scan' && <QrScan t={t} onResult={(to, amount) => setDialog({ kind: 'send', to, amount })} />}
          {dialog.kind === 'compound' && <CompoundDialog t={t} service={service} />}
          {dialog.kind === 'seed' && <SeedBackupDialog t={t} service={service} />}
          {dialog.kind === 'export' && <ExportDialog t={t} service={service} />}
          {dialog.kind === 'utxos' && <UtxoList t={t} service={service} />}
          {dialog.kind === 'legacy' && <LegacyMigrate t={t} service={service} state={state} />}
          {dialog.kind === 'settings' && <SettingsView t={t} service={service} settings={settings} />}
          {dialog.kind === 'bridge' && <BridgeDialog t={t} service={service} state={state} />}
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- left column

function BalanceBlock({ t, service, state }: { t: T; service: WalletService; state: WalletState }) {
  const b = state.balance;
  return (
    <div className="balance">
      <div className="label">{t('available')}</div>
      <div className="big">{service.formatAmount(b?.mature)} KLS</div>
      <div className="label small">{t('pendingShort')}</div>
      <div>{service.formatAmount(b?.pending)} KLS</div>
    </div>
  );
}

function ReceiveBlock({ t, address }: { t: T; address?: string }) {
  const [qr, setQr] = useState<string>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!address) return;
    QRCode.toDataURL(address, { margin: 1, width: 180 }).then(setQr).catch(() => setQr(undefined));
  }, [address]);
  if (!address) return null;
  const copy = async () => {
    if (!(await copyText(address))) window.prompt(t('copy'), address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="receive">
      <div className="label">{t('receiveAddressLabel')}</div>
      <div className="addr">
        <code>{address}</code>
        <button className="icon" title={t('copy')} onClick={copy}>{copied ? '✓' : <CopyIcon />}</button>
      </div>
      {qr && <img className="qr" src={qr} alt="QR" width={140} height={140} />}
    </div>
  );
}

function StatusBlock({ t, state }: { t: T; state: WalletState }) {
  const status = !state.connected ? t('statusOffline') : state.synced ? t('statusOnline') : t('statusSyncing');
  return (
    <div className="walletstatus small">
      <div>{t('walletStatus')}: <span className={state.connected ? (state.synced ? 'okc' : 'warnc') : 'badc'}>{status}</span></div>
      <div>{t('daaScore')}: {state.daaScore != null ? Number(state.daaScore).toLocaleString('en-US') : '—'}</div>
    </div>
  );
}

// ---------------------------------------------------------------- transactions

interface TxView {
  direction: 'in' | 'out' | 'self';
  value: bigint;
  label: string;
  counterparty: string;
}

/** Direction, amount and "LABEL => address" line of a record, like the old wallet list. */
function describeTx(t: T, service: WalletService, tx: ITransactionRecord): TxView {
  const s = txSummary(tx);
  const d = tx.data?.data as any;
  const kind = tx.data?.type as string;
  let counterparty = '';
  try {
    if (s.direction === 'in') {
      const e = d?.utxoEntries?.[0];
      counterparty = e?.address ? String(e.address) : '';
    } else {
      const out = d?.transaction?.outputs?.[0];
      if (out?.scriptPublicKey) counterparty = service.addressFromScript(out.scriptPublicKey);
    }
  } catch {
    /* counterparty is cosmetic */
  }
  const label =
    kind === 'batch' || kind === 'change' || s.direction === 'self'
      ? t('compoundingWallet')
      : s.direction === 'in'
        ? t('receivedTo')
        : t('sentTo');
  return { direction: s.direction, value: s.value, label, counterparty };
}

function fmtTime(tx: ITransactionRecord): string {
  if (!tx.unixtimeMsec) return `DAA ${tx.blockDaaScore}`;
  const d = new Date(Number(tx.unixtimeMsec));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function Transactions({ t, service, state }: { t: T; service: WalletService; state: WalletState }) {
  const pages = Math.max(1, Math.ceil(state.txTotal / HISTORY_PAGE_SIZE));
  const page = Math.min(state.txPage, pages - 1);
  const go = (p: number) => void service.loadHistoryPage(Math.max(0, Math.min(pages - 1, p)));

  // Page buttons: a window of 10 around the current page, as in the old wallet.
  const from = Math.max(0, Math.min(page - 4, pages - 10));
  const nums = Array.from({ length: Math.min(10, pages) }, (_, i) => from + i);

  return (
    <div className="txlist">
      {state.transactions.length === 0 && <p className="muted center">{t('historyEmpty')}</p>}
      <ul>
        {state.transactions.map((tx) => {
          const v = describeTx(t, service, tx);
          const sign = v.direction === 'out' ? '-' : v.direction === 'in' ? '+' : '';
          return (
            <li key={tx.id}>
              <span className={`arrow ${v.direction}`}>{v.direction === 'in' ? '⇤' : '⇥'}</span>
              <div className="txmain">
                <div className="txhead">
                  <span>{fmtTime(tx)}</span>
                  <span className={`amt ${v.direction}`}>{sign}{service.formatAmount(v.value)} KLS</span>
                </div>
                <a className="txid" href={EXPLORER_TX_URL + tx.id} target="_blank" rel="noreferrer noopener" title={t('explorer')}>{tx.id}</a>
                <div className="txnote">{v.label}{v.counterparty ? ' =>' : ''}</div>
                {v.counterparty && <div className="txaddr">{v.counterparty}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      {pages > 1 && (
        <div className="pager">
          <button disabled={page === 0} onClick={() => go(0)}>{t('pageFirst')}</button>
          <button disabled={page === 0} onClick={() => go(page - 1)}>&lt;</button>
          {nums.map((n) => (
            <button key={n} className={n === page ? 'active' : ''} onClick={() => go(n)}>{n + 1}</button>
          ))}
          <button disabled={page >= pages - 1} onClick={() => go(page + 1)}>&gt;</button>
          <button disabled={page >= pages - 1} onClick={() => go(pages - 1)}>{t('pageLast')}</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- wallet tab

function WalletInfo({
  t,
  service,
  state,
  settings,
  open,
}: {
  t: T;
  service: WalletService;
  state: WalletState;
  settings: Settings;
  open: (d: Dialog) => void;
}) {
  const [msg, setMsg] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [nodeVersion, setNodeVersion] = useState<string>();
  useEffect(() => {
    service.nodeVersion().then(setNodeVersion).catch(() => setNodeVersion(undefined));
  }, [service, state.connected]);

  const run = async (fn: () => Promise<string | void>) => {
    setMsg(undefined);
    setErr(undefined);
    setBusy(true);
    try {
      const r = await fn();
      if (r) setMsg(r);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () =>
    run(async () => {
      const txs = await service.allTransactions();
      const rows = [['date', 'type', 'direction', 'amount_kls', 'transaction_id', 'address', 'daa_score']];
      for (const tx of txs) {
        const v = describeTx(t, service, tx);
        const sign = v.direction === 'out' ? '-' : '';
        rows.push([fmtTime(tx), String(tx.data?.type ?? ''), v.direction, sign + service.formatAmount(v.value), tx.id, v.counterparty, String(tx.blockDaaScore)]);
      }
      const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      download(`karlsen-transactions-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv');
      return `${txs.length} ✓`;
    });

  const recover = () => {
    if (prompt(t('recoverConfirm')) !== 'DELETE') return;
    void service.lock().finally(() => {
      service.forgetWallet();
      location.reload();
    });
  };

  const status = !state.connected ? t('statusOffline') : state.synced ? t('statusOnline') : t('statusSyncing');

  return (
    <div className="walletinfo">
      <div className="info">
        <b>{t('walletHeading')}</b>
        <div>{t('version')} {APP_VERSION}</div>
        <div>{t('status')}: {status}</div>
        <div>{t('network')}: karlsen-{settings.networkId}</div>
      </div>
      <div className="btncol">
        <button className="dark" disabled={busy} onClick={() => open({ kind: 'compound' })}>{t('compoundTx')}</button>
        <button className="dark" disabled={busy} onClick={exportCsv}>{t('exportCsv')}</button>
        <button className="dark" disabled={busy} onClick={() => run(async () => { await service.refreshHistory(); return t('done'); })}>{t('updateTimes')}</button>
        <button className="dark" onClick={() => open({ kind: 'seed' })}>{t('backupSeed')}</button>
        <button className="dark" onClick={recover}>{t('recoverFromSeed')}</button>
        <button className="dark" onClick={() => open({ kind: 'export' })}>{t('exportWalletFile')}</button>
        <button className="dark" onClick={() => open({ kind: 'legacy' })}>{t('tabLegacy')}</button>
        {FEATURES.bridge && <button className="dark" onClick={() => open({ kind: 'bridge' })}>{t('tabBridge')}</button>}
        <button className="dark" onClick={() => open({ kind: 'settings' })}>{t('openSettings')}</button>
      </div>
      {msg && <p className="ok center">{msg}</p>}
      {err && <p className="error center">{err}</p>}

      {DONATION_ADDRESS && (
        <details>
          <summary>{t('donations')}</summary>
          <code className="small">{DONATION_ADDRESS}</code>
        </details>
      )}
      <details>
        <summary>{t('developerInfo')}</summary>
        <div className="small devinfo">
          <div>Karlsen Web Wallet: {APP_VERSION}</div>
          <div>Rusty Karlsen WASM SDK: {service.sdkVersion()}</div>
          <div>{t('nodeVersion')}: {nodeVersion ?? '—'}</div>
          <div>{t('nodeUrl')}: {state.nodeUrl}</div>
          <div>{t('network')}: {settings.networkId}</div>
          <div>React: 18 · Vite: 5</div>
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- network tab

function NetworkInfo({ t, service }: { t: T; service: WalletService }) {
  const [info, setInfo] = useState<DagInfo>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const i = await service.dagInfo();
        if (alive) {
          setInfo(i);
          setErr(undefined);
        }
      } catch (e) {
        if (alive) setErr(errText(e));
      }
    };
    void poll();
    const id = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [service]);

  const n = (v?: bigint | number) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
  const median = info ? new Date(Number(info.pastMedianTime)) : undefined;
  const offsetSec = median ? Math.max(0, Math.round((Date.now() - median.getTime()) / 1000)) : undefined;
  const hms = (s: number) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, '0')).join(':');

  return (
    <div className="kv">
      <h4>{t('networkStatus')}</h4>
      {err && <p className="error">{err}</p>}
      <table>
        <tbody>
          <tr><td>{t('network')}</td><td>{info?.network ?? '—'}</td></tr>
          <tr><td>{t('daaScore')}</td><td>{n(info?.virtualDaaScore)}</td></tr>
          <tr><td>{t('dagHeader')}</td><td>{n(info?.headerCount)}</td></tr>
          <tr><td>{t('dagBlocks')}</td><td>{n(info?.blockCount)}</td></tr>
          <tr><td>{t('difficulty')}</td><td>{info ? info.difficulty.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</td></tr>
          <tr><td>{t('medianOffset')}</td><td>{offsetSec != null ? hms(offsetSec) : '—'}</td></tr>
          <tr><td>{t('medianTimeUtc')}</td><td>{median ? median.toISOString().replace('T', ' ').slice(0, 19) : '—'}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- debug tab

function DebugInfo({ t, service, state, open }: { t: T; service: WalletService; state: WalletState; open: (d: Dialog) => void }) {
  const [msg, setMsg] = useState<string>();
  const b = state.balance;
  const count = b ? b.matureUtxoCount + b.pendingUtxoCount : 0;
  return (
    <div className="kv">
      <h4>{t('inUseUtxos')}</h4>
      <table>
        <tbody>
          <tr><td>{t('countLabel')}</td><td>{count}</td></tr>
          <tr><td>{t('amountLabel')}</td><td>{service.formatAmount((b?.mature ?? 0n) + (b?.pending ?? 0n))} KLS</td></tr>
          <tr><td>{t('balanceOutgoing')}</td><td>{service.formatAmount(b?.outgoing)} KLS</td></tr>
        </tbody>
      </table>
      <div className="btncol">
        <button className="dark" onClick={() => open({ kind: 'utxos' })}>{t('showUtxos')}</button>
        <button className="dark" onClick={() => { setMsg(undefined); void service.refreshHistory().then(() => setMsg(t('done'))); }}>{t('forceTimes')}</button>
        <button className="dark" onClick={() => { setMsg(undefined); void service.rescan().then(() => setMsg(t('scanMoreDone'))); }}>{t('scanMore')}</button>
      </div>
      {msg && <p className="ok center">{msg}</p>}
    </div>
  );
}

function UtxoList({ t, service }: { t: T; service: WalletService }) {
  const [rows, setRows] = useState<Awaited<ReturnType<WalletService['utxos']>>>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    service.utxos().then(setRows).catch((e) => setErr(errText(e)));
  }, [service]);
  return (
    <div className="stack">
      <h2>{t('utxoTitle')} {rows ? `(${rows.length})` : ''}</h2>
      {err && <p className="error">{err}</p>}
      {!rows && !err && <p className="muted">…</p>}
      {rows && (
        <div className="utxos">
          {rows.map((u) => (
            <div key={`${u.txId}:${u.index}`} className="utxo">
              <div className="row between">
                <b>{service.formatAmount(u.amount)} KLS</b>
                <span className="muted small">DAA {u.daaScore.toString()}{u.coinbase ? ` · ${t('coinbase')}` : ''}</span>
              </div>
              <a className="small txid" href={EXPLORER_TX_URL + u.txId} target="_blank" rel="noreferrer noopener">{u.txId}:{u.index}</a>
              <div className="small muted txaddr">{u.address}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

function Modal({ children, onClose, t, wide }: { children: React.ReactNode; onClose: () => void; t: T; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <button className="icon closebtn" title={t('close')} onClick={onClose}>✕</button>
        {children}
      </div>
    </div>
  );
}

/** Password-gated action used by compound, seed backup and file export. */
function PasswordAction({
  t,
  title,
  text,
  action,
  onRun,
}: {
  t: T;
  title: string;
  text?: string;
  action: string;
  onRun: (pw: string) => Promise<React.ReactNode>;
}) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [result, setResult] = useState<React.ReactNode>();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(undefined);
    try {
      setResult(await onRun(pw));
      setPw('');
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  };
  if (result) return <div className="stack"><h2>{title}</h2>{result}</div>;
  return (
    <form className="stack" onSubmit={submit}>
      <h2>{title}</h2>
      {text && <p className="muted">{text}</p>}
      <input type="password" autoFocus autoComplete="current-password" placeholder={t('enterPassword')} value={pw} onChange={(e) => setPw(e.target.value)} />
      {err && <p className="error">{err}</p>}
      <button className="dark" type="submit" disabled={busy || !pw}>{action}</button>
    </form>
  );
}

function TxLinks({ t, ids }: { t: T; ids: string[] }) {
  return (
    <div className="stack">
      <p className="ok">{t('sent')}</p>
      {ids.map((id) => (
        <a key={id} className="txid small" href={EXPLORER_TX_URL + id} target="_blank" rel="noreferrer noopener">{id}</a>
      ))}
    </div>
  );
}

function CompoundDialog({ t, service }: { t: T; service: WalletService }) {
  return (
    <PasswordAction t={t} title={t('compoundTx')} text={t('compoundConfirmText')} action={t('compoundTx')}
      onRun={async (pw) => <TxLinks t={t} ids={await service.compound(pw)} />} />
  );
}

function SeedBackupDialog({ t, service }: { t: T; service: WalletService }) {
  if (!service.hasSeedBackup()) {
    return <div className="stack"><h2>{t('backupSeed')}</h2><p className="warning">{t('backupSeedMissing')}</p></div>;
  }
  return (
    <PasswordAction t={t} title={t('backupSeed')} text={t('backupSeedText')} action={t('backupSeed')}
      onRun={async (pw) => {
        const words = service.revealSeed(pw).split(' ');
        return (
          <>
            <p className="warning">{t('seedWarning')}</p>
            <ol className="seed">{words.map((w, i) => <li key={i}><span>{i + 1}.</span> {w}</li>)}</ol>
          </>
        );
      }} />
  );
}

function ExportDialog({ t, service }: { t: T; service: WalletService }) {
  return (
    <PasswordAction t={t} title={t('exportWalletFile')} text={t('exportText')} action={t('exportWalletFile')}
      onRun={async (pw) => {
        const hex = await service.exportBackup(pw);
        download(`karlsen-wallet-backup-${new Date().toISOString().slice(0, 10)}.kwb`, hex, 'text/plain');
        return <p className="ok">{t('done')}</p>;
      }} />
  );
}

function download(name: string, content: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- QR scan

/** Parses "karlsen:addr?amount=1.5" style payloads. */
function parseQr(raw: string): { to: string; amount?: string } {
  const text = raw.trim();
  const [addr, query] = text.split('?');
  const amount = query ? new URLSearchParams(query).get('amount') ?? undefined : undefined;
  return { to: addr, amount };
}

function QrScan({ t, onResult }: { t: T; onResult: (to: string, amount?: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    const Detector = (window as any).BarcodeDetector;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !Detector) {
      setErr(t('qrUnsupported'));
      return;
    }
    let stream: MediaStream | undefined;
    let timer: number | undefined;
    let stopped = false;
    const detector = new Detector({ formats: ['qr_code'] });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then(async (s) => {
        stream = s;
        if (stopped || !video.current) return;
        video.current.srcObject = s;
        await video.current.play();
        const tick = async () => {
          if (stopped || !video.current) return;
          try {
            const codes = await detector.detect(video.current);
            if (codes[0]?.rawValue) {
              const r = parseQr(codes[0].rawValue);
              onResult(r.to, r.amount);
              return;
            }
          } catch {
            /* keep scanning */
          }
          timer = window.setTimeout(tick, 300);
        };
        void tick();
      })
      .catch((e) => setErr(errText(e)));
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [t, onResult]);
  return (
    <div className="stack center">
      <h2>{t('scanQr')}</h2>
      {err ? <p className="warning">{err}</p> : <p className="muted">{t('qrPoint')}</p>}
      {!err && <video ref={video} className="qrvideo" muted playsInline />}
    </div>
  );
}

// ---------------------------------------------------------------- send

type FeeLevel = 'low' | 'normal' | 'priority';

function Send({
  t,
  service,
  state,
  initialTo,
  initialAmount,
  onDone,
}: {
  t: T;
  service: WalletService;
  state: WalletState;
  initialTo?: string;
  initialAmount?: string;
  onDone: () => void;
}) {
  const [to, setTo] = useState(initialTo ?? '');
  const [amount, setAmount] = useState(initialAmount ?? '');
  const [fee, setFee] = useState<FeeLevel>('normal');
  const [rates, setRates] = useState<Record<FeeLevel, number>>();
  const [est, setEst] = useState<Awaited<ReturnType<WalletService['estimate']>>>();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string[]>();

  useEffect(() => {
    void service.feeRates().then((r) => {
      if (r) setRates({ low: r.low.feeRate, normal: r.normal.feeRate, priority: r.priority.feeRate });
    });
  }, [service]);

  const parsed = () => {
    if (!service.validateAddress(to)) throw new Error(t('invalidAddress'));
    const sompi = service.parseAmount(amount);
    if (!sompi || sompi <= 0n) throw new Error(t('invalidAmount'));
    return sompi;
  };

  const wrap = async (fn: () => Promise<void>) => {
    setErr(undefined);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="stack">
        <TxLinks t={t} ids={result} />
        <button className="dark" onClick={onDone}>{t('close')}</button>
      </div>
    );
  }

  return (
    <div className="stack">
      <h2>{t('sendTitle')}</h2>
      <label>{t('recipient')}<input spellCheck={false} autoComplete="off" value={to} onChange={(e) => { setTo(e.target.value); setEst(undefined); }} /></label>
      <label>{t('amount')}
        <div className="row">
          <input inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setEst(undefined); }} />
          <button type="button" className="fit" onClick={() => { setAmount(service.formatAmount(state.balance?.mature)); setEst(undefined); }}>{t('max')}</button>
        </div>
      </label>
      <label>{t('feePriority')}
        <select value={fee} onChange={(e) => { setFee(e.target.value as FeeLevel); setEst(undefined); }}>
          <option value="low">{t('feeLow')}</option>
          <option value="normal">{t('feeNormal')}</option>
          <option value="priority">{t('feeHigh')}</option>
        </select>
      </label>
      {!est && (
        <button className="dark" disabled={busy || !to || !amount} onClick={() => wrap(async () => setEst(await service.estimate(to, parsed(), rates?.[fee])))}>
          {t('review')}
        </button>
      )}
      {est && (
        <div className="review">
          <p>{t('networkFee')}: <b>{service.formatAmount(est.fees)} KLS</b></p>
          {est.finalAmount !== undefined && <p>{t('totalDeducted')}: <b>{service.formatAmount(est.finalAmount + est.fees)} KLS</b></p>}
          <p>{t('txCount')}: {est.transactions}</p>
          <p className="muted small">{t('sendPasswordText')}</p>
          <input type="password" autoComplete="current-password" placeholder={t('password')} value={pw} onChange={(e) => setPw(e.target.value)} />
          <div className="row">
            <button onClick={() => setEst(undefined)} disabled={busy}>{t('cancel')}</button>
            <button className="dark" disabled={busy || !pw}
              onClick={() => wrap(async () => { setResult(await service.send(pw, to, parsed(), rates?.[fee])); setPw(''); setEst(undefined); })}>
              {t('confirmSend')}
            </button>
          </div>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- settings

function SettingsView({ t, service, settings }: { t: T; service: WalletService; settings: Settings }) {
  const [s, setS] = useState(settings);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [msg, setMsg] = useState<string>();
  const [err, setErr] = useState<string>();

  return (
    <div className="stack">
      <h2>{t('settingsTitle')}</h2>
      <label>{t('nodeUrl')}<input spellCheck={false} value={s.nodeUrl} onChange={(e) => setS({ ...s, nodeUrl: e.target.value })} /></label>
      <p className="muted small">{t('nodeUrlHelp')}</p>
      <label>{t('network')}
        <select value={s.networkId} onChange={(e) => setS({ ...s, networkId: e.target.value as Settings['networkId'] })}>
          <option value="mainnet">mainnet</option>
          <option value="testnet-10">testnet-10</option>
          <option value="testnet-11">testnet-11</option>
        </select>
      </label>
      <label>{t('language')}
        <select value={s.lang} onChange={(e) => setS({ ...s, lang: e.target.value as Settings['lang'] })}>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
      </label>
      <button className="dark" onClick={() => { saveSettings(s); location.reload(); }}>{t('save')}</button>

      <hr />
      <h3>{t('changePassword')}</h3>
      <input type="password" autoComplete="current-password" placeholder={t('currentPassword')} value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
      <input type="password" autoComplete="new-password" placeholder={t('newPassword')} value={newPw} onChange={(e) => setNewPw(e.target.value)} />
      <button
        className="dark"
        disabled={!oldPw || newPw.length < 8}
        onClick={async () => {
          setMsg(undefined);
          setErr(undefined);
          try {
            await service.changePassword(oldPw, newPw);
            setOldPw('');
            setNewPw('');
            setMsg(t('passwordChanged'));
          } catch (e) {
            setErr(errText(e));
          }
        }}
      >{t('changePassword')}</button>
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- icons

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}
