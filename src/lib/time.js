export function fmtSecs(s){
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60;
  return h>0?`${h}h ${m}m`:`${m}m ${sc}s`;
}

export function fmtH(s){ return (s/3600).toFixed(1)+"h"; }
