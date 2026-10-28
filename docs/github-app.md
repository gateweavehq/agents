# Connecting GitHub

Gateweave Agents reads the agent configuration in each repository, and applies setups by pull
request, through a GitHub App. Every
server (Gateweave Cloud, staging, your own deployment, your laptop) needs an app of its own,
because the app's URLs point at one server. Without one, everything else works and the
workspace's GitHub settings say that GitHub is not set up.

## What the app asks for

| Permission                 | Access         | Why                                                                  |
| -------------------------- | -------------- | -------------------------------------------------------------------- |
| Repository → Metadata      | Read           | Required by GitHub. Lists the repositories the app reaches           |
| Repository → Contents      | Read and write | Reads the files that configure agents; commits a setup's to a branch |
| Repository → Pull requests | Read and write | Opens the pull request that applies a setup, and follows its state   |

No account permissions. Writing is only ever a new branch named `gateweave/…` and a pull request
from it: the app never writes to a default branch, and a commit changes only the files the setup
writes (see [Applying a setup](#applying-a-setup)). It subscribes to three events, **Push** (to
read a default branch again when it changes), **Repository** (renames and default branch changes)
and **Pull request** (to know when one that applies a setup is merged or closed). GitHub sends
installation events to every app without a subscription.

An app created before setups could be applied has only read access. Add the two write
permissions and the **Pull request** event on its settings page; each account that installed it
then accepts the new permissions on GitHub before setups can be applied there. Reading goes on
working in the meantime.

## Create the app

Open this link, with `https://HOST` replaced by your server's origin
(`https://agents.example.com`, or `http://localhost:4720` for local development) and
`ORGANIZATION` by the GitHub organization that will own the app. To own it with a personal account instead, start the link
with `https://github.com/settings/apps/new`.

```text
https://github.com/organizations/ORGANIZATION/settings/apps/new?name=Gateweave%20Agents
  &url=https://HOST
  &callback_urls[]=https://HOST/api/github/callback
  &setup_url=https://HOST/api/github/setup
  &setup_on_update=true
  &webhook_active=true
  &webhook_url=https://HOST/api/github/webhooks
  &public=false
  &metadata=read
  &contents=write
  &pull_requests=write
  &events[]=push
  &events[]=repository
  &events[]=pull_request
```

The line breaks are for reading; remove them before you open it. GitHub fills in the form from
these parameters
([docs](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters)).
Then, on the form:

1. **Name.** App names are unique on GitHub. Change it if it is taken.
2. **Webhook secret.** GitHub cannot fill it in from the link. Generate one with
   `openssl rand -hex 32` and paste it in.
3. **Request user authorization (OAuth) during installation** stays off. Turning it on replaces
   the setup URL, and connecting needs that step (see below).
4. **Expire user authorization tokens** stays on. The app never keeps a user token anyway.
5. **Where can this GitHub App be installed?** "Only on this account" suits one organization's
   own server. A server that other accounts connect to, such as Gateweave Cloud, needs "Any
   account" (`public=true` in the link).

Create the app, then on its settings page:

- Note the **App ID** and the **Client ID**.
- Note the **slug**: the last part of the app's public page, `github.com/apps/<slug>`.
- **Generate a new client secret** and copy it.
- **Generate a private key**. GitHub downloads a `.pem` file.

Webhooks cannot reach `localhost`. To try them locally, run a tunnel such as
`cloudflared tunnel --url http://localhost:4720` and use its address as the webhook URL.
Connecting works without them; changes on GitHub then show up only when you connect again.

## Give the server its settings

The server needs all six:

| Setting                     | Value                            |
| --------------------------- | -------------------------------- |
| `GITHUB_APP_ID`             | The App ID                       |
| `GITHUB_APP_SLUG`           | The slug                         |
| `GITHUB_APP_CLIENT_ID`      | The Client ID                    |
| `GITHUB_APP_CLIENT_SECRET`  | The client secret                |
| `GITHUB_APP_PRIVATE_KEY`    | The contents of the `.pem` file  |
| `GITHUB_APP_WEBHOOK_SECRET` | The webhook secret you generated |

Locally, uncomment them in `.dev.vars` and fill them in. Quote the private key across lines, or
put it on one line with each newline written as `\n`.

On Cloudflare, store each as a secret from the repository root, adding `--env staging` (or your
environment) as needed. Wrangler reads the value from standard input, so the key never lands in
your shell history:

```sh
pnpm wrangler secret put GITHUB_APP_PRIVATE_KEY < gateweave-agents.private-key.pem
pnpm wrangler secret put GITHUB_APP_WEBHOOK_SECRET
```

Then delete the downloaded `.pem`. You can generate a new key on GitHub at any time and revoke
the old one.

## How connecting works

1. A workspace admin chooses **Connect GitHub** in the workspace's settings. The server sends
   them to install the app, with a signed state that names the workspace.
2. GitHub sends them back to the setup URL with the installation's id. Anyone can open that URL
   with any id, so the server does not trust it yet and sends them on to authorize the app.
3. GitHub sends them back to the callback URL with a code. The server trades it for a user
   token, checks that the installation is one this person can reach on GitHub, and only then
   links it to the workspace and lists its repositories. It does not keep the token.

Every member of the workspace sees the agent configuration found in the repositories the
admin connects, private ones included, whether or not they can open those repositories on
GitHub. Choose the repositories on GitHub with that in mind.

After that, a push to a repository's default branch has the workspace read its agent files
again; only the files the push changed are downloaded.

## Applying a setup

An owner or admin chooses **Apply** on a setup's page and picks a repository. The workspace reads
the repository's default branch at its head and commits the setup's files on top of it, in a
branch of their own, then opens a pull request. Nothing reaches the default branch until someone
merges it.

- **Files the setup does not write are not touched.** A file the setup writes is replaced, except
  the shared MCP configuration (`.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`,
  `.codex/config.toml`): there only the setup's servers are merged in, and the rest of the file
  stays as it is. A symbolic link or folder where the setup would write a file is left alone, and
  the pull request says so.
- **Applying again** while the pull request is open gives it a new commit, unless someone else
  pushed to its branch: then it is left alone until it is merged or closed.
- **A pull request's state** (open, merged or closed) comes from the **Pull request** webhook, and
  is checked again on GitHub whenever the setup is applied there, so a missed delivery is caught
  up.
- **After the merge**, the repository's and the setup's pages show drift: whether the repository
  still holds what the setup writes, or someone edited or deleted its files, or the setup has
  moved on since. **Apply again** opens a new pull request.

An installation belongs to one workspace at a time. **Disconnect** forgets it and its
repositories; the app stays installed on GitHub until you uninstall it there, which also
disconnects it. The code is in `apps/web/src/server/github/flow.ts`.
