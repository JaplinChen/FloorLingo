import * as fs from 'node:fs';
import { atomicWriteJson } from './translate-fs';
import type { PhraseCandidate } from './translate-phrase-candidates';

/**
 * Daily phrase-review loop over WhatsApp DM. Pure logic only — formatting, parsing and the schedule
 * decision — so the service wiring stays thin and every branch here is testable without a session.
 *
 * Two properties this file exists to hold:
 *  - **Replies address DB ids, never positions.** The candidate list is ordered `count DESC`, and a
 *    scan refreshes counts, so "the 3rd one" means something different after every scan. An admin
 *    replying to yesterday's message would otherwise approve a row they never read.
 *  - **Nothing is guessed.** An unparseable reply gets a usage line back, not a best-effort match.
 */

export interface ReviewReply {
  approve: number[];
  reject: number[];
  /** `ok 41=giao hàng` — approve id 41 but with this Vietnamese instead of the LLM's suggestion. */
  corrections: { id: number; vi: string }[];
}

const USAGE_LINES = [
  'ok 41 43 — 核准 / duyệt',
  'no 42 — 略過 / bỏ qua',
  'ok 41=bản dịch đúng — 改譯法後核准 / sửa bản dịch rồi duyệt',
];

/** The reply grammar, for a DM footer or an error response. */
export function usageText(): string {
  return ['回覆 / Trả lời:', ...USAGE_LINES].join('\n');
}

/**
 * The daily digest. Bilingual because the admin list can hold both Taiwanese managers and Vietnamese
 * staff, and a review loop its own reviewers can't read is worse than no review loop.
 */
export function formatReviewDm(rows: PhraseCandidate[]): string {
  const lines = rows.map(r => `#${r.id}  ${r.phrase} → ${r.translated}  (${r.count}x)`);
  return [`待審核詞彙 ${rows.length} 筆 / ${rows.length} mục chờ duyệt`, '', ...lines, '', usageText()].join('\n');
}

/**
 * Parse a review reply. Returns null when the text isn't a review reply at all (so the caller can
 * stay silent rather than backtalk every stray DM); returns an empty result when it looks like one
 * but names no valid id (so the caller can answer with the usage line).
 */
export function parseReviewReply(text: string): ReviewReply | null {
  const trimmed = text.trim();
  if (!/^(ok|no)\b/i.test(trimmed)) return null;

  const reply: ReviewReply = { approve: [], reject: [], corrections: [] };
  // Split on the verbs so one message can carry both, e.g. "ok 41 43 no 42".
  const segments = trimmed.split(/\b(?=(?:ok|no)\b)/i).filter(s => s.trim());
  for (const segment of segments) {
    const verb = /^ok\b/i.test(segment) ? 'ok' : 'no';
    const rest = segment.replace(/^(ok|no)\b/i, '').trim();
    if (!rest) continue;

    // `41=bản dịch` first: the correction consumes the whole remainder, so it can contain spaces.
    const corrected = rest.match(/^#?(\d+)\s*=\s*(.+)$/);
    if (corrected && verb === 'ok') {
      const vi = corrected[2].trim();
      if (vi) reply.corrections.push({ id: Number(corrected[1]), vi });
      continue;
    }
    for (const token of rest.split(/[\s,]+/)) {
      const id = Number(token.replace(/^#/, ''));
      if (!Number.isInteger(id) || id <= 0) continue;
      (verb === 'ok' ? reply.approve : reply.reject).push(id);
    }
  }
  return reply;
}

export const isEmptyReply = (r: ReviewReply): boolean => !r.approve.length && !r.reject.length && !r.corrections.length;

/** Local calendar date + hour in `tz`. Throws on an unknown timezone — callers validate at boot. */
export function localParts(now: Date, tz: string): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    })
      .formatToParts(now)
      .map(p => [p.type, p.value]),
  );
  // hour12:false yields "24" for midnight in some ICU builds.
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

/**
 * Whether today's digest is still owed. `>=` rather than `===` so a restart (or a container that was
 * down at the target hour) still sends later the same day instead of silently skipping; the date
 * check is what keeps it to once per day, and it is persisted so a restart inside the hour doesn't
 * re-send to everyone.
 */
export function isDigestDue(now: Date, tz: string, targetHour: number, lastSentDate: string): boolean {
  const { date, hour } = localParts(now, tz);
  return hour >= targetHour && date !== lastSentDate;
}

/** Reads `TRANSLATE_REVIEW_DM_HOUR`. null = feature off. Invalid values are reported, never guessed. */
export function parseDmHour(raw: string | undefined): { hour: number | null; error?: string } {
  if (raw === undefined || raw.trim() === '') return { hour: null };
  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return { hour: null, error: `TRANSLATE_REVIEW_DM_HOUR must be an integer 0-23, got "${raw}" — daily DM disabled` };
  }
  return { hour };
}

/**
 * Last date a digest went out, persisted so a restart inside the target hour doesn't re-DM everyone.
 * Unreadable = "never sent": the cost is one duplicate digest, versus silently never sending again.
 */
export function readDigestState(path: string): string {
  try {
    return (JSON.parse(fs.readFileSync(path, 'utf8')) as { lastSentDate?: string }).lastSentDate || '';
  } catch {
    return '';
  }
}

/** Returns false when the stamp could not be written — the caller logs it, because that means a re-send. */
export function writeDigestState(path: string, date: string): boolean {
  try {
    atomicWriteJson(path, { lastSentDate: date });
    return true;
  } catch {
    return false;
  }
}

/** Validates `TRANSLATE_REVIEW_DM_TZ` by using it; an unknown zone falls back rather than throwing at 3am. */
export function resolveTz(raw: string | undefined): { tz: string; error?: string } {
  const fallback = 'Asia/Taipei';
  const tz = (raw || '').trim() || fallback;
  try {
    localParts(new Date(0), tz);
    return { tz };
  } catch {
    return { tz: fallback, error: `TRANSLATE_REVIEW_DM_TZ "${tz}" is not a known timezone — using ${fallback}` };
  }
}
