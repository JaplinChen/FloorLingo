import { parseCommand, COMMANDS, isGlossaryAdmin } from './translate-commands';

describe('parseCommand (dispatch table)', () => {
  it('matches every alias of every registered command', () => {
    for (const spec of COMMANDS) {
      for (const alias of spec.aliases) {
        expect(parseCommand(`/${alias}`)?.spec.cmd).toBe(spec.cmd);
        expect(parseCommand(`/${alias.toUpperCase()}`)?.spec.cmd).toBe(spec.cmd); // case-insensitive
      }
    }
  });

  it('strips the prefix into rest, trimmed', () => {
    expect(parseCommand('/g 客戶 = khách hàng')?.rest).toBe('客戶 = khách hàng');
    expect(parseCommand('/glossary  pending')?.rest).toBe('pending');
    expect(parseCommand('/g')?.rest).toBe('');
  });

  it('requires a word boundary after the alias (no false prefix match)', () => {
    expect(parseCommand('/glossaryx')).toBeNull(); // not /glossary
    expect(parseCommand('/gg')).toBeNull(); // not /g
    expect(parseCommand('/help')?.spec.cmd).toBe('help');
  });

  it('returns null for non-commands', () => {
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('/unknown')).toBeNull();
  });
});

describe('isGlossaryAdmin', () => {
  it('grants nobody when the allowlist is empty', () => {
    // The old behaviour was the opposite: an unconfigured list let every member of every translated
    // group rewrite the glossary, and glossary terms are forced onto every later translation.
    expect(isGlossaryAdmin(new Set(), 'u@c.us')).toBe(false);
    expect(isGlossaryAdmin(new Set(), '')).toBe(false);
    expect(isGlossaryAdmin(new Set(), undefined)).toBe(false);
  });

  it('matches a configured admin across every JID suffix', () => {
    const admins = new Set(['886912345678@c.us']);
    expect(isGlossaryAdmin(admins, '886912345678@c.us')).toBe(true);
    expect(isGlossaryAdmin(admins, '886912345678@s.whatsapp.net')).toBe(true);
    expect(isGlossaryAdmin(admins, '886912345678@lid')).toBe(true);
    expect(isGlossaryAdmin(admins, '886912345678')).toBe(true);
  });

  it('refuses everyone else', () => {
    const admins = new Set(['886912345678@c.us', '886900000000']);
    expect(isGlossaryAdmin(admins, '886999999999@c.us')).toBe(false);
    expect(isGlossaryAdmin(admins, '886900000000@lid')).toBe(true); // bare digits in config still match
  });
});
