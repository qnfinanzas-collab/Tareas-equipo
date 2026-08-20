// materializeAntesalaFronts — convierte los 3 frentes del CEO
// (ceoProfile.antesalaPendingFronts) en 3 proyectos reales dentro de
// data.projects + data.boards. Diseñado para dispararse al pulsar
// "Entrar en Kluxor" en AntesalaSummary — el commit 5/5 lo cablea.
//
// Función PURA, testeable en Node. Devuelve nextData sin mutar el
// original. Se usa en tandem con applyAntesalaAnswers(status="completed")
// que limpia el buffer pendingFronts tras materializar.
//
// Estructura de cada proyecto creado idéntica a la que produce
// src/App.jsx createProject:
//   { id (número), name, code (3 letras, único), color, emoji, desc,
//     members, workspaceId:null, ownerId, createdBy, createdAt,
//     visibility:"private", archived:false, category:"antesala" }
// Y en boards[id]: 4 columnas por defecto ["Por hacer", "En progreso",
// "Revision", "Hecho"] con ids "nc_ant_<projId>_<n>".
//
// Los ids numéricos se calculan a partir del prev — nunca colisionan
// con los ya existentes. Los codes se generan con autoProjectCode
// pasando los codes ya usados como blocklist, garantizando unicidad.

import { autoProjectCode } from "../../lib/projectCode.js";

const DEFAULT_COLUMNS = ["Por hacer", "En progreso", "Revision", "Hecho"];
// Color neutro institucional para los 3 primeros proyectos — el CEO
// puede personalizar cada uno desde la app tras entrar. Elegimos
// #4E4A42 (gris pardo del diseño, coherente con marca).
const DEFAULT_COLOR = "#4E4A42";
// Emoji fallback usado en la app cuando un proyecto no tiene emoji
// custom. Se conserva para no romper componentes que muestran emoji.
const DEFAULT_EMOJI = "📋";

/**
 * @param {object} prev  data actual (no muta).
 * @param {object} opts
 * @param {string[]} opts.fronts       - 3 títulos de proyecto (uno por frente).
 * @param {number|string} opts.ownerMemberId - id del miembro del CEO.
 * @param {Date}   [opts.now]          - inyectable para tests deterministas.
 * @returns {{ nextData: object, created: Array<{id:number,code:string,name:string}> }}
 *   nextData con los 3 proyectos añadidos. created con {id, code, name} de cada
 *   uno para logging y para que el caller pueda hacer follow-up si necesita.
 *   Si fronts NO son exactamente 3 no vacíos, devuelve { nextData: prev, created: [] }.
 */
export function materializeAntesalaFronts(prev, opts = {}) {
  const fronts = Array.isArray(opts.fronts) ? opts.fronts.map(f => String(f || "").trim()).filter(Boolean) : [];
  if (fronts.length !== 3) return { nextData: prev, created: [] };
  const ownerMemberId = opts.ownerMemberId;
  if (ownerMemberId == null) return { nextData: prev, created: [] };
  const now = opts.now instanceof Date ? opts.now : new Date();
  const nowIso = now.toISOString();

  // Calcular nextProjId desde los proyectos existentes. Sin usar el
  // counter global de App.jsx (no accesible fuera de React). Mismo
  // patrón que _initCounters.
  const projectsPrev = Array.isArray(prev?.projects) ? prev.projects : [];
  const boardsPrev = (prev && typeof prev.boards === "object") ? prev.boards : {};
  const projIds = projectsPrev.map(p => Number(p?.id)).filter(n => Number.isFinite(n));
  let nextProjId = projIds.length ? Math.max(...projIds) + 1 : 5;

  // Codes en uso — se van acumulando conforme creamos los 3 para
  // evitar colisiones entre los propios frentes (imagine dos con el
  // mismo prefijo — "Reestructurar equipo" y "Reestructurar procesos"
  // colisionarían en "REE" si no pasamos el code del primero como
  // usado al calcular el segundo).
  const usedCodes = new Set(projectsPrev.map(p => p?.code).filter(Boolean));

  const created = [];
  const newProjects = [];
  const newBoardsEntries = {};

  for (let i = 0; i < 3; i++) {
    const name = fronts[i];
    const id = nextProjId++;
    const code = autoProjectCode(name, [...usedCodes]);
    usedCodes.add(code);
    const cols = DEFAULT_COLUMNS.map((colName, cIdx) => ({
      id: `nc_ant_${id}_${cIdx}`,
      name: colName,
      tasks: [],
    }));
    const project = {
      id,
      name,
      desc: "",
      color: DEFAULT_COLOR,
      emoji: DEFAULT_EMOJI,
      code,
      members: [ownerMemberId],
      workspaceId: null,
      ownerId: ownerMemberId,
      createdBy: ownerMemberId,
      createdAt: nowIso,
      visibility: "private",
      archived: false,
      category: "antesala",
    };
    newProjects.push(project);
    newBoardsEntries[id] = cols;
    created.push({ id, code, name });
  }

  const nextData = {
    ...prev,
    projects: [...projectsPrev, ...newProjects],
    boards: { ...boardsPrev, ...newBoardsEntries },
  };
  return { nextData, created };
}
