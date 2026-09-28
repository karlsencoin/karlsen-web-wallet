import { useEffect, useMemo, useState } from 'react';
import { WalletService, type WalletState } from './wallet';
import { LANGUAGES, LEGACY_WALLET_URL, hasLegacyWallet, loadSettings, saveSettings, type Settings } from './config';
import { translator, type TKey } from './i18n';
import { SeedGrid } from './SeedGrid';
import { Main } from './Classic';

type T = (k: TKey) => string;

/** Applies the colour theme to <html>; 'auto' leaves it to prefers-color-scheme. */
function applyTheme(theme: Settings['theme']) {
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

function effectiveDark(theme: Settings['theme']): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  // The wallet runtime is bound to the settings loaded at start; node/network changes reload the page.
  const service = useMemo(() => new WalletService(settings), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => applyTheme(settings.theme), [settings.theme]);
  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    saveSettings(next);
    setSettings(next);
  };
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
      body = <Unlock t={t} service={service} error={state.error} nodeError={state.nodeError} settings={settings} />;
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
        <img src="/karlsen.svg" alt="" width={28} height={28} title={t('appTitle')} />
        <div className="tools">
          {state.phase === 'ready' && (
            <button className="icon" title={t('lock')} onClick={() => void service.lock()}><LockIcon /></button>
          )}
          <label className="langsel" title={t('language')}>
            <span aria-hidden="true">文A</span>
            <select value={settings.lang} onChange={(e) => update({ lang: e.target.value as Settings['lang'] })}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </label>
          <button className="icon" title={t('themeToggle')} onClick={() => update({ theme: effectiveDark(settings.theme) ? 'light' : 'dark' })}>
            {effectiveDark(settings.theme) ? '☀' : '☾'}
          </button>
        </div>
      </header>
      <main>{body}</main>
    </div>
  );
}

/** Prominent notice when the previous web wallet is still stored in this browser. */
function LegacyBanner({ t }: { t: T }) {
  if (!hasLegacyWallet()) return null;
  return (
    <div className="legacy-banner">
      <p>{t('legacyDetected')}</p>
      <a className="button dark" href={LEGACY_WALLET_URL}>{t('legacyOpenOld')}</a>
    </div>
  );
}

/** Always-available, low-key link to the previous web wallet. */
export function LegacyLink({ t }: { t: T }) {
  return <p className="center small"><a href={LEGACY_WALLET_URL}>{t('legacyLink')}</a></p>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="centered card">{children}</div>;
}

// ---------------------------------------------------------------- onboarding

function Onboarding({ t, service, error }: { t: T; service: WalletService; error?: string }) {
  const [step, setStep] = useState<'choose' | 'show' | 'confirm' | 'restore' | 'password'>('choose');
  const [mnemonic, setMnemonic] = useState('');

  if (step === 'choose') {
    return (
      <div className="card narrow">
        <LegacyBanner t={t} />
        <h1>{t('welcome')}</h1>
        <p>{t('welcomeText')}</p>
        {error && <p className="error">{error}</p>}
        <button className="primary" onClick={() => { setMnemonic(service.generateMnemonic(24)); setStep('show'); }}>
          {t('createWallet')}
        </button>
        <button onClick={() => setStep('restore')}>{t('restoreWallet')}</button>
        <LegacyLink t={t} />
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

function Unlock({ t, service, error, nodeError, settings }: {
  t: T;
  service: WalletService;
  error?: string;
  nodeError?: WalletState['nodeError'];
  settings: Settings;
}) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await service.unlock(pw);
    } catch {
      /* error is shown from wallet state */
    } finally {
      setBusy(false);
    }
  };
  const usePublicNode = () => {
    saveSettings({ ...settings, nodeMode: 'public' });
    location.reload();
  };
  const forget = () => {
    if (prompt(t('forgetConfirm')) !== 'DELETE') return;
    service.forgetWallet();
    location.reload();
  };
  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>{t('unlockTitle')}</h2>
      <label>{t('password')}<input type="password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      {nodeError ? (
        <div className="stack">
          <p className="error">{t('nodeUnreachable')}</p>
          <p className="muted small">{nodeError.tried.join(', ')}</p>
          {settings.nodeMode === 'custom'
            ? <button type="button" className="dark" onClick={usePublicNode}>{t('nodeUsePublic')}</button>
            : <p className="muted small">{t('nodeUnreachableHelp')}</p>}
        </div>
      ) : (
        error && <p className="error">{error}</p>
      )}
      <button className="primary" type="submit" disabled={busy || !pw}>{nodeError ? t('retry') : t('unlock')}</button>
      <button type="button" className="link danger" onClick={forget}>{t('forgetWallet')}</button>
      <LegacyBanner t={t} />
      {!hasLegacyWallet() && <LegacyLink t={t} />}
    </form>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
