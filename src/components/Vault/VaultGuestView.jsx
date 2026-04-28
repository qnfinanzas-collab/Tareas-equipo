// VaultGuestView — vista aislada para acceso invitado vía /vault/:token.
// Renderizada por App.jsx ANTES del shell de SoulBaric (sin sidebar, sin
// auth de SoulBaric). El invitado introduce el PIN del space y accede
// solo a sus propios documentos. NO ve nada del resto de la app.
//
// Persistencia: las mutaciones se guardan en data.vault.spaces vía el
// callback onUpdateVault — exactamente igual que el VaultView del CEO.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { PERSONAL_CATEGORY_LABELS, PERSONAL_CATEGORY_ORDER, computePersonalStats } from "./personalTemplates.js";
import { uploadDocument as uploadToBucket, getSignedUrlCached, storageEnabled } from "../../lib/storage.js";

// (mini-replicas de helpers — duplicación local intencionada para no
// acoplar VaultGuestView a VaultView vía exports cruzados)
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = "application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";
const STATUS_META = {
  attached:       { icon: "✅", label: "Adjuntado", color: "#0E7C5A", bg: "#F0FDF4", border: "#86EFAC" },
  pending:        { icon: "❌", label: "Falta",     color: "#B91C1C", bg: "#FEF2F2", border: "#FCA5A5" },
  overdue:        { icon: "🔴", label: "Vencido",   color: "#991B1B", bg: "#FEE2E2", border: "#F87171" },
  expiring:       { icon: "🟡", label: "Vence pronto", color: "#92400E", bg: "#FEF3C7", border: "#FCD34D" },
};
function readFileAsDataUrl(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
}
function dataUrlToBase64(d) { const i = d.indexOf(","); return i >= 0 ? d.slice(i + 1) : d; }
function dataUrlToBlob(d) {
  if (!d) return null;
  try { const [h, b] = d.split(","); const mime = (h.match(/data:([^;]+)/) || [])[1] || "application/octet-stream"; const bin = atob(b); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new Blob([u8], { type: mime }); } catch { return null; }
}
function dataUrlToBlobUrl(d) { const b = dataUrlToBlob(d); return b ? URL.createObjectURL(b) : null; }
function effectiveStatus(doc) {
  if (doc.status !== "attached") return doc.status;
  if (!doc.expiresAt) return "attached";
  const days = Math.floor((new Date(doc.expiresAt) - new Date()) / 86400000);
  if (days < 0) return "overdue";
  if (days <= 90) return "expiring";
  return "attached";
}

async function resolveDocUrl(doc) {
  if (!doc) return null;
  if (doc.storagePath) {
    try { return await getSignedUrlCached(doc.storagePath); }
    catch { return null; }
  }
  return doc.fileUrl || null;
}
function useDocUrl(doc) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!doc || (!doc.storagePath && !doc.fileUrl)) { setUrl(null); return; }
    resolveDocUrl(doc).then(u => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [doc?.storagePath, doc?.fileUrl, doc?.id]);
  return url;
}

// Parser del path /vault/:token. Devuelve null si no aplica.
export function parseVaultGuestPath(pathname) {
  const m = (pathname || "").match(/^\/vault\/([a-zA-Z0-9_-]{8,})\/?$/);
  return m ? m[1] : null;
}

// Componente de login + vista. Si el space del token no existe → 404.
// Si existe pero PIN mal → mensaje de error. Si OK → render del vault.
export default function VaultGuestView({ token, data, onUpdateVault }) {
  const space = (data?.vault?.spaces || []).find(s => s.accessToken === token);
  const [pinInput, setPinInput] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState("");

  if (!space) {
    return (
      <FullScreenShell>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#111827", marginBottom: 6 }}>Vault no encontrado</div>
        <div style={{ fontSize: 13, color: "#6B7280", textAlign: "center", maxWidth: 360 }}>
          El enlace que has usado no corresponde a ningún espacio activo. Pide al CEO que te envíe un enlace nuevo.
        </div>
      </FullScreenShell>
    );
  }

  if (!unlocked) {
    return (
      <FullScreenShell>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🔐</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#111827", marginBottom: 4 }}>Vault Personal de {space.name}</div>
        <div style={{ fontSize: 13, color: "#6B7280", marginBottom: 20 }}>Introduce el PIN de 4 dígitos para acceder a tu documentación.</div>
        <input
          autoFocus
          value={pinInput}
          onChange={e => { setPinInput(e.target.value.replace(/\D/g, "").slice(0, 4)); setError(""); }}
          onKeyDown={e => {
            if (e.key === "Enter") {
              if (pinInput === space.pin) setUnlocked(true);
              else setError("PIN incorrecto");
            }
          }}
          placeholder="••••"
          maxLength={4}
          style={{ padding: "14px 18px", borderRadius: 10, border: `1.5px solid ${error ? "#FCA5A5" : "#D1D5DB"}`, fontSize: 28, fontFamily: "ui-monospace,monospace", textAlign: "center", letterSpacing: 12, width: 180, outline: "none" }}
        />
        {error && <div style={{ marginTop: 10, fontSize: 12, color: "#B91C1C" }}>{error}</div>}
        <button
          onClick={() => { if (pinInput === space.pin) setUnlocked(true); else setError("PIN incorrecto"); }}
          disabled={pinInput.length !== 4}
          style={{ marginTop: 18, padding: "10px 28px", borderRadius: 8, background: pinInput.length === 4 ? "#1D9E75" : "#E5E7EB", color: pinInput.length === 4 ? "#fff" : "#9CA3AF", border: "none", fontSize: 13, fontWeight: 600, cursor: pinInput.length === 4 ? "pointer" : "default", fontFamily: "inherit" }}
        >Entrar</button>
        <div style={{ marginTop: 32, fontSize: 11, color: "#9CA3AF", textAlign: "center" }}>
          🔒 Este espacio es privado. Solo tú y el titular del PIN tenéis acceso.
        </div>
      </FullScreenShell>
    );
  }

  return <GuestVault space={space} data={data} onUpdateVault={onUpdateVault} onLogout={() => { setUnlocked(false); setPinInput(""); }} />;
}

function FullScreenShell({ children }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#F9FAFB", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ background: "#fff", border: "0.5px solid #E5E7EB", borderRadius: 16, padding: "40px 32px", maxWidth: 440, width: "100%", textAlign: "center", boxShadow: "0 8px 32px rgba(0,0,0,0.08)" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#1D9E75", letterSpacing: 1.5, marginBottom: 16 }}>SOULBARIC · VAULT PERSONAL</div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0 }}>{children}</div>
      </div>
    </div>
  );
}

// Vault interior del invitado — versión simplificada del SpaceContent.
// La clasificación con Gonzalo sigue funcionando (llama a /api/agent).
function GuestVault({ space, data, onUpdateVault, onLogout }) {
  const docs = space.documents || [];
  const [filter, setFilter] = useState("all");
  const [isDragOver, setIsDragOver] = useState(false);
  const [processing, setProcessing] = useState(null);
  const [recent, setRecent] = useState([]);
  const inputRef = useRef(null);

  const stats = useMemo(() => computePersonalStats(docs), [docs]);
  const filtered = useMemo(() => filter === "all" ? docs : docs.filter(d => effectiveStatus(d) === filter), [docs, filter]);
  const grouped = useMemo(() => {
    const out = {};
    for (const d of filtered) (out[d.category || "otros"] ||= []).push(d);
    return out;
  }, [filtered]);

  const updateDocs = (next) => {
    const spaces = (data?.vault?.spaces || []).map(s => s.id === space.id ? { ...s, documents: next } : s);
    onUpdateVault?.({ spaces });
  };
  const updateDoc = (id, patch) => updateDocs(docs.map(d => d.id === id ? { ...d, ...patch } : d));

  const processFiles = async (files) => {
    for (const file of Array.from(files || [])) {
      if (file.size > MAX_FILE_BYTES) {
        setRecent(r => [{ file: file.name, ok: false, msg: "Excede 10MB", ts: Date.now() }, ...r].slice(0, 5));
        continue;
      }
      setProcessing(file.name);
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const base64 = dataUrlToBase64(dataUrl);
        const docList = docs.map(d => `[${d.id}] ${d.name} (cat: ${d.category})`).join("\n");
        let attachments = [];
        if (file.type === "application/pdf") attachments = [{ kind: "pdf", media_type: "application/pdf", data: base64 }];
        else if (file.type === "image/jpeg" || file.type === "image/png") attachments = [{ kind: "image", media_type: file.type, data: base64 }];
        else { setRecent(r => [{ file: file.name, ok: false, msg: "Tipo no soportado", ts: Date.now() }, ...r].slice(0, 5)); setProcessing(null); continue; }

        const res = await fetch("/api/agent", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            system: "Clasificador documental personal. Responde SOLO con JSON.",
            messages: [{ role: "user", content: `Clasifica este archivo (${file.name}) en el vault de ${space.name}.\n\nDOCUMENTOS (id entre corchetes, no inventes):\n${docList}\n\nResponde JSON: {"match":"<id o null>","category":"<identificacion|fiscal|propiedades|financiero|seguros|familia|vehiculos|formacion|otros>","newDocName":"<nombre si match=null>","detectedExpiry":"<YYYY-MM-DD o null>","confidence":0.0}` }],
            attachments, max_tokens: 500,
          }),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
        const raw = (out.text || "").trim().replace(/^```json\s*|\s*```$/g, "").replace(/^```\s*|\s*```$/g, "");
        const cls = JSON.parse(raw);
        // Subir al bucket. El invitado usa la misma anon key — la RLS del
        // bucket debe permitir uploads en vault/{spaceId} (pública o por
        // policy custom). Fallback a base64 si no hay Supabase.
        let payload;
        if (storageEnabled()) {
          const meta = await uploadToBucket(file, `vault/${space.id}`);
          payload = { storagePath: meta.storagePath, fileUrl: null, fileName: meta.name, fileType: meta.type, fileSize: meta.size };
        } else {
          payload = { storagePath: null, fileUrl: dataUrl, fileName: file.name, fileType: file.type, fileSize: file.size };
        }
        const filePayload = {
          ...payload, status: "attached",
          uploadedAt: new Date().toISOString(), expiresAt: cls.detectedExpiry || null,
        };
        let nextDocs; let label;
        if (cls.match && docs.find(d => d.id === cls.match)) {
          nextDocs = docs.map(d => d.id === cls.match ? { ...d, ...filePayload, expiresAt: filePayload.expiresAt || d.expiresAt } : d);
          label = `→ ${docs.find(d => d.id === cls.match)?.name}`;
        } else {
          const newDoc = { id: `pdoc_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, category: cls.category || "otros", name: cls.newDocName || file.name, description: "", required: false, hasExpiry: !!cls.detectedExpiry, ...filePayload, versions: [], notes: "", createdAt: new Date().toISOString() };
          nextDocs = [...docs, newDoc];
          label = `→ nuevo: ${newDoc.name}`;
        }
        updateDocs(nextDocs);
        setRecent(r => [{ file: file.name, ok: true, msg: label, ts: Date.now() }, ...r].slice(0, 5));
      } catch (e) {
        setRecent(r => [{ file: file.name, ok: false, msg: e.message || "Error", ts: Date.now() }, ...r].slice(0, 5));
      } finally { setProcessing(null); }
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#F9FAFB", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px 16px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#1D9E75", letterSpacing: 1.5 }}>SOULBARIC · VAULT</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#111827", marginTop: 2 }}>🔐 {space.name}</div>
          </div>
          <button onClick={onLogout} style={{ padding: "7px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#6B7280", fontFamily: "inherit" }}>Cerrar sesión</button>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setIsDragOver(false); processFiles(e.dataTransfer.files); }}
          onClick={!processing ? () => inputRef.current?.click() : undefined}
          style={{ border: `2px dashed ${isDragOver ? "#1D9E75" : "#BDC3C7"}`, borderRadius: 12, padding: "28px 22px", textAlign: "center", backgroundColor: isDragOver ? "#F0FDF4" : "#fff", cursor: processing ? "wait" : "pointer", marginBottom: 14 }}
        >
          {processing ? (
            <><div style={{ fontSize: 28, marginBottom: 6 }}>🏛️</div><div style={{ fontSize: 14, fontWeight: 600 }}>Gonzalo analiza "{processing}"…</div></>
          ) : (
            <><div style={{ fontSize: 28, marginBottom: 6 }}>📎</div><div style={{ fontSize: 14, fontWeight: 600 }}>Suelta tus documentos aquí</div><div style={{ fontSize: 12, color: "#7F8C8D", marginTop: 4 }}>Se clasificarán automáticamente</div></>
          )}
          <input ref={inputRef} type="file" multiple accept={ACCEPTED_TYPES} onChange={(e) => { const f = e.target.files; e.target.value = ""; if (f?.length) processFiles(f); }} style={{ display: "none" }} />
        </div>

        {recent.length > 0 && (
          <div style={{ background: "#fff", border: "0.5px solid #E5E7EB", borderRadius: 10, padding: "8px 14px", marginBottom: 14 }}>
            {recent.map(r => (
              <div key={r.ts} style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 12 }}>
                <span>{r.ok ? "✅" : "⚠️"}</span>
                <span style={{ fontWeight: 600 }}>{r.file}</span>
                <span style={{ color: r.ok ? "#374151" : "#B91C1C" }}>{r.msg}</span>
              </div>
            ))}
          </div>
        )}

        {/* Stats */}
        <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "10px 16px", marginBottom: 14, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#0E7C5A" }}>✅ {stats.attached}/{stats.total}</span>
          {stats.pending > 0 && <span style={{ fontSize: 13, color: "#B91C1C" }}>❌ {stats.pending} faltan</span>}
          {stats.expiringSoon > 0 && <span style={{ fontSize: 13, color: "#92400E" }}>🟡 {stats.expiringSoon} próximos</span>}
          <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700 }}>{stats.pct}%</span>
        </div>

        {/* Filtros */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {[["all","Todos"],["attached","✅ OK"],["pending","❌ Faltan"],["expiring","🟡 Vencen pronto"]].map(([k, l]) => {
            const active = filter === k;
            return <button key={k} onClick={() => setFilter(k)} style={{ padding: "6px 14px", borderRadius: 16, border: `1px solid ${active ? "#1D9E75" : "#E5E7EB"}`, background: active ? "#1D9E75" : "#fff", color: active ? "#fff" : "#6B7280", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>;
          })}
        </div>

        {/* Lista */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {filtered.length === 0 ? (
            <div style={{ background: "#fff", border: "1px dashed #E5E7EB", borderRadius: 12, padding: "28px 16px", textAlign: "center", color: "#9CA3AF", fontSize: 12 }}>Ningún documento coincide con este filtro.</div>
          ) : PERSONAL_CATEGORY_ORDER.filter(cat => grouped[cat]).map(cat => (
            <div key={cat} style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB", fontSize: 12, fontWeight: 700, color: "#374151" }}>{PERSONAL_CATEGORY_LABELS[cat]}</div>
              {grouped[cat].map(d => <GuestDocRow key={d.id} doc={d} onUpdate={updateDoc} />)}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 30, textAlign: "center", fontSize: 11, color: "#9CA3AF" }}>
          🔒 Este es un espacio privado. Solo tú tienes acceso a estos documentos.
        </div>
      </div>
    </div>
  );
}

function GuestDocRow({ doc, onUpdate }) {
  const eff = effectiveStatus(doc);
  const meta = STATUS_META[eff] || STATUS_META.pending;
  const [showPreview, setShowPreview] = useState(false);
  const hasFile = doc.status === "attached" && (doc.fileUrl || doc.storagePath);
  const downloadDoc = async () => {
    const url = await resolveDocUrl(doc);
    if (!url) return;
    const a = document.createElement("a"); a.href = url; a.download = doc.fileName || "documento"; a.click();
  };
  return (
    <div style={{ borderTop: "0.5px solid #F3F4F6", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 18 }}>{meta.icon}</span>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{doc.name}</div>
        {hasFile && <div style={{ fontSize: 11, color: "#0E7C5A", fontFamily: "ui-monospace,monospace", marginTop: 2 }}>📎 {doc.fileName}{doc.expiresAt ? ` · vence ${new Date(doc.expiresAt).toLocaleDateString("es-ES",{day:"numeric",month:"short",year:"numeric"})}` : ""}</div>}
      </div>
      <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 8px", borderRadius: 10, background: meta.bg, border: `1px solid ${meta.border}`, color: meta.color }}>{meta.label}</span>
      {hasFile && (
        <>
          <button onClick={() => setShowPreview(true)} style={guestBtn}>👁️ Ver</button>
          <button onClick={downloadDoc} style={guestBtn}>📥 Descargar</button>
          {showPreview && <GuestPreview doc={doc} onClose={() => setShowPreview(false)} />}
        </>
      )}
    </div>
  );
}

function GuestPreview({ doc, onClose }) {
  const isPdf = doc.fileType === "application/pdf";
  const isImage = doc.fileType?.startsWith("image/");
  const resolvedUrl = useDocUrl(doc);
  const [pdfBlobUrl, setPdfBlobUrl] = useState(null);
  useEffect(() => {
    if (!isPdf || !resolvedUrl) return;
    if (!resolvedUrl.startsWith("data:")) { setPdfBlobUrl(resolvedUrl); return; }
    const u = dataUrlToBlobUrl(resolvedUrl);
    setPdfBlobUrl(u);
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [isPdf, resolvedUrl]);
  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 4000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#fff", borderRadius: 12, width: "92vw", maxWidth: 1100, height: "90vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "12px 18px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>{doc.name}</div>
          {resolvedUrl && <a href={resolvedUrl} download={doc.fileName} style={{ ...guestBtn, textDecoration: "none" }}>📥 Descargar</a>}
          <button onClick={onClose} style={{ background: "transparent", border: "none", fontSize: 22, cursor: "pointer", color: "#6B7280" }}>×</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {isPdf && (pdfBlobUrl
            ? <iframe src={pdfBlobUrl} title={doc.name} style={{ width: "100%", height: "100%", minHeight: "70vh", border: 0 }} />
            : <div style={{ padding: 40, textAlign: "center", color: "#9CA3AF" }}>Cargando…</div>)}
          {isImage && (resolvedUrl
            ? <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 20, height: "100%" }}><img src={resolvedUrl} alt={doc.name} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} /></div>
            : <div style={{ padding: 40, color: "#9CA3AF" }}>Cargando…</div>)}
          {!isPdf && !isImage && <div style={{ padding: 40, textAlign: "center", color: "#6B7280" }}>Pulsa Descargar para abrir.</div>}
        </div>
      </div>
    </div>
  );
}

const guestBtn = { display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 6, background: "#fff", border: "1px solid #D1D5DB", color: "#374151", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" };
