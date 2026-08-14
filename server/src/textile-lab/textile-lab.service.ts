import { pool } from "../storage/postgres.client";

type Db = Pick<typeof pool,"query">;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid=(value:unknown,name:string)=>{const result=String(value??"");if(!UUID.test(result))throw Object.assign(new Error(`${name} is invalid`),{statusCode:400,code:"invalid_reference"});return result;};
const text=(value:unknown,name:string,max=200)=>{const result=String(value??"").trim();if(!result||result.length>max)throw Object.assign(new Error(`${name} is required`),{statusCode:400,code:"invalid_field"});return result;};

export const listDevices=async(db:Db=pool)=>(await db.query(`SELECT * FROM textile_lab.devices ORDER BY created_at`)).rows;
export const listSpecimens=async(db:Db=pool)=>(await db.query(`SELECT * FROM textile_lab.specimens ORDER BY specimen_identifier`)).rows;
export const listSessions=async(db:Db=pool)=>(await db.query(`SELECT s.*,d.display_name AS device_name,p.display_name AS specimen_name FROM textile_lab.test_sessions s JOIN textile_lab.devices d ON d.id=s.device_id JOIN textile_lab.specimens p ON p.id=s.specimen_id ORDER BY s.started_at DESC LIMIT 50`)).rows;

export async function overview(db:Db=pool){
  const result=await db.query(`SELECT
    (SELECT row_to_json(d) FROM textile_lab.devices d ORDER BY (d.status='connected') DESC,d.last_connected_at DESC NULLS LAST LIMIT 1) AS device,
    (SELECT row_to_json(p) FROM textile_lab.specimens p WHERE p.status IN('active','testing') ORDER BY (p.status='testing') DESC,p.created_at LIMIT 1) AS specimen,
    (SELECT row_to_json(s) FROM textile_lab.test_sessions s WHERE s.status='active' ORDER BY s.started_at DESC LIMIT 1) AS session,
    (SELECT row_to_json(r) FROM textile_lab.raw_readings r ORDER BY r.received_at DESC,r.id DESC LIMIT 1) AS latest_reading`);
  return result.rows[0];
}

export async function registerDevice(input:Record<string,unknown>,actor:string,db:Db=pool){
  const values=[text(input.device_identifier,"device_identifier"),text(input.display_name,"display_name"),text(input.hardware_type,"hardware_type"),text(input.hardware_model,"hardware_model"),input.firmware_version?text(input.firmware_version,"firmware_version"):null,text(input.transport,"transport"),actor];
  const result=await db.query(`INSERT INTO textile_lab.devices(device_identifier,display_name,hardware_type,hardware_model,firmware_version,transport,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7)
    ON CONFLICT(device_identifier) DO UPDATE SET display_name=EXCLUDED.display_name,hardware_type=EXCLUDED.hardware_type,hardware_model=EXCLUDED.hardware_model,firmware_version=EXCLUDED.firmware_version,transport=EXCLUDED.transport,updated_at=now(),updated_by=EXCLUDED.updated_by
    RETURNING *`,values);return result.rows[0];
}

export async function startTestSession(input:Record<string,unknown>,actor:string,db:Db=pool){
  const result=await db.query(`INSERT INTO textile_lab.test_sessions(specimen_id,device_id,test_user_id,activity_purpose,analytics_population_snapshot,analytics_eligible,protocol_identifier,protocol_version,notes,created_by) SELECT $1,$2,$3,$4,p.analytics_population,false,$5,$6,$7,$8 FROM (SELECT $3::uuid AS id) requested LEFT JOIN lema.user_profiles p ON p.id=requested.id RETURNING *`,[uuid(input.specimen_id,"specimen_id"),uuid(input.device_id,"device_id"),input.test_user_id?uuid(input.test_user_id,"test_user_id"):null,text(input.activity_purpose,"activity_purpose"),input.protocol_identifier?text(input.protocol_identifier,"protocol_identifier"):null,input.protocol_version?text(input.protocol_version,"protocol_version"):null,input.notes?String(input.notes).trim():null,actor]);return result.rows[0];
}

export async function completeTestSession(id:unknown,actor:string,db:Db=pool){
  const result=await db.query(`UPDATE textile_lab.test_sessions SET status='completed',ended_at=now() WHERE id=$1 AND status='active' RETURNING *`,[uuid(id,"session_id")]);if(!result.rows[0])throw Object.assign(new Error("Active session not found"),{statusCode:404,code:"session_not_found"});return result.rows[0];
}

export async function appendRawReadings(sessionId:unknown,input:unknown,actor:string,db:Db=pool){
  const readings=Array.isArray(input)?input:[];if(readings.length<1||readings.length>1000)throw Object.assign(new Error("readings must contain 1 to 1000 items"),{statusCode:400,code:"invalid_readings"});
  const session=uuid(sessionId,"session_id");const inserted=[];
  for(const item of readings as Record<string,unknown>[]){
    const result=await db.query(`INSERT INTO textile_lab.raw_readings(session_id,device_id,specimen_id,observed_at,channel_identifier,raw_value,unit,sequence_number,adapter_identifier,adapter_version,transport,source_payload,ingestion_metadata,created_by) SELECT s.id,s.device_id,s.specimen_id,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 FROM textile_lab.test_sessions s WHERE s.id=$1 AND s.status='active' RETURNING *`,[session,new Date(String(item.observed_at)).toISOString(),text(item.channel_identifier,"channel_identifier"),text(item.raw_value,"raw_value",1000),item.unit?text(item.unit,"unit",50):null,item.sequence_number??null,text(item.adapter_identifier,"adapter_identifier"),text(item.adapter_version,"adapter_version"),text(item.transport,"transport"),item.source_payload?String(item.source_payload):null,item.ingestion_metadata??{},actor]);if(!result.rows[0])throw Object.assign(new Error("Active session not found"),{statusCode:404,code:"session_not_found"});inserted.push(result.rows[0]);
  }
  return inserted;
}

export async function listRawReadings(sessionId:unknown,db:Db=pool){return(await db.query(`SELECT * FROM textile_lab.raw_readings WHERE session_id=$1 ORDER BY observed_at,sequence_number NULLS LAST,id LIMIT 5000`,[uuid(sessionId,"session_id")])).rows;}
