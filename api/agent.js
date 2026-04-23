// Vercel serverless function: proxy a Anthropic con la API key en env var.
// POST /api/agent  { system, messages, max_tokens?, attachments? }
//
// attachments: adjuntos que se inyectan como bloques de contenido en el ÚLTIMO
// mensaje user (típicamente el prompt de análisis). Formatos:
//   { kind:"pdf",  media_type:"application/pdf", data:"<base64>" }
//   { kind:"image", media_type:"image/png"|"image/jpeg", data:"<base64>" }
//   { kind:"text", name:"doc.txt", text:"<contenido>" }
// Nota: payload base64 pesa ~33% más que el archivo. Vercel Hobby limita
// a ~4.5MB el body — con ese margen, archivos >3MB pueden fallar.

export const config = { api: { bodyParser: { sizeLimit: "20mb" } } };

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
  const { system, messages, attachments, max_tokens: reqMaxTokens, model = "claude-sonnet-4-5-20250929" } = req.body || {};
  const max_tokens = reqMaxTokens ?? (Array.isArray(attachments) && attachments.length>0 ? 4000 : 600);
  if(!Array.isArray(messages) || messages.length === 0){
    res.status(400).json({ error: "messages requerido" });
    return;
  }
  const finalMessages = injectAttachments(messages, attachments);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens, system, messages: finalMessages }),
    });
    const data = await r.json();
    if(!r.ok){
      res.status(r.status).json({ error: data.error?.message || "Error en Anthropic", details: data });
      return;
    }
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    res.status(200).json({ text });
  } catch(e){
    res.status(500).json({ error: e.message || "Error desconocido" });
  }
}
