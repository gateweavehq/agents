# Memory

A workspace has a memory: short notes that its agents recall in later runs. A note is a fact
("The storefront's database is Postgres 17"), a decision ("Deploys go out on Tuesdays") or a
preference ("Ada wants short answers"). Each says who or what wrote it, in which run, and when.

Everyone in the workspace reads the memory on the **Memory** page. Owners and admins change it.

## Give an agent memory

Memory is off for every agent until someone turns it on.

1. Open **Agents** and the agent, and choose **Edit**.
2. Tick **Memory** and save.

The agent then has three tools:

- **remember** stores a note. The agent says what kind it is and what it is about: itself (unless
  it says otherwise), the whole workspace, the repository it works in, or the person it is
  answering.
- **recall** searches the notes by keyword and returns the best matches, at most 20.
- **forget** takes back a note the agent wrote itself. It stays on the Memory page under
  **Forgotten**, and no agent recalls it again.

An agent recalls the notes about the workspace, about itself, about its repository, and about the
person whose message started the run. It reads them as notes with their source, not as
instructions.

A conversation is its member's alone, but the memory is the workspace's: a note an agent writes
while you chat with it can be read by everyone in the workspace.

Memory works with the **Gateweave** engine. Agents that run Claude Code, Codex or OpenCode in the
sandbox do not have these tools yet.

## What waits for approval

A trigger starts a run from something an outsider may have written: a webhook's event, an issue's
text. If an agent stored whatever such a text told it to, the text would steer every later run.

So a note an agent writes in a run **a trigger started** is not recalled by any agent. It shows on
the Memory page under **Waiting for approval**, with the run it came from. An owner or admin reads
it and chooses:

- **Approve**: agents recall it from then on, and it says who approved it.
- **Dismiss**: it is removed.

Editing a waiting note does not approve it. A note an agent writes while a person chats with it is
recalled at once, and so is one an owner or admin types.

A replay of a trigger's run counts as a trigger's run, since it reads the same event.

## The Memory page

- **Search** finds the notes that have every word you type, whatever their case or accents. A word
  matches the words that start with it.
- Filter by **kind**, by what a note is **about**, and by state: **Recalled**, **Waiting for
  approval** or **Forgotten**.
- Each note shows its text, kind, what it is about, who or what wrote it, the run it was written
  in, and when. The run is a link for those who may open it: owners and admins, and the member who
  started it.

Owners and admins also:

- **Add** a note, about the workspace or about one agent, repository or person, with an optional
  source (a label and an https link) and an optional last day on which it is recalled.
- **Edit** a note's text, kind, source and last day. Who wrote it stays, and the note says who
  edited it.
- **Delete** a note. It is removed for good, from the search too.

## Limits

- A note has at most 2,000 characters.
- A workspace keeps at most 5,000 notes, and at most 500 waiting for approval. Past either, an
  agent's `remember` is refused with the reason, and an owner or admin makes room on the page.
- The newest 1,000 forgotten notes are kept.

## What is recorded

The audit log (**Settings > Audit log**) records notes added, edited, approved, dismissed and
deleted, with who did it, and what agents remembered and forgot, with the agent's name. It keeps
the first 80 characters of a note at most, and nothing of a note about a person.

When someone deletes their account, the notes about them are removed. Notes they wrote about the
workspace stay, shown as written by "A former member".

Put no secret in a note: everyone in the workspace reads the memory, and agents send what they
recall to their model provider.

## Not yet

- Recall is by keyword. Recall by meaning (embeddings in Vectorize, with reranking) comes when the
  volume needs it.
- Searching documents, such as repository docs, Track issues and mail.
- Memory for the engines that run in the sandbox, and for outside clients over MCP.
- Bringing back a forgotten note.

[architecture.md](architecture.md#memory) has how it is built.
