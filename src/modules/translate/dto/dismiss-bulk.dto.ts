import { IsInt, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Threshold for bulk-dismissing sentence candidates; bounded for the same reason as ApproveBulkDto. */
export class DismissBulkDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  maxCount!: number;
}
