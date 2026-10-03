import {createHash} from 'crypto';
import {existsSync,readFileSync} from 'fs';
import {resolve} from 'path';
import {Resvg} from '@resvg/resvg-js';
import sharp from 'sharp';
import {assessDevelopment} from './narrative-intake';
const brandFile=(name:string)=>{const paths=[resolve(__dirname,'../../assets/brand',name),resolve(__dirname,'../../../../server/assets/brand',name)];const found=paths.find(p=>existsSync(p));if(!found)throw productionError('Bundled brand assets are unavailable',503);return found;};
export const BRAND={version:'klps-web-1',font:'Inter',ink:'#25142b',magenta:'#b80082',pink:'#efbdd6',lavender:'#c6a6e6',violet:'#8f55d8',width:1080,height:1350,margin:84,source:'Website-UX-UI/src/index.css :root brand tokens; src/assets/logo.webp'};
export const productionError=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode,code:'production_review_required'});
export const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function briefFingerprint(item:any,plan:any){const {asset_id,...brief}=item.platform_brief;return fingerprint({brief,theme:plan.narrative_plan.theme,objective:plan.objective,audience:plan.audience,evidence:plan.narrative_plan.evidence_hash});}
export type GenerationRequest={content_id:string;brief:any;theme:string;evidence:any;constraints:string;neighbours:any[];approved_assets:string[];version:number;tracked_link?:{id:string;generated_url:string}};
export type CopyDraft={caption:string;script:string;guidance:string;headline:string;subhead:string;alt:string};
// Approved structured source states are the only generated factual input. Free-text briefing is not evidence.
export function prepareCopy(r:GenerationRequest):CopyDraft {
 const fact=assessDevelopment(r.evidence);if(!fact)throw productionError('The recorded evidence cannot support a production draft');
 const b=r.brief,conversion=b.role==='conversion',summary=fact.evidence_summary;
 const angles=['What does progress really look like?','First, ask better questions.','A step forward. Not a shortcut.','What happened — and what did not.','Evidence before assumptions.','The work behind the story.','The next question matters.','Stay close to the build.','A founder’s view of progress.'];
 const headline=angles[(b.position-1+r.version-1)%angles.length];
 const invitation=r.tracked_link?`Follow the KLPS journey and join the waitlist: ${r.tracked_link.generated_url}`:'Follow KLPS for the next part of the build journey.';
 const end=conversion?invitation:'What would you want to understand about this stage?';
 const captions:Record<string,string>={
 linkedin:`${r.version%2?'Building KLPS means being precise about progress.':'An early-stage founder’s update: the evidence matters as much as the headline.'}\n\n${summary}\n\nFor me, the useful distinction is between taking a development step and having evidence for a product claim. I want to keep that distinction visible as the company grows.\n\n${conversion?invitation:'How do you communicate early progress without overstating it?'}`,
 facebook:`${r.version%2?'A little behind-the-scenes update from KLPS.':'Come behind the scenes with KLPS for a moment.'}\n\n${summary}\n\nBuilding something takes questions as well as answers. We’re sharing this part of the journey so you can see what this stage means.\n\n${end}`,
 instagram:`${headline}\n\n${summary}\n\nThis is one part of the KLPS build story — the process, as well as the progress.\n\n${conversion?(r.tracked_link?'Interested in the journey? Join our waitlist through the link in our profile.':'Stay with us for the next part of the journey.'):'Follow the story and tell us what you would ask next.'}`,
 x:`${r.version%2?'KLPS build note:':'From the KLPS build journey:'} ${fact.title.toLowerCase()}. A development step, not a finished-product claim.${conversion&&r.tracked_link?`\n${r.tracked_link.generated_url}`:'\nThe process matters.'}`,
 tiktok:`What does an early development step actually tell you? Here’s the KLPS build journey, with the limits left in. ${conversion?'Follow our profile link if you want to join the waitlist.':'What should we explain next?'}`,
 snapchat:`Behind the KLPS build: ${fact.title.toLowerCase()}. Open the link for context — this is a development step, not a product claim.`
 };
 if(!captions[b.platform])throw productionError('Unsupported platform');
 const script=b.requirement.kind==='genuine'?`0–3s · To camera: “${headline}”\n3–20s · Explain: “${summary}”\n20–30s · Close: “${conversion?'If this journey interests you, you can join the KLPS waitlist.':'What would you ask at this stage?'}”`:'';
 const guidance=b.requirement.kind==='genuine'?`Film genuine KLPS material only. Topic: ${b.requirement.topic}.\nOpening: Emma to camera. Cutaway: your own workspace or permitted work-in-progress; keep supplier names, documents and private technical details out of frame. Close: one question to camera. Do not stage a result or demonstrate an unverified capability.\n${b.requirement.aspect_ratio}; approximately ${b.requirement.duration_seconds??30} seconds; platform: ${b.platform}. Needed by ${b.requirement.deadline}.\nSuggested beats: ${b.talking_points.join(' / ')}. Confirm each factual statement against the evidence before recording.`:conversion&&r.tracked_link&&b.platform==='instagram'?`Use this content-bound link in your profile when posting: ${r.tracked_link.generated_url}. Instagram captions do not make links clickable.`:'Review every claim and the actual artwork before approval.';
 return {caption:captions[b.platform],script,guidance,headline,subhead:fact.title,alt:`KLPS designed typography card: ${headline} ${fact.title}. Development evidence, not a finished-product claim.`};
}
export interface VisualGenerator {id:string;billable:boolean;generate(request:GenerationRequest,copy:CopyDraft):Promise<{bytes:Buffer;mime:string;origin:'designed'|'generated';provenance?:Record<string,string>}>}
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
function lines(s:string,max:number){const out:string[]=[];for(const word of s.split(/\s+/)){if(!out.length||out[out.length-1].length+word.length+1>max)out.push(word);else out[out.length-1]+=' '+word;}return out;}
export async function renderBrandCard(r:GenerationRequest,copy:CopyDraft,texture?:Buffer){
 if(r.brief.requirement.kind!=='designed'||r.brief.requirement.media_type!=='image')throw productionError('Genuine-media reservations cannot be generated');
 const neighbourIndex=r.neighbours.findIndex(n=>n.id===r.content_id);
 const dark=(Math.max(0,neighbourIndex)+r.version)%3===0,background=dark?BRAND.ink:'#fff5fb',ink=dark?'#ffffff':BRAND.ink;
 const logo=await sharp(readFileSync(brandFile('klps-logo.webp'))).trim().resize(100,100,{fit:'contain',background:'#ffffff'}).png().toBuffer();
 const title=lines(copy.headline,22),sub=lines(copy.subhead,36),role=r.brief.role.replaceAll('_',' ').toUpperCase();
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1080" height="1350"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#f7cfc9"/><stop offset=".35" stop-color="#ecbad8"/><stop offset=".7" stop-color="#ca88db"/><stop offset="1" stop-color="#8f55d8"/></linearGradient></defs><rect width="1080" height="1350" fill="${background}"/>${texture?`<image width="1080" height="1350" opacity=".15" preserveAspectRatio="xMidYMid slice" xlink:href="data:image/jpeg;base64,${texture.toString('base64')}"/>`:''}<circle cx="${r.brief.position%2?970:100}" cy="210" r="290" fill="url(#g)" opacity=".35"/><rect x="84" y="84" width="104" height="104" rx="16" fill="white"/><image x="86" y="86" width="100" height="100" xlink:href="data:image/png;base64,${logo.toString('base64')}"/><g font-family="Inter" fill="${ink}"><text x="220" y="150" font-size="38" font-weight="700">KLPS</text><text x="84" y="240" font-size="20">${escape(r.theme.replace(/_/g,' ').slice(0,55))}</text><text x="84" y="300" font-size="22" letter-spacing="3">${escape(role)}</text>${title.map((t,i)=>`<text x="80" y="${440+i*94}" font-size="76" font-weight="700">${escape(t)}</text>`).join('')}<rect x="84" y="810" width="96" height="8" fill="${BRAND.magenta}"/>${sub.map((t,i)=>`<text x="84" y="${900+i*48}" font-size="36">${escape(t)}</text>`).join('')}<text x="84" y="1130" font-size="24">Development evidence. No finished-product claim.</text><text x="84" y="1230" font-size="26">${r.brief.role==='conversion'?'Follow the build · KLPS waitlist':'klps.co.uk · The build journey'}</text><text x="940" y="1230" font-size="26">${String(r.brief.position).padStart(2,'0')}</text></g></svg>`;
 const png=new Resvg(svg,{font:{fontFiles:[brandFile('Inter.ttf')],loadSystemFonts:false,defaultFontFamily:'Inter'}}).render().asPng();
 return {bytes:await sharp(png).jpeg({quality:94,chromaSubsampling:'4:4:4'}).toBuffer(),mime:'image/jpeg',origin:'designed' as const};
}
export const designedGenerator:VisualGenerator={id:'klps-designed-v1',billable:false,generate:renderBrandCard};
// Billable adapters are deliberately not registered until cost/disclosure approval and durable budget admission are in place.
export function visualGenerator(id:string):VisualGenerator {if(id==='klps-designed-v1')return designedGenerator;throw productionError('External AI image generation is not enabled. Founder approval of provider, usage budget and data disclosure is required before activation.',403);}
