-- member_count follows team_members in the same statement. App code never writes it.
CREATE FUNCTION sync_team_member_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE teams SET member_count = member_count + 1 WHERE id = NEW.team_id;
  ELSE
    UPDATE teams SET member_count = member_count - 1 WHERE id = OLD.team_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER team_members_count_sync
  AFTER INSERT OR DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION sync_team_member_count();

-- A membership is inserted or deleted, never moved or edited in place.
CREATE FUNCTION reject_membership_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'membership rows are immutable' USING ERRCODE = '23514',
    CONSTRAINT = 'team_members_immutable';
END $$;
CREATE TRIGGER team_members_no_update BEFORE UPDATE ON team_members
  FOR EACH ROW EXECUTE FUNCTION reject_membership_update();

-- Verify the FINAL count at commit, including accidental direct counter writes.
-- The corresponding team row is already write-locked by the mutation/trigger.
CREATE FUNCTION verify_team_member_count() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stored_count integer; actual_count integer;
BEGIN
  SELECT member_count INTO stored_count FROM teams WHERE id = NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF; -- last-member leave deleted the team
  SELECT count(*) INTO actual_count FROM team_members WHERE team_id = NEW.id;
  IF stored_count <> actual_count THEN
    RAISE EXCEPTION 'member count mismatch' USING ERRCODE = '23514',
      CONSTRAINT = 'teams_member_count_matches';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER teams_verify_member_count
  AFTER INSERT OR UPDATE ON teams DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION verify_team_member_count();

-- Every update bumps version and updated_at. OLD is the locked, latest row, so no lost updates.
CREATE FUNCTION teams_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version    := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER teams_touch
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION teams_touch();

-- The audit log is append-only.
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER audit_log_no_mutation
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
