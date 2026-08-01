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
    await pc.takeForApproval(top.id);
    await pc.upsert('出貨', 'giao hàng khác', 20); // a later scan re-mines the same phrase
    const remaining = await pc.list();
    expect(remaining.map(c => c.phrase)).toEqual(['客戶']); // approved row stays out of the queue
  });

  it('records provenance for approve, dismiss and revoke', async () => {
    const pc = store();
    await pc.upsert('客戶', 'khách hàng', 5);
    const [row] = await pc.list();
    await pc.takeForApproval(row.id, 'bulk');
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
    await pc.takeForApproval(list[0].id);
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
    });
  });

  it('survives a reopen — provenance is on disk, not in memory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    const file = path.join(dir, 'translations.sqlite');
    const first = new PhraseCandidates(file);
    first.init();
    await first.upsert('客戶', 'khách hàng', 5);
    const [row] = await first.list();
    await first.takeForApproval(row.id, 'bulk');

    const second = new PhraseCandidates(file);
    second.init();
    await second.recordRevoke('客戶');
    const s = await second.stats();
    expect(s.approved30d).toBe(1);
    expect(s.revoked30d).toBe(1); // origin 'bulk' was read back from the previous process
  });
});
