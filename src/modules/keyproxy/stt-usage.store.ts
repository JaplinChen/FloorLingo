import * as fs from 'node:fs';
import { atomicWriteJson } from '../translate/translate-fs';

// Voice transcription talks to Groq/OpenAI DIRECTLY — the key-rotation proxy has no
// /v1/audio/transcriptions route, so those calls never touch it and its quota-stats show the key at
// zero forever. That reads as a broken key on the LLM Keys page when it is simply being used by a
// path the proxy cannot see. This sidecar is the missing half: the STT caller counts its own calls
// here, and KeyProxyService folds them into the matching row.
//
// Keyed by the LAST 4 CHARS of the key, never the key itself: the file lives beside the glossary in
// the data dir and must stay useless to anyone who reads it. KeyProxyService already holds the
// plaintext, so it can compute the same suffix to match on.

const usagePath = (): string => process.env.STT_USAGE_PATH || 'data/stt-usage.json';

export interface SttUsage {
  requests: number;
  failures: number;
  /** Epoch ms of the last call, success or failure. 0 when never used. */
  lastUsedAt: number;
}

type UsageFile = Record<string, SttUsage>;

const empty = (): SttUsage => ({ requests: 0, failures: 0, lastUsedAt: 0 });

export function keySuffix(key: string): string {
  return key.slice(-4);
}

function read(): UsageFile {
  try {
    const raw = JSON.parse(fs.readFileSync(usagePath(), 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? (raw as UsageFile) : {};
  } catch {
    return {}; // absent or corrupt: usage counters are not worth failing a request over
  }
}

/** Totals for one key suffix; zeroes when it has never been used. */
export function sttUsageFor(suffix: string): SttUsage {
  return read()[suffix] ?? empty();
}

/**
 * Count one transcription attempt. Persisted rather than in-memory so the number survives the
 * redeploys this project does often — a counter that resets to zero on every restart would look
 * exactly like the bug this file exists to fix.
 */
export function recordSttCall(key: string, ok: boolean, now = Date.now()): void {
  if (!key) return;
  const suffix = keySuffix(key);
  const all = read();
  const cur = all[suffix] ?? empty();
  all[suffix] = {
    requests: cur.requests + 1,
    failures: cur.failures + (ok ? 0 : 1),
    lastUsedAt: now,
  };
  try {
    atomicWriteJson(usagePath(), all);
  } catch {
    // Best effort: a read-only data dir must not turn a working transcription into a failed one.
  }
}
