CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  password_hash  text NOT NULL,
  display_name   text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  skills         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(skills) <= 12),
  utc_offset_min smallint NOT NULL DEFAULT 0 CHECK (utc_offset_min BETWEEN -720 AND 840),
  is_organizer   boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));
CREATE INDEX users_skills_gin ON users USING gin (skills);

CREATE TABLE hackathons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  min_team_size smallint NOT NULL CHECK (min_team_size >= 1),
  max_team_size smallint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hackathons_size_range CHECK (max_team_size >= min_team_size AND max_team_size <= 10)
);

-- Registration. Also the per-user mutex row (section 7.3).
CREATE TABLE hackathon_participants (
  hackathon_id    uuid NOT NULL REFERENCES hackathons (id),
  user_id         uuid NOT NULL REFERENCES users (id),
  open_to_invites boolean NOT NULL DEFAULT true,
  registered_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hackathon_id, user_id)
);

CREATE TABLE teams (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id      uuid NOT NULL REFERENCES hackathons (id),
  name              text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  looking_for       text[] NOT NULL DEFAULT '{}' CHECK (cardinality(looking_for) <= 8),
  is_open           boolean NOT NULL DEFAULT true,       -- leader toggle: "looking for teammates"
  leader_id         uuid NOT NULL,                       -- FK added below (deferred)
  min_size          smallint NOT NULL,                   -- snapshot of the hackathon rule
  max_size          smallint NOT NULL,                   -- snapshot of the hackathon rule
  member_count      smallint NOT NULL DEFAULT 0,         -- kept by trigger, never by app code
  invite_code       text NOT NULL,
  invite_expires_at timestamptz NOT NULL,
  version           bigint NOT NULL DEFAULT 1,           -- bumped by trigger on every update
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teams_size_range      CHECK (min_size >= 1 AND max_size >= min_size),
  CONSTRAINT teams_count_nonneg    CHECK (member_count >= 0),
  CONSTRAINT teams_not_overfull    CHECK (member_count <= max_size),   -- the seat guarantee
  CONSTRAINT teams_invite_format   CHECK (invite_code ~ '^[0-9A-HJKMNP-TV-Z]{10}$'),
  CONSTRAINT teams_id_hackathon_uq UNIQUE (id, hackathon_id)
);
CREATE UNIQUE INDEX teams_invite_code_uq ON teams (invite_code);
CREATE UNIQUE INDEX teams_name_per_hackathon_uq ON teams (hackathon_id, lower(name));

CREATE TABLE team_members (
  team_id      uuid NOT NULL,
  hackathon_id uuid NOT NULL,
  user_id      uuid NOT NULL,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id),
  -- team and member must belong to the same hackathon; no cascade: a team can only be deleted when empty
  CONSTRAINT team_members_team_fk
    FOREIGN KEY (team_id, hackathon_id) REFERENCES teams (id, hackathon_id),
  CONSTRAINT team_members_participant_fk
    FOREIGN KEY (hackathon_id, user_id) REFERENCES hackathon_participants (hackathon_id, user_id),
  -- one team per person per hackathon
  CONSTRAINT team_members_one_team_per_hackathon UNIQUE (hackathon_id, user_id)
);

-- The leader is always a member. Deferred, so promotion or deletion can happen in one transaction.
ALTER TABLE teams
  ADD CONSTRAINT teams_leader_is_member_fk
  FOREIGN KEY (id, leader_id) REFERENCES team_members (team_id, user_id)
  DEFERRABLE INITIALLY DEFERRED;

-- Board: open teams with free seats, newest first (keyset pagination).
CREATE INDEX teams_board_idx
  ON teams (hackathon_id, created_at DESC, id DESC)
  WHERE is_open AND member_count < max_size;

CREATE TABLE join_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id uuid NOT NULL,
  team_id      uuid NOT NULL,
  user_id      uuid NOT NULL,
  message      text NOT NULL DEFAULT '' CHECK (char_length(message) <= 300),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','accepted','declined','cancelled','expired')),
  decided_by   uuid REFERENCES users (id),
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT join_requests_team_fk
    FOREIGN KEY (team_id, hackathon_id) REFERENCES teams (id, hackathon_id) ON DELETE CASCADE,
  CONSTRAINT join_requests_participant_fk
    FOREIGN KEY (hackathon_id, user_id) REFERENCES hackathon_participants (hackathon_id, user_id),
  CONSTRAINT join_requests_decided_chk CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX join_requests_one_pending_uq ON join_requests (team_id, user_id) WHERE status = 'pending';
CREATE INDEX join_requests_inbox_idx ON join_requests (team_id, created_at) WHERE status = 'pending';
CREATE INDEX join_requests_user_pending_idx ON join_requests (hackathon_id, user_id) WHERE status = 'pending';

CREATE TABLE idempotency_keys (
  user_id         uuid NOT NULL REFERENCES users (id),
  key             text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 100),
  request_hash    text NOT NULL,                 -- sha256(method + path + canonical JSON body)
  response_status smallint,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE TABLE audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hackathon_id   uuid NOT NULL,
  team_id        uuid,                           -- deliberately NOT a foreign key: history outlives the team
  actor_id       uuid,                           -- NULL for system actions
  target_user_id uuid,
  action         text NOT NULL,
  details        jsonb NOT NULL DEFAULT '{}',
  request_id     text,                           -- correlation with logs
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_team_idx ON audit_log (team_id, id DESC);
CREATE INDEX audit_hackathon_idx ON audit_log (hackathon_id, id DESC);
