// Diego — chat con el analista financiero. Mismo patrón que GovChatTab
// (Gonzalo): conversación 1:1 con voz, ActionProposal, persistencia local
// por userId. Diego se enfoca en operativa diaria: tesorería, conciliación,
// IVA, categorización contable. Distinto de Jorge Finanzas (modelos de
// inversión, ROI, waterfall, payback).
//
// Adjuntar documento:
//   - Excel/CSV/TXT: parsing local (xlsx/papaparse) → texto inyectado en el
//     mensaje del usuario (contexto plano).
//   - PDF/imagen: lectura como base64 → enviado a /api/agent vía el campo
//     `attachments` que Anthropic procesa nativamente (visión y PDF parsing).
//     Diego ve el documento real, no solo el nombre del archivo.
import React, { useState, useEffect, useRef } from "react";
import { speak, stopSpeaking, listen } from "../../lib/voice.js";
import { parseAgentActions, cleanAgentResponse, classifyReply } from "../../lib/agentActions.js";
import { blobToBase64 } from "../../lib/storage.js";
import ActionProposal from "../Shared/ActionProposal.jsx";

const DIEGO_VOICE = { gender: "male", rate: 1.05, pitch: 0.95 };
const CHAT_MAX = 50;
const ATTACH_MAX_CHARS = 6000; // tope del extracto de texto plano (xlsx/csv/txt)
const ATTACH_MAX_MB = 15;      // tope archivo binario (PDF/imagen) — Vercel limita el body

export default function Diego({ data, currentMember, canEdit, selectedCompanyId, onCallAgent, onRunAgentActions }) {
  const userId = currentMember?.id ?? "anon";
  const storageKey = `soulbaric.diego.chat.${userId}.${selectedCompanyId || "all"}`;
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || "[]"); } catch { return []; }
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // loadingKind="doc" cuando estamos esperando una respuesta sobre un PDF/
  // imagen (binario enviado al modelo); "chat" en cualquier otro caso. Se
  // usa solo para el indicador visual del spinner mientras Diego responde.
  const [loadingKind, setLoadingKind] = useState("chat");
  const [listening, setListening] = useState(false);
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem("diego_muted") === "1"; } catch { return false; }
  });
  // attachment shape (uno u otro):
  //   texto:   { name, kind: "csv"|"excel"|"text", text, size }
  //   binario: { name, kind: "pdf"|"image", base64, media_type, size }
  const [attachment, setAttachment] = useState(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState("");
  const stopListenRef = useRef(null);
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);

  const companies = data.governance?.companies || [];
  const company = selectedCompanyId === "all" || !selectedCompanyId ? null : companies.find(c => c.id === selectedCompanyId);

  // Recarga el historial cuando cambia la empresa filtrada (chat por empresa).
  useEffect(() => {
    try { setHistory(JSON.parse(localStorage.getItem(storageKey) || "[]")); }
    catch { setHistory([]); }
  }, [storageKey]);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(history.slice(-CHAT_MAX))); } catch {}
  }, [history, storageKey]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, loading]);

  const toggleMute = () => {
    setMuted(m => {
      const next = !m;
      try { localStorage.setItem("diego_muted", next ? "1" : "0"); } catch {}
      if (next) stopSpeaking();
      return next;
    });
  };

  const speakIfUnmuted = (text) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    if (muted || !text) return;
    try { speak(text, DIEGO_VOICE); } catch (e) { console.warn("[diego] speak fallo:", e?.message); }
  };

  // Detección del tipo a partir del archivo. Sin tocar el contenido.
  // Devuelve { kind: "pdf"|"image"|"csv"|"excel"|"text"|"unsupported", media_type? }.
  const detectAttachmentKind = (file) => {
    const lower = (file.name || "").toLowerCase();
    const mime = (file.type || "").toLowerCase();
    const isPdf = lower.endsWith(".pdf") || mime === "application/pdf";
    if (isPdf) return { kind: "pdf", media_type: "application/pdf" };
    const isImage = lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp")
      || mime === "image/png" || mime === "image/jpeg" || mime === "image/webp";
    if (isImage) {
      const media_type = mime || (lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : "image/jpeg");
      return { kind: "image", media_type };
    }
    if (lower.endsWith(".csv")) return { kind: "csv" };
    if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return { kind: "excel" };
    if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".json")) return { kind: "text" };
    return { kind: "unsupported" };
  };

  // handleAttach: SOLO registra la referencia. NO lee el archivo. NO sube
  // nada al modelo. El usuario decide cuándo activar la lectura pulsando
  // "👁 Leer" — diseño "léelo solo si lo necesitas" para no consumir
  // tokens / cuota del LLM por accidente al arrastrar archivos.
  const handleAttach = (file) => {
    setAttachError("");
    if (!file) return;
    const detected = detectAttachmentKind(file);
    if (detected.kind === "unsupported") {
      setAttachError("Formato no soportado. Usa .xlsx, .xls, .csv, .pdf, .png, .jpg, .webp, .txt");
      return;
    }
    if ((detected.kind === "pdf" || detected.kind === "image") && file.size > ATTACH_MAX_MB * 1024 * 1024) {
      setAttachError(`Archivo demasiado grande (${(file.size/1024/1024).toFixed(1)}MB). Máx ${ATTACH_MAX_MB}MB.`);
      return;
    }
    setAttachment({
      file,                        // referencia cruda — no la persistimos en localStorage
      name: file.name,
      kind: detected.kind,         // "pdf" | "image" | "csv" | "excel" | "text"
      media_type: detected.media_type || null,
      size: file.size,
      read: false,                 // se pondrá true cuando el usuario pulse "Leer"
      base64: null,                // se rellena al leer si es binario
      text: null,                  // se rellena al leer si es texto
    });
  };

  // readAttachment: ejecuta la lectura cuando el usuario pulsa "👁 Leer".
  // Para binarios (pdf/imagen) → base64 vía blobToBase64. Para texto
  // (csv/xlsx/txt) → extracción local con SheetJS / PapaParse / file.text().
  const readAttachment = async () => {
    if (!attachment || attachment.read || attaching) return;
    setAttachError("");
    setAttaching(true);
    try {
      const { file, kind } = attachment;
      if (!file) throw new Error("Adjunto sin referencia al archivo");
      if (kind === "pdf" || kind === "image") {
        const base64 = await blobToBase64(file);
        setAttachment(a => a ? { ...a, base64, read: true } : a);
      } else if (kind === "csv") {
        const Papa = (await import("papaparse")).default;
        let raw = await file.text();
        if (/[\uFFFD]/.test(raw)) {
          const buf = await file.arrayBuffer();
          raw = new TextDecoder("iso-8859-1").decode(buf);
        }
        const out = Papa.parse(raw, { skipEmptyLines: true });
        const rows = out.data || [];
        let text = rows.slice(0, 200).map(r => Array.isArray(r) ? r.join(" | ") : String(r)).join("\n");
        if (text.length > ATTACH_MAX_CHARS) text = text.slice(0, ATTACH_MAX_CHARS) + "\n…(truncado)";
        setAttachment(a => a ? { ...a, text, read: true } : a);
      } else if (kind === "excel") {
        const XLSX = await import("xlsx");
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array", cellDates: true });
        const parts = [];
        for (const name of wb.SheetNames.slice(0, 3)) {
          const ws = wb.Sheets[name];
          const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
          parts.push(`### Hoja "${name}" (${arr.length} filas)`);
          parts.push(arr.slice(0, 200).map(r => r.map(c => String(c ?? "").trim()).join(" | ")).join("\n"));
        }
        let text = parts.join("\n");
        if (text.length > ATTACH_MAX_CHARS) text = text.slice(0, ATTACH_MAX_CHARS) + "\n…(truncado)";
        setAttachment(a => a ? { ...a, text, read: true } : a);
      } else if (kind === "text") {
        let text = await file.text();
        if (text.length > ATTACH_MAX_CHARS) text = text.slice(0, ATTACH_MAX_CHARS) + "\n…(truncado)";
        setAttachment(a => a ? { ...a, text, read: true } : a);
      } else {
        throw new Error(`No sé leer un archivo de tipo "${kind}"`);
      }
    } catch (e) {
      console.warn("[diego] read fallo:", e);
      setAttachError(e.message || "Error leyendo el archivo");
    } finally {
      setAttaching(false);
    }
  };

  const onPickFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) handleAttach(f);
  };

  const send = async (overrideText) => {
    const txt = (overrideText ?? input).trim();
    if ((!txt && !attachment) || loading) return;
    if (!onCallAgent) return;
    stopSpeaking();
    const isBinary = attachment && (attachment.kind === "pdf" || attachment.kind === "image");
    const isReadBinary = isBinary && attachment.read && attachment.base64;
    const isReadText   = attachment && !isBinary && attachment.read && attachment.text;
    // Construcción del mensaje según estado del adjunto:
    //   1) Sin adjunto: mensaje normal.
    //   2) Adjunto NO leído: solo mencionamos el nombre como referencia.
    //      El modelo NO ve el contenido — el usuario decidió no leerlo.
    //   3) Adjunto texto leído: inyectamos el extracto en el prompt.
    //   4) Adjunto binario leído: enviamos base64 vía `attachments` al API.
    let finalContent = txt;
    if (attachment) {
      if (isReadText) {
        const header = `\n\n[Adjunto · ${attachment.name} · ${attachment.kind}]\n`;
        finalContent = (txt || "Analiza el documento adjunto.") + header + attachment.text;
      } else if (isReadBinary) {
        finalContent = txt || "Analiza el documento adjunto. Extrae los datos exclusivamente del archivo.";
      } else {
        // Adjunto sin leer: solo referencia textual. Diego no ve el contenido.
        const sufijo = `\n\n[Adjunto sin leer · ${attachment.name} · ${attachment.kind}. El usuario lo añadió como referencia pero no ha pulsado "Leer", así que no tienes acceso al contenido. Si necesitas verlo, indica al usuario que lo lea.]`;
        finalContent = (txt || `He adjuntado ${attachment.name} pero NO quiero que lo analices todavía.`) + sufijo;
      }
    }
    const userMsg = {
      role: "user",
      content: finalContent,
      ts: Date.now(),
      attachmentMeta: attachment ? { name: attachment.name, kind: attachment.kind, size: attachment.size, read: !!attachment.read } : null,
      displayContent: txt || (attachment ? `(He adjuntado ${attachment.name}${attachment.read ? "" : " — sin leer"})` : ""),
    };
    const next = [...history, userMsg].slice(-CHAT_MAX);
    setHistory(next);
    setInput("");
    // Para binarios leídos necesitamos retener el adjunto local hasta enviarlo.
    const sentAttachment = attachment;
    setAttachment(null);
    setAttachError("");
    setLoading(true);
    setLoadingKind(isReadBinary ? "doc" : "chat");
    try {
      const messages = next.map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));
      // Solo enviamos `attachments` cuando el último mensaje del usuario
      // tiene un binario LEÍDO (base64 cargado). El endpoint los inyecta
      // como content blocks en el último mensaje user.
      const callPayload = { messages, selectedCompanyId };
      if (isReadBinary && sentAttachment?.base64) {
        callPayload.attachments = [{
          kind: sentAttachment.kind,                  // "pdf" | "image"
          media_type: sentAttachment.media_type,
          data: sentAttachment.base64,
        }];
      }
      const reply = await onCallAgent(callPayload);
      const rawReply = (reply || "").trim() || "(sin respuesta)";
      const proposal = parseAgentActions(rawReply);
      const finalReply = proposal ? (cleanAgentResponse(rawReply) || "(sin texto)") : rawReply;
      const updated = [...next, { role: "assistant", content: finalReply, proposal, ts: Date.now() }].slice(-CHAT_MAX);
      setHistory(updated);
      speakIfUnmuted(finalReply);
    } catch (e) {
      const errMsg = `⚠ Error consultando a Diego: ${e.message || e}`;
      setHistory(h => [...h, { role: "assistant", content: errMsg, ts: Date.now(), error: true }].slice(-CHAT_MAX));
    } finally {
      setLoading(false);
    }
  };

  const startListen = () => {
    if (listening) {
      try { stopListenRef.current?.(); } catch {}
      setListening(false);
      return;
    }
    setListening(true);
    try {
      const stop = listen({
        lang: "es-ES",
        onResult: (text) => {
          setListening(false);
          if (text && text.trim()) setInput(p => (p ? p + " " : "") + text.trim());
        },
        onError: () => setListening(false),
        onEnd: () => setListening(false),
      });
      stopListenRef.current = stop;
    } catch {
      setListening(false);
    }
  };

  const onKey = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };

  const clear = () => {
    if (!history.length) return;
    if (window.confirm("¿Borrar la conversación con Diego para esta empresa?")) {
      setHistory([]);
      try { localStorage.removeItem(storageKey); } catch {}
    }
  };

  const download = () => {
    if (!history.length) return;
    const lines = history.map(m => {
      const who = m.role === "user" ? "CEO" : "Diego";
      const txt = m.displayContent || m.content;
      return `[${new Date(m.ts).toLocaleString("es-ES")}] ${who}:\n${txt}\n`;
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `diego-chat-${(company?.name || "consolidado").replace(/\s+/g,"_")}-${new Date().toISOString().slice(0,10)}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 540 }}>
      {/* Header del chat */}
      <div style={{ padding: "12px 16px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", gap: 10, background: "linear-gradient(90deg,#F0FDF4,#FFFFFF)" }}>
        <div style={{ width: 36, height: 36, borderRadius: "50%", background: "#27AE60", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>💹</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>Diego · Analista Financiero</div>
          <div style={{ fontSize: 11, color: "#0E7C5A" }}>
            Tesorería, conciliación bancaria, IVA, previsiones, análisis fiscal
            {company ? ` · filtrando ${company.name}` : " · vista consolidada"}
          </div>
        </div>
        <button onClick={toggleMute} title={muted ? "Activar voz" : "Silenciar voz"} style={{ background: "transparent", border: "1px solid #E5E7EB", borderRadius: 8, width: 32, height: 32, fontSize: 14, cursor: "pointer", color: muted ? "#9CA3AF" : "#27AE60" }}>{muted ? "🔇" : "🔊"}</button>
        <button onClick={download} disabled={!history.length} title="Descargar conversación" style={{ background: "transparent", border: "1px solid #E5E7EB", borderRadius: 8, width: 32, height: 32, fontSize: 14, cursor: history.length ? "pointer" : "not-allowed", color: history.length ? "#6B7280" : "#D1D5DB" }}>⬇</button>
        <button onClick={clear} disabled={!history.length} title="Borrar conversación" style={{ background: "transparent", border: "1px solid #E5E7EB", borderRadius: 8, width: 32, height: 32, fontSize: 14, cursor: history.length ? "pointer" : "not-allowed", color: history.length ? "#6B7280" : "#D1D5DB" }}>🗑</button>
      </div>

      {/* Mensajes */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px", display: "flex", flexDirection: "column", gap: 10 }}>
        {history.length === 0 && (
          <div style={{ padding: "24px 16px", textAlign: "center", color: "#9CA3AF", fontSize: 13, fontStyle: "italic", lineHeight: 1.55 }}>
            Pregúntale a Diego sobre tesorería, IVA trimestral, categorización de movimientos, conciliación bancaria, anomalías o previsiones.
            <br />Adjunta una factura (PDF o foto), un extracto bancario (.xlsx/.csv) o un texto para que lo lea directamente.
          </div>
        )}
        {history.map((m, i) => {
          const isUser = m.role === "user";
          const visible = isUser ? (m.displayContent || m.content) : m.content;
          // Clasificación de fiabilidad: solo en mensajes del agente (no
          // del usuario) y solo si no es un error. Sin label = no
          // pintamos badge para no saturar mensajes neutros.
          const reliability = !isUser && !m.error ? classifyReply(m.content) : null;
          return (
            <div key={i} style={{ display: "flex", gap: 8, justifyContent: isUser ? "flex-end" : "flex-start", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", maxWidth: "82%" }}>
                {!isUser && <div style={{ width: 28, height: 28, borderRadius: "50%", background: m.error ? "#FCA5A5" : "#27AE60", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}>💹</div>}
                <div style={{
                  background: isUser ? "#7F77DD" : (m.error ? "#FEE2E2" : "#F0FDF4"),
                  color: isUser ? "#fff" : (m.error ? "#991B1B" : "#1F2937"),
                  border: m.error ? "1px solid #FCA5A5" : "0.5px solid #E5E7EB",
                  borderRadius: 12,
                  padding: "10px 14px",
                  fontSize: 13.5,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}>
                  {visible}
                  {isUser && m.attachmentMeta && (
                    <div style={{ marginTop: 6, padding: "4px 8px", background: "rgba(255,255,255,0.2)", borderRadius: 6, fontSize: 11, fontWeight: 600 }}>
                      📎 {m.attachmentMeta.name}
                    </div>
                  )}
                  {reliability && reliability.label && (
                    <div
                      title={reliability.hint}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        marginTop: 8,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: reliability.bg,
                        color: reliability.color,
                        border: `0.5px solid ${reliability.border}`,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.2,
                      }}
                    >
                      {reliability.kind === "high" ? "🟢" : reliability.kind === "med" ? "🟡" : "🔴"} {reliability.label}
                    </div>
                  )}
                </div>
              </div>
              {!isUser && m.proposal && onRunAgentActions && canEdit && (
                <div style={{ alignSelf: "stretch", paddingLeft: 36 }}>
                  <ActionProposal
                    proposal={m.proposal}
                    agentName="Diego"
                    agentEmoji="💹"
                    color="#27AE60"
                    onConfirm={async (selected) => {
                      // Pasamos selectedCompanyId explícito para que el
                      // executor de agentActions pueda deducir companyId
                      // sin depender de localStorage (más explícito y a
                      // prueba de fallos). Si la vista está en "all" no
                      // pasamos nada y el executor cae a su propio fallback.
                      const opts = (selectedCompanyId && selectedCompanyId !== "all")
                        ? { defaultCompanyId: selectedCompanyId } : {};
                      await onRunAgentActions(selected, opts);
                    }}
                    onCancel={() => setHistory(prev => prev.map((x, idx) => idx === i ? { ...x, proposal: null, proposalDiscarded: true } : x))}
                  />
                </div>
              )}
              {!isUser && m.proposal && !canEdit && (
                <div style={{ alignSelf: "stretch", paddingLeft: 36, fontSize: 11, color: "#92400E", fontStyle: "italic" }}>
                  Diego propuso acciones, pero solo usuarios con permiso de edición en Finanzas pueden ejecutarlas.
                </div>
              )}
            </div>
          );
        })}
        {loading && (
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#27AE60", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>{loadingKind === "doc" ? "📄" : "💹"}</div>
            <div style={{ background: "#F0FDF4", border: "0.5px solid #E5E7EB", borderRadius: 12, padding: "10px 14px", fontSize: 12.5, color: "#0E7C5A", fontStyle: "italic" }}>
              {loadingKind === "doc" ? "📄 Leyendo documento…" : "💹 Diego está analizando…"}
            </div>
          </div>
        )}
      </div>

      {/* Adjunto pendiente / error.
          Estados: sin leer (gris, borde punteado) → "Sin leer — pulsa 👁
          para que Diego analice el contenido". Leído (verde sólido + ✅)
          → "Leído — Diego verá el documento". */}
      {attachment && (
        <div style={{ margin: "0 12px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{
            padding: "8px 12px",
            background: attachment.read ? "#F0FDF4" : "#F9FAFB",
            border: attachment.read ? "1px solid #86EFAC" : "1.5px dashed #D1D5DB",
            borderRadius: 8,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}>
            <span>{attachment.kind === "pdf" ? "📄" : attachment.kind === "image" ? "🖼" : attachment.kind === "excel" ? "📊" : attachment.kind === "csv" ? "📊" : "📎"}</span>
            <span style={{ flex: 1, fontWeight: 600, color: attachment.read ? "#065F46" : "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attachment.name}</span>
            <span style={{ fontSize: 10, color: attachment.read ? "#0E7C5A" : "#9CA3AF" }}>{(attachment.size/1024).toFixed(0)} KB · {attachment.kind}</span>
            {attachment.read ? (
              <span title="Leído — Diego verá el documento" style={{ fontSize: 11, fontWeight: 700, color: "#0E7C5A", padding: "2px 8px", borderRadius: 999, background: "#DCFCE7", border: "0.5px solid #86EFAC" }}>✅ Leído</span>
            ) : (
              <button
                onClick={readAttachment}
                disabled={attaching}
                title="Leer ahora — convierte el archivo y deja que Diego lo analice"
                style={{ padding: "3px 10px", borderRadius: 6, background: attaching ? "#E5E7EB" : "#fff", border: "1px solid #D1D5DB", color: attaching ? "#9CA3AF" : "#0E7C5A", fontSize: 11, fontWeight: 600, cursor: attaching ? "wait" : "pointer", fontFamily: "inherit" }}
              >{attaching ? "…" : "👁 Leer"}</button>
            )}
            <button onClick={() => setAttachment(null)} title="Quitar adjunto" style={{ background: "transparent", border: "none", color: attachment.read ? "#065F46" : "#6B7280", fontSize: 16, cursor: "pointer" }}>×</button>
          </div>
          <div style={{ fontSize: 10.5, color: attachment.read ? "#0E7C5A" : "#6B7280", paddingLeft: 4 }}>
            {attachment.read
              ? `✅ Leído — Diego verá el documento al enviar el mensaje.`
              : `Sin leer — pulsa 👁 Leer para que Diego analice el contenido. Si envías así, Diego solo verá el nombre del archivo.`}
          </div>
          {/* Warning de archivo grande: PDFs/imágenes >10MB pueden tardar
              hasta 90s en parseo nativo de Anthropic. Avisamos al CEO
              para que no piense que está colgado. */}
          {(attachment.kind === "pdf" || attachment.kind === "image") && attachment.size > 10 * 1024 * 1024 && (
            <div style={{ fontSize: 10.5, color: "#92400E", paddingLeft: 4, fontWeight: 600 }}>
              ⚠️ Archivo grande ({(attachment.size/1024/1024).toFixed(1)} MB). Diego puede tardar hasta 90 s en analizarlo.
            </div>
          )}
        </div>
      )}
      {attachError && (
        <div style={{ margin: "0 12px 8px", padding: "8px 12px", background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: 8, fontSize: 12, color: "#991B1B" }}>⚠ {attachError}</div>
      )}

      {/* Input */}
      <div style={{ padding: 12, borderTop: "0.5px solid #E5E7EB", display: "flex", gap: 8, alignItems: "flex-end" }}>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.json" onChange={onPickFile} style={{ display: "none" }} />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={attaching || loading}
          title="Adjuntar PDF, imagen (jpg/png), Excel, CSV o texto"
          style={{ width: 38, height: 38, borderRadius: 10, background: "#fff", color: "#27AE60", border: "1px solid #86EFAC", cursor: attaching ? "wait" : "pointer", fontSize: 16, fontFamily: "inherit" }}
        >{attaching ? "…" : "📎"}</button>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Pregúntale sobre tesorería, IVA, conciliación, categorización…"
          rows={1}
          style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", outline: "none", resize: "none", lineHeight: 1.4, maxHeight: 120 }}
        />
        <button onClick={startListen} title={listening ? "Detener" : "Hablar"} style={{ width: 38, height: 38, borderRadius: 10, background: listening ? "#E24B4A" : "#fff", color: listening ? "#fff" : "#27AE60", border: `1px solid ${listening ? "#E24B4A" : "#86EFAC"}`, cursor: "pointer", fontSize: 16, fontFamily: "inherit" }}>{listening ? "⏹" : "🎤"}</button>
        <button
          onClick={() => send()}
          disabled={(!input.trim() && !attachment) || loading}
          style={{ padding: "9px 16px", borderRadius: 10, background: (input.trim() || attachment) && !loading ? "#27AE60" : "#E5E7EB", color: (input.trim() || attachment) && !loading ? "#fff" : "#9CA3AF", border: "none", fontSize: 13, fontWeight: 600, cursor: (input.trim() || attachment) && !loading ? "pointer" : "not-allowed", fontFamily: "inherit" }}
        >{loading ? "…" : "Enviar"}</button>
      </div>
    </div>
  );
}
