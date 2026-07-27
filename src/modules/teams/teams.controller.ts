import { Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/auth.decorators';
import { TeamsService } from './teams.service';

@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  /**
   * Azure Bot's messaging endpoint (…/api/teams/messages). The adapter writes the response.
   * @Public bypasses ApiKeyGuard because Azure sends its own Bot Framework JWT, not our X-API-Key —
   * CloudAdapter verifies that JWT instead. TeamsService refuses to process at all unless
   * MicrosoftAppId is set, so this route is never an unauthenticated entry point in production.
   */
  @Public()
  @Post('messages')
  messages(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.teams.process(req, res);
  }
}
