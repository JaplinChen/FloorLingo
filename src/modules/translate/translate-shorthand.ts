import * as fs from 'node:fs';
import { atomicWriteJson } from './translate-fs';

/**
 * Vietnamese factory shorthand -> full words, expanded in the SOURCE text before it reaches the LLM.
 * Members type "qlsx", "đv", "xly"; the model has never seen those forms and guesses, which is how a
 * production-control line came back with the wrong department and week. Deterministic expansion
 * removes the guess.
 *
 * Deliberately NOT the glossary: Glossary.section matches by plain substring (a 2-letter form would
 * fire inside ordinary words) and stores both directions (zh->vi output would start emitting
 * shorthand). This table is word-boundary matched and one-directional (vi source only).
 */

/** Seed set so the feature works before anyone edits the file; disk entries override these. */
const SEED: Record<string, string> = {
  qlsx: 'quản lý sản xuất',
  sx: 'sản xuất',
  pxsx: 'phân xưởng sản xuất',
  ttsx: 'tiến độ sản xuất',
  đv: 'đơn vị',
  dv: 'đơn vị',
  xly: 'xử lý',
  klh: 'kế hoạch',
  kh: 'kế hoạch',
  ncc: 'nhà cung cấp',
  nvl: 'nguyên vật liệu',
  bp: 'bộ phận',
  sl: 'số lượng',
  hc: 'hoàn công',
  cbsx: 'chuẩn bị sản xuất',
  ktra: 'kiểm tra',
  tm: 'thu mua',
  yc: 'yêu cầu',
  cty: 'công ty',
  đc: 'được',
};

export class ShorthandTable {
  private data: Record<string, string> = { ...SEED };
  private matcher: RegExp | null = null;

  constructor(private readonly filePath: string) {}

  /** Load from disk; falls back to the seed set when the file is absent/unreadable. */
  load(): number {
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, string>;
    } catch {
      this.data = { ...SEED };
    }
    this.matcher = null;
    return Object.keys(this.data).length;
  }

  entries(): { short: string; full: string }[] {
    return Object.entries(this.data).map(([short, full]) => ({ short, full }));
  }

  add(short: string, full: string): void {
    this.data[short.trim().toLowerCase()] = full.trim();
    this.persist();
  }

  remove(short: string): boolean {
    const key = short.trim().toLowerCase();
    if (!(key in this.data)) return false;
    delete this.data[key];
    this.persist();
    return true;
  }

  // ponytail: the whole table is written, not a delta from SEED — a delta cannot express "seed entry
  // deleted". Trade-off: once the file exists, later SEED edits no longer reach this install.
  private persist(): void {
    atomicWriteJson(this.filePath, this.data);
    this.matcher = null;
  }

  // \b is ASCII-only, so it fails on "đv"; use letter/digit lookaround instead. Longest-first so a
  // longer form ("pxsx") is not eaten by a shorter one.
  private build(): RegExp {
    const keys = Object.keys(this.data)
      .sort((a, b) => b.length - a.length)
      .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`(?<![\\p{L}\\p{N}])(${keys.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  }

  /**
   * Expand every known shorthand token in `text`. Unknown tokens pass through untouched.
   * `skip` lets the glossary win: a shorthand that already has its own glossary entry must stay
   * verbatim, or Glossary.section would no longer find it in the body and its rule would go unused.
   */
  expand(text: string, skip?: (short: string) => boolean): string {
    if (!text || !Object.keys(this.data).length) return text;
    this.matcher ??= this.build();
    this.matcher.lastIndex = 0;
    return text.replace(this.matcher, m => {
      const key = m.toLowerCase();
      return skip?.(key) ? m : (this.data[key] ?? m);
    });
  }
}
