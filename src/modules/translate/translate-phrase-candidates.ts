import * as fs from 'node:fs';
import * as path from 'node:path';
import { memoryDbPath } from './translate-memory';

// High-frequency Chinese phrases mined from translation memory + their LLM-suggested Vietnamese, held
// for dashboard approval into the glossary. Kept in a separate table from translation_memory so the
// whole-sentence candidates and the word-level candidates never mix (different count semantics).
interface SqliteDb {
  run(sql: string, params: unknown[], cb?: (err: Error | null) => void): void;
  all<T>(sql: string, params: unknown[], cb: (err: Error | null, rows: T[]) => void): void;
  get<T>(sql: string, params: unknown[], cb: (err: Error | null, row?: T) => void): void;
  serialize(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqlite3 = require('sqlite3') as { Database: new (file: string) => SqliteDb };

interface PhraseRow {
  id: number;
  phrase: string;
  translated: string;
  count: number;
  updated_at: string;
}

export interface PhraseCandidate {
  id: number;
  phrase: string;
  translated: string;
  count: number;
  at: string;
}

/** Where a glossary entry came from. Recorded per event so a later revoke can be attributed. */
export type PhraseOrigin = 'human' | 'bulk' | 'consensus' | 'cross-model' | 'manual';

export interface PhraseStats {
  pending: number;
  approved: number;
  dismissed: number;
  /** Approvals and revocations inside the trailing 30-day window (lifetime totals hide current health). */
  approved30d: number;
  revoked30d: number;
  /** revoked30d / approved30d, 0 when nothing was approved. The wave-gating signal. */
  revocationRate30d: number;
  /** Mean hours between a candidate first appearing and being reviewed; null when nothing is reviewed. */
  reviewLatencyHours: number | null;
  /** Last mining run. null before the first scan — which is itself the answer to "is mining running?". */
  lastScan: { at: string; mined: number; upserted: number } | null;
}

const DAY_MS = 86_400_000;

/**
 * Phrase-candidate store. Mining upserts fresh phrases (bumping count on repeat, refreshing the LLM
 * translation), leaving approved/dismissed rows untouched so a curated phrase doesn't reappear.
 *
 * `phrase_events` is the provenance authority: one append-only row per approve/dismiss/revoke, carrying
 * the origin. It exists so "was this entry removed because a machine picked it badly, or because a human
 * fixed a typo?" is answerable — without it the revocation rate cannot gate anything.
 */
export class PhraseCandidates {
  private db: SqliteDb | null = null;

  constructor(private readonly file = memoryDbPath()) {}

  init(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new sqlite3.Database(this.file);
    db.serialize(); // serialized mode — same rationale as TranslationMemory
    // Two connections (this one and TranslationMemory) share the file: serialize() only orders
    // statements within a connection, so without these a bulk write hands the other one SQLITE_BUSY.
    // Callbacks are load-bearing: journal_mode takes a brief write lock, so another process holding
    // the file makes it fail. WAL is an optimisation — busy_timeout is the actual fix — so a failure
    // here must not take the connection down with it.
    db.run(`PRAGMA busy_timeout = 5000`, [], () => {});
    db.run(`PRAGMA journal_mode = WAL`, [], () => {});
    db.run(
      `CREATE TABLE IF NOT EXISTS phrase_candidates (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         phrase TEXT NOT NULL,
         translated TEXT NOT NULL DEFAULT '',
         count INTEGER NOT NULL DEFAULT 1,
         status TEXT NOT NULL DEFAULT 'new',
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         UNIQUE(phrase)
       )`,
      [],
    );
    db.run(`CREATE INDEX IF NOT EXISTS idx_pc_status_count ON phrase_candidates(status, count DESC)`, []);
    // Added after the table shipped; the error on an existing column is the expected no-op.
    db.run(`ALTER TABLE phrase_candidates ADD COLUMN origin TEXT`, [], () => {});
    db.run(`ALTER TABLE phrase_candidates ADD COLUMN reviewed_at TEXT`, [], () => {});
    db.run(
      `CREATE TABLE IF NOT EXISTS phrase_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         phrase TEXT NOT NULL,
         kind TEXT NOT NULL,
         origin TEXT NOT NULL,
         at TEXT NOT NULL
       )`,
      [],
    );
    db.run(`CREATE INDEX IF NOT EXISTS idx_pe_at ON phrase_events(at)`, []);
    // One row per mining run. Without it the dashboard cannot distinguish "mining found nothing new"
    // from "mining has not run since the last restart" — they look identical (an unchanged queue).
    db.run(
      `CREATE TABLE IF NOT EXISTS phrase_scans (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         at TEXT NOT NULL,
         mined INTEGER NOT NULL,
         upserted INTEGER NOT NULL
       )`,
      [],
    );
    this.db = db;
  }

  /** Upsert one mined phrase; refreshes count + translation but never revives a curated (non-new) row. */
  upsert(phrase: string, translated: string, count: number): Promise<void> {
    return new Promise(resolve => {
      const p = phrase.trim();
      if (!this.db || !p) return resolve();
      const now = new Date().toISOString();
      this.db.run(
        `INSERT INTO phrase_candidates (phrase, translated, count, status, created_at, updated_at)
         VALUES (?, ?, ?, 'new', ?, ?)
         ON CONFLICT(phrase) DO UPDATE SET count = excluded.count, translated = excluded.translated, updated_at = excluded.updated_at
         WHERE phrase_candidates.status = 'new'`,
        [p, translated.trim(), Math.max(1, count), now, now],
        () => resolve(),
      );
    });
  }

  /** Top unreviewed phrase candidates by frequency. */
  list(limit = 50): Promise<PhraseCandidate[]> {
    return new Promise(resolve => {
      if (!this.db) return resolve([]);
      this.db.all<PhraseRow>(
        `SELECT id, phrase, translated, count, updated_at FROM phrase_candidates
           WHERE status = 'new' ORDER BY count DESC, updated_at DESC LIMIT ?`,
        [Math.max(1, Math.min(500, limit))],
        (err, rows) => resolve(err || !rows ? [] : rows.map(toCandidate)),
      );
    });
  }

  private get(id: number): Promise<PhraseCandidate | null> {
    return new Promise(resolve => {
      if (!this.db) return resolve(null);
      this.db.get<PhraseRow>(
        `SELECT id, phrase, translated, count, updated_at FROM phrase_candidates WHERE id = ?`,
        [id],
        (err, r) => resolve(err || !r ? null : toCandidate(r)),
      );
    });
  }

  private setStatus(id: number, status: 'approved' | 'dismissed', origin: PhraseOrigin): Promise<void> {
    return new Promise(resolve => {
      if (!this.db) return resolve();
      this.db.run(
        `UPDATE phrase_candidates SET status = ?, origin = ?, reviewed_at = ? WHERE id = ?`,
        [status, origin, new Date().toISOString(), id],
        () => resolve(),
      );
    });
  }

  /** Append one provenance row. Best-effort: a failed event must never block the approval itself. */
  private logEvent(phrase: string, kind: 'approved' | 'dismissed' | 'revoked', origin: PhraseOrigin): Promise<void> {
    return new Promise(resolve => {
      if (!this.db) return resolve();
      this.db.run(
        `INSERT INTO phrase_events (phrase, kind, origin, at) VALUES (?, ?, ?, ?)`,
        [phrase, kind, origin, new Date().toISOString()],
        () => resolve(),
      );
    });
  }

  /** Mark approved and return the row so the caller can add it to the glossary. */
  async takeForApproval(id: number, origin: PhraseOrigin = 'human'): Promise<PhraseCandidate | null> {
    const row = await this.get(id);
    if (!row) return null;
    await this.setStatus(id, 'approved', origin);
    await this.logEvent(row.phrase, 'approved', origin);
    return row;
  }

  async dismiss(id: number): Promise<void> {
    const row = await this.get(id);
    await this.setStatus(id, 'dismissed', 'human');
    if (row) await this.logEvent(row.phrase, 'dismissed', 'human');
  }

  /**
   * Record that a glossary term was removed, attributed to whatever origin last approved it. A term
   * never approved through this pipeline is `manual` — counting those as revocations would make the
   * rate meaningless (a human fixing their own typo is not a bad machine suggestion).
   */
  async recordRevoke(phrase: string): Promise<void> {
    const p = phrase.trim();
    if (!p) return;
    await this.logEvent(p, 'revoked', await this.lastApprovalOrigin(p));
  }

  private lastApprovalOrigin(phrase: string): Promise<PhraseOrigin> {
    return new Promise(resolve => {
      if (!this.db) return resolve('manual');
      this.db.get<{ origin?: string }>(
        `SELECT origin FROM phrase_events WHERE phrase = ? AND kind = 'approved' ORDER BY id DESC LIMIT 1`,
        [phrase],
        (err, r) => resolve(err || !r?.origin ? 'manual' : (r.origin as PhraseOrigin)),
      );
    });
  }

  /** Record a completed mining run. `mined` is what the miner proposed, `upserted` what survived the LLM. */
  recordScan(mined: number, upserted: number): Promise<void> {
    return new Promise(resolve => {
      if (!this.db) return resolve();
      this.db.run(
        `INSERT INTO phrase_scans (at, mined, upserted) VALUES (?, ?, ?)`,
        [new Date().toISOString(), mined, upserted],
        () => resolve(),
      );
    });
  }

  /** Queue health for the dashboard: is review keeping up, and is what we approve staying approved? */
  async stats(): Promise<PhraseStats> {
    const empty: PhraseStats = {
      pending: 0,
      approved: 0,
      dismissed: 0,
      approved30d: 0,
      revoked30d: 0,
      revocationRate30d: 0,
      reviewLatencyHours: null,
      lastScan: null,
    };
    if (!this.db) return empty;
    const cutoff = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const byStatus = await this.rows<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM phrase_candidates GROUP BY status`,
      [],
    );
    const byKind = await this.rows<{ kind: string; n: number }>(
      `SELECT kind, COUNT(*) AS n FROM phrase_events WHERE at >= ? AND origin != 'manual' GROUP BY kind`,
      [cutoff],
    );
    const latency = await this.rows<{ h: number | null }>(
      `SELECT AVG(julianday(reviewed_at) - julianday(created_at)) * 24 AS h
         FROM phrase_candidates WHERE reviewed_at IS NOT NULL`,
      [],
    );
    const scans = await this.rows<{ at: string; mined: number; upserted: number }>(
      `SELECT at, mined, upserted FROM phrase_scans ORDER BY id DESC LIMIT 1`,
      [],
    );
    const status = (k: string) => byStatus.find(r => r.status === k)?.n ?? 0;
    const kind = (k: string) => byKind.find(r => r.kind === k)?.n ?? 0;
    const approved30d = kind('approved');
    const revoked30d = kind('revoked');
    return {
      pending: status('new'),
      approved: status('approved'),
      dismissed: status('dismissed'),
      approved30d,
      revoked30d,
      revocationRate30d: approved30d ? revoked30d / approved30d : 0,
      reviewLatencyHours: latency[0]?.h ?? null,
      lastScan: scans[0] ?? null,
    };
  }

  private rows<T>(sql: string, params: unknown[]): Promise<T[]> {
    return new Promise(resolve => {
      if (!this.db) return resolve([]);
      this.db.all<T>(sql, params, (err, r) => resolve(err || !r ? [] : r));
    });
  }
}

function toCandidate(r: PhraseRow): PhraseCandidate {
  return { id: r.id, phrase: r.phrase, translated: r.translated, count: r.count, at: r.updated_at };
}
