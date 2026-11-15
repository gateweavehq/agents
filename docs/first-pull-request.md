# From zero to a first pull request

Every step between an empty Cloudflare account and an agent on your own server that opens a pull
request, in order, with what each one needs. [self-hosting.md](self-hosting.md) has the details
of each setting; this page is the route through them.

Times are from one rehearsal on 2026-11-15 in an empty Cloudflare account. Steps marked **not
timed** were not part of it.

| Step                                          | Needs                                                        | Plan         | Time           |
| --------------------------------------------- | ------------------------------------------------------------ | ------------ | -------------- |
| [1. Deploy](#1-deploy)                        | A Cloudflare account, a GitHub or GitLab account             | Workers Free | About 67 s     |
| [2. A first chat](#2-a-first-chat)            | A model provider's API key                                   | Workers Free | Under a minute |
| [3. Connect GitHub](#3-connect-github)        | A GitHub account or organization where you may create an App | Workers Free | Not timed      |
| [4. Turn sandboxes on](#4-turn-sandboxes-on)  | A machine with Docker, Node.js and pnpm                      | Workers Paid | Not timed      |
| [5. A pull request](#5-a-pull-request)        | Steps 1 to 4                                                 | Workers Paid | Not timed      |
| [6. From an issue](#6-from-an-issue-optional) | A Gateweave Track server, steps 1 to 4                       | Workers Paid | Not timed      |

## What each plan allows

**Workers Free** is enough for steps 1 to 3. Agents uses a Worker, a D1 database, Durable Objects
with SQLite storage, a Workflow and a daily Cron Trigger, all of which the Free plan includes,
within its daily limits ([Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/)). On it you can sign up, make
workspaces, chat with agents and teams on your own model key, see every run with its trace and
cost, find the coding agents configured in your repositories, and apply a setup to a repository,
which opens a pull request of the setup's files.

**Workers Paid** comes in at step 4. An agent that edits code needs a sandbox, a sandbox is a
[Cloudflare Container](https://developers.cloudflare.com/containers/pricing/), and Containers
are not on the Free plan. Your account pays for the time they run;
[Sandboxes](self-hosting.md#sandboxes) has the price and the limits you can set.

**Docker** comes in at step 4 too, and only there: a deploy that includes sandboxes builds their
image from `sandbox/Dockerfile` on the machine that deploys.

Model usage is never on your Cloudflare bill. It goes to the provider whose key the workspace
adds.

## 1. Deploy

Needs a Cloudflare account, and a GitHub or GitLab account for your copy of the repository.
About 67 s from submitting the form to a Worker that answers.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gateweavehq/agents)

On the form, choose **+ Create new** for the D1 database and give `BETTER_AUTH_SECRET` a random
string of at least 32 characters, such as the output of `openssl rand -base64 32`. Keep a copy of
it. [Deploy with the button](self-hosting.md#deploy-with-the-button) explains every field.

Nothing has to be set after the build. The server signs sessions with that secret and, until you
give it a `SECRETS_KEY`, also encrypts the keys workspaces save under a key made from it. That is
why the copy matters: [changing it](self-hosting.md#the-key-that-encrypts-workspaces-secrets)
means entering those keys again.

To deploy from the command line instead, see
[Deploy from the command line](self-hosting.md#deploy-from-the-command-line). That was not timed.

## 2. A first chat

Needs an API key from Anthropic, OpenAI or Google. Under a minute from the Worker's address to
an agent's first answer.

1. Open the Worker's address and create an account. The first account runs the server; close
   sign-up to others when you are ready ([Who may sign up](self-hosting.md#who-may-sign-up)).
2. Create a workspace.
3. Under **Settings > Models**, add the provider's key.
4. Under **Agents**, make an agent with a model of that provider, and send it a message.

The answer is a run, with its trace and estimated cost under **Runs**. This agent has no sandbox
and no repository: it can talk and use MCP servers, not edit code.

## 3. Connect GitHub

Needs a GitHub account or organization where you may create a GitHub App, and admin rights on
the account whose repositories you connect. Not timed.

Each server has a GitHub App of its own, because the app's addresses point at that server.
[github-app.md](github-app.md) has the steps:

1. Open the prefilled link with your server's address in it. On GitHub's form, check the name,
   paste a webhook secret you generate, and create the app.
2. Note the App ID, the Client ID and the slug, generate a client secret, and generate a private
   key.
3. Give the server the six `GITHUB_APP_*` settings as secrets: in the dashboard under Workers &
   Pages › your Worker › Settings › Variables and Secrets, or with `pnpm wrangler secret put` from
   a checkout of your copy.
4. In the workspace, choose **Settings > GitHub**, then **Connect GitHub**, and pick the
   repositories on GitHub.

From here the workspace lists the coding agents set up in those repositories, and
[applying a setup](github-app.md#applying-a-setup) opens a pull request. That one needs no
sandbox, so it works on the Free plan. It carries the setup's files, not an agent's work.

GitLab connects with an access token under **Settings > GitLab** and needs nothing on the
server, but agents cannot open merge requests on GitLab yet. For a pull request, use GitHub.

## 4. Turn sandboxes on

Needs the Workers Paid plan, and a machine with Docker running, Node.js 24 (22+ works) and
pnpm 12. Not timed.

1. Clone your copy of the repository and run `pnpm install`.
2. In `wrangler.jsonc`, at the top level, add the sandbox to the Durable Object bindings and add
   the container, as the `staging` environment further down the file has them:

   ```jsonc
   "durable_objects": {
   	"bindings": [
   		{ "name": "REGISTRY", "class_name": "RegistryDO" },
   		{ "name": "CONVERSATIONS", "class_name": "ConversationAgent" },
   		{ "name": "RATE_LIMITER", "class_name": "RateLimiter" },
   		{ "name": "SANDBOX", "class_name": "RunnerSandbox" },
   		{ "name": "SANDBOX_METER", "class_name": "SandboxMeterDO" }
   	]
   },
   "containers": [
   	{
   		"class_name": "RunnerSandbox",
   		"scheduling_policy": "durable_object",
   		"images": { "sandbox": { "dockerfile": "./sandbox/Dockerfile" } }
   	}
   ],
   ```

3. Run `pnpm wrangler login`, then `pnpm run deploy`. It builds the image and deploys.
4. Set the limits you want before anyone uses them: `SANDBOX_WORKSPACES`,
   `SANDBOX_DAILY_MINUTES` and `SANDBOX_MONTHLY_BUDGET`
   ([Sandboxes](self-hosting.md#sandboxes)). Without them, every workspace on the server may use
   sandboxes, up to three at once each.

If you deployed with the button, your copy also deploys on every push, through Workers Builds.
Whether its builder can build the sandbox image was not tried. A build that fails there deploys
nothing, so the Worker stays as your machine's deploy left it: go on deploying from your machine
as above.

## 5. A pull request

Needs steps 1 to 4, with the GitHub App installed on the repository. Not timed.

1. Edit the agent from step 2, or make another: give it a sandbox, and under **Repository**
   choose the one it works in.
2. Start a conversation and ask for a change.
3. The agent works in a checkout of the repository in its sandbox, on a branch of its own, and
   opens the pull request with its `open_pull_request` tool. The run links to it.

The commits are by your GitHub App's bot account. The agent never writes to the default branch,
and the repository's token never enters the sandbox
([Sandboxes](architecture.md#sandboxes)).

## 6. From an issue (optional)

Needs a [Gateweave Track](https://github.com/gateweavehq/track) server that yours can reach, and
steps 1 to 4. Not timed on a self-hosted pair.

Track is not needed for a pull request. It is what turns "assign an issue" into one:

1. Deploy Track, with its own
   [Deploy to Cloudflare button](https://github.com/gateweavehq/track#deploying), and create a
   workspace and a team there.
2. In Agents, under **Agents**, choose **Set up** next to **Work on Track issues**, then
   **Connect Track**, and approve in Track. [track-work.md](track-work.md) has each screen.
3. Assign the agent an issue in Track.

Two Workers on `workers.dev` cannot reach each other, as
[self-hosting.md](self-hosting.md#sign-in-through-an-openid-connect-provider) notes for sign-in
providers. Agents and Track call each other, so give each a custom domain, or add
`global_fetch_strictly_public` to `compatibility_flags` in both. This pairing was not rehearsed.

For scale: on Gateweave Cloud, one such run had its pull request open 3 minutes 45 seconds after
the issue was assigned (the run in the [README](../README.md)). That is the agent's working time
on one issue, not a setup time.

## What is still done by hand

- The GitHub App: a form on GitHub, a webhook secret, a private key and six settings (step 3).
- Sandboxes: the Paid plan, an edit to `wrangler.jsonc` and a deploy with Docker (step 4).
- Track: a second deploy, and addresses the two servers can reach each other on (step 6).
