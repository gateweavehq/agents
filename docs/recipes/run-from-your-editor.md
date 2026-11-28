# Give an agent a task from your editor and follow its run

Have your AI client hand a task to one of your Gateweave Agents agents, then watch the run until it ends. The
run spends the workspace's budget and appears on the Runs page like any other.

**How far this has been checked.** On 2026-11-26 the tool calls below ran through Agents' in-memory MCP client
(`apps/web/src/server/mcp/test-client.ts`) against a seeded workspace: a workspace `acme` with an agent called
`Docs checker`. The calls answered as described under [What you should see](#what-you-should-see). The agent
was a stand-in that answered `run_agent` and `get_run` with fixed data, so no run actually took place.
[What has not been tried](#what-has-not-been-tried) has the rest.

## Before you start

- Your client is connected to Agents with the `agents:run` scope, granted beside `agents`. A token without it is
  not offered `run_agent` or `get_run` at all. [MCP reference](../mcp.md#how-to-connect) says how to connect and
  which scopes to approve.
- The agent exists and can run, and has **Tasks from MCP clients** turned on (step 1). The example task in
  step 5 reads `acme/billing-api`, so the example agent needs read access to that repository.

## 1. Turn on "Tasks from MCP clients"

Starting a task needs the agent's **Tasks from MCP clients** setting to be on, and it is off until someone turns
it on. A workspace owner or admin can: open the agent under **Agents**, choose **Edit**, tick
**Tasks from MCP clients** and save.

An agent without it refuses the task, saying that a workspace owner or admin can turn the setting on.

## 2. Start the run

The client calls `run_agent` with four inputs, all required:

- `workspace`: the workspace's slug, from `list_workspaces`.
- `agent`: the agent's id or its exact name, as its page shows it.
- `task`: what the agent should do, in full. It sees this text and nothing else of your conversation.
- `requestId`: an id of the client's own for this task, up to 64 letters, digits, `_` and `-`. Sending the same
  id only to retry the same task. A retry of a task that already started returns that run (`duplicate`) instead
  of starting a second, when it comes from the same person through the same OAuth client, for the same agent in
  the same workspace. A retry of a task that did not start gets no such promise: it may be told the task is
  still starting, get the earlier refusal, or start the task afresh. The id is not compared with the task's
  text, so send a new id for a different task.

The answer has a `status`. `started` and `duplicate` come with a `runId`, and `started` also with a
`conversationId`. `limited` means the agent has reached its limit of outside tasks for the minute or the day,
counting the tasks it accepted whether or not their run has begun, and `retryAfter` says how many seconds to
wait. `starting` means the same task is still being started, and `retryAfter` again says when to ask. A `refused` answer has a `message` saying why.

## 3. Follow the run

The client calls `get_run` with the `workspace` and the `runId`, again and again until the run's `state` is no
longer `running`. A run ends as `succeeded`, `failed`, `stopped`, `interrupted` or `step-limit`. The answer holds
the agent's answer once it has one, its steps and tokens, and `link`.

You can read your own runs. A workspace owner or admin reads every member's.

## 4. Open the run

`link` is the run's address on the Runs page, as a path such as `/acme/runs/3f9c2b7e-5d41-4a8e-9b06-1c7e2a4d8f53`.
Add it to the address you use for Agents, such as
`https://agents.gateweave.com/acme/runs/3f9c2b7e-5d41-4a8e-9b06-1c7e2a4d8f53`, to open the run and its trace.
To read the task's conversation, choose **Open the conversation** at the top of that page. The person who gave
the task sees it there; an owner or admin who opens someone else's run does not.

## 5. Ask for the task

Paste this into your client. Replace the workspace, the agent, the task, the request id and the address of Agents
with your own. A request id names one task: reuse it only to retry that same task, and give a different task a
new id, because the id is not compared with the task's text.

```text
Use the Gateweave Agents MCP server to give a task to an agent.

1. Call run_agent with workspace "acme", agent "Docs checker", requestId "docs-check-1" and this task:
   "Read the README of acme/billing-api and list every command in it that package.json has no script for."
2. If the answer is refused, show me its message and stop. If it is limited or starting, wait retryAfter
   seconds and call run_agent again with the same requestId.
3. Call get_run with the workspace and the runId every 10 seconds until the state is no longer "running".
4. Tell me the final state, the agent's answer, the steps and tokens used, and the run's link, written as a full
   address on https://agents.gateweave.com (use your own address if you run Agents yourself).
```

## What you should see

| Call        | What comes back                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `run_agent` | `status: "started"`, a `runId` such as `3f9c2b7e-5d41-4a8e-9b06-1c7e2a4d8f53` and a `conversationId`        |
| `get_run`   | First `state: "running"` with `answer: null` and `endedAt: null`, then `state: "succeeded"` with the answer |

The last `get_run` also gives `steps`, `inputTokens`, `outputTokens`, `cost` (in millionths of a dollar, and
`null` when a model the run used has no prices), `startedAt`, `endedAt` and `link`. Your client reports them,
and the run is on the Runs page.

With **Tasks from MCP clients** off, `run_agent` answers `status: "refused"` with the message `That agent does
not allow tasks from outside. A workspace owner or admin can turn on "Tasks from MCP clients" in the agent's settings.`, and no run starts.

## What has not been tried

- A run on Gateweave Cloud, or on a self-hosted copy: the calls ran against a seeded workspace in the in-memory
  client, with a stand-in for the agent, not against a deployed Worker.
- A real client signing in with OAuth and approving `agents:run`.
- A real run: the states `failed`, `stopped`, `interrupted` and `step-limit`, a task the agent's budget or rate
  limit turns away, and opening the link in the browser.
- Reading a run another member started, as an owner or admin and as a member.
