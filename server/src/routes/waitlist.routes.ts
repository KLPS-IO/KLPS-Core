import { recordAttributedVisit, registerWaitlist } from '../growth/acquisition.service';
import { Router } from "express";
import {
  requireAdmin,
  requireDataRoomAuth
} from "../services/data-room.service";
import { pool } from "../storage/postgres.client";

const router = Router();

const isValidEmail = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const normalizeOptionalText = (value: unknown) => {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed || null;
};

// Browser attribution is accepted only from the first-party site, after opt-in.
router.post('/visits', async (req, res) => {
  res.setHeader('Cache-Control','no-store');
  const origin=req.get('origin');
  const allowed=['https://klps.co.uk','https://www.klps.co.uk'];
  if(['development','test'].includes(process.env.NODE_ENV ?? '')) allowed.push('http://127.0.0.1:5173','http://localhost:5173');
  if(!origin || !allowed.includes(origin)) return res.status(403).json({ok:false,error:'first_party_origin_required'});
  try {
    const visit=await recordAttributedVisit(req.body ?? {});
    return visit ? res.status(201).json({ok:true,...visit}) : res.status(400).json({ok:false,error:'attribution_unavailable'});
  } catch { return res.status(503).json({ok:false,error:'attribution_unavailable'}); }
});

router.post("/", async (req, res) => {
  const name =
    normalizeOptionalText(req.body?.name);
  const email =
    normalizeOptionalText(req.body?.email)?.toLowerCase() ?? null;
  const phone =
    normalizeOptionalText(req.body?.phone);
  const source =
    normalizeOptionalText(req.body?.source) ?? "waitlist";

  if (!name || name.length > 200) {
    return res.status(400).json({
      ok: false,
      error: "name_required"
    });
  }

  if (!email || email.length > 320 || (phone?.length ?? 0) > 80 || source.length > 120 || !isValidEmail(email)) {
    return res.status(400).json({
      ok: false,
      error: "valid_email_required"
    });
  }

  try {
    await registerWaitlist({name,email,phone,source,attribution_token:req.body?.attribution_token});
    // Same response for new and repeat identities; no personal data or membership disclosure.
    return res.status(201).json({ok:true});
  } catch (error) {
    console.error("waitlist signup failed");

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
