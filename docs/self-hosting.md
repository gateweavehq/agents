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

- **Git account** is the first field, the account the copy goes to. If nothing is connected yet,
  connect GitHub or GitLab there.
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
a copy. Then open the Worker's address, create an account and then a workspace. The first account
runs the server. Until it changes that, anyone who can reach the address can sign up and create
workspaces of their own, and a workspace is only visible to its members. See
[Who may sign up](#who-may-sign-up) to close that.

**Preview builds.** The button turns them on: a push to any other branch builds a Preview with its
own URL. A Preview gets none of the Worker's bindings or secrets, so its address only says that it
is not set up, and it cannot reach your data. To make Previews work, create another D1 database and
apply the migrations to it, name it and the Durable Objects under `previews` in `wrangler.jsonc` as
[Cloudflare's guide](https://developers.cloudflare.com/workers/previews/resources/) shows, and give
them a secret of their own with `pnpm wrangler preview base-config secret put BETTER_AUTH_SECRET`.
If you don't need them, untick **Enable Preview builds** on the form, or turn them off later under
Settings › Build › Branch control.

**Dependabot.** The copy brings this repository's `.github/dependabot.yml`, so Dependabot opens a
pull request on it within minutes, and weekly after that. You don't need them: a release brings
updates that were tested together, and what you merge can conflict with the next update. Delete the
file unless you want them, and close what it opened.

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

Open the Worker's address, create an account and then a workspace. The first account runs the
server. Until it changes that, anyone who can reach the address can sign up and create workspaces
of their own, and a workspace is only visible to its members. See
[Who may sign up](#who-may-sign-up) to close that.

## Where the database lives

Every read and write of an account or a session goes to one place, the D1 database's primary, and
D1 puts it close to whoever asked for the database unless told otherwise. That may be far from your
people. Measured from a Worker with the primary in Eastern Europe, one read takes about 20 ms from
Frankfurt, 110 ms from Virginia, 240 ms from Tokyo and 290 ms from Sydney
([how](https://github.com/gateweavehq/track/issues/231#issuecomment-6708513383)).

To choose, make the database yourself before the first deploy, with a location hint (`wnam`, `enam`,
`weur`, `eeur`, `apac` or `oc`):

```sh
pnpm wrangler d1 create gateweave-agents --location apac
```

Then pick it instead of **+ Create new** on the button's form, or put its id in `wrangler.jsonc` as
`database_id`.

## Settings

Everything except `BETTER_AUTH_SECRET` is optional. Set them in the Cloudflare dashboard (Workers &
Pages › your Worker › Settings › Variables and Secrets), or from the repository root:

```sh
pnpm wrangler secret put BETTER_AUTH_URL
```

Keep tokens, keys and email addresses as secrets. The limits can be plain variables, and both stay
through a deploy, because `wrangler.jsonc` sets `keep_vars`. A server older than v0.13.1 lost its
plain variables on every deploy, and a limit that is not set is no limit, so look through them
after updating.

| Name                       | What it does                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`       | Signs sessions. Required.                                                                                                                                          |
| `BETTER_AUTH_URL`          | The address people use, such as `https://agents.example.com`. Inferred from each request when unset, and then `/mcp` is off.                                       |
| `SECRETS_KEY`              | Encrypts model provider keys and environment secrets (32 random bytes, base64). Model keys are off without it.                                                     |
| `GITHUB_CLIENT_ID`         | Turns on "Sign in with GitHub", with `GITHUB_CLIENT_SECRET`.                                                                                                       |
| `GITHUB_CLIENT_SECRET`     | The client secret of the same GitHub OAuth app.                                                                                                                    |
| `OIDC_ISSUER`              | Turns on an OpenID Connect provider, with the two below. See [below](#sign-in-through-an-openid-connect-provider).                                                 |
| `OIDC_CLIENT_ID`           | This deployment's client ID at the provider.                                                                                                                       |
| `OIDC_CLIENT_SECRET`       | Its client secret there.                                                                                                                                           |
| `OIDC_PROVIDER_NAME`       | What the sign-in button calls it. Unset: "single sign-on".                                                                                                         |
| `GITHUB_APP_*`             | The six settings of the GitHub App that connects workspaces to repositories; see [github-app.md](github-app.md).                                                   |
| `EMAIL_FROM`               | Turns on email (invitations, password reset), such as `Gateweave Agents <agents@example.com>`.                                                                     |
| `LEGAL_NOTICE_URL`         | The address of your legal notice. See [below](#your-legal-pages).                                                                                                  |
| `PRIVACY_POLICY_URL`       | The address of your privacy policy.                                                                                                                                |
| `TERMS_URL`                | The address of your terms.                                                                                                                                         |
| `SIGN_UP_REQUEST_URL`      | Where "Ask for access" leads while sign-up is by invitation: an https address. See [below](#who-may-sign-up).                                                      |
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
Then set `BETTER_AUTH_URL` to that address, and use it in the GitHub apps' URLs. Sign-in needs HTTPS:
session cookies are marked `Secure`, so a browser won't keep them over plain HTTP. Turn on
[Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)
for the domain so that nobody lands on the plain address.

Agents' pages refuse scripts they did not name, so a zone setting that adds scripts to a page does
nothing here or gets in the way. [Web Analytics' automatic setup and Rocket Loader](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/content-security-policies/)
are two of them: leave those off for this hostname.

### Your legal pages

Agents comes with no legal notice, privacy policy or terms, and never links to Gateweave's: whoever runs a
copy decides what applies to it. Set any of the three addresses above, and it is linked from the
sign-in pages and the workspace menu. With `TERMS_URL` set, the sign-in page also says that continuing
means agreeing to them.

### Email

Agents sends email through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/).
Onboard the sender's domain once with `pnpm wrangler email sending enable example.com`, then set
`EMAIL_FROM` to an address on it. Without email, Agents works, but invitations have to be accepted
from a link that an admin copies, and nobody can reset a forgotten password for themselves.

As you hold the database, you can do it for them, from the repository root. Find their `id` in this
list. Don't paste an address someone sent you into a command, as it could run as part of it:

```sh
pnpm wrangler d1 execute DB --remote --command "SELECT id, email FROM user ORDER BY email"
```

Then make a link for that `id`. It works once, for an hour, and using it signs them out everywhere.
Whoever opens it can choose the password, so send it only to them:

```sh
PERSON=the-id-from-that-list
TOKEN=$(openssl rand -hex 32)
pnpm wrangler d1 execute DB --remote --command \
  "INSERT INTO verification (id, identifier, value, expires_at) VALUES ('$TOKEN', 'reset-password:$TOKEN', '$PERSON', (unixepoch() + 3600) * 1000)"
echo "https://your-server/reset-password?token=$TOKEN"
```

### Sign in through an OpenID Connect provider

Any OpenID Connect provider can sign people in: Gateweave ID, Pocket ID, authentik, Keycloak, Okta
and others. It adds a button to the sign-in page, and passwords keep working.

1. Register Agents with the provider as a confidential client that uses the authorization code
   flow and `client_secret_basic`, with the scopes `openid`, `profile` and `email`:
   - Redirect URI: `https://agents.example.com/api/auth/callback/oidc` (your address)
   - Back-channel logout URI, if the provider has them:
     `https://agents.example.com/api/auth/backchannel-logout/oidc`
2. Set `OIDC_ISSUER` to the provider's issuer, the address its
   `/.well-known/openid-configuration` is under, then `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.
   `OIDC_PROVIDER_NAME` names the button, as in "Continue with Acme".

Someone new gets an account, named as the provider names them, and can change that name in Agents
without the provider changing it back. Someone whose address already has one links to it only when
the provider says the address is verified and they have verified it in Agents too, so anyone who could
sign up at the provider with that address cannot take over the account. Without
[email](#email) nobody can verify an address in Agents, so existing accounts stay with their
passwords.

If the provider is down, its button says so, and everything else keeps working. People already
signed in stay signed in, because Agents asks the provider nothing except when someone uses that
button or the provider signs someone out. With the back-channel logout URI registered, signing out
at the provider ends the Agents sessions it started. Signing out of Agents leaves the provider's
session alone.

A member's picture shows when it comes from the provider's own host or from GitHub. From anywhere
else, the page's policy stops it and their initials show instead.

If Agents and the provider are both Workers, give each a
[Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#worker-to-worker-communication).
A Worker cannot reach another on its own zone through a route, and two on `workers.dev` cannot reach
each other at all: Cloudflare answers with error 1042, and the button says it could not reach the
provider. If they have to stay on `workers.dev`, add `global_fetch_strictly_public` to
`compatibility_flags` in each one's `wrangler.jsonc`.

### Who may sign up

A server is open when you deploy it: anyone who can reach the address may make an account. The first
account runs the server, and its account page (`/settings/account`) has a section, **This server**,
that only that account sees. Choose **By invitation** there, and from then on only these may make an
account:

- the first account of a server that has none;
- an address on the list below it, or at a domain on it;
- an address with a pending invitation to a workspace, from any workspace's admin as before;
- where you turn on **Trust** your provider (shown when a
  [provider](#sign-in-through-an-openid-connect-provider) is set up), anyone who signs in through
  it, since it keeps its own list. GitHub is never trusted that way.

People who already have an account sign in as before. Everyone else is told "This server takes new
accounts by invitation. Ask whoever runs it to invite you.", whichever way they come (a password,
GitHub or the provider) and whether or not the address has an account.

The list takes an address (`ada@example.com`) or a domain with an `@` in front (`@example.com`). A
domain covers addresses at exactly that domain and not its subdomains, so `@example.com` does not
cover `ada@mail.example.com`. An entry may have a note of your own, up to 200 characters. The list
holds up to 5,000 entries, each shown with when it was added and whether an account with that
address (or at that domain) exists yet. Taking an entry off stops letting more people in with it; an
account it made stays. Changing anything needs a sign-in from the last day.

Set `SIGN_UP_REQUEST_URL` to an https address, such as a waitlist page, and the sign-in pages show
"Ask for access" linking to it while sign-up is by invitation.

While sign-up is by invitation, the account that runs the server cannot be deleted, because nobody
else could open it again. Open sign-up first, which lets it go. When the owner's account is deleted
on an open server, ownership passes to the oldest account that is left, who then sees **This
server**. If none is left, the next account to sign up becomes the owner.

The list is personal data: it holds email addresses of people who may not have an account, and the
server keeps them until you take them off. Deleting an account does not take its address off the
list. Say so in your privacy notice if you publish one, and remove an address when someone asks.

An upgrade changes nothing for a server that has accounts: it stays open, with its oldest account as
the owner.

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

## When someone deletes their account

People delete their own account on `/settings/account`, with no setting to turn on, and their
conversations go from every workspace, with their messages and sandboxes. If you publish a privacy
notice, say what stays: their runs, under "A former member", and what they set up for a workspace,
including tokens they connected.
[The architecture notes](architecture.md#deleting-an-account) have the full list, including
workspaces someone left before v0.15, which you would have to clear by hand if they ask, and what
Cloudflare's point-in-time recovery keeps.

An account that is the only owner of a workspace is refused until someone else owns it or it is
deleted. So is the account that runs the server while [sign-up is by invitation](#who-may-sign-up),
and an address on the owner's list stays there, since the list is the owner's. If you restore D1 or a workspace's registry to a time before a deletion, the person comes
back.

## Updating

**Command line:**

```sh
git pull
pnpm install
pnpm run deploy
```

The deploy applies new D1 migrations before the new code goes live.

**Button:** your copy does not follow this repository on its own, and shares no history with it,
so `git pull` refuses. This takes the latest release into your copy instead, as one commit on top
of it. A copy can skip releases, however old it is:

```sh
git remote add upstream https://github.com/gateweavehq/agents.git   # once
git fetch upstream
git show upstream/main:scripts/update-copy.mjs | node --input-type=module
git push
```

The script pushes nothing, and `git reset --hard HEAD~1` undoes it until you do. The push is what
deploys: Workers Builds builds it and applies the D1 migrations.

If GitHub refuses the push with `push declined due to email privacy restrictions`, the commit
carries the address your GitHub settings keep private. Use the `noreply` address those settings
show you, and make the commit again:

```sh
git config user.email "<your noreply address>"
git commit --amend --reset-author --no-edit
git push
```

What your copy changed stays: the Worker's and database's names in `wrangler.jsonc`, the name in
`package.json`, and having no workflows. If something else you changed conflicts with the release,
the script names the files for you to fix before committing. To take a release other than the
latest, end the third line with `node --input-type=module - --to v1.2.3`.

Agents is in early development. Read [CHANGELOG.md](../CHANGELOG.md) before updating, as some
releases change how things work.
