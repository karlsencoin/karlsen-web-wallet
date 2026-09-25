# Karlsen Web Wallet

Non-custodial web wallet for the Karlsen network, built on the official
**Rusty Karlsen WASM SDK v3.3.x** (Full package, ISC license) with React + TypeScript.

- Keys, signing, UTXO tracking and the node connection are handled by the Rust
  wallet framework (`wallet/core`, compiled to `karlsen_bg.wasm`) — the same code
  used by the Karlsen CLI wallet.
- The SDK runs on the **main thread** (its storage and timer layers need `window`
  and `localStorage`; it does not work inside a Web Worker).
- Accounts use the standard BIP-44 path `m/44'/121337'/0'` only. Legacy `972`
  wallets from the old wallet.karlsencoin.org are intentionally not supported.

## Features (v0.1.0)

Create wallet (24-word seed + 3-word confirmation) · restore from 12/24 words ·
password unlock · balance (mature / pending / outgoing) · receive address + QR ·
new receive address · send with fee-rate choice, estimate and password
re-confirmation · transaction history · compound UTXOs · change password ·
encrypted backup download · EN/TR · node URL / network settings · bridge tab
(behind `VITE_FEATURE_BRIDGE`).

## Run on Mine1 (local karlsend)

1. karlsend must expose wRPC Borsh on the LAN and have the UTXO index:
   ```
   karlsend --utxoindex --rpclisten-borsh=0.0.0.0:43110
   ```
2. Build/run the wallet:
   ```
   npm install
   cp .env.example .env.local   # adjust VITE_DEFAULT_NODE_URL if needed
   npm run dev                  # http://192.168.1.25:5173
   ```
3. Production build: `npm run build` → static files in `dist/` (serve with nginx;
   `.wasm` must be served as `application/wasm`).

Note: a page served over `https://` can only connect to `wss://` node endpoints.

## Layout

```
public/karlsen-wasm/   SDK (karlsen.js, karlsen_bg.wasm) — loaded at runtime, not bundled
src/sdk.ts             SDK loader + panic hook
src/wallet.ts          WalletService: SDK lifecycle, events, send/estimate, history
src/App.tsx            Screens (onboarding, unlock, wallet, send, receive, history, settings, bridge)
src/i18n.ts            English / Turkish strings
src/config.ts          Settings + feature flags
```

## Known limitations / open items

- The seed phrase is shown only at creation: the SDK's `prvKeyDataGet` does not
  return key material to JavaScript yet.
- Bridge `signMessage` needs the account private key; the Wallet API does not
  expose it, so the bridge will need a dedicated signing path (e.g. derive from the
  mnemonic at bridge time, or a small Rust binding in rusty-karlsen).
- Explorer links assume `https://explorer.karlsencoin.org/txs/<id>`.
- Balance / send / history were not exercised against a live node yet.
