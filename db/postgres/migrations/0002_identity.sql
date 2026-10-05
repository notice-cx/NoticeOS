-- Maintained Better Auth 1.7.7 snake_case schema (ro-ujb9.289.8.3.1).
-- Generated with the qualified minimal/Kysely mappings. Runtime code never
-- applies migrations. Existing installations require operator maintenance.
CREATE SCHEMA noticeos_identity;
REVOKE ALL ON SCHEMA noticeos_identity FROM PUBLIC;

create table "noticeos_identity"."auth_user" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "name" text not null, "email" text not null unique, "email_verified" boolean not null, "image" text, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz default CURRENT_TIMESTAMP not null);

create table "noticeos_identity"."auth_session" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "expires_at" timestamptz not null, "token" text not null unique, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz not null, "ip_address" text, "user_agent" text, "user_id" uuid not null references "noticeos_identity"."auth_user" ("id") on delete cascade, "active_organization_id" text);

create table "noticeos_identity"."auth_account" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "account_id" text not null, "provider_id" text not null, "user_id" uuid not null references "noticeos_identity"."auth_user" ("id") on delete cascade, "access_token" text, "refresh_token" text, "id_token" text, "access_token_expires_at" timestamptz, "refresh_token_expires_at" timestamptz, "scope" text, "password" text, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz not null);

create table "noticeos_identity"."auth_verification" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "identifier" text not null, "value" text not null, "expires_at" timestamptz not null, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz default CURRENT_TIMESTAMP not null);

create table "noticeos_identity"."auth_organization" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "created_at" timestamptz not null, "metadata" text);

create table "noticeos_identity"."auth_member" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "organization_id" uuid not null references "noticeos_identity"."auth_organization" ("id") on delete cascade, "user_id" uuid not null references "noticeos_identity"."auth_user" ("id") on delete cascade, "role" text not null, "created_at" timestamptz not null);

create table "noticeos_identity"."auth_invitation" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "organization_id" uuid not null references "noticeos_identity"."auth_organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expires_at" timestamptz not null, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "inviter_id" uuid not null references "noticeos_identity"."auth_user" ("id") on delete cascade);

create index "auth_session_user_id_idx" on "noticeos_identity"."auth_session" ("user_id");

create index "auth_account_user_id_idx" on "noticeos_identity"."auth_account" ("user_id");

create index "auth_verification_identifier_idx" on "noticeos_identity"."auth_verification" ("identifier");

create index "auth_member_organization_id_idx" on "noticeos_identity"."auth_member" ("organization_id");

create index "auth_member_user_id_idx" on "noticeos_identity"."auth_member" ("user_id");

create index "auth_invitation_organization_id_idx" on "noticeos_identity"."auth_invitation" ("organization_id");

create index "auth_invitation_email_idx" on "noticeos_identity"."auth_invitation" ("email");

-- Identity organizations anchor existing canonical workspaces; names and
-- lifecycle remain in noticeos.workspaces, not an independently editable copy.
ALTER TABLE noticeos_identity.auth_organization ADD CONSTRAINT auth_organization_workspace_fk
  FOREIGN KEY (id) REFERENCES noticeos.workspaces(workspace_id) ON DELETE RESTRICT;
ALTER TABLE noticeos_identity.auth_member ADD CONSTRAINT auth_member_workspace_user_unique
  UNIQUE (organization_id, user_id);

GRANT USAGE ON SCHEMA noticeos_identity TO noticeos_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA noticeos_identity TO noticeos_identity;
