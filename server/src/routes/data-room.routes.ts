import express from "express";
import fs from "fs";
import {
  canAccessDocument,
  clearSessionCookie,
  createLoginOtp,
  createSession,
  createSignedDocumentUrl,
  DataRoomRequest,
  DataRoomAccessLevel,
  ensureUserForEmail,
  getCurrentNda,
  getIpAddress,
  getSessionUser,
  getUserAgent,
  hasAcceptedCurrentNda,
  isValidEmail,
  logAccessEvent,
  normalizeEmail,
  requireAdmin,
  requireAuthorised,
  requireDataRoomAuth,
  resolvePrivateStoragePath,
  setSessionCookie,
  verifyLoginOtp,
  verifySignedDocumentToken
} from "../services/data-room.service";
import { pool } from "../storage/postgres.client";
import {
  sendDataRoomOtpEmail
} from "../services/email.service";
import {
  createR2PresignedUrl,
  isR2Configured
} from "../services/r2.service";
import {
  cleanupExpiredDataRoomAuth
} from "../services/data-room-maintenance.service";

const router = express.Router();

const jsonOk = (
  data: Record<string, unknown> = {}
) => ({
  status: "success",
  ...data
});

const asyncHandler =
  (
    handler: (
      req: DataRoomRequest,
      res: express.Response
    ) => Promise<unknown>
  ) =>
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) =>
      Promise.resolve(
        handler(req as DataRoomRequest, res)
      ).catch(next);

const parsePositiveLimit = (value: unknown) => {
  const limit = Number(value ?? 100);
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(Math.floor(limit), 1), 500);
};

const isDocumentAccessLevel = (value: unknown) =>
  value === "public_light" ||
  value === "investor_nda" ||
  value === "advisor_nda" ||
  value === "founder_only" ||
  value === "legal_only" ||
  value === "admin_only";

const normalizeAccessLevel = (
  value: unknown,
  fallback: DataRoomAccessLevel
) =>
  isDocumentAccessLevel(value)
    ? value as DataRoomAccessLevel
    : fallback;

const toStorageKey = (filename: string) => {
  const safeFilename =
    filename
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");

  return `data-room/${Date.now()}-${safeFilename || "document"}`;
};

const requireNdaMiddleware = async (
  req: DataRoomRequest,
  res: express.Response,
  next: express.NextFunction
) => {
  const result =
    await hasAcceptedCurrentNda(
      req.dataRoomUser!.id
    );

  if (!result.accepted) {
    return res.status(403).json({
      status: "error",
      code: "nda_required",
      message: "Current NDA must be accepted",
      nda_version: result.nda?.version ?? null
    });
  }

  next();
};

const sendSessionResponse = async (
  req: DataRoomRequest,
  res: express.Response
) => {
  const session =
    await getSessionUser(req);

  if (!session) {
    return res.json(
      jsonOk({
        authenticated: false,
        user: null
      })
    );
  }

  const nda =
    await hasAcceptedCurrentNda(
      session.user.id
    );

  return res.json(
    jsonOk({
      authenticated: true,
      user: {
        id: session.user.id,
        email: session.user.email,
        role: session.user.role,
        access_tier: session.user.accessTier,
        is_admin:
          session.user.role === "founder_admin"
      },
      nda: {
        current_version:
          nda.nda?.version ?? null,
        accepted: nda.accepted,
        accepted_at: nda.acceptedAt ?? null
      }
    })
  );
};

router.post(
  "/auth/request-login",
  asyncHandler(async (req, res) => {
    const email =
      normalizeEmail(req.body?.email);

    if (!isValidEmail(email)) {
      return res.status(400).json({
        status: "error",
        code: "invalid_email",
        message: "A valid email is required"
      });
    }

    const recentFailures =
      await pool.query(
        `
        SELECT count(*)::int AS failures
        FROM data_room.login_attempts
        WHERE
          email = $1
          AND success = false
          AND attempted_at > now() - interval '15 minutes'
        `,
        [email]
      );

    if (Number(recentFailures.rows[0].failures) >= 5) {
      return res.status(429).json({
        status: "error",
        code: "rate_limited",
        message: "Too many login attempts. Try again later."
      });
    }

    const user =
      await ensureUserForEmail(email);

    if (user.role !== "revoked_user") {
      const otp =
        await createLoginOtp(user);

      await sendDataRoomOtpEmail({
        email,
        otpCode: otp.code
      });
    }

    res.json(
      jsonOk({
        message:
          "If this email can access the data room, a one-time login code has been sent.",
        expires_in_minutes: 10
      })
    );
  })
);

router.post(
  "/auth/verify-login",
  asyncHandler(async (req, res) => {
    const email =
      normalizeEmail(req.body?.email);
    const code =
      typeof req.body?.code === "string"
        ? req.body.code.trim()
        : "";

    if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        status: "error",
        code: "invalid_login_payload",
        message: "Email and six-digit code are required"
      });
    }

    const user =
      await verifyLoginOtp(email, code);

    if (
      !user ||
      user.role === "pending_user" ||
      user.role === "revoked_user"
    ) {
      await pool.query(
        `
        INSERT INTO data_room.login_attempts (
          email,
          ip_address,
          success
        )
        VALUES ($1, $2, false)
        `,
        [
          email,
          getIpAddress(req)
        ]
      );

      await logAccessEvent({
        req,
        email,
        eventType: "login_failed",
        metadata: {
          reason: user ? user.role : "invalid_otp"
        }
      });

      return res.status(401).json({
        status: "error",
        code: "login_failed",
        message:
          "Login failed or this email is not authorised"
      });
    }

    await pool.query(
      `
      INSERT INTO data_room.login_attempts (
        email,
        ip_address,
        success
      )
      VALUES ($1, $2, true)
      `,
      [
        email,
        getIpAddress(req)
      ]
    );

    const session =
      await createSession(req, user);

    setSessionCookie(
      res,
      session.token,
      session.expiresAt
    );

    const nda =
      await hasAcceptedCurrentNda(user.id);

    await logAccessEvent({
      req,
      user,
      eventType: "login_success"
    });

    res.json(
      jsonOk({
        authenticated: true,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          access_tier: user.accessTier,
          is_admin: user.role === "founder_admin"
        },
        nda: {
          current_version:
            nda.nda?.version ?? null,
          accepted: nda.accepted,
          accepted_at: nda.acceptedAt ?? null
        },
        session: {
          expires_at:
            session.expiresAt.toISOString()
        }
      })
    );
  })
);

router.get(
  "/session",
  asyncHandler(sendSessionResponse)
);

router.get(
  "/me",
  asyncHandler(sendSessionResponse)
);

router.get(
  "/auth/me",
  asyncHandler(sendSessionResponse)
);

router.post(
  "/logout",
  requireDataRoomAuth,
  asyncHandler(async (req, res) => {
    await pool.query(
      `
      UPDATE data_room.sessions
      SET revoked_at = now()
      WHERE id = $1
      `,
      [req.dataRoomSessionId]
    );

    clearSessionCookie(res);

    await logAccessEvent({
      req,
      user: req.dataRoomUser,
      eventType: "logout"
    });

    res.json(jsonOk());
  })
);

router.get(
  "/nda/status",
  requireDataRoomAuth,
  requireAuthorised,
  asyncHandler(async (req, res) => {
    const nda =
      await hasAcceptedCurrentNda(
        req.dataRoomUser!.id
      );

    res.json(
      jsonOk({
        current_version:
          nda.nda?.version ?? null,
        accepted: nda.accepted,
        accepted_at: nda.acceptedAt ?? null,
        required: !nda.accepted
      })
    );
  })
);

router.get(
  "/nda/current",
  requireDataRoomAuth,
  requireAuthorised,
  asyncHandler(async (req, res) => {
    const nda = await getCurrentNda();

    if (!nda) {
      return res.status(404).json({
        status: "error",
        code: "nda_not_configured",
        message: "No active NDA is configured"
      });
    }

    await logAccessEvent({
      req,
      user: req.dataRoomUser,
      eventType: "nda_viewed",
      metadata: {
        nda_version: nda.version
      }
    });

    res.json(
      jsonOk({
        nda: {
          version: nda.version,
          company_name: nda.company_name,
          company_number: nda.company_number,
          registered_office_address:
            nda.registered_office_address,
          watermark_footer_text:
            nda.watermark_footer_text,
          agreement_text:
            nda.agreement_text,
          agreement_text_hash:
            nda.agreement_text_hash,
          scroll_completion_required: true,
          acceptance_method: "clickwrap",
          accepted_button_label: "I agree"
        }
      })
    );
  })
);

router.post(
  "/nda/accept",
  requireDataRoomAuth,
  requireAuthorised,
  asyncHandler(async (req, res) => {
    if (req.body?.accepted_button_label !== "I agree") {
      return res.status(400).json({
        status: "error",
        code: "invalid_acceptance",
        message:
          "The NDA must be accepted with the I agree button"
      });
    }

    if (req.body?.scroll_completed !== true) {
      return res.status(400).json({
        status: "error",
        code: "scroll_required",
        message:
          "Scroll completion is required before acceptance"
      });
    }

    const nda = await getCurrentNda();

    if (!nda) {
      return res.status(404).json({
        status: "error",
        code: "nda_not_configured",
        message: "No active NDA is configured"
      });
    }

    await pool.query(
      `
      INSERT INTO data_room.nda_acceptances (
        user_id,
        email,
        nda_version,
        ip_address,
        user_agent,
        agreement_text_hash,
        scroll_completion_required,
        acceptance_method,
        accepted_button_label
      )
      VALUES ($1, $2, $3, $4, $5, $6, true, 'clickwrap', 'I agree')
      ON CONFLICT (user_id, nda_version)
      DO NOTHING
      `,
      [
        req.dataRoomUser!.id,
        req.dataRoomUser!.email,
        nda.version,
        getIpAddress(req),
        getUserAgent(req),
        nda.agreement_text_hash
      ]
    );

    await logAccessEvent({
      req,
      user: req.dataRoomUser,
      eventType: "nda_accepted",
      metadata: {
        nda_version: nda.version,
        agreement_text_hash:
          nda.agreement_text_hash,
        accepted_button_label: "I agree",
        acceptance_method: "clickwrap",
        scroll_completion_required: true
      }
    });

    res.json(
      jsonOk({
        accepted: true,
        nda_version: nda.version
      })
    );
  })
);

router.get(
  "/categories",
  requireDataRoomAuth,
  requireAuthorised,
  requireNdaMiddleware,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `
      SELECT
        id,
        label,
        description,
        sort_order,
        minimum_access_level,
        active
      FROM data_room.document_categories
      WHERE active = true
      ORDER BY sort_order, label
      `
    );

    const categories = result.rows.filter(row =>
      canAccessDocument(
        req.dataRoomUser!,
        row.minimum_access_level
      )
    );

    res.json(
      jsonOk({
        categories
      })
    );
  })
);

router.get(
  "/documents",
  requireDataRoomAuth,
  requireAuthorised,
  requireNdaMiddleware,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `
      SELECT
        id,
        filename,
        category,
        description,
        file_size,
        version,
        uploaded_at,
        updated_at,
        access_level,
        storage_provider,
        content_type,
        sort_order,
        watermark_required,
        active
      FROM data_room.documents
      WHERE active = true
      ORDER BY category, sort_order, filename
      `
    );

    const documents = result.rows.filter(row =>
      canAccessDocument(
        req.dataRoomUser!,
        row.access_level
      )
    );

    res.json(
      jsonOk({
        documents,
        access_levels: [
          "public_light",
          "investor_nda",
          "advisor_nda",
          "founder_only",
          "legal_only",
          "admin_only"
        ],
        watermark_text:
          "Confidential Property of KLPS Ltd"
      })
    );
  })
);

router.post(
  "/documents/:id/url",
  requireDataRoomAuth,
  requireAuthorised,
  requireNdaMiddleware,
  asyncHandler(async (req, res) => {
    const action =
      req.body?.action === "download"
        ? "download"
        : "view";

    const result = await pool.query(
      `
      SELECT id, access_level, active
      FROM data_room.documents
      WHERE id = $1
      LIMIT 1
      `,
      [req.params.id]
    );

    const document = result.rows[0];

    if (
      !document ||
      !document.active ||
      !canAccessDocument(
        req.dataRoomUser!,
        document.access_level
      )
    ) {
      return res.status(404).json({
        status: "error",
        code: "document_not_found",
        message: "Document not found"
      });
    }

    const signed =
      createSignedDocumentUrl({
        req,
        user: req.dataRoomUser!,
        documentId: document.id,
        action
      });

    res.json(
      jsonOk({
        action,
        signed_url: signed.signedUrl,
        expires_at: signed.expiresAt
      })
    );
  })
);

router.get(
  "/documents/:id/file",
  asyncHandler(async (req, res) => {
    const documentId =
      String(req.params.id);
    const action =
      String(req.query.action ?? "");
    const expires =
      String(req.query.expires ?? "");
    const userId =
      String(req.query.user_id ?? "");
    const token =
      String(req.query.token ?? "");

    if (
      !verifySignedDocumentToken({
        documentId,
        action,
        expires,
        userId,
        token
      })
    ) {
      return res.status(401).json({
        status: "error",
        code: "invalid_signed_url",
        message: "Signed URL is invalid or expired"
      });
    }

    const result = await pool.query(
      `
      SELECT
        d.id,
        d.filename,
        d.storage_path,
        d.storage_provider,
        d.access_level,
        d.active,
        u.email,
        u.role,
        u.access_tier
      FROM data_room.documents d
      CROSS JOIN data_room.users u
      WHERE d.id = $1
        AND u.id = $2
      LIMIT 1
      `,
      [documentId, userId]
    );

    const row = result.rows[0];

    if (
      !row ||
      !row.active ||
      row.role === "revoked_user" ||
      !canAccessDocument(
        {
          id: userId,
          email: row.email,
          role: row.role,
          accessTier: row.access_tier
        },
        row.access_level
      )
    ) {
      return res.status(404).json({
        status: "error",
        code: "document_not_found",
        message: "Document not found"
      });
    }

    await logAccessEvent({
      req,
      user: {
        id: userId,
        email: row.email,
        role: row.role,
        accessTier: row.access_tier
      },
      eventType:
        action === "download"
          ? "document_downloaded"
          : "document_viewed",
      documentId: row.id,
      metadata: {
        action
      }
    });

    if (row.storage_provider === "r2") {
      const r2Url =
        createR2PresignedUrl({
          method: "GET",
          objectKey: row.storage_path,
          expiresSeconds: 60,
          responseFilename:
            action === "download"
              ? row.filename
              : undefined
        });

      return res.redirect(302, r2Url);
    }

    const filePath =
      resolvePrivateStoragePath(row.storage_path);

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({
        status: "error",
        code: "file_not_available",
        message:
          "Document metadata exists but the private file is not available on this server"
      });
    }

    if (action === "download") {
      return res.download(filePath, row.filename);
    }

    res.sendFile(filePath);
  })
);

router.get(
  "/admin/users",
  requireDataRoomAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const result = await pool.query(
      `
      SELECT
        id,
        email,
        role,
        authorised_at,
        revoked_at,
        access_tier,
        created_at,
        updated_at
      FROM data_room.users
      ORDER BY created_at DESC
      `
    );

    res.json(
      jsonOk({
        users: result.rows
      })
    );
  })
);

router.post(
  "/admin/users/authorise",
  requireDataRoomAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const email =
      normalizeEmail(req.body?.email);
    const accessTier =
      normalizeAccessLevel(
        req.body?.access_tier,
        "investor_nda"
      );

    if (!isValidEmail(email)) {
      return res.status(400).json({
        status: "error",
        code: "invalid_email",
        message: "A valid email is required"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO data_room.users (
        email,
        role,
        access_tier,
        authorised_at,
        authorised_by
      )
      VALUES ($1, 'authorised_user', $3, now(), $2)
      ON CONFLICT (email)
      DO UPDATE SET
        role = CASE
          WHEN data_room.users.role = 'founder_admin'
          THEN 'founder_admin'
          ELSE 'authorised_user'
        END,
        access_tier = CASE
          WHEN data_room.users.role = 'founder_admin'
          THEN 'admin_only'
          ELSE $3
        END,
        authorised_at = now(),
        authorised_by = $2,
        revoked_at = NULL,
        revoked_by = NULL,
        updated_at = now()
      RETURNING id, email, role, access_tier, authorised_at
      `,
      [
        email,
        req.dataRoomUser!.id,
        accessTier
      ]
    );

    await logAccessEvent({
      req,
      user: req.dataRoomUser,
      email,
      eventType: "user_authorised",
      metadata: {
        authorised_email: email
        ,
        access_tier: accessTier
      }
    });

    res.json(
      jsonOk({
        user: result.rows[0]
      })
    );
  })
);

router.post(
  "/admin/users/revoke",
  requireDataRoomAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const email =
      normalizeEmail(req.body?.email);

    if (!isValidEmail(email)) {
      return res.status(400).json({
        status: "error",
        code: "invalid_email",
        message: "A valid email is required"
      });
    }

    if (email === req.dataRoomUser!.email) {
      return res.status(400).json({
        status: "error",
        code: "cannot_revoke_self",
        message:
          "Founder/admin cannot revoke their own active account"
      });
    }

    const result = await pool.query(
      `
      UPDATE data_room.users
      SET
        role = 'revoked_user',
        revoked_at = now(),
        revoked_by = $2,
        updated_at = now()
      WHERE email = $1
      RETURNING id, email, role, revoked_at
      `,
      [
        email,
        req.dataRoomUser!.id
      ]
    );

    await pool.query(
      `
      UPDATE data_room.sessions
      SET revoked_at = now()
      WHERE user_id IN (
        SELECT id
        FROM data_room.users
        WHERE email = $1
      )
      `,
      [email]
    );

    await logAccessEvent({
      req,
      user: req.dataRoomUser,
      email,
      eventType: "user_revoked",
      metadata: {
        revoked_email: email
      }
    });

    res.json(
      jsonOk({
        user: result.rows[0] ?? null
      })
    );
  })
);

router.get(
  "/admin/access-logs",
  requireDataRoomAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const limit =
      parsePositiveLimit(req.query.limit);

    const result = await pool.query(
      `
      SELECT *
      FROM data_room.access_events
      ORDER BY timestamp DESC
      LIMIT $1
      `,
      [limit]
    );

    res.json(
      jsonOk({
        logs: result.rows
      })
    );
  })
);

router.get(
  "/admin/nda-acceptances",
  requireDataRoomAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const limit =
      parsePositiveLimit(req.query.limit);

    const result = await pool.query(
      `
      SELECT *
      FROM data_room.nda_acceptances
      ORDER BY accepted_at DESC
      LIMIT $1
      `,
      [limit]
    );

    res.json(
      jsonOk({
        acceptances: result.rows
      })
    );
  })
);

router.get(
  "/admin/document-activity",
  requireDataRoomAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const limit =
      parsePositiveLimit(req.query.limit);

    const result = await pool.query(
      `
      SELECT *
      FROM data_room.access_events
      WHERE event_type IN (
        'document_viewed',
        'document_downloaded'
      )
      ORDER BY timestamp DESC
      LIMIT $1
      `,
      [limit]
    );

    res.json(
      jsonOk({
        activity: result.rows
      })
    );
  })
);

router.post(
  "/admin/maintenance/cleanup-auth",
  requireDataRoomAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const cleanup =
      await cleanupExpiredDataRoomAuth();

    res.json(
      jsonOk({
        cleanup
      })
    );
  })
);

router.post(
  "/admin/documents/upload-url",
  requireDataRoomAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const filename =
      typeof req.body?.filename === "string"
        ? req.body.filename
        : "";
    const contentType =
      typeof req.body?.content_type === "string"
        ? req.body.content_type
        : "application/octet-stream";

    if (!filename.trim()) {
      return res.status(400).json({
        status: "error",
        code: "filename_required",
        message: "filename is required"
      });
    }

    if (!isR2Configured()) {
      return res.status(500).json({
        status: "error",
        code: "r2_not_configured",
        message:
          "Cloudflare R2 environment variables are not configured"
      });
    }

    const storagePath =
      toStorageKey(filename);
    const uploadUrl =
      createR2PresignedUrl({
        method: "PUT",
        objectKey: storagePath,
        expiresSeconds: 300
      });

    res.json(
      jsonOk({
        storage_provider: "r2",
        storage_path: storagePath,
        upload_url: uploadUrl,
        method: "PUT",
        expires_at:
          new Date(Date.now() + 300000).toISOString(),
        headers: {
          "content-type": contentType
        }
      })
    );
  })
);

router.post(
  "/admin/documents",
  requireDataRoomAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const {
      filename,
      category,
      description,
      file_size,
      version,
      storage_path,
      storage_provider,
      content_type,
      sort_order,
      access_level,
      watermark_required
    } = req.body ?? {};
    const safeAccessLevel =
      normalizeAccessLevel(
        access_level,
        "investor_nda"
      );
    const safeStorageProvider =
      storage_provider === "r2"
        ? "r2"
        : "local";

    if (
      typeof filename !== "string" ||
      typeof category !== "string" ||
      typeof version !== "string" ||
      typeof storage_path !== "string" ||
      (
        access_level !== undefined &&
        !isDocumentAccessLevel(access_level)
      ) ||
      (
        storage_provider !== undefined &&
        storage_provider !== "r2" &&
        storage_provider !== "local"
      )
    ) {
      return res.status(400).json({
        status: "error",
        code: "invalid_document_payload",
        message:
          "filename, category, version, storage_path, and a valid access_level are required"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO data_room.documents (
        filename,
        category,
        description,
        file_size,
        version,
        storage_path,
        storage_provider,
        content_type,
        sort_order,
        access_level,
        watermark_required
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
      `,
      [
        filename.trim(),
        category.trim(),
        typeof description === "string"
          ? description.trim()
          : null,
        Number(file_size ?? 0),
        version.trim(),
        storage_path.trim(),
        safeStorageProvider,
        typeof content_type === "string"
          ? content_type
          : null,
        Number(sort_order ?? 0),
        safeAccessLevel,
        watermark_required !== false
      ]
    );

    res.status(201).json(
      jsonOk({
        document: result.rows[0]
      })
    );
  })
);

router.patch(
  "/admin/documents/:id",
  requireDataRoomAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const allowed = [
      "filename",
      "category",
      "description",
      "file_size",
      "version",
      "storage_path",
      "storage_provider",
      "content_type",
      "sort_order",
      "access_level",
      "watermark_required",
      "active"
    ];

    const updates = allowed.filter(key =>
      Object.prototype.hasOwnProperty.call(
        req.body ?? {},
        key
      )
    );

    if (
      Object.prototype.hasOwnProperty.call(
        req.body ?? {},
        "access_level"
      ) &&
      !isDocumentAccessLevel(req.body.access_level)
    ) {
      return res.status(400).json({
        status: "error",
        code: "invalid_access_level",
        message:
          "access_level must be a valid data room access level"
      });
    }

    if (
      Object.prototype.hasOwnProperty.call(
        req.body ?? {},
        "storage_provider"
      ) &&
      req.body.storage_provider !== "r2" &&
      req.body.storage_provider !== "local"
    ) {
      return res.status(400).json({
        status: "error",
        code: "invalid_storage_provider",
        message:
          "storage_provider must be local or r2"
      });
    }

    if (updates.length === 0) {
      return res.status(400).json({
        status: "error",
        code: "empty_patch",
        message:
          "At least one document metadata field is required"
      });
    }

    const assignments = updates.map(
      (key, index) =>
        `${key} = $${index + 2}`
    );

    const values = updates.map(
      key => req.body[key]
    );

    const result = await pool.query(
      `
      UPDATE data_room.documents
      SET
        ${assignments.join(", ")},
        updated_at = now()
      WHERE id = $1
      RETURNING *
      `,
      [
        req.params.id,
        ...values
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        code: "document_not_found",
        message: "Document not found"
      });
    }

    res.json(
      jsonOk({
        document: result.rows[0]
      })
    );
  })
);

router.delete(
  "/admin/documents/:id",
  requireDataRoomAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `
      UPDATE data_room.documents
      SET
        active = false,
        updated_at = now()
      WHERE id = $1
      RETURNING *
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        code: "document_not_found",
        message: "Document not found"
      });
    }

    res.json(
      jsonOk({
        document: result.rows[0]
      })
    );
  })
);

router.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("data-room error:", error);

    res.status(500).json({
      status: "error",
      code: "data_room_error",
      message: "Data room request failed"
    });
  }
);

export default router;
