import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProfileSuggestionStore, buildProfileSuggestPrompt, sanitizeDraft } from './translate-profile-suggest';

describe('ProfileSuggestionStore', () => {
  let file: string;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'profile-pending-')), 'chat-profile-pending.json');
  });

  it('sets, gets, lists and overwrites a pending draft', () => {
    const s = new ProfileSuggestionStore(file);
    s.set('123@g.us', '出貨群，常提櫃號');
    expect(s.get('123@g.us')?.draft).toBe('出貨群，常提櫃號');
    expect(s.get('123@g.us')?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    s.set('123@g.us', '改為品管群');
    expect(s.entries().map(e => e.draft)).toEqual(['改為品管群']);
  });

  it('persists across reloads', () => {
    const s = new ProfileSuggestionStore(file);
    s.set('123@g.us', '越南工廠A班');
    const reloaded = new ProfileSuggestionStore(file);
    expect(reloaded.load()).toBe(1);
    expect(reloaded.entries()[0]).toMatchObject({ chatId: '123@g.us', draft: '越南工廠A班' });
  });

  it('removes a draft and reports whether it existed', () => {
    const s = new ProfileSuggestionStore(file);
    s.set('123@g.us', '背景');
    expect(s.remove('123@g.us')).toBe(true);
    expect(s.entries()).toEqual([]);
    expect(s.remove('nope')).toBe(false);
    expect(s.get('123@g.us')).toBeNull();
  });

  it('caps draft at 500 characters on set', () => {
    const s = new ProfileSuggestionStore(file);
    s.set('123@g.us', 'a'.repeat(600));
    expect(s.get('123@g.us')?.draft).toBe('a'.repeat(500));
  });
});

describe('sanitizeDraft', () => {
  it('trims and returns plain output', () => {
    expect(sanitizeDraft('  出貨群背景  ', '')).toBe('出貨群背景');
  });

  it('strips code fences', () => {
    expect(sanitizeDraft('```\n出貨群背景\n```', '')).toBe('出貨群背景');
    expect(sanitizeDraft('```markdown\n出貨群背景\n```', '')).toBe('出貨群背景');
  });

  it('caps at 500 characters', () => {
    expect(sanitizeDraft('a'.repeat(600), '')).toBe('a'.repeat(500));
  });

  it('returns null for empty output', () => {
    expect(sanitizeDraft('', '現行背景')).toBeNull();
    expect(sanitizeDraft('   ', '現行背景')).toBeNull();
    expect(sanitizeDraft('```\n```', '現行背景')).toBeNull();
  });

  it('returns null when output equals the current profile', () => {
    expect(sanitizeDraft('現行背景', '現行背景')).toBeNull();
    expect(sanitizeDraft(' 現行背景 ', ' 現行背景 ')).toBeNull();
  });
});

describe('buildProfileSuggestPrompt', () => {
  it('includes the current profile and message samples', () => {
    const prompt = buildProfileSuggestPrompt('出貨群', ['櫃號 ABCD1234', '船期延到週五']);
    expect(prompt).toContain('現行背景描述：出貨群');
    expect(prompt).toContain('- 櫃號 ABCD1234');
    expect(prompt).toContain('- 船期延到週五');
    expect(prompt).toContain('400 字以內');
  });

  it('marks an absent current profile', () => {
    expect(buildProfileSuggestPrompt('', ['hi'])).toContain('現行背景描述：（無）');
  });
});
