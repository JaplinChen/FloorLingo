import { IsNotEmpty, IsString } from 'class-validator';

export class ChatProfileDto {
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @IsString()
  @IsNotEmpty()
  text!: string;
}
