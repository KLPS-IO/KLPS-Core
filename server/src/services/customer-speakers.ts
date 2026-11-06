export type SpeakerRole='emma'|'participant'|'unclear';
export type SpeakerSpan={start:number;end:number;role:SpeakerRole};
const roles=new Set(['emma','participant','unclear']);
function boundary(text:string,i:number){return !(i>0&&i<text.length&&text.charCodeAt(i-1)>=0xd800&&text.charCodeAt(i-1)<=0xdbff&&text.charCodeAt(i)>=0xdc00&&text.charCodeAt(i)<=0xdfff);}
export function validSpeakerSpans(text:string,value:unknown):value is SpeakerSpan[]{
 if(!Array.isArray(value)||value.length>2000)return false;let end=0;
 for(const s of value){if(!s||!Number.isInteger(s.start)||!Number.isInteger(s.end)||s.start<end||s.start<0||s.end<=s.start||s.end>text.length||!roles.has(s.role)||!boundary(text,s.start)||!boundary(text,s.end))return false;end=s.end;}return true;
}
function merge(spans:SpeakerSpan[]):SpeakerSpan[]{const out:SpeakerSpan[]=[];for(const s of [...spans].sort((a,b)=>a.start-b.start)){if(s.start>=s.end)continue;const previous=out[out.length-1];if(previous&&previous.end===s.start&&previous.role===s.role)previous.end=s.end;else out.push({...s});}return out;}
export function assignSpeaker(text:string,spans:SpeakerSpan[],start:number,end:number,role:SpeakerRole):SpeakerSpan[]{
 if(!validSpeakerSpans(text,[{start,end,role}]))return spans;
 const result:SpeakerSpan[]=[];for(const s of spans){if(s.end<=start||s.start>=end)result.push(s);else{if(s.start<start)result.push({...s,end:start});if(s.end>end)result.push({...s,start:end});}}
 return merge([...result,{start,end,role}]);
}
export function speakerSegments(text:string,spans:SpeakerSpan[]):Array<{start:number;end:number;role:SpeakerRole|'unassigned';text:string}>{
 const out:Array<{start:number;end:number;role:SpeakerRole|'unassigned';text:string}>=[];let position=0;for(const s of spans){if(s.start>position)out.push({start:position,end:s.start,role:'unassigned',text:text.slice(position,s.start)});out.push({...s,text:text.slice(s.start,s.end)});position=s.end;}if(position<text.length)out.push({start:position,end:text.length,role:'unassigned',text:text.slice(position)});return out;
}
export function labelRemainingParticipant(text:string,spans:SpeakerSpan[]):SpeakerSpan[]{return merge(speakerSegments(text,spans).filter(s=>s.text.trim()).map(s=>({start:s.start,end:s.end,role:s.role==='unassigned'?'participant':s.role})));}
export function speakersComplete(text:string,spans:SpeakerSpan[]):boolean{return validSpeakerSpans(text,spans)&&speakerSegments(text,spans).every(s=>s.role!=='unassigned'||!s.text.trim());}
export function participantText(text:string,spans:SpeakerSpan[]):string{return speakerSegments(text,spans).filter(s=>s.role==='participant').map(s=>s.text.trim()).filter(Boolean).join('\n\n');}
export function rebaseSpeakers(before:string,after:string,spans:SpeakerSpan[]):SpeakerSpan[]{
 if(before===after)return spans;let prefix=0;while(prefix<Math.min(before.length,after.length)&&before[prefix]===after[prefix])prefix++;
 while(prefix>0&&(!boundary(before,prefix)||!boundary(after,prefix)))prefix--;
 let suffix=0;while(suffix<Math.min(before.length-prefix,after.length-prefix)&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
 while(suffix>0&&(!boundary(before,before.length-suffix)||!boundary(after,after.length-suffix)))suffix--;
 const oldEnd=before.length-suffix,delta=after.length-before.length;const result:SpeakerSpan[]=[];
 for(const s of spans){if(s.start<prefix)result.push({...s,end:Math.min(s.end,prefix)});if(s.end>oldEnd)result.push({...s,start:Math.max(s.start,oldEnd)+delta,end:s.end+delta});}
 return merge(result);
}
