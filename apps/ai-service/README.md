# Forge AI service

FastAPI service for embeddings, retrieval (RAG) and LLM-backed features. It is **internal only**:
called by the API and worker with a shared service token, and never exposed through the proxy.
See [docs/architecture.md §7](../../docs/architecture.md#7-ai-and-rag-architecture).

```bash
uv sync                 # create .venv with runtime + dev dependencies
uv run uvicorn app.main:create_app --factory --reload --port 8000
uv run pytest           # tests
uv run ruff check . && uv run mypy   # lint + types
```
