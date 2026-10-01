import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../storage/postgres.client';
type Db = Pick<PoolClient, 'query'>;
export const attributionTokenHash = (token: unknown): string | null => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? createHash('sha256').update(token).digest('hex') : null;
export const isKlpsDestination = (value: string) => {
 try { const u = new URL(value); return u.protocol === 'https:' && ['klps.co.uk','www.klps.co.uk'].includes(u.hostname) && !u.port && !u.username && !u.password && ['/', '/waitlist', '/waitlist/'].includes(u.pathname); } catch { return false; }
};
export async function recordAttributedVisit(input: Record<string, unknown>, db: Db = pool) {
 const hash = attributionTokenHash(input.token);
 if (input.consent !== true || !hash || typeof input.code !== 'string' || !/^[a-f0-9]{18}$/.test(input.code)) return null;
 const link = (await db.query(`SELECT * FROM growth_os.tracked_links WHERE public_code=$1 AND status='active'`, [input.code])).rows[0];
 if (!link || !isKlpsDestination(link.destination_url)) return null;
 const result = await db.query(`INSERT INTO growth_os.tracked_link_visits(workspace_id,tracked_link_id,token_hash,platform,campaign_id,content_item_id,consent_version)
 VALUES($1,$2,$3,$4,$5,$6,'first-party-v1') ON CONFLICT(token_hash) DO NOTHING RETURNING expires_at`,
 [link.workspace_id,link.id,hash,link.source || null,link.campaign_id,link.content_item_id]);
 if (result.rows[0]) return result.rows[0];
 // Idempotent retries cannot rebind a token to a later link or extend its life.
 return (await db.query(`SELECT expires_at FROM growth_os.tracked_link_visits WHERE token_hash=$1 AND tracked_link_id=$2 AND expires_at>now()`,[hash,link.id])).rows[0] ?? null;
}
export async function registerWaitlist(input: {name:string;email:string;phone:string|null;source:string;attribution_token?:unknown}, db: Db = pool) {
 // A single atomic statement protects first acquisition during concurrent repeats.
 // Invalid/expired attribution never blocks signup and never invents lineage.
 await db.query(`INSERT INTO public.waitlist_signups(name,email,phone,source,acquisition_visit_id)
 VALUES($1,lower(trim($2)),$3,$4,(SELECT id FROM growth_os.tracked_link_visits WHERE token_hash=$5 AND expires_at>now()))
 ON CONFLICT(LOWER(email)) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,updated_at=now()`,
 [input.name,input.email,input.phone,input.source,attributionTokenHash(input.attribution_token)]);
}
export async function acquisitionReport(workspace: string, db: Db = pool) {
 const rows = (await db.query(`WITH visits AS (
 SELECT v.*, (SELECT count(*)::int FROM public.waitlist_signups s WHERE s.acquisition_visit_id=v.id) signups
 FROM growth_os.tracked_link_visits v WHERE v.workspace_id=$1
 ) SELECT v.platform,v.campaign_id,v.content_item_id,v.tracked_link_id,
 c.name campaign_name,i.title content_title,l.label link_label,
 count(*)::int visits,sum(v.signups)::int unique_signups,
 count(*) FILTER(WHERE v.signups>0)::int converted_visits
 FROM visits v LEFT JOIN growth_os.campaigns c ON c.id=v.campaign_id AND c.workspace_id=$1
 LEFT JOIN growth_os.content_items i ON i.id=v.content_item_id AND i.workspace_id=$1
 LEFT JOIN growth_os.tracked_links l ON l.id=v.tracked_link_id AND l.workspace_id=$1
 GROUP BY v.platform,v.campaign_id,v.content_item_id,v.tracked_link_id,c.name,i.title,l.label
 ORDER BY unique_signups DESC,visits DESC`,[workspace])).rows;
 // Waitlist is company-wide, as in the existing community view, not assigned to an invented workspace.
 const unknown = (await db.query(`SELECT count(*)::int count FROM public.waitlist_signups WHERE acquisition_visit_id IS NULL`)).rows[0].count;
 return {rows,unattributed_company_signups:unknown,model:'consented_first_touch',window_hours:24,
  qualification:'Separate community assessment; signup does not imply qualification.',
  limitation:'Consented session visits only. Conversion is visits with a new signup / visits. Link lineage is not proof of social referrer or multi-touch causality. Historical/direct/no-consent signups remain unattributed.'};
}
