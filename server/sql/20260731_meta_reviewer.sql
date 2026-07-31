BEGIN;

ALTER TABLE data_room.users
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE data_room.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE data_room.users ADD CONSTRAINT users_role_check CHECK (
  role IN ('founder_admin','authorised_user','pending_user','revoked_user','meta_reviewer')
);

COMMIT;
