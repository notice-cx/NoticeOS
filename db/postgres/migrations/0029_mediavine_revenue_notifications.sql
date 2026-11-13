-- Existing subject checks imply the expanded checks, and all existing
-- outbox rows get NULL revenue columns. Skip scans while writes are locked.
ALTER TABLE noticeos.notifications DROP CONSTRAINT notifications_subject_check,
  ADD CONSTRAINT notifications_subject_check CHECK (subject IN ('alert', 'data-source', 'mediavine-revenue')) NOT VALID;

ALTER TABLE noticeos.notification_outbox DROP CONSTRAINT notification_outbox_subject_check,
  ADD CONSTRAINT notification_outbox_subject_check CHECK (subject IN ('alert', 'data-source', 'mediavine-revenue')) NOT VALID,
  ADD COLUMN revenue_minor bigint,
  ADD COLUMN previous_revenue_minor bigint,
  ADD COLUMN month_revenue_minor numeric,
  ADD COLUMN month_reported_days integer,
  ADD CONSTRAINT notification_outbox_revenue_check CHECK (
    (subject = 'mediavine-revenue' AND revenue_minor IS NOT NULL
      AND month_revenue_minor IS NOT NULL AND month_reported_days IS NOT NULL AND month_reported_days BETWEEN 1 AND 31) OR
    (subject <> 'mediavine-revenue' AND revenue_minor IS NULL AND previous_revenue_minor IS NULL
      AND month_revenue_minor IS NULL AND month_reported_days IS NULL)
  ) NOT VALID;
