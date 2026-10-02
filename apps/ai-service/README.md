# Forge AI service

This FastAPI service runs Forge's LLM-backed features. It is **internal only**: the API and the
worker call it with a shared service token, and it is never exposed through the proxy. See
[docs/architecture.md §7](../../docs/architecture.md#7-ai-and-rag-architecture).

```bash
uv sync                 # create .venv with runtime + dev dependencies
uv run uvicorn app.main:create_app --factory --reload --port 8000
uv run pytest           # tests (never call OpenAI)
uv run ruff check . && uv run mypy   # lint + types
UPDATE_CONTRACTS=1 uv run pytest tests/test_feature_api.py   # after changing the wire format
```

| Endpoint            | What it does                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `POST /v1/drafts`   | Free text → an issue draft, streamed as SSE (`delta`*, then `result` or `error`) (FR-7.1)  |
| `POST /v1/summaries`| An issue and its comments → TL;DR, decisions, open questions and next steps (FR-7.2)       |
| `POST /v1/index`    | Chunk and embed one document the API wrote; unchanged chunks keep their vectors (FR-8.3)   |
| `POST /v1/search`   | Hybrid retrieval (pgvector + full text, RRF) within the given projects (FR-11.2)           |
| `POST /v1/related`  | Issues similar to an issue or to draft text, above a threshold (FR-7.3)                    |
| `POST /v1/reviews`  | A pull request's diffs → findings per file (line, severity, category), summary, missing tests (FR-9) |
| `POST /v1/chat`     | Answer with numbered citations, or a `query_issues` tool call for the API to run (FR-7.4)  |
| `GET /health/ready` | The provider and model in use                                                              |

- **Providers** (`app/llm/`). `AI_PROVIDER=fake` (the default) answers deterministically without a
  key. `AI_PROVIDER=openai` needs `OPENAI_API_KEY` and uses `OPENAI_CHAT_MODEL` with strict
  structured outputs.
- **Prompts** (`app/prompts/`) are versioned Jinja2 templates. Untrusted text is always fenced in
  `<untrusted_input>` blocks.
- **Retrieval** (`app/rag/`): source-aware chunking, an embedder (OpenAI
  `OPENAI_EMBEDDING_MODEL`, or a deterministic hashing fake), SQL against pgvector as the
  least-privilege `forge_ai` role (`AI_DATABASE_URL`), reciprocal rank fusion and citation
  mapping. Without `AI_DATABASE_URL` the retrieval endpoints answer 503 and the rest still works.
- **Evaluation** (`evals/`): 42 questions over a corpus that mirrors the demo seed; CI fails if
  hit-rate@5 drops below 0.8 (FR-8.6). Database tests need a Postgres server with pgvector:

  ```bash
  TEST_DATABASE_ADMIN_URL=postgresql://forge:<password>@localhost:5432/postgres uv run pytest
  # The same eval with real embeddings (costs a few cents):
  EVAL_EMBEDDER=openai OPENAI_API_KEY=sk-... TEST_DATABASE_ADMIN_URL=... uv run pytest tests/test_eval.py -s
  ```

  Each run creates a scratch database from the API's migrations and drops it afterwards.
- **Contract files** (`tests/contract/`) are the exact responses the API is tested against
  ([ADR-0013](../../docs/adr/0013-ai-provider-fake-and-contract-files.md)).
