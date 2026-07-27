import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";
import { toFiniteMoney } from "../services/current-costs.service";

type Db = Pick<PoolClient, "query">;
type Kind = "text" | "date" | "timestamp" | "boolean" | "money" | "uuid" | "email" | "url";
type Config = { table: string; fields: Record<string, Kind>; required: string[]; enums?: Record<string, readonly string[]>; order?: string };
const wpStatuses = ['Draft','Research','Supplier Discovery','Discovery Meetings','RFQ Preparation','RFQ Issued','Quotes Received','Evaluation','Supplier Selected','In Delivery','Validated','Paused','Closed'] as const;
const supplierStatuses = ['Researching','Longlisted','Shortlisted','Contacted','Meeting Booked','Discovery Complete','RFQ Planned','RFQ Sent','Quote Received','Declined','Not Suitable','Selected','Reserve'] as const;
const rfqStatuses = ['Draft','Ready','Sent','Acknowledged','Clarification','Response Received','Declined','Closed'] as const;
const actionStatuses = ['To Do','In Progress','Waiting','Blocked','Complete','Cancelled'] as const;
const baseAudit = { change_reason: "text" as Kind };

export const RD_RESOURCES = {
  suppliers: { table: "suppliers", required: ["work_package_id","organisation_name","category","change_reason"], order: "created_at DESC", fields: { work_package_id:"uuid",organisation_name:"text",category:"text",organisation_type:"text",country:"text",website:"url",summary:"text",relevant_capability:"text",commercial_services_status:"text",paid_feasibility_status:"text",sme_support_status:"text",existing_relationship:"text",priority_tier:"text",procurement_status:"text",source_reference:"text",research_notes:"text",...baseAudit }, enums: { procurement_status:supplierStatuses, category:['Academic & Research Organisation','Commercial Smart Textile Developer','Conductive Textile & Fibre Supplier','Graphene Material Specialist','Printed Electronics Specialist','Textile Testing Laboratory','Prototype Integration Partner'] } },
  contacts: { table:"supplier_contacts",required:["supplier_id","full_name","email","change_reason"],fields:{supplier_id:"uuid",full_name:"text",role:"text",email:"email",phone:"text",linkedin_url:"url",preferred_contact_method:"text",notes:"text",...baseAudit} },
  interactions: { table:"interactions",required:["supplier_id","work_package_id","interaction_type","occurred_at","summary","change_reason"],fields:{supplier_id:"uuid",work_package_id:"uuid",interaction_type:"text",occurred_at:"timestamp",attendees:"text",summary:"text",technical_learning:"text",commercial_learning:"text",actions:"text",follow_up_date:"date",status:"text",...baseAudit} },
  rfqs: { table:"rfqs",required:["work_package_id","supplier_id","rfq_code","title","change_reason"],fields:{work_package_id:"uuid",supplier_id:"uuid",rfq_code:"text",title:"text",scope_summary:"text",sent_at:"timestamp",response_due_at:"timestamp",status:"text",requested_quote_type:"text",requested_letter_of_support:"boolean",requested_expression_of_interest:"boolean",vat_required:"boolean",min_likely_max_requested:"boolean",assumptions:"text",confidentiality_notes:"text",...baseAudit},enums:{status:rfqStatuses} },
  quotations: { table:"quotations",required:["supplier_id","work_package_id","quote_reference","change_reason"],fields:{supplier_id:"uuid",work_package_id:"uuid",rfq_id:"uuid",quote_reference:"text",quote_date:"date",valid_until:"date",currency:"text",vat_included:"boolean",net_amount:"money",vat_amount:"money",gross_amount:"money",minimum_amount:"money",likely_amount:"money",maximum_amount:"money",one_off_development_cost:"money",materials_cost:"money",testing_cost:"money",tooling_or_nre:"money",estimated_unit_cost:"money",moq:"money",lead_time_text:"text",payment_schedule:"text",scope:"text",deliverables:"text",assumptions:"text",exclusions:"text",dependencies:"text",testing_included:"boolean",wash_testing_included:"boolean",stretch_testing_included:"boolean",electrical_characterisation_included:"boolean",garment_integration_included:"boolean",documentation_included:"boolean",foreground_ip_terms:"text",background_ip_restrictions:"text",data_ownership:"text",sample_ownership:"text",publication_rights:"text",confidentiality_terms:"text",recommendation:"text",decision_status:"text",evidence_confidence:"text",...baseAudit} },
  findings: { table:"technical_findings",required:["work_package_id","title","finding","change_reason"],fields:{work_package_id:"uuid",supplier_id:"uuid",interaction_id:"uuid",title:"text",finding:"text",source_type:"text",impact_on_mvp:"text",decision_required:"boolean",status:"text",...baseAudit},enums:{status:['Observation','To Validate','Accepted','Rejected','Superseded']} },
  actions: { table:"action_items",required:["work_package_id","title","owner","priority","change_reason"],fields:{work_package_id:"uuid",supplier_id:"uuid",title:"text",description:"text",owner:"text",priority:"text",due_date:"date",status:"text",completed_at:"timestamp",...baseAudit},enums:{priority:['Critical','High','Medium','Low'],status:actionStatuses} },
  friction: { table:"friction_log",required:["work_package_id","workflow_step","friction","change_reason"],fields:{work_package_id:"uuid",workflow_step:"text",existing_finance_os_support:"text",friction:"text",temporary_workaround:"text",consequence:"text",enhancement_needed:"text",urgency:"text",status:"text",...baseAudit} },
  mappings: { table:"finance_mappings",required:["work_package_id","source_entity_type","source_entity_id","proposed_destination","change_reason"],fields:{work_package_id:"uuid",source_entity_type:"text",source_entity_id:"uuid",proposed_destination:"text",proposed_amount:"money",financial_treatment:"text",timing:"text",evidence_id:"uuid",mapping_status:"text",notes:"text",...baseAudit},enums:{mapping_status:['Not Reviewed','Ready to Map','Mapped','Rejected','Superseded']} }
} satisfies Record<string,Config>;
export type RdResource = keyof typeof RD_RESOURCES;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const date=/^\d{4}-\d{2}-\d{2}$/;
const fail=(message:string,code="invalid_rd_payload",statusCode=400)=>Object.assign(new Error(message),{code,statusCode});

function parse(field:string,kind:Kind,value:unknown) {
  if(value===null||value==="") return null;
  if(kind==="text"){if(typeof value!=="string")throw fail(`${field} must be text`);const v=value.trim();if(v.length>10000)throw fail(`${field} is too long`);return v||null;}
  if(kind==="boolean"){if(typeof value!=="boolean")throw fail(`${field} must be boolean`);return value;}
  if(kind==="uuid"){if(typeof value!=="string"||!uuid.test(value))throw fail(`${field} must be a UUID`);return value;}
  if(kind==="date"){if(typeof value!=="string"||!date.test(value)||Number.isNaN(Date.parse(`${value}T00:00:00Z`)))throw fail(`${field} must be YYYY-MM-DD`);return value;}
  if(kind==="timestamp"){if(typeof value!=="string"||Number.isNaN(Date.parse(value)))throw fail(`${field} must be an ISO timestamp`);return value;}
  if(kind==="email"){if(typeof value!=="string"||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))throw fail(`${field} must be a valid email`);return value.trim().toLowerCase();}
  if(kind==="url"){if(typeof value!=="string")throw fail(`${field} must be a URL`);try{const u=new URL(value);if(!["https:","http:"].includes(u.protocol))throw new Error();return u.toString();}catch{throw fail(`${field} must be a valid HTTP URL`);}}
  const amount=toFiniteMoney(value);if(amount===null)throw fail(`${field} must be finite money or null`);return amount;
}
export function validateRdPayload(resource:RdResource,input:Record<string,unknown>,partial=false){
  const config=RD_RESOURCES[resource] as Config;const unknown=Object.keys(input).filter(k=>!(k in config.fields));if(unknown.length)throw fail(`Unknown fields: ${unknown.join(", ")}`);
  const out:Record<string,unknown>={};for(const [field,kind] of Object.entries(config.fields))if(field in input)out[field]=parse(field,kind,input[field]);
  if(!partial)for(const field of config.required)if(!(field in out)||out[field]===null)throw fail(`${field} is required`);
  if(partial&&(!out.change_reason||String(out.change_reason).length<5))throw fail("A meaningful change_reason is required");
  for(const [field,allowed] of Object.entries(config.enums??{}))if(field in out&&out[field]!==null&&!allowed.includes(out[field] as never))throw fail(`Invalid ${field}`);
  return out;
}
export function requireRdFounder(role:unknown){if(role!=="founder_admin")throw fail("Founder/admin access is required","rd_forbidden",403);}
export async function getWp1(db:Db=pool){const r=await db.query(`SELECT * FROM rd_lab.work_packages WHERE code='WP1'`);if(!r.rows[0])throw fail("WP1 is not configured","wp1_not_found",404);return r.rows[0];}
export async function updateWp1(input:Record<string,unknown>,userId:string,db:Db=pool){
  const allowed={status:"text" as Kind,target_start_date:"date" as Kind,target_end_date:"date" as Kind,change_reason:"text" as Kind};const unknown=Object.keys(input).filter(k=>!(k in allowed));if(unknown.length)throw fail(`Unknown fields: ${unknown.join(", ")}`);
  const values:Record<string,unknown>={};for(const [k,v]of Object.entries(input))values[k]=parse(k,allowed[k as keyof typeof allowed],v);
  if(!values.change_reason||String(values.change_reason).length<5)throw fail("A meaningful change_reason is required");if(values.status&&!wpStatuses.includes(values.status as never))throw fail("Invalid status");
  const current=await db.query(`SELECT * FROM rd_lab.work_packages WHERE code='WP1' FOR UPDATE`);if(!current.rows[0])throw fail("WP1 not found","wp1_not_found",404);
  const names=Object.keys(values);const params=names.map(k=>values[k]);params.push(userId,current.rows[0].id);
  const result=await db.query(`UPDATE rd_lab.work_packages SET ${names.map((k,i)=>`${k}=$${i+1}`).join(",")},updated_by=$${names.length+1},version=version+1 WHERE id=$${names.length+2} RETURNING *`,params);return result.rows[0];
}
export async function listRecords(resource:RdResource,wpId:string,query:Record<string,unknown>,db:Db=pool){
  const c=RD_RESOURCES[resource] as Config;const filters=Object.keys(query).filter(k=>k in c.fields).slice(0,10);const params:unknown[]=[wpId];let where=resource==="contacts"?"supplier_id IN (SELECT id FROM rd_lab.suppliers WHERE work_package_id=$1)":"work_package_id=$1";
  for(const key of filters){params.push(parse(key,c.fields[key],query[key]));where+=` AND ${key}=$${params.length}`;}
  return (await db.query(`SELECT * FROM rd_lab.${c.table} WHERE ${where} ORDER BY ${c.order??"created_at DESC"} LIMIT 500`,params)).rows;
}
export async function createRecord(resource:RdResource,input:Record<string,unknown>,userId:string,db:Db=pool){
  const c=RD_RESOURCES[resource] as Config,v=validateRdPayload(resource,input);const names=Object.keys(v);const params=names.map(k=>v[k]);params.push(userId,userId);
  const r=await db.query(`INSERT INTO rd_lab.${c.table}(${names.join(",")},created_by,updated_by) VALUES(${names.map((_,i)=>`$${i+1}`).join(",")},$${names.length+1},$${names.length+2}) RETURNING *`,params);return r.rows[0];
}
export async function updateRecord(resource:RdResource,id:string,input:Record<string,unknown>,userId:string,db:Db=pool){
  if(!uuid.test(id))throw fail("id must be a UUID");const c=RD_RESOURCES[resource] as Config,v=validateRdPayload(resource,input,true),names=Object.keys(v);
  const current=await db.query(`SELECT * FROM rd_lab.${c.table} WHERE id=$1 FOR UPDATE`,[id]);if(!current.rows[0])throw fail("Record not found","rd_record_not_found",404);
  await db.query(`INSERT INTO rd_lab.record_versions(entity_type,entity_id,version,snapshot,change_reason,created_by) VALUES($1,$2,$3,$4,$5,$6)`,[resource,id,current.rows[0].version,current.rows[0],v.change_reason,userId]);
  const params=names.map(k=>v[k]);params.push(userId,id);const r=await db.query(`UPDATE rd_lab.${c.table} SET ${names.map((k,i)=>`${k}=$${i+1}`).join(",")},updated_by=$${names.length+1},version=version+1 WHERE id=$${names.length+2} RETURNING *`,params);return r.rows[0];
}
export async function summary(wpId:string,db:Db=pool){
  const r=await db.query(`SELECT
  (SELECT count(*)::int FROM rd_lab.suppliers WHERE work_package_id=$1) suppliers_identified,
  (SELECT count(*)::int FROM rd_lab.suppliers WHERE work_package_id=$1 AND procurement_status IN('Contacted','Meeting Booked','Discovery Complete','RFQ Planned','RFQ Sent','Quote Received','Selected')) suppliers_contacted,
  (SELECT count(*)::int FROM rd_lab.interactions WHERE work_package_id=$1) meetings_held,
  (SELECT count(*)::int FROM rd_lab.rfqs WHERE work_package_id=$1 AND status NOT IN('Draft','Ready')) rfqs_sent,
  (SELECT count(*)::int FROM rd_lab.quotations WHERE work_package_id=$1) quotations_received,
  (SELECT count(*)::int FROM rd_lab.action_items WHERE work_package_id=$1 AND status NOT IN('Complete','Cancelled')) open_actions,
  (SELECT min(minimum_amount) FROM rd_lab.quotations WHERE work_package_id=$1) minimum_amount,
  (SELECT max(likely_amount) FROM rd_lab.quotations WHERE work_package_id=$1) likely_amount,
  (SELECT max(maximum_amount) FROM rd_lab.quotations WHERE work_package_id=$1) maximum_amount`,[wpId]);return r.rows[0];
}
