import { DOW } from "./constants.js";

export const TODAY = new Date(); TODAY.setHours(0,0,0,0);

export const fmt = d => d.toISOString().slice(0,10);

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
