-- Phase 8: GitHub integration (FR-6, ADR-0008): read-only GitHub issues, repository sync state
-- and webhook deliveries (deduplicated by GitHub's delivery ID).
-- CreateEnum
CREATE TYPE "github_issue_state" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "github_sync_status" AS ENUM ('IDLE', 'QUEUED', 'RUNNING', 'FAILED', 'RATE_LIMITED');

-- AlterTable
ALTER TABLE "github_repositories" ADD COLUMN     "last_sync_error" VARCHAR(500),
ADD COLUMN     "sync_status" "github_sync_status" NOT NULL DEFAULT 'IDLE';

-- CreateTable
CREATE TABLE "github_issues" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "github_id" BIGINT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "state" "github_issue_state" NOT NULL,
    "author_login" VARCHAR(100),
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "comments_count" INTEGER NOT NULL DEFAULT 0,
    "html_url" TEXT NOT NULL,
    "opened_at" TIMESTAMPTZ NOT NULL,
    "closed_at" TIMESTAMPTZ,
    "github_updated_at" TIMESTAMPTZ NOT NULL,
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_webhook_deliveries" (
    "id" VARCHAR(64) NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "action" VARCHAR(64),
    "installation_id" BIGINT,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,
    "error" VARCHAR(500),

    CONSTRAINT "github_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_issues_github_id_key" ON "github_issues"("github_id");

-- CreateIndex
CREATE INDEX "github_issues_repository_id_state_opened_at_idx" ON "github_issues"("repository_id", "state", "opened_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "github_issues_repository_id_number_key" ON "github_issues"("repository_id", "number");

-- CreateIndex
CREATE INDEX "github_webhook_deliveries_received_at_idx" ON "github_webhook_deliveries"("received_at");

-- AddForeignKey
ALTER TABLE "github_issues" ADD CONSTRAINT "github_issues_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "github_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

