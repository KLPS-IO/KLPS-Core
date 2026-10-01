import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {pool} from '../storage/postgres.client';
export type SourceKind='rd_discovery'|'rd_quotation'|'rd_finding'|'rd_delivery'|'community_feedback';
export type Development={kind:SourceKind;id:string;state:string;date:string;version:number|null;verification?:string;disclosure:'unknown'|'permission_recorded'|'restricted';source_path:string;work_package?:string};
export type NarrativeProposal={title:string;evidence_summary:string;significance:string;narrative:string;business_purpose:string;audience:string;timing:string;platforms:string[];platform_roles:Record<string,string>;confidence:number;reasoning:string;next_action:string};
export const evidenceHash=(event:Development)=>createHash('sha256').update(JSON.stringify({kind:event.kind,id:event.id,state:event.state,date:['rd_finding','rd_delivery'].includes(event.kind)?null:event.date,verification:event.verification??null,disclosure:event.disclosure,work_package:event.work_package??null})).digest('hex');
// Facts are selected from explicit canonical states. No free text is interpreted as an achievement.
export function assessDevelopment(e:Development):NarrativeProposal|null {
 let title='',summary='',significance='',narrative='founder_build_journey',purpose='credibility_nurture';
 if(e.kind==='rd_discovery' && ['Discovery Completed','Completed','Complete','Held'].includes(e.state)){
  title='Supplier discovery completed';summary='An R&D supplier discovery interaction is recorded as completed. This is not a partnership, supplier appointment, completed product test or product validation.';
  significance='A documented discovery step may explain how KLPS evaluates product feasibility.';
 } else if(e.kind==='rd_quotation' && e.state==='quotation_recorded'){
  title='Supplier quotation recorded';summary='A dated supplier quotation is recorded. A proposal is not a supplier appointment, purchase or delivery.';
  significance='The build journey has reached a concrete proposal to evaluate; commercial terms remain private.';narrative='supplier_progress';
 } else if(e.kind==='rd_finding' && e.state==='Accepted' && e.verification==='Verified'){
  title='Technical finding accepted and marked verified';summary='An individual R&D finding is recorded as accepted and verified. This does not establish a validated product or clinical claim.';
  significance='A reviewed finding may support an explanation of the evidence-led development process.';narrative='rd_progress';purpose='education';
 } else if(e.kind==='rd_delivery' && ['In Delivery','Validated'].includes(e.state)){
  title=e.state==='In Delivery'?'R&D work package in delivery':'R&D work package marked validated';summary=`The canonical work package is marked ${e.state}. This describes the work package only, not a validated commercial product.`;
  significance='A recorded work-package milestone may help explain the next stage of the build journey.';narrative='rd_progress';
 } else if(e.kind==='community_feedback' && e.state==='quote_use_approved'){
  title='Customer feedback cleared for quote review';summary='A Growth community interaction has both quote-use permission and founder quote approval recorded. No customer identity or quotation is copied here.';
  significance='Permission-backed feedback may support an educational narrative about the needs KLPS is exploring; it is not market-wide validation.';narrative='customer_insight';purpose='education';
 } else return null;
 return {title,evidence_summary:summary,significance,narrative,business_purpose:purpose,audience:'prospective_waitlist_members',timing:'after_disclosure_review',platforms:['linkedin','instagram','tiktok'],platform_roles:{linkedin:'Founder progress and credibility.',instagram:'Visual build narrative only when suitable imagery exists.',tiktok:'First-person process story only when genuine footage is available.'},confidence:0.8,reasoning:'Deterministic match to an explicit recorded state, not independent verification of its truth or evidence of acquisition impact.',next_action:e.disclosure==='restricted'?'Keep internal; resolve restrictions in the canonical source.':'Review the canonical evidence and disclosure before accepting a narrative for planning.'};
}
export async function collectDevelopments(workspace:string,db:Pick<PoolClient,'query'>=pool):Promise<Development[]> {
 // Deliberately exclude finance, private budgets, commercial amounts, source text,
 // attendees, names, contact details, attachment URLs and evidence storage keys.
 const result=await db.query(`
 WITH owned AS (SELECT p.id,p.code,p.status,p.version,p.updated_at FROM rd_lab.work_packages p
 JOIN growth_os.workspaces w ON w.owner_user_id=p.owner_user_id WHERE w.id=$1 AND p.code='WP1')
 SELECT 'rd_discovery' kind,i.id,i.status state,i.occurred_at date,i.version,NULL::text verification,'unknown' disclosure,p.code work_package
 FROM rd_lab.interactions i JOIN owned p ON p.id=i.work_package_id
 WHERE i.status IN ('Discovery Completed','Completed','Complete','Held') AND i.occurred_at<=now()
 AND lower(i.interaction_type) IN ('supplier discovery meeting','discovery meeting','supplier discovery','meeting','discovery call')
 UNION ALL
 SELECT 'rd_quotation',q.id,'quotation_recorded',q.quote_date::timestamptz,q.version,NULL,
 CASE WHEN nullif(trim(q.confidentiality_terms),'') IS NOT NULL OR nullif(trim(q.publication_rights),'') IS NOT NULL THEN 'restricted' ELSE 'unknown' END,p.code
 FROM rd_lab.quotations q JOIN owned p ON p.id=q.work_package_id
 WHERE q.quote_date IS NOT NULL AND q.quote_date<=current_date AND lower(coalesce(q.decision_status,'')) NOT IN ('rejected','superseded')
 UNION ALL
 SELECT 'rd_finding',f.id,f.status,f.updated_at,f.version,f.verification_status,'unknown',p.code
 FROM rd_lab.technical_findings f JOIN owned p ON p.id=f.work_package_id WHERE f.status='Accepted' AND f.verification_status='Verified'
 UNION ALL
 SELECT 'rd_delivery',p.id,p.status,p.updated_at,p.version,NULL,'unknown',p.code FROM owned p WHERE p.status IN ('In Delivery','Validated')
 UNION ALL
 SELECT 'community_feedback',i.id,'quote_use_approved',i.occurred_at,NULL,NULL,'permission_recorded',NULL
 FROM growth_os.interactions i WHERE i.workspace_id=$1 AND i.archived_at IS NULL AND i.quote_use_permission=true AND i.approved_quote=true AND i.occurred_at<=now()
 ORDER BY date DESC`,[workspace]);
 return result.rows.map(r=>({...r,date:new Date(r.date).toISOString(),source_path:r.kind==='community_feedback'?'/innovation-lab/funnel/community':'/rd-lab/work-packages/wp1-textile-sensing'}));
}
