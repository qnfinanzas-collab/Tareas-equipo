// Asesor IA rule-based — briefings, respuestas y comandos ejecutables, sin API.
import { getQ } from "./eisenhower.js";
import { daysUntil, fmt } from "./date.js";

export const AVATARS = {
  gestion: {
    key: "gestion", label: "Gestión", icon: "🎯", color: "#E24B4A",
    voice: { gender: "male", rate: 1.02, pitch: 1.0 },
    opener: "Hola, soy tu asesor de gestión de proyectos.",
    style: "directo y orientado a acción",
  },
  marketing: {
    key: "marketing", label: "Marketing", icon: "📣", color: "#E76AA1",
    voice: { gender: "female", rate: 1.08, pitch: 1.08 },
    opener: "Hola, soy tu estratega de marketing.",
    style: "creativo y orientado a audiencia",
  },
  comunicacion: {
    key: "comunicacion", label: "Comunicación", icon: "✍️", color: "#378ADD",
    voice: { gender: "female", rate: 1.0, pitch: 1.05 },
    opener: "Hola, soy tu asesor de comunicación.",
    style: "claro y empático",
  },
  finanzas: {
    key: "finanzas", label: "Finanzas", icon: "💰", color: "#1D9E75",
    voice: { gender: "male", rate: 0.98, pitch: 0.95 },
    opener: "Hola, soy tu analista financiero.",
    style: "analítico y orientado a números",
  },
  legal: {
    key: "legal", label: "Legal", icon: "⚖️", color: "#3C3489",
    voice: { gender: "male", rate: 0.95, pitch: 0.92 },
    opener: "Hola, soy tu asesor legal.",
    style: "prudente y preciso",
  },
  estrategia: {
    key: "estrategia", label: "Estrategia", icon: "🧠", color: "#7F77DD",
    voice: { gender: "female", rate: 1.0, pitch: 1.0 },
    opener: "Hola, soy tu asesor estratégico.",
    style: "estructurado y con visión de largo plazo",
  },
};

export const AVATAR_KEYS = Object.keys(AVATARS);

// --- Helpers internos ---
function hoursLogged(task){
  return ((task.timeLogs||[]).reduce((s,l)=>s+l.seconds,0)/3600);
}
function progressPct(task){
  const est = task.estimatedHours||0;
  if(est<=0) return null;
  return Math.round(hoursLogged(task)/est*100);
}
function subtaskStats(task){
  const subs = task.subtasks || [];
  const done = subs.filter(s=>s.done).length;
  return { total: subs.length, done, pending: subs.length-done };
}
function riskLevel(task){
  const q = getQ(task);
  const d = daysUntil(task.dueDate);
  const pct = progressPct(task);
  if(d<0) return "crítico";
  if(q==="Q1") return "alto";
  if(d<=2 && (pct==null || pct<50)) return "alto";
  if(q==="Q2") return "medio";
  return "bajo";
}

// --- Consejos por categoría ---
const ADVICE = {
  gestion: task => {
    const q = getQ(task), d = daysUntil(task.dueDate);
    if(q==="Q1") return "Es urgente e importante. Bloquea un tramo ahora, avisa a los implicados y elimina distracciones. No lo delegues, hazlo ya.";
    if(q==="Q2") return "Es importante pero no urgente — aquí está el verdadero trabajo de calidad. Asigna un slot fijo en tu agenda esta semana antes de que se convierta en urgente.";
    if(q==="Q3") return "Urgente pero poco importante. Valora delegarlo o acotar el alcance para no robarte tiempo de lo que sí mueve la aguja.";
    if(d<0) return "Está vencida. Decide ahora mismo: ¿la replanificamos, la recortamos o la cerramos? No dejes que drene energía al equipo.";
    return "Revisa si las subtareas están claras, si tiene owner único y si la fecha límite es realista. Tres cosas que desatascan el 80% de los bloqueos.";
  },
  marketing: task => {
    const hasDesc = (task.desc||"").length>30;
    if(!hasDesc) return "Antes de ejecutar, define en una línea: a quién va dirigido, qué problema resuelve y qué resultado esperamos medir. Sin eso, cualquier canal es tiro al aire.";
    return "Piensa el embudo: awareness, consideración, conversión, retención. ¿En qué fase está tu audiencia con este tema? Eso decide canal, tono y call-to-action, no al revés.";
  },
  comunicacion: task => {
    return "Dos reglas: primero el mensaje clave en una frase que tu madre entendería, después la estructura. Si el lector tuviera que leer solo el titular y la primera línea, ¿sabría qué hacer?";
  },
  finanzas: task => {
    const est = task.estimatedHours||0;
    const logged = hoursLogged(task);
    if(est>0 && logged>est*1.3) return `Ya has invertido ${logged.toFixed(1)} horas sobre ${est} estimadas — un ${Math.round(logged/est*100)}%. Antes de seguir, revisa si el retorno justifica el coste acumulado.`;
    return "Cuantifica el coste-oportunidad antes de continuar: ¿qué dejas de hacer mientras esto está en marcha? Si no lo puedes justificar con un número, probablemente no es prioritario.";
  },
  legal: task => {
    return "Lista los riesgos antes que las acciones: qué puede fallar, a quién afecta, qué incumplimiento concreto habría. Documenta el proceso — no protege lo que no está por escrito. Si dudas, escálalo antes de firmar nada.";
  },
  estrategia: task => {
    return "Tres preguntas: ¿Esta tarea nos acerca al objetivo trimestral? ¿Qué dejamos de hacer para hacer esto? ¿Cuál es el mínimo entregable que valida la hipótesis? Ejecutar sin responder las tres es ruido.";
  },
};

// --- Briefing inicial (lo que el avatar dice nada más abrir) ---
export function buildBriefing(task, avatarKey){
  const av = AVATARS[avatarKey] || AVATARS.gestion;
  const q = getQ(task);
  const d = daysUntil(task.dueDate);
  const pct = progressPct(task);
  const subs = subtaskStats(task);
  const risk = riskLevel(task);

  const parts = [av.opener];
  parts.push(`La tarea es: ${task.title}.`);

  // Estado temporal
  if(d < 0) parts.push(`Está vencida desde hace ${-d} ${-d===1?"día":"días"}.`);
  else if(d === 0) parts.push("Vence hoy.");
  else if(d <= 2) parts.push(`Vence en ${d} ${d===1?"día":"días"}.`);
  else if(d < 999) parts.push(`Tienes ${d} días hasta la fecha límite.`);

  // Eisenhower
  const qLabels = { Q1: "urgente e importante", Q2: "importante pero no urgente", Q3: "urgente pero poco importante", Q4: "ni urgente ni importante" };
  parts.push(`Según Eisenhower es ${qLabels[q]}.`);

  // Progreso
  if(pct !== null){
    if(pct >= 100) parts.push(`Has invertido el ${pct}% del tiempo estimado.`);
    else if(pct > 0) parts.push(`Llevas un ${pct}% del tiempo estimado invertido.`);
  }
  if(subs.total > 0) parts.push(`Tienes ${subs.done} de ${subs.total} subtareas hechas.`);

  // Riesgo
  parts.push(`El riesgo que percibo es ${risk}.`);

  // Consejo específico
  const advice = ADVICE[avatarKey]?.(task);
  if(advice) parts.push("Mi recomendación: " + advice);

  parts.push("¿En qué te ayudo? Pulsa el botón de micro y pregúntame.");

  return parts.join(" ");
}

// --- Intent matching muy simple ---
const INTENTS = [
  { name: "ayuda",      kw: ["qué hago","que hago","por dónde","por donde","empezar","primer paso","siguiente","ayuda","ayúdame","ayudame"] },
  { name: "subtareas",  kw: ["subtarea","subtareas","tareas","pasos","pendiente","pendientes","checklist"] },
  { name: "tiempo",     kw: ["tiempo","horas","cuánto","cuanto","llevas","llevo","he dedicado","he trabajado"] },
  { name: "plazo",      kw: ["vence","fecha","plazo","límite","limite","deadline","cuándo","cuando"] },
  { name: "prioridad",  kw: ["prioridad","importante","urgente","eisenhower","cuadrante"] },
  { name: "estado",     kw: ["estado","progreso","cómo va","como va","cómo vamos","como vamos","avance"] },
  { name: "riesgo",     kw: ["riesgo","problema","peligro","alerta","me preocupa"] },
  { name: "resumen",    kw: ["resumen","repite","otra vez","repítelo","repitelo","resúmelo","resumelo"] },
  { name: "equipo",     kw: ["quién","quien","asignado","asignados","responsable","equipo"] },
  { name: "detener",    kw: ["para","silencio","cállate","callate","gracias","vale","ok ya","ok, ya"] },
];

function matchIntent(text){
  const t = (text||"").toLowerCase();
  for(const it of INTENTS){
    if(it.kw.some(k => t.includes(k))) return it.name;
  }
  return null;
}

// --- Respuestas por intent (con inclinación según avatar) ---
export function respondToQuery(userText, task, avatarKey, members){
  const av = AVATARS[avatarKey] || AVATARS.gestion;
  const intent = matchIntent(userText);
  const q = getQ(task);
  const d = daysUntil(task.dueDate);
  const pct = progressPct(task);
  const subs = subtaskStats(task);

  if(!intent){
    return "No te he entendido del todo. Prueba con preguntas como: qué hago primero, cuánto tiempo llevo, cuándo vence, o pídeme un resumen.";
  }

  if(intent === "detener") return "Hecho. Vuelve cuando quieras.";
  if(intent === "resumen") return buildBriefing(task, avatarKey);

  if(intent === "ayuda"){
    if(subs.pending > 0){
      const next = task.subtasks.find(s=>!s.done);
      return `Empieza por la siguiente subtarea pendiente: ${next.title}. ` + (ADVICE[avatarKey]?.(task) || "");
    }
    return ADVICE[avatarKey]?.(task) || "Divide la tarea en tres pasos concretos y ataca el primero en las próximas dos horas.";
  }

  if(intent === "subtareas"){
    if(subs.total === 0) return "Esta tarea no tiene subtareas. Te recomiendo añadir al menos tres subtareas concretas para que sea ejecutable.";
    const pend = task.subtasks.filter(s=>!s.done).slice(0,3).map(s=>s.title).join("; ");
    return `Tienes ${subs.pending} subtareas pendientes de ${subs.total}. Las próximas son: ${pend}.`;
  }

  if(intent === "tiempo"){
    const logged = hoursLogged(task);
    const est = task.estimatedHours||0;
    if(est<=0) return `Has registrado ${logged.toFixed(1)} horas en esta tarea. No hay estimación — te recomiendo ponerla para medir desviación.`;
    return `Has registrado ${logged.toFixed(1)} horas de ${est} estimadas, un ${pct}%. ${pct>100?"Estás por encima del presupuesto.":pct>80?"Estás cerca del límite, vigila.":"Vas dentro de lo previsto."}`;
  }

  if(intent === "plazo"){
    if(!task.dueDate) return "Esta tarea no tiene fecha límite. Ponle una — sin plazo, no hay prioridad real.";
    if(d < 0) return `Vencida hace ${-d} días. Hay que decidir ya: replanificar, recortar o cerrar.`;
    if(d === 0) return "Vence hoy. Bloquea tiempo ahora mismo.";
    return `Vence en ${d} ${d===1?"día":"días"}. ${d<=2?"Es inminente.":d<=7?"Entra en zona de alerta esta semana.":"Tienes margen, pero no te confíes."}`;
  }

  if(intent === "prioridad"){
    const qDesc = { Q1: "Q1: urgente e importante. Hazlo ahora.", Q2: "Q2: importante pero no urgente. Planifícalo en tu agenda antes de que se convierta en Q1.", Q3: "Q3: urgente pero poco importante. Valora delegarlo.", Q4: "Q4: ni urgente ni importante. Plantéate si merece existir." };
    return qDesc[q] || "No tengo clasificación clara de prioridad.";
  }

  if(intent === "estado"){
    const bits = [];
    if(pct !== null) bits.push(`${pct}% del tiempo estimado invertido`);
    if(subs.total > 0) bits.push(`${subs.done} de ${subs.total} subtareas hechas`);
    if(d < 999) bits.push(d<0 ? `vencida hace ${-d} días` : d===0 ? "vence hoy" : `vence en ${d} días`);
    if(bits.length === 0) return "Muy poca información para calibrar el estado. Añade estimación de horas y subtareas.";
    return "Estado actual: " + bits.join(", ") + ".";
  }

  if(intent === "riesgo"){
    const risk = riskLevel(task);
    const reasons = [];
    if(d < 0) reasons.push("vencida");
    if(q === "Q1") reasons.push("en el cuadrante más urgente");
    if(pct !== null && pct > 100) reasons.push("sobre presupuesto");
    if(subs.pending > subs.done && subs.total > 0) reasons.push("más subtareas pendientes que hechas");
    return `Riesgo ${risk}. ` + (reasons.length ? "Motivos: " + reasons.join(", ") + "." : "No veo señales de alarma inmediatas.");
  }

  if(intent === "equipo"){
    if(!task.assignees || task.assignees.length === 0) return "No hay nadie asignado. Asigna al menos un responsable único antes de ejecutar.";
    const names = task.assignees.map(id => (members||[]).find(m=>m.id===id)?.name || "?").join(", ");
    return `Asignada a: ${names}.` + (task.assignees.length>1 ? " Con varias personas, define quién es el owner único responsable del resultado." : "");
  }

  return "No te he entendido del todo.";
}

// ═══════════════════════════════════════════════════════════════════════════
// EJECUCIÓN DE COMANDOS
// ═══════════════════════════════════════════════════════════════════════════

const ORDINALS = {
  "primera":1,"primero":1,"1":1,
  "segunda":2,"segundo":2,"2":2,
  "tercera":3,"tercero":3,"3":3,
  "cuarta":4,"cuarto":4,"4":4,
  "quinta":5,"quinto":5,"5":5,
  "sexta":6,"sexto":6,"6":6,
  "séptima":7,"septima":7,"séptimo":7,"septimo":7,"7":7,
  "octava":8,"octavo":8,"8":8,
};

const DOW_NAMES = { domingo:0, lunes:1, martes:2, "miércoles":3, miercoles:3, jueves:4, viernes:5, "sábado":6, sabado:6 };

const PRIORITY_WORDS = {
  alta: ["alta","máxima","maxima","urgente","crítica","critica"],
  media: ["media","normal","estándar","estandar"],
  baja: ["baja","mínima","minima","poca"],
};

function parsePriority(text){
  const t = text.toLowerCase();
  for(const [p,words] of Object.entries(PRIORITY_WORDS)){
    if(words.some(w => new RegExp(`\\b${w}\\b`).test(t))) return p;
  }
  return null;
}

function parseDate(text){
  const t = text.toLowerCase().trim();
  const today = new Date(); today.setHours(0,0,0,0);
  const addDays = n => { const d=new Date(today); d.setDate(d.getDate()+n); return fmt(d); };

  if(/\bhoy\b/.test(t)) return addDays(0);
  if(/pasado\s+ma[ñn]ana/.test(t)) return addDays(2);
  if(/\bma[ñn]ana\b/.test(t)) return addDays(1);
  const inN = t.match(/en\s+(\d+)\s+d[ií]as?/);
  if(inN) return addDays(parseInt(inN[1]));
  const inWeeks = t.match(/en\s+(\d+)\s+semanas?/);
  if(inWeeks) return addDays(parseInt(inWeeks[1])*7);
  if(/en\s+una\s+semana/.test(t)) return addDays(7);

  // "el lunes" / "el próximo lunes"
  const dowMatch = t.match(/\b(domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)\b/);
  if(dowMatch){
    const target = DOW_NAMES[dowMatch[1]];
    const cur = today.getDay();
    let diff = (target - cur + 7) % 7;
    if(diff === 0) diff = 7;
    return addDays(diff);
  }

  // dd/mm o dd-mm
  const dm = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if(dm){
    const d = parseInt(dm[1]), m = parseInt(dm[2])-1;
    const y = dm[3] ? (dm[3].length===2?2000+parseInt(dm[3]):parseInt(dm[3])) : today.getFullYear();
    const date = new Date(y, m, d);
    return fmt(date);
  }

  return null;
}

function findMemberByName(members, text){
  if(!members) return null;
  const t = text.toLowerCase();
  // Exact first-name match first
  for(const m of members){
    const first = m.name.split(" ")[0].toLowerCase();
    if(new RegExp(`\\b${first}\\b`).test(t)) return m;
  }
  // Full name partial match
  for(const m of members){
    if(t.includes(m.name.toLowerCase())) return m;
  }
  // Initials
  for(const m of members){
    if(t.includes(m.initials.toLowerCase())) return m;
  }
  return null;
}

function resolveSubtask(subs, text){
  if(!subs || subs.length === 0) return null;
  const t = text.toLowerCase();
  // Ordinal
  const ordMatch = t.match(/\b(primera|primero|segunda|segundo|tercera|tercero|cuarta|cuarto|quinta|quinto|sexta|sexto|s[eé]ptima|s[eé]ptimo|octava|octavo|\d+)\b/);
  if(ordMatch){
    const idx = ORDINALS[ordMatch[1]];
    if(idx && idx <= subs.length) return subs[idx-1];
  }
  if(/\b(última|ultima|último|ultimo)\b/.test(t)) return subs[subs.length-1];
  // Title partial match
  for(const s of subs){
    const title = s.title.toLowerCase();
    const words = title.split(/\s+/).filter(w=>w.length>3);
    if(words.some(w => t.includes(w))) return s;
  }
  return null;
}

// Devuelve el texto que sigue a una de las palabras gatillo
function extractAfter(text, triggers){
  const t = text.trim();
  for(const trigger of triggers){
    const re = new RegExp(`^.*?\\b${trigger}\\b[:,\\s]+(.+)$`,"i");
    const m = t.match(re);
    if(m) return m[1].trim().replace(/[.!?]+$/,"");
  }
  return null;
}

// Parsea una frase en un comando estructurado.
// Devuelve { type, ...args } o null si no es un comando.
export function parseCommand(text){
  if(!text) return null;
  const t = text.toLowerCase().trim().replace(/\s+/g," ");

  // 1. Crear subtarea
  if(/\b(crea|crear|a[ñn]ade|a[ñn]adir|agrega|agregar|nueva)\b.*\b(sub\s?tareas?|tareas?|paso|item|elemento)\b/.test(t)){
    const title = extractAfter(text, ["subtarea","sub tarea","subtareas","sub tareas","tarea","tareas","paso","item","elemento","llamada","llamado","sobre","para","de"]);
    if(title) return { type:"addSubtask", title };
    // Fallback: intenta extraer después de "subtarea"
    const m = text.match(/sub\s?tareas?\s+(.+)/i);
    if(m) return { type:"addSubtask", title: m[1].replace(/[.!?]+$/,"").trim() };
  }

  // 2. Marcar subtarea como hecha
  if(/\b(marca|completa|termina|finaliza|cierra)\b.*\bsub\s?tareas?\b/.test(t) || /\bsub\s?tareas?\b.*\b(hecha|completada|terminada|lista)\b/.test(t)){
    return { type:"markSubtaskDone", ref: text };
  }

  // 3. Eliminar subtarea
  if(/\b(elimina|borra|quita|suprime)\b.*\bsub\s?tareas?\b/.test(t)){
    return { type:"deleteSubtask", ref: text };
  }

  // 4. Prioridad
  if(/\b(prioridad|priori[zs]a|prior[ií]talo|prior[ií]tala)\b/.test(t) || /\bpon.*\b(alta|media|baja|urgente)\b/.test(t) || /\bcambia.*\bprioridad\b/.test(t)){
    const p = parsePriority(t);
    if(p) return { type:"setPriority", priority: p };
  }

  // 5. Plazo / fecha límite
  if(/\b(plazo|vence|fecha|deadline|l[ií]mite)\b/.test(t) || /\b(p[oó]n|cambia).*\b(hoy|ma[ñn]ana|pasado)\b/.test(t)){
    const d = parseDate(t);
    if(d) return { type:"setDueDate", date: d };
  }

  // 6. Estimación
  const estMatch = t.match(/\b(estima|estimar|pon|cambia).*?(\d+(?:[.,]\d+)?)\s*(?:h|horas?)\b/);
  if(estMatch){
    return { type:"setEstimate", hours: parseFloat(estMatch[2].replace(",",".")) };
  }

  // 7. Asignar
  if(/\b(as[ií]gnal[oa]|as[ií]gna|pon a|a[ñn]ade a)\b/.test(t) && !/\b(sub\s?tarea|comentario|nota)\b/.test(t)){
    return { type:"assign", ref: text };
  }
  if(/\b(quita a|desasigna|desas[ií]gnal[oa]|elimina a)\b/.test(t) && !/\bsub\s?tarea\b/.test(t)){
    return { type:"unassign", ref: text };
  }

  // 8. Mover columna
  if(/\b(mueve|mu[eé]vela|mu[eé]velo|ll[eé]val[oa]|pasa|pon)\b.*\b(hecho|hecha|completada|completado|terminad[oa]|en progreso|en curso|por hacer|pendiente)\b/.test(t)){
    if(/\b(hecho|hecha|completada|completado|terminad[oa])\b/.test(t)) return { type:"moveColumn", target:"Hecho" };
    if(/\b(en progreso|en curso)\b/.test(t)) return { type:"moveColumn", target:"En progreso" };
    if(/\b(por hacer|pendiente)\b/.test(t)) return { type:"moveColumn", target:"Por hacer" };
  }

  // 9. Añadir comentario
  if(/\b(comenta|a[ñn]ade comentario|deja comentario|apunta|nota)\b/.test(t)){
    const txt = extractAfter(text, ["comentario","comenta","nota","apunta","apunte"]);
    if(txt) return { type:"addComment", text: txt };
  }

  // 10. Cambiar descripción
  if(/\b(descripci[oó]n|describe|description)\b/.test(t)){
    const txt = extractAfter(text, ["descripción","descripcion","describe","description"]);
    if(txt) return { type:"setDescription", text: txt };
  }

  // 11. Cambiar título
  if(/\b(renombra|t[ií]tulo|renombrar)\b/.test(t)){
    const txt = extractAfter(text, ["título","titulo","renombra","renombrar","renombrala","renombralo"]);
    if(txt) return { type:"rename", title: txt };
  }

  return null;
}

// Ejecuta el comando y devuelve { task: nuevoTask, msg: confirmación para decir al usuario }
export function executeCommand(cmd, task, members){
  if(!cmd) return null;
  const subs = task.subtasks || [];

  if(cmd.type === "addSubtask"){
    const id = "st_" + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
    const sub = { id, title: cmd.title, done: false, dueDate:"", assigneeId:null };
    return {
      task: { ...task, subtasks: [...subs, sub] },
      msg: `Hecho. Añadida la subtarea: ${cmd.title}.`
    };
  }

  if(cmd.type === "markSubtaskDone"){
    const sub = resolveSubtask(subs, cmd.ref);
    if(!sub) return { task, msg: "No he identificado qué subtarea marcar. Dímelo por posición, por ejemplo: 'marca la primera'." };
    return {
      task: { ...task, subtasks: subs.map(s => s.id===sub.id ? {...s, done:true} : s) },
      msg: `Marcada como hecha: ${sub.title}.`
    };
  }

  if(cmd.type === "deleteSubtask"){
    const sub = resolveSubtask(subs, cmd.ref);
    if(!sub) return { task, msg: "No he identificado qué subtarea borrar." };
    return {
      task: { ...task, subtasks: subs.filter(s => s.id !== sub.id) },
      msg: `Eliminada la subtarea: ${sub.title}.`
    };
  }

  if(cmd.type === "setPriority"){
    return { task: { ...task, priority: cmd.priority }, msg: `Prioridad cambiada a ${cmd.priority}.` };
  }

  if(cmd.type === "setDueDate"){
    return { task: { ...task, dueDate: cmd.date }, msg: `Fecha límite fijada al ${cmd.date}.` };
  }

  if(cmd.type === "setEstimate"){
    return { task: { ...task, estimatedHours: cmd.hours }, msg: `Estimación actualizada a ${cmd.hours} horas.` };
  }

  if(cmd.type === "assign"){
    const m = findMemberByName(members, cmd.ref);
    if(!m) return { task, msg: "No he identificado a la persona. Dime su nombre." };
    if((task.assignees||[]).includes(m.id)) return { task, msg: `${m.name} ya estaba asignado.` };
    return {
      task: { ...task, assignees: [...(task.assignees||[]), m.id] },
      msg: `Asignado ${m.name} a esta tarea.`
    };
  }

  if(cmd.type === "unassign"){
    const m = findMemberByName(members, cmd.ref);
    if(!m) return { task, msg: "No he identificado a la persona a desasignar." };
    return {
      task: { ...task, assignees: (task.assignees||[]).filter(id => id !== m.id) },
      msg: `Desasignado ${m.name}.`
    };
  }

  if(cmd.type === "moveColumn"){
    return { task, msg: `Para mover a "${cmd.target}" tendrás que hacerlo desde el selector "Mover a" — lo he dejado señalado.`, hint:{ type:"moveColumn", target: cmd.target } };
  }

  if(cmd.type === "addComment"){
    const c = { author: null, text: cmd.text, time: "ahora mismo" };
    return {
      task: { ...task, comments: [...(task.comments||[]), c] },
      msg: `Comentario añadido: ${cmd.text}.`
    };
  }

  if(cmd.type === "setDescription"){
    return { task: { ...task, desc: cmd.text }, msg: "Descripción actualizada." };
  }

  if(cmd.type === "rename"){
    return { task: { ...task, title: cmd.title }, msg: `Tarea renombrada a: ${cmd.title}.` };
  }

  return null;
}

