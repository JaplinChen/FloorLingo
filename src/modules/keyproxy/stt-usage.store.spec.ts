import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { keySuffix, quotaFromHeaders, recordSttCall, sttUsageFor } from './stt-usage.store';

describe('stt-usage store', () => {
  let file: string;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stt-')), 'stt-usage.json');
    process.env.STT_USAGE_PATH = file;
  });

  it('reports zeroes for a key that has never been used', () => {
    expect(sttUsageFor('abcd')).toEqual({ requests: 0, failures: 0, lastUsedAt: 0, quota: null });
  });

  it('counts successes and failures separately, keyed by suffix', () => {
    recordSttCall('gsk_secret_value_wxyz', true, null, 1000);
    recordSttCall('gsk_secret_value_wxyz', false, null, 2000);
    recordSttCall('gsk_secret_value_wxyz', true, null, 3000);

    expect(sttUsageFor('wxyz')).toEqual({ requests: 3, failures: 1, lastUsedAt: 3000, quota: null });
  });

  it('never writes the key itself to disk', () => {
    recordSttCall('gsk_super_secret_wxyz', true);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('gsk_super_secret_wxyz');
    expect(raw).not.toContain('super_secret');
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>)).toEqual(['wxyz']);
  });

  it('keeps separate totals per key', () => {
    recordSttCall('key-one-aaaa', true, null, 10);
    recordSttCall('key-two-bbbb', true, null, 20);
    recordSttCall('key-two-bbbb', true, null, 30);

    expect(sttUsageFor('aaaa').requests).toBe(1);
    expect(sttUsageFor('bbbb').requests).toBe(2);
  });

  it('ignores an empty key instead of creating a junk row', () => {
    recordSttCall('', true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('survives a corrupt usage file rather than throwing into the STT path', () => {
    fs.writeFileSync(file, 'not json at all', 'utf8');
    expect(sttUsageFor('wxyz')).toEqual({ requests: 0, failures: 0, lastUsedAt: 0, quota: null });
    expect(() => recordSttCall('key-wxyz', true)).not.toThrow();
    expect(sttUsageFor('wxyz').requests).toBe(1);
  });

  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null });

  it('reads the full x-ratelimit family Groq sends', () => {
    expect(
      quotaFromHeaders(
        headers({
          'x-ratelimit-limit-requests': '2000',
          'x-ratelimit-remaining-requests': '1999',
          'x-ratelimit-limit-audio-seconds': '7200',
          'x-ratelimit-remaining-audio-seconds': '7197',
        }),
      ),
    ).toEqual({
      limitRequests: 2000,
      remainingRequests: 1999,
      limitAudioSeconds: 7200,
      remainingAudioSeconds: 7197,
    });
  });

  it('treats a partial or absent header set as no quota, not a half-filled one', () => {
    expect(quotaFromHeaders(headers({}))).toBeNull(); // Gemini and friends report nothing
    expect(quotaFromHeaders(undefined)).toBeNull(); // response without a headers bag at all
    expect(quotaFromHeaders(headers({ 'x-ratelimit-limit-requests': '2000' }))).toBeNull();
    expect(
      quotaFromHeaders(
        headers({
          'x-ratelimit-limit-requests': 'lots',
          'x-ratelimit-remaining-requests': '1',
          'x-ratelimit-limit-audio-seconds': '1',
          'x-ratelimit-remaining-audio-seconds': '1',
        }),
      ),
    ).toBeNull();
  });

  it('stores the reported quota and keeps the last reading when a later call reports none', () => {
    const q = { limitRequests: 2000, remainingRequests: 1999, limitAudioSeconds: 7200, remainingAudioSeconds: 7197 };
    recordSttCall('key-wxyz', true, q, 1000);
    expect(sttUsageFor('wxyz').quota).toEqual(q);

    // A transport failure reports nothing; the known ceiling must not be blanked by it.
    recordSttCall('key-wxyz', false, null, 2000);
    expect(sttUsageFor('wxyz').quota).toEqual(q);
    expect(sttUsageFor('wxyz').failures).toBe(1);
  });

  it('keySuffix takes the last four characters', () => {
    expect(keySuffix('gsk_abcdefgh1234')).toBe('1234');
  });
});
