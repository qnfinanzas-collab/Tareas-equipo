// Diego — chat con el analista financiero. Mismo patrón que GovChatTab
// (Gonzalo): conversación 1:1 con voz, ActionProposal, persistencia local
// por userId. Diego se enfoca en operativa diaria: tesorería, conciliación,
// IVA, categorización contable. Distinto de Jorge Finanzas (modelos de
// inversión, ROI, waterfall, payback).
//
// Adjuntar documento: el botón 📎 acepta Excel/CSV (parser dinámico vía
// xlsx/papaparse) y PDF (texto extraído vía /api/pdf-text si está, o
// fallback "PDF adjunto, indicar contenido"). El texto extraído se inyecta
// como contexto al final del mensaje del usuario.
import React, { useState, useEffect, useRef } from "react";
import { speak, stopSpeaking, listen } from "../../lib/voice.js";
import { parseAgentActions, cleanAgentResponse } from "../../lib/agentActions.js";
import ActionProposal from "../Shared/ActionProposal.jsx";

const DIEGO_VOICE = { gender: "male", rate: 1.05, pitch: 0.95 };
const CHAT_MAX = 50;
const ATTACH_MAX_CHARS = 6000; // tope del extracto de texto del documento

export default function Diego({ data, currentMember, canEdit, selectedCompanyId, onCallAgent, onRunAgentActions }) {
  const userId = currentMember?.id ?? "anon";
  const storageKey = `soulbaric.diego.chat.${userId}.${selectedCompanyId || "all"}`;
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || "[]"); } catch { return []; }
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem("diego_muted") === "1"; } catch { return false; }
  });
  const [attachment, setAttachment] = useState(null); // { name, kind, text, size }
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

  const handleAttach = async (file) => {
    setAttachError("");
    setAttaching(true);
    try {
      const lower = (file.name || "").toLowerCase();
      let text = "";
      let kind = "raw";
      if (lower.endsWith(".csv")) {
        const Papa = (await import("papaparse")).default;
        let raw = await file.text();
        if (/[\uFFFD]/.test(raw)) {
          const buf = await file.arrayBuffer();
          raw = new TextDecoder("iso-8859-1").decode(buf);
        }
        const out = Papa.parse(raw, { skipEmptyLines: true });
        const rows = out.data || [];
        text = rows.slice(0, 200).map(r => Array.isArray(r) ? r.join(" | ") : String(r)).join("\n");
        kind = "csv";
      } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
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
        text = parts.join("\n");
        kind = "excel";
      } else if (lower.endsWith(".pdf")) {
        // Fallback simple: PDF se anuncia pero no se extrae el texto en
        // navegador (necesitaría pdfjs-dist). Diego sabrá que el CEO ha
        // adjuntado un PDF y pedirá detalles si no recibe transcripción.
        text = `[PDF adjuntado: ${file.name} — ${(file.size/1024).toFixed(0)} KB. El extracto del PDF no está disponible en esta sesión; pídele al CEO los datos relevantes o que pegue el texto.]`;
        kind = "pdf";
      } else if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".json")) {
        text = await file.text();
        kind = "text";
      } else {
        throw new Error("Formato no soportado. Usa .xlsx, .xls, .csv, .pdf, .txt");
      }
      if (text.length > ATTACH_MAX_CHARS) text = text.slice(0, ATTACH_MAX_CHARS) + "\n…(truncado)";
      setAttachment({ name: file.name, kind, text, size: file.size });
    } catch (e) {
      console.warn("[diego] attach fallo:", e);
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
    // Inyectamos el contenido del adjunto al final del mensaje del usuario.
    let finalContent = txt;
    if (attachment) {
      const header = `\n\n[Adjunto · ${attachment.name} · ${attachment.kind}]\n`;
      finalContent = (txt || "Analiza el documento adjunto.") + header + attachment.text;
    }
    const userMsg = {
      role: "user",
      content: finalContent,
      ts: Date.now(),
      attachmentMeta: attachment ? { name: attachment.name, kind: attachment.kind, size: attachment.size } : null,
      displayContent: txt || (attachment ? `(He adjuntado ${attachment.name})` : ""),
    };
    const next = [...history, userMsg].slice(-CHAT_MAX);
    setHistory(next);
    setInput("");
    setAttachment(null);
    setAttachError("");
    setLoading(true);
    try {
      const messages = next.map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));
      const reply = await onCallAgent({ messages, selectedCompanyId });
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
            <br />Puedes adjuntar un extracto bancario (.xlsx/.csv) o un PDF para que lo analice.
          </div>
        )}
        {history.map((m, i) => {
          const isUser = m.role === "user";
          const visible = isUser ? (m.displayContent || m.content) : m.content;
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
                </div>
              </div>
              {!isUser && m.proposal && onRunAgentActions && canEdit && (
                <div style={{ alignSelf: "stretch", paddingLeft: 36 }}>
                  <ActionProposal
                    proposal={m.proposal}
                    agentName="Diego"
                    agentEmoji="💹"
                    color="#27AE60"
                    onConfirm={async (selected) => { await onRunAgentActions(selected); }}
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
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#27AE60", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>💹</div>
            <div style={{ background: "#F0FDF4", border: "0.5px solid #E5E7EB", borderRadius: 12, padding: "10px 14px", fontSize: 12.5, color: "#0E7C5A", fontStyle: "italic" }}>💹 Diego está analizando…</div>
          </div>
        )}
      </div>

      {/* Adjunto pendiente / error */}
      {attachment && (
        <div style={{ margin: "0 12px 8px", padding: "8px 12px", background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 8, fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <span>📎</span>
          <span style={{ flex: 1, fontWeight: 600, color: "#065F46", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attachment.name}</span>
          <span style={{ fontSize: 10, color: "#0E7C5A" }}>{(attachment.size/1024).toFixed(0)} KB · {attachment.kind}</span>
          <button onClick={() => setAttachment(null)} title="Quitar adjunto" style={{ background: "transparent", border: "none", color: "#065F46", fontSize: 16, cursor: "pointer" }}>×</button>
        </div>
      )}
      {attachError && (
        <div style={{ margin: "0 12px 8px", padding: "8px 12px", background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: 8, fontSize: 12, color: "#991B1B" }}>⚠ {attachError}</div>
      )}

      {/* Input */}
      <div style={{ padding: 12, borderTop: "0.5px solid #E5E7EB", display: "flex", gap: 8, alignItems: "flex-end" }}>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv,.pdf,.txt,.md,.json" onChange={onPickFile} style={{ display: "none" }} />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={attaching || loading}
          title="Adjuntar Excel, CSV, PDF o texto"
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
