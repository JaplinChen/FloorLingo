import * as fs from 'node:fs';
import { atomicWriteJson } from './translate-fs';

const MAX_DRAFT_LENGTH = 500;

export interface PendingProfile {
  draft: string;
  at: string;
}

/** LLM-drafted profile updates awaiting admin review: chatId -> { draft, at }, flat JSON on disk. */
export class ProfileSuggestionStore {
  private data: Record<string, PendingProfile> = {};

  constructor(private readonly filePath: string) {}

  load(): number {
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, PendingProfile>;
      return Object.keys(this.data).length;
    } catch {
      this.data = {};
      return 0;
    }
  }

  private save(): void {
    atomicWriteJson(this.filePath, this.data);
  }

  entries(): { chatId: string; draft: string; at: string }[] {
    return Object.entries(this.data).map(([chatId, p]) => ({ chatId, draft: p.draft, at: p.at }));
  }

  get(chatId: string): PendingProfile | null {
    return this.data[chatId] || null;
  }

  set(chatId: string, draft: string): void {
    this.data[chatId] = { draft: draft.slice(0, MAX_DRAFT_LENGTH), at: new Date().toISOString() };
    this.save();
  }

  remove(chatId: string): boolean {
    if (!(chatId in this.data)) return false;
    delete this.data[chatId];
    this.save();
    return true;
  }
}

export function buildProfileSuggestPrompt(current: string, messages: string[]): string {
  const sample = messages.map(m => `- ${m}`).join('\n');
  return (
    '你是翻譯背景維護助手。以下是一個工廠 WhatsApp 群組的「現行背景描述」與「近期訊息樣本」。\n' +
    '請根據訊息樣本判斷背景描述是否需要更新，若需要，輸出更新後的完整背景描述；若不需要，輸出空字串。\n' +
    '要求：\n' +
    '- 繁體中文，400 字以內。\n' +
    '- 只寫有助翻譯理解的語境：部門、常見縮寫代號、慣用稱呼。\n' +
    '- 不要逐字複述訊息內容，不要加任何說明或前後綴，只輸出背景描述本身。\n\n' +
    `現行背景描述：${current || '（無）'}\n\n近期訊息樣本：\n${sample}`
  );
}

/** Trim, strip code fences, cap at 500 chars; empty or unchanged output means "no suggestion" (null). */
export function sanitizeDraft(out: string, current: string): string | null {
  let text = (out || '').trim();
  const fence = text.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  text = text.slice(0, MAX_DRAFT_LENGTH).trim();
  if (!text || text === current.trim()) return null;
  return text;
}
