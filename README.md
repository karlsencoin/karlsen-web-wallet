# Karlsen Web Wallet

Non-custodial browser wallet for the Karlsen network, live at
**https://wallet.karlsencoin.org**.

Built on the **Rusty Karlsen WASM SDK** (ISC license) with React + TypeScript.
Keys, signing, UTXO tracking and the node connection are handled by the Rust
wallet framework (`wallet/core`, compiled to `karlsen_bg.wasm`), the same code
base used by the Karlsen node and CLI wallet. Keys are generated and encrypted
in the browser and never leave it.

## Features (v2.0.0)

- Create a wallet (24-word seed with confirmation) or restore from 12 / 24 words
- Standard Karlsen BIP-44 path `m/44'/121337'/0'`
- Balance (mature / pending), receive address with QR, QR scanning
- Send with fee priority, estimate and password confirmation; send-all
- Transaction history with paging, CSV export
- Compound UTXOs, seed backup, encrypted wallet file export, change password
- Network status (DAA score, DAG blocks, difficulty, past median time)
- Node connection: Karlsen public node by default with failover, or your own node
  (Settings → Advanced), with URL validation and a way out when a node is unreachable
- **Old wallet (972)**: finds funds of the previous web wallet / Karlsen-Desktop
  (`m/44'/972`) from their seed phrase and moves them to this wallet
- Links to the previous web wallet, which stays available unchanged at `/legacy`
- 12 languages: de, en, es, fr, id, ja, ko, pt, ru, tr, vi, zh (English fallback)
- Light / dark theme
- Karlsen ⇄ Solana bridge (wKLS) screen, behind `VITE_FEATURE_BRIDGE`
  (a read-only teaser is shown while the flag is off)

## SDK

The wallet loads the SDK at runtime from `public/karlsen-wasm/` (not bundled and
not committed). Build it from [rusty-karlsen](https://github.com/karlsencoin/rusty-karlsen):

```bash
git clone https://github.com/karlsencoin/rusty-karlsen
cd rusty-karlsen
git checkout feat/wallet-bridge-sign-message   # adds accountsSignMessage / accountsBridgeDeposit
cargo install wasm-pack
cd wasm && ./build-web --sdk
```

Copy the resulting web SDK (`karlsen.js`, `karlsen_bg.wasm`, `karlsen.d.ts`) into
`public/karlsen-wasm/` of this project.

## Development

A karlsend node with the UTXO index and wRPC Borsh enabled is required:

```bash
karlsend --utxoindex --rpclisten-borsh=0.0.0.0:43110
```

```bash
npm install
cp .env.example .env.local     # optional, see comments inside
npm run dev -- --host 0.0.0.0  # http://<this-machine>:5173
```

On plain `http://` the wallet connects to `ws://<page host>:43110` by default.

## Production build

```bash
npm run build                  # static files in dist/
```

Serve `dist/` as static files (nginx or similar):

- `.wasm` must be served as `application/wasm`
- `index.html` with `Cache-Control: no-cache`, `assets/` can be cached immutably
- the default public node is `wss://<page host>/wrpc`, so proxy `/wrpc` (WebSocket)
  to karlsend's wRPC Borsh port (`127.0.0.1:43110`)
- a page served over `https://` can only open `wss://` node connections

Build-time options are documented in `.env.example`.

## Layout

```
public/karlsen-wasm/   SDK loaded at runtime (not committed, see "SDK")
src/sdk.ts             SDK loader + panic hook
src/wallet.ts          WalletService: SDK lifecycle, node failover, events, send, history
src/App.tsx            Onboarding, unlock, top bar
src/Classic.tsx        Main screen (tabs, dialogs, settings)
src/legacy.ts          Old wallet (972) scan and transfer
src/Bridge.tsx         Bridge dialog (wKLS)
src/bridge.ts          Bridge API client and intent signing
src/config.ts          Settings, node endpoints, feature flags
src/i18n.ts            English and Turkish strings, locale loading
src/locales/*.ts       Other languages
```

## Security notes

- The wallet file and the seed copy used by "Backup Seed" are stored encrypted with
  the wallet password in the browser's local storage.
- No keys, seeds or passwords are sent to any server.
- Report security issues privately to the Karlsen team rather than in public issues.

## License

ISC
