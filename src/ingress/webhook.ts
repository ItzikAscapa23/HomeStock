import { timingSafeEqual } from 'node:crypto';
import { extractUpdateId } from '../telegram/parse.js';
import type { DedupeStore } from '../persistence/dedupe-store.js';

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export interface WebhookDeps {
  getSecret: () => Promise<string>;
  dedupe: DedupeStore;
  /** Fire-and-forget hand-off to the worker (async Lambda invoke). */
  dispatch: (update: unknown) => Promise<void>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  body: string | undefined;
  isBase64Encoded?: boolean;
}

/**
 * Ingress logic (R26): verify the secret, dedupe on update_id, hand off, ack fast.
 * Status codes: 401 bad secret; 500 only when a retry from Telegram would help.
 */
export async function handleWebhook(req: WebhookRequest, deps: WebhookDeps): Promise<{ statusCode: number }> {
  const log = deps.log ?? (() => {});

  const provided = req.headers[SECRET_HEADER] ?? '';
  if (!safeEqual(provided, await deps.getSecret())) {
    log('rejected: bad secret token');
    return { statusCode: 401 };
  }

  let update: unknown;
  try {
    const raw = req.isBase64Encoded ? Buffer.from(req.body ?? '', 'base64').toString('utf8') : (req.body ?? '');
    update = JSON.parse(raw);
  } catch {
    log('ignored: body is not JSON');
    return { statusCode: 200 }; // a retry won't fix it
  }

  const updateId = extractUpdateId(update);
  if (updateId === undefined) {
    log('ignored: no update_id');
    return { statusCode: 200 };
  }

  if (!(await deps.dedupe.claim(updateId))) {
    log('duplicate update', { updateId });
    return { statusCode: 200 };
  }

  try {
    await deps.dispatch(update);
  } catch (err) {
    // Hand-off failed: release the claim so Telegram's retry gets processed.
    log('dispatch failed', { updateId, error: String(err) });
    await deps.dedupe.release(updateId).catch(() => {});
    return { statusCode: 500 };
  }

  return { statusCode: 200 };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}
