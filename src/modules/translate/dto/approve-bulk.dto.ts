import { IsInt, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Threshold for a bulk phrase approval. Bounded and integer-only on purpose: this is an admin
 * endpoint that writes straight into the glossary, and an unvalidated value reaches a SQL comparison
 * — `Number(undefined)` alone would yield NaN, matching nothing while the UI reports success.
 */
export class ApproveBulkDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  minCount!: number;
}
