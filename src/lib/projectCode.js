// projectCode — códigos de proyecto de 3 letras mayúsculas.
// Extraído de src/App.jsx a un módulo puro (sin React) para poder
// reusarse desde Node (smokes) y desde el ejecutor de la Antesala
// que crea los 3 frentes como proyectos.
//
// Regla del proyecto (CLAUDE.md): funciones compartidas viven una sola
// vez y las vistas las importan. App.jsx ahora las importa desde aquí.

export const PROJECT_CODE_RE = /^[A-Z]{3}$/;

export function isValidProjectCode(code) {
  return typeof code === "string" && PROJECT_CODE_RE.test(code);
}

// Genera código de 3 letras a partir del nombre, evitando colisiones con
// los códigos ya usados. Si las primeras 3 letras colisionan, intenta
// "<2 primeras letras><dígito>" (SH2, SH3…). Última opción: P00..P99.
export function autoProjectCode(name, existingCodes) {
  const used = new Set((existingCodes || []).filter(Boolean));
  const clean = (name || "").toUpperCase().replace(/[^A-ZÑ]/g, "").replace(/Ñ/g, "N");
  const base = clean.length >= 3 ? clean.slice(0, 3) : (clean + "XXX").slice(0, 3);
  if (!used.has(base)) return base;
  const stem = (clean.length >= 2 ? clean.slice(0, 2) : (clean + "X").slice(0, 2));
  for (let n = 2; n <= 9; n++) {
    const cand = (stem + String(n)).slice(0, 3);
    if (!used.has(cand)) return cand;
  }
  for (let n = 0; n < 100; n++) {
    const cand = "P" + String(n).padStart(2, "0");
    if (!used.has(cand)) return cand;
  }
  return "XXX";
}
