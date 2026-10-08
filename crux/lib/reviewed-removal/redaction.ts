import type { Target } from './model.ts';
/** Suggestions only: prose replacements must be reviewed before applying. */
export function createRedactor(targets: Target[]) {
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const folded=(s:string)=>s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const ids=new Set(targets.flatMap(t=>t.ids));
const names=new Set(targets.flatMap(t=>t.aliases.filter(a=>a.length>5)).map(folded));
function isRemovedIdentity(value:unknown):boolean {
 return typeof value==='string'&&(ids.has(value)||names.has(folded(value))||targets.some(t=>t.type==='organization'&&t.aliases.includes(value)));
}
function textMatches(value:string,scope:string[]=targets.map(t=>t.name),weak=false):boolean {
 return targets.filter(t=>scope.includes(t.name)).some(t=>t.aliases.some(a=>{
  const acronym=a.length<=5||(t.caseSensitiveAliases??[]).includes(a);
  return new RegExp('(?<![\\w-])'+escape(a).replace(/ /g,'[\\s._–—-]+')+'(?![\\w-])',acronym?'u':'iu').test(value);
 })||weak&&(t.contextAliases??[]).some(a=>new RegExp('(?<![\\w-])'+escape(a)+'(?![\\w-])','u').test(value)));
}
function removeNames(value:string,scope:string[]=targets.map(t=>t.name),weak=false):string {
 return value.split('\n').map(line=>{const prefix=line.match(/^\s*/)?.[0]??'';return prefix+removeNamesLine(line.slice(prefix.length),scope,weak);}).join('\n');
}
function removeNamesLine(value:string,scope:string[],weak:boolean):string {
 const scoped=targets.filter(t=>scope.includes(t.name));
 if(!textMatches(value,scope)&&!scoped.some(t=>t.ids.some(id=>value.includes(id))||weak&&(t.contextAliases??[]).some(alias=>new RegExp('(?<![\\w-])'+escape(alias)+'(?![\\w-])','u').test(value))))return value;
 const held:string[]=[];
 let text=value.replace(/https?:\/\/[^\s<>"\[\]()]*(?:\([^\s<>"\[\]]*\)[^\s<>"\[\]()]*)?/g,url=>`ZZURL${held.push(url)-1}ZZ`);
 // Keep shared resource links; unwrap only links to removed identities.
 for(const tag of ['EntityLink','R'])text=text.replace(new RegExp('<'+tag+'\\b([^>]*)>([\\s\\S]*?)<\\/'+tag+'>','g'),(whole,attrs,body)=>{
  const ref=attrs.match(/\bid=["']([^"']+)["']/)?.[1];const slug=attrs.match(/\bname=["']([^"']+)["']/)?.[1];
  return isRemovedIdentity(ref)||isRemovedIdentity(slug)?body:whole;
 });
 for(const target of targets.filter(t=>scope.includes(t.name))){
  const aliases=[...target.aliases].sort((a,b)=>b.length-a.length);
  for(const alias of aliases){
   const acronym=alias.length<=5||(target.caseSensitiveAliases??[]).includes(alias);
   const expression='(?<![\\w-])'+escape(alias).replace(/ /g,'[\\s._–—-]+')+'(?![\\w-])';
   text=text.replace(new RegExp(expression,acronym?'gu':'giu'),'ZZREMOVEDZZ');
  }
  if(weak&&target.type==='person'){
   const patterns=[...(target.contextAliases??[])].sort((a,b)=>b.length-a.length).map(escape);
   for(const expression of patterns)text=text.replace(new RegExp('(?<![\\w-])(?:'+expression+')(?![\\w-])','gu'),'ZZREMOVEDZZ');
  }
 }
 text=text.replace(/(?:\*\*|\*)?ZZREMOVEDZZ(?:\*\*|\*)?['’]s\s+/g,'');
 text=text.replace(/\s*(?:\*\*|\*)?ZZREMOVEDZZ(?:\*\*|\*)?\s*\((?![^()]*\b(?:19|20)\d{2}\b)[^)]*\)/g,'ZZREMOVEDZZ');
 text=text.replace(/(?:co-)?founded (?:in \d{4} )?by ZZREMOVEDZZ(?:,? (?:a |the )?[^.;]*?(?:professor|textbook author)[^.;]*)?/gi,'founded');
 text=text.replace(/(?:according to|as noted by|as argued by|research by|developed by) ZZREMOVEDZZ(?: and (?:others|collaborators))?\s*,?\s*/gi,match=>/^research/i.test(match)?'Research ':/^developed/i.test(match)?'Developed ':'');
 text=text.replace(/ZZREMOVEDZZ and (?:others|collaborators) (?:show|have shown|demonstrate|have demonstrated)/g,'The research shows');
 text=text.replace(/ZZREMOVEDZZ argues that/g,'One argument is that');
 text=text.replace(/ZZREMOVEDZZ argues for/g,'One proposal calls for');
 text=text.replace(/ZZREMOVEDZZ (?:warns|warned) that/g,'One concern is that');
 text=text.replace(/(?:,\s*)?(?:and\s+|&\s+)?(?:\*\*|\*)?ZZREMOVEDZZ(?:\*\*|\*)?(?=\s*[,;])/g,'');
 text=text.replace(/,?\s*(?:and|&)\s+(?:\*\*|\*)?ZZREMOVEDZZ(?:\*\*|\*)?/g,'');
 text=text.replace(/(?:\*\*|\*)?ZZREMOVEDZZ(?:\*\*|\*)?\s*(?:,\s*|and\s+|&\s+)/g,'');
 text=text.replace(/(?:\*\*|\*)?ZZREMOVEDZZ(?:\*\*|\*)?/g,'');
 text=text.replace(/\(\s*\)/g,'');
 text=text.replace(/\(\s*[,;]\s*/g,'(').replace(/\s*[,;]\s*\)/g,')');
 text=text.replace(/ {2,}/g,' ').replace(/\s+,/g,',').replace(/,\s*,/g,',').replace(/,\s*and\s*,/g,',').replace(/\s+\./g,'.');
 text=text.replace(/(\|\s*),\s*/g,'$1').replace(/,\s*(?=\|)/g,'').replace(/(including|with|Researchers\*\*:)\s*,\s*/g,'$1 ').replace(/(\[\^[^\]]+\]:)\./g,'$1').replace(/,\s+et al\./g,' et al.');
 return text.replace(/ZZURL(\d+)ZZ/g,(_,i)=>held[Number(i)]);
}
function redactValue(value:unknown,scope:string[]=targets.map(t=>t.name),weak=false):unknown {
 if(typeof value==='string')return isRemovedIdentity(value)?null:removeNames(value,scope,weak);
 if(Array.isArray(value))return value.filter(item=>!isRemovedIdentity(item)&&!(item&&typeof item==='object'&&!Array.isArray(item)&&['id','name','personId','entityId','stableId'].some(k=>isRemovedIdentity((item as Record<string,unknown>)[k])))).map(item=>redactValue(item,scope,weak));
 if(value&&typeof value==='object'){
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/url|source|link|filename/i.test(k)&&typeof v==='string'&&/^https?:/.test(v)?v:redactValue(v,scope,weak)]));
 }
 return value;
}

return {isRemovedIdentity,textMatches,removeNames,redactValue};
}
