-- Hourly snapshots may leave hot storage only after their analytical export.
CREATE TRIGGER history_leaves_only_when_exported BEFORE DELETE ON noticeos.mercury_readings
  FOR EACH ROW EXECUTE FUNCTION noticeos.history_leaves_only_when_exported('observed_at', '35 days');

-- Preserve the last known balance through extended collection failures.
CREATE FUNCTION noticeos.retain_latest_mercury_reading() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM noticeos.mercury_readings r
     WHERE r.workspace_id = OLD.workspace_id AND r.connection_id = OLD.connection_id
       AND (r.observed_at, r.reading_id) > (OLD.observed_at, OLD.reading_id)
  ) THEN
    RAISE EXCEPTION 'mercury_readings: the newest reading of a connection must remain'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER retain_latest_mercury_reading BEFORE DELETE ON noticeos.mercury_readings
  FOR EACH ROW EXECUTE FUNCTION noticeos.retain_latest_mercury_reading();
GRANT DELETE ON noticeos.mercury_readings TO noticeos_maint;
