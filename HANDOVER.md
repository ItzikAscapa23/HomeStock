# HomeStock — Handover

Single source of truth for project state. Rewritten at the end of every phase.
Spec lives in `plan.md` and `PRD.md` — both read-only during execution.

---

## Project header

*Established in phase 0. Changes only when something structural changes.*

**Stack:** TypeScript (strict, `verbatimModuleSyntax`, ESM / NodeNext), Node.js 22,
npm. AWS CDK v2 (`aws-cdk-lib` 2.275, CLI 2.1147). Lambdas bundled by esbuild via
`NodejsFunction` (ESM, minified, arm64, nodejs22.x; `@aws-sdk/*` externalised — the
runtime provides it). Tests: vitest. TypeScript 7 (`tsc` only typechecks; no emit).
No framework (see CLAUDE.md).

**Deployed environment:** account `671292827773`, region `eu-central-1`, AWS profile
`homestock` (IAM Identity Center SSO, `AdministratorAccess`). CDK bootstrapped.

| Resource | Name |
|---|---|
| CloudFormation stack | `HomeStock` |
| DynamoDB table | `homestock` (PK/SK strings, TTL attr `ttl`, on-demand, PITR on, RETAIN) |
| S3 bucket | `homestock-receipts-671292827773` (private, SSE-S3, RETAIN) |
| Webhook URL | `https://85r4hqb7z4.execute-api.eu-central-1.amazonaws.com/telegram` |
| Lambdas | `HomeStock-Ingress…` (256 MB, 10 s), `HomeStock-Worker…` (512 MB, 60 s, async retries 0) |
| Log groups | one per Lambda, 7-day retention |
| SSM (manual, SecureString) | `/homestock/telegram/bot-token`, `/homestock/telegram/webhook-secret`, `/homestock/llm/anthropic-api-key`, `/homestock/llm/openai-api-key` |
| SSM (manual, String) | `/homestock/telegram/allowed-chat-ids` — comma-separated chat ids |
| Telegram bot | display name "ניהול המלאי של אסקפה"; group privacy **disabled** |

**Commands:**
| Purpose | Command |
|---|---|
| Install | `npm ci` |
| Typecheck | `npm run build` (`tsc --noEmit`; bundling happens in synth) |
| Test | `npm test` |
| Synth | `npx cdk synth` |
| Diff | `npm run diff` |
| Deploy | `npm run deploy` (diff then deploy, `--profile homestock`) |
| Webhook (once) | `AWS_PROFILE=homestock npm run webhook` |
| SSO login | `aws sso login --profile homestock` |
| Seed registry | `AWS_PROFILE=homestock npm run seed` (reads git-ignored `seed/registry.local.json`; `-- --dry-run`) |
| Lint | none configured |

**Where work happens:** code is written and verified in the cloud workspace, pushed to
GitHub (`ItzikAscapa23/HomeStock`, `main`); the user pulls into
`/Users/itzhak/myProjects/homeStock` and deploys from there. Deploys need AWS creds,
which exist only on the user's Mac.

**Key directories:**
- `infra/` — CDK app (`bin/app.ts`) and `homestock-stack.ts`
- `src/handlers/` — Lambda entry points, thin. `ingress.ts` wires SDK clients directly and never touches the container.
- `src/ingress/webhook.ts` — ingress logic (secret, dedupe, dispatch) with injected deps
- `src/container.ts` — composition root, cached per container
- `src/dispatcher/` — routes inbound events (report / command / button) to services, returns domain `Reply`s; chat allowlist
- `src/registry/` — normalisation, local alias match, LLM resolver, item registry cache, seed planning
- `src/llm/` — provider-agnostic `LlmClient`, Anthropic + OpenAI adapters, task routing
- `src/shopping/` — reporting out, `/list` formatting
- `seed/` — `registry.example.json` (committed, also the test registry); `*.local.json` git-ignored
- `test/fixtures/hebrew-reports.json` — Hebrew message → item fixtures; add every real misresolution here
- `src/telegram/` — Bot API client (`fetch`) and update → domain parsing
- `src/domain/` — domain types shared across modules (`InboundMessage`)
- `src/persistence/` — DynamoDB access; `keys.ts` is the only place PK/SK strings exist
- `src/config/params.ts` — SSM parameter names + cached reader
- `scripts/set-webhook.ts` — one-time webhook registration, not part of deploy
- `test/` — vitest unit tests, fakes only
- `README.md` — end-user setup guide (AWS, Telegram, deploy). Keep it in step with reality.

**Conventions:** as CLAUDE.md. Relative imports carry `.js` extensions (NodeNext).
Commits: `phase(N): <what>` (CLAUDE.md wins over the handover skill's default format).

---

## Status

- **Current phase:** 1.6 — Stock-in by text, item merge, stock questions (amendment, see Decisions)
- **State:** `in-progress` — built and verified in the workspace; deploy + live check pending
- **Phase 1:** `complete` — review gate (two weeks of family use) still applies to the predictive phases (2's interval learning, 3)
- **Last updated:** 2026-10-31

---

## Current phase progress

*Phase 1.6 (user-requested amendment, 2026-11-06, during the review window):*
- [x] Intent per message: out / in (bought) / query — local wording first (`detectIntent`), LLM decides only when it's consulted anyway
- [x] "קניתי חלב" → `Purchase` (source `manual`) + off the list; unknown items asked once, confirming records a purchase (R3)
- [x] "יש לנו ביצים?" → one line from ground truth only (list / last bought / last reported out / no data) (R27, partial — no prediction)
- [x] `/same A = B` → alias if A isn't an item; confirm-tap merge if it is (aliases, codes, purchases, list row; A deleted) (R21)
- [x] Live: `/same` merges done by the user (גרעיני חמניה קלויים → שחורים, אפיפית שוקולד → וופלים ללא גלוטן) — worked, but the target had to be typed exactly (two misses)
- [x] `/same` "did you mean": a non-exact target offers up to 3 items as buttons; the tap is the confirmation (label shows 🔀 merge or = alias)
- [ ] Deploy + live check: "קניתי חלב", "יש לנו ביצים?", a paper-receipt photo, `/same X = <partial name>`

*Phase 2 — Stock in and interval learning. **Not started — blocked by the phase 1 review gate.** Items already delivered by phase 1.5 are marked; the rest is the remaining scope.*

- [x] Resolve Q3 (brand vs generic) — decided in phase 1.5 (variant-level, generic word → usual variant)
- [ ] Resolve Q1 (cold start: seeded category defaults vs longer initial review) with the user
- [x] `Purchase` records — built in phase 1.5 (source `receipt`; `list-confirm` / `manual` not yet written)
- [ ] Post-shopping confirmation flow (R3) from the open list — partly covered: receipts already clear bought items
- [x] Receipt ingestion (R1, R2) — phase 1.5
- [ ] Interval learning (R7): rolling days-between-purchases; depletion score = days since purchase / interval
- [ ] `staple` / `non-cyclic` flags (R8, R9) excluded from or damped in scoring
- [ ] Backfill intervals from purchase history already present (receipts recorded since 2026-10-31, incl. an April receipt)

---

## Verification

Phase 1.5, 2026-10-31 (cloud workspace). Phase 1's live results remain valid (phase log).

| Command / check | Result |
|---|---|
| `npm run build` | passed (exit 0) |
| `npm test` | passed — 9 files, 144 tests (phase 1.6: intent, stock-in, stock questions, /same merge) (receipt flow on synthetic Shufersal / Super-Pharm / Osher Ad layouts; Q3 variant fixtures) |
| `npx cdk synth` | passed. No VpcConfig. Worker 180 s / 1024 MB, env adds `BUCKET_NAME`; worker bundle 45.8 kb, ingress 3.7 kb |
| Live receipt #1 (Shufersal PDF) | first try **failed** (`Anthropic 400: tool_choice … not supported`, Sonnet 5.5) → fixed (`output_config.format`) → **passed**: 31 new items added in one tap, 4 ambiguous lines answered |
| Live receipt #2 (Super-Pharm, file saved without `.pdf`) | first try **silent** (declared `application/octet-stream`) → fixed (bytes sniffed) → **passed**: 4 products (3 body-cream lines merged), 2 matched, 2 new. User feedback: summary hid matched names and all quantities → summary now names every product with ×qty / kg |
| Live receipt #3 (Osher Ad, broken text layer) | **passed**: 46 products → 23 matched, 17 new (one tap), 6 asked; kg produce, ×N quantities, page-split description joined, no promo lines leaked |
| Bug found live | receipts cleared list entries regardless of date (29/10 receipt cleared milk reported 31/10). Fixed + deployed; milk re-reported; re-sending the receipt no longer touches it — **passed** |
| Duplicate re-send | **passed** — "הקבלה הזו כבר נקלטה ✓" |
| `npm run deploy` / live receipt | not run — needs the user's Mac |

---

## Decisions

- **Dedupe = DynamoDB conditional put** on `UPDATE#<id>` with a 7-day TTL — atomic, no extra service. R26
- **On worker-invoke failure, ingress releases the dedupe claim and returns 500** so Telegram's retry is processed. Bad secret → 401; malformed body → 200 (a retry can't fix it).
- **Worker async `retryAttempts: 0`** — a retry after a successful `sendMessage` would double-reply. Cost: a transient Telegram failure drops that reply. Revisit in phase 1 by making processing idempotent on `update_id`.
- **Explicit `LogGroup` per function instead of `logRetention`** — `logRetention` adds a custom-resource Lambda with its own un-retained log group.
- **Secrets read from SSM at runtime, cached per container** — CloudFormation can't inject SecureString into Lambda env. Default `aws/ssm` key, no KMS cost.
- **Fixed table name `homestock`, bucket `homestock-receipts-<account>`** — names known before deploy; single env (C6).
- **DynamoDB PITR enabled** — usage-priced (pennies), protects purchase history.
- **arm64 + ESM bundles**; **raw `fetch` Telegram client** — cold start and bundle size.
- **`src/dispatcher/` and `src/domain/`** added beyond CLAUDE.md's layout — homes for reply logic and shared domain types.
- **Region `eu-central-1`** — close to Israel, full service set incl. Bedrock if chosen for Q4. `il-central-1` rejected for thinner service/model availability.
- **IAM Identity Center, Single-Region instance (AWS-owned key)** — Multi-Region default creates a customer-managed KMS key, a fixed ~$1+/month charge.
- **Each household self-hosts its own copy** in its own AWS account (user wants friends to be able to reuse the project). Compatible with N1 — no multi-tenancy. Consequence: **household-specific data (seed registry, R20 household context) must never be committed** — keep it in a git-ignored local file or enter it through the bot. Repo stays public.
- **Phase 1: dedicated shopping group (user decision).** Every non-command message is a report candidate; no separate intent classifier. Chatter is filtered by the same LLM call (`isReport: false` → silence).
- **Chat allowlist in SSM** (`/homestock/telegram/allowed-chat-ids`, plain String, comma-separated). Bots are publicly reachable and LLM calls cost money; unknown chats get silence. `/chatid` answers anywhere so a household can find its ids. Kept out of git (household-specific), cached 5 min.
- **Resolution = local first, whole message to the LLM otherwise.** Normalisation (niqqud, punctuation, digits, filler lexicon, fused-prefix stripping on a phrase's first word) only produces candidate phrases; longest alias wins. If any content word is left unexplained, the *whole* message goes to the LLM — no partial guessing.
- **Confident LLM matches are learned as aliases without a confirm tap.** A tap per new phrasing would hurt adoption (C7). Risk: a wrong high-confidence match becomes a wrong alias. No undo yet — fix by editing the item (seed file) until an undo exists. Low-confidence/unknown → buttons.
- **One-tap questions are `PendingAsk` rows** (TTL 3 days); `take()` is an atomic delete, so double taps and stale buttons are harmless. Callback data `a:<askId>:<choice>`.
- **Registry and open list are single partitions** (`REGISTRY`, `LIST#OPEN`), read whole; registry cached 60 s per container. One open list row per item → re-reports don't duplicate.
- **Message log** `MSG#<yyyy-mm>` / `<iso>#<updateId>`: raw written before processing, `parsed` after (incl. path local/llm and model). On error the user gets one line and the log keeps the raw text.
- **Seed data out of git:** `seed/registry.local.json` is git-ignored; `seed/registry.example.json` (generic Israeli household, 68 items) is committed and is also the test registry. Re-seeding merges and never drops learned aliases; alias collisions abort the seed.
- **`/list` is plain text** (no `parse_mode`) — nothing to escape in item names. Multi-line is fine for an explicit command; report replies stay one line (R25).
- **Phase 1.5 amendment — receipts now (user decision, 2026-10-31).** Receipts don't need the two-week data the predictive phases need; they *create* purchase history and clear bought items from the list. Recipes stay after phase 3 (value comes from meal planning, which needs scores).
- **Q3 — brand vs generic (user decision):** items are **variant-level** — "חלב 3%", "חלב 1% טרה", "חלב סויה" are separate items. A **generic word maps to the household's usual variant** via an alias (user: bare "חלב" → "חלב 3%"), so "נגמר החלב" stays zero-tap; naming a variant hits it (longest alias wins). The receipt resolver is told to treat a different brand/fat %/type as a different item.
- **Receipts: whole file goes to the model (user decision).** The PDF/photo includes name, phone, address; sent to the routed provider as-is. Stored privately in the receipts bucket. Never committed, never logged in full.
- **Receipts are sent in the private chat with the bot (user decision).** Files/photos in the group are ignored — family photos aren't receipts and receipt summaries are noisy (R25).
- **New products from a receipt are confirmed in bulk (user decision):** one summary with "✓ add all new"; separate one-tap questions only for genuinely ambiguous lines. Satisfies R2's "surfaced, never silently dropped" without 25 messages.
- **Receipt lines are merged before matching** — same code (or, without a code, same description) and same unit → one line, quantities summed. Real receipts print one product on several lines (Super-Pharm: one line per unit; Osher Ad: one per promo pair); unmerged, "add all" would create duplicate items.
- **Receipt layouts checked so far** (user-supplied samples, never committed): Shufersal Online delivery note (4 pp., ordered vs supplied, negative promo lines, substitutions); Osher Ad via Pairzon (narrow thermal, **broken PDF text layer** — only the rendered page is readable, descriptions wrap across pages, price-less promo lines, kg produce, short internal codes); Super-Pharm tax invoice (one line per unit, card-payment line). The broken text layer is why the file goes to the model rather than text extraction.
- **Anthropic structured output = `output_config.format` (json_schema), not a forced tool call.** First live receipt failed: Sonnet 5.5 returns 400 for `tool_choice: tool/any` (migration guide, "forced tool use"). Native JSON-schema output works on Haiku 5.5 and Sonnet 5.5; JSON comes back in the text block (after any thinking block). `max_tokens` raised (receipt 16k, lines 8k, resolve 2k) because adaptive thinking spends from the same budget; truncation/refusal now fail loudly. Schemas stay within the documented limits (no min/max, ≤16 anyOf/type-array params).
- **Phase 1.6 amendment (user, 2026-11-06):** stock-in by text, item merge and stock questions added during the review window. Small, and the first fixes a real bug: "קניתי חלב" used to be read as a depletion report. Caveat for the review: three new interactions muddy the "is phase 1 used" signal slightly.
- **Intent is decided by wording first** (`src/registry/normalise.ts` `detectIntent`): "?" or opening יש/האם → query; past-tense bought/arrived words (קניתי, הבאנו, נכנס…) → in; else out. "קנו"/"קנה" excluded (also imperative "buy!"). The LLM returns an intent too and decides only when wording is not explicit. Intent words are stripped like fillers, so "קניתי חלב" resolves locally.
- **Stock questions answer from ground truth only** until phase 2: on the list (reported date), last bought (and "not reported out since"), last reported out, or "no data". Never "we have it". Questions change no state and never ask back; unknown products → "לא מכיר: X".
- **`/same A = B`** keeps B. If A names no item exactly, it becomes an alias of B (no confirm). If A is an item, one confirm tap merges it into B: name/aliases/codes move, later `lastOutAt` kept, purchases re-keyed, list row moved, A deleted. Household-level Q3 exception (user: "קוטג׳ 9%" = "קוטג׳"). **If you merge away a seeded item, remove it from `seed/registry.local.json`** — re-seeding would recreate it and abort on the alias collision.
- **`/same` suggestions** (`ItemRegistry.search`): items whose name/alias contains every typed word; the word as typed first, prefix-stripped forms (≥ 3 letters) only if nothing matched — "פל" matched פלפלים. Suggestions only; never used for message resolution. Only the target (after `=`) gets suggestions; a non-exact left side becomes an alias, not a merge.
- **Manual purchases are recorded as quantity 1** (no quantity parsing from text yet).
- **A receipt only clears list entries reported on or before its purchase day** (household-local date). A depletion report is ground truth (R5); a receipt from before it must not undo it. Purchases are still recorded regardless of date.
- **The receipt summary names every product with its quantity** (×N for several units, kg for weighed) — a count alone ("✓ 2 recorded") couldn't be checked and wasn't trusted. Long receipts are clipped at Telegram's message limit.
- **Receipt file type is sniffed from content** (`%PDF-`, JPEG/PNG/WebP magic bytes), never trusted from Telegram's MIME label or the file name. Any document in the private chat is a receipt candidate; anything unreadable or > 10 MB gets one line ("PDF or photo, up to 10MB") instead of silence.
- **Item codes / barcodes are stored on items** (`codes`) and are the first resolution step for receipt lines — exact, language-free, local (R22).
- **Q4 — LLM layer (user decision, 2026-10-31):** one domain interface in `src/llm/` (`complete<T>({ task, system, user, schema })` → typed JSON); callers name a *task*, never a model. **Two provider adapters from the start: Anthropic and OpenAI.** A routing config maps task → `{ provider, model }`, passed to the worker as an env var from CDK context — switching provider/model is a config change + deploy. Keys in SSM: `/homestock/llm/anthropic-api-key`, `/homestock/llm/openai-api-key`. No LangChain / Vercel AI SDK: bundle size, and they hide structured output, prompt caching and vision. A Hebrew fixture set (real messages → expected item) gates any routing change.

---

## Assumptions

- `setWebhook` subscribes to `message` and `callback_query` only.
- `resolve-item` default model `claude-haiku-5-5`; OpenAI alternative `gpt-5.4-mini` (used in tests/docs). Override with `npx cdk deploy -c llmRouting='{"resolve-item":{"provider":"openai","model":"…"}}'`.
- An unknown item with no LLM proposal is offered as a new item in category `household`.
- Live group is a basic group (id `-55…`, no `-100` prefix). If Telegram converts it to a supergroup the id changes and the bot goes silent until the allowlist is updated (README troubleshooting).
- Receipt extraction uses `claude-sonnet-5-5` (multi-page bidi Hebrew); line matching `claude-haiku-5-5`. Rough cost per 4-page receipt: a few cents. Override per task via `llmRouting`.
- Worker memory raised to 1024 MB and timeout to 180 s for receipts. Usage-priced; ordinary messages still finish in ~1 s.
- Receipt originals are kept in S3 (`receipts/<yyyy-mm>/<fileUniqueId>.<ext>`) with no lifecycle rule; at a few hundred KB each this is cents per year. Revisit if photos pile up.
- Duplicate detection uses Telegram's `file_unique_id`: the same file re-sent is caught; a re-scan/re-download of the same receipt as a *different* file is not.
- Member attribution (R24) is the Telegram user id + first name stored on list rows and in the message log; no separate member table yet.
- The user's Mac exports `AWS_CA_BUNDLE` (a corporate root CA) for other work; HomeStock commands are run after `unset AWS_CA_BUNDLE` in that terminal. Nothing in the repo depends on this.

---

## Open questions / blockers

- **Partial reports (R6) before phase 3.** "נשאר מעט חלב" / "כמעט נגמר" currently lists the item as `out`, because R6's weaker signal is phase 3 work. Not a PRD contradiction (R6 is scheduled later) but a known gap — the user should know the bot treats "almost out" as out for now.
- **Receipt links** (e.g. Super-Pharm's weezmo.com digital-receipt URL arriving by SMS) aren't supported — the user must download and send the file. Proposed: fetch https links to known receipt hosts in the private chat. Not built; user's call.
- **No undo for a wrong learned alias or item code** — see Decisions. Revisit if it happens in practice.
- **Receipt purchases ≠ interval learning yet.** Purchases are recorded from now on; using them (R7) is phase 2, still behind the review gate.
- **Worker `retryAttempts: 0`** still stands; processing is not yet idempotent per `update_id` (ingress dedupe covers Telegram retries).

- **Recipes (user decision, 2026-10-31): wait for the two-week review, then decide.** Phase 4 (recipe bank) is independent of usage data and could be built as an opt-in amendment; phase 5 (meal planning) needs phase 2 scores and Q2. Before phase 4: decide where household context (R20) lives (bot command vs local file — never git) and whether recipes run in the private chat or the group.
- **Proposed, not approved (user: "not yet", 2026-10-31):**
  - *List clearing before the review gate* — the list only grows; a minimal R3 `/bought` (tap what you didn't get, rest cleared and recorded as purchases) would keep the list trustworthy during the two-week test. Plan change — user's call.
  - *Usual quantity per item* — `qty` in the seed shown on `/list` ("חלב ×3 ליטר"), plus an optional number in a report overriding it. Never ask at report time (C7); no stock counting (N5). Later learnable from purchases (phase 2).

---

## PRD conflicts

- None.

---

## Phase log

| Phase | Title | Commit | Date |
|---|---|---|---|
| 0 | Groundwork and plumbing | `ae4e27d` | 2026-10-31 |
| 1 | Depletion reports and the shopping list | `7cfa92f` | 2026-10-31 |
| 1.5 | Receipt ingestion (amendment) | `b77e77c` … `1353beb`, closing commit `phase(1.5): close` | 2026-10-31 |

---

## Next phase entry conditions

Phase 2 starts only when (plan.md review gate — **if the family isn't using it, stop and diagnose adoption instead**):
- The family has used the bot for at least two weeks — earliest **2026-11-14**
- At least 20 real depletion reports in the table. Count with:
  `aws dynamodb query --profile homestock --table-name homestock --key-condition-expression "PK = :pk" --expression-attribute-values '{":pk":{"S":"MSG#2026-11"}}' --query "length(Items[?parsed.M.intent.S=='out' || parsed.M.intent.S=='report'])"`
  (repeat per month; `MSG#2026-10` holds the setup-day tests; since phase 1.6 reports log as `out`, bought as `in`, questions as `query`)
- Plan.md's own phase 2 exit needs ≥15 items with a learned interval — receipts are the fastest way there; keep sending them
- Review the message log for misresolutions; add each to `test/fixtures/hebrew-reports.json`
