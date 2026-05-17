import crypto from "crypto";
import path from "path";
import { Request, Response, NextFunction } from "express";
import { pool } from "../storage/postgres.client";

export const FOUNDER_EMAIL =
  "emmamendez07@gmail.com";

export const SESSION_COOKIE_NAME =
  "klps_data_room_session";

const SESSION_TTL_MS =
  Number(process.env.DATA_ROOM_SESSION_TTL_MS) ||
  1000 * 60 * 60 * 12;

const OTP_TTL_MS =
  Number(process.env.DATA_ROOM_OTP_TTL_MS) ||
  1000 * 60 * 10;

const SIGNED_URL_TTL_MS =
  Number(process.env.DATA_ROOM_SIGNED_URL_TTL_MS) ||
  1000 * 60 * 5;

const DATA_ROOM_SECRET =
  process.env.DATA_ROOM_SECRET ||
  process.env.SESSION_SECRET ||
  "development-data-room-secret-change-me";

export type DataRoomRole =
  | "founder_admin"
  | "authorised_user"
  | "pending_user"
  | "revoked_user";

export type DataRoomUser = {
  id: string;
  email: string;
  role: DataRoomRole;
};

export type DataRoomRequest =
  Request & {
    dataRoomUser?: DataRoomUser;
    dataRoomSessionId?: string;
  };

export const normalizeEmail = (email: unknown) => {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
};

export const isValidEmail = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export const isFounder = (email: string) =>
  normalizeEmail(email) === FOUNDER_EMAIL;

export const getIpAddress = (req: Request) => {
  const forwardedFor =
    req.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string") {
    return forwardedFor.split(",")[0].trim();
  }

  return req.ip || null;
};

export const getUserAgent = (req: Request) =>
  req.get("user-agent") || null;

export const hashSha256 = (value: string) =>
  crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");

const hmac = (value: string) =>
  crypto
    .createHmac("sha256", DATA_ROOM_SECRET)
    .update(value)
    .digest("hex");

const timingSafeEqualHex = (
  left: string,
  right: string
) => {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const parseCookies = (cookieHeader?: string) => {
  const cookies: Record<string, string> = {};

  if (!cookieHeader) return cookies;

  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name) continue;
    cookies[name] = decodeURIComponent(valueParts.join("="));
  }

  return cookies;
};

export const setSessionCookie = (
  res: Response,
  token: string,
  expiresAt: Date
) => {
  const secure =
    process.env.NODE_ENV === "production";

  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`
  ];

  if (secure) cookieParts.push("Secure");

  res.setHeader("Set-Cookie", cookieParts.join("; "));
};

export const clearSessionCookie = (res: Response) => {
  const secure =
    process.env.NODE_ENV === "production";

  const cookieParts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ];

  if (secure) cookieParts.push("Secure");

  res.setHeader("Set-Cookie", cookieParts.join("; "));
};

export const ensureUserForEmail = async (
  email: string
) => {
  const role: DataRoomRole =
    isFounder(email)
      ? "founder_admin"
      : "pending_user";

  const result = await pool.query(
    `
    INSERT INTO data_room.users (
      email,
      role,
      authorised_at
    )
    VALUES (
      $1,
      $2,
      CASE WHEN $2 = 'founder_admin' THEN now() ELSE NULL END
    )
    ON CONFLICT (email)
    DO UPDATE SET
      role = CASE
        WHEN data_room.users.email = $1
          AND $1 = $3
        THEN 'founder_admin'
        ELSE data_room.users.role
      END,
      authorised_at = CASE
        WHEN $1 = $3
        THEN COALESCE(data_room.users.authorised_at, now())
        ELSE data_room.users.authorised_at
      END,
      revoked_at = CASE
        WHEN $1 = $3 THEN NULL
        ELSE data_room.users.revoked_at
      END,
      updated_at = now()
    RETURNING id, email, role
    `,
    [
      email,
      role,
      FOUNDER_EMAIL
    ]
  );

  return result.rows[0] as DataRoomUser;
};

export const logAccessEvent = async ({
  req,
  user,
  email,
  eventType,
  documentId,
  metadata = {}
}: {
  req: Request;
  user?: DataRoomUser | null;
  email?: string | null;
  eventType: string;
  documentId?: string | null;
  metadata?: Record<string, unknown>;
}) => {
  await pool.query(
    `
    INSERT INTO data_room.access_events (
      user_id,
      email,
      event_type,
      document_id,
      ip_address,
      user_agent,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      user?.id ?? null,
      email ?? user?.email ?? null,
      eventType,
      documentId ?? null,
      getIpAddress(req),
      getUserAgent(req),
      JSON.stringify(metadata)
    ]
  );
};

export const createLoginOtp = async (
  user: DataRoomUser
) => {
  const code =
    String(crypto.randomInt(100000, 999999));

  const expiresAt =
    new Date(Date.now() + OTP_TTL_MS);

  await pool.query(
    `
    INSERT INTO data_room.login_otps (
      user_id,
      email,
      otp_hash,
      expires_at
    )
    VALUES ($1, $2, $3, $4)
    `,
    [
      user.id,
      user.email,
      hmac(code),
      expiresAt
    ]
  );

  return {
    code,
    expiresAt
  };
};

export const verifyLoginOtp = async (
  email: string,
  code: string
) => {
  const result = await pool.query(
    `
    SELECT
      o.id,
      o.otp_hash,
      u.id AS user_id,
      u.email,
      u.role
    FROM data_room.login_otps o
    JOIN data_room.users u
      ON u.id = o.user_id
    WHERE
      o.email = $1
      AND o.consumed_at IS NULL
      AND o.expires_at > now()
    ORDER BY o.created_at DESC
    LIMIT 1
    `,
    [email]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  const valid =
    timingSafeEqualHex(row.otp_hash, hmac(code));

  if (!valid) return null;

  await pool.query(
    `
    UPDATE data_room.login_otps
    SET consumed_at = now()
    WHERE id = $1
    `,
    [row.id]
  );

  return {
    id: row.user_id,
    email: row.email,
    role: row.role
  } as DataRoomUser;
};

export const createSession = async (
  req: Request,
  user: DataRoomUser
) => {
  const token =
    crypto.randomBytes(32).toString("base64url");

  const expiresAt =
    new Date(Date.now() + SESSION_TTL_MS);

  const result = await pool.query(
    `
    INSERT INTO data_room.sessions (
      user_id,
      token_hash,
      expires_at,
      ip_address,
      user_agent
    )
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
    `,
    [
      user.id,
      hashSha256(token),
      expiresAt,
      getIpAddress(req),
      getUserAgent(req)
    ]
  );

  return {
    token,
    expiresAt,
    sessionId: result.rows[0].id as string
  };
};

export const getSessionUser = async (
  req: Request
) => {
  const cookies =
    parseCookies(req.headers.cookie);
  const token =
    cookies[SESSION_COOKIE_NAME];

  if (!token) return null;

  const result = await pool.query(
    `
    SELECT
      s.id AS session_id,
      u.id,
      u.email,
      u.role
    FROM data_room.sessions s
    JOIN data_room.users u
      ON u.id = s.user_id
    WHERE
      s.token_hash = $1
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
      AND u.role <> 'revoked_user'
    LIMIT 1
    `,
    [hashSha256(token)]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  return {
    sessionId: row.session_id as string,
    user: {
      id: row.id,
      email: row.email,
      role: row.role
    } as DataRoomUser
  };
};

export const requireDataRoomAuth = async (
  req: DataRoomRequest,
  res: Response,
  next: NextFunction
) => {
  const session =
    await getSessionUser(req);

  if (!session) {
    return res.status(401).json({
      status: "error",
      code: "unauthenticated",
      message: "Authentication required"
    });
  }

  req.dataRoomUser = session.user;
  req.dataRoomSessionId = session.sessionId;
  next();
};

export const requireAdmin = (
  req: DataRoomRequest,
  res: Response,
  next: NextFunction
) => {
  if (req.dataRoomUser?.role !== "founder_admin") {
    return res.status(403).json({
      status: "error",
      code: "admin_required",
      message: "Founder/admin access required"
    });
  }

  next();
};

export const requireAuthorised = (
  req: DataRoomRequest,
  res: Response,
  next: NextFunction
) => {
  const role = req.dataRoomUser?.role;

  if (
    role !== "founder_admin" &&
    role !== "authorised_user"
  ) {
    return res.status(403).json({
      status: "error",
      code: "not_authorised",
      message: "Data room access is not authorised"
    });
  }

  next();
};

export const getCurrentNda = async () => {
  const result = await pool.query(
    `
    SELECT
      id,
      version,
      company_name,
      company_number,
      registered_office_address,
      watermark_footer_text,
      agreement_text,
      agreement_text_hash
    FROM data_room.nda_versions
    WHERE active = true
    ORDER BY created_at DESC
    LIMIT 1
    `
  );

  return result.rows[0] ?? null;
};

export const hasAcceptedCurrentNda = async (
  userId: string
) => {
  const nda = await getCurrentNda();

  if (!nda) {
    return {
      nda,
      accepted: false
    };
  }

  const result = await pool.query(
    `
    SELECT accepted_at
    FROM data_room.nda_acceptances
    WHERE user_id = $1
      AND nda_version = $2
    LIMIT 1
    `,
    [
      userId,
      nda.version
    ]
  );

  return {
    nda,
    accepted: result.rows.length > 0,
    acceptedAt:
      result.rows[0]?.accepted_at ?? null
  };
};

export const canAccessDocument = (
  user: DataRoomUser,
  documentAccessLevel: string
) => {
  if (user.role === "founder_admin") return true;
  if (user.role !== "authorised_user") return false;

  return documentAccessLevel === "authorised_user";
};

export const createSignedDocumentUrl = ({
  req,
  user,
  documentId,
  action
}: {
  req: Request;
  user: DataRoomUser;
  documentId: string;
  action: "view" | "download";
}) => {
  const expires =
    Date.now() + SIGNED_URL_TTL_MS;

  const payload =
    `${documentId}.${action}.${expires}.${user.id}`;

  const token = hmac(payload);
  const baseUrl =
    process.env.DATA_ROOM_PUBLIC_API_URL ||
    `${req.protocol}://${req.get("host")}`;

  return {
    expiresAt: new Date(expires).toISOString(),
    signedUrl:
      `${baseUrl}/api/data-room/documents/${documentId}/file` +
      `?action=${action}&expires=${expires}&user_id=${user.id}&token=${token}`
  };
};

export const verifySignedDocumentToken = ({
  documentId,
  action,
  expires,
  userId,
  token
}: {
  documentId: string;
  action: string;
  expires: string;
  userId: string;
  token: string;
}) => {
  const expiresNumber = Number(expires);

  if (
    !expiresNumber ||
    Date.now() > expiresNumber ||
    !["view", "download"].includes(action)
  ) {
    return false;
  }

  const payload =
    `${documentId}.${action}.${expiresNumber}.${userId}`;

  return timingSafeEqualHex(token, hmac(payload));
};

export const resolvePrivateStoragePath = (
  storagePath: string
) => {
  const root =
    process.env.DATA_ROOM_STORAGE_ROOT;

  if (!root) return null;

  const resolvedRoot =
    path.resolve(root);
  const resolvedFile =
    path.resolve(resolvedRoot, storagePath);

  if (!resolvedFile.startsWith(resolvedRoot)) {
    return null;
  }

  return resolvedFile;
};
