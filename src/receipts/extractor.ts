import type { ReceiptLine } from '../domain/item.js';
import type { JsonSchema, LlmAttachment, LlmClient } from '../llm/types.js';

export interface ExtractedReceipt {
  isReceipt: boolean;
  store: string | null;
  /** YYYY-MM-DD, or null if the receipt shows no date. */
  purchasedOn: string | null;
  lines: ReceiptLine[];
  llm: { provider: string; model: string };
}

/** Reads a receipt file into product lines (R1). The model sees the original file. */
export class ReceiptExtractor {
  constructor(private readonly llm: LlmClient) {}

  async extract(file: LlmAttachment): Promise<ExtractedReceipt> {
    const { value, provider, model } = await this.llm.complete(
      {
        task: 'extract-receipt',
        system: SYSTEM,
        user: 'Extract this receipt.',
        attachments: [file],
        schemaName: 'receipt',
        schema: SCHEMA,
        maxTokens: 8000,
        timeoutMs: 120_000,
      },
      validate,
    );
    return { ...value, llm: { provider, model } };
  }
}

const SYSTEM = `You read Israeli supermarket receipts, invoices and delivery notes (קבלה, חשבונית,
תעודת משלוח) from chains such as Shufersal, Rami Levy, Victory, Yochananof, Osher Ad, Tiv Taam,
including online-order delivery notes. Hebrew text in PDFs is often stored in reversed or mixed
direction — read it as a person would see it on the page.

Return one entry per purchased product:
- code: the item code or barcode printed on the line (digits only), or null.
- description: the product description as printed, in correct Hebrew reading order.
- quantity: the quantity actually SUPPLIED/charged. If the receipt has both "ordered" (הוזמן) and
  "supplied" (סופק) columns, use supplied. Skip lines where supplied is 0 (out of stock or replaced).
- unit: "kg" for items sold by weight (quantity is the weight), otherwise "unit".

Do NOT return: promotion/discount lines (מבצע, הנחה, קופון, negative amounts), deposits (פיקדון),
delivery or packing fees, bags, subtotals, totals, VAT, payment lines.

isReceipt = false if the file is not a shopping receipt (then lines = []).
store: the chain/store name, or null. purchasedOn: the purchase or delivery date as YYYY-MM-DD
(prefer the supply/delivery date over the order date), or null.
Never include the customer's name, phone or address anywhere in the output.`;

const SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['isReceipt', 'store', 'purchasedOn', 'lines'],
  properties: {
    isReceipt: { type: 'boolean' },
    store: { type: ['string', 'null'] },
    purchasedOn: { type: ['string', 'null'] },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'description', 'quantity', 'unit'],
        properties: {
          code: { type: ['string', 'null'] },
          description: { type: 'string' },
          quantity: { type: 'number' },
          unit: { type: 'string', enum: ['unit', 'kg'] },
        },
      },
    },
  },
};

function validate(json: unknown): Omit<ExtractedReceipt, 'llm'> {
  const v = json as { isReceipt?: unknown; store?: unknown; purchasedOn?: unknown; lines?: unknown } | null;
  if (!v || typeof v.isReceipt !== 'boolean' || !Array.isArray(v.lines)) {
    throw new Error('Receipt extraction: malformed response');
  }
  const lines: ReceiptLine[] = [];
  for (const raw of v.lines as Record<string, unknown>[]) {
    const description = typeof raw?.description === 'string' ? raw.description.trim() : '';
    const quantity = typeof raw?.quantity === 'number' && Number.isFinite(raw.quantity) ? raw.quantity : 0;
    if (!description || quantity <= 0) continue; // belt and braces: never record a zero/negative line
    lines.push({
      index: lines.length,
      code: typeof raw.code === 'string' && raw.code.trim() ? raw.code.trim() : null,
      description,
      quantity,
      unit: raw.unit === 'kg' ? 'kg' : 'unit',
    });
  }
  const purchasedOn =
    typeof v.purchasedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.purchasedOn) ? v.purchasedOn : null;
  return {
    isReceipt: v.isReceipt,
    store: typeof v.store === 'string' && v.store.trim() ? v.store.trim() : null,
    purchasedOn,
    lines: v.isReceipt ? lines : [],
  };
}
