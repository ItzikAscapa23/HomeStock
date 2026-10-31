# HomeStock — PRD

## 1. Problem

Weekly supermarket shopping for the household is built from guesswork. The list is
assembled from memory, and checking the fridge and pantry first either doesn't happen
or happens partially. Two failure modes result:

- **False positives** — buying something we already have.
- **False negatives** — assuming we have something we don't, and running out.

The root cause is a lack of reliable visibility into current home stock at the moment
the list is built.

The system is for a single household (~5 people, food and non-food items: cleaning
supplies, batteries, toiletries). It is not a product for others.

### Approach

Exact inventory tracking fails in practice — nobody logs every consumed yogurt. The
system instead combines:

1. **Predicted depletion** — purchase history yields a consumption interval per item.
   Items are scored "probably fine / probably low / probably out" rather than counted.
2. **Periodic reconciliation** — before shopping, the user confirms only the handful of
   items in the uncertain band, instead of surveying the whole kitchen.
3. **Opportunistic ground truth** — a Telegram bot lets any family member report
   "נגמר החלב" in three seconds, which overrides the prediction and retrains the
   interval.

Meal planning is a fourth signal: a planned dish is a known future consumption event.

---

## 2. Constraints

**C1 — Telegram only.** The bot is the entire interface. No web app, no mobile app.
Telegram provides auth, group chat, buttons and notifications for free. WhatsApp is
rejected for now: the Business API requires Meta approval, a provider and per-message
cost.

**C2 — Hebrew free text is the primary input.** Messages are shorthand, unvocalised,
with fused prefixes (חלב / החלב / בחלב), spelling variation, and ambiguity
(סבון → dishes? hands? laundry?). Parsing must not rely on regex.

**C3 — Serverless AWS, minimal cost.** Target ≤ $5/month all-in. Specifically:
- No VPC for Lambdas (NAT Gateway is $32/month and would dominate the bill).
- No vector database. The item registry is 200–400 items and fits in a prompt.
- SSM Parameter Store (free tier) for secrets, not Secrets Manager.
- DynamoDB on-demand, single table.
- CloudWatch Logs retention set explicitly to 7 days.

**C4 — Node.js / TypeScript, AWS CDK.** Matches the owner's existing stack.

**C5 — Deploy from laptop.** No CI/CD pipeline. `cdk deploy` with a named AWS profile.

**C6 — Single environment.** No dev/prod split — a second stack means a second bot
token and duplicate webhook management.

**C7 — Adoption is the binding constraint.** Any interaction that takes more than a few
seconds on a phone will not be used. Every feature is judged on friction first,
accuracy second.

---

## 3. Requirements

### Stock in

**R1** — The bot accepts a supermarket receipt as a photo, as a digital file (PDF), or
as free text typed into the chat. Line items are extracted and resolved against the
item registry.

**R2** — Receipt line items use abbreviated supermarket Hebrew ("חלב תנ 3%"). Unmatched
lines are surfaced for one-tap confirmation rather than silently dropped.

**R3** — The default stock-in path is confirming the shopping list produced by R12
after the shopping run ("bought everything except X, Y"). Only deviations are recorded.
R1 is the fallback when shopping happened without a list.

### Depletion

**R4** — Any household member can report an item as finished in free text
("נגמר קרטון חלב"). The item is resolved, marked out, its cycle reset, and it is added
to the next shopping list.

**R5** — A depletion report is ground truth and overrides the prediction.

**R6** — Partial states ("נשאר מעט", "נגמר כמעט") are accepted and stored as a distinct,
weaker signal than "out".

**R7** — Each item carries a learned purchase interval. A depletion score is derived
from `days_since_purchase / typical_interval`. Items are classified probably-fine,
uncertain, or probably-out.

**R8** — Items can be flagged **non-cyclic** (a spice bought twice a year, a one-off).
These are excluded from prediction and handled by explicit reporting only, so they do
not pollute the model.

**R9** — Items can be flagged **staple** (salt, oil, flour). Staples have long intervals
and are suppressed from routine review prompts.

### Review

**R10** — A weekly scheduled prompt (Thursday evening) surfaces only items whose
depletion score falls in the uncertain band, one message per item with Yes/No buttons.
Target: ~6 items, answerable without typing.

**R11** — Every review answer is ground truth and retrains the item's interval. A "still
have" stretches the interval; an "out" shortens it.

### Output

**R12** — On request (`/list`) the bot produces the shopping list: depletion reports +
predicted-low items + meal-plan gaps, deduplicated, grouped by supermarket category,
each item annotated with its reason ("נגמר" / "צפוי להיגמר" / "לשקשוקה").

### Meal planning and recipes

**R13** — The user states planned cooking in free text ("בשבת עושים שקשוקה ופסטה"). The
bot extracts the dishes and matches them against the recipe bank.

**R14** — An unknown dish has its ingredient list generated by an LLM and presented for
confirmation. The output is shopping-relevant only: ingredient + rough quantity +
staple flag. No method, no per-gram quantities.

**R15** — Confirmation is one tap per line: each ingredient removable, plus a free-text
"add" line. The first interaction must not be a long conversation.

**R16** — Generation is seeded with household context (R20) and the item registry, so
returned ingredients use canonical names rather than synonyms needing resolution.

**R17** — Each recipe records provenance: `generated`, `confirmed`, or `edited`. An
unconfirmed generated recipe is trusted less and re-asked after the dish is first
cooked. After one or two confirmations it becomes stable and stops asking.

**R18** — Recipes can be defined directly, outside any shopping context, and browsed and
edited later (`/recipes`). The recipe bank is a deliverable in its own right — over time
it becomes the household cookbook.

**R19** — Planned dishes produce the union of their ingredients, minus likely stock;
only genuinely uncertain items are asked about before being merged into the list.

### Cross-cutting

**R20** — A **household context** record (kashrut, allergies, preferences, things the
kids won't eat) is injected into every LLM call.

**R21** — An **item registry** of canonical items, each with a growing alias list, is the
single vocabulary every message, receipt line and recipe ingredient resolves to. Every
user confirmation writes a new alias back, so resolution sharpens with use.

**R22** — Resolution short-circuits before the LLM: an exact alias match resolves
locally with no model call. Over time most messages take this path.

**R23** — Raw inbound messages are stored alongside their parsed result, so a bad
resolution can be diagnosed months later against the original text.

**R24** — The bot lives in a family group chat. Any member can report; the household,
not the individual, is the entity that owns stock. `telegram_user_id` maps to a member
for attribution only.

**R25** — Bot replies are short — a single confirmation line. Group-chat noise is an
adoption risk.

**R26** — Inbound updates are deduplicated by Telegram `update_id`. The webhook
acknowledges within Telegram's timeout and slow work (LLM, vision) happens
asynchronously.

### Secondary

**R27** — Inventory query: "יש לנו ביצים?" returns the current state of an item or
category.

**R28** — History and stats: what was bought, how much, how often. Answered with
structured queries, not retrieval.

---

## 4. Non-goals

**N1** — Not a multi-tenant product. One household. No sign-up flow, no billing, no
onboarding.

**N2** — No web or mobile frontend.

**N3** — No WhatsApp support in the initial build.

**N4** — No barcode scanning. Receipts and free text cover the same ground with less
hardware friction.

**N5** — No exact quantity tracking as a general mechanism. Counts may be kept for a
small set of countable, recipe-critical items (eggs, onions, tomatoes); everything else
stays probabilistic.

**N6** — No vector database or embedding search. The registry fits in a prompt. Revisit
only above ~1000 items.

**N7** — No RAG over structured data. Purchase history, stock levels and intervals are
queried directly. Retrieval is reserved for recipes and unstructured household
knowledge.

**N8** — No price tracking, budgeting, or store comparison.

**N9** — No automatic ordering or supermarket integration.

**N10** — No per-user permissions. Everyone in the family group has the same rights.

---

## 5. Open questions

**Q1 — Cold start.** For the first 3–4 weeks there is no learned interval. Options:
seed category defaults (dairy ~5 days, cleaning supplies ~60), or accept a long review
list initially and let it shrink. Decide before R7 is implemented.

**Q2 — Recipe quantity vs probabilistic stock.** Recipes are quantitative ("6 eggs");
inventory is probabilistic ("probably have eggs"). Either ask the user to verify
quantity for the few items a recipe depends on heavily, or keep real counts for a small
countable set (see N5). Decide before R19.

**Q3 — Brand vs generic in the registry.** Is "תנובה 3%" the same canonical item as
"חלב"? This is a household decision, not a general one, and it shapes R21.

**Q4 — Model routing.** Which tasks go to a small fast model (text resolution, intent
parsing) and which justify a stronger one (receipt vision, recipe generation). Affects
cost more than anything else in the system.

**Q5 — Expected first-time recipe edit rate.** LLM generation produces a generic Israeli
version of a dish; the household version may differ substantially. High edit rates on
first use are expected and are not a sign the generation is broken — but if they stay
high after confirmation, R17's trust model needs revisiting.
