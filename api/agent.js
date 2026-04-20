// Vercel serverless function: proxy a Anthropic con la API key en env var.
// POST /api/agent  { system, messages, max_tokens? }

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
  const { system, messages, max_tokens = 600, model = "claude-sonnet-4-5-20250929" } = req.body || {};
  if(!Array.isArray(messages) || messages.length === 0){
    res.status(400).json({ error: "messages requerido" });
    return;
  }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens, system, messages }),
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
