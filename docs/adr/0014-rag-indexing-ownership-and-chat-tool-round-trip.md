# ADR-0014: The API owns indexed documents, and runs the assistant's tool itself

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

Phase 10 builds the RAG pipeline designed in architecture §7.2–7.4. Three details of that design
needed deciding once it met the code:

1. **Who writes `documents`.** The AI service's database role can write `documents` and
   `document_chunks` (ADR-0004), so either side could. But turning a source into indexable text
   needs things only the API knows: issue keys, project keys, author names, which projects link a
   repository, and where a citation should link.
2. **Repositories linked to several projects.** A pull request in a repository that two projects
   link belongs to both. The initial schema allowed one document per source, which would put the
   PR's chunks in one project only and either hide it from the other or break the
   `project_id = ANY(...)` permission filter.
3. **The `query_issues` tool.** §7.3 sketched the chat request carrying "a tool callback URL" for
   the AI service to call back into the API with the user's permissions. That needs a network path
   from the AI service to the API and a credential that acts as the user.

## Decision

- **The API normalises and writes the document; the AI service chunks and embeds it.** A worker
  job reads the source's current state, writes the normalised text (header line plus body) and its
  hash to `documents`, and calls `POST /v1/index` with the document ID. The AI service chunks it,
  reuses stored vectors for unchanged text (by content hash and embedding model), embeds the rest
  and swaps the chunks in one transaction, which it abandons if the document changed meanwhile.
  Deleting a source deletes its document; chunks go with it by foreign key.
- **One document per source per project.** The unique key becomes
  `(source_type, source_id, project_id)`. A PR in a repository linked to two projects is indexed
  twice; the second copy reuses the first one's vectors, so it costs no embedding call. Unlinking
  the repository removes that project's copies.
- **The chat tool runs in the API, in two requests.** `POST /v1/chat` either answers or, when the
  model asks for `query_issues`, ends its stream with a `tool_call` event. The API validates the
  arguments with Zod, runs the query against the user's own readable projects, and sends a second
  `/v1/chat` request carrying the call and its results, after which the model must answer. The AI
  service stays stateless and never calls the API.
- Indexing jobs reach the worker through the transactional outbox (`search.index` events written
  with each issue, comment and document change) and BullMQ deduplication with
  `keepLastIfActive`, so a burst of edits to one source runs at most one job now and one after it.
  A backfill job (at worker start and every six hours) repairs anything a failure left behind.

## Alternatives considered

- **The AI service writes documents from a payload.** Fewer round trips, but the AI service would
  need to know URLs and project links, and source data would be serialised into the request.
- **One shared document per source, with a project array.** Keeps one copy, but turns the
  permission filter into an array-overlap on a second table and makes "unlink" a partial update.
- **A callback URL with a short-lived act-as token.** Works, but adds an inbound path into the API
  from a service that processes untrusted text, plus a credential to mint, scope and expire.

## Consequences

- ➕ The permission filter stays a plain `project_id = ANY($1)` on one table (§7.4).
- ➕ A prompt injection that makes the model call `query_issues` with another project's key finds
  nothing: scope comes from the API's membership check, not from the model's arguments.
- ➕ Re-indexing is cheap: an unchanged source costs one hash comparison in the API; a changed one
  re-embeds only its changed chunks.
- ➖ A chat turn that uses the tool re-embeds the question in the second request (a few tokens).
- ➖ Repositories linked to many projects store one chunk set per project.
