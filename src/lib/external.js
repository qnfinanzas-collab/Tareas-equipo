import { QM } from "./constants.js";

export function gCalUrl(task,slot){
  const base="https://calendar.google.com/calendar/render?action=TEMPLATE";
  const title=encodeURIComponent(`[TaskFlow] ${task.title}`);
  const d=(slot?.date||task.dueDate||"").replace(/-/g,"");
  const st=(slot?.startTime||"09:00").replace(":","");
  const eh=Math.min(23,Math.floor(parseInt(st.slice(0,2))+(slot?.hours||1)));
  const et=`${String(eh).padStart(2,"0")}${st.slice(2)}`;
  const dates=d?`&dates=${d}T${st}00/${d}T${et}00`:"";
  const desc=encodeURIComponent(`Prioridad: ${task.priority}\nEstimado: ${task.estimatedHours||"?"}h\nTaskFlow #${task.id}`);
  return `${base}&text=${title}${dates}&details=${desc}`;
}

export function waUrl(member,msg){
  const phone=(member?.avail?.whatsapp||"").replace(/[^0-9]/g,"");
  if(!phone)return null;
  return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}

export function waMsg(member,slots,log){
  const my=log.filter(l=>l.memberId===member.id);
  if(!my.length)return `Hola ${member.name.split(" ")[0]}! Sin tareas nuevas esta semana en TaskFlow.`;
  const lines=my.slice(0,4).map(l=>`- ${l.taskTitle} (${l.totalScheduled.toFixed(1)}h) ${QM[l.quadrant]?.icon||""}`);
  return `Hola ${member.name.split(" ")[0]}! TaskFlow ha planificado tus tareas:\n\n${lines.join("\n")}\n\nRevisa el planificador para los detalles.`;
}
