import {
  formatReviewDm,
  parseReviewReply,
  isEmptyReply,
  isDigestDue,
  localParts,
  parseDmHour,
  resolveTz,
} from './translate-review-dm';
import { jidDigits } from './translate-senders';

const cand = (id: number, phrase: string, translated: string, count: number) => ({
  id,
  phrase,
  translated,
  count,
  at: '2026-08-01T00:00:00.000Z',
});

describe('review DM formatting', () => {
  it('addresses rows by DB id, not by position', () => {
    const text = formatReviewDm([cand(41, '出貨', 'giao hàng', 12), cand(43, '客戶', 'khách hàng', 9)]);
    expect(text).toContain('#41  出貨 → giao hàng  (12x)');
    expect(text).toContain('#43  客戶 → khách hàng  (9x)');
    // No "1." / "2." anywhere: a reply to yesterday's list must not resolve against today's order.
    expect(text).not.toMatch(/^\s*\d+[.)]/m);
  });

  it('is bilingual so either half of the admin list can act on it', () => {
    const text = formatReviewDm([cand(1, '出貨', 'giao hàng', 3)]);
    expect(text).toContain('待審核詞彙');
    expect(text).toContain('mục chờ duyệt');
    expect(text).toContain('Trả lời');
  });
});

describe('review reply parsing', () => {
  it('reads approvals, rejections and both in one message', () => {
    expect(parseReviewReply('ok 41 43')).toEqual({ approve: [41, 43], reject: [], corrections: [] });
    expect(parseReviewReply('no 42')).toEqual({ approve: [], reject: [42], corrections: [] });
    expect(parseReviewReply('ok 41 43 no 42')).toEqual({ approve: [41, 43], reject: [42], corrections: [] });
  });

  it('accepts the shapes people actually type', () => {
    expect(parseReviewReply('OK #41, #43')).toEqual({ approve: [41, 43], reject: [], corrections: [] });
    expect(parseReviewReply('  ok   41  ')).toEqual({ approve: [41], reject: [], corrections: [] });
  });

  it('takes a corrected translation, spaces and all', () => {
    expect(parseReviewReply('ok 41=giao hàng gấp')).toEqual({
      approve: [],
      reject: [],
      corrections: [{ id: 41, vi: 'giao hàng gấp' }],
    });
    expect(parseReviewReply('ok #41 = thời hạn giao')).toEqual({
      approve: [],
      reject: [],
      corrections: [{ id: 41, vi: 'thời hạn giao' }],
    });
  });

  it('returns null for anything that is not a review reply, so stray DMs get no backtalk', () => {
    expect(parseReviewReply('你好')).toBeNull();
    expect(parseReviewReply('/glossary add 出貨 = giao hàng')).toBeNull();
    expect(parseReviewReply('okay then')).toBeNull(); // "okay" is not the verb "ok"
  });

  it('never guesses an id — a reply with none parses empty rather than picking one', () => {
    for (const text of ['ok', 'ok abc', 'no ???', 'ok 0', 'ok -5', 'ok 41=']) {
      const parsed = parseReviewReply(text);
      expect(parsed).not.toBeNull();
      expect(isEmptyReply(parsed!)).toBe(true);
    }
  });
});

describe('digest schedule', () => {
  const tz = 'Asia/Taipei'; // UTC+8, no DST

  it('reads the local hour, not the container UTC hour', () => {
    // 22:00 UTC on the 1st is 06:00 on the 2nd in Taipei — the bug that DMs a factory at 3am.
    expect(localParts(new Date('2026-08-01T22:00:00Z'), tz)).toEqual({ date: '2026-08-02', hour: 6 });
  });

  it('sends once the hour arrives, then not again that day', () => {
    const before = new Date('2026-08-01T00:00:00Z'); // 08:00 Taipei
    const after = new Date('2026-08-01T02:00:00Z'); // 10:00 Taipei
    expect(isDigestDue(before, tz, 9, '')).toBe(false);
    expect(isDigestDue(after, tz, 9, '')).toBe(true);
    // Same day, already sent: a restart inside the hour must not re-DM everyone.
    expect(isDigestDue(after, tz, 9, '2026-08-01')).toBe(false);
    // Next day: due again.
    expect(isDigestDue(new Date('2026-08-02T02:00:00Z'), tz, 9, '2026-08-01')).toBe(true);
  });

  it('still sends today if the app was down at the target hour', () => {
    const late = new Date('2026-08-01T09:00:00Z'); // 17:00 Taipei, target was 09:00
    expect(isDigestDue(late, tz, 9, '')).toBe(true);
  });
});

describe('config parsing', () => {
  it('treats unset as off and rejects nonsense loudly', () => {
    expect(parseDmHour(undefined)).toEqual({ hour: null });
    expect(parseDmHour('')).toEqual({ hour: null });
    expect(parseDmHour('9')).toEqual({ hour: 9 });
    expect(parseDmHour('0')).toEqual({ hour: 0 });
    for (const bad of ['25', '-1', 'noon', '9.5']) {
      const r = parseDmHour(bad);
      expect(r.hour).toBeNull();
      expect(r.error).toContain('0-23');
    }
  });

  it('falls back on an unknown timezone instead of throwing at 3am', () => {
    expect(resolveTz('Asia/Ho_Chi_Minh')).toEqual({ tz: 'Asia/Ho_Chi_Minh' });
    expect(resolveTz(undefined)).toEqual({ tz: 'Asia/Taipei' });
    const bad = resolveTz('Mars/Olympus');
    expect(bad.tz).toBe('Asia/Taipei');
    expect(bad.error).toContain('not a known timezone');
  });
});

describe('admin identity', () => {
  it('matches the same person across every JID suffix WhatsApp uses', () => {
    const admin = jidDigits('886912345678@c.us');
    expect(jidDigits('886912345678@s.whatsapp.net')).toBe(admin);
    expect(jidDigits('886912345678@lid')).toBe(admin);
    expect(jidDigits('886912345678')).toBe(admin);
    expect(jidDigits('886912345679@c.us')).not.toBe(admin);
  });
});
