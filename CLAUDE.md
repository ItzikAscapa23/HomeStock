# CLAUDE.md — HomeStock

Telegram bot for household inventory and supermarket shopping. Single family, personal
project. See `PRD.md` for requirements (R1–R28) and `plan.md` for phases.

**Spec files are read-only.** All state goes in `HANDOVER.md`. Cite requirements by
number (`R7`), not paraphrase. If the code needs something the PRD forbids, stop and
surface the conflict — don't resolve it silently.

---

## Stack

- **TypeScript** (strict), Node.js 22
- **No framework.** Plain modules, explicit constructor injection, one composition root
- **AWS CDK v2** — infrastructure, in `infra/`
- **DynamoDB** single table, on-demand
- **esbuild** via `NodejsFunction` — no Docker in the build

### Why no framework — don't reintroduce one

Nest and Express were both considered and rejected. There is no HTTP API: Telegram is
the only interface, and the webhook receives exactly one payload shape. A framework
here costs cold-start time and bundle size for DI and routing this project doesn't need.

So:

- **No Nest, no Express, no serverless-express, no decorators, no `reflect-metadata`.**
- **No controllers, no routes.** The Lambda handler *is* the entry point.
- Wiring happens in **one composition root** (`src/container.ts`) that constructs
  services and returns them. Module-level cached, so it's built once per container.
- Services take their dependencies as **constructor arguments**, typed against
  interfaces. That's the whole DI story and it's enough.

```ts
// src/container.ts
let container: Container | undefined;

export function getContainer(): Container {
  if (container) return container;
  const db = new DynamoClient(process.env.TABLE_NAME!);
  const llm = new LlmClient(process.env.LLM_KEY!);
  const registry = new ItemRegistry(db, llm);
  // ...
  return (container = { registry, inventory, shopping, telegram });
}
```

If manual wiring ever becomes unmanageable, adding a framework later is mechanical.
It isn't at eight modules.

---

## Layout

```
infra/              CDK app — stack, constructs, bin entry
src/
  container.ts      Composition root. The only place services are constructed.
  handlers/         Lambda entry points. Thin — resolve from container, call, reply.
    ingress.ts        verify token, dedupe, async-invoke worker, return 200
    worker.ts         the actual processing
    review.ts         scheduled weekly review
  telegram/         Bot API client, update parsing, reply formatting
  registry/         Canonical items, aliases, resolution (R21, R22)
  inventory/        Stock state, purchases, interval learning, scoring (R7–R9)
  shopping/         List generation (R12)
  recipes/          Recipe bank, generation, provenance (R14–R18)
  meals/            Meal plan parsing, ingredient union (R13, R19)
  llm/              Model routing, prompt assembly, caching
  persistence/      DynamoDB access. Single-table keys live here and nowhere else.
  household/        Household context record (R20)
test/
scripts/
  set-webhook.ts    One-time webhook registration. NOT part of deploy.
```

Directories depend on `persistence` and `llm`; they don't depend on each other except
through explicitly exported services, wired in `container.ts`.

**Ingress stays minimal.** Telegram retries if the webhook is slow, so that handler
verifies the secret token, dedupes on `update_id`, async-invokes the worker and returns
200. It should not pull in the container or the LLM client at all.

---

## Commands

```bash
npm ci                                  # install
npm run build                           # tsc + esbuild bundles
npm test                                # unit tests
npm run diff                            # cdk diff  — always before deploy
npm run deploy                          # cdk diff && cdk deploy --profile homestock
npm run webhook                         # scripts/set-webhook.ts, run manually once
```

Deploy is from the laptop. There is no CI/CD and no dev/prod split.

---

## Hard constraints — flag before violating

- **No VPC on any Lambda.** NAT Gateway is $32/month against a ~$3/month target bill.
- **No vector database, no embeddings.** The registry is 200–400 items and fits in a
  prompt. Below ~1000 items this is settled.
- **No RAG over structured data.** Purchase history, stock and intervals are DynamoDB
  queries. Retrieval is for recipes and household knowledge only.
- **SSM Parameter Store** (standard tier, free) for secrets — not Secrets Manager.
- **CloudWatch log retention: 7 days**, set explicitly on every log group.
- **`removalPolicy: RETAIN`** on the table and bucket. A typo'd construct ID must not
  be able to delete the household's purchase history.
- Keep bundles small — it's the main lever on cold start. Prefer `@aws-sdk/client-*`
  sub-packages, no barrel imports of large libraries.
- Anything that adds a **fixed monthly charge** gets raised with the user first.

---

## Domain rules that are easy to get wrong

**Hebrew input is not regex-parseable.** Messages are unvocalised, with fused prefixes
(חלב / החלב / בחלב / והחלב), spelling variation, and ambiguous shorthand (סבון — dishes,
hands or laundry?). Resolution order is: normalise → exact alias match locally → LLM
fallback with the full registry in the prompt → ask the user. Every user confirmation
writes the alias back (R21, R22).

**Never call the LLM when a local alias match exists.** Over time most messages should
take the local path. A resolver that always calls the model is a bug, not a slow path.

**Store raw messages alongside parsed results** (R23). When resolution is wrong in month
three, the original text is the only way to diagnose it.

**Stock is probabilistic, not counted.** Depletion scores, not quantities. The
exceptions are a small set of countable recipe-critical items (eggs, onions, tomatoes);
everything else stays a score. Don't introduce general quantity tracking.

**Ground truth beats prediction, always.** A depletion report or a review answer
overrides the score and resets the cycle.

**Bot replies are one line.** This lives in a family group chat; noise is an adoption
risk, and adoption is the binding constraint on the whole project.

**The household is the entity, not the user.** `telegram_user_id` maps to a member for
attribution only. Everyone has the same rights.

---

## Conventions

- Business logic in services, never in handlers.
- Services are constructed only in `container.ts`. No `new` of a service elsewhere, and
  no singletons reaching for globals.
- DynamoDB key construction is confined to `persistence/`. No PK/SK strings elsewhere.
- Telegram API shapes do not leak past `telegram/` — map to domain types at the edge.
- Hebrew strings in code are user-facing copy; keep them in one place per module, not
  scattered through logic.
- Tests: unit tests on resolution, scoring and interval learning — that's where the
  bugs will be. Services take interfaces, so fakes are enough; no mocking framework.
  Don't unit-test CDK constructs; `cdk synth` is the check.
- Commit format: `phase(N): <what>` for phase work, conventional commits otherwise.
