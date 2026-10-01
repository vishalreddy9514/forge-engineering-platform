-- Phase 10: RAG indexing.

-- A pull request or commit in a repository linked to several projects gets one document per
-- project, so retrieval filters on project_id alone (architecture §7.4).
DROP INDEX "documents_source_type_source_id_key";
CREATE UNIQUE INDEX "documents_source_type_source_id_project_id_key"
    ON "documents"("source_type", "source_id", "project_id");

-- Re-indexing reuses the stored vector of identical text embedded by the same model.
CREATE INDEX "document_chunks_content_hash_embedding_model_idx"
    ON "document_chunks"("content_hash", "embedding_model");
