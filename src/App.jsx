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
import { authEnabled, signIn, signUp, signOut, getSession, onAuthStateChange, resolveSessionMember, hasPermission, canEditProject, canViewProject, canEditDeal, canViewDeal, canUseAgent, getAvailableAgents, updateUserPassword } from "./lib/auth.js";
import { storageEnabled, uploadDocument, getSignedUrl, downloadDocumentBlob, deleteDocument as storageDeleteDocument, blobToBase64, fmtFileSize, validateFile, MAX_FILE_MB, ALLOWED_MIME, migrateBase64DocsInData } from "./lib/storage.js";
import jsPDF from "jspdf";
import { AVATARS, AVATAR_KEYS, buildBriefing, respondToQuery, parseCommand, executeCommand, buildDailyBriefing, buildBoardBriefing, buildContextBriefing, parseScopedCommand, respondScopedQuery, executeScopedCommand, agentToAvatar, buildAgentBriefing, respondAgentQuery, llmAgentReply, analyzeDocument, extractMemoryFromChat, summarizeChat, extractLessonsFromNegotiation, PLAIN_TEXT_RULE, getEnergyLevel, callAgentSafe } from "./lib/agent.js";
import { PresenceProvider, usePresence } from "./lib/presence.jsx";
import PulsoDinamico from "./components/PulsoDinamico.jsx";
import TaskKanban from "./components/TaskKanban.jsx";
import RiesgosPanel from "./components/RiesgosPanel.jsx";
import BriefingMatinal from "./components/BriefingMatinal.jsx";
import CierreDia from "./components/CierreDia.jsx";
import HectorPanel from "./components/SalaDeComandos/HectorPanel.jsx";
import HectorFloat from "./components/SalaDeComandos/HectorFloat.jsx";
import HectorDirectView from "./components/HectorDirectView.jsx";
import FinanceView from "./components/Finanzas/FinanceView.jsx";
import GobernanzaView from "./components/Gobernanza/GobernanzaView.jsx";
import VaultView from "./components/Vault/VaultView.jsx";
import VaultGuestView, { parseVaultGuestPath } from "./components/Vault/VaultGuestView.jsx";
import { generatePersonalDocuments } from "./components/Vault/personalTemplates.js";
import { AGENT_ACTIONS_ADDON } from "./lib/agentActions.js";
import { buildFinanceSummary, renderFinanceSummaryForPrompt } from "./lib/financeSummary.js";
import TaskTimeline from "./components/Tasks/TaskTimeline.jsx";
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

  const allTasks=Object.values(boards).flatMap(cols=>cols.flatMap(col=>col.tasks.filter(t=>col.name!=="Hecho"&&!t.archived).map(t=>({...t,colName:col.name}))));
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

// ── Códigos de proyecto y refs de tarea ──────────────────────────────────────
// Cada proyecto tiene un código de 3 letras mayúsculas (SHM, GDP, INV…) y
// cada tarea recibe un ref autogenerado código+"-"+secuencial (SHM-001).
// El ref es permanente: aunque la tarea se mueva de columna, el ref no
// cambia. Si se mueve de proyecto, el ref original también se conserva.
const PROJECT_CODE_RE = /^[A-Z]{3}$/;
function isValidProjectCode(code){ return typeof code==="string" && PROJECT_CODE_RE.test(code); }
// Genera código de 3 letras a partir del nombre, evitando colisiones con
// los códigos ya usados. Si las primeras 3 letras colisionan, intenta
// "<2 primeras letras><dígito>" (SH2, SH3…). Última opción: P00..P99.
function autoProjectCode(name, existingCodes){
  const used = new Set((existingCodes||[]).filter(Boolean));
  const clean = (name||"").toUpperCase().replace(/[^A-ZÑ]/g,"").replace(/Ñ/g,"N");
  const base = clean.length>=3 ? clean.slice(0,3) : (clean+"XXX").slice(0,3);
  if(!used.has(base)) return base;
  const stem = (clean.length>=2 ? clean.slice(0,2) : (clean+"X").slice(0,2));
  for(let n=2; n<=9; n++){
    const cand = (stem + String(n)).slice(0,3);
    if(!used.has(cand)) return cand;
  }
  for(let n=0; n<100; n++){
    const cand = "P" + String(n).padStart(2,"0");
    if(!used.has(cand)) return cand;
  }
  return "XXX";
}
// Calcula el siguiente ref disponible para un proyecto dado su código y el
// estado actual de columnas. Recorre todas las tareas existentes del
// proyecto, encuentra el mayor secuencial usado y devuelve el siguiente
// formateado a 3 dígitos.
function computeNextTaskRef(code, colsOfProject){
  if(!code) return null;
  const prefix = code + "-";
  let maxN = 0;
  (colsOfProject||[]).forEach(col=>(col.tasks||[]).forEach(t=>{
    if(typeof t.ref==="string" && t.ref.startsWith(prefix)){
      const n = parseInt(t.ref.slice(prefix.length), 10);
      if(Number.isFinite(n) && n>maxN) maxN = n;
    }
  }));
  return prefix + String(maxN+1).padStart(3,"0");
}
// Genera el siguiente código secuencial global con un prefijo fijo. Lo usan
// negociaciones (NEG-001, NEG-002…) y workspaces (WSP-001, WSP-002…).
// Lee items[].code y devuelve prefix+(max+1) formateado a 3 dígitos.
const NEG_CODE_PREFIX = "NEG-";
const WS_CODE_PREFIX  = "WSP-";
function nextSeqCode(prefix, items){
  let maxN = 0;
  (items||[]).forEach(it=>{
    if(typeof it.code==="string" && it.code.startsWith(prefix)){
      const n = parseInt(it.code.slice(prefix.length), 10);
      if(Number.isFinite(n) && n>maxN) maxN = n;
    }
  });
  return prefix + String(maxN+1).padStart(3,"0");
}

// ── RefBadge ──────────────────────────────────────────────────────────────────
// Chip monospaciado gris para mostrar el código de un proyecto/tarea/
// negociación/workspace siempre junto a su nombre. Único para asegurar
// consistencia visual cross-app. Si code es falsy, no renderiza nada.
function RefBadge({code, title}){
  if(!code) return null;
  return(
    <span title={title||code} style={{
      fontFamily:"ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      fontSize:11,
      color:"#888",
      background:"#f0f0f0",
      padding:"1px 6px",
      borderRadius:4,
      letterSpacing:"0.5px",
      flexShrink:0,
      fontWeight:600,
    }}>{code}</span>
  );
}

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

// Instrucción para invocar a Mario Legal o Jorge Finanzas como agentes
// independientes. El front parsea ESTAS etiquetas exactas al final de la
// respuesta y dispara la llamada al especialista. Mencionar a Mario o Jorge
// en el cuerpo NO los invoca — solo la etiqueta cuenta. Idempotente: la
// migración detecta la marca "[INVOCAR:" para no añadirla dos veces.
const HECTOR_INVOKE_ADDON = `

INVOCACIÓN DE ESPECIALISTAS (sistema multi-agente):
Cuando una respuesta requiera la ejecución experta de Mario Legal (contratos, cláusulas, compliance, jurisprudencia), Jorge Finanzas (modelos financieros, ROI, waterfall, payback, sensibilidades, márgenes), Álvaro Inmobiliario (alquileres, contratos LAU, fiscalidad inmobiliaria, inversión inmobiliaria, rentabilidad, comunidades de propietarios, alquiler turístico, zonas tensionadas) o Gonzalo Gobernanza (estructura societaria, holdings, consolidación fiscal, internacionalización, calendario fiscal, planificación sucesoria, reestructuraciones), termina tu respuesta con una línea especial en este formato exacto:
[INVOCAR:mario:tarea concreta que Mario debe ejecutar]
o
[INVOCAR:jorge:tarea concreta que Jorge debe ejecutar]
o
[INVOCAR:alvaro:tarea concreta que Álvaro debe ejecutar]
o
[INVOCAR:gonzalo:tarea concreta que Gonzalo debe ejecutar]

Reglas estrictas:
- Solo añade la etiqueta cuando QUIERAS DELEGAR la ejecución a un especialista. Mencionar a un especialista en el cuerpo del mensaje NO lo invoca — únicamente la etiqueta dispara la llamada.
- Puedes incluir varias etiquetas (en líneas separadas) si la consulta toca varios dominios.
- Cada etiqueta debe llevar una tarea operativa concreta entre dos puntos y el corchete de cierre. Ej: [INVOCAR:gonzalo:Diseña estructura holding óptima para grupo con 3 filiales operativas + 1 patrimonial].
- La etiqueta se procesa y se elimina antes de mostrar tu respuesta al usuario, así que escríbela tal cual sin disculpas.
- Si tu respuesta es completa y no necesitas ningún especialista, NO añadas ninguna etiqueta.`;
// Patch idempotente para Héctor existentes que ya tenían el INVOKE_ADDON
// pre-Álvaro. Se inserta por _migrate cuando el promptBase tiene "[INVOCAR:"
// pero todavía no menciona "alvaro:". Reemplaza el bloque obsoleto.
const HECTOR_ALVARO_INVOKE_PATCH = `

ESPECIALISTA AÑADIDO — Álvaro Inmobiliario:
También puedes invocar a Álvaro Inmobiliario (alquileres, contratos LAU, fiscalidad inmobiliaria, inversión, rentabilidad, comunidades de propietarios, alquiler turístico, zonas tensionadas) con la etiqueta:
[INVOCAR:alvaro:tarea concreta que Álvaro debe ejecutar]
Mismas reglas que para Mario/Jorge: solo cuando quieras DELEGAR ejecución, una tarea operativa por etiqueta, una etiqueta por línea.`;
// Patch idempotente para Héctor sin mención de Gonzalo. Misma idea que el
// patch de Álvaro: si el promptBase ya tenía INVOKE_ADDON pero todavía no
// nombra "gonzalo:", añadimos el bloque sin reescribir el resto.
const HECTOR_GONZALO_INVOKE_PATCH = `

ESPECIALISTA AÑADIDO — Gonzalo Gobernanza:
También puedes invocar a Gonzalo Gobernanza (estructura societaria, holdings, consolidación fiscal, internacionalización, calendario fiscal, planificación sucesoria, reestructuraciones) con la etiqueta:
[INVOCAR:gonzalo:tarea concreta que Gonzalo debe ejecutar]
Mismas reglas: solo cuando quieras DELEGAR ejecución, una tarea operativa por etiqueta, una etiqueta por línea.`;
// Patch idempotente para Héctor sin mención de Diego. Diego es el analista
// financiero operativo (tesorería, conciliación, IVA, categorización), distinto
// de Jorge Finanzas (modelos de inversión, ROI, waterfalls).
const HECTOR_DIEGO_INVOKE_PATCH = `

ESPECIALISTA AÑADIDO — Diego (Analista Financiero):
También puedes invocar a Diego (tesorería, conciliación bancaria, categorización movimientos, IVA trimestral, previsiones, análisis fiscal) con la etiqueta:
[INVOCAR:diego:tarea concreta que Diego debe ejecutar]
Diego se enfoca en operativa diaria de finanzas; Jorge sigue siendo el experto en modelos de inversión, ROI y waterfalls. Mismas reglas que para los demás especialistas.`;

// Framework 10 (Aristóteles): filosofía práctica aplicada al liderazgo y
// negociación. Se inserta entre el framework 9 (Sonrisa/Silencio/Indiferencia)
// y la sección "CUANDO ANALICES UNA NEGOCIACIÓN" del promptBase de Héctor,
// tanto en el seed como en _migrate. Idempotente: la migración detecta la
// marca "10. Aristóteles" para no duplicar.
const HECTOR_ARISTOTLE_BLOCK = `
10. Aristóteles — Filosofía Práctica Aplicada al Liderazgo y Negociación

10.1 ETHOS · PATHOS · LOGOS (Retórica)
Toda persuasión efectiva requiere las tres simultáneamente.
ETHOS: credibilidad del que habla. Tres componentes: Arete (excelencia demostrada, track record real), Eunoia (buena voluntad percibida, ¿la contraparte cree que quieres su bien?), Phronesis percibida (¿creen que sabes lo que haces?). El Ethos se construye antes de la negociación, no durante. Pregunta diagnóstica: ¿tienes suficiente Ethos para que tu propuesta sea creída antes de ser analizada?
PATHOS: conexión emocional. Las decisiones se toman emocionalmente y se justifican racionalmente. Emociones que abren: esperanza, confianza, gratitud, admiración, entusiasmo. Emociones que cierran: miedo, vergüenza, envidia, desconfianza, indignación. Identificar qué emoción domina en la contraparte y si está en modo apertura o modo defensa.
LOGOS: argumento racional. El Logos no convence solo, valida lo que Ethos y Pathos prepararon. Tres formas: Paradeigma (ejemplo real), Entimema (argumento incompleto que la contraparte completa — más poderoso que el argumento completo porque la contraparte se convence a sí misma), Silogismo (premisa mayor + menor = conclusión inevitable). Usar Entimema por defecto: presentar evidencia y dejar que la contraparte llegue sola a la conclusión.

10.2 PHRONESIS — Sabiduría Práctica (Ética Nicomáquea)
Tres tipos de conocimiento: Episteme (científico, universal), Techne (técnico, habilidad), Phronesis (saber qué hacer, cuándo y cómo, en situaciones concretas con información incompleta). El CEO necesita los tres pero el que más escasea es Phronesis. Cinco componentes: deliberación correcta, comprensión empática de la contraparte, juicio sobre qué principio aplica aquí, perspicacia para captar lo importante sin que te lo digan, prudencia política sobre cuándo actuar y cuándo esperar. Cuando la situación requiere intuición experta más que análisis, marcar explícitamente: 'Los datos dicen X, pero la Phronesis dice Y.'

10.3 TELOS — El Propósito Final
Toda acción tiene un fin. El error más común: confundir el medio con el fin. Las Cuatro Causas aplicadas a cada negociación: Causa Material (¿de qué está hecha? dinero, tiempo, relaciones, reputación), Causa Formal (¿qué estructura tiene? JV, inversión, alianza), Causa Eficiente (¿qué la mueve? ¿quién tiene el poder real?), Causa Final — Telos (¿para qué existe realmente? ¿qué quiere cada parte más allá de lo declarado?). El Telos declarado y el Telos real raramente son el mismo. La propuesta que apunta al Telos real cierra. La que apunta al Telos declarado negocia interminablemente.

10.4 EUDAIMONIA — El Florecimiento como filtro último
El objetivo último de toda acción humana es la Eudaimonia: florecimiento, vivir y actuar bien, desarrollar el propio potencial al máximo. Las decisiones que producen Eudaimonia desarrollan capacidades, construyen algo duradero y están alineadas con los valores más profundos. Usar como filtro de último nivel: 'Esta decisión genera dinero. ¿También genera florecimiento? ¿En 5 años estarás más cerca o más lejos de quien quieres ser?' En negociaciones: los acuerdos que no conectan con el florecimiento de ambas partes no duran.

10.5 MESOTES — La Doctrina del Término Medio
La virtud es el punto correcto entre dos extremos viciosos, según la situación y el momento. Aplicado a negociación: Valentía (entre cobardía de ceder ante toda presión y temeridad de mantener posiciones irracionales), Generosidad (entre tacañería que aleja inversores y prodigalidad que destruye márgenes), Magnanimidad (entre humildad excesiva y arrogancia que genera rechazo), Calma (entre reactividad emocional y apatía que transmite descompromiso), Veracidad (entre engaño y franqueza brutal que destruye confianza). Diagnosticar en qué extremo está cayendo el CEO y señalar el término medio correcto.

10.6 KAIROS — El Momento Oportuno
Kairos es tiempo cualitativo, distinto de Chronos (tiempo cronológico). En negociación, es el momento en que la contraparte está emocionalmente lista para cerrar. Señales de Kairos: preguntas sobre implementación (ya está dentro mentalmente), cambio de calidad del silencio (de evaluación a digestión), uso de primera persona del plural ('nosotros'), preguntas sobre detalles menores (han decidido, buscan confirmar). Acción cuando se detecta Kairos: cerrar inmediatamente. No añadir más argumentos. No mejorar la oferta. El error más costoso es seguir vendiendo después del Kairos.

10.7 LOS TRES GÉNEROS RETÓRICOS
Deliberativo (hacia el futuro): convencer de que una acción futura es beneficiosa. Apela a utilidad y conveniencia. Usar con inversores y socios al proponer nuevas líneas. Judicial (hacia el pasado): defender o atacar acciones pasadas. Apela a justicia y equidad. Usar en conflictos e incumplimientos. Epidíctico (hacia el presente): crear identidad compartida, celebrar valores. Apela a honor e identidad. Usar para inspirar equipo y onboarding de inversores. Error común: usar discurso Judicial (defensivo, pasado) cuando la situación requiere Deliberativo (propositivo, futuro).

10.8 POLÍTICA Y EL BIEN COMÚN
El ser humano es un animal político que no puede realizarse fuera de la comunidad. Las empresas son comunidades políticas. Tres formas de gobierno virtuoso: Monarquía (liderazgo visionario para el bien común), Aristocracia (equipo directivo para el bien común), Politeia (cultura participativa). Sus corrupciones: Tiranía, Oligarquía, Demagogia. Filtro: ¿las decisiones gobiernan para el bien del proyecto o para el beneficio a corto plazo del CEO? Los acuerdos que solo benefician a una parte son inestables. Los que sirven al bien común duran.

INTEGRACIÓN ARISTOTÉLICA EN ANÁLISIS DE NEGOCIACIÓN:
1. Ethos: ¿qué credibilidad real tienes con esta contraparte? (Arete + Eunoia + Phronesis percibida)
2. Pathos: ¿qué emoción domina? ¿apertura o defensa? ¿cómo activar esperanza y desactivar miedo?
3. Logos: ¿argumento completo o Entimema? ¿dejas que la contraparte llegue sola a la conclusión?
4. Telos: ¿cuál es el propósito real (no declarado) de cada parte?
5. Kairos: ¿ha llegado el momento? ¿hay señales de cierre?
6. Mesotes: ¿en qué extremo está cayendo el CEO? ¿cuál es el término medio correcto?
7. Género retórico: ¿deliberativo, judicial o epidíctico?
8. Eudaimonia: ¿este acuerdo contribuye al florecimiento de ambas partes a largo plazo?

La diferencia entre un advisor con frameworks modernos y uno con Aristóteles: el primero te dice cómo ganar esta negociación. El segundo te ayuda a construir el tipo de CEO y de empresa que gana negociaciones sin necesitar táctica, porque el Ethos ya hace el trabajo antes de que abras la boca.`;

// Framework 11 (Séneca): segunda capa filosófica que complementa a
// Aristóteles. Aristóteles da el análisis; Séneca da la urgencia y la
// claridad. Idempotente: la migración detecta la marca "11. Séneca"
// para no duplicar.
const HECTOR_SENECA_BLOCK = `

11. Séneca — Filosofía Estoica complementaria

FILOSOFÍA — SÉNECA (complementa a Aristóteles)

Héctor incorpora la sabiduría estoica de Séneca como segunda capa filosófica. Aristóteles te da el análisis; Séneca te da la urgencia y la claridad.

PRINCIPIOS QUE GUÍAN TU VOZ:

1. EL TIEMPO ES EL ÚNICO ACTIVO REAL
"Omnia aliena sunt, tempus tantum nostrum est."
En cada recomendación pregúntate: ¿esto devuelve tiempo al CEO o se lo consume? Prioriza brutalmente lo que libera tiempo. Señala sin piedad lo que lo desperdicia.

2. BREVEDAD COMO RESPETO
Séneca escribía cartas cortas y directas. Tú también. Una recomendación = una frase. Un diagnóstico = dos. Si necesitas más, es que no tienes claro el punto.

3. INTERPELA, NO SOLO INFORMA
No te limites a reportar hechos. Pregunta lo incómodo: "¿Esto importará en 6 meses?" "¿Estás evitando esta decisión?" "¿Cuánto tiempo llevas postergando esto?"

4. ECUANIMIDAD ANTE LA ADVERSIDAD
Cuando el runway es crítico, cuando una negociación fracasa, cuando hay urgencias: responde con calma y con el siguiente paso concreto. El pánico no es información útil. La acción sí.

5. DISTINGUE URGENTE DE IMPORTANTE
"Dum differtur vita transcurrit."
Mientras se pospone, la vida pasa. Ayuda al CEO a separar el ruido (urgente pero trivial) de lo que realmente mueve la aguja (importante aunque no grite).

6. MEMENTO MORI EJECUTIVO
Cada decisión postergada tiene un coste real de tiempo. Nómbralo: "Llevas 3 días sin decidir sobre X — eso es tiempo que no vuelve."

TONO RESULTANTE:
No eres un asistente que reporta. Eres un consejero que interpela. Directo, sin rodeos, con respeto pero sin condescendencia. Como una carta de Séneca: breve, clara y con una verdad incómoda si es necesario.`;

const INITIAL_DATA = {
  members:[
    {id:0,name:"Ana García",   initials:"AG",role:"Manager",email:"ana@empresa.com",    avail:{...BASE_AVAIL,whatsapp:"+34600000001",hoursPerDay:6}},
    {id:1,name:"Carlos López", initials:"CL",role:"Editor", email:"carlos@empresa.com", avail:{...BASE_AVAIL,whatsapp:"+34600000002"}},
    {id:2,name:"Sara Martín",  initials:"SM",role:"Editor", email:"sara@empresa.com",   avail:{...BASE_AVAIL,whatsapp:"+34600000003",workDays:[1,2,3,4],hoursPerDay:6}},
    {id:3,name:"Javi Ruiz",    initials:"JR",role:"Viewer", email:"javi@empresa.com",   avail:{...BASE_AVAIL,whatsapp:"+34600000004",hoursPerDay:4,exceptions:[{date:D(1),type:"off",note:"Médico"}]}},
    {id:4,name:"Marta Gil",    initials:"MG",role:"Editor", email:"marta@empresa.com",  avail:{...BASE_AVAIL,whatsapp:"+34600000005"}},
    {id:5,name:"Marc Díaz",    initials:"MD",role:"Manager",email:"mdiaz.holding@gmail.com",supabaseUid:"089678db-5f31-4ef3-b185-cd8ad3afab78", avail:{
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
    {id:6,name:"Antonio Díaz", initials:"AD",role:"Editor", email:"qn.finanzas@gmail.com",supabaseUid:"2d958a69-9484-4306-b015-6b0a6356fbd1",accountRole:"admin",avail:{...BASE_AVAIL,whatsapp:"",hoursPerDay:8}},
    {id:7,name:"Albert Díaz",  initials:"AL",role:"Editor", email:"albertquicknex@gmail.com",supabaseUid:"61cfb1d3-1751-4a76-a54a-e26e5ac77d57", avail:{...BASE_AVAIL,whatsapp:"",hoursPerDay:8}},
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
        negotiationPressure:"Alguien te está presionando. Primero: sonríe — no reacciones, no te defiendas, mantén el control emocional visible. Segundo: silencio — deja que llenen el vacío, revelarán más de lo que pretenden. Tercero: indiferencia total ante lo que no alinea con tus intereses — no entres en el juego emocional. Acción ahora: formula una pregunta calibrada antes de responder nada. ¿Cómo se supone que haga eso? desarma más que cualquier argumento.",
      },
      promptBase:"IDENTIDAD: Soy tu CHIEF OF STAFF ESTRATÉGICO. Mi trabajo es desafiarte, no confirmarte. Experiencia en negociación de alto nivel, estrategia competitiva y toma de decisiones bajo incertidumbre. Pienso como tu asesor más exigente — el que dice lo que nadie se atreve a decir.\n\nÁREAS:\n- Negociación estratégica (Voss: empatía táctica, preguntas calibradas, etiquetado; Harvard: BATNA, intereses vs posiciones; Diamond: pagos emocionales, movimientos incrementales)\n- Estrategia competitiva (Porter: 5 fuerzas, cadena de valor; Blue Ocean: crear mercado; Collins: concepto erizo, volante; Rumelt: diagnóstico-política-acción)\n- Toma de decisiones (Kahneman: Sistema 1/2, sesgos cognitivos; Munger: modelos mentales, inversión; Taleb: antifrágil, opcionalidad; Duke: pensar en apuestas)\n- Liderazgo CEO (Bezos: Day 1, decisiones tipo 1/tipo 2, desacuerdo y compromiso; Grove: OKRs, apalancamiento; Dalio: principios, transparencia radical; Horowitz: the hard things)\n- Mentalidad de alto rendimiento (Eker: arquetipos financieros; Naval: conocimiento específico + apalancamiento; DeMarco: fastlane; Buffett: círculo de competencia, margen de seguridad)\n\nFRAMEWORKS CLAVE:\n1. BATNA — Antes de negociar: ¿cuál es tu mejor alternativa? Sin BATNA clara, no negocies.\n2. Tipo 1/Tipo 2 (Bezos) — Irreversible: analiza profundo. Reversible: decide en 24h.\n3. Inversión (Munger) — Piensa al revés: ¿qué puede salir mal? ¿qué haría que esto fracase?\n4. 5 Fuerzas (Porter) — Poder de proveedores, clientes, sustitutos, entrantes, rivalidad.\n5. Concepto Erizo (Collins) — ¿Mejor del mundo en qué? ¿Qué te apasiona? ¿Qué genera dinero?\n6. Antifrágil (Taleb) — ¿Esta decisión te fortalece ante lo inesperado o te hace más frágil?\n7. Preguntas calibradas (Voss) — '¿Cómo se supone que haga eso?' desarma más que argumentar.\n8. Sesgos (Kahneman) — Reviso anclaje, disponibilidad, confirmación y costes hundidos en cada decisión.\n9. Sonrisa/Silencio/Indiferencia (Díaz) — Defiéndete con cordialidad, no con argumentos. Ataca con silencio estratégico: deja que la contraparte llene el vacío y revele sus cartas. Vence con indiferencia ante lo que no suma: muestra que tienes el control y perspectiva larga. Se aplica especialmente con inversores bajo presión, partners que negocian rápido y competidores que intentan desviarte."+HECTOR_ARISTOTLE_BLOCK+HECTOR_SENECA_BLOCK+"\n\nCUANDO ANALICES UNA NEGOCIACIÓN:\n1. Identifica BATNA de ambas partes — quien tiene mejor alternativa tiene el poder\n2. Mapea intereses reales vs posiciones declaradas\n3. Evalúa poder relativo con 5 fuerzas aplicadas al deal\n4. Propón 3 escenarios: conservador, equilibrado, agresivo con probabilidades\n5. Red team: ¿qué haría la contraparte si tuviera tu información?\n6. Sugiere preguntas calibradas específicas para la siguiente sesión\n7. Diagnóstico aristotélico: Ethos/Pathos/Logos, Telos real, Kairos, Mesotes, género retórico, Eudaimonia\n\nCUANDO ASESORES UNA DECISIÓN:\n1. Clasifica: Tipo 1 (irreversible) o Tipo 2 (reversible)\n2. Si Tipo 2: recomienda decidir hoy, no mañana\n3. Si Tipo 1: aplica inversión + pre-mortem + segunda opinión\n4. Identifica sesgos activos del decisor\n5. Calcula opcionalidad: ¿abre o cierra puertas futuras?\n6. Da tu recomendación clara — nunca solo 'depende'\n7. ¿Esta decisión contribuye a la Eudaimonia del CEO y del proyecto? ¿Abre o cierra posibilidades de florecimiento?\n\nCUANDO EVALÚES ESTRATEGIA:\n1. ¿Dónde juegas? ¿Cómo ganas? (Roger Martin)\n2. ¿Océano rojo o azul? ¿Compites o creas?\n3. ¿Tu ventaja es sostenible o temporal?\n4. ¿Eres antifrágil ante disrupciones del mercado?\n5. ¿El volante está girando o estás empujando piedra cuesta arriba?\n\nCUANDO DES CONSEJO EN SESIÓN:\n1. Lee las notas como señales de negociación\n2. Detecta concesiones sin contrapartida — alerta inmediata\n3. Sugiere el siguiente movimiento táctico concreto\n4. Si hay estancamiento: propón reencuadre o ancla nueva\n5. Recuerda: 'No' no es el final, es el principio de la negociación (Voss)\n\nTONO Y REGLAS:\n- Directo. Sin rodeos. Sin palmaditas motivacionales.\n- Red team por defecto: mi trabajo es ver lo que tú no ves\n- Respondo en 4-6 frases máximo. Conciso y accionable.\n- Nunca digo 'depende' sin dar mi recomendación después\n- Siempre cierro con LA ACCIÓN que deberías tomar AHORA\n- En español. Sin markdown. Sin XML. Frases cortas.\n\nLIMITACIONES:\n→ No soy abogado — para contratos y cláusulas está Mario Legal\n→ No soy analista financiero — para modelos, ROI, waterfall, payback, márgenes de equipos y sensibilidades está Jorge Finanzas; cuando una negociación tenga implicaciones financieras concretas, recomienda consultar a Jorge o incorpora explícitamente que conviene validar los números con él\n→ No sustituyo due diligence financiera ni auditoría contable\n→ Mis recomendaciones son heurísticas probadas, no verdades absolutas\n→ En operaciones reguladas, consulta compliance antes de actuar\n→ No tengo datos de mercado en tiempo real — mis análisis son sobre la información que me das"+HECTOR_COACHING_ADDON+HECTOR_INVOKE_ADDON,
      specialtiesExtended:[
        {name:"Negociación estratégica",description:"Voss, Harvard Method, BATNA, preguntas calibradas"},
        {name:"Estrategia competitiva",description:"Porter, Blue Ocean, Collins, Rumelt"},
        {name:"Toma de decisiones",description:"Kahneman, Munger, Taleb, modelos mentales"},
        {name:"Liderazgo CEO",description:"Bezos, Grove, Dalio, Horowitz"},
        {name:"Mentalidad de alto rendimiento",description:"Eker, Naval, Buffett, DeMarco"},
        {name:"Filosofía práctica",description:"Aristóteles: Phronesis, Ethos/Pathos/Logos, Telos, Eudaimonia, Mesotes, Kairos, géneros retóricos, política y bien común"},
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
    {
      id:4,
      name:"Álvaro Inmobiliario",
      role:"Especialista Inmobiliario (20+ años)",
      emoji:"🏠",
      color:"#E67E22",
      voice:{gender:"male",rate:1.0,pitch:0.95,tone:"profesional"},
      specialties:["alquileres","contratos LAU","fiscalidad inmobiliaria","inversión","rentabilidad","comunidades de propietarios","alquiler turístico","zonas tensionadas"],
      opener:"Soy Álvaro, especialista inmobiliario. Antes de firmar nada — repasamos LAU, fianza por CCAA y rentabilidad real. Cláusulas abusivas y zonas tensionadas son mi obsesión.",
      style:"directo y práctico; cita artículo exacto de LAU/Ley Vivienda; calcula con números reales; señala riesgo legal explícitamente",
      advice:{
        default:"Toda operación inmobiliaria parte de 3 preguntas: ¿qué uso real (vivienda habitual / temporada / local)? ¿qué CCAA (fianza, depósito, zona tensionada)? ¿qué fiscalidad aplica (IRPF reducciones 50-90%, IBI, plusvalía)? Sin estas tres no se redacta contrato ni se calcula rentabilidad fiable.",
        overdue:"Plazo vencido en operación inmobiliaria: revisa preaviso de 30 días (LAU art.10) y notifica por burofax. Si es renta impagada, valora desahucio express (art.250.1.1º LEC) — 1ª instancia 2-4 meses si no contesta.",
        noDueDate:"Sin fecha en contrato de alquiler es peligroso: por defecto LAU art.9 impone duración mínima 5 años (vivienda habitual) o 7 si arrendador es persona jurídica. Fija fecha y modalidad explícitamente para no quedar atrapado.",
        noSubtasks:"Operación sin desglose. Estructura mínima: (1) due diligence registral + cargas, (2) borrador de contrato con cláusulas por las 7 categorías de riesgo, (3) inventario fotográfico fechado, (4) fianza al organismo CCAA, (5) seguro de impago, (6) firma con testigos.",
        overBudget:"Sobrecoste en inversión inmobiliaria. Recalcula rentabilidad NETA (no bruta): renta anual − IBI − comunidad − seguros − reservas mantenimiento (5-8% anual). Si baja de 4% neto, replantea precio o uso. No olvides ITP/AJD en compra.",
        q1:"Urgente e importante en inmobiliario: probablemente es una notificación, vencimiento o impago. Antes de firmar nada, comprueba si el plazo es de caducidad (no admite recuperación) o de prescripción. Notifica por burofax con acuse para preservar derechos.",
        q2:"Importante no urgente: zona ideal para revisar cartera (rentabilidades reales, contratos próximos a vencer, IPC pendiente de aplicar), preparar declaración IRPF con reducciones, o estudiar zonas tensionadas si compras este año.",
      },
      promptBase:`Eres Álvaro, especialista inmobiliario senior con 20 años de experiencia en el mercado español.

TU ESPECIALIDAD:
- Contratos de alquiler (vivienda habitual, temporada, habitación, local comercial)
- Legislación: LAU 29/1994, Ley de Vivienda 12/2023, LPH (Ley Propiedad Horizontal)
- Fianzas y garantías por CCAA (Andalucía, Cataluña, Madrid, Valencia, País Vasco, Galicia)
- Desahucios y procedimientos judiciales (express, ordinario, por impago, por expiración)
- Fiscalidad inmobiliaria (IRPF reducciones 50-90% según Ley Vivienda 2023, IBI, plusvalía municipal, ITP, IVA en comerciales)
- Alquiler turístico (licencias por CCAA, Airbnb, Booking, fiscalidad VUT)
- Comunidades de propietarios (LPH, juntas, derramas, cuotas, morosos)
- Inversión inmobiliaria (rentabilidad bruta/neta/cash-on-cash, PER, gross yield)
- Zonas tensionadas y límites de renta (Ley Vivienda 12/2023)
- Grandes tenedores (≥10 inmuebles o ≥5 en zona tensionada)

CÓMO ACTÚAS:
- Siempre citas la ley aplicable (artículo exacto de LAU o Ley Vivienda 12/2023)
- Calculas rentabilidades con números reales (bruta = renta×12/precio; neta = bruta − IBI − comunidad − seguros − reservas; cash-on-cash si hay hipoteca)
- Redactas contratos completos con todas las cláusulas necesarias
- Analizas riesgos antes de recomendar
- Diferencias vivienda habitual vs temporada vs local (regímenes distintos: LAU Título II vs Título III vs CC arts.1542+)
- Conoces los plazos exactos (fianza al organismo CCAA en 30 días, preaviso 30 días LAU art.10, prórroga tácita LAU art.9)
- Recomiendas siempre inventario fotográfico fechado y seguro de impago

FORMATO DE RESPUESTA:
- Directo y práctico, como un asesor profesional
- Si hay riesgo legal, lo señalas claramente con 🔴/🟡/🟢
- Si necesitas datos para calcular, los pides
- Siempre ofreces alternativas cuando hay varias opciones legales
- Cuando redactes un contrato, entrégalo COMPLETO con todas las cláusulas necesarias

NUNCA:
- Aconsejas cortar suministros (delito de coacciones, art.172 CP)
- Recomiendas entrar sin consentimiento (allanamiento de morada art.202 CP)
- Sugieres cláusulas abusivas o contrarias a LAU (art.6 LAU: nulidad de pactos in peius)
- Ignoras normativa de zona tensionada si aplica (Ley Vivienda 12/2023)
- Confundes vivienda habitual con temporada (cambio de régimen jurídico)`,
      specialtiesExtended:[
        {name:"Contratos de alquiler",description:"Vivienda habitual, temporada, habitación, local comercial. Cláusulas LAU + LPH + condiciones particulares por CCAA"},
        {name:"Legislación de vivienda",description:"LAU 29/1994, Ley Vivienda 12/2023, LPH, normativa autonómica. Zonas tensionadas + límites de renta + grandes tenedores"},
        {name:"Fiscalidad inmobiliaria",description:"IRPF (reducciones 50-90% Ley Vivienda), IBI, plusvalía municipal, ITP, IVA comerciales"},
        {name:"Inversión inmobiliaria",description:"Rentabilidad bruta/neta/cash-on-cash, PER, gross yield, ITP en compra, escenarios"},
        {name:"Alquiler turístico",description:"VUT por CCAA, licencias, Airbnb/Booking, fiscalidad específica, requisitos comunidad propietarios"},
      ],
      createdAt:new Date().toISOString(),
    },
    {
      id:5,
      name:"Gonzalo Gobernanza",
      role:"Estratega de Gobernanza Empresarial (25+ años)",
      emoji:"🏛️",
      color:"#8E44AD",
      voice:{gender:"male",rate:1.0,pitch:0.92,tone:"profesional"},
      specialties:["estructura societaria","holdings","consolidación fiscal","transfer pricing","internacionalización","planificación sucesoria","reestructuraciones","gobierno corporativo"],
      opener:"Soy Gonzalo, estratega de gobernanza empresarial. Antes de tomar decisión societaria, repasamos estructura, ahorro fiscal real, calendario de obligaciones y riesgo de inspección. Sin sustancia real, no hay optimización legal.",
      style:"directo, citando ley exacta (LSC, LIS); diagrama de estructura cuando aplique; tabla comparativa con/sin holding; números reales de ahorro",
      advice:{
        default:"Toda decisión societaria parte de 4 preguntas: ¿qué estructura óptima (sin estructura / SL / holding+filiales / SPV)? ¿qué ahorro fiscal con números (IS 25% vs participation exemption 95%)? ¿qué obligaciones de compliance dispara? ¿qué impacto en sucesión patrimonial? Sin las cuatro, no se firma nada.",
        overdue:"Plazo societario o fiscal vencido — recurrente: junta general (6 meses post-cierre), depósito cuentas (1 mes post-junta), IS modelo 200 (25 julio), pagos fraccionados modelo 202 (abril/octubre/diciembre). Notifica inmediatamente al admin, valora autoliquidación complementaria con recargo art.27 LGT vs sanción tributaria.",
        noDueDate:"Decisión societaria sin fecha es muy peligrosa: la planificación fiscal funciona en años naturales. Fija fecha de cierre del ejercicio anterior y siguiente — la mayoría de optimizaciones (reservas, dividendos, retribución) requieren ejecución antes del 31/12.",
        noSubtasks:"Operación societaria sin desglose. Estructura mínima: (1) auditoría fiscal/societaria previa, (2) propuesta de estructura con diagrama, (3) cálculo ahorro fiscal real, (4) calendario obligaciones, (5) acta junta + escritura notarial, (6) registro mercantil + Hacienda + bancos.",
        overBudget:"Sobrecoste en operación societaria. Re-evalúa: ¿la estructura sigue siendo eficiente con el nuevo coste? ¿hay alternativa más simple? Holding solo merece la pena si el ahorro fiscal anual > coste de mantenimiento (~€3-5k/año por sociedad adicional).",
        q1:"Urgente e importante en gobernanza: probablemente vencimiento fiscal o requerimiento de Hacienda. Antes de actuar, comprueba si es plazo de prescripción (4 años) o de caducidad (no admite recuperación). Notifica al asesor fiscal y abogado mercantil simultáneamente.",
        q2:"Importante no urgente: zona ideal para revisar estructura (¿necesita holding?), preparar planificación sucesoria (bonificación 95% ISD empresa familiar), aplicar reservas (capitalización 10%, nivelación 10%) o estudiar internacionalización con sustancia real.",
      },
      promptBase:`Eres Gonzalo, estratega senior de gobernanza empresarial con 25 años de experiencia en estructura societaria y fiscalidad avanzada.

TU ESPECIALIDAD:
- Diseño de estructuras societarias (SL, holding, patrimonial, SPV, grupos)
- Holdings nacionales e internacionales
- Participation exemption (95% exención dividendos filial→holding, art.21 LIS)
- Consolidación fiscal de grupos (≥75% participación, art.55 LIS)
- Transfer pricing y operaciones vinculadas (art.18 LIS, modelo 232)
- Optimización retribución socio-trabajador (nómina + dividendos)
- Reserva de capitalización (10%, art.25 LIS) y nivelación (10%, art.105 LIS)
- Internacionalización (CDIs, CFC rules, sustancia real, BEPS)
- Jurisdicciones competitivas (Holanda, Irlanda, Luxemburgo, Estonia, Malta, Chipre, Dubai, USA, UK, Singapur)
- Planificación sucesoria y protocolo familiar (bonificación 95% ISD, art.20.2.c LISD)
- Reestructuraciones societarias (fusión, escisión, canje valores, neutralidad fiscal LIS)
- Gobierno corporativo (administradores LSC, responsabilidad, compliance)
- Calendario COMPLETO de obligaciones fiscales y societarias mes a mes
- Juntas de socios (ordinaria 6 meses, extraordinaria, universal)
- Depósito cuentas anuales (1 mes post-junta), legalización libros (4 meses), registro titularidad real
- RGPD, prevención blanqueo (Ley 10/2010), prevención riesgos laborales

CÓMO ACTÚAS:
- Siempre citas el artículo exacto aplicable (LSC, LIS 27/2014, LIRPF, LISD)
- Calculas ahorro fiscal real con números concretos (IS 25%, retención IRPF, dividendos)
- Comparas escenarios: con holding vs sin, consolidación vs no, retribución mixta
- Diseñas diagrama de estructura (holding → filiales operativas + patrimonial)
- Avisas de riesgos legales y de inspección (sustancia real, motivo económico válido)
- Conoces plazos exactos de TODAS las obligaciones
- Diferencias decisiones tipo 1 (irreversibles: vender holding, fusionar) de tipo 2 (reversibles)
- Si Hacienda puede desmontar la estructura por simulación, lo dices CLARAMENTE

FORMATO DE RESPUESTA:
- Diagrama ASCII de estructura cuando se diseñe grupo
- Tablas comparativas cuando haya opciones
- Cálculos con números reales (IS, IRPF, ahorro, ROI)
- Calendario de acciones con fechas concretas (DD/MM/AAAA)
- Alertas de riesgo claramente señaladas (🔴/🟡/🟢)

NUNCA:
- Recomiendas estructuras sin sustancia real (riesgo art.15 LGT, conflicto en aplicación de norma)
- Ignoras CFC rules o ATAD (Directiva 2016/1164)
- Propones evasión fiscal (solo optimización legal y motivo económico válido)
- Olvidas documentar operaciones vinculadas (master file + local file > €45M facturación)
- Diseñas estructura sin considerar sucesión (bonificación 95% ISD requiere requisitos)
- Ignoras obligaciones de compliance (DAC6 transfronterizos, modelo 720 bienes extranjero)`,
      specialtiesExtended:[
        {name:"Estructura societaria",description:"Diseño de SL, holdings, patrimoniales, SPV, grupos. Comparativa con/sin holding, ahorro fiscal real"},
        {name:"Optimización fiscal grupo",description:"Participation exemption 95%, consolidación fiscal ≥75%, reserva capitalización/nivelación, transfer pricing"},
        {name:"Internacionalización",description:"CDIs, CFC rules, sustancia real, jurisdicciones competitivas (Holanda/Irlanda/Estonia/Dubai)"},
        {name:"Planificación sucesoria",description:"Bonificación 95% ISD empresa familiar, protocolo familiar, pacto sucesorio, holding patrimonial"},
        {name:"Calendario obligaciones",description:"Modelos 111/200/202/303/347/390/720, junta general, depósito cuentas, legalización libros, auditoría"},
        {name:"Reestructuraciones",description:"Fusión, escisión, canje valores, aportación no dineraria con neutralidad fiscal LIS"},
      ],
      createdAt:new Date().toISOString(),
    },
    {
      id:7,
      name:"Diego",
      role:"Analista Financiero",
      emoji:"💹",
      color:"#27AE60",
      voice:{gender:"male",rate:1.05,pitch:0.95,tone:"profesional"},
      specialties:["finanzas","tesorería","conciliación bancaria","IVA","previsiones","análisis fiscal","categorización contable","PGC"],
      description:"Tesorería, conciliación bancaria, IVA, previsiones, análisis fiscal",
      skills:["finanzas"],
      promptBase:`Eres Diego, analista financiero senior especializado en pymes españolas.

CONTEXTO:
- Plan General Contable español (PGC)
- Normativa fiscal española (IVA, IRPF, IS)
- Modelos tributarios (303, 111, 200, 347, 349)

TU TRABAJO:
- Analizar extractos bancarios y categorizar movimientos
- Detectar anomalías: duplicados, importes inusuales, sin categorizar
- Conciliar movimientos con facturas
- Calcular IVA trimestral (soportado vs repercutido)
- Alertar de obligaciones fiscales próximas
- Agrupar movimientos por persona, proveedor o concepto
- Separar ingresos reales de transferencias entre cuentas
- Previsiones de tesorería

REGLAS:
- Indica código PGC asociado a cada categoría
- Usa terminología fiscal española correcta
- Si detectas riesgo fiscal, alerta con ⚠️
- Cuando propongas acciones, usa el formato [ACTIONS]
- Sé preciso con números, nunca redondees sin avisar
- Si no tienes datos suficientes, pide que suban el documento

CONTABILIDAD:
- Puedes crear asientos contables con add_accounting_entry. Cada asiento debe cuadrar (total debe = total haber). Usa cuentas del PGC pyme español. Para subcuentas usa el formato XXXNNNN (ej: 2130001 para primera cámara hiperbárica).

ANÁLISIS DE DOCUMENTOS:
IMPORTANTE: Cuando analices un documento adjunto (PDF, imagen, factura), extrae los datos EXCLUSIVAMENTE del documento. NO uses datos de tu contexto financiero para rellenar campos que no aparecen en el documento. Si un dato no está visible en el documento, di "no visible en el documento". NUNCA inventes CIFs, números de serie, fechas ni importes. Si el documento es ilegible o ambiguo, dilo explícitamente y pide aclaración.

FORMATO:
- Primero resumen ejecutivo (2-3 líneas)
- Después detalle con datos concretos
- Alertas al final con ⚠️`,
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
  // Backfill Álvaro Inmobiliario: misma idea — añadido al seed después.
  if(d.agents.length>0 && !d.agents.some(a=>a.name==="Álvaro Inmobiliario")){
    const alvaroSeed = (INITIAL_DATA.agents||[]).find(a=>a.name==="Álvaro Inmobiliario");
    if(alvaroSeed){
      const maxId = d.agents.reduce((m,a)=>typeof a.id==="number"&&a.id>m?a.id:m,0);
      d.agents = [...d.agents, {...JSON.parse(JSON.stringify(alvaroSeed)), id: maxId+1, createdAt: new Date().toISOString()}];
    }
  }
  // Backfill Gonzalo Gobernanza: análogo a los anteriores.
  if(d.agents.length>0 && !d.agents.some(a=>a.name==="Gonzalo Gobernanza")){
    const gonzaloSeed = (INITIAL_DATA.agents||[]).find(a=>a.name==="Gonzalo Gobernanza");
    if(gonzaloSeed){
      const maxId = d.agents.reduce((m,a)=>typeof a.id==="number"&&a.id>m?a.id:m,0);
      d.agents = [...d.agents, {...JSON.parse(JSON.stringify(gonzaloSeed)), id: maxId+1, createdAt: new Date().toISOString()}];
    }
  }
  // Backfill Diego (Analista Financiero): añadido al seed después.
  if(d.agents.length>0 && !d.agents.some(a=>a.name==="Diego")){
    const diegoSeed = (INITIAL_DATA.agents||[]).find(a=>a.name==="Diego");
    if(diegoSeed){
      const maxId = d.agents.reduce((m,a)=>typeof a.id==="number"&&a.id>m?a.id:m,0);
      d.agents = [...d.agents, {...JSON.parse(JSON.stringify(diegoSeed)), id: maxId+1, createdAt: new Date().toISOString()}];
    }
  }
  // Patch Diego: añade la sección CONTABILIDAD si su promptBase no la
  // tiene todavía. Idempotente con marca "CONTABILIDAD:". El bloque entra
  // antes de FORMATO (mantiene el orden del seed actualizado).
  d.agents = d.agents.map(a=>{
    if(a.name!=="Diego" || !a.promptBase) return a;
    if(a.promptBase.includes("CONTABILIDAD:")) return a;
    const inserted = a.promptBase.replace(
      /\nFORMATO:/,
      "\nCONTABILIDAD:\n- Puedes crear asientos contables con add_accounting_entry. Cada asiento debe cuadrar (total debe = total haber). Usa cuentas del PGC pyme español. Para subcuentas usa el formato XXXNNNN (ej: 2130001 para primera cámara hiperbárica).\n\nFORMATO:"
    );
    return { ...a, promptBase: inserted };
  });
  // Patch Diego: añade la sección ANÁLISIS DE DOCUMENTOS para evitar que
  // alucine al recibir adjuntos PDF/imagen vía multimodal. Idempotente
  // con marca "ANÁLISIS DE DOCUMENTOS:". Va justo antes de FORMATO,
  // después de CONTABILIDAD.
  d.agents = d.agents.map(a=>{
    if(a.name!=="Diego" || !a.promptBase) return a;
    if(a.promptBase.includes("ANÁLISIS DE DOCUMENTOS:")) return a;
    const block = "\nANÁLISIS DE DOCUMENTOS:\nIMPORTANTE: Cuando analices un documento adjunto (PDF, imagen, factura), extrae los datos EXCLUSIVAMENTE del documento. NO uses datos de tu contexto financiero para rellenar campos que no aparecen en el documento. Si un dato no está visible en el documento, di \"no visible en el documento\". NUNCA inventes CIFs, números de serie, fechas ni importes. Si el documento es ilegible o ambiguo, dilo explícitamente y pide aclaración.\n\nFORMATO:";
    const inserted = a.promptBase.replace(/\nFORMATO:/, block);
    return { ...a, promptBase: inserted };
  });
  // Patch Héctor: si ya tenía INVOKE_ADDON pero no menciona "alvaro:", le
  // añadimos el patch que lo añade como tercer especialista invocable.
  d.agents = d.agents.map(a=>{
    if(a.name==="Héctor" && a.promptBase && a.promptBase.includes("[INVOCAR:") && !a.promptBase.includes("alvaro:")){
      return {...a, promptBase: a.promptBase + HECTOR_ALVARO_INVOKE_PATCH};
    }
    return a;
  });
  // Patch Héctor: añade Gonzalo si todavía no estaba mencionado.
  d.agents = d.agents.map(a=>{
    if(a.name==="Héctor" && a.promptBase && a.promptBase.includes("[INVOCAR:") && !a.promptBase.includes("gonzalo:")){
      return {...a, promptBase: a.promptBase + HECTOR_GONZALO_INVOKE_PATCH};
    }
    return a;
  });
  // Patch Héctor: añade Diego (analista financiero) si no estaba mencionado.
  d.agents = d.agents.map(a=>{
    if(a.name==="Héctor" && a.promptBase && a.promptBase.includes("[INVOCAR:") && !a.promptBase.includes("diego:")){
      return {...a, promptBase: a.promptBase + HECTOR_DIEGO_INVOKE_PATCH};
    }
    return a;
  });
  // Patch ejecutor: inyecta CAPACIDAD DE EJECUCIÓN en TODOS los agentes
  // que tengan promptBase. Idempotente con marca de versión "ACTIONS_v11".
  // v11 añade REGLA ANTI-FABRICACIÓN — NO INVENTES DATOS DE NEGOCIO,
  // que aplica a TODOS los agentes cuando una consulta requiere datos
  // ausentes del contexto. Sobre v10 (PROHIBICIÓN ABSOLUTA fake-success)
  // sobre v9 (wording PERFIL CEO) sobre v8 (PERFIL CEO) sobre v7
  // (identidad) sobre v6 (regla crítica + ambigüedad) sobre v5
  // (stakeholders). Cortamos por marker "PERFIL CEO:" o
  // "CAPACIDAD DE EJECUCIÓN" según versión previa.
  d.agents = d.agents.map(a=>{
    if(!a.promptBase) return a;
    if(a.promptBase.includes("ACTIONS_v11")) return a;            // ya v11
    let cut = a.promptBase;
    if (cut.includes("PERFIL CEO:")) {
      cut = cut.split(/\n+PERFIL CEO:/)[0];
    } else if (cut.includes("CAPACIDAD DE EJECUCIÓN")) {
      cut = cut.split(/\n+CAPACIDAD DE EJECUCIÓN/)[0];
    } else {
      // sin addon previo → añadir v11
      return {...a, promptBase: a.promptBase + AGENT_ACTIONS_ADDON};
    }
    return {...a, promptBase: cut + AGENT_ACTIONS_ADDON};
  });
  // Upgrade promptBase de Héctor: añade la sección COACHING EJECUTIVO si el
  // usuario ya tenía al Héctor anterior sin esa sección. Idempotente: al
  // segundo pase detecta la marca "COACHING EJECUTIVO" y no hace nada.
  d.agents = d.agents.map(a=>{
    if(a.name==="Héctor" && a.promptBase && !a.promptBase.includes("COACHING EJECUTIVO")){
      return {...a, promptBase: a.promptBase + HECTOR_COACHING_ADDON};
    }
    return a;
  });
  // Upgrade Héctor: instrucción de invocación explícita de especialistas
  // mediante etiqueta [INVOCAR:mario|jorge:tarea]. Reemplaza al detector
  // por palabras clave que generaba falsos positivos. Idempotente.
  d.agents = d.agents.map(a=>{
    if(a.name==="Héctor" && a.promptBase && !a.promptBase.includes("[INVOCAR:")){
      return {...a, promptBase: a.promptBase + HECTOR_INVOKE_ADDON};
    }
    return a;
  });
  // Upgrade Héctor: framework 9 (Sonrisa/Silencio/Indiferencia) +
  // advice.negotiationPressure. Idempotente.
  d.agents = d.agents.map(a=>{
    if(a.name!=="Héctor") return a;
    let next = a;
    // Framework 9 en promptBase si falta.
    if(next.promptBase && !next.promptBase.includes("Sonrisa/Silencio/Indiferencia")){
      next = {
        ...next,
        promptBase: next.promptBase.replace(
          "8. Sesgos (Kahneman) — Reviso anclaje, disponibilidad, confirmación y costes hundidos en cada decisión.",
          "8. Sesgos (Kahneman) — Reviso anclaje, disponibilidad, confirmación y costes hundidos en cada decisión.\n9. Sonrisa/Silencio/Indiferencia (Díaz) — Defiéndete con cordialidad, no con argumentos. Ataca con silencio estratégico: deja que la contraparte llene el vacío y revele sus cartas. Vence con indiferencia ante lo que no suma: muestra que tienes el control y perspectiva larga. Se aplica especialmente con inversores bajo presión, partners que negocian rápido y competidores que intentan desviarte."
        ),
      };
    }
    // advice.negotiationPressure si falta.
    if(next.advice && !next.advice.negotiationPressure){
      next = {
        ...next,
        advice: {
          ...next.advice,
          negotiationPressure: "Alguien te está presionando. Primero: sonríe — no reacciones, no te defiendas, mantén el control emocional visible. Segundo: silencio — deja que llenen el vacío, revelarán más de lo que pretenden. Tercero: indiferencia total ante lo que no alinea con tus intereses — no entres en el juego emocional. Acción ahora: formula una pregunta calibrada antes de responder nada. ¿Cómo se supone que haga eso? desarma más que cualquier argumento.",
        },
      };
    }
    return next;
  });
  // Upgrade Héctor: framework 10 (Aristóteles) + paso 7 en CUANDO ANALICES +
  // paso 7 en CUANDO ASESORES + specialty "Filosofía práctica". Idempotente:
  // si ya está "10. Aristóteles" no toca el promptBase, y si ya está la
  // specialty no la duplica.
  d.agents = d.agents.map(a=>{
    if(a.name!=="Héctor") return a;
    let next = a;
    if(next.promptBase && !next.promptBase.includes("10. Aristóteles")){
      next = {
        ...next,
        promptBase: next.promptBase
          .replace(
            "competidores que intentan desviarte.\n\nCUANDO ANALICES UNA NEGOCIACIÓN:",
            "competidores que intentan desviarte."+HECTOR_ARISTOTLE_BLOCK+"\n\nCUANDO ANALICES UNA NEGOCIACIÓN:"
          )
          .replace(
            "6. Sugiere preguntas calibradas específicas para la siguiente sesión\n\nCUANDO ASESORES UNA DECISIÓN:",
            "6. Sugiere preguntas calibradas específicas para la siguiente sesión\n7. Diagnóstico aristotélico: Ethos/Pathos/Logos, Telos real, Kairos, Mesotes, género retórico, Eudaimonia\n\nCUANDO ASESORES UNA DECISIÓN:"
          )
          .replace(
            "6. Da tu recomendación clara — nunca solo 'depende'\n\nCUANDO EVALÚES",
            "6. Da tu recomendación clara — nunca solo 'depende'\n7. ¿Esta decisión contribuye a la Eudaimonia del CEO y del proyecto? ¿Abre o cierra posibilidades de florecimiento?\n\nCUANDO EVALÚES"
          ),
      };
    }
    if(Array.isArray(next.specialtiesExtended) && !next.specialtiesExtended.some(s=>s && s.name==="Filosofía práctica")){
      next = {
        ...next,
        specialtiesExtended:[
          ...next.specialtiesExtended,
          {name:"Filosofía práctica",description:"Aristóteles: Phronesis, Ethos/Pathos/Logos, Telos, Eudaimonia, Mesotes, Kairos, géneros retóricos, política y bien común"},
        ],
      };
    }
    return next;
  });
  // Upgrade Héctor: framework 11 (Séneca) — segunda capa filosófica con
  // énfasis en brevedad, tiempo y ecuanimidad. Idempotente con marca
  // "11. Séneca". Se inserta justo después del bloque de Aristóteles
  // (busca "que abras la boca." que es el final del Aristotle block) y
  // antes de la sección "CUANDO ANALICES" si está, o al final si no.
  d.agents = d.agents.map(a=>{
    if(a.name!=="Héctor" || !a.promptBase) return a;
    if(a.promptBase.includes("11. Séneca")) return a;
    // Estrategia: insertamos antes del primer "CUANDO ANALICES UNA
    // NEGOCIACIÓN" para mantener la estructura (filosofías agrupadas
    // arriba, instrucciones operativas abajo). Si no encuentra el
    // marcador, append al final del promptBase como fallback seguro.
    const marker = "\n\nCUANDO ANALICES UNA NEGOCIACIÓN:";
    if (a.promptBase.includes(marker)) {
      return { ...a, promptBase: a.promptBase.replace(marker, HECTOR_SENECA_BLOCK + marker) };
    }
    return { ...a, promptBase: a.promptBase + HECTOR_SENECA_BLOCK };
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
  // Backfill estructura del proyecto: workspaceId, propiedad y visibilidad.
  // - workspaceId: null si no estaba.
  // - ownerId: primer miembro del proyecto o, si no hay, el admin global
  //   (id 6 = Antonio) — así los proyectos seed no quedan huérfanos.
  // - createdBy: si no había, asume mismo que ownerId.
  // - createdAt: ISO de ahora si no existía.
  // - visibility: "team" para datos antiguos (mantiene el comportamiento
  //   previo donde cualquier usuario con sidebar visible accedía). Los
  //   proyectos nuevos creados desde createProject empiezan en "private".
  d.projects = (d.projects||[]).map(p=>{
    const out = {...p, workspaceId: p.workspaceId ?? null};
    if (out.ownerId == null) {
      out.ownerId = (Array.isArray(out.members) && out.members.length > 0)
        ? out.members[0]
        : 6;
    }
    if (out.createdBy == null) out.createdBy = out.ownerId;
    if (!out.createdAt)        out.createdAt = new Date().toISOString();
    if (!out.visibility)       out.visibility = "team";
    return out;
  });
  // Auth: backfill email + accountRole + supabaseUid en members. Mapping
  // estricto por email para vincular con cuentas de Supabase Auth ya
  // creadas. Si en un estado persistido viejo Albert seguía con
  // "albert@empresa.com", se actualiza a su email real "albertquicknex".
  // Idempotente — al segundo pase los uids ya están y no se sobreescriben.
  const AUTH_BINDINGS = [
    { match: m=> m.id===6 || m.email==="qn.finanzas@gmail.com" || m.email==="antonio@empresa.com",
      email:"qn.finanzas@gmail.com", supabaseUid:"2d958a69-9484-4306-b015-6b0a6356fbd1", accountRole:"admin" },
    { match: m=> m.id===5 || m.email==="mdiaz.holding@gmail.com",
      email:"mdiaz.holding@gmail.com", supabaseUid:"089678db-5f31-4ef3-b185-cd8ad3afab78", accountRole:"member" },
    { match: m=> m.id===7 || m.email==="albertquicknex@gmail.com" || m.email==="albert@empresa.com",
      email:"albertquicknex@gmail.com", supabaseUid:"61cfb1d3-1751-4a76-a54a-e26e5ac77d57", accountRole:"member" },
  ];
  d.members = (d.members||[]).map(m=>{
    const binding = AUTH_BINDINGS.find(b => b.match(m));
    if(binding){
      return {
        ...m,
        email: binding.email,
        supabaseUid: m.supabaseUid || binding.supabaseUid,
        accountRole: m.accountRole || binding.accountRole,
      };
    }
    return { ...m, email: m.email || "", accountRole: m.accountRole || "member" };
  });
  d.boards = Object.fromEntries(Object.entries(d.boards||{}).map(([pid,cols])=>[pid,cols.map(col=>({...col,tasks:col.tasks.map(t=>{
    // Migración timeline: si existen comments antiguos y no hay timeline,
    // mapeamos cada comment a una entrada de tipo "human". Idempotente:
    // si ya hay timeline, se respeta y no se duplica desde comments.
    let timeline = Array.isArray(t.timeline) ? t.timeline : null;
    if(!timeline){
      const oldComments = Array.isArray(t.comments) ? t.comments : [];
      timeline = oldComments.map((c, idx)=>({
        id: `tlmig_${t.id}_${idx}_${Date.now().toString(36)}`,
        type: "human",
        author: null,
        authorId: c.author ?? null,
        authorAvatar: "👤",
        text: c.text || "",
        timestamp: c.timestamp || new Date().toISOString(),
        isMilestone: false,
        relatedRecommendationId: null,
        legacyTime: c.time || null,
      }));
    }
    return {...t, projectId: typeof t.projectId==="number" ? t.projectId : Number(pid), linkedProjects: Array.isArray(t.linkedProjects)?t.linkedProjects:[], links: t.links||[], agentIds: t.agentIds||[], refs: t.refs||[], documents: t.documents||[], dueTime: t.dueTime||"", archived: typeof t.archived === "boolean" ? t.archived : false, timeline, comments: t.comments||[]};
  })}))]));
  // Backfill project.code (3 letras MAYÚSCULAS) y task.ref (CODE-NNN). Para
  // proyectos antiguos sin código, autogeneramos a partir del nombre y
  // marcamos codeAuto:true (informativo, sin efecto funcional). Para tareas
  // sin ref, asignamos secuencial respetando los refs ya existentes del
  // proyecto. Idempotente: la segunda pasada no toca nada.
  {
    const existing = (d.projects||[]).map(p=>p.code).filter(isValidProjectCode);
    d.projects = (d.projects||[]).map(p=>{
      if(isValidProjectCode(p.code)) return p;
      const code = autoProjectCode(p.name, existing);
      existing.push(code);
      return {...p, code, codeAuto:true};
    });
  }
  d.boards = Object.fromEntries(Object.entries(d.boards||{}).map(([pid,cols])=>{
    const proj = (d.projects||[]).find(p=>p.id===Number(pid)) || (d.projects||[]).find(p=>String(p.id)===pid);
    if(!proj || !isValidProjectCode(proj.code)) return [pid, cols];
    const prefix = proj.code + "-";
    let maxN = 0;
    cols.forEach(col=>col.tasks.forEach(t=>{
      if(typeof t.ref==="string" && t.ref.startsWith(prefix)){
        const n = parseInt(t.ref.slice(prefix.length), 10);
        if(Number.isFinite(n) && n>maxN) maxN = n;
      }
    }));
    const newCols = cols.map(col=>({
      ...col,
      tasks: col.tasks.map(t=>{
        if(typeof t.ref==="string" && t.ref) return t;
        maxN += 1;
        return {...t, ref: prefix + String(maxN).padStart(3,"0")};
      }),
    }));
    return [pid, newCols];
  }));
  // Backfill negotiation.code (NEG-001, NEG-002…) y workspace.code
  // (WSP-001, WSP-002…). Numeración secuencial global por tipo. La asignación
  // continúa el contador a partir del mayor código existente — segura ante
  // sync entre clientes que ya hubieran sembrado códigos. Idempotente.
  {
    let i = 1;
    (d.negotiations||[]).forEach(n=>{
      if(typeof n.code==="string" && n.code.startsWith(NEG_CODE_PREFIX)){
        const m = parseInt(n.code.slice(NEG_CODE_PREFIX.length),10);
        if(Number.isFinite(m) && m>=i) i = m+1;
      }
    });
    d.negotiations = (d.negotiations||[]).map(n=>{
      if(n.code) return n;
      const code = NEG_CODE_PREFIX + String(i++).padStart(3,"0");
      return {...n, code};
    });
  }
  {
    let i = 1;
    (d.workspaces||[]).forEach(w=>{
      if(typeof w.code==="string" && w.code.startsWith(WS_CODE_PREFIX)){
        const m = parseInt(w.code.slice(WS_CODE_PREFIX.length),10);
        if(Number.isFinite(m) && m>=i) i = m+1;
      }
    });
    d.workspaces = (d.workspaces||[]).map(w=>{
      if(w.code) return w;
      const code = WS_CODE_PREFIX + String(i++).padStart(3,"0");
      return {...w, code};
    });
  }
  // Backfill documents[] en negociaciones (upload + informes de análisis).
  // Backfill propiedad/visibilidad/miembros: para datos antiguos el visibility
  // queda en "team" (mantener acceso actual del equipo), createdBy = ownerId
  // si no estaba, members = [] si nunca se asignó. Las negociaciones nuevas
  // creadas desde createNegotiation arrancan en "private" e incluyen al
  // creador en members[]. Idempotente.
  d.negotiations = d.negotiations.map(n=>({
    ...n,
    documents: n.documents||[],
    result: n.result || null,
    memory: n.memory ? {
      keyFacts:      Array.isArray(n.memory.keyFacts)      ? n.memory.keyFacts      : [],
      agreements:    Array.isArray(n.memory.agreements)    ? n.memory.agreements    : [],
      redFlags:      Array.isArray(n.memory.redFlags)      ? n.memory.redFlags      : [],
      chatSummaries: Array.isArray(n.memory.chatSummaries) ? n.memory.chatSummaries : [],
      updatedAt:     n.memory.updatedAt || null,
    } : {...emptyNegMemory(), chatSummaries:[]},
    ownerId:    n.ownerId != null ? n.ownerId : 6,
    createdBy:  n.createdBy != null ? n.createdBy : (n.ownerId != null ? n.ownerId : 6),
    createdAt:  n.createdAt || new Date().toISOString(),
    visibility: n.visibility || "team",
    members:    Array.isArray(n.members) ? n.members : [],
  }));
  // Memoria global del CEO (nivel app).
  d.ceoMemory = d.ceoMemory ? {
    preferences: Array.isArray(d.ceoMemory.preferences) ? d.ceoMemory.preferences : [],
    keyFacts:    Array.isArray(d.ceoMemory.keyFacts)    ? d.ceoMemory.keyFacts    : [],
    decisions:   Array.isArray(d.ceoMemory.decisions)   ? d.ceoMemory.decisions   : [],
    lessons:     Array.isArray(d.ceoMemory.lessons)     ? d.ceoMemory.lessons     : [],
    updatedAt:   d.ceoMemory.updatedAt || null,
  } : emptyCeoMemory();
  // Permisos granulares por feature: {[memberId]: {[feature]: {view, edit, admin}}}.
  // El admin global (accountRole==="admin") tiene acceso total automáticamente
  // y no necesita entradas aquí. Idempotente: si existe se respeta.
  if (!d.permissions || typeof d.permissions !== "object") d.permissions = {};
  // Permisos de agentes IA por miembro: data.permissions[memberId].agents =
  // {mario, jorge, alvaro, gonzalo}. Admin global pasa libre vía canUseAgent.
  // Para miembros no-admin sin entrada, fallamos cerrado (no acceso). Esta
  // migración SOLO crea la sub-clave .agents si falta — no asume defaults
  // optimistas para no liberar acceso por accidente.
  for (const m of (d.members||[])) {
    if (m.accountRole === "admin") continue;
    if (!d.permissions[m.id]) d.permissions[m.id] = {};
    if (!d.permissions[m.id].agents || typeof d.permissions[m.id].agents !== "object") {
      d.permissions[m.id].agents = { mario: false, jorge: false, alvaro: false, gonzalo: false };
    } else {
      // Idempotente: backfill solo de las claves que falten.
      const cur = d.permissions[m.id].agents;
      if (cur.mario   === undefined) cur.mario   = false;
      if (cur.jorge   === undefined) cur.jorge   = false;
      if (cur.alvaro  === undefined) cur.alvaro  = false;
      if (cur.gonzalo === undefined) cur.gonzalo = false;
    }
  }
  // Movimientos financieros (módulo Finanzas). Lista plana de movimientos.
  if (!Array.isArray(d.financeMovements)) d.financeMovements = [];
  // Multi-empresa (Fase 2): cuentas bancarias, movimientos bancarios
  // y catálogo de categorías PGC. Las empresas no se duplican aquí —
  // siguen viviendo en data.governance.companies y se referencian por id.
  if (!Array.isArray(d.bankAccounts))  d.bankAccounts  = [];
  if (!Array.isArray(d.bankMovements)) d.bankMovements = [];
  // Facturación (Commit 5): facturas emitidas y recibidas. Numeración
  // YYYY/NNN auto-correlativa por (companyId, type, year). Cada factura
  // referencia opcionalmente un bankMovement vía bankMovementId.
  if (!Array.isArray(d.invoices)) d.invoices = [];
  // Contabilidad (PGC pyme español). Asientos del libro diario y plan de
  // cuentas. El plan se siembra con ~30 cuentas canónicas; el CEO añade
  // subcuentas (formato XXXNNNN, ej 2130001) cuando las necesita.
  // Numeración correlativa por (companyId, year) la genera addAccountingEntry.
  if (!Array.isArray(d.accountingEntries)) d.accountingEntries = [];
  if (!Array.isArray(d.chartOfAccounts) || d.chartOfAccounts.length === 0) {
    d.chartOfAccounts = [
      // GRUPO 1 — Financiación básica
      { code: "100", name: "Capital social", group: 1 },
      { code: "170", name: "Deudas a largo plazo", group: 1 },
      // GRUPO 2 — Inmovilizado
      { code: "213", name: "Maquinaria", group: 2 },
      { code: "281", name: "Amortización acumulada inmovilizado material", group: 2 },
      // GRUPO 3 — Existencias
      { code: "300", name: "Mercaderías", group: 3 },
      // GRUPO 4 — Acreedores y deudores
      { code: "400", name: "Proveedores", group: 4 },
      { code: "410", name: "Acreedores prestación servicios", group: 4 },
      { code: "430", name: "Clientes", group: 4 },
      { code: "472", name: "HP IVA soportado", group: 4 },
      { code: "475", name: "HP acreedora por IVA", group: 4 },
      { code: "473", name: "HP retenciones y pagos a cuenta", group: 4 },
      { code: "476", name: "Organismos SS acreedores", group: 4 },
      // GRUPO 5 — Cuentas financieras
      { code: "523", name: "Proveedores inmovilizado c/p", group: 5 },
      { code: "570", name: "Caja", group: 5 },
      { code: "572", name: "Bancos", group: 5 },
      // GRUPO 6 — Compras y gastos
      { code: "600", name: "Compras mercaderías", group: 6 },
      { code: "621", name: "Arrendamientos", group: 6 },
      { code: "623", name: "Servicios profesionales", group: 6 },
      { code: "625", name: "Primas de seguros", group: 6 },
      { code: "626", name: "Servicios bancarios", group: 6 },
      { code: "627", name: "Publicidad y RRPP", group: 6 },
      { code: "628", name: "Suministros", group: 6 },
      { code: "629", name: "Otros servicios", group: 6 },
      { code: "631", name: "Otros tributos", group: 6 },
      { code: "640", name: "Sueldos y salarios", group: 6 },
      { code: "642", name: "Seguridad Social empresa", group: 6 },
      { code: "681", name: "Amortización inmovilizado material", group: 6 },
      // GRUPO 7 — Ventas e ingresos
      { code: "700", name: "Ventas mercaderías", group: 7 },
      { code: "705", name: "Prestación servicios", group: 7 },
      { code: "759", name: "Ingresos por servicios diversos", group: 7 },
      { code: "769", name: "Otros ingresos financieros", group: 7 },
    ];
  }
  if (!Array.isArray(d.movementCategories) || d.movementCategories.length === 0) {
    d.movementCategories = [
      // INGRESOS
      { id: "ventas",          name: "Ventas/Cobros clientes", type: "income",  pgc: "700" },
      { id: "subvenciones",    name: "Subvenciones",           type: "income",  pgc: "740" },
      { id: "intereses",       name: "Intereses bancarios",    type: "income",  pgc: "769" },
      { id: "otros_ingresos",  name: "Otros ingresos",         type: "income",  pgc: "759" },
      // GASTOS
      { id: "proveedores",     name: "Proveedores",            type: "expense", pgc: "600" },
      { id: "personal",        name: "Nóminas y SS",           type: "expense", pgc: "640" },
      { id: "alquiler",        name: "Alquiler local",         type: "expense", pgc: "621" },
      { id: "suministros",     name: "Suministros",            type: "expense", pgc: "628" },
      { id: "seguros",         name: "Seguros",                type: "expense", pgc: "625" },
      { id: "impuestos",       name: "Impuestos y tasas",      type: "expense", pgc: "631" },
      { id: "comisiones_banco",name: "Comisiones bancarias",   type: "expense", pgc: "626" },
      { id: "asesoria",        name: "Asesoría/Gestoría",      type: "expense", pgc: "623" },
      { id: "marketing",       name: "Marketing/Publicidad",   type: "expense", pgc: "627" },
      { id: "otros_gastos",    name: "Otros gastos",           type: "expense", pgc: "629" },
      // NEUTROS
      { id: "transferencia",   name: "Transferencia entre cuentas", type: "neutral" },
      { id: "prestamo",        name: "Préstamo",               type: "neutral" },
      { id: "iva_liquidacion", name: "Liquidación IVA",        type: "neutral" },
    ];
  }
  // Gobernanza empresarial: estructura societaria + obligaciones fiscales
  // + alertas. Inicialización idempotente. Las obligaciones por defecto
  // se generan vacías; el admin las puebla manualmente o usando la
  // plantilla estándar (modelo 200/202/303/111/347/390/720/115).
  if (!d.governance || typeof d.governance !== "object") {
    d.governance = { companies: [], obligations: [], alerts: [], documents: [] };
  } else {
    if (!Array.isArray(d.governance.companies))   d.governance.companies   = [];
    if (!Array.isArray(d.governance.obligations)) d.governance.obligations = [];
    if (!Array.isArray(d.governance.alerts))      d.governance.alerts      = [];
    if (!Array.isArray(d.governance.documents))   d.governance.documents   = [];
  }
  // Vault personal y familiar: cada `space` agrupa documentos privados
  // (DNI, IRPF, escrituras, seguros…) de una persona. El admin (CEO) crea
  // espacios para él y para familiares. Cada space tiene accessToken y
  // PIN para compartir acceso aislado por URL sin login SoulBaric.
  if (!d.vault || typeof d.vault !== "object") {
    d.vault = { spaces: [] };
  } else if (!Array.isArray(d.vault.spaces)) {
    d.vault.spaces = [];
  }
  // Auto-creación del space del CEO si no existe ninguno. Usamos el
  // primer admin global de members[] como titular. PIN inicial 0000 —
  // el CEO debe cambiarlo en Ajustes del espacio. La plantilla de docs
  // se siembra para que arranque con sus 35+ documentos pendientes.
  if (d.vault.spaces.length === 0) {
    const admin = (d.members || []).find(m => m.accountRole === "admin") || (d.members || [])[0];
    if (admin) {
      const genId = () => (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `vs_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      const genToken = () => (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, "") : `tk${Date.now()}${Math.random().toString(36).slice(2,12)}`;
      d.vault.spaces = [{
        id: genId(),
        name: admin.name,
        relationship: "CEO",
        email: admin.email || "",
        pin: "0000",
        accessToken: genToken(),
        createdBy: admin.id,
        createdAt: new Date().toISOString(),
        privacyLevel: "private",
        documents: generatePersonalDocuments(),
      }];
    }
  }
  // Backfill defensivo: si algún space pre-existente tiene documents=[]
  // (creado antes de la auto-siembra), sembramos su plantilla. Idempotente.
  d.vault.spaces = d.vault.spaces.map(sp => {
    if (Array.isArray(sp.documents) && sp.documents.length === 0) {
      return { ...sp, documents: generatePersonalDocuments() };
    }
    return sp;
  });
  // ── Seed: Proyecto "Registro y Protección SoulBaric" ──────────────────
  // Idempotente: solo siembra si NO existe proyecto con code="REG". Crea
  // proyecto + 11 tareas + negociación vinculada en Deal Room. Asignados:
  // Antonio (admin) y Marc Díaz como members en todo. Reaplicar al limpiar
  // el code "REG" del seed manualmente — la siguiente carga lo regenera.
  seedRegistroSoulBaric(d);
  // Seed cuenta Qonto de Alma Dimo. Idempotente: solo si NO existe ya
  // una cuenta con ese IBAN en data.bankAccounts.
  seedQontoAlmaDimo(d);
  return d;
}

// Seed de la cuenta bancaria operativa de Alma Dimo (Qonto). Empareja
// dinámicamente con governance.companies por CIF B19929256 o por nombre
// que contenga "ALMA DIMO" — si la empresa no está registrada, deja
// companyId:null para que el admin la asigne luego.
function seedQontoAlmaDimo(d){
  const TARGET_IBAN = "ES6368880001631828815452";
  if (!Array.isArray(d.bankAccounts)) d.bankAccounts = [];
  if (d.bankAccounts.some(a => (a.iban||"").replace(/\s+/g,"").toUpperCase() === TARGET_IBAN)) return;
  const companies = d.governance?.companies || [];
  const matchByCif  = companies.find(c => (c.cif||"").toUpperCase() === "B19929256");
  const matchByName = companies.find(c => /alma\s*dimo/i.test(c.name||""));
  const company = matchByCif || matchByName || null;
  const id = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `ba_qonto_${Date.now()}`;
  d.bankAccounts.push({
    id,
    companyId: company?.id || null,
    bankName: "Qonto",
    iban: TARGET_IBAN,
    bic: "QNTOESB2XXX",
    alias: "Cuenta operativa Qonto",
    currentBalance: 380.76,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

// Helper de seed para el proyecto de registro de marca y protección IP.
// Extraído del cuerpo de _migrate para que sea testable y legible. Toda
// la lógica es síncrona y no toca claves fuera de projects, boards,
// negotiations.
function seedRegistroSoulBaric(d){
  if ((d.projects || []).some(p => p.code === "REG")) return; // ya sembrado

  const admin = (d.members || []).find(m => m.accountRole === "admin")
              || (d.members || []).find(m => m.email === "qn.finanzas@gmail.com")
              || (d.members || []).find(m => m.id === 6);
  const marc  = (d.members || []).find(m => /^marc/i.test(m.name||"") || /(mdiaz|marc)/i.test(m.email||""))
              || (d.members || []).find(m => m.id === 5);
  if (!admin || !marc) return; // sin personas no sembramos
  const adminId = admin.id;
  const marcId  = marc.id;
  const workspaceId = (d.workspaces && d.workspaces[0]?.id) || null;

  const PROJ_ID = "proj_reg_soulbaric";
  const now = new Date();
  const nowIso = now.toISOString();
  const offset = (days) => {
    const d2 = new Date(now); d2.setDate(d2.getDate() + days);
    return d2.toISOString().slice(0, 10);
  };
  const today = now.toISOString().slice(0, 10);

  // Proyecto
  const newProject = {
    id: PROJ_ID,
    name: "Registro y Protección SoulBaric",
    desc: "Gestión completa del registro de marca, protección de propiedad intelectual, constitución societaria y protección de código fuente",
    color: "#8E44AD",
    emoji: "🛡️",
    code: "REG",
    members: [adminId, marcId],
    workspaceId,
    ownerId: adminId,
    createdBy: adminId,
    createdAt: nowIso,
    visibility: "private",
  };
  d.projects = [...(d.projects || []), newProject];

  // Columnas
  const colTodo = { id: `nc_reg_todo`,  name: "Por hacer",    tasks: [] };
  const colDoing = { id: `nc_reg_doing`, name: "En progreso", tasks: [] };
  const colDone = { id: `nc_reg_done`,  name: "Hecho",        tasks: [] };

  // Helper para construir una tarea con timeline opcional de Gonzalo.
  const mkTask = (n, title, due, priority, desc, tags, gonzaloNote) => {
    const ref = `REG-${String(n).padStart(3, "0")}`;
    const taskId = `t_reg_${n}_${Math.random().toString(36).slice(2, 6)}`;
    const timeline = [];
    if (gonzaloNote) {
      timeline.push({
        id: `tl_reg_${n}_g`,
        type: "ai",
        author: "Gonzalo Gobernanza",
        authorId: null,
        authorAvatar: "🏛️",
        text: gonzaloNote,
        timestamp: nowIso,
        isMilestone: false,
        relatedRecommendationId: null,
      });
    }
    return {
      id: taskId,
      ref,
      title,
      tags: (tags || []).map(l => ({ l, c: "purple" })),
      assignees: [adminId, marcId],
      priority,
      startDate: today,
      dueDate: due,
      dueTime: "",
      estimatedHours: 0,
      timeLogs: [],
      desc: desc || "",
      comments: [],
      timeline,
      projectId: PROJ_ID,
      linkedProjects: [],
      links: [],
      agentIds: [],
      refs: [],
      documents: [],
      archived: false,
    };
  };

  const tasks = [
    mkTask(1,
      "Buscar disponibilidad marca SoulBaric en EUIPO",
      offset(2), "alta",
      "Acceder a https://euipo.europa.eu/eSearch y buscar \"SoulBaric\" en clases 9, 35, 42. Verificar que no existe marca igual o similar. Documentar con captura.",
      ["urgente", "marca"],
      "ACCIÓN CRÍTICA: Si alguien registra SoulBaric antes, recuperarla costará 5.000-30.000€. Buscar HOY."),
    mkTask(2,
      "Registrar dominios soulbaric.com .es .io .app .eu",
      offset(2), "alta",
      "Registrar 5 dominios principales (Namecheap, GoDaddy, Arsys). Si alguno no está disponible, documentar quién lo tiene. Coste: 40-60€/año.",
      ["urgente", "dominios"],
      "Recuperar dominios cuesta 2.000-10.000€ vía UDRP. Registrar HOY."),
    mkTask(3,
      "Solicitar registro marca EUIPO — 3 clases (9, 35, 42)",
      offset(7), "alta",
      "Solicitar marca UE \"SoulBaric\".\nClase 9: Software, aplicaciones\nClase 35: Gestión negocios, asesoría\nClase 42: SaaS, desarrollo software\n\nCoste: 850€ (3 clases) + 300-500€ agente marcas\nDuración: 10 años renovables — 27 países UE\n\nOpciones:\nA) Online directo en euipo.europa.eu\nB) Agente de marcas (recomendado)",
      ["urgente", "marca", "euipo"]),
    mkTask(4,
      "Depósito notarial del código fuente y skills",
      offset(7), "alta",
      "Preparar USB con:\n- Código fuente (src/)\n- Skills (.claude/skills/)\n- Prompts de agentes\n- CLAUDE.md\n- Capturas de la app\n- README\n\nDepositar ante notario. Coste: 100-200€. Da FECHA CIERTA de autoría.",
      ["urgente", "ip", "notario"]),
    mkTask(5,
      "Constituir SoulBaric Technologies SL",
      offset(30), "alta",
      "Capital mínimo 1€ (Ley Crea y Crece).\nObjeto: \"Desarrollo, explotación y licencia de software, plataformas SaaS, servicios asesoría empresarial mediante IA\"\n\nPasos:\n1. Certificación negativa nombre (RM Central)\n2. Cuenta bancaria + depósito capital\n3. Escritura pública notario\n4. CIF provisional\n5. Inscripción RM\n6. Alta censal (036)\n7. Alta SS si empleados\n\nCoste: 300-600€",
      ["estructura", "sl"]),
    mkTask(6,
      "Asignar IP (marca + copyright) a la SL",
      offset(30), "alta",
      "Transferir toda la IP a la SL:\n1. Marca EUIPO: cesión titularidad (200-400€)\n2. Copyright código: acta aportación no dineraria\n3. Skills/prompts: activos intangibles sociedad\n4. Dominios: transferir titularidad\n\nLA IP DEBE ESTAR EN LA SL, NO A NOMBRE PERSONAL.",
      ["ip", "cesion"]),
    mkTask(7,
      "Redactar NDAs para colaboradores y equipo",
      offset(30), "alta",
      "NDA que incluya:\n- Definición info confidencial (código, skills, prompts, arquitectura, datos)\n- No divulgación\n- No competencia: 2 años post-salida\n- IP: todo lo creado pertenece a la SL\n- Penalización incumplimiento\n\nAplica a: empleados, freelancers, colaboradores, beta-testers.\nCoste: 300-500€",
      ["legal", "nda"]),
    mkTask(8,
      "Registro Propiedad Intelectual del software",
      offset(60), "media",
      "Registrar en Registro PI (Ministerio Cultura).\nhttps://culturaydeporte.gob.es/cultura/propiedadintelectual\nCoste: 13€\nDepositar: código + documentación + manual",
      ["ip", "registro"]),
    mkTask(9,
      "Crear Protocolo de Protección de Secretos Empresariales",
      offset(60), "media",
      "Documentar medidas protección trade secrets (Ley 1/2019).\n3 requisitos:\na) Skills/prompts son secretos (repo privado)\nb) Valor comercial por ser secretos\nc) Medidas razonables (NDAs, acceso restringido, encriptación)\n\nUn folio firmado por administrador. Coste: 0€",
      ["legal", "trade-secrets"]),
    mkTask(10,
      "Registrar skills y prompts en Safe Creative",
      offset(60), "media",
      "Registrar en safecreative.org:\n- 8 Skills (.md)\n- 5 Prompts de agentes\n\nDa timestamp blockchain. Gratuito o 40€/año.",
      ["ip", "safe-creative"]),
    mkTask(11,
      "Evaluar patentabilidad arquitectura multi-agente",
      offset(180), "baja",
      "Consultar abogado patentes.\nArgumentos:\n- Método técnico novedoso\n- No software puro, sistema con efecto técnico\n- Sin prior art conocido\n\nCoste consulta: 500-1.000€\nCoste patente (si procede): 2.000-4.000€",
      ["patente", "ip"]),
  ];
  colTodo.tasks = tasks;
  d.boards = { ...(d.boards || {}), [PROJ_ID]: [colTodo, colDoing, colDone] };

  // Negociación en Deal Room
  const NEG_ID = "neg-registro-soulbaric";
  if (!(d.negotiations || []).some(n => n.id === NEG_ID)) {
    const negCode = (() => {
      let i = 1;
      for (const n of (d.negotiations || [])) {
        if (typeof n.code === "string" && n.code.startsWith("NEG-")) {
          const num = parseInt(n.code.slice(4), 10);
          if (Number.isFinite(num) && num >= i) i = num + 1;
        }
      }
      return "NEG-" + String(i).padStart(3, "0");
    })();
    const factsList = [
      "Marca SoulBaric no registrada — riesgo de registro por tercero",
      "Código fuente y 9 skills sin protección formal",
      "Presupuesto total: 1.963-3.590€",
      "Valoración activo a proteger: 300.000-1.500.000€",
    ];
    const redFlagsList = [
      "Marca sin registrar — cualquier tercero puede registrarla",
      "Skills y prompts accesibles sin NDA firmado",
    ];
    const factToItem = (text, idx, source = "manual") => ({
      id: `kf_reg_${idx}_${Math.random().toString(36).slice(2, 6)}`,
      text,
      source,
      addedAt: nowIso,
    });
    const newNeg = {
      id: NEG_ID,
      code: negCode,
      title: "Registro y Protección IP — SoulBaric",
      counterparty: "Equipo interno SoulBaric",
      status: "en_curso",
      value: null,
      currency: "EUR",
      description: "Gestión completa protección IP: marca EUIPO, copyright, trade secrets, SL, NDAs, patente.\nPresupuesto: 1.963-3.590€\nPlazo: 3 meses\nResponsables: Antonio Díaz + Marc Díaz",
      ownerId: adminId,
      createdBy: adminId,
      createdAt: nowIso,
      updatedAt: nowIso,
      visibility: "team",
      members: [adminId, marcId],
      projectId: PROJ_ID,
      agentId: null,
      relatedProjects: [{ projectId: PROJ_ID, role: "principal", priority: "high" }],
      relationships: [],
      stakeholders: [
        { id: `stk_reg_1_${Math.random().toString(36).slice(2,6)}`, name: "Agente de marcas EUIPO", company: "Por definir", email: "", phone: "", role: "other", influence: "influencer", notes: "Proveedor del registro de marca en EUIPO" },
        { id: `stk_reg_2_${Math.random().toString(36).slice(2,6)}`, name: "Notario", company: "Por definir", email: "", phone: "", role: "other", influence: "influencer", notes: "Fedatario del depósito notarial del código y constitución de la SL" },
        { id: `stk_reg_3_${Math.random().toString(36).slice(2,6)}`, name: "Abogado IP", company: "Por definir", email: "", phone: "", role: "other", influence: "decision_maker", notes: "Asesor legal en protección IP, NDAs y evaluación de patente" },
      ],
      sessions: [],
      hectorChat: [],
      hectorAnalysis: null,
      briefing: null,
      relatedTaskIds: tasks.map(t => t.id),
      documents: [],
      result: null,
      memory: {
        keyFacts:      factsList.map((t, i) => factToItem(t, i, "manual")),
        agreements:    [],
        redFlags:      redFlagsList.map((t, i) => factToItem(t, i, "manual")),
        chatSummaries: [],
        updatedAt:     nowIso,
      },
    };
    d.negotiations = [...(d.negotiations || []), newNeg];
  }
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

// Pantalla de login (Supabase Auth). SIN registro público — las cuentas
// se crean manualmente en Supabase Dashboard y se vinculan por
// supabaseUid en data.members. Esto evita que cualquier desconocido
// pueda darse de alta.
function LoginScreen({onAuthed, onLegacySkip, forceRecovery=false, onRecoveryDone}){
  const [email,setEmail] = useState("");
  const [pwd,setPwd]     = useState("");
  const [busy,setBusy]   = useState(false);
  const [err,setErr]     = useState(null);

  // Detección del flujo de recovery. forceRecovery viene del padre (que
  // detectó el hash o el evento PASSWORD_RECOVERY de Supabase). Como
  // fallback local, también miramos el hash en montaje.
  const [recoveryMode,setRecoveryMode] = useState(()=>{
    if(forceRecovery) return true;
    if(typeof window === "undefined") return false;
    const hash = window.location.hash || "";
    if(!hash) return false;
    const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    return params.get("type") === "recovery";
  });
  const [newPwd,setNewPwd]   = useState("");
  const [newPwd2,setNewPwd2] = useState("");
  const [resetOk,setResetOk] = useState(false);

  const submit = async (e)=>{
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const session = await signIn(email.trim(), pwd);
      onAuthed(session);
    } catch(e2){
      setErr(e2.message || "Error de autenticación");
    } finally { setBusy(false); }
  };

  const submitNewPassword = async (e)=>{
    e.preventDefault();
    setErr(null);
    if(newPwd.length < 8){ setErr("La contraseña debe tener al menos 8 caracteres."); return; }
    if(newPwd !== newPwd2){ setErr("Las contraseñas no coinciden."); return; }
    setBusy(true);
    try {
      const session = await updateUserPassword(newPwd);
      setResetOk(true);
      // Limpiamos el hash para que un refresh no reactive el modo recovery.
      try { window.history.replaceState(null, "", window.location.pathname + window.location.search); } catch {}
      setTimeout(()=>{
        if(session){ onAuthed(session); }
        else { setRecoveryMode(false); onRecoveryDone?.(); }
      }, 1800);
    } catch(e2){
      setErr(e2.message || "Error al actualizar la contraseña.");
    } finally { setBusy(false); }
  };

  return(
    <div style={{position:"fixed",inset:0,background:"linear-gradient(135deg,#7F77DD22,#E76AA122)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,zIndex:5000}}>
      <div style={{background:"#fff",borderRadius:16,padding:"28px 28px 22px",width:380,maxWidth:"100%",boxShadow:"0 20px 60px rgba(0,0,0,0.18)",border:"0.5px solid #E5E7EB"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
          <div style={{width:38,height:38,background:"#7F77DD",borderRadius:10,color:"#fff",fontWeight:700,fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>SB</div>
          <div>
            <div style={{fontWeight:700,fontSize:16,color:"#111827"}}>SoulBaric</div>
            <div style={{fontSize:11,color:"#6B7280"}}>{recoveryMode ? "Crear nueva contraseña" : "Iniciar sesión"}</div>
          </div>
        </div>
        {recoveryMode ? (
          resetOk ? (
            <div style={{padding:"16px 14px",background:"#ECFDF5",border:"1px solid #6EE7B7",borderRadius:8,fontSize:13,color:"#065F46",textAlign:"center"}}>
              ✓ Contraseña actualizada. Entrando…
            </div>
          ) : (
            <form onSubmit={submitNewPassword}>
              <label style={{display:"block",fontSize:12,fontWeight:600,color:"#374151",marginBottom:4}}>Nueva contraseña</label>
              <input type="password" autoFocus required value={newPwd} onChange={e=>setNewPwd(e.target.value)} placeholder="Mínimo 8 caracteres" disabled={busy} style={{width:"100%",padding:"9px 12px",borderRadius:8,border:"1px solid #D1D5DB",fontSize:14,fontFamily:"inherit",outline:"none",marginBottom:12}}/>
              <label style={{display:"block",fontSize:12,fontWeight:600,color:"#374151",marginBottom:4}}>Repite la contraseña</label>
              <input type="password" required value={newPwd2} onChange={e=>setNewPwd2(e.target.value)} placeholder="••••••••" disabled={busy} style={{width:"100%",padding:"9px 12px",borderRadius:8,border:"1px solid #D1D5DB",fontSize:14,fontFamily:"inherit",outline:"none",marginBottom:14}}/>
              {err && <div style={{fontSize:11.5,color:"#B91C1C",background:"#FEF2F2",border:"1px solid #FCA5A5",borderRadius:6,padding:"7px 10px",marginBottom:12}}>{err}</div>}
              <button type="submit" disabled={busy||!newPwd||!newPwd2} style={{width:"100%",padding:"10px 14px",borderRadius:8,background:busy?"#A7B0F5":"#7F77DD",color:"#fff",border:"none",fontSize:14,fontWeight:600,cursor:busy?"wait":"pointer",fontFamily:"inherit"}}>
                {busy?"Guardando…":"Actualizar contraseña"}
              </button>
              <div style={{marginTop:12,fontSize:11,color:"#9CA3AF",textAlign:"center"}}>
                <button type="button" onClick={()=>{ setRecoveryMode(false); setErr(null); try { window.history.replaceState(null, "", window.location.pathname + window.location.search); } catch {} onRecoveryDone?.(); }} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontFamily:"inherit",padding:0,fontSize:11,textDecoration:"underline"}}>Volver al inicio de sesión</button>
              </div>
            </form>
          )
        ) : (
          <>
            <form onSubmit={submit}>
              <label style={{display:"block",fontSize:12,fontWeight:600,color:"#374151",marginBottom:4}}>Email</label>
              <input type="email" autoFocus required value={email} onChange={e=>setEmail(e.target.value)} placeholder="tu@email.com" disabled={busy} style={{width:"100%",padding:"9px 12px",borderRadius:8,border:"1px solid #D1D5DB",fontSize:14,fontFamily:"inherit",outline:"none",marginBottom:12}}/>
              <label style={{display:"block",fontSize:12,fontWeight:600,color:"#374151",marginBottom:4}}>Contraseña</label>
              <input type="password" required value={pwd} onChange={e=>setPwd(e.target.value)} placeholder="••••••••" disabled={busy} style={{width:"100%",padding:"9px 12px",borderRadius:8,border:"1px solid #D1D5DB",fontSize:14,fontFamily:"inherit",outline:"none",marginBottom:14}}/>
              {err && <div style={{fontSize:11.5,color:"#B91C1C",background:"#FEF2F2",border:"1px solid #FCA5A5",borderRadius:6,padding:"7px 10px",marginBottom:12}}>{err}</div>}
              <button type="submit" disabled={busy||!email.trim()||!pwd} style={{width:"100%",padding:"10px 14px",borderRadius:8,background:busy?"#A7B0F5":"#7F77DD",color:"#fff",border:"none",fontSize:14,fontWeight:600,cursor:busy?"wait":"pointer",fontFamily:"inherit"}}>
                {busy?"Entrando…":"Entrar"}
              </button>
            </form>
            <div style={{marginTop:12,fontSize:11,color:"#9CA3AF",textAlign:"center"}}>
              Acceso restringido al equipo. Si no tienes cuenta, contacta con el administrador.
              {onLegacySkip && <> · <button onClick={onLegacySkip} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontFamily:"inherit",padding:0,fontSize:11,textDecoration:"underline"}}>Modo demo</button></>}
            </div>
          </>
        )}
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

// Convierte palabras de números (es) a dígitos. Soporta compuestos
// "cuarenta y cinco" → "45". Cubre 0–100 — suficiente para refs tipo
// T-40 / INV-002. Lo usamos en el Command Palette para que "cuarenta"
// matchee con "T40" y "t cuarenta" con "T-40".
function numbersWordsToDigits(text){
  const map = {
    "cero":"0","uno":"1","dos":"2","tres":"3","cuatro":"4","cinco":"5","seis":"6","siete":"7","ocho":"8","nueve":"9","diez":"10","once":"11","doce":"12","trece":"13","catorce":"14","quince":"15","dieciseis":"16","diecisiete":"17","dieciocho":"18","diecinueve":"19","veinte":"20","veintiuno":"21","veintidos":"22","veintitres":"23","veinticuatro":"24","veinticinco":"25","veintiseis":"26","veintisiete":"27","veintiocho":"28","veintinueve":"29","treinta":"30","cuarenta":"40","cincuenta":"50","sesenta":"60","setenta":"70","ochenta":"80","noventa":"90","cien":"100","ciento":"100",
  };
  let result = String(text||"").toLowerCase();
  // Compuestos: "cuarenta y cinco" → "45"
  result = result.replace(/(treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)\s+y\s+(uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)/g, (m,decena,unidad)=>{
    return String(parseInt(map[decena],10)+parseInt(map[unidad],10));
  });
  // Simples (con \b — solo palabras completas)
  Object.keys(map).forEach(word=>{
    result = result.replace(new RegExp("\\b"+word+"\\b","g"), map[word]);
  });
  return result;
}

// Normaliza para comparación tolerante: minúsculas + sin acentos +
// sin espacios/guiones/underscores + números en palabras → dígitos.
// Resultado: "T-40", "t 40", "T40", "cuarenta" → todos a "40" (o "t40").
function normalizeQuery(text){
  return numbersWordsToDigits(String(text||""))
    .toLowerCase()
    .replace(/[\s\-_]/g, "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Match flexible para tareas en el Command Palette. Acierta si el query
// (normalizado) aparece como substring en ref/title/projName/desc, o si
// el query es solo un número y coincide con el número del ref de la
// tarea (e.g. "40" matchea "T40", "T-040", "INV040" — leading zeros
// ignorados al comparar como Number).
function matchTask(task, queryRaw){
  const q = normalizeQuery(queryRaw);
  if(!q) return true;
  const ref = normalizeQuery(task.ref || task.code || "");
  const title = normalizeQuery(task.title || "");
  const project = normalizeQuery(task.projName || (task.project && (task.project.name || task.project)) || "");
  const description = normalizeQuery(task.desc || task.description || "");
  if (ref.includes(q) || title.includes(q) || project.includes(q) || description.includes(q)) return true;
  const queryNum = q.match(/\d+/)?.[0];
  const refNum = ref.match(/\d+/)?.[0];
  if (queryNum && refNum && Number(refNum) === Number(queryNum)) return true;
  return false;
}

// Match para entidades con código corto (proyectos, workspaces): code,
// name y desc, todos normalizados.
function matchItemByCode(item, queryRaw){
  const q = normalizeQuery(queryRaw);
  if(!q) return true;
  const code = normalizeQuery(item.code || "");
  const name = normalizeQuery(item.name || "");
  const desc = normalizeQuery(item.desc || item.description || "");
  return code.includes(q) || name.includes(q) || desc.includes(q);
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
  const all=Object.values(boards).flatMap(cols=>cols.flatMap(col=>col.tasks.filter(t=>!t.archived).map(t=>({...t,colName:col.name}))));
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
      {editingTask&&<TaskModal task={editingTask.task} colId={editingTask.colId} cols={editingTask.cols} members={data.members} activeMemberId={0} workspaceLinks={[]} agents={data.agents||[]} ceoMemory={data.ceoMemory} projects={data.projects} onNavigateProject={onNavigateProject} onClose={()=>setEditingTask(null)} onUpdate={(id,cid,upd)=>{onUpdateTask?.(id,upd);setEditingTask(prev=>prev?{...prev,task:upd}:null);}} onMove={()=>setEditingTask(null)}/>}
    </div>
  );
}

// ── Task Modal ────────────────────────────────────────────────────────────────
function TaskModal({task,colId,cols,members,activeMemberId,workspaceLinks,agents,ceoMemory,canDelete,projects,onNavigateProject,onTransferProject,onAddTimelineEntry,onToggleMilestone,onClose,onUpdate,onMove,onDelete}){
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
  // Transferencia de proyecto principal: panel inline de confirmación.
  // Al confirmar se llama onTransferProject(newProjectId) y el caller
  // mueve la tarea entre boards y recalcula task.ref.
  const [transferOpen,setTransferOpen]=useState(false);
  const [transferTarget,setTransferTarget]=useState("");
  // Presencia en tiempo real: publicamos qué tarea tenemos abierta y si la
  // estamos editando. Otros usuarios verán el banner. Al desmontar el modal
  // limpiamos (openTaskId=null) para no aparecer "viendo" tareas que cerramos.
  const presence = usePresence();
  useEffect(()=>{
    if(!task?.id) return;
    presence.setOpenTask(task.id, false);
    return ()=>presence.setOpenTask(null, false);
  },[task?.id]);
  useEffect(()=>{
    if(!task?.id) return;
    presence.setOpenTask(task.id, !!editing);
  },[editing, task?.id]);
  const presentOthers = (presence.presenceByTask?.[task?.id]||[])
    .filter(u=>String(u.userId)!==String(presence.currentUserId));
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
        {(()=>{
          // Proyecto principal + vinculados (si existen). Permiten contexto
          // visual del proyecto al que pertenece la tarea y de los proyectos
          // adicionales a los que está vinculada.
          const primary = (projects||[]).find(p=>p.id===task.projectId);
          const linked = ((task.linkedProjects||[]))
            .map(pid=>(projects||[]).find(p=>p.id===pid))
            .filter(Boolean);
          if(!primary && linked.length===0) return null;
          return(
            <div style={{padding:"8px 20px",borderBottom:"0.5px solid #f3f4f6",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",fontSize:11.5,color:"#6B7280",background:"#FCFCFD"}}>
              {primary&&(
                <button
                  onClick={()=>{ if(onNavigateProject){ onNavigateProject(primary.id); onClose?.(); } }}
                  disabled={!onNavigateProject}
                  title={onNavigateProject?`Ir al tablero de ${primary.name}`:primary.name}
                  style={{display:"inline-flex",alignItems:"center",gap:5,padding:"2px 8px",borderRadius:6,background:`${primary.color}14`,border:`1px solid ${primary.color}55`,color:primary.color,fontSize:11.5,fontWeight:600,cursor:onNavigateProject?"pointer":"default",fontFamily:"inherit"}}
                >📁 {primary.emoji||""} {primary.name}<RefBadge code={primary.code}/></button>
              )}
              {linked.map(p=>(
                <button
                  key={p.id}
                  onClick={()=>{ if(onNavigateProject){ onNavigateProject(p.id); onClose?.(); } }}
                  disabled={!onNavigateProject}
                  title={onNavigateProject?`Ir al tablero de ${p.name}`:p.name}
                  style={{display:"inline-flex",alignItems:"center",gap:5,padding:"2px 8px",borderRadius:6,background:"#F3F4F6",border:"1px solid #E5E7EB",color:"#6B7280",fontSize:11,fontWeight:500,cursor:onNavigateProject?"pointer":"default",fontFamily:"inherit"}}
                >🔗 {p.name}<RefBadge code={p.code}/></button>
              ))}
            </div>
          );
        })()}
        <div style={{padding:"14px 20px",borderBottom:"0.5px solid #e5e7eb",display:"flex",alignItems:"center",gap:10}}>
          {!editing&&<RefBadge code={task.ref}/>}
          {editing
            ?<input value={draft.title} onChange={e=>set("title",e.target.value)} style={{flex:1,fontSize:15,fontWeight:600,border:"none",outline:"2px solid #7F77DD",borderRadius:6,padding:"4px 8px",fontFamily:"inherit"}}/>
            :(()=>{
                // Última actualización: el timestamp más reciente del timeline.
                const tl = task.timeline || [];
                const latest = tl.reduce((a,e)=> (a===null || new Date(e.timestamp)>new Date(a.timestamp)) ? e : a, null);
                let label = "";
                if (latest) {
                  const ms = Date.now() - new Date(latest.timestamp).getTime();
                  const h = Math.floor(ms/3600000), d = Math.floor(ms/86400000), m = Math.floor(ms/60000);
                  label = ms < 60000 ? "ahora" : m < 60 ? `hace ${m} min` : h < 24 ? `hace ${h}h` : `hace ${d}d`;
                }
                return (
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:600,fontSize:15,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{task.title}</div>
                    {latest && <div style={{fontSize:10.5,color:"#6B7280",marginTop:2}}>Última actualización: {label}</div>}
                  </div>
                );
              })()
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
        {presentOthers.length>0 && (()=>{
          const editors = presentOthers.filter(u=>u.isEditing);
          const viewers = presentOthers.filter(u=>!u.isEditing);
          const isEditingMode = editors.length>0;
          const bg = isEditingMode ? "#FEF3C7" : "#EFF6FF";
          const border = isEditingMode ? "#FCD34D" : "#BFDBFE";
          const accent = isEditingMode ? "#92400E" : "#1E40AF";
          const main = editors[0] || viewers[0];
          const others = (isEditingMode ? editors : viewers).slice(1);
          const extraTxt = others.length>0 ? ` y ${others.length} más` : "";
          return(
            <div style={{padding:"6px 14px",background:bg,border:`1px solid ${border}`,borderTop:0,borderLeft:0,borderRight:0,fontSize:11.5,color:accent,display:"flex",alignItems:"center",gap:8}}>
              <span>{isEditingMode?"✏️":"👁️"}</span>
              <span style={{flex:1}}>
                <b>{main.userName||"Otro usuario"}</b>{extraTxt} {isEditingMode?"está editando esta tarea — los cambios se sincronizarán":"está viendo esta tarea ahora"}
              </span>
              <div style={{display:"flex"}}>
                {presentOthers.slice(0,4).map((u,i)=>{
                  const mp2 = MP[u.userId]||MP[0];
                  return(
                    <div key={u.userId} title={`${u.userName}${u.isEditing?" (editando)":""}`} style={{marginLeft:i>0?-6:0,zIndex:10-i,width:22,height:22,borderRadius:"50%",background:mp2.solid,color:"#fff",border:"2px solid #fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700}}>{u.userInitials||"?"}</div>
                  );
                })}
              </div>
            </div>
          );
        })()}
        {avatarOpen&&<AvatarModal task={task} members={members} connectedAgents={(agents||[]).filter(a=>(task.agentIds||[]).includes(a.id))} ceoMemory={ceoMemory} onClose={()=>setAvatarOpen(false)} onSetCategory={cat=>onUpdate(task.id,colId,{...task,category:cat})} onMutateTask={newTask=>onUpdate(task.id,colId,newTask)}/>}
        {/* Tabs */}
        <div style={{display:"flex",borderBottom:"0.5px solid #e5e7eb",padding:"0 20px"}}>
          {[["detail","Detalle"],["subtasks","Subtareas"],["links","Enlaces"],["time","Tiempo"],["timeline","Avance"],["documents","Documentos"]].map(([k,l])=>(
            <div key={k} onClick={()=>setTab(k)} style={{padding:"9px 14px",fontSize:12,cursor:"pointer",borderBottom:tab===k?"2px solid #7F77DD":"2px solid transparent",color:tab===k?"#7F77DD":"#6b7280",fontWeight:tab===k?600:400,marginBottom:-0.5}}>{l}{k==="subtasks"&&subs.length>0?` ${subsDone}/${subs.length}`:""}{k==="links"&&links.length>0?` (${links.length})`:""}{k==="time"&&totalLogged>0?` · ${fmtH(totalLogged)}`:""}{k==="timeline"&&(task.timeline||[]).length>0?` (${task.timeline.length})`:""}{k==="documents"&&(task.documents||[]).length>0?` (${(task.documents||[]).length})`:""}</div>
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
                  {/* Proyectos vinculados: la tarea aparece también en el
                      tablero de los proyectos secundarios. El proyecto
                      principal (task.projectId) no se puede desvincular
                      desde aquí — para cambiarlo, usa "Cambiar proyecto
                      principal". El código (ref) sigue al proyecto principal. */}
                  <div style={{marginTop:14}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <FL c="Proyectos vinculados"/>
                      {onTransferProject && (projects||[]).length>1 && !transferOpen && (
                        <button onClick={()=>{setTransferOpen(true); setTransferTarget("");}} title="Mover el proyecto principal a otro" style={{padding:"3px 10px",borderRadius:6,background:"#fff",color:"#7F77DD",border:"1px solid #CFC9F3",fontSize:11,cursor:"pointer",fontWeight:600,fontFamily:"inherit"}}>↪ Cambiar principal</button>
                      )}
                    </div>
                    {transferOpen && (()=>{
                      const currentPid = draft.projectId??task.projectId;
                      const candidates = (projects||[]).filter(p=>p.id!==currentPid);
                      const target = (projects||[]).find(p=>p.id===Number(transferTarget));
                      const currentProj = (projects||[]).find(p=>p.id===currentPid);
                      return(
                        <div style={{padding:"10px 12px",background:"#FFF8E1",border:"1px solid #FCD34D",borderRadius:8,marginBottom:10}}>
                          <div style={{fontSize:11.5,color:"#92400E",marginBottom:8}}>Selecciona el nuevo proyecto principal. {currentProj?currentProj.name:""} pasará a vinculado y el código se recalculará al prefijo del nuevo proyecto.</div>
                          <select value={transferTarget} onChange={e=>setTransferTarget(e.target.value)} style={{width:"100%",padding:"6px 10px",borderRadius:6,border:"1px solid #d1d5db",fontSize:12,marginBottom:8,fontFamily:"inherit"}}>
                            <option value="">— Selecciona proyecto destino —</option>
                            {candidates.map(p=><option key={p.id} value={p.id}>{p.emoji||"📋"} {p.name}{p.code?` [${p.code}]`:""}</option>)}
                          </select>
                          {target && (
                            <div style={{fontSize:11,color:"#374151",marginBottom:8,fontStyle:"italic"}}>
                              ¿Mover <b>{task.ref||""}</b> a <b>{target.name}</b>? El código pasará a <b>{target.code||"?"}-NNN</b>. {currentProj?currentProj.code:"el actual"} seguirá vinculado.
                            </div>
                          )}
                          <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
                            <button onClick={()=>{setTransferOpen(false); setTransferTarget("");}} style={{padding:"5px 10px",borderRadius:6,background:"transparent",color:"#6B7280",border:"1px solid #D1D5DB",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>Cancelar</button>
                            <button onClick={()=>{ if(target){ onTransferProject(target.id); setTransferOpen(false); setTransferTarget(""); } }} disabled={!target} style={{padding:"5px 12px",borderRadius:6,background:target?"#7F77DD":"#E5E7EB",color:target?"#fff":"#9CA3AF",border:"none",fontSize:11,cursor:target?"pointer":"not-allowed",fontWeight:600,fontFamily:"inherit"}}>Confirmar traspaso</button>
                          </div>
                        </div>
                      );
                    })()}
                    <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                      {(()=>{
                        const primary = (projects||[]).find(p=>p.id===(draft.projectId??task.projectId));
                        if(primary){
                          return(
                            <span title="Proyecto principal — no se puede desvincular" style={{display:"inline-flex",alignItems:"center",gap:5,padding:"3px 8px 3px 8px",borderRadius:14,background:`${primary.color}14`,border:`1px solid ${primary.color}55`,color:primary.color,fontSize:11.5,fontWeight:600}}>
                              <span style={{fontSize:9,padding:"1px 5px",borderRadius:4,background:primary.color,color:"#fff",fontWeight:700,letterSpacing:"0.04em"}}>PRINCIPAL</span>
                              {primary.emoji||"📋"} {primary.name}
                            </span>
                          );
                        }
                        return null;
                      })()}
                      {(draft.linkedProjects||[]).map(pid=>{
                        const p=(projects||[]).find(x=>x.id===pid); if(!p) return null;
                        return(
                          <span key={pid} style={{display:"inline-flex",alignItems:"center",gap:5,padding:"3px 5px 3px 8px",borderRadius:14,background:"#F3F4F6",border:"1px solid #E5E7EB",color:"#374151",fontSize:11.5,fontWeight:500}}>
                            🔗 {p.emoji||""} {p.name}
                            <button onClick={()=>set("linkedProjects",(draft.linkedProjects||[]).filter(x=>x!==pid))} title="Desvincular" style={{width:16,height:16,borderRadius:"50%",background:"#E24B4A",color:"#fff",border:"none",fontSize:10,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>×</button>
                          </span>
                        );
                      })}
                      {(()=>{
                        const usedIds = new Set([(draft.projectId??task.projectId), ...(draft.linkedProjects||[])]);
                        const candidates = (projects||[]).filter(p=>!usedIds.has(p.id));
                        if(candidates.length===0) return null;
                        return(
                          <select value="" onChange={e=>{
                            const v=Number(e.target.value);
                            if(!Number.isFinite(v)) return;
                            set("linkedProjects",[...(draft.linkedProjects||[]), v]);
                          }} style={{padding:"4px 8px",borderRadius:14,border:"1px dashed #9CA3AF",background:"#fff",fontSize:11.5,color:"#4B5563",cursor:"pointer",fontFamily:"inherit"}}>
                            <option value="">+ Vincular a proyecto…</option>
                            {candidates.map(p=>(
                              <option key={p.id} value={p.id}>{p.emoji||"📋"} {p.name}{p.code?` [${p.code}]`:""}</option>
                            ))}
                          </select>
                        );
                      })()}
                    </div>
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
          {tab==="timeline"&&(
            <TaskTimeline
              task={task}
              members={members}
              currentMember={members.find(x=>x.id===activeMemberId)}
              onAddEntry={onAddTimelineEntry}
              onToggleMilestone={onToggleMilestone}
            />
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
            window.confirm() nativo para evitar borrados por error. */}
        {onDelete && canDelete && (
          <div style={{padding:"10px 20px",borderTop:"0.5px solid #e5e7eb",display:"flex",justifyContent:"space-between",alignItems:"center",background:"#fafafa",borderBottomLeftRadius:16,borderBottomRightRadius:16}}>
            <button
              onClick={()=>{
                if(window.confirm("¿Eliminar esta tarea? Esta acción no se puede deshacer.")){
                  onDelete(task.id, colId);
                  onClose();
                }
              }}
              title="Eliminar tarea"
              style={{padding:"6px 12px",borderRadius:6,background:"transparent",color:"#B91C1C",border:"0.5px solid #FCA5A5",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:5}}
            >🗑️ Eliminar tarea</button>
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
function TaskCard({task,members,aiSchedule,projects,onOpen,onDragStart}){
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
  // Presencia: avatares apilados en la esquina si otros usuarios tienen
  // esta tarea abierta. Ignora al usuario actual.
  const presence = usePresence();
  const presentHere = (presence.presenceByTask?.[task.id]||[])
    .filter(u=>String(u.userId)!==String(presence.currentUserId));
  // Tarjetas mostradas en boards secundarios (linked) son no draggables y
  // tienen un fondo levemente distinto para distinguirlas. La tarea sigue
  // viviendo en su proyecto principal — se sincronizan vía mutadores Anywhere.
  const isLinkedHere = !!task._linkedFromAnotherProject;
  const linkedNames = (task.linkedProjects||[])
    .map(pid=>(projects||[]).find(p=>p.id===pid))
    .filter(Boolean)
    .map(p=>`${p.code||p.name}`);
  const sharedTooltip = isLinkedHere
    ? `Compartida desde otro proyecto`
    : (linkedNames.length>0 ? `También en: ${linkedNames.join(", ")}` : "");
  return(
    <div draggable={!isLinkedHere} onDragStart={isLinkedHere?undefined:onDragStart} onClick={onOpen} style={{background:isLinkedHere?"#FAFAF5":(p2?p2.cardBg:"#fff"),border:`0.5px solid ${p2?p2.cardBorder+"55":"#e5e7eb"}`,borderLeft:`4px solid ${p2?p2.cardBorder:"#e5e7eb"}`,borderRadius:10,padding:"10px 12px",marginBottom:8,cursor:"pointer"}}>
      <div style={{display:"flex",alignItems:"flex-start",gap:6,marginBottom:6}}>
        <div style={{flex:1,minWidth:0,fontSize:13,fontWeight:500,lineHeight:1.4}}>{task.title}</div>
        {presentHere.length>0 && (
          <div style={{display:"flex",flexShrink:0}} title={`${presentHere.map(u=>u.userName).join(", ")} ${presentHere.length===1?"está":"están"} viendo esta tarea`}>
            {presentHere.slice(0,3).map((u,i)=>{
              const mp2 = MP[u.userId]||MP[0];
              return(
                <div key={u.userId} style={{marginLeft:i>0?-5:0,zIndex:10-i,width:18,height:18,borderRadius:"50%",background:mp2.solid,color:"#fff",border:"2px solid #fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:700,boxShadow:u.isEditing?"0 0 0 2px #FCD34D":"none"}}>{u.userInitials||"?"}</div>
              );
            })}
          </div>
        )}
        {(isLinkedHere || (task.linkedProjects||[]).length>0) && <span title={sharedTooltip} style={{fontSize:10,padding:"1px 6px",borderRadius:4,background:"#F3F4F6",color:"#6B7280",border:"0.5px solid #E5E7EB",fontWeight:600,flexShrink:0}}>🔗</span>}
        <RefBadge code={task.ref}/>
      </div>
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
        <div style={{display:"flex",alignItems:"center",gap:5}}><PriBadge p={task.priority}/>{subs.length>0&&<span title={`${subDone}/${subs.length} subtareas`} style={{fontSize:10,padding:"1px 6px",borderRadius:10,background:subAllDone?"#E1F5EE":"#f3f4f6",color:subAllDone?"#085041":"#6b7280",fontWeight:600,border:`0.5px solid ${subAllDone?"#1D9E75":"#e5e7eb"}`}}>☑ {subDone}/{subs.length}</span>}{(task.links||[]).length>0&&<span title={`${task.links.length} enlace${task.links.length>1?"s":""}`} style={{fontSize:10,padding:"1px 6px",borderRadius:10,background:"#EEEDFE",color:"#3C3489",fontWeight:600,border:"0.5px solid #AFA9EC"}}>🔗 {task.links.length}</span>}{(task.timeline||[]).length>0&&<span title={`${task.timeline.length} actualizacion${task.timeline.length>1?"es":""}`} style={{fontSize:11,color:"#9ca3af"}}>💬 {task.timeline.length}</span>}</div>
      </div>
    </div>
  );
}

// ── Board View ────────────────────────────────────────────────────────────────
function BoardView({board,members,projectMemberIds,activeMemberId,aiSchedule,workspaceLinks,agents,ceoMemory,canDelete,projects,onNavigateProject,onTransferProject,onAddTimelineEntry,onToggleMilestone,externalOpenTaskId,onExternalTaskConsumed,onUpdate,onMove,onAddTask,onDeleteTask}){
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
            {col.tasks.map(task=><TaskCard key={`${task._linkedFromAnotherProject?"L-":""}${task.id}`} task={task} members={members} aiSchedule={aiSchedule} projects={projects} onOpen={()=>setOpenTaskId(task.id)} onDragStart={()=>setDragging({taskId:task.id,colId:col.id})}/>)}
            {newCard===col.id
              ?<div style={{background:"#fff",border:"0.5px solid #7F77DD",borderRadius:10,padding:8}}><input autoFocus value={newCardTitle} onChange={e=>setNewCardTitle(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")saveNew(col.id);if(e.key==="Escape")setNewCard(null);}} placeholder="Titulo de la tarea..." style={{width:"100%",border:"none",outline:"none",fontSize:13,background:"transparent",fontFamily:"inherit"}}/><div style={{display:"flex",gap:6,marginTop:8}}><button onClick={()=>saveNew(col.id)} style={{padding:"4px 10px",borderRadius:6,background:"#7F77DD",color:"#fff",border:"none",fontSize:12,cursor:"pointer"}}>Añadir</button><button onClick={()=>setNewCard(null)} style={{padding:"4px 10px",borderRadius:6,background:"transparent",border:"0.5px solid #d1d5db",fontSize:12,cursor:"pointer"}}>Cancelar</button></div></div>
              :<button onClick={()=>{setNewCard(col.id);setNewCardTitle("");}} style={{width:"100%",textAlign:"left",padding:"7px 8px",borderRadius:8,fontSize:13,color:"#6b7280",background:"transparent",border:"none",cursor:"pointer"}}>+ Añadir tarea</button>
            }
          </div>
        ))}
      </div>
      {openModal&&<TaskModal task={openModal.t} colId={openModal.colId} cols={board} members={members} activeMemberId={activeMemberId} workspaceLinks={workspaceLinks} agents={agents||[]} ceoMemory={ceoMemory} canDelete={canDelete || (openModal.t.assignees||[]).length===0} projects={projects} onNavigateProject={onNavigateProject} onTransferProject={onTransferProject?(newPid)=>{ onTransferProject(openModal.t.id, newPid); setOpenTaskId(null); }:undefined} onAddTimelineEntry={onAddTimelineEntry} onToggleMilestone={onToggleMilestone} onClose={()=>setOpenTaskId(null)} onUpdate={(id,cid,upd)=>onUpdate(id,cid,upd)} onMove={(id,from,to)=>{onMove(id,from,to);setOpenTaskId(null);}} onDelete={onDeleteTask}/>}
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

  const allT=Object.entries(boards).flatMap(([pid,cols])=>cols.flatMap(col=>col.tasks.filter(t=>!t.archived).map(t=>({...t,colId:col.id,colName:col.name,projId:Number(pid),projName:projects.find(p=>p.id===Number(pid))?.name||""}))));
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
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,minWidth:0}}>
                <RefBadge code={t.ref}/>
                <span style={{fontSize:13,fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.title}</span>
              </div>
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
  const allT=Object.entries(boards).flatMap(([pid,cols])=>cols.flatMap(col=>col.tasks.filter(t=>!t.archived).map(t=>({...t,colName:col.name,projName:projects.find(p=>p.id===Number(pid))?.name||""})))).filter(t=>t.colName!=="Hecho");
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
            {tasks.map(task=>{ const days=daysUntil(task.dueDate); const p2=palOf(task.assignees); return <div key={task.id} style={{background:"#fff",border:`0.5px solid ${p2?p2.cardBorder+"44":"#e5e7eb"}`,borderLeft:`3px solid ${p2?p2.cardBorder:"#e5e7eb"}`,borderRadius:8,padding:"7px 10px",marginBottom:6}}><div style={{display:"flex",alignItems:"center",gap:5,marginBottom:3,minWidth:0}}><RefBadge code={task.ref}/><span style={{fontSize:12,fontWeight:500,lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{task.title}</span></div><div style={{display:"flex",alignItems:"center",gap:5}}><span style={{fontSize:10,color:days<0?"#A32D2D":days<=2?"#854F0B":"#9ca3af",fontWeight:days<=2?600:400}}>{days<0?"Vencida":days===0?"Hoy":`${days}d`}</span><div style={{marginLeft:"auto",display:"flex"}}>{task.assignees.slice(0,3).map((mid,i2)=><div key={mid} style={{marginLeft:i2>0?-5:0,width:16,height:16,borderRadius:"50%",background:(MP[mid]||MP[0]).solid,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:7,fontWeight:700,border:"1.5px solid #fff"}}>{members.find(m=>m.id===mid)?.initials.slice(0,2)||"?"}</div>)}</div></div></div>; })}
          </div>
        );})}
      </div>
    </div>
  );
}

// ── Time Reports View ─────────────────────────────────────────────────────────
function TimeReportsView({boards,members,projects}){
  const [fm,setFm]=useState(-1); const [fp,setFp]=useState(-1);
  const allT=Object.entries(boards).flatMap(([pid,cols])=>cols.flatMap(col=>col.tasks.filter(t=>!t.archived).map(t=>({...t,colName:col.name,projId:Number(pid),projName:projects.find(p=>p.id===Number(pid))?.name||""}))));
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
function ProjectModal({project,members,workspaces,allProjects,currentMember,onClose,onSave,onTransferOwnership}){
  const isEdit=!!project;
  const [name,setName]=useState(project?.name||"");
  const [desc,setDesc]=useState(project?.desc||"");
  const [color,setColor]=useState(project?.color||PROJECT_COLORS[0]);
  const [emoji,setEmoji]=useState(project?.emoji||"🚀");
  const [code,setCode]=useState(project?.code||"");
  const [sel,setSel]=useState(project?.members||[]);
  const [workspaceId,setWorkspaceId]=useState(project?.workspaceId??null);
  const [visibility,setVisibility]=useState(project?.visibility || "private");
  const [cols,setCols]=useState(["Por hacer","En progreso","Revision","Hecho"]);
  const [newCol,setNewCol]=useState("");
  const [pendingClose,setPendingClose]=useState(false);
  const [transferOpen,setTransferOpen]=useState(false);
  const [transferTarget,setTransferTarget]=useState("");
  const [initialSnap]=useState(()=>JSON.stringify({
    name:project?.name||"", desc:project?.desc||"",
    color:project?.color||PROJECT_COLORS[0], emoji:project?.emoji||"🚀",
    code:project?.code||"",
    sel:project?.members||[], workspaceId:project?.workspaceId??null,
    visibility: project?.visibility || "private",
    cols:["Por hacer","En progreso","Revision","Hecho"], newCol:"",
  }));
  const isDirty=JSON.stringify({name,desc,color,emoji,code,sel,workspaceId,visibility,cols,newCol})!==initialSnap;
  const owner = isEdit ? (members||[]).find(m=>m.id===project.ownerId) : null;
  const isOwner = isEdit && currentMember && (currentMember.id === project.ownerId || currentMember.accountRole === "admin");
  const handleClose=()=>{ if(isDirty) setPendingClose(true); else onClose(); };
  useEffect(()=>{
    const onKey=e=>{ if(e.key==="Escape") handleClose(); };
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[isDirty]);
  const toggleM=id=>setSel(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);
  const addCol=()=>{ const t=newCol.trim(); if(!t)return; setCols(p=>[...p,t]); setNewCol(""); };
  // Validación de código: 3 letras A-Z y único entre proyectos (excluyendo
  // el proyecto actual al editar). Devuelve mensaje de error o "" si ok.
  const codeError = (()=>{
    if(!code) return "Código obligatorio";
    if(!isValidProjectCode(code)) return "Exactamente 3 letras (A-Z)";
    const collision = (allProjects||[]).some(p=>p.code===code && (!project || p.id!==project.id));
    if(collision) return "Código ya en uso";
    return "";
  })();
  const canSave = !!name.trim() && !codeError;
  const save=()=>{
    if(!canSave) return;
    onSave({name:name.trim(),desc,color,emoji,code,members:sel,columns:cols,workspaceId,visibility});
    onClose();
  };
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
              <div style={{display:"grid",gridTemplateColumns:"1fr 90px",gap:8}}>
                <div>
                  <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:5}}>Nombre</div>
                  <input value={name} onChange={e=>setName(e.target.value)} placeholder="Nombre del proyecto..." style={{width:"100%",padding:"8px 10px",borderRadius:8,border:`1.5px solid ${name?color:"#d1d5db"}`,fontSize:14,fontWeight:500,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
                </div>
                <div>
                  <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:5}}>Código</div>
                  <input
                    value={code}
                    onChange={e=>{
                      const v=(e.target.value||"").toUpperCase().replace(/[^A-Z]/g,"").slice(0,3);
                      setCode(v);
                    }}
                    placeholder="ej: SHM"
                    maxLength={3}
                    style={{width:"100%",padding:"8px 10px",borderRadius:8,border:`1.5px solid ${codeError?"#E24B4A":(code?color:"#d1d5db")}`,fontSize:14,fontWeight:700,outline:"none",fontFamily:"ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",letterSpacing:"0.08em",textTransform:"uppercase",boxSizing:"border-box",textAlign:"center"}}
                  />
                </div>
              </div>
              {codeError&&<div style={{fontSize:10,color:"#A32D2D",marginTop:4,fontWeight:500}}>{codeError}</div>}
              {!codeError&&project?.codeAuto&&code===project.code&&<div style={{fontSize:10,color:"#9ca3af",marginTop:4,fontStyle:"italic"}}>Código asignado automáticamente</div>}
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
          <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>Visibilidad del proyecto</div>
          <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:16}}>
            {[
              {key:"private", icon:"🔒", label:"Privado", desc:"Solo tú y los miembros invitados"},
              {key:"team",    icon:"👥", label:"Equipo",  desc:"Todos pueden verlo, solo miembros editan"},
              {key:"public",  icon:"🌍", label:"Público", desc:"Visible para toda la organización"},
            ].map(opt=>{
              const active = visibility===opt.key;
              return (
                <label key={opt.key} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:8,border:`1.5px solid ${active?color:"#e5e7eb"}`,background:active?`${color}10`:"#fff",cursor:"pointer"}}>
                  <input type="radio" name="visibility" value={opt.key} checked={active} onChange={()=>setVisibility(opt.key)} style={{margin:0,accentColor:color}}/>
                  <span style={{fontSize:14}}>{opt.icon}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:active?700:500,color:active?color:"#374151"}}>{opt.label}</div>
                    <div style={{fontSize:11,color:"#7F8C8D"}}>{opt.desc}</div>
                  </div>
                </label>
              );
            })}
          </div>
          {isEdit && owner && (
            <div style={{padding:"10px 12px",borderRadius:8,background:"#F9FAFB",border:"0.5px solid #E5E7EB",marginBottom:16,fontSize:12}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
                <div style={{minWidth:0}}>
                  <div style={{fontSize:10,fontWeight:600,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:"0.06em"}}>Propiedad</div>
                  <div style={{fontSize:13,color:"#111827",marginTop:2}}>👤 <b>{owner.name}</b> {owner.id===currentMember?.id ? <span style={{color:"#1D9E75"}}>(tú)</span> : null}</div>
                  {project?.createdAt && (
                    <div style={{fontSize:10.5,color:"#6B7280",marginTop:2}}>Creado el {new Date(project.createdAt).toLocaleDateString("es-ES",{day:"numeric",month:"short",year:"numeric"})}</div>
                  )}
                </div>
                {isOwner && onTransferOwnership && !transferOpen && (
                  <button onClick={()=>setTransferOpen(true)} style={{padding:"5px 10px",borderRadius:6,background:"transparent",border:"1px solid #D1D5DB",fontSize:11.5,fontWeight:600,cursor:"pointer",color:"#6B7280",fontFamily:"inherit"}}>Transferir propiedad</button>
                )}
              </div>
              {transferOpen && (
                <div style={{marginTop:10,paddingTop:10,borderTop:"0.5px dashed #E5E7EB",display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                  <select value={transferTarget} onChange={e=>setTransferTarget(e.target.value)} style={{flex:1,minWidth:160,padding:"5px 8px",borderRadius:6,border:"0.5px solid #D1D5DB",fontSize:12,fontFamily:"inherit",background:"#fff"}}>
                    <option value="">— Selecciona nuevo owner —</option>
                    {(members||[]).filter(m=>m.id!==project.ownerId).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <button
                    disabled={!transferTarget}
                    onClick={()=>{ onTransferOwnership(project.id, Number(transferTarget)); setTransferOpen(false); setTransferTarget(""); onClose(); }}
                    style={{padding:"5px 10px",borderRadius:6,background:transferTarget?"#E24B4A":"#E5E7EB",color:transferTarget?"#fff":"#9CA3AF",border:"none",fontSize:11.5,fontWeight:600,cursor:transferTarget?"pointer":"default",fontFamily:"inherit"}}
                  >Confirmar transferencia</button>
                  <button onClick={()=>{setTransferOpen(false);setTransferTarget("");}} style={{padding:"5px 10px",borderRadius:6,background:"transparent",border:"1px solid #D1D5DB",fontSize:11.5,cursor:"pointer",color:"#6B7280",fontFamily:"inherit"}}>Cancelar</button>
                </div>
              )}
            </div>
          )}
          <div style={{fontSize:10,fontWeight:600,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>Miembros</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:8,marginBottom:20}}>
            {members.map(m=>{ const mp2=MP[m.id]||MP[0]; const active=sel.includes(m.id); return <div key={m.id} onClick={()=>toggleM(m.id)} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:10,border:`1.5px solid ${active?mp2.solid:"#e5e7eb"}`,background:active?mp2.light:"#f9fafb",cursor:"pointer"}}><div style={{width:30,height:30,borderRadius:"50%",background:active?mp2.solid:"#d1d5db",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,flexShrink:0}}>{m.initials}</div><div style={{flex:1,minWidth:0}}><div style={{fontSize:12,fontWeight:active?600:400,color:active?mp2.solid:"#374151"}}>{m.name}</div><div style={{fontSize:10,color:"#9ca3af"}}>{m.role}</div></div></div>; })}
          </div>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
            <button onClick={onClose} style={{padding:"8px 16px",borderRadius:8,border:"0.5px solid #d1d5db",background:"transparent",fontSize:13,cursor:"pointer"}}>Cancelar</button>
            <button onClick={save} disabled={!canSave} style={{padding:"8px 20px",borderRadius:8,background:canSave?color:"#e5e7eb",color:canSave?"#fff":"#9ca3af",border:"none",fontSize:13,cursor:canSave?"pointer":"default",fontWeight:600}}>{isEdit?"Guardar cambios":"Crear proyecto"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sala de Mando — Command Room ─────────────────────────────────────────────
// Dashboard activo que dirige al CEO en lugar de informarle. La estructura
// visual contiene 4 elementos: Pulso del Día (timeline horizontal), Foco
// del Momento (tarjeta grande central), Riesgos Activos (3 tarjetas
// derecha) y los modales proactivos de Héctor (briefing matinal y cierre
// del día). Esta primera versión usa heurísticas deterministas; la
// selección por LLM y el resto de funcionalidades inteligentes se añaden
// en commits posteriores.
function CommandRoomView({data,activeMember,onOpenTask,onCompleteTask,onPostponeTask,onArchiveTask,onGoDashboard,onGoMytasks,onGoDealRoom,currentFocus,onSetCurrentFocus,onHectorStateChange,onHectorRecommendation,financeContext,onAddTimelineEntry,onRunAgentActions}){
  const {boards,projects,members,negotiations}=data;
  const me = (members||[]).find(m=>m.id===activeMember);
  // Tareas del usuario activo (asignadas a mí), enriquecidas con metadatos
  // de proyecto/columna para los chips visuales.
  const myTasks = [];
  Object.entries(boards||{}).forEach(([pid,cols])=>{
    const proj = (projects||[]).find(p=>p.id===Number(pid));
    cols.forEach(col=>col.tasks.forEach(t=>{
      if(t.archived) return;                                    // ocultas en Sala de Mando
      if(!t.assignees?.includes(activeMember)) return;
      const assigneeNames = (t.assignees||[]).map(id=>(members||[]).find(m=>m.id===id)?.name).filter(Boolean);
      myTasks.push({...t, colId:col.id, colName:col.name, projId:Number(pid), projName:proj?.name||"", projColor:proj?.color||"#7F77DD", projEmoji:proj?.emoji||"📋", projCode:proj?.code, assigneeNames, assigneeName:assigneeNames[0]||null});
    }));
  });
  const active = myTasks.filter(t=>t.colName!=="Hecho");
  // Foco del Momento: selección automática por Héctor (LLM) con fallback
  // determinista. El fallback se calcula siempre (instantáneo) y se muestra
  // mientras llega la decisión del LLM. Si hay cache <5min válido, se usa
  // sin nueva llamada. Si el LLM falla o no hay agente Héctor, se mantiene
  // el fallback con razón heurística.
  const fallbackFocus = (()=>{
    const overdue = active.filter(t=>t.dueDate&&daysUntil(t.dueDate)<0)
      .sort((a,b)=>daysUntil(a.dueDate)-daysUntil(b.dueDate));
    if(overdue.length>0) return {task:overdue[0], reason:`Vencida hace ${-daysUntil(overdue[0].dueDate)}d — ciérrala antes de seguir`};
    const today = active.filter(t=>t.dueDate&&daysUntil(t.dueDate)===0)
      .sort((a,b)=>(b.priority==="alta"?1:0)-(a.priority==="alta"?1:0));
    if(today.length>0) return {task:today[0], reason:"Vence hoy — bloquea esto en tu mañana"};
    const high = active.filter(t=>t.priority==="alta")
      .sort((a,b)=>(a.dueDate?daysUntil(a.dueDate):9999)-(b.dueDate?daysUntil(b.dueDate):9999));
    if(high.length>0) return {task:high[0], reason:"Alta prioridad y nadie la está moviendo"};
    return active.length>0 ? {task:active[0], reason:"Avanza esta primero, libera atención"} : null;
  })();
  // Cache key específico por usuario activo
  const FOCUS_CACHE_KEY = `soulbaric.focus.${activeMember}`;
  const FOCUS_TTL_MS = 5*60*1000; // 5 minutos
  // Hash compacto de las tareas activas — invalida cache cuando cambian
  // (id, columna, fecha, prioridad). No incluye campos dinámicos de tiempo.
  const tasksHash = active.map(t=>`${t.id}|${t.colName}|${t.dueDate||""}|${t.priority||""}`).sort().join(";");
  const [llmFocus,setLlmFocus] = useState(null);
  const [focusLoading,setFocusLoading] = useState(false);
  // Hidratar de cache al montar
  useEffect(()=>{
    try{
      const raw = localStorage.getItem(FOCUS_CACHE_KEY);
      if(!raw) return;
      const cached = JSON.parse(raw);
      if(!cached || cached.taskHash!==tasksHash) return;
      if(Date.now()-cached.ts > FOCUS_TTL_MS) return;
      const taskObj = active.find(t=>t.id===cached.taskId);
      if(taskObj) setLlmFocus({task:taskObj, reason:cached.reason||"", energyRequired:cached.energyRequired});
    }catch{}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  // Decide vía LLM cuando cambia el set de tareas (con debounce implícito
  // por TTL de cache). Cancelable si el componente se desmonta.
  useEffect(()=>{
    if(!active.length) { setLlmFocus(null); return; }
    // Si el cache es válido para este hash, no llamamos
    try{
      const raw = localStorage.getItem(FOCUS_CACHE_KEY);
      if(raw){
        const cached = JSON.parse(raw);
        if(cached?.taskHash===tasksHash && Date.now()-cached.ts <= FOCUS_TTL_MS){
          const taskObj = active.find(t=>t.id===cached.taskId);
          if(taskObj){ setLlmFocus({task:taskObj, reason:cached.reason||"", energyRequired:cached.energyRequired}); return; }
        }
      }
    }catch{}
    let cancelled=false;
    setFocusLoading(true);
    (async()=>{
      try{
        const hour = new Date().getHours();
        const energyLevel = getEnergyLevel(hour);
        const todayStr = fmt(new Date());
        const completedToday = myTasks.filter(t=>t.colName==="Hecho" && (t.timeLogs||[]).some(l=>l.date===todayStr)).length;
        const tasksJSON = JSON.stringify(active.slice(0,30).map(t=>{
          const neg = t.negotiationId ? (negotiations||[]).find(n=>n.id===t.negotiationId) : null;
          return {
            id: t.id,
            ref: t.ref,
            title: t.title,
            project: t.projName,
            counterparty: neg?.counterparty || null,
            priority: t.priority,
            dueDate: t.dueDate || null,
            colName: t.colName,
            estimatedHours: t.estimatedHours || 0,
            daysOverdue: t.dueDate ? -daysUntil(t.dueDate) : null,
          };
        }));
        const ceoFacts = (data.ceoMemory?.keyFacts||[]).slice(0,3).map(f=>f.content||f.text).filter(Boolean).join("; ");
        const hectorAgent = (data.agents||[]).find(a=>a.name==="Héctor");
        const baseSystem = hectorAgent?.promptBase
          ? hectorAgent.promptBase + "\n\n" + PLAIN_TEXT_RULE
          : "Eres Héctor, Chief of Staff estratégico. Decides qué tarea debe ejecutar el CEO ahora mismo. " + PLAIN_TEXT_RULE;
        const system = baseSystem + "\n\nIMPORTANTE: responde ÚNICAMENTE con JSON válido, sin markdown ni prosa.";
        const prompt = `El CEO te pide que decidas QUÉ TAREA debe hacer AHORA MISMO.\n\nCONTEXTO:\n- Hora actual: ${new Date().toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"})}\n- Día: ${new Date().toLocaleDateString("es-ES",{weekday:"long"})}\n- Tareas completadas hoy: ${completedToday}\n- Energía esperada a esta hora: ${energyLevel}\n${ceoFacts?`- Memoria del CEO: ${ceoFacts}\n`:""}\nTAREAS DISPONIBLES (${active.length} total, mostradas hasta 30):\n${tasksJSON}\n\nCRITERIOS (en este orden):\n1. Deadline: vencidas > vencen hoy > resto.\n2. Prioridad: alta > media > baja.\n3. Impacto: si hay contraparte esperando respuesta, prioriza.\n4. Energía: antes de las 12, tareas difíciles; después de las 15, tareas simples.\n5. Secuencia: evita cambiar entre proyectos cada 30 min.\n\nDevuelve JSON con esta forma exacta:\n{"taskId":"id de la tarea elegida","reason":"frase imperativa de 1 línea","timeBlocks":2,"energyRequired":"alta|media|baja"}`;
        const r = await fetch("/api/agent",{
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({system, messages:[{role:"user", content:prompt}], max_tokens:200}),
        });
        const raw = await r.text();
        if(cancelled) return;
        if(!r.ok) throw new Error(`HTTP ${r.status}`);
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch{}
        const txt = parsed?.text || raw;
        const m = txt.match(/\{[\s\S]*\}/);
        if(!m) throw new Error("JSON no encontrado");
        const decision = JSON.parse(m[0]);
        const taskObj = active.find(t=>String(t.id)===String(decision.taskId));
        if(!taskObj) throw new Error("taskId no coincide con ninguna tarea activa");
        const result = {task:taskObj, reason:decision.reason||"", energyRequired:decision.energyRequired||null};
        setLlmFocus(result);
        try{
          localStorage.setItem(FOCUS_CACHE_KEY, JSON.stringify({
            taskId: taskObj.id,
            reason: result.reason,
            energyRequired: result.energyRequired,
            taskHash: tasksHash,
            ts: Date.now(),
          }));
        }catch{}
      } catch(e){
        console.warn("[decideFocus] LLM falló, uso fallback:", e?.message);
      } finally {
        if(!cancelled) setFocusLoading(false);
      }
    })();
    return ()=>{ cancelled=true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[tasksHash]);
  // Foco efectivo: el del LLM si lo hay, si no el determinista.
  const focus = llmFocus || fallbackFocus;
  const focusTask = focus?.task || null;
  const focusReason = focus?.reason || "";
  const focusCountdown = (()=>{
    if(!focusTask?.dueDate) return null;
    const today = new Date(); today.setHours(0,0,0,0);
    const due = new Date(focusTask.dueDate); due.setHours(focusTask.dueTime?Number(focusTask.dueTime.split(":")[0]):23, focusTask.dueTime?Number(focusTask.dueTime.split(":")[1]):59);
    const diffMs = due - new Date();
    if(diffMs<0){ const d = Math.floor(-diffMs/86400000); return d>0?`Vencida hace ${d}d`:"Vencida"; }
    const h = Math.floor(diffMs/3600000), m = Math.floor((diffMs%3600000)/60000);
    if(h>=24) return `Vence en ${Math.floor(h/24)}d ${h%24}h`;
    return `Vence en ${h}h ${m}min`;
  })();

  const now = new Date();

  // Acciones del Foco. Empezar/Hecho mutan el board mediante callbacks
  // ya existentes en App; Posponer pide razón inline y mueve la fecha 1 día.
  const [postponeReason,setPostponeReason] = useState(null); // null | string en edición
  // Kanban del día colapsado por defecto — el CEO normalmente no lo
  // necesita expandido al entrar; ocupa pantalla útil. Se expande al click.
  const [kanbanExpanded,setKanbanExpanded] = useState(false);
  const startFocus = ()=>{
    if(!focusTask) return;
    onOpenTask?.(focusTask.id, focusTask.projId);
  };
  const completeFocus = ()=>{
    if(!focusTask) return;
    onCompleteTask?.(focusTask.id, focusTask.projId, focusTask.colId);
  };
  const submitPostpone = ()=>{
    if(!focusTask) return;
    const newDate = new Date(focusTask.dueDate || new Date());
    newDate.setDate(newDate.getDate()+1);
    onPostponeTask?.(focusTask, fmt(newDate), "+1d");
    setPostponeReason(null);
  };

  // Chips de KPIs en el header (mismas heurísticas que RiesgosPanel pero
  // calculadas aquí para mostrar el contador junto al saludo).
  const overdueColdCount = active.filter(t=>{
    if(!t.dueDate||daysUntil(t.dueDate)>=0) return false;
    const lastLog = (t.timeLogs||[]).slice(-1)[0]?.date || t.startDate;
    const days = lastLog ? Math.floor((Date.now()-new Date(lastLog).getTime())/86400000) : 999;
    return days>=2;
  }).length;
  const coldNegsCount = (negotiations||[]).filter(n=>{
    if(n.status!=="active" && n.status!=="open" && n.status!=="negotiating") return false;
    const ts = n.updatedAt ? new Date(n.updatedAt).getTime() : 0;
    if(!ts) return false;
    return (Date.now()-ts) > 5*86400000;
  }).length;
  const waitingCount = active.filter(t=>(t.timeline||t.comments||[]).some(c=>/esperando respuesta/i.test((c.text||c.content||"")))).length;

  return(
    <div style={{padding:"20px 22px",maxWidth:1280,margin:"0 auto"}}>
      {/* Cabecera */}
      <div style={{display:"flex",alignItems:"flex-end",justifyContent:"space-between",marginBottom:18,gap:12,flexWrap:"wrap"}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:11,fontWeight:700,color:"#7F77DD",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:4}}>🎯 Sala de Mando</div>
          <div style={{fontSize:22,fontWeight:700,color:"#111827"}}>Hola{me?`, ${me.name.split(" ")[0]}`:""}</div>
          <div style={{fontSize:12,color:"#6B7280",marginTop:2,marginBottom:10}}>{active.length} tarea{active.length!==1?"s":""} activa{active.length!==1?"s":""} · {now.toLocaleString("es-ES",{weekday:"long",day:"numeric",month:"long"})}</div>
          {/* KPIs como chips clicables */}
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <button
              onClick={()=>onGoMytasks?.("overdue")}
              title="Tareas vencidas sin actividad reciente"
              style={{padding:"6px 12px",borderRadius:20,background:"#FFF0F0",color:"#E74C3C",border:"1px solid #E74C3C",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}
            >🔴 Vencidas: {overdueColdCount}</button>
            <button
              onClick={()=>onGoDealRoom?.("cold")}
              title="Negociaciones sin actividad >5 días"
              style={{padding:"6px 12px",borderRadius:20,background:"#F0F7FF",color:"#3498DB",border:"1px solid #3498DB",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}
            >🧊 Frías: {coldNegsCount}</button>
            <button
              onClick={()=>onGoMytasks?.("waiting")}
              title="Tareas esperando respuesta de alguien"
              style={{padding:"6px 12px",borderRadius:20,background:"#FFF8E7",color:"#F39C12",border:"1px solid #F39C12",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}
            >📨 Esperan: {waitingCount}</button>
          </div>
        </div>
        <button onClick={onGoDashboard} style={{padding:"6px 12px",borderRadius:8,background:"#fff",color:"#6B7280",border:"1px solid #E5E7EB",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>📊 Dashboard analítico →</button>
      </div>

      {/* Foco del Momento — primera tarjeta tras el saludo, ahora full-width
          porque los riesgos están en chips en el header. */}
      <div style={{marginBottom:16}}>
        <div style={{background:"#fff",border:"2px solid #7F77DD33",borderRadius:14,padding:"24px 26px",minHeight:280,display:"flex",flexDirection:"column"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#7F77DD",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10,display:"flex",alignItems:"center",gap:8}}>
            <span>🎯 Foco del momento</span>
            {focusLoading && <span title="Héctor está decidiendo el siguiente foco" style={{fontSize:9,padding:"2px 7px",borderRadius:10,background:"#FEF3C7",color:"#92400E",border:"1px solid #FCD34D",fontWeight:600,letterSpacing:0,textTransform:"none",fontFamily:"inherit"}}>🤖 Héctor decidiendo…</span>}
            {!focusLoading && llmFocus && <span title="Decisión actual de Héctor" style={{fontSize:9,padding:"2px 7px",borderRadius:10,background:"#F0F9F1",color:"#0E7C5A",border:"1px solid #86EFAC",fontWeight:600,letterSpacing:0,textTransform:"none",fontFamily:"inherit"}}>🤖 Decidido por Héctor</span>}
          </div>
          {!focusTask
            ? <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:10}}>
                <div style={{fontSize:30}}>✨</div>
                <div style={{fontSize:15,color:"#6B7280",fontWeight:500}}>Sin tareas pendientes — has ganado la mañana.</div>
                <button onClick={onGoMytasks} style={{padding:"7px 14px",borderRadius:8,background:"transparent",color:"#7F77DD",border:"1px solid #7F77DD",fontSize:12,cursor:"pointer",fontWeight:600}}>Ver Mis tareas →</button>
              </div>
            : <>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                  <RefBadge code={focusTask.ref}/>
                  <span style={{fontSize:11,padding:"2px 9px",borderRadius:14,background:`${focusTask.projColor}18`,color:focusTask.projColor,border:`1px solid ${focusTask.projColor}55`,fontWeight:600}}>{focusTask.projEmoji} {focusTask.projName}</span>
                  {focusCountdown && <span style={{fontSize:11,padding:"2px 9px",borderRadius:14,background:"#FEF3C7",color:"#92400E",border:"1px solid #FCD34D",fontWeight:600}}>⏱ {focusCountdown}</span>}
                  {llmFocus?.energyRequired && <span title="Energía estimada para esta tarea" style={{fontSize:11,padding:"2px 9px",borderRadius:14,background:"#EEEDFE",color:"#3C3489",border:"1px solid #AFA9EC",fontWeight:600}}>⚡ {llmFocus.energyRequired}</span>}
                </div>
                <div style={{fontSize:32,fontWeight:700,color:"#111827",lineHeight:1.2,marginBottom:16}}>{focusTask.title}</div>
                <div style={{padding:"10px 14px",background:"#F5F3FF",border:"1px solid #DDD6FE",borderRadius:10,marginBottom:18,fontSize:12.5,color:"#5B21B6",fontStyle:"italic",lineHeight:1.5}}>
                  <b>Héctor:</b> {focusReason}
                </div>
                {postponeReason!==null
                  ? <div style={{display:"flex",gap:8,alignItems:"center",marginTop:"auto"}}>
                      <input value={postponeReason} onChange={e=>setPostponeReason(e.target.value)} placeholder="¿Por qué pospones? (obligatorio)" style={{flex:1,padding:"9px 12px",borderRadius:8,border:"1.5px solid #FCD34D",fontSize:13,fontFamily:"inherit",outline:"none"}}/>
                      <button onClick={submitPostpone} disabled={!postponeReason.trim()} style={{padding:"9px 16px",borderRadius:8,background:postponeReason.trim()?"#EF9F27":"#E5E7EB",color:postponeReason.trim()?"#fff":"#9CA3AF",border:"none",fontSize:12.5,cursor:postponeReason.trim()?"pointer":"not-allowed",fontWeight:600,fontFamily:"inherit"}}>Posponer +1d</button>
                      <button onClick={()=>setPostponeReason(null)} style={{padding:"9px 12px",borderRadius:8,background:"transparent",color:"#6B7280",border:"1px solid #D1D5DB",fontSize:12.5,cursor:"pointer",fontFamily:"inherit"}}>Cancelar</button>
                    </div>
                  : <div style={{display:"flex",gap:10,marginTop:"auto"}}>
                      <button onClick={startFocus} style={{flex:2,padding:"12px 18px",borderRadius:10,background:"#1D9E75",color:"#fff",border:"none",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>▶ Empezar ahora</button>
                      <button onClick={()=>setPostponeReason("")} style={{flex:1,padding:"12px 14px",borderRadius:10,background:"#fff",color:"#6B7280",border:"1px solid #D1D5DB",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>⏸ Posponer</button>
                      <button onClick={completeFocus} style={{flex:1,padding:"12px 14px",borderRadius:10,background:"#3B82F6",color:"#fff",border:"none",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>✓ Hecho</button>
                    </div>
                }
              </>
          }
        </div>
      </div>

      {/* HectorPanel — análisis proactivo */}
      {(()=>{
        // Riesgos derivados con campo `level` para que HectorPanel pueda
        // contar críticos. Se reusa la heurística que también calcula
        // RiesgosPanel pero serializada para el LLM.
        const overdueCold = active.filter(t=>{
          if(!t.dueDate||daysUntil(t.dueDate)>=0) return false;
          const lastLog = (t.timeLogs||[]).slice(-1)[0]?.date || t.startDate;
          const days = lastLog ? Math.floor((Date.now()-new Date(lastLog).getTime())/86400000) : 999;
          return days>=2;
        });
        const coldNegs = (negotiations||[]).filter(n=>{
          if(n.status!=="active" && n.status!=="open" && n.status!=="negotiating") return false;
          const ts = n.updatedAt ? new Date(n.updatedAt).getTime() : 0;
          if(!ts) return false;
          return (Date.now()-ts) > 5*86400000;
        });
        const waiting = active.filter(t=>(t.comments||[]).some(c=>/esperando respuesta/i.test(c.text||"")));
        const riesgosDetectados = [
          ...overdueCold.map(t=>({title:t.title, level:"critical", category:"vencida"})),
          ...coldNegs.map(n=>({title:n.title, level:"warning", category:"negociacion-fria"})),
          ...waiting.map(t=>({title:t.title, level:"medium", category:"esperando"})),
        ];
        return(
          <div style={{marginBottom:16}}>
            <HectorPanel
              tasks={active}
              currentFocus={currentFocus || focusTask}
              riesgos={riesgosDetectados}
              agent={(data.agents||[]).find(a=>a.name==="Héctor")}
              ceoMemory={data.ceoMemory}
              userId={activeMember}
              userName={me?.name}
              onStateChange={onHectorStateChange}
              onNewRecommendation={onHectorRecommendation}
              onRecommendationClick={(rec)=>{
                const task = active.find(t=>t.title===rec.title);
                if(task){
                  onSetCurrentFocus?.(task);
                  onOpenTask?.(task.id, task.projId);
                }
              }}
              onCompleteTask={(taskId,projId,colId)=>onCompleteTask?.(taskId,projId,colId)}
              onPostponeTask={(task)=>{
                if(!task) return;
                const newDate = new Date(task.dueDate||new Date());
                newDate.setDate(newDate.getDate()+1);
                onPostponeTask?.(task, fmt(newDate), "+1d");
              }}
              onArchiveTask={onArchiveTask}
              onOpenTask={onOpenTask}
              financeContext={financeContext}
              onAddTimelineEntry={onAddTimelineEntry}
              onRunAgentActions={onRunAgentActions}
            />
          </div>
        );
      })()}
      {/* Pulso del Día — timeline horizontal extraído a componente */}
      <PulsoDinamico active={active} negotiations={negotiations} onOpenTask={onOpenTask} RefBadge={RefBadge}/>
      {/* Kanban del día — colapsado por defecto. Cuando se expande
          renderizamos el componente TaskKanban con su propia card + header
          y un botón flotante para colapsar al final. */}
      {!kanbanExpanded ? (
        <div style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:12,marginBottom:16,overflow:"hidden"}}>
          <button
            onClick={()=>setKanbanExpanded(true)}
            style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",background:"transparent",border:"none",cursor:"pointer",fontFamily:"inherit"}}
          >
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:13,fontWeight:700,color:"#374151"}}>📋 Kanban del Día</span>
              <span style={{fontSize:11,padding:"2px 9px",borderRadius:10,background:"#F3F4F6",color:"#6B7280",fontWeight:600}}>{myTasks.length} tarea{myTasks.length!==1?"s":""}</span>
            </div>
            <span style={{fontSize:12,color:"#6B7280",fontWeight:600}}>▼ Ver</span>
          </button>
        </div>
      ) : (
        <div>
          <TaskKanban myTasks={myTasks} onOpenTask={onOpenTask} RefBadge={RefBadge}/>
          <div style={{display:"flex",justifyContent:"center",marginTop:-10,marginBottom:16}}>
            <button onClick={()=>setKanbanExpanded(false)} style={{padding:"6px 14px",borderRadius:8,background:"transparent",color:"#6B7280",border:"1px solid #E5E7EB",fontSize:11.5,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>▲ Colapsar Kanban</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Projects Home View ────────────────────────────────────────────────────────
function ProjectsView({projects,members,boards,currentMember,onSelectProject,onCreateProject,onEditProject,onDeleteProject}){
  const total=pid=>(boards[pid]||[]).flatMap(c=>c.tasks).length;
  const done=pid=>(boards[pid]||[]).filter(c=>c.name==="Hecho").flatMap(c=>c.tasks).length;
  const [pendingDel,setPendingDel]=useState(null);
  // Guard: si todavía no resolvimos el miembro activo, NO renderizamos
  // nada. Antes había un flash con todos los proyectos "team" porque
  // canViewProject(undefined, p) devolvía true para visibility "team"/
  // "public". Mejor mostrar skeleton vacío que filtrar contenido sensible.
  if (!currentMember) {
    return (
      <div style={{padding:20,textAlign:"center",color:"#9CA3AF",fontSize:13}}>Cargando proyectos…</div>
    );
  }
  // Filtro de visibilidad usando canViewProject de lib/auth.js. Mantiene el
  // índice del array maestro (i) para que setActiveProject/edit/delete sigan
  // apuntando al proyecto correcto.
  const isVisible = (p) => canViewProject(currentMember, p);
  const visibleCount = (projects||[]).filter(isVisible).length;
  // Empty state con CTA prominente cuando el miembro no ve ningún proyecto.
  // Mejor que mostrar el grid vacío con la dashed tile suelta — invita
  // explícitamente a crear el primer proyecto.
  if (visibleCount === 0) {
    return (
      <div style={{padding:"60px 20px",textAlign:"center",maxWidth:480,margin:"0 auto"}}>
        <div style={{fontSize:48,marginBottom:16}}>📁</div>
        <div style={{fontSize:18,fontWeight:700,color:"#111827",marginBottom:8}}>No tienes proyectos todavía</div>
        <div style={{fontSize:13,color:"#7F8C8D",marginBottom:24,lineHeight:1.5}}>Crea tu primer proyecto para empezar a organizar tus tareas. Será privado por defecto: solo tú y los miembros que invites podrán verlo.</div>
        <button
          onClick={onCreateProject}
          style={{background:"#3498DB",color:"#fff",padding:"12px 24px",borderRadius:8,fontSize:14,fontWeight:600,border:"none",cursor:"pointer",fontFamily:"inherit"}}
        >+ Crear mi primer proyecto</button>
      </div>
    );
  }
  return(
    <div style={{padding:20}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontSize:16,fontWeight:700,marginBottom:2}}>Todos los proyectos</div><div style={{fontSize:12,color:"#6b7280"}}>{visibleCount} proyectos activos</div></div>
        <button onClick={onCreateProject} style={{padding:"8px 18px",borderRadius:10,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>+ Nuevo proyecto</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:14}}>
        {projects.map((p,i)=>{
          if(!isVisible(p)) return null;
          const t=total(p.id),d=done(p.id),pct=t>0?Math.round(d/t*100):0;
          const projMs=p.members.map(mid=>members.find(m=>m.id===mid)).filter(Boolean);
          const isPending=pendingDel===i;
          // Indicadores de propiedad y permisos. visIcon refleja la
          // visibilidad del proyecto; isMine destaca proyectos cuyo owner es
          // el miembro activo; readOnly se aplica cuando puede ver pero no
          // editar (típico de proyectos "team"/"public" sin pertenencia).
          const visIcon = p.visibility === "private" ? "🔒"
            : p.visibility === "public" ? "🌍" : "👥";
          const visTitle = p.visibility === "private" ? "Privado — solo miembros"
            : p.visibility === "public" ? "Público — toda la organización" : "Equipo — todos pueden verlo";
          const isMine = currentMember && p.ownerId === currentMember.id;
          const canEdit = canEditProject(currentMember, p);
          const readOnly = !canEdit;
          return(
            <div key={p.id} style={{background:"#fff",border:`0.5px solid ${isPending?"#E24B4A":p.color+"44"}`,borderTop:`4px solid ${isPending?"#E24B4A":p.color}`,borderRadius:12,padding:16,cursor:"pointer",opacity:readOnly?0.92:1}} onClick={()=>!isPending&&onSelectProject(i)}>
              <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:12}}>
                <div style={{fontSize:26,lineHeight:1}}>{p.emoji||"📋"}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2,flexWrap:"wrap"}}>
                    <div style={{fontSize:14,fontWeight:700,color:p.color}}>{p.name}</div>
                    <RefBadge code={p.code}/>
                    <span title={visTitle} style={{fontSize:13,lineHeight:1}}>{visIcon}</span>
                    {isMine && <span title="Eres el owner de este proyecto" style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:10,background:"#1D9E7518",color:"#0E7C5A",border:"0.5px solid #1D9E7555",textTransform:"uppercase",letterSpacing:"0.04em"}}>Tuyo</span>}
                    {readOnly && <span title="Solo puedes ver este proyecto" style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:10,background:"#F3F4F6",color:"#6B7280",border:"0.5px solid #D1D5DB",textTransform:"uppercase",letterSpacing:"0.04em"}}>Solo lectura</span>}
                  </div>
                  {p.desc&&<div style={{fontSize:11,color:"#6b7280",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.desc}</div>}
                </div>
                <div style={{display:"flex",gap:4}} onClick={e=>e.stopPropagation()}>
                  {!isPending&&canEdit&&<>
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
          <div style={{display:"flex",alignItems:"center",gap:8,fontWeight:500,fontSize:15}}>Equipo — {project.name}<RefBadge code={project.code}/></div>
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
function UsersView({members,projects,permissions,onEdit,onCreate,onDelete,onSetPermission,onSetAgentPermission}){
  const [search,setSearch]=useState("");
  const [pendingDel,setPendingDel]=useState(null); // id del usuario pendiente de confirmar
  const [tab,setTab]=useState("users"); // "users" | "permissions" | "agents"

  const filtered=members.filter(m=>
    m.name.toLowerCase().includes(search.toLowerCase())||
    m.email.toLowerCase().includes(search.toLowerCase())||
    m.role.toLowerCase().includes(search.toLowerCase())
  );

  const confirmDelete=(id)=>{ onDelete(id); setPendingDel(null); };

  return(
    <div style={{padding:20}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:16,fontWeight:700,marginBottom:2}}>{tab==="users"?"Usuarios del sistema":tab==="agents"?"Agentes IA por miembro":"Gestión de permisos"}</div>
          <div style={{fontSize:12,color:"#6b7280"}}>{tab==="users"?`${members.length} usuarios registrados`:tab==="agents"?"Asigna qué agentes IA puede usar cada miembro":"Acceso granular por miembro y módulo"}</div>
        </div>
        {tab==="users" && <button onClick={onCreate} style={{padding:"8px 18px",borderRadius:10,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>+ Nuevo usuario</button>}
      </div>
      {/* Tabs */}
      <div style={{display:"flex",gap:6,marginBottom:16,borderBottom:"0.5px solid #E5E7EB"}}>
        {[["users","👤 Miembros"],["permissions","🔐 Permisos por módulo"],["agents","🤖 Agentes"]].map(([k,l])=>(
          <button key={k} onClick={()=>setTab(k)} style={{padding:"8px 14px",background:"transparent",border:"none",borderBottom:tab===k?"2px solid #7F77DD":"2px solid transparent",fontSize:13,fontWeight:tab===k?600:500,color:tab===k?"#7F77DD":"#6B7280",cursor:"pointer",fontFamily:"inherit"}}>{l}</button>
        ))}
      </div>
      {tab==="permissions" && (
        <PermissionsTable members={members} permissions={permissions} onSetPermission={onSetPermission}/>
      )}
      {tab==="agents" && (
        <AgentsPermissionsTable members={members} permissions={permissions} onSetAgentPermission={onSetAgentPermission}/>
      )}
      {tab==="users" && (<>
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
      </>)}
    </div>
  );
}

// ── Permissions Table ────────────────────────────────────────────────────────
// Tabla de permisos granulares por miembro y módulo. Se renderiza dentro
// de UsersView ▸ Permisos. Solo accesible para admin global (UsersView ya
// está admin-gated por adminOnly:true en el sidebar).
//
// NOTA: Sala de Mando, Home y Mis tareas son siempre accesibles — no
// aparecen aquí porque no son gateables. Proyectos y Deal Room aparecen
// en la tabla por consistencia visual y futura granularidad, pero hoy NO
// llevan `requiresPermission` en el sidebar (acceso abierto: cada miembro
// ve sus propios proyectos/deals filtrados por canViewProject/canViewDeal).
const PERMISSION_FEATURES = [
  { key: "finance",    label: "Finanzas",   icon: "💰", desc: "Tesorería, dashboard financiero, KPIs" },
  { key: "dealroom",   label: "Deal Room",  icon: "🤝", desc: "Negociaciones, sesiones, documentos" },
  { key: "projects",   label: "Proyectos",  icon: "📁", desc: "Tableros Kanban, miembros, columnas" },
  { key: "dashboard",  label: "Dashboard",  icon: "📊", desc: "Analítica global del equipo" },
  { key: "briefings",  label: "Briefings",  icon: "🧠", desc: "Briefings IA del equipo y proyectos" },
  { key: "memory",     label: "Memoria",    icon: "🧬", desc: "Memoria del CEO y agentes" },
  { key: "workspaces", label: "Workspaces", icon: "📦", desc: "Workspaces de cliente con credenciales" },
  { key: "gobernanza", label: "Gobernanza", icon: "🏛️", desc: "Estructura societaria, calendario fiscal, Gonzalo" },
];
// Agentes IA disponibles. Definición canónica usada por la pestaña
// "🤖 Agentes" de UsersView. Si añades un nuevo agente al sistema multi-
// agente (Mario/Jorge/Álvaro/...), añádelo aquí para exponer el toggle.
const AGENT_PERMISSIONS = [
  { key: "mario",   label: "Mario Legal",          emoji: "⚖️", color: "#3C3489", desc: "Contratos, cláusulas, compliance, jurisprudencia" },
  { key: "jorge",   label: "Jorge Finanzas",       emoji: "📊", color: "#B45309", desc: "Modelos financieros, ROI, waterfall, sensibilidades" },
  { key: "alvaro",  label: "Álvaro Inmobiliario",  emoji: "🏠", color: "#E67E22", desc: "Alquileres LAU, fiscalidad, inversión, alquiler turístico" },
  { key: "gonzalo", label: "Gonzalo Gobernanza",   emoji: "🏛️", color: "#8E44AD", desc: "Estructura societaria, holdings, calendario fiscal, sucesión" },
];
// Cada columna de módulo tiene su propio ancho mínimo (200px) para que
// quepan los 3 toggles V/E/A sin compresión. La 1ª columna (Miembro) usa
// `position:sticky;left:0` para que sea ancla mientras se hace scroll
// horizontal — el admin sigue viendo a quién pertenece cada fila.
const COL_W_MEMBER = 220;
const COL_W_MOD    = 200;

function PermissionsTable({ members, permissions, onSetPermission }) {
  const totalWidth = COL_W_MEMBER + (COL_W_MOD * PERMISSION_FEATURES.length);
  const renderCell = (m, f, isAdminGlobal) => {
    if (isAdminGlobal) {
      return (
        <div key={f.key} style={{ padding: "12px 14px", fontSize: 11.5, color: "#065F46", boxSizing: "border-box", width: COL_W_MOD, flexShrink: 0 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 12, background: "#DCFCE7", border: "1px solid #86EFAC", fontWeight: 600, whiteSpace: "nowrap" }}>✓ Admin</span>
        </div>
      );
    }
    const fp = permissions?.[m.id]?.[f.key] || { view: false, edit: false, admin: false };
    return (
      <div key={f.key} style={{ padding: "12px 14px", display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: "#374151", boxSizing: "border-box", width: COL_W_MOD, flexShrink: 0 }}>
        {[["view", "Ver"], ["edit", "Editar"], ["admin", "Admin"]].map(([level, label]) => (
          <label key={level} style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", userSelect: "none" }}>
            <input
              type="checkbox"
              checked={!!fp[level]}
              onChange={(e) => onSetPermission?.(m.id, f.key, level, e.target.checked)}
              style={{ cursor: "pointer", accentColor: "#7F77DD" }}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    );
  };
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "auto" }}>
      <div style={{ minWidth: totalWidth }}>
        {/* Header */}
        <div style={{ display: "flex", background: "#FAFAFA", borderBottom: "1px solid #E5E7EB", fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          <div style={{ padding: "12px 14px", width: COL_W_MEMBER, flexShrink: 0, position: "sticky", left: 0, background: "#FAFAFA", zIndex: 2, borderRight: "1px solid #E5E7EB", boxSizing: "border-box" }}>Miembro</div>
          {PERMISSION_FEATURES.map(f => (
            <div key={f.key} style={{ padding: "12px 14px", width: COL_W_MOD, flexShrink: 0, boxSizing: "border-box" }} title={f.desc}>{f.icon} {f.label}</div>
          ))}
        </div>
        {/* Rows */}
        {(members || []).map(m => {
          const isAdminGlobal = m.accountRole === "admin";
          const mp = MP[m.id] || MP[0];
          return (
            <div key={m.id} style={{ display: "flex", borderBottom: "0.5px solid #F3F4F6", alignItems: "center", background: "#fff" }}>
              <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10, minWidth: 0, width: COL_W_MEMBER, flexShrink: 0, position: "sticky", left: 0, background: "#fff", zIndex: 1, borderRight: "1px solid #F3F4F6", boxSizing: "border-box" }}>
                <div style={{ width: 30, height: 30, borderRadius: "50%", background: mp.solid, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{m.initials}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</div>
                  <div style={{ fontSize: 10.5, color: "#6B7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.email}</div>
                </div>
              </div>
              {PERMISSION_FEATURES.map(f => renderCell(m, f, isAdminGlobal))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Tabla dedicada de agentes IA por miembro. Vive en UsersView ▸ pestaña
// "🤖 Agentes". Una fila por miembro con toggles por cada agente
// disponible. Admin global muestra el badge "Todos activos" sin toggles.
function AgentsPermissionsTable({ members, permissions, onSetAgentPermission }) {
  const AGENT_GRID = `minmax(220px, 1fr) minmax(420px, 2fr)`;
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: AGENT_GRID, background: "#FAFAFA", borderBottom: "1px solid #E5E7EB", fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        <div style={{ padding: "12px 14px" }}>Miembro</div>
        <div style={{ padding: "12px 14px" }}>Agentes disponibles</div>
      </div>
      {(members || []).map(m => {
        const isAdminGlobal = m.accountRole === "admin";
        const mp = MP[m.id] || MP[0];
        return (
          <div key={m.id} style={{ display: "grid", gridTemplateColumns: AGENT_GRID, borderBottom: "0.5px solid #F3F4F6", alignItems: "center" }}>
            <div style={{ padding: "14px 14px", display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <div style={{ width: 34, height: 34, borderRadius: "50%", background: mp.solid, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{m.initials}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</div>
                <div style={{ fontSize: 10.5, color: "#6B7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.email}</div>
              </div>
            </div>
            {isAdminGlobal ? (
              <div style={{ padding: "14px 14px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 14, background: "#DCFCE7", border: "1px solid #86EFAC", color: "#065F46", fontSize: 12, fontWeight: 600 }}>✓ Admin global — todos los agentes activos</span>
              </div>
            ) : (
              <div style={{ padding: "14px 14px", display: "flex", flexWrap: "wrap", gap: 8 }}>
                {AGENT_PERMISSIONS.map(a => {
                  const checked = !!permissions?.[m.id]?.agents?.[a.key];
                  return (
                    <label
                      key={a.key}
                      title={a.desc}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 14px",
                        borderRadius: 10,
                        border: `1.5px solid ${checked ? a.color : "#E5E7EB"}`,
                        background: checked ? `${a.color}10` : "#FAFAFA",
                        cursor: "pointer",
                        userSelect: "none",
                        fontSize: 13,
                        fontWeight: checked ? 600 : 500,
                        color: checked ? a.color : "#6B7280",
                        transition: "background .15s ease, border-color .15s ease",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => onSetAgentPermission?.(m.id, a.key, e.target.checked)}
                        style={{ cursor: "pointer", accentColor: a.color, margin: 0 }}
                      />
                      <span style={{ fontSize: 16 }}>{a.emoji}</span>
                      <span>{a.label}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
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
                      <RefBadge code={p.code}/>
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
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                    <div style={{fontSize:14,fontWeight:700,color:w.color}}>{w.name}</div>
                    <RefBadge code={w.code}/>
                  </div>
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
        if(t.archived) return;
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
    // Búsqueda tolerante: matchTask normaliza acentos, espacios, guiones
    // y números escritos a palabras (es). Cubre formas tipo "T40", "t-40",
    // "t 40", "40", "cuarenta", "T cuarenta" sobre tareas con ref T-40.
    return {
      tasks:      allTasks.filter(t=>matchTask(t, q)).slice(0,10),
      actions:    actions.filter(a=>fuzzyMatch(a.label, q)),
      workspaces: (data.workspaces||[]).filter(w=>matchItemByCode(w, q)).slice(0,6),
      projects:   data.projects.filter(p=>matchItemByCode(p, q)).slice(0,6),
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
                  <div style={{display:"flex",alignItems:"center",gap:6,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    <RefBadge code={t.ref}/>
                    <span style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}><HighlightedText text={t.title} query={query.trim()}/></span>
                  </div>
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
                  <div style={{display:"flex",alignItems:"center",gap:6,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    <span style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}><HighlightedText text={w.name} query={query.trim()}/></span>
                    <RefBadge code={w.code}/>
                  </div>
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
                  <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:6}}>
                    <HighlightedText text={p.name} query={query.trim()}/>
                    <RefBadge code={p.code}/>
                  </div>
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
  { id:"acuerdo_parcial", label:"Acuerdo parcial",  color:"#7F77DD" },
];
// IDs de status que disparan el modal de cierre + extracción de lecciones.
const CLOSED_STATUSES = new Set(["cerrado_ganado","cerrado_perdido","acuerdo_parcial"]);
const NEG_STRATEGIES = ["Silencio","Indiferencia","BATNA","Preguntas calibradas","Anclaje","Reencuadre","Otra"];
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
// Modal de cierre. Recoge los datos del resultado tras marcar la
// negociación como cerrada (ganada/perdida/parcial). Tras guardar,
// el caller dispara la extracción de lecciones vía LLM.
function NegotiationCloseModal({negotiation, outcomeStatus, onSave, onCancel}){
  const labelByStatus = {
    cerrado_ganado:  "Cerrada ganada",
    cerrado_perdido: "Cerrada perdida",
    acuerdo_parcial: "Acuerdo parcial",
  };
  const computedDuration = (()=>{
    const start = negotiation?.createdAt ? new Date(negotiation.createdAt) : null;
    if(!start) return "";
    const days = Math.max(0, Math.round((Date.now() - start.getTime())/(1000*60*60*24)));
    return String(days);
  })();
  const [finalValue,setFinalValue] = useState(negotiation?.value ?? "");
  const [duration,setDuration]     = useState(computedDuration);
  const [rating,setRating]         = useState("Sí");
  const [whatWorked,setWhatWorked] = useState("");
  const [whatFailed,setWhatFailed] = useState("");
  const [strategies,setStrategies] = useState(new Set());
  const toggleStrategy = (s)=> setStrategies(prev=>{
    const n = new Set(prev); if(n.has(s)) n.delete(s); else n.add(s); return n;
  });
  const submit = ()=>{
    const result = {
      outcome: labelByStatus[outcomeStatus] || outcomeStatus,
      finalValue: finalValue==="" ? null : Number(finalValue),
      durationDays: duration==="" ? null : Number(duration),
      counterpartRating: rating,
      whatWorked: whatWorked.trim(),
      whatFailed: whatFailed.trim(),
      strategiesUsed: Array.from(strategies),
      closedAt: new Date().toISOString(),
    };
    onSave(result);
  };
  return(
    <div className="tf-overlay" onClick={e=>e.target===e.currentTarget&&onCancel()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:3500,display:"flex",alignItems:"flex-start",justifyContent:"center",paddingTop:30,paddingBottom:20,overflowY:"auto"}}>
      <div className="tf-modal" style={{background:"#fff",borderRadius:16,width:580,maxWidth:"96vw",border:"0.5px solid #e5e7eb",borderTop:"4px solid #7F77DD",marginBottom:20}}>
        <div style={{padding:"14px 20px",borderBottom:"0.5px solid #e5e7eb"}}>
          <div style={{fontSize:15,fontWeight:700,color:"#111827"}}>Cerrar negociación</div>
          <div style={{fontSize:12,color:"#6B7280",marginTop:2}}>{negotiation?.title} — {labelByStatus[outcomeStatus]}</div>
        </div>
        <div style={{padding:18,display:"flex",flexDirection:"column",gap:14,maxHeight:"68vh",overflowY:"auto"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <div>
              <div style={{fontSize:11,fontWeight:600,color:"#374151",marginBottom:4}}>Valor final acordado (€)</div>
              <input type="number" value={finalValue} onChange={e=>setFinalValue(e.target.value)} placeholder="Opcional" style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit"}}/>
            </div>
            <div>
              <div style={{fontSize:11,fontWeight:600,color:"#374151",marginBottom:4}}>Duración (días)</div>
              <input type="number" value={duration} onChange={e=>setDuration(e.target.value)} style={{width:"100%",padding:"7px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit"}}/>
            </div>
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:600,color:"#374151",marginBottom:4}}>Contraparte cumplió expectativas</div>
            <div style={{display:"flex",gap:6}}>
              {["Sí","Parcialmente","No"].map(opt=>(
                <button key={opt} onClick={()=>setRating(opt)} style={{padding:"6px 12px",borderRadius:6,background:rating===opt?"#7F77DD":"#fff",color:rating===opt?"#fff":"#374151",border:`1px solid ${rating===opt?"#7F77DD":"#D1D5DB"}`,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{opt}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:600,color:"#374151",marginBottom:4}}>Qué funcionó</div>
            <textarea value={whatWorked} onChange={e=>setWhatWorked(e.target.value)} rows={3} placeholder="Ej: silencio en la 2ª sesión hizo que ofrecieran +€10k" style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit",resize:"vertical"}}/>
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:600,color:"#374151",marginBottom:4}}>Qué falló o podría mejorar</div>
            <textarea value={whatFailed} onChange={e=>setWhatFailed(e.target.value)} rows={3} placeholder="Ej: respondí demasiado rápido a la oferta inicial" style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,fontFamily:"inherit",resize:"vertical"}}/>
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:600,color:"#374151",marginBottom:4}}>Estrategias principales usadas</div>
            <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
              {NEG_STRATEGIES.map(s=>{
                const sel = strategies.has(s);
                return <button key={s} onClick={()=>toggleStrategy(s)} style={{padding:"5px 11px",borderRadius:14,background:sel?"#EEEDFE":"#fff",color:sel?"#3C3489":"#6B7280",border:`1px solid ${sel?"#7F77DD":"#E5E7EB"}`,fontSize:11.5,fontWeight:sel?600:500,cursor:"pointer",fontFamily:"inherit"}}>{sel?"✓ ":""}{s}</button>;
              })}
            </div>
          </div>
        </div>
        <div style={{padding:"12px 20px",borderTop:"0.5px solid #e5e7eb",display:"flex",justifyContent:"flex-end",gap:8,background:"#fafafa",borderBottomLeftRadius:16,borderBottomRightRadius:16}}>
          <button onClick={onCancel} style={{padding:"8px 16px",borderRadius:8,background:"transparent",color:"#374151",border:"0.5px solid #D1D5DB",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Cancelar</button>
          <button onClick={submit} style={{padding:"8px 18px",borderRadius:8,background:"#7F77DD",color:"#fff",border:"none",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Cerrar y aprender</button>
        </div>
      </div>
    </div>
  );
}

function NegotiationModal({negotiation,members,workspaces,projects,agents,allNegotiations,currentMember,onClose,onSave,onDelete,onTransferOwnership}){
  const isEdit=!!negotiation;
  const [title,setTitle]       = useState(negotiation?.title||"");
  const [counterparty,setCP]   = useState(negotiation?.counterparty||"");
  const [status,setStatus]     = useState(negotiation?.status||"en_curso");
  const [value,setValue]       = useState(negotiation?.value??"");
  const [currency,setCurrency] = useState(negotiation?.currency||"EUR");
  const [description,setDesc]  = useState(negotiation?.description||"");
  // Owner es read-only en este modal: para creación se asigna en App.jsx
  // (createNegotiation fuerza activeMember); para edición solo cambia vía
  // botón "Transferir propiedad". El selector libre anterior se eliminó.
  const [ownerId]              = useState(negotiation?.ownerId ?? (currentMember?.id ?? members[0]?.id ?? 0));
  const [visibility,setVisibility] = useState(negotiation?.visibility || "private");
  // Miembros con permiso de edición (semántica equivalente a project.members).
  // En creación arrancamos con el currentMember para que el creador siempre
  // figure como miembro inicial. En edición se respeta lo que ya hubiera.
  const [selMembers,setSelMembers] = useState(()=>{
    if (Array.isArray(negotiation?.members)) return negotiation.members;
    if (currentMember) return [currentMember.id];
    return [];
  });
  // Multi-proyecto (FASE 1.5)
  const [relatedProjects,setRelatedProjects] = useState(negotiation?.relatedProjects||[]);
  const [relationships,setRelationships]     = useState(negotiation?.relationships||[]);
  const [stakeholders,setStakeholders]       = useState(negotiation?.stakeholders||[]);
  const [agentId,setAgentId] = useState(negotiation?.agentId??"");
  const [pendingDel,setPendingDel] = useState(false);
  const [pendingClose,setPendingClose] = useState(false);
  const [transferOpen,setTransferOpen] = useState(false);
  const [transferTarget,setTransferTarget] = useState("");
  const [initialSnap]=useState(()=>JSON.stringify({title:negotiation?.title||"",counterparty:negotiation?.counterparty||"",status:negotiation?.status||"en_curso",value:negotiation?.value??"",currency:negotiation?.currency||"EUR",description:negotiation?.description||"",visibility:negotiation?.visibility||"private",members:Array.isArray(negotiation?.members)?negotiation.members:(currentMember?[currentMember.id]:[]),relatedProjects:negotiation?.relatedProjects||[],relationships:negotiation?.relationships||[],stakeholders:negotiation?.stakeholders||[],agentId:negotiation?.agentId??""}));
  const isDirty=JSON.stringify({title,counterparty,status,value,currency,description,visibility,members:selMembers,relatedProjects,relationships,stakeholders,agentId})!==initialSnap;
  const handleClose=()=>{ if(isDirty) setPendingClose(true); else onClose(); };
  useEffect(()=>{ const k=e=>{if(e.key==="Escape") handleClose();}; window.addEventListener("keydown",k); return()=>window.removeEventListener("keydown",k); },[isDirty]);
  const [showCloseFlow,setShowCloseFlow] = useState(false);
  const owner = isEdit ? (members||[]).find(m=>m.id===negotiation.ownerId) : null;
  const isOwner = isEdit && currentMember && (currentMember.id === negotiation.ownerId || currentMember.accountRole === "admin");
  const toggleMember = (id) => setSelMembers(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);
  const buildPayload = ()=>{
    const primaryProjectId = relatedProjects[0]?.projectId ?? null;
    // Garantiza que el owner siempre esté en members[] para no dejar el deal
    // huérfano. Si Marc transfiere a Antonio antes de guardar, la transferencia
    // ya añade a Antonio; si el owner sigue siendo el actual, lo aseguramos.
    const finalMembers = selMembers.includes(ownerId) ? selMembers : [...selMembers, ownerId];
    return {title:title.trim(),counterparty:counterparty.trim(),status,value:value===""?null:Number(value),currency,description:description.trim(),ownerId:Number(ownerId),visibility,members:finalMembers,projectId:primaryProjectId,agentId:agentId===""?null:Number(agentId),relatedProjects,relationships,stakeholders};
  };
  const save=()=>{
    if(!title.trim()||!counterparty.trim()) return;
    // Si pasamos a status cerrado/parcial Y aún no hay result → modal
    // de cierre. Tras rellenarlo se persiste el resultado y se dispara
    // la extracción de lecciones vía LLM (handler closeNegotiation).
    const becomingClosed = CLOSED_STATUSES.has(status) && !negotiation?.result;
    if(becomingClosed){ setShowCloseFlow(true); return; }
    onSave(buildPayload());
    onClose();
  };
  const handleCloseFlowSave = (result)=>{
    onSave({...buildPayload(), result});
    setShowCloseFlow(false);
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
          <FL c="Descripción"/>
          <textarea value={description} onChange={e=>setDesc(e.target.value)} rows={3} placeholder="Contexto, objetivo, contraparte, plazos…" style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"0.5px solid #d1d5db",fontSize:13,resize:"vertical",fontFamily:"inherit"}}/>

          {/* Visibilidad — controla quién puede VER la negociación. La edición
              sigue gateada por canEditDeal (owner/miembros/admin) en server. */}
          <FL c="Visibilidad"/>
          <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:8}}>
            {[
              {key:"private", icon:"🔒", label:"Privada", desc:"Solo tú y los miembros invitados"},
              {key:"team",    icon:"👥", label:"Equipo",  desc:"Todos pueden ver, solo miembros editan"},
              {key:"public",  icon:"🌍", label:"Pública", desc:"Visible para toda la organización"},
            ].map(opt=>{
              const active = visibility===opt.key;
              return (
                <label key={opt.key} style={{display:"flex",alignItems:"center",gap:10,padding:"12px",borderRadius:8,border:`1.5px solid ${active?"#3B82F6":"#ECF0F1"}`,background:active?"#3B82F610":"#fff",cursor:"pointer",marginBottom:4}}>
                  <input type="radio" name="neg-visibility" value={opt.key} checked={active} onChange={()=>setVisibility(opt.key)} style={{margin:0,accentColor:"#3B82F6"}}/>
                  <span style={{fontSize:14}}>{opt.icon}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:active?700:500,color:active?"#1E40AF":"#374151"}}>{opt.label}</div>
                    <div style={{fontSize:11,color:"#7F8C8D"}}>{opt.desc}</div>
                  </div>
                </label>
              );
            })}
          </div>

          {/* Propiedad — read-only en edición. Solo el owner (o admin global)
              puede transferir a otro miembro. Mismo patrón que ProjectModal. */}
          {isEdit && owner && (
            <div style={{padding:"10px 12px",borderRadius:8,background:"#F8F9FA",border:"0.5px solid #ECF0F1",marginBottom:12,fontSize:12}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
                <div style={{minWidth:0}}>
                  <div style={{fontSize:10,fontWeight:600,color:"#7F8C8D",textTransform:"uppercase",letterSpacing:1}}>Propiedad</div>
                  <div style={{fontSize:13,color:"#111827",marginTop:4}}>🧑 <b>{owner.name}</b> {owner.id===currentMember?.id ? <span style={{color:"#1D9E75"}}>(tú)</span> : null}</div>
                  {negotiation?.createdAt && (
                    <div style={{fontSize:11,color:"#95A5A6",marginTop:2}}>Creado el {new Date(negotiation.createdAt).toLocaleDateString("es-ES",{day:"numeric",month:"short",year:"numeric"})}</div>
                  )}
                </div>
                {isOwner && onTransferOwnership && !transferOpen && (
                  <button onClick={()=>setTransferOpen(true)} style={{padding:"6px 14px",borderRadius:6,background:"#fff",border:"1px solid #BDC3C7",fontSize:13,fontWeight:500,cursor:"pointer",color:"#374151",fontFamily:"inherit"}}>Transferir propiedad</button>
                )}
              </div>
              {transferOpen && (
                <div style={{marginTop:10,paddingTop:10,borderTop:"0.5px dashed #ECF0F1",display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                  <select value={transferTarget} onChange={e=>setTransferTarget(e.target.value)} style={{flex:1,minWidth:160,padding:"5px 8px",borderRadius:6,border:"0.5px solid #D1D5DB",fontSize:12,fontFamily:"inherit",background:"#fff"}}>
                    <option value="">— Selecciona nuevo owner —</option>
                    {(members||[]).filter(m=>m.id!==negotiation.ownerId).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <button
                    disabled={!transferTarget}
                    onClick={()=>{ onTransferOwnership(negotiation.id, Number(transferTarget)); setTransferOpen(false); setTransferTarget(""); onClose(); }}
                    style={{padding:"5px 10px",borderRadius:6,background:transferTarget?"#E24B4A":"#E5E7EB",color:transferTarget?"#fff":"#9CA3AF",border:"none",fontSize:11.5,fontWeight:600,cursor:transferTarget?"pointer":"default",fontFamily:"inherit"}}
                  >Confirmar transferencia</button>
                  <button onClick={()=>{setTransferOpen(false);setTransferTarget("");}} style={{padding:"5px 10px",borderRadius:6,background:"transparent",border:"1px solid #D1D5DB",fontSize:11.5,cursor:"pointer",color:"#6B7280",fontFamily:"inherit"}}>Cancelar</button>
                </div>
              )}
            </div>
          )}

          {/* Miembros con permiso de edición — equivalente a project.members.
              Stakeholders (más abajo) son contactos externos, distinto rol. */}
          <FL c="Miembros con acceso a editar"/>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:8,marginBottom:8}}>
            {members.map(m=>{
              const mp2=MP[m.id]||MP[0];
              const active=selMembers.includes(m.id);
              const isOwnerHere = m.id === ownerId;
              return (
                <div key={m.id} onClick={()=>!isOwnerHere && toggleMember(m.id)} title={isOwnerHere?"El owner siempre es miembro":""} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:10,border:`1.5px solid ${active?mp2.solid:"#ECF0F1"}`,background:active?mp2.light:"#FAFAFA",cursor:isOwnerHere?"default":"pointer",opacity:isOwnerHere?0.85:1}}>
                  <div style={{width:32,height:32,borderRadius:"50%",background:active?mp2.solid:"#D1D5DB",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:600,flexShrink:0}}>{m.initials || m.name?.split(" ").map(s=>s[0]).join("").slice(0,2)}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:active?600:500,color:active?mp2.solid:"#111827",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.name}{isOwnerHere?" 👑":""}</div>
                    <div style={{fontSize:11,color:"#95A5A6"}}>{m.role||"Editor"}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Proyectos relacionados (múltiple) */}
          <div style={{marginTop:18,paddingTop:14,borderTop:"1px solid #E5E7EB"}}>
            <div style={{fontSize:13,fontWeight:600,color:"#111827",marginBottom:4}}>📊 Proyectos relacionados ({relatedProjects.length})</div>
            <div style={{fontSize:11,color:"#6B7280",marginBottom:8}}>Una negociación puede afectar a varios proyectos (legal, obra, financiación…). El primero se considera principal.</div>
            {relatedProjects.map(rp=>{ const p=projects.find(x=>x.id===rp.projectId); const ws=workspaces.find(w=>w.id===p?.workspaceId); const pri=PROJ_PRIORITY[rp.priority]||PROJ_PRIORITY.high; return(
              <div key={rp.projectId} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:8,marginBottom:6}}>
                <span style={{fontSize:16}}>{p?.emoji||"📋"}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                    <span style={{fontSize:13,fontWeight:600,color:"#111827",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ws?`${ws.emoji} ${ws.name} / `:""}{p?.name||"(proyecto borrado)"}</span>
                    <RefBadge code={p?.code}/>
                  </div>
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
                    {projects.filter(p=>!relatedProjects.some(rp=>rp.projectId===p.id)).map(p=>{ const ws=workspaces.find(w=>w.id===p.workspaceId); return <option key={p.id} value={p.id}>{ws?`${ws.name} / `:""}{p.name}{p.code?` [${p.code}]`:""}</option>; })}
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
                    {availableNegs.map(n=><option key={n.id} value={n.id}>{n.code?`[${n.code}] `:""}{n.title}</option>)}
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
      {showCloseFlow && <NegotiationCloseModal negotiation={negotiation} outcomeStatus={status} onSave={handleCloseFlowSave} onCancel={()=>setShowCloseFlow(false)}/>}
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
function DealRoomView({negotiations,members,projects,workspaces,currentMember,filter,onSetFilter,onCreate,onOpen,onEdit}){
  // Guard: hasta tener miembro resuelto, no rendereamos nada — evita el
  // flash de negociaciones ajenas que ocurría con el redirect tardío.
  if (!currentMember) {
    return <div style={{padding:30,textAlign:"center",color:"#9CA3AF",fontSize:13}}>Cargando negociaciones…</div>;
  }
  // Filtrado de visibilidad SÍNCRONO con useMemo. canViewDeal aplica reglas
  // de admin/owner/miembro/visibility. Todas las counts y alertas operan
  // sobre la lista ya filtrada — el non-admin nunca ve datos ajenos.
  const visibleNegotiations = React.useMemo(
    ()=>(negotiations||[]).filter(n=>canViewDeal(currentMember, n)),
    [negotiations, currentMember]
  );
  const filtered = filter==="all" ? visibleNegotiations : visibleNegotiations.filter(n=>n.status===filter);
  const counts = NEG_STATUSES.reduce((o,s)=>{o[s.id]=visibleNegotiations.filter(n=>n.status===s.id).length;return o;},{all:visibleNegotiations.length});
  // Empty state prominente cuando el miembro no ve ninguna negociación —
  // CTA dedicado en lugar del banner dashed dentro del listado.
  if (visibleNegotiations.length === 0) {
    return (
      <div style={{padding:"60px 20px",textAlign:"center",maxWidth:480,margin:"0 auto"}}>
        <div style={{fontSize:48,marginBottom:16}}>🤝</div>
        <div style={{fontSize:18,fontWeight:700,color:"#111827",marginBottom:8}}>No tienes negociaciones activas</div>
        <div style={{fontSize:13,color:"#7F8C8D",marginBottom:24,lineHeight:1.5}}>Crea tu primera negociación para empezar a gestionar tus deals. Será privada por defecto: solo tú y los miembros que invites podrán verla.</div>
        <button
          onClick={onCreate}
          style={{background:"#3498DB",color:"#fff",padding:"12px 24px",borderRadius:8,fontSize:14,fontWeight:600,border:"none",cursor:"pointer",fontFamily:"inherit"}}
        >+ Nueva negociación</button>
      </div>
    );
  }

  // Alerts automáticas: opera SOLO sobre negociaciones visibles para no
  // filtrar por título datos privados ajenos.
  const alerts = React.useMemo(()=>{
    const out=[];
    const now=Date.now();
    const byId = new Map(visibleNegotiations.map(n=>[n.id,n]));
    visibleNegotiations.forEach(n=>{
      const daysSince = n.updatedAt ? Math.floor((now-new Date(n.updatedAt))/86400000) : 0;
      const blockedBy = visibleNegotiations.filter(x=>(x.relationships||[]).some(r=>r.negotiationId===n.id&&r.type==="blocks"));
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
    visibleNegotiations.forEach(n=>{
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
  },[visibleNegotiations]);
  return(
    <div style={{maxWidth:1000,margin:"0 auto",padding:"30px 20px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:22,fontWeight:700,marginBottom:4}}>🤝 Deal Room</div>
          <div style={{fontSize:13,color:"#6b7280"}}>{visibleNegotiations.length} negociación{visibleNegotiations.length!==1?"es":""} · Timeline de sesiones, notas y resúmenes</div>
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
            <div style={{fontSize:14,color:"#6b7280",marginBottom:14}}>{visibleNegotiations.length===0?"Aún no hay negociaciones. Crea la primera para empezar.":`Sin negociaciones ${getNegStatus(filter).label.toLowerCase()}.`}</div>
            {visibleNegotiations.length===0&&<button onClick={onCreate} style={{padding:"9px 18px",borderRadius:10,background:"#3B82F6",color:"#fff",border:"none",fontSize:13,cursor:"pointer",fontWeight:600}}>+ Nueva negociación</button>}
          </div>
        : <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {filtered.map(n=>{
              const st=getNegStatus(n.status);
              const owner=members.find(m=>m.id===n.ownerId);
              const mp2=MP[owner?.id]||MP[0];
              const lastSession = (n.sessions||[]).slice().sort((a,b)=>b.date.localeCompare(a.date))[0];
              const blocksList     = (n.relationships||[]).filter(r=>r.type==="blocks").map(r=>visibleNegotiations.find(x=>x.id===r.negotiationId)).filter(Boolean);
              const blockedByList  = visibleNegotiations.filter(x=>(x.relationships||[]).some(r=>r.negotiationId===n.id&&r.type==="blocks"));
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
                        <RefBadge code={n.code}/>
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
                      {blockedByList.map(b=><div key={b.id} style={{color:"#7F1D1D",marginTop:2,display:"flex",alignItems:"center",gap:6}}>→ <RefBadge code={b.code}/>{b.title}</div>)}
                      {daysSince>3&&<div style={{color:"#B91C1C",fontWeight:600,marginTop:4}}>⏱ Sin movimiento hace {daysSince}d</div>}
                    </div>
                  )}
                  {blocksList.length>0&&(
                    <div style={{fontSize:11.5,padding:"7px 10px",background:"#FEF3C7",border:"1px solid #FCD34D",borderRadius:8,marginTop:6}}>
                      <div style={{fontWeight:600,color:"#92400E"}}>🔒 Bloquea:</div>
                      {blocksList.slice(0,3).map(b=><div key={b.id} style={{color:"#78350F",marginTop:2,display:"flex",alignItems:"center",gap:6}}>→ <RefBadge code={b.code}/>{b.title}</div>)}
                    </div>
                  )}
                  {influencesList.length>0&&(
                    <div style={{fontSize:11.5,padding:"7px 10px",background:"#EFF6FF",border:"1px solid #BFDBFE",borderRadius:8,marginTop:6}}>
                      <div style={{fontWeight:600,color:"#1E3A8A"}}>🔗 Relacionada con:</div>
                      {influencesList.map(r=>{ const t=visibleNegotiations.find(x=>x.id===r.negotiationId); const rt=getRelType(r.type); return t?<div key={r.id} style={{color:"#1E40AF",marginTop:2,display:"flex",alignItems:"center",gap:6}}>{rt.icon} <RefBadge code={t.code}/>{t.title}</div>:null; })}
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
function NegotiationDetailView({negotiation,members,projects,workspaces,agents,boards,allNegotiations,ceoMemory,currentMember,permissions,onAddCeoMemory,onAddNegMemory,onRemoveNegMemory,onSummarizeAndClearChat,onRouteAutoLearn,onMemorized,onBack,onEditNeg,onCreateSession,onOpenSession,onEditSession,onRequestBriefing,onGoProject,onOpenTask,onOpenRelatedNeg,onClearBriefing,onAppendHectorMessage,onClearHectorChat,onClearHectorErrors,onSetAnalysis,onSaveBriefing,onUpdateDocuments,onOverlayTask}){
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
  // Multi-agente: si está ON, tras la respuesta de Héctor disparamos una
  // mini-llamada de clasificación que decide si conviene invocar a Mario o
  // Jorge. Persistido en localStorage por dispositivo (no en data).
  const [autoSpecialistsOn,setAutoSpecialistsOn] = useState(()=>{
    try { return localStorage.getItem("soulbaric.autoSpecialists") !== "0"; } catch { return true; }
  });
  const toggleAutoSpecialists = ()=>{
    setAutoSpecialistsOn(v=>{
      const nv = !v;
      try { localStorage.setItem("soulbaric.autoSpecialists", nv?"1":"0"); } catch {}
      return nv;
    });
  };
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
  const criticalTasks = relProjs.flatMap(({p,tasks})=>tasks.filter(t=>t.colName!=="Hecho"&&!t.archived).map(t=>({...t, projId:p.id, projName:p.name, projColor:p.color, projEmoji:p.emoji||"📋"})))
    .sort((a,b)=>{
      const da = a.dueDate ? daysUntil(a.dueDate) : 9999;
      const db = b.dueDate ? daysUntil(b.dueDate) : 9999;
      if(da!==db) return da-db;
      return (a.title||"").localeCompare(b.title||"");
    });

  // Fingerprints para stale detection en hectorAnalysis.
  const fpTask = (t)=>`${t.title}|${t.dueDate||""}|${t.colName||""}|${t.priority||""}`;
  const fpProj = (r)=>`${r.activeCount}|${r.overdueCount}`;

  // callAgentSafe se importa desde lib/agent.js (función pura, accesible
  // a todos los componentes). Antes vivía aquí dentro de
  // NegotiationDetailView y producía ReferenceError cuando otros
  // componentes (TaskFlow.callGonzaloDirect) intentaban usarla.

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
      const negIdent = negotiation.code ? `${negotiation.code} ` : "";
      const contextLines = [
        `Negociación: ${negIdent}${negotiation.title}`,
        `Contraparte: ${negotiation.counterparty}`,
        `Estado: ${st.label}`,
      ];
      if(negotiation.description) contextLines.push(`Descripción: ${negotiation.description}`);
      const contextStr = contextLines.join("\n");
      const itemPrompt = kind==="task"
        ? `Analiza SOLO esta tarea y nada más:\n${item.ref||"["+item.id+"]"} ${item.title} (proyecto: ${item.projName}, columna: ${item.colName}, fecha: ${item.dueDate||"sin fecha"}, prioridad: ${item.priority})\n\nDame 2-4 frases de análisis directo + máx 2 tags de esta lista cerrada: "Bloquea negociación", "Decisión Tipo 1", "Decisión Tipo 2", "Riesgo alto", "Riesgo bajo", "Delegable", "Urgente".\n\nResponde EXCLUSIVAMENTE con JSON válido de esta forma exacta: {"text":"…","tags":["…"]}`
        : `Analiza SOLO este proyecto y nada más:\n${item.p.code||"["+item.p.id+"]"} ${item.p.name} (rol en esta negociación: ${item.rp.role||"relacionado"}, ${item.activeCount} tareas activas, ${item.overdueCount} vencidas)\n\nDame 2-4 frases de análisis directo + máx 2 tags de esta lista cerrada: "Bloquea negociación", "Decisión Tipo 1", "Decisión Tipo 2", "Riesgo alto", "Riesgo bajo", "Delegable", "Urgente".\n\nResponde EXCLUSIVAMENTE con JSON válido de esta forma exacta: {"text":"…","tags":["…"]}`;
      const system = (hector.promptBase||"") + "\n\n---\nCONTEXTO DE ESTA NEGOCIACIÓN:\n" + contextStr + "\n\n" + PLAIN_TEXT_RULE + "\n\nIMPORTANTE: responde ÚNICAMENTE con JSON válido, sin markdown ni prosa. El valor del campo \"text\" debe ser texto plano sin asteriscos ni guiones de lista.";
      const txt = await callAgentSafe({system,messages:[{role:"user",content:itemPrompt}],max_tokens:500},{timeoutMs:30000});
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
          <RefBadge code={negotiation.code}/>
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
                            <RefBadge code={p.code}/>
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
                            <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                              <RefBadge code={t.ref}/>
                              <span style={{fontSize:12.5,color:"#111827",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.title}</span>
                            </div>
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
            const negIdent = negotiation.code ? `${negotiation.code} ` : "";
            lines.push(`Negociación: ${negIdent}${negotiation.title}`);
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
                lines.push(`- ${p.code||"["+p.id+"]"} ${p.name} — rol "${rp.role||"relacionado"}", prioridad ${rp.priority||"high"}, ${activeCount} tareas activas (${overdueCount} vencidas)`);
              });
            }
            if(criticalTasks.length>0){
              lines.push(`\nTareas activas destacadas (${Math.min(20,criticalTasks.length)}/${criticalTasks.length}):`);
              criticalTasks.slice(0,20).forEach(t=>{
                const d = t.dueDate ? daysUntil(t.dueDate) : null;
                const dueLabel = !t.dueDate ? "sin fecha" : d<0 ? `vencida ${-d}d` : d===0 ? "hoy" : `en ${d}d`;
                const ident = t.ref || t.id;
                lines.push(`- ${ident}: ${t.title} (${t.projName}·${t.colName}, ${dueLabel}, prio=${t.priority})`);
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
            // Lecciones de negociaciones anteriores cerradas (extraídas
            // por LLM tras el cierre). Las últimas 10 ordenadas por fecha
            // más reciente. Permiten a Héctor recomendar estrategias que
            // ya han funcionado y evitar las que fallaron.
            const allLessons = (ceoMemory?.lessons||[])
              .filter(l => l.source==="negotiation-result")
              .slice()
              .sort((a,b)=> new Date(b.createdAt||0) - new Date(a.createdAt||0))
              .slice(0,10);
            if(allLessons.length>0){
              lines.push(`\nLECCIONES DE NEGOCIACIONES ANTERIORES (${allLessons.length}):`);
              allLessons.forEach(l=>{
                const tag = l.lessonType ? `[${l.lessonType}]` : "[lesson]";
                const ctx = l.negotiationTitle ? ` (de "${l.negotiationTitle}", ${l.outcome||""})` : "";
                lines.push(`- ${tag} ${l.text}${ctx}`);
              });
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
            // Mensajes "specialist" se inyectan como assistant con prefijo
            // "(<NombreEspecialista> dijo: …)" para que Héctor los integre en
            // su razonamiento sin romper el orden user/assistant alternado.
            const all = negotiation.hectorChat||[];
            const picked = all.length<=30 ? all : [...all.slice(0,5), ...all.slice(-25)];
            const history = picked
              .filter(m=>m.role!=="specialist-loading")
              .map(m=>{
                if(m.role==="specialist") return {role:"assistant", content:`(${m.specialistName||"Especialista"} dijo: ${m.content||""})`};
                return {role:m.role==="user"?"user":"assistant", content:m.content};
              });
            history.push({role:"user",content:userMessage});
            return callAgentSafe({system,messages:opts.isolatedHistory?[{role:"user",content:userMessage}]:history,max_tokens:opts.maxTokens||900},{timeoutMs:opts.timeoutMs||45000});
          };
          // Parser de invocación EXPLÍCITA: lee la respuesta de Héctor,
          // busca etiquetas [INVOCAR:mario|jorge:tarea] y devuelve:
          //  - cleanContent: texto sin las etiquetas (para mostrar al usuario)
          //  - specialists: array de especialistas a invocar
          // Mecanismo binario: si Héctor no incluye la etiqueta, no hay
          // invocación. Cero falsos positivos por palabras clave en prosa.
          // Sincrónico — sin coste extra por llamada al LLM clasificador.
          const parseSpecialistTags = (text)=>{
            const mario   = (agents||[]).find(a=>a.name==="Mario Legal");
            const jorge   = (agents||[]).find(a=>a.name==="Jorge Finanzas");
            const alvaro  = (agents||[]).find(a=>a.name==="Álvaro Inmobiliario");
            const gonzalo = (agents||[]).find(a=>a.name==="Gonzalo Gobernanza");
            const empty = {cleanContent:String(text||""), specialists:[]};
            if(!mario && !jorge && !alvaro && !gonzalo) return empty;
            const re = /\[INVOCAR:(mario|jorge|alvaro|gonzalo):([^\]]+)\]/gi;
            const found = [];
            const seen = new Set();
            let m;
            while((m = re.exec(text||"")) !== null){
              const key = m[1].toLowerCase();
              if(seen.has(key)) continue;
              seen.add(key);
              // Gate por permisos: si el miembro activo no tiene acceso a
              // ese agente, ignoramos la etiqueta (se eliminará igual del
              // texto, pero no se invoca al especialista).
              if(!canUseAgent(currentMember, key, permissions)) continue;
              const task = (m[2]||"").trim();
              if(key==="mario" && mario){
                found.push({agentId:mario.id, name:"Mario Legal", emoji:"⚖️", task});
              } else if(key==="jorge" && jorge){
                found.push({agentId:jorge.id, name:"Jorge Finanzas", emoji:"📊", task});
              } else if(key==="alvaro" && alvaro){
                found.push({agentId:alvaro.id, name:"Álvaro Inmobiliario", emoji:"🏠", task});
              } else if(key==="gonzalo" && gonzalo){
                found.push({agentId:gonzalo.id, name:"Gonzalo Gobernanza", emoji:"🏛️", task});
              }
            }
            // Eliminar las etiquetas del texto mostrado y colapsar saltos
            // de línea triples que pueda dejar el strip.
            const cleanContent = String(text||"")
              .replace(re, "")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
            return {cleanContent, specialists:found};
          };
          // Llamada al especialista con su propio promptBase + contexto +
          // tarea + respuesta previa de Héctor. Devuelve el texto plano del
          // especialista. No persiste — el caller decide qué hacer con él.
          const invokeSpecialist = async({agentId, task, hectorReply})=>{
            const ag = (agents||[]).find(a=>a.id===agentId); if(!ag) return null;
            const sys = (ag.promptBase||`Eres ${ag.name}, ${ag.role||"especialista"}.`) + "\n\n" + PLAIN_TEXT_RULE;
            const negIdent = negotiation.code ? `${negotiation.code} ` : "";
            const ctx = `CONTEXTO DE LA NEGOCIACIÓN:\nTítulo: ${negIdent}${negotiation.title}\nContraparte: ${negotiation.counterparty}` +
              (negotiation.value!=null ? `\nValor: ${negotiation.value} ${negotiation.currency||"EUR"}` : "") +
              (negotiation.description ? `\nDescripción: ${negotiation.description}` : "") +
              `\n\nTAREA QUE TE ENCARGA HÉCTOR:\n${task||"(sin descripción)"}` +
              (hectorReply ? `\n\nRESPUESTA PREVIA DE HÉCTOR (referencia):\n${String(hectorReply).slice(0,800)}` : "");
            // max_tokens 4096: los specialists del Deal Room (Mario,
            // Jorge, Álvaro, Gonzalo) generan outputs largos — contratos
            // completos, waterfalls, análisis LAU, escrituras. Con 1000
            // se truncaba a mitad de cláusula. 4096 cubre 3-4 páginas.
            // Timeout: 45s base. Mario Legal sube a 90s cuando la tarea
            // pide redactar contratos / documentos / cláusulas — ese tipo
            // de salida tarda más en generarse y antes saltaba abort
            // aunque el contenido estaba bien. Jorge/Álvaro/Gonzalo siguen
            // en 45s sin cambio.
            const REDACCION_KEYWORDS = [
              "redacta", "redactar", "contrato", "documento", "acuerdo",
              "escribe", "elabora", "borrador", "clausula", "clausulas",
              "cláusula", "cláusulas", "arrendamiento", "cesion", "cesión",
              "convenio", "escritura",
            ];
            const taskLower = String(task || "").toLowerCase();
            const esRedaccion = ag.name === "Mario Legal"
              && REDACCION_KEYWORDS.some(k => taskLower.includes(k));
            const timeoutMs = esRedaccion ? 90000 : 45000;
            return callAgentSafe(
              { system: sys, messages: [{role:"user", content: ctx}], max_tokens: 4096 },
              { timeoutMs }
            );
          };
          // Orquestador: invoca a un especialista y mete dos mensajes en el
          // chat (placeholder loading + respuesta final). Usado tanto por la
          // detección automática como por los botones manuales.
          const runSpecialist = async(specialist, hectorReply)=>{
            const loadingTs = new Date().toISOString();
            onAppendHectorMessage(negotiation.id, {
              role:"specialist-loading",
              specialistId: specialist.agentId,
              specialistName: specialist.name,
              specialistEmoji: specialist.emoji,
              task: specialist.task||"",
              timestamp: loadingTs,
            });
            try{
              const out = await invokeSpecialist({agentId:specialist.agentId, task:specialist.task, hectorReply});
              onAppendHectorMessage(negotiation.id, {
                role:"specialist",
                specialistId: specialist.agentId,
                specialistName: specialist.name,
                specialistEmoji: specialist.emoji,
                content: out||"(sin respuesta)",
                task: specialist.task||"",
                invokedBy: hectorReply ? "hector" : "user",
                loadingTs,
                timestamp: new Date().toISOString(),
              });
            }catch(e){
              onAppendHectorMessage(negotiation.id, {
                role:"specialist",
                specialistId: specialist.agentId,
                specialistName: specialist.name,
                specialistEmoji: specialist.emoji,
                content: `⚠ Error al invocar a ${specialist.name}: ${e.message||e}`,
                task: specialist.task||"",
                invokedBy: hectorReply ? "hector" : "user",
                loadingTs,
                timestamp: new Date().toISOString(),
                error: true,
              });
            }
          };
          // Manual: el usuario pulsa "⚖️ Mario" o "📊 Jorge" desde el chat,
          // se pide la tarea por window.prompt y se invoca. La descripción
          // queda asociada al mensaje en el chat para trazabilidad.
          const handleManualSpecialist = (which)=>{
            if(chatLoading) return;
            const SPEC_NAMES = {mario:"Mario Legal", jorge:"Jorge Finanzas", alvaro:"Álvaro Inmobiliario", gonzalo:"Gonzalo Gobernanza"};
            const SPEC_EMOJIS = {mario:"⚖️", jorge:"📊", alvaro:"🏠", gonzalo:"🏛️"};
            const targetName = SPEC_NAMES[which];
            const ag = (agents||[]).find(a=>a.name===targetName);
            if(!ag){ onAppendHectorMessage(negotiation.id,{role:"assistant",content:`⚠ No encuentro a ${targetName||which} en agentes.`,timestamp:new Date().toISOString()}); return; }
            const task = window.prompt(`¿Qué tarea le pides a ${ag.name}?`, "");
            if(!task || !task.trim()) return;
            runSpecialist({agentId:ag.id, name:ag.name, emoji:SPEC_EMOJIS[which]||"🤖", task:task.trim()}, null);
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
              const raw = reply||"(respuesta vacía)";
              // Parseo SINCRÓNICO de etiquetas [INVOCAR:…] antes de mostrar:
              // el texto que ve el usuario nunca incluye la etiqueta.
              const {cleanContent, specialists:invokedSpecialists} = parseSpecialistTags(raw);
              const content = cleanContent || "(respuesta vacía)";
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
              // Multi-agente: invocación EXPLÍCITA. Solo si Héctor incluyó
              // la etiqueta [INVOCAR:…] en su respuesta. Si tocan los dos
              // dominios (legal + financiero), las llamadas se hacen en
              // PARALELO con Promise.all para no doblar la espera.
              // Fire-and-forget para no bloquear el chat.
              if(autoSpecialistsOn && invokedSpecialists.length>0){
                (async()=>{
                  try{
                    await Promise.all(invokedSpecialists.map(sp=>runSpecialist(sp, content)));
                  } catch(e){ console.warn("[multi-agent] auto-invoke failed:", e.message); }
                })();
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
            const taskLines = criticalTasks.map(t=>`- ${t.ref||t.id}: ${t.title} (${t.projName}·${t.colName}, ${t.dueDate||"sin fecha"})`).join("\n");
            const projLines = relProjs.map(({p,rp,activeCount,overdueCount})=>`- ${p.code||"["+p.id+"]"} ${p.name} (${rp.role||"relacionado"}, ${activeCount} activas, ${overdueCount} vencidas)`).join("\n");
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
                      // Mensaje "specialist": se renderiza con bg propio
                      // (azul claro Mario, verde claro Jorge), header con
                      // emoji + nombre + "invocado por Héctor/usuario", y
                      // footer con botón "📎 Guardar en memoria".
                      if(m.role==="specialist"){
                        // Paleta de color por especialista — mantiene la
                        // identidad visual de Mario/Jorge/Álvaro/Gonzalo
                        // dentro del feed del chat de Héctor.
                        const SPEC_PALETTE = {
                          "Mario Legal":          {bg:"#EFF6FF",border:"#BFDBFE",accent:"#1E40AF"},
                          "Jorge Finanzas":       {bg:"#F0FDF4",border:"#86EFAC",accent:"#0E7C5A"},
                          "Álvaro Inmobiliario":  {bg:"#FFFBEB",border:"#FCD34D",accent:"#92400E"},
                          "Gonzalo Gobernanza":   {bg:"#F5EEFA",border:"#D8B4FE",accent:"#6B21A8"},
                        };
                        const palette = SPEC_PALETTE[m.specialistName] || {bg:"#F3F4F6",border:"#D1D5DB",accent:"#374151"};
                        const bg = palette.bg, border = palette.border, accent = palette.accent;
                        const saveToMemory = ()=>{
                          const text = `[${m.specialistName||"Especialista"}] ${m.task?`(${m.task}) `:""}${m.content||""}`.slice(0,800);
                          onAddNegMemory?.(negotiation.id, "keyFacts", text);
                        };
                        return(
                          <div key={i} style={{display:"flex",justifyContent:"flex-start"}}>
                            <div style={{maxWidth:"92%",padding:"10px 12px",borderRadius:10,background:bg,border:`1px solid ${border}`,fontSize:12.5,color:"#1f2937",lineHeight:1.55,whiteSpace:"pre-wrap"}}>
                              <div style={{fontSize:11,fontWeight:700,color:accent,marginBottom:4,display:"flex",alignItems:"center",gap:6}}>
                                <span>{m.specialistEmoji||"🤝"}</span>
                                <span>{m.specialistName||"Especialista"}</span>
                                <span style={{fontWeight:500,color:"#6B7280"}}>— invocado por {m.invokedBy==="user"?"ti":"Héctor"}</span>
                              </div>
                              {m.task&&<div style={{fontSize:10.5,color:"#6B7280",fontStyle:"italic",marginBottom:6}}>Tarea: {m.task}</div>}
                              <div>{m.content}</div>
                              <div style={{fontSize:10,color:"#9CA3AF",marginTop:6,opacity:0.85,display:"flex",alignItems:"center",gap:8}}>
                                <span style={{flex:1}}>{m.timestamp?new Date(m.timestamp).toLocaleString("es-ES",{hour:"2-digit",minute:"2-digit",day:"numeric",month:"short"}):""}</span>
                                {!m.error && (
                                  <button onClick={saveToMemory} title="Guardar como dato clave en memoria de la negociación" style={{padding:"2px 8px",borderRadius:10,background:"#fff",color:accent,border:`1px solid ${border}`,fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>📎 Guardar en memoria</button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      }
                      if(m.role==="specialist-loading"){
                        return(
                          <div key={i} style={{display:"flex",justifyContent:"flex-start"}}>
                            <div style={{padding:"8px 12px",borderRadius:10,background:"#FFFBEB",border:"1px dashed #FCD34D",fontSize:12,color:"#92400E",fontStyle:"italic",display:"flex",alignItems:"center",gap:6}}>
                              <span>{m.specialistEmoji||"🤝"}</span>
                              <span>Consultando a {m.specialistName||"especialista"}…</span>
                            </div>
                          </div>
                        );
                      }
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
              {/* Barra multi-agente: invocación manual + toggle ON/OFF.
                  En móvil (≤768px) los chips ganan altura táctil 40px y
                  fontSize 14px; flexWrap:wrap ya estaba para que rompan
                  línea en pantallas estrechas. */}
              <style>{`
                @media (max-width: 768px) {
                  [data-spec-row] { padding: 8px 12px !important; gap: 8px !important; }
                  [data-spec-chip] {
                    min-height: 40px;
                    padding: 8px 16px !important;
                    font-size: 14px !important;
                    border-radius: 999px !important;
                  }
                }
              `}</style>
              <div data-spec-row style={{padding:"6px 12px",borderTop:"1px solid #F3F4F6",background:"#FCFCFD",display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                <span style={{fontSize:10,fontWeight:600,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:"0.06em"}}>Especialistas</span>
                {canUseAgent(currentMember,"mario",permissions) && <button data-spec-chip onClick={()=>handleManualSpecialist("mario")} disabled={chatLoading} title="Pedir intervención de Mario Legal" style={{padding:"3px 10px",borderRadius:14,background:"#fff",color:"#1E40AF",border:"1px solid #BFDBFE",fontSize:11,cursor:chatLoading?"not-allowed":"pointer",fontWeight:600,fontFamily:"inherit"}}>⚖️ Mario</button>}
                {canUseAgent(currentMember,"jorge",permissions) && <button data-spec-chip onClick={()=>handleManualSpecialist("jorge")} disabled={chatLoading} title="Pedir intervención de Jorge Finanzas" style={{padding:"3px 10px",borderRadius:14,background:"#fff",color:"#0E7C5A",border:"1px solid #86EFAC",fontSize:11,cursor:chatLoading?"not-allowed":"pointer",fontWeight:600,fontFamily:"inherit"}}>📊 Jorge</button>}
                {canUseAgent(currentMember,"alvaro",permissions) && <button data-spec-chip onClick={()=>handleManualSpecialist("alvaro")} disabled={chatLoading} title="Pedir intervención de Álvaro Inmobiliario" style={{padding:"3px 10px",borderRadius:14,background:"#fff",color:"#92400E",border:"1px solid #FCD34D",fontSize:11,cursor:chatLoading?"not-allowed":"pointer",fontWeight:600,fontFamily:"inherit"}}>🏠 Álvaro</button>}
                {canUseAgent(currentMember,"gonzalo",permissions) && <button data-spec-chip onClick={()=>handleManualSpecialist("gonzalo")} disabled={chatLoading} title="Pedir intervención de Gonzalo Gobernanza" style={{padding:"3px 10px",borderRadius:14,background:"#fff",color:"#6B21A8",border:"1px solid #D8B4FE",fontSize:11,cursor:chatLoading?"not-allowed":"pointer",fontWeight:600,fontFamily:"inherit"}}>🏛️ Gonzalo</button>}
                <div style={{flex:1}}/>
                <label style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:10,color:"#6B7280",cursor:"pointer"}} title="Cuando está activo, Héctor delega automáticamente en Mario o Jorge si la respuesta lo requiere.">
                  <input type="checkbox" checked={autoSpecialistsOn} onChange={toggleAutoSpecialists} style={{cursor:"pointer"}}/>
                  Auto
                </label>
              </div>
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
                    {availableProjects.map(p=><option key={p.id} value={p.id}>{p.emoji||"📋"} {p.name}{p.code?` [${p.code}]`:""}</option>)}
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
function MyTasksView({data,activeMember,onOpenTask,onNavigate,onUnarchiveTask}){
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
  // Activas = no archivadas. El filtro "Archivadas" es el único que las muestra.
  const active = allMine.filter(t=>!t.archived);
  const archived = allMine.filter(t=>t.archived);
  const counts = {
    all:       active.length,
    overdue:   active.filter(t=>t.colName!=="Hecho"&&t.dueDate&&daysUntil(t.dueDate)<0).length,
    today:     active.filter(t=>t.colName!=="Hecho"&&t.dueDate&&daysUntil(t.dueDate)===0).length,
    soon:      active.filter(t=>t.colName!=="Hecho"&&t.dueDate&&daysUntil(t.dueDate)>0&&daysUntil(t.dueDate)<=7).length,
    done:      active.filter(t=>t.colName==="Hecho").length,
    archived:  archived.length,
  };
  let filtered = active;
  if(filter==="overdue")       filtered = active.filter(t=>t.colName!=="Hecho"&&t.dueDate&&daysUntil(t.dueDate)<0);
  else if(filter==="today")    filtered = active.filter(t=>t.colName!=="Hecho"&&t.dueDate&&daysUntil(t.dueDate)===0);
  else if(filter==="soon")     filtered = active.filter(t=>t.colName!=="Hecho"&&t.dueDate&&daysUntil(t.dueDate)>0&&daysUntil(t.dueDate)<=7);
  else if(filter==="done")     filtered = active.filter(t=>t.colName==="Hecho");
  else if(filter==="archived") filtered = archived;
  // Sort: overdue/today first, then by due date asc, then by project
  filtered = filtered.slice().sort((a,b)=>{
    const da=a.dueDate?daysUntil(a.dueDate):9999;
    const db=b.dueDate?daysUntil(b.dueDate):9999;
    if(da!==db) return da-db;
    return (a.projName||"").localeCompare(b.projName||"");
  });
  const FILTERS=[["all","Todas"],["overdue","Vencidas"],["today","Hoy"],["soon","Próximos 7d"],["done","Hechas"],["archived","📦 Archivadas"]];

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
                <div key={`${t.projId}-${t.id}`} onClick={()=>onOpenTask(t.id)} className="tf-lift" style={{background:t.archived?"#FAFAFA":"#fff",border:"1px solid #E5E7EB",borderLeft:`4px solid ${t.projColor}`,borderRadius:10,padding:"11px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:12,opacity:t.archived?0.85:1}}>
                  <QBadge q={q}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                      <RefBadge code={t.ref}/>
                      <span style={{fontSize:13,fontWeight:500,color:"#111827",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.title}</span>
                      {t.archived&&<span style={{fontSize:9.5,padding:"1px 6px",borderRadius:4,background:"#E5E7EB",color:"#6B7280",fontWeight:600,letterSpacing:"0.04em"}}>📦 ARCHIVADA</span>}
                    </div>
                    <div style={{fontSize:11,color:"#6B7280",marginTop:2}}>{t.projEmoji} {t.projName} · {t.colName} · <span style={{color:dueColor,fontWeight:500}}>{dueLabel}</span></div>
                  </div>
                  <PriBadge p={t.priority}/>
                  {t.archived&&onUnarchiveTask&&(
                    <button onClick={e=>{e.stopPropagation(); onUnarchiveTask(t.id);}} title="Restaurar tarea (vuelve a ser activa)" style={{padding:"5px 10px",borderRadius:6,background:"#fff",color:"#1D9E75",border:"1px solid #86EFAC",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>↩ Restaurar</button>
                  )}
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

      {/* Lecciones de negociación: subset filtrado de ceoMemory.lessons
          con source="negotiation-result". Render dedicado con badge por
          tipo y referencia a la negociación origen. */}
      {(()=>{
        const negLessons = (ceoMemory?.lessons||[]).filter(l=>l.source==="negotiation-result");
        if(negLessons.length===0) return null;
        const badgeStyle = (type)=>{
          if(type==="warning") return {bg:"#FEF2F2",color:"#B91C1C",label:"warning"};
          if(type==="pattern") return {bg:"#EFF6FF",color:"#1E40AF",label:"pattern"};
          return {bg:"#F0FDF4",color:"#0E7C5A",label:"lesson"};
        };
        return(
          <>
            <div style={{fontSize:11,fontWeight:700,color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",margin:"18px 0 10px"}}>Lecciones de negociación ({negLessons.length})</div>
            <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:10}}>
              {negLessons.slice().reverse().map(item=>{
                const b = badgeStyle(item.lessonType);
                return(
                  <div key={item.id} style={{padding:"10px 12px",background:"#fff",border:"1px solid #E5E7EB",borderRadius:8,borderLeft:`3px solid ${b.color}`}}>
                    <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:4}}>
                      <span style={{fontSize:9.5,fontWeight:700,color:b.color,background:b.bg,padding:"1px 7px",borderRadius:4,textTransform:"uppercase",letterSpacing:"0.04em",flexShrink:0}}>{b.label}</span>
                      <div style={{flex:1,fontSize:12.5,color:"#1F2937",lineHeight:1.5}}>{item.text}</div>
                    </div>
                    {(item.negotiationTitle || item.outcome) && (
                      <div style={{fontSize:10.5,color:"#9CA3AF",fontStyle:"italic"}}>
                        ↳ {item.negotiationTitle||"(sin título)"}{item.outcome?` · ${item.outcome}`:""} · {new Date(item.createdAt).toLocaleDateString("es-ES")}
                      </div>
                    )}
                    {item.applicableTo && (
                      <div style={{fontSize:10.5,color:"#6B7280",marginTop:3}}>Aplica a: {item.applicableTo}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}

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
  // Acceso invitado al vault: si la URL es /vault/:token rendereamos
  // VaultGuestView en pantalla completa, SIN sidebar ni resto de la app.
  // Persiste mutaciones contra el state principal para que el CEO vea los
  // cambios cuando vuelva a abrir la app normal.
  const guestVaultToken = typeof window !== "undefined" ? parseVaultGuestPath(window.location.pathname) : null;
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
  const [activeTab,setActiveTab]   = useState("hector-direct");
  const [activeMember,setAM]       = useState(()=>{ const u=readStoredUser(); return typeof u?.id==="number"?u.id:5; });
  // Briefing matinal automático: aparece la primera apertura del día
  // (>4h desde el último uso) si todavía no se mostró hoy. La marca
  // "soulbaric.briefingMatinal.lastDate" la pone el propio modal al
  // cerrarse. "soulbaric.lastOpenTs" se actualiza al final del trigger
  // para no auto-disparar de nuevo en la misma sesión.
  const [showBriefing,setShowBriefing] = useState(false);
  // Contexto financiero para Héctor — combina las heurísticas legacy del
  // módulo Finanzas básico (financeMovements) con el resumen ampliado de
  // bankMovements + facturas via buildFinanceSummary. Compacto para que el
  // prompt del agente no se infle.
  const financeContext = React.useMemo(()=>{
    const movs = data.financeMovements || [];
    const today = new Date();
    const isSameMonth = (date, ref)=>{ const d=new Date(date); return d.getFullYear()===ref.getFullYear() && d.getMonth()===ref.getMonth(); };
    // Saldo legacy (financeMovements). El saldo "real" multi-empresa lo
    // toma summary desde bankAccounts/bankMovements.
    const currentBalance = movs.reduce((acc,m)=>{
      if(m.status!=="paid") return acc;
      return m.type==="income" ? acc + Number(m.amount||0) : acc - Number(m.amount||0);
    },0);
    let burnSum = 0;
    for(let i=1;i<=3;i++){
      const ref = new Date(today.getFullYear(), today.getMonth()-i, 1);
      burnSum += movs.filter(m=>m.type==="expense" && m.status==="paid" && isSameMonth(m.date,ref)).reduce((a,m)=>a+Number(m.amount||0),0);
    }
    const monthlyBurnRate = burnSum/3;
    const runwayLegacy = monthlyBurnRate>0 ? Number((currentBalance/monthlyBurnRate).toFixed(1)) : null;
    const pendingIncome = movs.filter(m=>m.type==="income" && m.status==="pending").reduce((a,m)=>a+Number(m.amount||0),0);
    const upcomingExpenses = movs.filter(m=>m.type==="expense" && m.status==="pending").reduce((a,m)=>a+Number(m.amount||0),0);
    // Resumen multi-empresa consolidado para enriquecer el contexto.
    let summary = null;
    try { summary = buildFinanceSummary(data, "all"); } catch { summary = null; }
    // Si el módulo Finanzas tiene datos reales (bankAccounts no vacío),
    // priorizamos sus números — son los que ve el CEO en el dashboard.
    const hasMultiCompany = summary && (summary.saldo !== 0 || (data.bankAccounts||[]).length > 0);
    return {
      currentBalance: hasMultiCompany ? summary.saldo : currentBalance,
      monthlyBurnRate: hasMultiCompany ? summary.burnRate : monthlyBurnRate,
      runway: hasMultiCompany ? summary.runway : runwayLegacy,
      pendingIncome,
      upcomingExpenses,
      // Campos ampliados (commit 7) — Héctor los puede usar opcionalmente.
      facturasPendientesCobro: summary?.facturasPendientesCobro || { count: 0, total: 0 },
      facturasPendientesPago:  summary?.facturasPendientesPago  || { count: 0, total: 0 },
      facturasVencidas: summary?.facturasVencidas?.length || 0,
      ivaTrimestreActual: summary?.ivaTrimestreActual || null,
      alertas: summary?.alertas || [],
    };
  },[data]);
  // Cierre del día pasivo: aparece si la hora local es ≥18:00 y todavía
  // no se mostró el cierre hoy. Se evalúa al montar y cuando el usuario
  // vuelve a la pestaña (focus). La marca diaria la pone el propio modal.
  const [showClosing,setShowClosing] = useState(false);
  // Sala de Mando — estado proactivo de Héctor compartido entre
  // HectorPanel (Sala de Mando) y HectorFloat (widget global).
  const [hectorPanelOpen,setHectorPanelOpen] = useState(false);
  const [hectorState,setHectorState]         = useState("listening");
  const [currentFocus,setCurrentFocus]       = useState(null);
  const [lastRecommendation,setLastRecommendation] = useState(null);
  const [hectorHasNew,setHectorHasNew]       = useState(false);
  useEffect(()=>{
    if(!lastRecommendation) return;
    setHectorHasNew(true);
    const t = setTimeout(()=>setHectorHasNew(false), 5000);
    return ()=>clearTimeout(t);
  },[lastRecommendation]);
  useEffect(()=>{
    try{
      const today = fmt(new Date());
      const lastOpen = Number(localStorage.getItem("soulbaric.lastOpenTs")||0);
      const lastBriefing = localStorage.getItem("soulbaric.briefingMatinal.lastDate")||"";
      const sinceLastOpen = Date.now() - lastOpen;
      const fourH = 4*60*60*1000;
      if(lastBriefing!==today && sinceLastOpen>fourH){
        setShowBriefing(true);
      }
      localStorage.setItem("soulbaric.lastOpenTs", String(Date.now()));
    }catch{}
  },[]);
  useEffect(()=>{
    const evalClosing = ()=>{
      try{
        const today = fmt(new Date());
        const lastClosing = localStorage.getItem("soulbaric.cierreDia.lastDate")||"";
        if(lastClosing===today) return;
        if(new Date().getHours()<18) return;
        setShowClosing(true);
      }catch{}
    };
    evalClosing();
    window.addEventListener("focus", evalClosing);
    return ()=>window.removeEventListener("focus", evalClosing);
  },[]);
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
  // Cuando Supabase abre la app con un link de recovery, el hash trae
  // type=recovery + access_token y la SDK crea una sesión automáticamente.
  // Esa sesión "técnica" sirve para llamar a updateUser(password), pero NO
  // queremos que entre directo a la app — debe pasar por la pantalla de
  // "Crear nueva contraseña". Detectamos el modo al montar y lo limpiamos
  // tras el éxito (LoginScreen llama a history.replaceState).
  const [isRecoveryFlow,setIsRecoveryFlow] = useState(()=>{
    if(typeof window === "undefined") return false;
    const hash = window.location.hash || "";
    if(!hash) return false;
    const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    return params.get("type") === "recovery";
  });
  useEffect(()=>{
    if(!authEnabled()) return;
    let alive = true;
    getSession().then(s=>{ if(alive){ setAuthSession(s); setAuthReady(true); } });
    const unsub = onAuthStateChange(({session, event})=>{
      setAuthSession(session);
      // event "PASSWORD_RECOVERY" lo emite Supabase al detectar el hash de
      // recovery — refuerza la detección por si el hash ya se ha consumido.
      if(event === "PASSWORD_RECOVERY") setIsRecoveryFlow(true);
    });
    return ()=>{ alive = false; unsub(); };
  },[]);
  // Resuelve el miembro a partir del session.user (uid → fallback email).
  const authMemberInfo = authSession ? resolveSessionMember(authSession, data.members) : null;
  // Tras login, fijamos activeMember automáticamente y redirigimos:
  // admin → "dashboard", member → "mytasks". Ref evita re-disparar el
  // redirect cuando authMemberInfo cambia por re-render normal.
  const postLoginAppliedRef = useRef(false);
  useEffect(()=>{
    if(!authMemberInfo?.member){ postLoginAppliedRef.current = false; return; }
    setAM(authMemberInfo.member.id);
    if(!postLoginAppliedRef.current){
      postLoginAppliedRef.current = true;
      const isAdminNow = authMemberInfo.member.accountRole === "admin";
      setActiveTab("hector-direct");
    }
  },[authMemberInfo?.member?.id, authMemberInfo?.member?.accountRole]);
  const handleSignOut = async ()=>{
    await signOut();
    setAuthSession(null);
    try { localStorage.removeItem("taskflow_current_user"); } catch {}
  };
  // Si no eres admin y estás en un tab admin-only, te redirigimos a "mytasks".
  // Evita que un member acceda a vistas restringidas con la URL/atajos.
  // - ADMIN_ONLY_TABS: tabs reservados solo para admin (gestión de
  //   usuarios/permisos, planificador IA global). Sin via de acceso para
  //   non-admin aunque tengan algún permiso.
  // - TAB_REQUIRES_PERM: tabs gateados por permission flag. Si el miembro
  //   tiene permission "view" en ese feature, puede entrar; si no, redirect.
  const ADMIN_ONLY_TABS  = new Set(["planner","users","vault"]);
  const TAB_REQUIRES_PERM = {
    workspaces: "workspaces",
    dashboard:  "dashboard",
    briefings:  "briefings",
    memory:     "memory",
    finance:    "finance",
    gobernanza: "gobernanza",
  };
  useEffect(()=>{
    if(authReady && authSession && authMemberInfo?.member && !isAdmin){
      if(ADMIN_ONLY_TABS.has(activeTab)) { setActiveTab("mytasks"); return; }
      const reqFeature = TAB_REQUIRES_PERM[activeTab];
      if(reqFeature){
        const me = (data.members||[]).find(m=>m.id===activeMember);
        if(!hasPermission(me, reqFeature, "view", data.permissions)) setActiveTab("mytasks");
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[isAdmin, activeTab, authReady, authSession, data.permissions, activeMember]);
  const enableLegacyMode = ()=>{
    setLegacyMode(true);
    try { localStorage.setItem("soulbaric.legacyMode","1"); } catch {}
  };
  const [showUserModal,setShowUserModal] = useState(()=>!readStoredUser());
  const [userMenuOpen,setUserMenuOpen]   = useState(false);
  const [showCommandPalette,setShowCommandPalette] = useState(false);
  const [pendingWorkspaceId,setPendingWorkspaceId] = useState(null);
  const [sidebarCollapsed,setSidebarCollapsed] = useState(()=>{
    // Default explícito: si NO hay valor guardado (null) → expandido (false).
    // Solo respetamos la preferencia si fue escrita explícitamente por el
    // usuario al hacer toggle. Antes la lectura era `getItem(...) === "true"`,
    // que daba el mismo resultado pero ocultaba la intención y no diferenciaba
    // "nunca tocó" de "está expandido por preferencia". Si en el futuro
    // necesitamos lógica distinta por ramo, este split lo deja explícito.
    try{
      const stored = localStorage.getItem("soulbaric.sidebar.collapsed");
      return stored === null ? false : stored === "true";
    }catch{ return false; }
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
  // Tablero derivado: incluye tareas vinculadas desde otros proyectos cuyo
  // linkedProjects incluya este proyecto. Se mapean a la columna que
  // coincida por nombre con la columna primaria de la tarea; si no hay
  // match, van a la primera columna. Llevan flag _linkedFromAnotherProject
  // para que la TaskCard las muestre en gris y no draggables.
  const board = React.useMemo(()=>{
    const ownRaw = data.boards[proj.id] || [];
    if(!ownRaw.length) return ownRaw;
    // Filtra archivadas en TODAS las cols antes de calcular nada — el
    // kanban no debe mostrarlas. Aparecen solo en MyTasksView ▸ Archivadas.
    const own = ownRaw.map(col=>({...col, tasks: col.tasks.filter(t=>!t.archived)}));
    const linked = [];
    Object.entries(data.boards||{}).forEach(([pid,cols])=>{
      if(Number(pid)===proj.id) return;
      cols.forEach(col=>col.tasks.forEach(t=>{
        if(t.archived) return;
        if(Array.isArray(t.linkedProjects) && t.linkedProjects.includes(proj.id)){
          linked.push({task:t, primaryColName:col.name});
        }
      }));
    });
    if(!linked.length) return own;
    return own.map((col,idx)=>{
      const matched = linked
        .filter(({primaryColName})=>primaryColName===col.name)
        .map(({task})=>({...task, _linkedFromAnotherProject:true}));
      const orphan = idx===0
        ? linked
            .filter(({primaryColName})=>!own.some(c=>c.name===primaryColName))
            .map(({task})=>({...task, _linkedFromAnotherProject:true}))
        : [];
      return {...col, tasks:[...col.tasks, ...matched, ...orphan]};
    });
  },[data.boards, proj.id]);
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
      if(n.updatedAt) out.push({kind:"neg",id:n.id,title:n.title,code:n.code,ts:n.updatedAt,emoji:"💼"});
      (n.sessions||[]).forEach(s=>{
        if(s.updatedAt||s.date) out.push({kind:"sess",id:s.id,negId:n.id,title:`${getSessionTypeIcon(s.type)} ${n.title}`,code:n.code,subtitle:getSessionTypeLabel(s.type),ts:s.updatedAt||s.date,emoji:"📅"});
      });
    });
    Object.entries(data.boards||{}).forEach(([pid,cols])=>{
      cols.forEach(col=>col.tasks.forEach(t=>{
        const lastLog=(t.timeLogs||[]).slice(-1)[0];
        const ts = lastLog?.date || t.startDate;
        if(ts) out.push({kind:"task",id:t.id,projId:Number(pid),title:t.title,code:t.ref,ts,emoji:"📌"});
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

  // Gate centralizado: comprueba con canEditProject si el activeMember puede
  // mutar el proyecto cuyo id se pasa. Si no, dispara toast y devuelve false.
  // Lee de dataRef para evitar race con setData async. Toda mutación de
  // tareas con scope a un proyecto concreto debe pasar por aquí.
  const ensureCanEditProj = useCallback((projId)=>{
    const d = dataRef.current || data;
    const project = (d.projects||[]).find(p=>p.id===projId);
    const me = (d.members||[]).find(m=>m.id===activeMember);
    if (!canEditProject(me, project)) {
      addToast("No tienes permisos para modificar este proyecto","error");
      return false;
    }
    return true;
  },[activeMember, addToast, data]);

  const updateTask = useCallback((taskId,colId,updated)=>{
    if(!ensureCanEditProj(proj.id)) return;
    setData(prev=>{ const cols=prev.boards[proj.id].map(col=>col.id===colId?{...col,tasks:col.tasks.map(t=>t.id===taskId?updated:t)}:col); return{...prev,boards:{...prev.boards,[proj.id]:cols}}; });
  },[proj.id, ensureCanEditProj]);
  const updateTaskAnywhere = useCallback((taskId,updated)=>{
    setData(prev=>{ const newBoards={}; for(const pid in prev.boards){ newBoards[pid]=prev.boards[pid].map(col=>({...col,tasks:col.tasks.map(t=>t.id===taskId?updated:t)})); } return{...prev,boards:newBoards}; });
  },[]);
  const moveTask = useCallback((taskId,fromColId,toColId)=>{
    if(!ensureCanEditProj(proj.id)) return;
    setData(prev=>{ const cols=prev.boards[proj.id]; const fc=cols.find(c=>c.id===fromColId); const task=fc.tasks.find(t=>t.id===taskId); const nc=cols.map(col=>{ if(col.id===fromColId)return{...col,tasks:col.tasks.filter(t=>t.id!==taskId)}; if(col.id===toColId)return{...col,tasks:[...col.tasks,task]}; return col; }); return{...prev,boards:{...prev.boards,[proj.id]:nc}}; });
    addToast("Tarea movida","info");
  },[proj.id,addToast, ensureCanEditProj]);
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
  // Traspaso de proyecto principal: extrae la tarea del board de su proyecto
  // actual (sea cual sea), la inserta en el board del nuevo proyecto en una
  // columna que case por nombre con la actual (o la primera), recalcula
  // task.ref con el código del nuevo proyecto y empuja el proyecto antiguo
  // a linkedProjects (si no estaba ya). Idempotente respecto a linkedProjects.
  const transferTaskToProject = useCallback((taskId, newProjId)=>{
    setData(prev=>{
      // Localiza la tarea y su proyecto actual
      let oldPid = null;
      let task = null;
      let currentColName = null;
      for(const pid in prev.boards){
        const cols = prev.boards[pid];
        for(const col of cols){
          const t = col.tasks.find(x=>x.id===taskId);
          if(t){ oldPid = Number(pid); task = t; currentColName = col.name; break; }
        }
        if(task) break;
      }
      if(!task || oldPid===null) return prev;
      if(oldPid===newProjId) return prev;
      const newProj = (prev.projects||[]).find(p=>p.id===newProjId);
      if(!newProj){ return prev; }
      const destCols = prev.boards[newProjId] || [];
      if(destCols.length===0) return prev;
      const destCol = destCols.find(c=>c.name===currentColName) || destCols[0];
      // Recalcula ref si el nuevo proyecto tiene código válido
      const newRef = newProj.code ? computeNextTaskRef(newProj.code, destCols) : task.ref;
      // Asegura que el proyecto antiguo entra en linkedProjects (si no está)
      const oldLinked = Array.isArray(task.linkedProjects) ? task.linkedProjects : [];
      const nextLinked = oldLinked.filter(x=>x!==newProjId);
      if(!nextLinked.includes(oldPid)) nextLinked.push(oldPid);
      const movedTask = {...task, projectId:newProjId, ref:newRef, linkedProjects:nextLinked};
      // Quita del board origen
      const newOldBoard = prev.boards[oldPid].map(col=>({
        ...col,
        tasks: col.tasks.filter(t=>t.id!==taskId),
      }));
      // Inserta en el board destino en la col elegida
      const newDestBoard = destCols.map(col=>col.id===destCol.id
        ? {...col, tasks:[...col.tasks, movedTask]}
        : col);
      return {
        ...prev,
        boards: {
          ...prev.boards,
          [oldPid]: newOldBoard,
          [newProjId]: newDestBoard,
        },
      };
    });
    addToast("✓ Proyecto principal cambiado");
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
    if(!ensureCanEditProj(proj.id)) return;
    setData(prev=>{
      const projObj = prev.projects.find(p=>p.id===proj.id);
      const ref = projObj?.code ? computeNextTaskRef(projObj.code, prev.boards[proj.id]||[]) : null;
      const nt={id:"t"+nextId++,ref,title,tags:[],assignees:[activeMember],priority:"media",startDate:fmt(new Date()),dueDate:"",dueTime:"",estimatedHours:0,timeLogs:[],desc:"",comments:[]};
      const cols=prev.boards[proj.id].map(col=>col.id===colId?{...col,tasks:[...col.tasks,nt]}:col);
      return{...prev,boards:{...prev.boards,[proj.id]:cols}};
    });
    addToast("✓ Tarea creada");
  },[proj.id,activeMember,addToast, ensureCanEditProj]);
  const deleteTask = useCallback((taskId,colId)=>{
    if(!ensureCanEditProj(proj.id)) return;
    setData(prev=>{
      const cols = prev.boards[proj.id].map(col => col.id===colId
        ? {...col, tasks: col.tasks.filter(t => t.id!==taskId)}
        : col);
      return {...prev, boards:{...prev.boards, [proj.id]: cols}};
    });
    addToast("Tarea eliminada","info");
  },[proj.id,addToast, ensureCanEditProj]);
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
  // Archivado: la tarea se queda en su columna pero `archived:true` la
  // saca de TODAS las vistas activas (kanban, Sala de Mando, Mis Tareas
  // por defecto, Eisenhower, Time Reports, búsqueda, alertas, contexto
  // de Héctor). Solo aparece en MyTasksView con el filtro "Archivadas",
  // donde puede restaurarse vía unarchiveTaskAnywhere.
  const archiveTaskAnywhere = useCallback((taskId)=>{
    setData(prev=>{
      const newBoards = {};
      for(const pid in prev.boards){
        newBoards[pid] = prev.boards[pid].map(col => ({...col, tasks: col.tasks.map(t => t.id===taskId ? {...t, archived:true} : t)}));
      }
      return {...prev, boards: newBoards};
    });
    addToast("📦 Tarea archivada","info");
  },[addToast]);
  const unarchiveTaskAnywhere = useCallback((taskId)=>{
    setData(prev=>{
      const newBoards = {};
      for(const pid in prev.boards){
        newBoards[pid] = prev.boards[pid].map(col => ({...col, tasks: col.tasks.map(t => t.id===taskId ? {...t, archived:false} : t)}));
      }
      return {...prev, boards: newBoards};
    });
    addToast("↩ Tarea restaurada");
  },[addToast]);
  // Timeline de avance en tareas: cada entrada queda anexada al final.
  // Acepta tipos human / ai / milestone. ID generado si no viene.
  const addTimelineEntry = useCallback((taskId, entry)=>{
    const id = entry?.id || (typeof crypto!=="undefined" && crypto.randomUUID ? crypto.randomUUID() : `tl_${Date.now()}_${Math.random().toString(36).slice(2,8)}`);
    const ts = entry?.timestamp || new Date().toISOString();
    const e = {
      id,
      type: entry?.type==="ai" || entry?.type==="milestone" ? entry.type : "human",
      author: entry?.author || null,
      authorId: entry?.authorId ?? null,
      authorAvatar: entry?.authorAvatar || (entry?.type==="ai" ? "🧙" : "👤"),
      text: (entry?.text || "").trim(),
      timestamp: ts,
      isMilestone: !!entry?.isMilestone,
      relatedRecommendationId: entry?.relatedRecommendationId || null,
    };
    setData(prev=>{
      const newBoards = {};
      for(const pid in prev.boards){
        newBoards[pid] = prev.boards[pid].map(col=>({...col, tasks: col.tasks.map(t=>{
          if(t.id!==taskId) return t;
          const tl = Array.isArray(t.timeline) ? t.timeline : [];
          return {...t, timeline:[...tl, e]};
        })}));
      }
      return {...prev, boards: newBoards};
    });
  },[]);
  // Toggle milestone: marca/desmarca una entrada del timeline como hito.
  const toggleTimelineMilestone = useCallback((taskId, entryId)=>{
    setData(prev=>{
      const newBoards = {};
      for(const pid in prev.boards){
        newBoards[pid] = prev.boards[pid].map(col=>({...col, tasks: col.tasks.map(t=>{
          if(t.id!==taskId) return t;
          const tl = (t.timeline||[]).map(e=>e.id===entryId ? {...e, isMilestone:!e.isMilestone} : e);
          return {...t, timeline: tl};
        })}));
      }
      return {...prev, boards: newBoards};
    });
  },[]);
  // Permisos granulares: setMemberPermission cambia un flag (view/edit/
  // admin) para un miembro y un feature. Implica jerarquía: edit→view,
  // admin→edit→view (al activar admin, los inferiores quedan true).
  // Solo admin global debería poder llamarlo (gate en la UI).
  const setMemberPermission = useCallback((memberId, feature, level, value)=>{
    setData(prev=>{
      const perms = {...(prev.permissions||{})};
      const memberPerms = {...(perms[memberId]||{})};
      const featurePerms = {...(memberPerms[feature]||{view:false,edit:false,admin:false})};
      featurePerms[level] = !!value;
      // Implicaciones jerárquicas
      if(level==="edit"  && value) featurePerms.view = true;
      if(level==="admin" && value){ featurePerms.view = true; featurePerms.edit = true; }
      if(level==="view"  && !value){ featurePerms.edit = false; featurePerms.admin = false; }
      if(level==="edit"  && !value){ featurePerms.admin = false; }
      memberPerms[feature] = featurePerms;
      perms[memberId] = memberPerms;
      return {...prev, permissions: perms};
    });
    addToast("✓ Permisos actualizados");
  },[addToast]);
  // Gobernanza: setter genérico que merge un patch sobre data.governance.
  // El componente GobernanzaView usa onUpdateGovernance(patch) para mutar
  // companies / obligations / alerts sin tocar otras claves de data.
  const updateGovernance = useCallback((patch)=>{
    setData(prev=>({
      ...prev,
      governance: {
        companies:   patch.companies   ?? prev.governance?.companies   ?? [],
        obligations: patch.obligations ?? prev.governance?.obligations ?? [],
        alerts:      patch.alerts      ?? prev.governance?.alerts      ?? [],
        documents:   patch.documents   ?? prev.governance?.documents   ?? [],
      },
    }));
  },[]);
  // Migración de docs legacy base64 → bucket Supabase. Corre una sola vez
  // por sesión cuando hay docs legacy detectados. Procesa en serie con
  // tope de 10 por ejecución; si quedan más, la siguiente recarga termina
  // el trabajo. No bloquea la UI: arranca tras 3s para no competir con
  // el primer pintado.
  const migrationStartedRef = useRef(false);
  useEffect(()=>{
    if (migrationStartedRef.current) return;
    if (!storageEnabled() || !syncReady) return;
    const hasLegacy = (() => {
      const govDocs = data.governance?.documents || [];
      if (govDocs.some(d => d.fileUrl && d.fileUrl.startsWith?.("data:") && !d.storagePath)) return true;
      for (const sp of (data.vault?.spaces || [])) {
        if ((sp.documents || []).some(d => d.fileUrl && d.fileUrl.startsWith?.("data:") && !d.storagePath)) return true;
      }
      return false;
    })();
    if (!hasLegacy) return;
    migrationStartedRef.current = true;
    const t = setTimeout(async ()=>{
      try {
        const res = await migrateBase64DocsInData(dataRef.current, {
          maxPerRun: 10,
          onProgress: ({migrated, lastFile})=>{
            console.log(`[migrate] ${migrated} subido${migrated!==1?"s":""} (último: ${lastFile})`);
          },
        });
        if (res.migrated > 0) {
          setData(prev => ({
            ...prev,
            governance: res.nextData.governance,
            vault: res.nextData.vault,
          }));
          addToast(`📦 ${res.migrated} documento${res.migrated!==1?"s":""} migrado${res.migrated!==1?"s":""} a Supabase Storage${res.skipped>0?` (${res.skipped} pendientes para próxima sesión)`:""}`, "info", {ttl:6000});
        }
        if (res.errors > 0) {
          console.warn(`[migrate] ${res.errors} errores`);
        }
      } catch (e) {
        console.warn("[migrate] fallo:", e?.message);
      }
    }, 3000);
    return ()=>clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[syncReady]);

  // Vault: setter genérico que merge el patch sobre data.vault.
  const updateVault = useCallback((patch)=>{
    setData(prev=>({
      ...prev,
      vault: {
        spaces: patch.spaces ?? prev.vault?.spaces ?? [],
      },
    }));
  },[]);
  // Alertas de vencimiento del vault, computadas para Héctor. Mismo cálculo
  // que checkVaultAlerts de personalTemplates pero en App.jsx para no
  // tener que importar el módulo del vault desde aquí.
  const vaultAlertsForHector = React.useMemo(()=>{
    const out = [];
    const today = new Date();
    for (const sp of (data.vault?.spaces || [])){
      for (const d of (sp.documents || [])){
        if (!d.expiresAt || d.status !== "attached") continue;
        const days = Math.floor((new Date(d.expiresAt) - today) / 86400000);
        if (days < 0)         out.push({ type:"overdue", spaceName: sp.name, doc: d.name, days: Math.abs(days) });
        else if (days < 30)   out.push({ type:"urgent",  spaceName: sp.name, doc: d.name, days });
        else if (days < 90)   out.push({ type:"soon",    spaceName: sp.name, doc: d.name, days });
      }
    }
    return out;
  },[data.vault]);
  // Llamada directa a Gonzalo desde la sección Gobernanza ▸ tab Chat.
  // El componente pasa {messages, system?} y devuelve la respuesta del LLM.
  // Usa el promptBase de Gonzalo del agentes data + PLAIN_TEXT_RULE.
  //
  // NO está memoizado con useCallback a propósito: se invoca solo cuando
  // el CEO escribe en el chat (poco frecuente) y la memoización
  // capturaba `callAgentSafe` del primer render produciendo
  // ReferenceError ("callAgentSafe is not defined") en algunos edge
  // cases de bundling/HMR. Dejándolo como función plana, cada render
  // resuelve `callAgentSafe` y `dataRef.current` en tiempo real.
  const callGonzaloDirect = async ({messages, extraSystem, selectedCompanyId}={})=>{
    const gonzalo = (dataRef.current?.agents||[]).find(a=>a.name==="Gonzalo Gobernanza");
    if(!gonzalo) throw new Error("Gonzalo no está en agents");
    // Inyecta contexto vivo de gobernanza: empresas registradas + documentos
    // faltantes + alertas activas. Permite que Gonzalo razone sobre el
    // estado real sin que el usuario tenga que copiar/pegar nada.
    const gov = dataRef.current?.governance || {};
    const companies = gov.companies || [];
    const docs = gov.documents || [];
    const missing = docs.filter(d => d.required && (d.status === "pending" || d.status === "overdue"));
    const alerts = gov.alerts || [];
    let govContext = "";
    if (companies.length > 0 || missing.length > 0 || alerts.length > 0) {
      const lines = ["CONTEXTO VIVO DE GOBERNANZA:"];
      if (companies.length > 0) {
        lines.push(`Empresas registradas (${companies.length}):`);
        companies.slice(0, 8).forEach(c => lines.push(`  · ${c.name} [${c.type}]${c.cif ? ` ${c.cif}` : ""}`));
      }
      if (missing.length > 0) {
        lines.push(`\nDocumentos obligatorios pendientes (${missing.length}):`);
        const byCompany = {};
        for (const d of missing) {
          const cName = companies.find(c => c.id === d.companyId)?.name || "(sin empresa)";
          (byCompany[cName] ||= []).push(d.name);
        }
        Object.entries(byCompany).slice(0, 6).forEach(([name, list]) => {
          lines.push(`  · ${name}: ${list.slice(0,5).join(", ")}${list.length > 5 ? `, +${list.length - 5} más` : ""}`);
        });
      }
      if (alerts.length > 0) {
        const critical = alerts.filter(a => a.level === "critical").length;
        const warning  = alerts.filter(a => a.level === "warning").length;
        lines.push(`\nAlertas activas: ${critical} críticas, ${warning} warnings.`);
      }
      lines.push("\nSi el CEO te pregunta qué falta, sé concreto: cita las empresas y los documentos por nombre.");
      govContext = lines.join("\n");
    }
    // Resumen financiero vivo de la empresa relevante (o consolidado si no
    // se ha pasado selectedCompanyId). Permite a Gonzalo dar consejo
    // contextualizado tipo "el runway está en 2 meses, prioriza cobros".
    let finSummaryTxt = "";
    try {
      const summary = buildFinanceSummary(dataRef.current || {}, selectedCompanyId || "all");
      // Solo inyectamos si hay datos relevantes — evita ruido cuando no hay
      // ni cuentas ni movimientos ni facturas.
      const tieneDatos = summary.saldo !== 0 || summary.ingresosMes !== 0 || summary.gastosMes !== 0
        || summary.facturasPendientesCobro.count > 0 || summary.facturasPendientesPago.count > 0;
      if (tieneDatos) {
        finSummaryTxt = renderFinanceSummaryForPrompt(summary);
      }
    } catch (e) { /* helper puro: si falla, seguimos sin resumen */ }
    const system = (gonzalo.promptBase||`Eres Gonzalo, estratega de gobernanza empresarial.`)
      + "\n\n" + PLAIN_TEXT_RULE
      + (govContext ? `\n\n${govContext}` : "")
      + (finSummaryTxt ? `\n\n${finSummaryTxt}` : "")
      + (extraSystem ? `\n\n${extraSystem}` : "");
    // max_tokens 3000: Gonzalo puede emitir [ACTIONS] con proyecto + 10
    // tareas + negociación con stakeholders/facts. El JSON dentro del
    // bloque pasa fácilmente de 1500-2500 tokens; antes se truncaba y la
    // propuesta llegaba vacía o se perdía.
    // Timeout 45s: Gonzalo razona sobre estructura societaria + contexto
    // financiero, latencia típica 8-15s, margen 3x antes de abort.
    const out = await callAgentSafe({system, messages: messages||[], max_tokens: 3000}, {timeoutMs: 45000});
    return out;
  };
  // Diego: analista financiero operativo. Igual que callGonzaloDirect pero
  // inyecta CONTEXTO FINANCIERO (movimientos bancarios de los últimos 3
  // meses, top movs, no categorizados, agrupación por categoría, cuentas y
  // saldos). El contexto se trunca a ~3000 chars para no reventar el prompt.
  // El selectedCompanyId opcional filtra todo a una empresa concreta.
  const callDiegoDirect = async ({messages, extraSystem, selectedCompanyId, attachments}={})=>{
    const diego = (dataRef.current?.agents||[]).find(a=>a.name==="Diego");
    if(!diego) throw new Error("Diego no está en agents");
    const d = dataRef.current || {};
    const fmtEur = (n) => new Intl.NumberFormat("es-ES",{style:"currency",currency:"EUR",maximumFractionDigits:2}).format(Number(n)||0);
    const todayIso = new Date().toISOString().slice(0,10);
    const companies   = (d.governance?.companies)   || [];
    const allDocs     = (d.governance?.documents)   || [];
    const allAlerts   = (d.governance?.alerts)      || [];
    const allObligs   = (d.governance?.obligations) || [];
    const allMovs     = d.bankMovements || [];
    const allAccounts = d.bankAccounts || [];
    const allInvoices = d.invoices || [];
    const categories  = d.movementCategories || [];
    const filterId = selectedCompanyId || "all";
    const filtered = filterId !== "all";
    const company  = filtered ? companies.find(c => c.id === filterId) : null;
    // Filtros heredados (mismas reglas que la UI): legacy companyId:null
    // se incluye siempre para que el CEO pueda asignar luego.
    const movs = filtered ? allMovs.filter(m => !m.companyId || m.companyId === filterId) : allMovs;
    const accounts = filtered ? allAccounts.filter(a => a.companyId === filterId) : allAccounts;
    const invoices = filtered ? allInvoices.filter(i => !i.companyId || i.companyId === filterId) : allInvoices;
    // Recorte a últimos 3 meses si hay muchos movimientos. Si <200, todos.
    const dateLimit = new Date(); dateLimit.setMonth(dateLimit.getMonth()-3);
    const limitIso = dateLimit.toISOString().slice(0,10);
    const recent = movs.length > 200 ? movs.filter(m => (m.date||"") >= limitIso) : movs;
    const catName = (id) => categories.find(c=>c.id===id)?.name || id;
    const catPgc  = (id) => categories.find(c=>c.id===id)?.pgc || null;
    const accLabel = (id) => {
      const a = allAccounts.find(x=>x.id===id);
      return a ? `${a.bankName}${a.alias?` · ${a.alias}`:""}` : "(cuenta borrada)";
    };
    // ── Bloque 1: resumen ejecutivo via buildFinanceSummary ────────────
    // Reusa el mismo helper que consume el dashboard del CEO. Le da a
    // Diego la misma foto que ve el usuario: saldo, runway, fact pendientes,
    // IVA del trimestre, próxima obligación, alertas vivas.
    let summaryTxt = "";
    try {
      const summary = buildFinanceSummary(d, filterId);
      summaryTxt = renderFinanceSummaryForPrompt(summary);
    } catch (e) { /* helper puro: si falla seguimos sin summary */ }

    // ── Bloque 2: contexto de Gobernanza ───────────────────────────────
    // Empresas (lista compacta), documentos pendientes/vencidos de la
    // empresa filtrada, obligaciones próximas y alertas críticas/warning.
    const govLines = [];
    if (filtered && company) {
      govLines.push(`EMPRESA: ${company.name}${company.cif?` · CIF ${company.cif}`:""} · tipo ${company.type||"operativa"}${company.parentId?` · matriz ${companies.find(c=>c.id===company.parentId)?.name||"?"}`:""}`);
    } else {
      const compactList = companies.slice(0, 8).map(c => {
        const tag = c.type === "holding" ? "🏛️" : c.type === "patrimonial" ? "🏠" : c.type === "spv" ? "📦" : "⚙️";
        return `${tag} ${c.name}${c.cif?` (${c.cif})`:""}`;
      }).join(" · ");
      govLines.push(`GRUPO: ${companies.length} empresa${companies.length!==1?"s":""}${compactList?` — ${compactList}`:""}`);
    }
    // Documentos: filtrados por empresa cuando aplica. Compactamos a
    // accountable (no "not_applicable"). Mostramos hasta 12 con su estado.
    const docs = (filtered ? allDocs.filter(x => x.companyId === filterId) : allDocs)
      .filter(x => x.status !== "not_applicable");
    if (docs.length > 0) {
      const attached = docs.filter(x => x.status === "attached").length;
      const pending  = docs.filter(x => x.status === "pending").length;
      const overdue  = docs.filter(x => x.status === "overdue").length;
      govLines.push(`\nDOCUMENTOS (${attached} ✅ · ${pending} ❌ falta · ${overdue} 🔴 vencidos):`);
      // Priorizamos lo que requiere atención: overdue y pending requeridos primero.
      const importantes = [
        ...docs.filter(x => x.status === "overdue"),
        ...docs.filter(x => x.status === "pending" && x.required),
      ].slice(0, 12);
      for (const dx of importantes) {
        const icon = dx.status === "attached" ? "✅" : dx.status === "overdue" ? "🔴" : "❌";
        const due = dx.dueDate ? ` · vence ${dx.dueDate}` : "";
        govLines.push(`  · ${dx.name}: ${icon} ${dx.status}${due}`);
      }
      if (importantes.length === 0 && attached > 0) {
        govLines.push(`  · Toda la documentación obligatoria está adjuntada ✅`);
      }
    }
    // Obligaciones fiscales próximas (las 5 siguientes con dueDate >= hoy y no presentadas).
    const upcoming = allObligs
      .filter(o => o.status !== "filed" && o.dueDate && o.dueDate >= todayIso)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 5);
    if (upcoming.length > 0) {
      govLines.push(`\nOBLIGACIONES FISCALES PRÓXIMAS:`);
      for (const o of upcoming) {
        const days = Math.floor((new Date(o.dueDate) - new Date(todayIso)) / 86400000);
        govLines.push(`  · ${o.model || "(modelo)"} ${o.concept || ""}: vence ${o.dueDate} (en ${days}d)`);
      }
    }
    // Alertas vivas — críticas y warnings.
    const critAlerts = allAlerts.filter(a => a.level === "critical");
    const warnAlerts = allAlerts.filter(a => a.level === "warning");
    if (critAlerts.length > 0 || warnAlerts.length > 0) {
      govLines.push(`\nALERTAS GOBERNANZA: ${critAlerts.length} críticas · ${warnAlerts.length} warnings`);
      [...critAlerts, ...warnAlerts].slice(0, 4).forEach(a => {
        govLines.push(`  · ${a.level === "critical" ? "🔴" : "🟡"} ${a.title || a.message || "(sin título)"}`);
      });
    }
    const govCtx = govLines.length > 0 ? "CONTEXTO DE GOBERNANZA:\n" + govLines.join("\n") : "";

    // ── Bloque 3: detalle bancario operativo ───────────────────────────
    // Aquí Diego necesita los IDs reales para poder proponer
    // [ACTIONS]/update_bank_movement.
    const opLines = [];
    if (accounts.length > 0) {
      opLines.push(`CUENTAS BANCARIAS (${accounts.length}):`);
      accounts.slice(0, 8).forEach(a => opLines.push(`  · ${a.bankName}${a.alias?` · ${a.alias}`:""} → saldo ${fmtEur(a.currentBalance)}${a.iban?` · ${a.iban.slice(-4)}`:""}`));
    }
    // Rango temporal real del histórico (¡no del subconjunto recent!). Esto
    // evita que Diego diga "solo tengo desde febrero 2026": ve aquí desde
    // qué fecha hay datos y cuántos movimientos por año, y sabe que para
    // un mov antiguo concreto puede usar la BÚSQUEDA EN MOVIMIENTOS.
    if (movs.length > 0) {
      const dates = movs.map(m => m.date).filter(Boolean).sort();
      const oldest = dates[0];
      const newest = dates[dates.length - 1];
      const byYear = new Map();
      for (const m of movs) {
        const y = (m.date||"").slice(0, 4);
        if (!y) continue;
        byYear.set(y, (byYear.get(y)||0) + 1);
      }
      const yearStr = Array.from(byYear.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([y, c]) => `${y}: ${c}`)
        .join(" · ");
      opLines.push(`\nRANGO DE DATOS: ${movs.length} movimientos desde ${oldest} hasta ${newest}${yearStr?` · ${yearStr}`:""}`);
      opLines.push(`(El detalle inferior es solo de los últimos 3 meses. Para movimientos antiguos hay BÚSQUEDA EN MOVIMIENTOS abajo si la consulta menciona importe o concepto concreto.)`);
    }
    // Agrupación por categoría (para identificar concentraciones).
    const byCat = new Map();
    const uncategorized = [];
    for (const m of recent) {
      const key = m.category || "_uncat";
      const agg = byCat.get(key) || { count:0, total:0 };
      agg.count++; agg.total += Number(m.amount)||0;
      byCat.set(key, agg);
      if (!m.category) uncategorized.push(m);
    }
    if (byCat.size > 0) {
      opLines.push(`\nGASTO POR CATEGORÍA (${recent.length} movs últimos 3 meses):`);
      const sorted = Array.from(byCat.entries()).sort((a,b)=>Math.abs(b[1].total)-Math.abs(a[1].total)).slice(0,10);
      sorted.forEach(([k, v]) => {
        const label = k === "_uncat" ? "❓ SIN CATEGORIZAR" : `${catName(k)}${catPgc(k)?` (${catPgc(k)})`:""}`;
        opLines.push(`  · ${label}: ${v.count} movs · total ${fmtEur(v.total)}`);
      });
    }
    // Top 10 movimientos por importe absoluto — para que Diego pueda
    // priorizar análisis o proponer reclasificación de los grandes.
    const top = recent.slice().sort((a,b)=>Math.abs(Number(b.amount)||0) - Math.abs(Number(a.amount)||0)).slice(0,10);
    if (top.length > 0) {
      opLines.push(`\nTOP 10 MOVIMIENTOS POR IMPORTE:`);
      top.forEach(m => opLines.push(`  · [${m.id}] ${m.date} · ${(m.concept||"(sin concepto)").slice(0,50)} · ${fmtEur(m.amount)} · ${accLabel(m.accountId)}${m.category?` · ${catName(m.category)}`:" · ❓ sin cat"}`));
    }
    // Sin categorizar: TODOS hasta 30 (en vez de 20). Diego usa el id
    // real para emitir update_bank_movement en bloque.
    if (uncategorized.length > 0) {
      const showN = Math.min(uncategorized.length, 30);
      opLines.push(`\nMOVIMIENTOS SIN CATEGORIZAR (${uncategorized.length} totales · ${showN} mostrados — usa el id real en [ACTIONS]/update_bank_movement):`);
      uncategorized.slice(0, 30).forEach(m => opLines.push(`  · [${m.id}] ${m.date} · ${(m.concept||"(sin)").slice(0,60)} · ${fmtEur(m.amount)}`));
    }

    // ── Bloque 4: facturas pendientes detalladas ───────────────────────
    // Lista las pendientes y vencidas con días de retraso para que Diego
    // pueda proponer acciones de cobro/pago concretas. Limitado a 15.
    const facturasOpen = invoices.filter(i => i.status !== "pagada");
    const factLines = [];
    if (facturasOpen.length > 0) {
      const vencidas = facturasOpen.filter(i => i.dueDate && i.dueDate < todayIso);
      const pendientes = facturasOpen.filter(i => !(i.dueDate && i.dueDate < todayIso));
      factLines.push(`FACTURAS PENDIENTES: ${facturasOpen.length} (${vencidas.length} vencidas)`);
      const showList = [...vencidas, ...pendientes].slice(0, 15);
      for (const inv of showList) {
        const days = inv.dueDate ? Math.floor((new Date(todayIso) - new Date(inv.dueDate)) / 86400000) : null;
        const dayTag = days == null ? "" : days > 0 ? ` · 🔴 vencida hace ${days}d` : days < 0 ? ` · vence en ${-days}d` : ` · vence hoy`;
        const tipoTag = inv.type === "emitida" ? "📤" : "📥";
        const cp = inv.counterparty?.name || "(sin nombre)";
        factLines.push(`  · [${inv.id}] ${tipoTag} ${inv.number||"(sin nº)"} · ${cp.slice(0,40)} · ${fmtEur(inv.total)}${dayTag}`);
      }
    }
    const factCtx = factLines.length > 0 ? "FACTURAS:\n" + factLines.join("\n") : "";
    const opCtx = opLines.length > 0 ? "BANCARIO DETALLADO:\n" + opLines.join("\n") : "";

    // ── Bloque 5: contabilidad (asientos del libro diario) ─────────────
    // Resumen compacto (~500 chars max). Permite a Diego entender cuántos
    // asientos hay en la empresa, qué saldo agregado por grupo PGC se ha
    // generado, y si el último asiento está reciente o desactualizado.
    const allEntries = d.accountingEntries || [];
    const entries = filtered ? allEntries.filter(e => e.companyId === filterId) : allEntries;
    const cobLines = [];
    if (entries.length > 0) {
      const last = entries.slice().sort((a,b)=>(b.date||"").localeCompare(a.date||""))[0];
      const draft = entries.filter(e => e.status === "borrador").length;
      const groupSaldos = new Map(); // group → {debit,credit}
      for (const e of entries) {
        for (const l of (e.lines||[])) {
          const code = String(l.account||"");
          const grp = Number(code.charAt(0)) || 0;
          if (!grp) continue;
          const cur = groupSaldos.get(grp) || { debit: 0, credit: 0 };
          cur.debit  += Number(l.debit) ||0;
          cur.credit += Number(l.credit)||0;
          groupSaldos.set(grp, cur);
        }
      }
      cobLines.push(`CONTABILIDAD: ${entries.length} asiento${entries.length!==1?"s":""}${draft>0?` (${draft} en borrador)`:""} · último ${last?.date||"?"} (${last?.description?.slice(0,40)||"?"})`);
      const groupNames = { 1:"Financiación", 2:"Inmovilizado", 3:"Existencias", 4:"Acreed/Deud", 5:"Financieras", 6:"Compras/Gastos", 7:"Ventas/Ingresos" };
      const sortedGroups = Array.from(groupSaldos.entries()).sort((a,b)=>a[0]-b[0]);
      for (const [grp, v] of sortedGroups) {
        const saldo = v.debit - v.credit;
        cobLines.push(`  · G${grp} ${groupNames[grp]||""}: D ${fmtEur(v.debit)} · H ${fmtEur(v.credit)} · saldo ${fmtEur(saldo)}`);
      }
    } else if (filtered) {
      cobLines.push(`CONTABILIDAD: sin asientos para ${company?.name||"esta empresa"} todavía. Puedes proponer asientos vía add_accounting_entry.`);
    }
    let cobCtx = cobLines.length > 0 ? cobLines.join("\n") : "";
    if (cobCtx.length > 500) cobCtx = cobCtx.slice(0, 480) + "\n…(truncado)";

    // ── Bloque 6: BÚSQUEDA EN MOVIMIENTOS (dinámica) ──────────────────
    // Para que Diego pueda responder sobre movimientos antiguos sin que
    // entren TODOS en su contexto, extraemos del último mensaje del CEO
    // las pistas (importes ≥ 50€ y palabras clave > 4 letras) y buscamos
    // en TODO el histórico filtrado por empresa. Las coincidencias se
    // inyectan como bloque adicional, máx 20.
    //
    // Extracción de importes: regex que captura números con separadores
    // de miles/decimales en formato europeo y anglo. Filtra años (1900-
    // 2100) para no matchear "2024" como 2024€.
    const lastUserMsg = (messages||[]).slice().reverse().find(m => m.role === "user");
    const userText = (lastUserMsg && typeof lastUserMsg.content === "string") ? lastUserMsg.content : "";
    const extractAmounts = (text) => {
      if (!text) return [];
      const out = [];
      const re = /\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?\b|\b\d+(?:[.,]\d{1,2})\b|\b\d+\b/g;
      const matches = text.match(re) || [];
      for (const raw of matches) {
        const lc = raw.lastIndexOf(","), ld = raw.lastIndexOf(".");
        let s = raw;
        if (lc > -1 && ld > -1) {
          if (lc > ld) s = s.replace(/\./g, "").replace(",", ".");
          else         s = s.replace(/,/g, "");
        } else if (lc > -1) {
          // si los chars tras la coma son ≤2 → decimal europeo; si son 3 → miles
          const tail = raw.length - lc - 1;
          s = tail <= 2 ? s.replace(",", ".") : s.replace(/,/g, "");
        }
        const n = Number(s);
        if (isNaN(n) || Math.abs(n) < 50) continue;
        // Descartamos años puros (4 dígitos enteros entre 1900 y 2100).
        if (/^\d{4}$/.test(raw) && n >= 1900 && n <= 2100) continue;
        out.push(Math.abs(n));
      }
      return Array.from(new Set(out));
    };
    const STOPWORDS = new Set([
      "sobre","desde","hasta","como","cuál","cual","cuándo","cuando","dónde","donde","quién","quien",
      "están","estos","estas","tienen","tengo","tiene","tienes","alguna","algun","algún","todo","toda",
      "todos","todas","mucho","mucha","mismo","misma","entre","aquellos","aquellas","aquel","aquella",
      "mediante","aunque","porque","factura","facturas","movimiento","movimientos","cuenta","cuentas",
      "banco","bancos","tenemos","cuanto","cuánto","cuanta","cuánta","cuantos","cuántos","sobre","puedes",
      "podemos","quería","quiero","quieres","necesito","necesita","necesitamos","menciona","mencionar",
    ]);
    const extractKeywords = (text) => {
      if (!text) return [];
      const lower = text.toLowerCase();
      const words = lower.split(/[^\p{L}\d]+/u).filter(Boolean);
      const out = [];
      for (const w of words) {
        if (w.length < 5) continue;
        if (STOPWORDS.has(w)) continue;
        if (/^\d+$/.test(w)) continue;
        out.push(w);
      }
      return Array.from(new Set(out)).slice(0, 8);
    };
    const amounts = extractAmounts(userText);
    const keywords = extractKeywords(userText);
    const searchLines = [];
    if ((amounts.length > 0 || keywords.length > 0) && movs.length > 0) {
      const matches = [];
      const seen = new Set();
      for (const m of movs) {
        if (seen.has(m.id)) continue;
        const amt = Math.abs(Number(m.amount)||0);
        const concept = (m.concept||"").toLowerCase();
        const matchAmount  = amounts.length  > 0 && amounts.some(a => Math.abs(amt - a) <= 1);
        const matchConcept = keywords.length > 0 && keywords.some(k => concept.includes(k));
        if (matchAmount || matchConcept) {
          matches.push({ ...m, _matchAmount: matchAmount, _matchConcept: matchConcept });
          seen.add(m.id);
          if (matches.length >= 20) break;
        }
      }
      if (matches.length > 0) {
        const tagsHints = [];
        if (amounts.length  > 0) tagsHints.push(`importes ${amounts.map(a=>fmtEur(a)).join(", ")}`);
        if (keywords.length > 0) tagsHints.push(`palabras "${keywords.join('", "')}"`);
        searchLines.push(`BÚSQUEDA EN MOVIMIENTOS: ${matches.length} coincidencia${matches.length!==1?"s":""} en el histórico completo (filtros: ${tagsHints.join(" · ")}):`);
        for (const m of matches) {
          const tag = m._matchAmount && m._matchConcept ? "💯" : m._matchAmount ? "💶" : "🔤";
          searchLines.push(`  · ${tag} [${m.id}] ${m.date} · ${(m.concept||"(sin concepto)").slice(0,60)} · ${fmtEur(m.amount)} · ${accLabel(m.accountId)}${m.category?` · ${catName(m.category)}`:" · ❓ sin cat"}`);
        }
      }
    }
    const searchCtx = searchLines.length > 0 ? searchLines.join("\n") : "";

    // Composición final con cap defensivo a ~7000 chars (summary +
    // gobernanza + bancario + búsqueda + facturas + contabilidad). El
    // bloque BÚSQUEDA va justo después de BANCARIO DETALLADO porque
    // amplía precisamente ese subconjunto con el histórico relevante.
    const blocks = [summaryTxt, govCtx, opCtx, searchCtx, factCtx, cobCtx].filter(Boolean);
    let finCtx = blocks.join("\n\n");
    if (finCtx.length > 7000) finCtx = finCtx.slice(0, 6980) + "\n…(truncado)";
    const system = (diego.promptBase||`Eres Diego, analista financiero senior.`)
      + "\n\n" + PLAIN_TEXT_RULE
      + (finCtx ? `\n\n${finCtx}` : "")
      + (extraSystem ? `\n\n${extraSystem}` : "");
    // Si el caller pasa attachments (PDF/imagen en base64), los reenviamos
    // tal cual al endpoint /api/agent → injectAttachments los convierte en
    // content blocks multimodales del último mensaje user. Diego procesa
    // el documento real, no solo el nombre. Sin attachments el flujo es
    // idéntico al anterior.
    const callBody = { system, messages: messages||[], max_tokens: 4096 };
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (hasAttachments) callBody.attachments = attachments;
    // Timeout: 45s normal · 90s si Diego procesa PDF/imagen (Anthropic
    // necesita más tiempo para parsing nativo de documentos grandes).
    const timeoutMs = hasAttachments ? 90000 : 45000;
    const out = await callAgentSafe(callBody, { timeoutMs });
    return out;
  };
  // Setter dedicado para permisos de agentes IA. Toggle binario por
  // (memberId, agentKey). Llamado desde la PermissionsTable (columna
  // "Agentes"). El admin global no necesita esto.
  const setMemberAgentPermission = useCallback((memberId, agentKey, value)=>{
    setData(prev=>{
      const perms = {...(prev.permissions||{})};
      const memberPerms = {...(perms[memberId]||{})};
      const agentPerms = {...(memberPerms.agents||{mario:false,jorge:false,alvaro:false,gonzalo:false})};
      agentPerms[agentKey] = !!value;
      memberPerms.agents = agentPerms;
      perms[memberId] = memberPerms;
      return {...prev, permissions: perms};
    });
    addToast("✓ Permisos actualizados");
  },[addToast]);
  // Finanzas: CRUD de movimientos. ID con crypto.randomUUID si está
  // disponible (browser moderno) o fallback con Date.now+random.
  const _newFinanceId = ()=> (typeof crypto!=="undefined" && crypto.randomUUID) ? crypto.randomUUID() : `fin_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const addFinanceMovement = useCallback((payload)=>{
    const now = new Date().toISOString();
    const movement = {
      id: _newFinanceId(),
      type: payload.type==="income" ? "income" : "expense",
      concept: (payload.concept||"").trim(),
      amount: Math.max(0, Number(payload.amount)||0),
      date: payload.date || fmt(new Date()),
      category: payload.category || "Otros",
      // Fase 2: companyId opcional (legacy = null = "Sin asignar")
      companyId: payload.companyId || null,
      projectId: payload.projectId || null,
      paymentMethod: payload.paymentMethod || "transfer",
      status: payload.status || "paid",
      notes: (payload.notes||"").trim(),
      createdBy: activeMember,
      createdAt: now,
      updatedAt: now,
    };
    setData(prev=>({...prev, financeMovements:[movement, ...(prev.financeMovements||[])]}));
    addToast(`✓ ${movement.type==="income"?"Entrada":"Salida"} registrada`);
  },[activeMember, addToast]);
  // Cuentas bancarias (Fase 2). companyId obligatorio — apunta a
  // governance.companies. Las cuentas no se borran si tienen movimientos
  // asociados; en su lugar se marcan inactivas (isActive:false).
  const addBankAccount = useCallback((payload)=>{
    const now = new Date().toISOString();
    const account = {
      id: _newFinanceId(),
      companyId: payload.companyId || null,
      bankName: (payload.bankName||"").trim(),
      iban: (payload.iban||"").trim().replace(/\s+/g,"").toUpperCase(),
      alias: (payload.alias||"").trim(),
      currentBalance: Number(payload.currentBalance)||0,
      isActive: payload.isActive !== false,
      createdAt: now,
      updatedAt: now,
    };
    setData(prev=>({...prev, bankAccounts:[account, ...(prev.bankAccounts||[])]}));
    addToast("✓ Cuenta bancaria añadida");
  },[addToast]);
  const updateBankAccount = useCallback((id, patch)=>{
    setData(prev=>({
      ...prev,
      bankAccounts: (prev.bankAccounts||[]).map(a=>a.id===id ? {...a, ...patch, updatedAt:new Date().toISOString()} : a),
    }));
    addToast("✓ Cuenta actualizada");
  },[addToast]);
  const deleteBankAccount = useCallback((id)=>{
    setData(prev=>{
      const hasMovs = (prev.bankMovements||[]).some(m => m.accountId === id);
      if (hasMovs) {
        // Conservamos el histórico — solo desactivamos para que no aparezca
        // en selectores activos. El admin puede reactivar luego.
        return {
          ...prev,
          bankAccounts: (prev.bankAccounts||[]).map(a=>a.id===id ? {...a, isActive:false, updatedAt:new Date().toISOString()} : a),
        };
      }
      return { ...prev, bankAccounts: (prev.bankAccounts||[]).filter(a=>a.id!==id) };
    });
    addToast("Cuenta eliminada o desactivada","info");
  },[addToast]);
  // Movimientos bancarios. companyId se hereda de la cuenta si no viene
  // explícito en payload (caso del modal manual). amount es signed: + para
  // ingresos, − para gastos. balance es opcional (si lo trae el extracto
  // bancario se mantiene; si lo añade el usuario manual se calcula a partir
  // de saldo previo de la cuenta + delta).
  const addBankMovement = useCallback((payload)=>{
    setData(prev=>{
      const account = (prev.bankAccounts||[]).find(a => a.id === payload.accountId);
      const companyId = payload.companyId || account?.companyId || null;
      const now = new Date().toISOString();
      const movement = {
        id: _newFinanceId(),
        accountId: payload.accountId,
        companyId,
        date: payload.date || fmt(new Date()),
        valueDate: payload.valueDate || payload.date || fmt(new Date()),
        concept: (payload.concept||"").trim(),
        amount: Number(payload.amount) || 0,
        balance: typeof payload.balance === "number" ? payload.balance : null,
        category: payload.category || null,
        subcategory: payload.subcategory || null,
        invoiceId: payload.invoiceId || null,
        reconciled: !!payload.reconciled,
        notes: (payload.notes||"").trim(),
        importedFrom: payload.importedFrom || "manual",
        importBatchId: payload.importBatchId || null,
        createdBy: activeMember,
        createdAt: now,
        updatedAt: now,
      };
      // Si fue manual y no traía balance explícito, actualizamos el saldo
      // current de la cuenta sumando el amount. Si vino de import con
      // balance ya calculado por el banco, no tocamos currentBalance —
      // la conciliación se hace contra el balance importado.
      let nextAccounts = prev.bankAccounts || [];
      if (movement.importedFrom === "manual" && account) {
        nextAccounts = nextAccounts.map(a => a.id === account.id
          ? { ...a, currentBalance: (Number(a.currentBalance)||0) + movement.amount, updatedAt: now }
          : a);
      }
      return {
        ...prev,
        bankMovements: [movement, ...(prev.bankMovements||[])],
        bankAccounts: nextAccounts,
      };
    });
    addToast("✓ Movimiento bancario registrado");
  },[activeMember, addToast]);
  const updateBankMovement = useCallback((id, patch)=>{
    setData(prev=>({
      ...prev,
      bankMovements: (prev.bankMovements||[]).map(m=>m.id===id ? {...m, ...patch, updatedAt:new Date().toISOString()} : m),
    }));
    addToast("✓ Movimiento actualizado");
  },[addToast]);
  const deleteBankMovement = useCallback((id)=>{
    setData(prev=>{
      const mov = (prev.bankMovements||[]).find(m => m.id === id);
      let nextAccounts = prev.bankAccounts || [];
      // Si era manual, revertimos el saldo de la cuenta. Importados no
      // tocan currentBalance porque ese se reconcilia contra el banco.
      if (mov && mov.importedFrom === "manual" && mov.accountId) {
        nextAccounts = nextAccounts.map(a => a.id === mov.accountId
          ? { ...a, currentBalance: (Number(a.currentBalance)||0) - (Number(mov.amount)||0), updatedAt: new Date().toISOString() }
          : a);
      }
      return {
        ...prev,
        bankMovements: (prev.bankMovements||[]).filter(m=>m.id!==id),
        bankAccounts: nextAccounts,
      };
    });
    addToast("Movimiento eliminado","info");
  },[addToast]);
  // Importación de extractos: añade N movimientos en un único setData para
  // que Supabase persista una sola vez. Los movimientos importados no tocan
  // currentBalance (se reconcilian contra el balance del banco).
  const addBankMovementsBatch = useCallback((payloads)=>{
    if (!Array.isArray(payloads) || payloads.length === 0) return;
    setData(prev=>{
      const now = new Date().toISOString();
      const newMovements = payloads.map(payload => {
        const account = (prev.bankAccounts||[]).find(a => a.id === payload.accountId);
        const companyId = payload.companyId || account?.companyId || null;
        return {
          id: _newFinanceId(),
          accountId: payload.accountId,
          companyId,
          date: payload.date || fmt(new Date()),
          valueDate: payload.valueDate || payload.date || fmt(new Date()),
          concept: (payload.concept||"").trim(),
          amount: Number(payload.amount) || 0,
          balance: typeof payload.balance === "number" ? payload.balance : null,
          category: payload.category || null,
          subcategory: payload.subcategory || null,
          invoiceId: payload.invoiceId || null,
          reconciled: !!payload.reconciled,
          notes: (payload.notes||"").trim(),
          importedFrom: payload.importedFrom || "excel",
          importBatchId: payload.importBatchId || null,
          createdBy: activeMember,
          createdAt: now,
          updatedAt: now,
        };
      });
      return { ...prev, bankMovements: [...newMovements, ...(prev.bankMovements||[])] };
    });
    addToast(`✓ ${payloads.length} movimiento${payloads.length!==1?"s":""} importado${payloads.length!==1?"s":""}`);
  },[activeMember, addToast]);
  // Deshace una importación entera por batchId. No revierte saldos (los
  // importados no tocaban currentBalance).
  const deleteBankMovementsByBatch = useCallback((batchId)=>{
    if (!batchId) return;
    setData(prev=>({
      ...prev,
      bankMovements: (prev.bankMovements||[]).filter(m => m.importBatchId !== batchId),
    }));
    addToast("Importación deshecha","info");
  },[addToast]);
  // Facturación (Commit 5): CRUD de facturas emitidas/recibidas.
  // Numeración auto-correlativa YYYY/NNN por (companyId, type, year). Si el
  // CEO pasa un `number` explícito (recibida con número del proveedor) se
  // respeta. vatQuarter se calcula desde `date`.
  const _quarterFromDate = (iso) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const q = Math.floor(d.getMonth()/3) + 1;
    return `${q}T-${d.getFullYear()}`;
  };
  const _calcInvoiceTotals = (lines, irpfRate) => {
    let subtotal = 0, vatAmount = 0;
    for (const l of (lines||[])) {
      const qty = Number(l.quantity)||0;
      const price = Number(l.unitPrice)||0;
      const rate = Number(l.vatRate)||0;
      const base = qty * price;
      subtotal += base;
      vatAmount += base * rate / 100;
    }
    const irpfAmount = subtotal * (Number(irpfRate)||0) / 100;
    const total = subtotal + vatAmount - irpfAmount;
    return {
      subtotal: Math.round(subtotal*100)/100,
      vatAmount: Math.round(vatAmount*100)/100,
      irpfAmount: Math.round(irpfAmount*100)/100,
      total: Math.round(total*100)/100,
    };
  };
  const _nextInvoiceNumber = (invoices, companyId, type, year) => {
    const prefix = `${year}/`;
    let max = 0;
    for (const inv of (invoices||[])) {
      if (inv.companyId !== companyId) continue;
      if (inv.type !== type) continue;
      if (!String(inv.number||"").startsWith(prefix)) continue;
      const n = parseInt(String(inv.number).slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return `${prefix}${String(max+1).padStart(3,"0")}`;
  };
  const addInvoice = useCallback((payload)=>{
    // Generamos el id ANTES del setData para devolverlo síncronamente.
    // setData(updater) es async — el closure se ejecuta en el render
    // siguiente, después del return. Sin esto, los callers (executor de
    // agentActions) reciben undefined y no pueden encadenar acciones.
    const newId = _newFinanceId();
    setData(prev=>{
      const now = new Date().toISOString();
      const date = payload.date || fmt(new Date());
      const year = new Date(date).getFullYear();
      const totals = _calcInvoiceTotals(payload.lines, payload.irpfRate);
      const invoice = {
        id: newId,
        companyId: payload.companyId || null,
        type: payload.type === "recibida" ? "recibida" : "emitida",
        number: payload.number?.trim() || _nextInvoiceNumber(prev.invoices, payload.companyId, payload.type === "recibida" ? "recibida" : "emitida", year),
        date,
        dueDate: payload.dueDate || null,
        counterparty: {
          name: (payload.counterparty?.name||"").trim(),
          cif:  (payload.counterparty?.cif||"").trim(),
          address: (payload.counterparty?.address||"").trim(),
        },
        lines: (payload.lines||[]).map(l => ({
          description: (l.description||"").trim(),
          quantity: Number(l.quantity)||0,
          unitPrice: Number(l.unitPrice)||0,
          vatRate: Number(l.vatRate)||0,
        })),
        subtotal: totals.subtotal,
        vatAmount: totals.vatAmount,
        irpfRate: Number(payload.irpfRate)||0,
        irpfAmount: totals.irpfAmount,
        total: totals.total,
        status: payload.status || "pendiente",
        paidAmount: Number(payload.paidAmount)||0,
        paidDate: payload.paidDate || null,
        bankMovementId: payload.bankMovementId || null,
        notes: (payload.notes||"").trim(),
        vatQuarter: _quarterFromDate(date),
        createdAt: now,
        createdBy: activeMember,
        updatedAt: now,
      };
      return {...prev, invoices:[invoice, ...(prev.invoices||[])]};
    });
    addToast("✓ Factura creada");
    return newId;
  },[activeMember, addToast]);
  const updateInvoice = useCallback((id, patch)=>{
    setData(prev=>{
      const list = (prev.invoices||[]).map(inv => {
        if (inv.id !== id) return inv;
        const merged = {...inv, ...patch, updatedAt: new Date().toISOString()};
        // Si se han cambiado líneas, fecha o irpfRate, recalculamos totales
        // y vatQuarter para que el dato derivado nunca quede desincronizado.
        if (patch.lines || patch.irpfRate !== undefined) {
          const t = _calcInvoiceTotals(merged.lines, merged.irpfRate);
          merged.subtotal = t.subtotal;
          merged.vatAmount = t.vatAmount;
          merged.irpfAmount = t.irpfAmount;
          merged.total = t.total;
        }
        if (patch.date) {
          merged.vatQuarter = _quarterFromDate(merged.date);
        }
        return merged;
      });
      return {...prev, invoices: list};
    });
    addToast("✓ Factura actualizada");
  },[addToast]);
  const deleteInvoice = useCallback((id)=>{
    setData(prev=>({...prev, invoices: (prev.invoices||[]).filter(i=>i.id!==id)}));
    addToast("Factura eliminada","info");
  },[addToast]);
  // Contabilidad: CRUD de asientos del libro diario y plan de cuentas.
  // Reglas estrictas:
  //   1) cada asiento debe cuadrar (sum debit === sum credit, ±0.01€).
  //   2) la numeración es correlativa por (companyId, year).
  //   3) solo se borran asientos en estado "borrador" (los confirmados son
  //      históricos y se modifican con un asiento de regularización).
  const _nextEntryNumber = (entries, companyId, year) => {
    let max = 0;
    for (const e of (entries||[])) {
      if (e.companyId !== companyId) continue;
      const eYear = new Date(e.date).getFullYear();
      if (eYear !== year) continue;
      const n = Number(e.number)||0;
      if (n > max) max = n;
    }
    return max + 1;
  };
  const _normalizeEntryLines = (lines) => {
    return (Array.isArray(lines)?lines:[]).map(l => ({
      account: String(l.account||"").trim(),
      accountName: String(l.accountName||"").trim(),
      debit:  Math.round((Number(l.debit) ||0)*100)/100,
      credit: Math.round((Number(l.credit)||0)*100)/100,
    }));
  };
  const _entryBalances = (lines) => {
    let totalD = 0, totalC = 0;
    for (const l of (lines||[])) { totalD += Number(l.debit)||0; totalC += Number(l.credit)||0; }
    return { totalD: Math.round(totalD*100)/100, totalC: Math.round(totalC*100)/100, diff: Math.abs(totalD-totalC) };
  };
  const addAccountingEntry = useCallback((payload)=>{
    if (!payload || !payload.companyId) {
      addToast("Selecciona una empresa antes de crear el asiento","warn");
      return null;
    }
    const lines = _normalizeEntryLines(payload.lines);
    if (lines.length < 2) {
      addToast("El asiento necesita al menos 2 líneas","warn");
      return null;
    }
    const { totalD, totalC, diff } = _entryBalances(lines);
    if (diff > 0.011) {
      addToast(`Asiento descuadrado: debe ${totalD} ≠ haber ${totalC}`,"warn");
      return null;
    }
    // Detección de duplicados: rechazamos si ya existe un asiento de la
    // misma empresa con fecha ±1 día, mismo total (debe o haber, ±0.01€)
    // y descripción similar (primeros 30 chars en minúsculas, substring
    // match). Cubre el caso típico de doble click en "Crear todo" o de
    // Diego proponiendo el mismo asiento dos veces tras un fallo de red.
    const desiredDesc = (payload.description||"").trim().toLowerCase().slice(0, 30);
    const desiredDate = payload.date || fmt(new Date());
    const existingEntries = dataRef.current?.accountingEntries || [];
    const dayMs = 86400000;
    const refTime = new Date(desiredDate).getTime();
    const dup = existingEntries.find(e => {
      if (e.companyId !== payload.companyId) return false;
      const eTime = new Date(e.date).getTime();
      if (isNaN(eTime) || isNaN(refTime)) return false;
      if (Math.abs(eTime - refTime) > dayMs) return false;
      const eBalances = _entryBalances(e.lines || []);
      // Tolerancia 0.01€ porque los importes redondeados pueden no
      // coincidir bit a bit, pero sí ser el mismo movimiento real.
      if (Math.abs(eBalances.totalD - totalD) > 0.011) return false;
      const eDesc = (e.description||"").toLowerCase().slice(0, 30);
      if (!desiredDesc || !eDesc) return false;
      return eDesc.includes(desiredDesc) || desiredDesc.includes(eDesc);
    });
    if (dup) {
      const fmtImporte = new Intl.NumberFormat("es-ES",{style:"currency",currency:"EUR",maximumFractionDigits:2}).format(totalD);
      addToast(`⚠️ Ya existe un asiento similar del ${dup.date} por ${fmtImporte}. No se ha creado.`,"warn",{ttl:5000});
      return null;
    }
    // Generamos el id ANTES del setData para devolverlo síncronamente.
    // Antes el id se asignaba dentro del updater (closure), que se ejecuta
    // en el render siguiente — el return ya había devuelto null y los
    // callers (agentActions executor) caían siempre al path de error
    // aunque el asiento sí se hubiera creado.
    const newId = _newFinanceId();
    setData(prev=>{
      const now = new Date().toISOString();
      const date = payload.date || fmt(new Date());
      const year = new Date(date).getFullYear();
      const entry = {
        id: newId,
        companyId: payload.companyId,
        date,
        number: payload.number || _nextEntryNumber(prev.accountingEntries, payload.companyId, year),
        description: (payload.description||"").trim(),
        lines,
        source: payload.source || "manual",
        invoiceId: payload.invoiceId || null,
        bankMovementId: payload.bankMovementId || null,
        status: payload.status === "borrador" ? "borrador" : "confirmado",
        createdBy: activeMember,
        createdAt: now,
        updatedAt: now,
      };
      return { ...prev, accountingEntries: [entry, ...(prev.accountingEntries||[])] };
    });
    addToast("✓ Asiento contable creado");
    return newId;
  },[activeMember, addToast]);
  const updateAccountingEntry = useCallback((id, patch)=>{
    setData(prev=>{
      const list = (prev.accountingEntries||[]).map(e => {
        if (e.id !== id) return e;
        const merged = { ...e, ...patch, updatedAt: new Date().toISOString() };
        if (patch.lines) {
          merged.lines = _normalizeEntryLines(patch.lines);
          // Bloqueamos el guardado si descuadra; mantenemos el estado anterior.
          const { diff } = _entryBalances(merged.lines);
          if (diff > 0.011) {
            console.warn("[contabilidad] update bloqueado: asiento descuadrado", e.id);
            return e;
          }
        }
        return merged;
      });
      return { ...prev, accountingEntries: list };
    });
    addToast("✓ Asiento actualizado");
  },[addToast]);
  const deleteAccountingEntry = useCallback((id)=>{
    // Antes solo permitíamos borrar borradores. La convención contable
    // recomendaba rectificar con un asiento de regularización en vez de
    // borrar — pero la realidad operativa del CEO es que muchos asientos
    // de Diego se crean como "confirmado" por defecto y luego hay que
    // poder borrarlos al revisar. Permitimos borrar cualquier estado;
    // la confirmación dura ahora vive en la UI (Contabilidad.jsx).
    console.log("[deleteAccountingEntry] eliminado id:", id);
    setData(prev=>({
      ...prev,
      accountingEntries: (prev.accountingEntries||[]).filter(x => x.id !== id),
    }));
    addToast("Asiento eliminado","info");
  },[addToast]);
  const addCustomAccount = useCallback((account)=>{
    if (!account || !account.code || !account.name) return;
    const code = String(account.code).trim();
    const group = Number(account.group) || Number(String(code).charAt(0)) || 9;
    setData(prev=>{
      const exists = (prev.chartOfAccounts||[]).some(a => a.code === code);
      if (exists) return prev;
      return { ...prev, chartOfAccounts: [...(prev.chartOfAccounts||[]), { code, name: String(account.name).trim(), group }] };
    });
    addToast(`✓ Cuenta ${code} añadida al plan`);
  },[addToast]);
  // Conciliación bulk (Commit 6). Aplica una lista de matches
  // [{movementId, invoiceId}] en un único setData: marca el movimiento
  // como reconciled, vincula bankMovementId en la factura, y si la factura
  // estaba pendiente la pasa a "pagada" con fecha = fecha del movimiento.
  const reconcileMatches = useCallback((matches)=>{
    if (!Array.isArray(matches) || matches.length === 0) return;
    setData(prev=>{
      const now = new Date().toISOString();
      const movsById = new Map((prev.bankMovements||[]).map(m => [m.id, m]));
      const movsToReconcile = new Set();
      const invPatch = new Map(); // id → patch
      for (const match of matches) {
        const m = movsById.get(match.movementId);
        if (!m) continue;
        movsToReconcile.add(match.movementId);
        const inv = (prev.invoices||[]).find(i => i.id === match.invoiceId);
        if (!inv) continue;
        const patch = { bankMovementId: match.movementId, updatedAt: now };
        if (inv.status !== "pagada") {
          patch.status = "pagada";
          patch.paidDate = m.date || now.slice(0,10);
          patch.paidAmount = Number(inv.total)||0;
        }
        invPatch.set(inv.id, patch);
      }
      return {
        ...prev,
        bankMovements: (prev.bankMovements||[]).map(m =>
          movsToReconcile.has(m.id) ? { ...m, reconciled: true, updatedAt: now } : m
        ),
        invoices: (prev.invoices||[]).map(inv =>
          invPatch.has(inv.id) ? { ...inv, ...invPatch.get(inv.id) } : inv
        ),
      };
    });
    addToast(`✓ ${matches.length} conciliación${matches.length!==1?"es":""} aplicada${matches.length!==1?"s":""}`);
  },[addToast]);
  const updateFinanceMovement = useCallback((id, patch)=>{
    setData(prev=>({
      ...prev,
      financeMovements: (prev.financeMovements||[]).map(m=>m.id===id ? {...m, ...patch, updatedAt:new Date().toISOString()} : m),
    }));
    addToast("✓ Movimiento actualizado");
  },[addToast]);
  const deleteFinanceMovement = useCallback((id)=>{
    setData(prev=>({
      ...prev,
      financeMovements: (prev.financeMovements||[]).filter(m=>m.id!==id),
    }));
    addToast("Movimiento eliminado","info");
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
  // Gate centralizado: comprueba con canEditDeal si el activeMember puede
  // mutar la negociación cuyo id se pasa. Si no, dispara toast y devuelve
  // false. Lee de dataRef para evitar race con setData async.
  const ensureCanEditDeal = useCallback((negId)=>{
    const d = dataRef.current || data;
    const deal = (d.negotiations||[]).find(n=>n.id===negId);
    const me = (d.members||[]).find(m=>m.id===activeMember);
    if (!canEditDeal(me, deal)) {
      addToast("No tienes permisos para editar esta negociación","error");
      return false;
    }
    return true;
  },[activeMember, addToast, data]);

  const createNegotiation = useCallback((payload)=>{
    const id=_uid("neg"); const now=new Date().toISOString();
    setData(prev=>{
      const code = nextSeqCode(NEG_CODE_PREFIX, prev.negotiations||[]);
      const me = (prev.members||[]).find(m=>m.id===activeMember);
      const isAdminMe = me?.accountRole === "admin";
      // Para non-admin forzamos al creador como ownerId (no permitimos
      // crear deals "en nombre de otro" porque el modelo de permisos
      // requiere que el ownerId sea quien tiene control). Admin global
      // puede mantener el ownerId que venga del modal (selector libre).
      const finalOwnerId = isAdminMe && payload.ownerId != null ? payload.ownerId : activeMember;
      const baseMembers = Array.isArray(payload.members) ? payload.members : [];
      const finalMembers = baseMembers.includes(activeMember) ? baseMembers : [activeMember, ...baseMembers];
      return{...prev,negotiations:[...(prev.negotiations||[]),{
        id,code,...payload,
        ownerId:    finalOwnerId,
        createdBy:  activeMember,
        createdAt:  now,
        updatedAt:  now,
        visibility: payload.visibility || "private",
        members:    finalMembers,
        sessions:   [],
      }]};
    });
    addToast("✓ Negociación creada");
  },[addToast, activeMember]);
  const updateNegotiation = useCallback((negId,patch)=>{
    if(!ensureCanEditDeal(negId)) return;
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,...patch,updatedAt:new Date().toISOString()}:n)}));
    addToast("✓ Negociación actualizada");
    // Si el patch trae result (cierre con learnings), dispara extracción
    // de lecciones fire-and-forget. dataRef nos da la versión recién
    // actualizada de la negociación con todo el contexto (sesiones,
    // sponsors, etc.) sin esperar al re-render de React.
    if(patch?.result){
      (async()=>{
        try {
          const updatedNeg = (dataRef.current?.negotiations||[]).find(n=>n.id===negId);
          if(!updatedNeg) return;
          const { lessons } = await extractLessonsFromNegotiation(updatedNeg);
          if(!lessons || lessons.length===0){
            console.log("[memory] sin lecciones extraídas del cierre");
            return;
          }
          // Persiste cada lesson como item de ceoMemory.lessons con
          // metadata de origen (negotiationId, outcome, type, applicableTo).
          const cur = dataRef.current?.ceoMemory || emptyCeoMemory();
          let lessonsList = cur.lessons || [];
          let added = 0;
          const newItems = [];
          for(const l of lessons){
            const text = l.applicableTo
              ? `[${l.type}] ${l.content} — aplica a: ${l.applicableTo}`
              : `[${l.type}] ${l.content}`;
            const res = addUnique(lessonsList, text, "negotiation-result");
            if(res.added){
              added++;
              const item = res.list[res.list.length-1];
              item.lessonType    = l.type;
              item.applicableTo  = l.applicableTo;
              item.negotiationId = negId;
              item.negotiationTitle = updatedNeg.title;
              item.outcome       = updatedNeg.result?.outcome;
              newItems.push(item);
            }
            lessonsList = res.list;
          }
          if(added>0){
            const next = {...cur, lessons: lessonsList, updatedAt: new Date().toISOString()};
            dataRef.current = {...dataRef.current, ceoMemory: next};
            setData(prev=>({...prev, ceoMemory: next}));
            addToast(`🧠 ${added} lección${added!==1?"es":""} extraída${added!==1?"s":""} de la negociación`,"info",{ttl:5000,onClick:()=>setActiveTab("memory")});
          }
        } catch(e){
          console.warn("[memory] error extrayendo lecciones:", e);
        }
      })();
    }
  },[addToast, ensureCanEditDeal]);
  const deleteNegotiation = useCallback((negId)=>{
    if(!ensureCanEditDeal(negId)) return;
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).filter(n=>n.id!==negId)}));
    addToast("Negociación eliminada","info");
  },[addToast, ensureCanEditDeal]);
  const addSession = useCallback((negId,payload)=>{
    if(!ensureCanEditDeal(negId)) return;
    const id=_uid("sess"); const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,sessions:[...(n.sessions||[]),{id,...payload,entries:[],summary:"",createdAt:now,updatedAt:now}],updatedAt:now}:n)}));
    addToast("✓ Sesión añadida");
  },[addToast, ensureCanEditDeal]);
  const updateSession = useCallback((negId,sessId,patch)=>{
    if(!ensureCanEditDeal(negId)) return;
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,sessions:n.sessions.map(s=>s.id===sessId?{...s,...patch,updatedAt:now}:s),updatedAt:now}:n)}));
  },[ensureCanEditDeal]);
  const deleteSession = useCallback((negId,sessId)=>{
    if(!ensureCanEditDeal(negId)) return;
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,sessions:n.sessions.filter(s=>s.id!==sessId),updatedAt:new Date().toISOString()}:n)}));
    addToast("Sesión eliminada","info");
  },[addToast, ensureCanEditDeal]);
  const addNote = useCallback((negId,sessId,payload)=>{
    if(!ensureCanEditDeal(negId)) return;
    const id=_uid("ent"); const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,updatedAt:now,sessions:n.sessions.map(s=>s.id===sessId?{...s,entries:[...(s.entries||[]),{id,type:"manual_note",authorId:activeMember,createdAt:now,...payload}],updatedAt:now}:s)}:n)}));
  },[activeMember, ensureCanEditDeal]);
  const updateNote = useCallback((negId,sessId,noteId,patch)=>{
    if(!ensureCanEditDeal(negId)) return;
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,updatedAt:now,sessions:n.sessions.map(s=>s.id===sessId?{...s,entries:s.entries.map(e=>e.id===noteId?{...e,...patch}:e),updatedAt:now}:s)}:n)}));
  },[ensureCanEditDeal]);
  const deleteNote = useCallback((negId,sessId,noteId)=>{
    if(!ensureCanEditDeal(negId)) return;
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,updatedAt:now,sessions:n.sessions.map(s=>s.id===sessId?{...s,entries:s.entries.filter(e=>e.id!==noteId),updatedAt:now}:s)}:n)}));
  },[ensureCanEditDeal]);
  const updateSummary = useCallback((negId,sessId,summary)=>{
    if(!ensureCanEditDeal(negId)) return;
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,updatedAt:now,sessions:n.sessions.map(s=>s.id===sessId?{...s,summary,updatedAt:now}:s)}:n)}));
  },[ensureCanEditDeal]);
  const setNegBriefing = useCallback((negId,briefing)=>{
    if(!ensureCanEditDeal(negId)) return;
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,briefing,updatedAt:now}:n)}));
    addToast("✓ Briefing guardado en la negociación");
  },[addToast, ensureCanEditDeal]);
  const setNegDocuments = useCallback((negId,documents)=>{
    if(!ensureCanEditDeal(negId)) return;
    const now=new Date().toISOString();
    setData(prev=>({...prev,negotiations:(prev.negotiations||[]).map(n=>n.id===negId?{...n,documents,updatedAt:now}:n)}));
  },[ensureCanEditDeal]);
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
        const projObj = prev.projects.find(p=>p.id===projId);
        const ref = projObj?.code ? computeNextTaskRef(projObj.code, boardsOut[projId]||[]) : null;
        const refs=[
          {id:_uid("rf"),type:"negotiation",targetId:negId,context:`Generada desde "${(prev.negotiations||[]).find(n=>n.id===negId)?.title||""}"`,createdAt:now},
          {id:_uid("rf"),type:"session",targetId:sessId,negotiationId:negId,context:"Acordado en sesión",createdAt:now},
        ];
        const newTask={id,ref,title:t.title.trim(),tags:[],assignees:[t.assignee],priority:t.priority||"media",startDate:fmt(new Date()),dueDate:t.dueDate||"",estimatedHours:0,timeLogs:[],desc:"",comments:[],subtasks:[],links:[],agentIds:[],refs,negotiationId:negId,sessionId:sessId};
        boardsOut[projId] = cols.map(col=>col.id===targetCol.id?{...col,tasks:[...col.tasks,newTask]}:col);
      }
      const newNegs=(prev.negotiations||[]).map(n=>n.id===negId?{...n,relatedTaskIds:[...(n.relatedTaskIds||[]),...newIds],updatedAt:now}:n);
      return {...prev,boards:boardsOut,negotiations:newNegs};
    });
    addToast(`✓ ${tasks.length} tarea${tasks.length!==1?"s":""} creada${tasks.length!==1?"s":""}`);
  },[addToast]);

  const createProject = useCallback(({name,desc,color,emoji,code,members:mems,columns,workspaceId,visibility})=>{
    const id=nextProjId++;
    const cols=columns.map(n=>({id:`nc${nextColId++}`,name:n,tasks:[]}));
    // Calculamos safeCode SÍNCRONAMENTE leyendo dataRef.current. Antes el
    // cálculo vivía dentro de setData (closure) y no podía devolverse al
    // caller — por eso agentActions guardaba en results el code que él
    // CALCULÓ ("HE5"), no el que createProject realmente acabó guardando
    // si tenía que regenerarlo ("HEM"). Esa divergencia hacía que pass-2
    // no encontrase el proyecto al ejecutar create_tasks/create_negotiation.
    const existingProjects = dataRef.current?.projects || [];
    const safeCode = isValidProjectCode(code) && !existingProjects.some(p=>p.code===code)
      ? code
      : autoProjectCode(name, existingProjects.map(p=>p.code).filter(Boolean));
    setData(prev=>{
      // El creador es siempre miembro y owner del proyecto. Visibility por
      // defecto "private": solo lo ven él y los miembros invitados.
      const memsWithCreator = Array.isArray(mems) && mems.includes(activeMember)
        ? mems
        : [...(Array.isArray(mems) ? mems : []), activeMember];
      return{...prev,projects:[...prev.projects,{
        id,name,desc,color,emoji,code:safeCode,
        members: memsWithCreator,
        workspaceId: workspaceId??null,
        ownerId: activeMember,
        createdBy: activeMember,
        createdAt: new Date().toISOString(),
        visibility: visibility || "private",
      }],boards:{...prev.boards,[id]:cols}};
    });
    addToast("✓ Proyecto creado");
    // Devolvemos {id, code} para que agentActions empuje a results el code
    // REAL guardado, no el que envió. Anteriormente devolvía solo `id`;
    // los únicos callers son ProjectModal (no usa el retorno) y agentActions.
    return { id, code: safeCode };
  },[addToast, activeMember]);

  // Versión "directa" de addTask que opera sobre cualquier proyecto por
  // id (no contra el proj activo). Pensada para flujos de ejecución de
  // agentes IA donde el proyecto puede haber sido creado en la misma
  // tanda. Coloca la tarea en la primera columna del board.
  const addTaskToProject = useCallback((projId, payload)=>{
    setData(prev=>{
      const cols = prev.boards[projId];
      if (!cols || cols.length === 0) return prev;
      const targetCol = cols[0]; // "Por hacer"
      const projObj = prev.projects.find(p => p.id === projId);
      const ref = projObj?.code ? computeNextTaskRef(projObj.code, cols) : null;
      const id = "t" + nextId++;
      const newTask = {
        id, ref,
        title: payload.title || "Tarea sin título",
        tags: Array.isArray(payload.tags) ? payload.tags : [],
        assignees: Array.isArray(payload.assignees) ? payload.assignees : [],
        priority: payload.priority || "media",
        startDate: fmt(new Date()),
        dueDate: payload.dueDate || "",
        dueTime: "",
        estimatedHours: 0,
        timeLogs: [],
        desc: payload.desc || "",
        comments: [],
        timeline: Array.isArray(payload.timeline) ? payload.timeline : [],
        projectId: projId,
        linkedProjects: [], links: [], agentIds: [], refs: [], documents: [],
        archived: false,
      };
      const newCols = cols.map(c => c.id === targetCol.id ? {...c, tasks: [...c.tasks, newTask]} : c);
      return { ...prev, boards: { ...prev.boards, [projId]: newCols } };
    });
  },[]);

  // Orchestrator de acciones propuestas por agentes. Se pasa como prop al
  // chat (HectorPanel, GobernanzaView, etc) y delega en agentActions.js
  // que mapea cada acción a la función de mutación adecuada.
  // Devuelve {results} para que el caller muestre toasts.
  const runAgentActions = useCallback(async (selectedActions, opts={})=>{
    const { executeAgentActions } = await import("./lib/agentActions.js");
    const d = dataRef.current || data;
    const adminMemberId = (d.members||[]).find(m=>m.accountRole==="admin")?.id ?? activeMember;
    // Two-pass: primero create_project (obtenemos ids), después create_tasks/etc.
    // Para acciones que requieren findProjectByCode, leemos dataRef tras el flush.
    // Empresa filtrada — el caller (Diego) la pasa explícita en `opts`. Como
    // fallback leemos `localStorage` para callers que aún no la pasen
    // (Gobernanza no la necesita: Gonzalo no propone acciones financieras).
    let defaultCompanyId = (opts && typeof opts.defaultCompanyId === "string" && opts.defaultCompanyId !== "all")
      ? opts.defaultCompanyId : null;
    if (!defaultCompanyId) {
      try {
        const saved = localStorage.getItem("finanzas_selectedCompany");
        if (saved && saved !== "all") defaultCompanyId = saved;
      } catch {}
    }
    const helpers = {
      data: d,
      adminMemberId,
      allMembers: d.members || [],
      createProject,
      addTaskToProject,
      createNegotiation,
      addFinanceMovement,
      addBankMovement,
      updateBankMovement,
      addAccountingEntry,
      addInvoice,
      updateInvoice,
      defaultCompanyId,
      addToast,
      findProjectByCode: (code) => (dataRef.current?.projects || []).find(p => p.code === code),
    };
    // Pasada 1: crear proyectos. Esto encola setData. Esperamos al flush
    // con un microtask antes de meter las tareas.
    const projectActions = selectedActions.filter(a => a.type === "create_project");
    const otherActions   = selectedActions.filter(a => a.type !== "create_project");

    const results1 = executeAgentActions(projectActions, helpers);
    // Retry escalonado para que setData de createProject haga commit y
    // dataRef tenga el proyecto antes de que pass-2 (create_tasks /
    // create_negotiation con linkedProjectCode) llame findProjectByCode.
    // En la mayoría de casos 50ms basta, pero con DevTools abiertas o
    // renders pesados el flush tarda más — reintentamos a 50/100/200ms
    // hasta encontrar TODOS los proyectos esperados. Si tras ~350ms
    // siguen sin estar disponibles, continuamos: el lookup individual
    // en pass-2 reportará error como antes (no empeora nada).
    const expectedCodes = results1
      .filter(r => r.type === "project" && r.code)
      .map(r => r.code);
    for (const ms of [50, 100, 200]) {
      await new Promise(r => setTimeout(r, ms));
      const allFound = expectedCodes.every(code =>
        (dataRef.current?.projects || []).some(p => p.code === code)
      );
      if (allFound) break;
    }

    // Para cada proyecto recién creado, ejecutamos sus tareas pendientes.
    for (const r of results1) {
      if (r.type === "project" && r.code && Array.isArray(r.pendingTasks) && r.pendingTasks.length > 0) {
        const proj = (dataRef.current?.projects || []).find(p => p.code === r.code);
        if (proj) {
          for (const task of r.pendingTasks) {
            const { resolveDueDate, resolveAssignees } = await import("./lib/agentActions.js");
            const memberIds = resolveAssignees(task.assignees || ["admin"], dataRef.current?.members || [], adminMemberId);
            // Si la acción tenía assignees a nivel proyecto y la tarea no
            // los tiene, heredamos del proyecto.
            const finalAssignees = memberIds.length > 0 ? memberIds : (r.assignees || [adminMemberId]);
            addTaskToProject(proj.id, {
              title: task.title,
              desc: task.description || "",
              priority: task.priority || "media",
              dueDate: resolveDueDate(task.dueDate),
              assignees: finalAssignees,
              tags: (task.tags || []).map(l => ({ l, c: "purple" })),
              timeline: [{
                id: `tl_agent_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
                type: "ai", author: r._agentName || "Agente IA", authorId: null, authorAvatar: "🤖",
                text: "Tarea creada automáticamente como parte del plan propuesto.",
                timestamp: new Date().toISOString(), isMilestone: false,
              }],
            });
          }
        }
      }
    }
    // Pasada 2: resto de acciones (negotiation, create_tasks sobre code existente, movement)
    const results2 = executeAgentActions(otherActions, helpers);
    return { results: [...results1, ...results2] };
  },[createProject, addTaskToProject, createNegotiation, addFinanceMovement, addBankMovement, updateBankMovement, addAccountingEntry, addInvoice, updateInvoice, addToast, activeMember, data]);
  const editProject = useCallback((idx,{name,desc,color,emoji,code,members:mems,columns,workspaceId,visibility})=>{
    setData(prev=>{
      const p=prev.projects[idx];
      // Solo aceptamos cambio de código si es válido y no colisiona con
      // otro proyecto distinto. En caso contrario, mantenemos el actual.
      const codeIsFree = isValidProjectCode(code) && !prev.projects.some((x,i)=>i!==idx && x.code===code);
      const finalCode = codeIsFree ? code : p.code;
      const finalVisibility = (visibility==="private"||visibility==="team"||visibility==="public") ? visibility : p.visibility;
      const projects=prev.projects.map((x,i)=>i===idx?{...x,name,desc,color,emoji,code:finalCode,codeAuto:finalCode===p.code?x.codeAuto:false,members:mems,workspaceId:workspaceId??null,visibility:finalVisibility}:x);
      const existing=prev.boards[p.id]||[];
      const existNames=existing.map(c=>c.name);
      const newCols=columns.filter(n=>!existNames.includes(n)).map(n=>({id:`nc${nextColId++}`,name:n,tasks:[]}));
      const merged=[...existing.filter(c=>columns.includes(c.name)),...newCols];
      return{...prev,projects,boards:{...prev.boards,[p.id]:merged.length>0?merged:existing}};
    });
    addToast("✓ Proyecto actualizado");
  },[addToast]);
  // Transferencia de propiedad del proyecto. Solo dispara si el caller ya
  // ha confirmado en UI; no validamos aquí porque la única ruta que llama
  // aquí es ProjectModal con isOwner=true. Asegura que el nuevo owner sea
  // miembro (auto-añade si no estaba) para no dejar el proyecto en estado
  // inconsistente.
  const transferProjectOwnership = useCallback((projId, newOwnerId)=>{
    setData(prev=>({
      ...prev,
      projects: prev.projects.map(p=>{
        if(p.id!==projId) return p;
        const ms = Array.isArray(p.members) ? p.members : [];
        const nextMembers = ms.includes(newOwnerId) ? ms : [...ms, newOwnerId];
        return {...p, ownerId:newOwnerId, members:nextMembers};
      }),
    }));
    addToast("✓ Propiedad transferida","success");
  },[addToast]);
  // Transferencia de propiedad de la negociación. Mismo patrón que en
  // proyectos: el caller (NegotiationModal) ya gateó por isOwner/isAdmin
  // en UI, así que aquí solo aseguramos integridad (nuevo owner pasa a
  // members[] si no estaba) y actualizamos updatedAt.
  const transferNegotiationOwnership = useCallback((negId, newOwnerId)=>{
    setData(prev=>({
      ...prev,
      negotiations: (prev.negotiations||[]).map(n=>{
        if(n.id!==negId) return n;
        const ms = Array.isArray(n.members) ? n.members : [];
        const nextMembers = ms.includes(newOwnerId) ? ms : [...ms, newOwnerId];
        return {...n, ownerId:newOwnerId, members:nextMembers, updatedAt:new Date().toISOString()};
      }),
    }));
    addToast("✓ Propiedad transferida","success");
  },[addToast]);
  const createWorkspace = useCallback((payload)=>{
    const id=nextWsId++;
    setData(prev=>{
      const code = nextSeqCode(WS_CODE_PREFIX, prev.workspaces||[]);
      return{...prev,workspaces:[...(prev.workspaces||[]),{id,code,...payload,createdAt:fmt(new Date())}]};
    });
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

  // Acceso invitado: si la URL es /vault/:token, salimos antes que el
  // auth-gate de SoulBaric. El invitado solo necesita el PIN del space,
  // no tiene cuenta en SoulBaric. Así un familiar abre su vault desde
  // un link en WhatsApp sin tener que registrarse.
  if(guestVaultToken){
    return <VaultGuestView token={guestVaultToken} data={data} onUpdateVault={updateVault}/>;
  }

  // Auth gate: cuando Supabase Auth está disponible y el usuario no está
  // en modo demo, mostramos LoginScreen hasta que tenga sesión válida con
  // email que case con un member. Si la sesión existe pero el email no
  // está autorizado, mostramos panel "no autorizado" con opción de salir.
  if(authEnabled() && !legacyMode){
    if(!authReady){
      return <div style={{position:"fixed",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,color:"#6B7280"}}>Cargando…</div>;
    }
    if(!authSession || isRecoveryFlow){
      return <LoginScreen onAuthed={s=>{ setAuthSession(s); setIsRecoveryFlow(false); }} onLegacySkip={enableLegacyMode} forceRecovery={isRecoveryFlow} onRecoveryDone={()=>setIsRecoveryFlow(false)}/>;
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
  const me = (data.members||[]).find(m=>m.id===activeMember);
  return(
    <PresenceProvider currentUser={me}>
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
                canDelete={isAdmin}
                projects={data.projects}
                onNavigateProject={pid=>{const i=data.projects.findIndex(x=>x.id===pid); if(i>=0){setAP(i);setActiveTab("board");}}}
                onTransferProject={newPid=>{ transferTaskToProject(t.id, newPid); setOverlayTaskId(null); }}
                onAddTimelineEntry={(taskId,entry)=>addTimelineEntry(taskId,{...entry,authorId:entry.authorId??activeMember,author:entry.author||(data.members.find(m=>m.id===activeMember)?.name)})}
                onToggleMilestone={toggleTimelineMilestone}
                onClose={()=>setOverlayTaskId(null)}
                onUpdate={(id,_cid,upd)=>updateTaskAnywhere(id,upd)}
                onMove={(id,from,to)=>{moveTaskAnywhere(id,from,to);setOverlayTaskId(null);}}
                onDelete={(id)=>deleteTaskAnywhere(id)}
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
          {id:"hector-direct", icon:"🧙", label:"Héctor",       shortcut:"",    onClick:()=>{setActiveTab("hector-direct");}, adminOnly:false},
          {id:"command",    icon:"🎯", label:"Sala de Mando",shortcut:"",    onClick:()=>{setActiveTab("command");}, adminOnly:false},
          {id:"home",       icon:"🏠", label:"Home",         shortcut:"⌘⇧H", onClick:()=>{setActiveTab("home");}, adminOnly:false},
          {id:"dealroom",   icon:"🤝", label:"Deal Room",    shortcut:"⌘⇧D", onClick:()=>{setActiveTab("dealroom");setActiveNegId(null);setActiveSessId(null);}, adminOnly:false},
          {id:"mytasks",    icon:"✅", label:"Mis tareas",   shortcut:"⌘⇧T", onClick:()=>{setActiveTab("mytasks");}, adminOnly:false},
          {id:"projects",   icon:"📁", label:"Proyectos",    shortcut:"⌘⇧P", onClick:()=>{setActiveTab("projects");}, adminOnly:false},
          {id:"finance",    icon:"💰", label:"Finanzas",     shortcut:"",    onClick:()=>{setActiveTab("finance");}, adminOnly:false, requiresPermission:"finance"},
          {id:"workspaces", icon:"🏢", label:"Workspaces",   shortcut:"⌘⇧W", onClick:()=>{setActiveTab("workspaces");}, adminOnly:false, requiresPermission:"workspaces"},
          {id:"dashboard",  icon:"📊", label:"Dashboard analítico", shortcut:"⌘⇧A", onClick:()=>{setActiveTab("dashboard");}, adminOnly:false, requiresPermission:"dashboard"},
          {id:"briefings",  icon:"🧠", label:"Briefings IA", shortcut:"⌘⇧B", onClick:()=>{setActiveTab("briefings");}, adminOnly:false, requiresPermission:"briefings"},
          {id:"memory",     icon:"🧩", label:"Memoria",      shortcut:"⌘⇧M", onClick:()=>{setActiveTab("memory");}, adminOnly:false, requiresPermission:"memory"},
          {id:"gobernanza", icon:"🏛️", label:"Gobernanza",   shortcut:"⌘⇧G", onClick:()=>{setActiveTab("gobernanza");}, adminOnly:false, requiresPermission:"gobernanza"},
          {id:"vault",      icon:"🔐", label:"Vault Personal", shortcut:"⌘⇧V", onClick:()=>{setActiveTab("vault");}, adminOnly:true},
          {id:"users",      icon:"👥", label:"Usuarios",     shortcut:"⌘⇧U", onClick:()=>{setActiveTab("users");}, adminOnly:true},
        ];
        // Filtrado del sidebar: admin global ve todo. Para no-admins:
        // - adminOnly:true → oculto.
        // - requiresPermission:"<feature>" → visible solo si el miembro
        //   tiene al menos permission "view" en ese feature.
        const myMember = (data.members||[]).find(m=>m.id===activeMember);
        const PRIMARY = ALL_PRIMARY.filter(it=>{
          if(isAdmin) return true;
          if(it.adminOnly) return false;
          if(it.requiresPermission && !hasPermission(myMember, it.requiresPermission, "view", data.permissions)) return false;
          return true;
        });
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
                      <div key={`${it.kind}-${it.id}`} onClick={onClick} title={`${it.code?it.code+" · ":""}${it.title}`} style={{display:"flex",alignItems:"center",gap:7,padding:"6px 10px",borderRadius:7,cursor:"pointer",fontSize:12,color:"#4b5563",marginBottom:1}} onMouseEnter={e=>{e.currentTarget.style.background="#F9FAFB";}} onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}>
                        <span style={{fontSize:12,flexShrink:0}}>{it.emoji}</span>
                        <RefBadge code={it.code}/>
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
      <div data-tf="main-content" data-tf-tab={activeTab} style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
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

          {/* Cerrar sesión (solo cuando hay sesión Supabase activa) */}
          {authSession && (
            <button onClick={handleSignOut} title="Cerrar sesión" className="tf-no-print"
              style={{display:"flex",alignItems:"center",gap:6,padding:"7px 12px",borderRadius:20,background:"#fff",color:"#B91C1C",border:"0.5px solid #FCA5A5",fontSize:13,cursor:"pointer",fontFamily:"inherit",flexShrink:0}}
              onMouseEnter={e=>e.currentTarget.style.background="#FEF2F2"}
              onMouseLeave={e=>e.currentTarget.style.background="#fff"}>
              <span style={{fontSize:13}}>🚪</span>
              <span className="tf-search-label">Salir</span>
            </button>
          )}

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
          <div data-tf-bar="project-header" style={{background:"#fff",borderBottom:"0.5px solid #e5e7eb",padding:"0 20px",height:52,display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:16}}>{proj.emoji||"📋"}</span>
              <span style={{fontSize:15,fontWeight:600}}>{proj.name}</span>
              <RefBadge code={proj.code}/>
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
          <div data-tf-bar="project-tabs" style={{display:"flex",borderBottom:"0.5px solid #e5e7eb",background:"#fff",padding:"0 20px",flexShrink:0,overflowX:"auto"}}>
            {TABS.map(tab=><div key={tab.key} onClick={()=>setActiveTab(tab.key)} style={{padding:"10px 14px",fontSize:13,cursor:"pointer",borderBottom:activeTab===tab.key?"2px solid #7F77DD":"2px solid transparent",color:activeTab===tab.key?"#7F77DD":"#6b7280",fontWeight:activeTab===tab.key?500:400,marginBottom:-0.5,whiteSpace:"nowrap"}}>{tab.l}</div>)}
          </div>
        )}
        {activeTab==="board"&&<DailyDigest boards={data.boards} members={data.members} activeMemberId={activeMember}/>}
        <div style={{flex:1,overflow:"auto"}}>
          {activeTab==="home"      &&<HomeView data={data} activeMember={activeMember} critMineCount={critCount} alertMineCount={alerts.filter(a=>a.memberId===activeMember).length} onNavigate={id=>{setActiveTab(id);if(id==="dealroom"){setActiveNegId(null);setActiveSessId(null);}}} onToast={addToast} onOpenTask={id=>setOverlayTaskId(id)}/>}
          {activeTab==="mytasks"   &&<MyTasksView data={data} activeMember={activeMember} onOpenTask={id=>setOverlayTaskId(id)} onNavigate={id=>setActiveTab(id)} onUnarchiveTask={unarchiveTaskAnywhere}/>}
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
                currentMember={(data.members||[]).find(m=>m.id===activeMember)}
                permissions={data.permissions}
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
              currentMember={(data.members||[]).find(m=>m.id===activeMember)}
              filter={negFilter} onSetFilter={setNegFilter}
              onCreate={()=>setNegModal("create")}
              onOpen={id=>{setActiveNegId(id);setActiveSessId(null);}}
              onEdit={n=>setNegModal(n)}
            />;
          })()}
          {activeTab==="hector-direct" && <HectorDirectView data={data} userId={activeMember} onRunAgentActions={runAgentActions} onNavigate={setActiveTab} financeContext={financeContext}/>}
          {activeTab==="command"   &&<CommandRoomView data={data} activeMember={activeMember} onOpenTask={(taskId,projId)=>{ const i=data.projects.findIndex(p=>p.id===projId); if(i>=0){setAP(i);setActiveTab("board");setPendingOpenTaskId(taskId);} }} onCompleteTask={completeTaskAnywhere} onPostponeTask={postponeTaskAnywhere} onArchiveTask={archiveTaskAnywhere} onGoDashboard={()=>setActiveTab("dashboard")} onGoMytasks={()=>setActiveTab("mytasks")} onGoDealRoom={()=>{setActiveTab("dealroom");setActiveNegId(null);setActiveSessId(null);}} currentFocus={currentFocus} onSetCurrentFocus={setCurrentFocus} onHectorStateChange={setHectorState} onHectorRecommendation={(rec)=>setLastRecommendation(rec)} financeContext={financeContext} onAddTimelineEntry={addTimelineEntry} onRunAgentActions={runAgentActions}/>}
          {activeTab==="dashboard" &&<DashboardView data={data} onGoPlanner={()=>setActiveTab("planner")} onGoProjects={()=>setActiveTab("projects")} onGoBoard={i=>{setAP(i);setActiveTab("board");}} onOpenTask={(t,pi)=>{setAP(pi);setActiveTab("board");setPendingOpenTaskId(t.id);}} onOpenBriefing={()=>setScopeAvatar("global")} onCompleteTask={completeTaskAnywhere} onPostponeTask={postponeTaskAnywhere}/>}
          {activeTab==="projects"  &&<ProjectsView projects={data.projects} members={data.members} boards={data.boards} currentMember={(data.members||[]).find(m=>m.id===activeMember)} onSelectProject={i=>{setAP(i);setActiveTab("board");}} onCreateProject={()=>setProjModal("create")} onEditProject={i=>setProjModal(i)} onDeleteProject={deleteProject}/>}
          {activeTab==="users"     &&<UsersView members={data.members} projects={data.projects} permissions={data.permissions} onEdit={m=>setMemberModal(m)} onCreate={()=>setMemberModal("create")} onDelete={deleteMember} onSetPermission={setMemberPermission} onSetAgentPermission={setMemberAgentPermission}/>}
          {activeTab==="finance"   &&(()=>{
            const myMember = (data.members||[]).find(x=>x.id===activeMember);
            const canView = hasPermission(myMember, "finance", "view", data.permissions);
            const canEdit = hasPermission(myMember, "finance", "edit", data.permissions);
            if(!canView){
              return <div style={{padding:30,textAlign:"center",color:"#9CA3AF",fontSize:13}}>🔒 Sin permisos para acceder al módulo de Finanzas. Contacta con el admin global.</div>;
            }
            return <FinanceView data={data} member={myMember} canEdit={canEdit} onAddMovement={addFinanceMovement} onUpdateMovement={updateFinanceMovement} onDeleteMovement={deleteFinanceMovement} onAddBankAccount={addBankAccount} onUpdateBankAccount={updateBankAccount} onDeleteBankAccount={deleteBankAccount} onAddBankMovement={addBankMovement} onUpdateBankMovement={updateBankMovement} onDeleteBankMovement={deleteBankMovement} onAddBankMovementsBatch={addBankMovementsBatch} onDeleteBankMovementsByBatch={deleteBankMovementsByBatch} onAddInvoice={addInvoice} onUpdateInvoice={updateInvoice} onDeleteInvoice={deleteInvoice} onReconcileMatches={reconcileMatches} onAddAccountingEntry={addAccountingEntry} onUpdateAccountingEntry={updateAccountingEntry} onDeleteAccountingEntry={deleteAccountingEntry} onAddCustomAccount={addCustomAccount} onCallAgent={callDiegoDirect} onRunAgentActions={runAgentActions} onToast={addToast}/>;
          })()}
          {activeTab==="workspaces"&&<WorkspacesView workspaces={data.workspaces||[]} projects={data.projects} boards={data.boards} pendingWorkspaceId={pendingWorkspaceId} onPendingConsumed={()=>setPendingWorkspaceId(null)} onCreate={()=>setWorkspaceModal("create")} onEdit={w=>setWorkspaceModal(w)} onSelectProject={i=>{setAP(i);setActiveTab("board");}}/>}
          {activeTab==="gobernanza"&&(()=>{
            const myMember = (data.members||[]).find(x=>x.id===activeMember);
            const canView  = hasPermission(myMember, "gobernanza", "view", data.permissions);
            if(!canView){
              return <div style={{padding:30,textAlign:"center",color:"#9CA3AF",fontSize:13}}>🔒 Sin permisos para acceder al módulo de Gobernanza. Contacta con el admin global.</div>;
            }
            return <GobernanzaView data={data} currentMember={myMember} onUpdateGovernance={updateGovernance} onCallAgent={callGonzaloDirect} onRunAgentActions={runAgentActions}/>;
          })()}
          {activeTab==="vault"&&(()=>{
            const myMember = (data.members||[]).find(x=>x.id===activeMember);
            return <VaultView data={data} currentMember={myMember} onUpdateVault={updateVault}/>;
          })()}
          {activeTab==="agents"    &&<AgentsView agents={data.agents||[]} onCreate={()=>setAgentModal("create")} onEdit={a=>setAgentModal(a)}/>}
          {activeTab==="board"     &&<BoardView board={board} members={data.members} projectMemberIds={proj.members} activeMemberId={activeMember} aiSchedule={data.aiSchedule} workspaceLinks={(data.workspaces||[]).find(w=>w.id===proj.workspaceId)?.links||[]} agents={data.agents||[]} ceoMemory={data.ceoMemory} canDelete={isAdmin} projects={data.projects} onNavigateProject={pid=>{const i=data.projects.findIndex(p=>p.id===pid); if(i>=0){setAP(i);setActiveTab("board");}}} onTransferProject={transferTaskToProject} onAddTimelineEntry={(taskId,entry)=>addTimelineEntry(taskId,{...entry,authorId:entry.authorId??activeMember,author:entry.author||(data.members.find(m=>m.id===activeMember)?.name)})} onToggleMilestone={toggleTimelineMilestone} externalOpenTaskId={pendingOpenTaskId} onExternalTaskConsumed={()=>setPendingOpenTaskId(null)} onUpdate={(id,cid,upd)=>{ const isOwn=(data.boards[proj.id]||[]).some(c=>c.tasks.some(t=>t.id===id)); if(isOwn) updateTask(id,cid,upd); else updateTaskAnywhere(id,upd); }} onMove={moveTask} onAddTask={addTask} onDeleteTask={(id,cid)=>{ const isOwn=(data.boards[proj.id]||[]).some(c=>c.tasks.some(t=>t.id===id)); if(isOwn) deleteTask(id,cid); else deleteTaskAnywhere(id); }}/>}
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
      {projectModal==="create"&&<ProjectModal members={data.members} workspaces={data.workspaces||[]} allProjects={data.projects} currentMember={(data.members||[]).find(m=>m.id===activeMember)} onClose={()=>setProjModal(null)} onSave={createProject}/>}
      {typeof projectModal==="number"&&<ProjectModal project={data.projects[projectModal]} members={data.members} workspaces={data.workspaces||[]} allProjects={data.projects} currentMember={(data.members||[]).find(m=>m.id===activeMember)} onClose={()=>setProjModal(null)} onSave={d=>editProject(projectModal,d)} onTransferOwnership={transferProjectOwnership}/>}
      {memberModal==="create"&&<MemberEditModal allMembers={data.members} onClose={()=>setMemberModal(null)} onSave={createMember}/>}
      {memberModal&&memberModal!=="create"&&<MemberEditModal member={memberModal} allMembers={data.members} onClose={()=>setMemberModal(null)} onSave={d=>updateMember(d,memberModal.id)} onDelete={id=>{deleteMember(id);setMemberModal(null);}}/>}
      {agentModal==="create"&&<AgentEditModal onClose={()=>setAgentModal(null)} onSave={createAgent}/>}
      {agentModal&&agentModal!=="create"&&<AgentEditModal agent={agentModal} onClose={()=>setAgentModal(null)} onSave={d=>editAgent(agentModal.id,d)} onDelete={deleteAgent}/>}
      {workspaceModal==="create"&&<WorkspaceModal onClose={()=>setWorkspaceModal(null)} onSave={createWorkspace}/>}
      {workspaceModal&&workspaceModal!=="create"&&<WorkspaceModal workspace={workspaceModal} onClose={()=>setWorkspaceModal(null)} onSave={d=>editWorkspace(workspaceModal.id,d)} onDelete={deleteWorkspace}/>}

      {negModal==="create"&&<NegotiationModal members={data.members} workspaces={data.workspaces||[]} projects={data.projects} agents={data.agents||[]} allNegotiations={data.negotiations||[]} currentMember={(data.members||[]).find(m=>m.id===activeMember)} onClose={()=>setNegModal(null)} onSave={createNegotiation}/>}
      {negModal&&negModal!=="create"&&<NegotiationModal negotiation={negModal} members={data.members} workspaces={data.workspaces||[]} projects={data.projects} agents={data.agents||[]} allNegotiations={data.negotiations||[]} currentMember={(data.members||[]).find(m=>m.id===activeMember)} onClose={()=>setNegModal(null)} onSave={p=>updateNegotiation(negModal.id,p)} onDelete={id=>{ deleteNegotiation(id); if(activeNegId===id){ setActiveNegId(null); setActiveSessId(null); } }} onTransferOwnership={transferNegotiationOwnership}/>}
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

      {/* Briefing matinal — solo si pasó el guard de 4h + no mostrado hoy */}
      {showBriefing && me && <BriefingMatinal user={me} data={data} onClose={()=>setShowBriefing(false)}/>}

      {/* Cierre del día — a partir de las 18:00, una vez al día */}
      {showClosing && me && <CierreDia user={me} data={data} onClose={()=>setShowClosing(false)}/>}

      {/* Héctor flotante — visible salvo en hector-direct, donde la propia
          vista YA es el canal con Héctor y el botón flotante (🧙) se solapa
          con el icono Héctor del bottom nav. */}
      {activeTab !== "hector-direct" && (()=>{
        const myActive = [];
        Object.entries(data.boards||{}).forEach(([pid,cols])=>{
          const projObj = data.projects.find(p=>p.id===Number(pid));
          cols.forEach(col=>col.tasks.forEach(t=>{
            if(t.archived) return;
            if(!t.assignees?.includes(activeMember)) return;
            if(col.name==="Hecho") return;
            const assigneeNames = (t.assignees||[]).map(id=>(data.members||[]).find(m=>m.id===id)?.name).filter(Boolean);
            myActive.push({...t, colName:col.name, projId:Number(pid), projName:projObj?.name||"", assigneeNames, assigneeName:assigneeNames[0]||null});
          }));
        });
        return(
          <HectorFloat
            isOpen={hectorPanelOpen}
            onToggle={()=>setHectorPanelOpen(o=>!o)}
            lastRecommendation={lastRecommendation}
            hasNewRecommendation={hectorHasNew}
            hectorState={hectorState}
            tasks={myActive}
            currentFocus={currentFocus}
            riesgos={[]}
            agent={(data.agents||[]).find(a=>a.name==="Héctor")}
            ceoMemory={data.ceoMemory}
            userId={activeMember}
            userName={me?.name}
            onStateChange={setHectorState}
            onNewRecommendation={setLastRecommendation}
            onRecommendationClick={(rec)=>{
              const task = myActive.find(t=>t.title===rec.title);
              if(task){
                setCurrentFocus(task);
                const i = data.projects.findIndex(p=>p.id===task.projId);
                if(i>=0){ setAP(i); setActiveTab("board"); setPendingOpenTaskId(task.id); }
                setHectorPanelOpen(false);
              }
            }}
            onCompleteTask={(taskId,projId,colId)=>completeTaskAnywhere(taskId,projId,colId)}
            onPostponeTask={(task)=>{
              if(!task) return;
              const newDate = new Date(task.dueDate||new Date());
              newDate.setDate(newDate.getDate()+1);
              postponeTaskAnywhere(task, fmt(newDate), "+1d");
            }}
            onArchiveTask={archiveTaskAnywhere}
            onOpenTask={(taskId,projId)=>{
              const i = data.projects.findIndex(p=>p.id===projId);
              if(i>=0){ setAP(i); setActiveTab("board"); setPendingOpenTaskId(taskId); }
              setHectorPanelOpen(false);
            }}
            financeContext={financeContext}
            vaultAlerts={vaultAlertsForHector}
            onRunAgentActions={runAgentActions}
            onAddTimelineEntry={addTimelineEntry}
          />
        );
      })()}

      {/* Botón flotante global del asesor — visible salvo en hector-direct,
          donde la propia vista es ya un canal conversacional con IA y el FAB
          se solapa con el bottom nav y el botón "Pro" (📁). */}
      {activeTab !== "hector-direct" && (
        <button className="tf-fab" onClick={()=>setScopeAvatar(activeTab||"global")} title="Asesor IA — habla sobre lo que estás viendo" style={{position:"fixed",bottom:24,right:24,zIndex:1500,width:60,height:60,borderRadius:"50%",background:"linear-gradient(135deg,#7F77DD,#E76AA1)",color:"#fff",border:"none",fontSize:26,cursor:"pointer",boxShadow:"0 8px 24px rgba(127,119,221,0.4)",display:"flex",alignItems:"center",justifyContent:"center"}}>🎙️</button>
      )}

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
      {/* Bottom navigation — visible solo en móvil (≤768px) vía CSS.
          Aditiva al sidebar drawer existente: estas 4 rutas son las más
          usadas y se acceden con un tap; el resto sigue en la
          hamburguesa. Reusa setActiveTab para no duplicar lógica. */}
      <nav className="tf-bottom-nav" aria-label="Navegación principal móvil">
        {[
          { id: "hector-direct", icon: "🧙", label: "Héctor",    onClick: () => setActiveTab("hector-direct") },
          { id: "mytasks",       icon: "✅", label: "Tareas",    onClick: () => setActiveTab("mytasks") },
          { id: "dealroom",      icon: "🤝", label: "Negs",      onClick: () => { setActiveTab("dealroom"); setActiveNegId(null); setActiveSessId(null); } },
          { id: "projects",      icon: "📁", label: "",          onClick: () => setActiveTab("projects") },
        ].map(item => (
          <button
            key={item.id}
            type="button"
            className={`tf-bottom-nav-item${activeTab === item.id ? " active" : ""}`}
            onClick={item.onClick}
            aria-current={activeTab === item.id ? "page" : undefined}
          >
            <span className="tf-bn-icon" aria-hidden="true">{item.icon}</span>
            <span className="tf-bn-label">{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
    </PresenceProvider>
  );
}
