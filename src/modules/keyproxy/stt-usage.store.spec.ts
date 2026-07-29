import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { keySuffix, recordSttCall, sttUsageFor } from './stt-usage.store';

describe('stt-usage store', () => {
  let file: string;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stt-')), 'stt-usage.json');
    process.env.STT_USAGE_PATH = file;
  });

  it('reports zeroes for a key that has never been used', () => {
    expect(sttUsageFor('abcd')).toEqual({ requests: 0, failures: 0, lastUsedAt: 0 });
  });

  it('counts successes and failures separately, keyed by suffix', () => {
    recordSttCall('gsk_secret_value_wxyz', true, 1000);
    recordSttCall('gsk_secret_value_wxyz', false, 2000);
    recordSttCall('gsk_secret_value_wxyz', true, 3000);

    expect(sttUsageFor('wxyz')).toEqual({ requests: 3, failures: 1, lastUsedAt: 3000 });
  });

  it('never writes the key itself to disk', () => {
    recordSttCall('gsk_super_secret_wxyz', true);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('gsk_super_secret_wxyz');
    expect(raw).not.toContain('super_secret');
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>)).toEqual(['wxyz']);
  });

  it('keeps separate totals per key', () => {
    recordSttCall('key-one-aaaa', true, 10);
    recordSttCall('key-two-bbbb', true, 20);
    recordSttCall('key-two-bbbb', true, 30);

    expect(sttUsageFor('aaaa').requests).toBe(1);
    expect(sttUsageFor('bbbb').requests).toBe(2);
  });

  it('ignores an empty key instead of creating a junk row', () => {
    recordSttCall('', true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('survives a corrupt usage file rather than throwing into the STT path', () => {
    fs.writeFileSync(file, 'not json at all', 'utf8');
    expect(sttUsageFor('wxyz')).toEqual({ requests: 0, failures: 0, lastUsedAt: 0 });
    expect(() => recordSttCall('key-wxyz', true)).not.toThrow();
    expect(sttUsageFor('wxyz').requests).toBe(1);
  });

  it('keySuffix takes the last four characters', () => {
    expect(keySuffix('gsk_abcdefgh1234')).toBe('1234');
  });
});
