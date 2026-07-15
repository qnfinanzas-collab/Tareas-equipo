// hectorContext — helpers puros para construir contexto ampliado del prompt
// de Héctor (MNT-009 Fase 2, Camino B-scoped, 15/07/2026).
//
// Bug de raíz: HectorDirectView solo pasaba a Héctor las tareas urgentes o
// de alta prioridad (tope 15). Cuando el CEO creaba una tarea normal
// (priority media) y luego la mencionaba, Héctor no la veía en el contexto
// y le preguntaba al CEO cosas que ya existían.
//
// Estos helpers añaden dos filtros complementarios al urgentBlock existente:
//   1. RECIENTES — tareas/negociaciones creadas o modificadas en las últimas
//      48 h. Cubre lo que "acaba de pasar" aunque no sea urgente.
//   2. MENCIONADAS — tareas/negociaciones del proyecto o negociación citado
//      por el CEO en el mensaje actual. Cubre "de qué estamos hablando".
//
// Además provee `buildLinkifyMap` para MNT-009 Fase 2 · Camino B-scoped:
// mapa `code → {kind, id}` precomputado desde el catálogo real del tenant,
// filtrado por visibilidad del member activo. LinkifiedText en ChatBubble
// lo usa para envolver códigos reales en spans clicables sin falsos positivos.
//
// Funciones PURAS: mismo input → mismo output. Testables en Node sin React.

import { filterVisibleProjects, filterVisibleNegotiations } from "./visibility.js";

const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 h

// Detecta menciones a proyectos/negociaciones en el mensaje del CEO.
// Estrategia:
//   1. Codes de proyecto explícitos (MAR, TST, FJU…) — palabra exacta
//      buscada contra data.projects[].code.
//   2. Codes de negociación (NEG-100, NEG-092…) — regex NEG-\d+ validada
//      contra data.negotiations[].code.
//   3. Palabras del nombre de proyecto/negociación (≥5 chars, no genéricas
//      como "cliente", "proyecto", "empresa") matched contra p.name / n.title.
//
// Devuelve `{projectIds:Set, negIds:Set}` — ids nativos para lookup posterior.
export function detectMentionedContext(txt, data, member) {
  const out = { projectIds: new Set(), negIds: new Set() };
  if (!txt || typeof txt !== "string" || !data) return out;

  const projects = filterVisibleProjects(data.projects || [], member);
  const negs     = filterVisibleNegotiations(data.negotiations || [], member);

  const upper = txt.toUpperCase();

  // 1) Codes de proyecto exactos.
  for (const p of projects) {
    if (!p || !p.code) continue;
    const code = String(p.code).toUpperCase();
    if (code.length < 2) continue;
    // Palabra exacta con boundaries — evita matchear "MARBELLA" como "MAR".
    // No usamos \b porque no cuenta guiones; usamos lookaround manual.
    const re = new RegExp(`(?:^|[^A-Z0-9])${escapeRe(code)}(?![A-Z0-9-])`, "i");
    if (re.test(txt)) out.projectIds.add(p.id);
  }

  // 2) Codes de negociación (NEG-\d+ o formato similar del catálogo real).
  const negCodes = new Set(negs.map(n => (n?.code || "").toUpperCase()).filter(c => c));
  const negRegex = /\bNEG-\d+\b/gi;
  let m;
  while ((m = negRegex.exec(upper)) !== null) {
    const code = m[0].toUpperCase();
    if (negCodes.has(code)) {
      const n = negs.find(x => (x?.code || "").toUpperCase() === code);
      if (n) out.negIds.add(n.id);
    }
  }

  // 3) Palabras del nombre de proyecto/negociación (heurística conservadora).
  const words = (txt.match(/[a-záéíóúñü]{5,}/gi) || []).map(w => w.toLowerCase());
  if (words.length === 0) return out;
  const wordSet = new Set(words);
  const STOP = new Set([
    "cliente","clientes","proyecto","proyectos","empresa","empresas","reunion","reunión",
    "tarea","tareas","negocio","negocios","hector","héctor","ahora","antes","despues","después",
    "mañana","hoy","ayer","semana","semanas","mes","meses","año","años","hola","gracias","favor",
    "puedes","puede","cualquier","alguno","alguna","tambien","también","porque","porqué",
  ]);
  const isSignificant = (w) => w && w.length >= 5 && !STOP.has(w);

  for (const p of projects) {
    if (!p || !p.name || out.projectIds.has(p.id)) continue;
    const nameWords = (String(p.name).match(/[a-záéíóúñü]{5,}/gi) || []).map(w => w.toLowerCase()).filter(isSignificant);
    if (nameWords.length === 0) continue;
    // Suficiente con 1 palabra significativa coincidente.
    if (nameWords.some(w => wordSet.has(w))) out.projectIds.add(p.id);
  }

  for (const n of negs) {
    if (!n || out.negIds.has(n.id)) continue;
    const title = String(n.title || "");
    const nameWords = (title.match(/[a-záéíóúñü]{5,}/gi) || []).map(w => w.toLowerCase()).filter(isSignificant);
    if (nameWords.length === 0) continue;
    if (nameWords.some(w => wordSet.has(w))) out.negIds.add(n.id);
  }

  return out;
}

// Recolecta tareas RECIENTES (creadas o modificadas en las últimas 48 h)
// desde data.boards, excluidas las que ya aparecen en excludeIds.
// Ordenadas por recencia descendente. Cada item lleva projectId y projectCode
// para poder rellenar la línea del prompt sin lookups extra.
export function collectRecentTasks(data, excludeIds = new Set(), now = Date.now()) {
  if (!data || !data.boards) return [];
  const cutoff = now - RECENT_WINDOW_MS;
  const projectByPid = new Map((data.projects || []).map(p => [p.id, p]));
  const out = [];
  for (const [pid, cols] of Object.entries(data.boards)) {
    for (const col of (cols || [])) {
      if (!col || col.name === "Hecho") continue;
      for (const t of (col.tasks || [])) {
        if (!t || t.archived) continue;
        if (excludeIds.has(t.id)) continue;
        const ts = Math.max(
          t.updatedAt ? new Date(t.updatedAt).getTime() : 0,
          t.createdAt ? new Date(t.createdAt).getTime() : 0,
        );
        if (!ts || ts < cutoff) continue;
        const p = projectByPid.get(Number(pid));
        out.push({
          id: t.id, title: t.title || "sin título",
          priority: t.priority || "media",
          dueDate: t.dueDate || null,
          projectId: Number(pid),
          projectCode: p?.code || null,
          ts,
        });
      }
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

// Recolecta tareas del proyecto o negociación mencionado por el CEO.
// Trae TODAS las tareas activas de los proyectos matched (sin filtro
// prioridad) + las tareas asociadas a negociaciones matched.
export function collectMentionedTasks(data, mentioned, excludeIds = new Set()) {
  if (!data || !data.boards || !mentioned) return [];
  const projectByPid = new Map((data.projects || []).map(p => [p.id, p]));
  const out = [];
  // Tareas de los proyectos mencionados.
  for (const pid of mentioned.projectIds) {
    const cols = data.boards[pid] || [];
    for (const col of cols) {
      if (!col || col.name === "Hecho") continue;
      for (const t of (col.tasks || [])) {
        if (!t || t.archived || excludeIds.has(t.id)) continue;
        const p = projectByPid.get(Number(pid));
        out.push({
          id: t.id, title: t.title || "sin título",
          priority: t.priority || "media",
          dueDate: t.dueDate || null,
          projectId: Number(pid),
          projectCode: p?.code || null,
        });
      }
    }
  }
  return out;
}

// Recolecta negociaciones RECIENTES (últimas 48 h) excluidas las que ya
// aparecen en excludeIds. Ordenadas por recencia desc.
export function collectRecentNegotiations(negs, excludeIds = new Set(), now = Date.now()) {
  if (!Array.isArray(negs)) return [];
  const cutoff = now - RECENT_WINDOW_MS;
  return negs
    .filter(n => n && !excludeIds.has(n.id))
    .map(n => ({
      n,
      ts: Math.max(
        n.updatedAt ? new Date(n.updatedAt).getTime() : 0,
        n.createdAt ? new Date(n.createdAt).getTime() : 0,
      ),
    }))
    .filter(x => x.ts >= cutoff)
    .sort((a, b) => b.ts - a.ts)
    .map(x => x.n);
}

// MNT-009 Fase 2 · Camino B-scoped: precomputa el mapa de códigos → entidades
// para el linkify en ChatBubble. Solo códigos que EXISTEN en el catálogo
// real del tenant + son VISIBLES para el member activo. Elimina falsos
// positivos por regex genérica sobre codes inventados por el LLM.
//
// Devuelve `{codes: Map<upperCode, {kind, id, title}>, patterns: {taskProjectCodes, negCodes}}`.
// Los patterns permiten construir un regex único de detección en el texto.
export function buildLinkifyMap(data, member) {
  const codes = new Map();
  const taskProjectCodes = new Set();
  const negCodes = new Set();
  if (!data) return { codes, patterns: { taskProjectCodes, negCodes } };

  const projects = filterVisibleProjects(data.projects || [], member);
  const negs     = filterVisibleNegotiations(data.negotiations || [], member);

  for (const p of projects) {
    if (!p || !p.code) continue;
    const code = String(p.code).toUpperCase();
    if (code.length < 2 || code.length > 8) continue;
    codes.set(code, { kind: "project", id: p.id, title: p.name || code });
    taskProjectCodes.add(code);
  }
  for (const n of negs) {
    if (!n || !n.code) continue;
    const code = String(n.code).toUpperCase();
    if (!code) continue;
    codes.set(code, { kind: "negotiation", id: n.id, title: n.title || code });
    // Si viene con formato NEG-N, lo añadimos al regex especial.
    if (/^NEG-\d+$/i.test(code)) negCodes.add(code);
  }
  return { codes, patterns: { taskProjectCodes, negCodes } };
}

// Escape para RegExp — reutilizado en varias funciones.
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
