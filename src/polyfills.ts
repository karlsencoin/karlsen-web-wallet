// @solana/web3.js expects Node's Buffer as a global in the browser.
import { Buffer } from 'buffer';

const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;
