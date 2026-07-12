// smoke_f1_rls_forensic — verificación FINAL de si RLS de taskflow_state
// permite UPDATE anon. Read-only, sin más escrituras.
//
// Método: leer updated_at de la fila id=1. Si mi UPDATE del preflight anterior
// se ejecutó realmente, updated_at estará muy cerca de "ahora" (segundos).
// Si RLS bloqueó silenciosamente, updated_at será más viejo (última escritura
// legítima de Antonio a la app).

import { createClient } from "@supabase/supabase-js";

const SUPA_URL = "https://iqilkicirtmmpvykogot.supabase.co";
const SUPA_KEY = "sb_publishable_zD9BqUw7LY4gZcLDdpbUnA_WczNBPv7";
const supa = createClient(SUPA_URL, SUPA_KEY);

const { data, error } = await supa
  .from("taskflow_state")
  .select("id, updated_at")
  .eq("id", 1)
  .maybeSingle();

if (error) {
  console.log("ERROR leyendo taskflow_state:", error);
  process.exit(2);
}

const now = Date.now();
const updated = new Date(data.updated_at).getTime();
const ageSec = Math.round((now - updated) / 1000);
const ageMin = Math.round(ageSec / 60);

console.log("[f1-rls-forensic]");
console.log(`  fila id=1 · updated_at = ${data.updated_at}`);
console.log(`  edad = ${ageSec}s (${ageMin}min)`);
console.log("");

if (ageSec < 120) {
  console.log("🚨 UPDATE anon EFECTIVO — updated_at cambió hace <2min.");
  console.log("   Esto confirma que RLS de taskflow_state NO bloquea UPDATE anon.");
  console.log("   IMPACTO: cualquier navegador con anon key puede sobrescribir");
  console.log("   la fila de Antonio. F1 NO PUEDE CONTINUAR hasta arreglar RLS.");
  process.exit(1);
}

console.log("✓ updated_at antiguo — el UPDATE anon del preflight NO se ejecutó.");
console.log("  RLS de taskflow_state parece bloquear escrituras anon silenciosamente.");
console.log("  (El error null + array vacío del preflight era señal de bloqueo, no éxito.)");
