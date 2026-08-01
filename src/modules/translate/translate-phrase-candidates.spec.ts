import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PhraseCandidates } from './translate-phrase-candidates';

function store(): PhraseCandidates {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  const pc = new PhraseCandidates(path.join(dir, 'translations.sqlite'));
  pc.init();
  return pc;
}

describe('PhraseCandidates', () => {
  it('upserts, lists by frequency, and never revives a curated row', async () => {
    const pc = store();
    await pc.upsert('客戶', 'khách hàng', 3);
    await pc.upsert('出貨', 'giao hàng', 9);
    expect((await pc.list()).map(c => c.phrase)).toEqual(['出貨', '客戶']);

    const [top] = await pc.list();
    await pc.markApproved([top], 'human');
    await pc.upsert('出貨', 'giao hàng khác', 20); // a later scan re-mines the same phrase
    const remaining = await pc.list();
    expect(remaining.map(c => c.phrase)).toEqual(['客戶']); // approved row stays out of the queue
  });

  it('records provenance for approve, dismiss and revoke', async () => {
    const pc = store();
    await pc.upsert('客戶', 'khách hàng', 5);
    const [row] = await pc.list();
    await pc.markApproved([row], 'bulk');
    await pc.recordRevoke('客戶');

    const s = await pc.stats();
    expect(s.approved).toBe(1);
    expect(s.approved30d).toBe(1);
    expect(s.revoked30d).toBe(1);
    expect(s.revocationRate30d).toBe(1);
  });

  it('excludes terms it never approved from the revocation rate', async () => {
    const pc = store();
    await pc.recordRevoke('手動加的詞'); // a human fixing their own glossary typo
    const s = await pc.stats();
    expect(s.revoked30d).toBe(0);
    expect(s.revocationRate30d).toBe(0);
  });

  it('counts pending and dismissed separately and measures review latency', async () => {
    const pc = store();
    await pc.upsert('客戶', 'khách hàng', 5);
    await pc.upsert('出貨', 'giao hàng', 5);
    await pc.upsert('品質', 'chất lượng', 5);
    const list = await pc.list();
    await pc.markApproved([list[0]], 'human');
    await pc.dismiss(list[1].id);

    const s = await pc.stats();
    expect(s.pending).toBe(1);
    expect(s.approved).toBe(1);
    expect(s.dismissed).toBe(1);
    expect(s.reviewLatencyHours).not.toBeNull();
    expect(s.reviewLatencyHours!).toBeGreaterThanOrEqual(0);
  });

  it('returns zeroed stats on an empty store', async () => {
    expect(await store().stats()).toEqual({
      pending: 0,
      approved: 0,
      dismissed: 0,
      approved30d: 0,
      revoked30d: 0,
      revocationRate30d: 0,
      reviewLatencyHours: null,
      lastScan: null,
    });
  });

  it('selects by threshold, highest first, and never past the 200 cap', async () => {
    const pc = store();
    await pc.upsert('出貨', 'giao hàng', 9);
    await pc.upsert('客戶', 'khách hàng', 5);
    await pc.upsert('品質', 'chất lượng', 2);

    expect((await pc.pendingAbove(5)).map(r => r.phrase)).toEqual(['出貨', '客戶']);
    expect((await pc.pendingAbove(1)).length).toBe(3);
    expect((await pc.pendingAbove(1, 1)).map(r => r.phrase)).toEqual(['出貨']);
    expect((await pc.pendingAbove(1, 9999)).length).toBe(3); // limit clamps, doesn't blow up
  });

  it('approves a batch once and refuses to approve the same row twice', async () => {
    const pc = store();
    await pc.upsert('出貨', 'giao hàng', 9);
    await pc.upsert('客戶', 'khách hàng', 5);
    const rows = await pc.pendingAbove(5);

    expect(await pc.markApproved(rows, 'bulk')).toBe(2);
    // Second pass: rows are no longer 'new', so nothing moves and no extra events are logged.
    expect(await pc.markApproved(rows, 'bulk')).toBe(0);

    const s = await pc.stats();
    expect(s.pending).toBe(0);
    expect(s.approved).toBe(2);
    expect(s.approved30d).toBe(2); // NOT 4 — a double approve must not inflate the rate's denominator
  });

  it('leaves a row reviewable when only part of a batch is still new', async () => {
    const pc = store();
    await pc.upsert('出貨', 'giao hàng', 9);
    await pc.upsert('客戶', 'khách hàng', 5);
    const rows = await pc.pendingAbove(5);

    await pc.markApproved([rows[0]], 'human'); // another admin got there first
    expect(await pc.markApproved(rows, 'bulk')).toBe(1); // "1 of 2", not 2
  });

  it('peek returns only unreviewed rows', async () => {
    const pc = store();
    await pc.upsert('出貨', 'giao hàng', 9);
    const [row] = await pc.list();
    expect(await pc.peek(row.id)).toMatchObject({ phrase: '出貨' });
    await pc.markApproved([row], 'human');
    expect(await pc.peek(row.id)).toBeNull();
  });

  it('reports the latest scan, and tells "never ran" apart from "found nothing"', async () => {
    const pc = store();
    expect((await pc.stats()).lastScan).toBeNull(); // never ran

    await pc.recordScan(30, 0); // ran, kept nothing — must NOT read as "never ran"
    expect(await pc.stats().then(s => s.lastScan)).toMatchObject({ mined: 30, upserted: 0 });

    await pc.recordScan(12, 5);
    expect(await pc.stats().then(s => s.lastScan)).toMatchObject({ mined: 12, upserted: 5 });
  });

  it('survives a reopen — provenance is on disk, not in memory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    const file = path.join(dir, 'translations.sqlite');
    const first = new PhraseCandidates(file);
    first.init();
    await first.upsert('客戶', 'khách hàng', 5);
    const [row] = await first.list();
    await first.markApproved([row], 'bulk');

    const second = new PhraseCandidates(file);
    second.init();
    await second.recordRevoke('客戶');
    const s = await second.stats();
    expect(s.approved30d).toBe(1);
    expect(s.revoked30d).toBe(1); // origin 'bulk' was read back from the previous process
  });
});
