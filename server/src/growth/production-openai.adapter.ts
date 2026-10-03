import sharp from 'sharp';
import {BRAND,renderBrandCard,VisualGenerator,productionError} from './production-generation';
/** Prepared adapter only: deliberately absent from the production provider registry.
 * No environment variable can activate it. Cost approval and durable budget admission
 * must precede registration. Tests inject a fake transport; no paid request is made.
 * Contract: https://developers.openai.com/api/docs/guides/image-generation
 */
export function openAIImageAdapter(apiKey:string,transport:typeof fetch):VisualGenerator {
 return {id:'openai-gpt-image-1.5-brand-v1',billable:true,async generate(r,copy){
  if(r.brief.requirement.kind!=='designed'||r.brief.requirement.media_type!=='image')throw productionError('Genuine-media reservations cannot be generated');
  if(!apiKey)throw productionError('Image provider is not configured',503);
  // Only abstract visual direction is disclosed; never source IDs, documents, people, URLs or free-text brief notes.
  const prompt=`Create an abstract editorial background for a KLPS brand card. Palette: ${BRAND.pink}, ${BRAND.lavender}, ${BRAND.violet}. Spacious, restrained shapes and soft gradients; generous empty central space. Purpose: ${r.brief.role}. Cycle position: ${r.brief.position}. No text, letters, logos, people, product photography, documents, charts or representations of real events. The final title and canonical logo will be typeset separately.`;
  let response:Response;try{response=await transport('https://api.openai.com/v1/images/generations',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-image-1.5',prompt,n:1,size:'1024x1536',quality:'medium',output_format:'jpeg',background:'opaque'}),signal:AbortSignal.timeout(120000)});}catch{throw productionError('Image provider outcome is unconfirmed. No automatic retry was made.',502);}
  if(!response.ok)throw productionError(`Image provider returned HTTP ${response.status}. No automatic retry was made.`,502);
  const payload=await response.json().catch(()=>null) as {data?:{b64_json?:string}[]}|null;
  const encoded=payload?.data?.[0]?.b64_json;if(!encoded||encoded.length>28*1024*1024)throw productionError('Image provider returned an invalid result',502);
  let texture:Buffer;try{texture=await sharp(Buffer.from(encoded,'base64'),{limitInputPixels:20_000_000}).resize(1080,1350,{fit:'cover'}).jpeg().toBuffer();}catch{throw productionError('Image provider returned invalid image bytes',502);}
  const card=await renderBrandCard(r,copy,texture);return {...card,origin:'generated',provenance:{model:'gpt-image-1.5',treatment:'AI abstract background with canonical KLPS typography and logo'}};
 }};
}
