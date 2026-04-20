import { TRANSPORT_KW } from "./constants.js";
import { fmt, toH } from "./date.js";

export function needsMargin(title){
  return TRANSPORT_KW.some(k=>(title||"").toLowerCase().includes(k));
}

export function calcFreeInRange(dayEvents, member, dateStr, rangeStart, rangeEnd){
  const avail=member.avail;
  const margin=(avail.transportMarginMins||30)/60;
  const dow=new Date(dateStr).getDay();
  const fixed=(avail.blockedSlots||[]).filter(b=>b.days.includes(dow)).map(b=>({s:toH(b.start),e:toH(b.end)})).filter(b=>b.e>rangeStart&&b.s<rangeEnd).map(b=>({s:Math.max(rangeStart,b.s),e:Math.min(rangeEnd,b.e)}));
  const cal=dayEvents.filter(e=>e.endH>rangeStart&&e.startH<rangeEnd).map(e=>({
    s:Math.max(rangeStart,e.hasMargin?e.startH-margin:e.startH),
    e:Math.min(rangeEnd,e.hasMargin?e.endH+margin:e.endH),
  }));
  const blocks=[...fixed,...cal].sort((a,b)=>a.s-b.s);
  const free=[]; let cur=rangeStart;
  for(const b of blocks){
    if(b.s>cur+0.25) free.push({start:cur,end:b.s,hours:b.s-cur});
    cur=Math.max(cur,b.e);
  }
  if(rangeEnd>cur+0.25) free.push({start:cur,end:rangeEnd,hours:rangeEnd-cur});
  return free;
}

export function calcFreeSlots(dayEvents, member, dateStr){
  const avail=member.avail;
  return calcFreeInRange(dayEvents,member,dateStr,toH(avail.afternoonStart||"14:30"),toH(avail.afternoonEnd||"20:00"));
}

export function calcFreeMorning(dayEvents, member, dateStr){
  const avail=member.avail;
  return calcFreeInRange(dayEvents,member,dateStr,toH(avail.morningStart||"08:00"),toH(avail.morningEnd||"13:00"));
}

export function getAvailHours(member,dateStr){
  const a=member.avail;
  const dow=new Date(dateStr).getDay();
  if(!a.workDays.includes(dow))return 0;
  const exc=a.exceptions?.find(e=>e.date===dateStr);
  if(exc?.type==="off")return 0;
  if(exc?.type==="half")return a.hoursPerDay/2;
  return a.hoursPerDay;
}

export function getBlockLabels(member,dateStr){
  const dow=new Date(dateStr).getDay();
  return(member.avail?.blockedSlots||[]).filter(b=>b.days.includes(dow)).map(b=>`${b.label}`);
}

export function getWorkDays(from,n){
  const res=[]; const d=new Date(from); let c=0;
  while(res.length<n&&c<90){ if(d.getDay()!==0&&d.getDay()!==6)res.push(fmt(d)); d.setDate(d.getDate()+1); c++; }
  return res;
}
