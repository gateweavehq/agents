# MCP reference

`/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server, so AI agents can
work with Gateweave Agents as the person who connected them. This page says how to connect one and
lists the tools it gets. How the server is built is in
[AI agents (MCP)](architecture.md#ai-agents-mcp).

This is the other direction from the library's "MCP servers", where Agents' own agents reach other
servers.

## How to connect

### The MCP URL

| Where              | URL                                                                        |
| ------------------ | -------------------------------------------------------------------------- |
| Gateweave Cloud    | `https://agents.gateweave.com/mcp`                                         |
| A self-hosted copy | `/mcp` on the address people use, such as `https://agents.example.com/mcp` |

On a self-hosted copy, `/mcp` exists only when `BETTER_AUTH_URL` is set to the address people use,
without the `/mcp` path (such as `https://agents.example.com`), because a token must name one
canonical URL. Without it `/mcp` answers `404`. See
[self-hosting](self-hosting.md).

### Sign-in and scopes

The client signs in with OAuth: Agents is the authorization server. The client registers itself,
sends the person to authorize with PKCE, and they approve it on the consent screen, which names
the app, says where the grant will go, and is never skipped. Session cookies are never accepted
at `/mcp`.

| Scope        | What it lets the client do                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`     | Read: see the names of the workspaces the person belongs to and read their repositories' wikis, which may describe private code. It cannot change anything.                                                                                                                                                                                                                                                                                       |
| `agents:run` | Run: give the person's agents tasks and read their runs. Starting a task needs the agent's "Tasks from MCP clients" setting to be on, which the agent's owner or a workspace admin (an owner or admin of the workspace) can turn on, and those tasks spend the workspace's budget. Reading a run needs only workspace membership: a member reads their own runs, an owner or admin reads every one. Granted beside `agents`, never instead of it. |

A token without `agents:run` is not offered `run_agent` or `get_run` at all.

### Client setup

With Claude Code:

```sh
claude mcp add --transport http gateweave-agents https://agents.gateweave.com/mcp
```

For another client, a generic JSON config:

```json
{
	"mcpServers": {
		"gateweave-agents": {
			"type": "http",
			"url": "https://agents.gateweave.com/mcp"
		}
	}
}
```

Use your own address from the table above on a self-hosted copy. The client finds the
authorization server from the `401` that `/mcp` answers without a token, and asks for the scopes
it wants.

## Recipes

Two tasks, each with the steps, a prompt to paste and what you should see:

- [Find where something is handled, from a repository's wiki](recipes/ask-the-wiki.md)
- [Give an agent a task from your editor and follow its run](recipes/run-from-your-editor.md)

## Tools

The table is generated from the server's own `tools/list`, under both values of whether the token
carries `agents:run`. Do not edit it by hand: a test fails when it differs, and names the command
that rewrites it. In the input column, a name ending in `?` is optional. A tool with no output
schema answers in text.

<!-- mcp-tools:start -->
| Tool                  | What it does                                                                                                                                                        | Input                                     | Output                                                       | Needs                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| `list_workspaces`     | Lists the Agents workspaces you belong to.                                                                                                                          | none                                      | `workspaces`                                                 | `agents`                                                             |
| `read_wiki_structure` | Lists the pages of a repository's wiki, numbered, in one of your workspaces.                                                                                        | `repoName`, `workspace?`                  | text                                                         | `agents`                                                             |
| `read_wiki_contents`  | Gives a repository's wiki in one of your workspaces: every page, or the one asked for, each with the source files it was written from and citations of their lines. | `repoName`, `workspace?`, `page?`         | text                                                         | `agents`                                                             |
| `ask_wiki_question`   | Finds the pages of a repository's wiki, or of up to 10 repositories' wikis, that bear on a question, and gives them, best first, for you to answer from.            | `repoName`, `question`, `workspace?`      | text                                                         | `agents`                                                             |
| `list_wiki_repos`     | Lists the repositories that have a wiki in your workspaces, or in the one named, with how many pages each has and the commit it was written from.                   | `workspace?`                              | text                                                         | `agents`                                                             |
| `run_agent`           | Gives an agent of one of your workspaces a task and starts its run, the way a trigger would.                                                                        | `workspace`, `agent`, `task`, `requestId` | `status`, `runId`, `conversationId`, `retryAfter`, `message` | `agents:run`; the agent's "Tasks from MCP clients" setting turned on |
| `get_run`             | Reads a run of one of your workspaces: its state, the agent's answer once it has one, its steps and tokens, and its link on the Runs page.                          | `workspace`, `runId`                      | `status`, `message`, `run`                                   | `agents:run`                                                         |
<!-- mcp-tools:end -->
