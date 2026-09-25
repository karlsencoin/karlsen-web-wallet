// Loads the Rusty Karlsen WASM SDK (Full package) at runtime from /karlsen-wasm/.
// The SDK runs on the main thread on purpose: its wallet runtime (workflow-rs)
// needs `window` and `localStorage`, which do not exist inside Web Workers.
import type * as KarlsenSdk from './karlsen-sdk';

export type Sdk = typeof KarlsenSdk;

const SDK_BASE = '/karlsen-wasm/';

let sdkPromise: Promise<Sdk> | null = null;

export function loadSdk(): Promise<Sdk> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const url = SDK_BASE + 'karlsen.js';
      const sdk = (await import(/* @vite-ignore */ url)) as Sdk & {
        default: (arg: { module_or_path: string }) => Promise<unknown>;
      };
      await sdk.default({ module_or_path: SDK_BASE + 'karlsen_bg.wasm' });
      // Surface Rust panics as readable console messages instead of "unreachable".
      sdk.initConsolePanicHook();
      return sdk;
    })();
    sdkPromise.catch(() => {
      sdkPromise = null;
    });
  }
  return sdkPromise;
}
