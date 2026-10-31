/**
 * Single-table key construction. PK/SK strings live here and nowhere else.
 *
 * Table attributes: PK (string), SK (string), ttl (number, epoch seconds, optional).
 *
 * | Entity        | PK                 | SK                      |
 * |---------------|--------------------|-------------------------|
 * | Dedupe marker | UPDATE#<updateId>  | DEDUPE                  |
 * | Item          | REGISTRY           | ITEM#<itemId>           |
 * | Open list row | LIST#OPEN          | ITEM#<itemId>           |
 * | Message log   | MSG#<yyyy-mm>      | <iso-ts>#<updateId>     |
 * | Pending ask   | PENDING#<id>       | PENDING                 |
 *
 * The registry and the open list are single partitions on purpose: 200–400 items and a
 * few dozen list rows are read whole every time (C3: no GSIs, no scans).
 */
export const keys = {
  updateDedupe: (updateId: number) => ({ PK: `UPDATE#${updateId}`, SK: 'DEDUPE' }),

  registryPartition: 'REGISTRY',
  item: (itemId: string) => ({ PK: 'REGISTRY', SK: `ITEM#${itemId}` }),

  openListPartition: 'LIST#OPEN',
  listEntry: (itemId: string) => ({ PK: 'LIST#OPEN', SK: `ITEM#${itemId}` }),

  messageMonth: (at: Date) => `MSG#${at.toISOString().slice(0, 7)}`,
  message: (at: Date, updateId: number) => ({
    PK: `MSG#${at.toISOString().slice(0, 7)}`,
    SK: `${at.toISOString()}#${updateId}`,
  }),

  pending: (id: string) => ({ PK: `PENDING#${id}`, SK: 'PENDING' }),
} as const;

export const TTL_ATTRIBUTE = 'ttl';

/** Strip key attributes off a stored record before handing it to a service. */
export function stripKeys<T>(record: Record<string, unknown>): T {
  const { PK: _pk, SK: _sk, [TTL_ATTRIBUTE]: _ttl, ...rest } = record;
  return rest as T;
}
