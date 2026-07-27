import type { Request, Response } from 'express';
import { TeamsService } from './teams.service';
import { TranslateService } from '../translate/translate.service';

// The security guarantee: with no Azure app id and no explicit anonymous opt-in, the messaging
// endpoint must refuse — otherwise it's an open, unauthenticated translate endpoint (@Public route).
describe('TeamsService.process auth gate', () => {
  const makeRes = () => {
    const res = { status: jest.fn(), json: jest.fn() } as unknown as Response & {
      status: jest.Mock;
      json: jest.Mock;
    };
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res;
  };

  const svc = new TeamsService({} as TranslateService);

  afterEach(() => {
    delete process.env.MicrosoftAppId;
    delete process.env.TEAMS_ALLOW_ANONYMOUS;
  });

  it('refuses with 401 when unconfigured and anonymous not opted in', async () => {
    delete process.env.MicrosoftAppId;
    delete process.env.TEAMS_ALLOW_ANONYMOUS;
    const res = makeRes();
    await svc.process({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('does not 401 when anonymous is explicitly opted in (local Emulator)', async () => {
    process.env.TEAMS_ALLOW_ANONYMOUS = 'true';
    const res = makeRes();
    // adapter.process may throw on the fake req — that's fine; we only assert it got past the gate.
    await svc.process({ headers: {}, body: {} } as Request, res).catch(() => undefined);
    expect(res.status).not.toHaveBeenCalledWith(401);
  });
});
