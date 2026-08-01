import { Injectable, OnModuleInit, BadRequestException } from '@nestjs/common';
import { HookManager, HookContext, HookResult } from '../../core/hooks';
import { MessageService } from '../message/message.service';
import { ContactService } from '../contact/contact.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { Glossary } from './translate-glossary';
import { SenderDirectory } from './translate-senders';
import { ShorthandTable } from './translate-shorthand';
import { WatchwordStore } from './translate-watchwords';
import { FeedbackStore } from './translate-feedback';
import { CategoryStore } from './translate-categories';
import { TranslationMemory, type Candidate } from './translate-memory';
import { PhraseCandidates, type PhraseCandidate, type PhraseStats } from './translate-phrase-candidates';
import { minePhrases } from './translate-phrase-miner';
import {
  BOT_MARKER,
  DEFAULT_PROMPT_TEMPLATE,
  Pair,
  speechSourceRule,
  ZH_TO_VI,
  VI_DOMAIN_RULE,
  detectPair,
  buildPrompt,
  fixViCasing,
  sleep,
} from './translate-lang';
import * as llm from './translate-llm-client';
import { LlmProvider, LlmParams, LLM_PROVIDERS } from './translate-llm-client';
import {
  configPath,
  TranslateConfig,
  TranslateConfigStore,
  defaultRuntimeConfig,
  envSeedConfig,
  sanitizeConfig,
  normalizeConfigPatch,
  maskProviderConfigs,
  splitList,
} from './translate-config.store';
import { parseCommand, type CommandContext } from './translate-commands';
import {
  HourlyCap,
  VoiceConfig,
  appendVoiceStat,
  archiveAudio,
  transcribe,
  voiceConfigFromEnv,
  voiceEnabled,
} from './translate-voice';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { recordSttCall } from '../keyproxy/stt-usage.store';

export { LLM_PROVIDERS } from './translate-llm-client';
export type { LlmProvider, LlmParams } from './translate-llm-client';
export type { TranslateConfig } from './translate-config.store';

// Media captions land in `body` (see baileys-inbound-mapper), so image/video/document carry translatable text.
const TRANSLATABLE_TYPES = new Set<IncomingMessage['type']>(['text', 'image', 'video', 'document']);
// Audio carries no body — routed through STT first (see transcribeAndTranslate), not the caption path.
const VOICE_TYPES = new Set<IncomingMessage['type']>(['voice', 'audio']);
// Prefix on the transcript line. Unlike a text message, the source isn't already visible in the chat,
// so the bot echoes what it heard alongside the translation.
const TRANSCRIPT_MARKER = '🎙 ';
// Circuit breaker for a stalling model (see modelFails). Trip on the 2nd consecutive failure so a
// single blip doesn't sideline a healthy primary; 60s cooldown re-probes often enough that recovery
// costs at most one slow message.
const MODEL_TRIP_AFTER = 2;
const MODEL_COOLDOWN_MS = 60_000;

@Injectable()
export class TranslateService implements OnModuleInit {
  private readonly logger = createLogger('TranslateService');
  private readonly configStore = new TranslateConfigStore();

  private cfg = defaultRuntimeConfig();

  // zh<->vi term overrides; default paths live under the writable data dir (read-only rootfs Docker).
  private glossary!: Glossary;
  private glossaryPath = 'data/glossary.json';
  // Manual @mention JID->name overrides applied to the body before translation.
  private senders!: SenderDirectory;
  private sendersPath = 'data/senders.json';
  // Vietnamese factory shorthand expanded in the source text before the prompt (vi->zh only).
  private shorthand!: ShorthandTable;
  private shorthandPath = 'data/shorthand.json';
  // Per-user keyword alerts: DM the watcher when a group message contains their keyword.
  private watchwords!: WatchwordStore;
  private watchwordsPath = 'data/watchwords.json';
  // /bad translation feedback: ring of recent sends (for source recovery) + persisted report list.
  private feedback!: FeedbackStore;
  private feedbackPath = 'data/bad-feedback.json';
  // Admin-managed glossary category list backing the dashboard dropdown.
  private categories!: CategoryStore;
  private categoriesPath = 'data/categories.json';
  // Translation memory: logs every LLM translation as a future glossary candidate.
  private memory!: TranslationMemory;
  // High-frequency phrase candidates mined from translation memory (dashboard-triggered scan).
  private phrases!: PhraseCandidates;
  // Author WIDs allowed to mutate the glossary via /glossary commands. Empty = anyone in the group.
  private adminIds = new Set<string>();
  // @lid keys already put through resolvePendingSenders — one attempt each, no per-message retries.
  private senderLookupTried = new Set<string>();

  // Voice-note transcription (env-only config); disabled unless TRANSLATE_VOICE_STT_URL is set.
  private voice: VoiceConfig = voiceConfigFromEnv();
  private voiceCap = new HourlyCap(this.voice.maxPerHour);
  // Bounded queue, not the default Infinity: every parked task holds its decoded audio buffer alive, so
  // an unbounded park turns a burst into heap. Overflow throws, which the caller logs as a dropped note.
  private voiceLimiter = new ConcurrencyLimiter(this.voice.concurrency, this.voice.concurrency * 4);

  private nextSendAt = 0;
  // Running count of translations where every model failed — surfaced in logs for observability.
  private failureCount = 0;
  // Per-chat send timestamps (ms) for the rolling-minute rate limit; pruned on each check.
  private rateHits = new Map<string, number[]>();
  // hookId for the dynamically (un)registered message:sent hook — null when not registered.
  private sentHookId: string | null = null;
  // Serialize translations behind one chain — a local Ollama model handles one request at a time.
  private queue: Promise<unknown> = Promise.resolve();
  // Circuit breaker per model entry: a provider that stalls (upstream degradation) would otherwise
  // charge every queued message the full LLM timeout before falling back. After MODEL_TRIP_AFTER
  // consecutive failures, skip that entry for MODEL_COOLDOWN_MS so only the first message pays.
  private modelFails = new Map<string, { fails: number; until: number }>();

  constructor(
    private readonly hookManager: HookManager,
    private readonly messageService: MessageService,
    private readonly contactService: ContactService,
  ) {}

  /**
   * Best-effort name lookup for `@lid` mentions queued by notePending. Two shots: the lid->phone
   * mapping (the table is keyed by phone for most people, so this usually hits), then the contact
   * record. Tried keys are remembered so an unresolvable lid isn't re-queried on every message.
   */
  private resolvePendingSenders(sessionId: string, jids: string[]): void {
    for (const key of this.senders.pending(jids)) {
      if (this.senderLookupTried.has(key)) continue;
      this.senderLookupTried.add(key);
      void this.lookupSenderName(sessionId, key).catch(err =>
        this.logger.debug(`sender lookup failed for ${key}`, String(err)),
      );
    }
  }

  private async lookupSenderName(sessionId: string, key: string): Promise<boolean> {
    const lid = `${key}@lid`;
    const phone = await this.contactService.resolveContactPhone(sessionId, lid).catch(() => null);
    const viaPhone = phone ? this.senders.nameOf(phone) : '';
    if (viaPhone) return this.senders.learn(key, viaPhone);
    const contact = await this.contactService.getContactById(sessionId, lid).catch(() => null);
    const name = contact?.name || contact?.pushName;
    return name ? this.senders.learn(key, name) : false;
  }

  /**
   * Dashboard-triggered: run every queued empty-name entry through the same lookup. Sequential —
   * each key is one or two WhatsApp queries and the batch form is rate-limit prone (see adapter).
   * Per-lookup failures are already swallowed inside lookupSenderName; a "session not started"
   * throw is left to propagate so the button reports it instead of a silent "filled 0".
   */
  async backfillSenders(sessionId: string): Promise<number> {
    let filled = 0;
    for (const key of this.senders.allPending()) {
      if (await this.lookupSenderName(sessionId, key)) filled++;
    }
    return filled;
  }

  onModuleInit(): void {
    this.applyConfig(envSeedConfig());
    this.glossaryPath = process.env.TRANSLATE_GLOSSARY_PATH || this.glossaryPath;
    this.adminIds = new Set(splitList(process.env.TRANSLATE_ADMIN_IDS || ''));
    this.glossary = new Glossary(this.glossaryPath);
    const terms = this.glossary.load();
    if (terms > 0) this.logger.log(`Glossary loaded: ${terms} term(s) from ${this.glossaryPath}`);

    this.sendersPath = process.env.TRANSLATE_SENDERS_PATH || this.sendersPath;
    this.senders = new SenderDirectory(this.sendersPath);
    const senderCount = this.senders.load();
    if (senderCount > 0) this.logger.log(`Senders loaded: ${senderCount} override(s) from ${this.sendersPath}`);

    this.shorthandPath = process.env.TRANSLATE_SHORTHAND_PATH || this.shorthandPath;
    this.shorthand = new ShorthandTable(this.shorthandPath);
    this.logger.log(`Shorthand loaded: ${this.shorthand.load()} Vietnamese abbreviation(s)`);

    this.watchwordsPath = process.env.TRANSLATE_WATCHWORDS_PATH || this.watchwordsPath;
    this.watchwords = new WatchwordStore(this.watchwordsPath);
    const watcherCount = this.watchwords.load();
    if (watcherCount > 0) this.logger.log(`Watchwords loaded: ${watcherCount} watcher(s) from ${this.watchwordsPath}`);

    this.feedbackPath = process.env.TRANSLATE_FEEDBACK_PATH || this.feedbackPath;
    this.feedback = new FeedbackStore(this.feedbackPath);
    const feedbackCount = this.feedback.load();
    if (feedbackCount > 0) this.logger.log(`Feedback loaded: ${feedbackCount} report(s) from ${this.feedbackPath}`);

    this.categoriesPath = process.env.TRANSLATE_CATEGORIES_PATH || this.categoriesPath;
    this.categories = new CategoryStore(this.categoriesPath);
    const categoryCount = this.categories.load();
    if (categoryCount > 0) this.logger.log(`Categories loaded: ${categoryCount} from ${this.categoriesPath}`);

    this.memory = new TranslationMemory();
    this.memory.init();
    this.phrases = new PhraseCandidates();
    this.phrases.init();

    // Persisted runtime config takes precedence over .env; .env values seed the file on first run.
    this.loadConfig();

    // Always registered; enable/disable is enforced in onMessage so runtime toggles need no re-registration.
    this.hookManager.register(
      'translate',
      'message:received',
      ctx => this.onMessage(ctx as HookContext<IncomingMessage>, false),
      50,
    );
    if (this.cfg.includeFromMe) this.registerSentHook();

    if (voiceEnabled(this.voice)) {
      this.logger.log(
        `Voice transcription enabled: model=${this.voice.model}, stt=${this.voice.baseUrl}` +
          `, prompt=${this.voice.prompt ? `${this.voice.prompt.length} chars` : 'none'}`,
      );
    }

    this.logger.log(
      `Translate loaded: enabled=${this.cfg.enabled}, ${this.cfg.groupIds.size} group(s), ` +
        `model=${this.cfg.llmModel}, includeFromMe=${this.cfg.includeFromMe}`,
    );
  }

  // Keys never leave the server: apiKeys are masked to '' + apiKeySet; '' round-trips the PUT as "keep stored key".
  getConfig(): TranslateConfig & { llmPromptTemplateDefault: string; apiKeySet: boolean } {
    return {
      ...this.persistedConfig(),
      llmApiKey: '',
      apiKeySet: this.cfg.llmApiKey !== '',
      llmProviderConfigs: maskProviderConfigs(this.cfg.llmProviderConfigs),
      llmPromptTemplateDefault: DEFAULT_PROMPT_TEMPLATE,
    };
  }

  private persistedConfig(): TranslateConfig {
    return { ...this.cfg, groupIds: [...this.cfg.groupIds], llmFallbackModels: [...this.cfg.llmFallbackModels] };
  }

  /** Apply an already-sanitized partial config to the live state (no hook side effects). */
  private applyConfig(p: Partial<TranslateConfig>): void {
    const { groupIds, ...rest } = p;
    Object.assign(this.cfg, rest);
    if (groupIds !== undefined) this.cfg.groupIds = new Set(groupIds);
  }

  updateConfig(partial: Partial<TranslateConfig>): TranslateConfig {
    const prevFromMe = this.cfg.includeFromMe;
    this.applyConfig(normalizeConfigPatch(partial, this.cfg.llmProviderConfigs));
    if (this.cfg.includeFromMe !== prevFromMe) {
      if (this.cfg.includeFromMe) this.registerSentHook();
      else this.unregisterSentHook();
    }
    this.saveConfig();
    return this.getConfig();
  }

  // REST CRUD on the glossary/sender stores lives in the controller (boundary validation there).
  get glossaryStore(): Glossary {
    return this.glossary;
  }
  get senderStore(): SenderDirectory {
    return this.senders;
  }
  get categoryStore(): CategoryStore {
    return this.categories;
  }

  /** Top translation-memory candidates to promote into the glossary. */
  async memoryCandidates(limit?: number, offset?: number): Promise<{ items: Candidate[]; total: number }> {
    const [items, total] = await Promise.all([this.memory.candidates(limit, offset), this.memory.candidatesCount()]);
    return { items, total };
  }

  /** Promote a candidate into the glossary (both directions handled by Glossary.add's orient). */
  async approveMemoryCandidate(id: number): Promise<Candidate[]> {
    const row = await this.memory.takeForApproval(id);
    if (row) this.glossary.add(row.source, row.translated);
    return this.memory.candidates();
  }

  async dismissMemoryCandidate(id: number): Promise<Candidate[]> {
    await this.memory.dismiss(id);
    return this.memory.candidates();
  }

  /** Current high-frequency phrase candidates awaiting review. */
  phraseCandidates(limit?: number): Promise<PhraseCandidate[]> {
    return this.phrases.list(limit);
  }

  /** Queue health for the dashboard — pending backlog, review latency, and the revocation rate. */
  phraseStats(): Promise<PhraseStats> {
    return this.phrases.stats();
  }

  /**
   * Remove a glossary pairing and record the revocation against whatever origin approved it. Routed
   * through the service rather than the controller touching `glossaryStore` directly so provenance
   * stays in one place — the revocation rate is what gates any future auto-promotion.
   */
  async removeGlossaryTerm(term: string): Promise<ReturnType<Glossary['entries']>> {
    const removed = this.glossary.remove(term);
    if (removed) {
      await this.phrases.recordRevoke(term);
      this.logger.log(`[translate:phrase-review] glossary term revoked: ${term}`);
    }
    return this.glossary.entries();
  }

  /**
   * Mine translation memory for high-frequency Chinese phrases not yet in the glossary, ask the LLM
   * for a Vietnamese term for each (non-terms come back blank and are skipped), and upsert the rest as
   * candidates. Dashboard-triggered — reads the whole memory table + one LLM call, so it's not on the
   * translation hot path. Returns the refreshed candidate list.
   */
  async scanPhrases(): Promise<PhraseCandidate[]> {
    const sources = await this.memory.allSources();
    const exclude = new Set(this.glossary.entries().map(e => e.source));
    const minCount = Math.max(1, Number(process.env.TRANSLATE_PHRASE_MIN_COUNT) || 3);
    const mined = minePhrases(sources, { minCount, limit: 30, exclude });
    if (mined.length) {
      const translations = await this.translatePhrases(mined.map(m => m.phrase));
      for (const m of mined) {
        const vi = (translations[m.phrase] || '').trim();
        if (vi) await this.phrases.upsert(m.phrase, vi, m.count);
      }
    }
    return this.phrases.list();
  }

  // Batch-translate mined phrases in one LLM call. Asks for strict JSON {phrase: vi}; a phrase the
  // model deems a non-term (fragment/noise) it returns as "" and we skip it. Failure → empty map
  // (scan just upserts nothing), never throws into the controller.
  private async translatePhrases(phrases: string[]): Promise<Record<string, string>> {
    const params = this.resolveModel(this.cfg.llmModel);
    if (!params) return {};
    const list = phrases.map(p => `- ${p}`).join('\n');
    const prompt =
      '你是中越術語翻譯助手。以下是從聊天記錄擷取的中文片段，請判斷哪些是有意義的詞彙或術語，' +
      '並給出越南文翻譯。無意義的片段（斷詞雜訊、非完整詞）翻譯留空字串。\n' +
      '只回 JSON 物件，key 是中文片段，value 是越南文（或空字串），不要任何其他文字。\n\n' +
      list;
    try {
      const out = await llm.callLlm(params, prompt);
      const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') result[k] = v;
      return result;
    } catch (err) {
      this.logger.warn(`Phrase batch translate failed: ${String(err)}`);
      return {};
    }
  }

  /** Promote a phrase candidate into the glossary. */
  async approvePhraseCandidate(id: number): Promise<PhraseCandidate[]> {
    const row = await this.phrases.takeForApproval(id);
    if (row && row.translated) this.glossary.add(row.phrase, row.translated);
    return this.phrases.list();
  }

  async dismissPhraseCandidate(id: number): Promise<PhraseCandidate[]> {
    await this.phrases.dismiss(id);
    return this.phrases.list();
  }

  private registerSentHook(): void {
    if (this.sentHookId) return;
    // fromMe messages never reach message:received — the adapter routes them to message:sent.
    this.sentHookId = this.hookManager.register(
      'translate',
      'message:sent',
      ctx => this.onMessage(ctx as HookContext<IncomingMessage>, true),
      50,
    );
  }

  private unregisterSentHook(): void {
    if (!this.sentHookId) return;
    this.hookManager.unregister(this.sentHookId);
    this.sentHookId = null;
  }

  private loadConfig(): void {
    const read = this.configStore.read();
    // Missing = first run: seed from .env values. Unreadable/corrupt: keep the file, don't clobber it.
    if (read.status === 'missing') return this.saveConfig();
    if (read.status === 'unreadable') {
      this.logger.warn(`Config unreadable, keeping ${configPath()} untouched: ${String(read.error)}`);
      return;
    }
    this.applyConfig(sanitizeConfig(read.raw));
  }

  private saveConfig(): void {
    this.configStore.write(this.persistedConfig());
  }

  // Fire-and-forget: never block the receive pipeline — kick off async and return continue:true immediately.
  private async onMessage(
    ctx: HookContext<IncomingMessage>,
    isSentPath: boolean,
  ): Promise<HookResult<IncomingMessage>> {
    const msg = ctx.data;
    const pass: HookResult<IncomingMessage> = { continue: true };
    try {
      if (!this.cfg.enabled) return pass;
      const isVoice = VOICE_TYPES.has(msg.type);
      if (!TRANSLATABLE_TYPES.has(msg.type) && !isVoice) return pass;
      // received-path fromMe shouldn't occur (adapter routes fromMe to message:sent); guard anyway.
      if (msg.fromMe && !isSentPath) return pass;
      if (!msg.isGroup || !this.cfg.groupIds.has(msg.chatId)) return pass;

      // Passive learn: the sender's JID + name only coexist here (live message). Remember it so a
      // later @mention of this person resolves to a name without any manual entry. Skips known JIDs.
      if (!isSentPath && msg.author) {
        const nm = msg.contact?.pushName || msg.contact?.name || msg.contact?.verifiedName || msg.contact?.shortName;
        if (nm) {
          this.senders.learn(msg.author, nm);
          if (msg.senderPhone) this.senders.learn(msg.senderPhone, nm);
        }
      }

      // Audio has no body, so it exits before the text path's command/mention/watchword handling —
      // a spoken message is content to translate, never a command.
      if (isVoice) {
        if (ctx.sessionId) void this.transcribeAndTranslate(ctx.sessionId, msg);
        return pass;
      }

      const body = msg.body || '';
      // marker skip is load-bearing on the sent path: the bot's own translation is fromMe+marker,
      // so this is what stops an infinite translate→send→translate loop.
      if (!body.trim() || body.startsWith(BOT_MARKER)) return pass;

      const sessionId = ctx.sessionId;
      if (!sessionId) return pass;

      const trimmed = body.trim();
      const command = parseCommand(trimmed);
      if (command) {
        const cmdCtx: CommandContext = {
          deps: {
            glossary: this.glossary,
            adminIds: this.adminIds,
            messageService: this.messageService,
            watchwords: this.watchwords,
            feedback: this.feedback,
          },
          sessionId,
          msg,
          raw: trimmed,
          rest: command.rest,
        };
        void command.spec
          .handle(cmdCtx)
          .catch(err => this.logger.error(`${command.spec.cmd} command failed`, String(err)));
        return pass; // command, not content to translate
      }

      // markUsed(mentionedIds) is the sole usage counter: the adapter already replaced the raw
      // @<digits> token with a name before this hook runs, so apply() can't see mentions reliably.
      // Unresolved mentions get queued as empty-name entries for an admin to name (notePending).
      if (msg.mentionedIds?.length) {
        this.senders.markUsed(msg.mentionedIds);
        this.senders.notePending(msg.mentionedIds, body);
        this.resolvePendingSenders(sessionId, msg.mentionedIds);
      }

      // Keyword alerts: DM every watcher (other than the author) whose keyword this group message hits.
      // Fire-and-forget; a watcher that's an unresolved @lid may fail to DM — logged, never blocks translate.
      if (msg.isGroup) {
        for (const { watcher, keyword } of this.watchwords.matches(body, msg.author || msg.from)) {
          void this.messageService
            .sendText(sessionId, { chatId: watcher, text: `${BOT_MARKER}🔔 群組有人提到「${keyword}」：\n${body}` })
            .catch(err => this.logger.error('Watch alert send failed', String(err)));
        }
      }

      // Fire-and-forget off the receive pipeline: decide + translate in the shared core, then send.
      void this.translateAndSend(sessionId, msg.chatId, body).catch(err =>
        this.onTranslateFailure(sessionId, msg.chatId, err),
      );
    } catch (err) {
      this.logger.error('Translate hook error', String(err));
    }
    return pass;
  }

  /**
   * Platform-agnostic translate decision: given inbound text and a chat key (rate-limit bucket),
   * return the bot reply (BOT_MARKER + translation) or null to stay silent. Serialized on the shared
   * queue so a single-request Ollama isn't hit concurrently. Shared by the WhatsApp hook and any other
   * platform adapter injecting this same service — glossary/sender/memory/config all shared.
   */
  async translateInbound(
    text: string,
    chatKey: string,
    send?: (reply: string) => Promise<void>,
    fromSpeech = false,
  ): Promise<string | null> {
    const body = text || '';
    if (!body.trim() || body.startsWith(BOT_MARKER)) return null;
    const pair = this.detectPair(body);
    if (!pair) return null; // not zh/vi — leave it alone

    // Cost guards: skip over-long messages and throttle per chat so a flood can't run up the cloud
    // LLM bill. Both default to off (0). Checked before the LLM call, after cheap filters.
    if (this.cfg.maxMessageLength > 0 && body.length > this.cfg.maxMessageLength) {
      this.logger.warn(`Skipped (too long: ${body.length} > ${this.cfg.maxMessageLength}) chat=${chatKey}`);
      return null;
    }
    if (!this.allowByRate(chatKey)) {
      this.logger.warn(`Skipped (rate limit ${this.cfg.maxTranslationsPerMinute}/min) chat=${chatKey}`);
      return null;
    }

    return this.enqueue(async () => {
      const translated = await this.translate(body, pair, fromSpeech);
      // The model can echo the source when it's not translatable natural language — don't spam a
      // verbatim copy. Only path that discards a successful LLM response, so log it or the bot looks
      // like it randomly stopped translating.
      if (!translated || translated.trim() === body.trim()) {
        this.logger.warn(`Skipped (echo/empty) pair=${pair.key} in="${body.slice(0, 60)}"`);
        return null;
      }
      const reply = BOT_MARKER + translated;
      // In-queue send keeps sends serialized behind translations (race-free pacing). Adapters that
      // don't need in-queue delivery omit send and dispatch the returned reply themselves.
      if (send) await send(reply);
      return reply;
    });
  }

  /**
   * Voice path: STT the note, then hand the transcript to the normal translate path so glossary,
   * senders, memory and /bad feedback all apply to it unchanged. Fully off the receive pipeline —
   * every exit here is a silent drop of ONE voice note, never a delivery failure.
   */
  private async transcribeAndTranslate(sessionId: string, msg: IncomingMessage): Promise<void> {
    try {
      if (!voiceEnabled(this.voice)) return;
      if (msg.type === 'audio' && !this.voice.includeAudioFiles) return; // PTT only unless opted in
      const media = msg.media;
      // omitted = the note blew the inbound media cap, so there are no bytes to send to the backend.
      if (!media?.data || media.omitted) return;
      const audio = Buffer.from(media.data, 'base64');
      // Size before cap: an oversized note costs nothing to reject, so it must not spend hourly budget
      // that a real note could have used.
      if (audio.byteLength > this.voice.maxBytes) {
        this.logger.warn(`Voice note too large (${audio.byteLength} > ${this.voice.maxBytes}); skipped`);
        return;
      }
      if (!this.voiceCap.take(msg.chatId)) {
        this.logger.warn(`Voice hourly cap (${this.voice.maxPerHour}) hit for chat=${msg.chatId}; skipped`);
        return;
      }
      // The hourly cap bounds VOLUME, not concurrency: a burst of notes would otherwise fire that many
      // parallel STT requests — fine for Groq, but a self-hosted CPU whisper thrashes and cloud tiers 429.
      const startedAt = Date.now();
      // Count the call whichever way it goes: these requests bypass the key-rotation proxy entirely,
      // so this store is the ONLY place the STT key's usage is visible on the LLM Keys page.
      const { text, confidence } = await this.voiceLimiter
        .run(() => transcribe(audio, media.mimetype, this.voice))
        .then(r => {
          recordSttCall(this.voice.apiKey, true, r.quota);
          return r;
        })
        .catch(err => {
          recordSttCall(this.voice.apiKey, false);
          throw err;
        });
      // Recorded BEFORE the empty-transcript exit: "whisper heard nothing" is itself a data point the
      // threshold has to account for, and dropping it would bias the sample toward successful notes.
      const ts = Date.now();
      appendVoiceStat({
        ts,
        model: this.voice.model,
        file: archiveAudio(audio, media.mimetype, ts) || undefined,
        ms: Date.now() - startedAt,
        bytes: audio.byteLength,
        chars: text.length,
        noSpeech: confidence?.maxNoSpeech ?? null,
        logprob: confidence?.minLogprob ?? null,
        segments: confidence?.segments ?? null,
        text,
      });
      if (!text) {
        this.logger.warn(`Voice transcript empty chat=${msg.chatId}`);
        return;
      }
      // Log the SUCCESS too, not just failures: without it a working voice path is indistinguishable
      // from a silent one in the logs, and there's no way to tell whether a prompt/model change helped.
      // The transcript itself is included — it's the only place STT accuracy is observable.
      //
      // The confidence numbers are RECORDED, NOT ACTED ON. Whisper invents filler over trailing silence
      // and such a span shows a high no_speech / poor logprob, so these are the levers a future filter
      // would use — but the threshold has to come from real traffic, not a number picked up front.
      const conf = confidence
        ? ` no_speech=${confidence.maxNoSpeech.toFixed(3)} logprob=${confidence.minLogprob.toFixed(3)}` +
          ` seg=${confidence.segments}`
        : '';
      this.logger.log(
        `Voice transcribed in ${Date.now() - startedAt}ms (${audio.byteLength}B -> ${text.length} chars)` +
          `${conf} chat=${msg.chatId}: ${text}`,
      );
      // fromSpeech=true: the transcript echoed to the group stays exactly as heard, but the translation
      // is told it came from STT so it can reinterpret a loanword the sentence contradicts.
      await this.translateAndSend(sessionId, msg.chatId, text, TRANSCRIPT_MARKER + text, true);
    } catch (err) {
      this.logger.error('Voice transcription failed', String(err));
    }
  }

  // WhatsApp send path: translate off the receive pipeline, then pace + send back (in-queue). Typing
  // simulation runs inside MessageService.sendText (SIMULATE_TYPING). `prefixLine` (voice) prepends the
  // transcript so the group sees what was heard — the source text isn't in the chat like a text message.
  private translateAndSend(
    sessionId: string,
    chatId: string,
    body: string,
    prefixLine?: string,
    fromSpeech = false,
  ): Promise<string | null> {
    return this.translateInbound(
      body,
      chatId,
      async reply => {
        const wait = this.nextSendAt - Date.now();
        if (wait > 0) await sleep(wait);
        // Keep BOT_MARKER first: it stops the sent-path hook re-translating the bot's own message.
        const text = prefixLine ? BOT_MARKER + prefixLine + '\n' + reply.slice(BOT_MARKER.length) : reply;
        const res = await this.messageService.sendText(sessionId, { chatId, text });
        this.nextSendAt = Date.now() + this.cfg.minSendIntervalMs;
        // Remember source↔translation keyed by the sent id so a later /bad quoting it recovers the source.
        this.feedback.record(res?.messageId, body, reply.replace(BOT_MARKER, '').trim());
      },
      fromSpeech,
    );
  }

  // Rolling 60s window per chat. Records a hit when allowed; returns false once the group hits the cap.
  private allowByRate(chatId: string): boolean {
    const limit = this.cfg.maxTranslationsPerMinute;
    if (limit <= 0) return true;
    const now = Date.now();
    const recent = (this.rateHits.get(chatId) ?? []).filter(t => now - t < 60_000);
    if (recent.length >= limit) {
      this.rateHits.set(chatId, recent);
      return false;
    }
    recent.push(now);
    this.rateHits.set(chatId, recent);
    return true;
  }

  // Every model failed: log with a running total (so a broken bot is visible in logs), and optionally
  // tell the group so users aren't left wondering why translation silently stopped.
  private onTranslateFailure(sessionId: string, chatId: string, err: unknown): void {
    this.failureCount += 1;
    this.logger.error(`Translate task failed (total failures=${this.failureCount})`, String(err));
    if (this.cfg.notifyOnFailure) {
      void this.messageService
        .sendText(sessionId, { chatId, text: BOT_MARKER + '⚠️ 翻譯暫時失敗，請稍後再試' })
        .catch(e => this.logger.error('Failure-notice send failed', String(e)));
    }
  }

  // Thin instance wrapper over the pure detector (kept a method so the spec's private-method poke works).
  private detectPair(text: string): Pair | null {
    return detectPair(text);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Resolve unknown @mention JIDs to names, then expand Vietnamese factory shorthand — vi source
   * only, since a zh message never carries it and expanding would corrupt an ASCII word. Shared by
   * the live path and preview so the two can't drift.
   */
  private prepareSource(text: string, pair: Pair): string {
    const applied = this.senders.apply(text);
    if (pair.key === ZH_TO_VI.key) return applied;
    return this.shorthand.expand(applied, s => this.glossary.hasSource(pair.key, s));
  }

  /** Glossary terms used by this message, plus the vi->zh domain rule (see VI_DOMAIN_RULE). */
  private promptExtras(pair: Pair, applied: string): string {
    return this.glossary.section(pair.key, applied) + (pair.key === ZH_TO_VI.key ? '' : VI_DOMAIN_RULE);
  }

  private async translate(text: string, pair: Pair, fromSpeech = false): Promise<string> {
    const applied = this.prepareSource(text, pair);

    // Whole-message exact glossary hit (short conversational phrases like 明白/好/收到): answer
    // directly and skip the LLM, which weak models otherwise reply to conversationally ("請提供
    // 您需要翻譯的內容。"). Substring matches still go through the LLM via section() below.
    const exact = this.glossary.exact(pair.key, applied);
    if (exact) return pair.key === ZH_TO_VI.key ? fixViCasing(exact) : exact;

    // Inject only the glossary terms that actually appear in this message (see Glossary.section).
    // A speech-sourced message rides in on the same slot, so buildPrompt and any custom template that
    // already honours {glossary} pick it up with no extra placeholder to keep in sync.
    const extras = this.promptExtras(pair, applied) + (fromSpeech ? speechSourceRule(this.voice.confusions) : '');
    const prompt = buildPrompt(applied, pair, extras, this.cfg.llmPromptTemplate);

    // Try the primary model, then each fallback in order — covers "model not loaded"/timeout on a
    // local Ollama or a rate-limited cloud model without dropping the translation. A fallback entry
    // may cross providers via a "provider:model" prefix (e.g. groq:llama-3.3-70b-versatile).
    const all = [this.cfg.llmModel, ...this.cfg.llmFallbackModels].filter(Boolean);
    // Skip tripped entries — unless every entry is tripped, in which case try them all rather than
    // dropping the translation.
    const live = all.filter(e => !this.isTripped(e));
    const entries = live.length ? live : all;
    let lastErr: unknown;
    for (const entry of entries) {
      const params = this.resolveModel(entry);
      if (!params) {
        lastErr = new Error(`No saved config for cross-provider fallback "${entry}"`);
        this.logger.warn(`Skipping fallback "${entry}": ${String(lastErr)}`);
        continue;
      }
      try {
        const out = await llm.callLlm(params, prompt);
        this.modelFails.delete(entry);
        const result = pair.key === ZH_TO_VI.key ? fixViCasing(out) : out;
        // Log for later glossary curation (best-effort). Exact glossary hits returned above, so this
        // only captures genuine LLM output — not terms already in the glossary.
        this.memory.record(pair.key, applied, result);
        return result;
      } catch (err) {
        lastErr = err;
        this.logger.warn(`Model "${entry}" failed, trying next fallback: ${String(err)}`);
        this.tripModel(entry);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('All models failed');
  }

  private isTripped(entry: string): boolean {
    return (this.modelFails.get(entry)?.until ?? 0) > Date.now();
  }

  private tripModel(entry: string): void {
    const fails = (this.modelFails.get(entry)?.fails ?? 0) + 1;
    const tripped = fails >= MODEL_TRIP_AFTER;
    this.modelFails.set(entry, { fails, until: tripped ? Date.now() + MODEL_COOLDOWN_MS : 0 });
    if (tripped) {
      this.logger.warn(`Model "${entry}" tripped after ${fails} failures; skipping for ${MODEL_COOLDOWN_MS}ms`);
    }
  }

  /**
   * Resolve a fallback entry to call params. Bare "model" uses the active provider/endpoint/key.
   * A "provider:model" prefix (provider ∈ LLM_PROVIDERS) crosses providers, pulling that provider's
   * saved endpoint/key from llmProviderConfigs — returns null when it has no saved config yet.
   * Guard: an Ollama tag colon (qwen3:8b) isn't a provider prefix, so it stays a bare model name.
   */
  private resolveModel(entry: string): LlmParams | null {
    const colon = entry.indexOf(':');
    const maybeProvider = colon > 0 ? entry.slice(0, colon) : '';
    if (!LLM_PROVIDERS.includes(maybeProvider as LlmProvider)) {
      return { ...this.llmParams(), model: entry };
    }
    const provider = maybeProvider as LlmProvider;
    const model = entry.slice(colon + 1);
    if (!model) return { ...this.llmParams(), model: entry };
    if (provider === this.cfg.llmProvider) return { ...this.llmParams(), model };
    const pc = this.cfg.llmProviderConfigs[provider];
    const endpoint = typeof pc?.endpoint === 'string' ? pc.endpoint : '';
    if (!endpoint) return null; // no saved config for this provider — can't call it
    const apiKey = typeof pc?.apiKey === 'string' ? pc.apiKey : '';
    const temperature = typeof pc?.temperature === 'number' ? pc.temperature : this.cfg.llmTemperature;
    return { provider, endpoint, model, apiKey, temperature };
  }

  // Dashboard preview: run the real pipeline (sender/glossary substitution + fixViCasing) on ad-hoc text so
  // an operator can verify translation quality after changing prompt/model without posting to a group.
  // pair='' when the text isn't detectable zh/vi — the controller maps that to a 400. An optional
  // provider runs that configured engine instead of the active one, so providers can be A/B compared.
  async preview(text: string, provider?: LlmProvider): Promise<{ pair: string; translated: string }> {
    const pair = this.detectPair(text);
    if (!pair) return { pair: '', translated: '' };
    const params = this.previewParams(provider);
    return { pair: pair.key, translated: await this.translateWith(text, pair, params) };
  }

  // Resolve the LlmParams for a preview: the active engine by default, or a configured provider's saved
  // settings (from llmProviderConfigs) when comparing. Throws if the requested provider isn't set up.
  private previewParams(provider?: LlmProvider): LlmParams {
    if (!provider || provider === this.cfg.llmProvider) return this.llmParams();
    const pc = this.cfg.llmProviderConfigs[provider];
    const endpoint = typeof pc?.endpoint === 'string' ? pc.endpoint : '';
    const model = typeof pc?.model === 'string' ? pc.model : '';
    if (!endpoint || !model) throw new BadRequestException(`Provider "${provider}" is not configured`);
    const apiKey = typeof pc?.apiKey === 'string' ? pc.apiKey : '';
    const temperature = typeof pc?.temperature === 'number' ? pc.temperature : this.cfg.llmTemperature;
    return { provider, endpoint, model, apiKey, temperature };
  }

  // Single-engine translate (no fallback loop) — used by preview to test one provider deterministically.
  private async translateWith(text: string, pair: Pair, params: LlmParams): Promise<string> {
    const applied = this.prepareSource(text, pair);
    const prompt = buildPrompt(applied, pair, this.promptExtras(pair, applied), this.cfg.llmPromptTemplate);
    const out = await llm.callLlm(params, prompt);
    return pair.key === ZH_TO_VI.key ? fixViCasing(out) : out;
  }

  private llmParams(): LlmParams {
    const c = this.cfg;
    return {
      provider: c.llmProvider,
      endpoint: c.llmEndpoint,
      model: c.llmModel,
      apiKey: c.llmApiKey,
      temperature: c.llmTemperature,
    };
  }

  // Dashboard probes send apiKey:'' (getConfig masks it) — fall back to the stored key so
  // Test Connection / Fetch Models keep working without re-entering the secret. Endpoint-bound: only
  // backfill when the probe targets the SAME endpoint the key was saved against, so an admin can't
  // point the endpoint at their own server and exfiltrate the stored key (it also blocks SSRF-with-key).
  private storedKey(provider: LlmProvider, endpoint: string): string {
    if (endpoint.trim() !== this.cfg.llmEndpoint) return '';
    if (provider === this.cfg.llmProvider && this.cfg.llmApiKey) return this.cfg.llmApiKey;
    const k = this.cfg.llmProviderConfigs[provider]?.apiKey;
    return typeof k === 'string' ? k : '';
  }

  async testConnection(raw: LlmParams): Promise<{ ok: boolean; message: string }> {
    const p = raw.apiKey ? raw : { ...raw, apiKey: this.storedKey(raw.provider, raw.endpoint) };
    return llm.testConnection(p);
  }

  /** List model names for the endpoint (Ollama /api/tags, OpenAI/Groq /models, Gemini /v1beta/models). */
  async listModels(raw: Pick<LlmParams, 'provider' | 'endpoint' | 'apiKey'>): Promise<string[]> {
    const p = raw.apiKey ? raw : { ...raw, apiKey: this.storedKey(raw.provider, raw.endpoint) };
    return llm.listModels(p);
  }
}
