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
| `GET /health/ready` | The provider and model in use                                                              |

- **Providers** (`app/llm/`). `AI_PROVIDER=fake` (the default) answers deterministically without a
  key. `AI_PROVIDER=openai` needs `OPENAI_API_KEY` and uses `OPENAI_CHAT_MODEL` with strict
  structured outputs.
- **Prompts** (`app/prompts/`) are versioned Jinja2 templates. Untrusted text is always fenced in
  `<untrusted_input>` blocks.
- **Contract files** (`tests/contract/`) are the exact responses the API is tested against
  ([ADR-0013](../../docs/adr/0013-ai-provider-fake-and-contract-files.md)).
