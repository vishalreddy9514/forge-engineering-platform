# ADR-0013: A deterministic model provider and contract files between the API and the AI service

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

The AI features (FR-7) cross two languages and a paid external API. Several things have to hold at
once:

- CI must never call OpenAI (cost, flakiness, secrets).
- Local development should work without an API key.
- The API (TypeScript) and the AI service (Python) must agree on request and response shapes that
  neither type system can see across the process boundary.

## Decision

- **Provider interface with two implementations.** `ChatProvider` streams a completion constrained
  to a JSON Schema.
  - `OpenAIChatProvider` uses strict structured outputs.
  - `FakeChatProvider` reads the same prompts and produces schema-valid output from simple,
    deterministic rules. It is the default (`AI_PROVIDER=fake`).
  - Tests can also script exact replies from the fake, for example invalid JSON to exercise the
    repair path.
- **Contract files.** The AI service's endpoint tests write their real responses to
  `apps/ai-service/tests/contract/*.json` and fail if the output changes.
  - The API's unit tests parse the same files with the API's own Zod schemas.
  - The API's integration tests serve them from a fake AI service.
  - A change to the wire format therefore fails on one side until both sides agree.
- **Validation at every hop.** Model output is parsed with the Pydantic model, with one repair
  round. The API parses the AI service's output with Zod. The web app parses the API's output
  with the shared `@forge/types` schemas.

## Alternatives considered

- **Record and replay OpenAI responses (VCR-style).** This is realistic, but it needs a key to
  record, and recordings go stale when prompts change, which is often.
- **An OpenAPI client generated from FastAPI.** This would catch drift in field names but not the
  meaning of streamed SSE events. It also adds a codegen step to a two-endpoint surface.
- **Pact or another consumer-driven contract tool.** Heavier than two JSON files for two
  services owned by one team.

## Consequences

- ➕ The whole product, AI included, runs locally and in CI with no key and no network calls.
- ➕ Wire drift is caught by the ordinary test suites.
- ➖ The fake says nothing about output quality. Quality is judged with the real provider, and the
  retrieval evaluation in Phase 10 measures it.
