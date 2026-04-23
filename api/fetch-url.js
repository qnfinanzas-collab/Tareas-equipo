// Vercel serverless function: descarga una URL pública y devuelve el texto
// limpio (sin HTML). Pensado para pasar contenido web al LLM sin necesidad
// de sumarlo como documento (no hace falta base64 ni renderizado).

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

const MAX_CHARS = 50000;
const FETCH_TIMEOUT_MS = 15000;

function stripHtml(html){
  // Elimina scripts/styles con su contenido, luego tags, luego colapsa espacios.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function handler(req, res){
  if(req.method !== "POST"){
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const { url } = req.body || {};
  if(!url || typeof url !== "string"){
    res.status(400).json({ error: "url requerida" });
    return;
  }
  let parsed;
  try { parsed = new URL(url); }
  catch { res.status(400).json({ error: "URL inválida" }); return; }
  if(parsed.protocol !== "http:" && parsed.protocol !== "https:"){
    res.status(400).json({ error: "Solo http/https" });
    return;
  }
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(parsed.toString(), {
      signal: ctrl.signal,
      headers: { "user-agent": "SoulBaric-Fetcher/1.0" },
    });
    clearTimeout(t);
    if(!r.ok){
      res.status(r.status).json({ error: `Upstream ${r.status}` });
      return;
    }
    const ct = r.headers.get("content-type") || "";
    const body = await r.text();
    const text = ct.includes("html") ? stripHtml(body) : body.replace(/\s+/g," ").trim();
    res.status(200).json({
      url: parsed.toString(),
      title: (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim(),
      text: text.slice(0, MAX_CHARS),
      truncated: text.length > MAX_CHARS,
    });
  } catch(e){
    clearTimeout(t);
    res.status(500).json({ error: e.name==="AbortError" ? "Timeout" : (e.message||"Error desconocido") });
  }
}
