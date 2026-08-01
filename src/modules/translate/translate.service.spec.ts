import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TranslateService } from './translate.service';
import { HookManager } from '../../core/hooks';
import { MessageService } from '../message/message.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { parseCommand, type CommandDeps } from './translate-commands';
import { ContactService } from '../contact/contact.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

// Without this every suite in this file opens the REAL data/translations.sqlite, writing fixture rows
// into the production memory + candidate tables and racing the other jest workers for its write lock.
process.env.TRANSLATE_MEMORY_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'translate-spec-')),
  'translations.sqlite',
);

describe('TranslateService glossary', () => {
  let glossaryPath: string;
  let sendersPath: string;
  let sent: { chatId: string; text: string }[];
  let contactLookups: { phone: string | null; contact: { name?: string; pushName?: string } | null };
  let service: TranslateService;

  const makeMsg = (body: string): IncomingMessage =>
    ({
      chatId: 'g@g.us',
      from: 'u@c.us',
      author: 'u@c.us',
      body,
      type: 'text',
      isGroup: true,
      fromMe: false,
    }) as IncomingMessage;

  beforeEach(() => {
    glossaryPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-')), 'glossary.json');
    process.env.TRANSLATE_GLOSSARY_PATH = glossaryPath;
    sendersPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'send-')), 'senders.json');
    process.env.TRANSLATE_SENDERS_PATH = sendersPath;
    process.env.TRANSLATE_WATCHWORDS_PATH = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')),
      'watchwords.json',
    );
    process.env.TRANSLATE_FEEDBACK_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-')), 'bad-feedback.json');
    process.env.TRANSLATE_CONFIG_PATH = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'tcfg-')),
      'translate-config.json',
    );
    sent = [];
    const messageService = {
      sendText: (_s: string, dto: { chatId: string; text: string }) => {
        sent.push(dto);
        return Promise.resolve({} as never);
      },
    } as unknown as MessageService;
    contactLookups = { phone: null, contact: null };
    const contactService = {
      resolveContactPhone: () => Promise.resolve(contactLookups.phone),
      getContactById: () =>
        contactLookups.contact ? Promise.resolve(contactLookups.contact) : Promise.reject(new Error('not found')),
    } as unknown as ContactService;
    service = new TranslateService(new HookManager(), messageService, contactService);
    service.onModuleInit(); // loads (absent) glossary from the temp path
  });

  // Poke private runtime config directly — cheaper than updateConfig() persisting to the temp path.
  const poke = (patch: Record<string, unknown>): void => {
    Object.assign((service as unknown as { cfg: Record<string, unknown> }).cfg, patch);
  };

  // Drive the real dispatch table: parse → spec.handle, with deps pulled from the service internals.
  const cmd = (body: string): Promise<void> => {
    const parsed = parseCommand(body.trim());
    if (!parsed) throw new Error(`not a command: ${body}`);
    const svc = service as unknown as CommandDeps;
    return parsed.spec.handle({
      deps: {
        glossary: svc.glossary,
        adminIds: svc.adminIds,
        messageService: svc.messageService,
        watchwords: svc.watchwords,
        feedback: svc.feedback,
      },
      sessionId: 'sess',
      msg: makeMsg(body),
      raw: body,
      rest: parsed.rest,
    });
  };

  it('add writes both directions and persists', async () => {
    await cmd('/glossary add 出貨 = giao hàng');
    const saved = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
    expect(saved['zh-tw:vi']['出貨']).toBe('giao hàng');
    expect(saved['vi:zh-tw']['giao hàng']).toBe('出貨');
  });

  it('del removes the pairing named from either side', async () => {
    await cmd('/glossary add 出貨 = giao hàng');
    await cmd('/glossary del giao hàng'); // name the Vietnamese side
    const saved = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
    expect(saved['zh-tw:vi']['出貨']).toBeUndefined();
    expect(saved['vi:zh-tw']['giao hàng']).toBeUndefined();
  });

  it('/g alias strips the short token and routes to the glossary', async () => {
    await cmd('/g 出貨 = giao hàng');
    const saved = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
    expect(saved['zh-tw:vi']['出貨']).toBe('giao hàng');
  });

  it('multi-line /g batch adds every line and replies once', async () => {
    await cmd('/g\n/g 資安 = ATTT\n/g 稽核 = Đánh giá\n/g 漏洞 = Lỗ hổng');
    const saved = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
    expect(saved['zh-tw:vi']['資安']).toBe('ATTT');
    expect(saved['zh-tw:vi']['稽核']).toBe('Đánh giá');
    expect(saved['zh-tw:vi']['漏洞']).toBe('Lỗ hổng');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('已新增術語：資安 ⇄ ATTT');
  });

  it('detects zh and vi source directions', () => {
    const detect = (service as unknown as { detectPair: (t: string) => { key: string } | null }).detectPair.bind(
      service,
    );
    expect(detect('今天出貨')?.key).toBe('zh-tw:vi');
    expect(detect('giao hàng hôm nay')?.key).toBe('vi:zh-tw');
    expect(detect('12345')).toBeNull();
  });

  it('mixed script decides by dominant text, not first CJK char', () => {
    const detect = (service as unknown as { detectPair: (t: string) => { key: string } | null }).detectPair.bind(
      service,
    );
    // A Vietnamese message @-mentioning a Chinese name must still translate TO Chinese.
    expect(detect('Báo cáo Giám đốc @VPIC1 陳嘉元, phòng 201 đã hoạt động.')?.key).toBe('vi:zh-tw');
    // A Chinese message quoting a Vietnamese place name stays Chinese→Vietnamese.
    expect(detect('我下週去 Đà Nẵng 出差三天談合約事宜')?.key).toBe('zh-tw:vi');
  });

  it('translates an image caption (media with text is not skipped)', async () => {
    const fetchMock = jest.fn(
      async () => ({ ok: true, json: async () => ({ message: { content: '報告主管' } }) }) as never,
    );
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    poke({
      enabled: true,
      llmProvider: 'ollama',
      llmEndpoint: 'http://x/api/chat',
      llmModel: 'qwen3:8b',
      groupIds: new Set(['g@g.us']),
      minSendIntervalMs: 0,
    });
    const msg = { ...makeMsg('Báo cáo Sếp'), type: 'image' } as IncomingMessage;
    await (
      service as unknown as {
        onMessage: (c: unknown, s: boolean) => Promise<unknown>;
      }
    ).onMessage({ data: msg, sessionId: 'sess' }, false);
    await (service as unknown as { queue: Promise<unknown> }).queue;

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('報告主管');
  });

  it('cost guards: skips over-long messages and throttles per group per minute', async () => {
    const fetchMock = jest.fn(
      async () => ({ ok: true, json: async () => ({ message: { content: '報告主管' } }) }) as never,
    );
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    poke({
      enabled: true,
      llmProvider: 'ollama',
      llmEndpoint: 'http://x/api/chat',
      llmModel: 'qwen3:8b',
      groupIds: new Set(['g@g.us']),
      minSendIntervalMs: 0,
      maxMessageLength: 10,
      maxTranslationsPerMinute: 2,
    });
    const fire = async (body: string) => {
      await (service as unknown as { onMessage: (c: unknown, s: boolean) => Promise<unknown> }).onMessage(
        { data: makeMsg(body), sessionId: 'sess' },
        false,
      );
      await (service as unknown as { queue: Promise<unknown> }).queue;
    };
    await fire('今天出貨了嗎現在幾點鐘'); // 11 chars > cap → skipped
    expect(sent).toHaveLength(0);
    await fire('今天出貨');
    await fire('今天出貨');
    await fire('今天出貨'); // 3rd within the minute → throttled
    expect(sent).toHaveLength(2);
  });

  it('applies the sender override to the @mention before sending the prompt to Ollama', async () => {
    service.senderStore.add('200859128434777', '總經理');
    let promptSent = '';
    const fetchMock = jest.fn(async (_url: string, init: { body: string }) => {
      promptSent = JSON.parse(init.body).messages[0].content as string;
      return { ok: true, json: async () => ({ message: { content: '報告總經理' } }) } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;

    const translate = (
      service as unknown as {
        translate: (t: string, p: { key: string }) => Promise<string>;
      }
    ).translate.bind(service);
    await translate('報告給@200859128434777以及其他同事', { key: 'zh-tw:vi' } as never);

    expect(fetchMock).toHaveBeenCalled();
    // Since #96 apply() substitutes the bare name — the @ is dropped for resolved mentions.
    expect(promptSent).toContain('報告給總經理以及其他同事');
    expect(promptSent).not.toContain('@200859128434777');
  });

  it('auto-names a pending @lid mention via the lid->phone mapping, then falls back to the contact record', async () => {
    const resolve = (
      service as unknown as {
        resolvePendingSenders: (s: string, j: string[]) => void;
      }
    ).resolvePendingSenders.bind(service);
    const flush = () => new Promise(r => setImmediate(r));

    // lid known to the phone-keyed table
    service.senderStore.add('84912830550', '陳嘉元');
    service.senderStore.notePending(['216659658829884@lid'], '@216659658829884 xin chào');
    contactLookups.phone = '84912830550';
    resolve('sess', ['216659658829884@lid']);
    await flush();
    expect(service.senderStore.nameOf('216659658829884')).toBe('陳嘉元');

    // no phone mapping → contact record's pushName wins
    service.senderStore.notePending(['133518235533349@lid'], '@133518235533349 ok');
    contactLookups.phone = null;
    contactLookups.contact = { pushName: 'Hoàng Linh' };
    resolve('sess', ['133518235533349@lid']);
    await flush();
    expect(service.senderStore.nameOf('133518235533349')).toBe('Hoàng Linh');

    // both fail → stays pending, and the key isn't re-queried
    service.senderStore.notePending(['212150496804930@lid'], '@212150496804930 ?');
    contactLookups.contact = null;
    resolve('sess', ['212150496804930@lid']);
    await flush();
    expect(service.senderStore.nameOf('212150496804930')).toBe('');
  });

  it('backfill fills every pending entry it can name and counts only the ones it filled', async () => {
    service.senderStore.notePending(['216659658829884@lid'], '@216659658829884 a');
    service.senderStore.notePending(['133518235533349@lid'], '@133518235533349 b');
    service.senderStore.add('84912830550', '陳嘉元');
    contactLookups.contact = { name: 'Cuong' }; // no phone mapping for either → contact record for both

    expect(await service.backfillSenders('sess')).toBe(2);
    expect(service.senderStore.nameOf('216659658829884')).toBe('Cuong');
    expect(service.senderStore.nameOf('84912830550')).toBe('陳嘉元'); // named rows untouched
    expect(await service.backfillSenders('sess')).toBe(0); // nothing pending left
  });

  it('strips a reasoning model <think> block so the group gets only the translation', async () => {
    poke({ llmProvider: 'ollama', llmEndpoint: 'http://x/api/chat', llmModel: 'qwen3:8b' });
    const fetchMock = jest.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            message: { content: '<think>越文翻成中文\n判斷語氣</think>\n\n報告總經理，會議已開始' },
          }),
        }) as never,
    );
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    const translate = (
      service as unknown as { translate: (t: string, p: { key: string }) => Promise<string> }
    ).translate.bind(service);
    expect(await translate('Báo cáo Giám đốc', { key: 'vi:zh-tw' } as never)).toBe('報告總經理，會議已開始');
  });

  it('lists models from the right URL per provider (keeps Groq /openai/v1 prefix)', async () => {
    const urls: string[] = [];
    const fetchMock = jest.fn(async (url: string) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ models: [{ name: 'm' }], data: [{ id: 'm' }] }) } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    const svc = service as unknown as {
      listModels: (p: { provider: string; endpoint: string; apiKey: string }) => Promise<string[]>;
    };
    await svc.listModels({ provider: 'ollama', endpoint: 'http://192.168.40.168:11434/api/chat', apiKey: '' });
    await svc.listModels({
      provider: 'groq',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: 'k',
    });
    await svc.listModels({ provider: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'k' });

    expect(urls[0]).toBe('http://192.168.40.168:11434/api/tags');
    expect(urls[1]).toBe('https://api.groq.com/openai/v1/models'); // prefix preserved
    expect(urls[2]).toBe('https://api.openai.com/v1/models');
  });

  it('backfills the stored key only when the probe targets the saved endpoint (no key exfil on a changed endpoint)', async () => {
    poke({ llmProvider: 'groq', llmEndpoint: 'https://api.groq.com/openai/v1/chat/completions', llmApiKey: 'secret' });
    const auth: (string | undefined)[] = [];
    const fetchMock = jest.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      auth.push(init?.headers?.authorization);
      return { ok: true, json: async () => ({ data: [{ id: 'm' }] }) } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    const svc = service as unknown as {
      listModels: (p: { provider: string; endpoint: string; apiKey: string }) => Promise<string[]>;
    };
    // Same endpoint, blank key → stored key is backfilled.
    await svc.listModels({ provider: 'groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: '' });
    // Attacker-controlled endpoint, blank key → key must NOT be sent.
    await svc.listModels({ provider: 'groq', endpoint: 'https://evil.example/v1/chat/completions', apiKey: '' });
    expect(auth[0]).toBe('Bearer secret');
    expect(auth[1]).toBeUndefined();
  });

  it('falls back to the next model when the primary model call fails', async () => {
    poke({
      llmProvider: 'ollama',
      llmEndpoint: 'http://x/api/chat',
      llmModel: 'primary',
      llmFallbackModels: ['backup'],
    });
    const tried: string[] = [];
    const fetchMock = jest.fn(async (_url: string, init: { body: string }) => {
      const model = JSON.parse(init.body).model as string;
      tried.push(model);
      if (model === 'primary') return { ok: false, status: 500 } as never;
      return { ok: true, json: async () => ({ message: { content: 'dịch xong' } }) } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;

    const translate = (
      service as unknown as {
        translate: (t: string, p: { key: string }) => Promise<string>;
      }
    ).translate.bind(service);
    const out = await translate('你好', { key: 'zh-tw:vi' } as never);

    expect(tried).toEqual(['primary', 'backup']);
    expect(out).toBe('Dịch xong');
  });

  it('trips the primary after 2 failures and stops paying its timeout on later messages', async () => {
    poke({
      llmProvider: 'ollama',
      llmEndpoint: 'http://x/api/chat',
      llmModel: 'primary',
      llmFallbackModels: ['backup'],
    });
    const tried: string[] = [];
    const fetchMock = jest.fn(async (_url: string, init: { body: string }) => {
      const model = JSON.parse(init.body).model as string;
      tried.push(model);
      if (model === 'primary') return { ok: false, status: 500 } as never;
      return { ok: true, json: async () => ({ message: { content: 'ok' } }) } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;

    const translate = (
      service as unknown as {
        translate: (t: string, p: { key: string }) => Promise<string>;
      }
    ).translate.bind(service);
    for (let i = 0; i < 4; i++) await translate(`你好${i}`, { key: 'zh-tw:vi' } as never);

    // Messages 1-2 probe the dead primary; after it trips, 3-4 go straight to the backup.
    expect(tried).toEqual(['primary', 'backup', 'primary', 'backup', 'backup', 'backup']);
  });

  it('retries once on Groq 429 honoring Retry-After, then succeeds', async () => {
    poke({
      llmProvider: 'groq',
      llmEndpoint: 'https://api.groq.com/openai/v1/chat/completions',
      llmModel: 'qwen',
      llmApiKey: 'k',
    });
    let calls = 0;
    const fetchMock = jest.fn(async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 429, headers: { get: (h: string) => (h === 'retry-after' ? '0' : null) } } as never;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'dịch xong' } }] }),
      } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    const translate = (
      service as unknown as { translate: (t: string, p: { key: string }) => Promise<string> }
    ).translate.bind(service);
    const out = await translate('你好', { key: 'vi:zh-tw' } as never);
    expect(calls).toBe(2);
    expect(out).toBe('dịch xong');
  });

  it('updateConfig merges llmProviderConfigs — a partial/empty payload never wipes other providers', () => {
    poke({
      llmProviderConfigs: {
        gemini: { endpoint: 'g', model: 'gemini-2.5-flash', apiKey: 'gk' },
        groq: { endpoint: 'q', model: 'qwen', apiKey: 'qk' },
        ollama: { endpoint: 'o', model: 'qwen3:8b' },
      },
    });
    const keys = () =>
      Object.keys((service as unknown as { cfg: { llmProviderConfigs: object } }).cfg.llmProviderConfigs).sort();
    // Empty payload (e.g. a stale Translate-page snapshot) must not drop anything.
    service.updateConfig({ llmProviderConfigs: {} });
    expect(keys()).toEqual(['gemini', 'groq', 'ollama']);
    // Subset payload updates only that provider, preserves the rest and their stored keys.
    service.updateConfig({ llmProviderConfigs: { gemini: { endpoint: 'g2', model: 'm2', apiKey: '' } } });
    const pc = (
      service as unknown as { cfg: { llmProviderConfigs: Record<string, { endpoint?: string; apiKey?: string }> } }
    ).cfg.llmProviderConfigs;
    expect(keys()).toEqual(['gemini', 'groq', 'ollama']);
    expect(pc.gemini.endpoint).toBe('g2'); // updated
    expect(pc.gemini.apiKey).toBe('gk'); // blank kept the stored key
    expect(pc.groq.apiKey).toBe('qk'); // untouched provider preserved
  });

  it('preview(text, provider) runs the requested configured provider, not the active one', async () => {
    poke({
      llmProvider: 'gemini',
      llmEndpoint: 'https://gen.example/v1beta',
      llmModel: 'gemini-2.5-flash',
      llmApiKey: 'gkey',
      llmProviderConfigs: {
        groq: {
          endpoint: 'https://api.groq.com/openai/v1/chat/completions',
          apiKey: 'qkey',
          model: 'qwen/qwen3.6-27b',
        },
      },
    });
    let calledUrl = '';
    let calledModel = '';
    const fetchMock = jest.fn(async (url: string, init?: { body?: string }) => {
      calledUrl = String(url);
      calledModel = JSON.parse(init?.body ?? '{}').model;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'xin chào' } }] }),
      } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    const res = await service.preview('你好', 'groq');
    expect(calledUrl).toContain('groq'); // hit Groq, not Gemini
    expect(calledModel).toBe('qwen/qwen3.6-27b');
    expect(res).toEqual({ pair: 'zh-tw:vi', translated: 'Xin chào' });
  });

  it('preview throws when the requested provider is not configured', async () => {
    poke({
      llmProvider: 'gemini',
      llmEndpoint: 'https://gen.example/v1beta',
      llmModel: 'gemini-2.5-flash',
      llmProviderConfigs: {},
    });
    await expect(service.preview('你好', 'groq')).rejects.toThrow(/not configured/);
  });

  it('cross-provider fallback: gemini fails, groq:model resolves from providerConfigs and succeeds', async () => {
    poke({
      llmProvider: 'gemini',
      llmEndpoint: 'https://gen.example/v1beta',
      llmModel: 'gemini-2.5-flash',
      llmApiKey: 'gkey',
      llmFallbackModels: ['groq:llama-3.3-70b-versatile'],
      llmProviderConfigs: {
        groq: { endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: 'qkey', model: 'x' },
      },
    });
    let groqAuth = '';
    let groqModel = '';
    const fetchMock = jest.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      if (String(url).includes('gen.example')) return { ok: false, status: 500 } as never;
      groqAuth = init?.headers?.authorization ?? '';
      groqModel = JSON.parse(init?.body ?? '{}').model;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'xin chào' } }] }),
      } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    const translate = (
      service as unknown as { translate: (t: string, p: { key: string }) => Promise<string> }
    ).translate.bind(service);
    const out = await translate('你好', { key: 'zh-tw:vi' } as never);
    expect(groqAuth).toBe('Bearer qkey'); // used the saved groq key, not the active gemini key
    expect(groqModel).toBe('llama-3.3-70b-versatile');
    expect(out).toBe('Xin chào'); // fixViCasing still applied on the cross-provider output
  });

  it('routes to the OpenAI-compatible shape and parses choices when provider=openai', async () => {
    poke({
      llmProvider: 'openai',
      llmEndpoint: 'https://api.openai.com/v1/chat/completions',
      llmApiKey: 'sk-x',
    });
    let authHeader = '';
    const fetchMock = jest.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      authHeader = init.headers.authorization;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'xin chào' } }] }) } as never;
    });
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;

    const translate = (
      service as unknown as {
        translate: (t: string, p: { key: string }) => Promise<string>;
      }
    ).translate.bind(service);
    const out = await translate('你好', { key: 'zh-tw:vi' } as never);

    expect(out).toBe('Xin chào');
    expect(authHeader).toBe('Bearer sk-x');
  });
});

describe('TranslateService voice notes', () => {
  let sent: { chatId: string; text: string }[];
  let service: TranslateService;

  const voiceMsg = (over: Partial<IncomingMessage> = {}): IncomingMessage =>
    ({
      chatId: 'g@g.us',
      from: 'u@c.us',
      author: 'u@c.us',
      body: '',
      type: 'voice',
      isGroup: true,
      fromMe: false,
      media: { mimetype: 'audio/ogg; codecs=opus', data: Buffer.from('opus').toString('base64') },
      ...over,
    }) as IncomingMessage;

  beforeEach(() => {
    const tmp = (p: string, f: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), p)), f);
    process.env.TRANSLATE_GLOSSARY_PATH = tmp('gloss-', 'glossary.json');
    process.env.TRANSLATE_SENDERS_PATH = tmp('send-', 'senders.json');
    process.env.TRANSLATE_WATCHWORDS_PATH = tmp('watch-', 'watchwords.json');
    process.env.TRANSLATE_FEEDBACK_PATH = tmp('fb-', 'bad-feedback.json');
    process.env.TRANSLATE_CONFIG_PATH = tmp('tcfg-', 'translate-config.json');
    sent = [];
    const messageService = {
      sendText: (_s: string, dto: { chatId: string; text: string }) => {
        sent.push(dto);
        return Promise.resolve({} as never);
      },
    } as unknown as MessageService;
    const contactService = {
      resolveContactPhone: () => Promise.resolve(null),
      getContactById: () => Promise.reject(new Error('not found')),
    } as unknown as ContactService;
    service = new TranslateService(new HookManager(), messageService, contactService);
    service.onModuleInit();
    Object.assign((service as unknown as { cfg: Record<string, unknown> }).cfg, {
      enabled: true,
      llmProvider: 'ollama',
      llmEndpoint: 'http://x/api/chat',
      llmModel: 'qwen3:8b',
      groupIds: new Set(['g@g.us']),
      minSendIntervalMs: 0,
    });
    Object.assign((service as unknown as { voice: Record<string, unknown> }).voice, {
      baseUrl: 'http://stt',
      model: 'whisper-large-v3-turbo',
      apiKey: '',
      language: '',
      prompt: '',
      timeoutMs: 5000,
      maxBytes: 1024,
      maxPerHour: 60,
      includeAudioFiles: false,
      confusions: new Map([['bot', ['boss', 'Bob', 'bioti']]]),
    });
  });

  // STT then LLM off the same mock: the transcriptions URL is the discriminator.
  const mockBackends = (transcript: string, translation: string) => {
    const fetchMock = jest.fn(async (url: string) =>
      String(url).includes('/audio/transcriptions')
        ? ({
            ok: true,
            json: async () => ({ text: transcript, segments: [{ no_speech_prob: 0.02, avg_logprob: -0.3 }] }),
          } as never)
        : ({ ok: true, json: async () => ({ message: { content: translation } }) } as never),
    );
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    return fetchMock;
  };

  const run = async (msg: IncomingMessage) => {
    await (
      service as unknown as {
        transcribeAndTranslate: (s: string, m: IncomingMessage) => Promise<void>;
      }
    ).transcribeAndTranslate('sess', msg);
    await (service as unknown as { queue: Promise<unknown> }).queue;
  };

  it('transcribes then translates, echoing the transcript above the translation', async () => {
    mockBackends('Báo cáo Sếp', '報告主管');
    await run(voiceMsg());

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('🎙 Báo cáo Sếp');
    expect(sent[0].text).toContain('報告主管');
    // BOT_MARKER must stay first or the sent-path hook re-translates the bot's own message.
    expect(sent[0].text.indexOf('🎙')).toBeGreaterThan(0);
  });

  it('routes a voice message from the hook into the voice path, not the caption path', async () => {
    const spy = jest.fn(async () => undefined);
    (service as unknown as { transcribeAndTranslate: unknown }).transcribeAndTranslate = spy;
    await (
      service as unknown as {
        onMessage: (c: unknown, s: boolean) => Promise<unknown>;
      }
    ).onMessage({ data: voiceMsg(), sessionId: 'sess' }, false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no STT endpoint is configured', async () => {
    (service as unknown as { voice: { baseUrl: string } }).voice.baseUrl = '';
    const fetchMock = mockBackends('x', 'y');
    await run(voiceMsg());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('skips an audio file unless includeAudioFiles is on', async () => {
    const fetchMock = mockBackends('Báo cáo Sếp', '報告主管');
    await run(voiceMsg({ type: 'audio' }));
    expect(fetchMock).not.toHaveBeenCalled();

    (service as unknown as { voice: { includeAudioFiles: boolean } }).voice.includeAudioFiles = true;
    await run(voiceMsg({ type: 'audio' }));
    expect(sent).toHaveLength(1);
  });

  it('skips a note whose blob was dropped by the inbound media cap', async () => {
    const fetchMock = mockBackends('x', 'y');
    await run(voiceMsg({ media: { mimetype: 'audio/ogg', omitted: true, sizeBytes: 99 } } as Partial<IncomingMessage>));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips a note over maxBytes', async () => {
    (service as unknown as { voice: { maxBytes: number } }).voice.maxBytes = 2;
    const fetchMock = mockBackends('x', 'y');
    await run(voiceMsg());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tells the translating model the text came from speech — and only for the voice path', async () => {
    const prompts: string[] = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init: { body: string }) => {
      if (String(url).includes('/audio/transcriptions')) {
        return { ok: true, json: () => Promise.resolve({ text: 'Con Boss này xịn đấy sếp' }) };
      }
      prompts.push(JSON.parse(init.body).messages[0].content as string);
      return { ok: true, json: () => Promise.resolve({ message: { content: '這個機器人真厲害' } }) };
    });

    await run(voiceMsg());
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('語音辨識結果');
    expect(prompts[0]).toContain('boss、Bob、bioti → bot'); // the named confusion, not generic advice
    expect(prompts[0]).toContain('Con Boss này xịn đấy sếp'); // the raw transcript, not a rewrite

    // A typed message must NOT carry the hint, or the model gets licence to rewrite what was typed.
    await (
      service as unknown as {
        onMessage: (c: unknown, s: boolean) => Promise<unknown>;
      }
    ).onMessage(
      { data: { ...voiceMsg(), type: 'text', body: 'Báo cáo Sếp', media: undefined }, sessionId: 'sess' },
      false,
    );
    await (service as unknown as { queue: Promise<unknown> }).queue;

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain('語音辨識結果');
  });

  it('logs the transcript on success so STT accuracy is observable', async () => {
    const log = jest
      .spyOn((service as unknown as { logger: { log: (m: string) => void } }).logger, 'log')
      .mockImplementation(() => undefined);
    mockBackends('Con bot này xịn đấy sếp', '這個機器人真厲害');
    await run(voiceMsg());

    const line = log.mock.calls.map(c => String(c[0])).find(m => m.includes('Voice transcribed'));
    expect(line).toBeDefined();
    expect(line).toContain('Con bot này xịn đấy sếp'); // the transcript itself, not just a count
    expect(line).toMatch(/\d+ms/);
    expect(line).toContain('g@g.us');
    // Decoder confidence is recorded so a hallucination threshold can be derived from real traffic.
    expect(line).toContain('no_speech=0.020');
    expect(line).toContain('logprob=-0.300');
    log.mockRestore();
  });

  it('still logs and sends when the backend returns no segment data', async () => {
    const log = jest
      .spyOn((service as unknown as { logger: { log: (m: string) => void } }).logger, 'log')
      .mockImplementation(() => undefined);
    // A backend that ignores verbose_json returns plain {text} — must degrade, not crash.
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) =>
      String(url).includes('/audio/transcriptions')
        ? { ok: true, json: () => Promise.resolve({ text: 'Báo cáo Sếp' }) }
        : { ok: true, json: () => Promise.resolve({ message: { content: '報告主管' } }) },
    );
    await run(voiceMsg());

    const line = log.mock.calls.map(c => String(c[0])).find(m => m.includes('Voice transcribed'));
    expect(line).toBeDefined();
    expect(line).not.toContain('no_speech');
    expect(sent).toHaveLength(1);
    log.mockRestore();
  });

  it('does not spend hourly budget on a note rejected for size', async () => {
    const svc = service as unknown as { voice: { maxBytes: number }; voiceCap: { take: (k: string) => boolean } };
    const take = jest.spyOn(svc.voiceCap, 'take');
    svc.voice.maxBytes = 2;
    mockBackends('Báo cáo Sếp', '報告主管');
    await run(voiceMsg());
    expect(take).not.toHaveBeenCalled();

    // ...and a note within the limit still does.
    svc.voice.maxBytes = 1024;
    await run(voiceMsg());
    expect(take).toHaveBeenCalledTimes(1);
  });

  it('bounds concurrent STT calls so a burst cannot fan out', async () => {
    (service as unknown as { voiceLimiter: unknown }).voiceLimiter = new ConcurrencyLimiter(2);
    let inFlight = 0;
    let peak = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      if (!String(url).includes('/audio/transcriptions')) {
        return { ok: true, json: () => Promise.resolve({ message: { content: '報告主管' } }) } as never;
      }
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return { ok: true, json: () => Promise.resolve({ text: 'Báo cáo Sếp' }) } as never;
    });

    const svc = service as unknown as {
      transcribeAndTranslate: (s: string, m: IncomingMessage) => Promise<void>;
    };
    await Promise.all([1, 2, 3, 4, 5].map(() => svc.transcribeAndTranslate('sess', voiceMsg())));
    await (service as unknown as { queue: Promise<unknown> }).queue;

    expect(peak).toBe(2);
    expect(sent).toHaveLength(5);
  });

  it('enforces the hourly cap', async () => {
    (service as unknown as { voiceCap: { max: number } }).voiceCap = new (
      require('./translate-voice') as { HourlyCap: new (n: number) => unknown }
    ).HourlyCap(1) as never;
    mockBackends('Báo cáo Sếp', '報告主管');
    await run(voiceMsg());
    await run(voiceMsg());
    expect(sent).toHaveLength(1);
  });

  it('sends nothing when the transcript comes back empty', async () => {
    mockBackends('', '報告主管');
    await run(voiceMsg());
    expect(sent).toHaveLength(0);
  });

  it('swallows an STT failure without throwing into the receive pipeline', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'bad key',
    }));
    await expect(run(voiceMsg())).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
