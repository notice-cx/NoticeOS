CREATE TABLE noticeos.notification_events (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  channel text NOT NULL DEFAULT 'discord' CHECK (channel <> ''),
  notification_type text NOT NULL CHECK (notification_type <> ''),
  source_kind text NOT NULL CHECK (source_kind <> ''),
  source_ref text NOT NULL CHECK (source_ref <> ''),
  occurrence text NOT NULL,
  connection_id uuid,
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_id uuid,
  lease_until timestamptz,
  finished_at timestamptz,
  legacy_receipt_id bigint,
  legacy_condition text,
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (workspace_id, channel, notification_type, source_kind, source_ref, occurrence),
  CHECK ((lease_id IS NULL) = (lease_until IS NULL)),
  CHECK ((state = 'pending') = (finished_at IS NULL)),
  CHECK (state = 'pending' OR lease_id IS NULL),
  CONSTRAINT notification_event_source CHECK (CASE notification_type
    WHEN 'open-error' THEN source_kind = 'alert'
    WHEN 'source-failing' THEN source_kind = 'integration'
    WHEN 'daily-mediavine-revenue' THEN source_kind = 'asset'
    ELSE true
  END),
  CONSTRAINT notification_event_revenue CHECK (
    notification_type <> 'daily-mediavine-revenue'
    OR (state = 'sent' AND payload = '{}')
    OR coalesce(
      jsonb_typeof(payload -> 'amount_minor') = 'number'
      AND (payload ->> 'amount_minor')::bigint IS NOT NULL
      AND ((payload ->> 'previous_minor') IS NULL OR (payload ->> 'previous_minor')::bigint IS NOT NULL)
      AND (payload ->> 'month_minor') ~ '^-?[0-9]+$'
      AND (payload ->> 'month_reported_days')::integer BETWEEN 1 AND 31,
      false
    )
  )
);
CREATE INDEX notification_events_due ON noticeos.notification_events (workspace_id, channel, next_attempt_at)
  WHERE state = 'pending';
CREATE INDEX notification_events_sent_source ON noticeos.notification_events
  (workspace_id, source_kind, source_ref, finished_at) WHERE state = 'sent';
ALTER TABLE noticeos.notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.notification_events FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.notification_events
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());
GRANT SELECT, INSERT ON noticeos.notification_events TO noticeos_app;
GRANT UPDATE (state, attempts, next_attempt_at, lease_id, lease_until, finished_at, legacy_condition)
  ON noticeos.notification_events TO noticeos_app;
GRANT SELECT ON noticeos.notification_events TO noticeos_maint;

CREATE FUNCTION noticeos.legacy_notification_type(subject text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$
  SELECT CASE subject
    WHEN 'alert' THEN 'open-error'
    WHEN 'data-source' THEN 'source-failing'
    WHEN 'mediavine-revenue' THEN 'daily-mediavine-revenue'
  END
$$;

CREATE FUNCTION noticeos.legacy_notification_source_kind(subject text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$
  SELECT CASE subject
    WHEN 'alert' THEN 'alert'
    WHEN 'data-source' THEN 'integration'
    WHEN 'mediavine-revenue' THEN 'asset'
  END
$$;

CREATE FUNCTION noticeos.legacy_notification_subject(notification_type text, source_kind text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN notification_type = 'open-error' AND source_kind = 'alert' THEN 'alert'
    WHEN notification_type = 'source-failing' AND source_kind = 'integration' THEN 'data-source'
    WHEN notification_type = 'daily-mediavine-revenue' AND source_kind = 'asset' THEN 'mediavine-revenue'
  END
$$;

-- Serialize the copy with the old sender, which locks the queue before receipts.
LOCK TABLE noticeos.notification_outbox, noticeos.notifications IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE workspace uuid;
        previous_workspace text := current_setting('noticeos.workspace_id', true);
BEGIN
  FOR workspace IN SELECT workspace_id FROM noticeos.workspaces LOOP
    PERFORM set_config('noticeos.workspace_id', workspace::text, true);
    INSERT INTO noticeos.notification_events (
      workspace_id, event_id, channel, notification_type, source_kind, source_ref, occurrence, connection_id,
      payload, occurred_at, created_at, state, attempts, next_attempt_at, lease_id, lease_until, finished_at,
      legacy_receipt_id, legacy_condition
    )
    SELECT q.workspace_id, q.event_id, q.channel, noticeos.legacy_notification_type(q.subject),
      noticeos.legacy_notification_source_kind(q.subject), q.subject_ref, q.occurrence, q.connection_id,
      CASE WHEN q.subject = 'mediavine-revenue' THEN jsonb_build_object(
        'amount_minor', q.revenue_minor, 'previous_minor', q.previous_revenue_minor,
        'month_minor', q.month_revenue_minor, 'month_reported_days', q.month_reported_days
      ) ELSE '{}'::jsonb END,
      q.occurred_at, q.created_at, CASE WHEN n.sent_at IS NULL THEN q.state ELSE 'sent' END, q.attempts,
      q.next_attempt_at, CASE WHEN n.sent_at IS NULL THEN q.lease_id END,
      CASE WHEN n.sent_at IS NULL THEN q.lease_until END, coalesce(n.sent_at, q.finished_at),
      n.notification_id, n.condition
      FROM noticeos.notification_outbox q
      LEFT JOIN noticeos.notifications n USING (workspace_id, channel, subject, subject_ref, occurrence);

    INSERT INTO noticeos.notification_events (
      workspace_id, channel, notification_type, source_kind, source_ref, occurrence, occurred_at, created_at,
      state, next_attempt_at, finished_at, legacy_receipt_id, legacy_condition
    )
    SELECT n.workspace_id, n.channel, noticeos.legacy_notification_type(n.subject),
      noticeos.legacy_notification_source_kind(n.subject), n.subject_ref,
      n.occurrence, n.sent_at, n.sent_at, 'sent', n.sent_at, n.sent_at, n.notification_id, n.condition
      FROM noticeos.notifications n
      ON CONFLICT (workspace_id, channel, notification_type, source_kind, source_ref, occurrence) DO NOTHING;

    -- Before failure episodes had UUIDs, the receipt key was a timestamp.
    -- Keep that receipt as the sent event and suppress its UUID-keyed duplicate.
    WITH duplicates AS (
      SELECT q.workspace_id, q.event_id, min(n.sent_at) AS sent_at
      FROM noticeos.notification_events q
      JOIN noticeos.integration_connections c ON c.workspace_id = q.workspace_id AND c.connection_id = q.connection_id
      JOIN noticeos.notifications n ON n.workspace_id = q.workspace_id AND n.channel = q.channel
        AND n.subject = 'data-source' AND n.subject_ref = q.source_ref
        AND n.occurrence ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' AND n.sent_at >= greatest(q.occurred_at, c.created_at)
      WHERE q.notification_type = 'source-failing' AND q.legacy_receipt_id IS NULL AND q.state IN ('pending', 'sent')
      GROUP BY q.workspace_id, q.event_id
    )
    UPDATE noticeos.notification_events q
      SET state = 'cancelled', finished_at = coalesce(q.finished_at, d.sent_at), lease_id = NULL, lease_until = NULL
      FROM duplicates d WHERE q.workspace_id = d.workspace_id AND q.event_id = d.event_id;
  END LOOP;
  PERFORM set_config('noticeos.workspace_id', coalesce(previous_workspace, ''), true);
END
$$;

DROP TABLE noticeos.notification_outbox;
DROP TABLE noticeos.notifications;

CREATE FUNCTION noticeos.guard_finished_notification() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  -- The previous app can receive a Discord confirmation after its event was cancelled.
  IF OLD.state = 'cancelled' AND NEW.state = 'sent' AND OLD.legacy_condition IS NULL
      AND coalesce(NEW.legacy_condition, '') <> ''
      AND (to_jsonb(OLD) - ARRAY['state', 'finished_at', 'legacy_condition'])
        = (to_jsonb(NEW) - ARRAY['state', 'finished_at', 'legacy_condition']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'finished notification events cannot change' USING ERRCODE = '23514';
END
$$;
CREATE TRIGGER guard_finished_notification BEFORE UPDATE ON noticeos.notification_events
  FOR EACH ROW WHEN (OLD.state <> 'pending' AND OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION noticeos.guard_finished_notification();

CREATE TRIGGER notification_wakeup AFTER INSERT ON noticeos.notification_events
  FOR EACH ROW WHEN (NEW.state = 'pending') EXECUTE FUNCTION noticeos.notification_wakeup();

-- The running 0029 app can finish delivery during the interval before its update.
CREATE VIEW noticeos.notification_outbox WITH (security_invoker = true) AS
  SELECT workspace_id, event_id, channel, noticeos.legacy_notification_subject(notification_type, source_kind) AS subject,
    source_ref AS subject_ref,
    occurrence, connection_id, occurred_at, created_at, state, attempts, next_attempt_at, lease_id, lease_until, finished_at,
    (payload ->> 'amount_minor')::bigint AS revenue_minor,
    (payload ->> 'previous_minor')::bigint AS previous_revenue_minor,
    (payload ->> 'month_minor')::numeric AS month_revenue_minor,
    (payload ->> 'month_reported_days')::integer AS month_reported_days
  FROM noticeos.notification_events WHERE channel = 'discord'
    AND noticeos.legacy_notification_subject(notification_type, source_kind) IS NOT NULL;
GRANT SELECT, INSERT ON noticeos.notification_outbox TO noticeos_app;
GRANT SELECT ON noticeos.notification_outbox TO noticeos_maint;
GRANT UPDATE (state, attempts, next_attempt_at, lease_id, lease_until, finished_at)
  ON noticeos.notification_outbox TO noticeos_app;
ALTER VIEW noticeos.notification_outbox ALTER COLUMN event_id SET DEFAULT gen_random_uuid();
ALTER VIEW noticeos.notification_outbox ALTER COLUMN channel SET DEFAULT 'discord';
ALTER VIEW noticeos.notification_outbox ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER VIEW noticeos.notification_outbox ALTER COLUMN state SET DEFAULT 'pending';
ALTER VIEW noticeos.notification_outbox ALTER COLUMN attempts SET DEFAULT 0;
ALTER VIEW noticeos.notification_outbox ALTER COLUMN next_attempt_at SET DEFAULT clock_timestamp();

CREATE FUNCTION noticeos.insert_legacy_notification_outbox() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, noticeos AS $$
BEGIN
  INSERT INTO noticeos.notification_events (
    workspace_id, event_id, channel, notification_type, source_kind, source_ref, occurrence, connection_id,
    payload, occurred_at, created_at, state, attempts, next_attempt_at, lease_id, lease_until, finished_at
  ) VALUES (
    NEW.workspace_id, NEW.event_id, NEW.channel, noticeos.legacy_notification_type(NEW.subject),
    noticeos.legacy_notification_source_kind(NEW.subject), NEW.subject_ref, NEW.occurrence, NEW.connection_id,
    CASE WHEN NEW.subject = 'mediavine-revenue' THEN jsonb_build_object(
      'amount_minor', NEW.revenue_minor, 'previous_minor', NEW.previous_revenue_minor,
      'month_minor', NEW.month_revenue_minor, 'month_reported_days', NEW.month_reported_days
    ) ELSE '{}'::jsonb END, NEW.occurred_at, NEW.created_at, NEW.state, NEW.attempts,
    NEW.next_attempt_at, NEW.lease_id, NEW.lease_until, NEW.finished_at
  ) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER insert_notification_outbox INSTEAD OF INSERT ON noticeos.notification_outbox
  FOR EACH ROW EXECUTE FUNCTION noticeos.insert_legacy_notification_outbox();

CREATE VIEW noticeos.notifications WITH (security_invoker = true) AS
  SELECT workspace_id, legacy_receipt_id AS notification_id, channel,
    noticeos.legacy_notification_subject(notification_type, source_kind) AS subject,
    source_ref AS subject_ref, occurrence, coalesce(legacy_condition, notification_type) AS condition, finished_at AS sent_at
  FROM noticeos.notification_events WHERE state = 'sent'
    AND noticeos.legacy_notification_subject(notification_type, source_kind) IS NOT NULL;
GRANT SELECT, INSERT ON noticeos.notifications TO noticeos_app;
GRANT SELECT ON noticeos.notifications TO noticeos_maint;

CREATE FUNCTION noticeos.insert_legacy_notification_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.condition IS NULL OR NEW.condition = '' THEN
    RAISE EXCEPTION 'notification receipt requires a condition' USING ERRCODE = '23514';
  END IF;
  INSERT INTO noticeos.notification_events (
    workspace_id, channel, notification_type, source_kind, source_ref, occurrence,
    occurred_at, created_at, state, next_attempt_at, finished_at, legacy_condition
  ) VALUES (
    NEW.workspace_id, NEW.channel, noticeos.legacy_notification_type(NEW.subject),
    noticeos.legacy_notification_source_kind(NEW.subject), NEW.subject_ref,
    NEW.occurrence, NEW.sent_at, NEW.sent_at, 'sent', NEW.sent_at, NEW.sent_at, NEW.condition
  ) ON CONFLICT (workspace_id, channel, notification_type, source_kind, source_ref, occurrence) DO UPDATE
    SET state = 'sent', finished_at = EXCLUDED.finished_at, lease_id = NULL, lease_until = NULL,
        legacy_condition = EXCLUDED.legacy_condition
    WHERE notification_events.state IN ('pending', 'cancelled');
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION noticeos.insert_legacy_notification_receipt() FROM PUBLIC;
CREATE TRIGGER insert_notification_receipt INSTEAD OF INSERT ON noticeos.notifications
  FOR EACH ROW EXECUTE FUNCTION noticeos.insert_legacy_notification_receipt();

CREATE OR REPLACE FUNCTION noticeos.enqueue_alert_notification() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, noticeos AS $$
DECLARE event_at timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'flag_evidence' THEN event_at := NEW.observed_at; ELSE event_at := NEW.fired_at; END IF;
  INSERT INTO noticeos.notification_events (
    workspace_id, notification_type, source_kind, source_ref, occurrence, occurred_at, next_attempt_at
  )
  SELECT f.workspace_id, 'open-error', 'alert', f.flag_number::text, '', event_at, event_at
  FROM noticeos.current_flags f
  WHERE f.workspace_id = NEW.workspace_id AND f.flag_id = NEW.flag_id
    AND f.severity = 'error' AND f.resolved_at IS NULL AND f.disposition IS NULL
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION noticeos.enqueue_connection_notification() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, noticeos AS $$
BEGIN
  IF NEW.provider <> 'discord' AND NEW.last_error IS NOT NULL AND NEW.last_used_at IS NOT NULL
     AND (NEW.last_ok_at IS NULL OR NEW.last_ok_at < NEW.last_used_at)
     AND (TG_OP = 'INSERT' OR OLD.last_error IS NULL OR OLD.last_used_at IS NULL
          OR OLD.last_ok_at >= OLD.last_used_at) THEN
    INSERT INTO noticeos.notification_events (
      workspace_id, notification_type, source_kind, source_ref, occurrence, connection_id, occurred_at, next_attempt_at
    )
    VALUES (NEW.workspace_id, 'source-failing', 'integration', NEW.provider, gen_random_uuid()::text,
            NEW.connection_id, NEW.last_used_at, NEW.last_used_at);
  END IF;
  RETURN NEW;
END
$$;
