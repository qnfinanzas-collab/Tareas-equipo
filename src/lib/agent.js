// Asesor IA rule-based — briefings, respuestas y comandos ejecutables, sin API.
import { getQ } from "./eisenhower.js";
import { daysUntil, fmt } from "./date.js";
import { stripMarkdown } from "./voice.js";

// Regla de estilo que se inyecta en el system prompt de CUALQUIER llamada
// al LLM de agentes. Fuerza texto plano sin markdown para que las respuestas
// se rendericen limpias en UI y suenen bien al TTS sin leer "asterisco".
export const PLAIN_TEXT_RULE = "FORMATO OBLIGATORIO: Responde en texto plano sin ningún formato. Prohibido usar asteriscos, almohadillas, guiones como viñetas, listas numeradas, o cualquier sintaxis markdown. Escribe como si hablaras: frases naturales, párrafos cortos, sin decoración. Usa saltos de línea para separar ideas, nada más.";

export const AVATARS = {
  gestion: {
    key: "gestion", label: "Gestión", icon: "🎯", color: "#E24B4A",
    voice: { gender: "male", rate: 1.02, pitch: 1.0 },
    opener: "Hola, soy tu asesor de gestión de proyectos.",
    style: "directo y orientado a acción",
  },
  marketing: {
    key: "marketing", label: "Marketing", icon: "📣", color: "#E76AA1",
    voice: { gender: "male", rate: 1.05, pitch: 1.0 },
    opener: "Hola, soy tu estratega de marketing.",
    style: "creativo y orientado a audiencia",
  },
  comunicacion: {
    key: "comunicacion", label: "Comunicación", icon: "✍️", color: "#378ADD",
    voice: { gender: "male", rate: 1.0, pitch: 0.98 },
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
    voice: { gender: "male", rate: 1.0, pitch: 0.97 },
    opener: "Hola, soy tu asesor estratégico.",
    style: "estructurado y con visión de largo plazo",
  },
};

export const AVATAR_KEYS = Object.keys(AVATARS);

// Esquema del agente personalizado (guardado en data.agents)
export const AGENT_DEFAULTS = {
  emoji: "🤖",
  color: "#7F77DD",
  voice: { gender: "male", rate: 1.0, pitch: 1.0 },
  specialties: [],
  opener: "Hola, soy tu asesor.",
  style: "profesional",
  advice: {
    default: "",
    overdue: "",
    noDueDate: "",
    noSubtasks: "",
    overBudget: "",
    q1: "",
    q2: "",
  },
  promptBase: "",
};

// Convierte un agent personalizado al formato que necesita AvatarModal (compatible con AVATARS)
export function agentToAvatar(agent){
  return {
    key: `agent_${agent.id}`,
    label: agent.name,
    icon: agent.emoji || "🤖",
    color: agent.color || "#7F77DD",
    voice: agent.voice || { gender: "male", rate: 1.0, pitch: 1.0 },
    opener: agent.opener || `Hola, soy ${agent.name}.`,
    style: agent.style || "profesional",
    _agent: agent,
  };
}

// Briefing dinámico para un agente personalizado (lee las plantillas de advice)
export function buildAgentBriefing(task, agent){
  const av = agentToAvatar(agent);
  const q = getQ(task);
  const d = daysUntil(task.dueDate);
  const subs = (task.subtasks||[]);
  const subDone = subs.filter(s=>s.done).length;
  const logged = ((task.timeLogs||[]).reduce((s,l)=>s+l.seconds,0)/3600);
  const est = task.estimatedHours||0;
  const pct = est>0 ? Math.round(logged/est*100) : null;

  const parts = [av.opener];
  if(agent.role) parts.push(`Soy especialista en ${agent.role}.`);
  parts.push(`Analizo la tarea: ${task.title}.`);

  // Estado
  if(d < 0) parts.push(`Está vencida desde hace ${-d} ${-d===1?"día":"días"}.`);
  else if(d === 0) parts.push("Vence hoy.");
  else if(d <= 2) parts.push(`Vence en ${d} ${d===1?"día":"días"}.`);
  else if(d < 999) parts.push(`Tienes ${d} días hasta la fecha límite.`);

  if(pct !== null) parts.push(`Llevas un ${pct}% del tiempo estimado invertido.`);
  if(subs.length > 0) parts.push(`${subDone} de ${subs.length} subtareas hechas.`);

  // Consejo específico según situación (selecciona la advice apropiada)
  const adv = agent.advice || {};
  let advice = "";
  if(d < 0 && adv.overdue) advice = adv.overdue;
  else if(!task.dueDate && adv.noDueDate) advice = adv.noDueDate;
  else if(subs.length === 0 && adv.noSubtasks) advice = adv.noSubtasks;
  else if(pct !== null && pct > 120 && adv.overBudget) advice = adv.overBudget;
  else if(q === "Q1" && adv.q1) advice = adv.q1;
  else if(q === "Q2" && adv.q2) advice = adv.q2;
  else advice = adv.default || "";

  if(advice) parts.push("Mi recomendación: " + advice);
  parts.push("¿En qué te ayudo? Pulsa el micro y pregúntame.");
  return parts.join(" ");
}

// Respuesta simple usando el agente personalizado — reutiliza respondToQuery base
// pero inyectando el opener/style del agente cuando aplica.
export function respondAgentQuery(userText, task, agent, members){
  // Usa el matching de intents existente pero con fallback al advice del agente
  const reply = respondToQuery(userText, task, "gestion", members);
  if(reply.startsWith("No te he entendido") && agent.advice?.default){
    return agent.advice.default;
  }
  return reply;
}

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
    if(m){
      let out = m[1].trim().replace(/[.!?]+$/,"");
      // Strip prepositions/articles iniciales que sobran
      out = out.replace(/^(llamad[oa]|titulad[oa]|que se llame|sobre|para|de|del|la|el|una|un)\s+/i, "");
      return out.trim();
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// NIVEL GLOBAL Y TABLERO — briefings y comandos cross-task
// ═══════════════════════════════════════════════════════════════════════════

function flatTasks(boards, projects){
  return Object.entries(boards).flatMap(([pid,cols])=>{
    const proj = projects.find(p=>p.id===Number(pid));
    return cols.flatMap(col => col.tasks.map(t => ({
      ...t, colId: col.id, colName: col.name,
      projectId: Number(pid), projectName: proj?.name || "",
    })));
  });
}

// Briefing diario — resumen global para un miembro concreto (o todos si memberId=null)
export function buildDailyBriefing(data, memberId){
  const { boards, members, projects } = data;
  const all = flatTasks(boards, projects);
  const mine = memberId!=null ? all.filter(t => (t.assignees||[]).includes(memberId)) : all;
  const active = mine.filter(t => t.colName !== "Hecho");
  const overdue = active.filter(t => t.dueDate && daysUntil(t.dueDate) < 0);
  const today = active.filter(t => t.dueDate && daysUntil(t.dueDate) === 0);
  const q1 = active.filter(t => getQ(t) === "Q1");
  const member = memberId!=null ? members.find(m=>m.id===memberId) : null;

  const parts = [];
  parts.push(member ? `Buenos días, ${member.name.split(" ")[0]}.` : "Resumen general del equipo.");
  parts.push(`Tienes ${active.length} ${active.length===1?"tarea activa":"tareas activas"} en ${projects.length} ${projects.length===1?"proyecto":"proyectos"}.`);

  if(overdue.length>0){
    parts.push(`${overdue.length} ${overdue.length===1?"está vencida":"están vencidas"}: ${overdue.slice(0,3).map(t=>t.title).join("; ")}${overdue.length>3?"…":""}.`);
  }
  if(today.length>0){
    parts.push(`Hoy vencen ${today.length}: ${today.slice(0,3).map(t=>t.title).join("; ")}${today.length>3?"…":""}.`);
  }
  if(q1.length>0){
    parts.push(`En el cuadrante urgente e importante tienes ${q1.length}.`);
  } else if(overdue.length===0 && today.length===0){
    parts.push("No hay incendios activos. Buen momento para atacar las tareas importantes pero no urgentes antes de que se conviertan en Q1.");
  }

  parts.push("Dame una orden o hazme una pregunta: por ejemplo 'crea una tarea urgente en marketing para preparar el newsletter', 'qué tengo para hoy' o 'qué lleva Antonio'.");
  return parts.join(" ");
}

// Briefings por sección
export function buildPlannerBriefing(data, memberId){
  const { boards, members, projects, aiSchedule=[] } = data;
  const all = flatTasks(boards, projects);
  const active = all.filter(t => t.colName !== "Hecho");
  const unscheduled = active.filter(t => !aiSchedule.some(s => s.taskId === t.id));
  const mine = memberId!=null ? active.filter(t => (t.assignees||[]).includes(memberId)) : active;
  const withICS = members.filter(m => m.avail?.icsUrl);
  const parts = ["Estás en el planificador IA."];
  parts.push(`${active.length} tareas activas, ${unscheduled.length} sin planificar.`);
  if(memberId!=null) parts.push(`Tú tienes ${mine.length} asignadas.`);
  if(withICS.length>0) parts.push(`${withICS.length} ${withICS.length===1?"miembro sincroniza":"miembros sincronizan"} Google Calendar.`);
  if(unscheduled.length>0) parts.push("Te recomiendo pulsar 'Replanificar' para que el motor asigne los huecos respetando calendarios y mañanas bloqueadas.");
  else parts.push("Todo planificado. Si añades nuevas tareas urgentes, repite la planificación.");
  parts.push("Puedes pedirme: 'cuántas vencidas hay', 'resumen', 'qué lleva Antonio'.");
  return parts.join(" ");
}

export function buildEisenhowerBriefing(data, memberId){
  const all = flatTasks(data.boards, data.projects);
  const mine = memberId!=null ? all.filter(t => (t.assignees||[]).includes(memberId)) : all;
  const active = mine.filter(t => t.colName !== "Hecho");
  const q = { Q1:0, Q2:0, Q3:0, Q4:0 };
  active.forEach(t => q[getQ(t)]++);
  const parts = ["Estás en la matriz Eisenhower."];
  parts.push(`Q1 (urgente-importante): ${q.Q1}. Q2 (importante): ${q.Q2}. Q3 (urgente-poco importante): ${q.Q3}. Q4: ${q.Q4}.`);
  if(q.Q1 > 3) parts.push("Demasiados incendios en Q1 — eso indica que se está reaccionando, no planificando. Intenta mover trabajo a Q2.");
  else if(q.Q1 === 0 && q.Q2 > 0) parts.push("Bien: sin urgencias y con Q2 claro. Aprovecha para ejecutar calidad.");
  if(q.Q3 > q.Q2) parts.push("Tienes más Q3 que Q2: plantéate delegar o recortar alcance de esas tareas urgentes poco importantes.");
  parts.push("Dime 'abre una tarea urgente' y te llevo directo.");
  return parts.join(" ");
}

export function buildReportsBriefing(data){
  const all = flatTasks(data.boards, data.projects);
  const totalLogged = all.reduce((s,t)=>s + ((t.timeLogs||[]).reduce((a,l)=>a+l.seconds,0)/3600), 0);
  const totalEst = all.reduce((s,t)=>s + (t.estimatedHours||0), 0);
  const over = all.filter(t => {
    const logged = (t.timeLogs||[]).reduce((a,l)=>a+l.seconds,0)/3600;
    return t.estimatedHours>0 && logged > t.estimatedHours * 1.2;
  });
  const parts = ["Estás en reportes de tiempo."];
  parts.push(`Total registrado: ${totalLogged.toFixed(1)} horas sobre ${totalEst.toFixed(0)} estimadas.`);
  if(over.length>0) parts.push(`${over.length} tareas van por encima del presupuesto — revisa si amplían alcance o hubo mala estimación.`);
  else parts.push("Ninguna tarea excede presupuesto. Buen control de estimaciones.");
  parts.push("Dime 'qué lleva Marc' o 'resumen' para datos específicos.");
  return parts.join(" ");
}

export function buildProjectsBriefing(data){
  const { projects, boards } = data;
  const perProj = projects.map(p => {
    const cols = boards[p.id] || [];
    const all = cols.flatMap(c => c.tasks.map(t => ({...t, colName:c.name})));
    const active = all.filter(t => t.colName !== "Hecho");
    const overdue = active.filter(t => t.dueDate && daysUntil(t.dueDate) < 0);
    return { p, total: all.length, active: active.length, overdue: overdue.length };
  });
  const worst = [...perProj].sort((a,b)=>b.overdue-a.overdue)[0];
  const parts = [`Estás en la vista de proyectos. Tienes ${projects.length}.`];
  if(worst && worst.overdue>0) parts.push(`El que peor está: ${worst.p.name} con ${worst.overdue} vencidas.`);
  const totals = perProj.reduce((s,x)=>({act:s.act+x.active,ov:s.ov+x.overdue}),{act:0,ov:0});
  parts.push(`Global: ${totals.act} activas, ${totals.ov} vencidas.`);
  parts.push("Dime 'abre el proyecto X' para ir directo, o 'crea una tarea en X'.");
  return parts.join(" ");
}

export function buildUsersBriefing(data){
  const { members, boards, projects } = data;
  const all = flatTasks(boards, projects);
  const loads = members.map(m => ({
    m,
    active: all.filter(t => (t.assignees||[]).includes(m.id) && t.colName!=="Hecho").length,
  })).sort((a,b)=>b.active-a.active);
  const parts = [`Estás en usuarios. ${members.length} miembros en el sistema.`];
  if(loads[0]) parts.push(`Más cargado: ${loads[0].m.name} con ${loads[0].active} tareas activas.`);
  if(loads.length>1 && loads[loads.length-1].active === 0) parts.push(`${loads[loads.length-1].m.name} no tiene ninguna asignada.`);
  parts.push("Puedes pedirme 'qué lleva Antonio' para ver sus tareas.");
  return parts.join(" ");
}

export function buildTeamBriefing(data, projectId){
  const proj = data.projects.find(p => p.id === projectId);
  if(!proj) return "Vista de equipo.";
  const board = data.boards[projectId] || [];
  const all = board.flatMap(c => c.tasks);
  const parts = [`Equipo del proyecto ${proj.name}: ${proj.members.length} ${proj.members.length===1?"miembro":"miembros"}.`];
  const loads = proj.members.map(mid => {
    const m = data.members.find(x=>x.id===mid);
    const n = all.filter(t => (t.assignees||[]).includes(mid)).length;
    return { m, n };
  }).sort((a,b)=>b.n-a.n);
  if(loads[0]) parts.push(`${loads[0].m?.name} lleva ${loads[0].n} tareas en este proyecto.`);
  parts.push("Dime 'qué lleva X' para detalle por persona.");
  return parts.join(" ");
}

export function buildWorkspacesBriefing(data){
  const ws = data.workspaces || [];
  const parts = [`Vista de workspaces. Tienes ${ws.length}.`];
  if(ws.length>0){
    const names = ws.slice(0,3).map(w=>w.name).join(", ");
    parts.push(`Los primeros: ${names}.`);
  }
  parts.push("Los workspaces agrupan proyectos por cliente o contexto.");
  return parts.join(" ");
}

export function buildAgentsBriefing(data){
  const ag = data.agents || [];
  if(ag.length===0) return "Aún no has creado ningún agente IA. Aquí puedes definir asesores especializados — abogados, marketers, analistas — y luego conectarlos a tareas concretas para que te aconsejen según su perfil.";
  const names = ag.slice(0,4).map(a=>a.name).join(", ");
  const parts = [`Tienes ${ag.length} agente${ag.length===1?"":"s"} IA: ${names}.`];
  const specs = [...new Set(ag.flatMap(a=>a.specialties||[]))].slice(0,4);
  if(specs.length>0) parts.push(`Especialidades cubiertas: ${specs.join(", ")}.`);
  parts.push("Abre una tarea y selecciona el agente que encaje con la situación para recibir consejo experto.");
  return parts.join(" ");
}

// Dispatcher context-aware
export function buildContextBriefing(scope, data, { activeMemberId, activeProjectId }){
  switch(scope){
    case "board":       return buildBoardBriefing(data.projects.find(p=>p.id===activeProjectId), data.boards[activeProjectId]||[], data.members);
    case "planner":     return buildPlannerBriefing(data, activeMemberId);
    case "eisenhower":  return buildEisenhowerBriefing(data, activeMemberId);
    case "reports":     return buildReportsBriefing(data);
    case "projects":    return buildProjectsBriefing(data);
    case "users":       return buildUsersBriefing(data);
    case "team":        return buildTeamBriefing(data, activeProjectId);
    case "workspaces":  return buildWorkspacesBriefing(data);
    case "agents":      return buildAgentsBriefing(data);
    case "dashboard":
    case "global":
    default:            return buildDailyBriefing(data, activeMemberId);
  }
}

// Briefing de tablero/proyecto
export function buildBoardBriefing(project, board, members){
  const all = board.flatMap(col => col.tasks.map(t => ({...t, colName: col.name})));
  const active = all.filter(t => t.colName !== "Hecho");
  const done = all.filter(t => t.colName === "Hecho");
  const overdue = active.filter(t => t.dueDate && daysUntil(t.dueDate) < 0);
  const q1 = active.filter(t => getQ(t) === "Q1");
  const colLoad = board.map(c => `${c.name}: ${c.tasks.filter(t=>c.name!=="Hecho").length}`).filter(x=>!x.includes(": 0")).join(", ");

  const parts = [];
  parts.push(`Proyecto ${project.name}.`);
  parts.push(`${active.length} tareas activas, ${done.length} completadas.`);
  if(colLoad) parts.push(`Carga por columna: ${colLoad}.`);
  if(overdue.length>0) parts.push(`${overdue.length} vencidas — priorízalas.`);
  if(q1.length>0) parts.push(`${q1.length} en Q1 urgente-importante.`);
  if(overdue.length===0 && q1.length===0) parts.push("El tablero no tiene rojos. Buen momento para Q2.");

  parts.push("Puedes pedirme: 'crea una tarea en Por hacer llamada X', 'qué columna está más cargada', o 'cuántas tengo vencidas'.");
  return parts.join(" ");
}

// Busca proyecto por referencia textual
function findProject(projects, text){
  const t = text.toLowerCase();
  for(const p of projects){
    if(t.includes(p.name.toLowerCase())) return p;
  }
  // palabras significativas
  for(const p of projects){
    const words = p.name.toLowerCase().split(/\s+/).filter(w=>w.length>3);
    if(words.some(w => t.includes(w))) return p;
  }
  return null;
}

function findColumn(board, text){
  const t = text.toLowerCase();
  for(const c of board){
    if(t.includes(c.name.toLowerCase())) return c;
  }
  if(/\b(hecho|completad|terminad)/.test(t)) return board.find(c=>/hecho/i.test(c.name));
  if(/\b(progreso|curso|haciendo)/.test(t)) return board.find(c=>/progreso|curso/i.test(c.name));
  if(/\b(por hacer|pendiente|backlog|todo)/.test(t)) return board.find(c=>/por hacer|pendiente|backlog|todo/i.test(c.name));
  return null;
}

// Parser para comandos de ámbito global/tablero.
// scope: "global" | "board". En "board" pasas activeProject; en "global" pasa projects.
export function parseScopedCommand(text, { scope, projects, board }){
  if(!text) return null;
  const t = text.toLowerCase().trim().replace(/\s+/g," ");

  // CREAR TAREA
  if(/\b(crea|crear|a[ñn]ade|a[ñn]adir|agrega|nueva)\b.*\btareas?\b/.test(t) && !/\bsub\s?tarea/.test(t)){
    const title = extractAfter(text, ["tarea","tareas","llamada","llamado","sobre","para","titulada","titulado"]);
    if(title){
      const priority = parsePriority(t);
      const date = parseDate(t);
      let projectId = null, colId = null;
      if(scope === "global" && projects){
        const p = findProject(projects, text);
        if(p) projectId = p.id;
      }
      if(scope === "board" && board){
        const c = findColumn(board, text);
        if(c) colId = c.id;
      }
      // Limpia la porción de proyecto/columna/prioridad del título
      let cleanTitle = title;
      if(projects){ for(const p of projects){ cleanTitle = cleanTitle.replace(new RegExp(`\\b(en |del |proyecto )?${p.name}\\b`,"ig"),"").trim(); } }
      if(board){ for(const c of board){ cleanTitle = cleanTitle.replace(new RegExp(`\\b(en |columna )?${c.name}\\b`,"ig"),"").trim(); } }
      cleanTitle = cleanTitle.replace(/\b(urgente|alta|media|baja|cr[ií]tica|importante)\b/ig,"").trim();
      cleanTitle = cleanTitle.replace(/\b(para hoy|para ma[ñn]ana|hoy|ma[ñn]ana)\b/ig,"").trim();
      cleanTitle = cleanTitle.replace(/\s+/g," ").replace(/^[,\s-]+|[,\s-]+$/g,"");
      if(!cleanTitle) cleanTitle = title;
      return { type:"createTask", title: cleanTitle, priority, date, projectId, colId };
    }
  }

  // ABRIR TAREA (se comprueba ANTES que listar — para que "muéstrame la tarea X" abra, no liste)
  if(/\b(abre|abrir|[aá]breme|abreme|muestr[ae]me|ens[eé]ñame|dame|tr[aá]eme|quiero ver|ver|ve a|ir a|entra en)\b[^.]*\b(la|una|esa|esta|aquella|otra|primera|siguiente|pr[oó]xima|[uú]ltima)?\s*tarea\b/.test(t)
     && !/\bsub\s?tarea/.test(t)){
    return { type:"openTask", ref: text };
  }

  // CREAR SUBTAREA desde scope global/board — guía al usuario
  if(/\b(crea|crear|a[ñn]ade|a[ñn]adir|agrega|agregar|nueva)\b.*\bsub\s?tareas?\b/.test(t)){
    return { type:"subtaskHint" };
  }

  // LISTAR MIS TAREAS / tareas de X
  if(/\b(qu[eé] tengo|mis tareas|tareas m[ií]as|muestr[ae]me mis|lista|listame|enuncia)\b/.test(t) || /\b(qu[eé] lleva|tareas de|tareas que tiene)\b/.test(t)){
    return { type:"listTasks", ref: text };
  }

  // VENCIDAS / HOY
  if(/\b(vencidas?|atrasadas?)\b/.test(t)){
    return { type:"listOverdue" };
  }
  if(/\b(para hoy|de hoy|vencen hoy|hoy)\b/.test(t) && /\b(qu[eé]|tengo|tareas|muestr)/.test(t)){
    return { type:"listToday" };
  }

  // CUÁNTAS / RESUMEN
  if(/\b(cu[aá]ntas|resumen|cu[aá]nto hay|estado general|briefing)\b/.test(t)){
    return { type:"summary" };
  }

  // COLUMNA MÁS CARGADA (board)
  if(scope === "board" && /\b(columna|m[aá]s cargad|saturad)/.test(t)){
    return { type:"boardLoad" };
  }

  // CAMBIAR DE PROYECTO
  if(scope === "global" && /\b(abre|muestra|ve a|ir a|cambia a|ens[eé]ñame)\b.*\b(proyecto|tablero)\b/.test(t)){
    return { type:"openProject", ref: text };
  }

  return null;
}

export function respondScopedQuery(text, { scope, data, memberId, project, board, members }){
  const cmdLess = text.toLowerCase();
  if(/\b(detente|para|silencio|gracias|vale)\b/.test(cmdLess)) return "Hecho. Llámame cuando me necesites.";
  if(/\b(resumen|repite|briefing)\b/.test(cmdLess)){
    if(scope==="global") return buildDailyBriefing(data, memberId);
    if(scope==="board") return buildBoardBriefing(project, board, members);
  }
  return "No te he entendido. Prueba: 'crea una tarea…', 'qué tengo hoy', 'cuántas vencidas', 'resumen'.";
}

// Ejecuta comando de ámbito global/tablero. Devuelve { data, msg } o { msg, hint }.
export function executeScopedCommand(cmd, { scope, data, activeProjectId, activeMemberId }){
  if(!cmd) return null;
  const { boards, projects, members } = data;

  if(cmd.type === "createTask"){
    // Determinar proyecto destino
    let projectId = cmd.projectId;
    if(projectId == null) projectId = scope==="board" ? activeProjectId : (projects[0]?.id);
    if(projectId == null) return { msg: "No sé en qué proyecto crear la tarea. Dime el nombre del proyecto." };
    const proj = projects.find(p=>p.id===projectId);
    const cols = boards[projectId] || [];
    if(cols.length === 0) return { msg: "El proyecto no tiene columnas." };
    // Columna destino: la primera que no sea Hecho, o la que haya indicado
    let col = cmd.colId ? cols.find(c=>c.id===cmd.colId) : null;
    if(!col) col = cols.find(c => c.name !== "Hecho") || cols[0];

    const newTask = {
      id: "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2,4),
      title: cmd.title,
      tags: [], assignees: activeMemberId!=null ? [activeMemberId] : [],
      priority: cmd.priority || "media",
      startDate: fmt(new Date()),
      dueDate: cmd.date || "",
      estimatedHours: 0, timeLogs: [], desc: "", comments: [], subtasks: [],
    };
    const newBoards = {
      ...boards,
      [projectId]: cols.map(c => c.id===col.id ? {...c, tasks:[...c.tasks, newTask]} : c),
    };
    return {
      data: { ...data, boards: newBoards },
      msg: `Tarea creada: ${cmd.title}, en ${proj.name}, columna ${col.name}${cmd.priority?`, prioridad ${cmd.priority}`:""}${cmd.date?`, vence ${cmd.date}`:""}.`,
    };
  }

  if(cmd.type === "listTasks"){
    const all = flatTasks(boards, projects);
    const member = findMemberByName(members, cmd.ref);
    const targetId = member ? member.id : activeMemberId;
    const mine = all.filter(t => (t.assignees||[]).includes(targetId) && t.colName !== "Hecho");
    if(mine.length===0) return { msg: `${member?member.name:"No"} tiene tareas activas.` };
    const top = mine.slice(0,5).map(t=>t.title).join("; ");
    return { msg: `${member?member.name:"Tú"} ${mine.length===1?"tiene":"tiene"} ${mine.length} tareas activas. Las primeras: ${top}.` };
  }

  if(cmd.type === "listOverdue"){
    const all = flatTasks(boards, projects);
    const tasks = all.filter(t => t.colName!=="Hecho" && t.dueDate && daysUntil(t.dueDate)<0);
    if(tasks.length===0) return { msg: "No hay tareas vencidas. Bien." };
    return { msg: `${tasks.length} vencidas: ${tasks.slice(0,4).map(t=>`${t.title} en ${t.projectName}`).join("; ")}.` };
  }

  if(cmd.type === "listToday"){
    const all = flatTasks(boards, projects);
    const tasks = all.filter(t => t.colName!=="Hecho" && t.dueDate && daysUntil(t.dueDate)===0);
    if(tasks.length===0) return { msg: "No vence nada hoy." };
    return { msg: `Hoy vencen ${tasks.length}: ${tasks.slice(0,4).map(t=>t.title).join("; ")}.` };
  }

  if(cmd.type === "summary"){
    if(scope==="board"){
      const project = projects.find(p=>p.id===activeProjectId);
      return { msg: buildBoardBriefing(project, boards[activeProjectId], members) };
    }
    return { msg: buildDailyBriefing(data, activeMemberId) };
  }

  if(cmd.type === "boardLoad"){
    const cols = boards[activeProjectId] || [];
    const active = cols.filter(c => c.name !== "Hecho");
    if(active.length===0) return { msg: "No hay columnas activas." };
    const sorted = [...active].sort((a,b)=>b.tasks.length-a.tasks.length);
    return { msg: `Más cargada: ${sorted[0].name} con ${sorted[0].tasks.length} tareas. ${sorted.slice(1,3).map(c=>`${c.name}: ${c.tasks.length}`).join(", ")}.` };
  }

  if(cmd.type === "subtaskHint"){
    return { msg: "Las subtareas se crean dentro de una tarea concreta. Primero dime 'abre la tarea X' y luego en el asesor de la tarea pídeme 'crea la subtarea Y'." };
  }

  if(cmd.type === "openProject"){
    const p = findProject(projects, cmd.ref);
    if(!p) return { msg: "No he identificado el proyecto." };
    return { msg: `Abriendo ${p.name}.`, hint:{ type:"openProject", projectId: p.id } };
  }

  if(cmd.type === "openTask"){
    const all = flatTasks(boards, projects);
    const refLower = (cmd.ref||"").toLowerCase();
    // Candidatos activos (no Hecho)
    let candidates = all.filter(t => t.colName !== "Hecho");
    // Filtro por asignado: si menciona un nombre concreto
    const refMember = findMemberByName(members, cmd.ref);
    if(refMember) candidates = candidates.filter(t => (t.assignees||[]).includes(refMember.id));
    else if(activeMemberId!=null && /\b(mi|mis|m[ií]a|m[ií]as|tengo|para m[ií])\b/.test(refLower)){
      candidates = candidates.filter(t => (t.assignees||[]).includes(activeMemberId));
    }
    // Filtro por proyecto si se menciona
    const refProj = findProject(projects, cmd.ref);
    if(refProj) candidates = candidates.filter(t => t.projectId === refProj.id);
    // Filtro por urgencia
    if(/\b(urgente|cr[ií]tica|q1|ahora)\b/.test(refLower)) candidates = candidates.filter(t => getQ(t)==="Q1");
    if(/\b(hoy)\b/.test(refLower)) candidates = candidates.filter(t => t.dueDate && daysUntil(t.dueDate)===0);
    if(/\b(vencidas?|atrasadas?)\b/.test(refLower)) candidates = candidates.filter(t => t.dueDate && daysUntil(t.dueDate)<0);

    // Match por palabras del título: quita stop-words y busca overlap
    const stop = new Set(["la","el","una","un","de","del","sobre","para","tarea","tareas","activa","activas","abre","abrir","muestra","muéstrame","muestrame","enseñame","ensename","ver","ir","a","que","y","en","por","mi","mis"]);
    const refWords = refLower.split(/[^a-záéíóúñü0-9]+/i).filter(w=>w.length>3 && !stop.has(w));
    if(refWords.length > 0){
      const scored = candidates.map(t => {
        const title = t.title.toLowerCase();
        const score = refWords.reduce((s,w)=> s + (title.includes(w)?1:0), 0);
        return { t, score };
      }).filter(x => x.score > 0).sort((a,b)=>b.score-a.score);
      if(scored.length > 0) candidates = scored.map(x => x.t);
    }

    if(candidates.length === 0) return { msg: "No encuentro ninguna tarea activa que encaje. Dime el título o la persona asignada." };

    // Ordena por urgencia: Q1 primero, luego por fecha
    const qOrder = { Q1:0, Q2:1, Q3:2, Q4:3 };
    candidates.sort((a,b)=>{
      const qa = qOrder[getQ(a)], qb = qOrder[getQ(b)];
      if(qa!==qb) return qa-qb;
      return daysUntil(a.dueDate) - daysUntil(b.dueDate);
    });
    const pick = candidates[0];
    return {
      msg: `Abro la tarea: ${pick.title}, en el proyecto ${pick.projectName}.`,
      hint: { type:"openTask", projectId: pick.projectId, taskId: pick.id },
    };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM (Anthropic) — conversación real con el agente usando su promptBase
// ═══════════════════════════════════════════════════════════════════════════

// LLM corre a través del proxy /api/agent (Vercel function con ANTHROPIC_API_KEY).
// El usuario no ve ni configura ninguna key.

import { formatCeoMemoryForPrompt } from "./memory.js";

function buildTaskContext(task, members){
  const q = getQ(task);
  const d = daysUntil(task.dueDate);
  const logged = ((task.timeLogs||[]).reduce((s,l)=>s+l.seconds,0)/3600);
  const est = task.estimatedHours||0;
  const subs = task.subtasks||[];
  const assignees = (task.assignees||[]).map(id=>(members||[]).find(m=>m.id===id)?.name||"?").join(", ")||"—";
  const comments = task.comments||[];
  const commentsBlock = comments.length
    ? "COMENTARIOS RECIENTES (últimos 10):\n" + comments.slice(-10).map(c=>{
        const author = (members||[]).find(m=>m.id===c.author)?.name || "?";
        return `- ${author} (${c.time||"sin fecha"}): ${c.text||""}`;
      }).join("\n")
    : "COMENTARIOS: ninguno";
  return [
    `Título: ${task.title}`,
    task.desc ? `Descripción: ${task.desc}` : null,
    `Prioridad Eisenhower: ${q}`,
    task.dueDate ? `Fecha límite: ${task.dueDate} (${d<0?`vencida hace ${-d} días`:d===0?"hoy":`en ${d} días`})` : "Sin fecha límite",
    est>0 ? `Tiempo: ${logged.toFixed(1)}h registradas de ${est}h estimadas` : `Tiempo registrado: ${logged.toFixed(1)}h (sin estimación)`,
    subs.length ? `Subtareas: ${subs.filter(s=>s.done).length}/${subs.length} hechas` : "Sin subtareas",
    `Responsables: ${assignees}`,
    commentsBlock,
  ].filter(Boolean).join("\n");
}

export async function llmAgentReply(userText, task, agent, members, history, ceoMemory){
  const memBlock = formatCeoMemoryForPrompt(ceoMemory);
  const systemPrompt = [
    agent.promptBase || `Eres ${agent.name}, ${agent.role||"asesor profesional"}.`,
    "",
    "ESTILO DE RESPUESTA:",
    "- Responde en español, tono profesional pero cercano.",
    "- Máximo 4-5 frases. Sé concreto y útil.",
    "- Si la pregunta es ambigua, pide la aclaración mínima imprescindible.",
    "- Cita normativa/artículos cuando aplique.",
    PLAIN_TEXT_RULE,
    memBlock ? "\n---\n" + memBlock : null,
    "",
    "CONTEXTO DE LA TAREA ACTUAL:",
    buildTaskContext(task, members),
  ].filter(x=>x!==null).join("\n");

  const messages = [];
  (history||[]).slice(-8).forEach(m=>{
    messages.push({ role: m.role==="user"?"user":"assistant", content: m.text });
  });
  messages.push({ role:"user", content: userText });

  const res = await fetch("/api/agent", {
    method:"POST",
    headers:{ "content-type":"application/json" },
    body: JSON.stringify({ system: systemPrompt, messages, max_tokens: 600 }),
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok){
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return stripMarkdown(data.text || "") || "(respuesta vacía del modelo)";
}

// Análisis de documento adjunto por un agente IA.
// attachment = { kind:"pdf"|"image"|"text", media_type?, data?, text?, name? }
// contextLabel = "la negociación X" / "la tarea Y" para situar al modelo.
// Devuelve { summary, details, recommendations } tal como los pidió el prompt.
export async function analyzeDocument(attachment, agent, contextLabel, ceoMemory){
  const memBlock = formatCeoMemoryForPrompt(ceoMemory);
  const systemPrompt = [
    agent.promptBase || `Eres ${agent.name}, ${agent.role||"analista profesional"}.`,
    "",
    "ESTILO DE RESPUESTA:",
    "- Responde en español, tono profesional y preciso.",
    "- Estructura en tres bloques claros separados por líneas en blanco:",
    "  RESUMEN EJECUTIVO: ...",
    "  RIESGOS Y OPORTUNIDADES: ...",
    "  RECOMENDACIONES CONCRETAS: ...",
    PLAIN_TEXT_RULE,
    memBlock ? "\n---\n" + memBlock : null,
  ].filter(x=>x!==null).join("\n");
  const prompt = `Analiza este documento en el contexto de ${contextLabel||"el caso actual"}. Da un resumen ejecutivo, identifica riesgos y oportunidades, y lista recomendaciones concretas.`;
  const body = {
    system: systemPrompt,
    messages: [{ role:"user", content: prompt }],
    attachments: [attachment],
    max_tokens: 4000,
  };
  const res = await fetch("/api/agent", {
    method:"POST",
    headers:{ "content-type":"application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  const text = stripMarkdown(data.text || "") || "(sin respuesta)";
  return parseAnalysisReport(text);
}

// Auto-aprendizaje silencioso: segunda llamada al LLM tras una respuesta
// del agente para extraer datos que valga la pena recordar permanentemente.
// recentMessages = últimos 4-6 mensajes del chat ([{role, content}]).
// Devuelve { ceoPreferences:[], keyFacts:[], decisions:[], lessons:[],
//   negKeyFacts:[], negAgreements:[], negRedFlags:[] } con strings cortas.
// Silencioso: si falla el parse, devuelve arrays vacíos; nunca lanza.
export async function extractMemoryFromChat(recentMessages, negTitle){
  const system = [
    "Eres un extractor de memoria silencioso. Analizas conversaciones y",
    "extraes datos objetivos y estables que conviene recordar a futuro.",
    "",
    "Reglas estrictas:",
    "- Solo extrae información duradera: preferencias del usuario, hechos",
    "  factuales, decisiones tomadas, lecciones aprendidas, acuerdos,",
    "  red flags. NUNCA: estados emocionales pasajeros, saludos, opiniones",
    "  triviales, cortesías.",
    "- Cada item: frase breve (<15 palabras), tono neutro, en español,",
    "  sin markdown, sin comillas, sin puntos finales.",
    "- Si nada es digno de recordar, devuelve todos los arrays vacíos.",
    "- Responde ÚNICAMENTE con JSON válido, sin prosa, sin markdown.",
    "",
    "Formato exacto:",
    `{"ceoPreferences":[],"keyFacts":[],"decisions":[],"lessons":[],"negKeyFacts":[],"negAgreements":[],"negRedFlags":[]}`,
  ].join("\n");
  const convo = (recentMessages||[]).slice(-4).map(m=>{
    const who = m.role==="user" ? "Usuario" : "Agente";
    return `${who}: ${m.content||""}`;
  }).join("\n\n");
  const userPrompt = (negTitle ? `Negociación en curso: ${negTitle}\n\n` : "")
    + "Conversación reciente:\n\n" + convo
    + "\n\nExtrae solo lo que realmente merezca recordarse. Si no hay nada nuevo, devuelve todos los arrays vacíos.";
  const empty = { ceoPreferences:[], keyFacts:[], decisions:[], lessons:[], negKeyFacts:[], negAgreements:[], negRedFlags:[] };
  try {
    const res = await fetch("/api/agent", {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body: JSON.stringify({ system, messages:[{role:"user",content:userPrompt}], max_tokens:500 }),
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) return empty;
    const text = data.text || "";
    const m = text.match(/\{[\s\S]*\}/);
    if(!m) return empty;
    const parsed = JSON.parse(m[0]);
    // Normaliza: fuerza arrays de strings no vacías.
    const clean = {};
    for(const k of Object.keys(empty)){
      const arr = Array.isArray(parsed[k]) ? parsed[k] : [];
      clean[k] = arr.map(s=>String(s||"").trim()).filter(s=>s.length>=3 && s.length<=200);
    }
    return clean;
  } catch {
    return empty;
  }
}

function parseAnalysisReport(text){
  const sections = { summary:"", details:"", recommendations:"" };
  const blocks = text.split(/\n(?=[A-ZÁÉÍÓÚÑ ]{3,}:)/);
  blocks.forEach(b=>{
    const m = b.match(/^([A-ZÁÉÍÓÚÑ ]+):\s*([\s\S]*)$/);
    if(!m) return;
    const label = m[1].trim();
    const content = m[2].trim();
    if(/RESUMEN/i.test(label)) sections.summary = content;
    else if(/RIESGO|OPORTUNIDAD/i.test(label)) sections.details = content;
    else if(/RECOMEND/i.test(label)) sections.recommendations = content;
  });
  // Si el LLM no cumplió el formato, mete todo en summary.
  if(!sections.summary && !sections.details && !sections.recommendations){
    sections.summary = text;
  }
  return sections;
}
