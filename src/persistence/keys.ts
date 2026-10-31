/**
 * Single-table key construction. PK/SK strings live here and nowhere else.
 *
 * Table attributes: PK (string), SK (string), ttl (number, epoch seconds, optional).
 */
export const keys = {
  updateDedupe: (updateId: number) => ({ PK: `UPDATE#${updateId}`, SK: 'DEDUPE' }),
} as const;

export const TTL_ATTRIBUTE = 'ttl';
