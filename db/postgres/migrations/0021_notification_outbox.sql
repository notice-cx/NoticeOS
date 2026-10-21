-- Delivery intent commits with its source condition. Wake-ups contain no data;
-- consumers must read their own workspace through forced row security.
CREATE TABLE noticeos.notification_outbox (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  channel text NOT NULL DEFAULT 'discord' CHECK (channel = 'discord'),
  subject text NOT NULL CHECK (subject IN ('alert','data-source')),
  subject_ref text NOT NULL CHECK (subject_ref <> ''),
  occurrence text NOT NULL,
  connection_id uuid,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_id uuid,
  lease_until timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (workspace_id, channel, subject, subject_ref, occurrence),
  CHECK ((lease_id IS NULL) = (lease_until IS NULL)),
  CHECK ((state = 'pending') = (finished_at IS NULL)),
  CHECK (state = 'pending' OR lease_id IS NULL)
);
CREATE INDEX notification_outbox_due ON noticeos.notification_outbox (workspace_id, next_attempt_at)
  WHERE state = 'pending';
ALTER TABLE noticeos.notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.notification_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.notification_outbox
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());
REVOKE ALL ON noticeos.notification_outbox FROM PUBLIC;
GRANT SELECT, INSERT ON noticeos.notification_outbox TO noticeos_app;
GRANT UPDATE (state, attempts, next_attempt_at, lease_id, lease_until, finished_at)
  ON noticeos.notification_outbox TO noticeos_app;
GRANT SELECT ON noticeos.notification_outbox TO noticeos_maint;

CREATE FUNCTION noticeos.enqueue_alert_notification() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, noticeos AS $$
DECLARE event_at timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'flag_evidence' THEN event_at := NEW.observed_at; ELSE event_at := NEW.fired_at; END IF;
  INSERT INTO noticeos.notification_outbox (workspace_id, subject, subject_ref, occurrence, occurred_at, next_attempt_at)
    SELECT f.workspace_id, 'alert', f.flag_number::text, '',
           event_at, event_at
      FROM noticeos.current_flags f
     WHERE f.workspace_id = NEW.workspace_id AND f.flag_id = NEW.flag_id
       AND f.severity = 'error' AND f.resolved_at IS NULL AND f.disposition IS NULL
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER flag_notification AFTER INSERT ON noticeos.flags
  FOR EACH ROW EXECUTE FUNCTION noticeos.enqueue_alert_notification();
CREATE TRIGGER evidence_notification AFTER INSERT ON noticeos.flag_evidence
  FOR EACH ROW EXECUTE FUNCTION noticeos.enqueue_alert_notification();

CREATE FUNCTION noticeos.enqueue_connection_notification() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, noticeos AS $$
BEGIN
  IF NEW.provider <> 'discord' AND NEW.last_error IS NOT NULL AND NEW.last_used_at IS NOT NULL
     AND (NEW.last_ok_at IS NULL OR NEW.last_ok_at < NEW.last_used_at)
     AND (TG_OP = 'INSERT' OR OLD.last_error IS NULL OR OLD.last_used_at IS NULL
          OR OLD.last_ok_at >= OLD.last_used_at) THEN
    INSERT INTO noticeos.notification_outbox
      (workspace_id, subject, subject_ref, occurrence, connection_id, occurred_at, next_attempt_at)
    VALUES (NEW.workspace_id, 'data-source', NEW.provider, gen_random_uuid()::text,
            NEW.connection_id, NEW.last_used_at, NEW.last_used_at);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connection_notification AFTER INSERT OR UPDATE OF last_error, last_used_at, last_ok_at ON noticeos.integration_connections
  FOR EACH ROW EXECUTE FUNCTION noticeos.enqueue_connection_notification();

CREATE FUNCTION noticeos.notification_wakeup() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_notify('noticeos_notifications', '');
  RETURN NEW;
END $$;
CREATE TRIGGER notification_wakeup AFTER INSERT ON noticeos.notification_outbox
  FOR EACH ROW EXECUTE FUNCTION noticeos.notification_wakeup();
