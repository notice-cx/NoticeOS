-- The database roles the model needs.
--
-- Cluster-wide, so not a migration: run once per database cluster, before the
-- first migration, by whoever administers it (BYPASSRLS needs a superuser).
-- All seven are NOLOGIN and no role is granted membership in another. On a
-- real host, giving each a login (or granting it to a login role) with a
-- password or certificate the operator holds is protected, operator-only work.
--
--   noticeos_owner  owns the schemas and every table; migrations run as it.
--                   Row security is FORCED on every workspace table, so even
--                   the owner reads and writes only the workspace its
--                   transaction names.
--   noticeos_app    what the Workers and scripts connect as. Not an owner and
--                   not BYPASSRLS, so row security always applies; its table
--                   privileges are exactly the revision rules in mapping.json.
--                   A job that works one workspace at a time runs as it and
--                   names each workspace with SET LOCAL.
--   noticeos_maint  what a job that legitimately spans workspaces runs as: the
--                   retention sweeps and moves to the analytical store, the
--                   capacity readback, the importer's pre-flight and the
--                   rehearsal's counts. BYPASSRLS, so it sees every workspace;
--                   it owns nothing, creates nothing, updates nothing, and may
--                   remove only what mapping.json `maintenance` lists.

--   noticeos_identity owns no schema/table and cannot access tenant data. It
--                   reads maintained sessions/memberships in its separate
--                   identity schema. Login activation is operator-only.
--   noticeos_platform performs the narrowly granted control-plane registration
--                   and provisioning operations in additive migrations.
--                   Directory/grant registration is not initialization or readiness.
--   noticeos_task_directory reads one unrevoked mapping through a fixed
--                   function. A mapping is facts, not task admission.

--   noticeos_service_grant reads one fixed service grant and canonical lifecycle
--                   through a function; it has no table or identity access.

CREATE ROLE noticeos_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE noticeos_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
CREATE ROLE noticeos_maint NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
CREATE ROLE noticeos_identity NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
CREATE ROLE noticeos_platform NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
CREATE ROLE noticeos_task_directory NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
CREATE ROLE noticeos_service_grant NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
