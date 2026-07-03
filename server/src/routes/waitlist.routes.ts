import { Router } from "express";
import {
  requireAdmin,
  requireDataRoomAuth
} from "../services/data-room.service";
import { pool } from "../storage/postgres.client";

const router = Router();

const isValidEmail = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

let schemaReady: Promise<void> | null = null;

const ensureWaitlistSchema = () => {
  if (!schemaReady) {
    schemaReady = pool
      .query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;

        CREATE TABLE IF NOT EXISTS public.waitlist_signups (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          phone TEXT,
          source TEXT DEFAULT 'waitlist',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE UNIQUE INDEX IF NOT EXISTS waitlist_signups_email_unique
        ON public.waitlist_signups (LOWER(email));
      `)
      .then(() => undefined)
      .catch(error => {
        schemaReady = null;
        throw error;
      });
  }

  return schemaReady;
};

const normalizeOptionalText = (value: unknown) => {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed || null;
};

router.post("/", async (req, res) => {
  const name =
    normalizeOptionalText(req.body?.name);
  const email =
    normalizeOptionalText(req.body?.email)?.toLowerCase() ?? null;
  const phone =
    normalizeOptionalText(req.body?.phone);
  const source =
    normalizeOptionalText(req.body?.source) ?? "waitlist";

  if (!name) {
    return res.status(400).json({
      ok: false,
      error: "name_required"
    });
  }

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({
      ok: false,
      error: "valid_email_required"
    });
  }

  try {
    await ensureWaitlistSchema();

    const result = await pool.query(
      `
      INSERT INTO public.waitlist_signups (
        name,
        email,
        phone,
        source
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (LOWER(email))
      DO UPDATE SET
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        source = EXCLUDED.source,
        updated_at = NOW()
      RETURNING
        id,
        name,
        email,
        phone,
        source,
        created_at
      `,
      [
        name,
        email,
        phone,
        source
      ]
    );

    return res.status(201).json({
      ok: true,
      signup: result.rows[0]
    });
  } catch (error) {
    console.error("waitlist signup error:", error);

    return res.status(500).json({
      ok: false,
      error: "waitlist_signup_failed"
    });
  }
});

router.get(
  "/",
  requireDataRoomAuth,
  requireAdmin,
  async (_req, res) => {
    try {
      await ensureWaitlistSchema();

      const result = await pool.query(`
        SELECT
          id,
          name,
          email,
          phone,
          source,
          created_at,
          updated_at
        FROM public.waitlist_signups
        ORDER BY created_at DESC
        LIMIT 100
      `);

      return res.json({
        ok: true,
        signups: result.rows
      });
    } catch (error) {
      console.error("waitlist list error:", error);

      return res.status(500).json({
        ok: false,
        error: "waitlist_query_failed"
      });
    }
  }
);

export default router;
