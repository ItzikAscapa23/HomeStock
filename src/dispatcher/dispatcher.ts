import { randomUUID } from 'node:crypto';
import { CATEGORIES, type CategoryId } from '../domain/categories.js';
import type { Item } from '../domain/item.js';
import type { Button, Inbound, InboundCallback, InboundMessage, Reply } from '../domain/message.js';
import type { MessageLog, PendingAsk, PendingStore } from '../persistence/stores.js';
import type { ReceiptFlow } from './receipt-flow.js';
import type { ItemRegistry } from '../registry/item-registry.js';
import type { Resolution, Resolver, UnresolvedMention } from '../registry/resolver.js';
import { formatList, type ReportOutcome, type ShoppingList } from '../shopping/shopping-list.js';
import type { ChatGate } from './chat-gate.js';

/** All user-facing copy for this module (CLAUDE.md: one place per module). Replies are one line (R25). */
const COPY = {
  help: 'כתבו מה נגמר — למשל "נגמר חלב". /list מציג את רשימת הקניות.',
  chatId: (chatId: number, userId: number | undefined) => `chat id: ${chatId}${userId ? ` · user id: ${userId}` : ''}`,
  added: (names: string) => `✓ ${names} — ברשימה`,
  alreadyListed: (names: string) => `${names} כבר ברשימה`,
  addedWithAlready: (added: string, already: string) => `✓ ${added} — ברשימה (${already} כבר שם)`,
  ask: (mention: string) => `לא בטוח מה זה "${mention}":`,
  newItemButton: (name: string, category: CategoryId) => `➕ חדש: ${name} (${CATEGORIES[category]})`,
  cancelButton: '✕ לא משנה',
  createdItem: (name: string, category: CategoryId) => `✓ נוסף פריט חדש: ${name} (${CATEGORIES[category]}) — ברשימה`,
  cancelled: (mention: string) => `"${mention}" — בוטל`,
  stale: 'כבר טופל',
  failed: 'לא הצלחתי לעבד את זה כרגע — נסו שוב בעוד רגע',
} as const;

const CALLBACK_PREFIX = 'a';

export interface DispatcherDeps {
  gate: ChatGate;
  registry: ItemRegistry;
  resolver: Resolver;
  shopping: ShoppingList;
  pending: PendingStore;
  log: MessageLog;
  receipts?: ReceiptFlow;
  newId?: () => string;
  logError?: (msg: string, err: unknown) => void;
}

/** Decides what to do with an inbound event. Returns replies; delivery happens in `telegram/`. */
export class Dispatcher {
  private readonly newId: () => string;
  private readonly logError: (msg: string, err: unknown) => void;

  constructor(private readonly d: DispatcherDeps) {
    this.newId = d.newId ?? (() => randomUUID().replace(/-/g, '').slice(0, 10));
    this.logError = d.logError ?? ((msg, err) => console.error(JSON.stringify({ msg, error: String(err) })));
  }

  /**
   * `emit` delivers a reply immediately (progress for slow work, e.g. reading a receipt);
   * everything else is returned and delivered by the caller.
   */
  async handle(event: Inbound, raw: unknown, emit: (r: Reply) => Promise<void> = async () => {}): Promise<Reply[]> {
    // R23: raw first, so a failure later still leaves the original text on record.
    await this.d.log.recordRaw({
      updateId: event.updateId,
      receivedAt: event.receivedAt.toISOString(),
      chatId: event.chatId,
      ...(event.fromUserId !== undefined && { fromUserId: event.fromUserId }),
      ...(event.fromName && { fromName: event.fromName }),
      kind: event.kind,
      text: event.kind === 'message' ? event.text : event.data,
      raw,
    });

    let parsed: Record<string, unknown> = { intent: 'ignored' };
    let replies: Reply[] = [];
    try {
      [parsed, replies] = await this.route(event, emit);
    } catch (err) {
      this.logError('dispatch failed', err);
      parsed = { intent: 'error', error: String(err) };
      replies =
        event.kind === 'callback'
          ? [{ type: 'ack', callbackId: event.callbackId, text: COPY.failed }]
          : [{ type: 'send', text: COPY.failed }];
    }
    await this.d.log.recordParsed(event.updateId, event.receivedAt, parsed);
    return replies;
  }

  private async route(event: Inbound, emit: (r: Reply) => Promise<void>): Promise<[Record<string, unknown>, Reply[]]> {
    // /chatid answers anywhere — it's how a household finds the id to allow.
    if (event.kind === 'message' && event.command === 'chatid') {
      return [{ intent: 'chatid' }, [{ type: 'send', text: COPY.chatId(event.chatId, event.fromUserId) }]];
    }
    if (!(await this.d.gate.isAllowed(event.chatId))) return [{ intent: 'chat-not-allowed' }, []];

    if (event.kind === 'callback') return this.onCallback(event);
    if (event.attachment) {
      // Receipts only in a private chat with the bot; photos and files in the group are family life, not receipts.
      if (event.chatType !== 'private' || !this.d.receipts) return [{ intent: 'attachment-ignored' }, []];
      return this.d.receipts.onReceipt(event, emit);
    }
    switch (event.command) {
      case undefined:
        return this.onReport(event);
      case 'start':
      case 'help':
        return [{ intent: 'help' }, [{ type: 'send', text: COPY.help }]];
      case 'list':
        return [{ intent: 'list' }, [{ type: 'send', text: await this.listText() }]];
      default:
        return [{ intent: 'unknown-command', command: event.command }, []];
    }
  }

  // ---------- depletion report (R4) ----------

  private async onReport(msg: InboundMessage): Promise<[Record<string, unknown>, Reply[]]> {
    const resolution = await this.d.resolver.resolve(msg.text);
    const parsed = { intent: 'report', resolution: summarise(resolution) };
    if (resolution.kind === 'not-a-report') return [parsed, []];

    const replies: Reply[] = [];

    // Items the LLM resolved confidently become aliases, so next time they resolve locally (R21, R22).
    for (const r of resolution.resolved) if (r.via === 'llm') await this.d.registry.learnAlias(r.itemId, r.mention);

    const items = await this.itemsFor(resolution.resolved.map((r) => r.itemId));
    if (items.length > 0) {
      const outcome = await this.d.shopping.reportOut(items, msg.fromUserId, msg.receivedAt);
      replies.push({ type: 'send', text: confirmation(outcome) });
    }

    for (const u of resolution.unresolved) replies.push(await this.ask(msg, u));
    return [parsed, replies];
  }

  private async ask(msg: InboundMessage, u: UnresolvedMention): Promise<Reply> {
    const proposal = u.proposal ?? { name: u.mention, category: 'household' as const };
    const ask: PendingAsk = {
      id: this.newId(),
      chatId: msg.chatId,
      mention: u.mention,
      candidateItemIds: u.candidateItemIds,
      proposal,
      ...(msg.fromUserId !== undefined && { createdByUserId: msg.fromUserId }),
      createdAt: msg.receivedAt.toISOString(),
    };
    await this.d.pending.put(ask);

    const candidates = await this.itemsFor(u.candidateItemIds);
    const buttons: Button[][] = [
      ...candidates.map((c, i) => [{ text: c.name, data: callbackData(ask.id, String(i)) }]),
      [{ text: COPY.newItemButton(proposal.name, proposal.category), data: callbackData(ask.id, 'n') }],
      [{ text: COPY.cancelButton, data: callbackData(ask.id, 'x') }],
    ];
    return { type: 'send', text: COPY.ask(u.mention), buttons };
  }

  // ---------- one-tap answers ----------

  private async onCallback(cb: InboundCallback): Promise<[Record<string, unknown>, Reply[]]> {
    const [prefix, askId, choice] = cb.data.split(':');
    if ((prefix === 'r' || prefix === 'l') && askId && choice && this.d.receipts) {
      return this.d.receipts.onCallback(cb, prefix, askId, choice);
    }
    if (prefix !== CALLBACK_PREFIX || !askId || !choice) {
      return [{ intent: 'callback-unknown' }, [{ type: 'ack', callbackId: cb.callbackId }]];
    }

    // take() is atomic: a double tap or a stale button finds nothing.
    const taken = await this.d.pending.take(askId);
    if (!taken || (taken.kind !== undefined && taken.kind !== 'item')) {
      return [{ intent: 'callback-stale' }, [{ type: 'ack', callbackId: cb.callbackId, text: COPY.stale }]];
    }
    const ask: PendingAsk = taken;

    const ack: Reply = { type: 'ack', callbackId: cb.callbackId };
    const edit = (text: string): Reply => ({ type: 'edit', messageId: cb.messageId, text });

    if (choice === 'x') {
      return [{ intent: 'ask-cancelled', askId }, [ack, edit(COPY.cancelled(ask.mention))]];
    }

    if (choice === 'n') {
      const proposal = ask.proposal ?? { name: ask.mention, category: 'household' };
      const category = (proposal.category in CATEGORIES ? proposal.category : 'household') as CategoryId;
      const item = await this.d.registry.create({ name: proposal.name, category, mention: ask.mention, at: cb.receivedAt });
      await this.d.shopping.reportOut([item], cb.fromUserId, cb.receivedAt);
      return [{ intent: 'item-created', askId, itemId: item.id }, [ack, edit(COPY.createdItem(item.name, category))]];
    }

    const itemId = ask.candidateItemIds[Number(choice)];
    const item = itemId ? await this.d.registry.get(itemId) : undefined;
    if (!item) return [{ intent: 'callback-bad-choice', askId }, [{ ...ack, text: COPY.stale }]];

    await this.d.registry.learnAlias(item.id, ask.mention); // the user's confirmation is the alias (R21)
    const outcome = await this.d.shopping.reportOut([item], cb.fromUserId, cb.receivedAt);
    return [{ intent: 'ask-answered', askId, itemId: item.id }, [ack, edit(confirmation(outcome))]];
  }

  // ---------- helpers ----------

  private async listText(): Promise<string> {
    const entries = await this.d.shopping.openEntries();
    const items = new Map((await this.d.registry.all()).map((i) => [i.id, i]));
    return formatList(entries, items);
  }

  private async itemsFor(ids: string[]): Promise<Item[]> {
    const out: Item[] = [];
    for (const id of ids) {
      const item = await this.d.registry.get(id);
      if (item) out.push(item);
    }
    return out;
  }
}

function callbackData(askId: string, choice: string): string {
  return `${CALLBACK_PREFIX}:${askId}:${choice}`; // ≤ 64 bytes (Telegram limit)
}

function confirmation(o: ReportOutcome): string {
  const names = (items: Item[]) => items.map((i) => i.name).join(', ');
  if (o.added.length && o.alreadyListed.length) return COPY.addedWithAlready(names(o.added), names(o.alreadyListed));
  if (o.added.length) return COPY.added(names(o.added));
  return COPY.alreadyListed(names(o.alreadyListed));
}

/** What goes into the message log next to the raw text (R23). */
function summarise(r: Resolution): Record<string, unknown> {
  if (r.kind === 'not-a-report') return { kind: r.kind, path: r.path, ...(r.llm && { llm: r.llm }) };
  return {
    kind: r.kind,
    path: r.path,
    resolved: r.resolved,
    unresolved: r.unresolved,
    ...(r.llm && { llm: r.llm }),
  };
}
