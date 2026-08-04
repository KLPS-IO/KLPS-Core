import { PoolClient } from "pg";
import { pool } from "../storage/postgres.client";

type Db=Pick<PoolClient,"query">;
type Json=Record<string,unknown>;
export type ExportConfig={categoryNominalCodes:Record<string,string>;paymentAccountNominalCodes:Record<string,string>};
export type ConfigSource="database"|"environment"|"none";
export const ACCOUNTING_EXPORT_TYPE="mtd_accounting" as const;
export const QUICKFILE_CONFIG_PROFILE="quickfile_purchase_csv_v1" as const;
export const PAYMENT_MAPPING_KEYS=["founder_director_funded","paypal","personal_credit_card","company_credit_card","business_bank","other"] as const;

const configError=(message:string,code:string,statusCode=400)=>Object.assign(new Error(message),{code,statusCode});
const clean=(value:unknown)=>typeof value==="string"?value.trim():"";
const profile=(value:unknown)=>{const result=clean(value);if(result!==QUICKFILE_CONFIG_PROFILE)throw configError("Unsupported accounting export profile","unsupported_accounting_export_profile");return result;};
const parseMapping=(value:unknown,name:string,allowed?:readonly string[])=>{
  if(!value||typeof value!=="object"||Array.isArray(value))throw configError(`${name} must be an object`,"invalid_accounting_export_mapping");
  const result:Record<string,string>={};
  for(const [rawKey,rawValue] of Object.entries(value as Json)){
    const key=rawKey.trim(),mapped=clean(rawValue);
    if(!key||!mapped||typeof rawValue!=="string")throw configError(`${name} keys and values must be non-empty strings`,"invalid_accounting_export_mapping");
    if(allowed&&!allowed.includes(key))throw configError(`Unsupported payment mapping key: ${key}`,"unsupported_payment_mapping_key");
    if(key in result)throw configError(`Duplicate mapping key: ${key}`,"duplicate_accounting_export_mapping");
    result[key]=mapped;
  }
  return result;
};
const parseEnvironmentMap=(name:string,allowed?:readonly string[])=>{
  const value=process.env[name];if(!value)return {};
  try{return parseMapping(JSON.parse(value),name,allowed);}
  catch(error){if((error as {code?:string}).code)throw error;throw configError(`${name} must be a JSON object of reviewed nominal-code mappings`,`invalid_${name.toLowerCase()}`,500);}
};
export const loadEnvironmentExportConfig=():ExportConfig=>({categoryNominalCodes:parseEnvironmentMap("MTD_ACCOUNTING_CATEGORY_NOMINAL_CODES"),paymentAccountNominalCodes:parseEnvironmentMap("MTD_ACCOUNTING_PAYMENT_ACCOUNT_NOMINAL_CODES",PAYMENT_MAPPING_KEYS)});
const publicConfig=(row:Json|null,environment:ExportConfig)=>{
  if(row)return{export_type:ACCOUNTING_EXPORT_TYPE,profile:QUICKFILE_CONFIG_PROFILE,category_nominal_codes:row.category_nominal_codes as Record<string,string>,payment_account_nominal_codes:row.payment_account_nominal_codes as Record<string,string>,source:"database" as const,confirmed:Boolean(row.confirmed_at),confirmed_at:row.confirmed_at??null,updated_at:row.updated_at??null,version:Number(row.version)};
  const configured=Object.keys(environment.categoryNominalCodes).length>0||Object.keys(environment.paymentAccountNominalCodes).length>0;
  return{export_type:ACCOUNTING_EXPORT_TYPE,profile:QUICKFILE_CONFIG_PROFILE,category_nominal_codes:environment.categoryNominalCodes,payment_account_nominal_codes:environment.paymentAccountNominalCodes,source:(configured?"environment":"none") as ConfigSource,confirmed:false,confirmed_at:null,updated_at:null,version:0};
};

export async function getAccountingExportConfig(profileValue:unknown,db:Db=pool,environment=loadEnvironmentExportConfig()){
  profile(profileValue);
  const row=(await db.query(`SELECT id,category_nominal_codes,payment_account_nominal_codes,confirmed_at,updated_at,version FROM finance_os.accounting_export_configs WHERE export_type=$1 AND profile=$2`,[ACCOUNTING_EXPORT_TYPE,QUICKFILE_CONFIG_PROFILE])).rows[0]??null;
  return publicConfig(row,environment);
}

export async function resolveAccountingExportConfig(profileValue:unknown,db:Db=pool,environment=loadEnvironmentExportConfig()){
  const current=await getAccountingExportConfig(profileValue,db,environment);
  return{config:{categoryNominalCodes:current.category_nominal_codes,paymentAccountNominalCodes:current.payment_account_nominal_codes},source:current.source,confirmed:current.confirmed,version:current.version,usableForGeneration:current.source==="environment"||(current.source==="database"&&current.confirmed)};
}

const changedKeys=(before:Record<string,string>,after:Record<string,string>)=>[...new Set([...Object.keys(before),...Object.keys(after)].filter(key=>before[key]!==after[key]))].sort();
const audit=async(db:Db,eventType:string,configId:string|null,userId:string,metadata:Json)=>db.query(`INSERT INTO finance_os.finance_events(event_type,entity_type,entity_id,summary,metadata,created_by) VALUES($1,'accounting_export_config',$2,$3,$4::jsonb,$5)`,[eventType,configId,`MTD Accounting Export configuration ${eventType.replace(/^accounting_export_config_/,"")}`,JSON.stringify(metadata),userId]);

export const validateAccountingExportConfigInput=(input:Json)=>{
  const selected=profile(input.profile),category=parseMapping(input.category_nominal_codes,"category_nominal_codes"),payment=parseMapping(input.payment_account_nominal_codes,"payment_account_nominal_codes",PAYMENT_MAPPING_KEYS);
  const reason=clean(input.change_reason);if(!reason)throw configError("change_reason is required","accounting_export_config_change_reason_required");
  const expected=Number(input.expected_version);if(!Number.isInteger(expected)||expected<0)throw configError("expected_version must be a non-negative integer","invalid_accounting_export_config_version");
  if(typeof input.confirm!=="boolean")throw configError("confirm must be boolean","invalid_accounting_export_config_confirmation");
  return{selected,category,payment,reason,expected,confirm:input.confirm};
};

export async function saveAccountingExportConfig(input:Json,userId:string){
  const {selected,category,payment,reason,expected,confirm}=validateAccountingExportConfigInput(input);
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const existing=(await client.query(`SELECT * FROM finance_os.accounting_export_configs WHERE export_type=$1 AND profile=$2 FOR UPDATE`,[ACCOUNTING_EXPORT_TYPE,selected])).rows[0]??null;
    const actual=existing?Number(existing.version):0;
    if(actual!==expected){await client.query("ROLLBACK");await audit(pool,"accounting_export_config_version_conflict",existing?.id??null,userId,{profile:selected,expected_version:expected,actual_version:actual,confirmed:Boolean(existing?.confirmed_at),changed_category_keys:changedKeys(existing?.category_nominal_codes??{},category),changed_payment_keys:changedKeys(existing?.payment_account_nominal_codes??{},payment)});throw configError("Accounting export configuration changed; reload and retry","accounting_export_config_version_conflict",409);}
    let row;
    if(existing){
      await client.query(`INSERT INTO finance_os.accounting_export_config_versions(config_id,version,snapshot,change_reason,created_by) VALUES($1,$2,$3::jsonb,$4,$5)`,[existing.id,existing.version,JSON.stringify(existing),reason,userId]);
      row=(await client.query(`UPDATE finance_os.accounting_export_configs SET category_nominal_codes=$1::jsonb,payment_account_nominal_codes=$2::jsonb,confirmed_at=CASE WHEN $3 THEN now() ELSE NULL END,confirmed_by=CASE WHEN $3 THEN $4::uuid ELSE NULL END,version=version+1,change_reason=$5,updated_at=now(),updated_by=$4 WHERE id=$6 RETURNING *`,[JSON.stringify(category),JSON.stringify(payment),confirm,userId,reason,existing.id])).rows[0];
    }else{
      row=(await client.query(`INSERT INTO finance_os.accounting_export_configs(export_type,profile,category_nominal_codes,payment_account_nominal_codes,confirmed_at,confirmed_by,change_reason,created_by,updated_by) VALUES($1,$2,$3::jsonb,$4::jsonb,CASE WHEN $5 THEN now() ELSE NULL END,CASE WHEN $5 THEN $6::uuid ELSE NULL END,$7,$6,$6) RETURNING *`,[ACCOUNTING_EXPORT_TYPE,selected,JSON.stringify(category),JSON.stringify(payment),confirm,userId,reason])).rows[0];
    }
    const metadata={profile:selected,version:Number(row.version),confirmed:Boolean(row.confirmed_at),changed_category_keys:changedKeys(existing?.category_nominal_codes??{},category),changed_payment_keys:changedKeys(existing?.payment_account_nominal_codes??{},payment)};
    await audit(client,"accounting_export_config_saved",row.id,userId,metadata);
    if(confirm)await audit(client,"accounting_export_config_confirmed",row.id,userId,metadata);
    await client.query("COMMIT");return publicConfig(row,{categoryNominalCodes:{},paymentAccountNominalCodes:{}});
  }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
}

export const auditConfigValidationFailed=(current:{source:ConfigSource;version:number;confirmed:boolean},userId:string,missingCategoryKeys:string[],missingPaymentKeys:string[],db:Db=pool)=>audit(db,"accounting_export_config_validation_failed",null,userId,{profile:QUICKFILE_CONFIG_PROFILE,version:current.version,source:current.source,confirmed:current.confirmed,changed_category_keys:[],changed_payment_keys:[],missing_category_keys:missingCategoryKeys,missing_payment_keys:missingPaymentKeys});
