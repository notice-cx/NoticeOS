-- Site icons: what each read of a site's home page found in its <link rel="icon">
-- and <link rel="apple-touch-icon"> tags, written by the ingest's daily icon
-- read (workers/ingest/src/site-icons.ts). One row per read: the best icon for
-- light surfaces and the best for dark ones (a media query matching
-- prefers-color-scheme: dark), each an absolute address. A site's card carries
-- the newest read that reached the page. Rows are history: never changed,
-- never removed.

CREATE TABLE noticeos.asset_icons (
  workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
  read_id      bigint GENERATED ALWAYS AS IDENTITY,
  asset_id     text NOT NULL,
  read_at      timestamptz NOT NULL,
  -- read: the page declared at least one icon; no-icon: the page answered and
  -- declared none; unreachable: no page came back.
  outcome      text NOT NULL CHECK (outcome IN ('read', 'no-icon', 'unreachable')),
  light_url    text CHECK (light_url ~ '^https?://' AND length(light_url) <= 2048),
  dark_url     text CHECK (dark_url ~ '^https?://' AND length(dark_url) <= 2048),
  -- The address read after redirects, its HTTP status and any transport error.
  detail       json NOT NULL DEFAULT '{}' CHECK (json_typeof(detail) = 'object'),
  CHECK ((outcome = 'read') = (light_url IS NOT NULL OR dark_url IS NOT NULL)),
  PRIMARY KEY (workspace_id, read_id),
  -- Also the index the newest read per site is found by.
  UNIQUE (workspace_id, asset_id, read_at),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES noticeos.assets
);

ALTER TABLE noticeos.asset_icons ENABLE ROW LEVEL SECURITY;
ALTER TABLE noticeos.asset_icons FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON noticeos.asset_icons
  USING (workspace_id = noticeos.current_workspace_id())
  WITH CHECK (workspace_id = noticeos.current_workspace_id());

REVOKE ALL ON noticeos.asset_icons FROM PUBLIC;
GRANT SELECT, INSERT ON noticeos.asset_icons TO noticeos_app;
GRANT SELECT ON noticeos.asset_icons TO noticeos_maint;
