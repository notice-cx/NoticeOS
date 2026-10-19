-- A signed-in person's own choices in a hosted workspace, starting with which
-- view of the Tower they open (the `ViewChoice` of packages/contract/src/views.mts),
-- so the choice follows the person to every sign-in and device. Written by the
-- Tower's /api/me/preferences routes (apps/tower/worker/person-preference-route.ts).
-- A standalone installation has no person and keeps the choice in the browser.
--
-- One row per save: the newest row for a workspace, person and name is the
-- current value. A reset is a save of the default value. Rows are history:
-- never changed, never removed.

CREATE TABLE noticeos.person_preferences (
  workspace_id  uuid NOT NULL REFERENCES noticeos.workspaces,
  preference_id bigint GENERATED ALWAYS AS IDENTITY,
  -- The identity schema's person id (auth_user); that schema is reached by a
  -- separate role, so there is no foreign key to it, as in workspace_mutation_audit.
  person_id     uuid NOT NULL,
  name          text NOT NULL CHECK (name IN ('view')),
  value         jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(value) = 'object'
                                      AND pg_catalog.octet_length(value::text) <= 2048),
  recorded_at   timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (workspace_id, preference_id)
);

-- The newest value per person and name.
CREATE INDEX person_preferences_newest
  ON noticeos.person_preferences (workspace_id, person_id, name, preference_id DESC);

ALTER TABLE noticeos.person_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.person_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.person_preferences
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());

REVOKE ALL ON noticeos.person_preferences FROM PUBLIC;
GRANT SELECT, INSERT ON noticeos.person_preferences TO noticeos_app;
GRANT SELECT ON noticeos.person_preferences TO noticeos_maint;
