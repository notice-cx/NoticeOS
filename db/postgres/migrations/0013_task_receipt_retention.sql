-- Task operation receipts are kept seven days after their last attempt (epic
-- ro-cvl9). A receipt is what stops a retried change from applying twice, and
-- no client retries a change a week later: past that, a retry runs as a new
-- change. Additive. The application removes its own workspace's expired
-- receipts before it records a new one; maintenance may remove them across
-- workspaces. The trigger refuses any removal sooner, whoever asks.
CREATE FUNCTION noticeos.task_receipt_leaves_only_when_expired() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(OLD.finished_at, OLD.started_at) >= now() - interval '7 days' THEN
    RAISE EXCEPTION 'task_operation_receipts: a receipt stays seven days after its last attempt'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER task_receipt_leaves_only_when_expired BEFORE DELETE ON noticeos.task_operation_receipts
  FOR EACH ROW EXECUTE FUNCTION noticeos.task_receipt_leaves_only_when_expired();
GRANT DELETE ON noticeos.task_operation_receipts TO noticeos_app, noticeos_maint;
