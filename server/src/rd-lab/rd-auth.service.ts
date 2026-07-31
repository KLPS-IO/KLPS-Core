import crypto from "crypto";
import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";
import { hashSha256, normalizeEmail } from "../services/data-room.service";

type Db = Pick<PoolClient, "query">;
const scrypt = (password:string,salt:Buffer,length:number,options:crypto.ScryptOptions) =>
  new Promise<Buffer>((resolve,reject)=>crypto.scrypt(password,salt,length,options,(error,key)=>error?reject(error):resolve(key)));
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export function validateFounderPassword(password: unknown) {
  if (typeof password !== "string" || password.length < 14 || password.length > 200)
    throw Object.assign(new Error("Password must contain at least 14 characters"), { code: "weak_password", statusCode: 400 });
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password))
    throw Object.assign(new Error("Password must include upper-case, lower-case, numeric and symbol characters"), { code: "weak_password", statusCode: 400 });
  return password;
}

export async function hashPassword(password: string) {
  validateFounderPassword(password);
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: unknown, encoded: unknown) {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  const [algorithm, n, r, p, saltValue, hashValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64");
  const actual = await scrypt(password, Buffer.from(saltValue, "base64"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p)
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export async function setFounderPassword(email: string, password: string, db: Db = pool) {
  const normalized = normalizeEmail(email);
  const user = await db.query(`SELECT id,email,role,access_tier FROM data_room.users WHERE lower(email)=$1 LIMIT 1`, [normalized]);
  if (!user.rows[0] || user.rows[0].role !== "founder_admin") throw new Error("A canonical founder_admin user must exist before password bootstrap");
  const passwordHash = await hashPassword(password);
  await db.query(
    `INSERT INTO rd_lab.password_credentials(user_id,password_hash) VALUES($1,$2)
     ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,password_updated_at=now(),
     failed_attempts=0,locked_until=NULL,updated_at=now()`,
    [user.rows[0].id, passwordHash]
  );
  return user.rows[0];
}

export async function authenticateFounder(email: unknown, password: unknown, ip: string | null, db: Db = pool) {
  const normalized = normalizeEmail(email);
  const emailHash = hashSha256(normalized || "invalid");
  const ipHash = ip ? hashSha256(ip) : null;
  const attempts = await db.query(
    `SELECT count(*)::int AS failures FROM rd_lab.login_attempts
     WHERE succeeded=false AND attempted_at > now()-interval '15 minutes'
     AND (email_hash=$1 OR ($2::text IS NOT NULL AND ip_hash=$2))`, [emailHash, ipHash]
  );
  if (Number(attempts.rows[0]?.failures ?? 0) >= 5)
    throw Object.assign(new Error("Too many login attempts. Try again later."), { code: "rate_limited", statusCode: 429 });
  const result = await db.query(
    `SELECT u.id,u.email,u.role,u.access_tier,c.password_hash,c.locked_until
     FROM data_room.users u JOIN rd_lab.password_credentials c ON c.user_id=u.id
     WHERE lower(u.email)=$1
       AND u.role IN ('founder_admin','meta_reviewer')
       AND COALESCE(u.is_active,true)=true
       AND (u.expires_at IS NULL OR u.expires_at>now())
     LIMIT 1`, [normalized]
  );
  const row = result.rows[0];
  const valid = row && (!row.locked_until || new Date(row.locked_until) <= new Date()) &&
    await verifyPassword(password, row.password_hash);
  await db.query(`INSERT INTO rd_lab.login_attempts(email_hash,ip_hash,succeeded) VALUES($1,$2,$3)`, [emailHash, ipHash, Boolean(valid)]);
  if (!valid) return null;
  await db.query(`UPDATE rd_lab.password_credentials SET failed_attempts=0,locked_until=NULL,updated_at=now() WHERE user_id=$1`, [row.id]);
  return { id: row.id, email: row.email, role: row.role, accessTier: row.access_tier };
}
