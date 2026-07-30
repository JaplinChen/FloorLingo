import * as fs from 'node:fs';
import * as path from 'node:path';
import { SttQuota, quotaFromHeaders } from '../keyproxy/stt-usage.store';

// Voice notes carry no `body`, so the translate hook drops them and a spoken message silently breaks
// the conversation. Transcribe to text first, then feed that text through the normal translate path so
// glossary / senders / memory / feedback all apply unchanged.
//
// Config is env-only (no dashboard page): an STT backend is set once per deploy, unlike the glossary.
// Enabled == TRANSLATE_VOICE_STT_URL is set — setting the endpoint is the opt-in, no separate flag.

export interface VoiceConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  language: string;
  /**
   * Whisper vocabulary bias — DOUBLE-EDGED, default empty on purpose.
   *
   * The problem it targets is real: Vietnamese speakers pronounce English loanwords with Vietnamese
   * phonology (unreleased final stops, no English stress), so the model snaps them to a commoner
   * English word — observed "bot" -> "boss" and "bot" -> "Bob", which flips the sentence's meaning
   * before translation ever sees it.
   *
   * But whisper does not treat this as a whitelist: the string is fed to the decoder as PRECEDING
   * CONTEXT. A comma-separated word list is unnatural context and measurably raises the odds of the
   * decoder wandering into training-set boilerplate — with a list set, short clips came back as
   * "Hãy đăng ký kênh để ủng hộ kênh..." (the YouTube "subscribe to the channel" filler), unrelated
   * to the audio. Listed words do get favoured; the sentence around them may not survive. Leave empty
   * unless a measured comparison shows otherwise.
   */
  prompt: string;
  timeoutMs: number;
  maxBytes: number;
  maxPerHour: number;
  concurrency: number;
  /** Known STT mishearings, `intended -> [heard variants]`. Empty = no correction block in the prompt. */
  confusions: Map<string, string[]>;
  includeAudioFiles: boolean;
}

const DEFAULTS = {
  model: 'whisper-large-v3-turbo',
  timeoutMs: 30_000,
  maxBytes: 16 * 1024 * 1024,
  maxPerHour: 60,
  // 2 keeps a burst from thrashing a self-hosted CPU whisper; raise it for a hosted backend.
  concurrency: 2,
};

function envInt(key: string, fallback: number): number {
  const n = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function voiceConfigFromEnv(): VoiceConfig {
  return {
    baseUrl: (process.env.TRANSLATE_VOICE_STT_URL || '').trim().replace(/\/+$/, ''),
    apiKey: (process.env.TRANSLATE_VOICE_STT_KEY || '').trim(),
    model: (process.env.TRANSLATE_VOICE_MODEL || DEFAULTS.model).trim(),
    language: (process.env.TRANSLATE_VOICE_LANGUAGE || '').trim(),
    prompt: (process.env.TRANSLATE_VOICE_PROMPT || '').trim(),
    timeoutMs: envInt('TRANSLATE_VOICE_TIMEOUT_MS', DEFAULTS.timeoutMs),
    maxBytes: envInt('TRANSLATE_VOICE_MAX_BYTES', DEFAULTS.maxBytes),
    maxPerHour: envInt('TRANSLATE_VOICE_MAX_PER_HOUR', DEFAULTS.maxPerHour),
    concurrency: envInt('TRANSLATE_VOICE_CONCURRENCY', DEFAULTS.concurrency),
    confusions: parseConfusions(process.env.TRANSLATE_VOICE_CONFUSIONS || ''),
    includeAudioFiles: (process.env.TRANSLATE_VOICE_INCLUDE_AUDIO || '').trim().toLowerCase() === 'true',
  };
}

export function voiceEnabled(cfg: VoiceConfig): boolean {
  return cfg.baseUrl !== '';
}

/**
 * Parse `TRANSLATE_VOICE_CONFUSIONS` — `intended=heard1,heard2; intended2=heard3` — into the map the
 * translation prompt is built from. Entries with no intended word or no variants are dropped rather
 * than emitted as a half-formed rule.
 */
export function parseConfusions(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const group of (raw || '').split(';')) {
    const [intended, variants] = group.split('=');
    const key = (intended || '').trim();
    const heard = (variants || '')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
    if (key && heard.length) out.set(key, heard);
  }
  return out;
}

/**
 * Whisper-style APIs sniff the audio format from the upload filename, not the Content-Type, so a
 * generic name makes Groq/OpenAI reject a perfectly valid WhatsApp opus note. Map the declared mime
 * (WhatsApp PTT is `audio/ogg; codecs=opus`) to the extension the backend expects.
 */
export function audioExtension(mimetype: string): string {
  const base = mimetype.split(';')[0].trim().toLowerCase();
  switch (base) {
    case 'audio/ogg':
    case 'audio/opus':
      return 'ogg';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
      return 'wav';
    case 'audio/webm':
      return 'webm';
    case 'audio/flac':
    case 'audio/x-flac':
      return 'flac';
    default:
      return 'ogg'; // WhatsApp voice notes are opus; a wrong guess fails loudly at the backend
  }
}

/** `<base>/v1/audio/transcriptions`, tolerating a base that already ends in `/v1`. */
export function transcriptionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
}

/**
 * Best-effort hourly spend guard, per chat. The STT backend is usually a paid per-second API and the
 * trigger is untrusted inbound audio, so an audio flood in one group is a direct cost amplification.
 * ponytail: in-memory rolling window, resets on restart — swap for the shared rate limiter if voice
 * ever needs a cross-process budget.
 */
export class HourlyCap {
  private hits = new Map<string, number[]>();

  constructor(private readonly max: number) {}

  take(key: string, now = Date.now()): boolean {
    const cutoff = now - 3_600_000;
    const kept = (this.hits.get(key) ?? []).filter(t => t > cutoff);
    if (kept.length >= this.max) {
      this.hits.set(key, kept);
      return false;
    }
    kept.push(now);
    this.hits.set(key, kept);
    return true;
  }
}

/** Per-segment decoder confidence, the numbers a hallucinated span shows up in. */
export interface TranscriptionConfidence {
  /** Highest `no_speech_prob` across segments — the model's own "nobody was talking here". */
  maxNoSpeech: number;
  /** Lowest `avg_logprob` across segments — the least-confident span it emitted. */
  minLogprob: number;
  segments: number;
}

export interface Transcription {
  text: string;
  /** Null when the backend returned plain `json` (no segment data) rather than `verbose_json`. */
  confidence: TranscriptionConfidence | null;
  /** Provider-reported quota from this call's response headers; null when it reports none. */
  quota: SttQuota | null;
}

/**
 * Reduce the segment array to the worst value of each metric. Whisper invents filler ("Cảm ơn.",
 * "Thank you") over trailing silence, and such a segment betrays itself with a high no_speech_prob or
 * a poor avg_logprob — so the worst segment, not the average, is the signal worth keeping.
 */
export function summarizeConfidence(segments: unknown): TranscriptionConfidence | null {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const noSpeech = segments.map(s => num((s as { no_speech_prob?: unknown })?.no_speech_prob, 0));
  const logprob = segments.map(s => num((s as { avg_logprob?: unknown })?.avg_logprob, 0));
  return { maxNoSpeech: Math.max(...noSpeech), minLogprob: Math.min(...logprob), segments: segments.length };
}

/** One recorded transcription, the row a `no_speech`/`logprob` threshold gets derived from. */
export interface VoiceStat {
  ts: number;
  model: string;
  ms: number;
  bytes: number;
  chars: number;
  noSpeech: number | null;
  logprob: number | null;
  segments: number | null;
  /** Truncated — enough to judge whether a low-confidence row was actually garbage. */
  text: string;
  /** Archived audio filename, when TRANSLATE_VOICE_ARCHIVE_DIR is set. Absent otherwise. */
  file?: string;
}

/**
 * Append one JSONL row to `data/voice-stats.jsonl`.
 *
 * The confidence numbers only ever reached `logger.log()`, and container logs die with the container —
 * so after months of voice traffic there was no sample to pick a threshold from. This is the durable
 * copy (named volume, survives restart/rebuild).
 *
 * ponytail: unbounded append, ~200B/note at a few notes a day. Rotate or prune when it matters.
 */
export function appendVoiceStat(
  stat: VoiceStat,
  file = process.env.TRANSLATE_VOICE_STATS_PATH || 'data/voice-stats.jsonl',
): void {
  try {
    fs.mkdirSync(path.dirname(file) || '.', { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...stat, text: stat.text.slice(0, 300) }) + '\n', 'utf8');
  } catch {
    // Stats are diagnostics: a full/read-only disk must never cost a voice note its translation.
  }
}

/**
 * Save the raw note so a model comparison has something to replay. OFF unless
 * TRANSLATE_VOICE_ARCHIVE_DIR is set: this writes real conversation audio to disk, so it's an explicit
 * opt-in for a measurement window, not a default. Turn it off and delete the directory when done.
 *
 * Returns the filename to record in the stat row, or '' if archiving is off or the write failed.
 */
export function archiveAudio(
  audio: Buffer,
  mimetype: string,
  ts: number,
  dir = process.env.TRANSLATE_VOICE_ARCHIVE_DIR || '',
): string {
  if (!dir) return '';
  const name = `${ts}.${audioExtension(mimetype)}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), audio);
    return name;
  } catch {
    return ''; // same rule as the stats row: diagnostics never cost a note its translation
  }
}

/**
 * One call to an OpenAI-compatible `/v1/audio/transcriptions`. Returns the transcript plus the decoder
 * confidence when the backend supplies segments. Throws on transport/HTTP failure so the caller can log
 * and drop — this runs off the receive pipeline, so a throw never blocks message delivery.
 */
export async function transcribe(audio: Buffer, mimetype: string, cfg: VoiceConfig): Promise<Transcription> {
  const form = new FormData();
  const bytes = new Uint8Array(audio);
  form.append('file', new Blob([bytes], { type: mimetype }), `audio.${audioExtension(mimetype)}`);
  form.append('model', cfg.model);
  // verbose_json for the per-segment confidence; `text` is present in both shapes, so a backend that
  // ignores the richer format still parses — only `confidence` comes back null.
  form.append('response_format', 'verbose_json');
  // Explicit 0 rather than relying on the backend default: greedy decoding leaves the model the least
  // room to invent. OpenAI/Groq already default to 0, so this mainly pins a self-hosted backend.
  form.append('temperature', '0');
  if (cfg.language) form.append('language', cfg.language);
  if (cfg.prompt) form.append('prompt', cfg.prompt);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(transcriptionsUrl(cfg.baseUrl), {
      method: 'POST',
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : undefined,
      body: form,
      signal: ac.signal,
    });
    if (!res.ok) {
      // Unlike translate-llm-client (status only), keep the body: the common setup failure is a model
      // name the backend doesn't have, and a bare 400 gives the operator nothing to act on.
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`STT ${res.status}: ${detail}`);
    }
    const json = (await res.json()) as { text?: unknown; segments?: unknown };
    return {
      text: typeof json.text === 'string' ? json.text.trim() : '',
      confidence: summarizeConfidence(json.segments),
      quota: quotaFromHeaders(res.headers),
    };
  } finally {
    clearTimeout(timer);
  }
}
