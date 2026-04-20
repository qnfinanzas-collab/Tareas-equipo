import { fmt } from "./date.js";
import { needsMargin } from "./availability.js";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

// Unfolds RFC 5545 line continuations (CRLF + space/tab)
function unfold(text){ return text.replace(/\r?\n[ \t]/g, ""); }

export function parseICSDate(s){
  if(!s) return null;
  const isUTC = /Z\s*$/.test(s);
  const c = s.replace(/[^0-9T]/g,"");
  if(c.length===8) return new Date(`${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}T00:00:00`);
  if(c.length>=15){
    const iso = `${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}T${c.slice(9,11)}:${c.slice(11,13)}:${c.slice(13,15)}${isUTC?"Z":""}`;
    return new Date(iso);
  }
  return null;
}

const DOW_RRULE = {SU:0,MO:1,TU:2,WE:3,TH:4,FR:5,SA:6};

function parseRRule(s){
  const out = {};
  s.split(";").forEach(p=>{
    const [k,v] = p.split("=");
    if(!k||!v) return;
    if(k==="FREQ") out.freq = v;
    else if(k==="INTERVAL") out.interval = parseInt(v)||1;
    else if(k==="COUNT") out.count = parseInt(v);
    else if(k==="UNTIL") out.until = parseICSDate(v);
    else if(k==="BYDAY") out.byDay = v.split(",").map(d=>DOW_RRULE[d.replace(/^[-+0-9]+/,"")]).filter(x=>x!==undefined);
  });
  return out;
}

function expandEvent(ev, horizon){
  const results = [];
  const durMs = ev.end - ev.start;
  if(!ev.rrule){ results.push({start:new Date(ev.start), end:new Date(ev.end)}); return results; }
  const r = ev.rrule;
  const exDates = new Set((ev.exdates||[]).map(d=>d.toISOString().slice(0,10)));
  const interval = r.interval||1;
  const maxIter = 400;
  let cur = new Date(ev.start); let iter = 0; let emitted = 0;
  const until = r.until || new Date(horizon.getTime()+90*86400000);
  while(iter<maxIter && cur<=until && cur<=horizon){
    iter++;
    let candidates = [cur];
    if(r.freq==="WEEKLY" && r.byDay && r.byDay.length){
      const weekStart = new Date(cur); weekStart.setDate(cur.getDate()-cur.getDay());
      candidates = r.byDay.map(d=>{ const x=new Date(weekStart); x.setDate(weekStart.getDate()+d); x.setHours(cur.getHours(),cur.getMinutes(),0,0); return x; });
    }
    for(const c of candidates){
      if(c<ev.start) continue;
      if(c>until||c>horizon) continue;
      if(exDates.has(c.toISOString().slice(0,10))) continue;
      results.push({start:new Date(c), end:new Date(c.getTime()+durMs)});
      emitted++;
      if(r.count && emitted>=r.count) return results;
    }
    if(r.freq==="DAILY") cur.setDate(cur.getDate()+interval);
    else if(r.freq==="WEEKLY") cur.setDate(cur.getDate()+7*interval);
    else if(r.freq==="MONTHLY") cur.setMonth(cur.getMonth()+interval);
    else if(r.freq==="YEARLY") cur.setFullYear(cur.getFullYear()+interval);
    else break;
  }
  return results;
}

// Splits an occurrence spanning multiple days into one entry per day, with clamped hours.
function splitByDay(occ, title){
  const out = [];
  const start = new Date(occ.start);
  const end = new Date(occ.end);
  const sameDay = fmt(start)===fmt(end);
  if(sameDay){
    const startH = start.getHours()+start.getMinutes()/60;
    let endH = end.getHours()+end.getMinutes()/60;
    if(endH<=startH) endH = Math.min(24, startH + (end-start)/3600000);
    out.push({ date: fmt(start), startH, endH });
    return out;
  }
  // Multi-day: emit first day (start→24), intermediate days (0→24), final day (0→endH)
  let cursor = new Date(start);
  cursor.setHours(0,0,0,0);
  const lastDay = new Date(end);
  lastDay.setHours(0,0,0,0);
  while(cursor <= lastDay){
    const isFirst = fmt(cursor)===fmt(start);
    const isLast  = fmt(cursor)===fmt(end);
    const startH = isFirst ? start.getHours()+start.getMinutes()/60 : 0;
    const rawEndH = isLast ? end.getHours()+end.getMinutes()/60 : 24;
    // Skip zero-length segments (e.g. all-day event ending at next-day midnight)
    if(rawEndH<=startH){ cursor.setDate(cursor.getDate()+1); continue; }
    out.push({ date: fmt(cursor), startH, endH: rawEndH });
    cursor.setDate(cursor.getDate()+1);
  }
  return out;
}

export function parseICS(text){
  const events = [];
  const unfolded = unfold(text);
  const blocks = unfolded.split("BEGIN:VEVENT");
  const horizon = new Date(); horizon.setDate(horizon.getDate()+60);
  for(let i=1;i<blocks.length;i++){
    const b = blocks[i];
    const get    = k => { const m = b.match(new RegExp(`${k}[^:]*:([^\r\n]+)`)); return m ? m[1].trim() : ""; };
    const getAll = k => { const re = new RegExp(`${k}[^:]*:([^\r\n]+)`,"g"); const out=[]; let m; while((m=re.exec(b))!==null) out.push(m[1].trim()); return out; };
    const title = get("SUMMARY");
    const start = parseICSDate(get("DTSTART"));
    const end   = parseICSDate(get("DTEND"));
    const rruleStr = get("RRULE");
    const exdates  = getAll("EXDATE").map(parseICSDate).filter(Boolean);
    if(!start || !title) continue;
    const endD  = end || new Date(start.getTime()+3600000);
    const rrule = rruleStr ? parseRRule(rruleStr) : null;
    const occurrences = expandEvent({start, end:endD, rrule, exdates}, horizon);
    const margin = needsMargin(title);
    for(const occ of occurrences){
      for(const seg of splitByDay(occ, title)){
        events.push({
          title,
          start: occ.start,
          end:   occ.end,
          date:  seg.date,
          startH: seg.startH,
          endH:   seg.endH,
          hasMargin: margin,
        });
      }
    }
  }
  return events;
}

// Cache: { [memberId]: { events, ts } }
export const ICS_CACHE = {};

function cacheEntry(id){
  const e = ICS_CACHE[id];
  if(!e) return null;
  // Back-compat: legacy array entries treated as fresh
  if(Array.isArray(e)) return { events:e, ts:Date.now() };
  if(Date.now() - e.ts > CACHE_TTL_MS) return null;
  return e;
}

export function getCachedEvents(id){
  const e = cacheEntry(id);
  return e ? e.events : null;
}

export function isCacheFresh(id){
  const e = ICS_CACHE[id];
  if(!e) return false;
  if(Array.isArray(e)) return true;
  return Date.now() - e.ts <= CACHE_TTL_MS;
}

export async function fetchICS(member){
  const url = member.avail?.icsUrl;
  if(!url) return [];
  const fresh = cacheEntry(member.id);
  if(fresh) return fresh.events;
  const proxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxy);
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const events = parseICS(text);
  ICS_CACHE[member.id] = { events, ts: Date.now() };
  return events;
}
