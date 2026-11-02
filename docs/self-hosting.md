# Self-hosting

Agents runs on your own Cloudflare account as one Worker. It uses:

- a D1 database for accounts and the list of workspaces;
- a Durable Object for each workspace's registry and for each conversation with an agent;
- if you turn sandboxes on, a container for each conversation whose agent has one.

Agents call models with each workspace's own provider keys, so model usage is billed to the
workspace's accounts with the providers, not to yours. Only Workers AI (optional) and sandboxes
(optional, Workers Paid plan) cost your account more than the Worker itself.

There are two ways to deploy: the button, which also sets up deploys on every push, or the
command line.

## Deploy with the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gateweavehq/agents)

The button copies this repository to your GitHub or GitLab account and connects the copy to
Workers Builds, so every push to its main branch deploys. On the form:

- **Project name** names the Worker. It answers on `<project name>.<your subdomain>.workers.dev`.
- **D1 database**: choose **+ Create new** and give it a name. The form picks an existing database
  when one in your account has the name in `wrangler.jsonc` (`gateweave-agents`), so check it
  before you deploy.
- **BETTER_AUTH_SECRET** signs sessions. Use a long random string, for example from
  `openssl rand -base64 32`, and keep it secret. Changing it later signs everyone out.
- Leave the build and deploy commands as they are. The deploy command applies the database
  migrations before the new code goes live.

When the build finishes, add `SECRETS_KEY` under Workers & Pages › your Worker › Settings ›
Variables and Secrets, as a secret: a long random string, such as another
`openssl rand -base64 32`. Workspaces encrypt their model keys and secret values with it, so keep
a copy. Then open the Worker's address, create an account and then a workspace. Anyone who can
reach the address can sign up and create workspaces of their own; a workspace is only visible to
its members.

**Preview builds.** The button turns them on: a push to any other branch builds a Preview with its
own URL. Previews get their own Durable Objects, but they share the D1 database, and so the
accounts, unless you bind another one in the Worker's
[Preview settings](https://developers.cloudflare.com/workers/previews/configuration/). Turn them
off under Settings › Build › Branch control if you don't need them.

## Deploy from the command line

Requirements: Node.js 24 (22+ works) and pnpm 12.

```sh
git clone https://github.com/gateweavehq/agents.git
cd agents
pnpm install
pnpm wrangler login
pnpm run deploy
```

`pnpm wrangler` runs the Wrangler version Agents pins, from the repository root. The Worker and its
database are named `gateweave-agents`. To use other names, change `name` and `database_name` in
`wrangler.jsonc` before the first deploy.

The first deploy does three things:

1. It creates the D1 database and the Durable Object namespaces.
2. It generates `BETTER_AUTH_SECRET`, which is never shown.
3. It applies the migrations.

Every later `pnpm run deploy` builds, applies new migrations, and only then deploys. Durable
Objects migrate their own storage when each one wakes.

Then give the server a key for the secrets that workspaces entrust to it, such as model provider
keys:

```sh
openssl rand -base64 32 | pnpm wrangler secret put SECRETS_KEY
```

Keep it. If it changes, workspaces have to add their keys and secret values again.

Open the Worker's address, create an account and then a workspace. Anyone who can reach the
address can sign up and create workspaces of their own. A workspace is only visible to its members.

## Settings

Everything except `BETTER_AUTH_SECRET` is optional. Set them in the Cloudflare dashboard (Workers &
Pages › your Worker › Settings › Variables and Secrets), or from the repository root:

```sh
pnpm wrangler secret put BETTER_AUTH_URL
```

Keep tokens, keys and email addresses as secrets. The limits can be plain variables.

| Name                       | What it does                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`       | Signs sessions. Required.                                                                                                                                          |
| `BETTER_AUTH_URL`          | The address people use, such as `https://agents.example.com`. Inferred from each request when unset.                                                               |
| `SECRETS_KEY`              | Encrypts model provider keys and environment secrets (32 random bytes, base64). Model keys are off without it.                                                     |
| `GITHUB_CLIENT_ID`         | Turns on "Sign in with GitHub", with `GITHUB_CLIENT_SECRET`.                                                                                                       |
| `GITHUB_CLIENT_SECRET`     | The client secret of the same GitHub OAuth app.                                                                                                                    |
| `GITHUB_APP_*`             | The six settings of the GitHub App that connects workspaces to repositories; see [github-app.md](github-app.md).                                                   |
| `EMAIL_FROM`               | Turns on email (invitations, password reset), such as `Gateweave Agents <agents@example.com>`.                                                                     |
| `AI_GATEWAY_URL`           | Sends model calls through a Cloudflare AI Gateway: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`.                                                     |
| `AI_GATEWAY_TOKEN`         | The gateway's token, when it is authenticated.                                                                                                                     |
| `WORKERS_AI_TOKEN`         | Offers Workers AI models to every workspace, paid by your account. A Cloudflare API token with Workers AI.                                                         |
| `CLOUDFLARE_ACCOUNT_ID`    | The account that pays for Workers AI. Taken from `AI_GATEWAY_URL` when unset.                                                                                      |
| `WORKERS_AI_WORKSPACES`    | The ids of the workspaces that may use Workers AI, separated by commas; `sandbox` for those `SANDBOX_WORKSPACES` invites. Every workspace when unset.              |
| `WORKERS_AI_DAILY_DOLLARS` | US dollars each workspace may spend on Workers AI in a day (UTC), at its list prices.                                                                              |
| `SANDBOX_WORKSPACES`       | The ids of the workspaces that may use sandboxes, separated by commas. Every workspace when unset.                                                                 |
| `SANDBOX_DAILY_MINUTES`    | Minutes of sandbox time each workspace may use in a day (UTC).                                                                                                     |
| `SANDBOX_MONTHLY_BUDGET`   | US dollars the server may spend on sandboxes in a month (UTC).                                                                                                     |
| `SANDBOX_ALERT_EMAIL`      | Who hears when sandboxes have spent 80% and then all of the monthly budget. Needs email.                                                                           |
| `INVITATION_CONTACT`       | Where a workspace asks for an invitation to Workers AI or sandboxes: an email address or an https URL. Settings > Models links to it. Keep an address as a secret. |

### Your own domain

In the dashboard, open the Worker and add a custom domain under Settings › Domains & Routes. Or
add `"routes": [{ "pattern": "agents.example.com", "custom_domain": true }]` to `wrangler.jsonc`.
Then set `BETTER_AUTH_URL` to that address, and use it in the GitHub apps' URLs.

### Email

Agents sends email through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/).
Onboard the sender's domain once with `pnpm wrangler email sending enable example.com`, then set
`EMAIL_FROM` to an address on it. Without email, Agents works, but invitations have to be accepted
from a link that an admin copies, and nobody can reset a forgotten password.

### Sandboxes

A sandbox is a Linux machine for each conversation with an agent that has one. The agent runs
commands and edits files there, and Claude Code, Codex and OpenCode run there too. To turn
sandboxes on:

1. Add the `SANDBOX` binding and the `containers` entry that the `staging` environment in
   `wrangler.jsonc` has to the environment you deploy.
2. Deploy from a machine with Docker, which builds `sandbox/Dockerfile`.

Your account pays for the [Containers](https://developers.cloudflare.com/containers/pricing/) time,
which needs the Workers Paid plan. Each sandbox is a `standard-1` instance, at most about $0.074 an
hour while it runs. Each workspace has at most three sandboxes at once, and each stops 15 minutes
after its conversation's last turn. To keep the bill in hand:

- `SANDBOX_WORKSPACES` limits sandboxes to the workspaces you invite.
- `SANDBOX_DAILY_MINUTES` limits each workspace's minutes per day.
- `SANDBOX_MONTHLY_BUDGET` limits the server's spending per month. Agents prices sandbox time at
  the most it can cost, so Cloudflare's bill stays under the budget. Set `SANDBOX_ALERT_EMAIL` to
  hear at 80% and at 100%.

### Usage across workspaces

Each workspace sees its own runs on its Usage and Runs pages. To see every workspace's usage
together, for charts or billing, bind a
[Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/) dataset
as `USAGE` in `wrangler.jsonc`:

```jsonc
"analytics_engine_datasets": [{ "binding": "USAGE", "dataset": "gateweave_agents_usage" }]
```

The dataset is created on the first write. From then on, each run that closes writes one event,
indexed by its workspace's id. Without the binding, nothing is written. The fields are in this
order (`packages/registry/src/usage.ts`):

| Field       | What it holds                                                                    |
| ----------- | -------------------------------------------------------------------------------- |
| `index1`    | The workspace's id                                                               |
| `blob1`–`8` | Run id, agent id, agent name, provider, model, status, trigger id, top run's id  |
| `double1`   | Input tokens (cached ones included)                                              |
| `double2`   | Output tokens                                                                    |
| `double3`   | Cached input tokens                                                              |
| `double4`   | Estimated model cost in US dollars, 0 when unpriced                              |
| `double5`   | 1 when the run has a cost estimate, 0 when a model it used has no prices         |
| `double6`   | Model requests                                                                   |
| `double7`   | Seconds the turn took                                                            |
| `double8`   | Sandbox seconds, with the 15 idle minutes after the turn (an upper bound summed) |
| `double9`   | Their estimated cost in US dollars                                               |

Query them with the [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
and an API token with Account Analytics Read. Analytics Engine samples heavy traffic, so weigh each
event by `_sample_interval`. This month's usage by workspace:

```sql
SELECT
  index1 AS workspace,
  SUM(_sample_interval) AS runs,
  SUM(_sample_interval * double1) AS input_tokens,
  SUM(_sample_interval * double2) AS output_tokens,
  SUM(_sample_interval * double4) AS model_dollars,
  SUM(_sample_interval * double9) AS sandbox_dollars
FROM gateweave_agents_usage
WHERE timestamp >= toStartOfMonth(NOW())
GROUP BY workspace
ORDER BY model_dollars DESC
```

The events are a copy, kept for Analytics Engine's retention (three months). The registry's runs
stay the record each workspace sees.

## Updating

```sh
git pull
pnpm install
pnpm run deploy
```

The deploy applies new D1 migrations before the new code goes live.
