// Memoria permanente del CEO y de cada negociación. La estructura vive
// en data.ceoMemory (global) y negotiation.memory (por negociación).
// Cada entrada: { id, text, source: "manual"|"auto", createdAt }.

export const CEO_MEMORY_KEYS = ["preferences","keyFacts","decisions","lessons"];
export const NEG_MEMORY_KEYS = ["keyFacts","agreements","redFlags"];
export const MEMORY_PROMPT_CAP = 30; // máx items por categoría inyectados al LLM

export function emptyCeoMemory(){
  return { preferences:[], keyFacts:[], decisions:[], lessons:[], updatedAt:null };
}
export function emptyNegMemory(){
  return { keyFacts:[], agreements:[], redFlags:[], chatSummaries:[], updatedAt:null };
}

export function createMemoryItem(text, source = "manual"){
  return {
    id: "mem_"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
    text: String(text||"").trim(),
    source,
    createdAt: new Date().toISOString(),
  };
}

// Normaliza texto para deduplicación: minúsculas, sin acentos, sin
// puntuación, espacios colapsados. No busca match exacto — usa includes
// bidireccional: si uno contiene al otro, se considera duplicado.
function normalize(s){
  return String(s||"")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^\w\s]/g," ")
    .replace(/\s+/g," ")
    .trim();
}
export function findSimilar(list, text){
  const n = normalize(text);
  if(!n || n.length<4) return null;
  return (list||[]).find(item=>{
    const ni = normalize(item.text);
    if(!ni) return false;
    return ni===n || (ni.length>=8 && n.includes(ni)) || (n.length>=8 && ni.includes(n));
  }) || null;
}

// Devuelve {list, added} — added=true si el texto se añadió (no era dup).
export function addUnique(list, text, source = "manual"){
  const trimmed = String(text||"").trim();
  if(!trimmed) return { list: list||[], added: false };
  const dup = findSimilar(list, trimmed);
  if(dup) return { list: list||[], added: false };
  return { list: [...(list||[]), createMemoryItem(trimmed, source)], added: true };
}

// Formatea la memoria del CEO como bloque para inyectar en system prompt.
// Solo incluye secciones no vacías. Capa a MEMORY_PROMPT_CAP items por
// sección (los más recientes) para no explotar el contexto.
export function formatCeoMemoryForPrompt(ceo){
  if(!ceo) return "";
  const sections = [
    ["PREFERENCIAS DEL CEO", ceo.preferences],
    ["HECHOS CLAVE",         ceo.keyFacts],
    ["DECISIONES ANTERIORES",ceo.decisions],
    ["LECCIONES APRENDIDAS", ceo.lessons],
  ];
  const parts = [];
  sections.forEach(([label, items])=>{
    const arr = (items||[]).slice(-MEMORY_PROMPT_CAP);
    if(arr.length===0) return;
    parts.push(`${label}:`);
    arr.forEach(m=>parts.push(`- ${m.text}`));
  });
  if(parts.length===0) return "";
  return "MEMORIA PERMANENTE DEL CEO:\n" + parts.join("\n");
}

// Igual pero para memoria de una negociación concreta.
export function formatNegMemoryForPrompt(neg){
  if(!neg) return "";
  const sections = [
    ["HECHOS CLAVE DE LA NEGOCIACIÓN", neg.keyFacts],
    ["ACUERDOS ALCANZADOS",            neg.agreements],
    ["RED FLAGS DETECTADAS",           neg.redFlags],
  ];
  const parts = [];
  sections.forEach(([label, items])=>{
    const arr = (items||[]).slice(-MEMORY_PROMPT_CAP);
    if(arr.length===0) return;
    parts.push(`${label}:`);
    arr.forEach(m=>parts.push(`- ${m.text}`));
  });
  if(parts.length===0) return "";
  return "MEMORIA DE ESTA NEGOCIACIÓN:\n" + parts.join("\n");
}
