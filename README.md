# HomeStock

A Telegram bot that keeps track of what's at home, so the weekly supermarket list stops
being guesswork. Family members report "נגמר חלב" in a group chat; the bot builds the
shopping list, learns how often things run out, and asks about the few items it isn't
sure of.

Each household runs its **own copy** in its **own AWS account**. There is no shared
server and no sign-up — you deploy it, you own the data.

> **Status:** early development. Phase 0 (plumbing — the bot replies "pong") is in
> place. See `plan.md` for the roadmap and `HANDOVER.md` for current state.

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

*Section to be completed once this step has been run end to end.*

---

## 4. Deploy

*Section to be completed once this step has been run end to end.*

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
