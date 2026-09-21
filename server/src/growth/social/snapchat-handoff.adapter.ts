import { SocialCapability, SocialPublishInput } from './social.types';
export const snapchatHandoffCapabilities = (scopes:string[]):SocialCapability[] =>
 ['https://auth.snapchat.com/oauth2/api/user.external_id','https://auth.snapchat.com/oauth2/api/user.display_name'].every(s=>scopes.includes(s)) ? ['manual_handoff'] : [];
export function validateSnapchatHandoff(input:SocialPublishInput) {
 if(typeof input.text!=='string'||!input.text.trim()||input.text.length>500||!Array.isArray(input.media)||input.media.length>1)
  throw Object.assign(new Error('Enter 1–500 characters and select at most one approved JPEG preview.'),{statusCode:400,code:'snapchat_content_invalid'});
 for(const item of input.media){
  if(!item||typeof item!=='object'||Object.keys(item).length!==1||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(String((item as any).publishing_asset_id)))
   throw Object.assign(new Error('Select an approved publishing asset.'),{statusCode:400,code:'snapchat_media_invalid'});
 }
}
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function snapchatShareHtml(text:string,imageUrl:string|null,url:string) {
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Approved KLPS content</title><meta property="og:site_name" content="KLPS"><meta property="og:title" content="${escape(text)}"><meta property="og:url" content="${escape(url)}">${imageUrl?`<meta property="og:image" content="${escape(imageUrl)}">`:''}</head><body><main><h1>Approved KLPS content</h1><p>${escape(text)}</p>${imageUrl?`<img src="${escape(imageUrl)}" alt="Approved content preview" style="max-width:100%;max-height:70vh">`:''}<p>Shared with Creative Kit Web as a link and preview. The sender chooses the audience and completes the share inside Snapchat.</p></main></body></html>`;
}
