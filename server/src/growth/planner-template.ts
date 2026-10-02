export const PLATFORMS=['linkedin','facebook','instagram','x','tiktok','snapchat'] as const;
export const ROLES=['awareness','education','credibility_nurture','founder_build_journey','conversion'] as const;
export const CHANNELS:Record<string,{format:string;approach:string;action:string}>={
 linkedin:{format:'text',approach:'Founder reflection: explain the recorded business development, what was learned and the next evidence needed. No invented partnership.',action:'separate_provider_approval'},
 facebook:{format:'text',approach:'Accessible community update: explain one useful idea in everyday language and invite a relevant question.',action:'separate_provider_approval'},
 instagram:{format:'image',approach:'Visual story: one clear visual idea per position, consistent typography and palette, with authentic build-journey material.',action:'separate_provider_approval'},
 x:{format:'text',approach:'One concise founder observation and its evidence boundary. Prepare short copy for manual posting.',action:'manual'},
 tiktok:{format:'video',approach:'Vertical founder-led video: opening question, real demonstration or footage, one useful takeaway; include a shot list and spoken talking points.',action:'manual'},
 snapchat:{format:'image',approach:'Selective behind-the-scenes context and an approved web-link attachment. Creative Kit Web is link sharing, not native image/video publishing.',action:'creative_kit_link_handoff'}
};
export function narrativeSequence(platforms:string[],start:string,end:string,title:string):Array<Record<string,any>>{
 if(!platforms.length||new Set(platforms).size!==platforms.length||platforms.some(p=>!PLATFORMS.includes(p as any)))throw Error('Choose supported, distinct platforms');
 const first=Date.parse(start+'T12:00:00Z'),last=Date.parse(end+'T12:00:00Z');
 if(!Number.isFinite(first)||!Number.isFinite(last)||last<first||last-first>180*86400000)throw Error('Choose a date range of at most 180 days');
 const items:Array<Record<string,any>>=[];
 for(const platform of platforms){
  const roles=platform==='instagram'?['awareness','education','founder_build_journey','education','credibility_nurture','founder_build_journey','education','conversion','founder_build_journey']:['awareness','credibility_nurture','conversion'];
  const beats=platform==='instagram'?['The question behind this development','Explain the process','Founder: why this step matters','What was actually recorded','What we cannot claim yet','Show the genuine work in progress','What evidence comes next','Who should join the journey','Founder reflection and next steps']:['Introduce the real development','Explain the evidence and its limits','Invite relevant people to follow the next stage'];
  roles.forEach((role,i)=>{const genuine=platform==='tiktok'||platform==='snapchat'||(platform==='instagram'&&[2,5,8].includes(i));
   const media=platform==='tiktok'||(platform==='instagram'&&genuine)?'video':CHANNELS[platform].format==='text'?'none':'image';
   items.push({slot:`${platform}:${i+1}`,platform,role,position:i+1,grid_position:platform==='instagram'?i+1:null,title:`${beats[i]} — ${title}`,
    scheduled_at:new Date(first+Math.round((last-first)/86400000*i/Math.max(1,roles.length-1))*86400000).toISOString(),included:true,review:'pending',
    structure:platform==='tiktok'?['0–3s: a spoken question to camera','3–20s: genuine workshop/product footage with one explanation','20–30s: evidence limit and next step; readable subtitles']:platform==='instagram'?['One visual focal point for this grid position','Short accessible caption outline and image description','Maintain the cycle palette; reserve authentic slots for real footage']:platform==='linkedin'?['Evidence-led opening','Founder interpretation and business relevance','A thoughtful question or appropriate next step']:platform==='facebook'?['Plain-language company update','Explain why the community may care','One accessible takeaway or question']:platform==='x'?['One concise observation','A factual boundary or next step','Founder writes and approves final copy before opening X']:['Brief behind-the-scenes context','Reviewed web-link attachment with optional preview','Founder completes the share in Snapchat'],
    approach:`${beats[i]}. ${CHANNELS[platform].approach}`,execution:CHANNELS[platform].action,
    cta:role==='conversion'?'Invite relevant people to explore KLPS and join the waitlist through a tracked link.':'No mandatory waitlist CTA.',
    talking_points:[beats[i],'State only the recorded development.','Explain why this stage matters without implying validation.','Describe the next step as a plan, not a completed result.'],
    requirement:{kind:genuine?'genuine':'designed',media_type:media,aspect_ratio:media==='video'?'9:16':media==='image'?'4:5':null,duration_seconds:media==='video'?30:null,topic:title,platforms:[platform],role,deadline:new Date(first+Math.round((last-first)/86400000*i/Math.max(1,roles.length-1))*86400000-2*86400000).toISOString()},
    asset_id:null});
  });
 }
 return items.sort((a,b)=>a.scheduled_at.localeCompare(b.scheduled_at)||platforms.indexOf(a.platform)-platforms.indexOf(b.platform)).map((x,i)=>({...x,order:i+1}));
}
export function assetFits(brief:Record<string,any>,asset:Record<string,any>){
 const r=brief.requirement;if(r.media_type==='none')return false;
 return asset.approved_for_use===true&&Boolean(asset.storage_key||asset.stored_version)&&
  (r.kind==='genuine'?['genuine_founder','genuine_product'].includes(asset.provenance_kind):['designed','generated'].includes(asset.provenance_kind))&&
  String(asset.mime_type??'').startsWith(r.media_type+'/')&&asset.aspect_ratio===r.aspect_ratio&&
  Array.isArray(asset.suitable_platforms)&&asset.suitable_platforms.includes(brief.platform)&&
  (r.media_type!=='video'||(Number(asset.duration_seconds)>0&&Number(asset.duration_seconds)<=r.duration_seconds*2));
}
