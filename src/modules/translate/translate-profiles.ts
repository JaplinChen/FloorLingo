import * as fs from 'node:fs';
import { atomicWriteJson } from './translate-fs';

const MAX_PROFILE_LENGTH = 500;

/**
 * Per-chat background/context notes: chatId -> free text, persisted as flat JSON. Injected into the
 * translation prompt so the model understands group-specific context (people, products, in-jokes)
 * without ever echoing it in the output.
 */
export class ChatProfileStore {
  private data: Record<string, string> = {};

  constructor(private readonly filePath: string) {}

  /** Load from disk; returns the entry count (0 if absent/unreadable — fine, translate without it). */
  load(): number {
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, string>;
      return Object.keys(this.data).length;
    } catch {
      this.data = {};
      return 0;
    }
  }

  private save(): void {
    atomicWriteJson(this.filePath, this.data);
  }

  entries(): { chatId: string; text: string }[] {
    return Object.entries(this.data).map(([chatId, text]) => ({ chatId, text }));
  }

  get(chatId: string): string {
    return this.data[chatId] || '';
  }

  set(chatId: string, text: string): void {
    this.data[chatId] = text.slice(0, MAX_PROFILE_LENGTH);
    this.save();
  }

  remove(chatId: string): boolean {
    if (!(chatId in this.data)) return false;
    delete this.data[chatId];
    this.save();
    return true;
  }

  /** Prompt appendix for a chat's profile, '' when the chat has none. */
  section(chatId: string): string {
    const text = chatId ? this.data[chatId] : '';
    if (!text) return '';
    return `\n群組背景（僅供理解語境，不要在譯文輸出）：${text}`;
  }
}
