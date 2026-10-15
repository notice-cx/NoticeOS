-- Codebase reports: what a site's measurement run found in its repository
-- (size, repeated code, unused code, hard-to-change functions, recent
-- changes), one envelope per run, validated by the contract's CodebaseReport.
-- A same-day resend appends revision n+1, as a nightly report does; the
-- newest revision per site and day is current (current_codebase_reports).
-- Rows are history: never changed, never removed.

CREATE TABLE noticeos.codebase_reports (
  workspace_id  uuid NOT NULL REFERENCES noticeos.workspaces,
  report_id     bigint GENERATED ALWAYS AS IDENTITY,
  report_number bigint NOT NULL CHECK (report_number >= 1), -- what readers show; see "Numbers a workspace hands out"
  asset_id      text NOT NULL,
  -- The UTC day of the envelope's generatedAt.
  report_date   date NOT NULL,
  revision      integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- The commit measured and the ref it was read from.
  commit        char(40) NOT NULL CHECK (commit ~ '^[0-9a-f]{40}$'),
  ref           text NOT NULL CHECK (ref <> ''),
  generated_at  timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  -- The report as received: an object, validated by the codebase contract.
  envelope      json NOT NULL CHECK (json_typeof(envelope) = 'object'),
  PRIMARY KEY (workspace_id, report_id),
  UNIQUE (workspace_id, report_number),
  -- Also the index the current view and every site's history read.
  UNIQUE (workspace_id, asset_id, report_date, revision),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);

ALTER TABLE noticeos.codebase_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.codebase_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.codebase_reports
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());
CREATE TRIGGER number_in_workspace BEFORE INSERT ON noticeos.codebase_reports
  FOR EACH ROW EXECUTE FUNCTION noticeos.number_in_workspace('report_number');

-- Each site's report for each day: its newest revision. `day_number` is the
-- number the day's first revision took, and stays the report's number however
-- often the site sends that day again. Written as "no newer revision" so a
-- reader's bound on report_date reaches the unique key.
CREATE VIEW noticeos.current_codebase_reports WITH (security_invoker = true) AS
SELECT r.*,
       (SELECT d.report_number FROM noticeos.codebase_reports d
         WHERE d.workspace_id = r.workspace_id AND d.asset_id = r.asset_id
           AND d.report_date = r.report_date AND d.revision = 1) AS day_number
  FROM noticeos.codebase_reports r
 WHERE NOT EXISTS (SELECT 1 FROM noticeos.codebase_reports n
                    WHERE n.workspace_id = r.workspace_id AND n.asset_id = r.asset_id
                      AND n.report_date = r.report_date AND n.revision > r.revision);

REVOKE ALL ON noticeos.codebase_reports, noticeos.current_codebase_reports FROM PUBLIC;
GRANT SELECT, INSERT ON noticeos.codebase_reports TO noticeos_app;
GRANT SELECT ON noticeos.current_codebase_reports TO noticeos_app;
GRANT SELECT ON noticeos.codebase_reports, noticeos.current_codebase_reports TO noticeos_maint;
