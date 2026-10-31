# HomeStock — Plan

Spec file. Read-only during execution. All state lives in HANDOVER.md.
PRD: ./PRD.md

**Sequencing principle:** the adoption risk dominates the technical risk. Phase 1 is
deliberately the smallest loop that proves the family will use a Telegram bot at all.
Prediction, receipts and recipes are all worthless if nobody types "נגמר חלב". Do not
reorder phases to build the interesting parts first.

Two things are established in Phase 0 and 1 even though they are not used until later,
because retrofitting them is expensive: the **item registry** as a first-class entity
(R21) and **raw message storage** alongside parsed results (R23).

---

## Phase 0 — Groundwork and plumbing

**Goal:** A deployed Telegram bot that echoes a message, proving the whole pipe from
Telegram to Lambda to reply works.

**PRD refs:** §2 Constraints (C3, C4, C5, C6), R26

**Tasks:**
- [ ] Initialise repo: TypeScript, CDK v2, esbuild via `NodejsFunction`, npm scripts for `build`, `test`, `diff`, `deploy`
- [ ] Create the bot with BotFather; store token in SSM Parameter Store (standard tier)
- [ ] CDK stack: HTTP API Gateway, ingress Lambda, worker Lambda, DynamoDB table (on-demand, single table), S3 bucket for receipts, CloudWatch log retention 7 days
- [ ] Set `removalPolicy: RETAIN` on the table and bucket
- [ ] Ingress Lambda: validate Telegram secret token, dedupe on `update_id`, return 200 fast, async-invoke the worker
- [ ] Worker Lambda: reply "pong" to any message via `sendMessage`
- [ ] `scripts/set-webhook.ts` — one-time webhook registration, deliberately NOT part of deploy
- [ ] Record stack, commands, directory layout and conventions in HANDOVER.md

**Definition of Done:**
- `cdk deploy --profile homestock` succeeds from a clean checkout
- A message sent to the bot in a private chat receives a reply
- The same `update_id` delivered twice produces exactly one reply
- No VPC attached to either Lambda; log groups show 7-day retention
- HANDOVER.md exists with a populated project header

**Verification:**
```bash
npm ci
npm run build
npm test
npx cdk synth
```

**Entry conditions for next phase:**
- Bot replies to a live message
- Table name and bucket name are readable from HANDOVER.md

---

## Phase 1 — Depletion reports and the shopping list

**Goal:** A family member can type "נגמר חלב" in the group and see that item on `/list`.

**PRD refs:** R4, R5, R12, R21, R22, R23, R24, R25

**Tasks:**
- [ ] Data model for `Item` (canonical name, category, aliases, flags — flags unused this phase) and `ListEntry` (item, reason, created_at, resolved_at)
- [ ] Seed the registry with ~50 items the household actually buys, hand-written
- [ ] Exact-alias resolver: normalise Hebrew prefixes and whitespace, match locally, no LLM call (R22)
- [ ] LLM fallback resolver: send the full registry plus the message, return a canonical match or `unknown`
- [ ] Unknown item flow: offer "add as new item?" with one-tap confirm; confirming writes the alias back
- [ ] Depletion report handler: resolve → mark out → add to list → single-line confirmation reply
- [ ] `/list` — grouped by category, each line annotated with its reason
- [ ] Persist every inbound message raw alongside its parsed result (R23)

**Definition of Done:**
- "נגמר חלב" in a group chat adds milk to the list and replies in one line
- A variant form ("נגמר לנו החלב") resolves to the same item
- An unknown item prompts to add it, and after confirming, the same phrasing resolves locally next time
- `/list` returns the items grouped by category with reasons
- Every inbound message is retrievable in raw form

**Verification:**
```bash
npm run build
npm test
npx cdk synth
```

**Entry conditions for next phase:**
- The family has used the bot for at least two weeks
- At least 20 real depletion reports in the table

> **Review gate.** If the family did not use it, stop and diagnose adoption before
> building anything else. This gate is the point of the phase.

---

## Phase 2 — Stock in and interval learning

**Goal:** Purchases are recorded, and each item accumulates enough history to produce a
depletion score.

**PRD refs:** R1, R2, R3, R7, R8, R9, Q1, Q3

**Tasks:**
- [ ] Resolve Q3 (brand vs generic granularity) with the user; record the decision
- [ ] Resolve Q1 (cold start) with the user: seeded category defaults vs longer initial review
- [ ] `Purchase` records: item, quantity, source (`list-confirm` | `receipt` | `manual`), timestamp
- [ ] Post-shopping confirmation flow (R3): present the open list, mark bought/not-bought, write purchases, clear the list
- [ ] Receipt ingestion (R1, R2): accept photo or PDF to S3, vision/LLM extraction to line items, resolve each, surface unmatched for one-tap confirm
- [ ] Interval learning (R7): rolling estimate of days between purchases per item; depletion score from days-since-purchase over interval
- [ ] `staple` and `non-cyclic` flags (R8, R9) on items, excluded from or damped in scoring
- [ ] Backfill intervals from any purchase history already present

**Definition of Done:**
- Confirming the list after a shopping run writes purchases and empties the list
- A photographed receipt produces line items, with unmatched lines surfaced rather than dropped
- Every item with ≥2 purchases has a computed interval and a current depletion score
- Staple and non-cyclic items are excluded from scoring as specified

**Verification:**
```bash
npm run build
npm test
npx cdk synth
```

**Entry conditions for next phase:**
- At least 15 items carry a learned interval from real purchase data

---

## Phase 3 — Weekly review

**Goal:** A scheduled Thursday prompt collects ground truth on uncertain items with
taps, not typing.

**PRD refs:** R6, R10, R11

**Tasks:**
- [ ] EventBridge Scheduler rule, Thursday evening Asia/Jerusalem, invoking a review Lambda
- [ ] Uncertain-band selection: score within the ambiguous range, staples and non-cyclic excluded, capped at ~8 items
- [ ] One message per item with Yes / No / Add buttons; handle callback queries
- [ ] Apply answers as ground truth and retrain the interval (R11)
- [ ] Partial-state handling (R6): accept "נשאר מעט" as a distinct weaker signal, both from buttons and free text
- [ ] `/review` to trigger the pass manually
- [ ] Guard against duplicate or stale callbacks when a review is answered late

**Definition of Done:**
- The scheduled job fires and sends the review in the family group
- Answering Yes/No updates stock state and visibly changes the item's interval
- A review answered two days late does not corrupt state
- Review list size is ~6–8 items, not the whole registry

**Verification:**
```bash
npm run build
npm test
npx cdk synth
```

**Entry conditions for next phase:**
- Two consecutive weekly reviews have been answered by the family
- Review list size is trending down as intervals tighten

---

## Phase 4 — Recipe bank

**Goal:** Dishes can be defined, generated, confirmed, browsed and edited — independent
of any shopping flow.

**PRD refs:** R14, R15, R16, R17, R18, R20, Q5

**Tasks:**
- [ ] `Recipe` model: dish name, aliases, ingredient lines (canonical item + rough quantity + staple flag), provenance (R17)
- [ ] Household context record (R20) and injection into every LLM call
- [ ] LLM ingredient generation (R14), seeded with household context and the registry so names come back canonical (R16)
- [ ] One-tap confirmation UI (R15): removable lines plus a free-text add
- [ ] `/recipes` — list, view, edit, delete
- [ ] Provenance transitions and the post-first-cook re-ask (R17)
- [ ] Dish-name resolution: "שקשוקה" and a free-text description land on the same stored dish

**Definition of Done:**
- A new dish name produces a generated ingredient list in one message
- Removing a line and adding one stores an `edited` recipe
- A `generated` recipe triggers a confirmation prompt after first use; a `confirmed` one does not
- Generated ingredients use canonical registry names, not synonyms

**Verification:**
```bash
npm run build
npm test
npx cdk synth
```

**Entry conditions for next phase:**
- At least 5 recipes stored, of which ≥3 are `confirmed` or `edited`

---

## Phase 5 — Meal planning

**Goal:** Stating what will be cooked produces the missing ingredients on the shopping
list.

**PRD refs:** R13, R19, Q2

**Tasks:**
- [ ] Resolve Q2 (recipe quantities vs probabilistic stock) with the user; record the decision
- [ ] Multi-dish extraction from free text ("בשבת עושים שקשוקה ופסטה") → recipe matches, unknown dishes routed to Phase 4 generation
- [ ] Ingredient union across planned dishes, deduplicated
- [ ] Subtract likely stock using depletion scores; staples suppressed
- [ ] Ask only genuinely uncertain items, one tap each
- [ ] Merge gaps into the list with reason "לשקשוקה" (R12 annotation)
- [ ] Meal plan as a consumption signal: planned dishes adjust expected depletion

**Definition of Done:**
- A two-dish message produces a correct missing-ingredients list
- An unknown dish in a meal-plan message flows through generation and confirmation without leaving the chat
- Staples do not appear in the questions
- List entries from meal planning are annotated with the dish that caused them

**Verification:**
```bash
npm run build
npm test
npx cdk synth
```

**Entry conditions for next phase:**
- One real weekend shopping run planned through this flow

---

## Phase 6 — Queries and history

**Goal:** Ad-hoc questions about current stock and past purchases are answerable in
chat.

**PRD refs:** R27, R28, N7

**Tasks:**
- [ ] Intent routing: distinguish a question from a report or a meal plan
- [ ] Inventory query (R27): item or category current state, with confidence wording that reflects prediction vs ground truth
- [ ] History and stats (R28): structured queries over purchases — frequency, last bought, volume
- [ ] Confirm no query path goes through retrieval (N7)

**Definition of Done:**
- "יש לנו ביצים?" returns a state and distinguishes "confirmed in stock" from "probably"
- "כמה פעמים קנינו חלב החודש?" returns a correct count
- A question is never misrouted as a depletion report

**Verification:**
```bash
npm run build
npm test
npx cdk synth
```
