import React, { useState, useCallback, useEffect, useRef } from "react";
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
import { AVATARS, AVATAR_KEYS, buildBriefing, respondToQuery, parseCommand, executeCommand, buildDailyBriefing, buildBoardBriefing, buildContextBriefing, parseScopedCommand, respondScopedQuery, executeScopedCommand, agentToAvatar, buildAgentBriefing, respondAgentQuery, llmAgentReply } from "./lib/agent.js";
import { voiceSupported, speak, stopSpeaking, listen } from "./lib/voice.js";

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
    {id:6,name:"Antonio Díaz", initials:"AD",role:"Editor", email:"antonio@empresa.com",avail:{...BASE_AVAIL,whatsapp:"",hoursPerDay:8}},
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
  d.projects = (d.projects||[]).map(p=>({...p, workspaceId: p.workspaceId ?? null}));
  d.boards = Object.fromEntries(Object.entries(d.boards||{}).map(([pid,cols])=>[pid,cols.map(col=>({...col,tasks:col.tasks.map(t=>({...t, links: t.links||[], agentIds: t.agentIds||[]}))}))]));
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
      {editingTask&&<TaskModal task={editingTask.task} colId={editingTask.colId} cols={editingTask.cols} members={data.members} activeMemberId={0} workspaceLinks={[]} agents={data.agents||[]} onClose={()=>setEditingTask(null)} onUpdate={(id,cid,upd)=>{onUpdateTask?.(id,upd);setEditingTask(prev=>prev?{...prev,task:upd}:null);}} onMove={()=>setEditingTask(null)}/>}
    </div>
  );
}

// ── Task Modal ────────────────────────────────────────────────────────────────
function TaskModal({task,colId,cols,members,activeMemberId,workspaceLinks,agents,onClose,onUpdate,onMove}){
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
        {avatarOpen&&<AvatarModal task={task} members={members} connectedAgents={(agents||[]).filter(a=>(task.agentIds||[]).includes(a.id))} onClose={()=>setAvatarOpen(false)} onSetCategory={cat=>onUpdate(task.id,colId,{...task,category:cat})} onMutateTask={newTask=>onUpdate(task.id,colId,newTask)}/>}
        {/* Tabs */}
        <div style={{display:"flex",borderBottom:"0.5px solid #e5e7eb",padding:"0 20px"}}>
          {[["detail","Detalle"],["subtasks","Subtareas"],["links","Enlaces"],["time","Tiempo"],["comments","Comentarios"]].map(([k,l])=>(
            <div key={k} onClick={()=>setTab(k)} style={{padding:"9px 14px",fontSize:12,cursor:"pointer",borderBottom:tab===k?"2px solid #7F77DD":"2px solid transparent",color:tab===k?"#7F77DD":"#6b7280",fontWeight:tab===k?600:400,marginBottom:-0.5}}>{l}{k==="subtasks"&&subs.length>0?` ${subsDone}/${subs.length}`:""}{k==="links"&&links.length>0?` (${links.length})`:""}{k==="time"&&totalLogged>0?` · ${fmtH(totalLogged)}`:""}{k==="comments"&&task.comments.length>0?` (${task.comments.length})`:""}</div>
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
                    <div><FL c="Fecha limite"/><FI type="date" value={draft.dueDate} onChange={v=>set("dueDate",v)}/></div>
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
                  <textarea value={draft.desc||""} onChange={e=>set("desc",e.target.value)} rows={3} style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/>
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
                <button onClick={addComment} style={{padding:"8px 14px",borderRadius:8,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:500}}>Enviar</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Asesor IA (voz del navegador) ─────────────────────────────────────────────
function AvatarModal({task,members,connectedAgents,onClose,onSetCategory,onMutateTask}){
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
        const reply = await llmAgentReply(text, task, activeAgent, members, messagesRef.current);
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
        {task.dueDate&&<span style={{fontSize:10,color:isOver?"#A32D2D":isToday?"#854F0B":"#9ca3af",fontWeight:isOver||isToday?600:400}}>{isOver?"Vencida":isToday?"Hoy":"Fin"}: {task.dueDate}</span>}
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
function BoardView({board,members,projectMemberIds,activeMemberId,aiSchedule,workspaceLinks,agents,externalOpenTaskId,onExternalTaskConsumed,onUpdate,onMove,onAddTask}){
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
      {openModal&&<TaskModal task={openModal.t} colId={openModal.colId} cols={board} members={members} activeMemberId={activeMemberId} workspaceLinks={workspaceLinks} agents={agents||[]} onClose={()=>setOpenTaskId(null)} onUpdate={(id,cid,upd)=>onUpdate(id,cid,upd)} onMove={(id,from,to)=>{onMove(id,from,to);setOpenTaskId(null);}}/>}
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
          {shown.map(alert=>{ const s=ls[alert.level]||ls.info; const m=members.find(x=>x.id===alert.memberId); const wu=waUrl(m,`Alerta TaskFlow: ${alert.taskTitle||"Aviso"} — ${alert.msg}`);
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
                        <button onClick={e=>{e.stopPropagation();setSent(p=>({...p,[alert.id]:true}));onEmailSend({to:m?.email,subject:`[TaskFlow] ${alert.taskTitle||"Alerta"}`,body:alert.msg});}} style={{fontSize:11,padding:"2px 8px",borderRadius:6,border:`1px solid ${s.border}`,background:"transparent",color:s.text,cursor:"pointer",fontWeight:500}}>{sent[alert.id]?"Enviado":"Email"}</button>
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
      {toasts.map(t=>{ const s=S[t.type]||S.success; return(
        <div key={t.id} style={{background:s.bg,border:`1px solid ${s.border}`,borderRadius:10,padding:"10px 22px",fontSize:13,fontWeight:600,color:s.text,display:"flex",alignItems:"center",gap:8,boxShadow:"0 4px 16px rgba(0,0,0,0.12)",whiteSpace:"nowrap",animation:"fadeInUp .18s ease"}}>
          <span style={{fontSize:15}}>{s.icon}</span><span>{t.msg}</span>
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
            ⚠ Nunca guardes contraseñas aquí. Usa tu gestor (1Password, Bitwarden, llavero). TaskFlow vive en localStorage sin cifrado.
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
function WorkspacesView({workspaces,projects,boards,onCreate,onEdit,onSelectProject}){
  const [selected,setSelected] = useState(null);
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
          <div style={{fontSize:18,fontWeight:700,marginBottom:4}}>Bienvenido a TaskFlow</div>
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
  const isRemoteUpdate             = useRef(false);
  const [syncReady,setSyncReady]   = useState(!syncEnabled);
  const [syncStatus,setSyncStatus] = useState(syncEnabled?"connecting":"off");
  const [activeProject,setAP]      = useState(0);
  const [activeTab,setActiveTab]   = useState("projects");
  const [activeMember,setAM]       = useState(()=>{ const u=readStoredUser(); return typeof u?.id==="number"?u.id:5; });
  const [showUserModal,setShowUserModal] = useState(()=>!readStoredUser());
  const [userMenuOpen,setUserMenuOpen]   = useState(false);
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
  const addToast=useCallback((msg,type="success")=>{
    const id=++toastIdRef.current;
    setToasts(prev=>[...prev,{id,msg,type}]);
    setTimeout(()=>setToasts(prev=>prev.filter(t=>t.id!==id)),3000);
  },[]);

  // Handlers del selector de usuario temporal (pre-auth).
  const selectUser = useCallback((member)=>{
    writeStoredUser(member);
    setAM(member.id);
    setShowUserModal(false);
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

  const proj  = data.projects[activeProject];
  const board = data.boards[proj.id];
  const alerts = genAlerts(data.boards, data.members);
  const critCount = alerts.filter(a=>a.memberId===activeMember&&(a.level==="critical"||a.level==="warning")).length;

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
    setData(prev=>{ const nt={id:"t"+nextId++,title,tags:[],assignees:[activeMember],priority:"media",startDate:fmt(new Date()),dueDate:"",estimatedHours:0,timeLogs:[],desc:"",comments:[]}; const cols=prev.boards[proj.id].map(col=>col.id===colId?{...col,tasks:[...col.tasks,nt]}:col); return{...prev,boards:{...prev.boards,[proj.id]:cols}}; });
    addToast("✓ Tarea creada");
  },[proj.id,activeMember,addToast]);
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

  return(
    <div style={{display:"flex",height:"100vh",fontFamily:"'Segoe UI',system-ui,sans-serif",background:"#f9fafb",color:"#111827"}}>
      {showUserModal&&<UserSelectionModal members={data.members} onSelectUser={selectUser}/>}
      {sidebarOpen && <div className="tf-backdrop" onClick={()=>setSidebarOpen(false)}/>}
      {/* SIDEBAR */}
      <div className={`tf-sidebar${sidebarOpen?" open":""}`} onClick={e=>{ if(e.target.tagName!=="BUTTON" && e.target.tagName!=="INPUT" && e.target.tagName!=="SELECT") setSidebarOpen(false); }} style={{width:224,flexShrink:0,background:"#fff",borderRight:"0.5px solid #e5e7eb",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"16px 16px 12px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:30,height:30,background:"#7F77DD",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:13,fontWeight:700}}>TF</div>
          <span style={{fontWeight:600,fontSize:15}}>TaskFlow</span>
          <span title={syncStatus==="connected"?"Sincronizado con Supabase":syncStatus==="connecting"?"Conectando…":syncStatus==="error"?"Error de sincronización":"Solo local (sin sync)"} style={{marginLeft:"auto",width:8,height:8,borderRadius:"50%",background:syncStatus==="connected"?"#10b981":syncStatus==="connecting"?"#f59e0b":syncStatus==="error"?"#ef4444":"#9ca3af"}}/>
        </div>
        <div style={{padding:"10px 12px",borderBottom:"0.5px solid #e5e7eb",background:"#fafafa",position:"relative"}}>
          <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:6}}>Usuario activo</div>
          {(()=>{ const m=data.members.find(x=>x.id===activeMember)||data.members[0]; const mp2=MP[m?.id]||MP[0]; return(
            <button title="Cambiar de usuario activo" onClick={()=>setUserMenuOpen(o=>!o)} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"7px 9px",borderRadius:8,border:"0.5px solid #d1d5db",background:"#fff",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
              <div style={{width:26,height:26,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0}}>{m?.initials}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:600,color:"#111827",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m?.name}</div>
                <div style={{fontSize:10,color:"#6b7280",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m?.email}</div>
              </div>
              <span style={{fontSize:10,color:"#9ca3af",flexShrink:0}}>{userMenuOpen?"▴":"▾"}</span>
            </button>
          );})()}
          {userMenuOpen&&(
            <>
              <div onClick={()=>setUserMenuOpen(false)} style={{position:"fixed",inset:0,zIndex:1600}}/>
              <div style={{position:"absolute",top:"calc(100% - 2px)",left:12,right:12,background:"#fff",border:"0.5px solid #e5e7eb",borderRadius:10,boxShadow:"0 10px 28px rgba(0,0,0,0.14)",zIndex:1700,overflow:"hidden",animation:"tf-slide-down .15s ease-out"}}>
                <div onClick={()=>{setUserMenuOpen(false);setPM(data.members.find(x=>x.id===activeMember));}} className="tf-lift-item" style={{padding:"9px 12px",fontSize:12,color:"#374151",cursor:"pointer",borderBottom:"0.5px solid #f3f4f6"}} onMouseEnter={e=>e.currentTarget.style.background="#f9fafb"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>⚙ Mi perfil</div>
                <div onClick={changeUser} className="tf-lift-item" style={{padding:"9px 12px",fontSize:12,color:"#374151",cursor:"pointer",borderBottom:"0.5px solid #f3f4f6"}} onMouseEnter={e=>e.currentTarget.style.background="#f9fafb"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>🔄 Cambiar usuario</div>
                <div onClick={logoutTemp} style={{padding:"9px 12px",fontSize:12,color:"#A32D2D",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background="#FEF2F2"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>🚪 Cerrar sesión</div>
              </div>
            </>
          )}
        </div>
        <div style={{padding:"6px 8px",borderBottom:"0.5px solid #e5e7eb"}}>
          <div onClick={()=>setActiveTab("dashboard")} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 8px",borderRadius:8,cursor:"pointer",fontSize:13,background:activeTab==="dashboard"?"#EEEDFE":"transparent",color:activeTab==="dashboard"?"#7F77DD":"#4b5563",fontWeight:activeTab==="dashboard"?600:400}}>
            <span style={{fontSize:14}}>📊</span> Dashboard
          </div>
          <div onClick={()=>setActiveTab("projects")} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 8px",borderRadius:8,cursor:"pointer",fontSize:13,background:activeTab==="projects"?"#EEEDFE":"transparent",color:activeTab==="projects"?"#7F77DD":"#4b5563",fontWeight:activeTab==="projects"?600:400}}>
            <span style={{fontSize:14}}>📋</span> Proyectos
          </div>
          <div onClick={()=>setActiveTab("planner")} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 8px",borderRadius:8,cursor:"pointer",fontSize:13,background:activeTab==="planner"?"#EEEDFE":"transparent",color:activeTab==="planner"?"#7F77DD":"#4b5563",fontWeight:activeTab==="planner"?600:400}}>
            <span style={{fontSize:14}}>⚡</span> Planificador IA
          </div>
          <div onClick={()=>setActiveTab("users")} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 8px",borderRadius:8,cursor:"pointer",fontSize:13,background:activeTab==="users"?"#EEEDFE":"transparent",color:activeTab==="users"?"#7F77DD":"#4b5563",fontWeight:activeTab==="users"?600:400}}>
            <span style={{fontSize:14}}>👥</span> Usuarios
          </div>
          <div onClick={()=>setActiveTab("workspaces")} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 8px",borderRadius:8,cursor:"pointer",fontSize:13,background:activeTab==="workspaces"?"#EEEDFE":"transparent",color:activeTab==="workspaces"?"#7F77DD":"#4b5563",fontWeight:activeTab==="workspaces"?600:400}}>
            <span style={{fontSize:14}}>🏢</span> Workspaces
          </div>
          <div onClick={()=>setActiveTab("agents")} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 8px",borderRadius:8,cursor:"pointer",fontSize:13,background:activeTab==="agents"?"#EEEDFE":"transparent",color:activeTab==="agents"?"#7F77DD":"#4b5563",fontWeight:activeTab==="agents"?600:400}}>
            <span style={{fontSize:14}}>🤖</span> Agentes IA
          </div>
        </div>
        <div style={{padding:8,flex:1,overflowY:"auto"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 8px 2px"}}>
            <span style={{fontSize:10,fontWeight:600,color:"#9ca3af",letterSpacing:"0.07em",textTransform:"uppercase"}}>Mis tableros</span>
            <button onClick={()=>setProjModal("create")} style={{width:18,height:18,borderRadius:4,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>+</button>
          </div>
          {data.projects.map((p,i)=>(
            <div key={p.id} onClick={()=>{setAP(i);setActiveTab("board");}} style={{display:"flex",alignItems:"center",gap:7,padding:"6px 8px",borderRadius:8,cursor:"pointer",fontSize:12,background:i===activeProject&&activeTab!=="dashboard"&&activeTab!=="projects"&&activeTab!=="planner"?"#f3f4f6":"transparent",color:i===activeProject&&activeTab!=="dashboard"&&activeTab!=="projects"&&activeTab!=="planner"?"#111827":"#4b5563",fontWeight:i===activeProject&&activeTab!=="dashboard"&&activeTab!=="projects"&&activeTab!=="planner"?500:400}}>
              <span style={{fontSize:14,flexShrink:0}}>{p.emoji||"📋"}</span>
              <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</span>
              <div style={{width:7,height:7,borderRadius:"50%",background:p.color,flexShrink:0}}/>
            </div>
          ))}
        </div>
        <div style={{padding:"10px 14px",borderTop:"0.5px solid #e5e7eb"}}>
          <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",letterSpacing:"0.07em",textTransform:"uppercase",marginBottom:7}}>Equipo · {proj.name}</div>
          {proj.members.slice(0,5).map(mid=>{ const m=data.members.find(x=>x.id===mid); const mp2=MP[mid]||MP[0]; return <div key={mid} style={{display:"flex",alignItems:"center",gap:7,padding:"3px 0"}}><div style={{width:24,height:24,borderRadius:"50%",background:mp2.solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:700,flexShrink:0}}>{m?.initials}</div><span style={{fontSize:11,color:"#4b5563",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m?.name}</span></div>; })}
        </div>
        <div style={{padding:"8px 14px",borderTop:"0.5px solid #e5e7eb"}}>
          <button onClick={()=>{ if(!window.confirm("¿Borrar todos los datos guardados y volver al estado inicial?"))return; localStorage.removeItem(LS_KEY); window.location.reload(); }} style={{width:"100%",padding:"5px 0",borderRadius:6,border:"0.5px solid #e5e7eb",background:"transparent",fontSize:10,color:"#9ca3af",cursor:"pointer"}}>Resetear datos</button>
        </div>
      </div>

      {/* MAIN */}
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
        {/* Barra superior móvil con hamburguesa (visible solo < 900px) */}
        <div className="tf-hamburger" style={{display:"none",background:"#fff",borderBottom:"0.5px solid #e5e7eb",padding:"10px 14px",alignItems:"center",gap:10,flexShrink:0}}>
          <button onClick={()=>setSidebarOpen(true)} style={{width:38,height:38,borderRadius:8,background:"#f3f4f6",border:"none",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>☰</button>
          <div style={{fontWeight:600,fontSize:14,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>TaskFlow · {activeTab==="board"?proj.name:activeTab}</div>
        </div>
        {activeTab!=="dashboard"&&activeTab!=="projects"&&activeTab!=="planner"&&activeTab!=="users"&&activeTab!=="workspaces"&&activeTab!=="agents"&&(
          <div style={{background:"#fff",borderBottom:"0.5px solid #e5e7eb",padding:"0 20px",height:52,display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:16}}>{proj.emoji||"📋"}</span>
              <span style={{fontSize:15,fontWeight:600}}>{proj.name}</span>
              <span style={{fontSize:11,padding:"2px 9px",borderRadius:20,background:`${proj.color}22`,color:proj.color,border:`0.5px solid ${proj.color}55`,fontWeight:500}}>{proj.members.length} miembros</span>
              {activeTab==="board"&&<span style={{fontSize:12,color:"#6b7280"}}>{doneTasks}/{totalTasks} completadas</span>}
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {activeTab==="board"&&<button onClick={()=>setScopeAvatar("board")} style={{padding:"6px 12px",borderRadius:8,background:"linear-gradient(135deg,#7F77DD,#E76AA1)",color:"#fff",border:"none",fontSize:12,cursor:"pointer",fontWeight:600}}>🎙️ Asesor del tablero</button>}
            <button onClick={()=>setShowAlerts(true)} style={{position:"relative",padding:"6px 14px",borderRadius:8,background:critCount>0?"#fff5f5":"#f9fafb",color:critCount>0?"#A32D2D":"#374151",border:`1px solid ${critCount>0?"#E24B4A":"#d1d5db"}`,fontSize:13,cursor:"pointer",fontWeight:500,display:"flex",alignItems:"center",gap:6}}>
              Alertas {critCount>0&&<span style={{background:"#E24B4A",color:"#fff",borderRadius:"50%",width:18,height:18,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700}}>{critCount}</span>}
            </button>
            </div>
          </div>
        )}
        {activeTab!=="dashboard"&&activeTab!=="projects"&&activeTab!=="planner"&&activeTab!=="users"&&activeTab!=="workspaces"&&activeTab!=="agents"&&(
          <div style={{display:"flex",borderBottom:"0.5px solid #e5e7eb",background:"#fff",padding:"0 20px",flexShrink:0,overflowX:"auto"}}>
            {TABS.map(tab=><div key={tab.key} onClick={()=>setActiveTab(tab.key)} style={{padding:"10px 14px",fontSize:13,cursor:"pointer",borderBottom:activeTab===tab.key?"2px solid #7F77DD":"2px solid transparent",color:activeTab===tab.key?"#7F77DD":"#6b7280",fontWeight:activeTab===tab.key?500:400,marginBottom:-0.5,whiteSpace:"nowrap"}}>{tab.l}</div>)}
          </div>
        )}
        {activeTab==="board"&&<DailyDigest boards={data.boards} members={data.members} activeMemberId={activeMember}/>}
        <div style={{flex:1,overflow:"auto"}}>
          {activeTab==="dashboard" &&<DashboardView data={data} onGoPlanner={()=>setActiveTab("planner")} onGoProjects={()=>setActiveTab("projects")} onGoBoard={i=>{setAP(i);setActiveTab("board");}} onOpenTask={(t,pi)=>{setAP(pi);setActiveTab("board");setPendingOpenTaskId(t.id);}} onOpenBriefing={()=>setScopeAvatar("global")} onCompleteTask={completeTaskAnywhere} onPostponeTask={postponeTaskAnywhere}/>}
          {activeTab==="projects"  &&<ProjectsView projects={data.projects} members={data.members} boards={data.boards} onSelectProject={i=>{setAP(i);setActiveTab("board");}} onCreateProject={()=>setProjModal("create")} onEditProject={i=>setProjModal(i)} onDeleteProject={deleteProject}/>}
          {activeTab==="users"     &&<UsersView members={data.members} projects={data.projects} onEdit={m=>setMemberModal(m)} onCreate={()=>setMemberModal("create")} onDelete={deleteMember}/>}
          {activeTab==="workspaces"&&<WorkspacesView workspaces={data.workspaces||[]} projects={data.projects} boards={data.boards} onCreate={()=>setWorkspaceModal("create")} onEdit={w=>setWorkspaceModal(w)} onSelectProject={i=>{setAP(i);setActiveTab("board");}}/>}
          {activeTab==="agents"    &&<AgentsView agents={data.agents||[]} onCreate={()=>setAgentModal("create")} onEdit={a=>setAgentModal(a)}/>}
          {activeTab==="board"     &&<BoardView board={board} members={data.members} projectMemberIds={proj.members} activeMemberId={activeMember} aiSchedule={data.aiSchedule} workspaceLinks={(data.workspaces||[]).find(w=>w.id===proj.workspaceId)?.links||[]} agents={data.agents||[]} externalOpenTaskId={pendingOpenTaskId} onExternalTaskConsumed={()=>setPendingOpenTaskId(null)} onUpdate={updateTask} onMove={moveTask} onAddTask={addTask}/>}
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
