'use strict';
// A provider can refuse a request and still return a normal reply whose only text is the refusal
// (the Antigravity bridge does this for "Individual quota reached ... Resets in 154h30m7s").
// Pi sees a successful stop, so Guard has to read the reply itself. This module decides whether
// a reply is such a refusal and turns it into an allowance observation for the controller.
const REJECTION=/quota (?:reached|exceeded|exhausted)|rate.?limit(?:ed)?(?: reached| exceeded| hit)?|resource.?exhausted|usage limit (?:reached|exceeded)|upgrade your (?:subscription|plan)|too many requests|out of (?:credits|quota)/i;
const RESET=/resets? (?:in|after)\s+(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?)?)?\s*)?(?:(\d+)\s*s(?:ec(?:onds?)?)?)?/i;
const HOUR=3600000;
const GROUPS={'claude-code':'claude','antigravity':'agy','antigravity-acp':'agy'};

function resetDelayMs(text){
  const m=RESET.exec(text);
  if(!m || (!m[1] && !m[2] && !m[3] && !m[4]))return null;
  return (Number(m[1]||0)*24+Number(m[2]||0))*HOUR+Number(m[3]||0)*60000+Number(m[4]||0)*1000;
}
function family(group,model){
  const m=String(model||'').toLowerCase();
  if(group==='agy')return m.includes('argon')?'gemini-argon':/(?:gemini|neon|carbon|hydrogen|flash)/.test(m)?'gemini':'claude-gpt';
  return ['opus','sonnet','haiku','fable'].find(f=>m.includes(f))||null;
}
// Returns null for an ordinary reply; otherwise the observation to post plus a user-facing note.
function parseProviderRejection(message,now=Date.now()){
  if(!message || message.role!=='assistant')return null;
  const group=GROUPS[message.provider];
  if(!group)return null; // Direct API/OAuth providers surface real errors; only bridges hide them in text.
  const parts=Array.isArray(message.content)?message.content:[];
  if(parts.some(p=>p && p.type==='toolCall'))return null;
  const text=parts.filter(p=>p && p.type==='text').map(p=>p.text||'').join(' ').replace(/\s+/g,' ').trim();
  if(!text || text.length>600 || !REJECTION.test(text))return null;
  const delay=resetDelayMs(text);
  const resetAt=new Date(now+(delay ?? 5*HOUR)).toISOString();
  const weekly=(delay ?? 5*HOUR)>24*HOUR;
  const fam=family(group,message.model);
  const base=group==='agy'?(fam+':'):'';
  return {
    group,model:message.model||null,resetAt,confirmedReset:delay!==null,
    observation:{provider:group,windowId:base+(weekly?'weekly':'session'),windowMinutes:weekly?10080:300,usedPercent:100,resetAt,observedAt:new Date(now).toISOString(),source:'provider',...(fam?{modelFamily:fam}:{})},
    note:`${message.model||group} refused the request: ${text.replace(/^[^A-Za-z]+/,'').slice(0,140)}`,
  };
}
module.exports={parseProviderRejection,resetDelayMs,REJECTION};
