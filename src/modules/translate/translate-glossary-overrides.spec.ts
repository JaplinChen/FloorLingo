import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OverrideLayer, groupKey } from './translate-glossary-overrides';

const layer = (): OverrideLayer => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-'));
  const l = new OverrideLayer(path.join(dir, 'glossary-overrides.json'));
  l.load();
  return l;
};

describe('groupKey', () => {
  it('keeps the whole local part, so legacy groups never collide', () => {
    // The bug this function exists to avoid: jidDigits() takes the FIRST digit run, so both of
    // these legacy JIDs (and the creator's own personal JID) collapse to "886912345678".
    expect(groupKey('886912345678-1609459200@g.us')).not.toBe(groupKey('886912345678-1700000000@g.us'));
    expect(groupKey('886912345678-1609459200@g.us')).not.toBe(groupKey('886912345678@c.us'));
    expect(groupKey('886912345678-1609459200@g.us')).toBe('886912345678-1609459200');
  });

  it('strips known suffixes so one group is one key', () => {
    expect(groupKey('120363123@g.us')).toBe('120363123');
    expect(groupKey('120363123@s.whatsapp.net')).toBe('120363123');
    expect(groupKey('120363123@lid')).toBe('120363123');
    expect(groupKey('  120363123@G.US  ')).toBe('120363123');
  });

  it('leaves an unknown suffix alone rather than mangling it', () => {
    expect(groupKey('120363123@newsuffix')).toBe('120363123@newsuffix');
  });
});

describe('OverrideLayer', () => {
  it('scopes an override to one group', () => {
    const l = layer();
    l.set('A@g.us', '出貨', 'xuất kho');
    expect(l.get('A@g.us', 'zh-tw:vi', '出貨')).toBe('xuất kho');
    expect(l.get('B@g.us', 'zh-tw:vi', '出貨')).toBeUndefined();
  });

  it('stores both directions', () => {
    const l = layer();
    l.set('A@g.us', '出貨', 'xuất kho');
    expect(l.get('A@g.us', 'vi:zh-tw', 'xuất kho')).toBe('出貨');
    // Shadowing only happens on the colliding source key: the global vi:zh-tw['giao hàng'] is
    // untouched, which is intended — that reverse mapping is still correct, just not this group's.
    expect(l.get('A@g.us', 'vi:zh-tw', 'giao hàng')).toBeUndefined();
  });

  it('survives a reload, version marker and all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-'));
    const file = path.join(dir, 'glossary-overrides.json');
    const first = new OverrideLayer(file);
    first.load();
    first.set('A@g.us', '出貨', 'xuất kho');

    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(raw.__v).toBe(2);

    const second = new OverrideLayer(file);
    expect(second.load()).toBe(1);
    expect(second.get('A@g.us', 'zh-tw:vi', '出貨')).toBe('xuất kho');
    // __v must not be mistaken for a group, and the reverse direction must not double the row.
    expect(second.all()).toEqual([{ group: 'a', pairKey: 'zh-tw:vi', source: '出貨', target: 'xuất kho' }]);
  });

  it('removes from one group only, and never reaches upward', () => {
    const l = layer();
    l.set('A@g.us', '出貨', 'xuất kho');
    l.set('B@g.us', '出貨', 'giao gấp');

    expect(l.remove('A@g.us', '出貨')).toBe(true);
    expect(l.get('A@g.us', 'zh-tw:vi', '出貨')).toBeUndefined();
    expect(l.get('B@g.us', 'zh-tw:vi', '出貨')).toBe('giao gấp'); // untouched
    expect(l.remove('A@g.us', '出貨')).toBe(false); // gone, and no fallback search
  });

  it('matches either side on remove', () => {
    const l = layer();
    l.set('A@g.us', '出貨', 'xuất kho');
    expect(l.remove('A@g.us', 'xuất kho')).toBe(true);
    expect(l.entriesFor('A@g.us', 'zh-tw:vi')).toEqual([]);
  });

  it('counts overrides once, not once per direction', () => {
    const l = layer();
    l.set('A@g.us', '出貨', 'xuất kho');
    l.set('A@g.us', '客戶', 'khách');
    l.set('B@g.us', '出貨', 'giao gấp');
    expect(l.count()).toBe(3);
    expect(l.counts()).toEqual({ a: 2, b: 1 });
  });

  it('reports which groups already agree on the same override', () => {
    const l = layer();
    l.set('A@g.us', '出貨', 'xuất kho');
    l.set('B@g.us', '出貨', 'xuất kho');
    l.set('C@g.us', '出貨', 'giao gấp');
    // Two groups landing on the same answer is the signal to ask an admin to change the global term.
    expect(l.groupsAgreeingOn('出貨', 'xuất kho').sort()).toEqual(['a', 'b']);
    expect(l.groupsAgreeingOn('出貨', 'giao gấp')).toEqual(['c']);
  });

  it('flags layers whose group is no longer configured', () => {
    const l = layer();
    l.set('A@g.us', '出貨', 'xuất kho');
    l.set('GONE@g.us', '客戶', 'khách');
    expect(l.orphans(['A@g.us'])).toEqual(['gone']);
    expect(l.orphans(['A@s.whatsapp.net'])).toEqual(['gone']); // suffix-insensitive
  });

  it('treats a corrupt or absent file as no overrides, never a crash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-'));
    const file = path.join(dir, 'glossary-overrides.json');
    fs.writeFileSync(file, '{ this is not json');
    const l = new OverrideLayer(file);
    expect(l.load()).toBe(0);
    expect(l.all()).toEqual([]);
  });
});
