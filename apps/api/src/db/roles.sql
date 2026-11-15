-- TeamForge — Least-Privilege Database Roles for Production (Neon / PostgreSQL 16)
--
-- This script creates a dedicated, unprivileged runtime application role ('teamforge_app')
-- separate from the migration/schema owner role ('teamforge_owner' / 'neondb_owner').
--
-- Defense-in-depth:
-- 1. teamforge_app is granted only SELECT and INSERT on audit_log.
-- 2. UPDATE, DELETE, and TRUNCATE are withheld at the grant level (SQLSTATE 42501).
-- 3. Non-owner status prevents teamforge_app from altering, dropping, or disabling audit triggers.
-- 4. Existing audit_log_no_mutation trigger remains active as secondary defense.

-- 1. Create the runtime application role (replace password in secret manager)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teamforge_app') THEN
    CREATE ROLE teamforge_app WITH LOGIN PASSWORD 'REPLACE_WITH_STRONG_RUNTIME_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

-- 2. Schema and general table privileges
GRANT CONNECT ON DATABASE teamforge TO teamforge_app;
GRANT USAGE ON SCHEMA public TO teamforge_app;

-- Grant standard DML to mutable application tables
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  users,
  hackathons,
  hackathon_participants,
  teams,
  team_members,
  join_requests,
  idempotency_keys
TO teamforge_app;

-- Grant sequence privileges
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO teamforge_app;

-- 3. Hardened append-only audit_log privileges
-- Strictly withhold UPDATE, DELETE, TRUNCATE
REVOKE ALL ON TABLE audit_log FROM teamforge_app;
GRANT SELECT, INSERT ON TABLE audit_log TO teamforge_app;

-- 4. Set default privileges for future objects created by schema owner
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO teamforge_app;
