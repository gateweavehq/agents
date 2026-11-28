# Pull request review

Gateweave can review pull requests that your workspace's agents open. The reviewer is **a second
reader, never the approval**: a person still decides whether the pull request is merged.

## Setting it up

Review is off until an owner or admin sets it up, one repository at a time. On the **Agents** page,
open **Review pull requests** under **Ready-made** and choose:

- the repository whose pull requests are reviewed;
- the engine, provider and model the reviewer uses.

The card appears only after the replay gate has passed and its precision has been checked. The
dialog shows the gate's date, engine and model, how many of the 35 seeded defects it found, and the
share of reviews that were real.

One setup makes the review instructions, the agent and its `pull_request` trigger. The agent has
its sandbox on and memory off, so each review stays confined to its pull request. The trigger
allows 30 runs a day and reviews only pull requests that this workspace's agents opened in that
repository.

## Who pays

Reviews are paid with the workspace's provider key and count toward its sandbox minutes, like
every other run. If the workspace has no key for the provider, or the server does not offer it
sandboxes, the setup is refused before anything is made.

## What a review is

The reviewer reads the pull request, its diff and the repository at the reviewed head in a fresh
sandbox. It reports defects through the review tool, and the review is posted as a pull request
review. It is evidence for a person reading the change, not an approval and not a merge decision.
