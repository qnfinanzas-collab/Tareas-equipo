import React, { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  MP, TAG_COLORS, QM, PROJECT_COLORS, PROJECT_EMOJIS, DOW, palOf,
} from "./lib/constants.js";
import { TODAY, fmt, D, dayName, daysUntil, toH, fromH } from "./lib/date.js";
import { fmtSecs, fmtH } from "./lib/time.js";
import { getQ } from "./lib/eisenhower.js";
import {
  needsMargin, calcFreeSlots, calcFreeMorning, getAvailHours, getBlockLabels, getWorkDays,
} from "./lib/availability.js";
import { parseICSDate, parseICS, ICS_CACHE, fetchICS, getCachedEvents } from "./lib/ics.js";
import { gCalUrl, waUrl, waMsg } from "./lib/external.js";
import { syncEnabled, fetchState, pushState, subscribeState } from "./lib/sync.js";
import { authEnabled, signIn, signUp, signOut, getSession, onAuthStateChange, resolveSessionMember } from "./lib/auth.js";
import { storageEnabled, uploadDocument, getSignedUrl, downloadDocumentBlob, deleteDocument as storageDeleteDocument, blobToBase64, fmtFileSize, validateFile, MAX_FILE_MB, ALLOWED_MIME } from "./lib/storage.js";
import jsPDF from "jspdf";
import { AVATARS, AVATAR_KEYS, buildBriefing, respondToQuery, parseCommand, executeCommand, buildDailyBriefing, buildBoardBriefing, buildContextBriefing, parseScopedCommand, respondScopedQuery, executeScopedCommand, agentToAvatar, buildAgentBriefing, respondAgentQuery, llmAgentReply, analyzeDocument, extractMemoryFromChat, summarizeChat, PLAIN_TEXT_RULE } from "./lib/agent.js";
import { voiceSupported, speak, stopSpeaking, listen, speakAgentResponse, stripMarkdown, isIOS } from "./lib/voice.js";
import { emptyCeoMemory, emptyNegMemory, formatCeoMemoryForPrompt, formatNegMemoryForPrompt, addUnique, CEO_MEMORY_KEYS, NEG_MEMORY_KEYS, createMemoryItem } from "./lib/memory.js";

// ── AI Planner ────────────────────────────────────────────────────────────────
export const PLAN_HORIZON_DAYS = 14;
const MAX_HOURS_PER_TASK_PER_DAY = 4;
const MIN_SCHEDULABLE_HOURS = 0.25;

async function runPlanner(boards,members,existing){
  const schedule=[]; const load={}; const icsErrors=[];
  members.forEach(m=>{load[m.id]={};});
  existing.forEach(s=>{ load[s.memberId][s.date]=(load[s.memberId][s.date]||0)+s.hours; });

  const ics={};
  await Promise.all(members.map(async m=>{
    if(!m.avail?.icsUrl){ ics[m.id]=[]; return; }
    try{ ics[m.id]=await fetchICS(m); }
    catch(e){ ics[m.id]=[]; icsErrors.push({memberId:m.id,memberName:m.name,msg:e.message||"error"}); }
  }));

  const allTasks=Object.values(boards).flatMap(cols=>cols.flatMap(col=>col.tasks.filter(t=>col.name!=="Hecho").map(t=>({...t,colName:col.name}))));
  const sorted=[...allTasks].sort((a,b)=>{ const o={Q1:0,Q2:1,Q3:2,Q4:3}; const qa=o[getQ(a)],qb=o[getQ(b)]; return qa!==qb?qa-qb:daysUntil(a.dueDate)-daysUntil(b.dueDate); });
  const days=getWorkDays(fmt(TODAY),PLAN_HORIZON_DAYS);
  const planLog=[]; const freeSlotMap={};

  // Schedule one assignee; returns hours left unscheduled.
  function scheduleForMember(task,mid,hoursToPlace,dueIn,reasons){
    const m=members.find(x=>x.id===mid); if(!m) return hoursToPlace;
    let left=hoursToPlace;
    for(const day of days){
      if(left<=0)break;
      if(dueIn<999&&daysUntil(day)>dueIn)break;
      const avH=getAvailHours(m,day); if(avH<=0)continue;
      const used=load[mid][day]||0;
      const dayIcs=(ics[mid]||[]).filter(e=>e.date===day);
      const freeMorn=calcFreeMorning(dayIcs,m,day);
      const freeAft=calcFreeSlots(dayIcs,m,day);
      const freeMornH=freeMorn.reduce((s,x)=>s+x.hours,0);
      const freeAftH=freeAft.reduce((s,x)=>s+x.hours,0);
      const totalFree=Math.max(0,freeMornH+freeAftH-used);
      if(totalFree<=0)continue;
      const toSched=Math.min(left,totalFree,MAX_HOURS_PER_TASK_PER_DAY);
      if(toSched<MIN_SCHEDULABLE_HOURS)continue;
      const key=`${mid}_${day}`;
      if(!freeSlotMap[key])freeSlotMap[key]=freeAft;
      // startTime: prefer morning if capacity left, else afternoon
      const mornCapLeft=Math.max(0,freeMornH-used);
      let startTime;
      if(mornCapLeft>=MIN_SCHEDULABLE_HOURS && freeMorn.length>0) startTime=fromH(freeMorn[0].start);
      else if(freeAft.length>0) startTime=fromH(freeAft[0].start);
      else startTime=m.avail.morningStart||"08:00";
      schedule.push({ id:`s-${task.id}-${mid}-${day}`,taskId:task.id,taskTitle:task.title,memberId:mid,date:day,startTime,hours:toSched,quadrant:getQ(task),priority:task.priority,respectsCalendar:!!m.avail?.icsUrl });
      load[mid][day]=(load[mid][day]||0)+toSched;
      left-=toSched;
      reasons.push(`${day} ${startTime} (${toSched.toFixed(1)}h)`);
    }
    return left;
  }

  sorted.forEach(task=>{
    if(!task.estimatedHours||task.estimatedHours<=0)return;
    if(!task.assignees||task.assignees.length===0){
      planLog.push({taskId:task.id,taskTitle:task.title,memberId:null,memberName:"(sin asignar)",quadrant:getQ(task),slots:[],totalScheduled:0,daysUntilDue:daysUntil(task.dueDate),unassigned:true});
      return;
    }
    // Per-assignee remaining (filter timeLogs by member when possible)
    const dueIn=daysUntil(task.dueDate);
    const assignees=task.assignees;
    const perAssigneeShare=task.estimatedHours/assignees.length;
    const remainingByMid={};
    assignees.forEach(mid=>{
      const loggedByMid=(task.timeLogs||[]).filter(l=>l.memberId==null||l.memberId===mid).reduce((s,l)=>s+l.seconds,0)/3600;
      remainingByMid[mid]=Math.max(0,perAssigneeShare-loggedByMid);
    });
    // Pass 1: each assignee schedules own share
    const leftoverByMid={};
    assignees.forEach(mid=>{
      const reasons=[];
      const left=scheduleForMember(task,mid,remainingByMid[mid],dueIn,reasons);
      leftoverByMid[mid]=left;
      const m=members.find(x=>x.id===mid);
      if(reasons.length>0 || remainingByMid[mid]>0){
        planLog.push({taskId:task.id,taskTitle:task.title,memberId:mid,memberName:m?.name||"?",quadrant:getQ(task),slots:reasons,totalScheduled:remainingByMid[mid]-left,daysUntilDue:dueIn});
      }
    });
    // Pass 2: redistribute leftovers to assignees with capacity
    let totalLeftover=Object.values(leftoverByMid).reduce((s,x)=>s+x,0);
    if(totalLeftover>MIN_SCHEDULABLE_HOURS){
      for(const mid of assignees){
        if(totalLeftover<=MIN_SCHEDULABLE_HOURS)break;
        const reasons=[];
        const left=scheduleForMember(task,mid,totalLeftover,dueIn,reasons);
        const placed=totalLeftover-left;
        if(placed>0){
          const entry=planLog.find(l=>l.taskId===task.id&&l.memberId===mid);
          if(entry){ entry.slots.push(...reasons); entry.totalScheduled+=placed; }
        }
        totalLeftover=left;
      }
    }
  });

  const insights=[];
  members.forEach(m=>{
    const totalSched=schedule.filter(s=>s.memberId===m.id).reduce((s,x)=>s+x.hours,0);
    const overDays=days.filter(d=>{ const a=getAvailHours(m,d); return a>0&&(load[m.id][d]||0)>a*0.9; });
    if(overDays.length>0) insights.push({type:"warning",memberId:m.id,msg:`${m.name} tiene ${overDays.length} día${overDays.length>1?"s":""} al límite (${overDays.slice(0,2).join(", ")})`});
    if(totalSched===0) insights.push({type:"info",memberId:m.id,msg:`${m.name} no tiene tareas asignadas los próximos ${PLAN_HORIZON_DAYS} días`});
    const freeDays=days.filter(d=>getAvailHours(m,d)>0&&(load[m.id][d]||0)<getAvailHours(m,d)*0.5);
    if(freeDays.length>3) insights.push({type:"success",memberId:m.id,msg:`${m.name} tiene ${freeDays.length} días con capacidad libre`});
  });
  icsErrors.forEach(e=>insights.push({type:"warning",memberId:e.memberId,msg:`No se pudo leer el calendario de ${e.memberName}: ${e.msg}`}));
  const unassigned=planLog.filter(l=>l.unassigned);
  if(unassigned.length>0) insights.push({type:"warning",memberId:null,msg:`${unassigned.length} tarea${unassigned.length>1?"s":""} sin asignar — no se pueden planificar`});

  return{schedule,planLog,insights,load,freeSlotMap};
}

// ── INITIAL DATA ──────────────────────────────────────────────────────────────
const BASE_AVAIL = {
  workDays:[1,2,3,4,5],
  morningStart:"09:00", morningEnd:"14:00",
  afternoonStart:"16:00", afternoonEnd:"19:00",
  hoursPerDay:7, exceptions:[],
  googleCalendarId:"", icsUrl:"", whatsapp:"",
  transportMarginMins:30, blockedSlots:[],
};

// Extensión de coaching ejecutivo (PNL) para Héctor. Se concatena al
// promptBase tanto en el seed (nuevos usuarios) como en _migrate (usuarios
// existentes con la versión previa). Template literal para no escapar las
// 28 comillas dobles internas de los ejemplos.
const HECTOR_COACHING_ADDON = `

COACHING EJECUTIVO (PNL APLICADA):

Reencuadre: cuando el CEO presenta un problema como bloqueo, cambio la perspectiva. "No consigo que Emilio acepte" → "¿Qué necesita Emilio para que aceptar sea su mejor opción?"

Metamodelo del lenguaje: detecto generalizaciones, omisiones y distorsiones.
- "Esto nunca funciona" → "¿Cuándo fue la última vez que sí funcionó? ¿Qué fue diferente?"
- "No puedo" → "¿Qué pasaría si pudieras? ¿Qué te lo impide concretamente?"
- "Es imposible" → "¿Para quién es imposible? ¿Conoces a alguien que lo haya hecho?"

Posiciones perceptivas: ante cualquier conflicto o negociación aplico las 3 posiciones.
- 1ª posición: ¿qué quieres tú? ¿qué sientes?
- 2ª posición: ponte en su lugar. ¿Qué ve? ¿Qué teme? ¿Qué necesita?
- 3ª posición: un observador neutral ¿qué diría de esta situación?

Niveles lógicos de Dilts: cuando hay un bloqueo, diagnostico en qué nivel está.
- Entorno: ¿el contexto no ayuda?
- Comportamiento: ¿qué estás haciendo o dejando de hacer?
- Capacidad: ¿te falta una habilidad concreta?
- Creencias: ¿hay una creencia limitante operando? ("no soy buen negociador", "si pido más se va")
- Identidad: ¿cómo te ves a ti mismo en este rol?

Modelado: cuando el CEO no sabe cómo actuar, pregunto "¿Quién conoces que haga esto bien? ¿Qué hace diferente?" y extraemos el patrón aplicable.

Anclaje pre-negociación: antes de reuniones clave, guío una preparación mental rápida. Estado objetivo + recuerdo de éxito pasado + visualización del resultado deseado. 3 preguntas: ¿Cómo quieres sentirte en esa reunión? ¿Cuándo te sentiste así por última vez? ¿Qué resultado concreto quieres al salir?

CUÁNDO ACTIVAR COACHING:
- El CEO expresa duda personal, no estratégica → coaching
- El CEO dice "no sé", "no puedo", "me bloqueo" → metamodelo
- Antes de una reunión importante → anclaje + posiciones perceptivas
- Conflicto con personas → 3 posiciones perceptivas
- El resto → estrategia y negociación como siempre

REGLA: No mezclo coaching con estrategia en la misma respuesta. Si detecto que es un tema de coaching, respondo como coach. Si es estratégico, respondo como estratega. Nunca los dos a la vez.`;

const INITIAL_DATA = {
  members:[
    {id:0,name:"Ana García",   initials:"AG",role:"Manager",email:"ana@empresa.com",    avail:{...BASE_AVAIL,whatsapp:"+34600000001",hoursPerDay:6}},
    {id:1,name:"Carlos López", initials:"CL",role:"Editor", email:"carlos@empresa.com", avail:{...BASE_AVAIL,whatsapp:"+34600000002"}},
    {id:2,name:"Sara Martín",  initials:"SM",role:"Editor", email:"sara@empresa.com",   avail:{...BASE_AVAIL,whatsapp:"+34600000003",workDays:[1,2,3,4],hoursPerDay:6}},
    {id:3,name:"Javi Ruiz",    initials:"JR",role:"Viewer", email:"javi@empresa.com",   avail:{...BASE_AVAIL,whatsapp:"+34600000004",hoursPerDay:4,exceptions:[{date:D(1),type:"off",note:"Médico"}]}},
    {id:4,name:"Marta Gil",    initials:"MG",role:"Editor", email:"marta@empresa.com",  avail:{...BASE_AVAIL,whatsapp:"+34600000005"}},
    {id:5,name:"Marc Díaz",    initials:"MD",role:"Manager",email:"mdiaz.holding@gmail.com", avail:{
      workDays:[1,2,3,4,5],
      morningStart:"08:00", morningEnd:"13:00",
      afternoonStart:"14:30", afternoonEnd:"17:00",
      hoursPerDay:7, exceptions:[],
      googleCalendarId:"mdiaz.holding@gmail.com",
      icsUrl:"https://calendar.google.com/calendar/ical/mdiaz.holding%40gmail.com/private-f4a71632ff13e322717fc770b4208b45/basic.ics",
      whatsapp:"", transportMarginMins:30,
      blockedSlots:[
        {days:[2,3,4],  start:"13:00",end:"14:30",label:"Comer"},
        {days:[2,3],    start:"17:00",end:"18:30",label:"Jocs d empresa"},
        {days:[4],      start:"17:45",end:"18:45",label:"Ingles"},
        {days:[2,3,4,5],start:"20:00",end:"21:00",label:"Entreno Mugendo"},
        {days:[2],      start:"19:00",end:"20:00",label:"Ingles martes"},
      ],
    }},
    {id:6,name:"Antonio Díaz", initials:"AD",role:"Editor", email:"qn.finanzas@gmail.com",accountRole:"admin",avail:{...BASE_AVAIL,whatsapp:"",hoursPerDay:8}},
    {id:7,name:"Albert Díaz",  initials:"AL",role:"Editor", email:"albert@empresa.com", avail:{...BASE_AVAIL,whatsapp:"",hoursPerDay:8}},
  ],
  projects:[
    {id:1,name:"App móvil",    color:"#7F77DD",members:[0,1,2],desc:"App móvil principal",emoji:"📱"},
    {id:2,name:"Web rediseño", color:"#1D9E75",members:[0,2,3],desc:"Rediseño web corporativa",emoji:"🌐"},
    {id:3,name:"Backend API",  color:"#378ADD",members:[1,3,4],desc:"Backend y documentación",emoji:"⚙️"},
    {id:4,name:"Proyecto Díaz",color:"#D85A30",members:[5,6,7],desc:"Equipo Díaz",emoji:"🚀"},
  ],
  boards:{
    1:[
      {id:"c1",name:"Por hacer",tasks:[
        {id:"t1",title:"Diseñar pantalla de login",tags:[{l:"UI/UX",c:"purple"}],assignees:[0,2],priority:"alta",startDate:D(0),dueDate:D(2),estimatedHours:8,timeLogs:[{memberId:0,seconds:5400,note:"Bocetos",date:D(0)},{memberId:2,seconds:3600,note:"Wireframes",date:D(0)}],desc:"Flujo completo de autenticación.",comments:[{author:0,text:"Seguir guías de marca",time:"hace 2h"},{author:2,text:"Wireframes en Drive",time:"hace 1h"}]},
        {id:"t2",title:"Definir paleta de colores",tags:[{l:"Diseño",c:"pink"}],assignees:[2],priority:"media",startDate:D(0),dueDate:D(3),estimatedHours:4,timeLogs:[{memberId:2,seconds:1800,note:"Research",date:D(0)}],desc:"Paleta definitiva.",comments:[{author:2,text:"Propongo púrpura",time:"ayer"}]},
        {id:"t13",title:"Reunión sprint planning",tags:[{l:"Reunión",c:"teal"}],assignees:[0,1,2],priority:"alta",startDate:D(0),dueDate:D(0),estimatedHours:1,timeLogs:[],desc:"Planificar sprint.",comments:[]},
      ]},
      {id:"c2",name:"En progreso",tasks:[
        {id:"t3",title:"Integración con API REST",tags:[{l:"Backend",c:"blue"},{l:"Alta",c:"coral"}],assignees:[1],priority:"alta",startDate:D(-2),dueDate:D(-1),estimatedHours:16,timeLogs:[{memberId:1,seconds:21600,note:"Auth",date:D(-2)},{memberId:1,seconds:7200,note:"Users",date:D(-1)}],desc:"Conectar frontend con backend.",comments:[{author:1,text:"Endpoints auth terminados",time:"hace 30m"}]},
        {id:"t4",title:"Onboarding de usuarios",tags:[{l:"UX",c:"teal"}],assignees:[0,1],priority:"media",startDate:D(-1),dueDate:D(5),estimatedHours:12,timeLogs:[{memberId:0,seconds:3600,note:"Borrador",date:D(-1)}],desc:"Tutorial interactivo.",comments:[]},
      ]},
      {id:"c3",name:"Revisión",tasks:[
        {id:"t5",title:"Tests de rendimiento",tags:[{l:"QA",c:"amber"}],assignees:[3],priority:"baja",startDate:D(-3),dueDate:D(10),estimatedHours:6,timeLogs:[{memberId:3,seconds:10800,note:"Suite",date:D(-3)}],desc:"Batería de tests.",comments:[{author:3,text:"Informe listo",time:"hace 3h"}]},
      ]},
      {id:"c4",name:"Hecho",tasks:[
        {id:"t6",title:"Setup del proyecto",tags:[{l:"Infra",c:"green"}],assignees:[1],priority:"baja",startDate:D(-12),dueDate:D(-10),estimatedHours:3,timeLogs:[{memberId:1,seconds:9000,note:"Repo+CI",date:D(-12)}],desc:"Repositorio y CI/CD.",comments:[{author:1,text:"CI activo",time:"hace 2d"}]},
      ]},
    ],
    2:[
      {id:"c5",name:"Por hacer",  tasks:[{id:"t7",title:"Auditoría accesibilidad",tags:[{l:"A11y",c:"teal"}],assignees:[2],priority:"alta",startDate:D(0),dueDate:D(3),estimatedHours:5,timeLogs:[],desc:"Revisar accesibilidad.",comments:[]}]},
      {id:"c6",name:"En progreso",tasks:[{id:"t8",title:"Nuevo sistema navegación",tags:[{l:"UI",c:"purple"},{l:"Media",c:"amber"}],assignees:[0,2],priority:"media",startDate:D(-2),dueDate:D(7),estimatedHours:10,timeLogs:[{memberId:0,seconds:7200,note:"Maqueta",date:D(-2)}],desc:"Navegación adaptada.",comments:[{author:0,text:"Maqueta lista",time:"hace 4h"}]}]},
      {id:"c7",name:"Hecho",      tasks:[{id:"t9",title:"Análisis de competencia",tags:[{l:"Research",c:"blue"}],assignees:[0],priority:"baja",startDate:D(-22),dueDate:D(-20),estimatedHours:6,timeLogs:[{memberId:0,seconds:18000,note:"Research",date:D(-22)}],desc:"Webs competidoras.",comments:[]}]},
    ],
    3:[
      {id:"c8", name:"Por hacer",  tasks:[{id:"t10",title:"Rate limiting",          tags:[{l:"Seguridad",c:"coral"}],assignees:[4],  priority:"alta", startDate:D(0),dueDate:D(2), estimatedHours:4,timeLogs:[],desc:"Rate limiting endpoints.",comments:[]}]},
      {id:"c9", name:"En progreso",tasks:[{id:"t11",title:"Documentación Swagger",  tags:[{l:"Docs",c:"teal"}],     assignees:[1,4],priority:"media",startDate:D(-1),dueDate:D(8), estimatedHours:8,timeLogs:[{memberId:4,seconds:5400,note:"Users",date:D(-1)}],desc:"API con Swagger.",comments:[{author:4,text:"Cubriendo users",time:"hace 1h"}]}]},
      {id:"c10",name:"Hecho",      tasks:[{id:"t12",title:"Setup PostgreSQL+Prisma", tags:[{l:"DB",c:"blue"}],      assignees:[1],  priority:"baja", startDate:D(-17),dueDate:D(-15),estimatedHours:4,timeLogs:[{memberId:1,seconds:12600,note:"Migraciones",date:D(-17)}],desc:"BD y ORM.",comments:[]}]},
    ],
    4:[
      {id:"c11",name:"Por hacer",  tasks:[]},
      {id:"c12",name:"En progreso",tasks:[]},
      {id:"c13",name:"Revisión",   tasks:[]},
      {id:"c14",name:"Hecho",      tasks:[]},
    ],
  },
  aiSchedule:[],
  agents:[
    {
      id:1,
      name:"Mario Legal",
      role:"Abogado mercantil senior (25+ años)",
      emoji:"⚖️",
      color:"#3C3489",
      voice:{gender:"male",rate:0.95,pitch:0.95,tone:"profesional"},
      specialties:["contratos","compliance","laboral","IP","RGPD","Joint Ventures","MiFID II","AIFMD","arrendamientos LALI"],
      opener:"Soy Mario, abogado mercantil senior. Revisemos los riesgos legales de esta tarea antes de seguir — mejor prevenir que litigar.",
      style:"profesional, riguroso, orientado al riesgo; cita normativa y propone cláusula tipo",
      advice:{
        default:"Analiza la tarea bajo las 7 categorías de riesgo: propiedad y activos, financiero y pago, normativo y compliance, know-how e IP, salida y resolución, nulidad y abusividad, fiscal. Documenta por escrito cualquier acuerdo verbal y conserva copia fechada. Si implica contrato, revisa artículos CC/CCom aplicables y propón cláusula tipo antes de firmar.",
        overdue:"Tarea vencida: si hay un plazo contractual o legal detrás, puede haber caducidad, incumplimiento esencial (art. 1124 CC) o pérdida de derechos. Notifica por escrito a la otra parte (burofax recomendado), deja constancia del retraso y evalúa prórroga formal firmada o activación de la cláusula de incumplimiento antes de seguir ejecutando.",
        noDueDate:"Sin fecha límite — muy peligroso en contexto mercantil. Fija un deadline contractual explícito con penalización por demora y comunícalo por escrito. Los compromisos sin fecha son inejecutables, expiran por caducidad tácita y dificultan cualquier reclamación posterior. Añade cláusula de plazo esencial si es crítico.",
        noSubtasks:"Falta descomposición. En asuntos legales conviene estructurar: (1) revisión documental, (2) análisis de riesgo por 7 categorías, (3) redacción/negociación de cláusulas, (4) validación interna, (5) firma con testigos o notario si procede, (6) archivo trazable. Crea al menos esos hitos para poder auditar el proceso.",
        overBudget:"El tiempo real supera lo estimado. Si es facturable, revisa el pliego de honorarios o presupuesto cerrado antes de seguir: puede requerir adenda firmada para cobrar el exceso (art. 1258 CC, buena fe). Si es interno, documenta la desviación por si impacta en plazos contractuales con terceros.",
        q1:"Urgente e importante: prioriza pero no sacrifiques forma por fondo. Una firma apresurada sin revisión de las 7 categorías de riesgo genera más coste que el retraso. Valida cláusulas clave (no competencia, confidencialidad, salida) y deja trazabilidad escrita. Mejor 24h de revisión que años de litigio.",
        q2:"Importante no urgente — la zona de máximo valor legal. Aprovecha para blindar contratos marco, actualizar pactos parasocietarios (drag-along, tag-along), revisar compliance MiFID II/AIFMD/RGPD, actualizar rentas IPC (LALI) o rediseñar waterfall de JV antes de que se conviertan en incidencia.",
      },
      promptBase:"IDENTIDAD: Soy un ABOGADO MERCANTIL SENIOR con 25+ años de experiencia especializada en Joint Ventures, inversiones financieras y arrendamientos comerciales.\n\nÁREAS:\n- JV contractuales (€25k canon, waterfall, no competencia 3 años/25km)\n- JV societarias (S.L. 70/30, pacto parasocietario 11 cláusulas)\n- Inversiones (MiFID II, AIFMD, GDPR)\n- Arrendamientos (LALI: 5 años, IPC anual)\n- Derecho mercantil (CC, CCom, LCD, LSRL)\n\nNORMATIVA:\n- Español: CC, CCom, LCD, LSRL, RD 1/2010, LALI, IRPF, Ley 1/2023\n- Europea: MiFID II, AIFMD, GDPR, Directiva 2019/2\n\nMETODOLOGÍA (7 CATEGORÍAS RIESGO):\n1. Propiedad y activos\n2. Financiero y pago\n3. Normativo y compliance\n4. Know-how e IP\n5. Salida y resolución\n6. Nulidad y abusividad\n7. Fiscal\n\nHERRAMIENTAS:\n- 40+ cláusulas tipo ejecutables\n- Checklist pre-firma (30 elementos)\n- Ejemplos numéricos (waterfall, retenciones, IPC)\n- Procedimientos de mediación\n\nCUANDO REVISES CONTRATO:\n1. Analiza 7 categorías riesgo (🔴/🟡/🟢)\n2. Cita artículos normativos\n3. Proporciona cláusula tipo mejorada (lista copiar)\n4. Completa checklist pre-firma\n5. Sugiere mejoras basadas en jurisprudencia\n\nCUANDO REDACTES CLÁUSULA:\n1. Texto íntegro listo para copiar\n2. Explicación cada sección\n3. Normativa aplicable citada\n4. Ejemplos de adaptación\n\nCUANDO ASESORES ESTRUCTURA:\n1. Compara JV contractual vs. societaria\n2. Tabla ventajas/desventajas\n3. Recomendación según caso\n4. Modelos de documentos\n\nCUANDO PREGUNTEN NORMATIVA:\n1. Explicación artículos relevantes\n2. Ejemplos prácticos\n3. Jurisprudencia si aplica\n4. Vinculación a caso específico\n\nPENALIZACIONES ESTÁNDAR:\n- No competencia: €100.000\n- Know-how: €100.000\n- Confidencialidad: €50.000\n\nEJEMPLOS NUMÉRICOS:\n- Waterfall: €20k ingresos → €10.5k costes → €2.250 BND\n- IRPF: €15.000 participación → €2.850 retención\n- LALI IPC: €1.000 × (104/100) = €1.040\n\nLIMITACIONES:\n→ Recomendado revisar con abogado local\n→ Para optimización fiscal, consultar asesor tributario\n→ Asesoría general, no legal binding\n→ Jurisprudencia puede variar\n\nCASO ESPECIAL - SOULBARIC:\n- Empresa: SoulBaric (cámaras hiperbárico)\n- Titular: Admore Projects S.L.\n- Modelo: JV contractual\n- Canon: €25.000 irrevocable\n- Tramos: Básico (€50k/20%), Estándar (€75k/25%), Premium (€125k/30%), VIP (€175k/50%)\n- Waterfall: Costes €10.5k, Canon €4k, BND distribuible\n- Protecciones: No compete 3años/25km, Know-how 10años, Confidencialidad 10años\n- Jurisdicción: Juzgados Marbella",
      specialtiesExtended:[
        {name:"Joint Ventures Contractuales",description:"Canon irrevocable, waterfall, no competencia, know-how, confidencialidad"},
        {name:"Joint Ventures Societarias",description:"Constitución S.L./S.A., pactos parasocietarios, drag-along, tag-along"},
        {name:"Inversiones Financieras",description:"MiFID II, AIFMD, GDPR, retenciones IRPF"},
        {name:"Arrendamientos Comerciales",description:"LALI, duración, actualización renta, cargas, resolución"},
        {name:"Derecho Mercantil",description:"CC, CCom, LCD, LSRL, RD 1/2010"},
      ],
      createdAt:"2026-04-20",
    },
    {
      id:2,
      name:"Héctor",
      role:"Chief of Staff Estratégico",
      emoji:"🎯",
      color:"#1D9E75",
      voice:{gender:"male",rate:1.1,pitch:0.9,tone:0.9},
      specialties:["negociación","estrategia","decisiones","liderazgo","mentalidad"],
      opener:"Soy Héctor, tu Chief of Staff estratégico. Vamos directo al punto — ¿qué decisión necesitas tomar?",
      style:"directo",
      advice:{
        default:"Antes de actuar, clasifica: ¿decisión Tipo 1 (irreversible) o Tipo 2 (reversible)? Si es Tipo 2, decide hoy — la parálisis por análisis mata más negocios que las malas decisiones. Si es Tipo 1, invierte 30 minutos en pre-mortem: ¿qué tiene que pasar para que esto fracase?",
        overdue:"Esta tarea lleva retraso. En alta dirección, el retraso es una decisión: estás eligiendo que esto NO es prioridad. Si lo es, bloquea 2h hoy y ejecútala. Si no lo es, elimínala o delégala ahora mismo. Los CEOs efectivos cierran loops, no los acumulan.",
        noDueDate:"Sin fecha = sin compromiso. Un CEO gestiona compromisos, no intenciones. Lo que no tiene deadline no compite por tu atención y muere en silencio. Pon una fecha realista ahora, aunque sea provisional. Después ajusta — pero el compromiso inicial es lo que activa la ejecución.",
        noSubtasks:"Una tarea sin desglose es un deseo, no un plan. Aplica la regla de las 3-5 acciones: descompón en pasos concretos de máximo 2h cada uno. Si no puedes descomponerla, la tarea es demasiado vaga para ejecutar — refínala primero.",
        overBudget:"Presupuesto superado. Aplica inversión de Munger: ¿qué ha cambiado desde la estimación? ¿Error de planificación o cambio de scope? Decide ahora: absorbes el sobrecoste (si el ROI lo justifica) o renegocias alcance. No dejes que siga creciendo sin una decisión consciente.",
        q1:"Cuadrante 1: urgente e importante. Esto requiere TU atención directa o la de tu mejor recurso. No delegues Q1 a juniors — el coste de un error aquí es alto. Bezos: Cuando detectas algo urgente e importante, trátalo como un regalo y resuélvelo personalmente.",
        q2:"Cuadrante 2: aquí se construyen ventajas competitivas. Este es el trabajo que separa a los CEOs excepcionales de los bomberos profesionales. Protege bloques semanales para Q2. La trampa es vivir apagando fuegos en Q1 y nunca construir en Q2. Agenda tiempo ahora.",
      },
      promptBase:"IDENTIDAD: Soy tu CHIEF OF STAFF ESTRATÉGICO. Mi trabajo es desafiarte, no confirmarte. Experiencia en negociación de alto nivel, estrategia competitiva y toma de decisiones bajo incertidumbre. Pienso como tu asesor más exigente — el que dice lo que nadie se atreve a decir.\n\nÁREAS:\n- Negociación estratégica (Voss: empatía táctica, preguntas calibradas, etiquetado; Harvard: BATNA, intereses vs posiciones; Diamond: pagos emocionales, movimientos incrementales)\n- Estrategia competitiva (Porter: 5 fuerzas, cadena de valor; Blue Ocean: crear mercado; Collins: concepto erizo, volante; Rumelt: diagnóstico-política-acción)\n- Toma de decisiones (Kahneman: Sistema 1/2, sesgos cognitivos; Munger: modelos mentales, inversión; Taleb: antifrágil, opcionalidad; Duke: pensar en apuestas)\n- Liderazgo CEO (Bezos: Day 1, decisiones tipo 1/tipo 2, desacuerdo y compromiso; Grove: OKRs, apalancamiento; Dalio: principios, transparencia radical; Horowitz: the hard things)\n- Mentalidad de alto rendimiento (Eker: arquetipos financieros; Naval: conocimiento específico + apalancamiento; DeMarco: fastlane; Buffett: círculo de competencia, margen de seguridad)\n\nFRAMEWORKS CLAVE:\n1. BATNA — Antes de negociar: ¿cuál es tu mejor alternativa? Sin BATNA clara, no negocies.\n2. Tipo 1/Tipo 2 (Bezos) — Irreversible: analiza profundo. Reversible: decide en 24h.\n3. Inversión (Munger) — Piensa al revés: ¿qué puede salir mal? ¿qué haría que esto fracase?\n4. 5 Fuerzas (Porter) — Poder de proveedores, clientes, sustitutos, entrantes, rivalidad.\n5. Concepto Erizo (Collins) — ¿Mejor del mundo en qué? ¿Qué te apasiona? ¿Qué genera dinero?\n6. Antifrágil (Taleb) — ¿Esta decisión te fortalece ante lo inesperado o te hace más frágil?\n7. Preguntas calibradas (Voss) — '¿Cómo se supone que haga eso?' desarma más que argumentar.\n8. Sesgos (Kahneman) — Reviso anclaje, disponibilidad, confirmación y costes hundidos en cada decisión.\n\nCUANDO ANALICES UNA NEGOCIACIÓN:\n1. Identifica BATNA de ambas partes — quien tiene mejor alternativa tiene el poder\n2. Mapea intereses reales vs posiciones declaradas\n3. Evalúa poder relativo con 5 fuerzas aplicadas al deal\n4. Propón 3 escenarios: conservador, equilibrado, agresivo con probabilidades\n5. Red team: ¿qué haría la contraparte si tuviera tu información?\n6. Sugiere preguntas calibradas específicas para la siguiente sesión\n\nCUANDO ASESORES UNA DECISIÓN:\n1. Clasifica: Tipo 1 (irreversible) o Tipo 2 (reversible)\n2. Si Tipo 2: recomienda decidir hoy, no mañana\n3. Si Tipo 1: aplica inversión + pre-mortem + segunda opinión\n4. Identifica sesgos activos del decisor\n5. Calcula opcionalidad: ¿abre o cierra puertas futuras?\n6. Da tu recomendación clara — nunca solo 'depende'\n\nCUANDO EVALÚES ESTRATEGIA:\n1. ¿Dónde juegas? ¿Cómo ganas? (Roger Martin)\n2. ¿Océano rojo o azul? ¿Compites o creas?\n3. ¿Tu ventaja es sostenible o temporal?\n4. ¿Eres antifrágil ante disrupciones del mercado?\n5. ¿El volante está girando o estás empujando piedra cuesta arriba?\n\nCUANDO DES CONSEJO EN SESIÓN:\n1. Lee las notas como señales de negociación\n2. Detecta concesiones sin contrapartida — alerta inmediata\n3. Sugiere el siguiente movimiento táctico concreto\n4. Si hay estancamiento: propón reencuadre o ancla nueva\n5. Recuerda: 'No' no es el final, es el principio de la negociación (Voss)\n\nTONO Y REGLAS:\n- Directo. Sin rodeos. Sin palmaditas motivacionales.\n- Red team por defecto: mi trabajo es ver lo que tú no ves\n- Respondo en 4-6 frases máximo. Conciso y accionable.\n- Nunca digo 'depende' sin dar mi recomendación después\n- Siempre cierro con LA ACCIÓN que deberías tomar AHORA\n- En español. Sin markdown. Sin XML. Frases cortas.\n\nLIMITACIONES:\n→ No soy abogado — para contratos y cláusulas está Mario Legal\n→ No soy analista financiero — para modelos, ROI, waterfall, payback, márgenes de equipos y sensibilidades está Jorge Finanzas; cuando una negociación tenga implicaciones financieras concretas, recomienda consultar a Jorge o incorpora explícitamente que conviene validar los números con él\n→ No sustituyo due diligence financiera ni auditoría contable\n→ Mis recomendaciones son heurísticas probadas, no verdades absolutas\n→ En operaciones reguladas, consulta compliance antes de actuar\n→ No tengo datos de mercado en tiempo real — mis análisis son sobre la información que me das"+HECTOR_COACHING_ADDON,
      specialtiesExtended:[
        {name:"Negociación estratégica",description:"Voss, Harvard Method, BATNA, preguntas calibradas"},
        {name:"Estrategia competitiva",description:"Porter, Blue Ocean, Collins, Rumelt"},
        {name:"Toma de decisiones",description:"Kahneman, Munger, Taleb, modelos mentales"},
        {name:"Liderazgo CEO",description:"Bezos, Grove, Dalio, Horowitz"},
        {name:"Mentalidad de alto rendimiento",description:"Eker, Naval, Buffett, DeMarco"},
      ],
      createdAt:new Date().toISOString(),
    },
    {
      id:3,
      name:"Jorge Finanzas",
      role:"Analista de Inversiones Senior (15+ años)",
      emoji:"📊",
      color:"#B45309",
      voice:{gender:"male",rate:1.0,pitch:0.95,tone:"profesional"},
      specialties:["finanzas","inversiones","ROI","waterfall","payback","leasing","equipos","modelos"],
      opener:"Soy Jorge, analista de inversiones. Vamos a los números — sin redondeos a favor, sin escenarios optimistas vacíos.",
      style:"directo, numérico, basado en datos; tablas sobre párrafos; unidades siempre",
      advice:{
        default:"Toda decisión financiera necesita 3 escenarios (conservador, base, optimista), payback, ROI 12/24/36m y sensibilidad cruzada. Si falta cualquiera, los números no están completos. Marca todo dato estimado con '(est.)' y nunca redondees a favor del inversor.",
        overdue:"Tarea financiera vencida: cada día de retraso impacta el modelo. Re-corre el cálculo con la fecha actual y revisa si payback o break-even han cambiado. Notifica desviación al inversor por escrito antes de que la descubra él.",
        noDueDate:"Sin fecha = sin proyección posible. Los modelos financieros necesitan timeline. Fija un horizonte concreto (12/24/36 meses son los estándar) antes de continuar — sin él no se puede calcular TIR ni VAN.",
        noSubtasks:"Modelo sin desglose. Estructura mínima: (1) ingresos brutos por mes, (2) costes operativos, (3) canon entrada y mensual, (4) waterfall por tramo, (5) métricas (payback, ROI, TIR, VAN, MOIC), (6) sensibilidad cruzada precio×ocupación, (7) escenarios.",
        overBudget:"Sobrecoste detectado. Recalcula payback con el nuevo total — si pasa de 18m, alerta inmediata al inversor. Si margen baja del 20%, revisa si la operación sigue siendo viable o requiere reestructurar.",
        q1:"Urgente e importante en finanzas: probablemente afecta liquidez o un compromiso contractual. Antes de actuar, valida con el modelo: ¿hay margen real o estamos cubriendo con el canon de entrada? No tomes decisiones operativas sin tener el waterfall actualizado delante.",
        q2:"Importante no urgente: zona ideal para modelar nuevos escenarios, revisar márgenes de equipos, ajustar estacionalidad costera, o preparar sensibilidades antes de que el inversor las pida. Aprovecha para blindar las proyecciones con datos reales recientes.",
      },
      promptBase:"Eres Jorge, analista de inversiones senior de SoulBaric / Alma Dimo Investments S.L.\n\nLÍNEAS DE NEGOCIO QUE DOMINAS:\n\nLÍNEA 1 — Explotación JV:\n- Waterfall: Ingresos → costes operativos (~€8.000/mes) → canon cámara (~€4.000/mes) → canon marca → BND → % inversor → remanente Alma Dimo\n- Tramos: Básico €50K/20% BND, Estándar €75K/25%, Premium €125K/30%, VIP €175K/50%\n- Canon entrada €25.000 irrevocable, no computa para payback\n- Estacionalidad Costa del Sol: jun-sep 1.4x, abr-may/oct-nov 1.0x, dic-mar 0.6x\n\nLÍNEA 2 — Comercialización de equipos:\n- Cámaras hiperbáricas: €5.000–€200.000+\n- Bañeras de hielo / ice baths: €1.500–€25.000\n- Crioterapia: €30.000–€150.000\n- Modelos: venta directa (margen 25-40%), distribución (comisión 10-20%), leasing/renting, paquete JV+equipo\n- Costes a incluir siempre: adquisición, transporte, aduanas, instalación, garantía (3-5% PVP), certificaciones\n\nREGLAS OBLIGATORIAS:\n- NUNCA redondear a favor del inversor. Payback 7.3 meses → reportar \"8 meses\"\n- NUNCA omitir canon de entrada del cálculo total\n- Siempre 3 escenarios: conservador, base, optimista\n- Siempre incluir sensibilidad cruzada precio × ocupación\n- Siempre incluir estacionalidad en proyecciones anuales\n- Métricas obligatorias: payback, ROI 12/24/36m, TIR, VAN (descuento 8%), MOIC\n- Inflación 3%, IS 25% (mencionar, no aplicar salvo que se pida)\n\nALERTAS:\n- Payback > 18m → avisar\n- ROI anual < 15% → avisar\n- Break-even > 50% capacidad → alerta roja\n- Margen equipo < 20% → avisar\n- Margen equipo < 10% → alerta roja\n- Proyección sin estacionalidad → alerta roja\n\nTONO: Directo, numérico, sin adornos. Tablas > párrafos. Castellano. Unidades siempre (€, %, meses). Si un dato es estimación, marcar \"(est.)\". No jerga innecesaria con inversores no profesionales.\n\nRepresentas SIEMPRE los intereses de Antonio Díaz Molina / Alma Dimo.",
      specialtiesExtended:[
        {name:"Modelos de inversión",description:"Waterfall por tramos, payback, ROI 12/24/36m, TIR, VAN, MOIC"},
        {name:"Comercialización de equipos",description:"Margen venta directa, distribución, leasing/renting, paquetes JV+equipo"},
        {name:"Sensibilidad y escenarios",description:"3 escenarios obligatorios + cruce precio×ocupación + estacionalidad costera"},
        {name:"Estructura financiera Alma Dimo",description:"Tramos €50K-€175K, canon €25K, BND, costes operativos, márgenes garantizados"},
        {name:"Compliance financiero",description:"Inflación, IS, retenciones — mencionar siempre, no aplicar sin pedir"},
      ],
      createdAt:new Date().toISOString(),
    },
  ],
  workspaces:[
    {id:1,name:"Cliente ejemplo",emoji:"🏢",color:"#378ADD",description:"Demo de workspace asociado — reemplázalo por tu cliente real.",
      links:[{id:"wl1",label:"Web",url:"https://example.com",icon:"🌐"}],
      contacts:[{id:"wc1",name:"Juan Pérez",role:"CEO",email:"juan@example.com",phone:"+34600000000",
        credentials:[{id:"cr1",system:"CRM SoulBaric",url:"https://crm.example.com",login:"juan@example.com",notes:"Guardado en 1Password",hint:"1Password"}]}],
      createdAt:fmt(new Date()),
    },
  ],
};

// ── localStorage persistence ──────────────────────────────────────────────────
const LS_KEY = 'taskflow_v1';
function _migrate(d){
  if(!d.workspaces) d.workspaces = [];
  if(!d.negotiations) d.negotiations = [];
  // FASE 1.5: negociaciones complejas — multi-proyecto, relaciones,
  // stakeholders; y tasks con refs cruzadas a neg/sesión.
  d.negotiations = d.negotiations.map(n=>{
    const m = {
      projectId: null, agentId: null, relatedTaskIds: [],
      relatedProjects: null, relationships: [], stakeholders: [],
      briefing: null, hectorChat: [], hectorAnalysis: null,
      ...n,
      sessions: (n.sessions||[]).map(s=>({
        attendees: [], agentConversations: [],
        ...s,
        entries: s.entries||[],
      })),
    };
    if(!Array.isArray(m.relatedProjects)){
      m.relatedProjects = m.projectId!=null ? [{projectId:m.projectId,role:"main",priority:"high"}] : [];
    }
    return m;
  });
  // Dedup workspace ids: sync realtime entre clientes puede fusionar estados con
  // contadores independientes y provocar colisiones. Con ids duplicados,
  // workspaces.find(w=>w.id===x) devuelve siempre el primero → clicks abren el
  // workspace equivocado. Primera aparición conserva id, las demás reciben nuevo id.
  {
    const seen = new Set();
    let maxId = d.workspaces.reduce((m,w)=>typeof w.id==="number" && w.id>m ? w.id : m, 0);
    d.workspaces = d.workspaces.map(w=>{
      if(seen.has(w.id)){
        const newId = ++maxId;
        seen.add(newId);
        return { ...w, id: newId };
      }
      seen.add(w.id);
      return w;
    });
  }
  if(!d.agents || d.agents.length===0){
    d._seededAgents = d._seededAgents || false;
    if(!d._seededAgents){
      d.agents = JSON.parse(JSON.stringify(INITIAL_DATA.agents||[]));
      d._seededAgents = true;
    } else {
      d.agents = [];
    }
  }
  // Backfill Héctor: se añadió al seed después del launch inicial. Si un
  // estado existente ya tenía agentes pero no incluye a Héctor, lo inyectamos
  // con un id fresco (max+1) para no colisionar con agentes custom. No se
  // re-siembra si el usuario dejó la lista vacía a propósito.
  if(d.agents.length>0 && !d.agents.some(a=>a.name==="Héctor")){
    const hectorSeed = (INITIAL_DATA.agents||[]).find(a=>a.name==="Héctor");
    if(hectorSeed){
      const maxId = d.agents.reduce((m,a)=>typeof a.id==="number"&&a.id>m?a.id:m,0);
      d.agents = [...d.agents, {...JSON.parse(JSON.stringify(hectorSeed)), id: maxId+1, createdAt: new Date().toISOString()}];
    }
  }
  // Rename Lucas Finanzas → Jorge Finanzas. Si un usuario tenía el agente
  // anterior persistido (commit 7a55353), renombramos in-place sin
  // duplicar. También actualiza opener y promptBase si conservan el nombre
  // viejo. Idempotente — al segundo pase nadie llama "Lucas Finanzas".
  d.agents = d.agents.map(a=>{
    if(a.name === "Lucas Finanzas"){
      return {
        ...a,
        name: "Jorge Finanzas",
        opener: (a.opener||"").replace(/\bLucas\b/g, "Jorge"),
        promptBase: (a.promptBase||"").replace(/\bLucas\b/g, "Jorge"),
      };
    }
    return a;
  });
  // Backfill Jorge Finanzas: análogo a Héctor — añadido al seed después
  // del launch. Sin colisión con custom porque el id es max+1.
  if(d.agents.length>0 && !d.agents.some(a=>a.name==="Jorge Finanzas")){
    const jorgeSeed = (INITIAL_DATA.agents||[]).find(a=>a.name==="Jorge Finanzas");
    if(jorgeSeed){
      const maxId = d.agents.reduce((m,a)=>typeof a.id==="number"&&a.id>m?a.id:m,0);
      d.agents = [...d.agents, {...JSON.parse(JSON.stringify(jorgeSeed)), id: maxId+1, createdAt: new Date().toISOString()}];
    }
  }
  // Upgrade promptBase de Héctor: añade la sección COACHING EJECUTIVO si el
  // usuario ya tenía al Héctor anterior sin esa sección. Idempotente: al
  // segundo pase detecta la marca "COACHING EJECUTIVO" y no hace nada.
  d.agents = d.agents.map(a=>{
    if(a.name==="Héctor" && a.promptBase && !a.promptBase.includes("COACHING EJECUTIVO")){
      return {...a, promptBase: a.promptBase + HECTOR_COACHING_ADDON};
    }
    return a;
  });
  // Upgrade promptBase de Héctor: mención a Jorge Finanzas en LIMITACIONES.
  // Para Héctors anteriores que no conocían a Jorge. Idempotente.
  d.agents = d.agents.map(a=>{
    if(a.name==="Héctor" && a.promptBase && !a.promptBase.includes("Jorge Finanzas")){
      // Caso A: Héctor tenía mención al "Lucas Finanzas" anterior →
      // simplemente renombrar al nuevo nombre, sin duplicar la línea.
      if(a.promptBase.includes("Lucas Finanzas")){
        return {...a, promptBase: a.promptBase
          .replace(/Lucas Finanzas/g, "Jorge Finanzas")
          .replace(/consultar a Lucas/g, "consultar a Jorge")
        };
      }
      // Caso B: Héctor sin mención previa → insertar línea bajo Mario Legal.
      const updated = a.promptBase.replace(
        "→ No soy abogado — para contratos y cláusulas está Mario Legal",
        "→ No soy abogado — para contratos y cláusulas está Mario Legal\n→ No soy analista financiero — para modelos, ROI, waterfall, payback, márgenes de equipos y sensibilidades está Jorge Finanzas; cuando una negociación tenga implicaciones financieras concretas, recomienda consultar a Jorge o incorpora explícitamente que conviene validar los números con él"
      );
      return {...a, promptBase: updated};
    }
    return a;
  });
  d.projects = (d.projects||[]).map(p=>({...p, workspaceId: p.workspaceId ?? null}));
  // Auth: backfill email + accountRole en members. Antonio (id=6) pasa
  // a email real qn.finanzas@gmail.com y accountRole "admin"; el resto
  // queda como "member" salvo si ya tenía un accountRole explícito.
  d.members = (d.members||[]).map(m=>{
    let email = m.email || "";
    if(m.id === 6 && email === "antonio@empresa.com") email = "qn.finanzas@gmail.com";
    let accountRole = m.accountRole;
    if(!accountRole) accountRole = (m.id === 6 ? "admin" : "member");
    return {...m, email, accountRole};
  });
  d.boards = Object.fromEntries(Object.entries(d.boards||{}).map(([pid,cols])=>[pid,cols.map(col=>({...col,tasks:col.tasks.map(t=>({...t, links: t.links||[], agentIds: t.agentIds||[], refs: t.refs||[], documents: t.documents||[], dueTime: t.dueTime||""}))}))]));
  // Backfill documents[] en negociaciones (upload + informes de análisis).
  d.negotiations = d.negotiations.map(n=>({
    ...n,
    documents: n.documents||[],
    memory: n.memory ? {
      keyFacts:      Array.isArray(n.memory.keyFacts)      ? n.memory.keyFacts      : [],
      agreements:    Array.isArray(n.memory.agreements)    ? n.memory.agreements    : [],
      redFlags:      Array.isArray(n.memory.redFlags)      ? n.memory.redFlags      : [],
      chatSummaries: Array.isArray(n.memory.chatSummaries) ? n.memory.chatSummaries : [],
      updatedAt:     n.memory.updatedAt || null,
    } : {...emptyNegMemory(), chatSummaries:[]},
  }));
  // Memoria global del CEO (nivel app).
  d.ceoMemory = d.ceoMemory ? {
    preferences: Array.isArray(d.ceoMemory.preferences) ? d.ceoMemory.preferences : [],
    keyFacts:    Array.isArray(d.ceoMemory.keyFacts)    ? d.ceoMemory.keyFacts    : [],
    decisions:   Array.isArray(d.ceoMemory.decisions)   ? d.ceoMemory.decisions   : [],
    lessons:     Array.isArray(d.ceoMemory.lessons)     ? d.ceoMemory.lessons     : [],
    updatedAt:   d.ceoMemory.updatedAt || null,
  } : emptyCeoMemory();
  return d;
}
function _loadData(){
  try{ const s=localStorage.getItem(LS_KEY); if(s)return _migrate(JSON.parse(s)); }catch(e){}
  return _migrate(JSON.parse(JSON.stringify(INITIAL_DATA)));
}
function _initCounters(d){
  const taskNums=Object.values(d.boards||{}).flatMap(c=>c.flatMap(col=>col.tasks.map(t=>t.id))).filter(id=>/^t\d+$/.test(id)).map(id=>+id.slice(1));
  const projNums=(d.projects||[]).map(p=>p.id).filter(n=>typeof n==="number");
  const colNums=Object.values(d.boards||{}).flatMap(c=>c.map(col=>col.id)).map(id=>+id.replace(/\D/g,"")).filter(n=>n>0);
  const wsNums=(d.workspaces||[]).map(w=>w.id).filter(n=>typeof n==="number");
  const agNums=(d.agents||[]).map(a=>a.id).filter(n=>typeof n==="number");
  return{
    nextId:  taskNums.length?Math.max(...taskNums)+1:20,
    nextProjId:projNums.length?Math.max(...projNums)+1:5,
    nextColId: colNums.length?Math.max(...colNums)+1:20,
    nextWsId:  wsNums.length?Math.max(...wsNums)+1:2,
    nextAgentId: agNums.length?Math.max(...agNums)+1:1,
  };
}
const _saved=_loadData();
const _c=_initCounters(_saved);
let nextId=_c.nextId,nextProjId=_c.nextProjId,nextColId=_c.nextColId,nextWsId=_c.nextWsId,nextAgentId=_c.nextAgentId;
// Re-sync counters cuando llega estado remoto, para que nextWsId/nextProjId no
// asignen ids ya usados por otros clientes — origen de las colisiones.
function _syncCounters(d){
  const c=_initCounters(d);
  if(c.nextId     >nextId)      nextId=c.nextId;
  if(c.nextProjId >nextProjId)  nextProjId=c.nextProjId;
  if(c.nextColId  >nextColId)   nextColId=c.nextColId;
  if(c.nextWsId   >nextWsId)    nextWsId=c.nextWsId;
  if(c.nextAgentId>nextAgentId) nextAgentId=c.nextAgentId;
}
const _uid=(p)=>`${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2,5)}`;

// ── Small components ──────────────────────────────────────────────────────────
const Tag=({tag})=>{ const c=TAG_COLORS[tag.c]||TAG_COLORS.blue; return <span style={{fontSize:11,padding:"2px 8px",borderRadius:20,fontWeight:500,background:c.bg,color:c.text,border:`0.5px solid ${c.border}`}}>{tag.l}</span>; };
const PriBadge=({p})=>{ const m={alta:{bg:"#FCEBEB",text:"#A32D2D",l:"Alta"},media:{bg:"#FAEEDA",text:"#633806",l:"Media"},baja:{bg:"#EAF3DE",text:"#27500A",l:"Baja"}}[p]||{bg:"#FAEEDA",text:"#633806",l:"Media"}; return <span style={{fontSize:10,padding:"2px 7px",borderRadius:20,background:m.bg,color:m.text,fontWeight:500}}>{m.l}</span>; };
const QBadge=({q})=>{ const qm=QM[q]; if(!qm)return null; return <span style={{fontSize:10,padding:"2px 7px",borderRadius:20,background:qm.bg,color:qm.border,border:`1px solid ${qm.border}`,fontWeight:600}}>{qm.icon} {qm.label}</span>; };
const FL=({c})=><div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:5,marginTop:14}}>{c}</div>;
const FI=({value,onChange,type="text",placeholder=""})=><input type={type} value={value||""} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,outline:"none",fontFamily:"inherit",background:"#fff",boxSizing:"border-box"}}/>;

// Banda reutilizable de confirmación de descarte para todos los modales con formulario.
function DiscardBanner({onKeep,onDiscard}){
  return(
    <div style={{padding:"10px 20px",background:"#FEF3C7",borderBottom:"0.5px solid #F59E0B",display:"flex",alignItems:"center",gap:12,justifyContent:"space-between",flexWrap:"wrap"}}>
      <div style={{fontSize:13,color:"#92400E",fontWeight:600}}>¿Descartar cambios?</div>
      <div style={{display:"flex",gap:6}}>
        <button onClick={onKeep} style={{padding:"6px 14px",borderRadius:7,background:"#378ADD",color:"#fff",border:"none",fontSize:12,fontWeight:600,cursor:"pointer"}}>↩ Seguir editando</button>
        <button onClick={onDiscard} style={{padding:"6px 14px",borderRadius:7,background:"#E24B4A",color:"#fff",border:"none",fontSize:12,fontWeight:600,cursor:"pointer"}}>❌ Descartar</button>
      </div>
    </div>
  );
}

// Botón de dictado por voz reutilizable. Pure: no toca el input directamente,
// el padre recibe onInterim/onFinal con la transcripción y decide qué hacer.
// Si SpeechRecognition no está disponible (Firefox etc), el componente no
// renderiza nada — el input queda como estaba.
// Dictado continuo. Click para empezar, click de nuevo para parar.
// NUNCA auto-envía. Mientras graba, acumula utterances finalizadas en
// accumRef y emite texto combinado (acumulado + interim) por onInterim
// / onFinal. Inicializa con initialText para que la dictación continúe
// desde lo que el usuario ya tenía escrito en el input.
const VoiceMicButton = React.forwardRef(function VoiceMicButton({onStart,onInterim,onFinal,onError,disabled,color="#1D9E75",title,size="md",initialText=""}, ref){
  const [listening,setListening] = useState(false);
  const stopRef    = useRef(null);
  const accumRef   = useRef("");
  const stoppedRef = useRef(false); // gate contra callbacks post-stop
  useEffect(()=>()=>{ if(stopRef.current){ try{stopRef.current();}catch{} } },[]);

  const doStop = ()=>{
    // Marca stop ANTES de llamar r.stop(): cualquier onInterim/onFinal
    // que llegue en el flush buffer se ignora. También vacía accum y
    // baja listening inmediatamente (sin esperar a onEnd), para que el
    // icono responda y el useEffect del padre no vea estado viejo.
    stoppedRef.current = true;
    accumRef.current = "";
    if(stopRef.current){ try{stopRef.current();}catch{} stopRef.current = null; }
    setListening(false);
  };

  // API imperativa: el padre puede forzar el stop (p.ej. al enviar un
  // mensaje, para que el mic no siga transcribiendo ni capture la voz
  // del TTS del agente).
  React.useImperativeHandle(ref, ()=>({ stop: doStop }), []);

  const supported = voiceSupported().stt;
  if(!supported) return null;

  const handleClick = (e)=>{
    e.stopPropagation();
    if(listening){ doStop(); return; }
    if(disabled) return;
    stoppedRef.current = false;
    accumRef.current = (initialText||"").trim();
    onStart?.();
    // iOS: continuous:true es inestable (no emite interims o corta).
    // Usamos one-shot y el usuario pulsa el botón cada vez que quiere
    // dictar otro fragmento — el accum se preserva entre ciclos.
    stopRef.current = listen({
      continuous: !isIOS,
      onStart:   ()=>setListening(true),
      onInterim: (t)=>{
        if(stoppedRef.current) return;
        const combined = accumRef.current ? `${accumRef.current} ${t}`.trim() : t;
        onInterim?.(combined);
      },
      onFinal:   (t)=>{
        if(stoppedRef.current) return;
        accumRef.current = accumRef.current ? `${accumRef.current} ${t}`.trim() : t;
        onFinal?.(accumRef.current);
      },
      onError:   (err)=>{ setListening(false); stopRef.current=null; onError?.(err); },
      onEnd:     ()=>{ setListening(false); stopRef.current=null; },
    });
  };
  const dim = size==="sm"?28:36;
  return(
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled&&!listening}
      title={listening?"Parar dictado":(title|| (isIOS?"Pulsa para dictar una frase":"Dictar por voz (continuo)"))}
      style={{width:dim,height:dim,borderRadius:8,background:listening?"#E24B4A":"#fff",color:listening?"#fff":color,border:listening?"none":`1px solid ${color}`,fontSize:size==="sm"?12:15,cursor:(disabled&&!listening)?"not-allowed":"pointer",fontFamily:"inherit",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",opacity:(disabled&&!listening)?0.5:1,animation:listening?"tf-mic-pulse 1.2s infinite":"none",padding:0}}
    >{listening?"⏹":"🎤"}</button>
  );
});

// Dropdown portalizado al body. El trigger vive dentro de un card con
// overflow:hidden (para respetar borderRadius del informe expandido),
// así que posicionar el menú via position:absolute lo clippa. Portal
// fuera de cualquier ancestro con overflow se resuelve calculando
// coordenadas desde getBoundingClientRect del trigger.
function PortalDropdown({getAnchor, open, onClose, children, minWidth = 170}){
  const [pos,setPos] = useState(null);
  useEffect(()=>{
    if(!open){ setPos(null); return; }
    const compute = ()=>{
      const el = getAnchor?.();
      if(!el) return;
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: Math.max(8, r.right - minWidth), width: minWidth });
    };
    compute();
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return ()=>{
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  },[open, minWidth, getAnchor]);
  useEffect(()=>{
    if(!open) return;
    const onDoc = (e)=>{
      const el = getAnchor?.();
      if(el && el.contains(e.target)) return;
      // Permitir clicks dentro del propio dropdown (detectado por data-role)
      if(e.target.closest && e.target.closest("[data-portal-dropdown='1']")) return;
      onClose?.();
    };
    const onKey = (e)=>{ if(e.key==="Escape") onClose?.(); };
    // defer para no pillar el click que lo abrió
    const t = setTimeout(()=>{ document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey); }, 0);
    return ()=>{ clearTimeout(t); document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  },[open, onClose, getAnchor]);
  if(!open || !pos) return null;
  return createPortal(
    <div data-portal-dropdown="1" style={{position:"fixed", top:pos.top, left:pos.left, minWidth:pos.width, background:"#fff", border:"1px solid #E5E7EB", borderRadius:8, boxShadow:"0 6px 20px rgba(0,0,0,0.18)", zIndex:10000, padding:4}}>
      {children}
    </div>,
    document.body
  );
}

// Pantalla de login (Supabase Auth). Se monta cuando authEnabled() y no
// hay sesión activa. Soporta sign-in y sign-up — el sign-up SOLO funciona
// si el email ya está registrado en data.members (caso contrario, error).
// Tras autenticarse, App resuelve el miembro por email y setea
// activeMember; si el email no está autorizado, muestra "no autorizado".
function LoginScreen({onAuthed, onLegacySkip}){
  const [mode,setMode]   = useState("signin"); // signin | signup
  const [email,setEmail] = useState("");
  const [pwd,setPwd]     = useState("");
  const [busy,setBusy]   = useState(false);
  const [err,setErr]     = useState(null);
  const submit = async (e)=>{
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const session = mode==="signup"
        ? await signUp(email.trim(), pwd)
        : await signIn(email.trim(), pwd);
      onAuthed(session);
    } catch(e2){
      setErr(e2.message || "Error de autenticación");
    } finally { setBusy(false); }
  };
  return(
    <div style={{position:"fixed",inset:0,background:"linear-gradient(135deg,#7F77DD22,#E76AA122)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,zIndex:5000}}>
      <div style={{background:"#fff",borderRadius:16,padding:"28px 28px 22px",width:380,maxWidth:"100%",boxShadow:"0 20px 60px rgba(0,0,0,0.18)",border:"0.5px solid #E5E7EB"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
          <div style={{width:38,height:38,background:"#7F77DD",borderRadius:10,color:"#fff",fontWeight:700,fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>SB</div>
          <div>
            <div style={{fontWeight:700,fontSize:16,color:"#111827"}}>SoulBaric</div>
            <div style={{fontSize:11,color:"#6B7280"}}>{mode==="signup"?"Crear cuenta":"Iniciar sesión"}</div>
          </div>
        </div>
        <form onSubmit={submit}>
          <label style={{display:"block",fontSize:12,fontWeight:600,color:"#374151",marginBottom:4}}>Email</label>
          <input type="email" autoFocus required value={email} onChange={e=>setEmail(e.target.value)} placeholder="tu@email.com" disabled={busy} style={{width:"100%",padding:"9px 12px",borderRadius:8,border:"1px solid #D1D5DB",fontSize:14,fontFamily:"inherit",outline:"none",marginBottom:12}}/>
          <label style={{display:"block",fontSize:12,fontWeight:600,color:"#374151",marginBottom:4}}>Contraseña</label>
          <input type="password" required minLength={6} value={pwd} onChange={e=>setPwd(e.target.value)} placeholder="••••••••" disabled={busy} style={{width:"100%",padding:"9px 12px",borderRadius:8,border:"1px solid #D1D5DB",fontSize:14,fontFamily:"inherit",outline:"none",marginBottom:14}}/>
          {err && <div style={{fontSize:11.5,color:"#B91C1C",background:"#FEF2F2",border:"1px solid #FCA5A5",borderRadius:6,padding:"7px 10px",marginBottom:12}}>{err}</div>}
          <button type="submit" disabled={busy||!email.trim()||pwd.length<6} style={{width:"100%",padding:"10px 14px",borderRadius:8,background:busy?"#A7B0F5":"#7F77DD",color:"#fff",border:"none",fontSize:14,fontWeight:600,cursor:busy?"wait":"pointer",fontFamily:"inherit"}}>
            {busy?"Procesando…":(mode==="signup"?"Crear cuenta":"Entrar")}
          </button>
        </form>
        <div style={{display:"flex",justifyContent:"space-between",marginTop:12,fontSize:11.5}}>
          <button onClick={()=>{setMode(mode==="signup"?"signin":"signup");setErr(null);}} style={{background:"none",border:"none",color:"#7F77DD",cursor:"pointer",fontFamily:"inherit",padding:0}}>{mode==="signup"?"Ya tengo cuenta":"Crear cuenta nueva"}</button>
          {onLegacySkip && <button onClick={onLegacySkip} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontFamily:"inherit",padding:0}}>Modo demo</button>}
        </div>
      </div>
    </div>
  );
}

// Adjuntos de documentos con upload a Supabase Storage.
// ownerKey = identificador del contenedor ("neg-<id>" o "task-<id>") que se
// usa como prefijo del path en el bucket. documents se persiste en el estado
// (negotiation.documents o task.documents) vía onChange.
function DocumentUploader({ownerKey, documents = [], onChange, agents = [], contextLabel, onPostChatMessage, ceoMemory}){
  const [busy,setBusy]    = useState(false);
  const [error,setError]  = useState(null);
  const [dragOver,setDragOver] = useState(false);
  const [agentId,setAgentId]   = useState("none");
  const [analyzing,setAnalyzing] = useState(null);
  const [expanded,setExpanded]   = useState(null);
  const [agentMenuDocId,setAgentMenuDocId] = useState(null); // doc.id cuyo dropdown de agentes está abierto
  const [urlInput,setUrlInput]   = useState("");
  const [urlBusy,setUrlBusy]     = useState(false);
  const fileInputRef      = useRef(null);

  if(!storageEnabled()){
    return <div style={{padding:"12px 14px",background:"#FEF3C7",border:"1px solid #FCD34D",borderRadius:8,fontSize:12,color:"#92400E"}}>
      Documentos requieren Supabase Storage. Añade VITE_SUPABASE_URL y VITE_SUPABASE_KEY para activarlo.
    </div>;
  }

  // El análisis por Anthropic soporta PDF (document block) e imágenes PNG/JPG
  // (image block). DOCX no es soportado natively por la API. TXT va como texto.
  // URLs (type:text/html) van como texto ya extraído por /api/fetch-url.
  const canAnalyze = (doc)=>{
    if(doc.url) return true;
    const type = doc.type;
    return type==="application/pdf" || type==="image/png" || type==="image/jpeg" || type==="text/plain";
  };

  const buildAttachment = async (doc)=>{
    if(doc.url){ return { kind:"text", name:doc.name, text: (doc.text||"").slice(0,50000) }; }
    const blob = await downloadDocumentBlob(doc.storagePath);
    if(doc.type==="text/plain"){
      const text = await blob.text();
      return { kind:"text", name:doc.name, text: text.slice(0,50000) };
    }
    const data = await blobToBase64(blob);
    if(doc.type==="application/pdf") return { kind:"pdf", media_type:"application/pdf", data };
    if(doc.type==="image/png" || doc.type==="image/jpeg") return { kind:"image", media_type:doc.type, data };
    throw new Error("Tipo no soportado para análisis");
  };

  const runAnalyze = async (doc, explicitAgent)=>{
    const agent = explicitAgent || agents.find(a=>String(a.id)===String(agentId));
    if(!agent) return;
    if(!canAnalyze(doc)){ setError(`${doc.type||"Tipo desconocido"} no soporta análisis automático`); return; }
    setError(null);
    setAnalyzing(doc.id);
    try {
      const att = await buildAttachment(doc);
      const report = await analyzeDocument(att, agent, contextLabel||"el caso actual", ceoMemory);
      const now = new Date().toISOString();
      const next = documents.map(d=>d.id===doc.id ? {...d, analyzedBy: agent.name, analyzedAt: now, report} : d);
      onChange?.(next);
      setExpanded(doc.id);
      // Publica el informe en el chat del agente (p.ej. chat de Héctor)
      // si el consumidor ha provisto el hook. Formato de texto plano que
      // mantiene coherencia con chatBody() del export PDF.
      if(onPostChatMessage){
        const parts = [`📎 Análisis de "${doc.name}" por ${agent.name}:`];
        if(report.summary)         parts.push(`\nRESUMEN EJECUTIVO:\n${report.summary}`);
        if(report.details)         parts.push(`\nRIESGOS Y OPORTUNIDADES:\n${report.details}`);
        if(report.recommendations) parts.push(`\nRECOMENDACIONES:\n${report.recommendations}`);
        onPostChatMessage({
          role: "assistant",
          content: parts.join("\n"),
          timestamp: now,
          kind: "document_analysis",
        });
      }
    } catch(e){
      setError(e.message||"Error al analizar");
    } finally {
      setAnalyzing(null);
    }
  };

  const handleFiles = async (fileList, {analyze=false}={})=>{
    const files = Array.from(fileList||[]);
    if(files.length===0) return;
    setError(null);
    setBusy(true);
    try {
      const next = [...documents];
      const uploadedDocs = [];
      for(const file of files){
        const v = validateFile(file);
        if(v){ setError(v); continue; }
        const meta = await uploadDocument(file, ownerKey);
        const doc = {
          id: "doc_"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
          name: meta.name,
          type: meta.type,
          size: meta.size,
          storagePath: meta.storagePath,
          uploadedAt: new Date().toISOString(),
          analyzedBy: null,
          analyzedAt: null,
          report: null,
        };
        next.push(doc);
        uploadedDocs.push(doc);
      }
      onChange?.(next);
      if(analyze){
        for(const doc of uploadedDocs){
          if(canAnalyze(doc)) await runAnalyze(doc);
        }
      }
    } catch(e){
      setError(e.message||"Error al subir");
    } finally {
      setBusy(false);
      if(fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const onDrop = (e)=>{
    e.preventDefault(); setDragOver(false);
    handleFiles(e.dataTransfer.files, {analyze: agentId!=="none"});
  };

  // URL fetch: contenido web que se pasa como texto al agente (no se sube
  // a Storage, se referencia por URL). Si hay agente seleccionado, se analiza
  // automáticamente tras descargar.
  const addUrl = async ()=>{
    const u = urlInput.trim();
    if(!u) return;
    setError(null);
    setUrlBusy(true);
    try {
      const r = await fetch("/api/fetch-url", {
        method:"POST",
        headers:{ "content-type":"application/json" },
        body: JSON.stringify({ url: u }),
      });
      const data = await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const doc = {
        id: "doc_"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
        name: data.title || data.url,
        type: "text/html",
        size: (data.text||"").length,
        storagePath: null,
        url: data.url,
        text: data.text || "",
        uploadedAt: new Date().toISOString(),
        analyzedBy: null,
        analyzedAt: null,
        report: null,
      };
      const next = [...documents, doc];
      onChange?.(next);
      setUrlInput("");
      if(agentId!=="none"){
        const agent = agents.find(a=>String(a.id)===String(agentId));
        if(agent){
          setAnalyzing(doc.id);
          try {
            const att = { kind:"text", name:doc.name, text: doc.text.slice(0,50000) };
            const report = await analyzeDocument(att, agent, contextLabel||"el caso actual", ceoMemory);
            const updated = next.map(d=>d.id===doc.id ? {...d, analyzedBy: agent.name, analyzedAt: new Date().toISOString(), report} : d);
            onChange?.(updated);
            setExpanded(doc.id);
          } finally { setAnalyzing(null); }
        }
      }
    } catch(e){
      setError(e.message||"Error al recuperar URL");
    } finally {
      setUrlBusy(false);
    }
  };

  const openDoc = async (doc)=>{
    try {
      if(doc.url){ window.open(doc.url,"_blank","noopener"); return; }
      const url = await getSignedUrl(doc.storagePath);
      window.open(url,"_blank","noopener");
    } catch(e){ setError(e.message); }
  };

  const removeDoc = async (doc)=>{
    if(doc.storagePath) await storageDeleteDocument(doc.storagePath);
    onChange?.(documents.filter(d=>d.id!==doc.id));
  };

  const iconFor = (doc)=>{
    if(doc.url) return "🔗";
    const type = doc.type;
    if(!type) return "📄";
    if(type.includes("pdf")) return "📕";
    if(type.includes("word")||type.includes("document")) return "📘";
    if(type.startsWith("image/")) return "🖼️";
    if(type.startsWith("text/")) return "📝";
    return "📄";
  };

  const hasAgents = agents && agents.length>0;
  const agentSelected = agentId!=="none";

  return(
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      <div
        onDragOver={e=>{e.preventDefault();setDragOver(true);}}
        onDragLeave={()=>setDragOver(false)}
        onDrop={onDrop}
        onClick={()=>fileInputRef.current?.click()}
        style={{
          border:`2px dashed ${dragOver?"#7F77DD":"#D1D5DB"}`,
          background: dragOver?"#F5F3FF":"#F9FAFB",
          borderRadius:10, padding:"16px 14px", textAlign:"center",
          cursor:busy?"wait":"pointer", transition:"all .15s",
        }}
      >
        <div style={{fontSize:22,marginBottom:4}}>📎</div>
        <div style={{fontSize:12.5,fontWeight:600,color:"#374151",marginBottom:2}}>
          {busy?"Subiendo…":"Arrastra o haz clic para adjuntar"}
        </div>
        <div style={{fontSize:10.5,color:"#9CA3AF"}}>
          PDF, DOCX, PNG, JPG, TXT · máx {MAX_FILE_MB}MB
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_MIME.join(",")}
          multiple
          disabled={busy}
          onChange={e=>handleFiles(e.target.files,{analyze:agentSelected})}
          style={{display:"none"}}
        />
      </div>
      {hasAgents&&(
        <div style={{display:"flex",alignItems:"center",gap:8,fontSize:11.5,color:"#6b7280"}}>
          <label style={{fontWeight:600}}>Analizar con:</label>
          <select value={agentId} onChange={e=>setAgentId(e.target.value)} style={{flex:1,padding:"6px 10px",borderRadius:6,border:"1px solid #D1D5DB",fontSize:12,fontFamily:"inherit",outline:"none",background:"#fff"}}>
            <option value="none">Solo guardar</option>
            {agents.map(a=><option key={a.id} value={a.id}>{a.name}{a.role?` — ${a.role}`:""}</option>)}
          </select>
        </div>
      )}
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <input
          type="url"
          value={urlInput}
          onChange={e=>setUrlInput(e.target.value)}
          onKeyDown={e=>{ if(e.key==="Enter"&&!urlBusy){ e.preventDefault(); addUrl(); } }}
          placeholder="O pega una URL (https://...)"
          disabled={urlBusy}
          style={{flex:1,padding:"6px 10px",borderRadius:6,border:"1px solid #D1D5DB",fontSize:12,fontFamily:"inherit",outline:"none",background:"#fff"}}
        />
        <button
          onClick={addUrl}
          disabled={urlBusy||!urlInput.trim()}
          style={{padding:"6px 12px",borderRadius:6,background:urlBusy?"#FEF3C7":(urlInput.trim()?"#1E40AF":"#E5E7EB"),color:urlBusy?"#92400E":(urlInput.trim()?"#fff":"#9CA3AF"),border:"none",fontSize:11.5,fontWeight:600,cursor:(urlBusy||!urlInput.trim())?"default":"pointer"}}
        >{urlBusy?"Descargando…":"Añadir URL"}</button>
      </div>
      {error&&<div style={{fontSize:11.5,color:"#B91C1C",background:"#FEF2F2",border:"1px solid #FCA5A5",borderRadius:6,padding:"6px 10px"}}>{error}</div>}
      {documents.length>0 && (
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {documents.map(doc=>{
            const isExpanded = expanded===doc.id && doc.report;
            const isAnalyzing = analyzing===doc.id;
            return(
              <div key={doc.id} style={{display:"flex",flexDirection:"column",background:"#fff",border:"1px solid #E5E7EB",borderRadius:8,overflow:"hidden"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px"}}>
                  <span style={{fontSize:16,flexShrink:0}}>{iconFor(doc)}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:12.5,fontWeight:600,color:"#111827",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{doc.name}</div>
                    <div style={{fontSize:10.5,color:"#9CA3AF"}}>
                      {fmtFileSize(doc.size)} · {new Date(doc.uploadedAt).toLocaleDateString("es-ES")}
                      {doc.analyzedBy && <> · <span style={{color:"#0E7C5A",fontWeight:600}}>analizado por {doc.analyzedBy}</span></>}
                    </div>
                  </div>
                  <button onClick={()=>openDoc(doc)} title="Abrir" style={{width:28,height:28,borderRadius:6,background:"#F3F4F6",border:"none",cursor:"pointer",fontSize:13}}>↗</button>
                  {/* Tercer botón: Analizar (verde) si no hay informe; Ver informe (azul) + Re-analizar (gris) si lo hay */}
                  {hasAgents && canAnalyze(doc) && !doc.report && (
                    <button
                      data-doc-anchor={`analyze-${doc.id}`}
                      onClick={()=>setAgentMenuDocId(v=>v===doc.id?null:doc.id)}
                      disabled={isAnalyzing}
                      title="Analizar con un agente IA"
                      style={{padding:"4px 12px",borderRadius:6,background:isAnalyzing?"#A7F3D0":"#1D9E75",color:"#fff",border:"none",cursor:isAnalyzing?"wait":"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:5}}
                    >{isAnalyzing?"⋯ Analizando…":"Analizar"}</button>
                  )}
                  {doc.report && (
                    <>
                      <button
                        onClick={()=>setExpanded(e=>e===doc.id?null:doc.id)}
                        title={isExpanded?"Ocultar informe":"Ver informe"}
                        style={{padding:"4px 12px",borderRadius:6,background:"#378ADD",color:"#fff",border:"none",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit"}}
                      >{isExpanded?"Ocultar":"Ver informe"}</button>
                      {hasAgents && canAnalyze(doc) && (
                        <button
                          data-doc-anchor={`analyze-${doc.id}`}
                          onClick={()=>setAgentMenuDocId(v=>v===doc.id?null:doc.id)}
                          disabled={isAnalyzing}
                          title="Re-analizar con otro agente"
                          style={{padding:"4px 10px",borderRadius:6,background:isAnalyzing?"#E5E7EB":"#F3F4F6",color:"#374151",border:"1px solid #D1D5DB",cursor:isAnalyzing?"wait":"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}
                        >{isAnalyzing?"⋯":"Re-analizar"}</button>
                      )}
                    </>
                  )}
                  <PortalDropdown
                    open={agentMenuDocId===doc.id && !isAnalyzing}
                    onClose={()=>setAgentMenuDocId(null)}
                    getAnchor={()=>document.querySelector(`[data-doc-anchor="analyze-${doc.id}"]`)}
                  >
                    {agents.map(a=>(
                      <button
                        key={a.id}
                        onClick={()=>{ setAgentMenuDocId(null); runAnalyze(doc, a); }}
                        style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"7px 10px",border:"none",background:"transparent",cursor:"pointer",fontSize:12,fontFamily:"inherit",textAlign:"left",borderRadius:6,color:"#111827"}}
                        onMouseEnter={e=>e.currentTarget.style.background="#F3F4F6"}
                        onMouseLeave={e=>e.currentTarget.style.background="transparent"}
                      >
                        <span>{a.emoji||"🤖"}</span>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontWeight:600}}>{a.name}</div>
                          {a.role && <div style={{fontSize:10,color:"#6B7280"}}>{a.role}</div>}
                        </div>
                      </button>
                    ))}
                  </PortalDropdown>
                  <button onClick={()=>removeDoc(doc)} title="Eliminar" style={{width:28,height:28,borderRadius:6,background:"#FEF2F2",border:"none",cursor:"pointer",fontSize:13,color:"#B91C1C"}}>✕</button>
                </div>
                {isExpanded && (
                  <div style={{borderTop:"1px solid #E5E7EB",padding:"10px 12px",background:"#FAFBFF",fontSize:12,color:"#374151",display:"flex",flexDirection:"column",gap:10}}>
                    {doc.report.summary && <div><div style={{fontSize:10,fontWeight:700,color:"#1E40AF",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:4}}>Resumen ejecutivo</div><div style={{lineHeight:1.5,whiteSpace:"pre-wrap"}}>{doc.report.summary}</div></div>}
                    {doc.report.details && <div><div style={{fontSize:10,fontWeight:700,color:"#B45309",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:4}}>Riesgos y oportunidades</div><div style={{lineHeight:1.5,whiteSpace:"pre-wrap"}}>{doc.report.details}</div></div>}
                    {doc.report.recommendations && <div><div style={{fontSize:10,fontWeight:700,color:"#0E7C5A",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:4}}>Recomendaciones</div><div style={{lineHeight:1.5,whiteSpace:"pre-wrap"}}>{doc.report.recommendations}</div></div>}
                    <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
                      <ExportPDFButton
                        title={`Informe — ${doc.name}`}
                        filename={`informe-${doc.name.slice(0,40)}`}
                        render={(pdfDoc,y)=>renderDocumentReport(pdfDoc, y, doc.report, doc.name, doc.analyzedBy)}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Generación de PDF: jsPDF directo, sin html2canvas. Cada renderer toma
// (doc, y) y devuelve la nueva y tras pintar. generatePDF se encarga del
// marco: header per-página, footer per-página, saltos de página automáticos.
//
// Layout A4 (210 × 297mm):
//   margen izquierdo/derecho: 14mm   → ancho útil 182mm
//   header en y=14 (brand+título+fecha), línea separadora en y=18
//   contenido arranca en y=26, tope inferior en y=275
//   footer línea en y=280, texto en y=286

const PDF_MARGIN_L = 14;
const PDF_MARGIN_R = 14;
const PDF_CONTENT_W = 182;          // 210 − 14 − 14
const PDF_TOP_CONTENT_Y = 26;
const PDF_BOTTOM_LIMIT = 275;

// Si el cursor sobrepasa el tope inferior, añade página y devuelve nueva y.
function pdfCheckPageBreak(doc, y, need = 6){
  if(y + need > PDF_BOTTOM_LIMIT){
    doc.addPage();
    return PDF_TOP_CONTENT_Y;
  }
  return y;
}

// Sanea texto para jsPDF. La fuente Helvetica por defecto solo soporta
// WinAnsiEncoding (Latin-1 + algunos extras). Emojis y otros caracteres
// fuera de ese rango pueden romper splitTextToSize/text() silenciosamente
// y dejar el body vacío. Mensajes de Héctor empiezan a menudo con 🎯/🔍
// (briefing/análisis), por eso el chat exportaba sin contenido.
function pdfSanitize(text){
  return String(text||"")
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")    // emoji rango principal
    .replace(/[\u2600-\u27BF]/g, "")           // misc symbols + dingbats
    .replace(/[\u200D\uFE0F\u20E3]/g, "")      // ZWJ + variation selector
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "");   // banderas regionales
}

function pdfWriteWrapped(doc, text, x, y, {maxWidth = PDF_CONTENT_W, lineH = 5}={}){
  const safe = pdfSanitize(text);
  let lines;
  try { lines = doc.splitTextToSize(safe, maxWidth); }
  catch(e){ console.warn("[pdf] splitTextToSize failed:", e, "text:", safe.slice(0,80)); lines = [safe]; }
  for(const line of lines){
    y = pdfCheckPageBreak(doc, y, lineH);
    try { if(line) doc.text(line, x, y); }
    catch(e){ console.warn("[pdf] text() failed:", e, "line:", line); }
    y += lineH;
  }
  return y;
}

// Mensajes tipo transcript para chat de Héctor / AgentBriefingModal.
function renderChat(doc, y, messages, {userLabel = "Usuario", assistantLabel = "Héctor"} = {}){
  console.log("[pdf] renderChat · msgs:", (messages||[]).length, "· first:", messages?.[0]?.content?.slice(0,40));
  if(!messages || messages.length === 0){
    doc.setFont("helvetica","italic"); doc.setFontSize(10); doc.setTextColor(156,163,175);
    doc.text("(Sin mensajes)", PDF_MARGIN_L, y);
    return y + 6;
  }
  for(const m of messages){
    const isUser = m.role === "user";
    const who = isUser ? userLabel : assistantLabel;
    const date = m.timestamp ? new Date(m.timestamp).toLocaleString("es-ES",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "";
    const tag = m.kind === "briefing" ? "  [BRIEFING]" : m.kind === "analysis" ? "  [ANÁLISIS]" : "";
    const accent = isUser ? [127,119,221] : [29,158,117]; // purple user / green Héctor

    y = pdfCheckPageBreak(doc, y, 12);
    // Línea accent vertical a la izquierda
    doc.setDrawColor(accent[0],accent[1],accent[2]);
    doc.setLineWidth(0.8);
    doc.line(PDF_MARGIN_L, y - 3, PDF_MARGIN_L, y + 3);

    // Autor + timestamp + tag (sanitized para WinAnsi)
    doc.setFont("helvetica","bold"); doc.setFontSize(10);
    doc.setTextColor(accent[0],accent[1],accent[2]);
    try { doc.text(pdfSanitize(who + tag), PDF_MARGIN_L + 3, y); } catch(e){ console.warn("[pdf] author text failed:", e); }
    doc.setFont("helvetica","normal"); doc.setFontSize(8.5);
    doc.setTextColor(120,120,130);
    try { doc.text(pdfSanitize(date), PDF_MARGIN_L + PDF_CONTENT_W, y, { align:"right" }); } catch(e){ console.warn("[pdf] date text failed:", e); }
    y += 5;

    // Contenido del mensaje (pdfWriteWrapped ya sanea)
    doc.setFont("helvetica","normal"); doc.setFontSize(10);
    doc.setTextColor(31,41,55);
    y = pdfWriteWrapped(doc, m.content || "", PDF_MARGIN_L + 3, y, {maxWidth: PDF_CONTENT_W - 3});
    y += 4; // gap entre mensajes
  }
  return y;
}

// Sección con label en color + cuerpo (para briefings, consejos, etc).
function renderSection(doc, y, label, body, color = [14,124,90]){
  if(!body) return y;
  y = pdfCheckPageBreak(doc, y, 10);
  doc.setFont("helvetica","bold"); doc.setFontSize(9);
  doc.setTextColor(color[0],color[1],color[2]);
  doc.text(String(label||"").toUpperCase(), PDF_MARGIN_L, y);
  y += 2;
  doc.setDrawColor(color[0],color[1],color[2]);
  doc.setLineWidth(0.3);
  doc.line(PDF_MARGIN_L, y, PDF_MARGIN_L + PDF_CONTENT_W, y);
  y += 5;
  doc.setFont("helvetica","normal"); doc.setFontSize(10);
  doc.setTextColor(31,41,55);
  y = pdfWriteWrapped(doc, body, PDF_MARGIN_L, y);
  return y + 5;
}

// Análisis batch: tarea/proyecto + texto + tags, en formato lista.
function renderAnalysis(doc, y, analysis, criticalTasks, relProjs){
  if(!analysis){
    doc.setFont("helvetica","italic"); doc.setFontSize(10); doc.setTextColor(156,163,175);
    doc.text("(Sin análisis)", PDF_MARGIN_L, y);
    return y + 6;
  }
  const renderRow = (title, subtitle, meta)=>{
    y = pdfCheckPageBreak(doc, y, 16);
    doc.setFont("helvetica","bold"); doc.setFontSize(10.5);
    doc.setTextColor(17,24,39);
    y = pdfWriteWrapped(doc, title, PDF_MARGIN_L, y, {lineH: 5});
    if(subtitle){
      doc.setFont("helvetica","normal"); doc.setFontSize(9);
      doc.setTextColor(107,114,128);
      doc.text(subtitle, PDF_MARGIN_L, y);
      y += 5;
    }
    doc.setFont("helvetica","normal"); doc.setFontSize(10);
    doc.setTextColor(31,41,55);
    y = pdfWriteWrapped(doc, meta?.text || "(sin análisis)", PDF_MARGIN_L + 4, y, {maxWidth: PDF_CONTENT_W - 4, lineH: 4.8});
    const tags = (meta?.tags || []).filter(Boolean);
    if(tags.length){
      y = pdfCheckPageBreak(doc, y, 6);
      doc.setFont("helvetica","bold"); doc.setFontSize(8.5);
      doc.setTextColor(55,48,163);
      doc.text(tags.map(t=>`[${t}]`).join("  "), PDF_MARGIN_L + 4, y);
      y += 5;
    }
    y += 3;
  };
  const sectionHeader = (label)=>{
    y = pdfCheckPageBreak(doc, y, 10);
    doc.setFont("helvetica","bold"); doc.setFontSize(11);
    doc.setTextColor(30,64,175);
    doc.text(label, PDF_MARGIN_L, y);
    y += 2;
    doc.setDrawColor(30,64,175); doc.setLineWidth(0.3);
    doc.line(PDF_MARGIN_L, y, PDF_MARGIN_L + PDF_CONTENT_W, y);
    y += 5;
  };
  const taskIds = Object.keys(analysis.tasks || {});
  if(taskIds.length){
    sectionHeader(`TAREAS (${taskIds.length})`);
    for(const id of taskIds){
      const t = (criticalTasks || []).find(x => String(x.id) === String(id));
      renderRow(t?.title || `Tarea ${id}`, t ? `${t.projName} · ${t.colName}` : "", analysis.tasks[id]);
    }
    y += 3;
  }
  const projIds = Object.keys(analysis.projects || {});
  if(projIds.length){
    sectionHeader(`PROYECTOS (${projIds.length})`);
    for(const id of projIds){
      const r = (relProjs || []).find(x => String(x.p.id) === String(id));
      const p = r?.p;
      renderRow(p?.name || `Proyecto ${id}`, r ? `${r.activeCount} activas · ${r.overdueCount} vencidas` : "", analysis.projects[id]);
    }
  }
  if(analysis.generatedAt){
    y = pdfCheckPageBreak(doc, y, 6);
    doc.setFont("helvetica","italic"); doc.setFontSize(8.5);
    doc.setTextColor(156,163,175);
    doc.text(`Generado ${new Date(analysis.generatedAt).toLocaleString("es-ES")}`, PDF_MARGIN_L, y);
    y += 5;
  }
  return y;
}

// Informe de documento: tres secciones (resumen/riesgos/recomendaciones).
function renderDocumentReport(doc, y, report, docName, analyzedBy){
  y = pdfCheckPageBreak(doc, y, 10);
  doc.setFont("helvetica","bold"); doc.setFontSize(9);
  doc.setTextColor(107,114,128);
  const meta = `Documento: ${docName || ""}` + (analyzedBy ? ` · Analizado por ${analyzedBy}` : "");
  y = pdfWriteWrapped(doc, meta, PDF_MARGIN_L, y, {lineH: 4.5});
  y += 4;
  y = renderSection(doc, y, "Resumen ejecutivo",       report?.summary,         [30,64,175]);
  y = renderSection(doc, y, "Riesgos y oportunidades", report?.details,         [180,83,9]);
  y = renderSection(doc, y, "Recomendaciones",         report?.recommendations, [14,124,90]);
  return y;
}

function generatePDF({title, render, filename}){
  const doc = new jsPDF({ unit:"mm", format:"a4", orientation:"portrait" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const today = new Date().toLocaleDateString("es-ES", { year:"numeric", month:"long", day:"numeric" });

  // Renderiza el cuerpo — el renderer se encarga de los saltos de página.
  render(doc, PDF_TOP_CONTENT_Y);

  // Header + footer en TODAS las páginas (post-proceso).
  const pageCount = doc.internal.getNumberOfPages();
  for(let i = 1; i <= pageCount; i++){
    doc.setPage(i);
    // HEADER
    doc.setFont("helvetica","bold"); doc.setFontSize(13);
    doc.setTextColor(127,119,221);
    doc.text("SoulBaric", PDF_MARGIN_L, 14);
    doc.setFont("helvetica","normal"); doc.setFontSize(10);
    doc.setTextColor(55,65,81);
    doc.text(String(title||"").slice(0,70), PDF_MARGIN_L + 36, 14);
    doc.setFontSize(8.5); doc.setTextColor(156,163,175);
    doc.text(today, pageW - PDF_MARGIN_R, 14, { align:"right" });
    doc.setDrawColor(127,119,221); doc.setLineWidth(0.4);
    doc.line(PDF_MARGIN_L, 18, pageW - PDF_MARGIN_R, 18);
    // FOOTER
    doc.setDrawColor(229,231,235); doc.setLineWidth(0.2);
    doc.line(PDF_MARGIN_L, 280, pageW - PDF_MARGIN_R, 280);
    doc.setFont("helvetica","normal"); doc.setFontSize(8);
    doc.setTextColor(156,163,175);
    doc.text("Generado por SoulBaric · Confidencial", PDF_MARGIN_L, 286);
    doc.text(`Página ${i} de ${pageCount}`, pageW - PDF_MARGIN_R, 286, { align:"right" });
  }

  const fname = (filename || title || "documento").replace(/[^\w.-]+/g,"_") + ".pdf";
  doc.save(fname);
}

// API: pasa `render(doc, y) => newY` para rendering estructurado, o
// `plainText` (string) para caso simple.
function ExportPDFButton({title, filename, render, plainText, size="sm", label="PDF"}){
  const [busy,setBusy] = useState(false);
  const run = ()=>{
    setBusy(true);
    try {
      const renderFn = render || ((doc, y) => pdfWriteWrapped(doc, plainText || "", PDF_MARGIN_L, y));
      generatePDF({ title, render: renderFn, filename });
    } catch(e){
      console.warn("[pdf]", e);
    } finally {
      setBusy(false);
    }
  };
  const pad = size==="sm" ? "5px 10px" : "7px 14px";
  const fs  = size==="sm" ? 11 : 12.5;
  return(
    <button onClick={run} disabled={busy} title="Descargar como PDF" style={{padding:pad,borderRadius:6,background:busy?"#FEF3C7":"#fff",color:"#7F77DD",border:"1px solid #7F77DD",fontSize:fs,fontWeight:600,cursor:busy?"wait":"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:5}}>
      {busy?"⋯":"📄"} {busy?"Generando":label}
    </button>
  );
}

function PrintButton({size="sm", label="Imprimir"}){
  const pad = size==="sm" ? "5px 10px" : "7px 14px";
  const fs  = size==="sm" ? 11 : 12.5;
  return(
    <button onClick={()=>window.print()} title="Imprimir" style={{padding:pad,borderRadius:6,background:"#fff",color:"#374151",border:"1px solid #D1D5DB",fontSize:fs,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:5}}>
      🖨️ {label}
    </button>
  );
}

// Fuzzy subsequence match + highlight para el Command Palette.
function fuzzyMatch(text,query){
  if(!query) return true;
  const t=text.toLowerCase(), q=query.toLowerCase();
  let i=0;
  for(const ch of q){
    i=t.indexOf(ch,i);
    if(i<0) return false;
    i++;
  }
  return true;
}
function HighlightedText({text,query}){
  if(!query||!text) return text||null;
  const t=text.toLowerCase(), q=query.toLowerCase();
  const nodes=[]; let last=0, k=0;
  for(const ch of q){
    const idx=t.indexOf(ch,last);
    if(idx<0) break;
    if(idx>last) nodes.push(<span key={k++}>{text.slice(last,idx)}</span>);
    nodes.push(<strong key={k++} style={{color:"#1E40AF"}}>{text[idx]}</strong>);
    last=idx+1;
  }
  if(last<text.length) nodes.push(<span key={k++}>{text.slice(last)}</span>);
  return <>{nodes}</>;
}

// ── Alerts engine ─────────────────────────────────────────────────────────────
function genAlerts(boards,members){
  const alerts=[];
  const all=Object.values(boards).flatMap(cols=>cols.flatMap(col=>col.tasks.map(t=>({...t,colName:col.name}))));
  all.forEach(task=>{
    const days=daysUntil(task.dueDate),q=getQ(task);
    task.assignees.forEach(mid=>{
      if(days<0)  alerts.push({id:`ov-${task.id}-${mid}`,memberId:mid,taskId:task.id,taskTitle:task.title,type:"overdue", level:"critical",msg:`Vencida hace ${Math.abs(days)}d`,quadrant:q});
      else if(days===0) alerts.push({id:`td-${task.id}-${mid}`,memberId:mid,taskId:task.id,taskTitle:task.title,type:"today",   level:"critical",msg:"Vence hoy",quadrant:q});
      else if(days<=2)  alerts.push({id:`ur-${task.id}-${mid}`,memberId:mid,taskId:task.id,taskTitle:task.title,type:"urgent",  level:"warning", msg:`Vence en ${days}d`,quadrant:q});
      const logged=(task.timeLogs||[]).filter(l=>l.memberId===mid).reduce((s,l)=>s+l.seconds,0);
      const est=(task.estimatedHours||0)*3600;
      if(est>0&&logged>est*1.1) alerts.push({id:`ti-${task.id}-${mid}`,memberId:mid,taskId:task.id,taskTitle:task.title,type:"time",level:"warning",msg:`Tiempo superado: ${fmtH(logged)} vs ${fmtH(est)}`,quadrant:q});
    });
    // Alertas de subtareas
    (task.subtasks||[]).forEach(sub=>{
      if(sub.done||!sub.dueDate)return;
      const sd=daysUntil(sub.dueDate);
      const target=sub.assigneeId!=null?sub.assigneeId:(task.assignees[0]??null);
      if(target==null)return;
      const stTitle=`${task.title} › ${sub.title}`;
      if(sd<0)      alerts.push({id:`sov-${task.id}-${sub.id}`,memberId:target,taskId:task.id,taskTitle:stTitle,type:"subtask-overdue",level:"critical",msg:`Subtarea vencida hace ${Math.abs(sd)}d`,quadrant:q});
      else if(sd===0)alerts.push({id:`std-${task.id}-${sub.id}`,memberId:target,taskId:task.id,taskTitle:stTitle,type:"subtask-today",  level:"critical",msg:"Subtarea vence hoy",quadrant:q});
      else if(sd<=2) alerts.push({id:`sur-${task.id}-${sub.id}`,memberId:target,taskId:task.id,taskTitle:stTitle,type:"subtask-urgent", level:"warning", msg:`Subtarea vence en ${sd}d`,quadrant:q});
    });
  });
  members.forEach(m=>{
    const my=all.filter(t=>t.assignees.includes(m.id)&&t.colName!=="Hecho");
    const q1=my.filter(t=>getQ(t)==="Q1"),q2=my.filter(t=>getQ(t)==="Q2");
    if(q1.length>3) alerts.push({id:`adv-ol-${m.id}`,memberId:m.id,taskId:null,taskTitle:null,type:"advisor",level:"warning",msg:`${q1.length} tareas críticas simultáneas. Considera delegar.`});
    if(q2.length>0&&q1.length===0) alerts.push({id:`adv-q2-${m.id}`,memberId:m.id,taskId:null,taskTitle:null,type:"advisor",level:"info",msg:`Sin urgencias. Avanza en las ${q2.length} tareas Q2.`});
    if(my.length===0) alerts.push({id:`adv-fr-${m.id}`,memberId:m.id,taskId:null,taskTitle:null,type:"advisor",level:"success",msg:"Sin tareas asignadas. Habla con tu manager."});
  });
  return alerts;
}

// ── Member Profile Modal ──────────────────────────────────────────────────────
function ProfileModal({member,onClose,onSave}){
  const [avail,setAvail]=useState({...member.avail});
  const [newExc,setNewExc]=useState({date:"",type:"off",note:""});
  const [pendingClose,setPendingClose]=useState(false);
  const [initialSnap]=useState(()=>JSON.stringify({avail:member.avail,newExc:{date:"",type:"off",note:""}}));
  const isDirty=JSON.stringify({avail,newExc})!==initialSnap;
  const handleClose=()=>{ if(isDirty) setPendingClose(true); else onClose(); };
  useEffect(()=>{
    const onKey=e=>{ if(e.key==="Escape") handleClose(); };
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[isDirty]);
  const mp=MP[member.id]||MP[0];
  const toggleDay=d=>setAvail(p=>({...p,workDays:p.workDays.includes(d)?p.workDays.filter(x=>x!==d):[...p.workDays,d].sort()}));
  const addExc=()=>{ if(!newExc.date)return; setAvail(p=>({...p,exceptions:[...p.exceptions,{...newExc}]})); setNewExc({date:"",type:"off",note:""}); };

  return(
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&handleClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:3000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:40,overflowY:"auto"}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:560,maxWidth:"96vw",border:"0.5px solid #e5e7eb",borderTop:`4px solid ${mp.solid}`,marginBottom:24}}>
        <div style={{padding:"14px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:40,height:40,borderRadius:"50%",background:mp.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700}}>{member.initials}</div>
          <div style={{flex:1}}>
            <div style={{fontWeight:600,fontSize:15,color:mp.solid}}>{member.name}</div>
            <div style={{fontSize:12,color:"#6b7280"}}>{member.role} · {member.email}</div>
          </div>
          <button onClick={handleClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#6b7280"}}>x</button>
        </div>
        {pendingClose&&<DiscardBanner onKeep={()=>setPendingClose(false)} onDiscard={()=>{setPendingClose(false);onClose();}}/>}
        <div style={{padding:20}}>
          {/* Weekly schedule preview */}
          {(member.avail?.blockedSlots||[]).length>0&&(
            <div style={{background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:10,padding:"10px 14px",marginBottom:16}}>
              <div style={{fontSize:11,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>Horario semanal</div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {["Lun","Mar","Mié","Jue","Vie","Sáb"].map((d,di)=>{
                  const dow=[1,2,3,4,5,6][di];
                  const isWork=member.avail.workDays.includes(dow);
                  const blocks=(member.avail.blockedSlots||[]).filter(b=>b.days.includes(dow));
                  return(
                    <div key={d} style={{flex:1,minWidth:65,background:isWork?"#fff":"#f3f4f6",border:`1px solid ${isWork?mp.solid+"44":"#e5e7eb"}`,borderRadius:8,padding:"6px 8px"}}>
                      <div style={{fontSize:11,fontWeight:600,color:isWork?mp.solid:"#9ca3af",marginBottom:3}}>{d}</div>
                      {isWork&&<>
                        <div style={{fontSize:9,color:"#1D9E75",marginBottom:2}}>OK {member.avail.morningStart}-{member.avail.morningEnd}</div>
                        <div style={{fontSize:9,color:"#378ADD",marginBottom:3}}>OK {member.avail.afternoonStart}-{member.avail.afternoonEnd}</div>
                      </>}
                      {blocks.map((b,i)=><div key={i} style={{fontSize:8,color:"#9ca3af",background:"#f3f4f6",borderRadius:3,padding:"1px 4px",marginBottom:2}}>X {b.label}</div>)}
                      {!isWork&&<div style={{fontSize:10,color:"#d1d5db"}}>Descanso</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <FL c="Días laborables"/>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {[1,2,3,4,5,6,0].map(d=>(
              <button key={d} onClick={()=>toggleDay(d)} style={{padding:"5px 10px",borderRadius:8,background:avail.workDays.includes(d)?mp.light:"#f9fafb",color:avail.workDays.includes(d)?mp.solid:"#6b7280",border:`1.5px solid ${avail.workDays.includes(d)?mp.solid:"#e5e7eb"}`,fontSize:12,cursor:"pointer",fontWeight:avail.workDays.includes(d)?600:400}}>{DOW[d]}</button>
            ))}
          </div>

          <FL c="Horario de mañana"/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <div><div style={{fontSize:11,color:"#9ca3af",marginBottom:3}}>Inicio</div><FI type="time" value={avail.morningStart} onChange={v=>setAvail(p=>({...p,morningStart:v}))}/></div>
            <div><div style={{fontSize:11,color:"#9ca3af",marginBottom:3}}>Fin</div><FI type="time" value={avail.morningEnd} onChange={v=>setAvail(p=>({...p,morningEnd:v}))}/></div>
          </div>
          <FL c="Horario de tarde"/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <div><div style={{fontSize:11,color:"#9ca3af",marginBottom:3}}>Inicio</div><FI type="time" value={avail.afternoonStart} onChange={v=>setAvail(p=>({...p,afternoonStart:v}))}/></div>
            <div><div style={{fontSize:11,color:"#9ca3af",marginBottom:3}}>Fin</div><FI type="time" value={avail.afternoonEnd} onChange={v=>setAvail(p=>({...p,afternoonEnd:v}))}/></div>
          </div>
          <FL c="Horas productivas por día"/>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <input type="range" min={1} max={10} step={0.5} value={avail.hoursPerDay} onChange={e=>setAvail(p=>({...p,hoursPerDay:Number(e.target.value)}))} style={{flex:1}}/>
            <span style={{fontSize:14,fontWeight:600,color:mp.solid,minWidth:36}}>{avail.hoursPerDay}h</span>
          </div>

          <FL c="Google Calendar — URL secreta ICS"/>
          <FI value={avail.icsUrl||""} onChange={v=>setAvail(p=>({...p,icsUrl:v}))} placeholder="https://calendar.google.com/calendar/ical/...basic.ics"/>
          {avail.icsUrl&&(()=>{
            const cached=getCachedEvents(member.id);
            const today=fmt(TODAY);
            const todayEvs=cached?cached.filter(e=>e.date===today):null;
            return(
              <div style={{display:"flex",flexDirection:"column",gap:4,marginTop:4}}>
                <div style={{fontSize:10,background:"#E1F5EE",color:"#085041",border:"1px solid #1D9E75",borderRadius:6,padding:"3px 8px"}}>Calendario conectado — el planificador respeta mañana y tarde</div>
                {cached===null?(
                  <div style={{fontSize:10,background:"#FEF3C7",color:"#92400E",border:"1px solid #F59E0B",borderRadius:6,padding:"3px 8px"}}>📅 Sin sincronizar aún — ejecuta el Planificador IA para cargar eventos</div>
                ):(
                  <div style={{fontSize:10,background:cached.length>0?"#EEF2FF":"#FEE2E2",color:cached.length>0?"#3730A3":"#991B1B",border:`1px solid ${cached.length>0?"#6366F1":"#EF4444"}`,borderRadius:6,padding:"3px 8px"}}>📅 {cached.length} eventos cargados · hoy: {todayEvs?.length||0} {cached.length===0?"— revisa la URL o el proxy CORS":""}</div>
                )}
                <button onClick={()=>{delete ICS_CACHE[member.id];alert("Caché ICS limpiada. Ejecuta el planificador para recargar.");}} style={{alignSelf:"flex-start",fontSize:10,padding:"2px 8px",borderRadius:6,border:"1px solid #d1d5db",background:"#fff",cursor:"pointer",color:"#6b7280"}}>🔄 Limpiar caché ICS</button>
              </div>
            );
          })()}

          <FL c="Margen de transporte (minutos)"/>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <input type="range" min={0} max={60} step={5} value={avail.transportMarginMins||30} onChange={e=>setAvail(p=>({...p,transportMarginMins:Number(e.target.value)}))} style={{flex:1}}/>
            <span style={{fontSize:13,fontWeight:600,color:mp.solid,minWidth:50}}>{avail.transportMarginMins||30} min</span>
          </div>
          <div style={{fontSize:11,color:"#9ca3af",marginTop:2}}>Tiempo antes/despues de clases y actividades con desplazamiento</div>

          <FL c="WhatsApp"/>
          <div style={{display:"flex",gap:8}}>
            <FI value={avail.whatsapp} onChange={v=>setAvail(p=>({...p,whatsapp:v}))} placeholder="+34600000000"/>
          </div>

          <FL c="Excepciones (dias libres / medias jornadas)"/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 2fr auto",gap:8,marginBottom:8}}>
            <input type="date" value={newExc.date} onChange={e=>setNewExc(p=>({...p,date:e.target.value}))} style={{padding:"6px 8px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:12}}/>
            <select value={newExc.type} onChange={e=>setNewExc(p=>({...p,type:e.target.value}))} style={{padding:"6px 8px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:12,background:"#fff"}}>
              <option value="off">Dia libre</option>
              <option value="half">Media jornada</option>
            </select>
            <input value={newExc.note} onChange={e=>setNewExc(p=>({...p,note:e.target.value}))} placeholder="Motivo..." style={{padding:"6px 8px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:12,outline:"none",fontFamily:"inherit"}}/>
            <button onClick={addExc} style={{padding:"6px 12px",borderRadius:8,background:mp.solid,color:"#fff",border:"none",fontSize:12,cursor:"pointer",fontWeight:600}}>+</button>
          </div>
          {avail.exceptions.map((e,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 10px",background:e.type==="off"?"#FCEBEB":"#FAEEDA",borderRadius:8,marginBottom:4,fontSize:12}}>
              <span style={{fontWeight:500}}>{e.date}</span>
              <span style={{color:"#6b7280"}}>{e.type==="off"?"Dia libre":"Media jornada"}</span>
              {e.note&&<span style={{color:"#6b7280"}}>— {e.note}</span>}
              <button onClick={()=>setAvail(p=>({...p,exceptions:p.exceptions.filter((_,j)=>j!==i)}))} style={{marginLeft:"auto",background:"none",border:"none",fontSize:13,cursor:"pointer",color:"#9ca3af"}}>x</button>
            </div>
          ))}

          <div style={{display:"flex",gap:8,marginTop:20,justifyContent:"flex-end"}}>
            <button onClick={onClose} style={{padding:"8px 16px",borderRadius:8,border:"0.5px solid #d1d5db",background:"transparent",fontSize:13,cursor:"pointer"}}>Cancelar</button>
            <button onClick={()=>{onSave(avail);onClose();}} style={{padding:"8px 20px",borderRadius:8,background:mp.solid,color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>Guardar perfil</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Planner View ──────────────────────────────────────────────────────────────
function PlannerView({data,onApplySchedule,saveMemberProfile,onUpdateTask}){
  const [result,setResult]=useState(null);
  const [running,setRunning]=useState(false);
  const [icsStatus,setIcsStatus]=useState({});
  const [waSent,setWaSent]=useState({});
  const [profileMember,setProfileMember]=useState(null);
  const [editingTask,setEditingTask]=useState(null);
  const members=data.members;
  useEffect(()=>{ setResult(null); },[members]);
  const findTaskContext=useCallback(taskId=>{
    for(const pid in data.boards){
      for(const col of data.boards[pid]){
        const t=col.tasks.find(x=>x.id===taskId);
        if(t)return{task:t,colId:col.id,cols:data.boards[pid]};
      }
    }
    return null;
  },[data.boards]);
  const workDays=getWorkDays(fmt(TODAY),PLAN_HORIZON_DAYS);

  const run=async()=>{
    setRunning(true);
    const icsMs=members.filter(m=>m.avail?.icsUrl);
    if(icsMs.length>0){ const s={}; icsMs.forEach(m=>{s[m.id]="loading";}); setIcsStatus(s); }
    try{
      const r=await runPlanner(data.boards,members,data.aiSchedule);
      const s={}; icsMs.forEach(m=>{s[m.id]="ok";}); setIcsStatus(s);
      setResult(r);
    }catch(e){
      const s={}; icsMs.forEach(m=>{s[m.id]="error";}); setIcsStatus(s);
    }
    setRunning(false);
  };

  const sendWA=(member)=>{
    if(!result)return;
    const url=waUrl(member,waMsg(member,result.schedule,result.planLog));
    if(url){window.open(url,"_blank");setWaSent(p=>({...p,[member.id]:true}));}
  };

  return(
    <div style={{padding:20}}>
      {/* ICS status */}
      {Object.keys(icsStatus).length>0&&(
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
          {members.filter(m=>icsStatus[m.id]).map(m=>{
            const st=icsStatus[m.id]; const mp2=MP[m.id]||MP[0];
            return(
              <div key={m.id} style={{display:"flex",alignItems:"center",gap:6,padding:"5px 12px",borderRadius:20,fontSize:11,fontWeight:500,background:st==="ok"?"#E1F5EE":st==="error"?"#FCEBEB":"#EEEDFE",color:st==="ok"?"#085041":st==="error"?"#A32D2D":"#3C3489",border:`1px solid ${st==="ok"?"#1D9E75":st==="error"?"#E24B4A":"#7F77DD"}`}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:st==="ok"?"#1D9E75":st==="error"?"#E24B4A":"#7F77DD"}}/>
                {m.initials} Google Calendar: {st==="loading"?"Leyendo...":st==="ok"?"Sincronizado":"Error"}
              </div>
            );
          })}
        </div>
      )}

      {/* Header */}
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:16,fontWeight:700,marginBottom:3}}>Agente IA de planificacion</div>
          <div style={{fontSize:12,color:"#6b7280"}}>Asigna tareas segun disponibilidad real, Eisenhower y calendario</div>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {result&&<button onClick={()=>members.forEach(m=>m.avail?.whatsapp&&setTimeout(()=>sendWA(m),200*m.id))} style={{padding:"8px 14px",borderRadius:8,background:"#25D366",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>Notificar todos (WA)</button>}
          {result&&<button onClick={()=>onApplySchedule(result.schedule)} style={{padding:"8px 16px",borderRadius:8,background:"#1D9E75",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>Aplicar plan</button>}
          <button onClick={run} disabled={running} style={{padding:"8px 20px",borderRadius:8,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600,opacity:running?0.7:1}}>
            {running?"Planificando...":"Planificar ahora"}
          </button>
        </div>
      </div>

      {/* Availability table */}
      <div style={{marginBottom:20}}>
        <div style={{fontSize:13,fontWeight:600,marginBottom:10}}>Disponibilidad del equipo — proximos {PLAN_HORIZON_DAYS} dias</div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead>
              <tr>
                <th style={{textAlign:"left",padding:"6px 10px",borderBottom:"1px solid #e5e7eb",fontWeight:600,color:"#6b7280",width:140}}>Persona</th>
                {workDays.map(d=>{
                  const isToday=d===fmt(TODAY);
                  return(
                    <th key={d} style={{padding:"4px 6px",textAlign:"center",borderBottom:"1px solid #e5e7eb",fontWeight:isToday?700:500,color:isToday?"#7F77DD":"#374151",minWidth:50,background:isToday?"#EEEDFE":"transparent"}}>
                      <div>{dayName(d)}</div>
                      <div style={{fontSize:10,color:"#9ca3af",fontWeight:400}}>{d.slice(5)}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {members.map(m=>{
                const mp2=MP[m.id]||MP[0];
                return(
                  <tr key={m.id}>
                    <td style={{padding:"6px 10px",borderBottom:"0.5px solid #f3f4f6"}}>
                      <div style={{display:"flex",alignItems:"center",gap:7}}>
                        <div style={{width:26,height:26,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,flexShrink:0}}>{m.initials}</div>
                        <div style={{minWidth:0}}>
                          <div style={{fontSize:12,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.name.split(" ")[0]}</div>
                          <div style={{fontSize:10,color:"#9ca3af"}}>{m.avail.hoursPerDay}h/d</div>
                        </div>
                        <button onClick={()=>setProfileMember(m)} style={{marginLeft:"auto",background:"none",border:"none",fontSize:12,cursor:"pointer",color:"#9ca3af",padding:"2px 4px"}}>✏️</button>
                      </div>
                    </td>
                    {workDays.map(d=>{
                      const avH=getAvailHours(m,d);
                      const cachedEvs=getCachedEvents(m.id);
                      const icsEvs=(cachedEvs||[]).filter(e=>e.date===d);
                      // Mirror planner's logic: use calcFreeMorning+calcFreeSlots for real capacity
                      const freeMorn=calcFreeMorning(icsEvs,m,d);
                      const freeAft=calcFreeSlots(icsEvs,m,d);
                      const effectiveH=freeMorn.reduce((s,x)=>s+x.hours,0)+freeAft.reduce((s,x)=>s+x.hours,0);
                      const icsBusyH=Math.max(0,avH-effectiveH);
                      const used=result?(result.load[m.id]?.[d]||0):0;
                      const pct=effectiveH>0?Math.min(Math.round(used/effectiveH*100),100):0;
                      const exc=m.avail.exceptions?.find(e=>e.date===d);
                      const labels=getBlockLabels(m,d);
                      return(
                        <td key={d} style={{padding:"3px 4px",textAlign:"center",borderBottom:"0.5px solid #f3f4f6",verticalAlign:"top"}}>
                          {avH===0?(
                            <div style={{fontSize:10,color:"#d1d5db",paddingTop:6}}>{exc?.type==="half"?"½":"—"}</div>
                          ):(
                            <div>
                              <div style={{height:26,background:"#f3f4f6",borderRadius:6,overflow:"hidden",position:"relative",marginBottom:2}}>
                                <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                                  <div style={{height:"100%",width:`${pct}%`,background:pct>=90?"#E24B4A":pct>=70?"#EF9F27":"#1D9E75",position:"absolute",left:0,top:0,opacity:0.7,borderRadius:6}}/>
                                  <span style={{fontSize:10,fontWeight:600,position:"relative",color:pct>50?"#fff":"#374151"}}>{effectiveH.toFixed(icsBusyH>0?1:0)}h{icsBusyH>0?<span style={{fontSize:8,opacity:0.8}}> /{avH}</span>:null}</span>
                                </div>
                              </div>
                              {labels.slice(0,2).map((bl,bi)=>(
                                <div key={bi} style={{fontSize:8,color:"#9ca3af",background:"#f9fafb",borderRadius:3,padding:"1px 3px",marginBottom:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:52}}>X {bl}</div>
                              ))}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{display:"flex",gap:10,marginTop:8,fontSize:11,color:"#6b7280",alignItems:"center"}}>
          <div style={{width:12,height:12,borderRadius:3,background:"#1D9E75",opacity:0.7}}/><span>Disponible</span>
          <div style={{width:12,height:12,borderRadius:3,background:"#EF9F27",opacity:0.7}}/><span>+70%</span>
          <div style={{width:12,height:12,borderRadius:3,background:"#E24B4A",opacity:0.7}}/><span>Al limite</span>
        </div>
      </div>

      {/* Results */}
      {result&&(
        <>
          {result.insights.length>0&&(
            <div style={{marginBottom:16}}>
              <div style={{fontSize:13,fontWeight:600,marginBottom:8}}>Analisis del agente</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {result.insights.map((ins,i)=>{
                  const s={warning:{bg:"#fffbf0",border:"#EF9F27",text:"#854F0B",icon:"⚠️"},info:{bg:"#f0f7ff",border:"#378ADD",text:"#0C447C",icon:"ℹ️"},success:{bg:"#f0fdf7",border:"#1D9E75",text:"#085041",icon:"✅"}}[ins.type]||{bg:"#f9fafb",border:"#e5e7eb",text:"#374151",icon:"•"};
                  return(
                    <div key={i} style={{display:"flex",gap:8,padding:"8px 12px",background:s.bg,border:`1px solid ${s.border}`,borderRadius:8}}>
                      <span style={{flexShrink:0}}>{s.icon}</span>
                      <span style={{fontSize:12,color:s.text}}>{ins.msg}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{fontSize:13,fontWeight:600,marginBottom:10}}>Plan por persona</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12,marginBottom:20}}>
            {members.map(m=>{
              const mp2=MP[m.id]||MP[0];
              const myLog=result.planLog.filter(l=>l.memberId===m.id);
              const mySlots=result.schedule.filter(s=>s.memberId===m.id);
              const totalH=mySlots.reduce((s,x)=>s+x.hours,0);
              const wu=waUrl(m,waMsg(m,mySlots,result.planLog));
              const icsOk=!!m.avail?.icsUrl;
              return(
                <div key={m.id} style={{background:"#fff",border:`1.5px solid ${mp2.solid}22`,borderLeft:`4px solid ${mp2.solid}`,borderRadius:12,padding:14}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                    <div style={{width:34,height:34,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{m.initials}</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:600,color:mp2.solid}}>{m.name}</div>
                      <div style={{fontSize:11,color:"#6b7280"}}>
                        {myLog.length} tareas · {totalH.toFixed(1)}h
                        {icsOk&&<span style={{marginLeft:6,background:"#E1F5EE",color:"#085041",border:"1px solid #1D9E75",borderRadius:4,padding:"1px 5px",fontSize:9}}>Cal. conectado</span>}
                      </div>
                    </div>
                    <div style={{display:"flex",gap:5}}>
                      {wu&&<a href={wu} target="_blank" rel="noreferrer" style={{width:30,height:30,borderRadius:8,background:"#25D366",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:13,textDecoration:"none"}}>{waSent[m.id]?"✓":"💬"}</a>}
                    </div>
                  </div>
                  {myLog.length===0&&<div style={{fontSize:11,color:"#9ca3af",textAlign:"center",padding:8}}>Sin tareas</div>}
                  {myLog.slice(0,4).map((log,i)=>(
                    <div key={i} onClick={()=>{const ctx=findTaskContext(log.taskId); if(ctx)setEditingTask(ctx);}} style={{display:"flex",alignItems:"flex-start",gap:6,padding:"5px 0",borderTop:i>0?"0.5px solid #f3f4f6":"none",cursor:"pointer",borderRadius:4}} onMouseEnter={e=>e.currentTarget.style.background="#f9fafb"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <QBadge q={log.quadrant}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:11,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{log.taskTitle}</div>
                        <div style={{fontSize:10,color:"#9ca3af"}}>{log.slots.slice(0,1).join(" · ")} · {log.totalScheduled.toFixed(1)}h</div>
                      </div>
                    </div>
                  ))}
                  {myLog.length>4&&<div style={{fontSize:11,color:"#9ca3af",marginTop:4}}>+{myLog.length-4} mas...</div>}
                </div>
              );
            })}
          </div>

          {/* Timeline */}
          <div style={{fontSize:13,fontWeight:600,marginBottom:10}}>Timeline</div>
          <div style={{overflowX:"auto"}}>
            <div style={{display:"grid",gridTemplateColumns:`120px repeat(${workDays.length},1fr)`,gap:2,minWidth:600}}>
              <div style={{padding:"4px 8px",fontSize:11,fontWeight:600,color:"#9ca3af"}}>Persona</div>
              {workDays.map(d=>(
                <div key={d} style={{padding:"4px 4px",textAlign:"center",fontSize:10,fontWeight:d===fmt(TODAY)?700:400,color:d===fmt(TODAY)?"#7F77DD":"#6b7280",background:d===fmt(TODAY)?"#EEEDFE":"transparent",borderRadius:4}}>
                  {dayName(d)}<br/><span style={{fontSize:9}}>{d.slice(5)}</span>
                </div>
              ))}
              {members.map(m=>{
                const mp2=MP[m.id]||MP[0];
                return(
                  <React.Fragment key={m.id}>
                    <div style={{display:"flex",alignItems:"center",gap:6,padding:"3px 8px"}}>
                      <div style={{width:20,height:20,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:700,flexShrink:0}}>{m.initials}</div>
                      <span style={{fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.name.split(" ")[0]}</span>
                    </div>
                    {workDays.map(d=>{
                      const slots=result.schedule.filter(s=>s.memberId===m.id&&s.date===d);
                      const avH=getAvailHours(m,d);
                      return(
                        <div key={d} style={{padding:2,minHeight:36,background:avH===0?"#f9fafb":"transparent",borderRadius:4}}>
                          {avH===0&&<div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:"#d1d5db"}}>—</div>}
                          {slots.slice(0,2).map((slot,si)=>(
                            <div key={si} title={`${slot.taskTitle} · ${slot.hours}h`} style={{background:mp2.light,border:`1px solid ${mp2.solid}`,borderRadius:4,padding:"2px 4px",fontSize:9,fontWeight:600,color:mp2.solid,marginBottom:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                              {slot.hours.toFixed(1)}h {slot.respectsCalendar?"📅":""}
                            </div>
                          ))}
                          {slots.length>2&&<div style={{fontSize:9,color:"#9ca3af"}}>+{slots.length-2}</div>}
                        </div>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </>
      )}

      {!result&&!running&&(
        <div style={{textAlign:"center",padding:"40px 20px",background:"#f9fafb",borderRadius:12,border:"1px dashed #d1d5db"}}>
          <div style={{fontSize:32,marginBottom:12}}>⚡</div>
          <div style={{fontSize:14,fontWeight:600,marginBottom:6}}>Listo para planificar</div>
          <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>El agente analizara tareas, Eisenhower y el calendario real de Marc para asignar automaticamente los bloques optimos</div>
          <button onClick={run} style={{padding:"10px 24px",borderRadius:10,background:"#7F77DD",color:"#fff",border:"none",fontSize:14,cursor:"pointer",fontWeight:600}}>Planificar ahora</button>
        </div>
      )}

      {running&&(
        <div style={{textAlign:"center",padding:"40px 20px"}}>
          <div style={{fontSize:32,marginBottom:12}}>⏳</div>
          <div style={{fontSize:14,fontWeight:600,marginBottom:4}}>Leyendo calendario y calculando slots...</div>
          <div style={{fontSize:12,color:"#6b7280"}}>Eisenhower + fechas limite + disponibilidad real</div>
        </div>
      )}

      {profileMember&&<ProfileModal member={profileMember} onClose={()=>setProfileMember(null)} onSave={avail=>{saveMemberProfile?.(profileMember.id,avail);delete ICS_CACHE[profileMember.id];setResult(null);}}/>}
      {editingTask&&<TaskModal task={editingTask.task} colId={editingTask.colId} cols={editingTask.cols} members={data.members} activeMemberId={0} workspaceLinks={[]} agents={data.agents||[]} ceoMemory={data.ceoMemory} onClose={()=>setEditingTask(null)} onUpdate={(id,cid,upd)=>{onUpdateTask?.(id,upd);setEditingTask(prev=>prev?{...prev,task:upd}:null);}} onMove={()=>setEditingTask(null)}/>}
    </div>
  );
}

// ── Task Modal ────────────────────────────────────────────────────────────────
function TaskModal({task,colId,cols,members,activeMemberId,workspaceLinks,agents,ceoMemory,canDelete,onClose,onUpdate,onMove,onDelete}){
  const [editing,setEditing]=useState(false);
  const [draft,setDraft]=useState({...task});
  const [comment,setComment]=useState("");
  const [tab,setTab]=useState("detail");
  const [running,setRunning]=useState(false);
  const [elapsed,setElapsed]=useState(0);
  const [note,setNote]=useState("");
  const [saved,setSaved]=useState(false);
  const [newSubTitle,setNewSubTitle]=useState("");
  const [editingSubId,setEditingSubId]=useState(null);
  const [editSubDraft,setEditSubDraft]=useState("");
  const [newLink,setNewLink]=useState({label:"",url:"",icon:"🔗"});
  const [avatarOpen,setAvatarOpen]=useState(false);
  const [pendingClose,setPendingClose]=useState(false);
  const [confirmDelete,setConfirmDelete]=useState(false);
  const intRef=useRef(null);
  const p2=palOf(task.assignees); const q=getQ(task);

  useEffect(()=>{
    if(running){ const start=Date.now()-elapsed*1000; intRef.current=setInterval(()=>setElapsed(Math.floor((Date.now()-start)/1000)),500); }
    else clearInterval(intRef.current);
    return()=>clearInterval(intRef.current);
  },[running]);

  const set=(k,v)=>setDraft(p=>({...p,[k]:v}));
  const saveEdits=()=>{ onUpdate(task.id,colId,draft); setEditing(false); };
  const addComment=()=>{ const t=comment.trim(); if(!t)return; const u={...task,comments:[...task.comments,{author:activeMemberId,text:t,time:"ahora mismo"}]}; onUpdate(task.id,colId,u); setComment(""); };
  const saveTime=()=>{ if(elapsed<1)return; const u={...task,timeLogs:[...(task.timeLogs||[]),{memberId:activeMemberId,seconds:elapsed,note:note.trim()||"Sin nota",date:fmt(new Date())}]}; onUpdate(task.id,colId,u); setElapsed(0); setRunning(false); setNote(""); setSaved(true); setTimeout(()=>setSaved(false),2500); };

  // ── Subtareas ──
  const subs=task.subtasks||[];
  const subsDone=subs.filter(s=>s.done).length;
  const subPct=subs.length?Math.round(subsDone/subs.length*100):0;
  const mutateSubs=(fn)=>{ const ns=fn(subs); onUpdate(task.id,colId,{...task,subtasks:ns}); };
  const addSubtask=()=>{ const t=newSubTitle.trim(); if(!t)return; const id="st_"+Date.now().toString(36)+Math.random().toString(36).slice(2,5); mutateSubs(s=>[...s,{id,title:t,done:false,dueDate:"",assigneeId:null}]); setNewSubTitle(""); };
  const toggleSub=(id)=>mutateSubs(s=>s.map(x=>x.id===id?{...x,done:!x.done}:x));
  const patchSub=(id,patch)=>mutateSubs(s=>s.map(x=>x.id===id?{...x,...patch}:x));
  const deleteSub=(id)=>mutateSubs(s=>s.filter(x=>x.id!==id));
  const commitEditSub=()=>{ const t=editSubDraft.trim(); if(t && editingSubId){ patchSub(editingSubId,{title:t}); } setEditingSubId(null); };

  // ── Links ──
  const links = task.links||[];
  const mutateLinks=(fn)=>onUpdate(task.id,colId,{...task,links:fn(links)});
  const addLink=()=>{ const u=newLink.url.trim(); if(!u)return; mutateLinks(ls=>[...ls,{id:_uid("tl"),label:newLink.label.trim()||u,url:u,icon:newLink.icon||"🔗"}]); setNewLink({label:"",url:"",icon:"🔗"}); };
  const delLink=id=>mutateLinks(ls=>ls.filter(l=>l.id!==id));

  const totalLogged=(task.timeLogs||[]).reduce((s,l)=>s+l.seconds,0);
  const est=(task.estimatedHours||0)*3600;
  const pct=est>0?Math.min(Math.round(totalLogged/est*100),100):null;
  const gcUrl=gCalUrl(task,null);
  const wu=waUrl(members.find(m=>m.id===activeMemberId),`Tarea: "${task.title}" — vence ${task.dueDate||"sin fecha"}. Prioridad ${task.priority}.`);

  // Protección contra missclicks: si hay texto en curso o se está editando, un
  // intento de cerrar (clic fuera, X o Esc) pide confirmación en vez de descartar.
  const isDirty = editing
    || newSubTitle.trim().length>0
    || (newLink.url||"").trim().length>0
    || comment.trim().length>0
    || note.trim().length>0;
  const handleClose = () => { if(isDirty) setPendingClose(true); else onClose(); };
  useEffect(()=>{
    const onKey = e => { if(e.key==="Escape" && !avatarOpen) handleClose(); };
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  },[isDirty,avatarOpen]);

  return(
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&handleClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:1000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:40,paddingBottom:20,overflowY:"auto"}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:580,maxWidth:"96vw",border:"0.5px solid #e5e7eb",borderTop:`4px solid ${p2?p2.cardBorder:"#7F77DD"}`,marginBottom:20}}>
        <div style={{padding:"14px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",gap:10}}>
          {editing
            ?<input value={draft.title} onChange={e=>set("title",e.target.value)} style={{flex:1,fontSize:15,fontWeight:600,border:"none",outline:"2px solid #7F77DD",borderRadius:6,padding:"4px 8px",fontFamily:"inherit"}}/>
            :<div style={{flex:1,fontWeight:600,fontSize:15}}>{task.title}</div>
          }
          <div style={{display:"flex",gap:6}}>
            {!editing
              ?<>
                <button onClick={()=>setAvatarOpen(true)} title="Hablar con asesor IA" style={{padding:"5px 12px",borderRadius:7,border:"none",background:"linear-gradient(135deg,#7F77DD,#E76AA1)",color:"#fff",fontSize:12,cursor:"pointer",fontWeight:600,display:"flex",alignItems:"center",gap:5}}>🎙️ Asesor IA</button>
                <button onClick={()=>{setEditing(true);setDraft({...task});}} style={{padding:"5px 12px",borderRadius:7,border:"0.5px solid #d1d5db",background:"#f9fafb",fontSize:12,cursor:"pointer",fontWeight:500}}>Editar</button>
              </>
              :<><button onClick={saveEdits} style={{padding:"5px 12px",borderRadius:7,border:"none",background:"#7F77DD",color:"#fff",fontSize:12,cursor:"pointer",fontWeight:500}}>Guardar</button><button onClick={()=>setEditing(false)} style={{padding:"5px 10px",borderRadius:7,border:"0.5px solid #d1d5db",background:"transparent",fontSize:12,cursor:"pointer"}}>X</button></>
            }
            <button onClick={handleClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#6b7280",lineHeight:1}}>x</button>
          </div>
        </div>
        {pendingClose&&<DiscardBanner onKeep={()=>setPendingClose(false)} onDiscard={()=>{setPendingClose(false);onClose();}}/>}
        {avatarOpen&&<AvatarModal task={task} members={members} connectedAgents={(agents||[]).filter(a=>(task.agentIds||[]).includes(a.id))} ceoMemory={ceoMemory} onClose={()=>setAvatarOpen(false)} onSetCategory={cat=>onUpdate(task.id,colId,{...task,category:cat})} onMutateTask={newTask=>onUpdate(task.id,colId,newTask)}/>}
        {/* Tabs */}
        <div style={{display:"flex",borderBottom:"0.5px solid #e5e7eb",padding:"0 20px"}}>
          {[["detail","Detalle"],["subtasks","Subtareas"],["links","Enlaces"],["time","Tiempo"],["comments","Comentarios"],["documents","Documentos"]].map(([k,l])=>(
            <div key={k} onClick={()=>setTab(k)} style={{padding:"9px 14px",fontSize:12,cursor:"pointer",borderBottom:tab===k?"2px solid #7F77DD":"2px solid transparent",color:tab===k?"#7F77DD":"#6b7280",fontWeight:tab===k?600:400,marginBottom:-0.5}}>{l}{k==="subtasks"&&subs.length>0?` ${subsDone}/${subs.length}`:""}{k==="links"&&links.length>0?` (${links.length})`:""}{k==="time"&&totalLogged>0?` · ${fmtH(totalLogged)}`:""}{k==="comments"&&task.comments.length>0?` (${task.comments.length})`:""}{k==="documents"&&(task.documents||[]).length>0?` (${(task.documents||[]).length})`:""}</div>
          ))}
        </div>
        <div style={{padding:20}}>
          {tab==="detail"&&(
            <>
              <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
                <PriBadge p={editing?draft.priority:task.priority}/>
                <QBadge q={q}/>
                <div style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"#6b7280"}}>
                  Mover a:
                  <select value={colId} onChange={e=>onMove(task.id,colId,e.target.value)} style={{fontSize:12,padding:"3px 8px",borderRadius:8,border:"0.5px solid #d1d5db",background:"#fff"}}>
                    {cols.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>
              {editing?(
                <>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    <div><FL c="Prioridad"/><select value={draft.priority} onChange={e=>set("priority",e.target.value)} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,background:"#fff",fontFamily:"inherit"}}><option value="alta">Alta</option><option value="media">Media</option><option value="baja">Baja</option></select></div>
                    <div><FL c="Horas estimadas"/><FI type="number" value={draft.estimatedHours} onChange={v=>set("estimatedHours",Number(v))} placeholder="ej. 8"/></div>
                    <div><FL c="Fecha inicio"/><FI type="date" value={draft.startDate} onChange={v=>set("startDate",v)}/></div>
                    <div>
                      <FL c="Fecha límite + hora"/>
                      <div style={{display:"flex",gap:6}}>
                        <FI type="date" value={draft.dueDate} onChange={v=>set("dueDate",v)}/>
                        <input
                          type="time"
                          value={draft.dueTime||""}
                          onChange={e=>set("dueTime",e.target.value)}
                          step="300"
                          style={{padding:"7px 8px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit",background:"#fff",width:96,flexShrink:0}}
                        />
                      </div>
                    </div>
                    <div style={{gridColumn:"1 / -1"}}>
                      <FL c="Categoría del asesor IA"/>
                      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                        {AVATAR_KEYS.map(k=>{ const av=AVATARS[k]; const sel=draft.category===k; return(
                          <button key={k} type="button" onClick={()=>set("category",sel?null:k)} style={{display:"flex",alignItems:"center",gap:5,padding:"4px 10px",borderRadius:20,border:`1.5px solid ${sel?av.color:"#e5e7eb"}`,background:sel?av.color+"15":"#fff",cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:600,color:sel?av.color:"#6b7280"}}>{av.icon} {av.label}</button>
                        );})}
                      </div>
                    </div>
                  </div>
                  <FL c="Descripcion"/>
                  <div style={{position:"relative"}}>
                    <textarea value={draft.desc||""} onChange={e=>set("desc",e.target.value)} rows={3} style={{width:"100%",padding:"8px 38px 8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
                    <div style={{position:"absolute",right:6,top:6}}>
                      <VoiceMicButton size="sm" color="#7F77DD" title="Dictar descripción" initialText={draft.desc||""} onInterim={t=>set("desc",t)} onFinal={t=>set("desc",t)}/>
                    </div>
                  </div>
                  {(agents||[]).length>0 && <>
                    <FL c="Agentes IA conectados"/>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {agents.map(a=>{
                        const sel=(draft.agentIds||[]).includes(a.id);
                        return (
                          <button key={a.id} type="button" onClick={()=>{
                            const cur=draft.agentIds||[];
                            set("agentIds", sel?cur.filter(x=>x!==a.id):[...cur,a.id]);
                          }} style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",borderRadius:20,border:`1.5px solid ${sel?a.color:"#e5e7eb"}`,background:sel?`${a.color}15`:"#fff",cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:600,color:sel?a.color:"#6b7280"}}>
                            <span>{a.emoji}</span> {a.name}
                          </button>
                        );
                      })}
                    </div>
                  </>}
                  <FL c="Asignados"/>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {members.map(m=>{
                      const sel=(draft.assignees||[]).includes(m.id);
                      const mp2=MP[m.id]||MP[0];
                      return (
                        <button key={m.id} type="button" onClick={()=>{
                          const cur=draft.assignees||[];
                          const nxt=sel?cur.filter(x=>x!==m.id):[...cur,m.id];
                          set("assignees",nxt);
                        }} style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px 4px 4px",borderRadius:20,border:`1.5px solid ${sel?mp2.solid:"#e5e7eb"}`,background:sel?mp2.light:"#fff",cursor:"pointer",fontFamily:"inherit"}}>
                          <div style={{width:22,height:22,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700}}>{m.initials}</div>
                          <span style={{fontSize:12,fontWeight:600,color:sel?mp2.solid:"#6b7280"}}>{m.name.split(" ")[0]}</span>
                          {sel&&<span style={{fontSize:10,color:mp2.solid}}>✓</span>}
                        </button>
                      );
                    })}
                  </div>
                </>
              ):(
                <>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
                    {task.startDate&&<div style={{background:"#f0f7ff",border:"1px solid #85B7EB",borderRadius:8,padding:"4px 10px",fontSize:11,color:"#0C447C"}}>Inicio: {task.startDate}</div>}
                    {task.dueDate&&<div style={{background:daysUntil(task.dueDate)<0?"#FCEBEB":daysUntil(task.dueDate)===0?"#FAEEDA":"#f0fdf7",border:`1px solid ${daysUntil(task.dueDate)<0?"#E24B4A":daysUntil(task.dueDate)===0?"#EF9F27":"#1D9E75"}`,borderRadius:8,padding:"4px 10px",fontSize:11,color:daysUntil(task.dueDate)<0?"#A32D2D":daysUntil(task.dueDate)===0?"#854F0B":"#085041",fontWeight:daysUntil(task.dueDate)<=0?600:400}}>{daysUntil(task.dueDate)<0?"Vencida":daysUntil(task.dueDate)===0?"Hoy":"Fin"}: {task.dueDate}</div>}
                    {task.estimatedHours>0&&<div style={{background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:8,padding:"4px 10px",fontSize:11,color:"#374151"}}>Est: {task.estimatedHours}h</div>}
                  </div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>{task.tags.map((tg,i)=><Tag key={i} tag={tg}/>)}</div>
                  {task.desc&&<div style={{fontSize:13,color:"#4b5563",lineHeight:1.6,padding:10,background:"#f9fafb",borderRadius:8,marginBottom:12}}>{task.desc}</div>}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
                    <a href={gcUrl} target="_blank" rel="noreferrer" style={{display:"flex",alignItems:"center",gap:6,padding:"6px 14px",borderRadius:8,background:"#E1F5EE",color:"#085041",border:"1px solid #1D9E75",fontSize:12,fontWeight:600,textDecoration:"none"}}>Añadir a Google Calendar</a>
                    {wu&&<a href={wu} target="_blank" rel="noreferrer" style={{display:"flex",alignItems:"center",gap:6,padding:"6px 14px",borderRadius:8,background:"#dcfce7",color:"#166534",border:"1px solid #25D366",fontSize:12,fontWeight:600,textDecoration:"none"}}>Notificar WhatsApp</a>}
                  </div>
                  <FL c="Asignados"/>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {task.assignees.length>0?task.assignees.map(mid=>{ const m=members.find(x=>x.id===mid); const mp2=MP[mid]||MP[0]; return <div key={mid} style={{display:"flex",alignItems:"center",gap:7,background:mp2.light,border:`1.5px solid ${mp2.solid}`,borderRadius:20,padding:"4px 12px 4px 5px"}}><div style={{width:22,height:22,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700}}>{m?.initials}</div><span style={{fontSize:12,fontWeight:600,color:mp2.solid}}>{m?.name}</span></div>; }):<span style={{fontSize:12,color:"#9ca3af"}}>Nadie</span>}
                  </div>
                  {(task.agentIds||[]).length>0 && (agents||[]).length>0 && <>
                    <FL c="Agentes IA conectados"/>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {task.agentIds.map(aid=>{ const a=(agents||[]).find(x=>x.id===aid); if(!a) return null; return (
                        <div key={aid} style={{display:"flex",alignItems:"center",gap:6,background:`${a.color}15`,border:`1.5px solid ${a.color}`,borderRadius:20,padding:"4px 12px 4px 8px",fontSize:12,fontWeight:600,color:a.color}}>
                          <span>{a.emoji}</span> {a.name}
                        </div>
                      ); })}
                    </div>
                  </>}
                </>
              )}
            </>
          )}
          {tab==="subtasks"&&(
            <>
              {subs.length>0&&(
                <div style={{marginBottom:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#6b7280",marginBottom:4}}>
                    <span>Progreso</span>
                    <span style={{fontWeight:600,color:subPct===100?"#085041":"#374151"}}>{subsDone}/{subs.length} completadas · {subPct}%</span>
                  </div>
                  <div style={{height:8,background:"#e5e7eb",borderRadius:20,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${subPct}%`,background:subPct===100?"#1D9E75":"#7F77DD",borderRadius:20,transition:"width .2s"}}/>
                  </div>
                </div>
              )}
              <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
                {subs.length===0&&<div style={{textAlign:"center",padding:"18px 12px",color:"#9ca3af",fontSize:12,fontStyle:"italic",background:"#f9fafb",border:"1px dashed #e5e7eb",borderRadius:10}}>Sin subtareas. Añade la primera abajo.</div>}
                {subs.map(sub=>{
                  const due=sub.dueDate?daysUntil(sub.dueDate):null;
                  const dueC=sub.done?"#9ca3af":due===null?"#9ca3af":due<0?"#A32D2D":due===0?"#854F0B":due<=2?"#633806":"#6b7280";
                  const asgMp=sub.assigneeId!=null?(MP[sub.assigneeId]||MP[0]):null;
                  const asgM=sub.assigneeId!=null?members.find(m=>m.id===sub.assigneeId):null;
                  const isEd=editingSubId===sub.id;
                  return(
                    <div key={sub.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",background:sub.done?"#f0fdf7":"#f9fafb",border:`1px solid ${sub.done?"#c6efd9":"#e5e7eb"}`,borderRadius:8}}>
                      <input type="checkbox" checked={sub.done} onChange={()=>toggleSub(sub.id)} style={{width:16,height:16,cursor:"pointer",accentColor:"#1D9E75",flexShrink:0}}/>
                      {isEd
                        ?<input autoFocus value={editSubDraft} onChange={e=>setEditSubDraft(e.target.value)} onBlur={commitEditSub} onKeyDown={e=>{if(e.key==="Enter")e.target.blur();if(e.key==="Escape"){setEditingSubId(null);}}} style={{flex:1,padding:"4px 8px",border:"1px solid #7F77DD",borderRadius:6,fontSize:13,outline:"none",fontFamily:"inherit",minWidth:0}}/>
                        :<div onClick={()=>{setEditingSubId(sub.id);setEditSubDraft(sub.title);}} style={{flex:1,fontSize:13,cursor:"text",textDecoration:sub.done?"line-through":"none",color:sub.done?"#9ca3af":"#1f2937",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0}}>{sub.title}</div>
                      }
                      <input type="date" value={sub.dueDate||""} onChange={e=>patchSub(sub.id,{dueDate:e.target.value})} title="Fecha límite" style={{fontSize:11,padding:"3px 6px",borderRadius:6,border:"0.5px solid #d1d5db",color:dueC,fontWeight:due!==null&&(due<0||due===0)&&!sub.done?600:400,background:"#fff",fontFamily:"inherit",width:128,flexShrink:0}}/>
                      <select value={sub.assigneeId==null?"":sub.assigneeId} onChange={e=>patchSub(sub.id,{assigneeId:e.target.value===""?null:Number(e.target.value)})} title={asgM?asgM.name:"Asignar"} style={{fontSize:11,padding:"3px 6px",borderRadius:6,border:"0.5px solid #d1d5db",background:asgMp?asgMp.light:"#fff",color:asgMp?asgMp.solid:"#6b7280",fontWeight:600,fontFamily:"inherit",width:68,flexShrink:0,cursor:"pointer"}}>
                        <option value="">—</option>
                        {members.map(m=><option key={m.id} value={m.id}>{m.initials}</option>)}
                      </select>
                      <button onClick={()=>deleteSub(sub.id)} title="Eliminar" style={{background:"none",border:"none",fontSize:14,color:"#9ca3af",cursor:"pointer",padding:0,width:22,height:22,flexShrink:0}}>×</button>
                    </div>
                  );
                })}
              </div>
              <div style={{display:"flex",gap:8}}>
                <input value={newSubTitle} onChange={e=>setNewSubTitle(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addSubtask();}} placeholder="Añadir subtarea y pulsa Enter..." style={{flex:1,padding:"8px 12px",border:"0.5px solid #d1d5db",borderRadius:8,fontSize:13,outline:"none",fontFamily:"inherit"}}/>
                <button onClick={addSubtask} disabled={!newSubTitle.trim()} style={{padding:"8px 16px",borderRadius:8,background:newSubTitle.trim()?"#7F77DD":"#e5e7eb",color:newSubTitle.trim()?"#fff":"#9ca3af",border:"none",fontSize:13,cursor:newSubTitle.trim()?"pointer":"default",fontWeight:600}}>+ Añadir</button>
              </div>
            </>
          )}
          {tab==="links"&&(
            <>
              <div style={{fontSize:11,color:"#6b7280",marginBottom:10}}>Enlaces específicos de esta tarea (documentos, tickets, briefings, etc.)</div>
              <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
                {links.length===0&&<div style={{textAlign:"center",padding:"18px 12px",color:"#9ca3af",fontSize:12,fontStyle:"italic",background:"#f9fafb",border:"1px dashed #e5e7eb",borderRadius:10}}>Sin enlaces. Añade URLs del documento, ticket, etc.</div>}
                {links.map(l=>(
                  <div key={l.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",background:"#f9fafb",border:"0.5px solid #e5e7eb",borderRadius:8}}>
                    <span style={{fontSize:14}}>{l.icon||"🔗"}</span>
                    <a href={l.url} target="_blank" rel="noreferrer" style={{flex:1,fontSize:13,color:"#7F77DD",textDecoration:"none",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.label}</a>
                    <span style={{fontSize:10,color:"#9ca3af",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:180}}>{l.url}</span>
                    <button onClick={()=>delLink(l.id)} style={{background:"none",border:"none",fontSize:14,color:"#9ca3af",cursor:"pointer",padding:0,width:22,height:22}}>×</button>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <input value={newLink.icon} onChange={e=>setNewLink(l=>({...l,icon:e.target.value}))} style={{width:40,padding:"7px 6px",border:"0.5px solid #d1d5db",borderRadius:7,fontSize:13,textAlign:"center",fontFamily:"inherit"}}/>
                <input value={newLink.label} onChange={e=>setNewLink(l=>({...l,label:e.target.value}))} placeholder="Etiqueta" style={{width:140,padding:"7px 10px",border:"0.5px solid #d1d5db",borderRadius:7,fontSize:12,fontFamily:"inherit",outline:"none"}}/>
                <input value={newLink.url} onChange={e=>setNewLink(l=>({...l,url:e.target.value}))} onKeyDown={e=>{if(e.key==="Enter")addLink();}} placeholder="https://..." style={{flex:1,padding:"7px 10px",border:"0.5px solid #d1d5db",borderRadius:7,fontSize:12,fontFamily:"inherit",outline:"none"}}/>
                <button onClick={addLink} disabled={!newLink.url.trim()} style={{padding:"7px 14px",borderRadius:7,background:newLink.url.trim()?"#7F77DD":"#e5e7eb",color:newLink.url.trim()?"#fff":"#9ca3af",border:"none",fontSize:12,cursor:newLink.url.trim()?"pointer":"default",fontWeight:600}}>+ Añadir</button>
              </div>
              {(workspaceLinks&&workspaceLinks.length>0)&&(
                <div style={{marginTop:18,paddingTop:14,borderTop:"0.5px dashed #e5e7eb"}}>
                  <div style={{fontSize:10,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>🏢 Enlaces del workspace</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {workspaceLinks.map(l=>(
                      <a key={l.id} href={l.url} target="_blank" rel="noreferrer" style={{display:"flex",alignItems:"center",gap:5,padding:"5px 10px",borderRadius:7,background:"#EEEDFE",color:"#3C3489",fontSize:11,textDecoration:"none",fontWeight:500,border:"0.5px solid #AFA9EC"}}>
                        <span>{l.icon||"🔗"}</span>{l.label}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {tab==="time"&&(
            <>
              <div style={{background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:12,padding:14,marginBottom:12}}>
                {est>0&&pct!==null&&<div style={{marginBottom:12}}><div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#6b7280",marginBottom:4}}><span>Progreso</span><span style={{color:pct>=100?"#A32D2D":"#374151",fontWeight:pct>=100?600:400}}>{fmtH(totalLogged)} / {task.estimatedHours}h ({pct}%)</span></div><div style={{height:8,background:"#e5e7eb",borderRadius:20,overflow:"hidden"}}><div style={{height:"100%",width:`${pct}%`,background:pct>=100?"#E24B4A":pct>=80?"#EF9F27":"#1D9E75",borderRadius:20}}/></div></div>}
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                  <div style={{fontSize:28,fontWeight:700,fontFamily:"monospace",color:running?"#E24B4A":"#374151",minWidth:100}}>{fmtSecs(elapsed)}</div>
                  <button onClick={()=>setRunning(r=>!r)} style={{padding:"7px 16px",borderRadius:8,background:running?"#FCEBEB":"#E1F5EE",color:running?"#A32D2D":"#085041",border:`1px solid ${running?"#E24B4A":"#1D9E75"}`,fontSize:13,cursor:"pointer",fontWeight:600}}>{running?"Pausar":"Iniciar"}</button>
                  <button onClick={()=>{setElapsed(0);setRunning(false);}} style={{padding:"7px 10px",borderRadius:8,background:"transparent",color:"#6b7280",border:"0.5px solid #d1d5db",fontSize:12,cursor:"pointer"}}>Reset</button>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <input value={note} onChange={e=>setNote(e.target.value)} placeholder="Nota (opcional)" style={{flex:1,padding:"6px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:12,outline:"none",fontFamily:"inherit"}}/>
                  <button onClick={saveTime} disabled={elapsed<1} style={{padding:"6px 14px",borderRadius:8,background:elapsed>0?"#7F77DD":"#e5e7eb",color:elapsed>0?"#fff":"#9ca3af",border:"none",fontSize:12,cursor:elapsed>0?"pointer":"default",fontWeight:600}}>{saved?"Guardado":"Guardar"}</button>
                </div>
              </div>
              {(task.timeLogs||[]).length>0&&(
                <div>
                  <FL c="Registros del equipo"/>
                  <div style={{display:"flex",flexDirection:"column",gap:5}}>
                    {[...(task.timeLogs||[])].reverse().map((l,i)=>{ const m=members.find(x=>x.id===l.memberId); const mp2=MP[l.memberId]||MP[0]; return <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:"#f9fafb",borderRadius:8,border:"0.5px solid #e5e7eb"}}><div style={{width:22,height:22,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:700,flexShrink:0}}>{m?.initials}</div><div style={{flex:1,minWidth:0}}><div style={{fontSize:11,fontWeight:500,color:mp2.solid}}>{m?.name}</div>{l.note&&<div style={{fontSize:10,color:"#6b7280"}}>{l.note}</div>}</div><div style={{fontSize:11,fontWeight:600}}>{fmtSecs(l.seconds)}</div><div style={{fontSize:10,color:"#9ca3af"}}>{l.date}</div></div>; })}
                  </div>
                </div>
              )}
            </>
          )}
          {tab==="comments"&&(
            <>
              <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:14}}>
                {task.comments.length===0&&<span style={{fontSize:12,color:"#9ca3af"}}>Sin comentarios aun.</span>}
                {task.comments.map((c,i)=>{ const m=members.find(x=>x.id===c.author); const mp2=MP[c.author]||MP[0]; return <div key={i} style={{display:"flex",gap:10}}><div style={{width:30,height:30,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0}}>{m?.initials}</div><div style={{flex:1,background:"#f9fafb",borderRadius:10,padding:"8px 12px",borderLeft:`3px solid ${mp2.solid}`}}><div style={{fontSize:12,fontWeight:600,marginBottom:2,color:mp2.solid}}>{m?.name}</div><div style={{fontSize:13,color:"#4b5563",lineHeight:1.5}}>{c.text}</div><div style={{fontSize:11,color:"#9ca3af",marginTop:3}}>{c.time}</div></div></div>; })}
              </div>
              <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
                <div style={{width:30,height:30,borderRadius:"50%",background:(MP[activeMemberId]||MP[0]).solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0}}>{members.find(x=>x.id===activeMemberId)?.initials}</div>
                <textarea rows={2} value={comment} onChange={e=>setComment(e.target.value)} placeholder="Escribe un comentario..." onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();addComment();}}} style={{flex:1,padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"none",fontFamily:"inherit",outline:"none"}}/>
                <VoiceMicButton size="sm" color="#7F77DD" title="Dictar comentario" initialText={comment} onInterim={t=>setComment(t)} onFinal={t=>setComment(t)}/>
                <button onClick={addComment} style={{padding:"8px 14px",borderRadius:8,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:500}}>Enviar</button>
              </div>
            </>
          )}
          {tab==="documents"&&(
            <DocumentUploader
              ownerKey={`task-${task.id}`}
              documents={task.documents||[]}
              onChange={docs=>onUpdate(task.id,colId,{...task,documents:docs})}
              agents={agents||[]}
              contextLabel={`la tarea "${task.title}"`}
              ceoMemory={ceoMemory}
            />
          )}
        </div>
        {/* Footer: solo aparece cuando hay onDelete y permiso (canDelete).
            Confirmación inline en dos pasos para evitar borrados por error. */}
        {onDelete && canDelete && (
          <div style={{padding:"10px 20px",borderTop:"0.5px solid #e5e7eb",display:"flex",justifyContent:"space-between",alignItems:"center",background:"#fafafa",borderBottomLeftRadius:16,borderBottomRightRadius:16}}>
            {confirmDelete
              ? <div style={{display:"flex",alignItems:"center",gap:10,fontSize:12,color:"#B91C1C"}}>
                  <span>¿Eliminar esta tarea? Esta acción no se puede deshacer.</span>
                  <button onClick={()=>{ onDelete(task.id, colId); onClose(); }} style={{padding:"5px 12px",borderRadius:6,background:"#E24B4A",color:"#fff",border:"none",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Sí, eliminar</button>
                  <button onClick={()=>setConfirmDelete(false)} style={{padding:"5px 10px",borderRadius:6,background:"transparent",color:"#374151",border:"0.5px solid #D1D5DB",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Cancelar</button>
                </div>
              : <button onClick={()=>setConfirmDelete(true)} title="Eliminar tarea" style={{padding:"6px 12px",borderRadius:6,background:"transparent",color:"#B91C1C",border:"0.5px solid #FCA5A5",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:5}}>🗑️ Eliminar tarea</button>
            }
            <span style={{fontSize:11,color:"#9CA3AF"}}>{task.id}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Asesor IA (voz del navegador) ─────────────────────────────────────────────
function AvatarModal({task,members,connectedAgents,ceoMemory,onClose,onSetCategory,onMutateTask}){
  const support = voiceSupported();
  const customAgents = connectedAgents||[];
  const hasCustom = customAgents.length>0;
  const initialKey = hasCustom ? `agent_${customAgents[0].id}` : (task.category || "gestion");
  const [avatarKey,setAvatarKey] = useState(initialKey);
  const [messages,setMessages] = useState([]);
  const [listening,setListening] = useState(false);
  const [speaking,setSpeaking] = useState(false);
  const [interim,setInterim] = useState("");
  const stopFnRef = useRef(null);
  const activeAgent = avatarKey.startsWith("agent_") ? customAgents.find(a=>`agent_${a.id}`===avatarKey) : null;
  const av = activeAgent ? agentToAvatar(activeAgent) : AVATARS[avatarKey];

  const say = useCallback((text, role="avatar")=>{
    setMessages(m=>[...m,{role,text,ts:Date.now()}]);
    if(role==="avatar" && support.tts){
      setSpeaking(true);
      speak(text,{ ...av.voice, onEnd: ()=>setSpeaking(false) });
    }
  },[av,support.tts]);

  useEffect(()=>{
    setMessages([]);
    const text = activeAgent ? buildAgentBriefing(task,activeAgent) : buildBriefing(task,avatarKey);
    say(text,"avatar");
    return ()=>{ stopSpeaking(); if(stopFnRef.current) stopFnRef.current(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[avatarKey]);

  const messagesRef = useRef([]);
  useEffect(()=>{ messagesRef.current = messages; },[messages]);

  const handleUser = useCallback(async (text)=>{
    setMessages(m=>[...m,{role:"user",text,ts:Date.now()}]);
    // 1) ¿Es un comando ejecutable?
    const cmd = parseCommand(text);
    if(cmd){
      const result = executeCommand(cmd,task,members);
      if(result){
        if(result.task !== task) onMutateTask?.(result.task);
        setTimeout(()=>say(result.msg,"avatar"),200);
        return;
      }
    }
    // 2) Si hay agente custom → LLM real vía /api/agent
    if(activeAgent){
      try {
        const reply = await llmAgentReply(text, task, activeAgent, members, messagesRef.current, ceoMemory);
        say(reply,"avatar");
        return;
      } catch(e){
        say(`(No he podido conectar con la IA: ${e.message}. Uso respuesta local.)`,"avatar");
      }
    }
    // 3) Fallback rule-based
    const reply = activeAgent ? respondAgentQuery(text,task,activeAgent,members) : respondToQuery(text,task,avatarKey,members);
    setTimeout(()=>say(reply,"avatar"),200);
  },[task,avatarKey,activeAgent,members,say,onMutateTask]);

  const startListen = ()=>{
    stopSpeaking(); setSpeaking(false);
    setInterim("");
    const stop = listen({
      onStart: ()=>setListening(true),
      onInterim: t=>setInterim(t),
      onFinal: t=>{ setInterim(""); handleUser(t); },
      onError: e=>{ setListening(false); setInterim(""); say("No he podido escuchar: "+(e.message||"error del navegador"),"avatar"); },
      onEnd: ()=>{ setListening(false); stopFnRef.current=null; },
    });
    stopFnRef.current = stop;
  };
  const stopListen = ()=>{ if(stopFnRef.current) stopFnRef.current(); setListening(false); setInterim(""); };

  if(!support.tts && !support.stt){
    return (
      <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&onClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div className="tf-modal" style={{background:"#fff",borderRadius:14,padding:24,maxWidth:420}}>
          <div style={{fontSize:15,fontWeight:600,marginBottom:8}}>Tu navegador no soporta voz</div>
          <div style={{fontSize:13,color:"#6b7280",marginBottom:14}}>Prueba en Chrome, Edge o Safari recientes.</div>
          <button onClick={onClose} style={{padding:"8px 16px",borderRadius:8,background:"#7F77DD",color:"#fff",border:"none",cursor:"pointer"}}>Cerrar</button>
        </div>
      </div>
    );
  }

  const handleClose = ()=>{ stopSpeaking(); stopListen(); onClose(); };

  return (
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&handleClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:560,maxWidth:"96vw",maxHeight:"90vh",display:"flex",flexDirection:"column",borderTop:`4px solid ${av.color}`,overflow:"hidden"}}>
        <div style={{padding:"14px 18px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:44,height:44,borderRadius:"50%",background:`linear-gradient(135deg,${av.color},${av.color}88)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,boxShadow:speaking?`0 0 0 4px ${av.color}33`:"none",transition:"box-shadow .2s"}}>{av.icon}</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:14,fontWeight:700,color:av.color}}>Asesor de {av.label}</div>
            <div style={{fontSize:11,color:"#6b7280",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{task.title}</div>
          </div>
          <button onClick={handleClose} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:"#9ca3af",lineHeight:1}}>×</button>
        </div>

        <div style={{padding:"10px 18px",borderBottom:"0.5px solid #e5e7eb",display:"flex",gap:6,flexWrap:"wrap",background:"#fafafa"}}>
          {customAgents.map(ag=>{ const k=`agent_${ag.id}`; const a=agentToAvatar(ag); const sel=avatarKey===k; return(
            <button key={k} onClick={()=>{ stopSpeaking(); stopListen(); setAvatarKey(k); }} style={{display:"flex",alignItems:"center",gap:4,padding:"4px 9px",borderRadius:16,border:`1px solid ${sel?a.color:"#e5e7eb"}`,background:sel?a.color+"15":"#fff",cursor:"pointer",fontSize:11,fontWeight:600,color:sel?a.color:"#6b7280"}}>{a.icon} {a.label}</button>
          );})}
          {AVATAR_KEYS.map(k=>{ const a=AVATARS[k]; const sel=avatarKey===k; return(
            <button key={k} onClick={()=>{ stopSpeaking(); stopListen(); setAvatarKey(k); onSetCategory?.(k); }} style={{display:"flex",alignItems:"center",gap:4,padding:"4px 9px",borderRadius:16,border:`1px solid ${sel?a.color:"#e5e7eb"}`,background:sel?a.color+"15":"#fff",cursor:"pointer",fontSize:11,fontWeight:600,color:sel?a.color:"#6b7280"}}>{a.icon} {a.label}</button>
          );})}
        </div>

        <div style={{flex:1,overflowY:"auto",padding:"14px 18px",display:"flex",flexDirection:"column",gap:10,minHeight:200}}>
          {messages.map((m,i)=>(
            <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
              <div style={{maxWidth:"85%",padding:"9px 13px",borderRadius:12,background:m.role==="user"?"#EEEDFE":av.color+"12",border:`1px solid ${m.role==="user"?"#7F77DD55":av.color+"33"}`,fontSize:13,lineHeight:1.45,color:"#1f2937",whiteSpace:"pre-wrap"}}>{m.text}</div>
            </div>
          ))}
          {interim&&(
            <div style={{display:"flex",justifyContent:"flex-end"}}>
              <div style={{maxWidth:"85%",padding:"8px 12px",borderRadius:12,background:"#f3f4f6",fontSize:13,color:"#9ca3af",fontStyle:"italic"}}>{interim}…</div>
            </div>
          )}
        </div>

        <div style={{padding:"14px 18px",borderTop:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"center",gap:14,background:"#fafafa"}}>
          {speaking&&(
            <button onClick={()=>{stopSpeaking();setSpeaking(false);}} style={{padding:"8px 14px",borderRadius:20,background:"#fff",border:"1px solid #d1d5db",fontSize:12,cursor:"pointer",color:"#6b7280"}}>⏸ Silenciar</button>
          )}
          <button
            onClick={listening?stopListen:startListen}
            disabled={!support.stt}
            style={{width:70,height:70,borderRadius:"50%",background:listening?"#E24B4A":`linear-gradient(135deg,${av.color},${av.color}cc)`,color:"#fff",border:"none",fontSize:26,cursor:support.stt?"pointer":"not-allowed",boxShadow:listening?"0 0 0 6px #E24B4A22":`0 4px 14px ${av.color}44`,transition:"all .15s",animation:listening?"pulse 1.2s infinite":"none"}}
            title={listening?"Para de escuchar":"Habla al asesor"}
          >{listening?"⏺":"🎤"}</button>
          <div style={{fontSize:11,color:"#9ca3af",minWidth:90}}>{listening?"Escuchando…":speaking?"Hablando…":support.stt?"Pulsa para hablar":"Mic no disponible"}</div>
        </div>
      </div>
      <style>{`@keyframes pulse{0%,100%{box-shadow:0 0 0 6px #E24B4A22}50%{box-shadow:0 0 0 12px #E24B4A11}}`}</style>
    </div>
  );
}

// ── Scope Avatar Modal (global / board) ──────────────────────────────────────
function ScopeAvatarModal({scope,data,activeProjectId,activeMemberId,onClose,onMutateData,onOpenProject,onOpenTask}){
  const support = voiceSupported();
  const av = AVATARS.gestion;
  const [messages,setMessages] = useState([]);
  const [listening,setListening] = useState(false);
  const [speaking,setSpeaking] = useState(false);
  const [interim,setInterim] = useState("");
  const stopFnRef = useRef(null);

  const say = useCallback((text, role="avatar")=>{
    setMessages(m=>[...m,{role,text,ts:Date.now()}]);
    if(role==="avatar" && support.tts){
      setSpeaking(true);
      speak(text,{ ...av.voice, onEnd: ()=>setSpeaking(false) });
    }
  },[av,support.tts]);

  useEffect(()=>{
    const text = buildContextBriefing(scope, data, { activeMemberId, activeProjectId });
    setMessages([]); say(text,"avatar");
    return ()=>{ stopSpeaking(); if(stopFnRef.current) stopFnRef.current(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[scope]);

  const handleUser = useCallback((text)=>{
    setMessages(m=>[...m,{role:"user",text,ts:Date.now()}]);
    const board = scope==="board" ? data.boards[activeProjectId] : null;
    const cmd = parseScopedCommand(text, { scope, projects: data.projects, board });
    if(cmd){
      const result = executeScopedCommand(cmd, { scope, data, activeProjectId, activeMemberId });
      if(result){
        if(result.data) onMutateData?.(result.data);
        if(result.hint?.type === "openProject") onOpenProject?.(result.hint.projectId);
        if(result.hint?.type === "openTask") { onOpenTask?.(result.hint.projectId, result.hint.taskId); setTimeout(()=>onClose?.(),400); }
        setTimeout(()=>say(result.msg,"avatar"),200);
        return;
      }
    }
    const reply = respondScopedQuery(text, { scope, data, memberId: activeMemberId, project: data.projects.find(p=>p.id===activeProjectId), board, members: data.members });
    setTimeout(()=>say(reply,"avatar"),200);
  },[scope,data,activeProjectId,activeMemberId,say,onMutateData,onOpenProject,onOpenTask,onClose]);

  const startListen = ()=>{
    stopSpeaking(); setSpeaking(false); setInterim("");
    const stop = listen({
      onStart: ()=>setListening(true),
      onInterim: t=>setInterim(t),
      onFinal: t=>{ setInterim(""); handleUser(t); },
      onError: e=>{ setListening(false); setInterim(""); say("No he podido escuchar: "+(e.message||"error"),"avatar"); },
      onEnd: ()=>{ setListening(false); stopFnRef.current=null; },
    });
    stopFnRef.current = stop;
  };
  const stopListen = ()=>{ if(stopFnRef.current) stopFnRef.current(); setListening(false); setInterim(""); };
  const handleClose = ()=>{ stopSpeaking(); stopListen(); onClose(); };

  const sendText = (txt)=>{ if(txt.trim()) handleUser(txt.trim()); };
  const [typed,setTyped] = useState("");

  const SCOPE_LABELS = {
    board:      `Asesor del tablero · ${data.projects.find(p=>p.id===activeProjectId)?.name||""}`,
    planner:    "Asesor del planificador IA",
    eisenhower: "Asesor de la matriz Eisenhower",
    reports:    "Asesor de reportes de tiempo",
    projects:   "Asesor de proyectos",
    users:      "Asesor de usuarios",
    team:       "Asesor del equipo",
    workspaces: "Asesor de workspaces",
    agents:     "Asesor de agentes IA",
    global:     "Asesor global · Briefing del día",
    dashboard:  "Asesor global · Briefing del día",
  };
  const title = SCOPE_LABELS[scope] || "Asesor IA";
  const SCOPE_ICONS = { board:"📋", planner:"⚡", eisenhower:"🎯", reports:"⏱️", projects:"📁", users:"👥", team:"🤝", workspaces:"🏢", agents:"🤖" };
  const scopeIcon = SCOPE_ICONS[scope] || "🌍";

  return (
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&handleClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:600,maxWidth:"96vw",maxHeight:"90vh",display:"flex",flexDirection:"column",borderTop:`4px solid ${av.color}`,overflow:"hidden"}}>
        <div style={{padding:"14px 18px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:44,height:44,borderRadius:"50%",background:`linear-gradient(135deg,${av.color},${av.color}88)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,boxShadow:speaking?`0 0 0 4px ${av.color}33`:"none",transition:"box-shadow .2s"}}>{scopeIcon}</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:14,fontWeight:700,color:av.color}}>{title}</div>
            <div style={{fontSize:11,color:"#6b7280"}}>Dame órdenes por voz o texto</div>
          </div>
          <button onClick={handleClose} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:"#9ca3af",lineHeight:1}}>×</button>
        </div>

        <div style={{flex:1,overflowY:"auto",padding:"14px 18px",display:"flex",flexDirection:"column",gap:10,minHeight:220}}>
          {messages.map((m,i)=>(
            <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
              <div style={{maxWidth:"85%",padding:"9px 13px",borderRadius:12,background:m.role==="user"?"#EEEDFE":av.color+"12",border:`1px solid ${m.role==="user"?"#7F77DD55":av.color+"33"}`,fontSize:13,lineHeight:1.45,color:"#1f2937",whiteSpace:"pre-wrap"}}>{m.text}</div>
            </div>
          ))}
          {interim&&(
            <div style={{display:"flex",justifyContent:"flex-end"}}>
              <div style={{maxWidth:"85%",padding:"8px 12px",borderRadius:12,background:"#f3f4f6",fontSize:13,color:"#9ca3af",fontStyle:"italic"}}>{interim}…</div>
            </div>
          )}
        </div>

        <div style={{padding:"10px 18px",borderTop:"0.5px solid #e5e7eb",display:"flex",gap:8,background:"#fafafa"}}>
          <input value={typed} onChange={e=>setTyped(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){sendText(typed);setTyped("");}}} placeholder="Escribe una orden… (o pulsa el micro)" style={{flex:1,padding:"9px 12px",borderRadius:10,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit",outline:"none"}}/>
          <button onClick={()=>{sendText(typed);setTyped("");}} style={{padding:"9px 14px",borderRadius:10,background:av.color,color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>Enviar</button>
        </div>

        <div style={{padding:"12px 18px",borderTop:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"center",gap:14,background:"#fafafa"}}>
          {speaking&&<button onClick={()=>{stopSpeaking();setSpeaking(false);}} style={{padding:"8px 14px",borderRadius:20,background:"#fff",border:"1px solid #d1d5db",fontSize:12,cursor:"pointer",color:"#6b7280"}}>⏸ Silenciar</button>}
          <button
            onClick={listening?stopListen:startListen}
            disabled={!support.stt}
            style={{width:64,height:64,borderRadius:"50%",background:listening?"#E24B4A":`linear-gradient(135deg,${av.color},${av.color}cc)`,color:"#fff",border:"none",fontSize:24,cursor:support.stt?"pointer":"not-allowed",boxShadow:listening?"0 0 0 6px #E24B4A22":`0 4px 14px ${av.color}44`,animation:listening?"pulse 1.2s infinite":"none"}}
            title={listening?"Para de escuchar":"Habla al asesor"}
          >{listening?"⏺":"🎤"}</button>
          <div style={{fontSize:11,color:"#9ca3af",minWidth:90}}>{listening?"Escuchando…":speaking?"Hablando…":support.stt?"Pulsa para hablar":"Mic no disponible"}</div>
        </div>
      </div>
      <style>{`@keyframes pulse{0%,100%{box-shadow:0 0 0 6px #E24B4A22}50%{box-shadow:0 0 0 12px #E24B4A11}}`}</style>
    </div>
  );
}

// ── Task Card ─────────────────────────────────────────────────────────────────
function TaskCard({task,members,aiSchedule,onOpen,onDragStart}){
  const p2=palOf(task.assignees);
  const isOver=daysUntil(task.dueDate)<0;
  const isToday=daysUntil(task.dueDate)===0;
  const q=getQ(task);
  const totalLogged=(task.timeLogs||[]).reduce((s,l)=>s+l.seconds,0);
  const est=(task.estimatedHours||0)*3600;
  const sched=(aiSchedule||[]).filter(s=>s.taskId===task.id&&task.assignees.includes(s.memberId));
  const subs=task.subtasks||[];
  const subDone=subs.filter(s=>s.done).length;
  const subAllDone=subs.length>0&&subDone===subs.length;
  return(
    <div draggable onDragStart={onDragStart} onClick={onOpen} style={{background:p2?p2.cardBg:"#fff",border:`0.5px solid ${p2?p2.cardBorder+"55":"#e5e7eb"}`,borderLeft:`4px solid ${p2?p2.cardBorder:"#e5e7eb"}`,borderRadius:10,padding:"10px 12px",marginBottom:8,cursor:"pointer"}}>
      <div style={{fontSize:13,fontWeight:500,marginBottom:6,lineHeight:1.4}}>{task.title}</div>
      {task.tags.length>0&&<div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:6}}>{task.tags.map((tg,i)=><Tag key={i} tag={tg}/>)}</div>}
      <div style={{marginBottom:6}}><QBadge q={q}/></div>
      <div style={{display:"flex",gap:6,marginBottom:6,flexWrap:"wrap"}}>
        {task.startDate&&<span style={{fontSize:10,color:"#6b7280"}}>Inicio: {task.startDate}</span>}
        {task.dueDate&&<span style={{fontSize:10,color:isOver?"#A32D2D":isToday?"#854F0B":"#9ca3af",fontWeight:isOver||isToday?600:400}}>{isOver?"Vencida":isToday?"Hoy":"Fin"}: {task.dueDate}{task.dueTime?` · ${task.dueTime}`:""}</span>}
        {sched.length>0&&<span style={{fontSize:10,color:"#7F77DD",fontWeight:600}}>Planificado</span>}
      </div>
      {est>0&&totalLogged>0&&<div style={{marginBottom:6}}><div style={{height:4,background:"#e5e7eb",borderRadius:20,overflow:"hidden"}}><div style={{height:"100%",width:`${Math.min(Math.round(totalLogged/est*100),100)}%`,background:totalLogged>est?"#E24B4A":totalLogged/est>0.8?"#EF9F27":"#1D9E75",borderRadius:20}}/></div></div>}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex"}}>{task.assignees.map((mid,i)=>{ const m=members.find(x=>x.id===mid); const mp2=MP[mid]||MP[0]; return <div key={mid} title={m?.name} style={{marginLeft:i>0?-7:0,zIndex:task.assignees.length-i,position:"relative",width:24,height:24,borderRadius:"50%",background:mp2.solid,color:"#fff",border:"2px solid #fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700}}>{m?.initials||"?"}</div>; })}</div>
        <div style={{display:"flex",alignItems:"center",gap:5}}><PriBadge p={task.priority}/>{subs.length>0&&<span title={`${subDone}/${subs.length} subtareas`} style={{fontSize:10,padding:"1px 6px",borderRadius:10,background:subAllDone?"#E1F5EE":"#f3f4f6",color:subAllDone?"#085041":"#6b7280",fontWeight:600,border:`0.5px solid ${subAllDone?"#1D9E75":"#e5e7eb"}`}}>☑ {subDone}/{subs.length}</span>}{(task.links||[]).length>0&&<span title={`${task.links.length} enlace${task.links.length>1?"s":""}`} style={{fontSize:10,padding:"1px 6px",borderRadius:10,background:"#EEEDFE",color:"#3C3489",fontWeight:600,border:"0.5px solid #AFA9EC"}}>🔗 {task.links.length}</span>}{task.comments.length>0&&<span style={{fontSize:11,color:"#9ca3af"}}>{task.comments.length}</span>}</div>
      </div>
    </div>
  );
}

// ── Board View ────────────────────────────────────────────────────────────────
function BoardView({board,members,projectMemberIds,activeMemberId,aiSchedule,workspaceLinks,agents,ceoMemory,canDelete,externalOpenTaskId,onExternalTaskConsumed,onUpdate,onMove,onAddTask,onDeleteTask}){
  const [openTaskId,setOpenTaskId]=useState(null);
  useEffect(()=>{
    if(externalOpenTaskId){
      setOpenTaskId(externalOpenTaskId);
      onExternalTaskConsumed?.();
    }
  },[externalOpenTaskId,onExternalTaskConsumed]);
  const [dragging,setDragging]=useState(null);
  const [newCard,setNewCard]=useState(null);
  const [newCardTitle,setNewCardTitle]=useState("");
  const handleDrop=(e,toColId)=>{ e.preventDefault(); if(!dragging||dragging.colId===toColId)return; onMove(dragging.taskId,dragging.colId,toColId); setDragging(null); };
  const saveNew=(colId)=>{ const t=newCardTitle.trim(); if(!t){setNewCard(null);return;} onAddTask(colId,t); setNewCard(null); setNewCardTitle(""); };
  const openModal=openTaskId?board.flatMap(c=>c.tasks.map(t=>({t,colId:c.id}))).find(x=>x.t.id===openTaskId):null;
  return(
    <>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",padding:"10px 20px 0",alignItems:"center"}}>
        <span style={{fontSize:11,color:"#9ca3af"}}>Persona:</span>
        {projectMemberIds.map(mid=>{ const m=members.find(x=>x.id===mid); const mp2=MP[mid]||MP[0]; return <div key={mid} style={{display:"flex",alignItems:"center",gap:5,background:mp2.light,border:`1px solid ${mp2.solid}`,borderRadius:20,padding:"3px 10px 3px 6px"}}><div style={{width:9,height:9,borderRadius:"50%",background:mp2.solid}}/><span style={{fontSize:11,fontWeight:600,color:mp2.solid}}>{m?.name.split(" ")[0]}</span></div>; })}
      </div>
      <div style={{display:"flex",gap:14,alignItems:"flex-start",padding:"12px 20px 20px",overflowX:"auto"}}>
        {board.map(col=>(
          <div key={col.id} className="tf-board-col" onDragOver={e=>e.preventDefault()} onDrop={e=>handleDrop(e,col.id)} style={{width:268,flexShrink:0,background:"#f3f4f6",borderRadius:14,padding:10}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10,padding:"0 2px"}}><span style={{fontSize:13,fontWeight:500}}>{col.name}</span><span style={{fontSize:11,background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:20,padding:"1px 7px",color:"#6b7280"}}>{col.tasks.length}</span></div>
            {col.tasks.map(task=><TaskCard key={task.id} task={task} members={members} aiSchedule={aiSchedule} onOpen={()=>setOpenTaskId(task.id)} onDragStart={()=>setDragging({taskId:task.id,colId:col.id})}/>)}
            {newCard===col.id
              ?<div style={{background:"#fff",border:"0.5px solid #7F77DD",borderRadius:10,padding:8}}><input autoFocus value={newCardTitle} onChange={e=>setNewCardTitle(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")saveNew(col.id);if(e.key==="Escape")setNewCard(null);}} placeholder="Titulo de la tarea..." style={{width:"100%",border:"none",outline:"none",fontSize:13,background:"transparent",fontFamily:"inherit"}}/><div style={{display:"flex",gap:6,marginTop:8}}><button onClick={()=>saveNew(col.id)} style={{padding:"4px 10px",borderRadius:6,background:"#7F77DD",color:"#fff",border:"none",fontSize:12,cursor:"pointer"}}>Añadir</button><button onClick={()=>setNewCard(null)} style={{padding:"4px 10px",borderRadius:6,background:"transparent",border:"0.5px solid #d1d5db",fontSize:12,cursor:"pointer"}}>Cancelar</button></div></div>
              :<button onClick={()=>{setNewCard(col.id);setNewCardTitle("");}} style={{width:"100%",textAlign:"left",padding:"7px 8px",borderRadius:8,fontSize:13,color:"#6b7280",background:"transparent",border:"none",cursor:"pointer"}}>+ Añadir tarea</button>
            }
          </div>
        ))}
      </div>
      {openModal&&<TaskModal task={openModal.t} colId={openModal.colId} cols={board} members={members} activeMemberId={activeMemberId} workspaceLinks={workspaceLinks} agents={agents||[]} ceoMemory={ceoMemory} canDelete={canDelete || (openModal.t.assignees||[]).length===0} onClose={()=>setOpenTaskId(null)} onUpdate={(id,cid,upd)=>onUpdate(id,cid,upd)} onMove={(id,from,to)=>{onMove(id,from,to);setOpenTaskId(null);}} onDelete={onDeleteTask}/>}
    </>
  );
}

// ── Slideout (panel lateral reutilizable) ─────────────────────────────────────
function Slideout({isOpen,onClose,title,subtitle,children}){
  useEffect(()=>{
    if(!isOpen) return;
    const onKey=e=>{ if(e.key==="Escape") onClose(); };
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[isOpen,onClose]);
  if(!isOpen) return null;
  return(
    <>
      <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.3)",zIndex:1500,animation:"tf-fade-in .2s ease"}}/>
      <div style={{position:"fixed",top:0,right:0,bottom:0,width:400,maxWidth:"90vw",background:"#fff",zIndex:1600,boxShadow:"-6px 0 28px rgba(0,0,0,0.18)",display:"flex",flexDirection:"column",animation:"tf-slide-in-right .25s ease-out"}}>
        <div style={{padding:"16px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
          <div style={{minWidth:0}}>
            <div style={{fontSize:14,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{title}</div>
            {subtitle&&<div style={{fontSize:11,color:"#6b7280",marginTop:2}}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:"#9ca3af",lineHeight:1}}>×</button>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"12px 14px"}}>{children}</div>
      </div>
    </>
  );
}

// Botón inline estilo pill para quick actions
function QuickActionBtn({icon,label,color,onClick}){
  return(
    <button className="tf-press" onClick={e=>{e.stopPropagation();onClick();}} style={{display:"inline-flex",alignItems:"center",gap:5,padding:"6px 12px",borderRadius:20,background:color+"14",color,border:`1px solid ${color}44`,fontSize:11,fontWeight:600,cursor:"pointer",transition:"background .15s, border-color .15s"}} onMouseEnter={e=>{e.currentTarget.style.background=color+"22";e.currentTarget.style.borderColor=color+"88";}} onMouseLeave={e=>{e.currentTarget.style.background=color+"14";e.currentTarget.style.borderColor=color+"44";}}>
      <span>{icon}</span><span>{label}</span>
    </button>
  );
}

// Tarjeta expandible de tarea crítica con quick actions inline.
function CriticalTaskCard({task,proj,members,onComplete,onPostpone,onOpenModal}){
  const [expanded,setExpanded] = useState(false);
  const [confirm,setConfirm]   = useState(false);
  const [showPostpone,setShowPostpone] = useState(false);
  const [leaving,setLeaving]   = useState(false);
  const days=daysUntil(task.dueDate);
  const dueLabel = !task.dueDate ? "Sin fecha" : days<0 ? `Vencida hace ${-days} día${-days!==1?"s":""}` : days===0 ? "Vence hoy" : `Vence en ${days} día${days!==1?"s":""}`;

  const resetAfterAction = () => { setLeaving(false); setConfirm(false); setShowPostpone(false); setExpanded(false); };
  const doComplete = () => { setLeaving(true); setTimeout(()=>{ onComplete(task); resetAfterAction(); },280); };
  const doPostpone = (deltaDays,label) => {
    const d=new Date(); d.setDate(d.getDate()+deltaDays);
    setLeaving(true); setTimeout(()=>{ onPostpone(task,fmt(d),label); resetAfterAction(); },280);
  };
  const doPostponeCustom = (dateStr) => {
    if(!dateStr) return;
    setLeaving(true); setTimeout(()=>{ onPostpone(task,dateStr,dateStr); resetAfterAction(); },280);
  };

  return(
    <div style={{borderTop:"1px solid #f3f4f6",padding:"10px 12px",borderRadius:4,background:expanded?"#fafafa":"#fff",transition:"opacity .28s ease, transform .28s ease, background .2s",opacity:leaving?0:1,transform:leaving?"translateX(24px)":"translateX(0)"}}>
      <div onClick={()=>setExpanded(e=>!e)} style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
        <QBadge q={getQ(task)}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{task.title}</div>
          <div style={{fontSize:10,color:"#9ca3af"}}>{proj?.emoji} {proj?.name} · <span style={{color:days<0?"#E24B4A":days===0?"#EF9F27":"#6b7280",fontWeight:500}}>{dueLabel}</span></div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          {task.assignees.slice(0,3).map((mid,i)=>{ const mp2=MP[mid]||MP[0]; const mm=members.find(x=>x.id===mid); return <div key={mid} style={{marginLeft:i>0?-6:0,width:22,height:22,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:700,border:"1.5px solid #fff"}}>{mm?.initials}</div>; })}
          <span style={{fontSize:11,color:"#7F77DD",fontWeight:600,marginLeft:4,userSelect:"none"}}>{expanded?"▴":"⚡ Acciones"}</span>
        </div>
      </div>
      {expanded&&!leaving&&(
        <div style={{marginTop:10,paddingTop:10,borderTop:"1px dashed #e5e7eb",animation:"tf-slide-down .2s ease-in-out"}}>
          {!confirm&&!showPostpone&&(
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <QuickActionBtn icon="✓" label="Completar" color="#10B981" onClick={()=>setConfirm(true)}/>
              <QuickActionBtn icon="💬" label="Comentar"  color="#3B82F6" onClick={onOpenModal}/>
              <QuickActionBtn icon="📅" label="Posponer"  color="#F59E0B" onClick={()=>setShowPostpone(true)}/>
              <QuickActionBtn icon="👁" label="Ver más"   color="#6B7280" onClick={onOpenModal}/>
            </div>
          )}
          {confirm&&(
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",animation:"tf-slide-down .15s ease"}}>
              <span style={{fontSize:12,color:"#065F46",fontWeight:600}}>¿Marcar como completada?</span>
              <button onClick={doComplete} style={{padding:"6px 14px",borderRadius:7,background:"#10B981",color:"#fff",border:"none",fontSize:12,fontWeight:600,cursor:"pointer"}}>✓ Sí</button>
              <button onClick={()=>setConfirm(false)} style={{padding:"6px 14px",borderRadius:7,background:"transparent",color:"#6B7280",border:"0.5px solid #d1d5db",fontSize:12,fontWeight:600,cursor:"pointer"}}>✗ No</button>
            </div>
          )}
          {showPostpone&&(
            <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",animation:"tf-slide-down .15s ease"}}>
              <span style={{fontSize:12,color:"#854F0B",fontWeight:600}}>Posponer:</span>
              <button onClick={()=>doPostpone(1,"24h")}     style={{padding:"5px 12px",borderRadius:7,background:"#F59E0B",color:"#fff",border:"none",fontSize:11,fontWeight:600,cursor:"pointer"}}>24h</button>
              <button onClick={()=>doPostpone(2,"48h")}     style={{padding:"5px 12px",borderRadius:7,background:"#F59E0B",color:"#fff",border:"none",fontSize:11,fontWeight:600,cursor:"pointer"}}>48h</button>
              <button onClick={()=>doPostpone(7,"1 semana")} style={{padding:"5px 12px",borderRadius:7,background:"#F59E0B",color:"#fff",border:"none",fontSize:11,fontWeight:600,cursor:"pointer"}}>1 semana</button>
              <input type="date" onChange={e=>doPostponeCustom(e.target.value)} style={{padding:"4px 8px",borderRadius:7,border:"0.5px solid #F59E0B",fontSize:11,fontFamily:"inherit"}}/>
              <button onClick={()=>setShowPostpone(false)} style={{padding:"5px 10px",borderRadius:7,background:"transparent",color:"#6B7280",border:"0.5px solid #d1d5db",fontSize:11,fontWeight:500,cursor:"pointer"}}>Cancelar</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Cuadrante Eisenhower interactivo (hover preview + click → slideout).
const DASH_Q_COLORS = {
  Q1:{ border:"#EF4444", bg:"#FEE2E2", label:"URGENTE + IMPORTANTE" },
  Q2:{ border:"#3B82F6", bg:"#DBEAFE", label:"IMPORTANTE"            },
  Q3:{ border:"#F59E0B", bg:"#FEF3C7", label:"URGENTE"               },
  Q4:{ border:"#9CA3AF", bg:"#F3F4F6", label:"ELIMINAR"              },
};
function EisenhowerQuadrant({qk,tasks,onClick}){
  const [hover,setHover] = useState(false);
  const qc = DASH_Q_COLORS[qk];
  const qm = QM[qk];
  const clickable = tasks.length>0;
  return(
    <div
      onClick={()=>clickable&&onClick(qk,tasks)}
      onMouseEnter={()=>setHover(true)}
      onMouseLeave={()=>setHover(false)}
      style={{background:qc.bg,border:`1.5px solid ${qc.border}`,borderRadius:10,padding:"12px 14px",cursor:clickable?"pointer":"default",position:"relative",minHeight:120,transition:"transform .15s ease, box-shadow .15s ease",transform:clickable&&hover?"translateY(-2px)":"translateY(0)",boxShadow:clickable&&hover?`0 8px 20px ${qc.border}33`:"none"}}
    >
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
        <span style={{fontSize:14}}>{qm.icon}</span>
        <span style={{fontSize:10,fontWeight:700,color:qc.border,letterSpacing:"0.04em"}}>{qk} · {qc.label}</span>
      </div>
      <div style={{fontSize:26,fontWeight:700,color:qc.border,lineHeight:1}}>{tasks.length}</div>
      <div style={{fontSize:10,color:"#6b7280",marginTop:2}}>{qm.sub||qm.label}</div>
      {hover&&clickable&&(
        <div style={{marginTop:10,paddingTop:10,borderTop:`1px dashed ${qc.border}55`,animation:"tf-fade-in .15s ease"}}>
          {tasks.slice(0,3).map(t=>(
            <div key={t.id} style={{fontSize:11,padding:"5px 8px",background:"#fff",border:`1px solid ${qc.border}33`,borderRadius:6,marginTop:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>📌 {t.title}</div>
          ))}
          {tasks.length>3&&<div style={{fontSize:10,color:"#6b7280",marginTop:5,fontStyle:"italic"}}>… +{tasks.length-3} más</div>}
          <div style={{fontSize:10,color:qc.border,fontWeight:700,marginTop:8}}>Click para ver todas →</div>
        </div>
      )}
      {!clickable&&hover&&(
        <div style={{marginTop:10,fontSize:10,color:"#9ca3af",fontStyle:"italic"}}>Sin tareas en este cuadrante</div>
      )}
    </div>
  );
}

// "hace Xd" con granularidad de día (los datos solo tienen fecha YYYY-MM-DD).
function timeAgoDate(dateStr){
  if(!dateStr) return "";
  const then=new Date(dateStr), now=new Date();
  const diffMs=now-then;
  if(diffMs<0) return fmt(new Date(dateStr));
  const days=Math.floor(diffMs/86400000);
  if(days<=0) return "hoy";
  if(days===1) return "ayer";
  if(days<7)   return `hace ${days}d`;
  if(days<30)  return `hace ${Math.floor(days/7)} sem`;
  return `hace ${Math.floor(days/30)} mes${days>=60?"es":""}`;
}

// ── Home View (panel de mandos tras login) ────────────────────────────────────
function HomeView({data,activeMember,critMineCount,alertMineCount,onNavigate,onToast,onOpenTask}){
  const [expandedCard,setExpandedCard] = useState(null);
  const toggleExpand = (id)=>setExpandedCard(c=>c===id?null:id);
  const me=data.members.find(m=>m.id===activeMember);
  const firstName=me?.name.split(" ")[0]||"";

  // Stats dinámicos personalizados por usuario activo.
  const today=fmt(TODAY);
  const horizonEnd=(()=>{ const d=new Date(TODAY); d.setDate(d.getDate()+PLAN_HORIZON_DAYS); return fmt(d); })();
  const weekFrom=(()=>{ const d=new Date(TODAY); d.setDate(d.getDate()-7); return fmt(d); })();
  const allMyTasks=[]; const myProjIds=new Set();
  Object.entries(data.boards||{}).forEach(([pid,cols])=>cols.forEach(c=>c.tasks.forEach(t=>{
    if(t.assignees?.includes(activeMember)){ allMyTasks.push(t); myProjIds.add(Number(pid)); }
  })));
  const scheduledMine=(data.aiSchedule||[]).filter(s=>s.memberId===activeMember&&s.date>=today&&s.date<=horizonEnd).length;
  const myWorkspaces=(data.workspaces||[]).filter(w=>data.projects.some(p=>p.workspaceId===w.id&&p.members?.includes(activeMember)));
  const weekSeconds=Object.values(data.boards||{}).flatMap(cols=>cols.flatMap(c=>c.tasks.flatMap(t=>(t.timeLogs||[])))).filter(l=>l.memberId===activeMember&&l.date>=weekFrom&&l.date<=today).reduce((s,l)=>s+l.seconds,0);
  const weekHours=(weekSeconds/3600).toFixed(1);
  const projectsCount=data.projects.length;
  const workspacesCount=(data.workspaces||[]).length;
  const agentsCount=(data.agents||[]).length;

  const showVideoToast=(label)=>()=>onToast?.(`📹 ${label} — próximamente`,"info");

  // Datasets para cards expandibles ─ se calculan una sola vez por render.
  const dashCritical=[], myTasks=[];
  Object.entries(data.boards||{}).forEach(([pid,cols])=>{
    const proj=data.projects.find(p=>p.id===Number(pid));
    cols.forEach(col=>{
      col.tasks.forEach(t=>{
        if(!t.assignees?.includes(activeMember)) return;
        const base={id:t.id,title:t.title,projId:Number(pid),projName:proj?.name||"",projEmoji:proj?.emoji||"📋"};
        myTasks.push({...base,status:col.name,_startDate:t.startDate||""});
        if(col.name==="Hecho") return;
        const q=getQ(t); const days=daysUntil(t.dueDate);
        const isCrit = q==="Q1" || (t.dueDate && days<=1);
        if(isCrit){
          const status = !t.dueDate?"Prioridad alta":days<0?`Vencida hace ${-days}d`:days===0?"Vence hoy":`Vence en ${days}d`;
          dashCritical.push({...base,status,_days:t.dueDate?days:999,_q:q});
        }
      });
    });
  });
  dashCritical.sort((a,b)=>{ if(a._days!==b._days) return a._days-b._days; return a._q==="Q1"?-1:1; });
  myTasks.sort((a,b)=>(b._startDate||"").localeCompare(a._startDate||""));

  // Planificador: entradas aiSchedule del usuario en ventana, dedup por taskId, enriquecidas.
  const plannerTasks=[];
  const plannerSeen=new Set();
  (data.aiSchedule||[])
    .filter(s=>s.memberId===activeMember&&s.date>=today&&s.date<=horizonEnd)
    .sort((a,b)=>a.date.localeCompare(b.date))
    .forEach(s=>{
      if(plannerSeen.has(s.taskId)) return; plannerSeen.add(s.taskId);
      let found=null;
      for(const [pid,cols] of Object.entries(data.boards||{})){
        for(const col of cols){
          const t=col.tasks.find(x=>x.id===s.taskId);
          if(t){ found={t,pid:Number(pid)}; break; }
        }
        if(found) break;
      }
      if(!found) return;
      const proj=data.projects.find(p=>p.id===found.pid);
      const d=new Date(s.date), td=new Date(today);
      const dd=Math.floor((d-td)/86400000);
      const when = dd===0?"Hoy":dd===1?"Mañana":`En ${dd}d`;
      plannerTasks.push({id:found.t.id,title:found.t.title,projId:found.pid,projName:proj?.name||"",projEmoji:proj?.emoji||"📋",status:`${when} · ${s.hours}h`});
    });

  // Mapa id→tareas para expansión inline.
  const expansions={
    dashboard:{tasks:dashCritical, label:"TAREAS CRÍTICAS"},
    projects: {tasks:myTasks,      label:"MIS TAREAS"},
    planner:  {tasks:plannerTasks, label:"PLANIFICADAS PRÓXIMOS 14 DÍAS"},
  };

  const cards=[
    {
      id:"dashboard", emoji:"📊", title:"Dashboard",
      tooltip:"Centro de comando para tareas urgentes y matriz de prioridades",
      tagline:"Centro de control para gestionar el trabajo diario",
      description:"Ve las 5 tareas más críticas del equipo, organiza tu trabajo con la matriz de prioridades (urgente vs importante), y detecta cuellos de botella antes de que se conviertan en problemas. Todo en una sola pantalla optimizada para tomar decisiones rápidas.",
      features:[
        "Top 5 tareas críticas con quick actions (completar, posponer, comentar)",
        "Matriz Eisenhower interactiva con preview por cuadrante",
        "Vista global del progreso de todos los proyectos",
      ],
      stats: critMineCount>0 ? `Tienes ${critMineCount} tarea${critMineCount!==1?"s":""} crítica${critMineCount!==1?"s":""} esperándote` : "Todo bajo control — 0 tareas críticas hoy ✓",
      videoLabel:"Ver cómo usar el Dashboard (2 min)",
    },
    {
      id:"projects", emoji:"📋", title:"Proyectos",
      tooltip:"Tableros Kanban para gestionar flujos de trabajo por proyecto",
      tagline:"Gestiona SHOWROOM MARBELLA, Iceflow, y todos tus proyectos en tableros Kanban",
      description:"Arrastra tareas entre columnas (Por hacer → En curso → Hecho), asigna responsables, establece deadlines, y colabora en tiempo real. Cada proyecto tiene su propio tablero personalizable con columnas que se adaptan a tu flujo de trabajo.",
      features:[
        `${projectsCount} proyecto${projectsCount!==1?"s":""} activo${projectsCount!==1?"s":""} con tableros independientes`,
        "Drag & drop intuitivo entre columnas",
        "Asignación de responsables y deadlines",
      ],
      stats: `Tienes ${allMyTasks.length} tarea${allMyTasks.length!==1?"s":""} asignada${allMyTasks.length!==1?"s":""} en ${myProjIds.size} proyecto${myProjIds.size!==1?"s":""}`,
      videoLabel:"Cómo organizar proyectos en Kanban (3 min)",
    },
    {
      id:"planner", emoji:"🎯", title:"Planificador IA", badge:"Nuevo",
      tooltip:"IA que organiza tu calendario automáticamente según prioridades",
      tagline:"Deja que la IA organice tu día automáticamente",
      description:"Conecta tu Google Calendar y el planificador distribuye tus tareas considerando prioridad, urgencia, tiempo disponible entre reuniones, y márgenes de transporte entre ubicaciones. La IA aprende de tus patrones y optimiza tu calendario para máxima productividad.",
      features:[
        "Integración bidireccional con Google Calendar",
        "Priorización automática basada en matriz Eisenhower",
        "Considera tiempo de desplazamiento entre ubicaciones",
        "Ahorra ~2 horas semanales en planificación manual",
      ],
      stats: `Has planificado ${scheduledMine} tarea${scheduledMine!==1?"s":""} para los próximos ${PLAN_HORIZON_DAYS} días`,
      videoLabel:"Conectar Google Calendar paso a paso (4 min)",
    },
    {
      id:"workspaces", emoji:"📁", title:"Workspaces",
      tooltip:"Espacios organizados por cliente con proyectos y miembros",
      tagline:"Espacios de trabajo organizados por cliente o proyecto estratégico",
      description:"Cada workspace agrupa múltiples proyectos relacionados con un cliente específico (ej: SHOWROOM MARBELLA incluye diseño, logística, ventas). Ideal para separar contextos y mantener conversaciones y archivos centralizados por cuenta. Colabora en tiempo real con acceso granular por miembro.",
      features:[
        `${workspacesCount} workspace${workspacesCount!==1?"s":""} activo${workspacesCount!==1?"s":""}${workspacesCount>0?" ("+(data.workspaces||[]).slice(0,3).map(w=>w.name).join(", ")+(workspacesCount>3?"…":"")+")":""}`,
        "Permisos por miembro y acceso compartido",
        "Historial de cambios y sincronización realtime",
      ],
      stats: `Tienes acceso a ${myWorkspaces.length} workspace${myWorkspaces.length!==1?"s":""} con ${projectsCount} proyecto${projectsCount!==1?"s":""} totales`,
      videoLabel:"Organizar equipos con Workspaces (3 min)",
    },
    {
      id:"agents", emoji:"🤖", title:"Agentes IA", badge:"Nuevo",
      tooltip:"Asesores virtuales con contexto de SoulBaric y memoria persistente",
      tagline:"Asesores virtuales personalizados para marketing, ventas, y estrategia",
      description:"Conversa por voz o texto con agentes especializados que entienden el contexto de SoulBaric. Pídeles que redacten emails de prospección, analicen competencia, sugieran estrategias de captación, o respondan dudas técnicas. Cada agente tiene memoria persistente y aprende de tus conversaciones anteriores.",
      features:[
        `${agentsCount} agente${agentsCount!==1?"s":""} configurado${agentsCount!==1?"s":""}`,
        "Conversación bidireccional por voz o texto",
        "Memoria persistente entre sesiones",
        "Respuestas contextualizadas a SoulBaric",
      ],
      stats: `Tienes ${agentsCount} agente${agentsCount!==1?"s":""} disponible${agentsCount!==1?"s":""} para consultar`,
      videoLabel:"Usar agentes IA para redactar propuestas (5 min)",
    },
    {
      id:"dealroom", emoji:"🤝", title:"Deal Room", badge:"Nuevo",
      tooltip:"Timeline de negociaciones con sesiones, notas y resúmenes",
      tagline:"Gestiona negociaciones complejas con histórico completo por sesión",
      description:"Cada negociación agrupa reuniones, llamadas y conversaciones informales en un timeline cronológico. Toma notas con hora exacta durante cada sesión y genera un resumen al cierre. Cambia el estado (en curso / pausado / cerrado ganado / cerrado perdido) y mantén visible el contexto completo sin perder detalles.",
      features:[
        `${(data.negotiations||[]).length} negociación${(data.negotiations||[]).length!==1?"es":""} registrada${(data.negotiations||[]).length!==1?"s":""}`,
        "Sesiones con tipo, fecha, ubicación y duración",
        "Notas cronológicas por sesión y resumen editable",
        "Filtros por estado y responsable",
      ],
      stats: (data.negotiations||[]).length===0 ? "Aún no hay negociaciones — crea la primera para empezar" : `${(data.negotiations||[]).filter(n=>n.status==="en_curso").length} negociación${(data.negotiations||[]).filter(n=>n.status==="en_curso").length!==1?"es":""} activa${(data.negotiations||[]).filter(n=>n.status==="en_curso").length!==1?"s":""} · ${(data.negotiations||[]).reduce((s,n)=>s+(n.sessions||[]).length,0)} sesion${(data.negotiations||[]).reduce((s,n)=>s+(n.sessions||[]).length,0)!==1?"es":""} totales`,
      videoLabel:"Registrar negociaciones paso a paso (4 min)",
    },
    {
      id:"reports", emoji:"⏱", title:"Tiempos",
      tooltip:"Tracking de horas para facturación y análisis de productividad",
      tagline:"Seguimiento de horas invertidas por tarea, proyecto y persona",
      description:"Registra automáticamente el tiempo que dedicas a cada tarea con un timer integrado. Genera reportes por miembro, proyecto, o cliente para facturación precisa, análisis de rentabilidad, y detección de cuellos de botella. Identifica qué tareas consumen más tiempo y optimiza la asignación de recursos.",
      features:[
        "Timer integrado en cada tarea",
        "Reportes por persona, proyecto y periodo",
        "Exportación para facturación",
        "Análisis de productividad del equipo",
      ],
      stats: `Has registrado ${weekHours} horas esta semana`,
      videoLabel:"Registrar tiempo y generar reportes (3 min)",
    },
  ];

  // Actividad: reune time logs, completados (Hecho) y creados. Granularidad diaria.
  const activity=[];
  Object.entries(data.boards||{}).forEach(([pid,cols])=>{
    const proj=data.projects.find(p=>p.id===Number(pid));
    cols.forEach(col=>{
      col.tasks.forEach(t=>{
        (t.timeLogs||[]).forEach(l=>{
          if(l.date) activity.push({date:l.date, type:"log", memberId:l.memberId, seconds:l.seconds, task:t, proj});
        });
        if(col.name==="Hecho"){
          const lastLog=(t.timeLogs||[]).slice(-1)[0];
          const d=lastLog?.date||t.startDate;
          if(d) activity.push({date:d, type:"done", memberId:t.assignees?.[0], task:t, proj});
        }
        if(t.startDate) activity.push({date:t.startDate, type:"created", memberId:t.assignees?.[0], task:t, proj});
      });
    });
  });
  const recent=activity.filter(a=>a.date).sort((a,b)=>a.date<b.date?1:-1).slice(0,5);
  const iconFor={log:"⏱", done:"✓", created:"➕"};
  const verbFor={log:"registró tiempo en", done:"completó", created:"creó"};

  const activityText=(a)=>{
    const m=data.members.find(x=>x.id===a.memberId);
    const who=m?.name||"Alguien";
    const when=timeAgoDate(a.date);
    return <><strong>{who}</strong> {verbFor[a.type]} "<em>{a.task.title}</em>" · <span style={{color:"#9CA3AF"}}>{when}</span></>;
  };

  const statsLine = critMineCount>0
    ? `Tienes ${critMineCount} tarea${critMineCount!==1?"s":""} crítica${critMineCount!==1?"s":""} hoy · ${alertMineCount>0?`${alertMineCount} alerta${alertMineCount!==1?"s":""} pendiente${alertMineCount!==1?"s":""}`:"sin alertas pendientes"}`
    : `Tienes 0 tareas críticas hoy · Todo bajo control ✓`;

  return(
    <div style={{maxWidth:1200,margin:"0 auto",padding:"40px 20px"}}>
      <div style={{marginBottom:40}}>
        <div style={{fontSize:32,fontWeight:700,color:"#111827",marginBottom:8,lineHeight:1.2}}>Bienvenido de nuevo, {firstName} 👋</div>
        <div style={{fontSize:15,color:"#6B7280"}}>{statsLine}</div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(360px,1fr))",gap:20,marginBottom:40,alignItems:"start"}}>
        {cards.map((c,i)=>{
          const exp=expansions[c.id];
          const isExpandable = exp && exp.tasks.length>0;
          const isExpanded   = expandedCard===c.id;
          return(
          <div
            key={c.id}
            onClick={()=>{ if(isExpandable&&isExpanded) return; onNavigate(c.id); }}
            style={{background:"#fff",border:"2px solid #E5E7EB",borderRadius:16,padding:"24px 26px",cursor:"pointer",transition:"all .25s cubic-bezier(0.4,0,0.2,1)",animation:`tf-card-in .3s ease ${i*50}ms both`,display:"flex",flexDirection:"column"}}
            onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-6px) scale(1.01)";e.currentTarget.style.boxShadow="0 20px 40px rgba(59,130,246,0.18)";e.currentTarget.style.borderColor="#3B82F6";const arr=e.currentTarget.querySelector("[data-arr]"); if(arr){arr.style.transform="translateX(4px)";arr.style.color="#3B82F6";}}}
            onMouseLeave={e=>{e.currentTarget.style.transform="translateY(0) scale(1)";e.currentTarget.style.boxShadow="none";e.currentTarget.style.borderColor="#E5E7EB";const arr=e.currentTarget.querySelector("[data-arr]"); if(arr){arr.style.transform="translateX(0)";arr.style.color="#9CA3AF";}}}
          >
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
              <span title={c.tooltip} style={{fontSize:30,lineHeight:1,cursor:"help"}}>{c.emoji}</span>
              <h3 style={{fontSize:19,fontWeight:700,color:"#111827",margin:0,flex:"0 1 auto"}}>{c.title}</h3>
              {c.badge&&<span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:4,textTransform:"uppercase",letterSpacing:"0.06em",background:"#10B981",color:"#fff"}}>{c.badge}</span>}
              <span data-arr onClick={e=>{e.stopPropagation();onNavigate(c.id);}} title="Ir a la sección" style={{fontSize:20,color:"#9CA3AF",transition:"transform .2s ease, color .2s ease",marginLeft:"auto",cursor:"pointer"}}>→</span>
            </div>

            <p style={{fontSize:15,fontWeight:500,color:"#111827",margin:"0 0 10px 0",lineHeight:1.45}}>{c.tagline}</p>
            <p style={{fontSize:13.5,color:"#6B7280",lineHeight:1.55,margin:"0 0 14px 0"}}>{c.description}</p>

            <ul style={{listStyle:"none",padding:0,margin:"0 0 14px 0"}}>
              {c.features.map((f,fi)=>(
                <li key={fi} style={{fontSize:12.5,color:"#4B5563",lineHeight:1.55,display:"flex",alignItems:"flex-start",gap:7,marginBottom:5}}>
                  <span style={{color:"#10B981",flexShrink:0,fontWeight:700}}>✓</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            {isExpandable
              ? <div
                  onClick={e=>{e.stopPropagation();toggleExpand(c.id);}}
                  style={{fontSize:13,fontWeight:600,color:"#3B82F6",padding:"9px 12px",background:"#EFF6FF",border:"1px solid transparent",borderRadius:8,marginBottom:10,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,transition:"background .15s, border-color .15s"}}
                  onMouseEnter={e=>{e.currentTarget.style.background="#DBEAFE";e.currentTarget.style.borderColor="#3B82F6";}}
                  onMouseLeave={e=>{e.currentTarget.style.background="#EFF6FF";e.currentTarget.style.borderColor="transparent";}}
                >
                  <span>{c.stats}</span>
                  <span style={{fontSize:14,color:"#3B82F6",flexShrink:0}}>{isExpanded?"↑":"↓"}</span>
                </div>
              : <div style={{fontSize:13,fontWeight:600,color:"#3B82F6",padding:"9px 12px",background:"#EFF6FF",borderRadius:8,marginBottom:10}}>{c.stats}</div>
            }

            {isExpandable&&isExpanded&&(
              <div style={{marginTop:6,paddingTop:14,borderTop:"2px solid #E5E7EB",animation:"tf-slide-down .25s ease"}}>
                <div style={{fontSize:11,fontWeight:700,color:"#6B7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>{exp.label} ({exp.tasks.length})</div>
                <div style={{display:"flex",flexDirection:"column",gap:7,maxHeight:300,overflowY:"auto",marginBottom:10}}>
                  {exp.tasks.slice(0,5).map(t=>(
                    <div
                      key={t.id}
                      onClick={e=>{e.stopPropagation();onOpenTask?.(t.id);}}
                      style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:8,padding:"9px 11px",cursor:"pointer",transition:"all .15s ease"}}
                      onMouseEnter={e=>{e.currentTarget.style.background="#fff";e.currentTarget.style.borderColor="#3B82F6";e.currentTarget.style.transform="translateX(3px)";e.currentTarget.style.boxShadow="0 2px 8px rgba(59,130,246,0.1)";}}
                      onMouseLeave={e=>{e.currentTarget.style.background="#F9FAFB";e.currentTarget.style.borderColor="#E5E7EB";e.currentTarget.style.transform="translateX(0)";e.currentTarget.style.boxShadow="none";}}
                    >
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
                        <span style={{fontSize:14,flexShrink:0}}>{t.projEmoji}</span>
                        <span style={{fontSize:13,fontWeight:500,color:"#111827",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.title}</span>
                      </div>
                      <div style={{fontSize:11,color:"#6B7280",marginLeft:22}}>{t.projName} · {t.status}</div>
                    </div>
                  ))}
                </div>
                {exp.tasks.length>5&&(
                  <button
                    onClick={e=>{e.stopPropagation();setExpandedCard(null);onNavigate(c.id);}}
                    style={{width:"100%",padding:"9px 14px",background:"#fff",border:"1px solid #E5E7EB",borderRadius:8,fontSize:13,fontWeight:500,color:"#3B82F6",cursor:"pointer",fontFamily:"inherit",transition:"background .15s, border-color .15s"}}
                    onMouseEnter={e=>{e.currentTarget.style.background="#EFF6FF";e.currentTarget.style.borderColor="#3B82F6";}}
                    onMouseLeave={e=>{e.currentTarget.style.background="#fff";e.currentTarget.style.borderColor="#E5E7EB";}}
                  >Ver las {exp.tasks.length} en {c.title} →</button>
                )}
              </div>
            )}

            <div style={{marginTop:"auto",paddingTop:10,borderTop:"1px solid #E5E7EB"}}>
              <button
                onClick={e=>{e.stopPropagation();showVideoToast(c.videoLabel)();}}
                style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,color:"#3B82F6",background:"none",border:"none",padding:0,cursor:"pointer",fontWeight:500,fontFamily:"inherit"}}
                onMouseEnter={e=>{e.currentTarget.style.color="#2563EB";e.currentTarget.style.textDecoration="underline";}}
                onMouseLeave={e=>{e.currentTarget.style.color="#3B82F6";e.currentTarget.style.textDecoration="none";}}
              >📹 Ver tutorial — {c.videoLabel.match(/\((\d+ min)\)/)?.[1]||"próximamente"}</button>
            </div>
          </div>
        );})}
      </div>

      <div style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:12,padding:"20px 24px",animation:`tf-card-in .3s ease ${cards.length*50}ms both`}}>
        <h3 style={{fontSize:12,fontWeight:700,color:"#6B7280",textTransform:"uppercase",letterSpacing:"0.08em",marginTop:0,marginBottom:14}}>Actividad reciente</h3>
        {recent.length===0
          ? <div style={{fontSize:13,color:"#9CA3AF"}}>No hay actividad reciente<div style={{fontSize:12,marginTop:4,color:"#B9BEC6"}}>Las acciones de tu equipo aparecerán aquí</div></div>
          : <ul style={{listStyle:"none",padding:0,margin:0}}>
              {recent.map((a,i)=>(
                <li key={`${a.type}-${a.task.id}-${i}`} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 0",borderBottom:i===recent.length-1?"none":"1px solid #E5E7EB"}}>
                  <span style={{fontSize:14,flexShrink:0,marginTop:1}}>{iconFor[a.type]}</span>
                  <span style={{fontSize:13,color:"#4B5563",lineHeight:1.5}}>{activityText(a)}</span>
                </li>
              ))}
            </ul>}
      </div>
    </div>
  );
}

// ── Dashboard View ────────────────────────────────────────────────────────────
function DashboardView({data,onGoPlanner,onGoProjects,onGoBoard,onOpenTask,onOpenBriefing,onCompleteTask,onPostponeTask}){
  const {boards,members,projects,aiSchedule}=data;
  const today=fmt(TODAY);
  const weekAgo=new Date(TODAY); weekAgo.setDate(weekAgo.getDate()-7);
  const weekFromStr=fmt(weekAgo);
  const weekAheadEnd=new Date(TODAY); weekAheadEnd.setDate(weekAheadEnd.getDate()+7);

  const allT=Object.entries(boards).flatMap(([pid,cols])=>cols.flatMap(col=>col.tasks.map(t=>({...t,colId:col.id,colName:col.name,projId:Number(pid),projName:projects.find(p=>p.id===Number(pid))?.name||""}))));
  const active=allT.filter(t=>t.colName!=="Hecho");
  const done=allT.filter(t=>t.colName==="Hecho");
  const overdue=active.filter(t=>t.dueDate&&daysUntil(t.dueDate)<0);
  const dueToday=active.filter(t=>t.dueDate&&daysUntil(t.dueDate)===0);

  // Horas loggeadas últimos 7 días
  const logsWeek=allT.flatMap(t=>(t.timeLogs||[]).map(l=>({...l,taskId:t.id,taskTitle:t.title,assignees:t.assignees})));
  const weekLogs=logsWeek.filter(l=>l.date&&l.date>=weekFromStr&&l.date<=today);
  const weekHours=weekLogs.reduce((s,l)=>s+l.seconds,0)/3600;

  // Progreso general: horas loggeadas / horas estimadas (tareas activas con estimación)
  const estTotal=active.reduce((s,t)=>s+(t.estimatedHours||0),0);
  const logTotal=allT.reduce((s,t)=>s+((t.timeLogs||[]).reduce((a,l)=>a+l.seconds,0)/3600),0);
  const completionPct=estTotal>0?Math.min(100,Math.round(logTotal/estTotal*100)):0;

  // Matriz Eisenhower — lista completa por cuadrante (no solo count) para preview + slideout
  const quadTasks={Q1:[],Q2:[],Q3:[],Q4:[]}; active.forEach(t=>{quadTasks[getQ(t)].push(t);});
  const [slideoutQ,setSlideoutQ] = useState(null); // null | "Q1" | "Q2" | ...

  // Top 5 críticas
  const critical=[...active].filter(t=>{ const q=getQ(t); return q==="Q1"||(t.dueDate&&daysUntil(t.dueDate)<=1); })
    .sort((a,b)=>{ const da=daysUntil(a.dueDate),db=daysUntil(b.dueDate); if(da!==db)return da-db; const po={alta:0,media:1,baja:2}; return (po[a.priority]||1)-(po[b.priority]||1); })
    .slice(0,5);

  // Carga por persona: logged last 7d + scheduled next 7d
  const loadByMember=members.map(m=>{
    const logged=logsWeek.filter(l=>l.memberId===m.id).reduce((s,l)=>s+l.seconds,0)/3600;
    const scheduled=(aiSchedule||[]).filter(s=>s.memberId===m.id&&s.date>=today&&s.date<=fmt(weekAheadEnd)).reduce((s,x)=>s+x.hours,0);
    const capacity=7*(m.avail?.hoursPerDay||8);
    return {m,logged,scheduled,capacity,pct:capacity>0?Math.min(100,Math.round(scheduled/capacity*100)):0};
  }).sort((a,b)=>b.scheduled-a.scheduled);

  // Calendario: miembros con ICS
  const icsMembers=members.filter(m=>m.avail?.icsUrl);
  const icsAlerts=icsMembers.map(m=>{
    const cached=getCachedEvents(m.id);
    return {m,synced:cached!==null,count:cached?.length||0};
  });

  const KPI=({label,value,sub,color,onClick})=>(
    <div onClick={onClick} style={{background:"#fff",border:`1.5px solid ${color}22`,borderLeft:`4px solid ${color}`,borderRadius:12,padding:"14px 16px",cursor:onClick?"pointer":"default",transition:"transform .12s"}} onMouseEnter={e=>onClick&&(e.currentTarget.style.transform="translateY(-1px)")} onMouseLeave={e=>onClick&&(e.currentTarget.style.transform="translateY(0)")}>
      <div style={{fontSize:11,color:"#6b7280",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>{label}</div>
      <div style={{fontSize:26,fontWeight:700,color,lineHeight:1.1}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:"#9ca3af",marginTop:3}}>{sub}</div>}
    </div>
  );

  return(
    <div style={{padding:20}}>
      <div style={{marginBottom:16,display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
        <div>
        <div style={{fontSize:18,fontWeight:700,marginBottom:3}}>Dashboard</div>
        <div style={{fontSize:12,color:"#6b7280"}}>Vista global del equipo · {today}</div>
        </div>
        <button onClick={onOpenBriefing} style={{padding:"10px 16px",borderRadius:10,background:"linear-gradient(135deg,#7F77DD,#E76AA1)",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600,display:"flex",alignItems:"center",gap:6,whiteSpace:"nowrap",boxShadow:"0 4px 14px rgba(127,119,221,0.3)"}}>🎙️ Briefing del día</button>
      </div>

      {/* KPIs */}
      <div className="tf-kpi-grid" style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:12,marginBottom:20}}>
        <KPI label="Tareas activas" value={active.length} sub={`${done.length} completadas`} color="#7F77DD" onClick={onGoProjects}/>
        <KPI label="Vencidas" value={overdue.length} sub={dueToday.length>0?`+${dueToday.length} vencen hoy`:"Al día"} color={overdue.length>0?"#E24B4A":"#1D9E75"}/>
        <KPI label="Horas esta semana" value={weekHours.toFixed(1)+"h"} sub={`${weekLogs.length} registros`} color="#EF9F27"/>
        <KPI label="Progreso estimado" value={completionPct+"%"} sub={`${logTotal.toFixed(0)}h de ${estTotal.toFixed(0)}h`} color="#1D9E75"/>
      </div>

      {/* Row: Eisenhower + Críticas */}
      <div className="tf-dashboard-grid-2" style={{display:"grid",gridTemplateColumns:"1fr 1.4fr",gap:14,marginBottom:20}}>
        <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,padding:14}}>
          <div style={{fontSize:13,fontWeight:600,marginBottom:10}}>Matriz Eisenhower</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:8}}>
            {["Q1","Q2","Q3","Q4"].map(qk=>(
              <EisenhowerQuadrant key={qk} qk={qk} tasks={quadTasks[qk]} onClick={(k)=>setSlideoutQ(k)}/>
            ))}
          </div>
        </div>

        <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,padding:14}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <div style={{fontSize:13,fontWeight:600}}>Top 5 críticas hoy</div>
            <span style={{fontSize:11,color:"#6b7280"}}>{critical.length} tarea{critical.length!==1?"s":""}</span>
          </div>
          {critical.length===0&&<div style={{fontSize:12,color:"#9ca3af",textAlign:"center",padding:"24px 10px"}}>🎉 No hay tareas críticas. ¡Buen trabajo!</div>}
          {critical.map(t=>{
            const proj=projects.find(p=>p.id===t.projId);
            const projIdx=projects.findIndex(p=>p.id===t.projId);
            return(
              <CriticalTaskCard
                key={t.id}
                task={t}
                proj={proj}
                members={members}
                onComplete={()=>onCompleteTask?.(t.id,t.projId,t.colId)}
                onPostpone={(task,newDate,label)=>onPostponeTask?.(task,newDate,label)}
                onOpenModal={()=>onOpenTask?.(t,projIdx)}
              />
            );
          })}
        </div>
      </div>

      {/* Slideout con todas las tareas de un cuadrante */}
      <Slideout
        isOpen={slideoutQ!==null}
        onClose={()=>setSlideoutQ(null)}
        title={slideoutQ?`${slideoutQ} · ${DASH_Q_COLORS[slideoutQ].label}`:""}
        subtitle={slideoutQ?`${quadTasks[slideoutQ].length} tarea${quadTasks[slideoutQ].length!==1?"s":""}`:""}
      >
        {slideoutQ&&quadTasks[slideoutQ].map(t=>{
          const proj=projects.find(p=>p.id===t.projId);
          const projIdx=projects.findIndex(p=>p.id===t.projId);
          const days=daysUntil(t.dueDate);
          const dueLabel=!t.dueDate?"Sin fecha":days<0?`Vencida hace ${-days}d`:days===0?"Hoy":`En ${days}d`;
          return(
            <div key={t.id} className="tf-lift" onClick={()=>{onOpenTask?.(t,projIdx);setSlideoutQ(null);}} style={{padding:"10px 12px",border:"0.5px solid #e5e7eb",borderLeft:`3px solid ${DASH_Q_COLORS[slideoutQ].border}`,borderRadius:10,marginBottom:8,cursor:"pointer",background:"#fff"}}>
              <div style={{fontSize:13,fontWeight:500,marginBottom:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.title}</div>
              <div style={{fontSize:11,color:"#6b7280"}}>{proj?.emoji} {proj?.name} · {t.colName} · <span style={{color:days<0?"#E24B4A":days===0?"#EF9F27":"#6b7280"}}>{dueLabel}</span></div>
            </div>
          );
        })}
        {slideoutQ&&quadTasks[slideoutQ].length===0&&(
          <div style={{fontSize:12,color:"#9ca3af",textAlign:"center",padding:30}}>Sin tareas en este cuadrante</div>
        )}
      </Slideout>

      {/* Carga por persona */}
      <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,padding:14,marginBottom:20}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:600}}>Carga del equipo — próximos 7 días</div>
          <button onClick={onGoPlanner} style={{fontSize:11,padding:"4px 10px",borderRadius:6,border:"1px solid #7F77DD",background:"#fff",color:"#7F77DD",cursor:"pointer",fontWeight:600}}>Ir al planificador →</button>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {loadByMember.map(({m,logged,scheduled,capacity,pct})=>{
            const mp2=MP[m.id]||MP[0];
            const barColor=pct>=90?"#E24B4A":pct>=70?"#EF9F27":"#1D9E75";
            return(
              <div key={m.id} style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{display:"flex",alignItems:"center",gap:7,width:140,flexShrink:0}}>
                  <div style={{width:26,height:26,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700}}>{m.initials}</div>
                  <div style={{minWidth:0}}><div style={{fontSize:12,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.name.split(" ")[0]}</div><div style={{fontSize:10,color:"#9ca3af"}}>{logged.toFixed(1)}h últimos 7d</div></div>
                </div>
                <div style={{flex:1,height:22,background:"#f3f4f6",borderRadius:6,position:"relative",overflow:"hidden"}}>
                  <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${pct}%`,background:barColor,opacity:0.7,borderRadius:6,transition:"width .3s"}}/>
                  <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:600,color:pct>50?"#fff":"#374151"}}>{scheduled.toFixed(1)}h / {capacity.toFixed(0)}h ({pct}%)</div>
                </div>
              </div>
            );
          })}
          {loadByMember.length===0&&<div style={{fontSize:12,color:"#9ca3af",textAlign:"center",padding:10}}>Sin miembros</div>}
        </div>
      </div>

      {/* Estado calendarios */}
      {icsMembers.length>0&&(
        <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,padding:14}}>
          <div style={{fontSize:13,fontWeight:600,marginBottom:10}}>Calendarios conectados</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {icsAlerts.map(({m,synced,count})=>{
              const mp2=MP[m.id]||MP[0];
              const bg=!synced?"#FEF3C7":count>0?"#E1F5EE":"#FCEBEB";
              const bd=!synced?"#F59E0B":count>0?"#1D9E75":"#E24B4A";
              const txt=!synced?"#92400E":count>0?"#085041":"#A32D2D";
              return(
                <div key={m.id} style={{display:"flex",alignItems:"center",gap:7,padding:"6px 12px",background:bg,border:`1px solid ${bd}`,borderRadius:20,fontSize:11}}>
                  <div style={{width:18,height:18,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:700}}>{m.initials}</div>
                  <span style={{color:txt,fontWeight:500}}>{m.name.split(" ")[0]}: {!synced?"sin sincronizar":count>0?`${count} eventos`:"sin eventos / error"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function EisenhowerView({boards,members,activeMemberId,projects}){
  const [fm,setFm]=useState(activeMemberId);
  const allT=Object.entries(boards).flatMap(([pid,cols])=>cols.flatMap(col=>col.tasks.map(t=>({...t,colName:col.name,projName:projects.find(p=>p.id===Number(pid))?.name||""})))).filter(t=>t.colName!=="Hecho");
  const filt=fm===-1?allT:allT.filter(t=>t.assignees.includes(fm));
  const quads={Q1:[],Q2:[],Q3:[],Q4:[]}; filt.forEach(t=>quads[getQ(t)].push(t));
  const allMems=[...new Set(Object.values(boards).flatMap(cols=>cols.flatMap(col=>col.tasks.flatMap(t=>t.assignees))))].map(id=>members.find(m=>m.id===id)).filter(Boolean);
  return(
    <div style={{padding:20}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontSize:16,fontWeight:600,marginBottom:2}}>Matriz de Eisenhower</div><div style={{fontSize:12,color:"#6b7280"}}>Clasifica por urgencia e importancia</div></div>
        <select value={fm} onChange={e=>setFm(Number(e.target.value))} style={{fontSize:12,padding:"5px 10px",borderRadius:8,border:"0.5px solid #d1d5db",background:"#fff"}}><option value={-1}>Todo el equipo</option>{allMems.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select>
      </div>
      <div style={{display:"flex",justifyContent:"center",marginBottom:4}}><span style={{fontSize:11,color:"#E24B4A",fontWeight:600}}>IMPORTANTE</span></div>
      <div style={{display:"grid",gridTemplateColumns:"20px 1fr 1fr",gridTemplateRows:"1fr 1fr",gap:10}}>
        <div style={{gridRow:"1/3",display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{writingMode:"vertical-rl",transform:"rotate(180deg)",fontSize:11,color:"#6b7280",fontWeight:600}}>URGENTE</div></div>
        {["Q1","Q2","Q3","Q4"].map(qk=>{ const qm=QM[qk]; const tasks=quads[qk]; return(
          <div key={qk} style={{background:qm.bg,border:`1.5px solid ${qm.border}`,borderRadius:12,padding:12,minHeight:160}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}><span style={{fontSize:16}}>{qm.icon}</span><div><div style={{fontSize:12,fontWeight:700,color:qm.border}}>{qk}: {qm.label}</div><div style={{fontSize:10,color:"#6b7280"}}>{qm.sub}</div></div><span style={{marginLeft:"auto",fontSize:11,background:"#fff",border:`1px solid ${qm.border}`,borderRadius:20,padding:"1px 7px",color:qm.border,fontWeight:600}}>{tasks.length}</span></div>
            {tasks.length===0&&<div style={{fontSize:11,color:"#9ca3af",textAlign:"center",padding:8}}>Sin tareas</div>}
            {tasks.map(task=>{ const days=daysUntil(task.dueDate); const p2=palOf(task.assignees); return <div key={task.id} style={{background:"#fff",border:`0.5px solid ${p2?p2.cardBorder+"44":"#e5e7eb"}`,borderLeft:`3px solid ${p2?p2.cardBorder:"#e5e7eb"}`,borderRadius:8,padding:"7px 10px",marginBottom:6}}><div style={{fontSize:12,fontWeight:500,marginBottom:3,lineHeight:1.3}}>{task.title}</div><div style={{display:"flex",alignItems:"center",gap:5}}><span style={{fontSize:10,color:days<0?"#A32D2D":days<=2?"#854F0B":"#9ca3af",fontWeight:days<=2?600:400}}>{days<0?"Vencida":days===0?"Hoy":`${days}d`}</span><div style={{marginLeft:"auto",display:"flex"}}>{task.assignees.slice(0,3).map((mid,i2)=><div key={mid} style={{marginLeft:i2>0?-5:0,width:16,height:16,borderRadius:"50%",background:(MP[mid]||MP[0]).solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:7,fontWeight:700,border:"1.5px solid #fff"}}>{members.find(m=>m.id===mid)?.initials.slice(0,2)||"?"}</div>)}</div></div></div>; })}
          </div>
        );})}
      </div>
    </div>
  );
}

// ── Time Reports View ─────────────────────────────────────────────────────────
function TimeReportsView({boards,members,projects}){
  const [fm,setFm]=useState(-1); const [fp,setFp]=useState(-1);
  const allT=Object.entries(boards).flatMap(([pid,cols])=>cols.flatMap(col=>col.tasks.map(t=>({...t,colName:col.name,projId:Number(pid),projName:projects.find(p=>p.id===Number(pid))?.name||""}))));
  const grand=allT.flatMap(t=>t.timeLogs||[]).reduce((s,l)=>s+l.seconds,0);
  const grandEst=allT.filter(t=>t.estimatedHours).reduce((s,t)=>s+t.estimatedHours*3600,0);
  const mStats=members.map(m=>{ const logs=allT.flatMap(t=>(t.timeLogs||[]).filter(l=>l.memberId===m.id)); const total=logs.reduce((s,l)=>s+l.seconds,0); const est=allT.filter(t=>t.assignees.includes(m.id)&&(t.estimatedHours||0)>0).reduce((s,t)=>s+(t.estimatedHours||0)*3600,0); return{...m,total,est,eff:est>0?Math.round(total/est*100):null}; }).filter(m=>m.total>0);
  return(
    <div style={{padding:20}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontSize:16,fontWeight:600,marginBottom:2}}>Reportes de tiempo</div><div style={{fontSize:12,color:"#6b7280"}}>Analisis de tiempos y desviaciones</div></div>
        <div style={{display:"flex",gap:8}}><select value={fm} onChange={e=>setFm(Number(e.target.value))} style={{fontSize:12,padding:"5px 10px",borderRadius:8,border:"0.5px solid #d1d5db",background:"#fff"}}><option value={-1}>Todos</option>{members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginBottom:20}}>
        {[{l:"Total registrado",v:fmtH(grand),c:"#7F77DD",bg:"#EEEDFE"},{l:"Total estimado",v:fmtH(grandEst),c:"#378ADD",bg:"#E6F1FB"},{l:"Desviacion",v:grandEst>0?`${Math.round((grand/grandEst-1)*100)}%`:"—",c:grand>grandEst?"#A32D2D":"#085041",bg:grand>grandEst?"#FCEBEB":"#E1F5EE"},{l:"Tareas activas",v:allT.filter(t=>t.colName!=="Hecho").length,c:"#633806",bg:"#FAEEDA"}].map((k,i)=><div key={i} style={{background:k.bg,borderRadius:10,padding:"12px 14px"}}><div style={{fontSize:10,fontWeight:600,color:k.c,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:4}}>{k.l}</div><div style={{fontSize:22,fontWeight:700,color:k.c}}>{k.v}</div></div>)}
      </div>
      <div style={{fontSize:13,fontWeight:600,marginBottom:10}}>Por miembro</div>
      {mStats.map(m=>{ const mp2=MP[m.id]||MP[0]; const pct=m.est>0?Math.min(Math.round(m.total/m.est*100),100):null; const over=pct!==null&&pct>100; return <div key={m.id} style={{background:"#fff",border:"0.5px solid #e5e7eb",borderLeft:`4px solid ${mp2.solid}`,borderRadius:10,padding:"12px 14px",marginBottom:8}}><div style={{display:"flex",alignItems:"center",gap:10,marginBottom:pct!==null?8:0}}><div style={{width:32,height:32,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,flexShrink:0}}>{m.initials}</div><div style={{flex:1}}><div style={{fontSize:13,fontWeight:600,color:mp2.solid}}>{m.name}</div><div style={{fontSize:11,color:"#6b7280"}}>{m.role}</div></div><div style={{textAlign:"right"}}><div style={{fontSize:16,fontWeight:700,color:over?"#A32D2D":mp2.solid}}>{fmtH(m.total)}</div>{m.est>0&&<div style={{fontSize:10,color:"#6b7280"}}>de {fmtH(m.est)}</div>}</div>{m.eff!==null&&<div style={{background:over?"#FCEBEB":"#E1F5EE",color:over?"#A32D2D":"#085041",border:`1px solid ${over?"#E24B4A":"#1D9E75"}`,borderRadius:20,padding:"3px 9px",fontSize:11,fontWeight:700,flexShrink:0}}>{m.eff}%</div>}</div>{pct!==null&&<div><div style={{height:6,background:"#e5e7eb",borderRadius:20,overflow:"hidden"}}><div style={{height:"100%",width:`${Math.min(pct,100)}%`,background:over?"#E24B4A":pct>80?"#EF9F27":"#1D9E75",borderRadius:20}}/></div>{over&&<div style={{fontSize:10,color:"#A32D2D",marginTop:3}}>Superado en {fmtH(m.total-m.est)}</div>}</div>}</div>; })}
    </div>
  );
}

// ── Project Modal ─────────────────────────────────────────────────────────────
function ProjectModal({project,members,workspaces,onClose,onSave}){
  const isEdit=!!project;
  const [name,setName]=useState(project?.name||"");
  const [desc,setDesc]=useState(project?.desc||"");
  const [color,setColor]=useState(project?.color||PROJECT_COLORS[0]);
  const [emoji,setEmoji]=useState(project?.emoji||"🚀");
  const [sel,setSel]=useState(project?.members||[]);
  const [workspaceId,setWorkspaceId]=useState(project?.workspaceId??null);
  const [cols,setCols]=useState(["Por hacer","En progreso","Revision","Hecho"]);
  const [newCol,setNewCol]=useState("");
  const [pendingClose,setPendingClose]=useState(false);
  const [initialSnap]=useState(()=>JSON.stringify({
    name:project?.name||"", desc:project?.desc||"",
    color:project?.color||PROJECT_COLORS[0], emoji:project?.emoji||"🚀",
    sel:project?.members||[], workspaceId:project?.workspaceId??null,
    cols:["Por hacer","En progreso","Revision","Hecho"], newCol:"",
  }));
  const isDirty=JSON.stringify({name,desc,color,emoji,sel,workspaceId,cols,newCol})!==initialSnap;
  const handleClose=()=>{ if(isDirty) setPendingClose(true); else onClose(); };
  useEffect(()=>{
    const onKey=e=>{ if(e.key==="Escape") handleClose(); };
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[isDirty]);
  const toggleM=id=>setSel(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);
  const addCol=()=>{ const t=newCol.trim(); if(!t)return; setCols(p=>[...p,t]); setNewCol(""); };
  const save=()=>{ if(!name.trim())return; onSave({name:name.trim(),desc,color,emoji,members:sel,columns:cols,workspaceId}); onClose(); };
  return(
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&handleClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:3000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:40,overflowY:"auto"}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:580,maxWidth:"96vw",border:"0.5px solid #e5e7eb",borderTop:`4px solid ${color}`,marginBottom:24}}>
        <div style={{padding:"14px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontWeight:600,fontSize:15}}>{isEdit?"Editar proyecto":"Crear nuevo proyecto"}</div>
          <button onClick={handleClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#6b7280"}}>x</button>
        </div>
        {pendingClose&&<DiscardBanner onKeep={()=>setPendingClose(false)} onDiscard={()=>{setPendingClose(false);onClose();}}/>}
        <div style={{padding:20}}>
          <div style={{background:`${color}18`,border:`2px solid ${color}`,borderRadius:12,padding:"12px 16px",marginBottom:20,display:"flex",alignItems:"center",gap:12}}>
            <div style={{fontSize:28}}>{emoji}</div>
            <div><div style={{fontSize:16,fontWeight:700,color}}>{name||"Nombre del proyecto"}</div><div style={{fontSize:12,color:"#6b7280"}}>{desc||"Descripcion del proyecto"}</div></div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:10,marginBottom:14}}>
            <div>
              <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:5}}>Emoji</div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap",maxWidth:200}}>
                {PROJECT_EMOJIS.map(e=><button key={e} onClick={()=>setEmoji(e)} style={{width:30,height:30,borderRadius:7,border:`2px solid ${emoji===e?color:"#e5e7eb"}`,background:emoji===e?`${color}18`:"transparent",fontSize:16,cursor:"pointer"}}>{e}</button>)}
              </div>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:5}}>Nombre</div>
              <input value={name} onChange={e=>setName(e.target.value)} placeholder="Nombre del proyecto..." style={{width:"100%",padding:"8px 10px",borderRadius:8,border:`1.5px solid ${name?color:"#d1d5db"}`,fontSize:14,fontWeight:500,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
              <div style={{marginTop:8}}>
                <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:5}}>Descripcion</div>
                <input value={desc} onChange={e=>setDesc(e.target.value)} placeholder="Descripcion breve..." style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
              </div>
            </div>
          </div>
          <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>Color</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>
            {PROJECT_COLORS.map(c=><button key={c} onClick={()=>setColor(c)} style={{width:28,height:28,borderRadius:"50%",background:c,border:`3px solid ${color===c?"#374151":"transparent"}`,cursor:"pointer"}}/>)}
          </div>
          <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>Columnas del tablero</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
            {cols.map((c,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:4,background:`${color}18`,border:`1px solid ${color}44`,borderRadius:8,padding:"4px 8px"}}>
                <span style={{fontSize:12,color,fontWeight:500}}>{c}</span>
                {cols.length>1&&<button onClick={()=>setCols(p=>p.filter((_,j)=>j!==i))} style={{background:"none",border:"none",fontSize:12,cursor:"pointer",color,padding:0,lineHeight:1}}>x</button>}
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8,marginBottom:16}}>
            <input value={newCol} onChange={e=>setNewCol(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCol()} placeholder="+ Nueva columna..." style={{flex:1,padding:"6px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:12,outline:"none",fontFamily:"inherit"}}/>
            <button onClick={addCol} style={{padding:"6px 12px",borderRadius:8,background:color,color:"#fff",border:"none",fontSize:12,cursor:"pointer",fontWeight:600}}>Añadir</button>
          </div>
          <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>Workspace asociado (opcional)</div>
          <select value={workspaceId??""} onChange={e=>setWorkspaceId(e.target.value===""?null:Number(e.target.value))} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,background:"#fff",fontFamily:"inherit",marginBottom:16}}>
            <option value="">— Sin workspace —</option>
            {(workspaces||[]).map(w=><option key={w.id} value={w.id}>{w.emoji} {w.name}</option>)}
          </select>
          <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>Miembros</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:8,marginBottom:20}}>
            {members.map(m=>{ const mp2=MP[m.id]||MP[0]; const active=sel.includes(m.id); return <div key={m.id} onClick={()=>toggleM(m.id)} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:10,border:`1.5px solid ${active?mp2.solid:"#e5e7eb"}`,background:active?mp2.light:"#f9fafb",cursor:"pointer"}}><div style={{width:30,height:30,borderRadius:"50%",background:active?mp2.solid:"#d1d5db",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0}}>{m.initials}</div><div style={{flex:1,minWidth:0}}><div style={{fontSize:12,fontWeight:active?600:400,color:active?mp2.solid:"#374151"}}>{m.name}</div><div style={{fontSize:10,color:"#9ca3af"}}>{m.role}</div></div></div>; })}
          </div>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
            <button onClick={onClose} style={{padding:"8px 16px",borderRadius:8,border:"0.5px solid #d1d5db",background:"transparent",fontSize:13,cursor:"pointer"}}>Cancelar</button>
            <button onClick={save} disabled={!name.trim()} style={{padding:"8px 20px",borderRadius:8,background:name.trim()?color:"#e5e7eb",color:name.trim()?"#fff":"#9ca3af",border:"none",fontSize:13,cursor:name.trim()?"pointer":"default",fontWeight:600}}>{isEdit?"Guardar cambios":"Crear proyecto"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Projects Home View ────────────────────────────────────────────────────────
function ProjectsView({projects,members,boards,onSelectProject,onCreateProject,onEditProject,onDeleteProject}){
  const total=pid=>(boards[pid]||[]).flatMap(c=>c.tasks).length;
  const done=pid=>(boards[pid]||[]).filter(c=>c.name==="Hecho").flatMap(c=>c.tasks).length;
  const [pendingDel,setPendingDel]=useState(null);
  return(
    <div style={{padding:20}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontSize:16,fontWeight:700,marginBottom:2}}>Todos los proyectos</div><div style={{fontSize:12,color:"#6b7280"}}>{projects.length} proyectos activos</div></div>
        <button onClick={onCreateProject} style={{padding:"8px 18px",borderRadius:10,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>+ Nuevo proyecto</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:14}}>
        {projects.map((p,i)=>{
          const t=total(p.id),d=done(p.id),pct=t>0?Math.round(d/t*100):0;
          const projMs=p.members.map(mid=>members.find(m=>m.id===mid)).filter(Boolean);
          const isPending=pendingDel===i;
          return(
            <div key={p.id} style={{background:"#fff",border:`0.5px solid ${isPending?"#E24B4A":p.color+"44"}`,borderTop:`4px solid ${isPending?"#E24B4A":p.color}`,borderRadius:12,padding:16,cursor:"pointer"}} onClick={()=>!isPending&&onSelectProject(i)}>
              <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:12}}>
                <div style={{fontSize:26,lineHeight:1}}>{p.emoji||"📋"}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:700,color:p.color,marginBottom:2}}>{p.name}</div>
                  {p.desc&&<div style={{fontSize:11,color:"#6b7280",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.desc}</div>}
                </div>
                <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
                  {!isPending&&<>
                    <button onClick={()=>onEditProject(i)} style={{width:26,height:26,borderRadius:6,border:"0.5px solid #e5e7eb",background:"#f9fafb",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✏️</button>
                    <button onClick={()=>setPendingDel(i)} style={{width:26,height:26,borderRadius:6,border:"0.5px solid #e5e7eb",background:"#f9fafb",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>🗑️</button>
                  </>}
                  {isPending&&<>
                    <button onClick={()=>{onDeleteProject(i);setPendingDel(null);}} style={{padding:"3px 8px",borderRadius:6,background:"#E24B4A",color:"#fff",border:"none",fontSize:11,cursor:"pointer",fontWeight:600}}>Confirmar</button>
                    <button onClick={()=>setPendingDel(null)} style={{padding:"3px 8px",borderRadius:6,background:"transparent",border:"0.5px solid #d1d5db",fontSize:11,cursor:"pointer"}}>No</button>
                  </>}
                </div>
              </div>
              <div style={{marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#6b7280",marginBottom:4}}><span>Progreso</span><span style={{fontWeight:600,color:p.color}}>{d}/{t} · {pct}%</span></div>
                <div style={{height:6,background:"#f3f4f6",borderRadius:20,overflow:"hidden"}}><div style={{height:"100%",width:`${pct}%`,background:p.color,borderRadius:20}}/></div>
              </div>
              <div style={{display:"flex",gap:4,marginBottom:12,flexWrap:"wrap"}}>
                {(boards[p.id]||[]).map(col=><div key={col.id} style={{fontSize:10,padding:"2px 7px",borderRadius:6,background:`${p.color}14`,color:p.color,border:`0.5px solid ${p.color}33`,fontWeight:500}}>{col.name} ({col.tasks.length})</div>)}
              </div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div style={{display:"flex"}}>{projMs.slice(0,5).map((m,mi)=>{ const mp2=MP[m.id]||MP[0]; return <div key={m.id} title={m.name} style={{marginLeft:mi>0?-8:0,zIndex:10-mi,width:26,height:26,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,border:"2px solid #fff"}}>{m.initials}</div>; })}</div>
                <span style={{fontSize:11,color:"#9ca3af"}}>{projMs.length} miembro{projMs.length!==1?"s":""}</span>
              </div>
            </div>
          );
        })}
        <div onClick={onCreateProject} style={{border:"2px dashed #d1d5db",borderRadius:12,padding:16,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:180,gap:8}}>
          <div style={{width:40,height:40,borderRadius:"50%",background:"#f3f4f6",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>+</div>
          <div style={{fontSize:13,fontWeight:500,color:"#6b7280"}}>Nuevo proyecto</div>
        </div>
      </div>
    </div>
  );
}

// ── Team View ─────────────────────────────────────────────────────────────────
function TeamView({project,members,projects,onSelectProject,onEditProfile}){
  const [email,setEmail]=useState(""); const [role,setRole]=useState("Editor"); const [fb,setFb]=useState("");
  const invite=()=>{ if(!email.trim())return; setFb(`Invitacion enviada a ${email.trim()} como ${role}`); setEmail(""); setTimeout(()=>setFb(""),3000); };
  return(
    <div style={{padding:20,maxWidth:760}}>
      <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:16,overflow:"hidden"}}>
        <div style={{padding:"16px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontWeight:500,fontSize:15}}>Equipo — {project.name}</div>
          <span style={{fontSize:11,padding:"2px 9px",borderRadius:20,background:`${project.color}22`,color:project.color,border:`0.5px solid ${project.color}55`,fontWeight:500}}>{project.members.length} miembros</span>
        </div>
        <div style={{padding:20}}>
          <div style={{fontSize:11,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:10}}>Identificacion por color</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:10,marginBottom:24}}>
            {project.members.map(mid=>{ const m=members.find(x=>x.id===mid); const mp2=MP[mid]||MP[0]; const avH=m?.avail?.hoursPerDay||7; const icsOk=!!m?.avail?.icsUrl; return <div key={mid} style={{background:mp2.light,border:`2px solid ${mp2.solid}`,borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",gap:10}}><div style={{width:40,height:40,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,flexShrink:0}}>{m?.initials}</div><div style={{flex:1,minWidth:0}}><div style={{fontSize:13,fontWeight:700,color:mp2.solid}}>{m?.name}</div><div style={{fontSize:11,color:"#6b7280"}}>{m?.role} · {avH}h/d</div><div style={{display:"flex",gap:4,marginTop:3}}>{m?.avail?.whatsapp&&<span style={{fontSize:9,background:"#dcfce7",color:"#166534",padding:"1px 5px",borderRadius:6}}>WA</span>}{icsOk&&<span style={{fontSize:9,background:"#dbeafe",color:"#1e40af",padding:"1px 5px",borderRadius:6}}>Cal</span>}</div></div><button onClick={()=>onEditProfile(m)} style={{background:"none",border:`1px solid ${mp2.solid}`,borderRadius:8,padding:"4px 8px",fontSize:11,cursor:"pointer",color:mp2.solid,fontWeight:600}}>Editar</button></div>; })}
          </div>
          <div style={{borderTop:"0.5px solid #e5e7eb",paddingTop:16,marginBottom:16}}>
            <div style={{fontSize:13,fontWeight:500,marginBottom:10}}>Invitar al proyecto</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email del nuevo miembro..." onKeyDown={e=>e.key==="Enter"&&invite()} style={{flex:1,minWidth:180,padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,outline:"none",fontFamily:"inherit"}}/>
              <select value={role} onChange={e=>setRole(e.target.value)} style={{padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,background:"#fff",fontFamily:"inherit"}}><option>Editor</option><option>Viewer</option><option>Manager</option></select>
              <button onClick={invite} style={{padding:"7px 16px",borderRadius:8,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:500}}>Invitar</button>
            </div>
            {fb&&<div style={{fontSize:12,color:"#1D9E75",marginTop:8}}>{fb}</div>}
          </div>
          <div style={{borderTop:"0.5px solid #e5e7eb",paddingTop:16}}>
            <div style={{fontSize:13,fontWeight:500,marginBottom:10}}>Todos los proyectos</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>{projects.map((p,i)=><div key={p.id} onClick={()=>onSelectProject(i)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 12px",background:"#f9fafb",borderRadius:10,cursor:"pointer"}}><div style={{display:"flex",alignItems:"center",gap:8}}><div style={{width:10,height:10,borderRadius:"50%",background:p.color}}/><span style={{fontSize:13,fontWeight:500}}>{p.name}</span></div><span style={{fontSize:11,color:"#6b7280"}}>{p.members.length} miembros</span></div>)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Member Edit Modal (crear / editar / eliminar usuario) ────────────────────
const ROLES = ["Manager","Editor","Viewer"];
const MEMBER_COLORS = PROJECT_COLORS; // reutilizamos la misma paleta

function MemberEditModal({member, allMembers, onClose, onSave, onDelete}){
  const isEdit = !!member;
  const nextColor = MEMBER_COLORS[allMembers.length % MEMBER_COLORS.length];

  const [name,     setName]     = useState(member?.name     || "");
  const [email,    setEmail]    = useState(member?.email    || "");
  const [role,     setRole]     = useState(member?.role     || "Editor");
  const [whatsapp, setWhatsapp] = useState(member?.avail?.whatsapp || "");
  const [icsUrl,   setIcsUrl]   = useState(member?.avail?.icsUrl   || "");
  const [hours,    setHours]    = useState(member?.avail?.hoursPerDay || 8);
  const [colorIdx, setColorIdx] = useState(
    isEdit ? MEMBER_COLORS.findIndex(c => c === (MP[member.id]?.solid || "#7F77DD")) : allMembers.length % MEMBER_COLORS.length
  );
  const [confirmDel, setConfirmDel] = useState(false);
  const [pendingClose,setPendingClose] = useState(false);
  const [initialSnap] = useState(()=>JSON.stringify({
    name:member?.name||"", email:member?.email||"", role:member?.role||"Editor",
    whatsapp:member?.avail?.whatsapp||"", icsUrl:member?.avail?.icsUrl||"",
    hours:member?.avail?.hoursPerDay||8,
    colorIdx:isEdit?MEMBER_COLORS.findIndex(c=>c===(MP[member.id]?.solid||"#7F77DD")):allMembers.length%MEMBER_COLORS.length,
  }));
  const isDirty = JSON.stringify({name,email,role,whatsapp,icsUrl,hours,colorIdx})!==initialSnap;
  const handleClose = ()=>{ if(isDirty) setPendingClose(true); else onClose(); };
  useEffect(()=>{
    const onKey=e=>{ if(e.key==="Escape") handleClose(); };
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[isDirty]);

  const initials = name.trim().split(" ").map(w=>w[0]||"").join("").toUpperCase().slice(0,2) || "??";
  const color    = MEMBER_COLORS[colorIdx < 0 ? 0 : colorIdx] || nextColor;

  const save = () => {
    if(!name.trim()||!email.trim()) return;
    const updated = {
      name:     name.trim(),
      email:    email.trim(),
      role,
      initials,
      _color:   color,
      avail: {
        ...(member?.avail || {}),
        ...BASE_AVAIL,
        ...(member?.avail || {}),
        whatsapp,
        icsUrl,
        hoursPerDay: hours,
        transportMarginMins: member?.avail?.transportMarginMins || 30,
        googleCalendarId:    member?.avail?.googleCalendarId    || "",
        workDays:            member?.avail?.workDays            || [1,2,3,4,5],
        morningStart:        member?.avail?.morningStart        || "09:00",
        morningEnd:          member?.avail?.morningEnd          || "14:00",
        afternoonStart:      member?.avail?.afternoonStart      || "16:00",
        afternoonEnd:        member?.avail?.afternoonEnd        || "19:00",
        exceptions:          member?.avail?.exceptions          || [],
        blockedSlots:        member?.avail?.blockedSlots        || [],
      },
    };
    onSave(updated);
  };

  return(
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&handleClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:3000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:40,overflowY:"auto"}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:520,maxWidth:"96vw",border:"0.5px solid #e5e7eb",borderTop:`4px solid ${color}`,marginBottom:24}}>
        {/* Header */}
        <div style={{padding:"14px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:44,height:44,borderRadius:"50%",background:color,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:700,flexShrink:0}}>{initials}</div>
          <div style={{flex:1}}>
            <div style={{fontWeight:600,fontSize:15}}>{isEdit?"Editar usuario":"Nuevo usuario"}</div>
            <div style={{fontSize:12,color:"#6b7280"}}>{isEdit?member.email:"Completa los datos del nuevo miembro"}</div>
          </div>
          <button onClick={handleClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#6b7280"}}>x</button>
        </div>
        {pendingClose&&<DiscardBanner onKeep={()=>setPendingClose(false)} onDiscard={()=>{setPendingClose(false);onClose();}}/>}

        <div style={{padding:20}}>
          {/* Nombre + email */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:4}}>
            <div>
              <FL c="Nombre completo"/>
              <input value={name} onChange={e=>setName(e.target.value)} placeholder="Nombre Apellido" style={{width:"100%",padding:"8px 10px",borderRadius:8,border:`1.5px solid ${name?"#7F77DD":"#d1d5db"}`,fontSize:13,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
            </div>
            <div>
              <FL c="Email"/>
              <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="correo@empresa.com" style={{width:"100%",padding:"8px 10px",borderRadius:8,border:`1.5px solid ${email?"#7F77DD":"#d1d5db"}`,fontSize:13,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
            </div>
          </div>

          {/* Rol */}
          <FL c="Rol en el equipo"/>
          <div style={{display:"flex",gap:8,marginBottom:4}}>
            {ROLES.map(r=>(
              <button key={r} onClick={()=>setRole(r)} style={{flex:1,padding:"7px 0",borderRadius:8,border:`1.5px solid ${role===r?color:"#e5e7eb"}`,background:role===r?`${color}18`:"#f9fafb",color:role===r?color:"#6b7280",fontSize:12,cursor:"pointer",fontWeight:role===r?600:400}}>{r}</button>
            ))}
          </div>

          {/* Color del usuario */}
          <FL c="Color identificativo"/>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:4}}>
            {MEMBER_COLORS.map((c,i)=>(
              <button key={c} onClick={()=>setColorIdx(i)} style={{width:30,height:30,borderRadius:"50%",background:c,border:`3px solid ${colorIdx===i?"#374151":"transparent"}`,cursor:"pointer",outline:`2px solid ${colorIdx===i?c+"66":"transparent"}`,outlineOffset:2}}/>
            ))}
          </div>

          {/* Horas productivas */}
          <FL c="Horas productivas por dia"/>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
            <input type="range" min={1} max={12} step={0.5} value={hours} onChange={e=>setHours(Number(e.target.value))} style={{flex:1}}/>
            <span style={{fontSize:14,fontWeight:600,color,minWidth:36}}>{hours}h</span>
          </div>

          {/* WhatsApp */}
          <FL c="WhatsApp"/>
          <input value={whatsapp} onChange={e=>setWhatsapp(e.target.value)} placeholder="+34600000000" style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>

          {/* ICS URL */}
          <FL c="Google Calendar ICS URL (opcional)"/>
          <input value={icsUrl} onChange={e=>setIcsUrl(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/...basic.ics" style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
          {icsUrl&&<div style={{fontSize:10,background:"#E1F5EE",color:"#085041",border:"1px solid #1D9E75",borderRadius:6,padding:"3px 8px",marginTop:4}}>Calendario conectado</div>}

          {/* Preview */}
          <div style={{marginTop:16,background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:10,padding:"10px 14px",display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:38,height:38,borderRadius:"50%",background:color,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,flexShrink:0}}>{initials}</div>
            <div>
              <div style={{fontSize:13,fontWeight:600,color}}>{name||"Nombre del usuario"}</div>
              <div style={{fontSize:11,color:"#6b7280"}}>{role} · {hours}h/dia · {email||"email@empresa.com"}</div>
            </div>
          </div>

          {/* Acciones */}
          <div style={{display:"flex",gap:8,marginTop:20,justifyContent:"space-between",alignItems:"center"}}>
            {/* Eliminar — solo en modo edicion */}
            {isEdit&&(
              !confirmDel
                ?<button onClick={()=>setConfirmDel(true)} style={{padding:"7px 14px",borderRadius:8,background:"#FCEBEB",color:"#A32D2D",border:"1px solid #E24B4A",fontSize:12,cursor:"pointer",fontWeight:500}}>Eliminar usuario</button>
                :<div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <span style={{fontSize:12,color:"#A32D2D",fontWeight:500}}>Confirmar</span>
                  <button onClick={()=>{onDelete(member.id);onClose();}} style={{padding:"7px 14px",borderRadius:8,background:"#E24B4A",color:"#fff",border:"none",fontSize:12,cursor:"pointer",fontWeight:600}}>Si, eliminar</button>
                  <button onClick={()=>setConfirmDel(false)} style={{padding:"7px 10px",borderRadius:8,background:"transparent",border:"0.5px solid #d1d5db",fontSize:12,cursor:"pointer"}}>No</button>
                </div>
            )}
            {!isEdit&&<div/>}
            <div style={{display:"flex",gap:8}}>
              <button onClick={onClose} style={{padding:"8px 16px",borderRadius:8,border:"0.5px solid #d1d5db",background:"transparent",fontSize:13,cursor:"pointer"}}>Cancelar</button>
              <button onClick={save} disabled={!name.trim()||!email.trim()} style={{padding:"8px 20px",borderRadius:8,background:name.trim()&&email.trim()?color:"#e5e7eb",color:name.trim()&&email.trim()?"#fff":"#9ca3af",border:"none",fontSize:13,cursor:name.trim()&&email.trim()?"pointer":"default",fontWeight:600}}>{isEdit?"Guardar cambios":"Crear usuario"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Users View (vista de todos los usuarios del sistema) ──────────────────────
function UsersView({members,projects,onEdit,onCreate,onDelete}){
  const [search,setSearch]=useState("");
  const [pendingDel,setPendingDel]=useState(null); // id del usuario pendiente de confirmar

  const filtered=members.filter(m=>
    m.name.toLowerCase().includes(search.toLowerCase())||
    m.email.toLowerCase().includes(search.toLowerCase())||
    m.role.toLowerCase().includes(search.toLowerCase())
  );

  const confirmDelete=(id)=>{ onDelete(id); setPendingDel(null); };

  return(
    <div style={{padding:20}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:16,fontWeight:700,marginBottom:2}}>Usuarios del sistema</div>
          <div style={{fontSize:12,color:"#6b7280"}}>{members.length} usuarios registrados</div>
        </div>
        <button onClick={onCreate} style={{padding:"8px 18px",borderRadius:10,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>+ Nuevo usuario</button>
      </div>

      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar por nombre, email o rol..." style={{width:"100%",padding:"9px 14px",borderRadius:10,border:"0.5px solid #d1d5db",fontSize:13,outline:"none",fontFamily:"inherit",marginBottom:16,boxSizing:"border-box"}}/>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
        {filtered.map(m=>{
          const mp2=MP[m.id]||MP[0];
          const userProjects=projects.filter(p=>p.members.includes(m.id));
          const icsOk=!!m.avail?.icsUrl;
          const waOk=!!m.avail?.whatsapp;
          const rc={Manager:{bg:"#EEEDFE",text:"#3C3489"},Editor:{bg:"#E1F5EE",text:"#085041"},Viewer:{bg:"#F1EFE8",text:"#444441"}}[m.role]||{bg:"#F1EFE8",text:"#444441"};
          const isPending=pendingDel===m.id;

          return(
            <div key={m.id} style={{background:"#fff",border:`0.5px solid ${isPending?"#E24B4A":mp2.solid+"33"}`,borderTop:`3px solid ${isPending?"#E24B4A":mp2.solid}`,borderRadius:12,padding:14,transition:"border-color .15s"}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:12,marginBottom:12}}>
                <div style={{width:44,height:44,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:700,flexShrink:0}}>{m.initials}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:600,color:mp2.solid,marginBottom:2}}>{m.name}</div>
                  <div style={{fontSize:11,color:"#6b7280",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.email}</div>
                  <div style={{display:"flex",gap:5,marginTop:5,flexWrap:"wrap"}}>
                    <span style={{fontSize:10,padding:"2px 8px",borderRadius:20,background:rc.bg,color:rc.text,fontWeight:600}}>{m.role}</span>
                    <span style={{fontSize:10,padding:"2px 8px",borderRadius:20,background:"#f3f4f6",color:"#6b7280"}}>{m.avail?.hoursPerDay||7}h/dia</span>
                    {waOk&&<span style={{fontSize:10,padding:"2px 7px",borderRadius:20,background:"#dcfce7",color:"#166534"}}>WA</span>}
                    {icsOk&&<span style={{fontSize:10,padding:"2px 7px",borderRadius:20,background:"#dbeafe",color:"#1e40af"}}>Cal</span>}
                  </div>
                </div>
              </div>

              {userProjects.length>0&&(
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:5}}>Proyectos</div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    {userProjects.map(p=><span key={p.id} style={{fontSize:10,padding:"2px 8px",borderRadius:6,background:`${p.color}18`,color:p.color,border:`0.5px solid ${p.color}44`,fontWeight:500}}>{p.emoji} {p.name}</span>)}
                  </div>
                </div>
              )}

              {/* Acciones */}
              <div style={{paddingTop:10,borderTop:"0.5px solid #f3f4f6"}}>
                {!isPending?(
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>onEdit(m)} style={{flex:1,padding:"6px 0",borderRadius:8,border:`1px solid ${mp2.solid}`,background:"transparent",color:mp2.solid,fontSize:12,cursor:"pointer",fontWeight:500}}>Editar</button>
                    <button onClick={()=>setPendingDel(m.id)} style={{padding:"6px 14px",borderRadius:8,border:"1px solid #E24B4A",background:"#FCEBEB",color:"#A32D2D",fontSize:12,cursor:"pointer",fontWeight:500}}>Eliminar</button>
                  </div>
                ):(
                  <div style={{background:"#FCEBEB",border:"1px solid #E24B4A",borderRadius:8,padding:"10px 12px"}}>
                    <div style={{fontSize:12,fontWeight:600,color:"#A32D2D",marginBottom:8}}>Confirmar eliminacion de {m.name}</div>
                    <div style={{fontSize:11,color:"#A32D2D",marginBottom:10}}>Se quitara de todos los proyectos y tareas asignadas.</div>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>confirmDelete(m.id)} style={{flex:1,padding:"6px 0",borderRadius:8,background:"#E24B4A",color:"#fff",border:"none",fontSize:12,cursor:"pointer",fontWeight:600}}>Si, eliminar</button>
                      <button onClick={()=>setPendingDel(null)} style={{flex:1,padding:"6px 0",borderRadius:8,background:"transparent",border:"1px solid #d1d5db",fontSize:12,cursor:"pointer"}}>Cancelar</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <div onClick={onCreate} style={{border:"2px dashed #d1d5db",borderRadius:12,padding:16,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:160,gap:8}}>
          <div style={{width:44,height:44,borderRadius:"50%",background:"#f3f4f6",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>+</div>
          <div style={{fontSize:13,fontWeight:500,color:"#6b7280"}}>Nuevo usuario</div>
          <div style={{fontSize:11,color:"#9ca3af",textAlign:"center"}}>Añade un nuevo miembro al sistema</div>
        </div>
      </div>
    </div>
  );
}

// ── Alert Panel ───────────────────────────────────────────────────────────────
function AlertPanel({alerts,members,activeMemberId,onClose,onEmailSend,onOpenTask}){
  const [tab,setTab]=useState("mine"); const [sent,setSent]=useState({});
  const ls={critical:{bg:"#fff5f5",border:"#E24B4A",text:"#A32D2D",icon:"🚨"},warning:{bg:"#fffbf0",border:"#EF9F27",text:"#854F0B",icon:"⚠️"},info:{bg:"#f0f7ff",border:"#378ADD",text:"#0C447C",icon:"ℹ️"},success:{bg:"#f0fdf7",border:"#1D9E75",text:"#085041",icon:"✅"}};
  const shown=tab==="mine"?alerts.filter(a=>a.memberId===activeMemberId):tab==="advisor"?alerts.filter(a=>a.type==="advisor"&&a.memberId===activeMemberId):alerts.filter(a=>a.type!=="advisor");
  return(
    <div className="tf-overlay" style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.35)",zIndex:2000,display:"flex",alignItems:"flex-start",justifyContent:"flex-end",paddingTop:60,paddingRight:20}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:420,maxHeight:"80vh",display:"flex",flexDirection:"column",border:"0.5px solid #e5e7eb",overflow:"hidden"}}>
        <div style={{padding:"14px 18px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}><div style={{fontWeight:600,fontSize:14}}>Centro de alertas</div><button onClick={onClose} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:"#6b7280"}}>x</button></div>
        <div style={{display:"flex",borderBottom:"0.5px solid #e5e7eb",flexShrink:0}}>{[["mine","Mis alertas"],["advisor","Asesor IA"],["team","Equipo"]].map(([k,l])=><div key={k} onClick={()=>setTab(k)} style={{flex:1,padding:"9px 0",textAlign:"center",fontSize:12,cursor:"pointer",borderBottom:tab===k?"2px solid #7F77DD":"2px solid transparent",color:tab===k?"#7F77DD":"#6b7280",fontWeight:tab===k?600:400}}>{l}</div>)}</div>
        <div style={{flex:1,overflowY:"auto",padding:12}}>
          {shown.length===0&&<div style={{textAlign:"center",padding:30,color:"#9ca3af",fontSize:13}}>Sin alertas activas</div>}
          {shown.map(alert=>{ const s=ls[alert.level]||ls.info; const m=members.find(x=>x.id===alert.memberId); const wu=waUrl(m,`Alerta SoulBaric: ${alert.taskTitle||"Aviso"} — ${alert.msg}`);
            const clickable = !!alert.taskId;
            return(
              <div
                key={alert.id}
                onClick={clickable?()=>onOpenTask?.(alert):undefined}
                title={clickable?"Click para abrir tarea":undefined}
                style={{background:s.bg,border:`1px solid ${s.border}`,borderRadius:10,padding:"10px 12px",marginBottom:8,cursor:clickable?"pointer":"default",transition:"transform .15s ease, box-shadow .15s ease"}}
                onMouseEnter={clickable?e=>{e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow=`0 4px 14px ${s.border}33`;}:undefined}
                onMouseLeave={clickable?e=>{e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.boxShadow="none";}:undefined}
              >
                <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
                  <span style={{fontSize:16,lineHeight:1.2,flexShrink:0}}>{s.icon}</span>
                  <div style={{flex:1,minWidth:0}}>
                    {alert.taskTitle&&<div style={{fontSize:12,fontWeight:600,color:s.text,marginBottom:2}}>{alert.taskTitle}</div>}
                    <div style={{fontSize:12,color:s.text,lineHeight:1.5}}>{alert.msg}</div>
                    {alert.quadrant&&<div style={{marginTop:5}}><QBadge q={alert.quadrant}/></div>}
                    <div style={{display:"flex",gap:6,marginTop:6,flexWrap:"wrap"}}>
                      {tab==="team"&&<span style={{fontSize:11,color:"#6b7280"}}>{m?.name}</span>}
                      <div style={{marginLeft:"auto",display:"flex",gap:5}}>
                        {wu&&<a href={wu} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{fontSize:11,padding:"2px 8px",borderRadius:6,background:"#dcfce7",color:"#166534",border:"1px solid #4ade80",textDecoration:"none",fontWeight:500}}>WA</a>}
                        <button onClick={e=>{e.stopPropagation();setSent(p=>({...p,[alert.id]:true}));onEmailSend({to:m?.email,subject:`[SoulBaric] ${alert.taskTitle||"Alerta"}`,body:alert.msg});}} style={{fontSize:11,padding:"2px 8px",borderRadius:6,border:`1px solid ${s.border}`,background:"transparent",color:s.text,cursor:"pointer",fontWeight:500}}>{sent[alert.id]?"Enviado":"Email"}</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EmailToast({emails,onDismiss}){
  return(
    <div style={{position:"fixed",bottom:20,right:20,zIndex:3000,display:"flex",flexDirection:"column",gap:8,maxWidth:340}}>
      {emails.map((e,i)=>(
        <div key={i} style={{background:"#fff",border:"1px solid #1D9E75",borderLeft:"4px solid #1D9E75",borderRadius:10,padding:"10px 14px"}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span style={{fontSize:12,fontWeight:600,color:"#085041"}}>Email simulado enviado</span><button onClick={()=>onDismiss(i)} style={{background:"none",border:"none",fontSize:14,cursor:"pointer",color:"#9ca3af"}}>x</button></div>
          <div style={{fontSize:11,color:"#4b5563"}}>Para: {e.to}</div>
          <div style={{fontSize:11,color:"#4b5563"}}>Asunto: {e.subject}</div>
        </div>
      ))}
    </div>
  );
}

// ── Toast system ──────────────────────────────────────────────────────────────
function Toast({toasts}){
  if(!toasts.length)return null;
  const S={
    success:{bg:"#E1F5EE",border:"#1D9E75",text:"#085041",icon:"✓"},
    error:  {bg:"#FCEBEB",border:"#E24B4A",text:"#A32D2D",icon:"⚠"},
    info:   {bg:"#E6F1FB",border:"#378ADD",text:"#0C447C",icon:"ℹ"},
  };
  return(
    <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",zIndex:4000,display:"flex",flexDirection:"column",gap:8,alignItems:"center",pointerEvents:"none"}}>
      {toasts.map(t=>{ const s=S[t.type]||S.success; const clickable = typeof t.onClick === "function"; return(
        <div key={t.id} onClick={clickable?t.onClick:undefined} style={{background:s.bg,border:`1px solid ${s.border}`,borderRadius:10,padding:"10px 22px",fontSize:13,fontWeight:600,color:s.text,display:"flex",alignItems:"center",gap:8,boxShadow:"0 4px 16px rgba(0,0,0,0.12)",whiteSpace:"nowrap",animation:"fadeInUp .18s ease",pointerEvents:clickable?"auto":"none",cursor:clickable?"pointer":"default"}}>
          <span style={{fontSize:15}}>{s.icon}</span><span>{t.msg}</span>
          {clickable && <span style={{fontSize:11,opacity:0.7,marginLeft:6}}>→ ver</span>}
        </div>
      );})}
    </div>
  );
}

function DailyDigest({boards,members,activeMemberId}){
  const [open,setOpen]=useState(true); if(!open)return null;
  const allT=Object.values(boards).flatMap(cols=>cols.flatMap(c=>c.tasks.map(t=>({...t,colName:c.name})))).filter(t=>t.colName!=="Hecho"&&t.assignees.includes(activeMemberId));
  const q1=allT.filter(t=>getQ(t)==="Q1"); const todayT=allT.filter(t=>daysUntil(t.dueDate)===0);
  const m=members.find(x=>x.id===activeMemberId); const mp2=MP[activeMemberId]||MP[0];
  return(
    <div style={{margin:"12px 20px 0",background:mp2.light,border:`1.5px solid ${mp2.solid}`,borderRadius:12,padding:"12px 16px",display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
      <div style={{width:40,height:40,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:700,flexShrink:0}}>{m?.initials}</div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:600,color:mp2.solid}}>Hola, {m?.name.split(" ")[0]} · {m?.avail?.hoursPerDay||7}h disponibles hoy</div>
        <div style={{fontSize:12,color:"#4b5563",marginTop:2}}>
          {q1.length>0?`${q1.length} tarea${q1.length>1?"s":""} critica${q1.length>1?"s":""}.`:""}{" "}
          {todayT.length>0?`${todayT.length} vence${todayT.length>1?"n":""} hoy.`:""}{" "}
          {q1.length===0&&todayT.length===0?"Sin urgencias. Buen dia para avanzar en Q2.":""}
        </div>
      </div>
      <div style={{display:"flex",gap:8,flexShrink:0,flexWrap:"wrap"}}>
        {q1.slice(0,2).map(t=><div key={t.id} style={{fontSize:11,background:"#FCEBEB",color:"#A32D2D",border:"1px solid #E24B4A",borderRadius:8,padding:"3px 8px",fontWeight:500}}>{t.title.slice(0,22)}{t.title.length>22?"...":""}</div>)}
      </div>
      <button onClick={()=>setOpen(false)} style={{background:"none",border:"none",fontSize:16,cursor:"pointer",color:"#9ca3af",flexShrink:0}}>x</button>
    </div>
  );
}

// ── Workspace Modal ───────────────────────────────────────────────────────────
const WS_EMOJIS = ["🏢","🏬","🏛️","🏦","🏭","🏪","🏤","🏥","🌍","💼","🧾","📊"];

function WorkspaceModal({workspace,onClose,onSave,onDelete}){
  const isEdit = !!workspace;
  const [name,setName]         = useState(workspace?.name||"");
  const [description,setDesc]  = useState(workspace?.description||"");
  const [color,setColor]       = useState(workspace?.color||PROJECT_COLORS[4]);
  const [emoji,setEmoji]       = useState(workspace?.emoji||"🏢");
  const [links,setLinks]       = useState(workspace?.links||[]);
  const [contacts,setContacts] = useState(workspace?.contacts||[]);
  const [pendingDel,setPendingDel] = useState(false);
  const [pendingClose,setPendingClose] = useState(false);
  const [initialSnap] = useState(()=>JSON.stringify({
    name:workspace?.name||"", description:workspace?.description||"",
    color:workspace?.color||PROJECT_COLORS[4], emoji:workspace?.emoji||"🏢",
    links:workspace?.links||[], contacts:workspace?.contacts||[],
  }));
  const isDirty = JSON.stringify({name,description,color,emoji,links,contacts})!==initialSnap;
  const handleClose = ()=>{ if(isDirty) setPendingClose(true); else onClose(); };
  useEffect(()=>{
    const onKey=e=>{ if(e.key==="Escape") handleClose(); };
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[isDirty]);

  const addLink    = ()=>setLinks(p=>[...p,{id:_uid("wl"),label:"",url:"",icon:"🔗"}]);
  const updLink    = (id,patch)=>setLinks(p=>p.map(l=>l.id===id?{...l,...patch}:l));
  const delLink    = id=>setLinks(p=>p.filter(l=>l.id!==id));

  const addContact = ()=>setContacts(p=>[...p,{id:_uid("wc"),name:"",role:"",email:"",phone:"",credentials:[]}]);
  const updContact = (id,patch)=>setContacts(p=>p.map(c=>c.id===id?{...c,...patch}:c));
  const delContact = id=>setContacts(p=>p.filter(c=>c.id!==id));

  const addCred = (cid)=>updContact(cid,{credentials:[...(contacts.find(c=>c.id===cid)?.credentials||[]),{id:_uid("cr"),system:"",url:"",login:"",notes:"",hint:""}]});
  const updCred = (cid,crid,patch)=>updContact(cid,{credentials:(contacts.find(c=>c.id===cid)?.credentials||[]).map(cr=>cr.id===crid?{...cr,...patch}:cr)});
  const delCred = (cid,crid)=>updContact(cid,{credentials:(contacts.find(c=>c.id===cid)?.credentials||[]).filter(cr=>cr.id!==crid)});

  const save = ()=>{
    if(!name.trim()) return;
    const cleanLinks    = links.filter(l=>l.url.trim()).map(l=>({...l,label:l.label.trim()||l.url,url:l.url.trim()}));
    const cleanContacts = contacts.map(c=>({...c,credentials:(c.credentials||[]).filter(cr=>cr.system.trim()||cr.url.trim()||cr.login.trim())}));
    onSave({name:name.trim(),description:description.trim(),color,emoji,links:cleanLinks,contacts:cleanContacts});
    onClose();
  };

  return(
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&handleClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:3000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:30,overflowY:"auto"}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:680,maxWidth:"96vw",border:"0.5px solid #e5e7eb",borderTop:`4px solid ${color}`,marginBottom:30}}>
        <div style={{padding:"14px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontWeight:600,fontSize:15}}>{isEdit?"Editar workspace":"Nuevo workspace"}</div>
          <button onClick={handleClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#6b7280"}}>×</button>
        </div>
        {pendingClose&&<DiscardBanner onKeep={()=>setPendingClose(false)} onDiscard={()=>{setPendingClose(false);onClose();}}/>}
        <div style={{padding:20,maxHeight:"75vh",overflowY:"auto"}}>
          {/* Preview */}
          <div style={{background:`${color}18`,border:`2px solid ${color}`,borderRadius:12,padding:"12px 16px",marginBottom:20,display:"flex",alignItems:"center",gap:12}}>
            <div style={{fontSize:28}}>{emoji}</div>
            <div><div style={{fontSize:16,fontWeight:700,color}}>{name||"Nombre del workspace"}</div><div style={{fontSize:12,color:"#6b7280"}}>{description||"Descripción o nota"}</div></div>
          </div>
          {/* Básicos */}
          <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:10,marginBottom:14}}>
            <div>
              <FL c="Emoji"/>
              <div style={{display:"flex",gap:5,flexWrap:"wrap",maxWidth:220}}>
                {WS_EMOJIS.map(e=><button key={e} onClick={()=>setEmoji(e)} style={{width:30,height:30,borderRadius:7,border:`2px solid ${emoji===e?color:"#e5e7eb"}`,background:emoji===e?`${color}18`:"transparent",fontSize:16,cursor:"pointer"}}>{e}</button>)}
              </div>
            </div>
            <div>
              <FL c="Nombre"/>
              <FI value={name} onChange={setName} placeholder="Ej: Cliente Pérez"/>
              <FL c="Descripción"/>
              <FI value={description} onChange={setDesc} placeholder="Ej: Consultora financiera — contrato anual"/>
            </div>
          </div>
          <FL c="Color"/>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>
            {PROJECT_COLORS.map(c=><button key={c} onClick={()=>setColor(c)} style={{width:28,height:28,borderRadius:"50%",background:c,border:`3px solid ${color===c?"#374151":"transparent"}`,cursor:"pointer"}}/>)}
          </div>

          {/* Enlaces */}
          <div style={{borderTop:"0.5px solid #e5e7eb",paddingTop:16,marginTop:6}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <div style={{fontSize:12,fontWeight:600,color:"#374151"}}>🔗 Enlaces rápidos</div>
              <button onClick={addLink} style={{padding:"5px 12px",borderRadius:7,background:color,color:"#fff",border:"none",fontSize:11,cursor:"pointer",fontWeight:600}}>+ Añadir enlace</button>
            </div>
            {links.length===0&&<div style={{fontSize:11,color:"#9ca3af",fontStyle:"italic",padding:"8px 0"}}>Sin enlaces. Añade URLs al Drive, web, CRM...</div>}
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {links.map(l=>(
                <div key={l.id} style={{display:"flex",gap:6,alignItems:"center"}}>
                  <input value={l.icon} onChange={e=>updLink(l.id,{icon:e.target.value})} style={{width:40,padding:"6px 6px",borderRadius:7,border:"0.5px solid #d1d5db",fontSize:13,textAlign:"center",fontFamily:"inherit"}}/>
                  <input value={l.label} onChange={e=>updLink(l.id,{label:e.target.value})} placeholder="Etiqueta (ej: Drive)" style={{width:150,padding:"6px 10px",borderRadius:7,border:"0.5px solid #d1d5db",fontSize:12,fontFamily:"inherit",outline:"none"}}/>
                  <input value={l.url} onChange={e=>updLink(l.id,{url:e.target.value})} placeholder="https://..." style={{flex:1,padding:"6px 10px",borderRadius:7,border:"0.5px solid #d1d5db",fontSize:12,fontFamily:"inherit",outline:"none"}}/>
                  <button onClick={()=>delLink(l.id)} style={{background:"none",border:"none",fontSize:16,color:"#9ca3af",cursor:"pointer",padding:"4px 8px"}}>×</button>
                </div>
              ))}
            </div>
          </div>

          {/* Contactos */}
          <div style={{borderTop:"0.5px solid #e5e7eb",paddingTop:16,marginTop:16}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <div style={{fontSize:12,fontWeight:600,color:"#374151"}}>👥 Contactos</div>
              <button onClick={addContact} style={{padding:"5px 12px",borderRadius:7,background:color,color:"#fff",border:"none",fontSize:11,cursor:"pointer",fontWeight:600}}>+ Añadir contacto</button>
            </div>
            {contacts.length===0&&<div style={{fontSize:11,color:"#9ca3af",fontStyle:"italic",padding:"8px 0"}}>Sin contactos.</div>}
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {contacts.map(c=>(
                <div key={c.id} style={{background:"#f9fafb",border:"0.5px solid #e5e7eb",borderRadius:10,padding:"10px 12px"}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:6}}>
                    <input value={c.name} onChange={e=>updContact(c.id,{name:e.target.value})} placeholder="Nombre completo" style={{padding:"6px 10px",borderRadius:7,border:"0.5px solid #d1d5db",fontSize:12,fontFamily:"inherit",outline:"none"}}/>
                    <input value={c.role} onChange={e=>updContact(c.id,{role:e.target.value})} placeholder="Rol (ej: CEO, CFO...)" style={{padding:"6px 10px",borderRadius:7,border:"0.5px solid #d1d5db",fontSize:12,fontFamily:"inherit",outline:"none"}}/>
                    <input value={c.email} onChange={e=>updContact(c.id,{email:e.target.value})} placeholder="email@..." style={{padding:"6px 10px",borderRadius:7,border:"0.5px solid #d1d5db",fontSize:12,fontFamily:"inherit",outline:"none"}}/>
                    <input value={c.phone} onChange={e=>updContact(c.id,{phone:e.target.value})} placeholder="+34..." style={{padding:"6px 10px",borderRadius:7,border:"0.5px solid #d1d5db",fontSize:12,fontFamily:"inherit",outline:"none"}}/>
                  </div>
                  {/* Credenciales */}
                  <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:8,padding:"8px 10px",marginTop:6}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                      <div style={{fontSize:10,fontWeight:600,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.06em"}}>🔐 Accesos (sin contraseña)</div>
                      <button onClick={()=>addCred(c.id)} style={{padding:"3px 10px",borderRadius:6,border:"0.5px solid #d1d5db",background:"#f9fafb",fontSize:10,cursor:"pointer",fontWeight:500}}>+ Acceso</button>
                    </div>
                    {(c.credentials||[]).length===0&&<div style={{fontSize:10,color:"#9ca3af",fontStyle:"italic"}}>Sin accesos registrados.</div>}
                    {(c.credentials||[]).map(cr=>(
                      <div key={cr.id} style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:6,padding:"6px 0",borderTop:"0.5px dashed #e5e7eb"}}>
                        <input value={cr.system} onChange={e=>updCred(c.id,cr.id,{system:e.target.value})} placeholder="Sistema (ej: CRM)" style={{padding:"5px 8px",borderRadius:6,border:"0.5px solid #d1d5db",fontSize:11,fontFamily:"inherit",outline:"none"}}/>
                        <input value={cr.url} onChange={e=>updCred(c.id,cr.id,{url:e.target.value})} placeholder="URL de acceso" style={{padding:"5px 8px",borderRadius:6,border:"0.5px solid #d1d5db",fontSize:11,fontFamily:"inherit",outline:"none"}}/>
                        <input value={cr.login} onChange={e=>updCred(c.id,cr.id,{login:e.target.value})} placeholder="Usuario / email de login" style={{padding:"5px 8px",borderRadius:6,border:"0.5px solid #d1d5db",fontSize:11,fontFamily:"inherit",outline:"none"}}/>
                        <input value={cr.hint} onChange={e=>updCred(c.id,cr.id,{hint:e.target.value})} placeholder="Contraseña guardada en... (1Password, etc.)" style={{padding:"5px 8px",borderRadius:6,border:"0.5px solid #d1d5db",fontSize:11,fontFamily:"inherit",outline:"none"}}/>
                        <input value={cr.notes} onChange={e=>updCred(c.id,cr.id,{notes:e.target.value})} placeholder="Notas (2FA, SSO, recuperación...)" style={{gridColumn:"1 / span 2",padding:"5px 8px",borderRadius:6,border:"0.5px solid #d1d5db",fontSize:11,fontFamily:"inherit",outline:"none"}}/>
                        <button onClick={()=>delCred(c.id,cr.id)} style={{gridColumn:"1 / span 2",justifySelf:"end",background:"none",border:"none",fontSize:11,color:"#9ca3af",cursor:"pointer"}}>Eliminar acceso ×</button>
                      </div>
                    ))}
                  </div>
                  <div style={{textAlign:"right",marginTop:6}}>
                    <button onClick={()=>delContact(c.id)} style={{background:"none",border:"none",fontSize:11,color:"#E24B4A",cursor:"pointer"}}>Eliminar contacto ×</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{background:"#FFF7E6",border:"1px solid #F0B85B",borderRadius:8,padding:"8px 12px",marginTop:14,fontSize:11,color:"#7C4A02"}}>
            ⚠ Nunca guardes contraseñas aquí. Usa tu gestor (1Password, Bitwarden, llavero). SoulBaric vive en localStorage sin cifrado.
          </div>

          <div style={{display:"flex",gap:8,justifyContent:"space-between",marginTop:20,alignItems:"center"}}>
            {isEdit ? (
              pendingDel
                ? <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>{onDelete(workspace.id);onClose();}} style={{padding:"8px 14px",borderRadius:8,background:"#E24B4A",color:"#fff",border:"none",fontSize:12,cursor:"pointer",fontWeight:600}}>Confirmar eliminación</button>
                    <button onClick={()=>setPendingDel(false)} style={{padding:"8px 14px",borderRadius:8,border:"0.5px solid #d1d5db",background:"transparent",fontSize:12,cursor:"pointer"}}>Cancelar</button>
                  </div>
                : <button onClick={()=>setPendingDel(true)} style={{padding:"8px 14px",borderRadius:8,background:"transparent",color:"#E24B4A",border:"0.5px solid #E24B4A",fontSize:12,cursor:"pointer",fontWeight:500}}>Eliminar workspace</button>
            ) : <div/>}
            <div style={{display:"flex",gap:8}}>
              <button onClick={onClose} style={{padding:"8px 16px",borderRadius:8,border:"0.5px solid #d1d5db",background:"transparent",fontSize:13,cursor:"pointer"}}>Cancelar</button>
              <button onClick={save} disabled={!name.trim()} style={{padding:"8px 20px",borderRadius:8,background:name.trim()?color:"#e5e7eb",color:name.trim()?"#fff":"#9ca3af",border:"none",fontSize:13,cursor:name.trim()?"pointer":"default",fontWeight:600}}>{isEdit?"Guardar":"Crear"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Workspaces View ───────────────────────────────────────────────────────────
function WorkspacesView({workspaces,projects,boards,onCreate,onEdit,onSelectProject,pendingWorkspaceId,onPendingConsumed}){
  const [selected,setSelected] = useState(null);
  useEffect(()=>{
    if(pendingWorkspaceId!=null){
      setSelected(pendingWorkspaceId);
      onPendingConsumed?.();
    }
  },[pendingWorkspaceId,onPendingConsumed]);
  const ws = selected!=null ? workspaces.find(w=>w.id===selected) : null;

  if(ws){
    const wsProjects = projects.map((p,i)=>({p,i})).filter(x=>x.p.workspaceId===ws.id);
    const activeTasks = wsProjects.reduce((s,{p})=>{
      const cols = boards[p.id]||[];
      return s + cols.filter(c=>c.name!=="Hecho").reduce((ss,c)=>ss+c.tasks.length,0);
    },0);
    return(
      <div style={{padding:20,maxWidth:880}}>
        <button onClick={()=>setSelected(null)} style={{background:"none",border:"none",fontSize:12,color:"#6b7280",cursor:"pointer",marginBottom:10,padding:0}}>← Volver a workspaces</button>
        <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderTop:`4px solid ${ws.color}`,borderRadius:14,padding:20,marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:6}}>
            <div style={{fontSize:36}}>{ws.emoji}</div>
            <div style={{flex:1}}>
              <div style={{fontSize:20,fontWeight:700,color:ws.color}}>{ws.name}</div>
              {ws.description&&<div style={{fontSize:13,color:"#6b7280",marginTop:2}}>{ws.description}</div>}
            </div>
            <button onClick={()=>onEdit(ws)} style={{padding:"7px 14px",borderRadius:8,background:ws.color,color:"#fff",border:"none",fontSize:12,cursor:"pointer",fontWeight:600}}>✏ Editar</button>
          </div>
          <div style={{display:"flex",gap:16,marginTop:14,fontSize:12,color:"#6b7280"}}>
            <span><b style={{color:ws.color}}>{wsProjects.length}</b> proyectos</span>
            <span><b style={{color:ws.color}}>{ws.links?.length||0}</b> enlaces</span>
            <span><b style={{color:ws.color}}>{ws.contacts?.length||0}</b> contactos</span>
            <span><b style={{color:ws.color}}>{activeTasks}</b> tareas activas</span>
          </div>
        </div>

        {(ws.links?.length>0)&&(
          <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:12,padding:16,marginBottom:16}}>
            <div style={{fontSize:12,fontWeight:600,color:"#374151",marginBottom:10}}>🔗 Enlaces rápidos</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {ws.links.map(l=>(
                <a key={l.id} href={l.url} target="_blank" rel="noreferrer" style={{display:"flex",alignItems:"center",gap:6,padding:"7px 12px",borderRadius:8,background:`${ws.color}14`,border:`1px solid ${ws.color}55`,color:ws.color,fontSize:12,fontWeight:600,textDecoration:"none"}}>
                  <span>{l.icon||"🔗"}</span>{l.label}
                </a>
              ))}
            </div>
          </div>
        )}

        {wsProjects.length>0&&(
          <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:12,padding:16,marginBottom:16}}>
            <div style={{fontSize:12,fontWeight:600,color:"#374151",marginBottom:10}}>📋 Proyectos asociados</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:8}}>
              {wsProjects.map(({p,i})=>{
                const cols=boards[p.id]||[];
                const total=cols.reduce((s,c)=>s+c.tasks.length,0);
                const done=cols.filter(c=>c.name==="Hecho").reduce((s,c)=>s+c.tasks.length,0);
                return(
                  <div key={p.id} onClick={()=>onSelectProject(i)} style={{border:`1px solid ${p.color}44`,borderLeft:`4px solid ${p.color}`,borderRadius:10,padding:"10px 12px",cursor:"pointer",background:"#fafafa"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                      <span style={{fontSize:16}}>{p.emoji||"📋"}</span>
                      <span style={{fontSize:13,fontWeight:600,color:p.color}}>{p.name}</span>
                    </div>
                    <div style={{fontSize:11,color:"#6b7280"}}>{done}/{total} tareas</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {(ws.contacts?.length>0)&&(
          <div style={{background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:12,padding:16}}>
            <div style={{fontSize:12,fontWeight:600,color:"#374151",marginBottom:10}}>👥 Contactos</div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {ws.contacts.map(c=>(
                <div key={c.id} style={{border:"0.5px solid #e5e7eb",borderRadius:10,padding:"10px 12px",background:"#fafafa"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                    <div>
                      <div style={{fontSize:13,fontWeight:600}}>{c.name||"(sin nombre)"} {c.role&&<span style={{fontWeight:400,color:"#6b7280",fontSize:12}}>· {c.role}</span>}</div>
                      <div style={{fontSize:11,color:"#6b7280",marginTop:2}}>{c.email} {c.phone&&`· ${c.phone}`}</div>
                    </div>
                  </div>
                  {(c.credentials?.length>0)&&(
                    <div style={{marginTop:6,borderTop:"0.5px dashed #e5e7eb",paddingTop:8}}>
                      <div style={{fontSize:10,color:"#6b7280",marginBottom:6,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em"}}>🔐 Accesos</div>
                      <div style={{display:"flex",flexDirection:"column",gap:5}}>
                        {c.credentials.map(cr=>(
                          <div key={cr.id} style={{fontSize:11,padding:"6px 10px",background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:7,display:"flex",flexWrap:"wrap",gap:8,alignItems:"center"}}>
                            <b style={{color:"#374151"}}>{cr.system}</b>
                            {cr.url&&<a href={cr.url} target="_blank" rel="noreferrer" style={{color:ws.color,textDecoration:"none"}}>🔗 Abrir</a>}
                            {cr.login&&<span style={{color:"#6b7280"}}>👤 {cr.login}</span>}
                            {cr.hint&&<span style={{color:"#854F0B",background:"#FAEEDA",padding:"1px 8px",borderRadius:6,fontSize:10}}>🔑 {cr.hint}</span>}
                            {cr.notes&&<span style={{color:"#6b7280",fontStyle:"italic"}}>{cr.notes}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return(
    <div style={{padding:20}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:16,fontWeight:700,marginBottom:2}}>Workspaces</div>
          <div style={{fontSize:12,color:"#6b7280"}}>{workspaces.length} cliente{workspaces.length!==1?"s":""} · control operativo</div>
        </div>
        <button onClick={onCreate} style={{padding:"8px 18px",borderRadius:10,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>+ Nuevo workspace</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:14}}>
        {workspaces.map(w=>{
          const wsProjects = projects.filter(p=>p.workspaceId===w.id);
          const activeTasks = wsProjects.reduce((s,p)=>{
            const cols=boards[p.id]||[];
            return s + cols.filter(c=>c.name!=="Hecho").reduce((ss,c)=>ss+c.tasks.length,0);
          },0);
          return(
            <div key={w.id} onClick={()=>setSelected(w.id)} style={{background:"#fff",border:`0.5px solid ${w.color}44`,borderTop:`4px solid ${w.color}`,borderRadius:12,padding:16,cursor:"pointer"}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:10}}>
                <div style={{fontSize:26,lineHeight:1}}>{w.emoji}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:700,color:w.color,marginBottom:2}}>{w.name}</div>
                  {w.description&&<div style={{fontSize:11,color:"#6b7280",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{w.description}</div>}
                </div>
              </div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap",fontSize:10,color:"#6b7280"}}>
                <span style={{background:`${w.color}14`,color:w.color,padding:"2px 8px",borderRadius:10,fontWeight:600}}>📋 {wsProjects.length} proyectos</span>
                <span style={{background:`${w.color}14`,color:w.color,padding:"2px 8px",borderRadius:10,fontWeight:600}}>🔗 {w.links?.length||0}</span>
                <span style={{background:`${w.color}14`,color:w.color,padding:"2px 8px",borderRadius:10,fontWeight:600}}>👥 {w.contacts?.length||0}</span>
                <span style={{background:`${w.color}14`,color:w.color,padding:"2px 8px",borderRadius:10,fontWeight:600}}>✓ {activeTasks} activas</span>
              </div>
            </div>
          );
        })}
        <div onClick={onCreate} style={{border:"2px dashed #d1d5db",borderRadius:12,padding:16,cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:140,gap:8}}>
          <div style={{width:40,height:40,borderRadius:"50%",background:"#f3f4f6",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>+</div>
          <div style={{fontSize:13,fontWeight:500,color:"#6b7280"}}>Nuevo workspace</div>
        </div>
      </div>
    </div>
  );
}

// ── Agents: edit modal + view ─────────────────────────────────────────────────
const AGENT_EMOJIS = ["⚖️","📣","✍️","💰","🧠","🎯","🩺","🛡️","🎨","📊","💡","🧑‍💼","🧾","🗣️","🔬","🧱"];
const AGENT_COLORS = ["#7F77DD","#E76AA1","#378ADD","#1D9E75","#E24B4A","#EF9F27","#3C3489","#9E5C22","#8B5CF6","#0EA5E9"];

function AgentEditModal({agent,onClose,onSave,onDelete}){
  const isNew = !agent;
  const DEFAULT_DRAFT = {
    name:"", role:"", emoji:"🤖", color:"#7F77DD",
    voice:{gender:"male",rate:1.0,pitch:1.0},
    specialties:[],
    opener:"", style:"", promptBase:"",
    advice:{ default:"", overdue:"", noDueDate:"", noSubtasks:"", overBudget:"", q1:"", q2:"" },
  };
  const [draft,setDraft] = useState(agent || DEFAULT_DRAFT);
  const [confirmDelete,setConfirmDelete] = useState(false);
  const [pendingClose,setPendingClose] = useState(false);
  const [initialSnap] = useState(()=>JSON.stringify(agent||DEFAULT_DRAFT));
  const isDirty = JSON.stringify(draft)!==initialSnap;
  const handleClose = ()=>{ if(isDirty) setPendingClose(true); else onClose(); };
  useEffect(()=>{
    const onKey=e=>{ if(e.key==="Escape") handleClose(); };
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[isDirty]);
  const set = (k,v)=>setDraft(d=>({...d,[k]:v}));
  const setVoice = (k,v)=>setDraft(d=>({...d,voice:{...d.voice,[k]:v}}));
  const setAdvice = (k,v)=>setDraft(d=>({...d,advice:{...d.advice,[k]:v}}));
  const canSave = draft.name.trim().length > 0;

  return (
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&handleClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:3000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:40,overflowY:"auto"}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:640,maxWidth:"96vw",border:"0.5px solid #e5e7eb",borderTop:`4px solid ${draft.color}`,marginBottom:24}}>
        <div style={{padding:"16px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:40,height:40,borderRadius:10,background:`${draft.color}22`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>{draft.emoji}</div>
          <div style={{flex:1}}>
            <div style={{fontSize:15,fontWeight:700}}>{isNew?"Nuevo agente IA":"Editar agente"}</div>
            <div style={{fontSize:11,color:"#6b7280"}}>Asesor personalizado que analiza tareas según su especialidad</div>
          </div>
          <button onClick={handleClose} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:"#9ca3af",lineHeight:1}}>×</button>
        </div>
        {pendingClose&&<DiscardBanner onKeep={()=>setPendingClose(false)} onDiscard={()=>{setPendingClose(false);onClose();}}/>}

        <div style={{padding:"14px 20px"}}>
          <FL c="Nombre del agente"/>
          <FI value={draft.name} onChange={v=>set("name",v)} placeholder="Ej: María Abogada, CarlosMKT"/>

          <FL c="Rol o especialidad"/>
          <FI value={draft.role} onChange={v=>set("role",v)} placeholder="Ej: Derecho mercantil, Estratega digital"/>

          <FL c="Icono"/>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {AGENT_EMOJIS.map(e=>(
              <button key={e} onClick={()=>set("emoji",e)} style={{width:36,height:36,borderRadius:8,border:draft.emoji===e?`2px solid ${draft.color}`:"1px solid #e5e7eb",background:draft.emoji===e?`${draft.color}15`:"#fff",fontSize:18,cursor:"pointer"}}>{e}</button>
            ))}
          </div>

          <FL c="Color"/>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {AGENT_COLORS.map(c=>(
              <button key={c} onClick={()=>set("color",c)} style={{width:32,height:32,borderRadius:"50%",border:draft.color===c?"3px solid #111":"1px solid #e5e7eb",background:c,cursor:"pointer"}}/>
            ))}
          </div>

          <FL c="Voz"/>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <select value={draft.voice.gender} onChange={e=>setVoice("gender",e.target.value)} style={{padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13}}>
              <option value="female">Femenina</option>
              <option value="male">Masculina</option>
              <option value="any">Cualquiera</option>
            </select>
            <label style={{fontSize:11,color:"#6b7280"}}>Velocidad</label>
            <input type="number" step="0.05" min="0.7" max="1.4" value={draft.voice.rate} onChange={e=>setVoice("rate",parseFloat(e.target.value)||1)} style={{width:70,padding:"6px 8px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13}}/>
            <label style={{fontSize:11,color:"#6b7280"}}>Tono</label>
            <input type="number" step="0.05" min="0.7" max="1.3" value={draft.voice.pitch} onChange={e=>setVoice("pitch",parseFloat(e.target.value)||1)} style={{width:70,padding:"6px 8px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13}}/>
          </div>

          <FL c="Especialidades (separadas por coma)"/>
          <FI value={(draft.specialties||[]).join(", ")} onChange={v=>set("specialties",v.split(",").map(s=>s.trim()).filter(Boolean))} placeholder="contratos, compliance, laboral"/>

          <FL c="Frase de apertura"/>
          <textarea value={draft.opener} onChange={e=>set("opener",e.target.value)} placeholder="Hola, soy María. Especializada en derecho mercantil." rows={2} style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit"}}/>

          <FL c="Estilo (descripción breve)"/>
          <FI value={draft.style} onChange={v=>set("style",v)} placeholder="prudente y preciso"/>

          <div style={{marginTop:18,padding:"12px",background:"#fafafa",border:"0.5px solid #e5e7eb",borderRadius:10}}>
            <div style={{fontSize:12,fontWeight:700,color:"#111",marginBottom:8}}>Consejos por situación</div>
            <div style={{fontSize:11,color:"#6b7280",marginBottom:10}}>El agente elegirá el consejo que mejor encaje con el estado de la tarea. Deja vacío lo que no quieras personalizar.</div>

            <FL c="Consejo general (por defecto)"/>
            <textarea value={draft.advice.default} onChange={e=>setAdvice("default",e.target.value)} rows={3} style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit"}}/>

            <FL c="Cuando está vencida"/>
            <textarea value={draft.advice.overdue} onChange={e=>setAdvice("overdue",e.target.value)} rows={2} style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit"}}/>

            <FL c="Sin fecha límite"/>
            <textarea value={draft.advice.noDueDate} onChange={e=>setAdvice("noDueDate",e.target.value)} rows={2} style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit"}}/>

            <FL c="Sin subtareas"/>
            <textarea value={draft.advice.noSubtasks} onChange={e=>setAdvice("noSubtasks",e.target.value)} rows={2} style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit"}}/>

            <FL c="Tarea sobrepasa presupuesto"/>
            <textarea value={draft.advice.overBudget} onChange={e=>setAdvice("overBudget",e.target.value)} rows={2} style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit"}}/>

            <FL c="Urgente e importante (Q1)"/>
            <textarea value={draft.advice.q1} onChange={e=>setAdvice("q1",e.target.value)} rows={2} style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit"}}/>

            <FL c="Importante no urgente (Q2)"/>
            <textarea value={draft.advice.q2} onChange={e=>setAdvice("q2",e.target.value)} rows={2} style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit"}}/>
          </div>

          <FL c="Prompt base (para futuro LLM)"/>
          <textarea value={draft.promptBase} onChange={e=>set("promptBase",e.target.value)} rows={3} placeholder="Eres una abogada mercantil experta. Analizas tareas desde el punto de vista..." style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit"}}/>
          <div style={{fontSize:10,color:"#9ca3af",marginTop:3}}>Se usará cuando conectemos el agente a un LLM real. De momento opcional.</div>
        </div>

        <div style={{padding:"12px 20px",borderTop:"0.5px solid #e5e7eb",display:"flex",gap:8,justifyContent:"space-between",background:"#fafafa"}}>
          {!isNew && onDelete && !confirmDelete && <button onClick={()=>setConfirmDelete(true)} style={{padding:"8px 14px",borderRadius:8,background:"transparent",color:"#E24B4A",border:"1px solid #E24B4A55",fontSize:13,cursor:"pointer"}}>Eliminar</button>}
          {!isNew && onDelete && confirmDelete && <div style={{display:"flex",gap:6}}>
            <button onClick={()=>onDelete(agent.id)} style={{padding:"8px 12px",borderRadius:8,background:"#E24B4A",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>Sí, eliminar</button>
            <button onClick={()=>setConfirmDelete(false)} style={{padding:"8px 12px",borderRadius:8,background:"transparent",border:"0.5px solid #d1d5db",fontSize:13,cursor:"pointer"}}>No</button>
          </div>}
          <div style={{display:"flex",gap:8,marginLeft:"auto"}}>
            <button onClick={onClose} style={{padding:"8px 14px",borderRadius:8,background:"transparent",border:"0.5px solid #d1d5db",fontSize:13,cursor:"pointer"}}>Cancelar</button>
            <button disabled={!canSave} onClick={()=>onSave(draft)} style={{padding:"8px 16px",borderRadius:8,background:canSave?draft.color:"#e5e7eb",color:"#fff",border:"none",fontSize:13,cursor:canSave?"pointer":"not-allowed",fontWeight:600}}>Guardar</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentsView({agents,onCreate,onEdit}){
  return (
    <div style={{padding:20}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
        <div>
          <div style={{fontSize:18,fontWeight:700,marginBottom:3}}>Agentes IA</div>
          <div style={{fontSize:12,color:"#6b7280"}}>Asesores especializados (abogados, marketing, comunicación…) que se conectan a tus tareas</div>
        </div>
        <button onClick={onCreate} style={{padding:"8px 14px",borderRadius:8,background:"linear-gradient(135deg,#7F77DD,#E76AA1)",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>+ Nuevo agente</button>
      </div>
      {agents.length===0 ? (
        <div style={{background:"#fff",border:"1px dashed #d1d5db",borderRadius:12,padding:"40px 20px",textAlign:"center"}}>
          <div style={{fontSize:40,marginBottom:10}}>🤖</div>
          <div style={{fontSize:15,fontWeight:600,marginBottom:5}}>Aún no tienes agentes</div>
          <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>Crea tu primer asesor especializado — abogado, marketer, analista financiero…</div>
          <button onClick={onCreate} style={{padding:"9px 18px",borderRadius:8,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>Crear primer agente</button>
        </div>
      ) : (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
          {agents.map(a=>(
            <div key={a.id} onClick={()=>onEdit(a)} style={{background:"#fff",border:"1px solid #e5e7eb",borderLeft:`4px solid ${a.color}`,borderRadius:12,padding:14,cursor:"pointer",transition:"transform .12s"}} onMouseEnter={e=>e.currentTarget.style.transform="translateY(-2px)"} onMouseLeave={e=>e.currentTarget.style.transform="translateY(0)"}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <div style={{width:42,height:42,borderRadius:10,background:`${a.color}22`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>{a.emoji}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:700,color:a.color,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.name}</div>
                  <div style={{fontSize:11,color:"#6b7280",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.role}</div>
                </div>
              </div>
              {(a.specialties||[]).length>0 && <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:6}}>
                {a.specialties.slice(0,4).map((s,i)=><span key={i} style={{fontSize:10,padding:"2px 7px",borderRadius:10,background:`${a.color}15`,color:a.color,fontWeight:500}}>{s}</span>)}
              </div>}
              {a.opener && <div style={{fontSize:12,color:"#4b5563",lineHeight:1.4,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>{a.opener}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Command Palette (⌘K) ──────────────────────────────────────────────────────
function CommandPalette({data,onClose,onNavigateTask,onNavigateWorkspace,onNavigateProject,actions}){
  const [query,setQuery]       = useState("");
  const [selectedIndex,setSI]  = useState(0);
  const inputRef               = useRef(null);
  const listRef                = useRef(null);

  useEffect(()=>{ inputRef.current?.focus(); },[]);

  const results = React.useMemo(()=>{
    const q=query.trim().toLowerCase();
    const allTasks=[];
    Object.entries(data.boards||{}).forEach(([pid,cols])=>{
      const proj=data.projects.find(p=>p.id===Number(pid));
      cols.forEach(col=>col.tasks.forEach(t=>{
        allTasks.push({...t,projId:Number(pid),projName:proj?.name||"",projEmoji:proj?.emoji||"📋",colName:col.name,colId:col.id});
      }));
    });
    if(!q){
      return {
        tasks:[],
        actions,
        workspaces:(data.workspaces||[]).slice(0,5),
        projects:[],
      };
    }
    return {
      tasks:      allTasks.filter(t=>fuzzyMatch(t.title,q)).slice(0,10),
      actions:    actions.filter(a=>fuzzyMatch(a.label,q)),
      workspaces: (data.workspaces||[]).filter(w=>fuzzyMatch(w.name,q)).slice(0,6),
      projects:   data.projects.filter(p=>fuzzyMatch(p.name,q)).slice(0,6),
    };
  },[query,data,actions]);

  // Lista plana para navegación por índice; registra el tipo de cada item.
  const flat = React.useMemo(()=>{
    const list=[];
    results.tasks     .forEach(t=>list.push({type:"task",     item:t}));
    results.actions   .forEach(a=>list.push({type:"action",   item:a}));
    results.workspaces.forEach(w=>list.push({type:"workspace",item:w}));
    results.projects  .forEach(p=>list.push({type:"project",  item:p}));
    return list;
  },[results]);

  useEffect(()=>{ setSI(0); },[query]);

  const executeAt = useCallback((idx)=>{
    const entry=flat[idx]; if(!entry) return;
    if(entry.type==="task")      onNavigateTask(entry.item);
    else if(entry.type==="workspace") onNavigateWorkspace(entry.item);
    else if(entry.type==="project")   onNavigateProject(entry.item);
    else if(entry.type==="action")    entry.item.run();
    onClose();
  },[flat,onNavigateTask,onNavigateWorkspace,onNavigateProject,onClose]);

  useEffect(()=>{
    const onKey=(e)=>{
      if(e.key==="Escape"){ e.preventDefault(); onClose(); }
      else if(e.key==="ArrowDown"){ e.preventDefault(); setSI(i=>Math.min((flat.length||1)-1,i+1)); }
      else if(e.key==="ArrowUp"){ e.preventDefault(); setSI(i=>Math.max(0,i-1)); }
      else if(e.key==="Enter"){ e.preventDefault(); executeAt(selectedIndex); }
      else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){ e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[flat,selectedIndex,executeAt,onClose]);

  useEffect(()=>{
    const el=listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`);
    if(el) el.scrollIntoView({block:"nearest"});
  },[selectedIndex]);

  const totalAll = flat.length;
  const hasAny = totalAll>0;

  const rowStyle = (idx)=>{
    const sel = idx===selectedIndex;
    return{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:8,cursor:"pointer",background:sel?"#DBEAFE":"transparent",color:sel?"#1E40AF":"#111827",transition:"background .15s ease"};
  };
  const catHeader = (label,count,first)=>(
    <div style={{fontSize:10,fontWeight:700,color:"#6B7280",textTransform:"uppercase",letterSpacing:"0.08em",padding:"10px 16px 4px",marginTop:first?0:4}}>{label} ({count})</div>
  );

  let idxCounter = 0;

  return(
    <>
      <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:9998,animation:"tf-fade-in .18s ease"}}/>
      <div style={{position:"fixed",top:"14vh",left:"50%",transform:"translateX(-50%)",width:600,maxWidth:"92vw",maxHeight:"72vh",background:"#fff",borderRadius:14,boxShadow:"0 24px 70px rgba(0,0,0,0.35)",border:"0.5px solid #e5e7eb",zIndex:9999,display:"flex",flexDirection:"column",overflow:"hidden",animation:"tf-palette-in .2s ease"}}>
        {/* Input */}
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"14px 18px",borderBottom:"1px solid #E5E7EB"}}>
          <span style={{fontSize:16,color:"#9CA3AF"}}>🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e=>setQuery(e.target.value)}
            placeholder="Buscar tareas, proyectos, acciones..."
            style={{flex:1,fontSize:17,border:"none",outline:"none",background:"transparent",fontFamily:"inherit",color:"#111827"}}
          />
          <VoiceMicButton
            size="sm"
            color="#1E40AF"
            title="Buscar por voz"
            initialText={query}
            onInterim={t=>setQuery(t)}
            onFinal={t=>{ setQuery(t); inputRef.current?.focus(); }}
          />
          <span style={{fontSize:10,color:"#9CA3AF",border:"0.5px solid #E5E7EB",borderRadius:5,padding:"2px 6px",fontWeight:600}}>Esc</span>
        </div>

        {/* Results */}
        <div ref={listRef} style={{flex:1,overflowY:"auto",padding:"4px 8px 8px"}}>
          {!hasAny&&(
            <div style={{padding:"30px 20px",textAlign:"center"}}>
              {query.trim()
                ? <><div style={{fontSize:13,color:"#6B7280",marginBottom:4}}>No se encontraron resultados para "<b>{query.trim()}</b>"</div><div style={{fontSize:11,color:"#9CA3AF"}}>Intenta con otros términos</div></>
                : <div style={{fontSize:13,color:"#9CA3AF"}}>Empieza a escribir para buscar</div>}
            </div>
          )}

          {results.tasks.length>0&&<>
            {catHeader("Tareas",results.tasks.length,true)}
            {results.tasks.map((t,i)=>{ const idx=idxCounter++; return(
              <div key={`t-${t.id}-${t.projId}-${i}`} data-idx={idx} onClick={()=>executeAt(idx)} onMouseEnter={()=>setSI(idx)} style={rowStyle(idx)}>
                <span style={{fontSize:15,flexShrink:0}}>📌</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}><HighlightedText text={t.title} query={query.trim()}/></div>
                  <div style={{fontSize:11,color:idx===selectedIndex?"#1E40AF":"#6B7280",opacity:0.85}}>{t.projEmoji} {t.projName} · {t.colName}</div>
                </div>
              </div>
            );})}
          </>}

          {results.actions.length>0&&<>
            {catHeader("Acciones",results.actions.length,results.tasks.length===0)}
            {results.actions.map((a,i)=>{ const idx=idxCounter++; return(
              <div key={`a-${a.id}`} data-idx={idx} onClick={()=>executeAt(idx)} onMouseEnter={()=>setSI(idx)} style={rowStyle(idx)}>
                <span style={{fontSize:15,flexShrink:0}}>{a.icon}</span>
                <div style={{flex:1,minWidth:0,fontSize:13,fontWeight:500}}><HighlightedText text={a.label} query={query.trim()}/></div>
                {a.shortcut&&<span style={{fontSize:10,color:idx===selectedIndex?"#1E40AF":"#9CA3AF",border:"0.5px solid #E5E7EB",borderRadius:5,padding:"2px 6px",fontWeight:600}}>{a.shortcut}</span>}
              </div>
            );})}
          </>}

          {results.workspaces.length>0&&<>
            {catHeader("Workspaces",results.workspaces.length,results.tasks.length===0&&results.actions.length===0)}
            {results.workspaces.map(w=>{ const idx=idxCounter++; const wsProjects=data.projects.filter(p=>p.workspaceId===w.id); const total=wsProjects.reduce((s,p)=>s+((data.boards[p.id]||[]).reduce((ss,c)=>ss+c.tasks.length,0)),0); const done=wsProjects.reduce((s,p)=>s+((data.boards[p.id]||[]).filter(c=>c.name==="Hecho").reduce((ss,c)=>ss+c.tasks.length,0)),0); return(
              <div key={`w-${w.id}`} data-idx={idx} onClick={()=>executeAt(idx)} onMouseEnter={()=>setSI(idx)} style={rowStyle(idx)}>
                <span style={{fontSize:15,flexShrink:0}}>{w.emoji||"🏢"}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}><HighlightedText text={w.name} query={query.trim()}/></div>
                  <div style={{fontSize:11,color:idx===selectedIndex?"#1E40AF":"#6B7280",opacity:0.85}}>{wsProjects.length} proyecto{wsProjects.length!==1?"s":""} · {done}/{total} completadas</div>
                </div>
              </div>
            );})}
          </>}

          {results.projects.length>0&&<>
            {catHeader("Proyectos",results.projects.length,results.tasks.length===0&&results.actions.length===0&&results.workspaces.length===0)}
            {results.projects.map(p=>{ const idx=idxCounter++; const cols=data.boards[p.id]||[]; const total=cols.reduce((s,c)=>s+c.tasks.length,0); const ws=(data.workspaces||[]).find(w=>w.id===p.workspaceId); return(
              <div key={`p-${p.id}`} data-idx={idx} onClick={()=>executeAt(idx)} onMouseEnter={()=>setSI(idx)} style={rowStyle(idx)}>
                <span style={{fontSize:15,flexShrink:0}}>{p.emoji||"📋"}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}><HighlightedText text={p.name} query={query.trim()}/></div>
                  <div style={{fontSize:11,color:idx===selectedIndex?"#1E40AF":"#6B7280",opacity:0.85}}>{ws?`${ws.emoji||"🏢"} ${ws.name} · `:""}{total} tarea{total!==1?"s":""}</div>
                </div>
              </div>
            );})}
          </>}
        </div>

        {/* Footer */}
        <div style={{padding:"10px 16px",borderTop:"1px solid #E5E7EB",background:"#F9FAFB",fontSize:11,color:"#9CA3AF",display:"flex",gap:12,flexWrap:"wrap"}}>
          <span><b style={{color:"#6B7280"}}>↑↓</b> Navegar</span>
          <span><b style={{color:"#6B7280"}}>Enter</b> Seleccionar</span>
          <span><b style={{color:"#6B7280"}}>Esc</b> Cerrar</span>
        </div>
      </div>
    </>
  );
}

// ── Deal Room (negociaciones con sesiones, notas y resumen) ──────────────────
const NEG_STATUSES = [
  { id:"en_curso",        label:"En curso",         color:"#10B981" },
  { id:"pausado",         label:"Pausado",          color:"#F59E0B" },
  { id:"cerrado_ganado",  label:"Cerrado ganado",   color:"#3B82F6" },
  { id:"cerrado_perdido", label:"Cerrado perdido",  color:"#E24B4A" },
];
const SESSION_TYPES = [
  { id:"meeting",  label:"Reunión presencial", icon:"🤝" },
  { id:"call",     label:"Llamada",            icon:"📞" },
  { id:"informal", label:"Conversación informal", icon:"💬" },
];
const getNegStatus     = s => NEG_STATUSES.find(x=>x.id===s)||NEG_STATUSES[0];
const getSessionTypeLabel = t => SESSION_TYPES.find(x=>x.id===t)?.label||t;
const getSessionTypeIcon  = t => SESSION_TYPES.find(x=>x.id===t)?.icon||"📅";
const REL_TYPES = [
  { id:"blocks",      label:"Bloquea a",      icon:"🔒", color:"#B91C1C" },
  { id:"depends_on",  label:"Depende de",     icon:"⏳", color:"#EF4444" },
  { id:"influences",  label:"Influye en",     icon:"🔗", color:"#2563EB" },
  { id:"parallel",    label:"Paralela a",     icon:"📍", color:"#6B7280" },
];
const getRelType = t => REL_TYPES.find(x=>x.id===t)||REL_TYPES[2];
const STK_ROLES = [
  { id:"landlord",   label:"Propietario" },
  { id:"investor",   label:"Inversor"    },
  { id:"vendor",     label:"Proveedor"   },
  { id:"contractor", label:"Contratista" },
  { id:"partner",    label:"Socio"       },
  { id:"other",      label:"Otro"        },
];
const STK_INFLUENCE = [
  { id:"decision_maker", label:"Toma decisiones" },
  { id:"influencer",     label:"Influenciador"   },
  { id:"blocker",        label:"Bloqueador"      },
  { id:"facilitator",    label:"Facilitador"     },
];
const getStkRole      = r => STK_ROLES.find(x=>x.id===r)?.label||r;
const getStkInfluence = i => STK_INFLUENCE.find(x=>x.id===i)?.label||i;
const PROJ_PRIORITY = {
  critical: { bg:"#FEE2E2", border:"#FCA5A5", text:"#991B1B", label:"Crítica" },
  high:     { bg:"#FEF3C7", border:"#FCD34D", text:"#92400E", label:"Alta" },
  medium:   { bg:"#DBEAFE", border:"#93C5FD", text:"#1E40AF", label:"Media" },
  low:      { bg:"#F3F4F6", border:"#D1D5DB", text:"#6B7280", label:"Baja" },
};
function formatDateTimeES(iso){
  if(!iso) return "";
  try{ return new Date(iso).toLocaleDateString("es-ES",{weekday:"long",day:"numeric",month:"long",year:"numeric",hour:"2-digit",minute:"2-digit"}); }
  catch{ return iso; }
}
function timeAgoIso(iso){
  if(!iso) return "";
  const s=Math.floor((new Date()-new Date(iso))/1000);
  if(s<60) return "hace un momento";
  if(s<3600) return `hace ${Math.floor(s/60)} min`;
  if(s<86400) return `hace ${Math.floor(s/3600)}h`;
  if(s<604800) return `hace ${Math.floor(s/86400)}d`;
  if(s<2592000) return `hace ${Math.floor(s/604800)} sem`;
  const m=Math.floor(s/2592000);
  return `hace ${m} mes${m>1?"es":""}`;
}

// Modal crear/editar negociación.
function NegotiationModal({negotiation,members,workspaces,projects,agents,allNegotiations,onClose,onSave,onDelete}){
  const isEdit=!!negotiation;
  const [title,setTitle]       = useState(negotiation?.title||"");
  const [counterparty,setCP]   = useState(negotiation?.counterparty||"");
  const [status,setStatus]     = useState(negotiation?.status||"en_curso");
  const [value,setValue]       = useState(negotiation?.value??"");
  const [currency,setCurrency] = useState(negotiation?.currency||"EUR");
  const [description,setDesc]  = useState(negotiation?.description||"");
  const [ownerId,setOwnerId]   = useState(negotiation?.ownerId??(members[0]?.id??0));
  // Multi-proyecto (FASE 1.5)
  const [relatedProjects,setRelatedProjects] = useState(negotiation?.relatedProjects||[]);
  const [relationships,setRelationships]     = useState(negotiation?.relationships||[]);
  const [stakeholders,setStakeholders]       = useState(negotiation?.stakeholders||[]);
  const [agentId,setAgentId] = useState(negotiation?.agentId??"");
  const [pendingDel,setPendingDel] = useState(false);
  const [pendingClose,setPendingClose] = useState(false);
  const [initialSnap]=useState(()=>JSON.stringify({title:negotiation?.title||"",counterparty:negotiation?.counterparty||"",status:negotiation?.status||"en_curso",value:negotiation?.value??"",currency:negotiation?.currency||"EUR",description:negotiation?.description||"",ownerId:negotiation?.ownerId??(members[0]?.id??0),relatedProjects:negotiation?.relatedProjects||[],relationships:negotiation?.relationships||[],stakeholders:negotiation?.stakeholders||[],agentId:negotiation?.agentId??""}));
  const isDirty=JSON.stringify({title,counterparty,status,value,currency,description,ownerId,relatedProjects,relationships,stakeholders,agentId})!==initialSnap;
  const handleClose=()=>{ if(isDirty) setPendingClose(true); else onClose(); };
  useEffect(()=>{ const k=e=>{if(e.key==="Escape") handleClose();}; window.addEventListener("keydown",k); return()=>window.removeEventListener("keydown",k); },[isDirty]);
  const save=()=>{
    if(!title.trim()||!counterparty.trim()) return;
    const primaryProjectId = relatedProjects[0]?.projectId ?? null;
    onSave({title:title.trim(),counterparty:counterparty.trim(),status,value:value===""?null:Number(value),currency,description:description.trim(),ownerId:Number(ownerId),projectId:primaryProjectId,agentId:agentId===""?null:Number(agentId),relatedProjects,relationships,stakeholders});
    onClose();
  };

  // Helpers UI multi-proyecto
  const [addProjOpen,setAddProjOpen] = useState(false);
  const [addProjSel,setAddProjSel]   = useState("");
  const [addProjRole,setAddProjRole] = useState("relacionado");
  const [addProjPri,setAddProjPri]   = useState("high");
  const addProject = ()=>{
    if(addProjSel===""){ return; }
    const pid = Number(addProjSel);
    if(relatedProjects.some(rp=>rp.projectId===pid)) return;
    setRelatedProjects([...relatedProjects,{projectId:pid,role:addProjRole.trim()||"relacionado",priority:addProjPri}]);
    setAddProjSel(""); setAddProjRole("relacionado"); setAddProjPri("high"); setAddProjOpen(false);
  };
  const removeProject = (pid)=>setRelatedProjects(relatedProjects.filter(rp=>rp.projectId!==pid));

  // Helpers UI relaciones
  const [addRelOpen,setAddRelOpen] = useState(false);
  const [addRelTarget,setAddRelTarget] = useState("");
  const [addRelType,setAddRelType] = useState("influences");
  const [addRelDesc,setAddRelDesc] = useState("");
  const [addRelCritical,setAddRelCritical] = useState(false);
  const availableNegs = (allNegotiations||[]).filter(n=>n.id!==negotiation?.id && !relationships.some(r=>r.negotiationId===n.id));
  const addRelation = ()=>{
    if(!addRelTarget) return;
    setRelationships([...relationships,{id:_uid("rel"),negotiationId:addRelTarget,type:addRelType,description:addRelDesc.trim(),critical:addRelCritical,createdAt:new Date().toISOString()}]);
    setAddRelTarget(""); setAddRelDesc(""); setAddRelCritical(false); setAddRelType("influences"); setAddRelOpen(false);
  };
  const removeRelation = (rid)=>setRelationships(relationships.filter(r=>r.id!==rid));

  // Helpers UI stakeholders
  const [addStkOpen,setAddStkOpen]  = useState(false);
  const [stkName,setStkName]        = useState("");
  const [stkCompany,setStkCompany]  = useState("");
  const [stkEmail,setStkEmail]      = useState("");
  const [stkPhone,setStkPhone]      = useState("");
  const [stkRole,setStkRole]        = useState("other");
  const [stkInfl,setStkInfl]        = useState("influencer");
  const [stkNotes,setStkNotes]      = useState("");
  const addStakeholder = ()=>{
    if(!stkName.trim()) return;
    setStakeholders([...stakeholders,{id:_uid("stk"),name:stkName.trim(),company:stkCompany.trim(),email:stkEmail.trim(),phone:stkPhone.trim(),role:stkRole,influence:stkInfl,notes:stkNotes.trim()}]);
    setStkName(""); setStkCompany(""); setStkEmail(""); setStkPhone(""); setStkRole("other"); setStkInfl("influencer"); setStkNotes(""); setAddStkOpen(false);
  };
  const removeStakeholder = (sid)=>setStakeholders(stakeholders.filter(s=>s.id!==sid));
  return(
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&handleClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:3000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:40,overflowY:"auto"}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:560,maxWidth:"96vw",border:"0.5px solid #e5e7eb",borderTop:"4px solid #3B82F6",marginBottom:24}}>
        <div style={{padding:"14px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontWeight:600,fontSize:15}}>{isEdit?"Editar negociación":"Nueva negociación"}</div>
          <button onClick={handleClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#6b7280"}}>x</button>
        </div>
        {pendingClose&&<DiscardBanner onKeep={()=>setPendingClose(false)} onDiscard={()=>{setPendingClose(false);onClose();}}/>}
        <div style={{padding:20}}>
          <FL c="Título *"/><FI value={title} onChange={setTitle} placeholder="Ej: Venta local Calle Mayor 23"/>
          <FL c="Contraparte *"/><FI value={counterparty} onChange={setCP} placeholder="Ej: Inversores Madrid SL"/>
          <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:10}}>
            <div><FL c="Valor (opcional)"/><FI type="number" value={value} onChange={setValue} placeholder="250000"/></div>
            <div><FL c="Moneda"/>
              <select value={currency} onChange={e=>setCurrency(e.target.value)} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit",background:"#fff"}}>
                <option value="EUR">EUR</option><option value="USD">USD</option><option value="GBP">GBP</option>
              </select>
            </div>
          </div>
          <FL c="Estado"/>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {NEG_STATUSES.map(s=>(
              <button key={s.id} onClick={()=>setStatus(s.id)} style={{padding:"6px 12px",borderRadius:8,border:`1.5px solid ${status===s.id?s.color:"#e5e7eb"}`,background:status===s.id?s.color+"18":"#fff",color:status===s.id?s.color:"#6b7280",fontSize:12,cursor:"pointer",fontWeight:status===s.id?600:400}}>{s.label}</button>
            ))}
          </div>
          <FL c="Responsable"/>
          <select value={ownerId} onChange={e=>setOwnerId(e.target.value)} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit",background:"#fff"}}>
            {members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <FL c="Descripción"/>
          <textarea value={description} onChange={e=>setDesc(e.target.value)} rows={3} placeholder="Contexto, objetivo, contraparte, plazos…" style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit"}}/>

          {/* Proyectos relacionados (múltiple) */}
          <div style={{marginTop:18,paddingTop:14,borderTop:"1px solid #E5E7EB"}}>
            <div style={{fontSize:13,fontWeight:600,color:"#111827",marginBottom:4}}>📊 Proyectos relacionados ({relatedProjects.length})</div>
            <div style={{fontSize:11,color:"#6B7280",marginBottom:8}}>Una negociación puede afectar a varios proyectos (legal, obra, financiación…). El primero se considera principal.</div>
            {relatedProjects.map(rp=>{ const p=projects.find(x=>x.id===rp.projectId); const ws=workspaces.find(w=>w.id===p?.workspaceId); const pri=PROJ_PRIORITY[rp.priority]||PROJ_PRIORITY.high; return(
              <div key={rp.projectId} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:8,marginBottom:6}}>
                <span style={{fontSize:16}}>{p?.emoji||"📋"}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,color:"#111827",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ws?`${ws.emoji} ${ws.name} / `:""}{p?.name||"(proyecto borrado)"}</div>
                  <div style={{fontSize:11,color:"#6B7280"}}>Rol: {rp.role}</div>
                </div>
                <span style={{fontSize:10,fontWeight:600,padding:"3px 8px",borderRadius:10,background:pri.bg,border:`1px solid ${pri.border}`,color:pri.text}}>{pri.label}</span>
                <button onClick={()=>removeProject(rp.projectId)} style={{padding:"5px 8px",borderRadius:6,border:"1px solid #e5e7eb",background:"#fff",fontSize:12,color:"#6b7280",cursor:"pointer"}}>✕</button>
              </div>
            );})}
            {!addProjOpen
              ? <button onClick={()=>setAddProjOpen(true)} style={{padding:"7px 12px",borderRadius:8,background:"#fff",color:"#3B82F6",border:"1px dashed #3B82F6",fontSize:12,cursor:"pointer",fontWeight:500}}>+ Añadir proyecto</button>
              : <div style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:10,padding:12}}>
                  <FL c="Proyecto"/>
                  <select value={addProjSel} onChange={e=>setAddProjSel(e.target.value)} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit",background:"#fff"}}>
                    <option value="">— Seleccionar —</option>
                    {projects.filter(p=>!relatedProjects.some(rp=>rp.projectId===p.id)).map(p=>{ const ws=workspaces.find(w=>w.id===p.workspaceId); return <option key={p.id} value={p.id}>{ws?`${ws.name} / `:""}{p.name}</option>; })}
                  </select>
                  <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:8,marginTop:6}}>
                    <div><FL c="Rol"/><FI value={addProjRole} onChange={setAddProjRole} placeholder="contrato, especificaciones…"/></div>
                    <div><FL c="Prioridad"/>
                      <select value={addProjPri} onChange={e=>setAddProjPri(e.target.value)} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit",background:"#fff"}}>
                        {Object.entries(PROJ_PRIORITY).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:6,marginTop:8,justifyContent:"flex-end"}}>
                    <button onClick={()=>{setAddProjOpen(false);setAddProjSel("");setAddProjRole("relacionado");setAddProjPri("high");}} style={{padding:"6px 12px",borderRadius:7,background:"transparent",border:"0.5px solid #d1d5db",fontSize:12,cursor:"pointer"}}>Cancelar</button>
                    <button onClick={addProject} disabled={!addProjSel} style={{padding:"6px 12px",borderRadius:7,background:addProjSel?"#3B82F6":"#e5e7eb",color:addProjSel?"#fff":"#9ca3af",border:"none",fontSize:12,cursor:addProjSel?"pointer":"default",fontWeight:600}}>Añadir</button>
                  </div>
                </div>}
          </div>

          {/* Relaciones entre negociaciones */}
          <div style={{marginTop:18,paddingTop:14,borderTop:"1px solid #E5E7EB"}}>
            <div style={{fontSize:13,fontWeight:600,color:"#111827",marginBottom:4}}>🔗 Relaciones con otras negociaciones ({relationships.length})</div>
            <div style={{fontSize:11,color:"#6B7280",marginBottom:8}}>Bloquea, depende, influye o corre en paralelo — visible en el Deal Room con badges.</div>
            {relationships.map(r=>{ const target=(allNegotiations||[]).find(n=>n.id===r.negotiationId); const rt=getRelType(r.type); return(
              <div key={r.id} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"10px 12px",background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:8,marginBottom:6}}>
                <span style={{fontSize:15,flexShrink:0}}>{rt.icon}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12.5,fontWeight:600,color:rt.color}}>{rt.label}: <span style={{color:"#111827"}}>{target?.title||"(negociación borrada)"}</span>{r.critical&&<span style={{marginLeft:6,fontSize:10,padding:"1px 6px",background:"#FEE2E2",color:"#B91C1C",borderRadius:10}}>Crítica</span>}</div>
                  {r.description&&<div style={{fontSize:11,color:"#6B7280",fontStyle:"italic",marginTop:3}}>{r.description}</div>}
                </div>
                <button onClick={()=>removeRelation(r.id)} style={{padding:"5px 8px",borderRadius:6,border:"1px solid #e5e7eb",background:"#fff",fontSize:12,color:"#6b7280",cursor:"pointer"}}>✕</button>
              </div>
            );})}
            {!addRelOpen
              ? <button onClick={()=>setAddRelOpen(true)} disabled={availableNegs.length===0} style={{padding:"7px 12px",borderRadius:8,background:"#fff",color:availableNegs.length===0?"#9CA3AF":"#3B82F6",border:`1px dashed ${availableNegs.length===0?"#e5e7eb":"#3B82F6"}`,fontSize:12,cursor:availableNegs.length===0?"not-allowed":"pointer",fontWeight:500}}>+ Añadir relación {availableNegs.length===0&&"(sin otras negociaciones)"}</button>
              : <div style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:10,padding:12}}>
                  <FL c="Tipo de relación"/>
                  <select value={addRelType} onChange={e=>setAddRelType(e.target.value)} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit",background:"#fff"}}>
                    {REL_TYPES.map(t=><option key={t.id} value={t.id}>{t.icon} {t.label}…</option>)}
                  </select>
                  <FL c="Negociación relacionada"/>
                  <select value={addRelTarget} onChange={e=>setAddRelTarget(e.target.value)} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit",background:"#fff"}}>
                    <option value="">— Seleccionar —</option>
                    {availableNegs.map(n=><option key={n.id} value={n.id}>{n.title}</option>)}
                  </select>
                  <FL c="Descripción"/>
                  <textarea value={addRelDesc} onChange={e=>setAddRelDesc(e.target.value)} rows={2} placeholder="Ej: Necesitamos local firmado antes de comprar cámaras" style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:12.5,resize:"vertical",fontFamily:"inherit"}}/>
                  <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,marginTop:8,cursor:"pointer"}}>
                    <input type="checkbox" checked={addRelCritical} onChange={e=>setAddRelCritical(e.target.checked)}/>
                    <span>Relación crítica (bloquea progreso)</span>
                  </label>
                  <div style={{display:"flex",gap:6,marginTop:10,justifyContent:"flex-end"}}>
                    <button onClick={()=>{setAddRelOpen(false);setAddRelTarget("");setAddRelDesc("");setAddRelCritical(false);}} style={{padding:"6px 12px",borderRadius:7,background:"transparent",border:"0.5px solid #d1d5db",fontSize:12,cursor:"pointer"}}>Cancelar</button>
                    <button onClick={addRelation} disabled={!addRelTarget} style={{padding:"6px 12px",borderRadius:7,background:addRelTarget?"#3B82F6":"#e5e7eb",color:addRelTarget?"#fff":"#9ca3af",border:"none",fontSize:12,cursor:addRelTarget?"pointer":"default",fontWeight:600}}>Añadir</button>
                  </div>
                </div>}
          </div>

          {/* Stakeholders */}
          <div style={{marginTop:18,paddingTop:14,borderTop:"1px solid #E5E7EB"}}>
            <div style={{fontSize:13,fontWeight:600,color:"#111827",marginBottom:4}}>👥 Stakeholders ({stakeholders.length})</div>
            <div style={{fontSize:11,color:"#6B7280",marginBottom:8}}>Personas clave externas al equipo: propietarios, inversores, proveedores…</div>
            {stakeholders.map(s=>(
              <div key={s.id} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 12px",background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:8,marginBottom:6}}>
                <span style={{fontSize:16,flexShrink:0}}>👤</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,color:"#111827"}}>{s.name}{s.company&&<span style={{fontWeight:400,color:"#6B7280"}}> · {s.company}</span>}</div>
                  <div style={{fontSize:11,color:"#6B7280",marginTop:2}}>{getStkRole(s.role)} · <b>{getStkInfluence(s.influence)}</b>{s.email&&` · ${s.email}`}{s.phone&&` · ${s.phone}`}</div>
                  {s.notes&&<div style={{fontSize:11,color:"#4B5563",fontStyle:"italic",marginTop:4}}>{s.notes}</div>}
                </div>
                <button onClick={()=>removeStakeholder(s.id)} style={{padding:"5px 8px",borderRadius:6,border:"1px solid #e5e7eb",background:"#fff",fontSize:12,color:"#6b7280",cursor:"pointer"}}>✕</button>
              </div>
            ))}
            {!addStkOpen
              ? <button onClick={()=>setAddStkOpen(true)} style={{padding:"7px 12px",borderRadius:8,background:"#fff",color:"#3B82F6",border:"1px dashed #3B82F6",fontSize:12,cursor:"pointer",fontWeight:500}}>+ Añadir stakeholder</button>
              : <div style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:10,padding:12}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div><FL c="Nombre *"/><FI value={stkName} onChange={setStkName} placeholder="Juan García"/></div>
                    <div><FL c="Empresa"/><FI value={stkCompany} onChange={setStkCompany} placeholder="Inmobiliaria XYZ"/></div>
                    <div><FL c="Email"/><FI value={stkEmail} onChange={setStkEmail} placeholder="juan@ejemplo.com"/></div>
                    <div><FL c="Teléfono"/><FI value={stkPhone} onChange={setStkPhone} placeholder="+34 600…"/></div>
                    <div><FL c="Rol"/>
                      <select value={stkRole} onChange={e=>setStkRole(e.target.value)} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit",background:"#fff"}}>
                        {STK_ROLES.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}
                      </select>
                    </div>
                    <div><FL c="Influencia"/>
                      <select value={stkInfl} onChange={e=>setStkInfl(e.target.value)} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit",background:"#fff"}}>
                        {STK_INFLUENCE.map(i=><option key={i.id} value={i.id}>{i.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <FL c="Notas"/>
                  <textarea value={stkNotes} onChange={e=>setStkNotes(e.target.value)} rows={2} placeholder="Contexto importante sobre esta persona…" style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:12.5,resize:"vertical",fontFamily:"inherit"}}/>
                  <div style={{display:"flex",gap:6,marginTop:10,justifyContent:"flex-end"}}>
                    <button onClick={()=>{setAddStkOpen(false);setStkName("");setStkCompany("");setStkEmail("");setStkPhone("");setStkNotes("");}} style={{padding:"6px 12px",borderRadius:7,background:"transparent",border:"0.5px solid #d1d5db",fontSize:12,cursor:"pointer"}}>Cancelar</button>
                    <button onClick={addStakeholder} disabled={!stkName.trim()} style={{padding:"6px 12px",borderRadius:7,background:stkName.trim()?"#3B82F6":"#e5e7eb",color:stkName.trim()?"#fff":"#9ca3af",border:"none",fontSize:12,cursor:stkName.trim()?"pointer":"default",fontWeight:600}}>Añadir</button>
                  </div>
                </div>}
          </div>

          {/* Agente IA */}
          <div style={{marginTop:18,paddingTop:14,borderTop:"1px solid #E5E7EB"}}>
            <div style={{fontSize:13,fontWeight:600,color:"#111827",marginBottom:4}}>🤖 Agente IA asignado</div>
            <select value={agentId} onChange={e=>setAgentId(e.target.value)} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit",background:"#fff"}}>
              <option value="">— Ninguno —</option>
              {agents.map(a=><option key={a.id} value={a.id}>{a.emoji||"🤖"} {a.name} — {a.role}</option>)}
            </select>
            <div style={{fontSize:11,color:"#9CA3AF",marginTop:3}}>El agente recibirá contexto completo en briefings y consejos</div>
          </div>

          <div style={{display:"flex",gap:8,marginTop:20,justifyContent:"space-between",alignItems:"center"}}>
            <div>
              {isEdit&&onDelete&&(!pendingDel
                ? <button onClick={()=>setPendingDel(true)} style={{padding:"8px 14px",borderRadius:8,background:"transparent",color:"#E24B4A",border:"1px solid #E24B4A55",fontSize:12,cursor:"pointer"}}>Eliminar</button>
                : <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>{onDelete(negotiation.id);onClose();}} style={{padding:"8px 12px",borderRadius:8,background:"#E24B4A",color:"#fff",border:"none",fontSize:12,cursor:"pointer",fontWeight:600}}>Confirmar</button>
                    <button onClick={()=>setPendingDel(false)} style={{padding:"8px 12px",borderRadius:8,background:"transparent",border:"0.5px solid #d1d5db",fontSize:12,cursor:"pointer"}}>No</button>
                  </div>)}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={onClose} style={{padding:"8px 16px",borderRadius:8,border:"0.5px solid #d1d5db",background:"transparent",fontSize:13,cursor:"pointer"}}>Cancelar</button>
              <button onClick={save} disabled={!title.trim()||!counterparty.trim()} style={{padding:"8px 20px",borderRadius:8,background:(title.trim()&&counterparty.trim())?"#3B82F6":"#e5e7eb",color:(title.trim()&&counterparty.trim())?"#fff":"#9ca3af",border:"none",fontSize:13,cursor:(title.trim()&&counterparty.trim())?"pointer":"default",fontWeight:600}}>{isEdit?"Guardar":"Crear"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Modal crear/editar sesión.
function SessionModal({session,onClose,onSave,onDelete}){
  const isEdit=!!session;
  const [type,setType]         = useState(session?.type||"meeting");
  const [date,setDate]         = useState(session?.date?.slice(0,16)||new Date().toISOString().slice(0,16));
  const [location,setLocation] = useState(session?.location||"");
  const [duration,setDuration] = useState(session?.duration||60);
  const [pendingDel,setPendingDel] = useState(false);
  const [pendingClose,setPendingClose] = useState(false);
  const [initialSnap]=useState(()=>JSON.stringify({type:session?.type||"meeting",date:session?.date?.slice(0,16)||"",location:session?.location||"",duration:session?.duration||60}));
  const isDirty=JSON.stringify({type,date,location,duration})!==initialSnap;
  const handleClose=()=>{ if(isDirty) setPendingClose(true); else onClose(); };
  useEffect(()=>{ const k=e=>{if(e.key==="Escape") handleClose();}; window.addEventListener("keydown",k); return()=>window.removeEventListener("keydown",k); },[isDirty]);
  const save=()=>{ onSave({type,date:new Date(date).toISOString(),location:location.trim(),duration:Number(duration)||0}); onClose(); };
  return(
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&handleClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:3000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:40,overflowY:"auto"}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:520,maxWidth:"96vw",border:"0.5px solid #e5e7eb",borderTop:"4px solid #3B82F6",marginBottom:24}}>
        <div style={{padding:"14px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontWeight:600,fontSize:15}}>{isEdit?"Editar sesión":"Nueva sesión"}</div>
          <button onClick={handleClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#6b7280"}}>x</button>
        </div>
        {pendingClose&&<DiscardBanner onKeep={()=>setPendingClose(false)} onDiscard={()=>{setPendingClose(false);onClose();}}/>}
        <div style={{padding:20}}>
          <FL c="Tipo"/>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {SESSION_TYPES.map(s=>(
              <button key={s.id} onClick={()=>setType(s.id)} style={{padding:"7px 12px",borderRadius:8,border:`1.5px solid ${type===s.id?"#3B82F6":"#e5e7eb"}`,background:type===s.id?"#EFF6FF":"#fff",color:type===s.id?"#1E40AF":"#6b7280",fontSize:12,cursor:"pointer",fontWeight:type===s.id?600:400}}>{s.icon} {s.label}</button>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:10}}>
            <div><FL c="Fecha y hora"/>
              <input type="datetime-local" value={date} onChange={e=>setDate(e.target.value)} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit"}}/></div>
            <div><FL c="Duración (min)"/>
              <input type="number" min={0} value={duration} onChange={e=>setDuration(e.target.value)} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit"}}/></div>
          </div>
          <FL c="Ubicación (opcional)"/>
          <FI value={location} onChange={setLocation} placeholder="Ej: Oficina Paseo de Gracia · Zoom · Café Central"/>
          <div style={{display:"flex",gap:8,marginTop:20,justifyContent:"space-between"}}>
            <div>
              {isEdit&&onDelete&&(!pendingDel
                ? <button onClick={()=>setPendingDel(true)} style={{padding:"8px 14px",borderRadius:8,background:"transparent",color:"#E24B4A",border:"1px solid #E24B4A55",fontSize:12,cursor:"pointer"}}>Eliminar</button>
                : <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>{onDelete(session.id);onClose();}} style={{padding:"8px 12px",borderRadius:8,background:"#E24B4A",color:"#fff",border:"none",fontSize:12,cursor:"pointer",fontWeight:600}}>Confirmar</button>
                    <button onClick={()=>setPendingDel(false)} style={{padding:"8px 12px",borderRadius:8,background:"transparent",border:"0.5px solid #d1d5db",fontSize:12,cursor:"pointer"}}>No</button>
                  </div>)}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={onClose} style={{padding:"8px 16px",borderRadius:8,border:"0.5px solid #d1d5db",background:"transparent",fontSize:13,cursor:"pointer"}}>Cancelar</button>
              <button onClick={save} style={{padding:"8px 20px",borderRadius:8,background:"#3B82F6",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>{isEdit?"Guardar":"Crear"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Modal añadir nota.
function AddNoteModal({initialNote,onClose,onSave,onDelete}){
  const isEdit=!!initialNote;
  const [timestamp,setTs] = useState(initialNote?.timestamp||new Date().toTimeString().slice(0,5));
  const [content,setContent] = useState(initialNote?.content||"");
  const [pendingClose,setPendingClose] = useState(false);
  const [initialSnap]=useState(()=>JSON.stringify({timestamp:initialNote?.timestamp||"",content:initialNote?.content||""}));
  const isDirty=JSON.stringify({timestamp,content})!==initialSnap;
  const handleClose=()=>{ if(isDirty) setPendingClose(true); else onClose(); };
  useEffect(()=>{ const k=e=>{if(e.key==="Escape") handleClose();}; window.addEventListener("keydown",k); return()=>window.removeEventListener("keydown",k); },[isDirty]);
  const save=()=>{ if(!content.trim()) return; onSave({timestamp,content:content.trim()}); onClose(); };
  return(
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&handleClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:3000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:60,overflowY:"auto"}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:480,maxWidth:"96vw",border:"0.5px solid #e5e7eb",borderTop:"4px solid #3B82F6",marginBottom:24}}>
        <div style={{padding:"14px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontWeight:600,fontSize:15}}>{isEdit?"Editar nota":"Nueva nota"}</div>
          <button onClick={handleClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#6b7280"}}>x</button>
        </div>
        {pendingClose&&<DiscardBanner onKeep={()=>setPendingClose(false)} onDiscard={()=>{setPendingClose(false);onClose();}}/>}
        <div style={{padding:20}}>
          <FL c="Hora (HH:MM)"/>
          <input type="time" value={timestamp} onChange={e=>setTs(e.target.value)} style={{width:140,padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit"}}/>
          <FL c="Nota *"/>
          <div style={{position:"relative"}}>
            <textarea autoFocus value={content} onChange={e=>setContent(e.target.value)} rows={6} placeholder="Ej: Emilio mencionó que el timeline es muy ajustado…" style={{width:"100%",padding:"8px 38px 8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit"}}/>
            <div style={{position:"absolute",right:6,top:6}}>
              <VoiceMicButton size="sm" color="#3B82F6" title="Dictar nota" initialText={content} onInterim={t=>setContent(t)} onFinal={t=>setContent(t)}/>
            </div>
          </div>
          <div style={{display:"flex",gap:8,marginTop:16,justifyContent:"space-between",alignItems:"center"}}>
            <div>
              {isEdit&&onDelete&&<button onClick={()=>{onDelete(initialNote.id);onClose();}} style={{padding:"8px 14px",borderRadius:8,background:"transparent",color:"#E24B4A",border:"1px solid #E24B4A55",fontSize:12,cursor:"pointer"}}>Eliminar</button>}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={onClose} style={{padding:"8px 16px",borderRadius:8,border:"0.5px solid #d1d5db",background:"transparent",fontSize:13,cursor:"pointer"}}>Cancelar</button>
              <button onClick={save} disabled={!content.trim()} style={{padding:"8px 20px",borderRadius:8,background:content.trim()?"#3B82F6":"#e5e7eb",color:content.trim()?"#fff":"#9ca3af",border:"none",fontSize:13,cursor:content.trim()?"pointer":"default",fontWeight:600}}>Guardar</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Vista principal: lista de negociaciones con filtros.
function DealRoomView({negotiations,members,projects,workspaces,filter,onSetFilter,onCreate,onOpen,onEdit}){
  const filtered = filter==="all" ? negotiations : negotiations.filter(n=>n.status===filter);
  const counts = NEG_STATUSES.reduce((o,s)=>{o[s.id]=negotiations.filter(n=>n.status===s.id).length;return o;},{all:negotiations.length});

  // Alerts automáticas: bloqueada >7d, sesión sin seguimiento >3d sin resumen,
  // stakeholder repetido en varias negociaciones activas.
  const alerts = React.useMemo(()=>{
    const out=[];
    const now=Date.now();
    const byId = new Map(negotiations.map(n=>[n.id,n]));
    negotiations.forEach(n=>{
      const daysSince = n.updatedAt ? Math.floor((now-new Date(n.updatedAt))/86400000) : 0;
      const blockedBy = negotiations.filter(x=>(x.relationships||[]).some(r=>r.negotiationId===n.id&&r.type==="blocks"));
      if(n.status==="en_curso" && blockedBy.length>0 && daysSince>7){
        out.push({id:`blk-${n.id}`,level:"critical",title:`${n.title} bloqueada hace ${daysSince}d`,description:`Bloqueada por: ${blockedBy.map(x=>x.title).join(", ")}`,negId:n.id});
      }
      const sessions=(n.sessions||[]).slice().sort((a,b)=>b.date.localeCompare(a.date));
      const last = sessions[0];
      if(last){
        const sd = Math.floor((now-new Date(last.date))/86400000);
        if(sd>3 && (!last.summary?.trim() || (last.entries||[]).length===0) && n.status==="en_curso"){
          out.push({id:`ses-${n.id}-${last.id}`,level:"warning",title:`Sesión sin seguimiento en ${n.title}`,description:`Hace ${sd} días · sin resumen o notas`,negId:n.id});
        }
      }
    });
    // stakeholders repetidos
    const stkMap=new Map();
    negotiations.forEach(n=>{
      if(n.status!=="en_curso") return;
      (n.stakeholders||[]).forEach(s=>{
        const key=s.name.trim().toLowerCase();
        if(!key) return;
        if(!stkMap.has(key)) stkMap.set(key,{name:s.name,negs:new Set()});
        stkMap.get(key).negs.add(n.id);
      });
    });
    for(const [,v] of stkMap){
      if(v.negs.size>=3){
        const first = byId.get([...v.negs][0]);
        out.push({id:`stk-${v.name}`,level:"info",title:`${v.name} aparece en ${v.negs.size} negociaciones activas`,description:"Persona clave en varios deals simultáneos",negId:first?.id});
      }
    }
    const order={critical:0,warning:1,info:2};
    return out.sort((a,b)=>order[a.level]-order[b.level]);
  },[negotiations]);
  return(
    <div style={{maxWidth:1000,margin:"0 auto",padding:"30px 20px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:22,fontWeight:700,marginBottom:4}}>🤝 Deal Room</div>
          <div style={{fontSize:13,color:"#6b7280"}}>{negotiations.length} negociación{negotiations.length!==1?"es":""} · Timeline de sesiones, notas y resúmenes</div>
        </div>
        <button onClick={onCreate} style={{padding:"10px 18px",borderRadius:10,background:"#3B82F6",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>+ Nueva negociación</button>
      </div>

      {/* Panel de alertas */}
      {alerts.length>0&&(
        <div style={{marginBottom:18,padding:14,background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:12}}>
          <div style={{fontSize:12,fontWeight:700,color:"#6B7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>⚠ Alertas ({alerts.length})</div>
          {alerts.map(a=>{
            const styles = a.level==="critical"?{bg:"#FEE2E2",bd:"#FCA5A5",icon:"🚨"}:a.level==="warning"?{bg:"#FEF3C7",bd:"#FCD34D",icon:"⚠️"}:{bg:"#DBEAFE",bd:"#93C5FD",icon:"💡"};
            return(
              <div key={a.id} onClick={()=>a.negId&&onOpen(a.negId)} style={{padding:"9px 12px",background:styles.bg,border:`1px solid ${styles.bd}`,borderRadius:8,marginBottom:6,cursor:a.negId?"pointer":"default",transition:"transform .15s"}} onMouseEnter={e=>a.negId&&(e.currentTarget.style.transform="translateY(-1px)")} onMouseLeave={e=>a.negId&&(e.currentTarget.style.transform="translateY(0)")}>
                <div style={{fontSize:12.5,fontWeight:600,color:"#111827",marginBottom:2}}>{styles.icon} {a.title}</div>
                <div style={{fontSize:11.5,color:"#4B5563"}}>{a.description}</div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{display:"flex",gap:8,marginBottom:18,flexWrap:"wrap"}}>
        {[["all","Todas",null],...NEG_STATUSES.map(s=>[s.id,s.label,s.color])].map(([k,l,c])=>{
          const sel=filter===k;
          return <button key={k} onClick={()=>onSetFilter(k)} style={{padding:"7px 14px",borderRadius:20,border:`1px solid ${sel?(c||"#3B82F6"):"#e5e7eb"}`,background:sel?(c||"#3B82F6"):"#fff",color:sel?"#fff":"#6b7280",fontSize:12,cursor:"pointer",fontWeight:sel?600:400,fontFamily:"inherit"}}>{l} ({counts[k]||0})</button>;
        })}
      </div>

      {filtered.length===0
        ? <div style={{textAlign:"center",padding:"60px 20px",background:"#F9FAFB",border:"1px dashed #e5e7eb",borderRadius:12}}>
            <div style={{fontSize:32,marginBottom:10}}>🤝</div>
            <div style={{fontSize:14,color:"#6b7280",marginBottom:14}}>{negotiations.length===0?"Aún no hay negociaciones. Crea la primera para empezar.":`Sin negociaciones ${getNegStatus(filter).label.toLowerCase()}.`}</div>
            {negotiations.length===0&&<button onClick={onCreate} style={{padding:"9px 18px",borderRadius:10,background:"#3B82F6",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>+ Nueva negociación</button>}
          </div>
        : <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {filtered.map(n=>{
              const st=getNegStatus(n.status);
              const owner=members.find(m=>m.id===n.ownerId);
              const mp2=MP[owner?.id]||MP[0];
              const lastSession = (n.sessions||[]).slice().sort((a,b)=>b.date.localeCompare(a.date))[0];
              const blocksList     = (n.relationships||[]).filter(r=>r.type==="blocks").map(r=>negotiations.find(x=>x.id===r.negotiationId)).filter(Boolean);
              const blockedByList  = negotiations.filter(x=>(x.relationships||[]).some(r=>r.negotiationId===n.id&&r.type==="blocks"));
              const influencesList = (n.relationships||[]).filter(r=>r.type==="influences"||r.type==="depends_on").slice(0,2);
              const daysSince = n.updatedAt ? Math.floor((Date.now()-new Date(n.updatedAt))/86400000) : 0;
              const alertLevel = blockedByList.length>0 && daysSince>7 ? "critical" : blockedByList.length>0 && daysSince>3 ? "warning" : null;
              const cardBg = alertLevel==="critical"?"#FEF2F2":alertLevel==="warning"?"#FFFBEB":"#fff";
              const cardBorder = alertLevel==="critical"?"#FCA5A5":alertLevel==="warning"?"#FCD34D":"#E5E7EB";
              return(
                <div key={n.id} onClick={()=>onOpen(n.id)} className="tf-lift" style={{background:cardBg,border:`2px solid ${cardBorder}`,borderLeft:`4px solid ${st.color}`,borderRadius:12,padding:"16px 18px",cursor:"pointer"}}>
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:10,marginBottom:6}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2,flexWrap:"wrap"}}>
                        <div style={{fontSize:16,fontWeight:600,color:"#111827"}}>{n.title}</div>
                        {alertLevel==="critical"&&<span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:10,background:"#FEE2E2",border:"1px solid #FCA5A5",color:"#B91C1C"}}>🚨 Crítico</span>}
                        {alertLevel==="warning"&&<span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:10,background:"#FEF3C7",border:"1px solid #FCD34D",color:"#92400E"}}>⚠️ Atención</span>}
                      </div>
                      <div style={{fontSize:12,color:"#6b7280"}}>Contraparte: <b style={{color:"#374151"}}>{n.counterparty}</b>{n.value!=null&&<> · <b style={{color:"#059669"}}>{Number(n.value).toLocaleString("es-ES")} {n.currency||"EUR"}</b></>}</div>
                    </div>
                    <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>
                      <span style={{fontSize:11,fontWeight:600,padding:"3px 9px",borderRadius:14,background:st.color+"18",color:st.color}}>{st.label}</span>
                      <button onClick={e=>{e.stopPropagation();onEdit(n);}} title="Editar" style={{background:"none",border:"none",fontSize:13,cursor:"pointer",color:"#9ca3af"}}>✏️</button>
                    </div>
                  </div>
                  {n.description&&<div style={{fontSize:13,color:"#4B5563",lineHeight:1.5,marginBottom:6}}>{n.description}</div>}

                  {/* Dependencias */}
                  {blockedByList.length>0&&(
                    <div style={{fontSize:11.5,padding:"7px 10px",background:"#FEF2F2",border:"1px solid #FCA5A5",borderRadius:8,marginTop:6}}>
                      <div style={{fontWeight:600,color:"#991B1B"}}>🚫 Bloqueada por:</div>
                      {blockedByList.map(b=><div key={b.id} style={{color:"#7F1D1D",marginTop:2}}>→ {b.title}</div>)}
                      {daysSince>3&&<div style={{color:"#B91C1C",fontWeight:600,marginTop:4}}>⏱ Sin movimiento hace {daysSince}d</div>}
                    </div>
                  )}
                  {blocksList.length>0&&(
                    <div style={{fontSize:11.5,padding:"7px 10px",background:"#FEF3C7",border:"1px solid #FCD34D",borderRadius:8,marginTop:6}}>
                      <div style={{fontWeight:600,color:"#92400E"}}>🔒 Bloquea:</div>
                      {blocksList.slice(0,3).map(b=><div key={b.id} style={{color:"#78350F",marginTop:2}}>→ {b.title}</div>)}
                    </div>
                  )}
                  {influencesList.length>0&&(
                    <div style={{fontSize:11.5,padding:"7px 10px",background:"#EFF6FF",border:"1px solid #BFDBFE",borderRadius:8,marginTop:6}}>
                      <div style={{fontWeight:600,color:"#1E3A8A"}}>🔗 Relacionada con:</div>
                      {influencesList.map(r=>{ const t=negotiations.find(x=>x.id===r.negotiationId); const rt=getRelType(r.type); return t?<div key={r.id} style={{color:"#1E40AF",marginTop:2}}>{rt.icon} {t.title}</div>:null; })}
                    </div>
                  )}

                  {/* Proyectos relacionados (pills por prioridad) */}
                  {(n.relatedProjects||[]).length>0&&(
                    <div style={{marginTop:8}}>
                      <div style={{fontSize:11,fontWeight:600,color:"#6B7280",marginBottom:4}}>📊 Proyectos ({n.relatedProjects.length}):</div>
                      <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                        {n.relatedProjects.slice(0,5).map(rp=>{ const p=projects.find(x=>x.id===rp.projectId); const pri=PROJ_PRIORITY[rp.priority]||PROJ_PRIORITY.high; return(
                          <span key={rp.projectId} title={`Rol: ${rp.role} · Prioridad: ${pri.label}`} style={{fontSize:10.5,fontWeight:500,padding:"3px 9px",borderRadius:12,background:pri.bg,border:`1px solid ${pri.border}`,color:pri.text}}>{p?.emoji||"📋"} {p?.name||"?"}</span>
                        );})}
                        {n.relatedProjects.length>5&&<span style={{fontSize:10.5,color:"#9CA3AF"}}>+{n.relatedProjects.length-5}</span>}
                      </div>
                    </div>
                  )}

                  {/* Stakeholders */}
                  {(n.stakeholders||[]).length>0&&(
                    <div style={{marginTop:8,fontSize:11.5,color:"#6B7280"}}>
                      <b style={{color:"#374151"}}>👥 Stakeholders:</b> {(n.stakeholders).slice(0,2).map((s,i)=><span key={s.id}>{i>0?", ":""}{s.name} <span style={{color:"#9CA3AF"}}>({getStkRole(s.role)})</span></span>)}{n.stakeholders.length>2&&<span style={{color:"#9CA3AF"}}>, +{n.stakeholders.length-2}</span>}
                    </div>
                  )}

                  <div style={{display:"flex",alignItems:"center",gap:12,fontSize:11,color:"#9ca3af",flexWrap:"wrap",marginTop:8,paddingTop:8,borderTop:"1px solid #F3F4F6"}}>
                    {owner&&<span style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:16,height:16,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:700}}>{owner.initials}</span>{owner.name.split(" ")[0]}</span>}
                    <span>💬 {(n.sessions||[]).length} sesion{(n.sessions||[]).length!==1?"es":""}</span>
                    {lastSession&&<span>· última {timeAgoIso(lastSession.date)}</span>}
                    {n.updatedAt&&<span style={{marginLeft:"auto"}}>Actualizada {timeAgoIso(n.updatedAt)}</span>}
                  </div>
                </div>
              );
            })}
          </div>}
    </div>
  );
}

// Detalle negociación: header, info, timeline sesiones.
function NegotiationDetailView({negotiation,members,projects,workspaces,agents,boards,allNegotiations,ceoMemory,onAddCeoMemory,onAddNegMemory,onRemoveNegMemory,onSummarizeAndClearChat,onRouteAutoLearn,onMemorized,onBack,onEditNeg,onCreateSession,onOpenSession,onEditSession,onRequestBriefing,onGoProject,onOpenTask,onOpenRelatedNeg,onClearBriefing,onAppendHectorMessage,onClearHectorChat,onClearHectorErrors,onSetAnalysis,onSaveBriefing,onUpdateDocuments,onOverlayTask}){
  const st=getNegStatus(negotiation.status);
  const owner=members.find(m=>m.id===negotiation.ownerId);
  const sessionsAsc = (negotiation.sessions||[]).slice().sort((a,b)=>a.date.localeCompare(b.date));
  const sessionsDesc = (negotiation.sessions||[]).slice().sort((a,b)=>b.date.localeCompare(a.date));
  // Héctor: prioridad por nombre, fallback a agentId de la negociación.
  const hector = (agents||[]).find(a=>a.name==="Héctor") || (negotiation.agentId?(agents||[]).find(a=>a.id===negotiation.agentId):null) || null;
  const [chatInput,setChatInput] = useState("");
  const [chatLoading,setChatLoading] = useState(false);
  const chatScrollRef = useRef(null);
  // Dos mecanismos de apertura: hover (desktop) o click/tap (desktop+móvil).
  // hoverKey gana sobre pinnedKey — hovering otro row mueve el popover a ese row
  // aunque haya uno pinned. Al salir del área hoverKey se limpia y pinnedKey
  // reaparece.
  const [hoverHector,setHoverHector] = useState(null);    // "task:<id>" | "proj:<id>"
  const [pinnedHector,setPinnedHector] = useState(null);
  const expandedHector = hoverHector || pinnedHector;
  const [speakingKey,setSpeakingKey] = useState(null);
  const [individualLoading,setIndividualLoading] = useState({}); // map key → true
  // Auto-TTS: solo cuando el usuario inició el turno por voz (mic).
  const voiceInitiatedRef = useRef(false);
  const chatMicRef = useRef(null); // handle al VoiceMicButton del chat para stop imperativo
  const [negMemOpen,setNegMemOpen] = useState(null); // qué sección de memoria de la negociación está abierta
  const [banner20Ignored,setBanner20Ignored] = useState(false); // el aviso amarillo (20-29 msgs) solo se ignora hasta el rojo (30+)
  const [speakingMsgTs,setSpeakingMsgTs] = useState(null);
  useEffect(()=>{
    const el = chatScrollRef.current; if(!el) return;
    el.scrollTop = el.scrollHeight;
  },[(negotiation.hectorChat||[]).length,chatLoading]);
  useEffect(()=>()=>stopSpeaking(),[]); // cleanup TTS al desmontar (STT lo maneja VoiceMicButton)

  // Proyectos relacionados — con agregación de tareas por proyecto.
  const relProjs = (negotiation.relatedProjects||[]).map(rp=>{
    const p = projects.find(x=>x.id===rp.projectId); if(!p) return null;
    const cols = boards[p.id]||[];
    const ownTasks = cols.flatMap(c=>c.tasks.map(t=>({...t, colName:c.name, colId:c.id})));
    const active = ownTasks.filter(t=>t.colName!=="Hecho");
    const overdue = active.filter(t=>t.dueDate&&daysUntil(t.dueDate)<0).length;
    const done = ownTasks.length - active.length;
    return { p, rp, tasks: ownTasks, activeCount: active.length, overdueCount: overdue, doneCount: done, total: ownTasks.length };
  }).filter(Boolean);

  // Tareas críticas cross-project: TODAS las tareas activas de TODOS los
  // proyectos vinculados, ordenadas por urgencia (vencidas primero, luego
  // por fecha próxima; sin fecha al final).
  const criticalTasks = relProjs.flatMap(({p,tasks})=>tasks.filter(t=>t.colName!=="Hecho").map(t=>({...t, projId:p.id, projName:p.name, projColor:p.color, projEmoji:p.emoji||"📋"})))
    .sort((a,b)=>{
      const da = a.dueDate ? daysUntil(a.dueDate) : 9999;
      const db = b.dueDate ? daysUntil(b.dueDate) : 9999;
      if(da!==db) return da-db;
      return (a.title||"").localeCompare(b.title||"");
    });

  // Fingerprints para stale detection en hectorAnalysis.
  const fpTask = (t)=>`${t.title}|${t.dueDate||""}|${t.colName||""}|${t.priority||""}`;
  const fpProj = (r)=>`${r.activeCount}|${r.overdueCount}`;

  // Parser defensivo para respuestas del proxy /api/agent. El proxy SIEMPRE
  // debería devolver JSON {text} o {error}, pero en timeouts/errores de
  // infra (504 de Vercel, función matada por el runtime) el body llega
  // vacío y r.json() explota con "Unexpected end of JSON input" sin
  // exponer el error real. Leemos como texto primero, intentamos parsear,
  // y si falla devolvemos el texto plano como mensaje de error.
  const callAgentSafe = async(body)=>{
    const r = await fetch("/api/agent",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const raw = await r.text();
    let data = null;
    if(raw){ try{ data = JSON.parse(raw); }catch{} }
    if(!r.ok){
      const errMsg = data?.error || raw || `HTTP ${r.status} (body vacío — posible timeout de la función)`;
      throw new Error(errMsg);
    }
    if(!data){
      // Respuesta OK pero body no-JSON (muy raro — probablemente infra
      // devolvió texto plano). Tratar el raw como la respuesta.
      return stripMarkdown(raw || "") || "(respuesta vacía del servidor)";
    }
    return stripMarkdown(data.text || "");
  };

  // TTS con voz de Héctor — reutiliza speak() de lib/voice.js. Toggle
  // "Escuchar/Detener" por item mediante speakingKey.
  const handleSpeak = (key,text)=>{
    if(!text) return;
    if(speakingKey===key){ stopSpeaking(); setSpeakingKey(null); return; }
    if(speakingKey) stopSpeaking();
    const cfg = hector?.voice || {gender:"male",rate:1.1,pitch:0.9};
    speak(text,{gender:cfg.gender||"male",rate:cfg.rate||1.1,pitch:cfg.pitch||0.9,onEnd:()=>setSpeakingKey(null)});
    setSpeakingKey(key);
  };

  // Regeneración individual de una recomendación stale (o primera vez).
  const regenOne = async(kind,item)=>{
    if(!hector) return;
    const key = kind==="task" ? `task:${item.id}` : `proj:${item.p.id}`;
    setIndividualLoading(prev=>({...prev,[key]:true}));
    try{
      const contextLines = [
        `Negociación: ${negotiation.title}`,
        `Contraparte: ${negotiation.counterparty}`,
        `Estado: ${st.label}`,
      ];
      if(negotiation.description) contextLines.push(`Descripción: ${negotiation.description}`);
      const contextStr = contextLines.join("\n");
      const itemPrompt = kind==="task"
        ? `Analiza SOLO esta tarea y nada más:\n[${item.id}] ${item.title} (proyecto: ${item.projName}, columna: ${item.colName}, fecha: ${item.dueDate||"sin fecha"}, prioridad: ${item.priority})\n\nDame 2-4 frases de análisis directo + máx 2 tags de esta lista cerrada: "Bloquea negociación", "Decisión Tipo 1", "Decisión Tipo 2", "Riesgo alto", "Riesgo bajo", "Delegable", "Urgente".\n\nResponde EXCLUSIVAMENTE con JSON válido de esta forma exacta: {"text":"…","tags":["…"]}`
        : `Analiza SOLO este proyecto y nada más:\n[${item.p.id}] ${item.p.name} (rol en esta negociación: ${item.rp.role||"relacionado"}, ${item.activeCount} tareas activas, ${item.overdueCount} vencidas)\n\nDame 2-4 frases de análisis directo + máx 2 tags de esta lista cerrada: "Bloquea negociación", "Decisión Tipo 1", "Decisión Tipo 2", "Riesgo alto", "Riesgo bajo", "Delegable", "Urgente".\n\nResponde EXCLUSIVAMENTE con JSON válido de esta forma exacta: {"text":"…","tags":["…"]}`;
      const system = (hector.promptBase||"") + "\n\n---\nCONTEXTO DE ESTA NEGOCIACIÓN:\n" + contextStr + "\n\n" + PLAIN_TEXT_RULE + "\n\nIMPORTANTE: responde ÚNICAMENTE con JSON válido, sin markdown ni prosa. El valor del campo \"text\" debe ser texto plano sin asteriscos ni guiones de lista.";
      const txt = await callAgentSafe({system,messages:[{role:"user",content:itemPrompt}],max_tokens:500});
      let parsed=null;
      try{ parsed=JSON.parse(txt); }
      catch{ const m=txt.match(/\{[\s\S]*\}/); if(m){ try{ parsed=JSON.parse(m[0]); }catch{} } }
      if(!parsed) throw new Error("JSON inválido del agente");
      const itemId = kind==="task"?String(item.id):String(item.p.id);
      const fp = kind==="task"?fpTask(item):fpProj(item);
      const prevA = negotiation.hectorAnalysis||{generatedAt:new Date().toISOString(),tasks:{},projects:{}};
      const field = kind==="task"?"tasks":"projects";
      const merged = {
        ...prevA,
        [field]: {...(prevA[field]||{}), [itemId]: {text:stripMarkdown(parsed.text||""),tags:Array.isArray(parsed.tags)?parsed.tags:[],fp}},
      };
      onSetAnalysis(negotiation.id,merged);
    }catch(e){
      onAppendHectorMessage(negotiation.id,{role:"assistant",content:`⚠ Error al regenerar análisis de ${kind==="task"?item.title:item.p.name}: ${e.message}`,timestamp:new Date().toISOString()});
    }finally{
      setIndividualLoading(prev=>{ const n={...prev}; delete n[key]; return n; });
    }
  };

  // Color/tag styles para los tags de análisis.
  const TAG_STYLES = {
    "Bloquea negociación":{bg:"#FEE2E2",border:"#FCA5A5",text:"#991B1B"},
    "Decisión Tipo 1":    {bg:"#FEE2E2",border:"#FCA5A5",text:"#991B1B"},
    "Decisión Tipo 2":    {bg:"#DBEAFE",border:"#93C5FD",text:"#1E40AF"},
    "Riesgo alto":        {bg:"#FEE2E2",border:"#FCA5A5",text:"#991B1B"},
    "Riesgo bajo":        {bg:"#E1F5EE",border:"#86EFAC",text:"#065F46"},
    "Delegable":          {bg:"#EDE9FE",border:"#C4B5FD",text:"#5B21B6"},
    "Urgente":            {bg:"#FEF3C7",border:"#FCD34D",text:"#92400E"},
  };
  const tagStyle = (t)=>TAG_STYLES[t]||{bg:"#F3F4F6",border:"#D1D5DB",text:"#374151"};

  // Render del chip "H" + popover inline. Reutilizado en tareas y proyectos.
  const renderHectorChip = (kind,item,keyId)=>{
    const key = `${kind}:${keyId}`;
    const entry = kind==="task" ? negotiation.hectorAnalysis?.tasks?.[String(keyId)] : negotiation.hectorAnalysis?.projects?.[String(keyId)];
    const currentFp = kind==="task" ? fpTask(item) : fpProj(item);
    const isStale = entry && entry.fp && entry.fp!==currentFp;
    const isExpanded = expandedHector===key;
    const loading = !!individualLoading[key];
    const hasEntry = !!entry;
    const chipBg = !hasEntry ? "#F3F4F6" : isStale ? "#E5E7EB" : "#1D9E75";
    const chipColor = !hasEntry ? "#9CA3AF" : isStale ? "#6B7280" : "#fff";
    const chipTitle = !hasEntry ? "Sin análisis — click para generar" : isStale ? "Análisis desactualizado — click para regenerar" : "Análisis de Héctor — click para ver";
    const handleChipClick = (e)=>{
      e.stopPropagation();
      if(!hasEntry){ regenOne(kind,item); setPinnedHector(key); return; }
      setPinnedHector(pinnedHector===key?null:key);
    };
    return { key, entry, isStale, isExpanded, loading, hasEntry, chipBg, chipColor, chipTitle, handleChipClick };
  };

  const renderHectorPopover = (kind,item,keyId)=>{
    const key = `${kind}:${keyId}`;
    const entry = kind==="task" ? negotiation.hectorAnalysis?.tasks?.[String(keyId)] : negotiation.hectorAnalysis?.projects?.[String(keyId)];
    if(!entry) return null;
    const loading = !!individualLoading[key];
    const currentFp = kind==="task" ? fpTask(item) : fpProj(item);
    const isStale = entry.fp && entry.fp!==currentFp;
    const speaking = speakingKey===key;
    return(
      <div style={{marginTop:6,background:"#F9FAFB",border:"1px solid #E5E7EB",borderLeft:"3px solid #1D9E75",borderRadius:8,padding:"10px 12px",animation:"tf-slide-down .15s ease"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
          <div style={{width:22,height:22,borderRadius:"50%",background:"linear-gradient(135deg,#1D9E75,#0E7C5A)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0}}>H</div>
          <div style={{fontSize:11,fontWeight:700,color:"#1D9E75",flex:1}}>Héctor opina{isStale&&<span style={{marginLeft:6,fontSize:10,padding:"1px 6px",background:"#FEF3C7",border:"0.5px solid #FCD34D",borderRadius:10,color:"#92400E",fontWeight:500}}>desactualizado</span>}</div>
          <button onClick={e=>{e.stopPropagation();setPinnedHector(null);setHoverHector(null);}} title="Cerrar" style={{background:"none",border:"none",fontSize:13,cursor:"pointer",color:"#9CA3AF"}}>×</button>
        </div>
        {(entry.tags||[]).length>0&&(
          <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:7}}>
            {entry.tags.map((t,i)=>{ const s=tagStyle(t); return(
              <span key={i} style={{fontSize:10,padding:"2px 7px",borderRadius:10,background:s.bg,border:`1px solid ${s.border}`,color:s.text,fontWeight:500}}>{t}</span>
            );})}
          </div>
        )}
        <div style={{fontSize:12,color:"#374151",lineHeight:1.6,whiteSpace:"pre-wrap"}}>{entry.text||"(sin contenido)"}</div>
        <div style={{display:"flex",gap:6,marginTop:9,flexWrap:"wrap"}}>
          <button onClick={e=>{e.stopPropagation();handleSpeak(key,entry.text);}} disabled={!entry.text} style={{padding:"5px 10px",borderRadius:6,background:speaking?"#E24B4A":"#fff",color:speaking?"#fff":"#1D9E75",border:`1px solid ${speaking?"#E24B4A":"#1D9E75"}`,fontSize:11,cursor:entry.text?"pointer":"not-allowed",fontWeight:500,fontFamily:"inherit"}}>{speaking?"⏸ Detener":"🔊 Escuchar"}</button>
          <button onClick={e=>{e.stopPropagation();regenOne(kind,item);}} disabled={loading||!hector} style={{padding:"5px 10px",borderRadius:6,background:"transparent",color:"#6B7280",border:"0.5px solid #D1D5DB",fontSize:11,cursor:loading||!hector?"not-allowed":"pointer",fontWeight:500,fontFamily:"inherit"}}>{loading?"⏳ Regenerando…":"🔄 Regenerar"}</button>
        </div>
      </div>
    );
  };

  return(
    <div style={{maxWidth:1200,margin:"0 auto",padding:"30px 20px"}}>
      <button onClick={onBack} style={{background:"none",border:"none",color:"#3B82F6",fontSize:13,cursor:"pointer",marginBottom:14,padding:0,fontFamily:"inherit"}}>← Deal Room</button>

      {/* Header */}
      <div style={{marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6,flexWrap:"wrap"}}>
          <div style={{fontSize:22,fontWeight:700,color:"#111827"}}>{negotiation.title}</div>
          <span style={{fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:14,background:st.color+"18",color:st.color}}>{st.label}</span>
        </div>
        <div style={{fontSize:13,color:"#6b7280"}}>Contraparte: <b style={{color:"#374151"}}>{negotiation.counterparty}</b>{negotiation.value!=null&&<> · <b style={{color:"#059669"}}>{Number(negotiation.value).toLocaleString("es-ES")} {negotiation.currency||"EUR"}</b></>}{owner&&<> · Responsable: <b style={{color:"#374151"}}>{owner.name}</b></>}</div>
      </div>
      {negotiation.description&&<div style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:10,padding:"12px 14px",marginBottom:16,fontSize:13,color:"#4B5563",lineHeight:1.6,whiteSpace:"pre-wrap"}}>{negotiation.description}</div>}
      <div style={{display:"flex",gap:10,marginBottom:20,flexWrap:"wrap"}}>
        <button onClick={onCreateSession} style={{padding:"9px 16px",borderRadius:10,background:"#3B82F6",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>+ Nueva sesión</button>
        <button onClick={()=>onEditNeg(negotiation)} style={{padding:"9px 16px",borderRadius:10,background:"#fff",color:"#374151",border:"0.5px solid #d1d5db",fontSize:13,cursor:"pointer"}}>Editar negociación</button>
      </div>

      {/* Dashboard grid 50/50 — stack en móvil vía .tf-dashboard-grid-2 */}
      <div className="tf-dashboard-grid-2" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,alignItems:"start",marginBottom:20}}>

        {/* ─── IZQUIERDA: datos operativos ─── */}
        <div style={{display:"flex",flexDirection:"column",gap:18,minWidth:0}}>

          {/* Proyectos relacionados */}
          <section>
            <div style={{fontSize:11,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}><span>📊 Proyectos relacionados</span><span style={{fontSize:10,color:"#9CA3AF"}}>{relProjs.length}</span></div>
            {relProjs.length===0
              ? <div style={{fontSize:12,color:"#9CA3AF",fontStyle:"italic",padding:"10px 12px",background:"#F9FAFB",border:"1px dashed #e5e7eb",borderRadius:8}}>Sin proyectos vinculados. Edita la negociación para añadirlos.</div>
              : <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {relProjs.map((rItem)=>{
                    const {p,rp,activeCount,overdueCount,total} = rItem;
                    const ws = workspaces.find(w=>w.id===p.workspaceId);
                    const pri = PROJ_PRIORITY[rp.priority]||PROJ_PRIORITY.high;
                    const chip = renderHectorChip("proj",rItem,p.id);
                    return(
                      <div
                        key={p.id}
                        onMouseEnter={()=>{ if(chip.hasEntry) setHoverHector(chip.key); }}
                        onMouseLeave={()=>setHoverHector(h=>h===chip.key?null:h)}
                      >
                        <div onClick={()=>onGoProject(p.id)} className="tf-lift" style={{background:"#fff",border:"1.5px solid #E5E7EB",borderLeft:`4px solid ${p.color}`,borderRadius:10,padding:"10px 12px",cursor:"pointer"}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                            <span style={{width:10,height:10,borderRadius:"50%",background:p.color,flexShrink:0}}/>
                            <span style={{fontSize:13,fontWeight:600,color:"#111827",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.emoji||"📋"} {p.name}</span>
                            <span style={{fontSize:10,fontWeight:600,padding:"2px 7px",borderRadius:10,background:pri.bg,border:`1px solid ${pri.border}`,color:pri.text,flexShrink:0}}>{pri.label}</span>
                            <button onClick={chip.handleChipClick} title={chip.chipTitle} disabled={chip.loading} style={{width:22,height:22,borderRadius:"50%",background:chip.loading?"#FEF3C7":chip.chipBg,color:chip.chipColor,border:"none",fontSize:10,fontWeight:700,cursor:chip.loading?"wait":"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit"}}>{chip.loading?"⋯":"H"}</button>
                          </div>
                          <div style={{display:"flex",alignItems:"center",gap:8,fontSize:11,color:"#6B7280",flexWrap:"wrap"}}>
                            {ws&&<span>{ws.emoji} {ws.name}</span>}
                            <span>· {total} tarea{total!==1?"s":""}</span>
                            {overdueCount>0
                              ? <span style={{fontSize:10,fontWeight:600,padding:"2px 7px",borderRadius:10,background:"#FEE2E2",border:"1px solid #FCA5A5",color:"#B91C1C"}}>{overdueCount} vencida{overdueCount!==1?"s":""}</span>
                              : activeCount===0
                                ? <span style={{fontSize:10,fontWeight:600,padding:"2px 7px",borderRadius:10,background:"#E1F5EE",border:"1px solid #86EFAC",color:"#065F46"}}>completo</span>
                                : <span style={{fontSize:10,fontWeight:600,padding:"2px 7px",borderRadius:10,background:"#E1F5EE",border:"1px solid #86EFAC",color:"#065F46"}}>al día</span>
                            }
                          </div>
                        </div>
                        {chip.isExpanded&&renderHectorPopover("proj",rItem,p.id)}
                      </div>
                    );
                  })}
                </div>}
          </section>

          {/* Tareas críticas cross-project */}
          <section>
            <div style={{fontSize:11,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}><span>🔥 Tareas críticas</span><span style={{fontSize:10,color:"#9CA3AF"}}>{criticalTasks.length}</span></div>
            {criticalTasks.length===0
              ? <div style={{fontSize:12,color:"#9CA3AF",fontStyle:"italic",padding:"10px 12px",background:"#F9FAFB",border:"1px dashed #e5e7eb",borderRadius:8}}>Sin tareas activas en los proyectos vinculados.</div>
              : <div style={{display:"flex",flexDirection:"column",gap:5,maxHeight:340,overflowY:"auto",paddingRight:4}}>
                  {criticalTasks.map(t=>{
                    const days = t.dueDate ? daysUntil(t.dueDate) : null;
                    const dueLabel = !t.dueDate ? "Sin fecha" : days<0 ? `Vencida ${-days}d` : days===0 ? "Hoy" : days<=7 ? `En ${days}d` : `En ${days}d`;
                    const dueColor = !t.dueDate ? "#9CA3AF" : days<0 ? "#E24B4A" : days===0 ? "#EF9F27" : days<=3 ? "#EF9F27" : "#6b7280";
                    const chip = renderHectorChip("task",t,t.id);
                    return(
                      <div
                        key={`${t.projId}-${t.id}`}
                        onMouseEnter={()=>{ if(chip.hasEntry) setHoverHector(chip.key); }}
                        onMouseLeave={()=>setHoverHector(h=>h===chip.key?null:h)}
                      >
                        <div onClick={()=>onOpenTask(t.id,t.projId)} style={{background:"#fff",border:"1px solid #E5E7EB",borderLeft:`3px solid ${t.projColor}`,borderRadius:8,padding:"8px 10px",cursor:"pointer",display:"flex",alignItems:"center",gap:8,transition:"background .12s"}} onMouseEnter={e=>{e.currentTarget.style.background="#F9FAFB";}} onMouseLeave={e=>{e.currentTarget.style.background="#fff";}}>
                          <input type="checkbox" readOnly checked={false} style={{flexShrink:0,cursor:"pointer",accentColor:t.projColor}} onClick={e=>e.stopPropagation()}/>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:12.5,color:"#111827",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.title}</div>
                            <div style={{fontSize:10.5,color:"#9CA3AF"}}>{t.projEmoji} {t.projName} · {t.colName}</div>
                          </div>
                          <span style={{fontSize:10.5,color:dueColor,fontWeight:600,flexShrink:0}}>{dueLabel}</span>
                          <button onClick={chip.handleChipClick} title={chip.chipTitle} disabled={chip.loading} style={{width:20,height:20,borderRadius:"50%",background:chip.loading?"#FEF3C7":chip.chipBg,color:chip.chipColor,border:"none",fontSize:9,fontWeight:700,cursor:chip.loading?"wait":"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"inherit"}}>{chip.loading?"⋯":"H"}</button>
                        </div>
                        {chip.isExpanded&&renderHectorPopover("task",t,t.id)}
                      </div>
                    );
                  })}
                </div>}
          </section>

          {/* Sesiones */}
          <section>
            <div style={{fontSize:11,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}><span>📅 Sesiones</span><span style={{fontSize:10,color:"#9CA3AF"}}>{sessionsDesc.length}</span></div>
            {sessionsDesc.length===0
              ? <div style={{fontSize:12,color:"#9CA3AF",fontStyle:"italic",padding:"10px 12px",background:"#F9FAFB",border:"1px dashed #e5e7eb",borderRadius:8}}>Sin sesiones aún.</div>
              : <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {sessionsDesc.map(s=>{
                    const idx = sessionsAsc.findIndex(x=>x.id===s.id) + 1;
                    const notes = (s.entries||[]).length;
                    return(
                      <div key={s.id} onClick={()=>onOpenSession(s.id)} className="tf-lift" style={{background:"#fff",border:"1.5px solid #E5E7EB",borderRadius:10,padding:"10px 12px",cursor:"pointer"}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                          <span style={{fontSize:10.5,fontWeight:700,color:"#6B7280",minWidth:20,fontFamily:"ui-monospace,monospace"}}>#{idx}</span>
                          <span style={{fontSize:13}}>{getSessionTypeIcon(s.type)}</span>
                          <span style={{fontSize:12.5,fontWeight:600,color:"#111827",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{getSessionTypeLabel(s.type)}</span>
                          <span style={{fontSize:10.5,color:"#9CA3AF",flexShrink:0}}>{timeAgoIso(s.date)}</span>
                        </div>
                        <div style={{fontSize:11,color:"#6b7280",marginBottom:s.summary?4:0}}>{formatDateTimeES(s.date)} · {s.duration} min · 📝 {notes}</div>
                        {s.summary&&<div style={{fontSize:11.5,color:"#4B5563",lineHeight:1.4,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>{s.summary}</div>}
                      </div>
                    );
                  })}
                </div>}
          </section>

          {/* Documentos */}
          <section>
            <div style={{fontSize:11,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}><span>📎 Documentos</span><span style={{fontSize:10,color:"#9CA3AF"}}>{(negotiation.documents||[]).length}</span></div>
            <DocumentUploader
              ownerKey={`neg-${negotiation.id}`}
              documents={negotiation.documents||[]}
              onChange={docs=>onUpdateDocuments?.(negotiation.id,docs)}
              agents={agents||[]}
              contextLabel={`la negociación "${negotiation.title}" con ${negotiation.counterparty}`}
              onPostChatMessage={msg=>onAppendHectorMessage(negotiation.id,msg)}
              ceoMemory={ceoMemory}
            />
          </section>

          {/* Memoria de la negociación */}
          <section>
            <div style={{fontSize:11,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span>🧠 Memoria de esta negociación</span>
              <span style={{fontSize:10,color:"#9CA3AF"}}>{(negotiation.memory?.keyFacts?.length||0)+(negotiation.memory?.agreements?.length||0)+(negotiation.memory?.redFlags?.length||0)}</span>
            </div>
            {[
              {key:"keyFacts",  label:"📍 Hechos",    items: negotiation.memory?.keyFacts   || []},
              {key:"agreements",label:"🤝 Acuerdos",  items: negotiation.memory?.agreements || []},
              {key:"redFlags",  label:"🚩 Red flags", items: negotiation.memory?.redFlags   || []},
            ].map(s=>(
              <MemorySection
                key={s.key}
                label={s.label}
                category={s.key}
                items={s.items}
                open={negMemOpen===s.key}
                onToggle={()=>setNegMemOpen(v=>v===s.key?null:s.key)}
                onAdd={(cat,text)=>onAddNegMemory?.(negotiation.id,{[cat]:[text]},"manual")}
                onRemove={(cat,id)=>onRemoveNegMemory?.(negotiation.id,cat,id)}
              />
            ))}
          </section>
        </div>

        {/* ─── DERECHA: Héctor chat en vivo ─── */}
        {(()=>{
          // Construye contexto narrativo de la negociación para el system prompt.
          const buildContext = ()=>{
            const lines=[];
            lines.push(`Negociación: ${negotiation.title}`);
            lines.push(`Contraparte: ${negotiation.counterparty}`);
            lines.push(`Estado: ${st.label}`);
            if(negotiation.value!=null) lines.push(`Valor: ${negotiation.value} ${negotiation.currency||"EUR"}`);
            if(negotiation.description) lines.push(`Descripción: ${negotiation.description}`);
            // Si la negociación tiene un especialista asignado (Mario, Jorge
            // u otro), Héctor incorpora su perspectiva. Volcamos resumen +
            // promptBase truncado para que pueda razonar como "Héctor
            // hablando con Jorge detrás" sin saturar tokens.
            if(negotiation.agentId){
              const assigned = (agents||[]).find(a=>a.id===negotiation.agentId);
              if(assigned && assigned.name!=="Héctor"){
                lines.push(`\nESPECIALISTA ASIGNADO A ESTA NEGOCIACIÓN:`);
                lines.push(`- Nombre: ${assigned.name}`);
                if(assigned.role)  lines.push(`- Rol: ${assigned.role}`);
                if(assigned.style) lines.push(`- Estilo: ${assigned.style}`);
                if(assigned.promptBase){
                  lines.push(`- Lineamientos del especialista (resumen):`);
                  lines.push(assigned.promptBase.slice(0, 1500));
                }
                lines.push(`Cuando aborden temas de su especialidad, incorpora su perspectiva en la respuesta y, si una decisión requiere su validación experta, recomiéndalo explícitamente.`);
              }
            }
            if(relProjs.length>0){
              lines.push(`\nProyectos vinculados (${relProjs.length}):`);
              relProjs.forEach(({p,rp,activeCount,overdueCount})=>{
                lines.push(`- [${p.id}] ${p.name} — rol "${rp.role||"relacionado"}", prioridad ${rp.priority||"high"}, ${activeCount} tareas activas (${overdueCount} vencidas)`);
              });
            }
            if(criticalTasks.length>0){
              lines.push(`\nTareas activas destacadas (${Math.min(20,criticalTasks.length)}/${criticalTasks.length}):`);
              criticalTasks.slice(0,20).forEach(t=>{
                const d = t.dueDate ? daysUntil(t.dueDate) : null;
                const dueLabel = !t.dueDate ? "sin fecha" : d<0 ? `vencida ${-d}d` : d===0 ? "hoy" : `en ${d}d`;
                lines.push(`- [${t.id}] ${t.title} (${t.projName}·${t.colName}, ${dueLabel}, prio=${t.priority})`);
              });
            }
            if((negotiation.stakeholders||[]).length>0){
              lines.push(`\nStakeholders:`);
              negotiation.stakeholders.forEach(s=>{
                lines.push(`- ${s.name}${s.company?` (${s.company})`:""} · ${getStkRole(s.role)} · influencia: ${getStkInfluence(s.influence)}`);
              });
            }
            if(sessionsDesc.length>0){
              const last = sessionsDesc[0];
              lines.push(`\nÚltima sesión: ${getSessionTypeLabel(last.type)} · ${formatDateTimeES(last.date)}`);
              if(last.summary) lines.push(`Resumen: ${last.summary.slice(0,600)}`);
            }
            // Comentarios de tareas vinculadas: máx 5 por tarea, 20 totales.
            // Da a Héctor visibilidad del hilo de discusión humana en cada tarea,
            // no solo los metadatos. Útil para entender bloqueos y decisiones.
            const taskComments = [];
            relProjs.forEach(({p,tasks})=>{
              tasks.forEach(t=>{
                (t.comments||[]).slice(-5).forEach(c=>{
                  const author = members.find(m=>m.id===c.author)?.name || "?";
                  taskComments.push(`[${t.title}] ${author} (${c.time||"sin fecha"}): ${c.text||""}`);
                });
              });
            });
            if(taskComments.length>0){
              lines.push(`\nCOMENTARIOS DE TAREAS VINCULADAS (${Math.min(20,taskComments.length)}/${taskComments.length}):`);
              taskComments.slice(0,20).forEach(c=>lines.push(`- ${c}`));
            }
            // Resúmenes de chats anteriores con Héctor (auto-generados al
            // pulsar "Limpiar chat"). Dan continuidad entre hilos pasados
            // y actuales sin arrastrar el histórico completo.
            const summaries = negotiation.memory?.chatSummaries || [];
            if(summaries.length>0){
              lines.push(`\nRESÚMENES DE CONVERSACIONES ANTERIORES (${summaries.length}):`);
              summaries.slice(-5).forEach(s=>{
                lines.push(`---`);
                lines.push(s.summary);
                if((s.keyPoints||[]).length) lines.push(`Puntos clave: ${s.keyPoints.join(", ")}`);
              });
            }
            // Documentos adjuntos a la negociación. Para los que ya tienen
            // informe de análisis previo, incluimos resumen + riesgos +
            // recomendaciones para que Héctor pueda referirse a ellos. Los
            // que no están analizados se listan igualmente para que sepa
            // que existen y pueda sugerir analizarlos.
            const docs = negotiation.documents||[];
            if(docs.length>0){
              lines.push(`\nDOCUMENTOS ADJUNTOS A ESTA NEGOCIACIÓN (${docs.length}):`);
              docs.forEach(d=>{
                const uploaded = d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString("es-ES") : "fecha desconocida";
                const typeLabel = d.url ? "URL web" : (d.type||"archivo");
                lines.push(`- ${d.name} (${typeLabel}, subido ${uploaded})`);
                if(d.report){
                  const by = d.analyzedBy ? ` por ${d.analyzedBy}` : "";
                  lines.push(`  Análisis previo${by}:`);
                  if(d.report.summary)         lines.push(`    • Resumen: ${d.report.summary}`);
                  if(d.report.details)         lines.push(`    • Riesgos/oportunidades: ${d.report.details}`);
                  if(d.report.recommendations) lines.push(`    • Recomendaciones: ${d.report.recommendations}`);
                } else {
                  lines.push(`  (Sin analizar — puedes sugerir analizarlo si es relevante)`);
                }
              });
            }
            return lines.join("\n");
          };
          const callAgent = async(userMessage, opts={})=>{
            if(!hector){ onAppendHectorMessage(negotiation.id,{role:"assistant",content:"⚠ No hay agente Héctor configurado. Añádelo desde Agentes IA.",timestamp:new Date().toISOString()}); return null; }
            const coherenceRule = "Mantén coherencia con toda la conversación. Si el usuario dice 'como te decía' o 'lo que te expliqué antes', busca en el historial anterior y conecta.";
            const ceoBlock = formatCeoMemoryForPrompt(ceoMemory);
            const negBlock = formatNegMemoryForPrompt(negotiation.memory);
            const memoryBlock = [ceoBlock, negBlock].filter(Boolean).join("\n\n");
            const system = (hector.promptBase||"")
              + (memoryBlock?("\n\n---\n"+memoryBlock):"")
              + "\n\n---\nCONTEXTO DE ESTA NEGOCIACIÓN:\n" + buildContext()
              + "\n\n" + coherenceRule
              + "\n\n" + PLAIN_TEXT_RULE
              + (opts.extraSystem?("\n\n"+opts.extraSystem):"");
            // Ventana de contexto: ≤30 mensajes se envían enteros. Por encima,
            // primeros 5 (semilla del hilo) + últimos 25 (continuidad reciente).
            const all = negotiation.hectorChat||[];
            const picked = all.length<=30 ? all : [...all.slice(0,5), ...all.slice(-25)];
            const history = picked.map(m=>({role:m.role==="user"?"user":"assistant",content:m.content}));
            history.push({role:"user",content:userMessage});
            return callAgentSafe({system,messages:opts.isolatedHistory?[{role:"user",content:userMessage}]:history,max_tokens:opts.maxTokens||900});
          };
          const handleSend = async(overrideText)=>{
            const txt = (overrideText ?? chatInput).trim(); if(!txt||chatLoading||!hector) return;
            // Corta cualquier lectura en curso — respuesta previa O popover de tarea/proyecto.
            stopSpeaking();
            setSpeakingMsgTs(null);
            setSpeakingKey(null); // limpia estado del popover TTS por coherencia visual
            // Para el mic ANTES de limpiar el input: evita que un interim
            // rezagado repueble el campo, y evita que luego el mic transcriba
            // la voz del TTS de Héctor y la meta de vuelta en el input.
            chatMicRef.current?.stop();
            setChatLoading(true);
            const now=new Date().toISOString();
            onAppendHectorMessage(negotiation.id,{role:"user",content:txt,timestamp:now});
            setChatInput("");
            try{
              const reply = await callAgent(txt);
              const assistantTs = new Date().toISOString();
              const content = reply||"(respuesta vacía)";
              onAppendHectorMessage(negotiation.id,{role:"assistant",content,timestamp:assistantTs});
              // Auto-TTS solo si el turno se inició por voz Y no estamos
              // en iOS. iOS bloquea speechSynthesis fuera de un gesto de
              // usuario, así que en lugar de auto-reproducir mostramos el
              // botón "🔊 Escuchar" junto al mensaje y el usuario lo pulsa.
              if(voiceInitiatedRef.current){
                voiceInitiatedRef.current = false;
                if(!isIOS){
                  setSpeakingMsgTs(assistantTs);
                  speakAgentResponse(content,hector,{onEnd:()=>setSpeakingMsgTs(null)});
                }
              }
              // Auto-aprendizaje fire-and-forget (no bloquea el chat).
              // Envía últimos 4 msgs al LLM con el extractor tipado y
              // rutea cada item según type (preference | keyFact | decision).
              (async()=>{
                console.log("[memory] auto-learn triggered · neg:", negotiation.title, "· hasRouter:", !!onRouteAutoLearn);
                try {
                  const recent = [
                    ...((negotiation.hectorChat||[]).slice(-3)),
                    {role:"user",content:txt,timestamp:now},
                    {role:"assistant",content,timestamp:assistantTs},
                  ];
                  const extracted = await extractMemoryFromChat(recent, negotiation.title);
                  const items = extracted.items || [];
                  if(items.length === 0){
                    console.log("[memory] auto-learn: no items to route");
                    return;
                  }
                  const added = onRouteAutoLearn ? onRouteAutoLearn(items, negotiation.id, negotiation.title) : 0;
                  console.log("[memory] auto-learn done · routed added:", added);
                  if(added>0) onMemorized?.({count: added, agentName: hector?.name||"Agente"});
                } catch(err){
                  console.warn("[memory] auto-learn failed:", err);
                }
              })();
            }catch(e){
              onAppendHectorMessage(negotiation.id,{role:"assistant",content:`⚠ ${e.message||"Error"}`,timestamp:new Date().toISOString()});
              voiceInitiatedRef.current = false; // no leer errores por voz
            }finally{ setChatLoading(false); }
          };
          const handleBriefing = async()=>{
            if(!hector||chatLoading) return;
            setChatLoading(true);
            const now=new Date().toISOString();
            onAppendHectorMessage(negotiation.id,{role:"user",content:negotiation.briefing?"🎯 Actualizar briefing estratégico":"🎯 Pedir briefing estratégico",timestamp:now});
            const userMsg = "Prepárame un briefing estratégico completo de esta negociación. Estructura: 1) Resumen del contexto y situación actual. 2) Objetivos clave para la próxima sesión. 3) Estrategia recomendada (BATNA, palancas, movimientos). 4) Posibles objeciones con respuestas. 5) Próximos pasos accionables y quién hace qué.";
            try{
              const reply = await callAgent(userMsg,{isolatedHistory:true,maxTokens:1400});
              if(reply){
                onAppendHectorMessage(negotiation.id,{role:"assistant",content:reply,timestamp:new Date().toISOString(),kind:"briefing"});
                onSaveBriefing(negotiation.id,{content:reply,generatedAt:new Date().toISOString(),generatedBy:"ai",agentId:hector.id});
              }
            }catch(e){
              onAppendHectorMessage(negotiation.id,{role:"assistant",content:`⚠ ${e.message||"Error"}`,timestamp:new Date().toISOString()});
            }finally{ setChatLoading(false); }
          };
          const handleAnalysis = async()=>{
            if(!hector||chatLoading) return;
            if(criticalTasks.length===0 && relProjs.length===0){
              onAppendHectorMessage(negotiation.id,{role:"assistant",content:"⚠ Sin tareas ni proyectos vinculados que analizar.",timestamp:new Date().toISOString()});
              return;
            }
            setChatLoading(true);
            const taskLines = criticalTasks.map(t=>`- [${t.id}] ${t.title} (${t.projName}·${t.colName}, ${t.dueDate||"sin fecha"})`).join("\n");
            const projLines = relProjs.map(({p,rp,activeCount,overdueCount})=>`- [${p.id}] ${p.name} (${rp.role||"relacionado"}, ${activeCount} activas, ${overdueCount} vencidas)`).join("\n");
            const userMsg = `Analiza cada tarea y proyecto vinculado a esta negociación. Para cada uno da:
1. Análisis en 2-4 frases (directo, sin rodeos, accionable, estilo Chief of Staff).
2. Tags de categorización (máx 2 por item) de esta lista cerrada exacta: "Bloquea negociación", "Decisión Tipo 1", "Decisión Tipo 2", "Riesgo alto", "Riesgo bajo", "Delegable", "Urgente".

Responde EXCLUSIVAMENTE con JSON válido (sin markdown, sin prosa antes o después). Estructura exacta:
{"tasks":{"<task-id>":{"text":"…","tags":["…"]},…},"projects":{"<project-id>":{"text":"…","tags":["…"]},…}}

Usa EXACTAMENTE estos IDs (no inventes):
Proyectos:
${projLines||"(ninguno)"}
Tareas:
${taskLines||"(ninguna)"}`;
            onAppendHectorMessage(negotiation.id,{role:"user",content:"🔍 Pedir análisis batch de tareas y proyectos",timestamp:new Date().toISOString()});
            try{
              const reply = await callAgent(userMsg,{isolatedHistory:true,maxTokens:2400,extraSystem:"En esta solicitud debes responder ÚNICAMENTE con JSON válido. Sin markdown, sin texto antes ni después."});
              let parsed=null;
              try{ parsed = JSON.parse(reply); }
              catch{
                const m = reply?.match(/\{[\s\S]*\}/);
                if(m){ try{ parsed = JSON.parse(m[0]); }catch{} }
              }
              if(!parsed){ throw new Error("No pude parsear el JSON de Héctor. Vuelve a intentarlo."); }
              // Fingerprints para stale detection (commit 3 los usará).
              const fpTask = (t)=>`${t.title}|${t.dueDate||""}|${t.colName||""}|${t.priority||""}`;
              const fpProj = (r)=>`${r.activeCount}|${r.overdueCount}`;
              const tasksOut={};
              for(const id in (parsed.tasks||{})){
                const found = criticalTasks.find(x=>String(x.id)===String(id));
                if(!found) continue;
                const entry = parsed.tasks[id]||{};
                tasksOut[id] = {text:stripMarkdown(entry.text||""),tags:Array.isArray(entry.tags)?entry.tags:[],fp:fpTask(found)};
              }
              const projsOut={};
              for(const id in (parsed.projects||{})){
                const found = relProjs.find(x=>String(x.p.id)===String(id));
                if(!found) continue;
                const entry = parsed.projects[id]||{};
                projsOut[id] = {text:stripMarkdown(entry.text||""),tags:Array.isArray(entry.tags)?entry.tags:[],fp:fpProj(found)};
              }
              const tCount=Object.keys(tasksOut).length, pCount=Object.keys(projsOut).length;
              onSetAnalysis(negotiation.id,{generatedAt:new Date().toISOString(),tasks:tasksOut,projects:projsOut});
              onAppendHectorMessage(negotiation.id,{role:"assistant",content:`✓ Análisis completo guardado: ${tCount} tarea${tCount!==1?"s":""} y ${pCount} proyecto${pCount!==1?"s":""} evaluado${pCount!==1?"s":""}. Hover (desktop) o tap (móvil) sobre cada fila para ver la recomendación de Héctor.`,timestamp:new Date().toISOString(),kind:"analysis"});
            }catch(e){
              onAppendHectorMessage(negotiation.id,{role:"assistant",content:`⚠ Error en análisis: ${e.message||"desconocido"}`,timestamp:new Date().toISOString()});
            }finally{ setChatLoading(false); }
          };
          const chatMsgs = negotiation.hectorChat||[];
          return(
            <div style={{position:"sticky",top:20,background:"#fff",border:"1.5px solid #E5E7EB",borderTop:"4px solid #1D9E75",borderRadius:12,minWidth:0,display:"flex",flexDirection:"column",minHeight:380,maxHeight:"calc(100vh - 60px)",overflow:"hidden"}}>
              {/* Header */}
              <div style={{padding:"12px 16px",borderBottom:"1px solid #F3F4F6",display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:38,height:38,borderRadius:"50%",background:"linear-gradient(135deg,#1D9E75,#0E7C5A)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:700,flexShrink:0}}>H</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:700,color:"#111827"}}>Héctor</div>
                  <div style={{fontSize:11,color:"#6B7280"}}>Chief of Staff Estratégico</div>
                </div>
                {(()=>{
                  const hasErrors = (chatMsgs||[]).some(m=>m.role==="assistant"&&(m.content||"").startsWith("⚠"));
                  return hasErrors ? (
                    <button onClick={()=>onClearHectorErrors(negotiation.id)} title="Limpiar solo mensajes de error" style={{background:"#FEF2F2",border:"0.5px solid #FCA5A5",fontSize:10,cursor:"pointer",color:"#B91C1C",padding:"3px 8px",borderRadius:6,fontFamily:"inherit",fontWeight:600}}>🧹 errores</button>
                  ) : null;
                })()}
                {chatMsgs.length>0&&<button onClick={()=>{ if(window.confirm("¿Limpiar el chat con Héctor? Antes se resumirá y guardará en memoria.")) onSummarizeAndClearChat?.(negotiation.id); }} title="Limpiar todo el chat" style={{background:"none",border:"none",fontSize:14,cursor:"pointer",color:"#9CA3AF"}}>🗑</button>}
              </div>
              {/* Acciones */}
              <div style={{padding:"10px 16px",borderBottom:"1px solid #F3F4F6",display:"flex",gap:8,flexWrap:"wrap"}}>
                <button onClick={handleBriefing} disabled={!hector||chatLoading} title={!hector?"Añade a Héctor como agente IA para usar esto":"Briefing estratégico — se guarda y queda en el chat"} style={{padding:"7px 12px",borderRadius:8,background:hector&&!chatLoading?"#1D9E75":"#E5E7EB",color:hector&&!chatLoading?"#fff":"#9CA3AF",border:"none",fontSize:12,cursor:hector&&!chatLoading?"pointer":"not-allowed",fontWeight:600}}>🎯 {negotiation.briefing?"Actualizar":"Pedir"} briefing</button>
                <button onClick={handleAnalysis} disabled={!hector||chatLoading||(criticalTasks.length===0&&relProjs.length===0)} title="Análisis batch — recomendación por tarea y proyecto" style={{padding:"7px 12px",borderRadius:8,background:hector&&!chatLoading&&(criticalTasks.length>0||relProjs.length>0)?"#378ADD":"#E5E7EB",color:hector&&!chatLoading&&(criticalTasks.length>0||relProjs.length>0)?"#fff":"#9CA3AF",border:"none",fontSize:12,cursor:hector&&!chatLoading&&(criticalTasks.length>0||relProjs.length>0)?"pointer":"not-allowed",fontWeight:600}}>🔍 Análisis</button>
                {negotiation.hectorAnalysis&&<span title={`Análisis generado ${timeAgoIso(negotiation.hectorAnalysis.generatedAt)}`} style={{fontSize:10,color:"#6B7280",display:"inline-flex",alignItems:"center",gap:4,alignSelf:"center"}}>· {Object.keys(negotiation.hectorAnalysis.tasks||{}).length}t/{Object.keys(negotiation.hectorAnalysis.projects||{}).length}p · {timeAgoIso(negotiation.hectorAnalysis.generatedAt)}</span>}
                {chatMsgs.length>0&&(
                  <div style={{marginLeft:"auto",display:"flex",gap:6}}>
                    <ExportPDFButton
                      title={`Chat con Héctor — ${negotiation.title}`}
                      filename={`chat-hector-${negotiation.title.slice(0,40)}`}
                      render={(doc,y)=>renderChat(doc,y,chatMsgs,{userLabel:"Usuario",assistantLabel:"Héctor"})}
                    />
                  </div>
                )}
              </div>
              {/* Mensajes */}
              <div ref={chatScrollRef} style={{flex:1,overflowY:"auto",padding:"14px 16px",display:"flex",flexDirection:"column",gap:10}}>
                {chatMsgs.length===0
                  ? <div style={{textAlign:"center",padding:"26px 10px",color:"#9CA3AF",fontSize:12,fontStyle:"italic"}}>
                      Aún no has consultado a Héctor sobre esta negociación.<br/>
                      Pulsa <b>Pedir briefing</b> o escribe una pregunta abajo.
                    </div>
                  : chatMsgs.map((m,i)=>{
                      const isUser=m.role==="user";
                      const isSpeaking = !isUser && m.timestamp===speakingMsgTs;
                      return(
                        <div key={i} style={{display:"flex",justifyContent:isUser?"flex-end":"flex-start"}}>
                          <div style={{maxWidth:"88%",padding:"9px 12px",borderRadius:10,background:isUser?"#EEEDFE":m.kind==="briefing"?"#F0F9F1":m.kind==="analysis"?"#EFF6FF":"#F9FAFB",border:`1px solid ${isSpeaking?"#10B981":isUser?"#CFC9F3":m.kind==="briefing"?"#86EFAC":m.kind==="analysis"?"#BFDBFE":"#E5E7EB"}`,fontSize:12.5,color:"#1f2937",lineHeight:1.55,whiteSpace:"pre-wrap",position:"relative",transition:"border-color .2s"}}>
                            {isSpeaking&&(
                              <button onClick={e=>{e.stopPropagation();stopSpeaking();setSpeakingMsgTs(null);}} title="Leyendo — click para detener" style={{display:"inline-flex",alignItems:"center",gap:4,padding:"2px 8px",borderRadius:10,background:"#10B981",color:"#fff",border:"none",fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"inherit",marginBottom:6,animation:"tf-speak-pulse 1.4s infinite"}}>🔊 Leyendo</button>
                            )}
                            {m.kind==="briefing"&&<div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}><div style={{fontSize:10,fontWeight:700,color:"#0E7C5A",textTransform:"uppercase",letterSpacing:"0.08em"}}>🎯 Briefing</div><ExportPDFButton title={`Briefing — ${negotiation.title}`} filename={`briefing-${negotiation.title.slice(0,40)}`} render={(doc,y)=>renderSection(doc,y,"Briefing estratégico",m.content,[14,124,90])}/></div>}
                            {m.kind==="analysis"&&<div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}><div style={{fontSize:10,fontWeight:700,color:"#1E40AF",textTransform:"uppercase",letterSpacing:"0.08em"}}>🔍 Análisis batch</div><ExportPDFButton title={`Análisis batch — ${negotiation.title}`} filename={`analisis-${negotiation.title.slice(0,40)}`} render={(doc,y)=>renderAnalysis(doc,y,negotiation.hectorAnalysis,criticalTasks,relProjs)}/></div>}
                            {m.content}
                            <div style={{fontSize:10,color:"#9CA3AF",marginTop:4,opacity:0.8,display:"flex",alignItems:"center",gap:8}}>
                              <span style={{flex:1}}>{m.timestamp?new Date(m.timestamp).toLocaleString("es-ES",{hour:"2-digit",minute:"2-digit",day:"numeric",month:"short"}):""}</span>
                              {!isUser && !isSpeaking && voiceSupported().tts && (
                                <button
                                  onClick={e=>{ e.stopPropagation(); setSpeakingMsgTs(m.timestamp); speakAgentResponse(m.content,hector,{onEnd:()=>setSpeakingMsgTs(null)}); }}
                                  title="Escuchar esta respuesta"
                                  style={{padding:"2px 8px",borderRadius:10,background:"#fff",color:"#1D9E75",border:"1px solid #86EFAC",fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}
                                >🔊 Escuchar</button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                {chatLoading&&(
                  <div style={{display:"flex",justifyContent:"flex-start"}}>
                    <div style={{padding:"9px 12px",borderRadius:10,background:"#F9FAFB",border:"1px solid #E5E7EB",fontSize:12,color:"#6B7280",fontStyle:"italic"}}>⏳ Héctor está respondiendo…</div>
                  </div>
                )}
              </div>
              {/* Aviso: chat demasiado largo. Amarillo 20-29 (ignorable),
                  rojo 30+ (no ignorable). Al superar 30 se re-muestra aunque
                  se hubiera ignorado el amarillo. */}
              {(()=>{
                const N = chatMsgs.length;
                const isRed = N >= 30;
                const isYellow = !isRed && N >= 20 && !banner20Ignored;
                if(!isRed && !isYellow) return null;
                const bg     = isRed?"#FFEBEE":"#FFF8E1";
                const border = isRed?"#E24B4A":"#EF9F27";
                const msg = isRed
                  ? `El chat tiene ${N} mensajes. Las respuestas de Héctor pueden ser imprecisas. Exporta y limpia ahora.`
                  : `El chat tiene ${N} mensajes. Héctor puede perder foco. Te recomiendo exportar a PDF y limpiar el chat. La memoria (🧠) conservará los datos clave.`;
                return(
                  <div style={{margin:"0 12px 8px",padding:"8px 12px",background:bg,border:`1px solid ${border}`,borderRadius:8,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                    <span style={{fontSize:14,flexShrink:0}}>⚠️</span>
                    <div style={{flex:1,minWidth:0,fontSize:11.5,color:"#1F2937",lineHeight:1.4}}>{msg}</div>
                    <div style={{display:"flex",gap:6,flexShrink:0}}>
                      <ExportPDFButton
                        title={`Chat con Héctor — ${negotiation.title}`}
                        filename={`chat-hector-${negotiation.title.slice(0,40)}`}
                        render={(doc,y)=>renderChat(doc,y,chatMsgs,{userLabel:"Usuario",assistantLabel:"Héctor"})}
                        label="Exportar PDF"
                      />
                      <button
                        onClick={()=>{ if(window.confirm("¿Limpiar el chat con Héctor? Antes se resumirá y guardará en memoria.")) onSummarizeAndClearChat?.(negotiation.id); }}
                        style={{padding:"5px 10px",borderRadius:6,background:"#fff",color:"#B91C1C",border:"1px solid #FCA5A5",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}
                      >Limpiar chat</button>
                      {!isRed && (
                        <button
                          onClick={()=>setBanner20Ignored(true)}
                          style={{padding:"5px 10px",borderRadius:6,background:"transparent",color:"#6B7280",border:"1px solid #D1D5DB",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}
                        >Ignorar</button>
                      )}
                    </div>
                  </div>
                );
              })()}
              {/* Input */}
              <div style={{padding:"10px 12px",borderTop:"1px solid #F3F4F6",background:"#FAFAFA",display:"flex",gap:6,alignItems:"center"}}>
                <VoiceMicButton
                  ref={chatMicRef}
                  disabled={!hector||chatLoading}
                  color="#1D9E75"
                  title="Dictar mensaje para Héctor (click para parar)"
                  initialText={chatInput}
                  onStart={()=>{ stopSpeaking(); setSpeakingMsgTs(null); }}
                  onInterim={(t)=>setChatInput(t)}
                  onFinal={(t)=>{ setChatInput(t); voiceInitiatedRef.current=true; }}
                />
                <input
                  value={chatInput}
                  onChange={e=>setChatInput(e.target.value)}
                  onKeyDown={e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); handleSend(); } }}
                  placeholder={hector?"Pregunta a Héctor (Enter para enviar)…":"No hay agente Héctor disponible"}
                  disabled={!hector||chatLoading}
                  style={{flex:1,padding:"8px 10px",borderRadius:8,border:"1px solid #d1d5db",fontSize:12.5,fontFamily:"inherit",outline:"none",background:"#fff"}}
                />
                <button onClick={()=>handleSend()} disabled={!hector||chatLoading||!chatInput.trim()} style={{padding:"8px 14px",borderRadius:8,background:hector&&!chatLoading&&chatInput.trim()?"#1D9E75":"#E5E7EB",color:hector&&!chatLoading&&chatInput.trim()?"#fff":"#9CA3AF",border:"none",fontSize:12,cursor:hector&&!chatLoading&&chatInput.trim()?"pointer":"not-allowed",fontWeight:600,flexShrink:0,fontFamily:"inherit"}}>Enviar</button>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Stakeholders + Relaciones (datos secundarios, full-width bajo el grid) */}
      {((negotiation.stakeholders||[]).length>0)&&(
        <section style={{marginBottom:18}}>
          <div style={{fontSize:11,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>👥 Stakeholders ({negotiation.stakeholders.length})</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:10}}>
            {negotiation.stakeholders.map(s=>(
              <div key={s.id} style={{background:"#fff",border:"1.5px solid #E5E7EB",borderRadius:10,padding:"11px 13px"}}>
                <div style={{fontSize:13,fontWeight:600,color:"#111827",marginBottom:3}}>👤 {s.name}</div>
                <div style={{fontSize:11,color:"#6B7280",marginBottom:4}}>{s.company&&`${s.company} · `}{getStkRole(s.role)} · <b>{getStkInfluence(s.influence)}</b></div>
                {(s.email||s.phone)&&<div style={{fontSize:11,color:"#9CA3AF",marginBottom:4}}>{s.email}{s.email&&s.phone&&" · "}{s.phone}</div>}
                {s.notes&&<div style={{fontSize:11.5,color:"#4B5563",fontStyle:"italic",lineHeight:1.5,marginTop:4}}>{s.notes}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {((negotiation.relationships||[]).length>0)&&(
        <section style={{marginBottom:18}}>
          <div style={{fontSize:11,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>🔗 Relaciones con otras negociaciones ({negotiation.relationships.length})</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:10}}>
            {negotiation.relationships.map(r=>{
              const target = (allNegotiations||[]).find(n=>n.id===r.negotiationId);
              const rt=getRelType(r.type);
              const bg = r.type==="blocks"?"#FEF2F2":r.type==="depends_on"?"#FEF2F2":r.type==="influences"?"#EFF6FF":"#F9FAFB";
              const bd = r.type==="blocks"?"#FCA5A5":r.type==="depends_on"?"#FCA5A5":r.type==="influences"?"#BFDBFE":"#E5E7EB";
              return(
                <div key={r.id} onClick={()=>target&&onOpenRelatedNeg?.(r.negotiationId)} className="tf-lift" style={{background:bg,border:`1.5px solid ${bd}`,borderRadius:10,padding:"11px 13px",cursor:target?"pointer":"default"}}>
                  <div style={{fontSize:12.5,fontWeight:600,color:rt.color,marginBottom:3}}>{rt.icon} {rt.label} {r.critical&&<span style={{marginLeft:6,fontSize:10,padding:"1px 6px",background:"#FEE2E2",color:"#B91C1C",borderRadius:10}}>Crítica</span>}</div>
                  <div style={{fontSize:12.5,fontWeight:600,color:"#111827"}}>{target?.title||"(negociación borrada)"}</div>
                  {r.description&&<div style={{fontSize:11,color:"#4B5563",fontStyle:"italic",marginTop:4,lineHeight:1.5}}>{r.description}</div>}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

// Detalle sesión: notas cronológicas + resumen editable.
function SessionDetailView({negotiation,session,agent,relatedProject,onBack,onEditSession,onAddNote,onEditNote,onUpdateSummary,onToast,onManageAttendees,onRequestAdvice,onGenerateTasks}){
  const [summaryDraft,setSummaryDraft] = useState(session.summary||"");
  const [editingSummary,setEditingSummary] = useState(false);
  const entries = (session.entries||[]).slice().sort((a,b)=>(a.timestamp||"").localeCompare(b.timestamp||""));
  const saveSummary=()=>{ onUpdateSummary(summaryDraft); setEditingSummary(false); onToast?.("✓ Resumen guardado"); };
  const autoSummary=()=>{
    if(entries.length===0){ onToast?.("Añade al menos una nota antes","error"); return; }
    const joined = entries.map(e=>`[${e.timestamp}] ${e.content}`).join("\n");
    const draft = `Sesión: ${getSessionTypeLabel(session.type)} · ${formatDateTimeES(session.date)}\n\nPuntos clave:\n${joined}\n\n(Resumen preliminar — edítalo para añadir conclusiones y próximos pasos.)`;
    setSummaryDraft(draft); setEditingSummary(true);
  };
  return(
    <div style={{maxWidth:820,margin:"0 auto",padding:"30px 20px"}}>
      <button onClick={onBack} style={{background:"none",border:"none",color:"#3B82F6",fontSize:13,cursor:"pointer",marginBottom:14,padding:0,fontFamily:"inherit"}}>← {negotiation.title}</button>
      <div style={{marginBottom:14}}>
        <div style={{fontSize:20,fontWeight:700,color:"#111827",marginBottom:4}}>{getSessionTypeIcon(session.type)} {getSessionTypeLabel(session.type)}</div>
        <div style={{fontSize:13,color:"#6b7280"}}>{formatDateTimeES(session.date)}{session.location?` · ${session.location}`:""} · {session.duration} min</div>
      </div>
      {/* Asistentes */}
      <div style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:10,padding:"12px 14px",marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:(session.attendees||[]).length>0?8:0}}>
          <div style={{fontSize:12,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em"}}>👥 Asistentes ({(session.attendees||[]).length})</div>
          <button onClick={onManageAttendees} style={{fontSize:11,color:"#3B82F6",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",fontWeight:500}}>Gestionar</button>
        </div>
        {(session.attendees||[]).length===0
          ? <div style={{fontSize:12,color:"#9CA3AF",fontStyle:"italic"}}>Sin asistentes registrados. Añade miembros internos o contactos externos.</div>
          : <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {(session.attendees||[]).map(a=>(
                <span key={a.id} title={`${a.name}${a.company?` · ${a.company}`:""} · ${a.role}`} style={{display:"inline-flex",alignItems:"center",gap:4,padding:"4px 10px",background:a.external?"#FEF3C7":"#EFF6FF",border:`1px solid ${a.external?"#FCD34D":"#BFDBFE"}`,borderRadius:14,fontSize:12,color:a.external?"#854F0B":"#1E40AF"}}>{a.lead&&"⭐ "}{a.name}{a.external&&<span style={{fontSize:10,opacity:0.7}}>(Ext)</span>}</span>
              ))}
            </div>}
      </div>

      <div style={{display:"flex",gap:10,marginBottom:22,flexWrap:"wrap"}}>
        <button onClick={onAddNote} style={{padding:"9px 16px",borderRadius:10,background:"#3B82F6",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>+ Añadir nota</button>
        <button onClick={()=>onEditSession(session)} style={{padding:"9px 16px",borderRadius:10,background:"#fff",color:"#374151",border:"0.5px solid #d1d5db",fontSize:13,cursor:"pointer"}}>Editar sesión</button>
        <button onClick={autoSummary} style={{padding:"9px 16px",borderRadius:10,background:"#fff",color:"#3B82F6",border:"0.5px solid #3B82F6",fontSize:13,cursor:"pointer",fontWeight:500}}>✨ Generar resumen</button>
        {agent&&<button onClick={onRequestAdvice} style={{padding:"9px 16px",borderRadius:10,background:"linear-gradient(135deg,#7F77DD,#E76AA1)",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>🤖 Pedir consejo a {agent.name.split(" ")[0]}</button>}
        {relatedProject&&<button onClick={onGenerateTasks} style={{padding:"9px 16px",borderRadius:10,background:"#10B981",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>📋 Generar tareas</button>}
      </div>

      <div style={{fontSize:12,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>Notas ({entries.length})</div>
      {entries.length===0
        ? <div style={{textAlign:"center",padding:30,background:"#F9FAFB",border:"1px dashed #e5e7eb",borderRadius:10,fontSize:13,color:"#6b7280",marginBottom:28}}>
            <div style={{marginBottom:10}}>Aún no hay notas</div>
            <button onClick={onAddNote} style={{padding:"7px 14px",borderRadius:8,background:"#3B82F6",color:"#fff",border:"none",fontSize:12,cursor:"pointer",fontWeight:600}}>+ Añadir primera nota</button>
          </div>
        : entries.map(e=>(
            <div key={e.id} style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:10,padding:"12px 14px",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                <span style={{fontSize:11,fontWeight:700,color:"#6b7280",fontFamily:"ui-monospace,monospace"}}>{e.timestamp}</span>
                <button onClick={()=>onEditNote(e)} style={{fontSize:11,color:"#3B82F6",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit"}}>Editar</button>
              </div>
              <div style={{fontSize:13,color:"#374151",lineHeight:1.55,whiteSpace:"pre-wrap"}}>{e.content}</div>
            </div>
          ))}

      <div style={{marginTop:26,paddingTop:22,borderTop:"2px solid #E5E7EB"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
          <div style={{fontSize:12,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em"}}>Resumen</div>
          {!editingSummary&&<button onClick={()=>{setSummaryDraft(session.summary||"");setEditingSummary(true);}} style={{fontSize:12,color:"#3B82F6",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",fontWeight:500}}>{session.summary?"Editar":"Añadir"}</button>}
        </div>
        {editingSummary
          ? <div>
              <div style={{position:"relative"}}>
                <textarea value={summaryDraft} onChange={e=>setSummaryDraft(e.target.value)} rows={8} placeholder="Escribe un resumen de la sesión: temas, acuerdos, objeciones, próximos pasos…" style={{width:"100%",padding:"10px 42px 10px 12px",borderRadius:8,border:"1px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit",lineHeight:1.55}}/>
                <div style={{position:"absolute",right:6,top:6}}>
                  <VoiceMicButton size="sm" color="#3B82F6" title="Dictar resumen" initialText={summaryDraft} onInterim={t=>setSummaryDraft(t)} onFinal={t=>setSummaryDraft(t)}/>
                </div>
              </div>
              <div style={{display:"flex",gap:8,marginTop:10}}>
                <button onClick={saveSummary} style={{padding:"8px 16px",borderRadius:8,background:"#3B82F6",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>Guardar</button>
                <button onClick={()=>{setEditingSummary(false);setSummaryDraft(session.summary||"");}} style={{padding:"8px 16px",borderRadius:8,background:"transparent",border:"0.5px solid #d1d5db",fontSize:13,cursor:"pointer"}}>Cancelar</button>
              </div>
            </div>
          : session.summary
            ? <div style={{fontSize:13,color:"#374151",lineHeight:1.6,whiteSpace:"pre-wrap"}}>{session.summary}</div>
            : <div style={{fontSize:13,color:"#9CA3AF",fontStyle:"italic"}}>Sin resumen aún.</div>}
      </div>

      {(session.agentConversations||[]).length>0&&(
        <div style={{marginTop:22,paddingTop:20,borderTop:"2px solid #E5E7EB"}}>
          <div style={{fontSize:12,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>🤖 Conversaciones con agente ({session.agentConversations.length})</div>
          {session.agentConversations.slice().reverse().map(c=>(
            <details key={c.id} style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:10,padding:"10px 14px",marginBottom:8}}>
              <summary style={{cursor:"pointer",fontSize:12,fontWeight:600,color:"#374151"}}>
                <span style={{fontFamily:"ui-monospace,monospace",color:"#6B7280",marginRight:8}}>{c.timestamp}</span>
                {c.type==="briefing_request"?"🎯 Briefing":c.type==="live_advice"?"💬 Consejo":"📝 Resumen"}
                <span style={{color:"#9CA3AF",fontWeight:400,marginLeft:6}}>· {timeAgoIso(c.createdAt)}</span>
              </summary>
              <div style={{marginTop:10,fontSize:12.5,color:"#1f2937",lineHeight:1.6,whiteSpace:"pre-wrap",paddingLeft:10,borderLeft:"2px solid #BFDBFE"}}>{c.agentResponse||"(sin respuesta)"}</div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

// Modal gestión de asistentes a una sesión (internos + externos).
function AttendeesModal({session,members,onClose,onSave,onToast}){
  const [attendees,setAttendees] = useState(session.attendees||[]);
  const [showAddExt,setShowAddExt] = useState(false);
  const [extName,setExtName]       = useState("");
  const [extCompany,setExtCompany] = useState("");
  const [extRole,setExtRole]       = useState("");
  const [pendingClose,setPendingClose] = useState(false);
  const [initialSnap]=useState(()=>JSON.stringify(session.attendees||[]));
  const isDirty=JSON.stringify(attendees)!==initialSnap || showAddExt || extName.trim() || extCompany.trim() || extRole.trim();
  const handleClose=()=>{ if(isDirty) setPendingClose(true); else onClose(); };
  useEffect(()=>{ const k=e=>{if(e.key==="Escape") handleClose();}; window.addEventListener("keydown",k); return()=>window.removeEventListener("keydown",k); },[isDirty]);

  const addInternal = (m)=>{
    if(attendees.some(a=>a.memberId===m.id)){ onToast?.("Este miembro ya está en la lista","info"); return; }
    setAttendees([...attendees,{id:_uid("att"),memberId:m.id,name:m.name,company:"SoulBaric",role:m.role||"Miembro del equipo",lead:attendees.length===0,external:false}]);
  };
  const addExternal = ()=>{
    if(!extName.trim()){ onToast?.("Nombre obligatorio","error"); return; }
    setAttendees([...attendees,{id:_uid("att"),memberId:null,name:extName.trim(),company:extCompany.trim(),role:extRole.trim()||"Invitado",lead:false,external:true}]);
    setExtName(""); setExtCompany(""); setExtRole(""); setShowAddExt(false);
  };
  const toggleLead = (id)=>setAttendees(attendees.map(a=>a.id===id?{...a,lead:!a.lead}:a));
  const remove = (id)=>setAttendees(attendees.filter(a=>a.id!==id));

  return(
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&handleClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:3000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:40,overflowY:"auto"}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:620,maxWidth:"96vw",border:"0.5px solid #e5e7eb",borderTop:"4px solid #3B82F6",marginBottom:24}}>
        <div style={{padding:"14px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontWeight:600,fontSize:15}}>👥 Gestionar asistentes</div>
          <button onClick={handleClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#6b7280"}}>×</button>
        </div>
        {pendingClose&&<DiscardBanner onKeep={()=>setPendingClose(false)} onDiscard={()=>{setPendingClose(false);onClose();}}/>}
        <div style={{padding:20,maxHeight:"70vh",overflowY:"auto"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#6B7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>Asistentes ({attendees.length})</div>
          {attendees.length===0
            ? <div style={{fontSize:12,color:"#9CA3AF",fontStyle:"italic",marginBottom:14}}>Aún no hay asistentes. Añade miembros del equipo o externos.</div>
            : <div style={{marginBottom:16}}>{attendees.map(a=>{ const mp2=a.memberId!=null?(MP[a.memberId]||MP[0]):null; return(
                <div key={a.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:10,marginBottom:6}}>
                  <div style={{width:30,height:30,borderRadius:"50%",background:mp2?.solid||"#9CA3AF",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0}}>{a.name.split(" ").map(w=>w[0]||"").join("").slice(0,2).toUpperCase()}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:600,color:"#111827"}}>{a.lead&&"⭐ "}{a.name}{a.external&&<span style={{fontSize:11,color:"#9CA3AF",fontWeight:400,marginLeft:4}}>(Externo)</span>}</div>
                    <div style={{fontSize:11,color:"#6B7280"}}>{a.company?`${a.company} · `:""}{a.role}</div>
                  </div>
                  <button onClick={()=>toggleLead(a.id)} title={a.lead?"Quitar líder":"Marcar como líder"} style={{padding:"6px 9px",borderRadius:6,border:`1px solid ${a.lead?"#FCD34D":"#e5e7eb"}`,background:a.lead?"#FEF3C7":"#fff",fontSize:13,cursor:"pointer"}}>⭐</button>
                  <button onClick={()=>remove(a.id)} title="Eliminar" style={{padding:"6px 9px",borderRadius:6,border:"1px solid #e5e7eb",background:"#fff",fontSize:12,color:"#6B7280",cursor:"pointer"}}>✕</button>
                </div>
              );})}</div>}

          <div style={{fontSize:11,fontWeight:700,color:"#6B7280",textTransform:"uppercase",letterSpacing:"0.08em",marginTop:16,marginBottom:8}}>Añadir miembros del equipo</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:16}}>
            {members.map(m=>{ const already=attendees.some(a=>a.memberId===m.id); const mp2=MP[m.id]||MP[0]; return(
              <button key={m.id} disabled={already} onClick={()=>addInternal(m)} style={{padding:"6px 12px",borderRadius:20,border:`1px solid ${already?"#e5e7eb":mp2.solid+"55"}`,background:already?"#F3F4F6":mp2.light,color:already?"#9CA3AF":mp2.solid,fontSize:12,fontWeight:500,cursor:already?"not-allowed":"pointer",opacity:already?0.6:1}}>{m.name.split(" ")[0]} {already&&"✓"}</button>
            );})}
          </div>

          <div style={{fontSize:11,fontWeight:700,color:"#6B7280",textTransform:"uppercase",letterSpacing:"0.08em",marginTop:16,marginBottom:8}}>Añadir asistente externo</div>
          {!showAddExt
            ? <button onClick={()=>setShowAddExt(true)} style={{padding:"8px 14px",borderRadius:8,background:"#fff",color:"#3B82F6",border:"1px dashed #3B82F6",fontSize:12,cursor:"pointer",fontWeight:500}}>+ Añadir externo</button>
            : <div style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:10,padding:14}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  <div><FL c="Nombre *"/><FI value={extName} onChange={setExtName} placeholder="Ej: Emilio Calvo"/></div>
                  <div><FL c="Empresa"/><FI value={extCompany} onChange={setExtCompany} placeholder="Inversor externo"/></div>
                </div>
                <FL c="Rol"/><FI value={extRole} onChange={setExtRole} placeholder="Inversor principal"/>
                <div style={{display:"flex",gap:6,marginTop:10}}>
                  <button onClick={()=>{setShowAddExt(false);setExtName("");setExtCompany("");setExtRole("");}} style={{padding:"7px 12px",borderRadius:7,background:"transparent",border:"0.5px solid #d1d5db",fontSize:12,cursor:"pointer"}}>Cancelar</button>
                  <button onClick={addExternal} style={{padding:"7px 14px",borderRadius:7,background:"#3B82F6",color:"#fff",border:"none",fontSize:12,cursor:"pointer",fontWeight:600}}>Añadir</button>
                </div>
              </div>}
        </div>
        <div style={{padding:"12px 20px",borderTop:"0.5px solid #e5e7eb",display:"flex",gap:8,justifyContent:"flex-end",background:"#fafafa"}}>
          <button onClick={onClose} style={{padding:"8px 16px",borderRadius:8,border:"0.5px solid #d1d5db",background:"transparent",fontSize:13,cursor:"pointer"}}>Cancelar</button>
          <button onClick={()=>{onSave(attendees);onClose();}} style={{padding:"8px 20px",borderRadius:8,background:"#3B82F6",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>Guardar asistentes</button>
        </div>
      </div>
    </div>
  );
}

// Modal briefing/consejo con agente IA — llama al proxy /api/agent y guarda
// la conversación en session.agentConversations cuando hay sesión asociada.
function AgentBriefingModal({agent,negotiation,session,kind,prompt,initialResponse,onClose,onSavedConversation,onSaveBriefing}){
  const [response,setResponse] = useState(initialResponse||"");
  const [loading,setLoading] = useState(!initialResponse);
  const [error,setError] = useState("");
  const [editedPrompt,setEditedPrompt] = useState(prompt);
  const [saved,setSaved] = useState(false);
  const runQuery = useCallback(async(signalRef)=>{
    setLoading(true); setError("");
    try{
      const baseSystem = (agent.promptBase&&agent.promptBase.trim())
        ? agent.promptBase
        : `Eres ${agent.name}${agent.role?`, especialista en ${agent.role}`:""}. Estilo: ${agent.style||"profesional y directo"}. Responde en español en ${kind==="briefing"?"párrafos claros separados por tema":"tono conciso y accionable"}.`;
      const systemPrompt = baseSystem + "\n\n" + PLAIN_TEXT_RULE;
      const r = await fetch("/api/agent",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({system:systemPrompt,messages:[{role:"user",content:editedPrompt}],max_tokens:900}),
      });
      const data = await r.json();
      if(signalRef.cancelled) return;
      if(!r.ok) throw new Error(data.error||"Error en el agente");
      const txt = stripMarkdown(data.text||"") || "(respuesta vacía)";
      setResponse(txt);
      if(session&&onSavedConversation){
        onSavedConversation({id:_uid("conv"),timestamp:kind==="briefing"?"pre-meeting":new Date().toTimeString().slice(0,5),type:kind==="briefing"?"briefing_request":"live_advice",query:editedPrompt,agentResponse:txt,createdAt:new Date().toISOString(),agentId:agent.id});
      }
    }catch(e){ if(!signalRef.cancelled) setError(e.message||"Error"); }
    finally{ if(!signalRef.cancelled) setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[agent,editedPrompt,kind,session,onSavedConversation]);
  useEffect(()=>{
    if(initialResponse) return; // pre-cargado (editar briefing existente)
    const signal={cancelled:false};
    runQuery(signal);
    return()=>{ signal.cancelled=true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  useEffect(()=>{ const k=e=>{if(e.key==="Escape") onClose();}; window.addEventListener("keydown",k); return()=>window.removeEventListener("keydown",k); },[onClose]);

  const handleSaveBriefing = ()=>{
    if(!response.trim()) return;
    onSaveBriefing?.({content:response.trim(),generatedAt:new Date().toISOString(),generatedBy:initialResponse?"manual":"ai",agentId:agent.id});
    setSaved(true);
    setTimeout(()=>onClose(),600);
  };

  return(
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&onClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:3000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:40,overflowY:"auto"}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:720,maxWidth:"96vw",border:"0.5px solid #e5e7eb",borderTop:`4px solid ${agent.color||"#7F77DD"}`,marginBottom:24}}>
        <div style={{padding:"14px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:40,height:40,borderRadius:10,background:(agent.color||"#7F77DD")+"22",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>{agent.emoji||"🤖"}</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:15,fontWeight:700}}>{kind==="briefing"?"🎯 Briefing":"💬 Consejo en tiempo real"} — {agent.name}</div>
            <div style={{fontSize:11,color:"#6B7280",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{negotiation.title}{session?` · ${formatDateTimeES(session.date)}`:""}</div>
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#6b7280"}}>×</button>
        </div>
        <div style={{padding:20,maxHeight:"70vh",overflowY:"auto"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#6B7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>Contexto enviado al agente</div>
          <textarea value={editedPrompt} onChange={e=>setEditedPrompt(e.target.value)} rows={6} style={{width:"100%",padding:"10px 12px",borderRadius:8,border:"1px solid #d1d5db",fontSize:12.5,resize:"vertical",fontFamily:"ui-monospace,monospace",background:"#F9FAFB",lineHeight:1.55}}/>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:4,marginBottom:14}}>
            <div style={{fontSize:11,color:"#9CA3AF"}}>Puedes editar el contexto y regenerar — {kind==="advice"?"la conversación se guarda automáticamente en la sesión.":"guarda cuando estés listo."}</div>
            <button onClick={()=>runQuery({cancelled:false})} disabled={loading} style={{padding:"5px 12px",borderRadius:6,background:"#fff",color:"#3B82F6",border:"0.5px solid #3B82F6",fontSize:11,cursor:loading?"not-allowed":"pointer",fontWeight:600,fontFamily:"inherit",opacity:loading?0.5:1}}>🔄 Regenerar</button>
          </div>

          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontSize:11,fontWeight:700,color:"#6B7280",textTransform:"uppercase",letterSpacing:"0.08em"}}>Respuesta del agente</div>
            {kind==="briefing"&&!loading&&response&&<div style={{fontSize:10.5,color:"#9CA3AF",fontStyle:"italic"}}>Editable — ajusta antes de guardar</div>}
          </div>
          {loading && <div style={{padding:20,textAlign:"center",color:"#6B7280",fontSize:13}}>⏳ Consultando a {agent.name}…</div>}
          {error && !loading && <div style={{padding:14,background:"#FEE2E2",border:"1px solid #FCA5A5",borderRadius:8,fontSize:12.5,color:"#991B1B"}}>⚠ {error}<div style={{fontSize:11,marginTop:4,color:"#7F1D1D"}}>Revisa ANTHROPIC_API_KEY en Vercel o intenta de nuevo.</div></div>}
          {!loading && !error && response!==undefined && (
            <textarea
              value={response}
              onChange={e=>setResponse(e.target.value)}
              rows={16}
              style={{width:"100%",padding:14,borderRadius:10,background:(agent.color||"#7F77DD")+"08",border:`1px solid ${(agent.color||"#7F77DD")}44`,fontSize:13,color:"#1f2937",lineHeight:1.6,fontFamily:"inherit",resize:"vertical"}}
            />
          )}
        </div>
        <div style={{padding:"12px 20px",borderTop:"0.5px solid #e5e7eb",display:"flex",gap:8,justifyContent:"flex-end",background:"#fafafa",flexWrap:"wrap"}}>
          {!loading && response?.trim() && (
            <>
              <ExportPDFButton
                title={`${kind==="briefing"?"Briefing":"Consejo"} — ${agent.name}${negotiation?` — ${negotiation.title}`:""}`}
                filename={`${kind==="briefing"?"briefing":"consejo"}-${(negotiation?.title||agent.name||"soulbaric").slice(0,40)}`}
                render={(doc,y)=>renderChat(doc,y,[
                  {role:"user",content:(prompt||""),timestamp:new Date().toISOString()},
                  {role:"assistant",content:response.trim(),timestamp:new Date().toISOString(),kind:kind==="briefing"?"briefing":null},
                ],{userLabel:"Pregunta",assistantLabel:agent.name})}
              />
              <PrintButton/>
            </>
          )}
          <button onClick={onClose} style={{padding:"8px 16px",borderRadius:8,background:"transparent",color:"#374151",border:"0.5px solid #d1d5db",fontSize:13,cursor:"pointer"}}>Cerrar</button>
          {kind==="briefing"&&onSaveBriefing&&(
            <button onClick={handleSaveBriefing} disabled={loading||!response.trim()||saved} style={{padding:"8px 20px",borderRadius:8,background:saved?"#10B981":(loading||!response.trim())?"#e5e7eb":agent.color||"#7F77DD",color:(saved||(!loading&&response.trim()))?"#fff":"#9ca3af",border:"none",fontSize:13,cursor:(loading||!response.trim())?"default":"pointer",fontWeight:600}}>{saved?"✓ Guardado":"💾 Guardar como briefing"}</button>
          )}
        </div>
      </div>
    </div>
  );
}

// Detecta compromisos simples por regex (patrón heurístico; FASE 3 usará LLM).
function detectCommitmentsInSession(session){
  const text = `${session.summary||""}\n${(session.entries||[]).map(e=>e.content).join("\n")}`;
  const found = new Set();
  const patterns = [
    /(?:enviar|enviamos)\s+(.{5,80}?)(?:\s+(?:antes de|el|para)\s|[.\n])/gi,
    /(?:preparar|preparamos)\s+(.{5,80}?)(?:\s+(?:para|antes)\s|[.\n])/gi,
    /(?:acord(?:ar|amos)|acuerdo:)\s*(.{5,80}?)(?:[.\n]|$)/gi,
    /(?:próximo paso|siguiente paso|next step):?\s*(.{5,80}?)(?:[.\n]|$)/gi,
    /(?:compromiso|me comprometo a)\s+(.{5,80}?)(?:[.\n]|$)/gi,
  ];
  patterns.forEach(p=>{
    for(const m of text.matchAll(p)){
      const t=(m[1]||"").trim().replace(/["'"",.]+$/,"");
      if(t.length>=5&&t.length<=90) found.add(t);
    }
  });
  return Array.from(found);
}

// Modal generar tareas en proyecto a partir de compromisos detectados.
function GenerateTasksModal({negotiation,session,availableProjects,members,activeMember,onClose,onGenerate}){
  const defaultProjId = availableProjects[0]?.id;
  const [tasks,setTasks] = useState(()=>{
    const detected=detectCommitmentsInSession(session).map(title=>({id:_uid("gt"),title,projectId:defaultProjId,assignee:activeMember,dueDate:"",priority:"media"}));
    return detected.length>0 ? detected : [{id:_uid("gt"),title:"",projectId:defaultProjId,assignee:activeMember,dueDate:"",priority:"media"}];
  });
  const [pendingClose,setPendingClose] = useState(false);
  const [initialSnap]=useState(()=>JSON.stringify(tasks));
  const isDirty=JSON.stringify(tasks)!==initialSnap;
  const handleClose=()=>{ if(isDirty) setPendingClose(true); else onClose(); };
  useEffect(()=>{ const k=e=>{if(e.key==="Escape") handleClose();}; window.addEventListener("keydown",k); return()=>window.removeEventListener("keydown",k); },[isDirty]);
  const update = (i,patch)=>setTasks(ts=>ts.map((t,idx)=>idx===i?{...t,...patch}:t));
  const remove = (i)=>setTasks(ts=>ts.filter((_,idx)=>idx!==i));
  const add    = ()=>setTasks(ts=>[...ts,{id:_uid("gt"),title:"",projectId:defaultProjId,assignee:activeMember,dueDate:"",priority:"media"}]);
  const valid  = tasks.filter(t=>t.title.trim()&&t.projectId);
  const generate = ()=>{ onGenerate(valid); onClose(); };
  return(
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&handleClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:3000,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:40,overflowY:"auto"}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:720,maxWidth:"96vw",border:"0.5px solid #e5e7eb",borderTop:"4px solid #3B82F6",marginBottom:24}}>
        <div style={{padding:"14px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div>
            <div style={{fontWeight:600,fontSize:15}}>📋 Generar tareas desde sesión</div>
            <div style={{fontSize:11,color:"#6b7280",marginTop:2}}>{getSessionTypeLabel(session.type)} · {availableProjects.length} proyecto{availableProjects.length!==1?"s":""} disponibles desde esta negociación</div>
          </div>
          <button onClick={handleClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#6b7280"}}>×</button>
        </div>
        {pendingClose&&<DiscardBanner onKeep={()=>setPendingClose(false)} onDiscard={()=>{setPendingClose(false);onClose();}}/>}
        <div style={{padding:20,maxHeight:"70vh",overflowY:"auto"}}>
          <div style={{fontSize:12.5,color:"#4B5563",marginBottom:14,lineHeight:1.5}}>
            {detectCommitmentsInSession(session).length===0
              ? <>No se detectaron compromisos automáticamente en el resumen ni en las notas. Puedes añadir tareas manualmente abajo. Cada tarea puede ir a un proyecto distinto.</>
              : <>Se detectaron <b style={{color:"#111827"}}>{detectCommitmentsInSession(session).length}</b> compromiso{detectCommitmentsInSession(session).length!==1?"s":""} en esta sesión. Revisa, edita y asigna el proyecto destino — cada tarea se creará con refs a la negociación y a esta sesión.</>}
          </div>

          {tasks.map((t,i)=>(
            <div key={t.id} style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:10,padding:14,marginBottom:10}}>
              <FL c={`Tarea ${i+1}`}/>
              <FI value={t.title} onChange={v=>update(i,{title:v})} placeholder="Ej: Enviar presupuesto revisado"/>
              <div style={{display:"grid",gridTemplateColumns:"1.6fr 1fr 1fr 0.8fr auto",gap:8,marginTop:8,alignItems:"flex-end"}}>
                <div><FL c="Proyecto *"/>
                  <select value={t.projectId||""} onChange={e=>update(i,{projectId:Number(e.target.value)})} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:`0.5px solid ${t.projectId?"#d1d5db":"#FCA5A5"}`,fontSize:12,fontFamily:"inherit",background:"#fff"}}>
                    <option value="">— Seleccionar —</option>
                    {availableProjects.map(p=><option key={p.id} value={p.id}>{p.emoji||"📋"} {p.name}</option>)}
                  </select>
                </div>
                <div><FL c="Asignado a"/>
                  <select value={t.assignee} onChange={e=>update(i,{assignee:Number(e.target.value)})} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:12,fontFamily:"inherit",background:"#fff"}}>
                    {members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div><FL c="Fecha límite"/>
                  <input type="date" value={t.dueDate} onChange={e=>update(i,{dueDate:e.target.value})} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:12,fontFamily:"inherit"}}/></div>
                <div><FL c="Prioridad"/>
                  <select value={t.priority} onChange={e=>update(i,{priority:e.target.value})} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:12,fontFamily:"inherit",background:"#fff"}}>
                    <option value="alta">Alta</option><option value="media">Media</option><option value="baja">Baja</option>
                  </select>
                </div>
                <button onClick={()=>remove(i)} title="Eliminar" style={{padding:"7px 10px",borderRadius:8,background:"#FEE2E2",color:"#B91C1C",border:"1px solid #FCA5A5",fontSize:12,cursor:"pointer"}}>✕</button>
              </div>
              <div style={{fontSize:10.5,color:"#9CA3AF",marginTop:6,fontStyle:"italic"}}>🔗 Se creará con refs: negociación "{negotiation.title}" + sesión {getSessionTypeLabel(session.type)}</div>
            </div>
          ))}
          <button onClick={add} style={{width:"100%",padding:"9px 14px",background:"#fff",color:"#3B82F6",border:"1px dashed #3B82F6",borderRadius:8,fontSize:13,cursor:"pointer",fontWeight:500}}>+ Añadir tarea manual</button>
        </div>
        <div style={{padding:"12px 20px",borderTop:"0.5px solid #e5e7eb",display:"flex",gap:8,justifyContent:"flex-end",background:"#fafafa"}}>
          <button onClick={onClose} style={{padding:"8px 16px",borderRadius:8,border:"0.5px solid #d1d5db",background:"transparent",fontSize:13,cursor:"pointer"}}>Cancelar</button>
          <button onClick={generate} disabled={valid.length===0} style={{padding:"8px 20px",borderRadius:8,background:valid.length>0?"#3B82F6":"#e5e7eb",color:valid.length>0?"#fff":"#9ca3af",border:"none",fontSize:13,cursor:valid.length>0?"pointer":"default",fontWeight:600}}>Crear {valid.length||0} tarea{valid.length!==1?"s":""}</button>
        </div>
      </div>
    </div>
  );
}

// ── Mis tareas (vista global tipo "My Issues") ───────────────────────────────
function MyTasksView({data,activeMember,onOpenTask,onNavigate}){
  const [filter,setFilter] = useState("all"); // all | overdue | today | soon | done
  const me = data.members.find(m=>m.id===activeMember);
  const allMine = [];
  Object.entries(data.boards||{}).forEach(([pid,cols])=>{
    const proj=data.projects.find(p=>p.id===Number(pid));
    cols.forEach(col=>col.tasks.forEach(t=>{
      if(!t.assignees?.includes(activeMember)) return;
      allMine.push({...t, colName:col.name, colId:col.id, projId:Number(pid), projName:proj?.name||"", projEmoji:proj?.emoji||"📋", projColor:proj?.color||"#7F77DD"});
    }));
  });
  const today = fmt(TODAY);
  const counts = {
    all:      allMine.length,
    overdue:  allMine.filter(t=>t.colName!=="Hecho"&&t.dueDate&&daysUntil(t.dueDate)<0).length,
    today:    allMine.filter(t=>t.colName!=="Hecho"&&t.dueDate&&daysUntil(t.dueDate)===0).length,
    soon:     allMine.filter(t=>t.colName!=="Hecho"&&t.dueDate&&daysUntil(t.dueDate)>0&&daysUntil(t.dueDate)<=7).length,
    done:     allMine.filter(t=>t.colName==="Hecho").length,
  };
  let filtered=allMine;
  if(filter==="overdue") filtered = allMine.filter(t=>t.colName!=="Hecho"&&t.dueDate&&daysUntil(t.dueDate)<0);
  else if(filter==="today") filtered = allMine.filter(t=>t.colName!=="Hecho"&&t.dueDate&&daysUntil(t.dueDate)===0);
  else if(filter==="soon") filtered = allMine.filter(t=>t.colName!=="Hecho"&&t.dueDate&&daysUntil(t.dueDate)>0&&daysUntil(t.dueDate)<=7);
  else if(filter==="done") filtered = allMine.filter(t=>t.colName==="Hecho");
  // Sort: overdue/today first, then by due date asc, then by project
  filtered = filtered.slice().sort((a,b)=>{
    const da=a.dueDate?daysUntil(a.dueDate):9999;
    const db=b.dueDate?daysUntil(b.dueDate):9999;
    if(da!==db) return da-db;
    return (a.projName||"").localeCompare(b.projName||"");
  });
  const FILTERS=[["all","Todas"],["overdue","Vencidas"],["today","Hoy"],["soon","Próximos 7d"],["done","Hechas"]];

  return(
    <div style={{maxWidth:900,margin:"0 auto",padding:"30px 20px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18,flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:22,fontWeight:700,marginBottom:4}}>✅ Mis tareas</div>
          <div style={{fontSize:13,color:"#6b7280"}}>{me?.name} · {allMine.length} tarea{allMine.length!==1?"s":""} asignada{allMine.length!==1?"s":""}</div>
        </div>
      </div>

      <div style={{display:"flex",gap:6,marginBottom:18,flexWrap:"wrap"}}>
        {FILTERS.map(([k,label])=>{
          const sel=filter===k;
          const n=counts[k]||0;
          return <button key={k} onClick={()=>setFilter(k)} style={{padding:"6px 14px",borderRadius:20,border:`1px solid ${sel?"#3B82F6":"#e5e7eb"}`,background:sel?"#3B82F6":"#fff",color:sel?"#fff":"#6b7280",fontSize:12,cursor:"pointer",fontWeight:sel?600:400,fontFamily:"inherit"}}>{label} ({n})</button>;
        })}
      </div>

      {filtered.length===0
        ? <div style={{textAlign:"center",padding:"50px 20px",background:"#F9FAFB",border:"1px dashed #e5e7eb",borderRadius:12}}>
            <div style={{fontSize:30,marginBottom:10}}>{filter==="done"?"🎉":"✨"}</div>
            <div style={{fontSize:14,color:"#6b7280",marginBottom:8}}>{filter==="all"?"No tienes tareas asignadas":filter==="overdue"?"Sin tareas vencidas — bien hecho":filter==="today"?"Nada vence hoy":filter==="soon"?"Sin tareas en los próximos 7 días":"Aún no has completado tareas"}</div>
            <button onClick={()=>onNavigate("projects")} style={{padding:"8px 16px",borderRadius:8,background:"transparent",color:"#3B82F6",border:"0.5px solid #3B82F6",fontSize:12,cursor:"pointer",fontWeight:500}}>Ir a Proyectos →</button>
          </div>
        : <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {filtered.map(t=>{
              const days=t.dueDate?daysUntil(t.dueDate):null;
              const q=getQ(t);
              const dueLabel = !t.dueDate ? "Sin fecha" : days<0 ? `Vencida hace ${-days}d` : days===0 ? "Vence hoy" : days<=7 ? `En ${days}d` : `En ${days}d`;
              const dueColor = !t.dueDate ? "#9CA3AF" : days<0 ? "#E24B4A" : days===0 ? "#EF9F27" : "#6b7280";
              return(
                <div key={`${t.projId}-${t.id}`} onClick={()=>onOpenTask(t.id)} className="tf-lift" style={{background:"#fff",border:"1px solid #E5E7EB",borderLeft:`4px solid ${t.projColor}`,borderRadius:10,padding:"11px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:12}}>
                  <QBadge q={q}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:500,color:"#111827",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.title}</div>
                    <div style={{fontSize:11,color:"#6B7280",marginTop:2}}>{t.projEmoji} {t.projName} · {t.colName} · <span style={{color:dueColor,fontWeight:500}}>{dueLabel}</span></div>
                  </div>
                  <PriBadge p={t.priority}/>
                </div>
              );
            })}
          </div>}
    </div>
  );
}

// ── Briefings IA (vista global) ──────────────────────────────────────────────
// ── Memoria: panel visible con secciones colapsables ────────────────────────
// Reutilizable. sections = [{ key, label, items, emptyMsg }].
// Modo "global" (ceoMemory, sin neg) y modo "neg" (ceoMemory + negMemory).
function MemorySection({label, category, items, onAdd, onRemove, open, onToggle}){
  const [newText,setNewText] = useState("");
  const submit = ()=>{ const t=newText.trim(); if(!t) return; onAdd?.(category, t); setNewText(""); };
  return(
    <section style={{border:"1px solid #E5E7EB",borderRadius:10,overflow:"hidden",marginBottom:10,background:"#fff"}}>
      <button onClick={onToggle} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"10px 14px",background:open?"#F5F3FF":"#fff",border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:600,color:"#111827",textAlign:"left",transition:"background .12s"}}>
        <span style={{fontSize:11,color:"#9CA3AF"}}>{open?"▼":"▶"}</span>
        <span style={{flex:1}}>{label}</span>
        <span style={{fontSize:11,color:"#6B7280",background:"#F3F4F6",padding:"2px 8px",borderRadius:10,fontWeight:500}}>{items.length}</span>
      </button>
      {open && (
        <div style={{padding:"6px 14px 12px"}}>
          {items.length===0 && <div style={{fontSize:12,color:"#9CA3AF",fontStyle:"italic",padding:"6px 0"}}>Aún sin entradas. Añade una manualmente o espera a que el agente aprenda.</div>}
          {items.length>0 && (
            <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:10}}>
              {items.slice().reverse().map(item=>(
                <div key={item.id} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"8px 10px",background:"#F9FAFB",borderRadius:8,borderLeft:`3px solid ${item.source&&item.source!=="manual"?"#378ADD":"#7F77DD"}`}}>
                  <div style={{flex:1,minWidth:0,fontSize:12.5,lineHeight:1.5,color:"#1F2937"}}>
                    {item.text}
                    {item.negotiationTitle && <div style={{fontSize:10,color:"#9CA3AF",marginTop:2,fontStyle:"italic"}}>↳ de "{item.negotiationTitle}"</div>}
                  </div>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2,flexShrink:0}}>
                    <span style={{fontSize:10,color:item.source&&item.source!=="manual"?"#1E40AF":"#6D28D9",background:item.source&&item.source!=="manual"?"#DBEAFE":"#EDE9FE",padding:"1px 6px",borderRadius:4,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.04em"}}>{item.source&&item.source!=="manual"?(item.source==="auto-summary"?"resumen":"auto"):"manual"}</span>
                    <span style={{fontSize:10,color:"#9CA3AF"}}>{new Date(item.createdAt).toLocaleDateString("es-ES")}</span>
                  </div>
                  <button onClick={()=>onRemove?.(category,item.id)} title="Eliminar" style={{width:22,height:22,borderRadius:5,background:"transparent",border:"none",cursor:"pointer",fontSize:13,color:"#B91C1C",padding:0,flexShrink:0}}>✕</button>
                </div>
              ))}
            </div>
          )}
          <div style={{display:"flex",gap:6}}>
            <input
              value={newText}
              onChange={e=>setNewText(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter"){ e.preventDefault(); submit(); } }}
              placeholder="Añadir entrada manual…"
              style={{flex:1,padding:"6px 10px",borderRadius:6,border:"1px solid #D1D5DB",fontSize:12,fontFamily:"inherit",outline:"none"}}
            />
            <button onClick={submit} disabled={!newText.trim()} style={{padding:"6px 12px",borderRadius:6,background:newText.trim()?"#7F77DD":"#E5E7EB",color:newText.trim()?"#fff":"#9CA3AF",border:"none",fontSize:12,fontWeight:600,cursor:newText.trim()?"pointer":"default",fontFamily:"inherit"}}>+ Añadir</button>
          </div>
        </div>
      )}
    </section>
  );
}

function MemoryPanel({ceoMemory, negotiation, onAddCeo, onRemoveCeo, onAddNeg, onRemoveNeg}){
  const [openKey,setOpenKey] = useState("preferences");
  const toggle = (k)=> setOpenKey(v=>v===k?null:k);

  const ceoSections = [
    { key:"preferences", label:"🎯 Preferencias del CEO", items: ceoMemory?.preferences||[] },
    { key:"keyFacts",    label:"📌 Hechos clave",         items: ceoMemory?.keyFacts||[] },
    { key:"decisions",   label:"⚖️ Decisiones anteriores",items: ceoMemory?.decisions||[] },
    { key:"lessons",     label:"💡 Lecciones aprendidas", items: ceoMemory?.lessons||[] },
  ];
  const negSections = negotiation ? [
    { key:"keyFacts",   label:"📍 Hechos de la negociación", items: negotiation.memory?.keyFacts||[] },
    { key:"agreements", label:"🤝 Acuerdos alcanzados",      items: negotiation.memory?.agreements||[] },
    { key:"redFlags",   label:"🚩 Red flags detectadas",     items: negotiation.memory?.redFlags||[] },
  ] : [];

  const totalCeo = ceoSections.reduce((s,x)=>s+x.items.length,0);
  const totalNeg = negSections.reduce((s,x)=>s+x.items.length,0);

  const renderPDF = (pdfDoc, y)=>{
    const title = negotiation ? `Memoria — ${negotiation.title}` : "Memoria global del CEO";
    pdfDoc.setFont("helvetica","bold"); pdfDoc.setFontSize(11);
    pdfDoc.setTextColor(127,119,221);
    pdfDoc.text("MEMORIA GLOBAL DEL CEO", PDF_MARGIN_L, y); y += 6;
    pdfDoc.setDrawColor(127,119,221); pdfDoc.setLineWidth(0.3);
    pdfDoc.line(PDF_MARGIN_L, y, PDF_MARGIN_L+PDF_CONTENT_W, y); y += 5;
    for(const s of ceoSections){
      if(s.items.length===0) continue;
      y = renderSection(pdfDoc, y, s.label.replace(/[^\w ]/g,"").trim(),
        s.items.map(i=>`• ${i.text}`).join("\n"), [127,119,221]);
    }
    if(negotiation){
      y += 4;
      y = pdfCheckPageBreak(pdfDoc, y, 10);
      pdfDoc.setFont("helvetica","bold"); pdfDoc.setFontSize(11);
      pdfDoc.setTextColor(29,158,117);
      pdfDoc.text(`MEMORIA DE LA NEGOCIACIÓN: ${negotiation.title}`, PDF_MARGIN_L, y); y += 6;
      pdfDoc.setDrawColor(29,158,117);
      pdfDoc.line(PDF_MARGIN_L, y, PDF_MARGIN_L+PDF_CONTENT_W, y); y += 5;
      for(const s of negSections){
        if(s.items.length===0) continue;
        y = renderSection(pdfDoc, y, s.label.replace(/[^\w ]/g,"").trim(),
          s.items.map(i=>`• ${i.text}`).join("\n"), [29,158,117]);
      }
    }
    return y;
  };

  return(
    <div style={{maxWidth:860,margin:"0 auto",padding:"30px 20px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:20,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:22,fontWeight:700,marginBottom:4,display:"flex",alignItems:"center",gap:8}}>🧠 Memoria</div>
          <div style={{fontSize:13,color:"#6b7280"}}>
            {negotiation ? <>Memoria global ({totalCeo}) + memoria de "{negotiation.title}" ({totalNeg})</>
                          : <>Memoria permanente del CEO — {totalCeo} entradas en {ceoSections.length} categorías</>}
          </div>
        </div>
        <ExportPDFButton
          title={negotiation?`Memoria — ${negotiation.title}`:"Memoria global del CEO"}
          filename={negotiation?`memoria-${negotiation.title.slice(0,40)}`:"memoria-ceo"}
          render={renderPDF}
          size="md"
          label="Exportar memoria"
        />
      </div>

      <div style={{fontSize:11,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>Memoria global</div>
      {ceoSections.map(s=>(
        <MemorySection
          key={s.key}
          label={s.label}
          category={s.key}
          items={s.items}
          open={openKey===`ceo-${s.key}`}
          onToggle={()=>toggle(`ceo-${s.key}`)}
          onAdd={(cat,text)=>onAddCeo?.({[cat]:[text]}, "manual")}
          onRemove={(cat,id)=>onRemoveCeo?.(cat,id)}
        />
      ))}

      {negotiation && (
        <>
          <div style={{fontSize:11,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",margin:"18px 0 10px"}}>Memoria de esta negociación</div>
          {negSections.map(s=>(
            <MemorySection
              key={s.key}
              label={s.label}
              category={s.key}
              items={s.items}
              open={openKey===`neg-${s.key}`}
              onToggle={()=>toggle(`neg-${s.key}`)}
              onAdd={(cat,text)=>onAddNeg?.(negotiation.id,{[cat]:[text]}, "manual")}
              onRemove={(cat,id)=>onRemoveNeg?.(negotiation.id,cat,id)}
            />
          ))}
        </>
      )}
    </div>
  );
}

function BriefingsView({data,onOpenNeg,onOpenSession}){
  const briefings=[]; const conversations=[];
  (data.negotiations||[]).forEach(n=>{
    if(n.briefing?.content){
      const agent = n.agentId ? (data.agents||[]).find(a=>a.id===n.agentId) : null;
      briefings.push({neg:n, briefing:n.briefing, agent});
    }
    (n.sessions||[]).forEach(s=>{
      (s.agentConversations||[]).forEach(c=>{
        const agent = c.agentId ? (data.agents||[]).find(a=>a.id===c.agentId) : (n.agentId ? (data.agents||[]).find(a=>a.id===n.agentId) : null);
        conversations.push({neg:n, sess:s, conv:c, agent});
      });
    });
  });
  briefings.sort((a,b)=>new Date(b.briefing.generatedAt||0)-new Date(a.briefing.generatedAt||0));
  conversations.sort((a,b)=>new Date(b.conv.createdAt||0)-new Date(a.conv.createdAt||0));
  const recentConversations = conversations.slice(0,10);

  return(
    <div style={{maxWidth:920,margin:"0 auto",padding:"30px 20px"}}>
      <div style={{marginBottom:20}}>
        <div style={{fontSize:22,fontWeight:700,marginBottom:4}}>🧠 Briefings IA</div>
        <div style={{fontSize:13,color:"#6b7280"}}>{briefings.length} briefing{briefings.length!==1?"s":""} guardado{briefings.length!==1?"s":""} · {conversations.length} conversación{conversations.length!==1?"es":""} totales con agentes</div>
      </div>

      <div style={{fontSize:12,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>📋 Briefings guardados ({briefings.length})</div>
      {briefings.length===0
        ? <div style={{padding:"20px",background:"#F9FAFB",border:"1px dashed #e5e7eb",borderRadius:10,fontSize:13,color:"#9CA3AF",fontStyle:"italic",marginBottom:26}}>Sin briefings guardados. Asigna un agente IA a una negociación y pide su briefing desde el Deal Room.</div>
        : <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:26}}>
            {briefings.map(({neg,briefing,agent})=>{
              const preview = briefing.content.length>300 ? briefing.content.slice(0,300)+"…" : briefing.content;
              return(
                <div key={neg.id} className="tf-lift" style={{background:"#fff",border:"2px solid #E5E7EB",borderLeft:`4px solid ${agent?.color||"#7F77DD"}`,borderRadius:12,padding:"14px 16px"}}>
                  <div onClick={()=>onOpenNeg(neg.id)} style={{cursor:"pointer"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:6,flexWrap:"wrap"}}>
                      <div style={{fontSize:14,fontWeight:600,color:"#111827"}}>💼 {neg.title}</div>
                      <div style={{fontSize:11,color:"#9CA3AF"}}>{agent?`${agent.emoji||"🤖"} ${agent.name} · `:""}{timeAgoIso(briefing.generatedAt)}</div>
                    </div>
                    <div style={{fontSize:12.5,color:"#4B5563",lineHeight:1.55,whiteSpace:"pre-wrap",background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:8,padding:"10px 12px",maxHeight:180,overflow:"hidden"}}>{preview}</div>
                  </div>
                  <div onClick={e=>e.stopPropagation()} style={{marginTop:8,display:"flex",gap:6,justifyContent:"flex-end"}}>
                    <ExportPDFButton
                      title={`Briefing — ${neg.title}`}
                      filename={`briefing-${neg.title.slice(0,40)}`}
                      render={(doc,y)=>renderSection(doc,y,"Briefing estratégico",briefing.content,[14,124,90])}
                    />
                  </div>
                </div>
              );
            })}
          </div>}

      <div style={{fontSize:12,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>🤖 Conversaciones recientes ({recentConversations.length})</div>
      {recentConversations.length===0
        ? <div style={{padding:"20px",background:"#F9FAFB",border:"1px dashed #e5e7eb",borderRadius:10,fontSize:13,color:"#9CA3AF",fontStyle:"italic"}}>Sin conversaciones. Usa "🤖 Pedir consejo" en una sesión activa.</div>
        : <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {recentConversations.map(({neg,sess,conv,agent})=>{
              const queryPrev = (conv.query||"").split("\n")[0].slice(0,120);
              const respPrev = (conv.agentResponse||"").slice(0,240);
              const typeLabel = conv.type==="briefing_request"?"🎯 Briefing":conv.type==="live_advice"?"💬 Consejo":"📝 Conversación";
              return(
                <div key={conv.id} onClick={()=>onOpenSession(neg.id,sess.id)} className="tf-lift" style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:10,padding:"12px 14px",cursor:"pointer"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:6,flexWrap:"wrap"}}>
                    <div style={{fontSize:12.5,fontWeight:600,color:"#111827"}}>{typeLabel} · {neg.title}</div>
                    <div style={{fontSize:11,color:"#9CA3AF"}}>{agent?`${agent.emoji||"🤖"} ${agent.name} · `:""}{timeAgoIso(conv.createdAt)}</div>
                  </div>
                  {queryPrev&&<div style={{fontSize:11.5,color:"#6B7280",marginBottom:4,fontStyle:"italic"}}>❓ {queryPrev}{(conv.query||"").length>120?"…":""}</div>}
                  <div style={{fontSize:12,color:"#374151",lineHeight:1.5,whiteSpace:"pre-wrap"}}>{respPrev}{(conv.agentResponse||"").length>240?"…":""}</div>
                </div>
              );
            })}
          </div>}
    </div>
  );
}

// ── Shortcuts cheatsheet ─────────────────────────────────────────────────────
function ShortcutsModal({onClose}){
  useEffect(()=>{ const k=e=>{if(e.key==="Escape") onClose();}; window.addEventListener("keydown",k); return()=>window.removeEventListener("keydown",k); },[onClose]);
  const GROUPS = [
    { title:"Navegación", items:[
      [["⌘","⇧","H"], "Ir a Home"],
      [["⌘","⇧","D"], "Ir a Deal Room"],
      [["⌘","⇧","T"], "Ir a Mis tareas"],
      [["⌘","⇧","P"], "Ir a Proyectos"],
      [["⌘","⇧","W"], "Ir a Workspaces"],
      [["⌘","⇧","A"], "Ir a Dashboard"],
      [["⌘","⇧","B"], "Ir a Briefings IA"],
      [["⌘","⇧","M"], "Ir a Memoria"],
    ]},
    { title:"Acciones", items:[
      [["⌘","K"],     "Abrir buscador / Command Palette"],
      [["⌘","⇧","N"], "Abrir menú «Nueva…»"],
      [["?"],         "Abrir este panel de atajos"],
    ]},
    { title:"Interfaz", items:[
      [["⌘","\\"],    "Colapsar / expandir sidebar"],
      [["Esc"],       "Cerrar modal, popover o menú activo"],
    ]},
  ];
  const kbdStyle = {fontSize:11,padding:"2px 7px",border:"0.5px solid #d1d5db",borderRadius:5,background:"#fff",color:"#374151",fontFamily:"ui-monospace,monospace",fontWeight:600,minWidth:22,textAlign:"center",display:"inline-block",boxShadow:"0 1px 0 #e5e7eb"};
  return(
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:3500,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:14,width:520,maxWidth:"96vw",maxHeight:"86vh",overflowY:"auto",border:"0.5px solid #e5e7eb"}}>
        <div style={{padding:"16px 22px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontSize:15,fontWeight:700}}>⌨️ Atajos de teclado</div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:"#6b7280"}}>×</button>
        </div>
        <div style={{padding:"16px 22px 20px"}}>
          {GROUPS.map((g,gi)=>(
            <div key={g.title} style={{marginBottom:gi===GROUPS.length-1?0:18}}>
              <div style={{fontSize:11,fontWeight:700,color:"#6B7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>{g.title}</div>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <tbody>
                  {g.items.map(([keys,desc],i)=>(
                    <tr key={i} style={{borderBottom:i===g.items.length-1?"none":"1px solid #F3F4F6"}}>
                      <td style={{padding:"8px 0",width:140}}>{keys.map((k,ki)=>(
                        <React.Fragment key={ki}>
                          {ki>0&&<span style={{color:"#D1D5DB",margin:"0 3px"}}>+</span>}
                          <kbd style={kbdStyle}>{k}</kbd>
                        </React.Fragment>
                      ))}</td>
                      <td style={{padding:"8px 0",fontSize:13,color:"#374151"}}>{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <div style={{fontSize:11,color:"#9CA3AF",marginTop:16,paddingTop:14,borderTop:"0.5px solid #E5E7EB",fontStyle:"italic"}}>En Windows/Linux, ⌘ = Ctrl. Los atajos con ⌘⇧ se bloquean si hay un input focuseado — excepto ⌘K que siempre funciona.</div>
        </div>
      </div>
    </div>
  );
}

// ── User selector (temporal, pre-auth) ────────────────────────────────────────
const USER_KEY = "taskflow_current_user";
const readStoredUser = () => { try{ const s=localStorage.getItem(USER_KEY); return s?JSON.parse(s):null; }catch{ return null; } };
const writeStoredUser = u => { try{ localStorage.setItem(USER_KEY,JSON.stringify({id:u.id,name:u.name,email:u.email})); }catch{} };
const clearStoredUser = () => { try{ localStorage.removeItem(USER_KEY); }catch{} };

// Modal bloqueante de selección inicial. Sin backdrop-close, sin X, sin Esc.
function UserSelectionModal({members,onSelectUser}){
  const [selectedId,setSelectedId] = useState(null);
  const [leaving,setLeaving] = useState(false);
  const canContinue = selectedId!==null;
  const commit = () => {
    const m = members.find(x=>x.id===selectedId); if(!m) return;
    setLeaving(true);
    setTimeout(()=>onSelectUser(m),200);
  };
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(17,24,39,0.65)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20,animation:"tf-fade-in .2s ease",opacity:leaving?0:1,transition:"opacity .2s"}}>
      <div style={{background:"#fff",borderRadius:16,width:480,maxWidth:"96vw",maxHeight:"92vh",display:"flex",flexDirection:"column",borderTop:"4px solid #7F77DD",boxShadow:"0 20px 60px rgba(0,0,0,0.25)"}}>
        <div style={{padding:"20px 24px 10px",textAlign:"center"}}>
          <div style={{fontSize:18,fontWeight:700,marginBottom:4}}>Bienvenido a SoulBaric</div>
          <div style={{fontSize:13,color:"#6b7280"}}>Selecciona tu usuario:</div>
        </div>
        <div style={{padding:"6px 16px 10px",overflowY:"auto",flex:1,display:"flex",flexDirection:"column",gap:8}}>
          {members.map(m=>{
            const mp2 = MP[m.id]||MP[0];
            const sel = selectedId===m.id;
            return(
              <div key={m.id} onClick={()=>setSelectedId(m.id)} className="tf-lift" style={{display:"flex",alignItems:"center",gap:12,padding:"11px 14px",border:`1.5px solid ${sel?mp2.solid:"#e5e7eb"}`,borderRadius:10,background:sel?mp2.light:"#fff",cursor:"pointer",transition:"background .15s, border-color .15s"}}>
                <div style={{width:20,height:20,borderRadius:"50%",border:`2px solid ${sel?mp2.solid:"#d1d5db"}`,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {sel && <div style={{width:10,height:10,borderRadius:"50%",background:mp2.solid}}/>}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,color:sel?mp2.solid:"#111827"}}>{m.name}</div>
                  <div style={{fontSize:11,color:"#6b7280",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.email}</div>
                </div>
                <div style={{width:34,height:34,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{m.initials}</div>
              </div>
            );
          })}
        </div>
        <div style={{padding:"14px 24px 10px",borderTop:"0.5px solid #f3f4f6",display:"flex",justifyContent:"center"}}>
          <button onClick={commit} disabled={!canContinue} style={{padding:"10px 28px",borderRadius:10,background:canContinue?"#378ADD":"#e5e7eb",color:canContinue?"#fff":"#9ca3af",border:"none",fontSize:14,fontWeight:600,cursor:canContinue?"pointer":"not-allowed",transition:"background .15s"}}>Continuar →</button>
        </div>
        <div style={{padding:"6px 24px 18px",fontSize:11,color:"#9ca3af",textAlign:"center",fontStyle:"italic"}}>Nota: Sistema temporal. Login completo próximamente.</div>
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function TaskFlow(){
  const [data,setData]             = useState(_saved);
  // Espejo de `data` en ref para leer estado actual desde callbacks sin
  // depender del timing de setState (útil en flujos async como auto-learn
  // de memoria, donde queremos devolver el nº de items añadidos al caller
  // sincrónicamente).
  const dataRef = useRef(_saved);
  useEffect(()=>{ dataRef.current = data; },[data]);
  const isRemoteUpdate             = useRef(false);
  const [syncReady,setSyncReady]   = useState(!syncEnabled);
  const [syncStatus,setSyncStatus] = useState(syncEnabled?"connecting":"off");
  const [activeProject,setAP]      = useState(0);
  const [activeTab,setActiveTab]   = useState("home");
  const [activeMember,setAM]       = useState(()=>{ const u=readStoredUser(); return typeof u?.id==="number"?u.id:5; });
  // isAdmin: lee accountRole del miembro activo. Cuando hay sesión
  // Supabase Auth, activeMember se resuelve por email tras login. Sin
  // sesión y con user picker legacy, se sigue usando para gate de
  // permisos. Default seguro a "member" si el miembro no existe.
  const isAdmin = (data.members||[]).find(m=>m.id===activeMember)?.accountRole === "admin";
  // Sesión Supabase Auth (Fix 3). authReady: false hasta que se haya
  // resuelto el getSession inicial, evita parpadeos del LoginScreen.
  // legacyMode: true si el usuario ha optado por "Modo demo" (ignora
  // auth y usa el user picker localStorage).
  const [authSession,setAuthSession] = useState(null);
  const [authReady,setAuthReady]     = useState(!authEnabled());
  const [legacyMode,setLegacyMode]   = useState(()=>{
    try { return localStorage.getItem("soulbaric.legacyMode") === "1"; } catch { return false; }
  });
  useEffect(()=>{
    if(!authEnabled()) return;
    let alive = true;
    getSession().then(s=>{ if(alive){ setAuthSession(s); setAuthReady(true); } });
    const unsub = onAuthStateChange(({session})=>{ setAuthSession(session); });
    return ()=>{ alive = false; unsub(); };
  },[]);
  // Resuelve el miembro a partir del email del session.user.
  const authMemberInfo = authSession ? resolveSessionMember(authSession, data.members) : null;
  // Cuando llega session válida con member match, fijamos activeMember
  // automáticamente (sin pasar por user picker).
  useEffect(()=>{
    if(authMemberInfo?.member) setAM(authMemberInfo.member.id);
  },[authMemberInfo?.member?.id]);
  const handleSignOut = async ()=>{
    await signOut();
    setAuthSession(null);
    try { localStorage.removeItem("taskflow_current_user"); } catch {}
  };
  // Si no eres admin y estás en un tab admin-only, te redirigimos a "mytasks".
  // Evita que un member acceda a vistas restringidas con la URL/atajos.
  const ADMIN_ONLY_TABS = new Set(["dealroom","projects","workspaces","dashboard","briefings","memory","board","planner","team","reports","eisenhower","users"]);
  useEffect(()=>{
    if(authReady && authSession && authMemberInfo?.member && !isAdmin){
      if(ADMIN_ONLY_TABS.has(activeTab)) setActiveTab("mytasks");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[isAdmin, activeTab, authReady, authSession]);
  const enableLegacyMode = ()=>{
    setLegacyMode(true);
    try { localStorage.setItem("soulbaric.legacyMode","1"); } catch {}
  };
  const [showUserModal,setShowUserModal] = useState(()=>!readStoredUser());
  const [userMenuOpen,setUserMenuOpen]   = useState(false);
  const [showCommandPalette,setShowCommandPalette] = useState(false);
  const [pendingWorkspaceId,setPendingWorkspaceId] = useState(null);
  const [sidebarCollapsed,setSidebarCollapsed] = useState(()=>{
    try{ return localStorage.getItem("soulbaric.sidebar.collapsed")==="true"; }catch{ return false; }
  });
  const toggleSidebarCollapsed = useCallback(()=>{
    setSidebarCollapsed(c=>{
      const nc=!c; try{ localStorage.setItem("soulbaric.sidebar.collapsed",String(nc)); }catch{} return nc;
    });
  },[]);
  const [nuevaOpen,setNuevaOpen]         = useState(false);
  const [showShortcuts,setShowShortcuts] = useState(false);
  const nuevaFirstBtnRef = useRef(null);
  const [overlayTaskId,setOverlayTaskId]           = useState(null);
  const [activeNegId,setActiveNegId]               = useState(null);
  const [activeSessId,setActiveSessId]             = useState(null);
  const [negFilter,setNegFilter]                   = useState("all");
  const [negModal,setNegModal]                     = useState(null); // null | "create" | neg object
  const [sessModal,setSessModal]                   = useState(null); // null | "create" | session object
  const [noteModal,setNoteModal]                   = useState(null); // null | "create" | note object
  const [attendeesModalOpen,setAttendeesModalOpen] = useState(false);
  const [genTasksOpen,setGenTasksOpen]             = useState(false);
  const [briefingCtx,setBriefingCtx]               = useState(null); // {agent, negotiation, session|null, kind, prompt}
  const [showAlerts,setShowAlerts] = useState(false);
  const [emailQueue,setEQ]         = useState([]);
  const [profileMember,setPM]      = useState(null);
  const [projectModal,setProjModal]= useState(null);
  const [memberModal,setMemberModal]= useState(null); // null | "create" | member object
  const [workspaceModal,setWorkspaceModal]= useState(null); // null | "create" | workspace object
  const [agentModal,setAgentModal] = useState(null); // null | "create" | agent object
  const [toasts,setToasts]          = useState([]);
  const [scopeAvatar,setScopeAvatar] = useState(null); // null | "global" | "board"
  const [pendingOpenTaskId,setPendingOpenTaskId] = useState(null);
  const [sidebarOpen,setSidebarOpen] = useState(false);

  // Persistencia automática en cada cambio de datos (local + remoto)
  useEffect(()=>{
    try{ localStorage.setItem(LS_KEY,JSON.stringify(data)); }catch(e){}
    if(!syncReady) return;
    if(isRemoteUpdate.current){ isRemoteUpdate.current=false; return; }
    pushState(data);
  },[data,syncReady]);

  // Sync inicial + subscripción realtime
  useEffect(()=>{
    if(!syncEnabled) return;
    let cancelled=false;
    fetchState().then(remote=>{
      if(cancelled) return;
      if(remote && Object.keys(remote).length>0 && remote.projects){
        const migrated=_migrate(remote);
        _syncCounters(migrated);
        isRemoteUpdate.current=true;
        setData(migrated);
      }
      setSyncReady(true);
      setSyncStatus("connected");
    }).catch(()=>{ if(!cancelled){ setSyncReady(true); setSyncStatus("error"); } });
    const unsub=subscribeState(remote=>{
      if(!remote || !remote.projects) return;
      const migrated=_migrate(remote);
      _syncCounters(migrated);
      isRemoteUpdate.current=true;
      setData(migrated);
    });
    return ()=>{ cancelled=true; unsub(); };
  },[]);

  const toastIdRef=useRef(0);
  const addToast=useCallback((msg,type="success",opts={})=>{
    const id=++toastIdRef.current;
    const onClick = opts.onClick ? ()=>{ opts.onClick(); setToasts(prev=>prev.filter(t=>t.id!==id)); } : null;
    const ttl = opts.ttl || 3000;
    setToasts(prev=>[...prev,{id,msg,type,onClick}]);
    setTimeout(()=>setToasts(prev=>prev.filter(t=>t.id!==id)),ttl);
  },[]);

  // Handlers del selector de usuario temporal (pre-auth).
  const selectUser = useCallback((member)=>{
    writeStoredUser(member);
    setAM(member.id);
    setShowUserModal(false);
    setActiveTab("home");
    addToast(`Hola, ${member.name.split(" ")[0]}`,"info");
  },[addToast]);
  const changeUser = useCallback(()=>{
    clearStoredUser();
    setUserMenuOpen(false);
    setShowUserModal(true);
  },[]);
  const logoutTemp = useCallback(()=>{
    clearStoredUser();
    window.location.reload();
  },[]);

  // Atajos globales — deshabilitados durante login. ⌘K siempre activo (incluso
  // con input focuseado); el resto se bloquea si hay input/textarea/select/CE.
  useEffect(()=>{
    if(showUserModal) return;
    const onKey=(e)=>{
      const el = document.activeElement;
      const inputFocused = el && (el.tagName==="INPUT" || el.tagName==="TEXTAREA" || el.tagName==="SELECT" || el.isContentEditable);
      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // ⌘K — command palette (siempre activo)
      if(meta && key==="k"){ e.preventDefault(); setShowCommandPalette(v=>!v); return; }

      if(inputFocused) return;

      // ⌘⇧<letra> — navegación
      if(meta && e.shiftKey){
        if(key==="h"){ e.preventDefault(); setActiveTab("home"); return; }
        if(key==="d"){ e.preventDefault(); setActiveTab("dealroom"); setActiveNegId(null); setActiveSessId(null); return; }
        if(key==="t"){ e.preventDefault(); setActiveTab("mytasks"); return; }
        if(key==="p"){ e.preventDefault(); setActiveTab("projects"); return; }
        if(key==="w"){ e.preventDefault(); setActiveTab("workspaces"); return; }
        if(key==="a"){ e.preventDefault(); setActiveTab("dashboard"); return; }
        if(key==="b"){ e.preventDefault(); setActiveTab("briefings"); return; }
        if(key==="m"){ e.preventDefault(); setActiveTab("memory"); return; }
        if(key==="n"){ e.preventDefault(); setNuevaOpen(true); setTimeout(()=>nuevaFirstBtnRef.current?.focus(),40); return; }
      }

      // ⌘\ — toggle sidebar colapsado
      if(meta && e.key==="\\"){ e.preventDefault(); toggleSidebarCollapsed(); return; }

      // ? — abrir panel de atajos
      if(e.key==="?"){ e.preventDefault(); setShowShortcuts(true); return; }
    };
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[showUserModal,toggleSidebarCollapsed]);

  const proj  = data.projects[activeProject];
  const board = data.boards[proj.id];
  const alerts = genAlerts(data.boards, data.members);
  const critCount = alerts.filter(a=>a.memberId===activeMember&&(a.level==="critical"||a.level==="warning")).length;

  // Acciones rápidas del Command Palette.
  const paletteActions = React.useMemo(()=>[
    { id:"new-task", icon:"➕", label:"Crear nueva tarea", shortcut:"", run:()=>{
        const colId=board[0]?.id; if(!colId) return;
        const id=_uid("t");
        setData(prev=>{
          const nt={id,title:"Nueva tarea",tags:[],assignees:[activeMember],priority:"media",startDate:fmt(new Date()),dueDate:"",estimatedHours:0,timeLogs:[],desc:"",comments:[],subtasks:[],links:[],agentIds:[]};
          const cols=prev.boards[proj.id].map(col=>col.id===colId?{...col,tasks:[...col.tasks,nt]}:col);
          return{...prev,boards:{...prev.boards,[proj.id]:cols}};
        });
        setActiveTab("board");
        setPendingOpenTaskId(id);
        addToast("✓ Tarea creada");
      } },
    { id:"dashboard",   icon:"🏠", label:"Ir al Dashboard",   shortcut:"",    run:()=>setActiveTab("dashboard") },
    { id:"projects",    icon:"📁", label:"Ir a Proyectos",    shortcut:"",    run:()=>setActiveTab("projects") },
    { id:"planner",     icon:"⚡", label:"Abrir Planificador IA", shortcut:"", run:()=>setActiveTab("planner") },
    { id:"workspaces",  icon:"🏢", label:"Ver Workspaces",     shortcut:"",    run:()=>setActiveTab("workspaces") },
    { id:"dealroom",    icon:"🤝", label:"Ir a Deal Room",     shortcut:"",    run:()=>{setActiveTab("dealroom");setActiveNegId(null);setActiveSessId(null);} },
    { id:"alerts",      icon:"🔔", label:"Ver alertas",        shortcut:"",    run:()=>setShowAlerts(true) },
    { id:"change-user", icon:"🔄", label:"Cambiar usuario",    shortcut:"",    run:()=>changeUser() },
    { id:"logout",      icon:"🚪", label:"Cerrar sesión",      shortcut:"",    run:()=>logoutTemp() },
  ],[proj.id,board,activeMember,addToast,changeUser,logoutTemp]);

  // Handlers para el dropdown "Nueva ▾" del TopBar. Reusan flujos existentes.
  const handleNuevaTarea = useCallback(()=>{
    const colId=board[0]?.id; if(!colId){ addToast("⚠ Sin tablero activo","error"); return; }
    const id=_uid("t");
    setData(prev=>{
      const nt={id,title:"Nueva tarea",tags:[],assignees:[activeMember],priority:"media",startDate:fmt(new Date()),dueDate:"",estimatedHours:0,timeLogs:[],desc:"",comments:[],subtasks:[],links:[],agentIds:[],refs:[]};
      const cols=prev.boards[proj.id].map(col=>col.id===colId?{...col,tasks:[...col.tasks,nt]}:col);
      return{...prev,boards:{...prev.boards,[proj.id]:cols}};
    });
    setOverlayTaskId(id);
    addToast("✓ Tarea creada — edítala en el modal");
  },[proj.id,board,activeMember,addToast]);
  const handleNuevaStakeholder = useCallback(()=>{
    if(!activeNegId){
      setActiveTab("dealroom"); setActiveNegId(null); setActiveSessId(null);
      addToast("Abre primero una negociación y añade stakeholders desde su edición","info");
      return;
    }
    const n=(data.negotiations||[]).find(x=>x.id===activeNegId); if(n) setNegModal(n);
  },[activeNegId,data.negotiations,addToast]);

  // Items recientes del sidebar: combina negociaciones, sesiones y tareas
  // por fecha de actividad descendente. Máx 5.
  const recentItems = React.useMemo(()=>{
    const out=[];
    (data.negotiations||[]).forEach(n=>{
      if(n.updatedAt) out.push({kind:"neg",id:n.id,title:n.title,ts:n.updatedAt,emoji:"💼"});
      (n.sessions||[]).forEach(s=>{
        if(s.updatedAt||s.date) out.push({kind:"sess",id:s.id,negId:n.id,title:`${getSessionTypeIcon(s.type)} ${n.title}`,subtitle:getSessionTypeLabel(s.type),ts:s.updatedAt||s.date,emoji:"📅"});
      });
    });
    Object.entries(data.boards||{}).forEach(([pid,cols])=>{
      cols.forEach(col=>col.tasks.forEach(t=>{
        const lastLog=(t.timeLogs||[]).slice(-1)[0];
        const ts = lastLog?.date || t.startDate;
        if(ts) out.push({kind:"task",id:t.id,projId:Number(pid),title:t.title,ts,emoji:"📌"});
      }));
    });
    const score=ts=>new Date(ts).getTime()||0;
    return out.sort((a,b)=>score(b.ts)-score(a.ts)).slice(0,5);
  },[data.negotiations,data.boards]);

  // Breadcrumb derivado del estado de navegación (activeTab + ids activos).
  const TAB_LABELS = {
    home:"Home", dashboard:"Dashboard", mytasks:"Mis tareas", briefings:"Briefings IA", memory:"Memoria",
    projects:"Proyectos", planner:"Planificador IA", workspaces:"Workspaces",
    agents:"Agentes IA", users:"Usuarios", dealroom:"Deal Room",
  };
  const breadcrumb = (()=>{
    const items=[];
    const isBoardTab = ["board","eisenhower","reports","team"].includes(activeTab);
    if(isBoardTab){
      items.push({label:"Proyectos", onClick:()=>setActiveTab("projects")});
      items.push({label:proj.name, onClick: activeTab==="board" ? null : ()=>setActiveTab("board")});
      if(activeTab!=="board"){
        const sub={eisenhower:"Matriz",reports:"Tiempos",team:"Equipo"}[activeTab];
        if(sub) items.push({label:sub});
      }
    } else if(activeTab==="dealroom"){
      items.push({label:"Deal Room", onClick: activeNegId ? ()=>{setActiveNegId(null);setActiveSessId(null);} : null});
      if(activeNegId){
        const neg=(data.negotiations||[]).find(n=>n.id===activeNegId);
        items.push({label: neg?.title||"(borrada)", onClick: activeSessId ? ()=>setActiveSessId(null) : null});
        if(activeSessId){
          const sess=neg?.sessions?.find(s=>s.id===activeSessId);
          if(sess) items.push({label: getSessionTypeLabel(sess.type)});
        }
      }
    } else {
      items.push({label: TAB_LABELS[activeTab]||activeTab});
    }
    return items;
  })();

  // ── Member CRUD ──
  const updateMember = useCallback((updates, memberId)=>{
    const {name,email,role,initials,avail,_color} = updates;
    if(_color && MP[memberId]){
      MP[memberId] = { solid:_color, light:_color+"22", cardBorder:_color, cardBg:_color+"11" };
    }
    setData(prev=>({
      ...prev,
      members: prev.members.map(m =>
        m.id === memberId
          ? { ...m, name, email, role, initials, avail: { ...m.avail, ...avail } }
          : m
      ),
    }));
    setMemberModal(null);
    addToast("✓ Usuario actualizado");
  },[addToast]);

  const createMember = useCallback((updates)=>{
    const {name,email,role,initials,avail,_color} = updates;
    setData(prev=>{
      const id = prev.members.length > 0 ? Math.max(...prev.members.map(m=>m.id)) + 1 : 0;
      if(_color) MP[id] = { solid:_color, light:_color+"22", cardBorder:_color, cardBg:_color+"11" };
      return { ...prev, members:[...prev.members, {id,name,email,role,initials,avail}] };
    });
    setMemberModal(null);
    addToast("✓ Usuario creado");
  },[addToast]);

  const deleteMember = useCallback((memberId)=>{
    setData(prev=>({
      ...prev,
      members: prev.members.filter(m=>m.id!==memberId),
      projects: prev.projects.map(p=>({...p,members:p.members.filter(mid=>mid!==memberId)})),
      boards: Object.fromEntries(Object.entries(prev.boards).map(([pid,cols])=>[pid,cols.map(col=>({...col,tasks:col.tasks.map(t=>({...t,assignees:t.assignees.filter(a=>a!==memberId)}))}))])),
    }));
    if(activeMember===memberId) setAM(0);
    addToast("Usuario eliminado","info");
  },[activeMember,addToast]);

  const updateTask = useCallback((taskId,colId,updated)=>{
    setData(prev=>{ const cols=prev.boards[proj.id].map(col=>col.id===colId?{...col,tasks:col.tasks.map(t=>t.id===taskId?updated:t)}:col); return{...prev,boards:{...prev.boards,[proj.id]:cols}}; });
  },[proj.id]);
  const updateTaskAnywhere = useCallback((taskId,updated)=>{
    setData(prev=>{ const newBoards={}; for(const pid in prev.boards){ newBoards[pid]=prev.boards[pid].map(col=>({...col,tasks:col.tasks.map(t=>t.id===taskId?updated:t)})); } return{...prev,boards:newBoards}; });
  },[]);
  const moveTask = useCallback((taskId,fromColId,toColId)=>{
    setData(prev=>{ const cols=prev.boards[proj.id]; const fc=cols.find(c=>c.id===fromColId); const task=fc.tasks.find(t=>t.id===taskId); const nc=cols.map(col=>{ if(col.id===fromColId)return{...col,tasks:col.tasks.filter(t=>t.id!==taskId)}; if(col.id===toColId)return{...col,tasks:[...col.tasks,task]}; return col; }); return{...prev,boards:{...prev.boards,[proj.id]:nc}}; });
    addToast("Tarea movida","info");
  },[proj.id,addToast]);
  // Acciones cross-project para el Dashboard (Top 5 críticas puede venir de cualquier proyecto).
  const completeTaskAnywhere = useCallback((taskId,projId,fromColId)=>{
    setData(prev=>{
      const cols=prev.boards[projId]; if(!cols) return prev;
      const done=cols.find(c=>c.name==="Hecho")||cols[cols.length-1];
      if(!done||done.id===fromColId) return prev;
      const src=cols.find(c=>c.id===fromColId);
      const task=src?.tasks.find(t=>t.id===taskId); if(!task) return prev;
      const nc=cols.map(col=>{
        if(col.id===fromColId) return{...col,tasks:col.tasks.filter(t=>t.id!==taskId)};
        if(col.id===done.id)   return{...col,tasks:[...col.tasks,task]};
        return col;
      });
      return{...prev,boards:{...prev.boards,[projId]:nc}};
    });
    addToast("✓ Tarea completada");
  },[addToast]);
  const moveTaskAnywhere = useCallback((taskId,fromColId,toColId)=>{
    setData(prev=>{
      for(const pid in prev.boards){
        const cols=prev.boards[pid];
        if(!cols.some(c=>c.id===fromColId)) continue;
        const fc=cols.find(c=>c.id===fromColId);
        const task=fc.tasks.find(t=>t.id===taskId); if(!task) return prev;
        const nc=cols.map(col=>{
          if(col.id===fromColId) return{...col,tasks:col.tasks.filter(t=>t.id!==taskId)};
          if(col.id===toColId)   return{...col,tasks:[...col.tasks,task]};
          return col;
        });
        return{...prev,boards:{...prev.boards,[pid]:nc}};
      }
      return prev;
    });
    addToast("Tarea movida","info");
  },[addToast]);
  const postponeTaskAnywhere = useCallback((task,newDate,label)=>{
    setData(prev=>{
      const newBoards={};
      for(const pid in prev.boards){
        newBoards[pid]=prev.boards[pid].map(col=>({...col,tasks:col.tasks.map(t=>t.id===task.id?{...t,dueDate:newDate}:t)}));
      }
      return{...prev,boards:newBoards};
    });
    addToast(`📅 Pospuesta hasta ${label||newDate}`,"info");
  },[addToast]);
  const addTask = useCallback((colId,title)=>{
    setData(prev=>{ const nt={id:"t"+nextId++,title,tags:[],assignees:[activeMember],priority:"media",startDate:fmt(new Date()),dueDate:"",dueTime:"",estimatedHours:0,timeLogs:[],desc:"",comments:[]}; const cols=prev.boards[proj.id].map(col=>col.id===colId?{...col,tasks:[...col.tasks,nt]}:col); return{...prev,boards:{...prev.boards,[proj.id]:cols}}; });
    addToast("✓ Tarea creada");
  },[proj.id,activeMember,addToast]);
  const deleteTask = useCallback((taskId,colId)=>{
    setData(prev=>{
      const cols = prev.boards[proj.id].map(col => col.id===colId
        ? {...col, tasks: col.tasks.filter(t => t.id!==taskId)}
        : col);
      return {...prev, boards:{...prev.boards, [proj.id]: cols}};
    });
    addToast("Tarea eliminada","info");
  },[proj.id,addToast]);
  const deleteTaskAnywhere = useCallback((taskId)=>{
    setData(prev=>{
      const newBoards = {};
      for(const pid in prev.boards){
        newBoards[pid] = prev.boards[pid].map(col => ({...col, tasks: col.tasks.filter(t => t.id!==taskId)}));
      }
      return {...prev, boards: newBoards};
    });
    addToast("Tarea eliminada","info");
  },[addToast]);
  const applySchedule = useCallback((schedule)=>{
    setData(prev=>({...prev,aiSchedule:schedule}));
    addToast("✓ Plan aplicado");
  },[addToast]);
  const saveMemberProfile = useCallback((memberId,avail)=>{
    setData(prev=>({
      ...prev,
      members: prev.members.map(m =>
        m.id === memberId ? { ...m, avail: { ...m.avail, ...avail } } : m
      ),
    }));
    addToast("✓ Perfil guardado");
  },[addToast]);

  // ── Deal Room mutations ──
  const createNegotiation = useCallback((payload)=>{
    const id=_uid("neg"); const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:[...(prev.negotiations||[]),{id,...payload,sessions:[],createdAt:now,updatedAt:now}]}));
    addToast("✓ Negociación creada");
  },[addToast]);
  const updateNegotiation = useCallback((negId,patch)=>{
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,...patch,updatedAt:new Date().toISOString()}:n)}));
    addToast("✓ Negociación actualizada");
  },[addToast]);
  const deleteNegotiation = useCallback((negId)=>{
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).filter(n=>n.id!==negId)}));
    addToast("Negociación eliminada","info");
  },[addToast]);
  const addSession = useCallback((negId,payload)=>{
    const id=_uid("sess"); const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,sessions:[...(n.sessions||[]),{id,...payload,entries:[],summary:"",createdAt:now,updatedAt:now}],updatedAt:now}:n)}));
    addToast("✓ Sesión añadida");
  },[addToast]);
  const updateSession = useCallback((negId,sessId,patch)=>{
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,sessions:n.sessions.map(s=>s.id===sessId?{...s,...patch,updatedAt:now}:s),updatedAt:now}:n)}));
  },[]);
  const deleteSession = useCallback((negId,sessId)=>{
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,sessions:n.sessions.filter(s=>s.id!==sessId),updatedAt:new Date().toISOString()}:n)}));
    addToast("Sesión eliminada","info");
  },[addToast]);
  const addNote = useCallback((negId,sessId,payload)=>{
    const id=_uid("ent"); const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,updatedAt:now,sessions:n.sessions.map(s=>s.id===sessId?{...s,entries:[...(s.entries||[]),{id,type:"manual_note",authorId:activeMember,createdAt:now,...payload}],updatedAt:now}:s)}:n)}));
  },[activeMember]);
  const updateNote = useCallback((negId,sessId,noteId,patch)=>{
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,updatedAt:now,sessions:n.sessions.map(s=>s.id===sessId?{...s,entries:s.entries.map(e=>e.id===noteId?{...e,...patch}:e),updatedAt:now}:s)}:n)}));
  },[]);
  const deleteNote = useCallback((negId,sessId,noteId)=>{
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,updatedAt:now,sessions:n.sessions.map(s=>s.id===sessId?{...s,entries:s.entries.filter(e=>e.id!==noteId),updatedAt:now}:s)}:n)}));
  },[]);
  const updateSummary = useCallback((negId,sessId,summary)=>{
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,updatedAt:now,sessions:n.sessions.map(s=>s.id===sessId?{...s,summary,updatedAt:now}:s)}:n)}));
  },[]);
  const setNegBriefing = useCallback((negId,briefing)=>{
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,briefing,updatedAt:now}:n)}));
    addToast("✓ Briefing guardado en la negociación");
  },[addToast]);
  const setNegDocuments = useCallback((negId,documents)=>{
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,documents,updatedAt:now}:n)}));
  },[]);
  // Memoria: añade items deduplicados. sections = {preferences?, keyFacts?,
  // decisions?, lessons?}. Cada valor es array de strings. Devuelve nº
  // añadidos sincrónicamente (computado contra dataRef, no dependiendo
  // del updater de setState que con batching async puede diferirse).
  const addCeoMemoryItems = useCallback((sections, source="auto")=>{
    const cur = dataRef.current?.ceoMemory || emptyCeoMemory();
    const next = {...cur};
    let added = 0;
    for(const key of CEO_MEMORY_KEYS){
      const list = Array.isArray(sections?.[key]) ? sections[key] : [];
      let arr = next[key]||[];
      for(const text of list){
        const res = addUnique(arr, text, source);
        arr = res.list; if(res.added) added++;
      }
      next[key] = arr;
    }
    next.updatedAt = new Date().toISOString();
    console.log("[memory] addCeoMemoryItems · input:", Object.fromEntries(Object.entries(sections||{}).map(([k,v])=>[k,(v||[]).length])), "· added:", added);
    if(added>0){
      // Actualiza ref en el acto para que llamadas sucesivas vean los cambios
      // antes de que React flushe el re-render.
      dataRef.current = {...dataRef.current, ceoMemory: next};
      setData(prev=>({...prev, ceoMemory: next}));
    }
    return added;
  },[]);
  const addNegMemoryItems = useCallback((negId, sections, source="auto")=>{
    const neg = (dataRef.current?.negotiations||[]).find(n=>n.id===negId);
    if(!neg){ console.warn("[memory] addNegMemoryItems · neg not found:", negId); return 0; }
    const cur = neg.memory || emptyNegMemory();
    const next = {...cur};
    let added = 0;
    for(const key of NEG_MEMORY_KEYS){
      const list = Array.isArray(sections?.[key]) ? sections[key] : [];
      let arr = next[key]||[];
      for(const text of list){
        const res = addUnique(arr, text, source);
        arr = res.list; if(res.added) added++;
      }
      next[key] = arr;
    }
    next.updatedAt = new Date().toISOString();
    console.log("[memory] addNegMemoryItems · neg:", negId, "· input:", Object.fromEntries(Object.entries(sections||{}).map(([k,v])=>[k,(v||[]).length])), "· added:", added);
    if(added>0){
      dataRef.current = {
        ...dataRef.current,
        negotiations: dataRef.current.negotiations.map(n=>n.id===negId?{...n, memory: next}:n),
      };
      setData(prev=>({...prev, negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n, memory: next}:n)}));
    }
    return added;
  },[]);
  // Añade UN item a ceoMemory.<category> con metadata opcional
  // (negotiationId, negotiationTitle) — usado por el router de auto-learn
  // para decisiones donde queremos conservar el origen. Deduplica con
  // addUnique (includes bidireccional + Jaccard ≥ 0.8). Devuelve bool.
  const addCeoMemorySingle = useCallback((category, text, source, meta)=>{
    if(!CEO_MEMORY_KEYS.includes(category)) return false;
    const cur = dataRef.current?.ceoMemory || emptyCeoMemory();
    const list = cur[category] || [];
    const res = addUnique(list, text, source, meta);
    if(!res.added) return false;
    const next = {...cur, [category]: res.list, updatedAt: new Date().toISOString()};
    dataRef.current = {...dataRef.current, ceoMemory: next};
    setData(prev=>({...prev, ceoMemory: next}));
    return true;
  },[]);
  const addNegMemorySingle = useCallback((negId, category, text, source)=>{
    if(!NEG_MEMORY_KEYS.includes(category)) return false;
    const neg = (dataRef.current?.negotiations||[]).find(n=>n.id===negId);
    if(!neg) return false;
    const cur = neg.memory || emptyNegMemory();
    const list = cur[category] || [];
    const res = addUnique(list, text, source);
    if(!res.added) return false;
    const next = {...cur, [category]: res.list, updatedAt: new Date().toISOString()};
    dataRef.current = {
      ...dataRef.current,
      negotiations: dataRef.current.negotiations.map(n=>n.id===negId?{...n, memory: next}:n),
    };
    setData(prev=>({...prev, negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n, memory: next}:n)}));
    return true;
  },[]);
  // Router del auto-learn. Recibe items tipados del extractor y los
  // coloca según la semántica pedida:
  //   preference → ceoMemory.preferences
  //   keyFact    → ceoMemory.keyFacts  +  negMemory.keyFacts (duplicado)
  //   decision   → ceoMemory.decisions (con negotiationId/Title)  +
  //                negMemory.keyFacts
  const routeAutoLearnItems = useCallback((items, negId, negTitle)=>{
    let added = 0;
    for(const it of (items||[])){
      const { type, content } = it;
      if(type === "preference"){
        if(addCeoMemorySingle("preferences", content, "auto-learn")) added++;
      } else if(type === "keyFact"){
        // Cuenta como 1 si al menos una de las dos inserciones tiene éxito.
        const a = addCeoMemorySingle("keyFacts", content, "auto-learn");
        const b = negId ? addNegMemorySingle(negId, "keyFacts", content, "auto-learn") : false;
        if(a || b) added++;
      } else if(type === "decision"){
        const meta = negId ? { negotiationId: negId, negotiationTitle: negTitle } : null;
        const a = addCeoMemorySingle("decisions", content, "auto-learn", meta);
        const b = negId ? addNegMemorySingle(negId, "keyFacts", content, "auto-learn") : false;
        if(a || b) added++;
      }
    }
    console.log("[memory] routeAutoLearnItems · total added:", added, "· from items:", (items||[]).length);
    return added;
  },[addCeoMemorySingle, addNegMemorySingle]);

  const removeCeoMemoryItem = useCallback((category, itemId)=>{
    if(!CEO_MEMORY_KEYS.includes(category)) return;
    setData(prev=>({...prev, ceoMemory: {
      ...(prev.ceoMemory||emptyCeoMemory()),
      [category]: ((prev.ceoMemory||{})[category]||[]).filter(x=>x.id!==itemId),
      updatedAt: new Date().toISOString(),
    }}));
  },[]);
  const removeNegMemoryItem = useCallback((negId, category, itemId)=>{
    if(!NEG_MEMORY_KEYS.includes(category)) return;
    setData(prev=>({...prev, negotiations:(prev.negotiations||[]).map(n=>{
      if(n.id!==negId) return n;
      const mem = n.memory||emptyNegMemory();
      return {...n, memory:{...mem, [category]: (mem[category]||[]).filter(x=>x.id!==itemId), updatedAt: new Date().toISOString()}};
    })}));
  },[]);
  const clearNegBriefing = useCallback((negId)=>{
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,briefing:null,updatedAt:now}:n)}));
    addToast("Briefing eliminado","info");
  },[addToast]);
  // Héctor chat persistente en negotiation.hectorChat[].
  const appendHectorMessage = useCallback((negId,msg)=>{
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,hectorChat:[...(n.hectorChat||[]),msg],updatedAt:new Date().toISOString()}:n)}));
  },[]);
  const clearHectorChat = useCallback((negId)=>{
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,hectorChat:[],updatedAt:new Date().toISOString()}:n)}));
    addToast("Chat con Héctor limpiado","info");
  },[addToast]);
  // Resume el chat con el LLM, persiste el resumen + keyPoints en la
  // memoria de la negociación, y SOLO después limpia hectorChat. Así
  // al usuario no se le pierde el contexto ni tiene que exportar+
  // reimportar el PDF: Héctor recordará los puntos clave en el próximo
  // turno vía buildContext().
  const summarizeAndClearHectorChat = useCallback(async (negId)=>{
    const neg = (dataRef.current?.negotiations||[]).find(n=>n.id===negId);
    if(!neg){ console.warn("[memory] summarize: neg not found", negId); return; }
    const msgs = neg.hectorChat||[];
    if(msgs.length===0){ clearHectorChat(negId); return; }
    addToast("⏳ Resumiendo el chat antes de limpiar…","info",{ttl:4000});
    try {
      const { summary, keyPoints } = await summarizeChat(msgs, neg.title);
      const summaryItem = {
        id: "sum_"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
        summary,
        keyPoints,
        messageCount: msgs.length,
        createdAt: new Date().toISOString(),
      };
      // Persiste resumen + keyPoints en memoria (source="auto-summary")
      // y LUEGO limpia el chat. Todo en un solo setData para atomicidad.
      setData(prev=>({
        ...prev,
        negotiations:(prev.negotiations||[]).map(n=>{
          if(n.id!==negId) return n;
          const mem = n.memory || emptyNegMemory();
          let keyFacts = mem.keyFacts||[];
          for(const kp of keyPoints){
            const res = addUnique(keyFacts, kp, "auto-summary");
            keyFacts = res.list;
          }
          return {
            ...n,
            hectorChat: [],
            memory: {
              ...mem,
              chatSummaries: [...(mem.chatSummaries||[]), summaryItem],
              keyFacts,
              updatedAt: new Date().toISOString(),
            },
            updatedAt: new Date().toISOString(),
          };
        }),
      }));
      addToast(`🧠 Chat resumido y guardado en memoria. Héctor recordará los puntos clave.`,"success",{ttl:5000, onClick:()=>setActiveTab("memory")});
    } catch(e){
      console.warn("[memory] summarizeAndClear threw, clearing anyway:", e);
      clearHectorChat(negId);
    }
  },[addToast, clearHectorChat]);
  const clearHectorErrors = useCallback((negId)=>{
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>{
      if(n.id!==negId) return n;
      const filtered = (n.hectorChat||[]).filter(m=>!(m.role==="assistant" && (m.content||"").startsWith("⚠")));
      return {...n,hectorChat:filtered,updatedAt:new Date().toISOString()};
    })}));
    addToast("Errores limpiados","info");
  },[addToast]);
  const setNegHectorAnalysis = useCallback((negId,analysis)=>{
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,hectorAnalysis:analysis,updatedAt:new Date().toISOString()}:n)}));
    addToast("✓ Análisis de Héctor guardado");
  },[addToast]);
  const setSessionAttendees = useCallback((negId,sessId,attendees)=>{
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,updatedAt:now,sessions:n.sessions.map(s=>s.id===sessId?{...s,attendees,updatedAt:now}:s)}:n)}));
    addToast("✓ Asistentes actualizados");
  },[addToast]);
  const addAgentConversation = useCallback((negId,sessId,conv)=>{
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,updatedAt:now,sessions:(n.sessions||[]).map(s=>s.id===sessId?{...s,agentConversations:[...(s.agentConversations||[]),conv],updatedAt:now}:s)}:n)}));
  },[]);
  // Crea tareas en los proyectos elegidos (una tarea puede ir a un proyecto
  // distinto de las demás). Cada tarea se crea con refs a la negociación y a
  // la sesión; se actualiza relatedTaskIds de la negociación.
  const generateTasksFromSession = useCallback((negId,sessId,tasks)=>{
    const newIds=[]; const now=new Date().toISOString();
    setData(prev=>{
      const boardsOut={...prev.boards};
      for(const t of tasks){
        const projId = t.projectId;
        const cols = boardsOut[projId]; if(!cols) continue;
        const targetCol = cols.find(c=>c.name==="Por hacer")||cols[0];
        const id=_uid("t"); newIds.push(id);
        const refs=[
          {id:_uid("rf"),type:"negotiation",targetId:negId,context:`Generada desde "${(prev.negotiations||[]).find(n=>n.id===negId)?.title||""}"`,createdAt:now},
          {id:_uid("rf"),type:"session",targetId:sessId,negotiationId:negId,context:"Acordado en sesión",createdAt:now},
        ];
        const newTask={id,title:t.title.trim(),tags:[],assignees:[t.assignee],priority:t.priority||"media",startDate:fmt(new Date()),dueDate:t.dueDate||"",estimatedHours:0,timeLogs:[],desc:"",comments:[],subtasks:[],links:[],agentIds:[],refs,negotiationId:negId,sessionId:sessId};
        boardsOut[projId] = cols.map(col=>col.id===targetCol.id?{...col,tasks:[...col.tasks,newTask]}:col);
      }
      const newNegs=(prev.negotiations||[]).map(n=>n.id===negId?{...n,relatedTaskIds:[...(n.relatedTaskIds||[]),...newIds],updatedAt:now}:n);
      return {...prev,boards:boardsOut,negotiations:newNegs};
    });
    addToast(`✓ ${tasks.length} tarea${tasks.length!==1?"s":""} creada${tasks.length!==1?"s":""}`);
  },[addToast]);

  const createProject = useCallback(({name,desc,color,emoji,members:mems,columns,workspaceId})=>{
    const id=nextProjId++;
    const cols=columns.map(n=>({id:`nc${nextColId++}`,name:n,tasks:[]}));
    setData(prev=>({...prev,projects:[...prev.projects,{id,name,desc,color,emoji,members:mems,workspaceId:workspaceId??null}],boards:{...prev.boards,[id]:cols}}));
    addToast("✓ Proyecto creado");
  },[addToast]);
  const editProject = useCallback((idx,{name,desc,color,emoji,members:mems,columns,workspaceId})=>{
    setData(prev=>{
      const p=prev.projects[idx];
      const projects=prev.projects.map((x,i)=>i===idx?{...x,name,desc,color,emoji,members:mems,workspaceId:workspaceId??null}:x);
      const existing=prev.boards[p.id]||[];
      const existNames=existing.map(c=>c.name);
      const newCols=columns.filter(n=>!existNames.includes(n)).map(n=>({id:`nc${nextColId++}`,name:n,tasks:[]}));
      const merged=[...existing.filter(c=>columns.includes(c.name)),...newCols];
      return{...prev,projects,boards:{...prev.boards,[p.id]:merged.length>0?merged:existing}};
    });
    addToast("✓ Proyecto actualizado");
  },[addToast]);
  const createWorkspace = useCallback((payload)=>{
    const id=nextWsId++;
    setData(prev=>({...prev,workspaces:[...(prev.workspaces||[]),{id,...payload,createdAt:fmt(new Date())}]}));
    addToast("✓ Workspace creado");
  },[addToast]);
  const editWorkspace = useCallback((id,payload)=>{
    setData(prev=>({...prev,workspaces:(prev.workspaces||[]).map(w=>w.id===id?{...w,...payload}:w)}));
    addToast("✓ Workspace actualizado");
  },[addToast]);
  const deleteWorkspace = useCallback((id)=>{
    setData(prev=>({
      ...prev,
      workspaces:(prev.workspaces||[]).filter(w=>w.id!==id),
      projects:prev.projects.map(p=>p.workspaceId===id?{...p,workspaceId:null}:p),
    }));
    addToast("Workspace eliminado","info");
  },[addToast]);

  const createAgent = useCallback((payload)=>{
    const id=nextAgentId++;
    setData(prev=>({...prev,agents:[...(prev.agents||[]),{id,...payload,createdAt:fmt(new Date())}]}));
    setAgentModal(null); addToast("✓ Agente creado");
  },[addToast]);
  const editAgent = useCallback((id,payload)=>{
    setData(prev=>({...prev,agents:(prev.agents||[]).map(a=>a.id===id?{...a,...payload}:a)}));
    setAgentModal(null); addToast("✓ Agente actualizado");
  },[addToast]);
  const deleteAgent = useCallback((id)=>{
    setData(prev=>{
      const boards={...prev.boards};
      Object.keys(boards).forEach(k=>{
        boards[k]=boards[k].map(c=>({...c,tasks:c.tasks.map(t=>({...t,agentIds:(t.agentIds||[]).filter(x=>x!==id)}))}));
      });
      return{...prev,agents:(prev.agents||[]).filter(a=>a.id!==id),boards};
    });
    setAgentModal(null); addToast("Agente eliminado","info");
  },[addToast]);

  const deleteProject = useCallback((idx)=>{
    setData(prev=>{ const p=prev.projects[idx]; const projects=prev.projects.filter((_,i)=>i!==idx); const boards={...prev.boards}; delete boards[p.id]; return{...prev,projects,boards}; });
    setAP(0); setActiveTab("projects");
    addToast("Proyecto eliminado","info");
  },[addToast]);

  const totalTasks=board.reduce((s,c)=>s+c.tasks.length,0);
  const doneTasks =board.filter(c=>c.name==="Hecho").reduce((s,c)=>s+c.tasks.length,0);
  const TABS=[{key:"board",l:"Tablero"},{key:"eisenhower",l:"Matriz"},{key:"reports",l:"Tiempos"},{key:"team",l:"Equipo"}];

  // Auth gate: cuando Supabase Auth está disponible y el usuario no está
  // en modo demo, mostramos LoginScreen hasta que tenga sesión válida con
  // email que case con un member. Si la sesión existe pero el email no
  // está autorizado, mostramos panel "no autorizado" con opción de salir.
  if(authEnabled() && !legacyMode){
    if(!authReady){
      return <div style={{position:"fixed",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,color:"#6B7280"}}>Cargando…</div>;
    }
    if(!authSession){
      return <LoginScreen onAuthed={s=>setAuthSession(s)} onLegacySkip={enableLegacyMode}/>;
    }
    if(!authMemberInfo?.member){
      return <div style={{position:"fixed",inset:0,background:"linear-gradient(135deg,#7F77DD22,#E76AA122)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,zIndex:5000}}>
        <div style={{background:"#fff",borderRadius:16,padding:"28px",width:380,maxWidth:"100%",boxShadow:"0 20px 60px rgba(0,0,0,0.18)"}}>
          <div style={{fontSize:15,fontWeight:700,color:"#B91C1C",marginBottom:8}}>Email no autorizado</div>
          <div style={{fontSize:12.5,color:"#374151",lineHeight:1.5,marginBottom:14}}>El email <b>{authSession.user?.email}</b> no está vinculado a ningún miembro del equipo. Pide al administrador que lo añada al campo email del miembro correspondiente.</div>
          <button onClick={handleSignOut} style={{padding:"8px 14px",borderRadius:8,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cerrar sesión</button>
        </div>
      </div>;
    }
  }
  return(
    <div style={{display:"flex",height:"100vh",fontFamily:"'Segoe UI',system-ui,sans-serif",background:"#f9fafb",color:"#111827"}}>
      {showUserModal&&!authSession&&<UserSelectionModal members={data.members} onSelectUser={selectUser}/>}
      {showShortcuts&&<ShortcutsModal onClose={()=>setShowShortcuts(false)}/>}
      {overlayTaskId&&(()=>{
        for(const p of data.projects){
          const cols=data.boards[p.id]||[];
          for(const col of cols){
            const t=col.tasks.find(x=>x.id===overlayTaskId);
            if(t){
              const ws=(data.workspaces||[]).find(w=>w.id===p.workspaceId);
              return <TaskModal
                task={t} colId={col.id} cols={cols}
                members={data.members} activeMemberId={activeMember}
                workspaceLinks={ws?.links||[]} agents={data.agents||[]}
                ceoMemory={data.ceoMemory}
                onClose={()=>setOverlayTaskId(null)}
                onUpdate={(id,_cid,upd)=>updateTaskAnywhere(id,upd)}
                onMove={(id,from,to)=>{moveTaskAnywhere(id,from,to);setOverlayTaskId(null);}}
              />;
            }
          }
        }
        return null;
      })()}
      {showCommandPalette&&<CommandPalette
        data={data}
        actions={paletteActions}
        onClose={()=>setShowCommandPalette(false)}
        onNavigateTask={task=>{
          const pi=data.projects.findIndex(p=>p.id===task.projId);
          if(pi<0){ addToast("⚠ Esta tarea ya no existe","error"); return; }
          setAP(pi); setActiveTab("board"); setPendingOpenTaskId(task.id);
        }}
        onNavigateWorkspace={ws=>{ setActiveTab("workspaces"); setPendingWorkspaceId(ws.id); }}
        onNavigateProject={p=>{ const i=data.projects.findIndex(x=>x.id===p.id); if(i>=0){ setAP(i); setActiveTab("board"); } }}
      />}
      {sidebarOpen && <div className="tf-backdrop" onClick={()=>setSidebarOpen(false)}/>}
      {/* SIDEBAR — AppShell: 5 principales + Recientes + Footer Atajos */}
      {(()=>{
        const me=data.members.find(x=>x.id===activeMember)||data.members[0];
        const mp2=MP[me?.id]||MP[0];
        // Items del sidebar. Para no-admin, filtramos a Home + Mis tareas
        // (no acceden a Board, Proyectos, Deal Room, Dashboard, Briefings,
        // Memoria — solo ven sus propias tareas asignadas).
        const ALL_PRIMARY=[
          {id:"home",       icon:"🏠", label:"Home",         shortcut:"⌘⇧H", onClick:()=>{setActiveTab("home");}, adminOnly:false},
          {id:"dealroom",   icon:"🤝", label:"Deal Room",    shortcut:"⌘⇧D", onClick:()=>{setActiveTab("dealroom");setActiveNegId(null);setActiveSessId(null);}, adminOnly:true},
          {id:"mytasks",    icon:"✅", label:"Mis tareas",   shortcut:"⌘⇧T", onClick:()=>{setActiveTab("mytasks");}, adminOnly:false},
          {id:"projects",   icon:"📁", label:"Proyectos",    shortcut:"⌘⇧P", onClick:()=>{setActiveTab("projects");}, adminOnly:true},
          {id:"workspaces", icon:"🏢", label:"Workspaces",   shortcut:"⌘⇧W", onClick:()=>{setActiveTab("workspaces");}, adminOnly:true},
          {id:"dashboard",  icon:"📊", label:"Dashboard",    shortcut:"⌘⇧A", onClick:()=>{setActiveTab("dashboard");}, adminOnly:true},
          {id:"briefings",  icon:"🧠", label:"Briefings IA", shortcut:"⌘⇧B", onClick:()=>{setActiveTab("briefings");}, adminOnly:true},
          {id:"memory",     icon:"🧩", label:"Memoria",      shortcut:"⌘⇧M", onClick:()=>{setActiveTab("memory");}, adminOnly:true},
        ];
        const PRIMARY = isAdmin ? ALL_PRIMARY : ALL_PRIMARY.filter(it=>!it.adminOnly);
        return(
        <div className={`tf-sidebar${sidebarOpen?" open":""}`} data-sb-no-close style={{width:sidebarCollapsed?60:224,flexShrink:0,background:"#fff",borderRight:"0.5px solid #e5e7eb",display:"flex",flexDirection:"column",transition:"width .18s ease"}}>
          {/* Header: logo + brand + collapse button */}
          <div style={{padding:sidebarCollapsed?"14px 8px":"14px 14px 12px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",gap:sidebarCollapsed?0:10,justifyContent:sidebarCollapsed?"center":"flex-start"}}>
            <div title="SoulBaric" style={{width:30,height:30,background:"#7F77DD",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:13,fontWeight:700,flexShrink:0}}>SB</div>
            {!sidebarCollapsed&&<>
              <span style={{fontWeight:600,fontSize:15,flex:1}}>SoulBaric</span>
              <span title={syncStatus==="connected"?"Sincronizado con Supabase":syncStatus==="connecting"?"Conectando…":syncStatus==="error"?"Error de sincronización":"Solo local (sin sync)"} style={{width:8,height:8,borderRadius:"50%",background:syncStatus==="connected"?"#10b981":syncStatus==="connecting"?"#f59e0b":syncStatus==="error"?"#ef4444":"#9ca3af",flexShrink:0}}/>
              <button onClick={toggleSidebarCollapsed} title="Colapsar sidebar (⌘\\)" style={{width:22,height:22,borderRadius:5,background:"transparent",border:"none",fontSize:12,cursor:"pointer",color:"#9CA3AF",display:"flex",alignItems:"center",justifyContent:"center"}}>‹</button>
            </>}
          </div>

          {/* User dropdown */}
          <div style={{padding:sidebarCollapsed?"10px 8px":"10px 12px",borderBottom:"0.5px solid #e5e7eb",background:"#fafafa",position:"relative"}}>
            {!sidebarCollapsed&&<div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:6}}>Usuario activo</div>}
            <button title={sidebarCollapsed?`${me?.name} — cambiar usuario`:"Cambiar de usuario activo"} onClick={()=>setUserMenuOpen(o=>!o)} style={{width:"100%",display:"flex",alignItems:"center",gap:sidebarCollapsed?0:8,padding:sidebarCollapsed?4:"7px 9px",borderRadius:8,border:sidebarCollapsed?"none":"0.5px solid #d1d5db",background:sidebarCollapsed?"transparent":"#fff",cursor:"pointer",fontFamily:"inherit",textAlign:"left",justifyContent:sidebarCollapsed?"center":"flex-start"}}>
              <div style={{width:sidebarCollapsed?32:26,height:sidebarCollapsed?32:26,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:sidebarCollapsed?11:10,fontWeight:700,flexShrink:0}}>{me?.initials}</div>
              {!sidebarCollapsed&&<>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:600,color:"#111827",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{me?.name}</div>
                  <div style={{fontSize:10,color:"#6b7280",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{me?.email}</div>
                </div>
                <span style={{fontSize:10,color:"#9ca3af",flexShrink:0}}>{userMenuOpen?"▴":"▾"}</span>
              </>}
            </button>
            {userMenuOpen&&(
              <>
                <div onClick={()=>setUserMenuOpen(false)} style={{position:"fixed",inset:0,zIndex:1600}}/>
                <div style={{position:"absolute",top:"calc(100% - 2px)",left:sidebarCollapsed?4:12,right:sidebarCollapsed?"auto":12,minWidth:sidebarCollapsed?200:"auto",background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:10,boxShadow:"0 10px 28px rgba(0,0,0,0.14)",zIndex:1700,overflow:"hidden",animation:"tf-slide-down .15s ease-out"}}>
                  <div onClick={()=>{setUserMenuOpen(false);setPM(data.members.find(x=>x.id===activeMember));}} style={{padding:"9px 12px",fontSize:12,color:"#374151",cursor:"pointer",borderBottom:"0.5px solid #f3f4f6"}} onMouseEnter={e=>e.currentTarget.style.background="#f9fafb"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>⚙ Mi perfil</div>
                  <div onClick={changeUser} style={{padding:"9px 12px",fontSize:12,color:"#374151",cursor:"pointer",borderBottom:"0.5px solid #f3f4f6"}} onMouseEnter={e=>e.currentTarget.style.background="#f9fafb"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>🔄 Cambiar usuario</div>
                  <div onClick={()=>{ setUserMenuOpen(false); if(authSession) handleSignOut(); else logoutTemp(); }} style={{padding:"9px 12px",fontSize:12,color:"#A32D2D",cursor:"pointer",borderBottom:"0.5px solid #f3f4f6"}} onMouseEnter={e=>e.currentTarget.style.background="#FEF2F2"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>🚪 Cerrar sesión</div>
                  <div onClick={()=>{ if(!window.confirm("¿Borrar todos los datos guardados y volver al estado inicial?"))return; setUserMenuOpen(false); localStorage.removeItem(LS_KEY); window.location.reload(); }} style={{padding:"9px 12px",fontSize:11,color:"#6B7280",cursor:"pointer",fontStyle:"italic"}} onMouseEnter={e=>e.currentTarget.style.background="#f9fafb"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>🗑 Resetear datos (dev)</div>
                </div>
              </>
            )}
          </div>

          {/* Principales (5) */}
          <div style={{padding:"8px 6px",borderBottom:"0.5px solid #e5e7eb"}}>
            {PRIMARY.map(it=>{
              const active = activeTab===it.id;
              return(
                <div key={it.id} onClick={it.onClick} title={sidebarCollapsed?`${it.label} · ${it.shortcut}`:it.shortcut} style={{display:"flex",alignItems:"center",gap:sidebarCollapsed?0:10,padding:sidebarCollapsed?"9px 0":"8px 10px",borderRadius:8,cursor:"pointer",fontSize:13,background:active?"#EEEDFE":"transparent",color:active?"#7F77DD":"#4b5563",fontWeight:active?600:500,justifyContent:sidebarCollapsed?"center":"flex-start",marginBottom:2}} onMouseEnter={e=>{if(!active) e.currentTarget.style.background="#F9FAFB";}} onMouseLeave={e=>{if(!active) e.currentTarget.style.background="transparent";}}>
                  <span style={{fontSize:16,flexShrink:0}}>{it.icon}</span>
                  {!sidebarCollapsed&&<>
                    <span style={{flex:1}}>{it.label}</span>
                    <span style={{fontSize:10,color:active?"#7F77DD99":"#9CA3AF",fontFamily:"ui-monospace,monospace"}}>{it.shortcut}</span>
                  </>}
                </div>
              );
            })}
          </div>

          {/* Recientes */}
          {!sidebarCollapsed&&(
            <div style={{padding:"8px 8px",flex:1,overflowY:"auto"}}>
              <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",letterSpacing:"0.07em",textTransform:"uppercase",padding:"4px 8px 6px"}}>Recientes</div>
              {recentItems.length===0
                ? <div style={{fontSize:11,color:"#9CA3AF",padding:"6px 10px",fontStyle:"italic"}}>Sin actividad reciente</div>
                : recentItems.map(it=>{
                    const onClick=()=>{
                      if(it.kind==="neg"){ setActiveTab("dealroom"); setActiveNegId(it.id); setActiveSessId(null); }
                      else if(it.kind==="sess"){ setActiveTab("dealroom"); setActiveNegId(it.negId); setActiveSessId(it.id); }
                      else if(it.kind==="task"){ setOverlayTaskId(it.id); }
                    };
                    return(
                      <div key={`${it.kind}-${it.id}`} onClick={onClick} title={it.title} style={{display:"flex",alignItems:"center",gap:7,padding:"6px 10px",borderRadius:7,cursor:"pointer",fontSize:12,color:"#4b5563",marginBottom:1}} onMouseEnter={e=>{e.currentTarget.style.background="#F9FAFB";}} onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}>
                        <span style={{fontSize:12,flexShrink:0}}>{it.emoji}</span>
                        <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{it.title}</span>
                      </div>
                    );
                  })}
            </div>
          )}
          {sidebarCollapsed&&<div style={{flex:1}}/>}

          {/* Footer: Atajos */}
          <div style={{padding:sidebarCollapsed?"8px":"8px 12px",borderTop:"0.5px solid #e5e7eb"}}>
            <button onClick={()=>setShowShortcuts(true)} title="Ver atajos de teclado (?)" style={{width:"100%",padding:sidebarCollapsed?"8px 0":"7px 10px",borderRadius:7,border:"0.5px solid #e5e7eb",background:"transparent",fontSize:11,color:"#6b7280",cursor:"pointer",display:"flex",alignItems:"center",gap:8,justifyContent:sidebarCollapsed?"center":"flex-start",fontFamily:"inherit"}} onMouseEnter={e=>{e.currentTarget.style.background="#F9FAFB";e.currentTarget.style.borderColor="#D1D5DB";}} onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderColor="#e5e7eb";}}>
              <span>⌨️</span>
              {!sidebarCollapsed&&<><span style={{flex:1,textAlign:"left"}}>Atajos</span><kbd style={{fontSize:10,padding:"1px 6px",border:"0.5px solid #d1d5db",borderRadius:4,background:"#fff",color:"#6b7280",fontFamily:"ui-monospace,monospace"}}>?</kbd></>}
            </button>
            {!sidebarCollapsed&&(
              <button onClick={toggleSidebarCollapsed} title="Colapsar sidebar (⌘\\)" style={{width:"100%",padding:"5px 0",borderRadius:6,border:"none",background:"transparent",fontSize:10,color:"#9ca3af",cursor:"pointer",marginTop:4,fontFamily:"inherit"}}>‹ Colapsar</button>
            )}
            {sidebarCollapsed&&(
              <button onClick={toggleSidebarCollapsed} title="Expandir sidebar (⌘\\)" style={{width:"100%",padding:"6px 0",borderRadius:6,border:"none",background:"transparent",fontSize:14,color:"#9ca3af",cursor:"pointer",marginTop:4,fontFamily:"inherit"}}>›</button>
            )}
          </div>
        </div>
        );
      })()}

      {/* MAIN */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
        {/* Top bar — siempre visible. Hamburger móvil + breadcrumb + buscar + Nueva ▾ + avatar. */}
        <div style={{display:"flex",background:"#fff",borderBottom:"0.5px solid #e5e7eb",padding:"10px 14px",alignItems:"center",gap:10,flexShrink:0}}>
          <button className="tf-only-mobile" onClick={()=>setSidebarOpen(true)} title="Abrir menú" style={{width:38,height:38,borderRadius:8,background:"#f3f4f6",border:"none",fontSize:18,cursor:"pointer",alignItems:"center",justifyContent:"center"}}>☰</button>

          {/* Breadcrumb */}
          <nav aria-label="Breadcrumb" style={{display:"flex",alignItems:"center",gap:6,flex:1,minWidth:0,overflow:"hidden"}}>
            {breadcrumb.map((item,i)=>{
              const isLast = i===breadcrumb.length-1;
              return(
                <React.Fragment key={i}>
                  {i>0&&<span style={{color:"#D1D5DB",fontSize:13,flexShrink:0}}>›</span>}
                  {!isLast && item.onClick
                    ? <button onClick={item.onClick} style={{background:"none",border:"none",color:"#6B7280",cursor:"pointer",fontFamily:"inherit",fontSize:13,padding:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:180}} onMouseEnter={e=>e.currentTarget.style.color="#374151"} onMouseLeave={e=>e.currentTarget.style.color="#6B7280"}>{item.label}</button>
                    : <span style={{color:isLast?"#111827":"#6B7280",fontWeight:isLast?600:400,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:260}}>{item.label}</span>
                  }
                </React.Fragment>
              );
            })}
          </nav>

          {/* Buscar (⌘K) */}
          <button title="Buscar (⌘K)" onClick={()=>setShowCommandPalette(true)} className="tf-search-btn"
            style={{display:"flex",alignItems:"center",gap:8,padding:"7px 12px",borderRadius:20,background:"#f3f4f6",color:"#4b5563",border:"0.5px solid #e5e7eb",fontSize:13,cursor:"pointer",fontFamily:"inherit",transition:"background .15s, color .15s, border-color .15s",flexShrink:0}}
            onMouseEnter={e=>{e.currentTarget.style.background="#DBEAFE";e.currentTarget.style.color="#1E40AF";e.currentTarget.style.borderColor="#93C5FD";}}
            onMouseLeave={e=>{e.currentTarget.style.background="#f3f4f6";e.currentTarget.style.color="#4b5563";e.currentTarget.style.borderColor="#e5e7eb";}}>
            <span style={{fontSize:14,lineHeight:1}}>🔍</span>
            <span className="tf-search-label">Buscar</span>
            <span className="tf-search-kbd" style={{fontSize:10,color:"#9ca3af",border:"0.5px solid #d1d5db",borderRadius:5,padding:"2px 6px",fontWeight:600,background:"#fff"}}>⌘K</span>
          </button>

          {/* Nueva ▾ */}
          <div style={{position:"relative",flexShrink:0}}>
            <button onClick={()=>setNuevaOpen(o=>!o)} title="Nueva (⌘⇧N)" style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600,fontFamily:"inherit"}}>
              <span>Nueva</span><span style={{fontSize:10,marginLeft:2}}>▾</span>
            </button>
            {nuevaOpen&&(
              <>
                <div onClick={()=>setNuevaOpen(false)} style={{position:"fixed",inset:0,zIndex:1600}}/>
                <div style={{position:"absolute",top:"calc(100% + 4px)",right:0,minWidth:200,background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:10,boxShadow:"0 10px 28px rgba(0,0,0,0.14)",zIndex:1700,overflow:"hidden",animation:"tf-slide-down .15s ease-out"}}>
                  <button ref={nuevaFirstBtnRef} onClick={()=>{setNuevaOpen(false);handleNuevaTarea();}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"10px 14px",background:"transparent",border:"none",fontSize:13,color:"#374151",cursor:"pointer",fontFamily:"inherit",textAlign:"left",borderBottom:"0.5px solid #f3f4f6"}} onMouseEnter={e=>e.currentTarget.style.background="#F9FAFB"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>📌 Tarea</button>
                  <button onClick={()=>{setNuevaOpen(false);setNegModal("create");}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"10px 14px",background:"transparent",border:"none",fontSize:13,color:"#374151",cursor:"pointer",fontFamily:"inherit",textAlign:"left",borderBottom:"0.5px solid #f3f4f6"}} onMouseEnter={e=>e.currentTarget.style.background="#F9FAFB"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>💼 Negociación</button>
                  <button onClick={()=>{setNuevaOpen(false);handleNuevaStakeholder();}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"10px 14px",background:"transparent",border:"none",fontSize:13,color:"#374151",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}} onMouseEnter={e=>e.currentTarget.style.background="#F9FAFB"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>👤 Stakeholder</button>
                </div>
              </>
            )}
          </div>

          {/* Avatar (abre dropdown de usuario en sidebar) */}
          {(()=>{ const me=data.members.find(x=>x.id===activeMember)||data.members[0]; const mp=MP[me?.id]||MP[0]; return(
            <button onClick={()=>{setSidebarOpen(true);setUserMenuOpen(o=>!o);}} title={me?.name||"Usuario"} style={{width:34,height:34,borderRadius:"50%",background:mp.solid,color:"#fff",border:"none",fontSize:11,fontWeight:700,cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>{me?.initials}</button>
          );})()}
        </div>
        {activeTab!=="home"&&activeTab!=="dashboard"&&activeTab!=="projects"&&activeTab!=="planner"&&activeTab!=="users"&&activeTab!=="workspaces"&&activeTab!=="agents"&&activeTab!=="dealroom"&&activeTab!=="mytasks"&&activeTab!=="briefings"&&(
          <div style={{background:"#fff",borderBottom:"0.5px solid #e5e7eb",padding:"0 20px",height:52,display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:16}}>{proj.emoji||"📋"}</span>
              <span style={{fontSize:15,fontWeight:600}}>{proj.name}</span>
              <span style={{fontSize:11,padding:"2px 9px",borderRadius:20,background:`${proj.color}22`,color:proj.color,border:`0.5px solid ${proj.color}55`,fontWeight:500}}>{proj.members.length} miembros</span>
              {activeTab==="board"&&<span style={{fontSize:12,color:"#6b7280"}}>{doneTasks}/{totalTasks} completadas</span>}
              {(()=>{ const relNeg=(data.negotiations||[]).find(n=>n.projectId===proj.id); if(!relNeg) return null; const st=getNegStatus(relNeg.status); return(
                <button onClick={()=>{setActiveTab("dealroom");setActiveNegId(relNeg.id);setActiveSessId(null);}} title={`Ir a la negociación: ${relNeg.title}`} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"3px 10px",borderRadius:14,background:"#FEF3C7",border:"1px solid #FCD34D",color:"#854F0B",fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:500}}>💼 {relNeg.title.length>26?relNeg.title.slice(0,26)+"…":relNeg.title}<span style={{fontSize:10,padding:"1px 6px",background:"#fff",borderRadius:10,color:st.color,fontWeight:600}}>{st.label}</span></button>
              );})()}
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {activeTab==="board"&&<button onClick={()=>setScopeAvatar("board")} style={{padding:"6px 12px",borderRadius:8,background:"linear-gradient(135deg,#7F77DD,#E76AA1)",color:"#fff",border:"none",fontSize:12,cursor:"pointer",fontWeight:600}}>🎙️ Asesor del tablero</button>}
            <button onClick={()=>setShowAlerts(true)} style={{position:"relative",padding:"6px 14px",borderRadius:8,background:critCount>0?"#fff5f5":"#f9fafb",color:critCount>0?"#A32D2D":"#374151",border:`1px solid ${critCount>0?"#E24B4A":"#d1d5db"}`,fontSize:13,cursor:"pointer",fontWeight:500,display:"flex",alignItems:"center",gap:6}}>
              Alertas {critCount>0&&<span style={{background:"#E24B4A",color:"#fff",borderRadius:"50%",width:18,height:18,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700}}>{critCount}</span>}
            </button>
            </div>
          </div>
        )}
        {activeTab!=="home"&&activeTab!=="dashboard"&&activeTab!=="projects"&&activeTab!=="planner"&&activeTab!=="users"&&activeTab!=="workspaces"&&activeTab!=="agents"&&activeTab!=="dealroom"&&activeTab!=="mytasks"&&activeTab!=="briefings"&&(
          <div style={{display:"flex",borderBottom:"0.5px solid #e5e7eb",background:"#fff",padding:"0 20px",flexShrink:0,overflowX:"auto"}}>
            {TABS.map(tab=><div key={tab.key} onClick={()=>setActiveTab(tab.key)} style={{padding:"10px 14px",fontSize:13,cursor:"pointer",borderBottom:activeTab===tab.key?"2px solid #7F77DD":"2px solid transparent",color:activeTab===tab.key?"#7F77DD":"#6b7280",fontWeight:activeTab===tab.key?500:400,marginBottom:-0.5,whiteSpace:"nowrap"}}>{tab.l}</div>)}
          </div>
        )}
        {activeTab==="board"&&<DailyDigest boards={data.boards} members={data.members} activeMemberId={activeMember}/>}
        <div style={{flex:1,overflow:"auto"}}>
          {activeTab==="home"      &&<HomeView data={data} activeMember={activeMember} critMineCount={critCount} alertMineCount={alerts.filter(a=>a.memberId===activeMember).length} onNavigate={id=>{setActiveTab(id);if(id==="dealroom"){setActiveNegId(null);setActiveSessId(null);}}} onToast={addToast} onOpenTask={id=>setOverlayTaskId(id)}/>}
          {activeTab==="mytasks"   &&<MyTasksView data={data} activeMember={activeMember} onOpenTask={id=>setOverlayTaskId(id)} onNavigate={id=>setActiveTab(id)}/>}
          {activeTab==="briefings" &&<BriefingsView data={data} onOpenNeg={nid=>{setActiveTab("dealroom");setActiveNegId(nid);setActiveSessId(null);}} onOpenSession={(nid,sid)=>{setActiveTab("dealroom");setActiveNegId(nid);setActiveSessId(sid);}}/>}
          {activeTab==="memory"    &&<MemoryPanel ceoMemory={data.ceoMemory} onAddCeo={addCeoMemoryItems} onRemoveCeo={removeCeoMemoryItem} onAddNeg={addNegMemoryItems} onRemoveNeg={removeNegMemoryItem}/>}
          {activeTab==="dealroom"&&(()=>{
            const activeNeg = activeNegId ? (data.negotiations||[]).find(n=>n.id===activeNegId) : null;
            const activeSess = activeNeg && activeSessId ? (activeNeg.sessions||[]).find(s=>s.id===activeSessId) : null;
            const negAgent = activeNeg?.agentId ? (data.agents||[]).find(a=>a.id===activeNeg.agentId) : null;
            const negPrimaryProjId = activeNeg?.relatedProjects?.[0]?.projectId ?? activeNeg?.projectId ?? null;
            const negProject = negPrimaryProjId!=null ? data.projects.find(p=>p.id===negPrimaryProjId) : null;
            const openBriefing = (neg,sess,kind)=>{
              const agent = (data.agents||[]).find(a=>a.id===neg.agentId);
              if(!agent){ addToast("⚠ Asigna un agente IA a esta negociación primero","error"); return; }
              const proj = neg.projectId ? data.projects.find(p=>p.id===neg.projectId) : null;
              const sessions = (neg.sessions||[]).slice().sort((a,b)=>b.date.localeCompare(a.date));
              const lastSess = sessions[0];
              const notes = sess ? (sess.entries||[]).map(e=>`- [${e.timestamp}] ${e.content}`).join("\n") : "";
              const prompt = kind==="briefing"
                ? `🎯 BRIEFING PARA NEGOCIACIÓN\n\nNegociación: ${neg.title}\nContraparte: ${neg.counterparty}${neg.value!=null?` · Valor: ${neg.value} ${neg.currency||"EUR"}`:""}\nEstado: ${getNegStatus(neg.status).label}\n${neg.description?`\nDescripción: ${neg.description}`:""}${proj?`\nProyecto: ${proj.name}`:""}\n\n${lastSess?`Última sesión (${formatDateTimeES(lastSess.date)}):\n${lastSess.summary||"(sin resumen)"}`:"Esta será la primera reunión."}\n\nPrepárame un briefing con:\n1. Resumen del contexto y del cliente\n2. Objetivos clave para la próxima sesión\n3. Estrategia recomendada\n4. Posibles objeciones y cómo responderlas\n5. Próximos pasos concretos`
                : `💬 CONSEJO EN TIEMPO REAL\n\nNegociación: ${neg.title} · Contraparte: ${neg.counterparty}\nSesión: ${getSessionTypeLabel(sess.type)} · ${formatDateTimeES(sess.date)}\n\nNotas tomadas hasta ahora:\n${notes||"(aún sin notas)"}\n\n¿Qué consejo concreto me das para avanzar en esta situación? Sé breve, directo y accionable.`;
              const initialResponse = kind==="briefing" && neg.briefing?.content ? neg.briefing.content : undefined;
              setBriefingCtx({agent,negotiation:neg,session:sess,kind,prompt,initialResponse});
            };
            if(activeNeg && activeSess){
              return <SessionDetailView
                negotiation={activeNeg} session={activeSess}
                agent={negAgent} relatedProject={negProject}
                onBack={()=>setActiveSessId(null)}
                onEditSession={s=>setSessModal(s)}
                onAddNote={()=>setNoteModal("create")}
                onEditNote={n=>setNoteModal(n)}
                onUpdateSummary={summary=>updateSummary(activeNeg.id,activeSess.id,summary)}
                onToast={addToast}
                onManageAttendees={()=>setAttendeesModalOpen(true)}
                onRequestAdvice={()=>openBriefing(activeNeg,activeSess,"advice")}
                onGenerateTasks={()=>setGenTasksOpen(true)}
              />;
            }
            if(activeNeg){
              return <NegotiationDetailView
                negotiation={activeNeg} members={data.members}
                projects={data.projects} workspaces={data.workspaces||[]}
                agents={data.agents||[]} boards={data.boards}
                allNegotiations={data.negotiations||[]}
                onBack={()=>setActiveNegId(null)}
                onEditNeg={n=>setNegModal(n)}
                onCreateSession={()=>setSessModal("create")}
                onOpenSession={sid=>setActiveSessId(sid)}
                onEditSession={s=>setSessModal(s)}
                onRequestBriefing={(n)=>openBriefing(n,null,"briefing")}
                onGoProject={pid=>{ const i=data.projects.findIndex(p=>p.id===pid); if(i>=0){ setAP(i); setActiveTab("board"); } }}
                onOpenTask={(taskId,pid)=>{ const i=data.projects.findIndex(p=>p.id===pid); if(i>=0){ setAP(i); setActiveTab("board"); setPendingOpenTaskId(taskId); } }}
                onOpenRelatedNeg={nid=>{ setActiveNegId(nid); setActiveSessId(null); }}
                onClearBriefing={nid=>clearNegBriefing(nid)}
                onAppendHectorMessage={appendHectorMessage}
                onClearHectorChat={clearHectorChat}
                onClearHectorErrors={clearHectorErrors}
                onSetAnalysis={setNegHectorAnalysis}
                onSaveBriefing={(nid,briefing)=>setNegBriefing(nid,briefing)}
                onUpdateDocuments={setNegDocuments}
                ceoMemory={data.ceoMemory}
                onAddCeoMemory={addCeoMemoryItems}
                onAddNegMemory={addNegMemoryItems}
                onRemoveNegMemory={removeNegMemoryItem}
                onSummarizeAndClearChat={summarizeAndClearHectorChat}
                onRouteAutoLearn={routeAutoLearnItems}
                onMemorized={({count,agentName})=>addToast(`🧠 ${agentName} ha memorizado ${count} dato${count!==1?"s":""} nuevo${count!==1?"s":""}`,"info",{ttl:5000,onClick:()=>setActiveTab("memory")})}
                onOverlayTask={id=>setOverlayTaskId(id)}
              />;
            }
            return <DealRoomView
              negotiations={data.negotiations||[]} members={data.members}
              projects={data.projects} workspaces={data.workspaces||[]}
              filter={negFilter} onSetFilter={setNegFilter}
              onCreate={()=>setNegModal("create")}
              onOpen={id=>{setActiveNegId(id);setActiveSessId(null);}}
              onEdit={n=>setNegModal(n)}
            />;
          })()}
          {activeTab==="dashboard" &&<DashboardView data={data} onGoPlanner={()=>setActiveTab("planner")} onGoProjects={()=>setActiveTab("projects")} onGoBoard={i=>{setAP(i);setActiveTab("board");}} onOpenTask={(t,pi)=>{setAP(pi);setActiveTab("board");setPendingOpenTaskId(t.id);}} onOpenBriefing={()=>setScopeAvatar("global")} onCompleteTask={completeTaskAnywhere} onPostponeTask={postponeTaskAnywhere}/>}
          {activeTab==="projects"  &&<ProjectsView projects={data.projects} members={data.members} boards={data.boards} onSelectProject={i=>{setAP(i);setActiveTab("board");}} onCreateProject={()=>setProjModal("create")} onEditProject={i=>setProjModal(i)} onDeleteProject={deleteProject}/>}
          {activeTab==="users"     &&<UsersView members={data.members} projects={data.projects} onEdit={m=>setMemberModal(m)} onCreate={()=>setMemberModal("create")} onDelete={deleteMember}/>}
          {activeTab==="workspaces"&&<WorkspacesView workspaces={data.workspaces||[]} projects={data.projects} boards={data.boards} pendingWorkspaceId={pendingWorkspaceId} onPendingConsumed={()=>setPendingWorkspaceId(null)} onCreate={()=>setWorkspaceModal("create")} onEdit={w=>setWorkspaceModal(w)} onSelectProject={i=>{setAP(i);setActiveTab("board");}}/>}
          {activeTab==="agents"    &&<AgentsView agents={data.agents||[]} onCreate={()=>setAgentModal("create")} onEdit={a=>setAgentModal(a)}/>}
          {activeTab==="board"     &&<BoardView board={board} members={data.members} projectMemberIds={proj.members} activeMemberId={activeMember} aiSchedule={data.aiSchedule} workspaceLinks={(data.workspaces||[]).find(w=>w.id===proj.workspaceId)?.links||[]} agents={data.agents||[]} ceoMemory={data.ceoMemory} canDelete={isAdmin} externalOpenTaskId={pendingOpenTaskId} onExternalTaskConsumed={()=>setPendingOpenTaskId(null)} onUpdate={updateTask} onMove={moveTask} onAddTask={addTask} onDeleteTask={deleteTask}/>}
          {activeTab==="eisenhower"&&<EisenhowerView boards={data.boards} members={data.members} activeMemberId={activeMember} projects={data.projects}/>}
          {activeTab==="planner"   &&<PlannerView data={data} onApplySchedule={applySchedule} saveMemberProfile={saveMemberProfile} onUpdateTask={updateTaskAnywhere}/>}
          {activeTab==="reports"   &&<TimeReportsView boards={data.boards} members={data.members} projects={data.projects}/>}
          {activeTab==="team"      &&<TeamView project={proj} members={data.members} projects={data.projects} onSelectProject={i=>{setAP(i);setActiveTab("board");}} onEditProfile={m=>setPM(m)}/>}
        </div>
      </div>

      {showAlerts&&<AlertPanel alerts={alerts} members={data.members} activeMemberId={activeMember} onClose={()=>setShowAlerts(false)} onEmailSend={e=>setEQ(q=>[...q,e])} onOpenTask={alert=>{
        if(!alert.taskId){ addToast("⚠ Alerta sin tarea asociada","error"); return; }
        let projIdx=-1;
        for(let i=0;i<data.projects.length;i++){
          const cols=data.boards[data.projects[i].id]||[];
          if(cols.some(c=>c.tasks.some(t=>t.id===alert.taskId))){ projIdx=i; break; }
        }
        if(projIdx<0){ addToast("⚠ Esta tarea ya no existe","error"); return; }
        setAP(projIdx); setActiveTab("board"); setPendingOpenTaskId(alert.taskId); setShowAlerts(false);
      }}/>}
      <EmailToast emails={emailQueue} onDismiss={i=>setEQ(q=>q.filter((_,j)=>j!==i))}/>
      <Toast toasts={toasts}/>
      {profileMember&&<ProfileModal member={profileMember} onClose={()=>setPM(null)} onSave={avail=>{saveMemberProfile(profileMember.id,avail);setPM(null);}}/>}
      {projectModal==="create"&&<ProjectModal members={data.members} workspaces={data.workspaces||[]} onClose={()=>setProjModal(null)} onSave={createProject}/>}
      {typeof projectModal==="number"&&<ProjectModal project={data.projects[projectModal]} members={data.members} workspaces={data.workspaces||[]} onClose={()=>setProjModal(null)} onSave={d=>editProject(projectModal,d)}/>}
      {memberModal==="create"&&<MemberEditModal allMembers={data.members} onClose={()=>setMemberModal(null)} onSave={createMember}/>}
      {memberModal&&memberModal!=="create"&&<MemberEditModal member={memberModal} allMembers={data.members} onClose={()=>setMemberModal(null)} onSave={d=>updateMember(d,memberModal.id)} onDelete={id=>{deleteMember(id);setMemberModal(null);}}/>}
      {agentModal==="create"&&<AgentEditModal onClose={()=>setAgentModal(null)} onSave={createAgent}/>}
      {agentModal&&agentModal!=="create"&&<AgentEditModal agent={agentModal} onClose={()=>setAgentModal(null)} onSave={d=>editAgent(agentModal.id,d)} onDelete={deleteAgent}/>}
      {workspaceModal==="create"&&<WorkspaceModal onClose={()=>setWorkspaceModal(null)} onSave={createWorkspace}/>}
      {workspaceModal&&workspaceModal!=="create"&&<WorkspaceModal workspace={workspaceModal} onClose={()=>setWorkspaceModal(null)} onSave={d=>editWorkspace(workspaceModal.id,d)} onDelete={deleteWorkspace}/>}

      {negModal==="create"&&<NegotiationModal members={data.members} workspaces={data.workspaces||[]} projects={data.projects} agents={data.agents||[]} allNegotiations={data.negotiations||[]} onClose={()=>setNegModal(null)} onSave={createNegotiation}/>}
      {negModal&&negModal!=="create"&&<NegotiationModal negotiation={negModal} members={data.members} workspaces={data.workspaces||[]} projects={data.projects} agents={data.agents||[]} allNegotiations={data.negotiations||[]} onClose={()=>setNegModal(null)} onSave={p=>updateNegotiation(negModal.id,p)} onDelete={id=>{ deleteNegotiation(id); if(activeNegId===id){ setActiveNegId(null); setActiveSessId(null); } }}/>}
      {attendeesModalOpen&&activeNegId&&activeSessId&&(()=>{
        const n=(data.negotiations||[]).find(x=>x.id===activeNegId); const s=n?.sessions.find(x=>x.id===activeSessId);
        if(!s) return null;
        return <AttendeesModal session={s} members={data.members} onClose={()=>setAttendeesModalOpen(false)} onSave={att=>setSessionAttendees(activeNegId,activeSessId,att)} onToast={addToast}/>;
      })()}
      {genTasksOpen&&activeNegId&&activeSessId&&(()=>{
        const n=(data.negotiations||[]).find(x=>x.id===activeNegId); const s=n?.sessions.find(x=>x.id===activeSessId);
        if(!n||!s) return null;
        const ids = (n.relatedProjects||[]).map(rp=>rp.projectId);
        if(ids.length===0 && n.projectId!=null) ids.push(n.projectId);
        const availableProjects = ids.map(id=>data.projects.find(p=>p.id===id)).filter(Boolean);
        if(availableProjects.length===0){ setGenTasksOpen(false); addToast("⚠ Asigna al menos un proyecto a la negociación primero","error"); return null; }
        return <GenerateTasksModal negotiation={n} session={s} availableProjects={availableProjects} members={data.members} activeMember={activeMember} onClose={()=>setGenTasksOpen(false)} onGenerate={(tasks)=>generateTasksFromSession(activeNegId,activeSessId,tasks)}/>;
      })()}
      {briefingCtx&&<AgentBriefingModal
        agent={briefingCtx.agent} negotiation={briefingCtx.negotiation} session={briefingCtx.session}
        kind={briefingCtx.kind} prompt={briefingCtx.prompt}
        initialResponse={briefingCtx.initialResponse}
        onClose={()=>setBriefingCtx(null)}
        onSavedConversation={briefingCtx.session?(conv=>addAgentConversation(briefingCtx.negotiation.id,briefingCtx.session.id,conv)):null}
        onSaveBriefing={briefingCtx.kind==="briefing"?(b=>setNegBriefing(briefingCtx.negotiation.id,b)):null}
      />}
      {activeNegId&&sessModal==="create"&&<SessionModal onClose={()=>setSessModal(null)} onSave={p=>addSession(activeNegId,p)}/>}
      {activeNegId&&sessModal&&sessModal!=="create"&&<SessionModal session={sessModal} onClose={()=>setSessModal(null)} onSave={p=>updateSession(activeNegId,sessModal.id,p)} onDelete={sid=>{ deleteSession(activeNegId,sid); if(activeSessId===sid) setActiveSessId(null); }}/>}
      {activeNegId&&activeSessId&&noteModal==="create"&&<AddNoteModal onClose={()=>setNoteModal(null)} onSave={p=>addNote(activeNegId,activeSessId,p)}/>}
      {activeNegId&&activeSessId&&noteModal&&noteModal!=="create"&&<AddNoteModal initialNote={noteModal} onClose={()=>setNoteModal(null)} onSave={p=>updateNote(activeNegId,activeSessId,noteModal.id,p)} onDelete={nid=>deleteNote(activeNegId,activeSessId,nid)}/>}

      {/* Botón flotante global del asesor — siempre visible */}
      <button className="tf-fab" onClick={()=>setScopeAvatar(activeTab||"global")} title="Asesor IA — habla sobre lo que estás viendo" style={{position:"fixed",bottom:24,right:24,zIndex:1500,width:60,height:60,borderRadius:"50%",background:"linear-gradient(135deg,#7F77DD,#E76AA1)",color:"#fff",border:"none",fontSize:26,cursor:"pointer",boxShadow:"0 8px 24px rgba(127,119,221,0.4)",display:"flex",alignItems:"center",justifyContent:"center"}}>🎙️</button>

      {scopeAvatar && <ScopeAvatarModal
        scope={scopeAvatar}
        data={data}
        activeProjectId={proj.id}
        activeMemberId={activeMember}
        onClose={()=>setScopeAvatar(null)}
        onMutateData={newData=>setData(newData)}
        onOpenProject={pid=>{ const idx=data.projects.findIndex(p=>p.id===pid); if(idx>=0){setAP(idx);setActiveTab("board");} }}
        onOpenTask={(pid,tid)=>{ const idx=data.projects.findIndex(p=>p.id===pid); if(idx>=0){setAP(idx);setActiveTab("board");setPendingOpenTaskId(tid);} }}
      />}
    </div>
  );
}
