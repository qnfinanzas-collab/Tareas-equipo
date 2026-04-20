// Asesor IA rule-based — briefings y respuestas por categoría, sin API.
import { getQ } from "./eisenhower.js";
import { daysUntil } from "./date.js";

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
