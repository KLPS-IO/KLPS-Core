import fs from 'node:fs/promises';
import path from 'node:path';
/** A local transport for the existing evidence object store, never a second metadata store. */
export function localEvidenceRoot(){
 if(process.env.FINANCE_LOCAL_REVIEW!=='1')return null;
 const db=new URL(process.env.DATABASE_URL??'');
 if(process.env.NODE_ENV==='production'||db.hostname!=='127.0.0.1'||db.port!=='55448'||!['/finance_review','/finance_test'].includes(db.pathname))throw new Error('Local evidence transport requires isolated loopback Finance database');
 const root=process.env.FINANCE_LOCAL_EVIDENCE_ROOT;if(!root||!path.isAbsolute(root))throw new Error('Absolute local evidence root required');return root;
}
function destination(key:string){const root=localEvidenceRoot();if(!root)throw new Error('Local evidence disabled');const target=path.resolve(root,key);if(!target.startsWith(root+path.sep))throw new Error('Invalid object key');return target;}
export async function putLocalEvidence(key:string,bytes:Buffer){const target=destination(key);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{mode:0o600});return key;}
export async function readLocalEvidence(key:string){return {body:await fs.readFile(destination(key)),contentType:key.endsWith('.png')?'image/png':key.endsWith('.pdf')?'application/pdf':'text/csv'};}
export async function deleteLocalEvidence(key:string){await fs.rm(destination(key),{force:true});}
