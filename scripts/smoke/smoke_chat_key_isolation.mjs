// smoke_chat_key_isolation — verifica que la nueva clave de chat scoped por
// authUid impide colisiones entre CEOs creados vía /api/signup (todos tienen
// memberSeed.id === 0). Vector histórico (21/08/2026): la clave viva era
// `kluxor.hector.chat.<userId>` — dos signups en el mismo navegador compartían
// `kluxor.hector.chat.0`, filtrando chats del anterior al siguiente.
//
// Este smoke NO arranca navegador. Verifica por regex en fuente:
//   1) HectorDirectView, HectorPanel y App.jsx usan el prefijo nuevo
//      `kluxor.hector.chat.uid.${authUid}` cuando hay authUid.
//   2) Existe migración one-time desde la clave legacy — pero SOLO cuando
//      userId > 0 (userId === 0 es colisión, se descarta con opción de
//      rescatar un opener sintético único).
//   3) El fallback legacy `kluxor.hector.chat.${userId}` sigue existiendo
//      para el caso sin authUid (legacy pre-authSession).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const HD  = fs.readFileSync(path.join(ROOT, "src/components/HectorDirectView.jsx"), "utf8");
const HP  = fs.readFileSync(path.join(ROOT, "src/components/SalaDeComandos/HectorPanel.jsx"), "utf8");
const AJX = fs.readFileSync(path.join(ROOT, "src/App.jsx"), "utf8");

let allOk = true;
const check = (label, cond, detail = "") => {
  const ok = !!cond;
  if (!ok) allOk = false;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail && !ok ? ` — ${detail}` : ""}`);
};

console.log("[chat-key-isolation]\n");

// HectorDirectView — clave nueva y migración.
check("HectorDirectView usa `kluxor.hector.chat.uid.${authUid}` cuando hay authUid",
  /`kluxor\.hector\.chat\.uid\.\$\{authUid\}`/.test(HD));
check("HectorDirectView mantiene LEGACY_CHAT_KEY para migración",
  /LEGACY_CHAT_KEY\s*=\s*`kluxor\.hector\.chat\.\$\{userKey\}`/.test(HD));
check("HectorDirectView migra legacy → new SOLO cuando userId > 0",
  /if\s*\(legacyRaw && userId > 0\)\s*\{[\s\S]{0,200}?setItem\(CHAT_KEY, legacyRaw\);[\s\S]{0,120}?removeItem\(LEGACY_CHAT_KEY\)/.test(HD));
check("HectorDirectView descarta legacy cuando userId === 0 (colisión signup)",
  /else if\s*\(legacyRaw && userId === 0\)/.test(HD) && /removeItem\(LEGACY_CHAT_KEY\)/.test(HD));

// HectorPanel — misma protección.
check("HectorPanel usa `kluxor.hector.chat.uid.${authUid}` cuando hay authUid",
  /`kluxor\.hector\.chat\.uid\.\$\{authUid\}`/.test(HP));
check("HectorPanel mantiene LEGACY_CHAT_KEY",
  /LEGACY_CHAT_KEY\s*=\s*`kluxor\.hector\.chat\.\$\{userId \?\? "anon"\}`/.test(HP));
check("HectorPanel migra legacy → new SOLO cuando userId > 0",
  /if\s*\(legacyRaw && userId > 0\)/.test(HP));

// App.jsx opener Antesala — usa authUid.
check("App.jsx opener Antesala usa `kluxor.hector.chat.uid.${authUidForKey}` cuando hay authSession",
  /`kluxor\.hector\.chat\.uid\.\$\{authUidForKey\}`/.test(AJX));
check("App.jsx opener Antesala tiene fallback legacy si no hay authSession",
  /authUidForKey\s*\?[\s\S]{0,200}?\.uid\.\$\{authUidForKey\}[\s\S]{0,200}?:\s*`kluxor\.hector\.chat\.\$\{activeMember/.test(AJX));

// Los 3 sitios (HD, HP, App.jsx) emiten el prefijo `.uid.` en al menos
// una expresión de chat key. Usamos regex NO globales para no arrastrar
// estado entre .test() calls.
{
  const uidPattern = /`kluxor\.hector\.chat\.uid\.\$\{[^}]+\}`/;
  check("HectorDirectView emite el prefijo .uid. al menos una vez",
    uidPattern.test(HD));
  check("HectorPanel emite el prefijo .uid. al menos una vez",
    uidPattern.test(HP));
  check("App.jsx emite el prefijo .uid. al menos una vez",
    uidPattern.test(AJX));
}

console.log("");
if (allOk) {
  console.log("=== CHAT-KEY-ISOLATION SMOKE OK ===");
} else {
  console.log("=== CHAT-KEY-ISOLATION SMOKE FAIL ===");
  process.exit(1);
}
