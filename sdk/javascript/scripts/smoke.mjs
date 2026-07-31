/**
 * Packaging smoke test: load the BUILT dist/ through Node's real CJS and ESM
 * loaders. Unit tests run under vitest's bundler-like resolver and cannot catch
 * a dual-format misconfig (CJS parsed as ESM, or extensionless ESM specifiers),
 * so this guards `npm publish` against shipping an unconsumable package.
 * Run after `npm run build`.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cjs = require('../dist/cjs/index.js');
if (typeof cjs.FloorLingoClient !== 'function') throw new Error('CJS: FloorLingoClient missing');

const esm = await import(new URL('../dist/esm/index.js', import.meta.url).href);
if (typeof esm.FloorLingoClient !== 'function') throw new Error('ESM: FloorLingoClient missing');

console.log('smoke OK: require() + import() both resolve FloorLingoClient');
