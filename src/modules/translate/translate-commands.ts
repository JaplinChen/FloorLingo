import { MessageService } from '../message/message.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { Glossary } from './translate-glossary';
import { jidDigits } from './translate-senders';
import { WatchwordStore } from './translate-watchwords';
import { FeedbackStore } from './translate-feedback';
import { BOT_MARKER } from './translate-lang';

// Cap on lines processed from one pasted /g message — see handleGlossaryCommand.
const GLOSSARY_BATCH_MAX = 20;

/** Stores/services every chat command may need; the caller wires the shared singletons in. */
export interface CommandDeps extends GlossaryCommandDeps {
  watchwords: WatchwordStore;
  feedback: FeedbackStore;
}

/** Everything a command handler needs; built once per command by the caller. */
export interface CommandContext {
  deps: CommandDeps;
  sessionId: string;
  msg: IncomingMessage;
  raw: string; // full trimmed command text (handlers that re-split a batch use this)
  rest: string; // text after the prefix, trimmed
}

export interface CommandSpec {
  cmd: string;
  aliases: string[]; // matched as /<alias>; first is the canonical name
  handle: (ctx: CommandContext) => Promise<void>;
}

// Command registry. Adding a chat command = append one row + write its handler; parse and dispatch
// both drive off this table, so no if-chain or switch to touch. Aliases are plain words (no regex
// metacharacters), so joining them into the strip-prefix regex below is safe.
export const COMMANDS: CommandSpec[] = [
  {
    cmd: 'glossary',
    aliases: ['glossary', 'g'],
    handle: ctx => handleGlossaryCommand(ctx.deps, ctx.sessionId, ctx.msg, ctx.raw),
  },
  {
    cmd: 'watch',
    aliases: ['watch', 'w'],
    handle: ctx => handleWatchCommand(ctx),
  },
  {
    cmd: 'bad',
    aliases: ['bad'],
    handle: ctx => handleBadCommand(ctx),
  },
  {
    cmd: 'help',
    aliases: ['help', 'h'],
    handle: ctx => handleHelpCommand(ctx.deps.messageService, ctx.sessionId, ctx.msg),
  },
];

/** Single parse for chat commands; null = not a command (regular content). */
export function parseCommand(trimmed: string): { spec: CommandSpec; rest: string } | null {
  for (const spec of COMMANDS) {
    // /<alias> must be followed by whitespace (incl. newline, for pasted multi-line batches) or end.
    const prefix = new RegExp(`^/(?:${spec.aliases.join('|')})(?=\\s|$)\\s*`, 'i');
    if (prefix.test(trimmed)) return { spec, rest: trimmed.replace(prefix, '').trim() };
  }
  return null;
}

export const HELP_TEXT = [
  '指令一覽：',
  '建議詞彙：/g 詞 = nghĩa',
  '  新詞 → 送出建議待管理員審核',
  '  全域已有相同譯法 → 不變更',
  '  全域譯法不同 → 設為本群專用（只影響本群）',
  '全域新增：/g global 詞 = nghĩa（管理員）',
  '全域刪除：/g gdel 詞（管理員）',
  '列出詞彙：/g',
  '待審清單：/g pending（管理員）',
  '核准建議：/g ok 編號（管理員）',
  '退回建議：/g no 編號（管理員）',
  '刪除詞彙：/g del 詞（管理員）',
  '關鍵字提醒：/watch add 關鍵字（命中時私訊你）',
  '列出提醒：/watch',
  '移除提醒：/watch del 關鍵字',
  '回報翻譯：引用譯文後輸入 /bad',
  '顯示說明：/help',
].join('\n');

export interface GlossaryCommandDeps {
  glossary: Glossary;
  adminIds: Set<string>;
  messageService: MessageService;
}

/**
 * Who may mutate the glossary from WhatsApp. Two properties, both learned the hard way:
 *
 *  - **An empty allowlist grants nobody.** It used to grant everybody — every member of every
 *    translated group could add or delete terms, and a glossary term is injected into every later
 *    translation as a mandatory-use directive. "Nobody configured admins yet" is not consent.
 *    Suggestions (`/g 詞 = nghĩa`) are unaffected: anyone may still propose, an admin approves.
 *  - **Compare JID user parts, not JIDs.** The same person arrives as `@c.us`, `@s.whatsapp.net` or
 *    `@lid` depending on engine and chat type, so a raw compare silently refuses a configured admin.
 */
export function isGlossaryAdmin(adminIds: Set<string>, author: string | undefined): boolean {
  if (!adminIds.size || !author) return false;
  const who = jidDigits(author);
  return [...adminIds].some(id => jidDigits(id) === who);
}

// Marker-prefixed reply so the bot never re-translates its own output. The admin allowlist gates
// mutating subcommands; the parsing/persistence lives in Glossary.
export async function handleGlossaryCommand(
  deps: GlossaryCommandDeps,
  sessionId: string,
  msg: IncomingMessage,
  raw: string,
): Promise<void> {
  // Each line may repeat the /g prefix (pasted batch adds); strip it per line.
  const lines = raw
    .split(/\r?\n/)
    .map(l => l.replace(/^\/(?:glossary|g)(?=\s|$)\s*/i, '').trim())
    .filter((l, i) => i === 0 || l !== '');
  const rest = lines[0] ?? '';
  const author = msg.author || msg.from;
  const canMutate = isGlossaryAdmin(deps.adminIds, author);
  // A pasted batch can hold many lines; cap it so one message can't create dozens of overrides and
  // dozens of notifications in one go.
  const batch = (lines.length > 1 ? lines.filter(l => l !== '') : lines).slice(0, GLOSSARY_BATCH_MAX);
  const groupId = msg.isGroup ? msg.chatId : undefined;
  const before = deps.glossary.overrideLayer.count();
  const reply = batch.map(l => deps.glossary.command(l, { canMutate, sender: author, groupId })).join('\n');
  // ponytail: long lists (full glossary / pending queue) DM the author so they don't flood the
  // group; short results (add/suggest/ok/no/del acks, usage) reply in place.
  const isList = batch.length === 1 && (rest === '' || /^pending(?=\s|$)/i.test(rest));
  const target = msg.isGroup && isList ? author : msg.chatId;
  if (!target) return;
  await deps.messageService.sendText(sessionId, { chatId: target, text: BOT_MARKER + reply });

  const written = deps.glossary.overrideLayer.count() - before;
  if (written > 0 && groupId) {
    console.log(`[glossary] override group=${groupId} author=${author} written=${written}`);
    // Once per command, not once per line: a pasted batch would otherwise DM every admin N times.
    await notifyAgreedOverrides(deps, sessionId, batch);
  }
}

/**
 * When a second group independently lands on the same override, that is no longer a local exception
 * — it is evidence the shared term is wrong. Push it to the admins rather than leaving it for
 * someone to notice on a dashboard: the people who can act are factory staff with day jobs, and
 * unprompted maintenance work does not happen.
 */
async function notifyAgreedOverrides(deps: GlossaryCommandDeps, sessionId: string, batch: string[]): Promise<void> {
  const seen = new Set<string>();
  const notices: string[] = [];
  for (const line of batch) {
    const m = line.match(/^(.+?)\s*(?:=|→|->)\s*(.+)$/);
    if (!m) continue;
    const [zh, vi] = [m[1].trim(), m[2].trim()];
    const groups = deps.glossary.overrideLayer.groupsAgreeingOn(zh, vi);
    if (groups.length < 2 || seen.has(zh)) continue;
    seen.add(zh);
    notices.push(`${groups.length} 個群都把「${zh}」改成「${vi}」，要改成全域嗎？回覆 /g global ${zh} = ${vi}`);
  }
  if (!notices.length) return;
  if (!deps.adminIds.size) {
    // Degrades to a log rather than silently doing nothing — the same empty-admin-list footgun that
    // already bit this module once.

    console.warn(`[glossary] ${notices.length} override(s) agreed across groups but TRANSLATE_ADMIN_IDS is empty`);
    return;
  }
  const text = BOT_MARKER + notices.join('\n');
  for (const admin of deps.adminIds) {
    // Best-effort: a failed admin DM must not roll back an override the group already saw acked.
    await deps.messageService.sendText(sessionId, { chatId: admin, text }).catch(() => undefined);
  }
}

// Keyword alerts are per-user (each manages their own list), so no admin gate. The ack replies in the
// same chat where it was typed — always deliverable, unlike a DM to a watcher that may be an unresolved
// @lid. The MATCH alert (sent from the service) is what DMs the watcher.
export async function handleWatchCommand(ctx: CommandContext): Promise<void> {
  const watcher = ctx.msg.author || ctx.msg.from;
  if (!watcher || !ctx.msg.chatId) return;
  const reply = ctx.deps.watchwords.command(ctx.rest, watcher);
  await ctx.deps.messageService.sendText(ctx.sessionId, { chatId: ctx.msg.chatId, text: BOT_MARKER + reply });
}

// /bad — quote the bot's translation and report it as wrong. v1 just collects (read-only); the ring
// buffer recovers the original text, falling back to the quoted body when the send predates this run.
export async function handleBadCommand(ctx: CommandContext): Promise<void> {
  if (!ctx.msg.chatId) return;
  const reporter = ctx.msg.author || ctx.msg.from;
  const quoted = ctx.msg.quotedMessage;
  const send = (text: string): Promise<unknown> =>
    ctx.deps.messageService.sendText(ctx.sessionId, { chatId: ctx.msg.chatId, text: BOT_MARKER + text });
  if (!quoted?.id) {
    await send('請「引用」要回報的翻譯訊息，再輸入 /bad。');
    return;
  }
  const fallback = quoted.body.replace(BOT_MARKER, '').trim();
  const entry = ctx.deps.feedback.report(quoted.id, fallback, reporter);
  await send(`已記錄翻譯回饋，謝謝。原文：${entry.source || '（無法回溯，已記譯文）'}`);
}

export async function handleHelpCommand(
  messageService: MessageService,
  sessionId: string,
  msg: IncomingMessage,
): Promise<void> {
  const target = msg.chatId;
  if (!target) return;
  await messageService.sendText(sessionId, { chatId: target, text: BOT_MARKER + HELP_TEXT });
}
