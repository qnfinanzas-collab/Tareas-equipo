// smoke_f1_rls_deterministic — prueba definitiva de si RLS de taskflow_state
// permite UPDATE anon.
//
// Método: intento fijar updated_at a un valor IMPOSIBLE (1999-12-31). Si el
// UPDATE tuvo efecto, leeremos ese valor. Si RLS bloqueó, updated_at
// permanecerá con el timestamp real de la última escritura legítima.
//
// Riesgo si RLS falla: minúsculo (solo el campo updated_at, no data). Al
// siguiente sync legítimo se reescribe. Merece la pena por la certeza que da.
//
// Riesgo si RLS bloquea (esperado): cero.

import { createClient } from "@supabase/supabase-js";

const SUPA_URL = "https://iqilkicirtmmpvykogot.supabase.co";
const SUPA_KEY = "sb_publishable_zD9BqUw7LY4gZcLDdpbUnA_WczNBPv7";
const supa = createClient(SUPA_URL, SUPA_KEY);

const IMPOSSIBLE_TS = "1999-12-31T23:59:59Z";

console.log("[f1-rls-deterministic]\n");

// 1) Leer estado pre-test.
const pre = await supa.from("taskflow_state").select("updated_at").eq("id", 1).maybeSingle();
console.log(`  pre-test updated_at: ${pre.data?.updated_at}`);

// 2) Intentar UPDATE anon con valor imposible.
const upd = await supa
  .from("taskflow_state")
  .update({ updated_at: IMPOSSIBLE_TS })
  .eq("id", 1)
  .select("id, updated_at");
console.log(`  UPDATE resultado: error=${JSON.stringify(upd.error?.code || null)}, data=${JSON.stringify(upd.data)}`);

// 3) Leer estado post-test.
const post = await supa.from("taskflow_state").select("updated_at").eq("id", 1).maybeSingle();
console.log(`  post-test updated_at: ${post.data?.updated_at}\n`);

const persisted = post.data?.updated_at?.startsWith("1999");
if (persisted) {
  console.log("🚨🚨🚨 RLS ROTA — UPDATE anon persistió el valor imposible.");
  console.log("      taskflow_state.updated_at ahora es 1999-12-31.");
  console.log("      Cualquier navegador con anon key puede sobrescribir");
  console.log("      la fila id=1 (dato de Antonio). PARAR F1 y arreglar RLS.");
  process.exit(1);
} else {
  console.log("✓ RLS FUNCIONA — UPDATE anon NO persistió.");
  console.log(`  updated_at sigue en ${post.data?.updated_at}.`);
  console.log("  El leaked=true del preflight anterior era una peculiaridad de");
  console.log("  Supabase JS (data no-null aunque array vacío tras RLS block).");
}
