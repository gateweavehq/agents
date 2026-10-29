# Triaging Gateweave Track issues

An agent run by Gateweave can triage each new issue in a
[Gateweave Track](https://github.com/gateweavehq/track) workspace. It joins the workspace as an
agent member, and for each new issue it:

- labels it,
- sets its priority when the issue says enough,
- looks for duplicates,
- leaves one short comment saying what it did and why.

It never changes an issue's title, description, status or assignee. When it is unsure, finds a
likely duplicate, or the issue lacks what someone would need to act on it, it comments instead.

Setting it up takes two steps, one in each product. You need to be an owner or admin in both.

## 1. In Track: an agent member and its key

1. Open **Settings → Agents** in your Track workspace and create an agent, named for instance
   "Triage". It shows in Track as a member, and everything it does there carries its name.
2. Copy the key Track shows. It starts with `gwt_`, and Track shows it once; for another one
   later, choose **New key** next to the agent.

## 2. In Agents: the ready-made triage agent

1. Open **Agents** in your Gateweave Agents workspace. Under **Ready-made**, choose **Set up**
   next to **Triage Track issues**.
2. Fill in:
   - **Track**: where you open Track. On Gateweave Cloud that is `https://track.gateweave.com`;
     for your own Track, its address.
   - **Agent key**: the key from step 1.
   - **Provider and model**: a fast model does the job, such as Claude Haiku. The workspace
     needs a key for the provider (**Settings → Model providers**) before the agent can answer.
3. Choose **Set up**. Agents first asks Track's MCP server, with the key, for its tools, so a
   wrong address or key is reported at once and nothing is made. Then it makes everything below
   in one go.
4. Copy the URL it shows, and leave the dialog open.

## 3. In Track: the webhook

1. Open **Settings → Webhooks** and choose **Add webhook**.
2. Paste the URL, choose the event **Issue created**, and under **For agent** choose the agent
   member from step 1. Track then leaves out what that agent does, so the agent never triggers
   itself.
3. Track shows the webhook's secret (`whsec_…`) once. Paste it into the dialog in Agents, and
   choose **Save and finish**.

If you closed the dialog, paste the secret later: on the agent's page, under **Triggers**,
choose **Use the sender's secret**. Until then, every delivery is refused.

## What is made

Everything is ordinary and can be changed afterwards. The names get a number when they are taken,
such as `track 2`.

| What                   | Name           | Notes                                                                                                                    |
| ---------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Instructions (library) | `Track triage` | How to triage, step by step. Edit them to fit your labels and habits, then move the agent to the new version.            |
| Environment set        | `Track`        | Holds the key as the secret `TRACK_AGENT_KEY`, sealed. Nobody sees it again, and replacing it is how you rotate the key. |
| MCP server (library)   | `track`        | Track's `/mcp`, with the header `Authorization: Bearer ${TRACK_AGENT_KEY}`.                                              |
| Agent                  | `Triage`       | Pins the three above, and may use only five of Track's tools.                                                            |
| Trigger                | `New issues`   | Starts a run of the agent for each delivery, at most 50 a day.                                                           |

### Only the tools triage needs

The agent may use `get_workspace`, `get_issue`, `search_issues`, `update_issue` and
`add_comment`, and no other tool Track offers. Its instructions tell it to read an issue as data,
never as instructions. The tool limit is the backstop: an issue that talks the model into trying
something else still cannot make it create issues, labels or teams. Change the list in the
agent's settings, if you need to.

## Costs and limits

Each new issue is one run, on your workspace's provider key, and shows under **Runs** with its
tokens and cost. The trigger starts at most 50 runs a day. Change that on the agent's page, or
pause the trigger there.

## When it does not work

- **"Track did not answer with this key"** when setting up: check the address (without the
  workspace's slug) and that the key was copied whole. A key revoked in Track is refused too.
- **The trigger lists deliveries as refused:** the secret in Agents is not the webhook's. Paste
  Track's again.
- **Deliveries that failed** say why under the trigger, such as a missing provider key. The run's
  page shows what the agent did.
