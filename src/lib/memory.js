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

export function createMemoryItem(text, source = "manual", meta = null){
  const base = {
    id: "mem_"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
    text: String(text||"").trim(),
    source,
    createdAt: new Date().toISOString(),
  };
  // Metadata opcional (usado por decisiones auto-learn: negotiationId +
  // negotiationTitle para poder navegar de vuelta al contexto origen).
  if(meta && typeof meta === "object"){
    if(meta.negotiationId)    base.negotiationId    = meta.negotiationId;
    if(meta.negotiationTitle) base.negotiationTitle = meta.negotiationTitle;
  }
  return base;
}

// Normaliza texto para deduplicación: minúsculas, sin acentos, sin
// puntuación, espacios colapsados.
function normalize(s){
  return String(s||"")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^\w\s]/g," ")
    .replace(/\s+/g," ")
    .trim();
}

// Similitud Jaccard sobre conjuntos de palabras: |A∩B| / |A∪B|.
// 1.0 = idénticas; 0.8 = 80% de solapamiento. Pensado para frases cortas.
export function jaccardSimilarity(a, b){
  const wa = new Set(normalize(a).split(/\s+/).filter(w=>w.length>=3));
  const wb = new Set(normalize(b).split(/\s+/).filter(w=>w.length>=3));
  if(wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  wa.forEach(w => { if(wb.has(w)) inter++; });
  const union = wa.size + wb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Detecta duplicados con doble criterio:
// (a) Includes bidireccional sobre strings normalizadas (pilla
//     "preferí JV" vs "preferí JV contractual" — uno contiene al otro).
// (b) Jaccard ≥ 0.8 (pilla reformulaciones con 80%+ de palabras en
//     común aunque ninguna contenga a la otra literalmente).
export function findSimilar(list, text, threshold = 0.8){
  const n = normalize(text);
  if(!n || n.length<4) return null;
  return (list||[]).find(item=>{
    const ni = normalize(item.text);
    if(!ni) return false;
    if(ni===n) return true;
    if(ni.length>=8 && n.includes(ni)) return true;
    if(n.length>=8 && ni.includes(n)) return true;
    return jaccardSimilarity(item.text, text) >= threshold;
  }) || null;
}

// Devuelve {list, added} — added=true si el texto se añadió (no era dup).
// meta: metadata opcional que se añade al item creado (negotiationId, etc.).
export function addUnique(list, text, source = "manual", meta = null){
  const trimmed = String(text||"").trim();
  if(!trimmed) return { list: list||[], added: false };
  const dup = findSimilar(list, trimmed);
  if(dup) return { list: list||[], added: false };
  return { list: [...(list||[]), createMemoryItem(trimmed, source, meta)], added: true };
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
