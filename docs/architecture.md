# Architecture

How Gateweave Agents is built today. [spec.md](spec.md) describes where it is going; this file
changes with the code.

## One Worker

The UI, the API and auth ship as one Worker (`apps/web`), the same shape as Gateweave Track:

- **TanStack Start** renders pages on the server and hydrates them in the browser. Server
  functions are the API: each one checks the session and, for workspace data, the caller's
  membership before doing anything.
- **Better Auth** owns accounts, sessions, workspaces (its organizations), members, roles and
  invitations, stored in **D1**. There is one Better Auth instance per isolate, built on first
  use, because workerd forbids I/O in global scope. It can also sign people in through an OpenID
  Connect provider: see "Signing in through a provider" below.
- **A read of D1 that fails is sent again**, up to three times in all
  (`apps/web/src/server/db/retry-reads.ts`), before a page or a session check is told. D1 can fail
  for a moment, and so can the local runtime under load, where one failed read of a session made a
  signed-in person's page a 500. Only a single `select` is sent again, on the database or on a
  session of it (`withSession`): a write may have happened although its answer was lost, and a
  batch, or a text with a second statement after a `;`, may hold writes. And only for a failure
  Cloudflare's D1 error list says to retry (a lost connection, the database's object reset or
  updated, a replica cut off, a node that could not be reached), or the local runtime's own.
  Everything else is the caller's at once: an overloaded database is not helped by more requests,
  and a failure nobody recognises is not known to be safe to repeat. The waits are about 25 and
  100 ms, each times a random factor between 0.5 and 1.5, so reads that failed together do not
  come back together. Each resend is logged by a fixed name for the failure and the attempt's
  number, never with D1's words, which can carry what a row held. After the last attempt the
  failure reaches the caller.
- **A query of D1 that failed says nothing of its statement.** Drizzle's own error is `Failed
  query: select … params: …`, with every value the statement was given, and whoever catches an
  error tends to log it or show it: Better Auth logged a session read that failed, token
  included, and a page whose read failed showed the statement and its values. So `createDb`
  throws a `DatabaseError` instead (`apps/web/src/server/db/query-failure.ts`), whose message is
  `A database query failed (reference 1a2b3c4d)` and nothing else. It is made where Drizzle's
  session prepares a query, the one place every builder, `db.query` and a transaction go through;
  a batch fails in D1's words where the binding is asked, and gets the same there, so what fails
  while a batch is put together is thrown as it is. The failure is logged once, as `d1: a query
  failed (<kind>), reference <reference>: <statement>`. The statement is the text with its `?`,
  cut at 600 characters, never the values: the app writes no value into a statement's text (no
  `sql.raw`; a `sql` template binds what it is given), which has to stay so. The kind is D1's
  code at the start of its words, SQLite's at their end, a name for each thing D1 says in fixed
  words (the passing ones of `retry-reads.ts`, and `overloaded`, `queued-too-long`, `cpu-reset`,
  `memory-reset`, `storage-timeout`, `response-too-large`, `too-many-api-requests`,
  `too-many-variables`, `syntax-error`), and a constraint or a missing table or column by the
  schema's names, quoted only right after D1's code: never D1's words as they came, since the
  same words further in may be what a row held. The error's cause is an error that says the kind
  only, which Better Auth's oauth-provider reads to tell a database not migrated yet (`no such
  table`) from a real failure. None of what this reaches for is in Drizzle's public types: with
  a session it does not know, `createDb` throws as the Worker starts, and with a prepared query
  sent some other way, at the first query. The error page (`RouteError`) shows no error's
  message, only that the page could not be loaded and the reference if there is one, which it
  looks for in the error's causes too. Only a message crosses from a server function to the
  browser, so one whose reference is in a cause, as Better Auth's `Failed to get session` is,
  leaves with the reference added to its message (`apps/web/src/start.ts`). A dialog or a toast
  still shows the message of what a server function threw, which for a failed query is that
  sentence. That file also lists the framework's guard against forged requests
  (`createCsrfMiddleware`, for server functions only) as request middleware: a start instance
  replaces the framework's default request middleware, which is that guard, so leaving it out
  would let a page of another origin call a server function. A server function answers 403
  unless `Sec-Fetch-Site` is `same-origin` or, without that header, `Origin` or else `Referer`
  is the app's own (`test/server-fn-origin.test.ts`).
- **Rate limits** on sign-in, password reset, invitations and email are counted in a
  `RateLimiter` Durable Object per client address or recipient, so they hold across isolates and
  locations. Everything else is limited in memory per isolate. Every Worker reaches another zone
  from one address, `2a06:98c0:3600::103`, so a request with that address and a `cf-worker` header
  is counted by the zone it names, which Cloudflare sets and a sender cannot change
  (`workers-address.ts`). Without that, junk from anyone's Worker could use up what a provider's
  logout or Track's deliveries need. Better Auth counts a request before anything in it can step in,
  so the request is changed before it gets there, and a session made from a Worker holds a made-up
  address, which nothing here shows anyone.
- **Email** goes through Cloudflare Email Service when `EMAIL_FROM` is set: password reset,
  verification and invitations. Without it, invitations are links to share.
- **What is past its time** goes once a day, on a Cron Trigger every deployment inherits from
  `wrangler.jsonc` (`apps/web/src/server/db/prune.ts`). Better Auth removes a session or a
  verification only when something looks it up, so those nobody comes back for would otherwise
  stay, with the address and browser a session holds, and invitations with the address they were
  sent to. OAuth refresh tokens, access tokens and client assertions past their time go too, since they name the person an agent acts as, and so do audit log entries older than a year. Gateweave Cloud's privacy policy states these periods, so a change here is a change to it.
- **Headers** go on every answer (`apps/web/src/server/security-headers.ts`): `nosniff`, a referrer
  rule and, over HTTPS, `Strict-Transport-Security`. A page also gets `X-Frame-Options`,
  `Cache-Control: private, no-store` and a Content-Security-Policy with a nonce made for that
  response. A conversation shows what a model wrote, and a model can be talked into writing
  anything, so nothing can frame a page, a script runs only from this Worker's own address or with
  the nonce, and a page connects only to this Worker. A member's picture is the one thing a page
  shows from elsewhere, and only from GitHub or the sign-in provider. Vite's dev server gets none of
  this, because its hot reload adds scripts without a nonce. The browser tests run against the
  production build, so they get the policy, and `e2e/fixtures.ts` fails a test on any refusal it
  reports. They only see the pages they open, so a change to what a page loads still needs a look
  in a browser.

### Signing in through a provider

With `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` set, Agents is a client of an OpenID
Connect provider, through Better Auth's `generic-oauth` plugin
(`apps/web/src/server/auth/oidc-sign-in.ts`). What comes out of it is an account row and an
ordinary session, so nothing past the sign-in page knows the difference. It is how Gateweave Cloud
signs people in with Gateweave ID, and how a self-hoster uses their own provider: one path,
differing only by configuration. Track has the same code, and the same reasons.

- **Discovery waits until someone needs it.** The plugin's `init` waits for the provider's discovery
  document with no time limit, and every request to a new isolate waits for `init`, so a slow
  provider would stop password sign-in and every session check. Agents replaces `init` so that each
  isolate starts as the plugin does after a failed discovery, which it retries, within 10 seconds,
  for a request that names the provider. That sets a field of the plugin's that is not public, so an
  upgrade that moves it fails the tests rather than the deployment. The cost is one wait for the
  first person to use the button in each isolate.
- **Linking is never assumed.** The provider is not in `trustedProviders`, so an existing account
  links only when the provider says the address is verified and Agents' account has verified it too.
  Anything but a JSON `true` in `email_verified` counts as unverified, since some providers send text.
- **Agents keeps no tokens.** It signs people in and never acts for them at the provider, so the
  account hook clears them all, and the ID token too, as soon as it has served its purpose. The same
  goes for signing in with GitHub: the GitHub integration makes an exchange of its own. The client
  authenticates with `client_secret_basic`, which every provider has to take.
- **The provider can end sessions.** `POST /api/auth/backchannel-logout/oidc` takes a logout token,
  checked against the provider's keys: issuer, audience, at most 5 minutes old, the logout event and
  no nonce, which together keep an ID token from passing as one. A session row keeps the `sid` of
  the ID token it came from (`session.oidc_sid`, never sent to the browser), and a token naming a
  `sid` ends just those sessions, and only if they belong to the `sub` it may also name. A token
  naming only a `sub` ends everything of that person's, which is the safe side of a provider that
  cannot say which. Once a token has arrived it is seen through with `waitUntil`, even if the
  provider stops waiting. Keys that cannot be fetched at that moment get a 503 and end nothing: it
  says nothing about the token, and a provider tries a 503 again where it takes a 400 as final.
- **A chat left open stops at its next message.** `apps/web/src/server/chat.ts` checks the session
  when the socket opens and passes its id on; the conversation looks it up in D1 before each
  message (`apps/web/src/server/conversation.ts`), so a socket whose session ended, by this logout
  or any other way, is closed (4401) without its message reaching the agent. So is one whose person
  has left the workspace or been removed from it, which the same query sees. A turn already under
  way finishes, and an idle socket stays open until it sends. The page (`conversation-view.tsx`)
  puts the refused words back in the box and asks the gateway with `HEAD` whether a socket would open
  now. If so, it opens one and says the message was not sent. If not, it says why and leaves the
  words to copy: the session ended, with a link to sign in, or the conversation is out of reach. It
  asks the same when a socket drops, since a refused handshake looks like any other dropped socket
  and the library would retry it for ever.
- **Signing out of Agents stays in Agents.** The provider's session is left alone, as other apps
  signed in through it would expect, and `disableProviderLogout` keeps the plugin from sending
  anyone there.
- **A closed server may trust it.** While sign-up is by invitation, the owner can have anyone who
  signs in through the provider make an account, since it keeps its own list. See "Who owns a
  server" below.

### Who owns a server

**One account runs the server, and decides who else may make an account.** A row in `deployment` (one
row, `id` = 1) names the owner (`owner_id`), says whether sign-up is `open` or `closed`, and whether
the sign-in provider is trusted (`trust_provider`). A second table, `sign_up_allow`, is the owner's
list. `apps/web/src/server/auth/deployment.ts` asks, and the triggers in `0007_sign_up_hold.sql`
hold it. Track and Agents have the same shape, and ID's is the model.

- **A new server is open, so a self-hosted one changes nothing.** `0007_sign_up_hold.sql` makes the
  oldest account the owner of a server that has accounts, and leaves the owner empty on one that has
  none, where the first account becomes it (`first_account_owns_deployment`). D1 runs writes one at
  a time, so there is only one first. The owner closes sign-up on their account page, under "This
  server".
- **Closed means an address needs a way in.** The first account of a server with none; an address on
  the list, or at a domain on it; an address with a pending, unexpired invitation to a workspace,
  from any workspace's admin as before; or, where the owner trusts the provider, an account made
  through it. GitHub is never trusted that way. People who already have an account sign in as ever.
- **The list holds an address, lowercased, or a domain written with a leading `@`.** A domain covers
  addresses at exactly that domain, which is the part after the last `@`, and not its subdomains.
  Entries are checked with zod at the owner's endpoint (`apps/web/src/lib/sign-up-allow.ts`):
  trimmed, lowercased, a valid address or `@` and a valid domain name, which for a name with other
  letters is its punycode. A note of at most 200 characters is the owner's own. At most 5,000
  entries: the endpoint says so, and the trigger `sign_up_allow_is_capped` holds it when two adds
  arrive together. Taking an entry off lets no more people in; an account it already made stays.
- **Every path that makes an account asks.** `databaseHooks.user.create.before` in `auth/config.ts`
  covers email and password sign-up, GitHub, the sign-in provider and accepting an invitation (which
  follows making the account). `mayMakeAccount` is the one function that decides. A `before` hook on
  `/sign-up/email` asks first, so that Better Auth's "that address is taken" does not tell a stranger
  which addresses have an account: on a closed server an address with no way in hears the refusal
  whether or not it has one.
- **The database refuses the rest.** The trigger `user_needs_a_way_in` has the same rule for a path
  that forgets to ask, with a missing `deployment` row counting as closed. One part of the rule
  cannot be read from the user row: whether an account comes from the provider is known only when
  its sign-in is linked, which is after it. So the hook, which knows the route Better Auth ran
  (`signsInThroughProvider`: `/callback/:id` with the provider's id), writes a pass for the address
  in `sign_up_pass`, good for a minute, and only where the owner trusts the provider. With trust on
  the trigger lets an insert through only while an unexpired pass exists for `lower(new.email)`.
  `user.create.after` deletes it, and writing one deletes the expired. A path that skips the hook
  has no pass, so trust opens nothing for it.
- **The refusal says one thing for every address:** "This server takes new accounts by invitation.
  Ask whoever runs it to invite you." (`SIGN_UP_CLOSED`). For GitHub and the provider it comes back
  to `/login?error=SIGN_UP_CLOSED`, which the page words itself. With `SIGN_UP_REQUEST_URL` set to an
  https address, the sign-in page also shows "Ask for access" linking to it while sign-up is closed.
- **The owner's endpoints are Better Auth's `/deployment/...`.** To anyone but the owner they answer
  404 as if they were not there. Everything that changes something asks for a fresh session
  (`freshAge`, a day), since each lets others in and would outlast a stolen cookie. Listing takes a
  search and a page at a time (50), newest first, with whether an account with the address, or at
  the domain, exists yet.
- **The owner's account stays while sign-up is closed.** Without it a closed server would have nobody
  who can open it. The account page refuses with words, and `deployment_keeps_its_owner` holds it in
  the database. On an open server the account may go, and ownership passes to the earliest account
  left (`created_at`, then `id`) in the trigger `deployment_hands_over_its_owner`, which runs before
  the row goes so that the foreign key finds nothing to empty. Every account here is a person, so
  none is skipped. If none is left the owner is empty, and the next account becomes it. A server is
  never left without an owner while it has accounts.
- **Not here:** server invitations, and a rule that only the owner makes workspaces while closed. ID
  has both, because its apps trust whoever has an account. Here a workspace's admin may still invite
  any address, and that invitation is a way in.

## The registry

Each workspace's registry is a Durable Object with its own SQLite database (`RegistryDO` in
`packages/registry`, named by the workspace id). Pages read it through server functions; it is
not synced to the browser yet (see "Decisions" in the spec).

- **Access.** The registry has no route. A server function checks the caller's session and D1
  membership (`currentMember`), then calls the workspace's registry over RPC. Deleting a
  workspace deletes its registry too.
- **Data.** Projects group repositories, and a repository can be in several. Repositories are
  matched by the provider's own id, so a rename keeps their history. A scan of one repository at
  one commit lists the agents configured in it (Claude Code, Codex, and so on, and their
  subagents) and the assets they read: instructions, prompts, skills, plugins, scripts, MCP
  servers and settings. `packages/model` defines that contract, and the registry validates
  every call against it.
- **Content.** Files are stored once, by Git blob id, in a `blobs` table; files over 256 KiB keep
  their id and size but not their text. An asset's hash covers its files' paths, relative to the
  asset, and their blob ids, so the same skill or `CLAUDE.md` has the same hash in every
  repository. That is how drift shows: compare hashes. An asset gets a new version only when its
  hash changes, and each version records the commit it was found at.
- **Scans replace.** Applying a scan makes the repository's agents and assets match it, in one
  transaction. What it no longer finds is marked removed rather than deleted, and comes back
  with the same id if a later scan finds it. A scan older than the last one applied is ignored,
  so webhooks that arrive out of order cannot roll a repository back. A failed scan is recorded
  without touching what earlier scans found.
- **Room for the runtime.** Agents and assets may have no repository: those are agents defined
  in the app and assets in the library (phases 2 and 3). Runs have a table of their own (see
  "Runs"), and teams will too.

- **Deleting a workspace** (AGT-76). An owner deletes it in Settings > Workspace, after typing
  its name; Better Auth's organization plugin lets only an owner, and deletes its D1 rows
  (members, invitations, and its GitHub installation link, by cascade). The same D1 batch that
  deletes its row writes a note in `workspace_deletion`, so what it held elsewhere is deleted
  even when the request can't finish. Its `afterDeleteOrganization` hook then deletes that
  (`apps/web/src/server/workspace-deletion.ts`): each conversation the registry knows, nested ones
  too and those waiting to be destroyed, with its messages, traces and sandbox, ten at a time, then
  the registry's storage with its sealed keys and secrets. A workspace that moved
  ([below](#where-a-workspace-lives)) has objects in more than one place, and each is emptied, as
  is the deployment's own jurisdiction, where a first move that gave up leaves a copy no row
  records.
  Last, one batch deletes the location row, only as it was read, and the note, only when no
  location row is left: a move that recorded a new place meanwhile keeps both, and its copy goes
  on the next try. A conversation that fails is logged and the rest go on, but its registry
  stays, since it is what lists the conversations, and the note stays too; nothing is reachable
  meanwhile, since no member is left. The daily run, after the prune and before the moves, notes
  any location row whose workspace is gone, then finishes two notes a run, those never tried
  first; deleting a conversation or registry twice is harmless. Every try starts again from the
  registry's list, so a workspace with thousands of conversations can need more calls than one run
  has. A note for a workspace that still exists is dropped and nothing is deleted. The GitHub App installation stays on GitHub until
  someone uninstalls it there.

### Where a workspace lives

A Durable Object stays where it was made: near its first request, or in one of Cloudflare's
jurisdictions (`eu`, `us`, `fedramp`) if it was made through `namespace.jurisdiction(…)`. The same
name in another jurisdiction is another, empty object. So a deployment that keeps its data in one,
`DURABLE_OBJECT_JURISDICTION`, notes where each workspace's objects are, and moves the ones that
aren't there yet. Track does the same for its workspaces (TRK-129); this is AGT-115.

- **Where.** D1's `workspace_location` has a row for each workspace whose objects are in a
  jurisdiction. One with no row has them outside any, as every workspace did before the setting.
  Reaching a workspace takes its id and that jurisdiction (`WorkspaceRef`,
  `apps/web/src/server/workspaces.ts`): the membership lookup joins it, and `registryFor` and
  `conversationFor` (`apps/web/src/server/registry.ts`) reach the objects there. A path that knows
  only the id, such as a webhook, the wiki Workflow or an erasure, looks it up first
  (`findRegistry`). Inside, each object reaches the others in its own jurisdiction (`objectsIn`,
  `packages/registry/src/jurisdiction.ts`): a registry its conversations, a conversation its
  sandbox, its registry and the conversations it starts, a sandbox's outbound proxy its
  conversation.
- **New workspaces** get their row in `afterCreateOrganization`, before anything reaches their
  objects. If writing it fails, the objects are made outside, and the next move puts it right.
- **Moving.** The daily Cron Trigger moves up to three workspaces whose row says otherwise into
  the deployment's jurisdiction, the oldest first (`apps/web/src/server/move.ts`). A workspace
  with a turn or a wiki under way waits for another day. The objects do the copying, with one
  module for the registry and the conversations (`packages/registry/src/move.ts`): the registry
  freezes first, with triggers that refuse every write to its tables and its alarm waiting, and
  names its conversations. Each conversation freezes too, closing its sockets, and is copied,
  four at a time, with what its sandbox keeps (the repository it cloned, what it pushed, the
  CLIs' sessions); then the registry is. A copy is emptied and takes the source's tables, made
  from the source's own SQL where the code makes them on first use, as the Agents SDK does; then
  their rows a page at a time, tables others refer to first, with their rowids (a table made
  `WITHOUT ROWID` in primary key order); then the object's key-value pairs. Both ends count and
  hash every table's rows, each value as SQLite quotes it, and the key-value pairs, and the
  hashes must agree. Sealing the old registry commits the move. Then the old conversations seal,
  the new objects start, a conversation by restarting so that the Agents SDK starts it from what
  came over, and D1 notes the new place. A workspace is paused for the seconds this takes, and
  chats reconnect as after any closed socket.
- **Secrets.** The registry seals keys and secrets under its object's id (`secrets.ts`), and the
  same name in another jurisdiction has another id. So a registry that moves stores the id it
  began with among its key-value pairs, which go with it, and seals and opens under that.
- **When a move fails** before the seal, the old objects thaw and the workspace stays where it
  was, and the next day's run tries again. A freeze also lapses after ten minutes, so a move
  that dies half way leaves a workspace frozen for ten minutes at most. It holds through a
  restart: Cloudflare evicts an idle object, and on staging the registry restarted after half a
  minute of waiting while its conversations were copied. A move that dies
  after the seal leaves it out of reach until the next run, which finds the registry sealed and
  only finishes; its last steps are tried five times first. An object never takes a move's rows
  while it holds a workspace of its own.
- **The sealed objects** refuse sockets and writes and run no alarm as soon as they seal. Seven
  days after the move, the daily run erases the old registry, conversations and sandbox keys.
  Only the seals remain, so the old objects stay closed. An old conversation already emptied
  by deletion counts as done and is left untouched. The old registry records which conversations
  are done, so large workspaces can resume across daily runs without revisiting them. The daily
  run forgets old copies before it starts new moves, even if the deployment has unset its
  jurisdiction. A workspace can move again once its previous copy is gone. Workspace deletion
  also erases any copies still waiting, retrying a refused forget a few times and leaving the
  copy's registry, row and deletion note to the daily run when it still refuses, rather than
  dropping it. A
  conversation's own deletion erases what its sandbox keeps of it — the repository it cloned,
  what it pushed, the CLIs' sessions — through the conversation, which marks the sandbox as
  being erased first; an unmarked sandbox refuses to forget its keys, so no caller can wipe a
  live conversation's by mistake (AGT-156). A backup reads only where the workspace is now.
- **The sandbox meter** moves first: the new one takes the old one's readings, each workspace's
  larger figure and every share of the budget either one told of, then the old one is cleared.
  Rate limits are counted in the same jurisdiction; their objects don't move, so counts start
  again there.
- **The wiki Workflow** keeps its instances in a jurisdiction of its own setting in
  `wrangler.jsonc`, fixed when the Workflow is made. Gateweave Cloud's moved to new Workflows
  named `…-wiki-eu`.
- **Sandboxes' containers follow it.** A sandbox's container is started by its Durable Object,
  and under the `durable_object` scheduling policy Cloudflare runs it
  [where the object runs](https://developers.cloudflare.com/containers/concepts/placement/#jurisdictional-constraints),
  so the container, with the repository it holds and the commands it runs, is in the jurisdiction
  too. What a turn sends out goes where its destination is, such as pushes to GitHub and requests
  to a model provider. The Containers API lists each instance's location: Gateweave Cloud's have
  all been in EU data centers since the move. The
  jurisdiction does not cover where container images are stored; the sandbox's image is code.
- **Cost.** Each conversation takes about a dozen calls to its two objects, of the thousand a
  Worker on the Free plan may make to Cloudflare's services in one invocation (ten thousand on
  Paid); hence three workspaces a run. One that holds a repository's files (see "Files without
  a machine"; nothing makes one yet) takes about forty at the most it can hold.

Local runtimes have no jurisdictions (workerd says "not implemented"), so the tests move a
workspace between two names instead (`packages/runtime/test/move.test.ts` and
`packages/registry/test/move.test.ts`): to the move, the other objects are just other stubs.

### Deleting an account

People delete their own account on `/settings/account`, through
`POST /api/auth/account/delete` (`apps/web/src/server/auth/delete-account.ts`). Better Auth's
`/delete-user` stays off: it lets someone with a password through without it, and its hooks can only
remove a member from a workspace, which leaves their conversations.

- **What it asks for.** A session from the last day, and the password if the account has one. An
  account without one types its address in the page, which only guards against a slip. Better
  Auth's `/unlink-account` is disabled, because it removes a password on a recent session alone,
  which would let a stolen cookie get past that question. So are the other routes it offers any
  session and the app has no use for, such as `/verify-password`, which takes guesses at a
  password. The list is `disabledPaths` in `apps/web/src/server/auth/config.ts`, and
  `apps/web/src/server/auth/routes.test.ts` fails when an upgrade adds a route to what answers, so
  someone decides about it.
- **A closed server keeps its owner.** Whoever runs the server is refused while sign-up is closed,
  and `deployment_keeps_its_owner` holds it. See "Who owns a server". The owner's list of addresses
  stays when they go: it holds people who may have no account.
- **A workspace keeps an owner.** The only owner of a workspace is refused and told which, because
  a workspace with no owner has nobody who can fix it. The plugin and this endpoint both count and
  then act, so two owners leaving at once could each see the other still there. Two triggers on
  `member` hold it in the database, however a row comes to change, and they let go of a workspace
  that is being deleted. That needs the organization row to go first, so
  `beforeDeleteOrganization` deletes it and its members follow by cascade.
- **D1 goes in one batch.** It notes every workspace that has to forget the person in
  `pending_erasure` (ids only), deletes the user, and takes invitations addressed to them, along
  with the address in every audit log entry for an invitation sent to it. Foreign
  keys take the sessions, sign-ins, memberships and the invitations they sent. It is one
  transaction, so no account goes without that note, and a trigger's refusal leaves everything in
  place.
- **Each registry then forgets them.** A registry keeps ids and no names, so there is nothing to
  rewrite, and names come from D1, falling back to "A former member". Their conversations have to
  go, since each holds what they wrote and nobody else can open it. `forgetPerson`
  (`packages/registry/src/forget.ts`) takes the rows of the conversations they started, nested ones
  included, clears their runs' link to them and puts the ids in `conversations_to_destroy`, in one
  write. D1's note goes once that has answered. The same write removes the memories about them
  and those agents wrote in the runs they started ([Memory](#memory)).
- **The registry's alarm destroys them.** Ten per alarm, each with its messages, traces and sandbox.
  Each alarm has a subrequest budget of its own, so someone with hundreds of conversations is done
  in minutes on any plan. A row goes once its object has gone. One that fails is tried again a
  minute later, then twice as long each time, up to a day, for as long as it takes. Deleting the
  workspace meanwhile reaches those too, since `conversationIds` includes them. The SDK empties an
  object and then aborts it, and on Cloudflare the abort can reach the caller before the answer, as
  an error saying `destroyed`. That counts as done, for every caller
  (`destroyConversationObject`). Local workerd answers first, so only a deployed Worker shows this.
- **It is asked until it has answered.** The daily cron asks again for 20 `pending_erasure` rows, a
  number a Worker on the Free plan can reach, those never tried again and the ones tried longest ago
  first, so a run of them that keep failing does not keep the rest waiting. Asking twice finds
  nothing to do.
- **Workspaces they left count too.** Each keeps their conversations, which nobody could open. A
  trigger notes whoever leaves in `former_member` (ids only), however they came to leave, and the
  note goes with the account or the workspace. Workspaces someone left before v0.15 are not noted,
  so their conversations stay in those until someone asks whoever runs the server.

What stays, and the page says so before anyone confirms:

- Their runs, for the workspace's usage, under their id and shown as "A former member". A run holds
  counts and no words.
- What they set up for a workspace, because it is the team's: agents, triggers, model keys, secrets,
  telemetry settings, and MCP and GitLab connections, including tokens they connected. Taking those
  away would silently break the team's agents, so the page tells people to disconnect them first or
  revoke them at the service. A GitLab connection names the account it was made with.
- Conversations a trigger started, which name the trigger and were never theirs.
- Memories they typed on the Memory page about the workspace, an agent or a repository, under
  their id and shown as "A former member". Those about them go, and so does whatever an agent
  noted in a run they started. The audit log keeps the start of a memory's text from when it was
  added or remembered, unless it is about a person, until the entry is a year old.
- What already left: what model providers received, what telemetry sent, and what agents did on
  GitHub, GitLab or in Track.
- Point-in-time recovery, which Cloudflare provides and Agents does not control: 30 days back for a
  Durable Object, and for D1 30 days on Workers Paid or 7 on Workers Free. Restoring a state from
  before the deletion brings the person back with it.

### Audit log

Owners and admins see who changed the workspace, and when, in Settings > Audit log, newest first,
50 at a time. It covers how the workspace is set up, not the work done in it
(`apps/web/src/lib/audit-events.ts` lists every action):

- **People**: invitations sent and revoked, with the address; people joining, leaving and removed;
  role changes, from and to; the workspace renamed or moved.
- **Keys and secrets**: provider keys saved and removed, environment sets created and edited,
  secrets set and removed, telemetry turned on and off. Names only, never a value; a telemetry
  endpoint by its host.
- **Connections**: GitHub and GitLab connected and disconnected, a GitLab webhook's new secret,
  MCP servers added, edited, signed in and out (by host), triggers created, changed, deleted and
  given a new secret, and Track triage or Track work set up.
- **Agents, teams and setups**: created, changed (which fields) and deleted, and a setup's pull
  request opened or updated in a repository. An agent's pin moved by itself ("Use vN") is a change
  that names the pin's field alone and carries the asset's name and the versions it went from and
  to; one moved to where it already was is not logged.
- **Deletions**: projects and library assets.
- **Memory**: memories added, edited, approved, dismissed and deleted by people, and remembered
  and forgotten by agents, which are entries with no member that name the agent. The start of a
  memory's text at most, none of one about a person, and none of one deleted or dismissed; see
  [Memory](#memory).

Chats, scans, runs, replays and wikis are not in it. The registry is never told who asks, so the
log is a D1 table, `audit_event`, written by the Worker once a change has been made: by the server
function that made it (`auditFor` in `apps/web/src/server/audit.ts`), or for Better Auth's changes
to people, by its after hook (`apps/web/src/server/auth/audit.ts`), which reads what a change
replaced, a role or a name, in the before hook. A change that fails records nothing. A row that
cannot be written is logged and the change stands.

Each entry holds the member who made the change by id, and a label taken at the time, as what it
was done to may be gone later: a name, an invited address, a host. People are named when the log
is read, from the user table, so someone who deleted their account reads as "Deleted member".
Entries go with the workspace (they reference it), after a year (the daily cron), and an invited
address goes when the person it was sent to deletes their account (see above).

### Changing a name or password

People change both on `/settings/account`, through Better Auth's `/update-user` and
`/change-password`, and what stands behind either may be a stolen cookie. The rules are in
`apps/web/src/server/auth/account-changes.ts` and the hooks of `config.ts`.

- **A rename takes a name and nothing else:** 1 to 100 characters once trimmed, which sign-up keeps
  to as well. The route would otherwise set a picture too, whose address everyone in someone's
  workspaces fetches. It allows ten a minute. Pages read a name from D1, so nothing else holds a
  copy to tell.
- **A provider's name is taken once.** GitHub's or an OpenID Connect provider's name fills in a new
  account and is not read again, so a name changed here stays.
- **A new password needs the current one,** at five tries a minute from one client address, and
  sends the person an email, which may be how they first hear that someone else has it.
- **Tries at a password are also held per person,** since a stolen cookie can be sent from many
  addresses (`apps/web/src/server/auth/password-tries.ts`). This and deleting an account share an
  allowance of 10 at once, refilling over an hour, within 30 that refill over a day. Only a request
  with a session for that account spends it, so nobody can lock a person out with their address
  alone, and signing in is not part of it. Whoever holds the cookie can spend it, but a password
  reset asks for no session, and the account page can end every session with no password, including
  the one a stolen cookie may be a copy of. When it runs out the person gets an email saying so and
  what to do, at most once a day and only at an address they have verified, because anyone can sign
  up with a stranger's. The refusal does not wait for it.
- **It ends every session,** whatever the request asks, since whoever knew the old password may be
  why it is changing and may be the one asking. Better Auth makes a new session for the browser that
  asked, which keeps the `oidc_sid` of the one it replaced, because it came from the same sign-in at
  the provider and a logout token still has to reach it. A chat left open in that browser refuses
  its next message like any other whose session ended, then gives the words back and goes on with
  the new session.

## GitHub

A workspace reads its repositories through a GitHub App ([github-app.md](github-app.md) sets one
up). `packages/github` is the app's client: a JWT signed with WebCrypto, installation tokens
cached per isolate, the OAuth web flow with PKCE, and webhook signatures. It needs nothing but
`fetch` and `crypto.subtle`, so it runs in workerd without Node polyfills.

- **Linking.** A `github_installation` row in D1 links an installation to one workspace. An
  admin links it through install, setup and callback (`apps/web/src/server/github/flow.ts`).
  The installation id that GitHub's setup redirect carries is not trusted: the link is made only
  after a user token shows that this person controls the installation's account on GitHub
  (`controlsInstallation` in `packages/github/src/app.ts`). For a personal account, that is the
  account's own user (`GET /user`); for an organization, an active admin of it
  (`GET /user/memberships/orgs/{org}`, which needs the app's "Members: read" organization
  permission). Being able to see the installation is not enough: `GET /user/installations`
  lists it for anyone with access to one of its repositories, read-only collaborators included.
  Everyone else gets the same refusal as for an installation they cannot see. The token is not
  kept.
- **Writing.** Commits, branches and pull requests through the REST API
  (`packages/github/src/writes.ts`), for applying setups. `commitChanges` there is called only
  by the files store, which nothing uses yet (AGT-122): it puts a change on a branch with no git, from a base commit, the files that
  differ and the paths that are gone. A file keeps its mode, and a symlink or a submodule is
  never written over. A truncated listing cannot reach it unnoticed: its `base` is the commit,
  the tree and the whole answer of `readTreeEntries`, `truncated` included, and a base whose
  listing GitHub cut short is refused (`truncated`) before anything is asked. The branch is
  never the default branch, must be where its caller left it and is never forced, and each refusal is a
  value: nothing to commit, the branch moved, a base the branch does not follow from, a path
  that cannot be written, or GitHub's own no with its status. `paths.ts` holds the path rules:
  no name a Git client refuses or that Windows or macOS reads as `.git` or `.gitmodules`, and
  `commitChanges` adds that a new path may not differ only in case from one that is there.
  `readTreeEntries` and `readBlob` in `contents.ts` read what it needs: every entry's mode, and
  one blob's exact bytes under a size limit, asked for raw so nothing is decoded.
  - **The branch's move is not a compare-and-swap, so the expected tip is not enforced
    atomically.** GitHub's REST API moves a ref with no "only if it is still at", and unforced
    it checks only that the move is a fast-forward. A reset of the branch to an ancestor of
    the expected commit, between `commitChanges`' look and its move, is not detected: the move
    succeeds and the commits that were dropped are back. A commit someone added is never lost.
  - **A lost answer is not a lost write.** When the ref's write fails in any way, a refusal
    or a connection that breaks even after the answer's headers came, the branch is read
    again: at the new commit the change is reported as made.
  - **A file is not replaced by a folder, or the reverse, in one change**; that is refused,
    whether the other path is in the repository or in the same change (`new` beside
    `new/page.md`), and both are named.
  - **The tests' stand-in for GitHub** (`test/fake-git.ts`, exported as
    `@gateweave/agents-github/testing`) refuses a wrong or read-only token, an empty
    repository's Git database (409), a tree on an unknown base, a malformed or `.git` path, a
    deletion of what is not there, a commit on an unknown parent, a branch name Git would not
    take, a branch that exists and a move that is not a fast-forward. What GitHub itself does
    is unknown until tried against it for: a workflow file from a token without the Workflows
    permission (which request fails, and how); and the names `paths.ts` refuses, which GitHub
    may well take. `commitChanges` asks GitHub for neither.
- **Staying in step.** Linking, and webhooks for installation and repository changes, list the
  installation's repositories and reconcile them into the registry: new ones appear, renamed ones
  keep their history (they are matched by GitHub's id), and ones the app no longer reaches are
  marked removed. Uninstalling the app, or disconnecting it, removes them all. Webhooks are
  verified with the app's secret; deliveries for installations no workspace linked are
  acknowledged and dropped.

## GitLab

A workspace can also read the projects of a GitLab, gitlab.com or a self-managed one (AGT-79).
GitLab has no app to install, so an owner or admin connects it on Settings > GitLab with an
access token: a project, group or personal token with `read_api` and `read_repository` and at
least the Reporter role. The client is `packages/registry/src/gitlab/client.ts`; the connections
are `gitlab_connections` rows in the registry (`gitlab/connections.ts`).

- **The token is a secret of the workspace.** The registry tries it (`GET /user`), seals it with
  `secrets.ts` and opens it only to read repositories. The page shows its last four characters.
  Requests send it in `PRIVATE-TOKEN` to the connection's own address only, with redirects
  refused, so it cannot be led elsewhere; the address must be https.
- **Projects are repositories.** The projects the token's user is a member of with Reporter
  access, not archived or empty, become repositories with `provider: "gitlab"`, the connection's
  id as their `installationId` and their page as `webUrl`, made from the connection's address so
  a link only ever leads to that GitLab, reconciled as an installation's are. GitLab numbers projects per instance, so a repository's `externalId` is the host and the
  project's id (`gitlab.example.com:42`). Listing them again is a button on the page.
- **Scans read what GitHub's do.** The branch's head, the commit's tree (keyset pages of 100, at
  most 20,000 entries) and raw blobs, a few at a time. The tree gives Git's blob ids, so files and
  assets hash the same as on GitHub. It gives no sizes: a blob too large or binary is found when
  it is read.
- **A push webhook rescans.** The page shows the webhook's URL
  (`/api/gitlab/webhooks/:workspaceId/:connectionId`) and, once, its secret token, which the
  registry keeps sealed. GitLab sends it in `X-Gitlab-Token`. The gateway
  (`apps/web/src/server/gitlab.ts`) turns away unknown workspaces, and the registry compares the
  token in constant time before reading the event; a mismatch gets the same 404 as a missing
  connection. A push to the default branch queues a scan.
- **Not yet.** Setups are applied by pull request, and sandboxes check out through the GitHub
  App, so both offer GitHub repositories only and say so for GitLab ones. Merge requests come
  next.

## Format adapters

`packages/adapters` turns a repository's files into the agents and assets of a scan. It is pure
TypeScript with no I/O, so it runs in the Worker. The scanner lists the repository's tree, asks
`wantsFile` which paths it needs, downloads those, and calls `detect`.

- **One adapter per coding agent** (Claude Code, Codex, Gemini CLI, Cursor, GitHub Copilot and
  Devin), each knowing only its own files, so a repository with just `AGENTS.md` has a Codex agent
  and nothing else. The vendor's documentation is linked at the top of each adapter.
- **GitHub Copilot and Devin** are scanned (AGT-69) and written (AGT-74).
  - **Copilot** reads `.github/copilot-instructions.md`, `.github/instructions`, prompt files,
    custom agents and chat modes, `.vscode/mcp.json` and `.github/skills`. A setup gives it
    `AGENTS.md`, which it reads anywhere, its own path-specific instructions back in
    `.github/instructions`, the shared `.agents/skills`, and `.vscode/mcp.json` (servers under
    `servers`, variables as `${env:NAME}`).
  - **Devin** reads `.devin/rules`, `.devin/global_rules.md`, `.devin/config.json`, and Windsurf's
    rule files, which Devin Desktop took over from Windsurf. A setup gives it `AGENTS.md` only.
    Its MCP servers live in a file its docs keep out of Git, and its docs name no folder for
    skills, so a setup reports both as not written for it. A scan lists Devin once the repository
    has a file of Devin's own.
- **Shared files are shared assets.** `detect` merges what the adapters find by asset key, so
  `AGENTS.md` or a `.agents/skills` folder is one asset that several agents read.
- **Secrets stay in the adapters.** Settings and MCP configuration are stored as canonical JSON
  (or TOML) with every value under `env` or `headers`, and anything that looks like a credential,
  replaced by `<redacted>`. Metadata carries the names of variables and headers, never values.
- **A Claude Code plugin is its root folder**, the parent of `.claude-plugin/`, because its
  commands, agents, skills and hooks live beside the manifest and a change to them must change
  the asset. Files are given by blob and size; only `.claude-plugin/*.json`, `.mcp.json` and
  `hooks/hooks.json` keep their (redacted) text. Another plugin's folder is never part of a
  plugin, and a plugin at the repository root takes only the documented component locations (and
  the paths its manifest names), not the whole repository. A root plugin is keyed
  `.claude-plugin`, since a path cannot be empty.
- **Problems, not exceptions.** A file that is missing its text or does not parse becomes a
  `ScanProblem` and is skipped; the rest of the scan goes on.
- **Writers are the reverse of `detect`.** `writeAssets(assets, runtimes)` turns library assets
  into the files to put in a repository, in each agent's own format. It is pure and
  byte-stable: sorted keys, `\n` newlines, one trailing newline, files sorted by path, and the
  same output whatever order the input came in, so drift detection can compare Git blob ids with
  a later scan. It returns `{ files, problems }`; an asset it cannot write whole is reported and
  skipped, never written in part.
  - _Instructions_ go back to the path in their name. Per folder, the shared text is combined in
    name order into `AGENTS.md` (Codex, Cursor). `CLAUDE.md` and `GEMINI.md` import it
    (`@AGENTS.md`, `@./AGENTS.md`) when another agent reads `AGENTS.md` too, and hold the text
    themselves otherwise. Cursor rules (`alwaysApply` in the metadata) become `.cursor/rules/*.mdc`
    and `.claude/rules` files stay Claude Code's; other runtimes ignore both.
  - _Skills_ go to `.claude/skills` for Claude Code and `.agents/skills` for Codex, Gemini CLI and
    Cursor, in a folder named after the `name` in `SKILL.md`, so a library can call a skill anything.
  - _MCP servers_ go to `.mcp.json`, `.codex/config.toml`, `.gemini/settings.json`,
    `.cursor/mcp.json` and `.vscode/mcp.json`. A stored server is converted between formats. The registry keeps
    `<redacted>` where a secret was, so the writer writes a reference to an environment variable
    instead (`${NAME}`, `${env:NAME}`, Codex's `env_vars` and `env_http_headers`), named after the
    `env` entry or header. A `<redacted>` anywhere else has no name to point at, so that server is
    reported and left out. No file ever contains `<redacted>`.
  - _Not written_ (reported as problems): `settings`, `prompt`, `script`, `env-set` and `plugin`.
- **Applying is planned, not guessed.** `planApply` decides how those files land in a repository
  (pure, like the writers): files it owns are replaced, symlinks and non-folders in the way are
  reported and left alone, and in the five MCP configuration files only the setup's own servers
  are merged in (under `servers` in VS Code's, `mcpServers` in the other JSON ones), so a
  repository's other servers and settings survive.

## Scans

Each workspace's `RegistryDO` scans its own repositories. Requests wait in its SQLite database
(`scan_requests`), and its alarm works through them a few at a time.

- **What asks for a scan.** A push to a repository's default branch (the webhook), and a
  reconcile that finds a repository new, back after removal, on another default branch or never
  scanned. Asking again while a request waits moves it to the front.
- **What a scan reads.** The default branch's head and its whole tree, then the text of the
  files the adapters want (`wantsFile`), fifty blobs per GraphQL request. Texts the registry
  already holds, by blob id, are not downloaded again, so a scan after a push downloads what the
  push changed. A wanted symlink, such as `CLAUDE.md` pointing to `AGENTS.md`, is read as its
  target. A head the last successful scan already read is not scanned again, unless a member
  asks with "Scan now", which forces a read for after the adapters learn something new.
- **What a scan records.** Besides agents and assets, every file it read: path, blob id, size and
  whether it is a symlink (`repository_files`), with the text of each new one kept by blob id.
  Every file a setup writes is one the adapters want (a test in `packages/adapters` holds the
  writers to it), so drift needs nothing else. Only files that changed since the last scan are
  written.
- **Writes stay synchronous.** A scan awaits GitHub outside any transaction, then validates the
  result like any other scan and applies it in one. A failure is recorded on the repository and
  tried again after a minute, ten minutes and an hour; what earlier scans found stays.

## The library

The library is the workspace's own copy of the skills, prompts and configuration it wants to
keep: assets with no repository (`packages/registry/src/library.ts`).

- **Adding.** An owner or admin adds a repository asset's current content, as a new library asset
  or as the next version of one of the same kind. Content the library asset already has as its
  latest version adds nothing. A library asset is keyed by its kind and name, and a name is
  unique among the library's live assets of that kind.
- **Writing.** An owner or admin can also type a library asset in the app: an `instructions`,
  `prompt` or `skill`, one text file each. The file is named as a scan names the same file
  (`AGENTS.md`, `SKILL.md`, and `<prompt name>.md`), and its blob id and the asset hash are computed
  the way a scan does, so a repository carrying that text counts as a use.
- **Editing.** On a library asset's page, an owner or admin edits the text of any file the registry
  kept (up to 256 KiB each) and saves it as the next version. A version is added only when the
  asset hash changes. A skill's description follows its `SKILL.md` front matter. Repository assets
  cannot be edited: the repository is the source of their text.
- **Uses come from content.** A repository asset uses a library asset when its hash equals one of
  that asset's versions, and is behind when that version is not the latest. Nothing links them,
  so a file copied by hand counts the same as one a setup will write, and a repository that
  changes its copy stops counting at its next scan.
- **Removing** marks the library asset removed, frees its name and leaves repositories alone.

## Setups

A setup is a set of library assets, each pinned to one of its versions, for the coding agents it
configures (`packages/registry/src/setups.ts`). Owners and admins manage them.

- **Pins move by hand.** A new version in the library shows on the setup as an update, and the
  setup keeps writing the pinned version until someone moves the pin. An asset that leaves the
  library keeps its pin, since its versions are kept, but cannot be pinned anew.
- **The preview is the writers' output.** The registry reads each pinned version's files and
  runs `writeAssets` from `packages/adapters` for the setup's coding agents, so the page shows
  exactly the files a setup writes, and what it cannot write and why.
- **Ready-made setups are folders.** `setups/<slug>/` at the repository root holds a
  `setup.json` and the files of its assets (see `setups/README.md`). The app bundles them into
  the Worker as text (`apps/web/src/server/ready-made.ts`) and reads each with `readSetupFolder`.
  Tests in `packages/adapters/test/ready-made.test.ts` hold every folder to the same rules: it
  reads, writes cleanly for its coding agents, is found again by `detect`, and carries no secret.
- **Adding one is one write.** `importSetup` runs in a single transaction: for each asset it
  reuses the library asset of the same kind and name when one of its versions already has these
  files, adds a version when the files differ, and creates the asset otherwise. It then creates
  a setup pinning the result. Adding the same setup twice therefore makes no new versions. An
  owner or admin reaches it from the Setups page.
- **A setup can ask for an address.** A self-hosted MCP server, such as Gateweave Mail's, is at
  a different address in every install, so its asset in `setup.json` has an `askUrl`, and its
  file holds an example. Whoever adds the setup gives the address (a dialog on the Setups page,
  `--url <server>=<url>` in the CLI), and `withAddresses` writes it into the server's file before
  anything else reads it. The address must pass `mcpServerUrl`, as a server written in the app
  does. Adding the setup again with another address makes a new version of that server only,
  which setups pinning the older one are then offered as an update: a workspace keeps one address
  for each server name.

## Applying setups

Applying a setup to a repository opens a pull request (`packages/registry/src/apply.ts`). Owners
and admins apply them, and [github-app.md](github-app.md#applying-a-setup) has the user's view.

- **The default branch is never written.** The registry reads its head, plans the files with
  `planApply` from `packages/adapters`, commits them on top of that head with a tree based on the
  head's (so no other file changes), and points a new `gateweave/<setup>-<id>` branch at the
  commit. Files go into the tree as content, so a commit is two requests however many files it
  changes. Shared configuration files are merged, not replaced, and their text comes from the
  registry's blobs when the last scan kept it. Any other file is compared by Git blob id and never
  downloaded.
- **Each application is a row** in `setup_applications`: the repository, the setup, the pins, the
  files it leaves the setup owning (by blob id, for drift), the branch and commit, and the pull
  request with its state. Every GitHub outcome is written in a transaction of its own as soon as
  it is known, never across an await.
- **Applying again** with the pull request still open checks it on GitHub first. If it was merged
  or closed without a webhook saying so, the row catches up and a new pull request is opened. If
  someone else pushed to its branch, the registry refuses. Otherwise a new commit replaces the
  branch's, and nothing happens when the open pull request already writes the same files.
- **Refusals are answers.** `applySetup` returns `{ status: "refused", message }` instead of
  throwing: an error loses its class on its way out of the Durable Object, and the message is meant
  for the person who asked. One setup is applied to one repository at a time per instance.
- **A merge queues a forced scan** of the repository, whether a webhook or applying again
  reported it. It is forced because the push's own scan may have read the merge before the merge
  was recorded, and an unforced scan skips a head it has read.

## Drift

Drift is how a repository compares with a setup merged into it (`packages/registry/src/drift.ts`).
It is computed when a page asks, from what the registry already holds, so it cannot go stale and
needs no GitHub request.

- **The baseline** is the newest merged pull request that applied the setup there, with the files
  it left the setup owning, by blob id. A later pull request that is still open is shown beside
  it, and one closed without merging changes nothing.
- **The comparison** plans the setup's current files against the files the last scan recorded,
  with `planApply`, exactly as applying it again would. Each file that plan would change is
  **behind** when the repository still holds what the merge left (or the setup did not own the
  file then), **changed** when it holds something else, and **missing** when the file is gone. A
  file the setup owned that applying would now leave alone, such as one replaced by a symlink,
  is changed too. In a shared configuration file only the setup's own servers count, so a server
  someone else added there is not drift.
- **The state** of a setup in a repository is its most urgent file's: missing, changed, behind,
  then in sync. Until a scan has read the merge it is **unscanned**, rather than every file
  looking missing. A repository's state in the lists is the most urgent of its setups'.
- **Applying again** from either page opens a pull request, or updates the open one, through the
  same dialog as **Apply**.

## Model providers

A workspace brings its own keys for the model providers its agents use (Anthropic, OpenAI and
Google), so usage is billed to the workspace's accounts. An owner or admin adds them on the
Models settings page. **Workers AI** is the exception: it needs no key of the workspace's (see
"Workers AI" below). Everything about keys (saving, sealing, checking) takes only the three keyed
providers, `KEYED_PROVIDERS` in `packages/model/src/vocabulary.ts`; `MODEL_PROVIDERS` is those
and Workers AI, for what an agent definition may name.

- **Sealed in the registry.** A key is encrypted with AES-256-GCM before it is stored, under a
  key derived with HKDF from one of the server's secrets and the workspace's Durable Object
  id, with the key's place as additional data (`packages/registry/src/secrets.ts`). A key sealed
  in one workspace does not open in another, and a sealed value copied to another row does not
  open there either.
- **Which secret.** `SECRETS_KEY` when it is set, and a sealed value then starts with `v1`. A
  server without one derives from `BETTER_AUTH_SECRET` (HKDF again, under a salt of its own, so
  the key is unrelated to anything else made from that secret) and its values start with `d1`, so
  that a first deploy keeps secrets with nothing more to set. The id at the start picks the key
  that opens a value: a server that gets a `SECRETS_KEY` later seals with it from then on and
  still opens its `d1` values while `BETTER_AUTH_SECRET` stays the same. A `SECRETS_KEY` that
  is set but unusable is reported and never passed over for the derived key.
- **Sealed again on use.** On a server with a `SECRETS_KEY`, a `d1` value that opens is sealed
  with it and written back over the value it was opened from (`#open` in the registry, and
  `replaceSealed` in `packages/registry/src/sealed.ts`, which lists every sealed column and
  matches by the old value, so one replaced meanwhile is left alone). Values not used since stay
  `d1`. The registry's `sealedCounts` says how many of each a workspace holds; no page shows it.
- **When a workspace keeps none.** `secretsProblem` decides, for the registry and the pages
  alike (the registry's `secretsState`). The server has no key to seal with: an unusable
  `SECRETS_KEY`; or none, and a `BETTER_AUTH_SECRET` that is under 32 characters or under 120
  bits by the estimate Better Auth warns with, written out there; or none, and
  `SECRETS_FROM_AUTH_SECRET` set to `off`, which keeps a server from deriving a key at all. Or
  the key is lost: the workspace holds `v1` values and the server has no `SECRETS_KEY`. Then
  nothing is sealed under the derived key and nothing opens, and the pages say that the key has
  to be put back, because sealing new values beside ones that cannot open would hide it.
- **Only the registry opens one**, when a request needs it. Server functions get the provider,
  the last four characters, who added it and when, and the last check, never the key.
- **Checking a key** lists the provider's models with it (`listProviderModels` in
  `packages/registry/src/providers.ts`) and records whether that worked, how many models there
  are, or the provider's refusal in a sentence. A check that finishes after the key was replaced
  is dropped.
- **Changing the secret loses the keys**: `SECRETS_KEY` for what it sealed, `BETTER_AUTH_SECRET`
  for what the derived key sealed. A check then says the key cannot be opened, and it has to be
  added again; nothing throws past the registry. A `SECRETS_KEY` that is taken away is the case
  above, and putting it back restores everything.

### Workers AI

Workers AI models run on Cloudflare's own GPUs and cost the workspace nothing directly: the
**deployment pays** through its Cloudflare account, and only when it opts in. Gateweave Cloud's
production leaves it off for now; a self-hoster turns it on.

- **Turning it on** takes a secret `WORKERS_AI_TOKEN` (a Cloudflare API token with the Workers AI
  permission, never in `wrangler.jsonc`) and the account that pays: the var
  `CLOUDFLARE_ACCOUNT_ID`, or else the account in `AI_GATEWAY_URL`. Without both, Workers AI is
  not offered, and says so: the agent dialogs label it "(not on this server)", Settings > Models
  says the server does not offer it, and a turn of an agent that uses it is refused up front with
  "This server does not offer Workers AI". `workersAiOffered` in `packages/model/src/workers-ai.ts`
  decides, for the registry, the runtime and the app alike.
- **No key.** Workspaces never save one, and Settings > Models has no key form for it. The
  registry's `beginTurn` hands the runtime `key: null` for it; the runtime reads the token and
  account from its own environment. The token is never stored, never returned by a server
  function and never in a page; the registry only sees whether it is set.
- **Reached by URL**, like AI Gateway, because the `AI` binding always calls Cloudflare. The
  runtime uses Cloudflare's OpenAI-compatible REST API through `@ai-sdk/openai-compatible`
  (`packages/runtime/src/models.ts`): `https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1`,
  `Authorization: Bearer <WORKERS_AI_TOKEN>`, with `includeUsage` on. With `AI_GATEWAY_URL` set,
  the request goes to the same URL with a `cf-aig-gateway-id` header naming the gateway, plus
  `cf-aig-metadata` and (for an authenticated gateway) `cf-aig-authorization`, as for the other
  providers.
- **Usage.** Streamed, every chunk carries a `usage` object with that chunk's increment, and the
  last chunk before `[DONE]` carries the totals for the request, which is the one the AI SDK
  keeps. A test pins this shape, so a change in the SDK cannot silently undercount.
- **Models** are Workers AI's own ids, such as `@cf/meta/llama-4-scout-17b-16e-instruct`. The
  lists in the agent dialog and on Settings > Models come from the catalog
  (`GET /accounts/<account>/ai/models/search?task=Text Generation`, in
  `packages/runtime/src/workers-ai.ts`), made with the deployment's token and keeping the models
  whose `function_calling` property is `"true"`, because agents need tools. Any id can still be
  typed.
- **Prices** for eight models are in `MODEL_PRICES` (`packages/model/src/prices.ts`), from each
  model's page. Other Workers AI models get no estimate, as an unlisted model of any provider
  does. A model Cloudflare is removing keeps its prices until that day (`until`), because it
  answers until then and a run without a cost would not count toward `WORKERS_AI_DAILY_DOLLARS`;
  `pricedModels`, which the demo lists, leaves it out.
- **Removed models.** Cloudflare retires models, and a request for one then fails with HTTP 410
  and error 5028. `WORKERS_AI_REMOVED` (`packages/model/src/workers-ai.ts`) lists the ones it has
  announced, with the day: the lists above leave them out, their prices end that day, and no dialog or
  page suggests one, which `apps/web/src/lib/removed-models.test.ts` checks across the
  repository. An agent still set to one keeps its model: `describeFailure` turns the 410 or the
  5028 into "Cloudflare removed … from Workers AI on 20 November 2026. Choose another model in
  the agent's settings." Nothing switches it, in code or in a migration, because an owner or
  admin chose the model and another costs something else.

## Agents run by Gateweave

Owners and admins define agents in the app (runtime `gateweave`). Each one is a row in `agents`,
with no repository and its own id as its key, and a row in `agent_definitions` beside it
(`packages/registry/src/definitions.ts`).

- **The model** is a provider and the provider's id for it. The form lists the models the
  workspace's key can use (`listModels`), and takes any id, so an agent can be defined before the
  key is added.
- **Instructions** are a library asset of kind instructions or prompt, pinned to a version as a
  setup's assets are, and all text. The agent reads it through `agent_assets`, so the asset's
  page lists the agent. A new version in the library changes nothing until someone moves the pin.
  "Use vN" on the agent's page moves it with `moveAgentPin`, which takes the asset and the
  version and nothing else: `updateAgent` takes the whole definition and fills what is missing
  with the schema's defaults, so a page that sent the agent back to move a pin reset whatever it
  left out. The form's Save, which is a whole save, starts from `inputOf`
  (`apps/web/src/lib/agent-input.ts`), whose test fails when the schema has a field it does not
  carry.
- **MCP servers** are pinned like instructions, each optionally limited to some of its tools (see
  "MCP servers"). The form offers the tools of the server's last check on the MCP page; a server
  never checked keeps the list its pin has and says to check it first, so saving the form never
  drops a limit it could not show.
- **A sandbox**, off by default, gives each of the agent's conversations a Linux machine to run
  commands and edit files in (see "Sandboxes").
- **Memory**, off by default, gives its turns the tools that write to the workspace's memory and
  recall from it (see "Memory").
- **Files only** (`files`, off by default; AGT-122) is for turns that read and edit a
  repository's files and open pull requests without a sandbox, and run nothing. It ships dark:
  the registry keeps the setting and its rules, no form offers it, and no turn has file tools
  yet. The setting is one appended boolean beside `sandbox`, so an agent has `files`, a sandbox
  or neither, and an agent saved before it reads as it did.
  - **On save**: `files` with `sandbox` is refused by the input schema
    (`agentDefinitionInput`), the one rule that needs no registry. The registry refuses `files`
    without a repository ("Files only works on a repository"), since there is nothing else for
    such a turn to work on. An engine other than Gateweave's loop, and an MCP server that runs
    as a local command, are refused as they are for any agent without a sandbox, in the same
    words. A repository still needs `sandbox` or `files`, so a client that knows nothing of the
    setting and sends the repository alone is told why. One that sends neither, as a page
    loaded before the form carried every field (AGT-135) does for an agent without a sandbox,
    saves the agent with the setting off and no repository. A repository on GitLab is refused in
    the setting's own words, not a sandbox's.
  - **In the app**, the form still has no control for it. An edit starts from the agent as it is
    (`formInput` in `apps/web/src/lib/agent-input.ts`), so an agent that has `files` keeps it
    and its repository through one; giving it a sandbox there turns `files` off, since it has
    one or the other. Moving a pin (`moveAgentPin`) takes the pin alone, so it keeps both, and
    refuses a version of an MCP server that runs as a local command, as for any agent without a
    sandbox. It is not a turn, so the deployment's setting below has no say in it.
  - **A turn** (`beginTurn`) with `files` asks for no sandbox: `sandboxOfferTo`, the workspace's
    sandboxes, the day's minutes and the month's budget do not decide, `runs.sandbox` stays
    false, and the run counts no sandbox time. It carries `files: true`, the repository, and
    `steps`, 40 (`MAX_SANDBOX_STEPS`), since its work goes in many small steps too. An ask over a
    team's edge has no tools, so it has no files either. The snapshot and the turn leave `files`
    and `steps` out when they do not apply, so both are what they were for every other agent.
  - **Until the runtime reads it**, a deployment refuses such a turn ("This server does not run
    agents on files without a sandbox yet") unless it sets `FILES_ONLY_RUNS` to the text `1`,
    which nothing does; a number or anything else is off. A deployment that set it now would get a turn without file tools, which is why
    it is off: an agent told it can edit files should not answer as one that cannot. A server
    that runs no sandboxes still refuses an agent with `sandbox`; it never falls back to files.
- **A turn reads one snapshot** (`agentSnapshot`): the model and the pinned instructions' text, in
  one synchronous read, so a turn never mixes two versions of an agent.
- **Removing an agent** marks it removed, as scans do, so its id stays known to whatever names
  it later, such as runs.

## Environment sets

An environment set is what an agent run by Gateweave runs with: variables and secrets. Owners and
admins manage them on the Environment page (`packages/registry/src/environment.ts`).

- **A set is a library asset** of kind `env-set` with one file, `environment.json`:
  `{ "variables": { "NAME": "value" }, "secrets": ["NAME"] }`. Names match `^[A-Z_][A-Z0-9_]*$`,
  there are at most 200 entries, and a name is a variable or a secret, never both. The registry
  writes the file with sorted keys, so the same content is the same bytes: an edit that changes
  nothing makes no version, and variables are versioned, shown and diffed like any asset. Secret
  values are never in the file. A set cannot be edited as plain files or copied from a
  repository, which would bypass those rules.
- **Secret values** are sealed (see "Model providers") in `env_secrets`, with the place
  `env-sets/<asset id>/<name>`. They belong to the set, not to a version, so moving a pin keeps
  them. A value can be set only for a name that is a secret in the set's current version. When an
  edit drops a name, its value is kept and shown as unused until someone removes it, so a typo
  fixed back finds its value again.
- **An agent picks one set**, pinned to a version like its instructions (`agent_definitions`,
  and `agent_assets` for the asset's page). A new version changes nothing until the pin moves.
  `agentSnapshot` does not carry it.
- **The runtime opens it.** The registry's private `#openEnvironment(agentId)` opens the pinned
  version's variables and secrets, with the names that have no value (or whose value no longer
  opens) as `missing`. No RPC returns what it opens: values leave the registry only in an MCP
  server's headers, through `turnServers`, for `beginTurn` and `mcpCheckTarget`. Pages and
  server functions only see `set` or `missing`.
- **On a server that cannot keep secrets** (see "Model providers") the page says so and values
  cannot be set; sets with only variables work as they are.

## MCP servers

An agent run by Gateweave gets its tools from MCP servers in the library
(`packages/registry/src/mcp-servers.ts`): remote ones, and, for an agent with a sandbox, ones that
run as a local command.

- **A server is a library asset** of kind `mcp-server` with one file, `.mcp.json`, holding one
  server in the shape Claude Code reads: `{ "headers": {…}, "type": "http" | "sse", "url": "…" }`,
  written with sorted keys so the same settings are the same bytes. Owners and admins add one in
  the library or copy one a scan found. Its settings are edited in a form, not as text, so the
  rules below always hold, and saving the same settings makes no version.
- **No secret in the file.** The URL is https (plain http only for the machine itself), with no
  user, query or fragment, which is where tokens hide. Each header's value names a variable of
  the agent's environment set, as in `Bearer ${API_TOKEN}`, with only text before it. A scan
  keeps no header values at all, so a copied server's headers read as variables named after
  them, and Codex's `bearer_token_env_var` as an `Authorization: Bearer` header
  (`readMcpConnection` in `packages/adapters`).
- **An agent pins up to ten servers**, each to a version like its instructions
  (`agent_mcp_servers`, and `agent_assets` for the asset's page). Pinning refuses a server the
  runtime could not reach: one whose URL breaks the rules above, or one that runs as a local
  command, for an agent without a sandbox. The agent's page shows each server's transport and URL,
  or its command, or why it cannot be reached, and the variables its headers (or its command's
  environment) use, each marked set or missing in the agent's environment set.
- **A pin can limit the agent to some of the server's tools** (`tools` on the pin, a JSON list of
  the server's own tool names; null is all of them). An agent that reads text nobody vetted, such
  as issue bodies, should hold only the tools its job needs, so a prompt hidden in that text
  cannot reach the rest. The list is the agent's, not the server's: it moves with the pin to a
  newer version, and a name the server does not offer is just absent. Names are checked as input
  (no spaces, no repeats, at least one); an empty list is not "no tools", so it is refused.
- **Each turn connects anew** (`packages/runtime/src/tools.ts`). `beginTurn` reads the agent's
  servers with the agent, before anything awaits, and returns each with its headers' values filled
  in from the opened environment set, in memory for that turn like the key. A server whose
  variables are not all there is left out, with which ones. The runtime connects to the rest at
  once with `@ai-sdk/mcp`, ten seconds each to connect and list their tools, keeps only the tools
  the pin allows before they reach the model, and closes every connection when the turn ends. It
  does not use the Agents SDK's `addMcpServer`, which would keep the headers, secrets included, in
  the conversation's SQLite.
- **No redirects.** The MCP client refuses them with `redirect: "error"`, which Workers do not
  take, so the runtime gives it a `fetch` with `redirect: "manual"`: a 3xx is a failure, and the
  agent's headers never reach the address it names.
- **Tools are named `<server>__<tool>`**, with the characters providers refuse replaced by `_`,
  so two servers cannot clash. A turn makes at most ten model requests (`MAX_STEPS`): the first,
  and one after each round of tool calls. Tool calls a stopped turn left without a result are
  dropped from the next turn's history, which providers would refuse.
- **A server that cannot be reached** is a failed span in the trace, with why in our words (its
  credentials refused, nothing at its URL, a redirect, no answer in time), never what it said.
  The turn goes on without it.
- **A check** (`checkMcpServer` in the same file) connects the way a turn does, with one shared
  connect path, and lists the server's tools. An owner or admin runs it from the MCP page; the
  server function asks `mcpCheckTarget` for the server at its current version, with the headers
  filled in from the environment set of an agent that pins it (one pinned to the current version
  if there is one, else any live agent, else no environment), runs the check in the Worker and
  keeps the result with `recordMcpCheck` in `mcp_checks`: when, which version, whether it worked,
  the tools with their descriptions (cut to a sensible size), and the error in our words. The
  headers live in that request's memory and never reach the browser; the check keeps no header
  value and nothing the server said but its tools' names and descriptions. A server that runs as
  a local command has no Check button: it starts only in an agent's sandbox (below).
- **A local command starts in the agent's sandbox** (AGT-71). A server stored with a `command`
  (`npx -y @acme/mcp`, `uvx …`), as scans find them in `.mcp.json` and the other formats, keeps
  its arguments and its `env`, whose values name variables of the agent's environment set as
  headers do (a scan keeps no `env` value). `beginTurn` fills them in only for a turn with a
  sandbox, and never with a secret: the sandbox holds none, so that nothing a command there runs
  can leak one. A server whose environment names a secret is left out of the turn, saying which,
  and a turn without a sandbox leaves every local server out. The runtime asks the conversation's
  sandbox to start the command (`startMcpServer` in `packages/runtime/src/sandbox.ts`) in
  `/workspace`, under `timeout`, with its own messages in a log; the two streams of its standard
  input and output cross from the sandbox to the conversation over RPC, and
  `SandboxStdioTransport` (`packages/runtime/src/local-servers.ts`) speaks MCP's stdio framing,
  one JSON-RPC message per line, over them for `@ai-sdk/mcp`. A local server has 90 seconds to
  start and list its tools, since the sandbox may start and `npx` download first. Its downloads
  go out as any command's do, to package registries only. Closing the turn's connections ends its
  input, and the command is stopped ten seconds later if it has not exited.
- **A server can be connected through OAuth** (AGT-78), as the MCP authorization spec
  describes, instead of naming a key in a header. An owner or admin presses Connect on the MCP
  page (`/api/mcp-oauth/connect`, `apps/web/src/server/mcp-oauth.ts`). The registry makes a
  single-use state, bound to them and valid for ten minutes (`packages/registry/src/mcp-oauth.ts`),
  and `@ai-sdk/mcp`'s `auth()` discovers the server's authorization server, registers the app as
  a public client, and sends them to sign in with PKCE. On `/api/mcp-oauth/callback` the state
  names the workspace and server; the registry takes it once, for the same person, while they are
  still an admin, and the code is traded for tokens. The client registration, the verifier and
  the tokens are sealed in `mcp_oauth`; pages see only who connected it and when. A turn or a
  check marks the server `oauth` (`turnServers`), and the runtime's `RegistryOAuthProvider`
  (`packages/runtime/src/mcp-oauth.ts`) gives `@ai-sdk/mcp` the token, which it refreshes when
  the server refuses it, keeping the new one sealed. The connection is for the URL the server had
  when it was made: after the server moves it is not sent, and the page asks to connect again.
  Agents that pin the server act on it as the person who connected it, and the page says so.
- **A secret goes to one origin** (AGT-64, `turnServers` in `packages/registry/src/mcp-servers.ts`).
  Anyone who may edit a server may change its URL, and the secrets its headers name were often
  entered by someone else. So `env_secrets.sent_to` keeps the origin a value was first sent to,
  by a check or a turn, and from then on a server at any other origin is left out, saying which
  secret was entered for another address. Entering the value again clears it; Track triage ties
  its key to Track's origin as it stores it. Tying the value rather than watching servers' URLs
  covers a new server that names an existing secret, and versions an agent pins, alike. The ties
  are read and made in the write that ends `beginTurn` or `mcpCheckTarget`, and a value entered
  again while the environment was being opened is not sent: that server waits for the next turn.
  Values stored before then were tied once, as each registry first woke after the deploy
  (AGT-65, `bindUnsentSecrets`): each to the origin of the servers that could send it, the
  version each live agent pins and the current version a check sends to. One named at different
  origins stays unbound with those origins (`env_secrets.contested`): it is sent only to one of
  them, the first a check or a turn uses, and the Environment page lists them on it until it is
  tied or entered again. One-time passes like this one run through `runPassOnce`
  (`packages/registry/src/passes.ts`), recorded in `registry_passes`: one that throws is rolled
  back, logged and recorded as failed with why, and the registry wakes all the same. When
  `bindUnsentSecrets` fails, the write that records it also closes every value still unbound
  with an empty `contested` list (AGT-66): `turnServers` sends it to no origin, rather than tying
  it to the first that asks, until someone enters it again. The Environment page tells owners and
  admins when that happened (`secretTiesFailedAt`), never why or any value, and marks each value
  to enter again.

## AI agents (MCP)

`/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server, so AI agents can
work with Agents as the person who connected them. It is the other direction from
[MCP servers](#mcp-servers): there, Agents' own agents reach other servers (`mcp-oauth.ts`); here,
outside agents reach Agents. Agents is also the OAuth authorization server these agents sign in
to, through Better Auth's MCP plugin (the `jwt()` and `mcp()` plugins in
`apps/web/src/server/auth/config.ts`, ported from Gateweave Track):

1. An agent calls `/mcp` without a token and gets a `401` pointing to the protected resource
   metadata (`/.well-known/oauth-protected-resource/mcp`), which names Agents' authorization
   server.
2. The agent registers itself (dynamic client registration) and sends the person to authorize,
   with PKCE. They sign in if needed and approve it on `/oauth/consent`. Anyone can register a
   client under any name, so the consent page also says where the grant will go, and consent is
   never skipped.
3. The agent gets an access token, a JWT bound to the `/mcp` URL with the `agents` scope, and a
   refresh token. The gateway (`apps/web/src/server/mcp/index.ts`) verifies the signature, the
   audience and the scope (`protect.ts`). It reads Agents' signing keys in-process rather than
   from the JWKS URL, because a Worker cannot reliably fetch its own hostname. Session cookies are
   never accepted there, so a web page cannot make a signed-in browser call it, and no Origin
   check is needed. There are no agent members here, so the only credential is an OAuth token.

The tools, in `apps/web/src/server/mcp/tools.ts`, only read:

- `list_workspaces` returns the name and slug of every workspace the person belongs to, read
  from D1.
- `read_wiki_structure` and `read_wiki_contents` read a [repository wiki](#repository-wiki) with
  DeepWiki's names, arguments and answers, so an agent set up for DeepWiki's or Devin's MCP server
  works unchanged: `repoName` is `owner/name` in any case (for GitLab the full path, split at the
  last slash), and the answers are DeepWiki's text, down to "Error fetching wiki for …:
  Repository not found." Two arguments DeepWiki lacks are optional: `workspace`, for the rare
  repository with a wiki in more than one of the person's workspaces, which the tool then asks
  for, and `page`, to read one page of `read_wiki_contents` instead of all of them. A repository
  in the person's workspaces without a wiki yet says so; anything else, a workspace they are not in
  among it, is "not found".
- `ask_wiki_question` takes DeepWiki's `repoName` (one, or a list of up to 10) and `question`, but
  no model answers it. DeepWiki's server has its model write the answer; the caller here is an AI
  agent with a model of its own, so the tool gives it the pages that bear on the question, whole,
  best first and up to 40,000 characters, then names the others worth reading, and the agent
  answers from them. A question so costs the workspace nothing and needs no key.
  `rankWikiPages` (`packages/model/src/wiki.ts`) ranks pages by the words they share with the
  question: a word in a title counts most, then in the purpose, then in the text, each weighted by
  how few pages have it, with English endings such as plurals taken off.
- `list_wiki_repos` lists the repositories with a wiki in the person's workspaces, as Devin's
  server lists its own, with each wiki's pages and commit.

Tools reach Agents only through the `AgentsAccess` object `createAgentsServer` is given, which
offers what the signed-in person may see. A tool that reads a workspace resolves it to the
person's membership in D1 first (invariant 1): the wiki tools ask the registry of each workspace
the person is in, or only the one named, and of no other.

Tokens must name one canonical URL, so the endpoint, and the authorization server, exist only
when `BETTER_AUTH_URL` pins the base URL. Without it `/mcp` answers `404`. The workspace slugs
`mcp` and `oauth` are reserved, so no workspace shadows `/mcp` or `/oauth/...`.

## Sandboxes

An agent with a sandbox works on a Linux machine of its own in each conversation: it runs
commands and reads, writes, edits, finds and searches files there. It is the first part of cloud
runners (phase 5, AGT-9). A deployment offers sandboxes when it binds `SANDBOX` with a container;
Gateweave Cloud's `cloud` and `staging` environments do, and self-hosted deploys leave them off
until their operator opts in. Cloud offers them only to the workspaces it invites.

- **Engines.** What takes an agent's turns is its engine. `gateweave`, the default, is Gateweave's
  own loop with the agent's tools (`packages/runtime/src/conversation-agent.ts`). `claude-code` runs
  Anthropic's Claude Code CLI in the agent's sandbox, so it reads the repository's own `CLAUDE.md`,
  skills and settings as it would on a laptop, `codex` runs OpenAI's Codex CLI there, which reads
  its `AGENTS.md`, and `opencode` runs the open-source OpenCode CLI, which reads `AGENTS.md` and
  `opencode.json`. The registry enforces two rules for each: it needs a sandbox, and it calls models
  of a provider it runs with (`ENGINE_PROVIDERS`): Anthropic's for Claude Code, OpenAI's for Codex,
  any of Anthropic's, OpenAI's or Google's for OpenCode. See **Claude Code**, **Codex** and **OpenCode** below.
  A CLI writes its own messages to a log in the sandbox, out of its events' way, one turn's at a
  time. When it ends without saying how its turn went, the conversation asks the sandbox how it
  ended (`engineExit`): its exit status, how long it ran, and the last ten lines of its log, at
  most 1,000 characters, with anything like a key taken out before they leave the sandbox. The
  turn fails with those (AGT-48). A kill before the turn's hour reads as the sandbox running out
  of memory, since nothing else there kills the CLI.
- **One container per conversation.** `RunnerSandbox` (`packages/runtime/src/sandbox.ts`) is a
  Durable Object with a container, named like its conversation and reached only by it, over RPC.
  It has no route. The container starts on the first call, from `sandbox/Dockerfile` (Debian
  with Node.js 24, Python 3, git, ripgrep, curl, jq and the shim `@cloudflare/sandbox` 1.0 talks
  to), as a `standard-1` instance (`SANDBOX_INSTANCE`), and stops after `SANDBOX_IDLE_MINUTES`
  (5 by default) without a call; its disk goes with it. Deleting the conversation stops it at once. pnpm and Yarn come
  through Corepack, in the version a repository's `packageManager` names, downloaded from npm on
  first use, Yarn 2 and later included; the image carries pnpm's current version
  (`PNPM_VERSION`). Corepack never asks, and never writes `packageManager` into the repository.
- **No internet, but packages.** The container starts with `enableInternet: false`, and all of its
  HTTP and HTTPS goes to `SandboxOutbound`, a `WorkerEntrypoint` of the app's Worker, through the
  container's own certificate authority. `decideOutbound` (`packages/runtime/src/outbound.ts`)
  lets through GET and HEAD to package registries (npm, PyPI, crates.io, Go's module proxy),
  git's fetches of the conversation's repository on github.com and the push `push` makes, an
  engine's requests to its model's provider while it runs a turn, and the engine tools' host, and
  answers everything else with a 403 that says why, which the command prints. A redirect goes
  back to the command, so each address it leads to is decided on too. The sandbox holds no secret
  of the workspace's: the key, the environment set and MCP headers stay in the Worker.
- **The tools** (`packages/runtime/src/sandbox-tools.ts`): `run_command` (a bash line, in a
  directory, stopped by `timeout` after 120 seconds unless the model asks for up to 600, its
  output preview keeps up to 2 KiB from the start and 6 KiB from the end. A clipped command
  may return a file containing its full output for the sandbox's lifetime), `read_file` (numbered lines,
  up to 2,000 lines and 16 KiB per response, with the next unread line in the continuation hint),
  `write_file`, `edit_file` (an exact replacement, found once unless every place is asked for),
  `find_files` and `search` (ripgrep). File paths stay under `/workspace`; that keeps the tools on
  the work, not a wall, since a command reaches the whole machine, which holds nothing else. They
  reach the container through `SandboxPort`, which the tests fill with files in memory. Only
  `run_command` needs the machine: the five for files ask for a `FilePort` (files read and written
  whole, listed and searched), which `sandboxFiles` makes of a sandbox, with ripgrep run in it for
  the last two. The port's answers are text in ripgrep's format, which is written down at
  `SearchResult`, and its owner writes what `find_files` and `search` say of themselves
  (`FileWords`), since the rules are its own.
- **Files without a machine** (AGT-122, built and not yet used: no agent setting turns it on and
  `ConversationAgent` makes none). `FileStore` (`packages/runtime/src/file-store.ts`) answers the
  same `FilePort` over a repository's files kept in the conversation's own SQLite, with nothing
  that runs: no shell, no git, no interpreter.
  - **Loaded as asked for.** A checkout reads the default branch's head and its tree, two
    requests, and keeps the listing compressed in a few rows. `find_files` answers from it.
    `read_file` fetches that one blob the first time; `search` fetches the texts it lacks under
    its path and glob, fifty to a request. A later turn asks GitHub nothing for what is held,
    and works on the commit first read.
  - **Bytes as they are.** A file is the blob's bytes, checked against its id, so a byte order
    mark and Windows line ends survive an edit; its mode is the listing's, so an executable
    file stays one.
  - **Out as a commit.** `push` hands the files that differ and the paths that are gone to
    `commitChanges`, with the commit this conversation last put on its branch; the answers are
    a sandbox's (`PushPort`), so `open_pull_request` can stand on either. A commit GitHub took
    whose note was lost, with the answer or with the object when a deploy restarts it, is found
    by the next push and taken for the conversation's own when it follows directly from where
    the conversation left the branch and everything it changed from that commit ends as the
    push leaves it, content, mode and deletions; a commit on top of it then undoes nothing in
    it, whoever made it. It is held against its own parent and not the base, so a person's
    commit that puts a file back as the base has it, restores one the conversation deleted or
    removes one it added is theirs, and the push is refused.
  - **Search is literal text**, never a regular expression: a model's pattern does not run in
    the Durable Object, where one that backtracks without end would hold the conversation. The
    tool's description says so. It has its own globs (`glob.ts`), read as ripgrep was recorded
    reading them: a name is matched as its UTF-8 bytes, so `?` and a set take a byte and not a
    letter; braces inside a set are the set's; and one branch with a slash holds every branch
    from where the path starts. They are bounded: a glob that branches or nests too far is
    refused, a set is a table looked up once a byte, and every step of matching is counted,
    remembered or not, so one made to be slow is stopped in a fraction of a second with words.
  - **Held to the sandbox's ripgrep.** `test/ripgrep/recorded.json` is what the ripgrep in the
    sandbox's image answered to the two command lines `sandboxFiles` writes, over a small
    repository (`record.mjs` beside it makes it, in the image). `ripgrep-recorded.test.ts`
    holds the store to it, and the tests' stand-in for ripgrep too, and writes out both answers
    wherever the store differs on purpose. Those are listed at the top of `file-store.ts`: it
    does not read `.gitignore` (the files are the commit's own and what the conversation
    wrote), it leaves out files over 256 KiB and files that are not UTF-8, and a glob with a
    slash also holds from the repository's root. The recordings also show what ripgrep does in
    a sandbox that its tools' descriptions do not say: a glob that matches an ignored file, or
    one in `.git`, lists it, so `find_files` there, which always has a glob, can.
  - **Limits, each answered in words.** A tree GitHub cuts short, or of more than 20,000
    entries, is not checked out. A file over 256 KiB, a binary file and a symlink are listed and
    not read, and none of the three is written over; the first two can be deleted, and a file
    then written where they were. A search that would fetch more than 500 files fetches none. A
    change of more than 500 files or 20 MB is refused as it is written. Only text is written: a
    NUL character is refused, and a row whose bytes the store could not read back is an error,
    never an empty file, in a read, a search and a push. A name that differs only in case from
    one that is there is refused as it is written; one the conversation deleted is not there,
    so a file's name changes case by deleting it and writing it, and `commitChanges` takes
    that in one change.
  - **No value over 900,000 bytes.** Durable Object SQLite takes none over 2 MB, and a backup
    and a move's digest read every value through `quote()`, which writes bytes as two
    characters each: 900,000 bytes are 1,800,003 characters. So the listing is cut into rows
    of that, a written file holds at most that, and a fetched file is at most 256 KiB. Local
    workerd does not enforce the limit, so the tests hold the store to the number.
  - **What a conversation can hold** follows: the listing (at most 8 MiB in 10 rows), the blobs
    fetched (at most 32 MiB, a row a blob and so at most 20,000, the oldest going first), the
    change (20 MB in 500 rows) and one row for the checkout. About 60 MiB and 20,511 rows at
    the most.
  - **Four tables of the conversation's** (`file_checkout`, `file_listing`, `file_blobs`,
    `file_changes`), made on first use as the trace's are, each write in one `transactionSync`
    after GitHub was asked. Deleting the conversation empties the object and them with it; a
    move copies every table it finds and makes the ones a new object lacks; a backup lists the
    tables itself. None of the three names a table, and `test/file-store-storage.test.ts`
    holds each to it. A conversation that holds files takes more calls to move, a read and a
    write for every 4 MB: about forty at the most it can hold.
  - **The token** is asked of the caller for each call that needs GitHub, for the one
    repository and for reading or writing, and is never stored, answered or traced. GitHub's
    refusals reach the model as the store's own words with a status; only a change GitHub
    refuses as invalid (422) is given in GitHub's words. The words say what the refusal is: a
    403 whose message is a rate limit's is a limit and not a missing permission, as is a
    GraphQL answer with no repository and a rate limit among its errors; no token for a call
    is told apart from a change GitHub refused; a 401 is not answered with "try again", since
    the app keeps a token until it runs out.
- **The trace** has a span for each call, under the server name `sandbox`, with its sizes and
  never its content, like an MCP tool's. A call that fails keeps the reason the tool gave the
  model, clipped to 500 characters (`traced` with `showErrors`), so a run's page says why; it can
  name a path or quote what git answered. An MCP server's reason is not kept, since it can carry
  what a third party said. A turn with a sandbox may take 40 model requests
  (`MAX_SANDBOX_STEPS`) instead of 10, since its work goes in many small steps.
- **The registry decides.** The agent's `sandbox` setting is in `agent_definitions` and its
  snapshot. `beginTurn` refuses a turn that needs a sandbox where the server binds none, in a
  workspace the server does not invite when it names the ones it does (`SANDBOX_WORKSPACES`, by
  id, which a registry knows as its Durable Object's name; Gateweave Cloud offers sandboxes by
  invitation), and one that would make more than three of the workspace's conversations hold one at once
  (`MAX_WORKSPACE_SANDBOXES`): a conversation holds one from a run marked `sandbox` until 15
  minutes after its last such run ended. An ask over a team's edge has no tools, so it needs no
  sandbox, unless the agent's engine runs only in one, as every engine but Gateweave's loop does.
  A turn awaits as it is prepared (the key, the environment set, the meter), and others may begin
  meanwhile, so this limit and the daily one below decide again in the write that begins the run
  (`#sandboxLimitRefusal`), with the same refusal (AGT-63).
- **Sandbox time and its limits** (AGT-45). The runs say how much sandbox time a workspace uses
  (`sandboxSeconds` in `packages/registry/src/runs.ts`):
  - Each conversation's sandbox counts from a run with it until `SANDBOX_IDLE_MINUTES` (5 by
    default) after the last.
  - Runs that overlap that way are merged.
  - The idle minutes count as soon as a run ends, since the sandbox runs them anyway.

  Then two limits apply, both off unless the server sets them:
  - **Daily.** `SANDBOX_DAILY_MINUTES` refuses a turn that needs a sandbox once the workspace has
    used that much of the UTC day.
  - **Monthly.** `SANDBOX_MONTHLY_BUDGET` covers the whole deployment. Before such a turn, and
    after it ends, the registry reports the workspace's figure for the month to `SandboxMeterDO`
    (`packages/registry/src/sandbox-meter.ts`). That is one Durable Object per deployment, bound as
    `SANDBOX_METER`, with no route. It keeps each workspace's latest figure, and prices the total
    at `SANDBOX_SECOND_PRICE`, the most a second of the machine costs. Turns are refused once that
    reaches the budget.
    - The first report to pass 80% or 100% calls `sandboxBudgetPassed` once a month. The app's
      `RegistryDO` emails `SANDBOX_ALERT_EMAIL` from there.
    - A setting that is not a number allows nothing, so a typo never lifts a limit.
    - A budget without the meter refuses too.

  A turn that begins under a limit runs to its end, so a limit can be passed by up to an hour of
  each sandbox in use.
- **A repository in the sandbox** (AGT-41). An agent with a sandbox can choose a repository the
  workspace's GitHub App reaches (`agent_definitions.repository_id`). On the conversation's first
  tool call, `withCheckout` (`packages/runtime/src/checkout.ts`) asks the sandbox to clone it into
  `/workspace/repo` from its default branch, blobs on demand, onto `gateweave/<conversation>`,
  and the model is told so after the agent's instructions. A checkout that fails is that tool's
  answer, and the next call tries again. The conversation keeps the repository it first checked
  out; one chosen later is for later conversations. The container's disk goes when it idles, so
  the next checkout starts over.
- **The token never enters the sandbox.** Git's requests go out through `SandboxOutbound` like any
  other. `decideOutbound` lets through only git's smart HTTP fetch of that one repository
  (`info/refs` for `git-upload-pack`, and the pack), refusing pushes and the rest of github.com.
  For those it allows, the Worker asks the sandbox which repository it checked out and mints an
  installation token scoped to that repository with `contents: read`
  (`GitHubApp.repositoryToken`). The Worker adds the token as the request leaves, so no command
  can print it. The registry refuses the turn when the app no longer reaches the repository, or
  when the server is not set up as a GitHub App.
- **Pull requests from the sandbox** (AGT-42). A turn whose sandbox has a repository also has
  `open_pull_request {title, body}` (`packages/runtime/src/pull-requests.ts`). The sandbox commits
  every change with the title as the message, with the repository's own hooks. Its author is the
  agent's name with the address of the GitHub App's bot account
  (`<id>+<slug>[bot]@users.noreply.github.com`, read once per installation with
  `GitHubApp.botIdentity`), so GitHub links the commit to the app and a CLA check can read it.
  Without the app, or when that lookup fails, it is the agent at `noreply@gateweave.com`. It
  refuses when the work has no commit the default branch lacks, then runs `git push` of
  `gateweave/<conversation>` (`RunnerSandbox.push`). The Worker then opens a
  pull request against the default branch with a token for `pull_requests: write` and
  `contents: read`, or updates the one the branch has open; the sandbox never makes it. GitHub
  lists only the first for these calls, but refuses a pull request with "not all refs are
  readable" without the second. A sandbox that stopped and starts again (after the idle minutes,
  5 by default, without use) clones the repository afresh and goes on from the branch as the conversation last pushed
  it, so its next push adds to the same pull request. The pull request goes on the run
  (`runs.pull_request`), and Runs and Chat link to it.
- **Checks before the push** (AGT-142). A repository can have checks: up to 5 bash command lines
  an owner or admin sets on its page (`repositories.checks`, `setRepositoryChecks`; the limits
  are `CHECK_LIMITS` in `packages/model/src/checks.ts`). A repository without any is proposed
  exactly as above. With some, `open_pull_request` takes the push in two steps
  (`packages/runtime/src/checks.ts`): `RunnerSandbox.commit`, then each command in the
  repository's root with the sandbox's own `run`, in order, stopping at the first that does not
  exit with 0, then `RunnerSandbox.pushCommit`, which pushes that commit by its id and commits
  nothing, so what a check or anything else on the machine changed after the commit is not in
  the push. The calls of one turn take their turns: two at once would commit, check and push over
  each other in the one checkout. One that waited while its turn was stopped does not begin.
  - The checks run in the checkout, not on the commit itself. So after each check that passed,
    the tool asks whether the checkout still is the commit (`changedSince` in `git-work.ts`:
    `HEAD`, and `git status` without ignored files). After each and not only the last, since a
    later check could put back what an earlier one changed. If it is not, a check changed the
    files, as a formatter does, and the next would run on something else than what gets pushed:
    the round stops and fails, and the model is told which files; the pull request is not.
    Called again, the tool commits what changed and checks that commit. When git cannot say, the
    round fails as well, as unverified and not as changed (`Comparison`), so nothing claims a
    change nobody saw.
  - A round that fails pushes and opens nothing. The tool's failure is the model's to read: the
    command, its exit code and the last 4,000 bytes of its output. The trace gets the failure
    without the output (`SummarizedFailure`), since output is content. The third failed round of a
    run pushes the work and opens the pull request as a draft; the run is not failed for it. An
    open pull request stays as it is: the REST API opens drafts but does not make one of an open
    pull request.
  - Before the AI disclosure, the body includes a section the tool writes (`checksSection`)
    with each command, its exit code and duration, and the commit. Its heading (`CHECKS_HEADING`) is the tool's: a line of the
    model's body that is the heading, however it is marked up, is removed with what follows it up
    to the next heading, whether the repository has checks or not. That removal is by the line's
    letters, without its tags, links and character references (`withoutChecksSection`); it is not
    a Markdown renderer, and a heading made to look the same in some other way gets past it. So
    the guarantee is the section's place, which the section states: the tool's is appended after
    everything the model wrote and is the last section. For that to hold on the page, what the body
    left open is closed first (`closed`): a code fence, an HTML comment, processing instruction,
    CDATA or declaration, and a `<details>`, each of which would otherwise take the section in
    and show it as code or not at all. A text with a tag in it is followed by the line
    `<!-- " ' -->`: a tag left unfinished in an HTML block, such as `<div title="cut`, would take
    what follows into an attribute, and the line ends it whatever quote is open, while it is a
    comment, which shows nothing, where none is. The tool cannot tell which lines Markdown passes
    on as HTML, so it does not try. Nothing of a command's output goes into the body.
  - A command gets 10 minutes, a call's checks 20 and a run's 40, counted where the tools are made
    for the turn. A command stopped at its limit is timed out, never passed. Checks a call has no
    time left for fail the round; when the run has none left before a round begins, the checks
    are not run and the pull request says so, as a draft. Each check is a tool span of the
    sandbox's (`check`), with the sizes of its command and output. The time is the run's sandbox
    time, as the run's length is. A turn that is stopped while its checks run starts no further
    check and pushes nothing, since minutes may lie between the call and its push.
  - **The commands are configuration, not content.** The runtime asks the registry for them at
    each call, by the id GitHub gave the repository the turn began with (`repositoryChecks`). The
    turn carries none, the tool's input has no place for one, and no file of the working tree is
    read for them. Only `setRepositoryChecks` writes them, for a GitHub repository, which the app
    calls for an owner or admin and notes in the audit log (`repository.checksSet`, with how many
    there were and are, never the commands, which are free text); a scan never does. They are no
    secret: every member sees them and each pull request lists them. When the registry cannot be
    asked, the tool opens nothing. Reading them from a file on the default branch is not built.
  - An engine in the sandbox opens its pull request with the same tool, served to its CLI
    (`./engine-tools.ts`), so Claude Code's, Codex's and OpenCode's work is checked the same way.
    A turn that works on files without a sandbox (AGT-122, dark) has nowhere to run a command:
    the tool then pushes as before and the section says `Checks: not run (no sandbox in this
    run)`.
  - The checks run on the agent's machine, where the agent ran commands before them. They say
    what ran on the commit; they do not stand in for the repository's own CI.
- **Only that push gets through.** `RunnerSandbox` opens a push window, in memory, for as long as
  its own `git push` runs. Only then does `decideOutbound` let `git-receive-pack` through, with a
  token for `contents: write`. Before the pack goes on, `SandboxOutbound` reads the ref updates it
  starts with (`pushedRefs`) and refuses anything else (`checkPush`):
  - more than one ref, or any ref but the conversation's branch;
  - deleting the branch;
  - an update from a commit other than the one the conversation last pushed, so commits someone
    else pushed are never dropped;
  - an update to any commit but the one the window was opened for (AGT-142), which is the commit
    the repository's checks ran on when it has any.

  A push it cannot read, encoded or over 50 MB, is refused too. A command the agent runs can never
  push, even while the window is open, to anything but that branch, nor anything there but the
  commit the tool itself is pushing: a `git push` left running in the sandbox to catch the window
  gets no unchecked commit through it.
- **Claude Code** (AGT-44). The image installs Anthropic's Claude Code CLI, pinned
  (`CLAUDE_CODE_VERSION` in `sandbox/Dockerfile`). A turn of an agent whose engine is
  `claude-code` checks the repository out first, if the agent has one, then runs `claude -p` there
  with `--output-format stream-json` (`RunnerSandbox.startEngine`, the engines' common part in
  `packages/runtime/src/engines.ts`, Claude Code's own in `packages/runtime/src/claude-code.ts`).
  It runs in `dontAsk` mode with Bash, the file tools and
  skills allowed, since nobody is there to approve a call; `bypassPermissions` refuses to run as
  root, which the sandbox's commands are. The message goes on its input, the agent's instructions
  and where it runs follow its own system prompt, and it may take 100 turns and an hour. Its
  `--settings`, which outrank the repository's settings files, turn its attribution off
  (`CLAUDE_CODE_SETTINGS`): no Co-Authored-By trailer on a commit and no "Generated with Claude
  Code" line in a pull request (AGT-57). Codex adds none when it runs with an API key, as it does
  here, and OpenCode adds none at all.
  - **Its events are the turn.** The conversation reads the CLI's events as they come
    (`ClaudeCodeTurn`): the main conversation's text goes to the chat, and its tool calls as
    `claude-code__<tool>`, their results clipped to 4,000 characters. Its model requests are
    metered where they leave the sandbox (below), so its events give no model spans. Each tool call
    becomes a tool span under the server name `claude-code`, a subagent's too. A
    result that is an error fails the turn, in the same words as Gateweave's loop uses. A message
    the CLI writes itself (its model is `<synthetic>`, as for a refused key) is meant for a terminal:
    it is neither text in the chat nor a request in the trace, and only a failure the app has no
    words for quotes it.
  - **The key never enters the sandbox.** The CLI's `ANTHROPIC_API_KEY` is a placeholder. While the
    turn runs, `RunnerSandbox` holds the workspace's key in memory, and `decideOutbound` lets
    `POST /v1/messages` (and `count_tokens`) to `api.anthropic.com` through. `SandboxOutbound`
    puts the key on each such request (`anthropicRequest` in `packages/runtime/src/models.ts`), and
    sends it through AI Gateway when the deployment names one, with the same metadata as
    Gateweave's own requests. Updates, telemetry and error reports are off, and so are background
    tasks, so a turn ends with its last answer. The CLI also asks that host for an organization's
    managed settings and policy limits (`/api/claude_code/settings` and `/policy_limits`). They are
    refused like anything else there, and it goes on without them, as staging showed.
  - **One session per conversation.** The sandbox keeps the session's id; a later turn resumes it
    while the container has its transcript. A container that stopped starts a new session, which
    reads the conversation so far, the most recent 50,000 characters, before the new message.
    Stopping a turn sends Claude Code Ctrl+C's signal, and a kill 10 seconds later.
  - **Gateweave's tools are one MCP server.** The turn's other tools, the agent's MCP servers,
    `open_pull_request` and a team's edges, are the same as in Gateweave's loop. The CLI reaches
    them as the MCP server `gateweave`, at `http://tools.gateweave.internal/mcp`
    (`packages/runtime/src/engine-tools.ts`): `--mcp-config` names it, `--strict-mcp-config`
    keeps any other server the repository configures out, and `mcp__gateweave` is allowed. That
    host exists only inside the sandbox. `SandboxOutbound` hands its requests to the conversation
    (`ConversationAgent.engineTools`) with a token made for the turn, which the sandbox never
    sees, and the conversation answers them with `createMcpHandler` from
    `@modelcontextprotocol/server`. So an MCP server's secret headers, the GitHub App and the team's
    other conversations stay in the Worker. The server is `alwaysLoad`, so the model has the tools
    in its first request, as in the loop: otherwise the CLI connects in the background and later
    keeps them behind its tool search. It says the tools never change, so the CLI opens no
    `subscriptions/listen` stream, which a handler made for each request could not keep. A call runs as the loop would run it and records its own
    span; the chat shows it under the tool's own name (`acme__search`, `open_pull_request`, an
    edge), so a pull request's card and a delegated answer look as they do in the loop. The
    server's `timeout` is the turn's hour, since an edge's nested turn can take longer than the 60
    seconds an HTTP server's request has otherwise, and calls are never moved to the background.
    Once the turn ends, or is stopped, the host refuses and the calls under way are cancelled.
- **Codex** (AGT-44). The image installs OpenAI's Codex CLI too, pinned (`CODEX_VERSION`), and a
  turn of an agent whose engine is `codex` runs `codex exec --json` the same way
  (`packages/runtime/src/codex.ts`), with approvals and Codex's own sandbox off, since the
  container is the sandbox, and `--ignore-user-config`, so its settings are Gateweave's alone,
  given as `-c` overrides. The agent's instructions and where it runs are its
  `developer_instructions`.
  - **Its own provider.** Codex's built-in OpenAI provider ignores `OPENAI_BASE_URL`, tries a
    WebSocket first and lists models at chatgpt.com, so the turn names a provider of its own
    (`model_providers.gateweave`): the Responses API at `https://api.openai.com/v1`, over HTTPS
    only, its key a placeholder in `GATEWEAVE_OPENAI_KEY`. `decideOutbound` lets
    `POST /v1/responses` to `api.openai.com` through while Codex runs a turn, compactions
    included, and `SandboxOutbound` puts the workspace's key on it (`openaiRequest`), through AI
    Gateway when the deployment names one. Update checks, analytics, feedback and web search are
    off. Codex trusts the sandbox's certificate through `SSL_CERT_FILE`.
  - **Its items are the chat.** An `agent_message` is text; a command (`codex__shell`), a patch
    (`codex__apply_patch`) and another MCP server's call are tool calls with spans under the
    server name `codex`; a call of Gateweave's `gateweave` server shows under its own name and
    records its own span, as with Claude Code. A command that exits with an error shows as failed,
    with its exit code. A failed turn's status (`unexpected status 401 …`, `last status: 429 …`)
    is said in Gateweave's words; anything else Codex says is quoted with whatever looks like a key
    taken out, since OpenAI's errors repeat part of it.
  - **One thread per conversation.** A later turn resumes the thread (`exec resume --last --all`)
    while the container has a session under `/root/.codex/sessions`; the container holds no other.
    Otherwise it starts a new one with the conversation so far, as Claude Code does. Gateweave's
    tools are the same MCP server, named with `omit_tools_from = ["deferred"]` so the model has
    them in its first request rather than behind Codex's tool search, and `tool_timeout_sec` the
    turn's hour. Codex speaks MCP's stateless 2025-06-18 revision, which the handler answers too.
- **OpenCode** (AGT-44). The image installs the OpenCode CLI (MIT), pinned (`OPENCODE_VERSION`):
  its build for the container's machine alone, and the `@opencode-ai/plugin` package it would
  otherwise fetch from npm into its settings folder on a new container's first turn. An agent
  whose engine is `opencode` runs with its Anthropic, OpenAI or Google model
  (`packages/runtime/src/opencode.ts`), and its turns come out as `opencode run --format json
  --auto` prints them. Permissions are approved as `--auto` approves them, since nobody is there
  to answer.
  - **A server per container** (AGT-50, `packages/runtime/src/opencode-server.ts`). Before its
    first request, `opencode run` starts Bun and loads its settings, plugins, MCP servers and
    database: about 4 s a turn on one vCPU, and 9 s on `standard-1`. So the container's first
    OpenCode turn starts `opencode serve` (`OPENCODE_SERVER_SCRIPT`), which outlives the turn.
    - Each turn drives the server from the sandbox's Durable Object, through the container's port
      (`getTcpPort`). It opens the project's events, sends the message (`prompt_async`) and prints
      what `opencode run` would of the events until the session is idle. On a running server, a
      turn reaches its first request in tens of milliseconds.
    - `opencode run --attach` would skip the start too, but with `--format json` it prints nothing:
      it returns without waiting for its events.
    - Each step before the message has a time limit, and so does each request asking whether a
      new server is up. On Cloudflare, a request to a port that nothing listens on yet can go
      unanswered, where Docker refuses it at once, so the first turn on staging waited for good.
    - The server reads its settings when it starts. It starts over when a turn's differ, which
      happens when the agent's model changes, or whether it has instructions or Gateweave's tools.
    - It lists an MCP server's tools only when it connects to it, so each turn with tools
      reconnects `gateweave` first, and the server lists the turn's own.
    - Stopping a turn stops the session (`abort`). At the hour's limit, the turn ends as one that
      `timeout` stopped.
    - The server keeps its warnings and errors in `/tmp/opencode-server.log`. A turn that ends
      without saying why quotes the part of that log written since the turn began, with the
      server's exit status if it exited.
  - **Its settings come last.** OpenCode reads `OPENCODE_CONFIG_CONTENT` after the repository's
    `opencode.json`, so the turn's settings win where both speak: the agent's model alone (for its
    small tasks too), at its provider's own address with a placeholder for a key, no update checks,
    shared sessions, model list or language server downloads, and no snapshots of the work. It
    takes instructions only from files, so the sandbox writes the agent's instructions and where it
    runs to `/tmp/gateweave-instructions.md`, which its `instructions` name: they follow the
    repository's `AGENTS.md` in its system prompt, and the server reads them at each message. A
    new session gets the title `Gateweave`, which spares the request to a small model OpenCode makes
    for one otherwise.
  - **Its tools.** It prints a tool call only once it has its result, so the tool span starts
    back by how long the call took, which keeps the sandbox's clock out of the trace. Its `task`
    tool is on: a subagent's session prints nothing, but its requests are metered like the others
    (below). `webfetch` is off, since the sandbox reaches no website.
  - **The key never enters the sandbox,** as with the others: `decideOutbound` opens the API of the
    agent's provider to the running turn, `POST /v1/messages` to `api.anthropic.com`,
    `POST /v1/responses` to `api.openai.com`, or, for Google, `POST
    /v1beta/models/<model>:generateContent` and `:streamGenerateContent?alt=sse` to
    `generativelanguage.googleapis.com` (the requests `@ai-sdk/google` makes, with no other query,
    so a request cannot bring a key of its own), and nothing of the others'. The key goes where
    the provider takes it: `x-goog-api-key` for Google (`googleRequest`), through AI Gateway's
    `google-ai-studio` path when the deployment names one, as for Gateweave's own calls. A failure comes as an
    `error` event with the provider's status, said in Gateweave's words, once OpenCode's own five
    retries of a request that may succeed later have failed too.
  - **One session per conversation.** The conversation keeps its session's id, and a later turn
    continues that session while the server has it, even after the server starts over; otherwise
    it starts a new one with the conversation so far. Gateweave's tools are the same MCP server, a `remote` one in its settings without OAuth,
    whose timeout, the turn's hour, covers each call. OpenCode speaks MCP's 2025-11-25 revision.
  - **It needs more than the smallest machine.** OpenCode runs on Bun. A local run of the image
    under `lite`'s limits (256 MiB, 1/16 vCPU) ran out of memory before its first answer; under
    `basic`'s (1 GiB, 1/4 vCPU) a turn took about half a minute and used 415 MiB at most. The
    sandbox starts as `standard-1`, so keep it at `basic` or above. Claude Code fits in `lite`.
- **What a model request may carry** (AGT-62, `checkModelRequest` and `forwardedHeaders` in
  `packages/runtime/src/outbound.ts`, `sendModelRequest` in `packages/runtime/src/model-requests.ts`).
  A request for the model is the one way out whose contents the sandbox chooses, and it leaves
  with the workspace's key. The providers run tools of their own for a request (MCP connectors,
  web search and fetch, code execution, file search), which would send what it holds wherever it
  says. So before the key goes on, the Worker reads the body, unencoded, and refuses with a 403
  one that is not a JSON object or that:
  - names a model other than the agent's (`model`, or Google's path);
  - for Anthropic, has `mcp_servers` or `container`, or a tool with a `type` other than `custom`
    (Claude Code's and OpenCode's tools have none), or `inference_geo` or a `speed` other than
    `standard`, which cost more;
  - for OpenAI, has a tool other than `function`, `custom` (Codex's `apply_patch`), a `namespace`
    of those (Codex's MCP tools) or `tool_search`, which looks only through the request's own
    deferred tools; or `web_search_options`, or a stored `prompt`, whose tools the request does
    not show; or reads what the workspace's organization stored (`previous_response_id`,
    `conversation`, a `file_id`, an `item_reference` input item, typed or not), which Codex and
    OpenCode never do, as they store nothing; or a
    `service_tier` other than `auto` or `default`;
  - for Google, has a tool other than `functionDeclarations`, `cachedContent` (which brings its
    own instructions and tools), or a `fileData` part with a URI anywhere in the body;
  - has the provider fetch an image, document or file by URL (`data:` URLs are fine).

  What goes out is the checked JSON, written out again, so the provider reads what was checked.
  A body is at most 16 MB (413 otherwise), under Anthropic's own 32 MB: checking holds its text
  and its parsed value at once, about four times its size, in an isolate of 128 MB that serves
  other requests too. The body is decoded as it streams, so no chunk is kept, and each form of it
  is let go as the next is made.
  Its headers are `content-type`, `accept`, `user-agent`, and for Anthropic `anthropic-version`
  and the betas in `ANTHROPIC_BETAS`: those Claude Code 2.1.308 and OpenCode 1.19.5 send that
  change how the model answers, thinks or caches. Betas of other APIs (files, batches, MCP
  servers, environments), of server tools (web search, the advisor) and those that let Anthropic
  answer with another model or price (server-side fallback, fast mode) are dropped, as is every
  other header: a CLI's telemetry and session ids, `OpenAI-Organization`, and `OpenAI-Beta`,
  which Codex sends only on the WebSocket it does not use here. A refusal is a failed model span
  in the run's trace with the reason, like a request the provider refused.
  - Claude Code would use other models for small tasks and subagents (Haiku, by its aliases), and
    fall back to another when one is overloaded. Its turn runs with each of those set to the
    agent's model (`claudeCodeModelEnv`), and `CLAUDE_CODE_NO_MODEL_FALLBACK`. OpenCode's
    `small_model` is the agent's already, and Codex calls only its `--model`.
  - No engine needs a server tool here. Claude Code's `WebSearch` would send Anthropic's
    `web_search` tool, but it is not among the turn's allowed tools, and its `WebFetch` fetches
    from the sandbox, which reaches no website. Codex's web search is off. Both would be refused.
- **Model requests are metered where they leave the sandbox** (AGT-49,
  `packages/runtime/src/meter.ts`). A CLI's events leave out what it does not print: OpenCode's
  subagents, Claude Code's in part, and Codex's requests one by one, of which it prints only the
  thread's total. `SandboxOutbound` sees every request for the model, since it adds the key, so the
  trace takes its model spans from there and the engines' events give only the chat and the tool
  spans.
  - A request that goes out first asks the conversation for a step (`engineRequestStarted`), with
    the turn's token, which the engine's later tool calls belong to. Anthropic's `count_tokens`,
    which no model answers, is not metered.
  - The answer streams on to the CLI as it comes. A copy of each chunk is read on the side: the
    usage at Anthropic's `message_start` and `message_delta`, in OpenAI's `response.completed`, in
    Google's last chunk, or in an answer that is not a stream. Only the usage, the model, how the
    answer ended, its first bytes' time and AI Gateway's log id are kept, never a body.
  - When the answer ends, or the CLI stops reading it, the Worker reports it
    (`engineRequestEnded`, under `waitUntil`), and the span is priced at the model's list price. A
    refused request (a status that is not 2xx), one that failed as it streamed, and one cut off
    are spans that failed, with what they had used. The conversation checks the report against a
    schema and records nothing without the turn's token, or once the turn has ended.
  - A turn's CLI can end a moment before its last request is reported, so the turn waits up to
    five seconds for the requests still open before it closes the run.

### AI disclosure on GitHub

To support EU AI Act Article 50 transparency, every pull request an agent opens or updates
ends with ``Written and opened by `<agent name>`, an AI agent in Gateweave Agents.`` and the
machine-readable comment `<!-- AI-Disclosure: mode=machine-generated -->`. If the cleaned name is
empty, the sentence is `Written and opened by an AI agent in Gateweave Agents.` The disclosure
follows the checks section when there is one.

Agent commits carry the `Assisted-by: Gateweave Agents:<model id>` trailer and use the
agent's bot identity as author and committer. If the engine chooses its own model, the
trailer uses the engine's name. Commits already on a remote are never rewritten.
The disclosure and trailer cannot be turned off.

## Chat

Members talk to agents run by Gateweave on the Chat page. Each conversation is a Durable Object
of its own, `ConversationAgent` (`packages/runtime`), built on the Agents SDK's `AIChatAgent`: it
keeps the messages in its SQLite, streams the reply over a WebSocket, and picks a stream back up
after a reconnect.

- **A conversation belongs to the member who started it.** The registry keeps the index
  (`conversations`: the agent, who started it, the title and when), and nobody else lists, opens
  or deletes it, admins included. The Durable Object is named `<workspace id>:<conversation id>`.
- **No public route.** The browser connects to `/api/chat/<slug>/<conversation id>` and reads
  `…/get-messages` first. The gateway (`apps/web/src/server/chat.ts`) takes only GET, requires
  the app's own Origin on WebSockets, checks the session, the membership in D1 and the
  conversation's owner, and passes the request on without its cookies. Anyone else gets the 404
  a missing conversation gets. A socket carries the session's id instead (`CHAT_SESSION_HEADER`),
  and takes no message once that session is gone; one that came without it closes at once.
- **Each turn asks the registry** (`beginTurn`). It records the turn (the first message titles
  the conversation) and returns the agent's snapshot with the workspace's key for its provider,
  opened, or a sentence saying why the agent cannot answer: it was removed, or the workspace has
  no key. The key stays in memory for that turn.
- **The model** is called with the AI SDK (`streamText`) and the provider's own package, with the
  agent's pinned instructions as the system prompt. Stopping a turn aborts the model's request. A
  provider's refusal becomes a sentence of ours chosen by its status (`describeFailure` in
  `packages/runtime/src/models.ts`); the provider's message, which can quote the key, is neither
  shown nor logged.
- **A turn runs, and can be stopped, before its reply begins.** A reply's first frame waits for
  the agent's MCP servers, and in a sandbox for the checkout. The page that sent the message
  shows Stop from the moment it is sent until the send settles, whatever the chat hook's status
  says: a message sent before a new socket has heard whether a turn was left running is set back
  to ready by that answer, with the turn under way. A page that opens meanwhile, or a socket
  that comes back, hears only that a turn is pending (`cf_agent_stream_pending`), of which the chat hook
  says nothing until the reply starts, so the page reads those frames itself
  (`apps/web/src/lib/pending-turn.ts`) and stops that turn by its request's id. A stop in that
  time ends the run as stopped: the model's request never leaves, and an engine in the sandbox
  is never started.
- **AI Gateway, when the deployment names one.** With `AI_GATEWAY_URL`
  (`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`), every model request goes through
  that gateway with the workspace's key (Workers AI: the deployment's token, see "Workers AI"),
  and `cf-aig-metadata` names the workspace, agent and conversation so its logs and analytics
  split by workspace. `AI_GATEWAY_TOKEN` is for an authenticated gateway. The gateway is reached
  by URL rather than through an `ai` binding, because the binding always calls Cloudflare: local
  development and the tests would need a Cloudflare login. Without the setting, requests go
  straight to the provider.
- **Replies are Markdown**, rendered with `react-markdown` and GitHub's extensions. An image in
  a reply shows as a link instead, so a reply cannot make the browser fetch an address it chose
  (which could carry the conversation away in its query).
- **Deleting a conversation** removes its row, then destroys its Durable Object with the
  messages and traces. Its runs stay (see "Runs").
- **Tools** come from the agent's MCP servers (see "MCP servers"), and for an agent with memory
  from the workspace's memory (see "Memory"). The conversation shows each
  call as its server and tool, running, done or failed; what went in and came back is in the
  messages, for the model, and not shown.

### Where a tool call can send data

Each turn keeps a private set of destinations mentioned by the person in the conversation, the
agent's instructions, its configured MCP server hosts and allowed targets, and the workspace
members' email addresses. A trigger also trusts the prompt in its definition, before any event
values are substituted. A chat message from a person has no source marker. A marked delivery,
including a trigger, team edge or outside MCP task, contributes no trusted text, even on replay.
A later person turn starts tainted when its history contains such a delivery.
Tool results, memory notes, the event body and model output supply no
destinations. Nested turns inherit their caller's destinations and exposure to outside content.
Even under an untainted parent, a nested turn never trusts its delegated message. This is
deliberately stricter than first planned. The model wrote that message, and destinations from the
person are already among the inherited sources.

After a turn sees outside content in a tool result, Gateweave checks the destinations in each
tool call, including memory writes and team edges. Trigger runs, replays and runs of unknown origin start with the
check active. The sandbox's own tools (`run_command` and the file tools) are not checked: the
sandbox's outbound rule decides what a command can reach, and a file is no destination.
A built-in tool can name its content fields: those for a destination its configuration fixes.
`open_pull_request` names its title and body, since it opens in the configured repository.
A link in a content field is not checked, because a reader follows it only by choice. An image is
checked, because the page that shows it fetches it. That covers Markdown and HTML images and
reference definitions. Only a plain link counts as a link: no `!` before it, and text with no
bracket, backslash, line break, backtick or angle bracket. An image's description may nest
brackets, escapes, code spans and raw HTML, so any other bracketed destination is checked as an
image's, a link with code in its text included. Every other field is checked whole, so
a field added later is checked until someone decides otherwise. Connected MCP tools, including Track's, have their whole input
checked. An MCP server can exempt a tool by explicitly marking it read-only and closed-world.
Memory saves return Gateweave's confirmation and leave the turn's taint unchanged. A recall taints
the turn. Claude Code, Codex and OpenCode use this check for Gateweave tools. Their own shell
and fetch tools are governed by the sandbox outbound rule (`decideOutbound`), and their results
still taint the run.

The first release logs calls that would be refused so operators can measure the effect before
enabling enforcement. Each flagged span records `target.decision = "would_refuse"` with the target
kind and host or email domain. Its status records the execution outcome. Enforcement returns a
tool error with the missing destination before execution.

The rule checks where data goes. Data sent back to a trusted target can still disclose information.
The check extracts destination-named fields, URLs with a scheme, email addresses and dotted IPs.
A destination field holding a street address or another non-network value yields no target.
In a tainted run, the rule checks `remember` and `recall` like any other call, so it flags a
memory note naming an untrusted address.
In a person's task, agent instructions and free-text tool arguments such as shell commands,
a dotted name without a scheme counts when
it is followed by a path or a port and its final label is 2 to 24 letters. The check skips the
file extensions `js ts tsx jsx mjs cjs json md txt yaml yml toml lock html css scss py go rs rb
java kt sh ps1 xml csv log png jpg jpeg gif svg webp pdf zip gz tar c h cc cpp hpp cs php sql vue
svelte mdx ini conf cfg env map wasm jsonl tsv ipynb swift m mm scala dart lua r pl ex exs erl
hs clj tf hcl proto gradle bat cmd`, regardless of case.
In a free-text tool argument, a bare dotted name without a path or port is ignored, to avoid
treating filenames as destinations. In a person's task and the agent's instructions, a bare
dotted name names a host, as does `localhost`, unless its final label is one of those
extensions. So `Edit deploy.sh` trusts nothing, while `check example.com` trusts
`example.com`.
Explicit URLs, authorities beginning with `//`, email addresses and bracketed IPs in trusted
text always name destinations, including URLs whose host ends in a file extension.
After `//` or a scheme with one slash, a single numeric IPv4 part must be at least 2^24,
and a dotted numeric host must have a nonzero first part. A full `scheme://` accepts either.
Outside text pasted into chat by a person becomes trusted. Destinations other than addresses or
URL hosts can escape the check, as can base64, percent-encoding embedded in text, and a destination
split across fields. JSON strings inside arguments are inspected as JSON.

## Runs

Every turn that reaches the model is a run. The registry keeps a summary of each, and the
conversation's Durable Object keeps its trace (`packages/runtime/src/trace.ts`).

- **The registry opens the run.** `beginTurn` adds a `runs` row (`running`, the agent, model,
  conversation and member) in the write that opens the key, and returns its id. A turn the
  registry refuses (no key, the agent removed) is not a run.
- **The trace stays with the conversation**: a span per model request in the conversation's own
  SQLite (`trace_runs`, `trace_spans`), written as each step starts and ends, with its timing,
  tokens, cache reads, estimated cost, finish reason, time to the first token and AI Gateway's
  log id (`cf-aig-log-id`). Connecting to each MCP server is a span too, with how many tools it
  gives the agent (after its allowlist), and so is each tool call, under the model request that made it, with the sizes of its
  input and output. A trace holds no message text and no tool input or output (only the reason a
  sandbox tool failed, as above), so it is private
  to the conversation without being secret: it goes when the conversation is deleted, and admins
  can read it while it lasts.
- **The runtime closes the run** once, from whichever of the AI SDK's `onEnd`, `onAbort` and
  `onError` comes first. A run is `succeeded`, `failed` (with the app's own sentence), `stopped`, or
  `step-limit` when its request budget prevents another model call. It sums the model spans and
  reports them with `finishRun`, which changes only a run still `running`, so a late or repeated
  report changes nothing.
- **A restart can cut a run short.** When a conversation wakes, it closes the runs it finds still
  open as `interrupted`, at the last moment its trace saw them move, and reports them. A
  conversation nobody opens again never wakes, so the registry marks runs older than an hour
  `interrupted` itself, with no end, before it lists or sums them. If the conversation does wake
  later, its report still fills in what the run used, once.
- **Cost is an estimate**, in millionths of a dollar: each request at the list prices of the day
  it ran (`packages/model/src/prices.ts`), with cache reads and writes at their own rates and the
  long-context rates when a request crosses its model's threshold. A model the table does not
  list gets no estimate, and neither does a run that used one; the Overview says how many runs it
  left out. The provider's bill and AI Gateway's logs stay the record.
- **Runs outlive their conversations.** Deleting a conversation clears the run's link to it in
  the same write, so the workspace's usage stays counted.
- **A run can be replayed from a model request** (AGT-73), to see whether a change to the agent's
  instructions or model fixes a run that went wrong. Each turn remembers the person's message it
  answered (`run_messages` in the conversation, `packages/runtime/src/replay.ts`). Replaying step
  `n` reads the run's conversation up to that message, with the first `n` steps of the answer
  (their tool calls and results; a step starts at each `step-start` part), and a new conversation
  of the caller's (`startReplay`, `conversations.replay_of`) takes it as its history: its first
  run is the replay (`runs.replay_of`), with the agent, or its team, as it is now. Only whoever
  started a run may replay it, since that copies their conversation's words into a new one; owners
  and admins may also replay a trigger's run, whose words they read on the run already. A run of
  an engine in the sandbox is refused, since its session lives in the CLI, and so is a run a
  team's edge started (replay the run at the top), one still going, and one from before runs
  remembered their message. The run's page offers "Replay from here" on each model request, links
  a replay to the run it replays, and lists a run's replays.
- **The workspace can get the traces** over OpenTelemetry (AGT-72). Settings > Telemetry keeps an
  OTLP/HTTP endpoint and its headers, sealed together in the registry's `telemetry` row
  (`packages/registry/src/telemetry.ts`); pages see the headers' names and how the last export
  went. When a run ends, `#report` puts it in the conversation's `otel_outbox` and sends it at
  once (`packages/runtime/src/telemetry-export.ts`): the registry opens the headers for that send
  (`telemetryTarget`), the run's spans become OTLP JSON (`otlp.ts`) and are posted to the
  endpoint's `/v1/traces`, without following redirects. The run is an `invoke_agent` span, its
  model requests `chat` spans with GenAI's `gen_ai.*` attributes for model, tokens and cache
  reads plus `gateweave.cost_usd`, the tools each request called `execute_tool` spans under it,
  and its MCP connections and edges spans of their own. The trace id is the run at the top's id,
  and a nested run's span hangs under the edge span that started it, so a team's turn is one
  trace. No message text and no tool input or output is sent. A send that fails for the network,
  a 429 or a 5xx is tried again from the outbox (an Agents SDK schedule), up to five times, 30
  seconds then four times longer each time; a refused key or another 4xx is not. Each try's
  outcome is recorded against the settings it used, and exporting never fails a run.
- **The deployment gets a copy.** When a deployment binds a Workers Analytics Engine dataset as
  `USAGE`, `finishRun` writes one event for each run it closes (`packages/registry/src/usage.ts`),
  indexed by workspace, with the run's agent, model, tokens, cost and sandbox time. Writing it
  never fails the run, and without the binding nothing is written. It lets whoever runs the
  server see usage across workspaces, for charts and billing, without asking each registry;
  docs/self-hosting.md has the fields and a query.

## Teams

A team is a directed graph of agents run by Gateweave (`packages/registry/src/teams.ts`). It
lives in the registry: `teams`, `team_members` and `team_edges`.

- **Members** are agents run by Gateweave or other teams, by id; ids are UUIDs, so an agent's
  never clashes with a team's. One of the agents is the lead, the one a chat with the team talks
  to. In edges, a team stands for its lead.
- **Edges** go from one member to another: `delegate` hands over a task and waits for the result,
  `ask` asks one question that is answered without tools, and `report` sends a message without
  waiting.
- **The whole graph is saved at once.** `setTeamGraph` takes the members, the edges and the lead
  and checks them together in one write, so a page never saves half a change and nothing can
  slip between two checks.
- **Two rules keep every turn finite**, checked in the team and in every team it is part of,
  since a change deep down changes what the teams above it do:
  - a team never contains itself, directly or through the teams in it;
  - `delegate` and `ask` edges, the ones that wait for an answer, never go in a circle once each
    team in the graph stands for its lead. A refusal names the circle, agent by agent. Reports
    may go back up, since nobody waits on them; how far they go is a limit of the runtime.
- **A removed agent stays where it was**, marked, until someone takes it out, so removing an
  agent never changes a graph by itself. It cannot join a team anew or start leading one. A team
  that is in another team cannot be deleted until it is taken out of there.

### A team's turns

A conversation can be with a team (`conversations.team_id`). Each turn is answered by the team's
lead as it is then (`packages/registry/src/team-turns.ts`, `packages/runtime/src/edges.ts`).

- **Where an agent stands** is the path of teams from the one the person talks to down to the
  one it acts in, and the agent. The lead of the team being chatted with stands at the top. The
  registry keeps each run's place (`runs.team_path`), so the runtime never says where a turn is.
- **Its edges are its tools.** A turn gets one tool per edge its agent can take where it stands:
  its own edges in the team it acts in and, when it leads that team, the team's own edges in the
  team above. That is what "a team stands for its lead" means in a turn. Tools are named
  `delegate__<member>`, `ask__<member>` and `report__<member>` and sorted by name, so a turn's
  tools come in the same order each time. Edges to removed agents are left out.
- **Taking an edge is a nested turn** of the agent at the other end. It runs in a new
  conversation of its own, a `ConversationAgent` reached by RPC (`nestedTurn`). It sees only the
  task, question or message, never the conversation that called it.
  - `delegate` gets the agent's MCP tools and its own edges, and the caller waits for the answer.
  - `ask` is one model request without tools or edges, and the caller waits.
  - `report` gets a full turn, and the caller goes on as soon as the registry has begun it. The
    nested conversation stays awake until the turn ends (`keepAliveWhile`).
  - Stopping a turn stops the delegates and asks it waits on; reports go on.
- **The registry decides each one.** The nested turn calls `beginTurn` with the edge it came
  through: the calling run, its span for the call, the edge's kind, team and member. The registry
  checks it against the graphs as they are, from the calling run's stored place, and checks the
  limits. It does so again in the write that opens the run, so two calls at once cannot both
  slip under a limit. A refusal comes back to the calling model as the tool's error, in our
  words.
- **The limits** (`TEAM_TURN_LIMITS`): a message's turns nest at most 4 edges deep, one turn
  takes at most 8 edges, and one message leads to at most 32 nested turns in all. An answer to an
  `ask` takes no edges. Reports may go in a circle, so these limits are what keeps a team from
  running away with the workspace's keys.
- **Nested runs** have the calling run (`parent_run_id`), its span for the call
  (`parent_span_id`), the run of the person's message (`root_run_id`), the edge and the depth.
  The caller's trace has an `edge` span per call, pointing at the run it started. A nested run
  belongs to the member whose message started it all, and counts once in usage, like any run.
- **No public route.** A nested conversation (`conversations.root_id`) is not listed or opened
  by the registry, so the chat gateway sends 404 for it. A turn there without an edge is refused.
  Deleting the person's conversation deletes the nested ones with it, Durable Objects included.

## Triggers

A trigger starts a run of an agent run by Gateweave, or of a team's lead, when another service
posts a webhook to it (`packages/registry/src/triggers.ts`, `apps/web/src/server/triggers.ts`), or
on a schedule.
Owners and admins make them on the agent's or team's page, each with a name, a prompt and how
many runs it may start a day.

- **Standard Webhooks.** Each trigger has a secret, `whsec_` and 32 random bytes in base64, sealed
  in the registry like a provider key and shown once, when it is made or replaced. A delivery
  carries `webhook-id`, `webhook-timestamp` and `webhook-signature`: an HMAC-SHA256 of
  `id.timestamp.body` under the secret, compared with WebCrypto's `verify` in constant time,
  within five minutes of now. Several `v1,` signatures may come at once, as from a sender
  rotating its secret. A sender that makes its own secret and signs with it, as a Gateweave
  Track webhook does, is pasted in place of the trigger's ("Use the sender's secret").
- **The gateway is the only public way in.** `POST /api/triggers/<workspace id>/<trigger id>`
  counts each client's posts in the isolate, caps the body at 64 KB while reading it, requires
  the three headers, and checks in D1 that the workspace exists before it reaches the registry,
  so no registry is made for a made-up id. Only then does the registry check the signature: the
  gateway trusts nothing about the sender, and a member's session plays no part.
- **One run per event.** The registry keeps each delivery by its `webhook-id` for seven days
  (`trigger_deliveries`). A retry of one that started a run or was skipped gets `202` with that
  run and starts nothing. A retry while its run is starting gets `409` with `Retry-After`, since
  that run may yet fail to begin. One that was over a limit or could not begin is taken again;
  one left starting for a minute, as when the Worker stopped in between, too.
- **Limits.** A trigger starts at most 10 runs a minute and its own number a day (50 unless set,
  up to 1,000), counting the runs that began and those about to, in the write that admits the
  delivery. Past either, the sender gets `429` with `Retry-After`. A workspace has at most 50
  triggers. A paused trigger answers `202` and starts nothing.
- **Event types.** A trigger may be limited to some event types, by the `type` in the event's
  body (`triggers.events`, up to 20, null for every event). An event of another type, or with
  none, answers `202`, starts nothing, and shows as skipped with why, so a sender set to send more
  than the job needs costs no runs. Like a paused trigger's, a skipped event stays skipped when
  its sender retries it.
- **Labels.** A trigger may be limited to issues that carry a label (`triggers.label`), by its name,
  compared trimmed and ignoring case, so `agent` starts runs for Gateweave Track issues labeled
  `agent`. On `issue.updated` it starts a run only when the label was just added, which the body's
  `updatedFrom.labelIds` shows, so an edit of a labeled issue starts nothing. An event about no
  issue, or about another one, is skipped with why, as an event of another type is. A scheduled
  trigger takes no label.
- **Assignees.** A trigger may be limited to the issues assigned to one Gateweave Track member
  (`triggers.assignee`), by the id Track gives them, which MCP's `get_workspace` returns as `you`
  for an agent member's key (`assigneeSkip` in `packages/model/src/triggers.ts`). The issue's
  `assigneeId` must be that id, and on `issue.updated` the change must have just made it so:
  `updatedFrom` lists the fields a change touched, so an edit of an issue that stayed theirs
  starts nothing. A comment starts a run while the issue is theirs, but only a person's
  (`data.actor.type`): Track sends no change of the agent member a webhook is for, and one by
  another agent or by Track itself is skipped, so two agents cannot keep each other going. Other
  events about an issue start a run while it is theirs. A scheduled trigger takes no assignee.
  The trigger also keeps what Track calls the member (`triggers.assignee_name`), which the app
  shows in place of the id: a setup gives it, and every signed event about an issue assigned to
  them names them as of the event (`data.issue.assignee`, read by `assigneeNameOf`), whether or
  not it starts a run, so a trigger made without a name gets one and a rename in Track shows. A
  change of assignee drops the name of the one before.
- **Its own conversation.** An admitted delivery opens a conversation for its run alone, started
  by `trigger:<id>` rather than a member (`conversations.trigger_id`), titled after the trigger
  and the event's `type`, unless its trigger keeps one per issue.
- **One conversation per issue.** A trigger may keep one conversation for each Gateweave Track
  issue (`triggers.per_issue`, AGT-58). The first event about an issue opens it, titled after the
  trigger and the issue's key, and notes the issue as `<workspace id>:<issue id>`
  (`conversations.issue`, from `issueOfEvent`), which stays the same when the issue is renamed or
  changes team. A later event about it takes its next turn there, with what was said and done
  before: a sandbox agent works on the conversation's branch again, which a new container fetches
  from GitHub, and `open_pull_request` updates the same pull request. A conversation takes one
  turn at a time, so while it is on one (a run of it going, younger than a run's hour, or a
  delivery's run starting), an event about the issue gets `429` and shows as over the limit, for
  the sender to retry. One that was deleted is replaced by a new one, and an event about no issue
  opens its own, as without the setting. A retry of a delivery whose run could not begin removes
  the conversation opened for it only when no run took place there. The gateway then calls `triggerTurn` on its `ConversationAgent` over
  RPC, which asks the registry to begin the run (`beginTriggerTurn`) and stays awake until the
  turn ends, as a report's does. The message is the prompt, with each `{{path}}` filled in from
  the event's JSON, and the event after it. A team's trigger starts the lead with the team's
  edges, like a person's message to the team.
- **Nobody's conversation.** No member lists it, opens it in Chat or goes on with it, and
  `beginTurn` refuses it. Its runs (`runs.trigger_id`, nested ones too) belong to the trigger, so
  owners and admins see them and members do not, and the run's page shows its conversation,
  which the server reads from the Durable Object for that page alone.
- **Schedules.** A trigger can instead start runs on a schedule (`triggers.schedule`): a cron
  expression of five fields read in an IANA time zone, so `0 9 * * 1-5` stays 9:00 on weekdays
  across summer time ([croner](https://github.com/hexagon/croner) parses it). It runs at most
  every five minutes, and one that never runs is refused. A scheduled trigger takes no webhooks:
  its URL answers `404` and its secret is never shown. The registry keeps each one's next time
  (`triggers.next_run_at`, null while paused) and sets its alarm for the earliest, together with
  the label scans. When the alarm fires, each due schedule is admitted in one write as a delivery
  with the id `schedule:<due time>`, under the same limits as a webhook's, and its next time is
  taken from then on. A schedule that fell behind, as when nothing woke the registry, runs once
  rather than once for each time it missed. The run starts in its own conversation, as a
  webhook's does, with an event of the type `schedule` whose `data.scheduledFor` is the time it
  was due. The registry package cannot reach the runtime, so the app's `RegistryDO`
  (`apps/web/src/server/registry-do.ts`) subclasses it to call `triggerTurn` on the
  conversation, as the gateway does; a run that cannot begin is kept as a failed delivery.
- **What came lately** shows under each trigger: its last ten deliveries, whether each started a
  run, was skipped, went over a limit or failed, and why.
- **Deleting a trigger** deletes its deliveries; the conversations and runs it started stay. A
  team's triggers go with the team.

### Track triage

The first agent made for a Gateweave product triages new issues in Gateweave Track, set up by an
owner or admin in one dialog on the Agents page ([docs/track-triage.md](track-triage.md)). The
names, the prompt and the tools are in `packages/model/src/track-triage.ts`, the setup in
`packages/registry/src/track-triage.ts`, and the instructions the agent follows in
`apps/web/src/server/track-triage.md`.

- **The key is tried first.** The server function (`apps/web/src/lib/track-triage.ts`) checks
  Track's MCP server with the agent member's key (`gwt_` and 43 characters) and needs the five
  tools triage uses, before the registry makes anything. The check is kept as the server's last
  one, so the MCP page lists its tools at once.
- **One write makes it all:** the instructions, an environment set whose secret
  `TRACK_AGENT_KEY` holds the key, Track's MCP server with `Authorization: Bearer
  ${TRACK_AGENT_KEY}`, the agent pinning all three, and a trigger for it on `issue.created` only,
  50 runs a day. The key
  and the trigger's secret are sealed before the write, the workspace's trigger limit is checked
  before anything is inserted, and a refusal after that throws, so a failure leaves nothing half
  made. A name already in the library gets a number (`track 2`).
- **Track makes the webhook's secret.** The trigger's own is never shown: the dialog's second
  step gives the URL to add in Track and takes the secret Track shows, as "Use the sender's
  secret" does. The webhook names the agent member under "For agent", so Track leaves the
  agent's own changes out and it never triggers itself.
- **Least privilege.** The agent pins Track's server with a tool allowlist of `get_workspace`,
  `get_issue`, `search_issues`, `update_issue` and `add_comment`. An issue is text anyone in the
  Track workspace wrote: the instructions say to read it as data, and the allowlist is what holds
  if a model is talked into more.

### Track issue work

The second agent made for Track works on the issues assigned to it (AGT-54): it is an agent member
of a Track workspace that people assign issues to, and each one becomes a run in a sandbox on one
of the workspace's repositories, ending in a pull request
([docs/track-work.md](track-work.md)). The names, the prompt and the tools are in
`packages/model/src/track-work.ts`, the setup in `packages/registry/src/track-work.ts`, and the
instructions in `apps/web/src/server/track-work.md`. It reuses triage's parts where they are the
same (`makeTrackAccess`: the instructions, the environment set with the key, and Track's MCP
server).

- **The key says who the agent is.** The server function (`apps/web/src/lib/track-work.ts`) checks
  Track's MCP server with the key as triage does, then asks it which member the key is
  (`checkTrackAgent` in `packages/runtime/src/tools.ts`): the one workspace `list_workspaces`
  lists, which must have the key as an `agent`, and the member `get_workspace` returns as `you`.
  A Track too old to say is refused with that reason, before anything is made.
- **One write makes it all**, as for triage, plus what the work needs: the agent has a sandbox, the
  chosen repository and engine, and the registry holds them to the usual rules (an engine calls
  only its providers' models, and the repository must be one the GitHub App reaches), so a
  refusal throws and undoes the write. The trigger takes `issue.created`, `issue.updated` and
  `comment.created`, with the member's id and name as its assignee and one conversation per issue, at most
  20 runs a day, since each can hold a sandbox for an hour.
- **It reports on the issue.** A trigger's run is told its page in the app, after the trigger's
  message (`triggerTurn`'s `runs`, from `apps/web/src/server/runs-page.ts`: `BETTER_AUTH_URL`'s
  origin, or the delivery's), so the agent links it when it comments that it started. It then moves
  the issue to In Progress, works in the repository, opens a pull request with
  `open_pull_request` (titled with the issue's key, and ending `Fixes <key>`, so Track's GitHub
  connection links it), comments with its link and moves the issue to In Review. When the issue
  is unclear it asks in a comment, mentioning who assigned it, and stops.
- **The page shows a delivery's message as an event** (AGT-120). `triggerTurn` stores it with
  `TRIGGER_MESSAGE_METADATA` (`{ source: "trigger" }`), which the model never receives, and the run page and
  Chat show it as a card: Track's event in words, the issue as a link, who did it, and the JSON in a closed
  disclosure (`apps/web/src/lib/trigger-message.ts`). A first message stored before the marker is
  recognised by its text; the text the model gets is unchanged.
- **A comment continues the work** (AGT-58). A person's comment on the issue takes the next turn
  of the issue's conversation: the agent answers a question, goes on once its own is answered, or
  makes the change asked for and pushes it to the same pull request, then comments once. Being
  assigned the issue again also continues the conversation, rather than starting over.
- **The same limits.** Track's tools are the same five as triage's. In the sandbox, the agent's
  pushes reach only its conversation's branch, through `open_pull_request`, as for any agent; the
  pull request is where a person reviews what an issue talked it into. Agents' proposal settings
  in Track still apply to the agent member.

### Connecting Track in one step

Both ready-made Track setups start from "Connect Track" (AGT-119), which replaces copying the agent
member's key into Agents and the webhook's secret back into Track. Track's half is its
`/connect/agent` page and `/api/connect/exchange` and `/undo`; the contract between the two is in
AGT-119. The address, the verifier and Track's answer are described in
`packages/model/src/track-connect.ts`, the pending connection in
`packages/registry/src/track-connect.ts`, and the flow in `apps/web/src/server/track-connect.ts`
(the exchange and undo calls are in `track-exchange.ts`). "Set it up by hand", the two steps above,
stays in the dialogs for a Track that has no such page or cannot be reached from the browser.

1. **Start.** `beginTrackConnect` (an owner's or admin's server function) checks what it can before
   the browser leaves: the provider has a key (or is Workers AI and offered), sandboxes are offered
   for work, and the registry applies the rules the setup applies (the repository is one the GitHub
   App reaches, the engine calls the provider's models), by `checkSandboxChoices`. It keeps a
   pending connection in the registry (`track_connections`): a random `state`, bound to the person,
   good for ten minutes and taken once; with it the choices, Track's origin, a random `verifier`
   (64 characters, sealed) and the id the trigger will have, so the webhook's URL exists before the
   trigger does. It answers with `<track>/connect/agent?purpose&name&webhook&events&return&state&challenge`.
   `webhook` and `return` are on this deployment's own origin (`BETTER_AUTH_URL`'s when set),
   which Track insists they share. `challenge` is the SHA-256 of the verifier; the verifier and the
   choices never go to the browser.
2. **Approve.** In Track the person chooses a workspace and team and presses Allow. Track makes the
   agent member and the webhook, both or neither, and sends the browser to
   `/api/track/connected?code&state`, or `?error=denied&state` for Cancel.
3. **Finish.** `GET /api/track/connected` needs a session. The return address names the workspace
   (`?workspace=<id>`, which Track keeps; its state takes only letters, digits, `_` and `-`); the
   caller must be an owner or admin of it now, and `trackConnectTake`
   gives the pending connection only to the person who started it and only once: any other call
   spends it and gets a plain page that makes no outbound call. After Cancel, the person lands on
   the Agents page with a notice that nothing was made. Otherwise the server posts `{ code,
   verifier }` to Track's `/api/connect/exchange` (no redirect followed, ten seconds, the answer
   read up to 16 KB and checked with `trackExchangeAnswer`), checks the key with Track as the manual
   setup does, and makes everything in one registry write: the same `setUpTrackWork` or
   `setUpTrackTriage`, now with the trigger's fixed id and Track's webhook secret as its secret.
4. **The trigger's assignee** is what `get_workspace` returns as `you` for the key (`checkTrackAgent`),
   which is the Track user id, the form an issue's `assigneeId` has in a delivery. Track's answer
   names the same id as `agent.id` (`memberId` is Track's member row, which nothing here uses); the
   two must agree, or a trigger that would never match is not made.
5. **If anything fails after the exchange** (the check, the registry write), the server calls
   `/api/connect/undo` with the token Track gave, up to three times for a `try_again`, and says
   nothing was left behind. If the undo fails too, the page names what is left in Track, the agent
   member and its webhook, and where to remove them. The same undo runs for an answer that cannot
   be used but names an `undo` token. Track makes both when the person allows, before the
   exchange, so an exchange that got no usable answer and no token (refused, busy, unreachable,
   unreadable) leaves nothing to undo with: the notice then says they may still be in Track and
   where to remove them, never that nothing was made.
6. **Audit.** `track.connected` records Track's origin, the Track workspace's slug and the agent's
   id, beside `trackWork.setUp` or `trackTriage.setUp`.

Threat model, briefly:

- The `state` is single use and bound to the person, so a link someone else follows, or follows
  twice, makes nothing.
- The `code` is useless without the verifier, which never leaves the server, so reading the code
  from the address (a history, a log, a Referer) gets nothing. It lives a minute in Track.
- The key, the webhook's secret and the undo token travel once, server to server. They are never in
  a page, an address, a log line, an error message or the audit log: failures are named, not quoted.
- Track's answer is validated and size-capped because the address is whatever the person typed, and
  a hostile server could answer with anything, or never stop.
- A hostile "Track" address can do what a typed address could already do in the manual setup, and
  no more: receive this deployment's webhook URL and a challenge, which are not secret, and
  answer. It can make nothing here unless the person is sent back with a state that is theirs, it
  sees the verifier only in the exchange, once, for a state already spent, and what it hands back
  is checked against Track's MCP server before anything is made. The dialog says to use an
  address you trust.
- The route is off in the demo, as the manual setup is.

### Track run reporting destinations

An owner or admin can connect a reporting destination from the Agents page. The browser goes to
Track's `/connect/source` approval page to choose a workspace and team. The flow shares the
one-time pending state, sealed verifier, and ten-minute lifetime of agent setup. It uses its own
callback and checks admin access both before the exchange and before saving the destination.
The exchange must name the exact `/api/events` endpoint at the approved Track origin.

The registry keeps one destination per Track origin, workspace and team in
`track_source_destinations`. It seals the source's event-writing key to the connection id and
Track origin. Moves and backups carry its ciphertext. Admins see only destination metadata,
and access to the key stays server-side. A second approval for the same destination keeps the
original and asks Track to undo the unused source. If the save is interrupted, the callback
checks the source's identity
and reports uncertainty when it cannot confirm the save. Disconnect removes the local destination
and credential. Revocation is managed in Track under Settings > Sources. The demo has the flow off.

## Memory

A workspace keeps short notes for its agents to recall in later runs (AGT-107): facts, decisions
and preferences, each saying who or what wrote it and where it came from
(`packages/registry/src/memory.ts`). [memory.md](memory.md) has the user's view. This is the first
slice: keyword recall in the registry. Vectors come once recall needs them.

- **Storage.** A `memories` table in the registry: the text (up to 2,000 characters), its kind
  (`fact`, `decision` or `preference`), what it is about (`scope`: the workspace, or one agent,
  repository or person by id), who wrote it (`author_kind` and `author_id`: a person's user id or
  an agent's id), the run and conversation an agent wrote it in and what started that run
  (`origin`, read when the memory is written, since the conversations it is read from may be gone
  later), a person's label and https link for its source, whether it is `trusted`, who approved
  and who last edited it, when it was made and changed, when it stops being recalled
  (`expires_at`), and when and in which run its agent took it back (`forgotten_at`,
  `forgotten_run_id`). People are ids here, as everywhere in the registry; the app names them.
- **Full text.** An FTS5 table, `memory_search`, holds each memory's text under the memory's `seq`,
  an integer primary key, since the rowid of a table keyed by text can change in a VACUUM. Drizzle
  cannot express an FTS5 table, so its migration (`0040_memory_search.sql`) is written by hand, as
  Track's issue search is. The tokenizer is `unicode61 remove_diacritics 2`, so case and Latin
  accents do not matter, with prefix indexes for words cut short. Every write changes the row and
  the index in the same `transactionSync`, in code and not by SQL triggers: a move copies the
  index by its content ([Where a workspace lives](#where-a-workspace-lives)), and a trigger would
  then index every memory twice. A person's removal of a memory (delete, dismiss, an account's
  deletion) also merges the index (`optimize`), because FTS5 otherwise keeps a deleted row's
  words in its pages until a merge. A merge rewrites the whole index, so nothing an agent calls
  runs one: when the oldest forgotten memories are dropped, their words go with the next merge.
- **The trust rule.** A memory is recalled by every later run that can see it, so one written from
  an outsider's text would steer runs long after the run that read it: prompt injection that
  stays. An agent reads outsiders' text in any run: a trigger's event, and in a person's chat an
  issue, a page or a tool's result. So the registry decides from two things it reads itself, what
  started the run and what the memory is about:
  - what an owner or admin types on the Memory page is trusted;
  - what an agent writes about **the workspace or a repository** is stored **not trusted**,
    whatever started the run: every agent, or every agent of that repository, would recall it, so
    a person lets it in;
  - what an agent writes about **itself or the person whose message started the run**, in a run a
    person's chat message started, is trusted at once: only that agent recalls the first, and
    agents recall the second only in that person's runs;
  - what an agent writes in a run a trigger started (a webhook, a schedule), in a replay of one,
    or in a run whose start cannot be read, is stored not trusted, whatever it is about.

  A memory that is not trusted shows on the Memory page as waiting, and no agent recalls it, not
  even in the run that wrote it, until an owner or admin approves it (`approved_by`), or
  dismisses it, which removes it. Editing one that waits does not approve it.
- **The limit that remains.** A note an agent keeps for itself in a chat can carry something it
  read from an outsider during that chat, and that agent recalls it later, in a trigger's run
  too, with nobody having approved it. The rule bounds how far such a note reaches (one agent, or
  one person's runs) and does not stop it. What answers it is how recall hands memories over:
  as notes with who or what wrote each and when, under a notice that they are records and not
  instructions, in a tool's result and never in the system prompt.
- **What started a run is read from the run.** The runtime passes the tools' calls on with the
  run's id and nothing else. The registry reads `runs.trigger_id`, which `beginRun` sets from who
  started the run, for a trigger's nested runs too (`runOrigin`). A replay of a trigger's run has
  that run's words as its history, so the registry also follows `conversations.replay_of` from
  the run's conversation, or for a team's nested turn the conversation it goes with, back through
  each replayed run, up to 20 of them, for every turn of the replay. A link it cannot follow,
  such as a replayed run whose conversation was since deleted, counts as outside (`unknown`). The
  run must still be going (`running`, and younger than a run's hour), must still have its
  conversation, and its agent must have memory on: a run whose conversation was deleted, by its
  member or with their account, is refused, so it writes nothing after what it wrote was
  removed. Nothing the model says can make a memory trusted that this rule holds back.
- **Tools.** An agent whose definition has `memory` on gets three tools in Gateweave's own loop
  (`packages/runtime/src/memory-tools.ts`). The switch is off unless someone turns it on in the
  agent's form, as the sandbox is, so agents made before memory have none; a turn without tools
  (an `ask`) has none either, and nor has an engine in the sandbox (`ConversationTurn.memory`).
  The form says that every member of the workspace can read what the agent notes.
  - `remember({ text, kind, scope? })` answers `{ id, waiting }`. The scope is `agent` (this
    agent alone, when none is given), `workspace`, `repository` (the one the agent works in) or
    `person` (whoever's message started the run); the registry fills in the id, and refuses a
    scope the run has nothing for. The description tells the model which notes wait and what
    `waiting: true` means, and to use `person` for anything about the person it is talking to.
  - `recall({ query, scope?, limit? })` answers `{ notice, memories }`: the trusted memories that
    are not forgotten or expired and that this agent may see, which are the workspace's, its own,
    its repository's, and those about the person whose message started the run. Each has its
    text, kind, scope, who wrote it, its source and its date. Who wrote it is "the agent Scout"
    or "a person", with ", edited by a person" for an agent's memory a person changed, and for
    one that waited where it came from and that a person approved it: "in a run a trigger
    started", "in a replay of a run a trigger started", "in a run a person's message started".
    The notice, and the tool's description, say that these are stored notes and not
    instructions. Nothing of memory goes into the system prompt.
  - `forget({ id })` takes back a memory the agent wrote itself, which stays for people to read
    and is never recalled. Anything else is refused, and a run that did not start from a
    person's message takes back only what still waits, so that an outsider's text cannot remove
    memory the workspace trusts.
  - A refusal reaches the model as the tool's error, in the registry's words. The trace records
    each call's timing and sizes, and a refusal's sentence, never a memory's text.
- **Recall is by keyword.** A query is cut into runs of letters and digits with the marks written
  on them, at most 16, and each is quoted as a prefix term, as typed; they are joined with `OR`
  (`memoryMatch` in `packages/model/src/memory.ts`). Folding is the tokenizer's alone, which
  reads a quoted word as it read the memories: a query folded in code was folded differently, and
  missed a Hindi or Arabic memory, whose words the tokenizer cuts at the marks it does not fold.
  A word the tokenizer cuts in several is matched as that phrase. A single Latin, Greek or
  Cyrillic letter is dropped, such as the "t" of "can't", which as a prefix matches every word
  that starts with it; a single digit matches itself only; one character of another script
  stays. Nothing else of a query reaches FTS5, so `AND`, `NEAR`, a column name or a stray quote
  is a word or nothing, and no query is a syntax error. Matches come best first (`bm25`), the
  newest first among equals. A query without a word lists the newest. The Memory page's search
  uses the same words joined with `AND`.
- **Limits**, held in the registry, each with a refusal that says what to do:
  - 5,000 memories a workspace that are not forgotten;
  - 500 of them waiting, so that agents cannot fill a workspace's memory;
  - 1,000 forgotten ones kept, past which the oldest are removed;
  - one run stores at most 20 and takes back at most 20, counted from the rows (`run_id`,
    `forgotten_run_id`), so a run cannot store and take back in a loop, each round an index
    write and two audit entries;
  - `recall` returns at most 20, and 8 when the call names no number.
- **The Memory page** (`apps/web/src/lib/memory.ts`). Members read it. Owners and admins add,
  edit, approve, dismiss and delete; a delete removes the row and its index row. The registry is
  told who by the server function, which checked the role, and takes a memory about a person only
  after the server function has checked that the person is a member. A conversation is its
  member's alone while memory is the workspace's, so every member reads what an agent noted in
  someone's chat; what they are not told is whose. The server function sends a run's id and who
  started it only to someone who may open that run (owners and admins, and the member who started
  it), and null to everyone else, who read "a run".
- **Audit.** `memory.added`, `.edited`, `.approved`, `.dismissed` and `.deleted` are written by
  the server function that made the change. `memory.remembered` and `memory.forgotten` are an
  agent's, with no member: the registry hands them to `memoryChanged`, which the app's
  `RegistryDO` overrides to write the row, naming the agent, its run, what started it and what
  the memory is about; an object that does not know its workspace logs the ids and writes
  nothing. An entry holds the memory's id and at most the first 80 characters of its text
  (`memoryExcerpt`), and nothing of the text of a memory about a person, since the log outlives
  the memory. `memory.deleted` and `memory.dismissed` hold none of the text either, only the
  kind and what it was about: someone just chose to remove it. The entry from when it was added
  or remembered keeps its 80 characters until it is a year old, which the page says before a
  delete, along with what else stays: what an agent recalled is in that conversation's messages.
- **When an account goes**, `forgetPerson` removes, in the write that queues their
  conversations, the memories about that person and every memory an agent wrote in a run they
  started (`runs.started_by`), whatever it is about, with their index rows: such a note came out
  of a conversation that was theirs alone, and an agent may have filed something about them
  under itself. What they typed on the Memory page stays, as what they set up does, under their
  id, and so does what other people wrote and what agents wrote in other people's runs and in
  triggers'. Someone who leaves a workspace, or is removed, and keeps their account loses
  nothing there, as their conversations stay too; the account's deletion reaches the workspaces
  they left ("Workspaces they left count too" above).
- **Backups and moves** need nothing new. A backup dumps every table, and Gateweave Backup copies
  an FTS5 table that keeps its own text with its rowids, which `memory_search` is. A move copies
  `memories` like any table and the index by its content.
- **Not yet:** vectors in Vectorize with reranking, AI Search over documents, the memory tools for
  the engines that run in the sandbox (their tools reach them through `engine-tools.ts`, which
  would serve these too), memory for outside clients over MCP, an end date set by an agent, and
  bringing back a forgotten memory.

## Repository wiki

A repository's wiki is pages a model writes about its code (AGT-108), each citing the lines it
explains, in the shape DeepWiki gives: numbered pages (`1`, `1.1`, `2`) with "Relevant source
files" and `**Sources:** [path:12-30]()` under what they cover. An owner or admin has one written
on the Wiki page, choosing a model of a provider the workspace has a key for (Anthropic, OpenAI or
Google, not Workers AI), and every member reads it. Private repositories are read the way scans
read them, through the workspace's GitHub or GitLab connection.

- **A Workflow writes it.** `startWiki` in the registry notes a generation and starts the app's
  `WIKI` Workflow (`apps/web/src/server/wiki/workflow.ts`), one step per model request: one plans
  the pages, one writes each page, and one makes the wiki the one people read. A step that fails
  tries again on its own, and so does an answer that is empty, cut off at the output limit or, for
  a plan, not the JSON asked for. A refusal that asking again cannot change, such as a key the
  provider does not take, fails at once. A wiki that cannot be written is marked failed with the
  reason, and the one people read stays as it was. A plan saved by a try whose answer was lost is
  not asked for again. A repository has one generation underway at a time (a partial unique
  index), and one that has not got further for an hour counts as failed, so another can start. A
  server whose Worker has no `WIKI` binding says so instead of starting.
- **The key never leaves the step.** Each step asks the registry for what it needs, the key among
  it, and hands back what it wrote. Workflows keep what a step returns, so a step returns only a
  count or a length: never the key, a prompt or the repository's code. A provider's refusal is
  turned into a sentence (`describeFailure`), since its own message can repeat part of the key.
- **Planning reads the tree and the docs.** The planner gets every file's path and size and the
  docs worth reading first (`wikiDocs`: the README, `AGENTS.md`, `docs/`, the package manifests),
  and answers with the pages, each with up to 12 files to read. Files the repository does not have
  are dropped. Every page then reads the same commit, which planning notes.
- **`.devin/wiki.json` steers it**, as it steers DeepWiki: its pages are kept exactly, in its
  order and under its parents, and its notes reach every writer. A file that breaks one of
  DeepWiki's rules (no pages, more than 30, two with one title, a parent that is not a page, over
  100 notes or 10,000 characters in one) is set aside, the model plans on its own, and the wiki
  says why. Pages nest at most five levels, as far as a page number such as `1.2.1.3.2` goes; a
  deeper one goes under its ancestor on the fourth, so each can be opened.
- **A page is written from its files' text**, with line numbers so that it can cite them, up to
  160,000 characters in all and 40,000 of any one file; a file cut short is marked as such.
  `checkCitations` keeps a citation only if it names a file the page read and lines it saw (a
  file's last newline ends its last line, not another), and turns any other into the plain path,
  so a link never points at lines that do not exist. It reads a page in linear time, whatever the
  model wrote.
- **The finished wiki replaces the last.** `wikiFinish` deletes the older generations of the
  repository. A failed one keeps its row and reason but not its pages, and only the newest failure
  stays.
- **Each wiki says where it came from**: the commit, the model, its tokens and the cost at the
  model's list prices, where they are known. The pages link each citation to those
  lines at that commit on GitHub or GitLab.
- **AI agents read it over MCP** at `/mcp`, with DeepWiki's `read_wiki_structure`,
  `read_wiki_contents` and `ask_wiki_question`, as the person who connected them; see
  [AI agents (MCP)](#ai-agents-mcp). Reading and asking use no model, so only writing a wiki costs
  the workspace anything.
- **What a provider receives** is the repository's paths and the text of the files a page reads,
  with the workspace's own key, as an agent's run would send them. A wiki stays when the person who
  started it deletes their account: it is the team's, and keeps only their id, as a run does.

## The CLI

`@gateweave/agents` (`packages/cli`) applies a setup kept as files to a working tree, and checks
that a working tree still holds it, for CI. It reads a setup folder with `readSetupFolder`, writes
it with `writeAssets` and plans it with `planApply`, like the app, so a file the CLI writes is the
file the pull request would.

- **The working tree stands in for the repository's tree.** Only the paths the setup writes and
  the folders above them are looked at, with `lstat`, so a symlink is never followed and a
  symlink, file or folder in the way is left alone and reported, as a pull request would leave it.
- **Text is compared in LF.** The CLI writes LF, and reads a checkout's CRLF as LF, so a Windows
  checkout does not look changed.
- **`check` fails on what `apply` would write**: exit code 1 lists each file as missing or
  differing. Paths it would leave alone are warnings, not failures.
- **Addresses come from flags.** A setup that asks for an MCP server's address (`askUrl`) takes
  it from `--url <server>=<url>`, for `apply` and `check` alike, and stops with exit code 2,
  naming the flag, when one is missing.
- **One file, no dependencies.** Vite bundles the CLI, the workspace packages it uses and the
  ready-made setups into `dist/main.js`, so a version always writes the same files.
- **Published from CI.** Pushing a `cli-v<version>` tag runs `publish-cli.yml`, which publishes
  that version to npm through trusted publishing, with provenance and no npm token. Only admins
  can create those tags, and the tag must point at a commit on `main` whose
  `packages/cli/package.json` has that version. The CLI's version is its own, apart from the app's.

## Pages

The workspace's pages read the registry through server functions in `apps/web/src/lib/registry.ts`,
each of which checks membership first, so a non-member gets the same "not found" as a missing
workspace.

- **Overview** counts what the registry holds and shows a matrix of repositories by the coding
  agents each one configures, with each repository's drift.
- **Projects** group repositories, and a project's page shows the same matrix for its
  repositories and the agents in them. Owners and admins create, edit and delete projects and
  choose their repositories; everyone else in the workspace sees them.
- **Repositories** lists them with their scan status and drift; a repository's page shows its
  agents, the assets they read grouped by kind, the problems the last scan found, the setups
  merged into it with their drift, and the pull requests that applied them.
- **Wiki** lists the repositories with their wiki's state, and a repository's wiki shows its pages
  beside their numbered outline, at `/<workspace>/wiki/<repository>/<page>`, the page a path segment
  so that `1.10` is not read as a number. Owners and admins have one written or written again
  there, and on a repository's page; see [Repository wiki](#repository-wiki).
- **Agents** lists every agent and subagent by runtime, and owners and admins define agents run
  by Gateweave there. An agent's page shows where a coding agent is configured and what it reads,
  or how an agent run by Gateweave works: its model, whether the workspace has a key for it, its
  pinned instructions with their text, its environment set and its MCP servers, with "Only: …"
  under a server the agent is limited to some tools of. Owners and admins also see its triggers
  there, as they do on a team's page, and set up the ready-made agents below the list:
  [Track triage](#track-triage) and [Track issue work](#track-issue-work).
- **Teams** lists the teams with their leads. A team's page draws its graph top-down from the
  lead (`apps/web/src/lib/team-layout.ts`, inline SVG, no graph library): each member one row
  below the nearest member that reaches it, every kind of edge in its own color and dashes. Below
  the drawing, its members and its edges are lists, which is what a screen reader reads. Owners
  and admins create teams, add and take out members, choose the lead and add and remove edges;
  members see them.
- **Chat** lists the caller's own conversations, the latest first, and starts one with any
  agent run by Gateweave or any team. A conversation's page streams the reply, can stop it, and
  says when the agent cannot answer and why. Agent and team pages have a Chat button too.
  - **Tool calls** show under the reply that made them. The conversation stores every call as a
    static part named after its tool, while the live stream calls MCP tools dynamic, so the chat
    reads both (`apps/web/src/lib/tool-calls.ts`).
  - **A conversation with a team** has the team drawn beside it, shrunk to fit, as on the team's
    page. Its members light up while they work: the page asks the registry for the conversation's
    runs still going (`activeRuns`) while a turn runs, and for as long as any is left, as after a
    report. An agent working inside a member team lights that team. Narrower screens open the team
    over the conversation with a button.
  - **Each call over an edge** shows as its kind and the member it went to, read back from the
    tool's name with the team's member names (`readEdgeToolName` in the model package, next to the
    naming the runtime uses).
- **Runs** lists the runs people's messages and triggers started, the latest first, fifty at a time
  (`apps/web/src/lib/runs.ts`): owners and admins see everyone's, since they answer for what runs
  spend, and members see their own. Each shows its total: the tokens and cost of the run and of
  every run its team's edges led to, added up from the runs of the same message. A run's page
  shows its summary, that total, and its trace as a timeline of connections, model requests, tool
  calls and calls over a team's edges. Each call shows the run it started inside the timeline,
  which opens to that run's own trace there, fetched when opened, or on its own page. The page
  links the conversation only for the member who started it; a nested run links the run that
  called it, and a trigger's run shows its conversation on the page. The Overview sums the last 30 days of runs, nested ones included.
- **Memory** lists the workspace's memories, the newest first, fifty at a time: those agents
  recall, those waiting for approval and those an agent took back, searched by word and filtered
  by kind and by what they are about. Each shows its text, who or what wrote it and in which run,
  linked for whoever may open that run, and when. Members see all of it; owners and admins add,
  edit, approve, dismiss and delete.
- **Environment** lists the environment sets with their variables, their secrets as set or
  missing (never a value), values kept for names that are no longer secrets, and the agents that
  run with each. Members see all of it; owners and admins create and edit sets and set, replace
  and remove values.
- **MCP** lists the library's MCP servers: transport and URL, or the command a local one runs (or
  why an agent cannot reach it), the variables its headers or environment need, the agents that
  pin it with their versions, and its last check with the tools it listed. Members see all of it;
  owners and admins get a Check button per remote server.
- **Library** lists the library's assets by kind, with how many repository assets carry one of
  their versions and how many of those are behind. Owners and admins write instructions, prompts
  and skills there, and add MCP servers.
- **Setups** lists them with how many assets each pins and how many have updates, and below them
  the ready-made setups, which an owner or admin adds to the workspace in one click; a setup's page
  shows its pins, moves one to the latest version, previews the files it writes, applies it to a
  repository, shows the drift of each repository it was merged into, and lists its pull requests.
- **An asset's page** shows the text of each of its files and every earlier version. For a
  repository asset it also shows the agents that read it, the library assets it matches, and how
  many other assets have the same content; for a library asset, the agents that pin it and the
  repository assets that use it. A library MCP server has "Edit settings" instead of editing its
  text.
  An asset with two versions or more offers "Compare versions": any two, as a line diff per file
  (added, removed and changed files). The server function computes it with `diffLines` from the
  `diff` package, imported inside the handler so it stays out of the browser bundle. A file whose
  text is not kept shows only that it changed.

Pages refresh themselves while a scan of what they show is waiting or running.

**Settings** has the workspace's members and invitations, its GitHub connection, where its run
traces go (Telemetry), its model provider keys, and, for owners, deleting the workspace.

## Backups

D1 can be backed up from outside the Worker, but the Durable Objects can't: only the Worker's own
code reads their SQLite. So the Worker exports a named entrypoint, `Backup`
(`apps/web/src/server/backup.ts`), for a backup Worker such as Gateweave Backup's.

- **No route.** A named entrypoint can't be reached from the internet. Only a Worker in the same
  Cloudflare account with a service binding to it can call it, so that binding is the access, the
  way the gateways' checks are for people and agents.
- **`objects(cursor)`** lists, 20 workspaces at a time from D1, each one's `registry.<workspace>`
  and then `conversation.<workspace>.<id>` for each conversation its registry lists, those of a
  team's turns and of triggers included (`backupConversations`). Deleted workspaces aren't
  listed, nor are conversations waiting to be destroyed.
- **`read(name, statements)`** runs the SELECTs of a SQLite dump in that object, after checking in
  D1 that the workspace exists and, for a conversation, that its registry still lists it, so a
  backup never wakes a deleted object nor makes an empty one. For any other name it answers null.
  The object's `backupRead` (`packages/registry/src/backup.ts`) takes only `SELECT` and
  `PRAGMA table_list` or `table_info`, one statement each, and runs them together in one
  transaction that it always rolls back. They see one moment, and nothing they run can change the
  object.
- **What a dump holds.** Every table of the object's SQLite, the Agents SDK's own included: a
  conversation's messages are in `cf_agents_session_messages`. A Durable Object's key-value storage
  (`_cf_KV`) can't be read with SQL, so a dump leaves it out; the Agents SDK keeps its own
  bookkeeping there, such as the object's name and where a stream was, not messages.
- **Restoring** an object from a backup isn't built in. The backup's SQL restores into a SQLite
  database, to read or to load by hand.

## The public demo

Gateweave runs a public demo at https://agents-demo.gateweave.com: the `demo` environment of
`wrangler.jsonc`, a Worker of its own (`gateweave-agents-demo`) with its own D1 database, both in
the EU. The same code ships to every deployment, and everything the demo does is off unless
`AGENTS_DEMO` is `"1"` (`apps/web/src/server/demo/mode.ts`), which only that environment sets.

- **A sandbox per visitor.** The sign-in page has one button, "Open the demo". It calls
  `startDemo` (`apps/web/src/lib/demo.ts`), which counts the visitor's network (20 sandboxes an
  hour and 100 a day per IPv4 address or IPv6 /64, in `RateLimiter`), then makes an account
  through Better Auth's server API, with a random address under `visitors.example.com` and a
  random password nobody sees, a workspace named Acme, and signs the visitor in. The registry then
  fills itself in one call (`fillDemo`): it is where the workspace lives, which may be an ocean
  away from the Worker that took the request. A sandbox that fails halfway is deleted, account and
  all, and the page says why.
- **An opening screen and a bar.** While `startDemo` runs, the browser shows an opening screen
  (`src/components/demo/demo-opening.tsx`, state in `src/lib/demo-opening.ts`, held in the root so
  it survives the move to the workspace). Its steps follow the server's real phases: four on
  timers tuned to a sandbox taking about 7.4 s, the fifth only when the server answers, the sixth
  when the workspace's overview has shown. Inside a sandbox, a bar at the bottom (`demo-bar.tsx`)
  counts down to cleanup from the visitor's creation time, which `getWorkspace` returns as
  `demoCreatedAt`, and points to Gateweave Cloud and the repository (`src/lib/demo-links.ts`); a
  welcome card shows once per sandbox.
- **Sample data that adds up** (`apps/web/src/server/demo/sample-data.ts` and `sample.ts`). Three
  repositories on `gitlab.example.com`, a host reserved for examples, scanned by the real adapters
  from the files in the sample, so each shows which coding agents it has. A library, and a setup
  merged into storefront by a pull request, which storefront has since fallen behind and changed
  by hand, so the drift is real. Storefront's wiki, whose citations are checked against the
  sample's files. A team of three agents, with three past conversations whose runs and traces are
  written as the runtime records them: each run's tokens are its trace's, and its cost is list
  prices. The registry takes made-up history only through `importSample`, which refuses unless
  the app's `sampleAllowed` says it is the demo.
- **Agents answer from a script** (`scripted-model.ts`). On the demo, `ConversationAgent` puts a
  stand-in model where the provider's would be, and the registry prepares turns without a key or
  an MCP server (`standInTurns`). The script depends only on which agent answers and which of its
  team's edges it can take: a lead hands work to each member once, and sums up once they answer,
  so a team's turn runs through the real edges, nested runs and traces. Nothing a visitor writes
  steers it, and no request reaches a model. Every provider seems to have a key, so any agent a
  visitor makes can be chatted with.
- **What the demo refuses.** The registry refuses, with the same message, saving or checking a
  model key, environment secrets, MCP servers and their OAuth, triggers, Track triage and issue
  work, telemetry, connecting GitLab, writing a wiki and applying a setup, and requests no scans.
  The Track set-up server functions refuse before they try the visitor's key on the visitor's
  address. Trigger and GitLab deliveries get a 404, GitHub is off, and email is off (visitors'
  addresses are made up). Over HTTP, Better Auth refuses every way to make an account or sign in,
  every change to an account, making workspaces, inviting anyone, and the server's own settings
  (`/deployment/*`): the first visitor is the server's owner (see
  [Who owns a server](#who-owns-a-server)), and an owner could close sign-up, which would stop
  every sandbox. The environment binds no email, Workflow, sandbox container, Workers AI or
  Analytics Engine, which `test/wrangler-config.test.ts` checks.
- **Cleanup.** The demo's Cron Trigger runs every ten minutes and deletes visitors a day old, up to
  100 a run (`cleanup.ts`): each one's workspace row with a deletion note in one batch, then its
  objects through the path deleting a workspace takes (its conversations, then its registry),
  then the visitor's row. Objects that fail keep the note, which the same Cron Trigger's retry
  finishes, so the visitor goes anyway; a workspace whose row fails to go keeps its visitor, so the
  next run finds it again.

`apps/web/test/demo.test.ts` checks each refusal, and that none of it happens anywhere else; the
smoke tests (`apps/web/smoke`) open a sandbox on the live demo after each deploy.

## What comes next

- **More agents in Gateweave products** (phase 4 in `docs/spec.md`, AGT-8), after
  [Track triage](#track-triage) and [Track issue work](#track-issue-work).
- **Workers AI on Gateweave Cloud** (AGT-36 shipped it for self-hosted servers). Cloud can turn it
  on with its token now: AGT-75 limits it to the workspaces the deployment invites
  (`WORKERS_AI_WORKSPACES`, which Cloud sets to `sandbox`, its sandbox invitations) and to
  `WORKERS_AI_DAILY_DOLLARS` a day each ($20 on Cloud), counted from the workspace's runs at
  Workers AI's list prices. `#prepareTurn` refuses a turn past either, and Settings > Models shows
  the day's spend.
- **After cloud runners** (phase 5, AGT-9, done): container cost on Runs (AGT-53).
- **GitLab, step two** (AGT-79): applying setups as merge requests, and sandboxes on GitLab.

## Deploys

`main` deploys to staging after CI passes, and a published GitHub release deploys production, the
`cloud` environment of `wrangler.jsonc`, then the public demo, the `demo` environment
(`.github/workflows/deploy.yml`). D1 migrations are applied before the new code goes live. After
the demo's deploy, the smoke tests (`pnpm test:smoke`) open a sandbox there from outside.
