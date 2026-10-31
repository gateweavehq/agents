# Working on Gateweave Track issues

An agent run by Gateweave can take the issues you assign to it in a
[Gateweave Track](https://github.com/gateweavehq/track) workspace. It joins the workspace as an
agent member, and for each issue assigned to it, it:

- comments that it is on it, with a link to its run in Agents, and moves the issue to In Progress;
- works on it in a sandbox, with your repository checked out: a vendor's coding agent such as
  Claude Code, Codex or OpenCode, or Gateweave's own loop;
- opens a pull request of its work, titled with the issue's key;
- comments with the pull request's link and moves the issue to In Review.

When the issue is unclear, it asks in a comment instead, mentioning whoever assigned it, and stops.
Answer in a comment on the issue, and it goes on where it stopped. A comment also asks it for a
change to its pull request: it makes the change, pushes it to the same pull request, and comments
back. Each issue has one conversation in Agents, so it remembers what was said and done, and works
on the same branch.

Setting it up takes three steps across the two products. You need to be an owner or admin in both,
and the Agents workspace needs:

- **sandboxes**, which Gateweave Cloud offers to the workspaces it invites, and a self-hosted server
  once its operator turns them on;
- **the GitHub App** installed on the repository the agent works in (**Settings → GitHub**);
- **a model provider key** for the engine you choose (**Settings → Model providers**): Anthropic's
  for Claude Code, OpenAI's for Codex, any of Anthropic's, OpenAI's or Google's for OpenCode.

## 1. In Track: an agent member and its key

1. Open **Settings → Agents** in your Track workspace and create an agent, named for instance
   "Coder". It shows in Track as a member you can assign issues to.
2. Copy the key Track shows. It starts with `gwt_`, and Track shows it once.

## 2. In Agents: the ready-made agent

1. Open **Agents** in your Gateweave Agents workspace. Under **Ready-made**, choose **Set up**
   next to **Work on Track issues**.
2. Fill in:
   - **Track**: where you open Track, such as `https://track.gateweave.com`.
   - **Agent key**: the key from step 1.
   - **Repository**: where it works and opens pull requests.
   - **Engine, provider and model**: coding takes a capable model, such as Claude Sonnet with
     Claude Code.
3. Choose **Set up**. Agents first asks Track, with the key, for its tools and which member the
   key is, so a wrong address or key is reported at once and nothing is made.
4. Copy the URL it shows, and leave the dialog open.

## 3. In Track: the webhook

1. Open **Settings → Webhooks** and choose **Add webhook**.
2. Paste the URL. Under **Events**, choose **Issue created**, **Issue changed** and **Comment
   added**: the trigger skips any issue that was not just assigned to the agent, and any comment
   that is not a person's on one of its issues. Under **For agent**, choose the agent member from
   step 1, so that its own changes never come back to it.
3. Track shows the webhook's secret (`whsec_…`) once. Paste it into the dialog in Agents, and
   choose **Save and finish**.

Then assign the agent an issue. If you closed the dialog, paste the secret later on the agent's
page, under **Triggers**, with **Use the sender's secret**.

## What is made

Everything is ordinary and can be changed afterwards. The names get a number when they are taken.

| What                   | Name               | Notes                                                                                       |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| Instructions (library) | `Track issue work` | How to take an issue from assigned to a pull request. Edit them to fit how your team works. |
| Environment set        | `Track`            | Holds the key as the secret `TRACK_AGENT_KEY`, sealed.                                      |
| MCP server (library)   | `track`            | Track's `/mcp`, with the header `Authorization: Bearer ${TRACK_AGENT_KEY}`.                 |
| Agent                  | `Coder`            | Pins the three above, with a sandbox on the repository and the engine you chose.            |
| Trigger                | `Assigned issues`  | One conversation per issue: an assignment, or a person's comment, starts a run; 20 a day.   |

### What it may do

In Track, it may use `get_workspace`, `get_issue`, `search_issues`, `update_issue` and
`add_comment`, nothing else. In the sandbox it has no internet but package registries, and its
work leaves only as the pull request `open_pull_request` opens, from a branch of its own. Anyone
in the Track workspace can write an issue, so treat its pull requests as you would a new
contributor's: review them before merging.

In Track, **Settings → Agents** lets an admin choose which kinds of change the agent only
proposes, such as status changes. Track holds those for a person to accept.

If the repository has a Track GitHub connection, the pull request links to the issue on its own,
since its title names the issue and its description ends with `Fixes <key>`: merging it moves the
issue to Done.

## Costs and limits

Each assigned issue is one run, on your workspace's provider key, with a sandbox for up to an hour,
and so is each comment it answers. They show under **Runs** with their tokens and cost, and count
toward the workspace's sandbox time. The trigger starts at most 20 runs a day; change that on the
agent's page, or pause the trigger there.

A comment that comes while the agent is still working on the issue waits: Agents asks Track to
send it again, and Track tries again after 5 seconds, then 5 minutes, then 30 minutes.

### Set up before comments continued the work

A trigger made before Agents v0.4.0 starts each assignment anew and ignores comments. To have
comments continue the work, open the agent's page, edit its trigger under **Triggers**: add
`comment.created` to **Events**, tick **One conversation per issue**, and make the prompt fit any
event, such as `Track sent {{type}} for the issue {{data.issue.key}}. It is assigned to you: work
on it as your instructions say.` Then add **Comment added** to the webhook's events in Track, and
bring the `Track issue work` instructions up to date from [the current ones](../apps/web/src/server/track-work.md).

## When it does not work

- **"This key is not an agent member's key"**: the key is not an agent's, or Track lists more than
  one workspace for it. Create an agent under Settings → Agents in Track and use its key.
- **"This Track does not say which member a key belongs to"**: your Track is older than this
  setup. Update it first.
- **Nothing happens when you assign an issue**: the webhook's recent deliveries in Track show what
  Agents answered, and the trigger's deliveries in Agents say why one was skipped.
- **A run that failed** says why on its page, such as a missing provider key or the workspace's
  sandbox time for the day being used up.
