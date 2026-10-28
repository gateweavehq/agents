# Connecting GitHub

Gateweave Agents reads the agent configuration in each repository through a GitHub App. Every
server (Gateweave Cloud, staging, your own deployment, your laptop) needs an app of its own,
because the app's URLs point at one server. Without one, everything else works and the
workspace's GitHub settings say that GitHub is not set up.

## What the app asks for

| Permission            | Access | Why                                                        |
| --------------------- | ------ | ---------------------------------------------------------- |
| Repository → Metadata | Read   | Required by GitHub. Lists the repositories the app reaches |
| Repository → Contents | Read   | Reads the files that configure agents                      |

Nothing else: no write access and no account permissions. It subscribes to two events, **Push**
(to read a default branch again when it changes) and **Repository** (renames and default branch
changes). GitHub sends installation events to every app without a subscription.

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
  &contents=read
  &events[]=push
  &events[]=repository
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

An installation belongs to one workspace at a time. **Disconnect** forgets it and its
repositories; the app stays installed on GitHub until you uninstall it there, which also
disconnects it. The code is in `apps/web/src/server/github/flow.ts`.
