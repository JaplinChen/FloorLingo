import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ActivityHandler,
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext,
} from 'botbuilder';
import { TranslateService } from '../translate/translate.service';
import { createLogger } from '../../common/services/logger.service';

// Teams adapter: reuses the platform-agnostic TranslateService.translateInbound() so glossary,
// senders, memory and LLM config are shared with WhatsApp. No in-queue send callback — Teams doesn't
// need anti-ban pacing, so it dispatches the returned reply itself (still serialized behind translate).
@Injectable()
export class TeamsService {
  private readonly logger = createLogger('TeamsService');
  // Empty MicrosoftAppId/Password (env unset) => anonymous auth, which the Bot Framework Emulator uses
  // for local testing. Real Teams needs an Azure Bot app id/password in the env.
  private readonly adapter = new CloudAdapter(
    new ConfigurationBotFrameworkAuthentication(process.env as Record<string, string>),
  );
  private readonly handler = new ActivityHandler();

  constructor(private readonly translate: TranslateService) {
    this.adapter.onTurnError = async (_ctx, err) => this.logger.error('Teams turn error', String(err));
    this.handler.onMessage(async (ctx, next) => {
      await this.onMessage(ctx);
      await next();
    });
  }

  // Bot Framework messaging endpoint — NestJS controller hands the express req/res straight through.
  // The route is @Public (Azure sends a Bot Framework JWT, not our X-API-Key), so this is the auth
  // gate: with no MicrosoftAppId the adapter runs anonymous, which would leave an open translate
  // endpoint. Refuse unless configured, or explicitly opted into for local Emulator testing.
  async process(req: Request, res: Response): Promise<void> {
    if (!process.env.MicrosoftAppId && process.env.TEAMS_ALLOW_ANONYMOUS !== 'true') {
      res.status(401).json({ message: 'Teams bot not configured' });
      return;
    }
    return this.adapter.process(req, res, ctx => this.handler.run(ctx));
  }

  private async onMessage(ctx: TurnContext): Promise<void> {
    const text = ctx.activity.text || '';
    // conversation.id is the per-chat rate-limit bucket, mirroring WhatsApp's chatId.
    const chatKey = ctx.activity.conversation?.id || 'teams';
    const reply = await this.translate.translateInbound(text, chatKey);
    if (reply) await ctx.sendActivity(reply);
  }
}
