import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Glossary } from './translate-glossary';

describe('Glossary', () => {
  let file: string;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-')), 'glossary.json');
  });

  it('adds a term in both directions and lists it zh->vi', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    expect(g.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 0 }]);
    // persisted and reloadable
    const reloaded = new Glossary(file);
    reloaded.load();
    expect(reloaded.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 0 }]);
  });

  it('orients reversed input so the CJK term lands on the zh side', () => {
    const g = new Glossary(file);
    g.add('sếp ơi', '長官啊');
    expect(g.entries()).toEqual([{ source: '長官啊', target: 'sếp ơi', count: 0 }]);
    expect(g.section('vi:zh-tw', 'sếp ơi giúp em')).toContain('sếp ơi → 長官啊');
  });

  it('section matches regardless of casing (chat types 5s, glossary says 5S)', () => {
    const g = new Glossary(file);
    g.add('去5S巡檢回來', 'đi 5S về');
    expect(g.section('vi:zh-tw', 'Sếp đi 5s về sẽ thảo luận')).toContain('đi 5S về → 去5S巡檢回來');
  });

  it('section bumps usage count for matched terms in either direction, persisted', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    g.section('zh-tw:vi', '我的電腦壞了');
    g.section('vi:zh-tw', 'máy tính hỏng rồi');
    g.section('zh-tw:vi', '沒提到術語'); // no match → no bump
    expect(g.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 2 }]);
    g.flushUsage(); // counts are batched now; the timer would get there on its own in 1s
    const reloaded = new Glossary(file);
    reloaded.load();
    expect(reloaded.entries()[0].count).toBe(2);
  });

  it('migrates reversed entries persisted by older versions on load', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        'zh-tw:vi': { 'sếp ơi': '長官啊', 電腦: 'máy tính' },
        'vi:zh-tw': { 長官啊: 'sếp ơi', 'máy tính': '電腦' },
      }),
      'utf8',
    );
    const g = new Glossary(file);
    g.load();
    expect(g.entries()).toEqual(
      expect.arrayContaining([
        { source: '長官啊', target: 'sếp ơi', count: 0 },
        { source: '電腦', target: 'máy tính', count: 0 },
      ]),
    );
    expect(g.section('vi:zh-tw', 'sếp ơi')).toContain('sếp ơi → 長官啊');
  });

  it('removes a pairing when the term appears on either side', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    expect(g.remove('máy tính')).toBe(true); // match on target side
    expect(g.entries()).toEqual([]);
    expect(g.remove('nope')).toBe(false);
  });

  it('injects only terms present in the text, not the whole table', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    g.add('印表機', 'máy in');
    // term appears in the text → included
    expect(g.section('zh-tw:vi', '我的電腦壞了')).toContain('電腦 → máy tính');
    // other term absent from the text → excluded (prevents dumping the full glossary)
    expect(g.section('zh-tw:vi', '我的電腦壞了')).not.toContain('印表機');
    // no matching term → empty section
    expect(g.section('zh-tw:vi', '你好嗎')).toBe('');
  });

  it('suggest queues a pending entry and approve moves it into the glossary', () => {
    const g = new Glossary(file);
    const reply = g.command('suggest 電腦 = máy tính', false, 'user@c.us');
    expect(reply).toContain('#1');
    expect(g.pending()).toMatchObject([{ id: 1, zh: '電腦', vi: 'máy tính', suggestedBy: 'user@c.us' }]);
    // persisted and reloadable
    const reloaded = new Glossary(file);
    reloaded.load();
    expect(reloaded.pending()).toHaveLength(1);

    expect(g.command('approve 1', true)).toContain('已核准');
    expect(g.pending()).toEqual([]);
    expect(g.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 0 }]);
  });

  it('reject drops the pending entry without touching the glossary', () => {
    const g = new Glossary(file);
    g.command('suggest 電腦 = máy tính', false, 'user@c.us');
    expect(g.command('reject 1', true)).toContain('已拒絕');
    expect(g.pending()).toEqual([]);
    expect(g.entries()).toEqual([]);
    expect(g.command('approve 1', true)).toContain('找不到');
  });

  it('blocks non-admins from pending/approve/reject but not suggest', () => {
    const g = new Glossary(file);
    g.command('suggest 電腦 = máy tính', false, 'user@c.us');
    expect(g.command('pending', false)).toBe('此指令僅限管理員使用。');
    expect(g.command('approve 1', false)).toBe('此指令僅限管理員使用。');
    expect(g.command('reject 1', false)).toBe('此指令僅限管理員使用。');
    expect(g.pending()).toHaveLength(1);
    expect(g.command('pending', true)).toContain('#1 電腦 = máy tính（user@c.us）');
  });

  it('bare pair adds as admin and suggests as member', () => {
    const g = new Glossary(file);
    expect(g.command('電腦 = máy tính', true)).toContain('已新增術語');
    expect(g.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 0 }]);
    expect(g.command('印表機 = máy in', false, 'user@c.us')).toContain('#1');
    expect(g.pending()).toMatchObject([{ id: 1, zh: '印表機', vi: 'máy in', suggestedBy: 'user@c.us' }]);
  });

  it('ok/no aliases approve and reject', () => {
    const g = new Glossary(file);
    g.command('suggest 電腦 = máy tính', false, 'a');
    g.command('suggest 印表機 = máy in', false, 'a');
    expect(g.command('ok 1', true)).toContain('已核准');
    expect(g.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 0 }]);
    expect(g.command('no 2', true)).toContain('已拒絕');
    expect(g.pending()).toEqual([]);
  });

  it('stores a category in a sidecar, exposes it via entries, and reloads it', () => {
    const g = new Glossary(file);
    g.add('鍵盤', 'bàn phím', 'asset');
    expect(g.entries()).toEqual([{ source: '鍵盤', target: 'bàn phím', count: 0, category: 'asset' }]);
    expect(g.getCategory('鍵盤')).toBe('asset');
    const reloaded = new Glossary(file);
    reloaded.load();
    expect(reloaded.getCategory('鍵盤')).toBe('asset');
  });

  it('omits category when untagged so the entry shape is unchanged', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    expect(g.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 0 }]);
    expect(g.getCategory('電腦')).toBe('');
  });

  it('setCategory with empty string clears the tag', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính', 'term');
    g.setCategory('電腦', '');
    expect(g.getCategory('電腦')).toBe('');
    expect(g.entries()[0]).not.toHaveProperty('category');
  });

  it('remove drops the category tag too', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính', 'term');
    g.remove('電腦');
    const reloaded = new Glossary(file);
    reloaded.load();
    expect(reloaded.getCategory('電腦')).toBe('');
  });

  it('dedupes suggestions against the glossary and the pending list', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    expect(g.command('suggest 電腦 = máy tính', false, 'a')).toContain('已存在');
    expect(g.pending()).toEqual([]);
    g.command('suggest 印表機 = máy in', false, 'a');
    expect(g.command('suggest 印表機 = máy in', false, 'b')).toContain('已存在');
    expect(g.pending()).toHaveLength(1);
  });
});

describe('Glossary origin sidecar', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gl-origin-')), 'glossary.json');

  it('tags pipeline-added terms, omits the field for hand-added ones, and clears on remove', () => {
    const file = tmp();
    const g = new Glossary(file);
    g.load();
    g.add('出貨', 'giao hàng', undefined, 'human');
    g.add('客戶', 'khách hàng'); // typed by hand — no marker

    const bySource = Object.fromEntries(g.entries().map(e => [e.source, e]));
    expect(bySource['出貨'].origin).toBe('human');
    expect('origin' in bySource['客戶']).toBe(false);

    // Survives a reload: the sidecar is on disk, not in memory.
    const reopened = new Glossary(file);
    reopened.load();
    expect(reopened.entries().find(e => e.source === '出貨')?.origin).toBe('human');

    reopened.remove('出貨');
    const after = new Glossary(file);
    after.load();
    after.add('出貨', 'giao hàng'); // re-added by hand — must not inherit the old origin
    expect('origin' in after.entries().find(e => e.source === '出貨')!).toBe(false);
  });
});

describe('Glossary.addMany', () => {
  it('writes the glossary file once for the whole batch', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gl-many-')), 'glossary.json');
    const g = new Glossary(file);
    g.load();

    // save() is what serializes the whole glossary map to disk. Counting it is the point of the
    // test: N terms must cost 1 serialization, not N (see F6 — atomicWriteJson degrades to a
    // non-atomic in-place write on a bind mount, so a restart mid-loop could truncate the file).
    const saves = jest.spyOn(g as unknown as { save: () => void }, 'save');

    g.addMany([
      { zh: '出貨', vi: 'giao hàng', origin: 'bulk' },
      { zh: '客戶', vi: 'khách hàng', origin: 'bulk' },
      { zh: '品質', vi: 'chất lượng', origin: 'bulk' },
    ]);
    expect(saves).toHaveBeenCalledTimes(1);

    // And a single add() must not have regressed into something more expensive.
    saves.mockClear();
    g.add('交期', 'thời hạn giao');
    expect(saves).toHaveBeenCalledTimes(1);
    saves.mockRestore();

    const reopened = new Glossary(file);
    reopened.load();
    expect(reopened.entries().length).toBe(4);
    expect(reopened.entries().filter(e => e.origin === 'bulk').length).toBe(3);
  });

  it('is a no-op on an empty batch', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gl-empty-')), 'glossary.json');
    const g = new Glossary(file);
    g.load();
    g.addMany([]);
    expect(fs.existsSync(file)).toBe(false); // nothing written at all
  });
});

describe('Glossary group overrides', () => {
  const make = (): Glossary => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-ovr-'));
    process.env.TRANSLATE_GLOSSARY_OVERRIDES_PATH = path.join(dir, 'ov.json');
    const g = new Glossary(path.join(dir, 'glossary.json'));
    g.load();
    g.add('出貨', 'giao hàng');
    return g;
  };

  afterEach(() => delete process.env.TRANSLATE_GLOSSARY_OVERRIDES_PATH);

  it('classifies the three write outcomes', () => {
    const g = make();
    expect(g.classifyWrite('出貨', 'giao hàng')).toBe('same');
    expect(g.classifyWrite('出貨', 'xuất kho')).toBe('conflict');
    expect(g.classifyWrite('客戶', 'khách hàng')).toBe('new');
    // Either side may be typed first; orient() decides which is the zh key.
    expect(g.classifyWrite('giao hàng', '出貨')).toBe('same');
  });

  it('section(): the override replaces the global term for that group only', () => {
    const g = make();
    g.setOverride('A@g.us', '出貨', 'xuất kho');

    const inA = g.section('zh-tw:vi', '今天出貨', 'A@g.us');
    expect(inA).toContain('出貨 → xuất kho');
    expect(inA).not.toContain('giao hàng'); // not both — the model would get contradictory orders

    expect(g.section('zh-tw:vi', '今天出貨', 'B@g.us')).toContain('出貨 → giao hàng');
    expect(g.section('zh-tw:vi', '今天出貨')).toContain('出貨 → giao hàng'); // no group = global
  });

  it('section(): a group override never leaks into another group', () => {
    const g = make();
    g.setOverride('A@g.us', '模具', 'khuôn riêng');
    expect(g.section('zh-tw:vi', '換模具', 'A@g.us')).toContain('khuôn riêng');
    expect(g.section('zh-tw:vi', '換模具', 'B@g.us')).toBe(''); // 模具 isn't global at all
  });

  it('exact(): overrides are deliberately excluded, in both directions', () => {
    const g = make();
    g.setOverride('A@g.us', '出貨', 'xuất kho');
    // Whole-message match still answers from the GLOBAL layer even inside the overriding group:
    // exact() is the one path that skips the LLM entirely, so a member must not be able to bind it.
    expect(g.exact('zh-tw:vi', '出貨')).toBe('giao hàng');
    expect(g.exact('vi:zh-tw', 'xuất kho')).toBeNull();
  });

  it('applies to vi->zh for the overriding group', () => {
    const g = make();
    g.setOverride('A@g.us', '出貨', 'xuất kho');
    expect(g.section('vi:zh-tw', 'hôm nay xuất kho', 'A@g.us')).toContain('xuất kho → 出貨');
    // The global reverse mapping is untouched and still correct — it just isn't what A produces.
    expect(g.section('vi:zh-tw', 'hôm nay giao hàng', 'A@g.us')).toContain('giao hàng → 出貨');
  });

  it('removing an override restores the global term and leaves it intact', () => {
    const g = make();
    g.setOverride('A@g.us', '出貨', 'xuất kho');
    expect(g.removeOverride('A@g.us', '出貨')).toBe(true);
    expect(g.section('zh-tw:vi', '今天出貨', 'A@g.us')).toContain('giao hàng');
    expect(g.entries().find(e => e.source === '出貨')?.target).toBe('giao hàng');
  });

  it('survives a reload with the overrides on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-ovr2-'));
    process.env.TRANSLATE_GLOSSARY_OVERRIDES_PATH = path.join(dir, 'ov.json');
    const file = path.join(dir, 'glossary.json');
    const first = new Glossary(file);
    first.load();
    first.add('出貨', 'giao hàng');
    first.setOverride('A@g.us', '出貨', 'xuất kho');

    const second = new Glossary(file);
    second.load();
    expect(second.section('zh-tw:vi', '今天出貨', 'A@g.us')).toContain('xuất kho');
    expect(second.overrideLayer.count()).toBe(1);
  });
});

describe('Glossary /g write dispatch', () => {
  const make = (): Glossary => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-cmd-'));
    process.env.TRANSLATE_GLOSSARY_OVERRIDES_PATH = path.join(dir, 'ov.json');
    const g = new Glossary(path.join(dir, 'glossary.json'));
    g.load();
    g.add('出貨', 'giao hàng');
    return g;
  };
  const member = { canMutate: false, sender: 'u@c.us', groupId: 'A@g.us' };
  const admin = { canMutate: true, sender: 'a@c.us', groupId: 'A@g.us' };

  afterEach(() => delete process.env.TRANSLATE_GLOSSARY_OVERRIDES_PATH);

  it('a new term from a member is a proposal, not a live global write', () => {
    const g = make();
    const reply = g.command('客戶 = khách hàng', member);
    expect(reply).toContain('已收到建議');
    expect(g.entries().find(e => e.source === '客戶')).toBeUndefined(); // shared asset untouched
    expect(g.pending()).toHaveLength(1);
  });

  it('a matching term is a no-op, not a duplicate write', () => {
    const g = make();
    expect(g.command('出貨 = giao hàng', member)).toContain('已存在');
    expect(g.overrideLayer.count()).toBe(0);
    expect(g.pending()).toHaveLength(0);
  });

  it('a conflicting term becomes THIS group override, no review needed', () => {
    const g = make();
    const reply = g.command('出貨 = xuất kho', member);
    expect(reply).toContain('本群專用');
    expect(reply).toContain('giao hàng'); // reply states what global still says
    expect(g.overrideLayer.get('A@g.us', 'zh-tw:vi', '出貨')).toBe('xuất kho');
    expect(g.entries().find(e => e.source === '出貨')?.target).toBe('giao hàng'); // global intact
  });

  it('the three outcomes are distinguishable and bilingual', () => {
    const g = make();
    const replies = [
      g.command('客戶 = khách hàng', member),
      g.command('出貨 = giao hàng', member),
      g.command('出貨 = xuất kho', member),
    ];
    expect(new Set(replies).size).toBe(3); // a member can tell which one happened
    for (const r of replies) expect(r).toMatch(/[À-ỹ]/); // each carries Vietnamese too
  });

  it('/g global writes the shared glossary instead of an override — admin only', () => {
    const g = make();
    expect(g.command('global 出貨 = xuất kho', member)).toContain('僅限管理員');
    expect(g.overrideLayer.count()).toBe(0);

    expect(g.command('global 出貨 = xuất kho', admin)).toContain('已更新全域');
    expect(g.entries().find(e => e.source === '出貨')?.target).toBe('xuất kho');
    expect(g.overrideLayer.count()).toBe(0); // admin's global fix did NOT become a group override
  });

  it('/g gdel removes from the shared glossary — admin only', () => {
    const g = make();
    expect(g.command('gdel 出貨', member)).toContain('僅限管理員');
    expect(g.command('gdel 出貨', admin)).toContain('已從全域移除');
    expect(g.entries()).toHaveLength(0);
    expect(g.command('gdel 不存在', admin)).toContain('找不到');
  });

  it('outside a group a conflicting write is still admin-gated, never an override', () => {
    const g = make();
    const noGroup = { canMutate: false, sender: 'u@c.us' };
    expect(g.command('出貨 = xuất kho', noGroup)).toContain('已收到建議');
    expect(g.overrideLayer.count()).toBe(0);
  });

  it('still accepts the old positional call shape', () => {
    const g = make();
    expect(g.command('global 客戶 = khách', true)).toContain('已更新全域');
  });
});

describe('Glossary self-heal on shared-glossary writes', () => {
  const make = (): Glossary => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-heal-'));
    process.env.TRANSLATE_GLOSSARY_OVERRIDES_PATH = path.join(dir, 'ov.json');
    const g = new Glossary(path.join(dir, 'glossary.json'));
    g.load();
    g.add('生產', 'San xuat');
    return g;
  };
  const admin = { canMutate: true, sender: 'a@c.us', groupId: 'A@g.us' };

  afterEach(() => delete process.env.TRANSLATE_GLOSSARY_OVERRIDES_PATH);

  it('/g global adopting a group wording removes that group override and says so', () => {
    const g = make();
    g.command('生產 = sản xuất', { canMutate: false, sender: 'u@c.us', groupId: 'A@g.us' });
    expect(g.overrideLayer.count()).toBe(1);

    const reply = g.command('global 生產 = sản xuất', admin);
    expect(reply).toContain('已更新全域術語');
    expect(reply).toContain('已清除 1 筆');
    expect(g.overrideLayer.count()).toBe(0);
    expect(g.entries().find(e => e.source === '生產')?.target).toBe('sản xuất');
  });

  it('every path into the shared glossary heals, not just /g global', () => {
    const g = make();
    g.setOverride('A@g.us', '生產', 'sản xuất');
    // A dashboard edit / approved suggestion / bulk approval all land in addMany.
    expect(g.addMany([{ zh: '生產', vi: 'sản xuất' }])).toBe(1);
    expect(g.overrideLayer.count()).toBe(0);
  });

  it('a shared write that does not match leaves the override alone', () => {
    const g = make();
    g.setOverride('A@g.us', '生產', 'sản xuất');
    expect(g.add('生產', 'sx khác')).toBe(0);
    expect(g.overrideLayer.get('A@g.us', 'zh-tw:vi', '生產')).toBe('sản xuất');
  });

  it('reports nothing extra when there was nothing to prune', () => {
    const g = make();
    expect(g.command('global 生產 = sản xuất', admin)).not.toContain('已清除');
  });
});

describe('Glossary usage counter writes', () => {
  const make = (): { g: Glossary; usagePath: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-usage-'));
    process.env.TRANSLATE_GLOSSARY_OVERRIDES_PATH = path.join(dir, 'ov.json');
    const file = path.join(dir, 'glossary.json');
    const g = new Glossary(file);
    g.load();
    g.add('出貨', 'giao hàng');
    g.add('客戶', 'khách hàng');
    g.add('品質', 'chất lượng');
    return { g, usagePath: path.join(dir, 'glossary-usage.json') };
  };

  afterEach(() => delete process.env.TRANSLATE_GLOSSARY_OVERRIDES_PATH);

  it('does not touch disk while counting — section() used to write once per matched term', () => {
    const { g, usagePath } = make();
    g.section('zh-tw:vi', '出貨 客戶 品質 一起處理'); // three matches
    expect(fs.existsSync(usagePath)).toBe(false); // nothing written yet
  });

  it('flush persists every pending count in one write', () => {
    const { g, usagePath } = make();
    g.section('zh-tw:vi', '出貨 客戶 品質 一起處理');
    g.exact('zh-tw:vi', '出貨');
    g.flushUsage();

    const saved = JSON.parse(fs.readFileSync(usagePath, 'utf8')) as Record<string, number>;
    expect(saved).toEqual({ 出貨: 2, 客戶: 1, 品質: 1 });
  });

  it('flush is a no-op when nothing is pending', () => {
    const { g, usagePath } = make();
    g.flushUsage();
    expect(fs.existsSync(usagePath)).toBe(false);
    g.section('zh-tw:vi', '出貨');
    g.flushUsage();
    const mtime = fs.statSync(usagePath).mtimeMs;
    g.flushUsage(); // second flush, still clean
    expect(fs.statSync(usagePath).mtimeMs).toBe(mtime);
  });

  it('counts survive a reload once flushed', () => {
    const { g, usagePath } = make();
    g.section('zh-tw:vi', '出貨');
    g.flushUsage();
    const reopened = new Glossary(usagePath.replace('-usage.json', '.json'));
    reopened.load();
    expect(reopened.entries().find(e => e.source === '出貨')?.count).toBe(1);
  });
});
