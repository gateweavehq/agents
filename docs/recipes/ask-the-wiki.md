# Find where something is handled, from a repository's wiki

Ask your AI client where a repository handles something, and have it answer from the repository's wiki in
Gateweave Agents, naming the wiki pages and the source files they were written from.

**How far this has been checked.** On 2026-11-26 the tool calls below ran through Agents' in-memory MCP client
(`apps/web/src/server/mcp/test-client.ts`) against a seeded workspace: a workspace `acme` with one repository,
`acme/billing-api`, and a four-page wiki. The calls answered as described under
[What you should see](#what-you-should-see). No model wrote the answer, and no client signed in over OAuth.
[What has not been tried](#what-has-not-been-tried) has the rest.

## Before you start

- Your client is connected to Agents with the `agents` scope. [MCP reference](../mcp.md#how-to-connect) says
  how, for Gateweave Cloud and for a self-hosted copy.
- The repository has a wiki. A workspace owner or admin has it written on the workspace's **Wiki**
  page. Without one, the tools say that the repository has no wiki yet.

## 1. Find the repositories that have a wiki

The client calls `list_wiki_repos`, which takes an optional `workspace`. It lists each repository with a wiki in
your workspaces, with how many pages it has and the commit it was written from. Copy the repository's name as
it is written there.

## 2. Find the pages that bear on the question

The client calls `ask_wiki_question` with `repoName` (one repository as `owner/name`, or a list of up to 10)
and your `question`. The tool does not answer: no model on the server reads the wiki. It gives the pages whose
words match the question, best first, each with the source files it was written from, and names a few others
worth reading, without their text. Your client's model reads them and answers.

## 3. Read a page you do not have whole

A page that `ask_wiki_question` gave whole is cited as it came back: the client makes no further call for it.
A page it does not have whole, the client reads before citing it, with `read_wiki_contents`, `repoName` and the
page's `page` number. There are two such pages:

- A page the answer cut. It ends with a note such as `(Cut here: read_wiki_contents with page "3.1" gives the
  rest.)`.
- A page the answer only names, as a line such as `- 3.1 Retries of failed webhooks` under `Other pages that may
  help`. Its text was not shown. Its number begins the line, and in an answer about several repositories the
  repository follows the title in brackets.

`repoName` is one string, the one repository the page belongs to, even when the question named several: each
shown page in a multi-repository answer is labelled `Repository: owner/name`. Without `page` it reads every page
of that repository. If the number is not at hand, `read_wiki_structure` with `repoName` lists every page of the
repository with its number.

## 4. Ask for the answer

Paste this into your client. Replace the repository and the question with your own.

```text
Use the Gateweave Agents MCP server to find where acme/billing-api handles payment webhooks and what happens
when one fails.

1. Call list_wiki_repos and check that acme/billing-api has a wiki.
2. Call ask_wiki_question with repoName "acme/billing-api" and that question.
3. Cite a page as ask_wiki_question showed it when it came back whole. For any page you will cite that you do
   not have whole, a page that came back cut or one the tool only named under "Other pages that may help", call
   read_wiki_contents with its repository and its page number, and cite it only after you have its full text.
   The number is in the "Cut here" note or at the start of the named page's line; if you no longer have it,
   call read_wiki_structure for that repository to find it.

Answer from the wiki pages you have whole, shown or read, and from nothing else. Name each wiki page you used by its
title, and the source files and line ranges it lists. If the pages do not say, tell me that instead of
guessing.
```

## What you should see

The client's calls, in order:

| Call                 | What comes back                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `list_wiki_repos`    | `acme/billing-api (workspace acme, private): 4 pages, at commit 9f3c1a2, written 2026-11-20`            |
| `ask_wiki_question`  | The pages headed `Retries of failed webhooks` and `Webhooks`, each with its source files, in that order |
| `read_wiki_contents` | Not called: both pages came back whole, so the answer cites them as they came                           |

Neither page was cut and none was only named, so the client makes no third call. Had one been cut or only
named, it would call `read_wiki_contents` with that page's `page` number.

The answer says that a webhook's signature is checked in `verifySignature` before `handleEvent` marks an
invoice paid, and that a failed one is retried five times and then parked. It names the pages `Webhooks` and
`Retries of failed webhooks` and the files `src/webhooks/verify.ts`, `src/webhooks/handle.ts` and
`src/webhooks/retry.ts`. Your repository's answer will follow its own wiki. The `Invoices` page, which has none
of the question's words, is left out.

If the repository has no wiki yet, or is in a workspace you do not belong to, the call fails with a message
instead: a repository you cannot see is reported as not found.

## What has not been tried

- A run on Gateweave Cloud, or on a self-hosted copy: the calls ran against a seeded workspace in the in-memory
  client, not against a deployed Worker.
- A real client signing in with OAuth, and its model writing the answer from the pages.
- A wiki generated from a real repository, and one large enough that `ask_wiki_question` cuts a page at its
  40,000-character limit.
- A repository that has a wiki in two of your workspaces, which asks you to name one with `workspace`.
