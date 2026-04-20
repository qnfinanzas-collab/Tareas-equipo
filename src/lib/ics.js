import { fmt } from "./date.js";
import { needsMargin } from "./availability.js";

export function parseICSDate(s){
  if(!s)return null;
  const c=s.replace(/[^0-9T]/g,"");
  if(c.length===8) return new Date(`${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}T00:00:00`);
  if(c.length>=15) return new Date(`${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}T${c.slice(9,11)}:${c.slice(11,13)}:${c.slice(13,15)}Z`);
  return null;
}

const DOW_RRULE={SU:0,MO:1,TU:2,WE:3,TH:4,FR:5,SA:6};

function parseRRule(s){
  const out={};
  s.split(";").forEach(p=>{
    const [k,v]=p.split("=");
    if(!k||!v)return;
    if(k==="FREQ")out.freq=v;
    else if(k==="INTERVAL")out.interval=parseInt(v)||1;
    else if(k==="COUNT")out.count=parseInt(v);
    else if(k==="UNTIL")out.until=parseICSDate(v);
    else if(k==="BYDAY")out.byDay=v.split(",").map(d=>DOW_RRULE[d.replace(/^[-+0-9]+/,"")]).filter(x=>x!==undefined);
  });
  return out;
}

function expandEvent(ev, horizon){
  const results=[];
  const durMs=ev.end-ev.start;
  if(!ev.rrule){ results.push({start:new Date(ev.start),end:new Date(ev.end)}); return results; }
  const r=ev.rrule;
  const exDates=new Set((ev.exdates||[]).map(d=>d.toISOString().slice(0,10)));
  const interval=r.interval||1;
  const maxIter=400;
  let cur=new Date(ev.start); let iter=0; let emitted=0;
  const until=r.until||new Date(horizon.getTime()+90*86400000);
  while(iter<maxIter&&cur<=until&&cur<=horizon){
    iter++;
    let candidates=[cur];
    if(r.freq==="WEEKLY"&&r.byDay&&r.byDay.length){
      const weekStart=new Date(cur); weekStart.setDate(cur.getDate()-cur.getDay());
      candidates=r.byDay.map(d=>{ const x=new Date(weekStart); x.setDate(weekStart.getDate()+d); x.setHours(cur.getHours(),cur.getMinutes(),0,0); return x; });
    }
    for(const c of candidates){
      if(c<ev.start)continue;
      if(c>until||c>horizon)continue;
      if(exDates.has(c.toISOString().slice(0,10)))continue;
      results.push({start:new Date(c),end:new Date(c.getTime()+durMs)});
      emitted++;
      if(r.count&&emitted>=r.count)return results;
    }
    if(r.freq==="DAILY") cur.setDate(cur.getDate()+interval);
    else if(r.freq==="WEEKLY") cur.setDate(cur.getDate()+7*interval);
    else if(r.freq==="MONTHLY") cur.setMonth(cur.getMonth()+interval);
    else if(r.freq==="YEARLY") cur.setFullYear(cur.getFullYear()+interval);
    else break;
  }
  return results;
}

export function parseICS(text){
  const events=[];
  const blocks=text.split("BEGIN:VEVENT");
  const horizon=new Date(); horizon.setDate(horizon.getDate()+60);
  for(let i=1;i<blocks.length;i++){
    const b=blocks[i];
    const get=k=>{ const m=b.match(new RegExp(`${k}[^:]*:([^\r\n]+)`)); return m?m[1].trim():""; };
    const getAll=k=>{ const re=new RegExp(`${k}[^:]*:([^\r\n]+)`,"g"); const out=[]; let m; while((m=re.exec(b))!==null)out.push(m[1].trim()); return out; };
    const title=get("SUMMARY"),start=parseICSDate(get("DTSTART")),end=parseICSDate(get("DTEND"));
    const rruleStr=get("RRULE");
    const exdates=getAll("EXDATE").map(parseICSDate).filter(Boolean);
    if(!start||!title)continue;
    const endD=end||new Date(start.getTime()+3600000);
    const rrule=rruleStr?parseRRule(rruleStr):null;
    const occurrences=expandEvent({start,end:endD,rrule,exdates},horizon);
    for(const occ of occurrences){
      let startH=occ.start.getHours()+occ.start.getMinutes()/60;
      let endH=occ.end.getHours()+occ.end.getMinutes()/60;
      if(fmt(occ.start)!==fmt(occ.end)) endH=24;
      if(endH<=startH) endH=Math.min(24,startH+(occ.end-occ.start)/3600000);
      events.push({
        title,start:occ.start,end:occ.end,
        date:fmt(occ.start),
        startH,endH,
        hasMargin:needsMargin(title),
      });
    }
  }
  return events;
}

export const ICS_CACHE={};

export async function fetchICS(member){
  const url=member.avail?.icsUrl;
  if(!url)return[];
  if(ICS_CACHE[member.id])return ICS_CACHE[member.id];
  try{
    const proxy=`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
    const res=await fetch(proxy);
    const text=await res.text();
    const events=parseICS(text);
    ICS_CACHE[member.id]=events;
    return events;
  }catch(e){ return[]; }
}
