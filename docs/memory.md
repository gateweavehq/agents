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
  answering. It is told to file anything about the person it is talking to under that person.
- **recall** searches the notes by keyword and returns the best matches, at most 20.
- **forget** takes back a note the agent wrote itself. It stays on the Memory page under
  **Forgotten**, and no agent recalls it again.

An agent recalls the notes about the workspace, about itself, about its repository, and about the
person whose message started the run. It reads them as notes with their source, not as
instructions.

**Every member of the workspace can read what an agent notes.** A conversation is its member's
alone, but the memory is the workspace's: a note an agent keeps while you chat with it shows on the
Memory page for every member, with the agent's name. The page tells the others that it came from a
run, and not whose: only you, and owners and admins, can open that run.

Memory works with the **Gateweave** engine. Agents that run Claude Code, Codex or OpenCode in the
sandbox do not have these tools yet.

## What waits for approval

An agent reads what outsiders wrote: the event a trigger starts a run from, and in any run an
issue, a web page or a tool's result. If an agent stored whatever such a text told it to, and other
agents recalled it, one text would steer every later run.

So two kinds of note are stored but **not recalled by any agent** until an owner or admin has read
them:

- a note an agent writes **about the workspace or a repository**, whatever started the run, a
  person's chat included, because every agent, or every agent of that repository, would recall it;
- any note an agent writes in a run **a trigger started**, or in a replay of one, since a replay
  reads the same event.

They show on the Memory page under **Waiting for approval**, with the run they came from. An owner
or admin chooses:

- **Approve**: agents recall it from then on, and it says who approved it and where it came from.
- **Dismiss**: it is removed.

Editing a waiting note does not approve it.

Recalled at once, without anyone's approval:

- a note an owner or admin types on the Memory page;
- a note an agent writes **about itself or about the person it is answering**, in a run that
  person's chat message started. Only that agent recalls the first, and agents recall the second
  only in that person's runs.

**The limit that remains.** In a chat, an agent may read an outsider's text and keep something
from it in a note about itself, which that agent then recalls in its later runs, a trigger's
included, with nobody having approved it. That is why an agent is handed what it recalls as notes
with who or what wrote them and when, under a notice that they are records and not instructions,
and never as part of its instructions. Read an agent's own notes on the Memory page (filter by
**Agent**) if it reads text you do not control.

## The Memory page

- **Search** finds the notes that have every word you type, whatever their case or, in Latin
  script, their accents. A word matches the words that start with it; a single letter is not
  searched for.
- Filter by **kind**, by what a note is **about**, and by state: **Recalled**, **Waiting for
  approval** or **Forgotten**.
- Each note shows its text, kind, what it is about, who or what wrote it, who edited it since, the
  run it was written in, and when. The run is a link for those who may open it: owners and admins,
  and the member who started it. Everyone else reads "a run", and is not told whose.

Owners and admins also:

- **Add** a note, about the workspace or about one agent, repository or person, with an optional
  source (a label and an https link) and an optional last day on which it is recalled.
- **Edit** a note's text, kind, source and last day. Who wrote it stays, and the note says who
  edited it.
- **Delete** a note. It is removed from the memory and from its search, and no agent recalls it
  again. Two things stay, and the page says so before you confirm:
  - the audit log keeps the first 80 characters of the note from when it was added or remembered,
    unless the note is about a person, until that entry is a year old;
  - what an agent already recalled is part of the conversation it recalled it in, and stays in
    that conversation's messages until the conversation is deleted.

## Limits

- A note has at most 2,000 characters.
- A workspace keeps at most 5,000 notes, and at most 500 waiting for approval. Past either, an
  agent's `remember` is refused with the reason, and an owner or admin makes room on the page.
- The newest 1,000 forgotten notes are kept.
- One run stores at most 20 notes and takes back at most 20, so a run cannot loop on them.

## What is recorded

The audit log (**Settings > Audit log**) records notes added, edited, approved, dismissed and
deleted, with who did it, and what agents remembered and forgot, with the agent's name. An entry
for a note added, edited, approved, remembered or forgotten keeps the first 80 characters of the
note, and nothing of a note about a person. An entry for a note deleted or dismissed keeps none of
its text: its kind and what it was about. Entries go when they are a year old.

## When someone leaves

When someone **deletes their account**, each workspace they were in, and each they had left,
removes:

- the notes about them;
- every note an agent wrote in a run they started, whatever it is about, since it came out of a
  conversation that was theirs alone and may say something of them.

What stays: notes they typed themselves on the Memory page, shown as written by "A former member",
notes other people wrote, and notes agents wrote in other people's runs and in triggers' runs. So
does the start of a note in an audit log entry, for the year the entry is kept, unless the note
was about a person.

When someone **leaves a workspace or is removed from it** and keeps their account, nothing is
removed, as with their conversations there, which stay until the account goes. An owner or admin
can delete the notes about them on the Memory page (filter by **Person**).

Put no secret in a note: everyone in the workspace reads the memory, and agents send what they
recall to their model provider.

## Not yet

- Recall is by keyword. Recall by meaning (embeddings in Vectorize, with reranking) comes when the
  volume needs it.
- Searching documents, such as repository docs, Track issues and mail.
- Memory for the engines that run in the sandbox, and for outside clients over MCP.
- Bringing back a forgotten note.

[architecture.md](architecture.md#memory) has how it is built.
