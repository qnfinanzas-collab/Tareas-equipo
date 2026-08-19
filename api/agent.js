// Vercel serverless function: proxy a Anthropic con la API key en env var.
// POST /api/agent  { system, messages, max_tokens?, attachments?, vault_token?, vault_pin? }
//
// AUTENTICACIÓN (obligatoria — cierre B1, 19/08/2026):
// Dos vías aceptadas para identificar al caller:
//   (a) Header `Authorization: Bearer <supabase_jwt>` — usuarios logueados
//       de Kluxor. Se valida contra Supabase auth.
//   (b) Body `{ vault_token, vault_pin }` — invitados que acceden a un
//       vault personal vía /vault/:token (VaultGuestView). Se valida
//       contra el JSONB de taskflow_state.data.vault.spaces[] server-side.
//       El cliente NUNCA es fuente de verdad: la BD confirma que el
//       (token, PIN) corresponde a un space real.
// Sin ninguna de las dos → 401. Cierra el vector que agotó el saldo
// Anthropic 3 veces este mes.
//
// RATE LIMIT (in-memory, sliding window de 60s):
//   Usuario autenticado: 60 req/min (holgado para uso normal, corta abuso).
//   Vault guest:          20 req/min (subida esporádica de documentos).
// El límite es por-instancia de la función (Vercel Fluid Compute reusa
// instancias — un atacante warm ve el mismo contador). Para límite
// distribuido real: Redis. Aceptable para escala actual.
//
// attachments: adjuntos que se inyectan como bloques de contenido en el ÚLTIMO
// mensaje user (típicamente el prompt de análisis). Formatos:
//   { kind:"pdf",  media_type:"application/pdf", data:"<base64>" }
//   { kind:"image", media_type:"image/png"|"image/jpeg", data:"<base64>" }
//   { kind:"text", name:"doc.txt", text:"<contenido>" }
// Nota: payload base64 pesa ~33% más que el archivo. Vercel Hobby limita
// a ~4.5MB el body — con ese margen, archivos >3MB pueden fallar.

// maxDuration: 180s. Subido desde 90s para dar margen a respuestas
// largas de Héctor con [ACTIONS] grandes (varias tareas con descriptions
// extensas tipo fichas médicas) — Sonnet 4.5 a ~60-80 tok/s puede tardar
// 100-140s en producir 8000 tokens y antes la función se mataba a los 90s
// antes de que Anthropic terminara. El cliente (lib/agent.js / HectorDirect)
// pasa timeoutMs alineado. Pro permite hasta 300s; 180s deja holgura sin
// disparar costes innecesarios. Hobby (60s tope) seguirá fallando deploy
// con error claro.
export const config = {
  maxDuration: 180,
  api: { bodyParser: { sizeLimit: "20mb" } },
};

import { supaAdmin, verifyBearer } from "./_lib/supa.js";

const RATE_LIMIT_USER  = 60;  // req/min por usuario autenticado
const RATE_LIMIT_VAULT = 20;  // req/min por vault_token (guest)
const RATE_WINDOW_MS   = 60_000;

// Sliding window in-memory. identifier → array de timestamps.
// Se limpia perezosamente al insertar (filtra timestamps > windowStart).
const rateWindows = new Map();

function checkRateLimit(identifier, maxPerMin) {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  let stamps = rateWindows.get(identifier) || [];
  stamps = stamps.filter(t => t > windowStart);
  if (stamps.length >= maxPerMin) {
    const retryAfter = Math.max(1, Math.ceil((stamps[0] + RATE_WINDOW_MS - now) / 1000));
    return { ok: false, retryAfter };
  }
  stamps.push(now);
  rateWindows.set(identifier, stamps);
  // Cleanup ocasional para que el Map no crezca indefinidamente.
  // Evict entradas cuyo timestamp más reciente ya expiró.
  if (rateWindows.size > 5000) {
    for (const [k, v] of rateWindows) {
      if (!v.length || v[v.length - 1] < windowStart) rateWindows.delete(k);
    }
  }
  return { ok: true };
}

// Localiza un vault space por accessToken buscando en taskflow_state.data.
// Retorna el objeto space {accessToken, pin, name, ...} o null.
// Usa jsonb @> (contains) para filtrar antes de traer la fila entera —
// eficiente incluso cuando el JSONB del tenant es grande.
async function findVaultSpaceByToken(token) {
  if (!token || typeof token !== "string" || token.length < 8) return null;
  try {
    const { data: rows, error } = await supaAdmin
      .from("taskflow_state")
      .select("data")
      .contains("data", { vault: { spaces: [{ accessToken: token }] } })
      .limit(1);
    if (error || !rows || rows.length === 0) return null;
    const spaces = rows[0]?.data?.vault?.spaces || [];
    return spaces.find(s => s && s.accessToken === token) || null;
  } catch {
    return null;
  }
}

function injectAttachments(messages, attachments){
  if(!Array.isArray(attachments) || attachments.length===0) return messages;
  const clone = messages.map(m=>({...m}));
  // Busca último mensaje user; si no hay, añade uno vacío.
  let idx = -1;
  for(let i=clone.length-1; i>=0; i--){ if(clone[i].role==="user"){ idx=i; break; } }
  if(idx<0){ clone.push({role:"user",content:""}); idx = clone.length-1; }
  const msg = clone[idx];
  const textContent = typeof msg.content === "string"
    ? [{type:"text", text: msg.content}]
    : Array.isArray(msg.content) ? msg.content : [];
  const attBlocks = attachments.map(a=>{
    if(a.kind==="pdf"){
      return { type:"document", source:{ type:"base64", media_type:a.media_type||"application/pdf", data:a.data } };
    }
    if(a.kind==="image"){
      return { type:"image", source:{ type:"base64", media_type:a.media_type||"image/png", data:a.data } };
    }
    if(a.kind==="text"){
      const name = a.name ? `[${a.name}]\n` : "";
      return { type:"text", text: `${name}${a.text||""}` };
    }
    return null;
  }).filter(Boolean);
  clone[idx] = { ...msg, content: [...attBlocks, ...textContent] };
  return clone;
}

export default async function handler(req, res){
  if(req.method !== "POST"){
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if(!key){
    res.status(500).json({ error: "ANTHROPIC_API_KEY no configurada en el servidor" });
    return;
  }

  // ── AUTH ──────────────────────────────────────────────────────────
  // Doble vía: Bearer JWT (usuarios logueados) o vault_token+PIN (guest).
  // Mensajes de error genéricos (no revelan si el token existe o no)
  // para no filtrar información a un atacante que sondee.
  const authHeader = req.headers?.authorization || req.headers?.Authorization || "";
  const hasBearer = /^Bearer\s+/i.test(authHeader);
  const { vault_token, vault_pin, ...restBody } = req.body || {};

  let identifier = null;
  let rateLimit = RATE_LIMIT_USER;

  if (hasBearer) {
    const { user, error: authErr } = await verifyBearer(req);
    if (!user) {
      res.status(401).json({ error: "No autorizado. Vuelve a iniciar sesión." });
      return;
    }
    identifier = `user:${user.id}`;
    rateLimit = RATE_LIMIT_USER;
  } else if (vault_token && vault_pin) {
    const space = await findVaultSpaceByToken(String(vault_token));
    if (!space) {
      // Nota: no distinguimos "no existe" de "existe pero PIN mal" para
      // no filtrar información sobre tokens válidos.
      res.status(401).json({ error: "No autorizado." });
      return;
    }
    if (String(space.pin || "") !== String(vault_pin)) {
      res.status(401).json({ error: "No autorizado." });
      return;
    }
    identifier = `vault:${String(vault_token).slice(0, 32)}`;
    rateLimit = RATE_LIMIT_VAULT;
  } else {
    res.status(401).json({ error: "No autorizado. Vuelve a iniciar sesión." });
    return;
  }

  // ── RATE LIMIT ────────────────────────────────────────────────────
  const rl = checkRateLimit(identifier, rateLimit);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.status(429).json({
      error: `Estás enviando peticiones muy rápido. Espera ${rl.retryAfter}s e inténtalo de nuevo.`,
      retryAfter: rl.retryAfter,
    });
    return;
  }

  // ── BODY / VALIDACIÓN ────────────────────────────────────────────
  const { system, messages, attachments, max_tokens: reqMaxTokens, model = "claude-sonnet-4-5-20250929", tools, tool_choice } = restBody;
  const max_tokens = reqMaxTokens ?? (Array.isArray(attachments) && attachments.length>0 ? 4000 : 600);
  if(!Array.isArray(messages) || messages.length === 0){
    res.status(400).json({ error: "messages requerido" });
    return;
  }
  const finalMessages = injectAttachments(messages, attachments);
  // Body de Anthropic: añadimos tools / tool_choice si el caller los pasó.
  // Cambio aditivo: si no vienen, la llamada queda EXACTAMENTE como antes.
  const anthropicBody = { model, max_tokens, system, messages: finalMessages };
  if (Array.isArray(tools) && tools.length > 0) anthropicBody.tools = tools;
  if (tool_choice) anthropicBody.tool_choice = tool_choice;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicBody),
    });
    const data = await r.json();
    if(!r.ok){
      // Humanización de errores comunes de Anthropic:
      //   429 → saldo agotado o rate limit del proveedor.
      //   402 → payment failed (billing).
      // El cliente los mostrará al usuario tal cual llegue en `error`.
      let humanMsg = data.error?.message || "Error en Anthropic";
      if (r.status === 429) humanMsg = "El servicio de IA está saturado o ha alcanzado el límite de uso. Reintenta en unos minutos o contacta con soporte.";
      else if (r.status === 402) humanMsg = "El servicio de IA no está disponible por un problema de facturación. Contacta con soporte.";
      res.status(r.status).json({ error: humanMsg, details: data });
      return;
    }
    // Ensamblado de respuesta preservando ORDEN de los bloques (riesgo 7
    // del diagnóstico). Concatenamos solo los text blocks (los tool_use y
    // tool_result se descartan, pero recogemos citaciones embebidas en
    // los text blocks). Deduplicamos citaciones por URL final.
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    const citationsRaw = [];
    (data.content || []).forEach(c => {
      if (c.type === "text" && Array.isArray(c.citations)) {
        c.citations.forEach(cit => {
          // Tipo emitido por web_search: web_search_result_location.
          // Aceptamos cualquier cita que traiga url + title.
          if (cit && typeof cit.url === "string") {
            citationsRaw.push({
              url: cit.url,
              title: cit.title || cit.url,
              cited_text: typeof cit.cited_text === "string" ? cit.cited_text.slice(0, 300) : "",
            });
          }
        });
      }
    });
    const seen = new Set();
    const citations = [];
    citationsRaw.forEach(c => {
      if (seen.has(c.url)) return;
      seen.add(c.url);
      citations.push(c);
    });
    // stop_reason propagado para que el caller (buildCouncilDirect, etc.)
    // pueda detectar truncado por max_tokens y disparar continuación
    // automática. Valores típicos: "end_turn", "max_tokens", "stop_sequence",
    // "tool_use". Null si la API no lo expone.
    res.status(200).json({ text, citations, stop_reason: data?.stop_reason || null });
  } catch(e){
    res.status(500).json({ error: e.message || "Error desconocido" });
  }
}
