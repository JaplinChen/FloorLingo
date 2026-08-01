import * as fs from 'node:fs';
import { atomicWriteJson } from './translate-fs';
import { OverrideLayer } from './translate-glossary-overrides';

/**
 * zh<->vi term overrides, persisted as JSON keyed by pair (e.g. "zh-tw:vi") -> { source: target }.
 * Format is compatible with WA-Translate's glossary.json.
 */
export interface PendingSuggestion {
  id: number;
  zh: string;
  vi: string;
  suggestedBy: string;
  at: string;
}

export class Glossary {
  private data: Record<string, Record<string, string>> = {};
  private pendingData: PendingSuggestion[] = [];
  private usage: Record<string, number> = {};
  private categories: Record<string, string> = {};
  private origins: Record<string, string> = {};
  private readonly pendingPath: string;
  private readonly usagePath: string;
  private readonly categoryPath: string;
  private readonly originPath: string;
  // Per-group conflict overrides. Its own file and class: the global glossary format stays
  // WA-Translate compatible and this file stays readable.
  private readonly overrides: OverrideLayer;

  constructor(
    private readonly filePath: string,
    pendingPath?: string,
  ) {
    this.pendingPath = pendingPath || filePath.replace(/\.json$/, '-pending.json');
    this.usagePath = filePath.replace(/\.json$/, '-usage.json');
    this.categoryPath = filePath.replace(/\.json$/, '-category.json');
    this.originPath = filePath.replace(/\.json$/, '-origin.json');
    this.overrides = new OverrideLayer(
      process.env.TRANSLATE_GLOSSARY_OVERRIDES_PATH || filePath.replace(/\.json$/, '-overrides.json'),
    );
  }

  private static readonly CJK = /[一-鿿]/;

  /** Users type pairs in either direction; put the CJK term on the zh side (no-op when ambiguous). */
  private static orient(a: string, b: string): [string, string] {
    return !Glossary.CJK.test(a) && Glossary.CJK.test(b) ? [b, a] : [a, b];
  }

  /** Load from disk; returns the total term count (0 if absent/unreadable — fine, translate without it). */
  load(): number {
    try {
      this.pendingData = JSON.parse(fs.readFileSync(this.pendingPath, 'utf8')) as PendingSuggestion[];
    } catch {
      this.pendingData = [];
    }
    try {
      this.usage = JSON.parse(fs.readFileSync(this.usagePath, 'utf8')) as Record<string, number>;
    } catch {
      this.usage = {};
    }
    try {
      this.categories = JSON.parse(fs.readFileSync(this.categoryPath, 'utf8')) as Record<string, string>;
    } catch {
      this.categories = {};
    }
    try {
      this.origins = JSON.parse(fs.readFileSync(this.originPath, 'utf8')) as Record<string, string>;
    } catch {
      this.origins = {};
    }
    this.overrides.load();
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, Record<string, string>>;
      this.migrateReversed();
      return Object.values(this.data).reduce((n, m) => n + Object.keys(m).length, 0);
    } catch {
      this.data = {};
      return 0;
    }
  }

  /** Self-heal entries stored on the wrong side by pre-orient versions (e.g. "sếp ơi" under zh). */
  private migrateReversed(): void {
    let changed = false;
    const pairs: [string, string][] = [
      ...Object.entries(this.data['zh-tw:vi'] || {}).map(([zh, vi]): [string, string] => [zh, vi]),
      ...Object.entries(this.data['vi:zh-tw'] || {}).map(([vi, zh]): [string, string] => [zh, vi]),
    ];
    for (const [zh, vi] of pairs) {
      const [z, v] = Glossary.orient(zh, vi);
      if (z !== zh) {
        delete this.data['zh-tw:vi']?.[zh];
        delete this.data['vi:zh-tw']?.[vi];
        (this.data['zh-tw:vi'] ??= {})[z] = v;
        (this.data['vi:zh-tw'] ??= {})[v] = z;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private save(): void {
    atomicWriteJson(this.filePath, this.data);
  }

  private savePending(): void {
    atomicWriteJson(this.pendingPath, this.pendingData);
  }

  /** Usage counters keyed by the zh term, persisted beside the glossary so its format stays WA-Translate compatible. */
  private bump(zh: string): void {
    this.usage[zh] = (this.usage[zh] ?? 0) + 1;
    try {
      atomicWriteJson(this.usagePath, this.usage);
    } catch {
      // Best-effort sidecar: a write failure must never break a translation in flight.
    }
  }

  /** zh->vi terms as a flat list for the dashboard/API (source = 中文, target = 越南文). */
  entries(): { source: string; target: string; count: number; category?: string; origin?: string }[] {
    return Object.entries(this.data['zh-tw:vi'] || {}).map(([source, target]) => {
      // Omit category/origin when unset so existing callers (and equality checks) see the original shape.
      const category = this.categories[source];
      const origin = this.origins[source];
      return {
        source,
        target,
        count: this.usage[source] ?? 0,
        ...(category ? { category } : {}),
        ...(origin ? { origin } : {}),
      };
    });
  }

  /**
   * Where a term came from, when it wasn't typed by hand. Sidecar like usage/category so glossary.json
   * stays WA-Translate compatible. Only set for pipeline-approved terms — a blank origin means a human
   * added it directly, which is the majority and needs no marker.
   */
  setOrigin(zh: string, origin: string): void {
    if (origin) this.origins[zh] = origin;
    else delete this.origins[zh];
    this.writeOrigins();
  }

  private writeOrigins(): void {
    try {
      atomicWriteJson(this.originPath, this.origins);
    } catch {
      // Best-effort: provenance is also in phrase_events, this sidecar only feeds the terms list.
    }
  }

  /** The category tag for a zh term (empty string when untagged). Keyed by the zh side like usage. */
  getCategory(zh: string): string {
    return this.categories[zh] ?? '';
  }

  /** Set (or clear, when empty) a zh term's category, persisting the sidecar. Keeps glossary.json format. */
  setCategory(zh: string, category: string): void {
    if (category) this.categories[zh] = category;
    else delete this.categories[zh];
    atomicWriteJson(this.categoryPath, this.categories);
  }

  /**
   * Add/overwrite a zh<->vi term in both directions, persisting immediately. Optional category and
   * origin sidecars. `origin` is a 4th positional param on purpose: several callers already pass
   * `category` positionally, so an options object in slot 3 would silently break them.
   */
  add(zh: string, vi: string, category?: string, origin?: string): number {
    return this.addMany([{ zh, vi, category, origin }]);
  }

  /**
   * Add many terms with ONE write per file. `add()` routes through here so both paths share one
   * implementation: approving in bulk via N× add() would re-serialize the whole glossary (and both
   * sidecars) per term, and atomicWriteJson falls back to a non-atomic in-place write on EBUSY/EXDEV
   * — the bind-mount case — so a restart mid-loop could truncate the file.
   */
  addMany(pairs: { zh: string; vi: string; category?: string; origin?: string }[]): number {
    if (!pairs.length) return 0;
    let categoryChanged = false;
    let originChanged = false;
    const oriented: { zh: string; vi: string }[] = [];
    for (const pair of pairs) {
      const [zh, vi] = Glossary.orient(pair.zh, pair.vi);
      oriented.push({ zh, vi });
      (this.data['zh-tw:vi'] ??= {})[zh] = vi;
      (this.data['vi:zh-tw'] ??= {})[vi] = zh;
      if (pair.category !== undefined) {
        if (pair.category) this.categories[zh] = pair.category;
        else delete this.categories[zh];
        categoryChanged = true;
      }
      if (pair.origin !== undefined) {
        if (pair.origin) this.origins[zh] = pair.origin;
        else delete this.origins[zh];
        originChanged = true;
      }
    }
    this.save();
    if (categoryChanged) atomicWriteJson(this.categoryPath, this.categories);
    if (originChanged) this.writeOrigins();
    // Self-heal: any group override that now matches the shared value has stopped being a deviation.
    // Done here rather than at each call site so every path into the shared glossary — /g global, a
    // dashboard edit, approving a suggestion, bulk-approving candidates — cleans up after itself.
    return this.overrides.pruneRedundant(oriented);
  }

  /** Remove any pairing where `term` appears on either side; returns whether anything was removed. */
  remove(term: string): boolean {
    let removed = false;
    for (const terms of Object.values(this.data)) {
      for (const [s, t] of Object.entries(terms)) {
        if (s === term || t === term) {
          delete terms[s];
          removed = true;
        }
      }
    }
    if (this.origins[term]) this.setOrigin(term, '');
    if (this.categories[term]) {
      delete this.categories[term];
      atomicWriteJson(this.categoryPath, this.categories);
    }
    if (removed) this.save();
    return removed;
  }

  /**
   * Whether `term` is a source-side term for this pair. Exact match on purpose: section() matches the
   * body case-sensitively, so a case-insensitive answer here would skip expanding a token whose
   * glossary rule then never fires — leaving the model with a bare abbreviation and no hint.
   */
  hasSource(pairKey: string, term: string): boolean {
    return term in (this.data[pairKey] || {});
  }

  has(zh: string, vi: string): boolean {
    return (this.data['zh-tw:vi'] || {})[zh] === vi;
  }

  pending(): PendingSuggestion[] {
    return [...this.pendingData];
  }

  /** Queue a suggestion; returns the assigned id, or null when the pair already exists (glossary or pending). */
  suggest(zh: string, vi: string, suggestedBy: string): number | null {
    [zh, vi] = Glossary.orient(zh, vi);
    if (this.has(zh, vi) || this.pendingData.some(p => p.zh === zh && p.vi === vi)) return null;
    const id = this.pendingData.reduce((m, p) => Math.max(m, p.id), 0) + 1;
    this.pendingData.push({ id, zh, vi, suggestedBy, at: new Date().toISOString() });
    this.savePending();
    return id;
  }

  /** Move a pending suggestion into the glossary; returns it, or null when the id is unknown. */
  approve(id: number): PendingSuggestion | null {
    const entry = this.pendingData.find(p => p.id === id);
    if (!entry) return null;
    this.pendingData = this.pendingData.filter(p => p.id !== id);
    this.savePending();
    this.add(entry.zh, entry.vi);
    return entry;
  }

  /** Drop a pending suggestion; returns it, or null when the id is unknown. */
  reject(id: number): PendingSuggestion | null {
    const entry = this.pendingData.find(p => p.id === id);
    if (!entry) return null;
    this.pendingData = this.pendingData.filter(p => p.id !== id);
    this.savePending();
    return entry;
  }

  /**
   * Whole-message exact match: if `text` (trimmed) is itself a glossary source term for this pair,
   * return its target so the caller can answer directly without an LLM call. Bumps usage like section().
   * Used for short conversational phrases (明白/好/收到) that weak models otherwise reply to
   * conversationally instead of translating. Substring matches are intentionally NOT handled here —
   * that stays with section()'s prompt injection, so a term inside a longer sentence still goes to the LLM.
   *
   * GLOBAL LAYER ONLY, on purpose. This is the one path that returns a reply without calling the LLM
   * at all, and the reply is indistinguishable from a real translation. Letting a group override
   * reach it would let any member permanently bind arbitrary output to a whole message for their
   * whole group, with no model in the loop. Overrides exist to disambiguate a term inside a
   * sentence, which is section()'s job, so they lose nothing by being excluded here.
   */
  exact(pairKey: string, text = ''): string | null {
    const target = (this.data[pairKey] || {})[text.trim()];
    if (!target) return null;
    this.bump(pairKey.startsWith('vi') ? target : text.trim());
    return target;
  }

  /**
   * Prompt section injecting ONLY the terms whose source actually appears in `text` (empty when none).
   * Injecting the whole table (hundreds of entries) bloats the prompt and makes weak models echo the
   * term list back as their "translation" — so filter to what this message really uses.
   */
  section(pairKey: string, text = '', groupId?: string): string {
    const hit = (map: Record<string, string>): [string, string][] =>
      Object.entries(map).filter(([source]) => text.includes(source));

    // Global first, then this group's overrides on top: a Map keyed by source means an override
    // silently replaces the global entry for the same term instead of injecting both, which would
    // hand the model two contradictory instructions in one mandatory-use list.
    const merged = new Map(hit(this.data[pairKey] || {}));
    if (groupId)
      for (const [s, t] of hit(Object.fromEntries(this.overrides.entriesFor(groupId, pairKey)))) merged.set(s, t);

    const entries = [...merged];
    if (!entries.length) return '';
    for (const [s, t] of entries) this.bump(pairKey.startsWith('vi') ? t : s);
    return ['', '術語表（必須使用以下對照翻譯）：', ...entries.map(([s, t]) => `- ${s} → ${t}`), ''].join('\n');
  }

  /** Read-only view of the override layer for the service, commands and the dashboard API. */
  get overrideLayer(): OverrideLayer {
    return this.overrides;
  }

  /**
   * What a `/g 詞 = 譯法` in a group means, given the global layer. This is the whole permission
   * model in one function:
   *   'new'      global doesn't know the term  -> propose it (pending queue, admin approves).
   *                                               Writing the SHARED asset needs review.
   *   'same'     global already says this      -> no-op.
   *   'conflict' global says something else    -> this group's override. Only affects them, so a
   *                                               member may do it without review.
   */
  classifyWrite(zh: string, vi: string): 'new' | 'same' | 'conflict' {
    const [z, v] = Glossary.orient(zh, vi);
    const current = (this.data['zh-tw:vi'] || {})[z];
    if (current === undefined) return 'new';
    return current === v ? 'same' : 'conflict';
  }

  /** Write a group override, orienting first so callers can pass either side. */
  setOverride(groupId: string, zh: string, vi: string): void {
    const [z, v] = Glossary.orient(zh, vi);
    this.overrides.set(groupId, z, v);
  }

  /** Remove a group override by either side. Never reaches the global layer — see OverrideLayer.remove. */
  removeOverride(groupId: string, term: string): boolean {
    return this.overrides.remove(groupId, term);
  }

  /**
   * Handle a `/glossary ...` command body (already stripped of the leading token). `canMutate` gates
   * add/del (admin allowlist). Returns the reply text; mutations persist immediately.
   *   /glossary                       list all terms
   *   /glossary add <中文> = <越南文>   add both directions
   *   /glossary del <詞>               remove any pairing where the term appears on either side
   *   /glossary suggest 中文 = vi       queue a suggestion (anyone; `sender` is recorded)
   *   /glossary pending|approve|reject  admin review of queued suggestions
   */
  command(
    rest: string,
    opts: { canMutate: boolean; sender?: string; groupId?: string } | boolean,
    legacySender = '',
  ): string {
    // Accepts the old positional form so existing callers/tests keep working.
    const o = typeof opts === 'boolean' ? { canMutate: opts, sender: legacySender, groupId: undefined } : opts;
    const canMutate = o.canMutate;
    const sender = o.sender ?? '';
    const groupId = o.groupId;

    // Admin-only explicit global verbs. Without these an admin can never touch the shared glossary
    // from WhatsApp: DMs return before command dispatch, so every /g arrives with a groupId, and the
    // bare form would turn an admin's global correction into a group override.
    const globalSet = rest.match(/^global\s+(.+?)\s*(?:=|→|->)\s*(.+)$/i);
    if (globalSet) {
      if (!canMutate) return '此指令僅限管理員使用。/ Chỉ quản trị viên.';
      const [zh, vi] = [globalSet[1].trim(), globalSet[2].trim()];
      if (!zh || !vi) return '格式錯誤：/g global 中文 = tiếng Việt';
      const pruned = this.add(zh, vi);
      const base = `已更新全域術語 / Đã cập nhật từ điển chung：${zh} ⇄ ${vi}`;
      // Say it out loud: adopting a group's wording silently deleting that group's override would be
      // a surprise the next time someone wondered where it went.
      return pruned
        ? `${base}
（已清除 ${pruned} 筆不再有差異的群組專用譯法 / đã xoá ${pruned} bản riêng không còn khác biệt）`
        : base;
    }
    const globalDel = rest.match(/^gdel\s+(.+)$/i);
    if (globalDel) {
      if (!canMutate) return '此指令僅限管理員使用。/ Chỉ quản trị viên.';
      const term = globalDel[1].trim();
      return this.remove(term)
        ? `已從全域移除 / Đã xoá khỏi từ điển chung：${term}`
        : `全域找不到此術語 / Không tìm thấy：${term}`;
    }

    return this.commandRest(rest, canMutate, sender, groupId);
  }

  private commandRest(rest: string, canMutate: boolean, sender: string, groupId?: string): string {
    if (!rest || /^list$/i.test(rest)) {
      const lines: string[] = [];
      for (const [key, terms] of Object.entries(this.data)) {
        const entries = Object.entries(terms);
        if (entries.length) lines.push(`[${key}]`, ...entries.map(([s, t]) => `- ${s} → ${t}`));
      }
      return lines.length ? ['術語表：', ...lines].join('\n') : '術語表目前為空。';
    }

    const suggest = rest.match(/^suggest\s+(.+?)\s*(?:=|→|->)\s*(.+)$/i);
    if (suggest) {
      const zh = suggest[1].trim();
      const vi = suggest[2].trim();
      if (!zh || !vi) return '格式錯誤，請用：/glossary suggest 中文 = tiếng Việt';
      const id = this.suggest(zh, vi, sender);
      if (id === null) return `此術語已存在或已在待審清單：${zh} ⇄ ${vi}`;
      return `已收到建議 #${id}：${zh} ⇄ ${vi}，待管理員審核。`;
    }
    if (/^suggest\b/i.test(rest)) return '格式錯誤，請用：/glossary suggest 中文 = tiếng Việt';

    const bare = /^(?:add|del(?:ete)?|pending|approve|reject|ok|no|list)\b/i.test(rest)
      ? null
      : rest.match(/^(.+?)\s*(?:=|→|->)\s*(.+)$/);
    if (bare) {
      const zh = bare[1].trim();
      const vi = bare[2].trim();
      if (zh && vi) {
        // Three outcomes, and the reply has to make clear WHICH one happened — they have very
        // different consequences and the audience is bilingual.
        const outcome = this.classifyWrite(zh, vi);
        if (outcome === 'same') return `已存在，未變更 / Đã có sẵn：${zh} ⇄ ${vi}`;

        if (outcome === 'conflict' && groupId) {
          // The shared glossary says something else. Scoping the disagreement to this group affects
          // only this group, so a member may do it without review — and the reply is posted in the
          // group, which is what makes it socially visible.
          const current = (this.data['zh-tw:vi'] || {})[Glossary.orient(zh, vi)[0]];
          this.setOverride(groupId, zh, vi);
          return `已設為本群專用譯法 / Đã đặt riêng cho nhóm này：${zh} → ${vi}\n（全域仍為 / Từ điển chung vẫn là：${current}）`;
        }

        if (canMutate) {
          this.add(zh, vi);
          return `已新增術語 / Đã thêm：${zh} ⇄ ${vi}`;
        }
        // Writing the SHARED glossary needs review, whatever the sender's group role.
        const id = this.suggest(zh, vi, sender);
        if (id === null) return `此術語已存在或已在待審清單：${zh} ⇄ ${vi}`;
        return `已收到建議 #${id} / Đã nhận đề xuất：${zh} ⇄ ${vi}，待管理員審核 / chờ duyệt。`;
      }
    }

    if (!canMutate) return '此指令僅限管理員使用。';

    if (/^pending$/i.test(rest)) {
      if (!this.pendingData.length) return '目前沒有待審建議。';
      return ['待審建議：', ...this.pendingData.map(p => `#${p.id} ${p.zh} = ${p.vi}（${p.suggestedBy}）`)].join('\n');
    }

    const approve = rest.match(/^(?:approve|ok)\s+(\d+)$/i);
    if (approve) {
      const entry = this.approve(Number(approve[1]));
      return entry ? `已核准 #${entry.id}：${entry.zh} ⇄ ${entry.vi}` : `找不到建議 #${approve[1]}`;
    }

    const reject = rest.match(/^(?:reject|no)\s+(\d+)$/i);
    if (reject) {
      const entry = this.reject(Number(reject[1]));
      return entry ? `已拒絕 #${entry.id}：${entry.zh} ⇄ ${entry.vi}` : `找不到建議 #${reject[1]}`;
    }

    const add = rest.match(/^add\s+(.+?)\s*(?:=|→|->)\s*(.+)$/i);
    if (add) {
      const zh = add[1].trim();
      const vi = add[2].trim();
      if (!zh || !vi) return '格式錯誤，請用：/glossary add 中文 = tiếng Việt';
      this.add(zh, vi);
      return `已新增術語：${zh} ⇄ ${vi}`;
    }

    const del = rest.match(/^del(?:ete)?\s+(.+)$/i);
    if (del) {
      const term = del[1].trim();
      const removed = this.remove(term);
      return removed ? `已移除術語：${term}` : `找不到術語：${term}`;
    }

    return ['指令：', '/g  列出術語', '/g 詞 = nghĩa', '/g pending', '/g ok|no <id>', '/g del <詞>'].join('\n');
  }
}
