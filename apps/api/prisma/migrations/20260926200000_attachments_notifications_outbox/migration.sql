-- Phase 6b: attachments upload lifecycle, idempotent notifications, and outbox relay wake-ups.

-- Notifications are created by a worker that may see the same outbox event more than once
-- (at-least-once delivery, ADR-0006). The key makes the insert idempotent per recipient.
-- NULL keys (notifications created outside the outbox) never conflict.
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" VARCHAR(200);
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- Wake the relay as soon as a transaction that wrote outbox rows commits (NOTIFY is delivered
-- on commit, never for a rolled-back transaction). The relay also polls, so a missed
-- notification only adds latency.
CREATE FUNCTION "notify_outbox_relay"() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('outbox_events', '');
    RETURN NULL;
END
$$;

CREATE TRIGGER "outbox_events_notify_relay"
    AFTER INSERT ON "outbox_events"
    FOR EACH STATEMENT EXECUTE FUNCTION "notify_outbox_relay"();

-- The cleanup job looks for uploads that were requested but never completed.
CREATE INDEX "attachments_pending_created_at_idx"
    ON "attachments" ("created_at") WHERE "status" = 'PENDING_UPLOAD';
