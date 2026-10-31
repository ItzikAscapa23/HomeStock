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
| SSM (manual, SecureString) | `/homestock/telegram/bot-token`, `/homestock/telegram/webhook-secret` |
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
- `src/dispatcher/` — decides the reply to an inbound message; phase 1 intent routing grows here
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

- **Current phase:** 0 — Groundwork and plumbing
- **State:** `complete`
- **Last updated:** 2026-10-31

---

## Current phase progress

*Phase 1 — Depletion reports and the shopping list. Not started.*

- [ ] Data model for `Item` (canonical name, category, aliases, flags) and `ListEntry` (item, reason, created_at, resolved_at)
- [ ] Seed the registry with ~50 items the household actually buys
- [ ] Exact-alias resolver: normalise Hebrew prefixes and whitespace, match locally, no LLM call (R22)
- [ ] LLM fallback resolver: full registry + message → canonical match or `unknown`
- [ ] Unknown item flow: "add as new item?" one-tap confirm; confirming writes the alias back
- [ ] Depletion report handler: resolve → mark out → add to list → one-line reply
- [ ] `/list` — grouped by category, each line annotated with its reason
- [ ] Persist every inbound message raw alongside its parsed result (R23)

---

## Verification

Phase 0, 2026-10-31.

| Command / check | Result |
|---|---|
| `npm ci` | passed (cloud workspace and user's Mac) |
| `npm run build` | passed |
| `npm test` | passed — 3 files, 10 tests |
| `npx cdk synth` | passed. 2 Lambdas without VpcConfig; 2 log groups at 7 d; table + bucket `DeletionPolicy: Retain`; no custom resources |
| `npm run deploy` (user's Mac) | passed — stack created in 75 s |
| `npm run webhook` | passed — `pending_update_count: 0`, no `last_error_message` |
| Live: private chat `/start` → `pong` | passed |
| Same `update_id` twice → one reply | passed in unit tests (`webhook.test.ts`, `dedupe-store.test.ts`); not replayed live |

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
- **Q4 — LLM layer (user decision, 2026-10-31):** one domain interface in `src/llm/` (`complete<T>({ task, system, user, schema })` → typed JSON); callers name a *task*, never a model. **Two provider adapters from the start: Anthropic and OpenAI.** A routing config maps task → `{ provider, model }`, passed to the worker as an env var from CDK context — switching provider/model is a config change + deploy. Keys in SSM: `/homestock/llm/anthropic-api-key`, `/homestock/llm/openai-api-key`. No LangChain / Vercel AI SDK: bundle size, and they hide structured output, prompt caching and vision. A Hebrew fixture set (real messages → expected item) gates any routing change.

---

## Assumptions

- `setWebhook` subscribes to `message` and `callback_query` only.
- The user's Mac exports `AWS_CA_BUNDLE` (a corporate root CA) for other work; HomeStock commands are run after `unset AWS_CA_BUNDLE` in that terminal. Nothing in the repo depends on this.

---

## Open questions / blockers

- **LLM API keys** — user to create Anthropic and OpenAI keys and store both in SSM (paths above). Blocks the phase 1 LLM fallback resolver only.
- **Which models per task** — pick at phase 1 build time from current model lists; default to the small/fast tier for `resolve-item`.
- **Tighten Ingress IAM** — it has `grantReadWriteData` on the table but needs only `PutItem`/`DeleteItem` for dedupe. Low risk; fix in phase 1.

---

## PRD conflicts

- None.

---

## Phase log

| Phase | Title | Commit | Date |
|---|---|---|---|
| 0 | Groundwork and plumbing | `d405e0c` (code), closing commit `phase(0): close` | 2026-10-31 |

---

## Next phase entry conditions

- Bot replies to a live message — ✔ (`pong`, 2026-10-31)
- Table and bucket names readable from this file — ✔
- Q4 decided — ✔ (see Decisions)
- Anthropic and OpenAI API keys stored in SSM — **open**
