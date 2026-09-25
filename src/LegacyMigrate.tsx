// UI for moving funds off legacy m/44'/972 addresses (old web wallet, Karlsen-Desktop).
// All safety checks live in ./legacy.ts; this component only drives the flow.
import { useState } from 'react';
import type { TKey } from './i18n';
import { SeedGrid } from './SeedGrid';
import type { WalletService, WalletState } from './wallet';
import {
  DEFAULT_LEGACY_SCAN_COUNT,
  previewLegacySweep,
  scanLegacyFunds,
  sweepLegacyFunds,
  type LegacyScanResult,
  type LegacySweepPreview,
} from './legacy';

// Same explorer base as App.tsx (kaspa-explorer fork: /txs/<id>).
const EXPLORER_TX_URL = 'https://explorer.karlsencoin.org/txs/';
/** Upper bound enforced by the Rust side per request. */
const MAX_SCAN_COUNT = 10_000;
/** Funded addresses listed on screen (the rest are summarised). */
const LISTED_ADDRESSES = 20;

type T = (k: TKey) => string;
type Step = 'input' | 'busy' | 'scanned' | 'preview' | 'done';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function LegacyMigrate({ t, service, state }: { t: T; service: WalletService; state: WalletState }) {
  const [words, setWords] = useState<string[]>(() => Array(12).fill(''));
  const seed = words.join(' ').trim();
  const clearSeed = (n = words.length) => setWords(Array(n).fill(''));
  const [step, setStep] = useState<Step>('input');
  const [busyLabel, setBusyLabel] = useState('');
  const [progress, setProgress] = useState('');
  const [count, setCount] = useState(DEFAULT_LEGACY_SCAN_COUNT);
  const [scan, setScan] = useState<LegacyScanResult>();
  const [preview, setPreview] = useState<LegacySweepPreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [txIds, setTxIds] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  // Destination is always this wallet's own receive address; the user cannot edit it.
  const destination = state.receiveAddress;
  const fmt = (sompi?: bigint) => `${service.formatAmount(sompi)} KLS`;
  const seedOk = seed.trim() !== '' && service.validateMnemonic(seed);

  const run = async (label: string, back: Step, fn: () => Promise<void>, errorPrefix = '') => {
    setError(undefined);
    setProgress('');
    setBusyLabel(label);
    setStep('busy');
    try {
      await fn();
    } catch (e) {
      setError(errorPrefix + errText(e));
      setStep(back);
    }
  };

  const doScan = (n: number) =>
    run(t('legacyScanning'), scan ? 'scanned' : 'input', async () => {
      const result = await scanLegacyFunds(service.sdkHandle, service.rpcClient, service.networkId, seed, n);
      setCount(n);
      setScan(result);
      setPreview(undefined);
      setConfirmed(false);
      setStep('scanned');
    });

  const doPreview = () =>
    run(t('legacyPreparing'), 'scanned', async () => {
      if (!destination || !scan) throw new Error('Wallet address is not ready yet.');
      const p = await previewLegacySweep(service.sdkHandle, service.rpcClient, service.networkId, seed, scan.funded, destination);
      if (p.destination !== destination) throw new Error('Destination changed unexpectedly. Nothing was sent.');
      setPreview(p);
      setConfirmed(false);
      setStep('preview');
    });

  const doSend = () =>
    run(
      t('legacySending'),
      'scanned',
      async () => {
        if (!destination || !scan || !preview || preview.destination !== destination) {
          throw new Error('Destination changed unexpectedly. Nothing was sent.');
        }
        const ids = await sweepLegacyFunds(
          service.sdkHandle,
          service.rpcClient,
          service.networkId,
          seed,
          scan.funded,
          destination,
          (done, total) => setProgress(`${done}/${total}`),
        );
        setTxIds(ids);
        clearSeed(); // drop the legacy seed as soon as it is no longer needed
        setStep('done');
      },
      t('legacySendFailed') + ' ',
    );

  const reset = () => {
    clearSeed();
    setScan(undefined);
    setPreview(undefined);
    setConfirmed(false);
    setTxIds([]);
    setError(undefined);
    setCount(DEFAULT_LEGACY_SCAN_COUNT);
    setStep('input');
  };

  return (
    <div className="card">
      <h3>{t('legacyTitle')}</h3>
      <p className="muted small">{t('legacyIntro')}</p>
      {error && <p className="error">{error}</p>}

      {step === 'busy' && (
        <p>
          {busyLabel} {progress}
        </p>
      )}

      {step === 'input' && (
        <>
          <label className="muted">{t('legacySeed')}</label>
          <div>
            {[12, 24].map((n) => (
              <button key={n} className={words.length === n ? 'active' : ''} onClick={() => clearSeed(n)}>
                {n} {t('legacyWords')}
              </button>
            ))}
          </div>
          <SeedGrid words={words} onChange={setWords} />
          <button disabled={!seedOk || !state.connected} onClick={() => void doScan(DEFAULT_LEGACY_SCAN_COUNT)}>
            {t('legacyScan')}
          </button>
        </>
      )}

      {step === 'scanned' && scan && (
        <>
          {scan.funded.length === 0 ? (
            <p>{t('legacyNothing')}</p>
          ) : (
            <>
              <div className="muted">{t('legacyFound')}</div>
              <div className="big">{fmt(scan.matureSompi)}</div>
              {scan.immatureUtxoCount > 0 && (
                <p className="muted small">
                  {t('legacyImmature')}: {fmt(scan.totalSompi - scan.matureSompi)} ({scan.immatureUtxoCount} UTXO)
                </p>
              )}
              <p className="muted small">
                {t('legacyAddresses')}: {scan.funded.length} · UTXO: {scan.utxoCount}
              </p>
              <ul className="small">
                {scan.funded.slice(0, LISTED_ADDRESSES).map((f) => (
                  <li key={f.address}>
                    <code>{f.path}</code> · <code>{f.address}</code> · {fmt(f.balance)}
                  </li>
                ))}
                {scan.funded.length > LISTED_ADDRESSES && <li>… +{scan.funded.length - LISTED_ADDRESSES}</li>}
              </ul>
            </>
          )}
          <p className="muted small">
            {t('legacyScanned')}: {scan.scanned.receive} receive + {scan.scanned.change} change
          </p>
          {count < MAX_SCAN_COUNT && (
            <button onClick={() => void doScan(Math.min(count * 2, MAX_SCAN_COUNT))}>{t('legacyScanMore')}</button>
          )}
          {scan.matureSompi > 0n && <button onClick={() => void doPreview()}>{t('legacyPreview')}</button>}
          <button onClick={reset}>{t('legacyBack')}</button>
        </>
      )}

      {step === 'preview' && preview && (
        <>
          <div className="muted">{t('legacyDestination')}</div>
          <p>
            <code>{preview.destination}</code>
          </p>
          <div className="grid3">
            <div>
              <div className="muted">{t('legacyFound')}</div>
              {fmt(preview.totalSompi)}
            </div>
            <div>
              <div className="muted">{t('legacyFees')}</div>
              {fmt(preview.feesSompi)}
            </div>
            <div>
              <div className="muted">{t('legacyReceive')}</div>
              {fmt(preview.finalSompi)}
            </div>
          </div>
          <p className="muted small">
            {t('legacyTxCount')}: {preview.transactions} · UTXO: {preview.utxos}
          </p>
          <label>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> {t('legacyConfirm')}
          </label>
          <button disabled={!confirmed} onClick={() => void doSend()}>
            {t('legacyMove')}
          </button>
          <button onClick={() => setStep('scanned')}>{t('legacyBack')}</button>
        </>
      )}

      {step === 'done' && (
        <>
          <p>{t('legacyDone')}</p>
          <ul className="small">
            {txIds.map((id) => (
              <li key={id}>
                <a href={EXPLORER_TX_URL + id} target="_blank" rel="noreferrer">
                  <code>{id}</code>
                </a>
              </li>
            ))}
          </ul>
          <button onClick={reset}>{t('legacyBack')}</button>
        </>
      )}
    </div>
  );
}
