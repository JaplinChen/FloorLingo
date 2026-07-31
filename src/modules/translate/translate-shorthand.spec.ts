import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ShorthandTable } from './translate-shorthand';

describe('ShorthandTable', () => {
  let file: string;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shorthand-')), 'shorthand.json');
  });

  const table = () => {
    const t = new ShorthandTable(file);
    t.load();
    return t;
  };

  it('expands seeded shorthand, including non-ASCII forms', () => {
    expect(table().expand('Nốt ngày mai là qlsx chốt lệnh tuần rồi. Các đv cần nhanh chóng xly hoàn công.')).toBe(
      'Nốt ngày mai là quản lý sản xuất chốt lệnh tuần rồi. Các đơn vị cần nhanh chóng xử lý hoàn công.',
    );
  });

  it('only matches whole tokens, so it never fires inside a longer word', () => {
    const t = table();
    expect(t.expand('không khách sxong dv1')).toBe('không khách sxong dv1');
    expect(t.expand('kh cần sl mới')).toBe('kế hoạch cần số lượng mới');
  });

  it('prefers the longest form when two entries overlap', () => {
    expect(table().expand('pxsx báo ttsx')).toBe('phân xưởng sản xuất báo tiến độ sản xuất');
  });

  it('persists additions and applies them on reload', () => {
    const t = table();
    t.add('LH', 'liên hệ');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).lh).toBe('liên hệ');
    expect(table().expand('lh gấp với sx')).toBe('liên hệ gấp với sản xuất');
  });

  it('leaves a token verbatim when skip claims it (glossary wins)', () => {
    expect(table().expand('qlsx báo sl', s => s === 'qlsx')).toBe('qlsx báo số lượng');
  });

  it('removes an entry and stops expanding it', () => {
    const t = table();
    expect(t.remove('sx')).toBe(true);
    expect(t.remove('nope')).toBe(false);
    expect(t.expand('sx ổn')).toBe('sx ổn');
  });
});
