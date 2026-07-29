import {
  HourlyCap,
  audioExtension,
  transcribe,
  transcriptionsUrl,
  voiceConfigFromEnv,
  voiceEnabled,
} from './translate-voice';

const baseCfg = {
  baseUrl: 'https://api.groq.com/openai',
  apiKey: 'k',
  model: 'whisper-large-v3-turbo',
  language: '',
  timeoutMs: 5000,
  maxBytes: 1024,
  maxPerHour: 60,
  includeAudioFiles: false,
};

describe('transcriptionsUrl', () => {
  it('appends /v1/audio/transcriptions to a bare base', () => {
    expect(transcriptionsUrl('https://api.groq.com/openai')).toBe(
      'https://api.groq.com/openai/v1/audio/transcriptions',
    );
  });

  it('does not double the /v1 when the base already has it', () => {
    expect(transcriptionsUrl('http://localhost:8000/v1')).toBe('http://localhost:8000/v1/audio/transcriptions');
  });

  it('tolerates a trailing slash', () => {
    expect(transcriptionsUrl('http://localhost:8000/')).toBe('http://localhost:8000/v1/audio/transcriptions');
  });
});

describe('audioExtension', () => {
  it('maps the WhatsApp PTT mime (with codecs param) to ogg', () => {
    expect(audioExtension('audio/ogg; codecs=opus')).toBe('ogg');
  });

  it('maps common audio mimes', () => {
    expect(audioExtension('audio/mpeg')).toBe('mp3');
    expect(audioExtension('audio/x-m4a')).toBe('m4a');
    expect(audioExtension('audio/wav')).toBe('wav');
  });

  it('falls back to ogg for an unknown mime', () => {
    expect(audioExtension('application/octet-stream')).toBe('ogg');
  });
});

describe('HourlyCap', () => {
  it('allows up to max then blocks within the window', () => {
    const cap = new HourlyCap(2);
    expect(cap.take('a', 1000)).toBe(true);
    expect(cap.take('a', 1000)).toBe(true);
    expect(cap.take('a', 1000)).toBe(false);
  });

  it('is per key', () => {
    const cap = new HourlyCap(1);
    expect(cap.take('a', 1000)).toBe(true);
    expect(cap.take('b', 1000)).toBe(true);
    expect(cap.take('a', 1000)).toBe(false);
  });

  it('lets the window roll off after an hour', () => {
    const cap = new HourlyCap(1);
    expect(cap.take('a', 1000)).toBe(true);
    expect(cap.take('a', 1000 + 3_600_001)).toBe(true);
  });
});

describe('voiceEnabled / voiceConfigFromEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is disabled with no STT url', () => {
    delete process.env.TRANSLATE_VOICE_STT_URL;
    expect(voiceEnabled(voiceConfigFromEnv())).toBe(false);
  });

  it('is enabled once the url is set, and strips a trailing slash', () => {
    process.env.TRANSLATE_VOICE_STT_URL = 'https://api.groq.com/openai/';
    const cfg = voiceConfigFromEnv();
    expect(voiceEnabled(cfg)).toBe(true);
    expect(cfg.baseUrl).toBe('https://api.groq.com/openai');
  });

  it('falls back to defaults for garbage numeric overrides', () => {
    process.env.TRANSLATE_VOICE_STT_URL = 'http://x';
    process.env.TRANSLATE_VOICE_MAX_PER_HOUR = 'nope';
    process.env.TRANSLATE_VOICE_TIMEOUT_MS = '-5';
    process.env.TRANSLATE_VOICE_CONCURRENCY = '';
    const cfg = voiceConfigFromEnv();
    expect(cfg.maxPerHour).toBe(60);
    expect(cfg.timeoutMs).toBe(30_000);
    expect(cfg.concurrency).toBe(2);
  });
});

describe('transcribe', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('posts multipart to the right url and returns the text', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return { ok: true, json: async () => ({ text: '  xin chào  ' }) };
    }) as unknown as typeof fetch;

    const out = await transcribe(Buffer.from('abc'), 'audio/ogg; codecs=opus', baseCfg);

    expect(out).toBe('xin chào');
    expect(captured!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    const form = captured!.init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('language')).toBeNull(); // blank language must not be sent (auto-detect)
    expect((form.get('file') as File).name).toBe('audio.ogg');
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('sends a language hint when configured', async () => {
    let form: FormData | null = null;
    global.fetch = jest.fn(async (_url: string, init: RequestInit) => {
      form = init.body as FormData;
      return { ok: true, json: async () => ({ text: 'hi' }) };
    }) as unknown as typeof fetch;

    await transcribe(Buffer.from('abc'), 'audio/ogg', { ...baseCfg, language: 'vi' });
    expect(form!.get('language')).toBe('vi');
  });

  it('omits the auth header for a keyless local backend', async () => {
    let init: RequestInit | null = null;
    global.fetch = jest.fn(async (_url: string, i: RequestInit) => {
      init = i;
      return { ok: true, json: async () => ({ text: 'hi' }) };
    }) as unknown as typeof fetch;

    await transcribe(Buffer.from('abc'), 'audio/ogg', { ...baseCfg, apiKey: '' });
    expect(init!.headers).toBeUndefined();
  });

  it('throws with the status and body on an HTTP error', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'model_not_found',
    })) as unknown as typeof fetch;

    await expect(transcribe(Buffer.from('abc'), 'audio/ogg', baseCfg)).rejects.toThrow(/STT 400: model_not_found/);
  });

  it('returns empty string when the backend omits text', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await transcribe(Buffer.from('abc'), 'audio/ogg', baseCfg)).toBe('');
  });
});
