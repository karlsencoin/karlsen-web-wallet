import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { WalletService, txSummary, type WalletState, type SendEstimate } from './wallet';
import { FEATURES, WALLET_FILENAME, loadSettings, saveSettings, type Settings } from './config';
import { translator, type TKey } from './i18n';
import { LANGUAGES } from './config';
import { SeedGrid } from './SeedGrid';
import { LegacyMigrate } from './LegacyMigrate';

// Explorer base for transaction links (Karlsen explorer is a kaspa-explorer fork: /txs/<id>).
const EXPLORER_TX_URL = 'https://explorer.karlsencoin.org/txs/';

type T = (k: TKey) => string;
type Tab = 'wallet' | 'send' | 'receive' | 'history' | 'bridge' | 'legacy' | 'settings';

export default function App() {
  const [settings] = useState<Settings>(loadSettings);
  const service = useMemo(() => new WalletService(settings), [settings]);
  const [state, setState] = useState<WalletState>(service.state);
  const t = useMemo(() => translator(settings.lang), [settings.lang]);

  useEffect(() => {
    const off = service.subscribe(setState);
    void service.init();
    return off;
  }, [service]);

  let body: JSX.Element;
  switch (state.phase) {
    case 'loading':
      body = <Centered>{t('loadingSdk')}</Centered>;
      break;
    case 'error':
      body = (
        <Centered>
          <h2>{t('fatalError')}</h2>
          <pre className="error">{state.error}</pre>
        </Centered>
      );
      break;
    case 'no-wallet':
      body = <Onboarding t={t} service={service} error={state.error} />;
      break;
    case 'locked':
      body = <Unlock t={t} service={service} error={state.error} lang={settings.lang} />;
      break;
    case 'opening':
      body = <Centered>{t('opening')}</Centered>;
      break;
    case 'ready':
      body = <Main t={t} service={service} state={state} settings={settings} />;
      break;
  }

  return (
    <div className="app">
      <header className="topbar">
        <img src="/karlsen.svg" alt="" width={28} height={28} />
        <span className="brand">{t('appTitle')}</span>
        {state.phase === 'ready' && <NodeStatus t={t} state={state} />}
      </header>
      <main>{body}</main>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="centered card">{children}</div>;
}

function NodeStatus({ t, state }: { t: T; state: WalletState }) {
  const cls = state.connected ? (state.synced ? 'ok' : 'warn') : 'bad';
  const label = state.connected
    ? `${t('nodeConnected')} · ${state.synced ? t('nodeSynced') : t('nodeSyncing')}`
    : t('nodeDisconnected');
  return (
    <span className={`status ${cls}`} title={state.nodeUrl}>
      ● {label}
    </span>
  );
}

// ---------------------------------------------------------------- onboarding

function Onboarding({ t, service, error }: { t: T; service: WalletService; error?: string }) {
  const [step, setStep] = useState<'choose' | 'show' | 'confirm' | 'restore' | 'password'>('choose');
  const [mnemonic, setMnemonic] = useState('');

  if (step === 'choose') {
    return (
      <div className="card narrow">
        <h1>{t('welcome')}</h1>
        <p>{t('welcomeText')}</p>
        {error && <p className="error">{error}</p>}
        <button className="primary" onClick={() => { setMnemonic(service.generateMnemonic(24)); setStep('show'); }}>
          {t('createWallet')}
        </button>
        <button onClick={() => setStep('restore')}>{t('restoreWallet')}</button>
      </div>
    );
  }

  if (step === 'show') {
    return (
      <div className="card narrow">
        <h2>{t('seedTitle')}</h2>
        <p className="warning">{t('seedWarning')}</p>
        <ol className="seed">
          {mnemonic.split(' ').map((w, i) => (
            <li key={i}><span>{i + 1}.</span> {w}</li>
          ))}
        </ol>
        <div className="row">
          <button onClick={() => setStep('choose')}>{t('back')}</button>
          <button className="primary" onClick={() => setStep('confirm')}>{t('seedWritten')}</button>
        </div>
      </div>
    );
  }

  if (step === 'confirm') {
    return <SeedConfirm t={t} mnemonic={mnemonic} onBack={() => setStep('show')} onOk={() => setStep('password')} />;
  }

  if (step === 'restore') {
    return (
      <RestoreForm
        t={t}
        service={service}
        onBack={() => setStep('choose')}
        onOk={(m) => { setMnemonic(m); setStep('password'); }}
      />
    );
  }

  return (
    <PasswordForm
      t={t}
      onBack={() => setStep('choose')}
      onSubmit={(pw) => service.createFromMnemonic(pw, mnemonic)}
    />
  );
}

function SeedConfirm({ t, mnemonic, onBack, onOk }: { t: T; mnemonic: string; onBack: () => void; onOk: () => void }) {
  const words = mnemonic.split(' ');
  const [positions] = useState(() => {
    const set = new Set<number>();
    const rnd = new Uint32Array(8);
    crypto.getRandomValues(rnd);
    for (const r of rnd) {
      set.add(r % words.length);
      if (set.size === 3) break;
    }
    return [...set].sort((a, b) => a - b);
  });
  const [answers, setAnswers] = useState<string[]>(positions.map(() => ''));
  const [err, setErr] = useState(false);

  const check = () => {
    const ok = positions.every((p, i) => answers[i].trim().toLowerCase() === words[p]);
    setErr(!ok);
    if (ok) onOk();
  };

  return (
    <div className="card narrow">
      <h2>{t('seedConfirmTitle')}</h2>
      <p>{t('seedConfirmText')}</p>
      {positions.map((p, i) => (
        <label key={p}>
          {t('word')} #{p + 1}
          <input
            autoComplete="off"
            spellCheck={false}
            value={answers[i]}
            onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
          />
        </label>
      ))}
      {err && <p className="error">{t('wrongWords')}</p>}
      <div className="row">
        <button onClick={onBack}>{t('back')}</button>
        <button className="primary" onClick={check}>{t('continue')}</button>
      </div>
    </div>
  );
}

function RestoreForm({ t, service, onBack, onOk }: { t: T; service: WalletService; onBack: () => void; onOk: (m: string) => void }) {
  const [words, setWords] = useState<string[]>(() => Array(12).fill(''));
  const [err, setErr] = useState(false);
  const setSize = (n: number) => setWords((w) => Array.from({ length: n }, (_, i) => w[i] ?? ''));
  const submit = () => {
    const phrase = words.map((w) => w.trim()).join(' ');
    const ok = words.every((w) => w.trim() !== '') && service.validateMnemonic(phrase);
    setErr(!ok);
    if (ok) onOk(phrase);
  };
  return (
    <div className="card narrow">
      <h2>{t('restoreTitle')}</h2>
      <p>{t('restoreText')}</p>
      <div className="row seed-size">
        {[12, 24].map((n) => (
          <button key={n} className={words.length === n ? 'primary' : ''} onClick={() => setSize(n)}>
            {n} {t('seedWords')}
          </button>
        ))}
      </div>
      <SeedGrid
        words={words}
        onChange={(w) => {
          setErr(false);
          setWords(w);
        }}
        plain
      />
      {err && <p className="error">{t('invalidSeed')}</p>}
      <p className="muted small">{t('legacyNote')}</p>
      <div className="row">
        <button onClick={onBack}>{t('back')}</button>
        <button className="primary" onClick={submit}>{t('continue')}</button>
      </div>
    </div>
  );
}

function PasswordForm({ t, onBack, onSubmit }: { t: T; onBack: () => void; onSubmit: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (pw.length < 8) return setErr(t('passwordTooShort'));
    if (pw !== pw2) return setErr(t('passwordMismatch'));
    setErr(undefined);
    setBusy(true);
    try {
      await onSubmit(pw);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  };
  return (
    <div className="card narrow">
      <h2>{t('setPassword')}</h2>
      <p>{t('passwordText')}</p>
      <label>{t('password')}<input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      <label>{t('passwordRepeat')}<input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
      <p className="muted small">{t('passwordRules')}</p>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button onClick={onBack} disabled={busy}>{t('back')}</button>
        <button className="primary" onClick={submit} disabled={busy}>{t('continue')}</button>
      </div>
    </div>
  );
}

function Unlock({ t, service, error, lang }: { t: T; service: WalletService; error?: string; lang: string }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await service.unlock(pw);
    } catch {
      setBusy(false);
    }
  };
  const forget = () => {
    const token = 'DELETE';
    if (prompt(t('forgetConfirm')) !== token) return;
    // The SDK stores the encrypted wallet file in localStorage under keys derived from the filename.
    Object.keys(localStorage)
      .filter((k) => k.includes(WALLET_FILENAME))
      .forEach((k) => localStorage.removeItem(k));
    location.reload();
  };
  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>{t('unlockTitle')}</h2>
      <label>{t('password')}<input type="password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <button className="primary" type="submit" disabled={busy || !pw}>{t('unlock')}</button>
      <button type="button" className="link danger" onClick={forget}>{t('forgetWallet')}</button>
    </form>
  );
}

// ---------------------------------------------------------------- main wallet

function Main({ t, service, state, settings }: { t: T; service: WalletService; state: WalletState; settings: Settings }) {
  const [tab, setTab] = useState<Tab>('wallet');
  const tabs: [Tab, TKey][] = [
    ['wallet', 'tabWallet'],
    ['send', 'tabSend'],
    ['receive', 'tabReceive'],
    ['history', 'tabHistory'],
    ...(FEATURES.bridge ? ([['bridge', 'tabBridge']] as [Tab, TKey][]) : []),
    ['legacy', 'tabLegacy'],
    ['settings', 'tabSettings'],
  ];
  return (
    <div className="main">
      <nav className="tabs">
        {tabs.map(([id, key]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{t(key)}</button>
        ))}
        <button className="lock" onClick={() => void service.lock()}>{t('lock')}</button>
      </nav>
      {state.error && <p className="error">{state.error}</p>}
      {tab === 'wallet' && <Overview t={t} service={service} state={state} />}
      {tab === 'send' && <Send t={t} service={service} state={state} />}
      {tab === 'receive' && <Receive t={t} service={service} state={state} />}
      {tab === 'history' && <History t={t} service={service} state={state} />}
      {tab === 'bridge' && <Bridge t={t} />}
      {tab === 'legacy' && <LegacyMigrate t={t} service={service} state={state} />}
      {tab === 'settings' && <SettingsView t={t} service={service} settings={settings} />}
    </div>
  );
}

function Amount({ service, sompi }: { service: WalletService; sompi?: bigint }) {
  return <>{service.formatAmount(sompi)} KLS</>;
}

function Overview({ t, service, state }: { t: T; service: WalletService; state: WalletState }) {
  const b = state.balance;
  return (
    <div className="card">
      <div className="balance">
        <div className="muted">{t('balanceAvailable')}</div>
        <div className="big"><Amount service={service} sompi={b?.mature} /></div>
      </div>
      <div className="grid3">
        <div><div className="muted">{t('balancePending')}</div><Amount service={service} sompi={b?.pending} /></div>
        <div><div className="muted">{t('balanceOutgoing')}</div><Amount service={service} sompi={b?.outgoing} /></div>
        <div><div className="muted">{t('utxoCount')}</div>{b ? b.matureUtxoCount + b.pendingUtxoCount : 0}</div>
      </div>
      <AddressBox t={t} address={state.receiveAddress} />
    </div>
  );
}

function AddressBox({ t, address }: { t: T; address?: string }) {
  const [copied, setCopied] = useState(false);
  if (!address) return null;
  return (
    <div className="address">
      <div className="muted">{t('receiveAddress')}</div>
      <code>{address}</code>
      <button onClick={async () => { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
        {copied ? t('copied') : t('copy')}
      </button>
    </div>
  );
}

function Receive({ t, service, state }: { t: T; service: WalletService; state: WalletState }) {
  const [qr, setQr] = useState<string>();
  useEffect(() => {
    if (state.receiveAddress) {
      QRCode.toDataURL(state.receiveAddress, { margin: 1, width: 240 }).then(setQr).catch(() => setQr(undefined));
    }
  }, [state.receiveAddress]);
  return (
    <div className="card center">
      {qr && <img className="qr" src={qr} alt="QR" width={240} height={240} />}
      <AddressBox t={t} address={state.receiveAddress} />
      <button onClick={() => void service.newReceiveAddress()}>{t('newAddress')}</button>
    </div>
  );
}

type FeeLevel = 'low' | 'normal' | 'priority';

function Send({ t, service, state }: { t: T; service: WalletService; state: WalletState }) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState<FeeLevel>('normal');
  const [rates, setRates] = useState<Record<FeeLevel, number>>();
  const [est, setEst] = useState<SendEstimate>();
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

  const review = async () => {
    setErr(undefined);
    setBusy(true);
    try {
      setEst(await service.estimate(to, parsed(), rates?.[fee]));
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    setErr(undefined);
    setBusy(true);
    try {
      setResult(await service.send(pw, to, parsed(), rates?.[fee]));
      setPw('');
      setEst(undefined);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="card">
        <h2>{t('sent')}</h2>
        {result.map((id) => (
          <p key={id}>{t('txId')}: <a href={EXPLORER_TX_URL + id} target="_blank" rel="noreferrer noopener"><code>{id}</code></a></p>
        ))}
        <button className="primary" onClick={() => { setResult(undefined); setTo(''); setAmount(''); }}>{t('continue')}</button>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>{t('sendTitle')}</h2>
      <label>{t('recipient')}<input spellCheck={false} autoComplete="off" value={to} onChange={(e) => { setTo(e.target.value); setEst(undefined); }} /></label>
      <label>{t('amount')}
        <div className="row">
          <input inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setEst(undefined); }} />
          <button type="button" onClick={() => { setAmount(service.formatAmount(state.balance?.mature)); setEst(undefined); }}>{t('max')}</button>
        </div>
      </label>
      <label>{t('feePriority')}
        <select value={fee} onChange={(e) => { setFee(e.target.value as FeeLevel); setEst(undefined); }}>
          <option value="low">{t('feeLow')}</option>
          <option value="normal">{t('feeNormal')}</option>
          <option value="priority">{t('feeHigh')}</option>
        </select>
      </label>
      {!est && <button className="primary" disabled={busy || !to || !amount} onClick={review}>{t('review')}</button>}
      {est && (
        <div className="review">
          <p>{t('networkFee')}: <b><Amount service={service} sompi={est.fees} /></b></p>
          {est.finalAmount !== undefined && <p>{t('totalDeducted')}: <b><Amount service={service} sompi={est.finalAmount + est.fees} /></b></p>}
          <p>{t('txCount')}: {est.transactions}</p>
          <p className="muted small">{t('sendPasswordText')}</p>
          <input type="password" autoComplete="current-password" placeholder={t('password')} value={pw} onChange={(e) => setPw(e.target.value)} />
          <div className="row">
            <button onClick={() => setEst(undefined)} disabled={busy}>{t('cancel')}</button>
            <button className="primary" onClick={send} disabled={busy || !pw}>{t('confirmSend')}</button>
          </div>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function History({ t, service, state }: { t: T; service: WalletService; state: WalletState }) {
  return (
    <div className="card">
      <div className="row between">
        <h2>{t('tabHistory')}</h2>
        <button onClick={() => void service.refreshHistory()}>{t('refresh')}</button>
      </div>
      {state.transactions.length === 0 && <p className="muted">{t('historyEmpty')}</p>}
      <ul className="history">
        {state.transactions.map((tx) => {
          const s = txSummary(tx);
          const when = tx.unixtimeMsec ? new Date(Number(tx.unixtimeMsec)).toLocaleString() : `DAA ${tx.blockDaaScore}`;
          const label = s.direction === 'in' ? t('incoming') : s.direction === 'out' ? t('outgoing') : t('internal');
          return (
            <li key={tx.id} className={s.direction}>
              <div>
                <b>{label}</b> <span className="muted small">{when}</span>
                <div><a className="small" href={EXPLORER_TX_URL + tx.id} target="_blank" rel="noreferrer noopener" title={t('explorer')}><code>{tx.id}</code></a></div>
              </div>
              <div className="amt">{s.direction === 'out' ? '−' : s.direction === 'in' ? '+' : ''}<Amount service={service} sompi={s.value} /></div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Bridge({ t }: { t: T }) {
  return (
    <div className="card">
      <h2>{t('bridgeTitle')}</h2>
      <p className="muted">{t('bridgeText')}</p>
    </div>
  );
}

function SettingsView({ t, service, settings }: { t: T; service: WalletService; settings: Settings }) {
  const [s, setS] = useState(settings);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [actionPw, setActionPw] = useState('');
  const [msg, setMsg] = useState<string>();
  const [err, setErr] = useState<string>();

  const run = async (fn: () => Promise<string | void>) => {
    setMsg(undefined);
    setErr(undefined);
    try {
      const r = await fn();
      if (r) setMsg(r);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  };

  return (
    <div className="card">
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
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.name}</option>
          ))}
        </select>
      </label>
      <button className="primary" onClick={() => { saveSettings(s); location.reload(); }}>{t('save')}</button>

      <hr />
      <h3>{t('changePassword')}</h3>
      <input type="password" autoComplete="current-password" placeholder={t('currentPassword')} value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
      <input type="password" autoComplete="new-password" placeholder={t('newPassword')} value={newPw} onChange={(e) => setNewPw(e.target.value)} />
      <button
        disabled={!oldPw || newPw.length < 8}
        onClick={() => run(async () => { await service.changePassword(oldPw, newPw); setOldPw(''); setNewPw(''); return t('passwordChanged'); })}
      >{t('changePassword')}</button>

      <hr />
      <input type="password" autoComplete="current-password" placeholder={t('password')} value={actionPw} onChange={(e) => setActionPw(e.target.value)} />
      <h3>{t('compound')}</h3>
      <p className="muted small">{t('compoundText')}</p>
      <button disabled={!actionPw} onClick={() => run(async () => { const ids = await service.compound(actionPw); return `${t('txId')}: ${ids.join(', ')}`; })}>{t('compound')}</button>
      <h3>{t('exportBackup')}</h3>
      <p className="muted small">{t('exportText')}</p>
      <button
        disabled={!actionPw}
        onClick={() => run(async () => {
          const hex = await service.exportBackup(actionPw);
          const blob = new Blob([hex], { type: 'text/plain' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `karlsen-wallet-backup-${new Date().toISOString().slice(0, 10)}.kwb`;
          a.click();
          URL.revokeObjectURL(a.href);
        })}
      >{t('exportBackup')}</button>

      {msg && <p className="ok">{msg}</p>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
