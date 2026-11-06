import { randomUUID } from 'node:crypto';
import { CATEGORIES, type CategoryId } from '../domain/categories.js';
import type { Item } from '../domain/item.js';
import type { Button, Inbound, InboundCallback, InboundMessage, Reply } from '../domain/message.js';
import type { StockService } from '../inventory/stock.js';
import type { MessageLog, PendingAsk, PendingMerge, PendingStore } from '../persistence/stores.js';
import type { ReceiptFlow } from './receipt-flow.js';
import type { ItemRegistry } from '../registry/item-registry.js';
import type { Resolution, Resolver, UnresolvedMention } from '../registry/resolver.js';
import { formatList, type ReportOutcome, type ShoppingList } from '../shopping/shopping-list.js';
import type { ChatGate } from './chat-gate.js';

/** All user-facing copy for this module (CLAUDE.md: one place per module). Replies are one line (R25). */
const COPY = {
  help: 'כתבו מה נגמר ("נגמר חלב"), מה קניתם ("קניתי חלב") או שאלו ("יש לנו ביצים?") · /list רשימת קניות · /same א = ב לאחד מוצרים',
  chatId: (chatId: number, userId: number | undefined) => `chat id: ${chatId}${userId ? ` · user id: ${userId}` : ''}`,
  added: (names: string) => `✓ ${names} — ברשימה`,
  alreadyListed: (names: string) => `${names} כבר ברשימה`,
  addedWithAlready: (added: string, already: string) => `✓ ${added} — ברשימה (${already} כבר שם)`,
  ask: (mention: string) => `לא בטוח מה זה "${mention}":`,
  newItemButton: (name: string, category: CategoryId) => `➕ חדש: ${name} (${CATEGORIES[category]})`,
  cancelButton: '✕ לא משנה',
  createdItem: (name: string, category: CategoryId) => `✓ נוסף פריט חדש: ${name} (${CATEGORIES[category]}) — ברשימה`,
  cancelled: (mention: string) => `"${mention}" — בוטל`,
  bought: (names: string) => `✓ נרשם שנקנה: ${names}`,
  boughtCleared: (names: string, cleared: string) => `✓ נרשם שנקנה: ${names} · ירד מהרשימה: ${cleared}`,
  createdBought: (name: string, category: CategoryId) => `✓ נוסף פריט חדש: ${name} (${CATEGORIES[category]}) — נרשם שנקנה`,
  unknownInQuery: (mentions: string) => `לא מכיר: ${mentions}`,
  sameUsage: 'כתבו כך: /same קוטג׳ 9% = קוטג׳ (השם אחרי ה-= נשאר)',
  sameUnknownTarget: (t: string) => `לא מכיר את "${t}" — כתבו את השם כפי שמופיע ב-/list`,
  sameAlready: (s: string, t: string) => `"${s}" כבר = ${t}`,
  sameAliased: (s: string, t: string) => `✓ מעכשיו "${s}" = ${t}`,
  mergeAsk: (s: string, t: string) => `🔀 לאחד את "${s}" לתוך "${t}"? היסטוריית הקניות עוברת, "${s}" יימחק`,
  mergeYes: '✓ אחד',
  mergeNo: '✕ ביטול',
  merged: (s: string, t: string, moved: number) => `✓ "${s}" אוחד לתוך "${t}"${moved ? ` (${moved} קניות עברו)` : ''}`,
  mergeCancelled: 'האיחוד בוטל',
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
  stock: StockService;
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
      case 'same':
        return this.onSame(event);
      default:
        return [{ intent: 'unknown-command', command: event.command }, []];
    }
  }

  // ---------- free text: ran out (R4), bought (R3), question (R27) ----------

  private async onReport(msg: InboundMessage): Promise<[Record<string, unknown>, Reply[]]> {
    const resolution = await this.d.resolver.resolve(msg.text);
    const parsed = { intent: resolution.kind === 'items' ? resolution.intent : 'report', resolution: summarise(resolution) };
    if (resolution.kind === 'not-a-report') return [parsed, []];

    // Items the LLM resolved confidently become aliases, so next time they resolve locally (R21, R22).
    for (const r of resolution.resolved) if (r.via === 'llm') await this.d.registry.learnAlias(r.itemId, r.mention);
    const items = await this.itemsFor(resolution.resolved.map((r) => r.itemId));

    if (resolution.intent === 'query') {
      // A question never changes state and never asks back — one line (R25, R27).
      const parts = items.length > 0 ? [await this.d.stock.describe(items)] : [];
      if (resolution.unresolved.length > 0) parts.push(COPY.unknownInQuery(resolution.unresolved.map((u) => u.mention).join(', ')));
      return [parsed, parts.length ? [{ type: 'send', text: parts.join(' · ') }] : []];
    }

    const replies: Reply[] = [];
    if (items.length > 0) {
      if (resolution.intent === 'in') {
        const { cleared } = await this.d.stock.recordBought(items, msg.fromUserId, msg.receivedAt);
        replies.push({ type: 'send', text: boughtLine(items, cleared) });
      } else {
        const outcome = await this.d.shopping.reportOut(items, msg.fromUserId, msg.receivedAt);
        replies.push({ type: 'send', text: confirmation(outcome) });
      }
    }

    for (const u of resolution.unresolved) replies.push(await this.ask(msg, u, resolution.intent));
    return [parsed, replies];
  }

  private async ask(msg: InboundMessage, u: UnresolvedMention, action: 'out' | 'in'): Promise<Reply> {
    const proposal = u.proposal ?? { name: u.mention, category: 'household' as const };
    const ask: PendingAsk = {
      id: this.newId(),
      action,
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
    if (prefix === 'm' && askId && choice) return this.onMergeTap(cb, askId, choice);
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
      if (ask.action === 'in') {
        await this.d.stock.recordBought([item], cb.fromUserId, cb.receivedAt);
        return [{ intent: 'item-created', askId, itemId: item.id }, [ack, edit(COPY.createdBought(item.name, category))]];
      }
      await this.d.shopping.reportOut([item], cb.fromUserId, cb.receivedAt);
      return [{ intent: 'item-created', askId, itemId: item.id }, [ack, edit(COPY.createdItem(item.name, category))]];
    }

    const itemId = ask.candidateItemIds[Number(choice)];
    const item = itemId ? await this.d.registry.get(itemId) : undefined;
    if (!item) return [{ intent: 'callback-bad-choice', askId }, [{ ...ack, text: COPY.stale }]];

    await this.d.registry.learnAlias(item.id, ask.mention); // the user's confirmation is the alias (R21)
    if (ask.action === 'in') {
      const { cleared } = await this.d.stock.recordBought([item], cb.fromUserId, cb.receivedAt);
      return [{ intent: 'ask-answered', askId, itemId: item.id }, [ack, edit(boughtLine([item], cleared))]];
    }
    const outcome = await this.d.shopping.reportOut([item], cb.fromUserId, cb.receivedAt);
    return [{ intent: 'ask-answered', askId, itemId: item.id }, [ack, edit(confirmation(outcome))]];
  }

  // ---------- /same A = B: "these are the same product for us" (R21) ----------

  private async onSame(msg: InboundMessage): Promise<[Record<string, unknown>, Reply[]]> {
    const args = msg.text.replace(/^\/\S+\s*/, '');
    const parts = args.split('=').map((p) => p.trim());
    const [left, right] = parts;
    if (parts.length !== 2 || !left || !right) return [{ intent: 'same-usage' }, [{ type: 'send', text: COPY.sameUsage }]];

    const target = await this.d.registry.findExact(right);
    if (!target) return [{ intent: 'same-unknown-target' }, [{ type: 'send', text: COPY.sameUnknownTarget(right) }]];

    const source = await this.d.registry.findExact(left);
    if (source?.id === target.id) return [{ intent: 'same-already' }, [{ type: 'send', text: COPY.sameAlready(left, target.name) }]];
    if (!source) {
      // Not an item of its own — just another way of saying the target.
      await this.d.registry.learnAlias(target.id, left);
      return [{ intent: 'same-alias', itemId: target.id }, [{ type: 'send', text: COPY.sameAliased(left, target.name) }]];
    }

    // Two existing items: merging deletes one, so it takes a confirm tap.
    const ask: PendingMerge = {
      kind: 'merge',
      id: this.newId(),
      chatId: msg.chatId,
      sourceId: source.id,
      targetId: target.id,
      ...(msg.fromUserId !== undefined && { createdByUserId: msg.fromUserId }),
      createdAt: msg.receivedAt.toISOString(),
    };
    await this.d.pending.put(ask);
    return [
      { intent: 'same-merge-asked', sourceId: source.id, targetId: target.id },
      [
        {
          type: 'send',
          text: COPY.mergeAsk(source.name, target.name),
          buttons: [[{ text: COPY.mergeYes, data: `m:${ask.id}:y` }, { text: COPY.mergeNo, data: `m:${ask.id}:n` }]],
        },
      ],
    ];
  }

  private async onMergeTap(cb: InboundCallback, id: string, choice: string): Promise<[Record<string, unknown>, Reply[]]> {
    const ack: Reply = { type: 'ack', callbackId: cb.callbackId };
    const p = await this.d.pending.take(id);
    if (!p || p.kind !== 'merge') return [{ intent: 'callback-stale' }, [{ ...ack, text: COPY.stale }]];
    const edit = (text: string): Reply => ({ type: 'edit', messageId: cb.messageId, text });
    if (choice !== 'y') return [{ intent: 'merge-cancelled' }, [ack, edit(COPY.mergeCancelled)]];

    const { source, target } = await this.d.registry.merge(p.sourceId, p.targetId);
    const moved = await this.d.stock.mergeInto(source.id, target.id);
    return [
      { intent: 'merged', sourceId: source.id, targetId: target.id, purchasesMoved: moved },
      [ack, edit(COPY.merged(source.name, target.name, moved))],
    ];
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

function boughtLine(items: Item[], cleared: Item[]): string {
  const names = items.map((i) => i.name).join(', ');
  return cleared.length ? COPY.boughtCleared(names, cleared.map((i) => i.name).join(', ')) : COPY.bought(names);
}

/** What goes into the message log next to the raw text (R23). */
function summarise(r: Resolution): Record<string, unknown> {
  if (r.kind === 'not-a-report') return { kind: r.kind, path: r.path, ...(r.llm && { llm: r.llm }) };
  return {
    kind: r.kind,
    intent: r.intent,
    path: r.path,
    resolved: r.resolved,
    unresolved: r.unresolved,
    ...(r.llm && { llm: r.llm }),
  };
}
