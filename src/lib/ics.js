import { fmt } from "./date.js";
import { needsMargin } from "./availability.js";

export function parseICSDate(s){
  if(!s)return null;
  const c=s.replace(/[^0-9T]/g,"");
  if(c.length===8) return new Date(`${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}T00:00:00`);
  if(c.length>=15) return new Date(`${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}T${c.slice(9,11)}:${c.slice(11,13)}:${c.slice(13,15)}Z`);
  return null;
}

export function parseICS(text){
  const events=[];
  const blocks=text.split("BEGIN:VEVENT");
  for(let i=1;i<blocks.length;i++){
    const b=blocks[i];
    const get=k=>{ const m=b.match(new RegExp(`${k}[^:]*:([^\r\n]+)`)); return m?m[1].trim():""; };
    const title=get("SUMMARY"),start=parseICSDate(get("DTSTART")),end=parseICSDate(get("DTEND"));
    if(start&&end&&title){
      events.push({
        title,start,end,
        date:fmt(start),
        startH:start.getHours()+start.getMinutes()/60,
        endH:end.getHours()+end.getMinutes()/60,
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
