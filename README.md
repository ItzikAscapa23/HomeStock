# HomeStock

A Telegram bot that keeps track of what's at home, so the weekly supermarket list stops
being guesswork. Family members report "נגמר חלב" in a group chat; the bot builds the
shopping list, learns how often things run out, and asks about the few items it isn't
sure of.

Each household runs its **own copy** in its **own AWS account**. There is no shared
server and no sign-up — you deploy it, you own the data.

> **Status:** early development. Phase 1 — report what ran out, get a shopping list —
> is built; its live test in a family group is pending. See `plan.md` for the roadmap
> and `HANDOVER.md` for current state.

**Cost:** designed to stay under ~$5/month (typically ~$1–3). Everything is
pay-per-use; nothing is billed by the hour. LLM usage (from phase 1) is billed separately
by your model provider.

---

## What you need

- A Mac or Linux machine with **Node.js 22+** and **git**
- **AWS CLI v2** (`aws --version`) — install from
  [AWS](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- An **AWS account** you control (a personal one — not your employer's)
- **Telegram** on your phone

---

## 1. Get the code

```bash
git clone https://github.com/ItzikAscapa23/HomeStock.git homestock
cd homestock
npm ci
```

`npm audit` reports a moderate `minimatch` advisory inside `aws-cdk-lib`. It only runs
on your machine at deploy time and isn't exploitable here. Don't run
`npm audit fix --force`.

---

## 2. Set up AWS (once)

The commands below assume region **`eu-central-1`** (Frankfurt). Any region works; use
the same one everywhere.

### 2.1 Account basics
1. Sign in as the root user and turn on **MFA** for it. Don't use root again after this.
2. **Billing and Cost Management → Budgets → Create budget → Monthly cost budget**,
   amount **$5**, your email. You'll be warned before anything gets expensive.
   - New accounts may be offered a *Free plan*. Pick the **Paid plan** — Free-plan
     accounts are closed after 6 months, taking your data with them. You still get the
     free credits.

### 2.2 A login for the command line (IAM Identity Center)
This gives you short-lived CLI logins instead of a permanent access key on your laptop.

1. Open **IAM Identity Center** with the region set to Frankfurt:
   <https://eu-central-1.console.aws.amazon.com/singlesignon/home?region=eu-central-1>
2. **Enable** → **Enable with AWS Organizations** → choose **Single-Region instance**.
   - Not *Multi-Region*: that creates a customer-managed KMS key (~$1+/month, fixed).
     Single-Region shows *Encryption: AWS owned key* (free).
3. **Users → Add user.** Type names with an **English keyboard layout** — Hebrew
   layout can insert an invisible character and the form fails with *"unsupported
   unicode format character"*. Skip groups.
4. Accept the email invite, set a password, register MFA.
5. **Multi-account permissions → Permission sets → Create → Predefined →
   AdministratorAccess**, session duration 8 hours.
6. **Multi-account permissions → AWS accounts** → tick your account → **Assign users
   or groups** → your user → **AdministratorAccess** → Submit.
   - The region selector shows *Global* on this page — that's normal.
7. Copy the **AWS access portal URL** from the Identity Center dashboard — the
   *IPv4-only* one, `https://d-xxxxxxxxxx.awsapps.com/start`.

### 2.3 Connect your terminal
```bash
aws configure sso --profile homestock
```
| Prompt | Answer |
|---|---|
| SSO session name | `homestock` |
| SSO start URL | the portal URL from 2.2 step 7 |
| SSO region | `eu-central-1` |
| SSO registration scopes | press Enter |
| *(browser opens)* | sign in, click **Allow** |
| CLI default client Region | `eu-central-1` |
| CLI default output format | `json` |

Check it:
```bash
aws sts get-caller-identity --profile homestock
```
You should see your account ID and an ARN containing `AWSReservedSSO_AdministratorAccess`.

When the login expires later: `aws sso login --profile homestock`.

> The profile **must** be named `homestock` — the npm scripts use that name.

---

## 3. Create the Telegram bot

In Telegram, open **@BotFather** (blue checkmark) and create a new bot (`/newbot`, or
the *New bot* form):

- **Name** — what people see, e.g. `המלאי של הבית`.
- **Username** — unique, must end in `bot`.
- Copy the **token** it gives you. Treat it like a password — anyone with it controls
  the bot. Don't paste it into chats or commit it.

Then **turn group privacy off**: `/setprivacy` → pick the bot → **Disable** (or *Bot
Settings → Group Privacy* in the app). Without this, the bot only sees `/commands` in a
group and never sees "נגמר חלב".

### Store the secrets in AWS (SSM Parameter Store)

Free, encrypted, and the Lambdas read them at runtime — the token never touches the code
or the repo.

```bash
read -s BOT_TOKEN   # paste the token, press Enter (nothing is echoed)
aws ssm put-parameter --profile homestock --type SecureString \
  --name /homestock/telegram/bot-token --value "$BOT_TOKEN"
unset BOT_TOKEN

aws ssm put-parameter --profile homestock --type SecureString \
  --name /homestock/telegram/webhook-secret --value "$(openssl rand -hex 32)"
```
Each prints `"Version": 1, "Tier": "Standard"`.

---

## 4. Deploy

```bash
npx cdk bootstrap --profile homestock   # once per account + region
npm run deploy                          # shows the diff, asks y/n — answer y
```
The first deploy takes ~2–4 minutes and ends with:
```
HomeStock.BucketName = homestock-receipts-<your-account-id>
HomeStock.TableName  = homestock
HomeStock.WebhookUrl = https://<id>.execute-api.eu-central-1.amazonaws.com/telegram
```

Point Telegram at it (once — not part of deploy):
```bash
AWS_PROFILE=homestock npm run webhook
```
It prints `Webhook set: …` and Telegram's webhook info with `"pending_update_count": 0`.

---

## 5. Connect your household

### 5.1 LLM keys
Unknown or ambiguous items are resolved by an LLM (Anthropic by default; OpenAI also
supported). Create an API key at console.anthropic.com (and/or platform.openai.com),
set a low monthly spend limit there, then:
```bash
read -s KEY && aws ssm put-parameter --profile homestock --type SecureString \
  --name /homestock/llm/anthropic-api-key --value "$KEY"; unset KEY

read -s KEY && aws ssm put-parameter --profile homestock --type SecureString \
  --name /homestock/llm/openai-api-key --value "$KEY"; unset KEY
```
Paste the key when the cursor waits — nothing is shown. Keep `"$KEY"` as written.

To use OpenAI instead of Anthropic, deploy with
`npx cdk deploy --profile homestock -c llmRouting='{"resolve-item":{"provider":"openai","model":"gpt-5.4-mini"}}'`.

### 5.2 Your item list
The bot matches messages against your household's item list first (free and instant)
and only asks the LLM about words it doesn't know.
```bash
cp seed/registry.example.json seed/registry.local.json
# edit seed/registry.local.json: remove what you never buy, add what you do
AWS_PROFILE=homestock npm run seed -- --dry-run
AWS_PROFILE=homestock npm run seed
```
`registry.local.json` is git-ignored — your list never ends up in the repo. Re-running
the seed is safe: it updates items and keeps the aliases the bot has learned.

### 5.3 The family group
1. Create a Telegram group just for shopping (e.g. "קניות"), add the family and the bot.
2. In the group send `/chatid`. Also send `/chatid` in your private chat with the bot.
3. Allow those chats (the bot ignores every other chat):
   ```bash
   aws ssm put-parameter --profile homestock --type String \
     --name /homestock/telegram/allowed-chat-ids --value '-100xxxxxxxxxx,123456789'
   ```
   To change it later add `--overwrite`. Takes effect within 5 minutes.

### Check it works
In the group:
- `נגמר חלב` → `✓ חלב — ברשימה`
- something not on your list, e.g. `נגמרה הקינואה` → buttons → tap **➕ חדש** → next time
  the same words are understood without asking
- `/list` → the shopping list by supermarket section

No reply? Look at the logs:
```bash
aws logs tail /aws/lambda/$(aws lambda list-functions --profile homestock \
  --query "Functions[?starts_with(FunctionName,'HomeStock-Ingress')].FunctionName" \
  --output text) --since 5m --profile homestock
```
(Same for `HomeStock-Worker`.)

---

## 6. Updating and removing

### Updating
```bash
git pull && npm ci && npm run deploy
```
The webhook doesn't need re-registering after a deploy.

### Removing
`npx cdk destroy --profile homestock` removes everything **except** the DynamoDB table
and the S3 bucket — those are kept on purpose so a mistake can't delete your history.
Delete them by hand in the console if you really want them gone.

---

## Troubleshooting

**`SSL validation failed … CERTIFICATE_VERIFY_FAILED`** from the AWS CLI.
Something is overriding the CLI's trusted certificates — often left over from a work
setup. Check:
```bash
env | grep -iE 'ca_bundle|ssl_cert|requests_ca|proxy'; grep -i ca_bundle ~/.aws/config
```
If `AWS_CA_BUNDLE` is set to a corporate certificate, run `unset AWS_CA_BUNDLE` in the
terminal you use for HomeStock (it only affects that window). Don't delete it if your
work setup needs it.

**Region selector is greyed out / locked** in the AWS console. You're on a global
service page (Billing, IAM, Organizations). Open a regional service first, or use a
direct link with `?region=eu-central-1`.

**`Token has expired`** / `The SSO session … has expired` — run
`aws sso login --profile homestock`.

---

## For developers

- `PRD.md` — requirements (R1–R28) and constraints. Read-only.
- `plan.md` — phases 0–6. Read-only.
- `HANDOVER.md` — current state, decisions, what's next.
- `CLAUDE.md` — code conventions and hard constraints.

```bash
npm run build     # typecheck
npm test          # unit tests
npx cdk synth     # synthesize the CloudFormation template
npm run diff      # see what a deploy would change
npm run deploy    # diff + deploy (profile: homestock)
```
