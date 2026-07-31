import "dotenv/config";
import { pool } from "../server/src/storage/postgres.client";
import { hashPassword } from "../server/src/rd-lab/rd-auth.service";
import { isValidEmail, normalizeEmail } from "../server/src/services/data-room.service";

const email = normalizeEmail(process.env.META_REVIEWER_EMAIL);
const password = process.env.META_REVIEWER_PASSWORD;
const expiresAt = process.env.META_REVIEWER_EXPIRES_AT?.trim() || null;

if (!email || !isValidEmail(email) || !password) {
  throw new Error("Set META_REVIEWER_EMAIL and META_REVIEWER_PASSWORD only for this command");
}
if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
  throw new Error("META_REVIEWER_EXPIRES_AT must be an ISO timestamp when supplied");
}

const provision = async () => {
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      "SELECT id,role FROM data_room.users WHERE lower(email)=$1 FOR UPDATE",
      [email]
    );
    if (existing.rows[0] && existing.rows[0].role !== "meta_reviewer") {
      throw new Error("The requested email belongs to a non-reviewer account");
    }
    const user = await client.query(
      `INSERT INTO data_room.users(email,role,access_tier,authorised_at,is_active,expires_at)
       VALUES($1,'meta_reviewer','public_light',now(),true,$2)
       ON CONFLICT(email) DO UPDATE SET
         is_active=true,expires_at=EXCLUDED.expires_at,revoked_at=NULL,updated_at=now()
       RETURNING id,email`,
      [email,expiresAt]
    );
    await client.query(
      `INSERT INTO rd_lab.password_credentials(user_id,password_hash)
       VALUES($1,$2)
       ON CONFLICT(user_id) DO UPDATE SET
         password_hash=EXCLUDED.password_hash,password_updated_at=now(),
         failed_attempts=0,locked_until=NULL,updated_at=now()`,
      [user.rows[0].id,passwordHash]
    );
    const workspace = await client.query(
      `INSERT INTO growth_os.workspaces(owner_user_id,name,timezone)
       VALUES($1,'Meta Review Workspace','Europe/London')
       ON CONFLICT(owner_user_id) DO UPDATE SET name=EXCLUDED.name
       RETURNING id`,
      [user.rows[0].id]
    );
    await client.query(
      "INSERT INTO growth_os.strategy(workspace_id) VALUES($1) ON CONFLICT(workspace_id) DO NOTHING",
      [workspace.rows[0].id]
    );
    await client.query(
      `INSERT INTO growth_os.daily_missions(
         workspace_id,seed_key,title,description,reason,expected_outcome,
         estimated_minutes,priority,mission_date,status
       ) VALUES($1,'meta-review-example-mission','Review the Facebook connection',
         'Open Settings and test the isolated Facebook connection flow.',
         'Validate the Meta OAuth review journey without production data.',
         'The reviewer can connect, confirm status and disconnect Facebook.',
         10,'medium',CURRENT_DATE,'planned')
       ON CONFLICT(workspace_id,seed_key) DO NOTHING`,
      [workspace.rows[0].id]
    );
    await client.query(
      `INSERT INTO growth_os.content_items(
         workspace_id,title,content_type,platform,status,caption
       )
       SELECT $1,'Example review content','social_post','facebook','idea',
         'Harmless demonstration content for Meta App Review.'
       WHERE NOT EXISTS (
         SELECT 1 FROM growth_os.content_items
         WHERE workspace_id=$1 AND title='Example review content'
       )`,
      [workspace.rows[0].id]
    );
    await client.query("COMMIT");
    console.log(`Meta reviewer account provisioned for ${user.rows[0].email}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

provision().finally(() => pool.end());
