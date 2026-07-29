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
  timeoutMs: number;
  maxBytes: number;
  maxPerHour: number;
  concurrency: number;
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
    timeoutMs: envInt('TRANSLATE_VOICE_TIMEOUT_MS', DEFAULTS.timeoutMs),
    maxBytes: envInt('TRANSLATE_VOICE_MAX_BYTES', DEFAULTS.maxBytes),
    maxPerHour: envInt('TRANSLATE_VOICE_MAX_PER_HOUR', DEFAULTS.maxPerHour),
    concurrency: envInt('TRANSLATE_VOICE_CONCURRENCY', DEFAULTS.concurrency),
    includeAudioFiles: (process.env.TRANSLATE_VOICE_INCLUDE_AUDIO || '').trim().toLowerCase() === 'true',
  };
}

export function voiceEnabled(cfg: VoiceConfig): boolean {
  return cfg.baseUrl !== '';
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

/**
 * One call to an OpenAI-compatible `/v1/audio/transcriptions`. Returns the transcript, or '' when the
 * backend produced nothing usable. Throws on transport/HTTP failure so the caller can log and drop —
 * this runs off the receive pipeline, so a throw never blocks message delivery.
 */
export async function transcribe(audio: Buffer, mimetype: string, cfg: VoiceConfig): Promise<string> {
  const form = new FormData();
  const bytes = new Uint8Array(audio);
  form.append('file', new Blob([bytes], { type: mimetype }), `audio.${audioExtension(mimetype)}`);
  form.append('model', cfg.model);
  form.append('response_format', 'json');
  if (cfg.language) form.append('language', cfg.language);

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
    const json = (await res.json()) as { text?: unknown };
    return typeof json.text === 'string' ? json.text.trim() : '';
  } finally {
    clearTimeout(timer);
  }
}
