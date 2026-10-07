-- Agent sign-in (epic ro-cvl9): the maintained Better Auth 1.7.7 tables for
-- its JWT plugin and @better-auth/oauth-provider, generated with the snake_case
-- names in packages/postgres/src/identity-engine.mts (AGENT_NAMES) and checked
-- against the generator by scripts/postgres-agent-sign-in.test.mjs. Signing
-- keys, OAuth clients, the two MCP resources, refresh tokens, consents. Additive;
-- existing stores require operator maintenance, and no sign-in is activated here.
create table "noticeos_identity"."auth_jwks" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "public_key" text not null, "private_key" text not null, "created_at" timestamptz not null, "expires_at" timestamptz, "alg" text, "crv" text);
create table "noticeos_identity"."auth_oauth_client" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "client_id" text not null unique, "client_secret" text, "client_discovery_id" text, "disabled" boolean, "skip_consent" boolean, "enable_end_session" boolean, "subject_type" text, "scopes" jsonb, "client_credentials_scopes" jsonb, "user_id" uuid references "noticeos_identity"."auth_user" ("id") on delete cascade, "created_at" timestamptz, "updated_at" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "software_id" text, "software_version" text, "software_statement" text, "redirect_uris" jsonb not null, "post_logout_redirect_uris" jsonb, "backchannel_logout_uri" text, "backchannel_logout_session_required" boolean, "token_endpoint_auth_method" text, "application_type" text, "jwks" text, "jwks_uri" text, "grant_types" jsonb, "response_types" jsonb, "require_pkce" boolean, "dpop_bound_access_tokens" boolean, "reference_id" text, "metadata" jsonb);
create table "noticeos_identity"."auth_oauth_resource" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "identifier" text not null unique, "name" text not null, "access_token_ttl" integer, "refresh_token_ttl" integer, "signing_algorithm" text, "signing_key_id" text, "allowed_scopes" jsonb, "custom_claims" jsonb, "dpop_bound_access_tokens_required" boolean, "disabled" boolean, "created_at" timestamptz, "updated_at" timestamptz, "policy_version" integer, "metadata" jsonb);
create table "noticeos_identity"."auth_oauth_client_resource" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "client_id" text not null references "noticeos_identity"."auth_oauth_client" ("client_id") on delete cascade, "resource_id" text not null references "noticeos_identity"."auth_oauth_resource" ("identifier") on delete cascade, "metadata" jsonb, "created_at" timestamptz);
create table "noticeos_identity"."auth_oauth_refresh_token" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "token" text not null unique, "client_id" text not null references "noticeos_identity"."auth_oauth_client" ("client_id") on delete cascade, "session_id" uuid references "noticeos_identity"."auth_session" ("id") on delete set null, "user_id" uuid not null references "noticeos_identity"."auth_user" ("id") on delete cascade, "reference_id" text, "authorization_code_id" text, "resources" jsonb, "requested_user_info_claims" jsonb, "expires_at" timestamptz not null, "created_at" timestamptz not null, "revoked" timestamptz, "rotated_at" timestamptz, "rotation_replay_response" text, "rotation_replay_expires_at" timestamptz, "auth_time" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);
create table "noticeos_identity"."auth_oauth_access_token" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "token" text not null unique, "client_id" text not null references "noticeos_identity"."auth_oauth_client" ("client_id") on delete cascade, "session_id" uuid references "noticeos_identity"."auth_session" ("id") on delete set null, "user_id" uuid references "noticeos_identity"."auth_user" ("id") on delete cascade, "reference_id" text, "authorization_code_id" text, "resources" jsonb, "requested_user_info_claims" jsonb, "refresh_id" uuid references "noticeos_identity"."auth_oauth_refresh_token" ("id") on delete cascade, "expires_at" timestamptz not null, "created_at" timestamptz not null, "revoked" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);
create table "noticeos_identity"."auth_oauth_consent" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "client_id" text not null references "noticeos_identity"."auth_oauth_client" ("client_id") on delete cascade, "user_id" uuid references "noticeos_identity"."auth_user" ("id") on delete cascade, "reference_id" text, "resources" jsonb, "requested_user_info_claims" jsonb, "scopes" jsonb not null, "created_at" timestamptz not null, "updated_at" timestamptz not null);
create table "noticeos_identity"."auth_oauth_client_assertion" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "expires_at" timestamptz not null);
create index "auth_oauth_client_user_id_idx" on "noticeos_identity"."auth_oauth_client" ("user_id");
create index "auth_oauth_client_resource_client_id_idx" on "noticeos_identity"."auth_oauth_client_resource" ("client_id");
create index "auth_oauth_client_resource_resource_id_idx" on "noticeos_identity"."auth_oauth_client_resource" ("resource_id");
create index "auth_oauth_refresh_token_client_id_idx" on "noticeos_identity"."auth_oauth_refresh_token" ("client_id");
create index "auth_oauth_refresh_token_session_id_idx" on "noticeos_identity"."auth_oauth_refresh_token" ("session_id");
create index "auth_oauth_refresh_token_user_id_idx" on "noticeos_identity"."auth_oauth_refresh_token" ("user_id");
create index "auth_oauth_refresh_token_authorization_code_id_idx" on "noticeos_identity"."auth_oauth_refresh_token" ("authorization_code_id");
create index "auth_oauth_access_token_client_id_idx" on "noticeos_identity"."auth_oauth_access_token" ("client_id");
create index "auth_oauth_access_token_session_id_idx" on "noticeos_identity"."auth_oauth_access_token" ("session_id");
create index "auth_oauth_access_token_user_id_idx" on "noticeos_identity"."auth_oauth_access_token" ("user_id");
create index "auth_oauth_access_token_authorization_code_id_idx" on "noticeos_identity"."auth_oauth_access_token" ("authorization_code_id");
create index "auth_oauth_access_token_refresh_id_idx" on "noticeos_identity"."auth_oauth_access_token" ("refresh_id");
create index "auth_oauth_consent_client_id_idx" on "noticeos_identity"."auth_oauth_consent" ("client_id");
create index "auth_oauth_consent_user_id_idx" on "noticeos_identity"."auth_oauth_consent" ("user_id");
create unique index "auth_oauth_client_resource_client_id_resource_id_uidx" on "noticeos_identity"."auth_oauth_client_resource" ("client_id", "resource_id");
GRANT SELECT, INSERT, UPDATE, DELETE ON
  noticeos_identity.auth_jwks,
  noticeos_identity.auth_oauth_client,
  noticeos_identity.auth_oauth_resource,
  noticeos_identity.auth_oauth_client_resource,
  noticeos_identity.auth_oauth_refresh_token,
  noticeos_identity.auth_oauth_access_token,
  noticeos_identity.auth_oauth_consent,
  noticeos_identity.auth_oauth_client_assertion
TO noticeos_identity;
