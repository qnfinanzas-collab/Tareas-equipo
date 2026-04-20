import { DOW } from "./constants.js";

export const TODAY = new Date(); TODAY.setHours(0,0,0,0);

// Local-date YYYY-MM-DD — using toISOString() would shift by TZ offset near midnight.
export const fmt = d => {
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
};

export const D = n => { const d=new Date(TODAY); d.setDate(d.getDate()+n); return fmt(d); };

export const dayName = d => DOW[new Date(d).getDay()];

export function daysUntil(s){
  if(!s)return 999;
  const d=new Date(s); d.setHours(0,0,0,0);
  return Math.ceil((d-TODAY)/86400000);
}

export function toH(t){ const[h,m]=(t||"0:0").split(":").map(Number); return h+m/60; }

export function fromH(dec){
  const h=Math.floor(dec),m=Math.round((dec-h)*60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}
