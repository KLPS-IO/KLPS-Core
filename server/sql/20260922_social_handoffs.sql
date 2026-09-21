BEGIN;
CREATE TABLE growth_os.social_handoffs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 publish_job_id uuid NOT NULL UNIQUE,
 provider text NOT NULL CHECK(provider='snapchat'),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 encrypted_url text NOT NULL,
 image_url text,
 media_delivery_id uuid REFERENCES growth_os.media_deliveries(id),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,publish_job_id) REFERENCES growth_os.social_publish_jobs(workspace_id,id) ON DELETE RESTRICT
);
COMMIT;
