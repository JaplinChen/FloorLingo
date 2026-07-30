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

/**
 * Provider-reported quota, straight from the response headers of the last call. This is the only
 * authoritative source there is: the ceiling depends on the account's tier, which nothing on this side
 * can know. Absent for providers that report nothing (Gemini sends no rate-limit headers, which is why
 * the proxy's own `limit` field sits at null) — then the UI shows a bare count rather than inventing one.
 */
export interface SttQuota {
  /** Requests allowed and left in the current window. */
  limitRequests: number;
  remainingRequests: number;
  /** Audio seconds allowed and left. For transcription this usually binds before the request count. */
  limitAudioSeconds: number;
  remainingAudioSeconds: number;
}

export interface SttUsage {
  requests: number;
  failures: number;
  /** Epoch ms of the last call, success or failure. 0 when never used. */
  lastUsedAt: number;
  /** Quota as of the last successful call. Null until a provider reports one. */
  quota: SttQuota | null;
}

type UsageFile = Record<string, SttUsage>;

const empty = (): SttUsage => ({ requests: 0, failures: 0, lastUsedAt: 0, quota: null });

/**
 * Pull the `x-ratelimit-*` family out of a transcription response. Groq sends all four; a backend that
 * sends none yields null, and a partial set is treated as none rather than shown as a half-filled bar.
 */
export function quotaFromHeaders(headers?: { get(name: string): string | null } | null): SttQuota | null {
  if (!headers) return null; // a backend/mock without a headers bag simply reports no quota
  const num = (name: string): number => {
    // Number(null) is 0, not NaN — so an absent header must be rejected BEFORE the numeric parse, or a
    // provider that sends none reads back as a genuine "0 of 0" quota.
    const raw = headers.get(name);
    if (raw === null || raw.trim() === '') return -1;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : -1;
  };
  const q: SttQuota = {
    limitRequests: num('x-ratelimit-limit-requests'),
    remainingRequests: num('x-ratelimit-remaining-requests'),
    limitAudioSeconds: num('x-ratelimit-limit-audio-seconds'),
    remainingAudioSeconds: num('x-ratelimit-remaining-audio-seconds'),
  };
  return Object.values(q).some(v => v < 0) ? null : q;
}

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
export function recordSttCall(key: string, ok: boolean, quota: SttQuota | null = null, now = Date.now()): void {
  if (!key) return;
  const suffix = keySuffix(key);
  const all = read();
  const cur = all[suffix] ?? empty();
  all[suffix] = {
    requests: cur.requests + 1,
    failures: cur.failures + (ok ? 0 : 1),
    lastUsedAt: now,
    // Keep the previous reading when this call reported none — a failed call still leaves the last
    // known ceiling valid, and dropping it would blank the display on one transport error.
    quota: quota ?? cur.quota ?? null,
  };
  try {
    atomicWriteJson(usagePath(), all);
  } catch {
    // Best effort: a read-only data dir must not turn a working transcription into a failed one.
  }
}
