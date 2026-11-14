import type { ReceiptLine } from '../domain/item.js';
import type { JsonSchema, LlmAttachment, LlmClient } from '../llm/types.js';

export interface ExtractedReceipt {
  isReceipt: boolean;
  store: string | null;
  chain: Chain;
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
        maxTokens: 16_000, // room for adaptive thinking plus a long receipt
        timeoutMs: 120_000,
      },
      validate,
    );
    return { ...value, llm: { provider, model } };
  }
}

/**
 * Chains we can tell apart. Barcodes (GTIN) are global, but short item codes and produce PLUs
 * ("2047", "4131074") are each chain's own — Victory's 2009 is bananas, another chain's 2009
 * can be anything. So internal codes are kept per chain, and dropped when the chain is unknown.
 */
export const CHAINS = [
  'shufersal', 'rami-levy', 'victory', 'yochananof', 'osher-ad', 'tiv-taam', 'carrefour',
  'mega', 'hazi-hinam', 'super-pharm', 'be', 'other',
] as const;
export type Chain = (typeof CHAINS)[number];

const SYSTEM = `You read Israeli shopping receipts, tax invoices and delivery notes (קבלה, חשבונית מס,
תעודת משלוח) — supermarkets (Shufersal, Rami Levy, Victory, Yochananof, Osher Ad, Tiv Taam…),
drugstores (Super-Pharm, Be) and online-order delivery notes, including narrow thermal-printer
layouts. Hebrew text in PDFs is often stored reversed, mixed-direction or with a broken text
layer — read the page as a person would see it.

Return one entry per purchased product line:
- code: the item code / barcode / מק"ט printed on the line (digits only), or null.
- description: the product description in correct Hebrew reading order. Descriptions often wrap
  onto a second line, and a product's description can continue at the top of the next page —
  join the parts into one description for that product.
- quantity: the quantity actually SUPPLIED/charged. If the receipt has both "ordered" (הוזמן) and
  "supplied" (סופק) columns, use supplied. Skip lines where supplied is 0 (out of stock or replaced).
- unit: "kg" for items sold by weight (quantity is the weight, e.g. 1.20 ק"ג), otherwise "unit".
- total: the line's amount in ₪ as printed (the סה"כ column), or null if the line has none.
If the same product appears on several lines, return each line as printed.
Check every line: quantity × unit price = total. If it doesn't, you swapped quantity and price.

Layouts to expect:
- The item code can be on its own line above the name, or before the name on the same line.
- Quantity and unit price are often on the line UNDER the product: "2.90 x 8 ליחידה" or
  "8 x 2.90" = 8 units; "0.815 ק\"ג x 6.90 לק\"ג" = 0.815 kg. Use the count/weight, not the price.
- Victory (ויקטורי): columns קוד פריט | תיאור | סה"כ, with "כמות * מחיר" under the product when
  the quantity isn't 1. Printed left-to-right it reads "10.00 * 2" (= 2 units at 10.00, total
  20.00) or "7.90 * 1.085" (= 1.085 kg at 7.90/kg, total 8.57). Weighed produce and meat have a
  short code (2047, 2206057) on its own line next to the name. Bold lines starting with "בנ"
  and a number ("בנ22233טבלאות שוקל -7.70", "בנ90603חזה עוף טרי -35.70") are promotions even
  though they name a product — skip them.
- Photos of paper receipts may be folded, skewed, curled or partly covered by fingers. Read every
  product line you can see; skip a line only if you truly cannot read it.

Do NOT return:
- promotion/discount lines — "מבצע", "הנחה", "קופון", "קטיף", "סאבדיי", "קידוד אריזה", negative amounts, and deal descriptions
  printed as a text line without their own item price (e.g. "פסטה רומו 2 ב 20", "שימורי X 2ב16",
  "מ. השיטה 2 ב 11-"), which belong to the product next to them;
- deposits (פיקדון), delivery/packing fees, bags ("שקית קופה", "שקיות קופה"), subtotals, totals, VAT (מע"מ),
- lines with a 0.00 total (stubs and vouchers such as "ספח ..."),
- loyalty-club sections (member name, points, savings, coupons),
- payment lines and whole-bill discounts (cash, gift cards such as "כרטיס DTS", "הנחת חשבון",
  credit-card company names such as כאל / ויזה / ישראכרט / מקס / כ.אשראי, change).

isReceipt = false if the file is not a shopping receipt (then lines = []).
store: the chain/store name, or null. chain: which chain it is, "other" if not in the list.
purchasedOn: the purchase or delivery date as YYYY-MM-DD, or null. Israeli dates print day
first: 13/11/2026 = 2026-11-13. Prefer the supply/delivery date over the order date.
Never include the customer's name, phone or address anywhere in the output.`;

const SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['isReceipt', 'store', 'chain', 'purchasedOn', 'lines'],
  properties: {
    isReceipt: { type: 'boolean' },
    store: { type: ['string', 'null'] },
    chain: { type: 'string', enum: [...CHAINS] },
    purchasedOn: { type: ['string', 'null'] },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'description', 'quantity', 'unit', 'total'],
        properties: {
          code: { type: ['string', 'null'] },
          description: { type: 'string' },
          quantity: { type: 'number' },
          unit: { type: 'string', enum: ['unit', 'kg'] },
          total: { type: ['number', 'null'] },
        },
      },
    },
  },
};

function validate(json: unknown): Omit<ExtractedReceipt, 'llm'> {
  const v = json as { isReceipt?: unknown; store?: unknown; chain?: unknown; purchasedOn?: unknown; lines?: unknown } | null;
  if (!v || typeof v.isReceipt !== 'boolean' || !Array.isArray(v.lines)) {
    throw new Error('Receipt extraction: malformed response');
  }
  const chain: Chain = (CHAINS as readonly unknown[]).includes(v.chain) ? (v.chain as Chain) : 'other';
  const lines: ReceiptLine[] = [];
  for (const raw of v.lines as Record<string, unknown>[]) {
    const description = typeof raw?.description === 'string' ? raw.description.trim() : '';
    const quantity = typeof raw?.quantity === 'number' && Number.isFinite(raw.quantity) ? raw.quantity : 0;
    // Belt and braces: never record a zero/negative line. A printed total of 0 or less is a
    // promo, a discount or a voucher stub, whatever product name it carries.
    const total = typeof raw?.total === 'number' && Number.isFinite(raw.total) ? raw.total : null;
    if (!description || quantity <= 0 || (total !== null && total <= 0)) continue;
    lines.push({
      index: lines.length,
      code: scopeCode(typeof raw.code === 'string' ? raw.code : null, chain),
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
    chain,
    purchasedOn,
    lines: v.isReceipt ? mergeDuplicates(lines) : [],
  };
}

/**
 * A barcode (GTIN-8/12/13/14) is the same product in every shop and is kept as is. Any other
 * code is the chain's own, so it is prefixed with the chain ("victory:2047"); with no known
 * chain it is dropped — a wrong code match records the wrong product without asking.
 */
export function scopeCode(code: string | null, chain: Chain): string | null {
  const digits = (code ?? '').replace(/\D/g, '');
  if (digits.length < 3) return null;
  if ([8, 12, 13, 14].includes(digits.length)) return digits;
  return chain === 'other' ? null : `${chain}:${digits}`;
}

/**
 * Receipts often print the same product on several lines (Super-Pharm: one line per unit;
 * Osher Ad: one line per promo pair). One product must become one item and one purchase,
 * so lines with the same code — or, without a code, the same description — are summed.
 */
export function mergeDuplicates(lines: ReceiptLine[]): ReceiptLine[] {
  const merged = new Map<string, ReceiptLine>();
  for (const line of lines) {
    const key = `${line.unit}|${line.code ? `c:${line.code.replace(/\D/g, '')}` : `d:${line.description.replace(/\s+/g, ' ')}`}`;
    const prev = merged.get(key);
    if (prev) prev.quantity = Math.round((prev.quantity + line.quantity) * 1000) / 1000;
    else merged.set(key, { ...line });
  }
  return [...merged.values()].map((l, index) => ({ ...l, index }));
}
