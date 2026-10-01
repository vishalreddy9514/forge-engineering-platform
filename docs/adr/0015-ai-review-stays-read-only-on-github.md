# ADR-0015: AI reviews stay in Forge; the GitHub App stays read-only

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

FR-9.4 (a "Could") suggests posting the AI review summary as a comment on the GitHub pull
request when a user explicitly clicks a button. Forge's GitHub App is read-only by design
(ADR-0008): Contents, Issues, Metadata and Pull requests, all read. Posting a comment needs
`pull_requests: write` (or `issues: write`) on every installation.

## Decision

- Do not post to GitHub. The review is stored and shown on the pull request's page in Forge,
  always under the banner _"AI-generated suggestions. This does not replace human code review."_
- Offer **Copy as Markdown** instead: the person reads the review, decides what is worth saying,
  and posts it themselves, under their own name.
- Reviews are requested explicitly (never automatically on every push), keyed by head commit so
  the same code is never reviewed twice, and every request is audit-logged (FR-13).

## Alternatives considered

- **Add `pull_requests: write` and a "Post to GitHub" button.** Every organisation installing the
  App would have to grant write access to all of its repositories for one optional feature, and a
  compromised Forge (or a prompt-injected review) could then write to their pull requests.
- **A separate, write-enabled App just for posting.** Doubles the setup in
  `docs/github-app-setup.md` for a "Could" requirement.

## Consequences

- ➕ The App's blast radius stays read-only: Forge cannot change anything on GitHub.
- ➕ Machine-written text reaches GitHub only through a person who has read it, attributed to them.
- ➖ One extra step (copy, paste) for teams that want the review on the pull request itself.
- The decision can be revisited with a separately-installed write App if users ask for it.
