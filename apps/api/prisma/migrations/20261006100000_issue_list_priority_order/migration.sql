-- The issue list sorted by priority (Phase 19, docs/performance.md). Without an index in that
-- order, each page sorted every live issue of the project: 100k rows for one page of 50.
-- Matches IssuesService.orderBy('priority') and its cursor, like issues_active_by_updated_idx.
CREATE INDEX "issues_active_by_priority_idx"
    ON "issues" ("project_id", "priority", "updated_at" DESC, "id" DESC) WHERE "deleted_at" IS NULL;
