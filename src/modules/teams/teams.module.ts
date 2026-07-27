import { Module } from '@nestjs/common';
import { TranslateModule } from '../translate/translate.module';
import { TeamsService } from './teams.service';
import { TeamsController } from './teams.controller';

@Module({
  imports: [TranslateModule],
  controllers: [TeamsController],
  providers: [TeamsService],
})
export class TeamsModule {}
