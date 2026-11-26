# Quickstart

About N minutes from a fresh clone gets you Agents on your own Cloudflare account, at a workers.dev
address, deployed from the command line, with you signed in as its first account and a workspace
that holds an agent that answers your first message through Workers AI.

This is the shortest path: no custom domain, no sign-in provider, no email, no GitHub App and no
sandboxes. The rest is in [self-hosting.md](self-hosting.md).

## What you need

- A Cloudflare account on the Workers Paid plan. The model this page uses is billed by the token
  (US$0.30 per million input tokens and US$1.20 per million output tokens), and Cloudflare's page
  for it says it is not offered under Workers Free billing. A first message costs a fraction of a
  cent. [first-pull-request.md](first-pull-request.md#what-cloudflares-plans-say) lists what else
  the plans change.
- [Git](https://git-scm.com/downloads).
- [Node.js](https://nodejs.org) 24, the version in `.node-version`, and
  [pnpm](https://pnpm.io/installation) 12.
- A browser, for signing in to Cloudflare and for Agents itself.

Docker is not needed: sandboxes are off until you turn them on.

## Steps

1. Get the code.

   ```sh
   git clone https://github.com/gateweavehq/agents.git
   cd agents
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Cloning into 'agents'...
   ```

   </details>

2. Install the dependencies.

   ```sh
   pnpm install
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Scope: all 8 workspace projects
   Packages: +524
   ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
   Progress: resolved 524, reused 0, downloaded 524, added 524, done

   devDependencies:
   + @biomejs/biome 2.6.8
   + typescript 7.0.2

   Done in 38s using pnpm v12.4.2
   ```

   This is a machine whose package store is empty. The counts differ a little from release to
   release, and a machine that has installed these packages before reuses them, so it finishes
   sooner.

   </details>

3. Sign in to Cloudflare. Wrangler, the Cloudflare command-line tool, opens your browser; approve
   its request there.

   ```sh
   pnpm wrangler login
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Attempting to login via OAuth...
   Opening a link in your default browser: https://dash.cloudflare.com/oauth2/auth?...
   Successfully logged in.
   ```

   </details>

4. Deploy.

   If your Cloudflare login can reach more than one account, the deploy cannot ask which to use.
   Run `pnpm wrangler whoami` to see them with their ids, then `export CLOUDFLARE_ACCOUNT_ID=<id>`
   for the one to deploy to.

   ```sh
   pnpm run deploy
   ```

   Nothing needs setting first. The deploy builds Agents, creates the database, the Durable Object
   classes and the Workflow that writes repository wikis, makes the secret that signs sessions
   (`BETTER_AUTH_SECRET`) and never shows it, and then applies the database migrations. If your
   account has no workers.dev subdomain yet, Wrangler offers to register one: say yes. When
   Wrangler asks whether to continue with the migrations, because the database may not serve
   requests while they run, answer yes.

   The Worker and the database are both called `gateweave-agents`, from `name` and `database_name`
   at the top of `wrangler.jsonc`; the ones under `env` are Gateweave's own deployments. To use
   other names, change those two before this step. The Worker's name is also the first part of its
   address. The wiki Workflow's name, `gateweave-agents-wiki`, is unique in an account, so change it
   too if your account already has a Workflow with that name.

   <details>
   <summary>Expected output</summary>

   ```text
   (!) Your Vite config uses features that are unsupported by `configLoader: 'native'` ...
   vite v8.3.8 building client environment for production...
   ✓ built in 14s
   vite v8.3.8 building ssr environment for production...
   WARNING Missing required secrets: BETTER_AUTH_SECRET. Add them to .dev.vars, .env, or set as environment variables.
   ✓ built in 12s
    ⛅️ wrangler 4.162.0
   ...
   Total Upload: 11383.43 KiB / gzip: 2641.51 KiB
   The following bindings need to be provisioned:
   Binding        Resource
   env.DB         D1 Database

   Provisioning DB (D1 Database)...
   Resource name found in config: gateweave-agents
   🌀 Creating new D1 Database "gateweave-agents"...
   🎉 Resources provisioned, continuing with deployment...
   Durable Object exports reconciliation:
     Created: ConversationAgent, RateLimiter, RegistryDO, RunnerSandbox, SandboxMeterDO
   Worker Startup Time: 110 ms
   Your Worker has access to the following bindings:
   Binding                                         Resource
   env.REGISTRY (RegistryDO)                       Durable Object
   env.CONVERSATIONS (ConversationAgent)           Durable Object
   env.RATE_LIMITER (RateLimiter)                  Durable Object
   env.SANDBOX_METER (SandboxMeterDO)              Durable Object
   env.WIKI (WikiWorkflow)                         Workflow
   env.EMAIL (unrestricted)                        Send Email
   env.DB (gateweave-agents)                       D1 Database
   env.BETTER_AUTH_SECRET ("(hidden)")             Environment Variable
   Uploaded gateweave-agents (24.17 sec)
   Deployed gateweave-agents triggers (2.44 sec)
     https://gateweave-agents.<your-subdomain>.workers.dev
     schedule: 29 3 * * *
     workflow: gateweave-agents-wiki
   Current Version ID: 4f1c7a2e-9b3d-4e86-a5c0-7d2e8b91f6a3
   ...
   Migrations to be applied:
   ? About to apply 14 migration(s)
   Your database may not be available to serve requests during the migration, continue?
   ...
   │ 0013_workspace_deletion.sql  │ ✅     │
   ```

   The Vite warning and the `WARNING Missing required secrets` line can be ignored: the second
   comes from the build, which runs before the deploy makes the secret. The address on the line
   after `Deployed` is yours. The migration table lists every migration with a tick; the last one
   is shown above. The numbers are from one run and differ from yours. The deploy takes about
   a minute and a half on a warm package cache.

   </details>

5. Open the address from the last step in your browser. It sends you on to `/login`, the page
   **Sign in to Gateweave Agents**. Choose **Create an account** under the form, enter a name, an email address and a
   password of at least 8 characters, then choose **Create account**. Agents sends no email and asks
   for no confirmation, so any address will do.

   This server is open until you change it: anyone who reaches the address can make an account, and
   the first one, yours, runs the server. Do this step before you share the address. To let in only
   people you choose, see [Who may sign up](self-hosting.md#who-may-sign-up).

   <details>
   <summary>Expected output</summary>

   You are signed in at once, and the page you land on is `/`, titled **Workspaces**, with "Signed in
   as" and your address under it and "You are not in any workspace yet." below.

   </details>

6. Under **New workspace**, enter `Acme` as the **Name** and choose **Create workspace**. The **URL**
   below it fills in as `acme`.

   <details>
   <summary>Expected output</summary>

   The workspace opens on its own address, `/acme`, on a page headed **Acme** with four counts,
   Projects, Repositories, Agents and Assets, all at 0. A sidebar lists the workspace's pages,
   among them **Agents** and **Chat**, with **Settings** at its foot.

   </details>

<!-- timed run stops here -->

7. Make a Cloudflare API token for Workers AI, and copy your account id while you are there. In the
   [Cloudflare dashboard](https://dash.cloudflare.com), open the **Workers AI** page and choose
   **Use REST API**. Choose **Create a Workers AI API Token**, check the prefilled permissions,
   choose **Create API Token**, then **Copy API Token**. The same page shows your **Account ID**;
   copy that as well. The token needs the permissions `Workers AI - Read` and `Workers AI - Edit`;
   if you make one by hand under your profile's API Tokens, give it those two. Cloudflare shows the
   token once on this page and keeps it on your profile.

   <details>
   <summary>Expected output</summary>

   The dashboard shows the token, a long string, and a box labelled **Account ID** with 32
   characters of letters and digits. Nothing changes on your server yet.

   </details>

8. Give the server the token. Wrangler asks for the value; paste the token, which shows nothing as
   you paste, and press Enter.

   ```sh
   pnpm wrangler secret put WORKERS_AI_TOKEN
   ```

   The token is a secret: Cloudflare does not show a secret again. The command takes effect at
   once, since the Worker already exists, so there is nothing to deploy.
   Wrangler warns that several environments are defined and none was named; that is about the
   `env` blocks, and the Worker you deployed in step 4 is the top-level one, which is what it uses.

   <details>
   <summary>Expected output</summary>

   ```text
    ⛅️ wrangler 4.162.0
   ───────────────────────────────────────────────
   WARNING Multiple environments are defined in the Wrangler configuration file, but no target environment was specified for the secret put command.
   ...
   ? Enter a secret value: › ********
   🌀 Creating the secret for the Worker "gateweave-agents"
   ✨ Success! Uploaded secret WORKERS_AI_TOKEN
   ```

   </details>

9. Tell it whose account pays: paste the account id from step 7. Agents needs it as well as the
   token, unless `AI_GATEWAY_URL` names the account. It is not confidential, but a secret keeps
   `wrangler.jsonc` as it is.

   ```sh
   pnpm wrangler secret put CLOUDFLARE_ACCOUNT_ID
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   ? Enter a secret value: › ********************************
   🌀 Creating the secret for the Worker "gateweave-agents"
   ✨ Success! Uploaded secret CLOUDFLARE_ACCOUNT_ID
   ```

   </details>

10. In the workspace, choose **Settings** in the sidebar. It opens `/acme/settings/members`, the
    Members page; choose **Models** in the list beside it.

    <details>
    <summary>Expected output</summary>

    The page is `/acme/settings/models`. A section headed **Workers AI** says "This server offers Workers AI models to this workspace.
    They need no key: whoever runs the server pays for their runs." Below it, a line ending "models
    that can use tools", with a count in front, opens a list when you choose it. If a red message shows there
    instead, the token or the account id is wrong: put the secret again.

    </details>

11. Choose **Agents** in the sidebar, then **New agent**. Enter `Helper` as the **Name**. The
    **Provider** already reads **Workers AI**, because no other provider has a key. In **Model**,
    enter `@cf/deepseek-ai/deepseek-v4.1-flash-1017`, a model Cloudflare lists as current, billed at
    the prices above. Leave **Instructions** at **None**, then choose **Create agent**.

    Choose the model this page names rather than one you remember: Cloudflare removed sixteen
    Workers AI text models on 20 November 2026, and an agent set to one of them fails with a message
    that says so. [When Cloudflare removes a Workers AI
    model](self-hosting.md#when-cloudflare-removes-a-workers-ai-model) has the rest.

    <details>
    <summary>Expected output</summary>

    A message says "Helper was created" and the agent's own page opens, at `/acme/agents/` followed by
    the agent's id.

    </details>

12. Choose **Chat** in the sidebar. Under **Start a conversation**, the list **Agents** shows
    **Helper** with "Workers AI" and the model's id under its name. Choose **Chat** beside it.

    <details>
    <summary>Expected output</summary>

    A conversation opens at `/acme/chat/` followed by its id, with "Write to Helper below." in the middle and a box labelled "Message
    Helper" at the foot.

    </details>

13. Type a message such as `Say hello in one sentence.` into the box and press Enter.

    <details>
    <summary>Expected output</summary>

    Your message appears, and Helper's answer arrives under it, a sentence or so of text.

    </details>

## Next

- [first-pull-request.md](first-pull-request.md): the longer route, from here to an agent that opens
  a pull request, with the plan and the accounts each step needs.
- [self-hosting.md](self-hosting.md): your own domain, sign-in providers, email, who may sign up,
  sandboxes, updating and backups.
