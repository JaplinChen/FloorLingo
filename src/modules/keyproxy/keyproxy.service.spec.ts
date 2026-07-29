import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KeyProxyService } from './keyproxy.service';
import { DockerService } from '../docker/docker.service';
import { recordSttCall } from './stt-usage.store';

describe('KeyProxyService voice usage merge', () => {
  const STT_KEY = 'gsk_direct_stt_key_e1BL';
  let service: KeyProxyService;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-'));
    process.env.STT_USAGE_PATH = path.join(dir, 'stt-usage.json');
    process.env.KEYPROXY_ENV_PATH = path.join(dir, '.env');
    fs.writeFileSync(process.env.KEYPROXY_ENV_PATH, `PROXY_API_KEY=p\nGROQ_API_KEY_1=${STT_KEY}\n`, 'utf8');
    // The proxy is unreachable in tests, so every key falls back to "no proxy status" — exactly the
    // situation this merge exists for: a key used only by the direct STT path.
    (global as unknown as { fetch: unknown }).fetch = jest.fn(() => Promise.reject(new Error('no proxy')));
    service = new KeyProxyService({} as DockerService);
  });

  it('shows a key at zero when neither the proxy nor voice has used it', async () => {
    const [row] = await service.listKeys();
    expect(row.requestCount).toBe(0);
    expect(row.voiceRequestCount).toBe(0);
    expect(row.status).toBe('unknown');
  });

  it('folds direct STT calls into the row the proxy reports nothing for', async () => {
    recordSttCall(STT_KEY, true);
    recordSttCall(STT_KEY, true);
    recordSttCall(STT_KEY, false);

    const [row] = await service.listKeys();
    expect(row.requestCount).toBe(3);
    expect(row.failureCount).toBe(1);
    expect(row.voiceRequestCount).toBe(3);
    // Traffic proves the key works even though the proxy never routed through it.
    expect(row.status).toBe('active');
  });

  it('still masks the key and never returns it in full', async () => {
    recordSttCall(STT_KEY, true);
    const [row] = await service.listKeys();
    expect(row.masked).toBe('…e1BL');
    expect(JSON.stringify(row)).not.toContain(STT_KEY);
  });

  it('leaves an unrelated key untouched', async () => {
    fs.writeFileSync(
      process.env.KEYPROXY_ENV_PATH as string,
      `PROXY_API_KEY=p\nGROQ_API_KEY_1=${STT_KEY}\nGEMINI_API_KEY_1=AIza_other_key_zzzz\n`,
      'utf8',
    );
    recordSttCall(STT_KEY, true);

    const rows = await service.listKeys();
    const other = rows.find(r => r.masked === '…zzzz');
    expect(other?.requestCount).toBe(0);
    expect(other?.voiceRequestCount).toBe(0);
  });
});
