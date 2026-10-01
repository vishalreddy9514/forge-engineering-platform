-- Phase 11: what an AI review covered, so the page can say what was and was not reviewed.
ALTER TABLE "ai_reviews"
    ADD COLUMN "files" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "skipped_files" JSONB NOT NULL DEFAULT '[]';
