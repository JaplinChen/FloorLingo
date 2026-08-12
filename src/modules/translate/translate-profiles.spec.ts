import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatProfileStore } from './translate-profiles';

describe('ChatProfileStore', () => {
  let file: string;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-')), 'chat-profiles.json');
  });

  it('sets, gets, lists and overwrites a profile', () => {
    const p = new ChatProfileStore(file);
    p.set('123@g.us', '越南工廠A班群組');
    expect(p.get('123@g.us')).toBe('越南工廠A班群組');
    expect(p.entries()).toEqual([{ chatId: '123@g.us', text: '越南工廠A班群組' }]);
    p.set('123@g.us', '改為B班');
    expect(p.entries()).toEqual([{ chatId: '123@g.us', text: '改為B班' }]);
  });

  it('persists across reloads', () => {
    const p = new ChatProfileStore(file);
    p.set('123@g.us', '出貨群，常提櫃號與船期');
    const reloaded = new ChatProfileStore(file);
    expect(reloaded.load()).toBe(1);
    expect(reloaded.entries()).toEqual([{ chatId: '123@g.us', text: '出貨群，常提櫃號與船期' }]);
  });

  it('removes a profile and reports whether it existed', () => {
    const p = new ChatProfileStore(file);
    p.set('123@g.us', '背景');
    expect(p.remove('123@g.us')).toBe(true);
    expect(p.entries()).toEqual([]);
    expect(p.remove('nope')).toBe(false);
  });

  it('section returns a prompt appendix only for chats with a profile', () => {
    const p = new ChatProfileStore(file);
    p.set('123@g.us', '工廠品管群');
    expect(p.section('123@g.us')).toBe('\n群組背景（僅供理解語境，不要在譯文輸出）：工廠品管群');
    expect(p.section('456@g.us')).toBe('');
    expect(p.section('')).toBe('');
  });

  it('truncates profile text to 500 characters on set', () => {
    const p = new ChatProfileStore(file);
    p.set('123@g.us', 'a'.repeat(600));
    expect(p.get('123@g.us')).toBe('a'.repeat(500));
    expect(p.section('123@g.us').endsWith('a'.repeat(500))).toBe(true);
  });
});
