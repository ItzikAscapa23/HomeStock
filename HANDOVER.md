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

**AWS resources (stack `HomeStock`, account/region from the `homestock` profile):**
| Resource | Name |
|---|---|
| DynamoDB table | `homestock` (PK/SK strings, TTL attr `ttl`, on-demand, PITR on, RETAIN) |
| S3 bucket | `homestock-receipts-<account-id>` (private, SSE-S3, RETAIN) |
| HTTP API route | `POST /telegram` → stack output `WebhookUrl` |
| Lambdas | `Ingress` (256 MB, 10 s), `Worker` (512 MB, 60 s, async retries 0) |
| Log groups | one per Lambda, 7-day retention |
| SSM (manual, SecureString) | `/homestock/telegram/bot-token`, `/homestock/telegram/webhook-secret` |

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
| Lint | none configured |

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

**Conventions:** as CLAUDE.md. Relative imports carry `.js` extensions (NodeNext).
Commits: `phase(N): <what>` (CLAUDE.md wins over the handover skill's default format).

---

## Status

- **Current phase:** 0 — Groundwork and plumbing
- **State:** `in-progress` — code done and verified; only the user's AWS/Telegram steps remain
- **Last updated:** 2026-10-31

---

## Current phase progress

- [x] Initialise repo: TypeScript, CDK v2, esbuild via `NodejsFunction`, npm scripts
- [ ] Create the bot with BotFather; store token in SSM — **user step**, see below
- [x] CDK stack: HTTP API, ingress + worker Lambdas, DynamoDB, S3, 7-day log retention
- [x] `removalPolicy: RETAIN` on table and bucket
- [x] Ingress Lambda: secret token, dedupe on `update_id`, 200 fast, async-invoke worker
- [x] Worker Lambda: reply "pong"
- [x] `scripts/set-webhook.ts`
- [x] Record stack, commands, layout, conventions
- [ ] `npm run deploy` succeeds — **user step (laptop)**
- [ ] Live: private-chat message gets "pong" — **user step**
- [ ] Live: same `update_id` twice → one reply — covered by unit test; live check optional

**User steps to finish phase 0** (needs AWS creds — can't run from the cloud workspace):
1. BotFather: `/newbot`; then `/setprivacy` → **Disable** (otherwise the bot sees only commands in groups and phase 1's "נגמר חלב" never arrives).
2. `aws ssm put-parameter --profile homestock --type SecureString --name /homestock/telegram/bot-token --value '<token>'`
3. `aws ssm put-parameter --profile homestock --type SecureString --name /homestock/telegram/webhook-secret --value "$(openssl rand -hex 32)"`
4. `npx cdk bootstrap --profile homestock` (first time per account/region only)
5. `npm ci && npm run deploy`, then `AWS_PROFILE=homestock npm run webhook`
6. Message the bot privately → expect `pong`.

---

## Verification

Run 2026-10-31 in the cloud workspace (no AWS credentials).

| Command | Result |
|---|---|
| `npm ci` | passed (exit 0) |
| `npm run build` | passed (exit 0) |
| `npm test` | passed — 3 files, 10 tests |
| `npx cdk synth` | passed (exit 0). Template checked: 2 Lambdas, no VpcConfig; 2 log groups at 7 d; table + bucket `DeletionPolicy: Retain`; no custom resources |
| `npm run deploy` | not run — no AWS credentials here |
| Live reply / live dedupe | not run — needs deploy |

---

## Decisions

- **Dedupe = DynamoDB conditional put** on `UPDATE#<id>` with a 7-day TTL — atomic, no extra service, cents/month. R26
- **On worker-invoke failure, ingress releases the dedupe claim and returns 500** — so Telegram's retry is processed instead of silently dropped. Bad secret → 401; malformed body → 200 (a retry can't fix it).
- **Worker async `retryAttempts: 0`** — a Lambda retry after a successful `sendMessage` would double-reply. Cost: a transient Telegram failure drops that reply. Revisit when the worker writes state (phase 1) by making processing idempotent on `update_id`.
- **Explicit `LogGroup` per function instead of `logRetention`** — `logRetention` adds a custom-resource Lambda with its own un-retained log group.
- **Secrets read from SSM at runtime, cached per container** — CloudFormation can't inject SecureString into Lambda env. Default `aws/ssm` key, so no KMS cost or policy.
- **Fixed table name `homestock` and bucket `homestock-receipts-<account>`** — so names are known before deploy (phase 1 entry condition) and single-env (C6) makes collisions a non-issue.
- **DynamoDB PITR enabled** — usage-priced (pennies at this size), not a fixed charge; protects purchase history. Turn off if unwanted.
- **arm64 + ESM bundles** — cheaper per ms, smaller cold start.
- **Telegram client is raw `fetch`**, no bot SDK — bundle size.
- **`src/dispatcher/` and `src/domain/`** added (not in CLAUDE.md layout) — needed a home for reply logic and for domain types shared by `telegram/` and services.

---

## Assumptions

- Region is whatever the `homestock` profile sets. If the LLM will be Bedrock, check model availability in that region before phase 1 (affects Q4).
- `setWebhook` subscribes to `message` and `callback_query` only (callbacks needed from phase 1's one-tap confirm).
- Repo `ItzikAscapa23/HomeStock` is **public**. Fine for code; but phase 1's seed registry and R20 household context (allergies, kids) would be public too. Recommend making it private before phase 1.

---

## Open questions / blockers

- User steps above — unblocks phase 0 completion.
- Q4 (model routing / LLM provider) — needed before phase 1's LLM fallback resolver. User decides.

---

## PRD conflicts

- None.

---

## Phase log

| Phase | Title | Commit | Date |
|---|---|---|---|
| 0 | Groundwork and plumbing (code; deploy pending) | see `git log` — `phase(0): …` | 2026-10-31 |

---

## Next phase entry conditions

- Bot replies `pong` to a live message (requires the user steps above)
- Table name `homestock` and bucket `homestock-receipts-<account-id>` — recorded above ✔
- LLM provider chosen (Q4) and its API key stored in SSM
