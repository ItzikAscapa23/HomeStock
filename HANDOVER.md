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

- **Current phase:** 1 — Depletion reports and the shopping list
- **State:** `complete` — **review gate: two weeks of family use before phase 2**
- **Last updated:** 2026-10-31

---

## Current phase progress

*Phase 2 — Stock in and interval learning. **Not started — blocked by the phase 1 review gate** (see entry conditions).*

- [ ] Resolve Q3 (brand vs generic granularity) with the user; record the decision
- [ ] Resolve Q1 (cold start: seeded category defaults vs longer initial review) with the user
- [ ] `Purchase` records: item, quantity, source (`list-confirm` | `receipt` | `manual`), timestamp
- [ ] Post-shopping confirmation flow (R3): open list → bought / not bought → purchases written, list cleared
- [ ] Receipt ingestion (R1, R2): photo/PDF to S3, extraction, resolve each line, unmatched surfaced for one-tap confirm
- [ ] Interval learning (R7): rolling days-between-purchases; depletion score = days since purchase / interval
- [ ] `staple` / `non-cyclic` flags (R8, R9) excluded from or damped in scoring
- [ ] Backfill intervals from purchase history already present

---

## Verification

Phase 1, 2026-10-31.

| Command / check | Result |
|---|---|
| `npm run build` | passed (exit 0) |
| `npm test` | passed — 7 files, 85 tests (22 Hebrew local fixtures, 4 LLM-required, 3 not-a-report, all DoD flows via fakes) |
| `npx cdk synth` | passed. No VpcConfig; Ingress policy = `PutItem`/`DeleteItem` + invoke + webhook-secret. Worker bundle 25.8 kb, Ingress 3.6 kb |
| `npm run seed` (user's Mac) | passed — 68 items from the example list |
| `npm run deploy` (user's Mac) | passed |
| Live, family group: "נגמר החלב" → `✓ חלב — ברשימה` | passed — path `local` |
| Live: "נגמר לנו החלב" → same item (`חלב כבר ברשימה`) | passed — path `local` |
| Live: unknown "נגמרו הגרעינים שחורים" → buttons → ➕ → item created; repeat → `כבר ברשימה` | passed — first `llm`, repeat `local` (message log) |
| Live: `/list` grouped by category with reasons | passed |
| Live: every inbound retrievable raw with its parse (R23) | passed — `MSG#2026-10` query shows text, intent, path |

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
- **Q4 — LLM layer (user decision, 2026-10-31):** one domain interface in `src/llm/` (`complete<T>({ task, system, user, schema })` → typed JSON); callers name a *task*, never a model. **Two provider adapters from the start: Anthropic and OpenAI.** A routing config maps task → `{ provider, model }`, passed to the worker as an env var from CDK context — switching provider/model is a config change + deploy. Keys in SSM: `/homestock/llm/anthropic-api-key`, `/homestock/llm/openai-api-key`. No LangChain / Vercel AI SDK: bundle size, and they hide structured output, prompt caching and vision. A Hebrew fixture set (real messages → expected item) gates any routing change.

---

## Assumptions

- `setWebhook` subscribes to `message` and `callback_query` only.
- `resolve-item` default model `claude-haiku-5-5`; OpenAI alternative `gpt-5.4-mini` (used in tests/docs). Override with `npx cdk deploy -c llmRouting='{"resolve-item":{"provider":"openai","model":"…"}}'`.
- An unknown item with no LLM proposal is offered as a new item in category `household`.
- Live group is a basic group (id `-55…`, no `-100` prefix). If Telegram converts it to a supergroup the id changes and the bot goes silent until the allowlist is updated (README troubleshooting).
- Member attribution (R24) is the Telegram user id + first name stored on list rows and in the message log; no separate member table yet.
- The user's Mac exports `AWS_CA_BUNDLE` (a corporate root CA) for other work; HomeStock commands are run after `unset AWS_CA_BUNDLE` in that terminal. Nothing in the repo depends on this.

---

## Open questions / blockers

- **Partial reports (R6) before phase 3.** "נשאר מעט חלב" / "כמעט נגמר" currently lists the item as `out`, because R6's weaker signal is phase 3 work. Not a PRD contradiction (R6 is scheduled later) but a known gap — the user should know the bot treats "almost out" as out for now.
- **No undo for a wrong learned alias** — see Decisions. Revisit if it happens in practice.
- **Worker `retryAttempts: 0`** still stands; processing is not yet idempotent per `update_id` (ingress dedupe covers Telegram retries).

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
| 1 | Depletion reports and the shopping list | `2062f18` (code), closing commit `phase(1): close` | 2026-10-31 |

---

## Next phase entry conditions

Phase 2 starts only when (plan.md review gate — **if the family isn't using it, stop and diagnose adoption instead**):
- The family has used the bot for at least two weeks — earliest **2026-11-14**
- At least 20 real depletion reports in the table. Count with:
  `aws dynamodb query --profile homestock --table-name homestock --key-condition-expression "PK = :pk" --expression-attribute-values '{":pk":{"S":"MSG#2026-11"}}' --query "length(Items[?parsed.M.intent.S=='report'])"`
  (repeat for each month; `MSG#2026-10` holds the setup-day tests)
- Review the message log for misresolutions; add each to `test/fixtures/hebrew-reports.json`
