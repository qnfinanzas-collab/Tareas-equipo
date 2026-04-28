// VaultView — espacio privado de documentación personal y familiar.
// Mismo patrón que DocumentacionTab pero por space (titular). El CEO ve
// pestañas con cada espacio (él + familiares); cada espacio tiene su
// propia drop zone, lista de docs y botones de acción.
//
// Las funciones de upload/preview/share son las mismas que en
// DocumentacionTab; aquí las redeclaramos en miniatura para no acoplar
// los dos módulos. La clasificación llama directamente a /api/agent.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { PERSONAL_CATEGORY_LABELS, PERSONAL_CATEGORY_ORDER, computePersonalStats, generatePersonalDocuments, checkVaultAlerts } from "./personalTemplates.js";
import { uploadDocument as uploadToBucket, getSignedUrlCached, storageEnabled } from "../../lib/storage.js";

const RELATIONSHIPS = [
  { key: "CEO",        label: "Yo (titular principal)" },
  { key: "Cónyuge",    label: "Cónyuge / Pareja" },
  { key: "Hijo/a",     label: "Hijo/a" },
  { key: "Padre/Madre", label: "Padre / Madre" },
  { key: "Hermano/a",  label: "Hermano/a" },
  { key: "Socio",      label: "Socio" },
  { key: "Allegado",   label: "Allegado" },
  { key: "Otro",       label: "Otro" },
];

function genId() {
  return (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `vs_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}
function genToken() {
  return (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, "") : `tk${Date.now()}${Math.random().toString(36).slice(2,12)}`;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = "application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";

const STATUS_META = {
  attached:       { icon: "✅", label: "Adjuntado", color: "#0E7C5A", bg: "#F0FDF4", border: "#86EFAC" },
  pending:        { icon: "❌", label: "Falta",     color: "#B91C1C", bg: "#FEF2F2", border: "#FCA5A5" },
  overdue:        { icon: "🔴", label: "Vencido",   color: "#991B1B", bg: "#FEE2E2", border: "#F87171" },
  expiring:       { icon: "🟡", label: "Vence pronto", color: "#92400E", bg: "#FEF3C7", border: "#FCD34D" },
  not_applicable: { icon: "⚪", label: "No aplica", color: "#6B7280", bg: "#F9FAFB", border: "#E5E7EB" },
};

const FILTERS = [
  { key: "all",      label: "Todos" },
  { key: "attached", label: "✅ OK" },
  { key: "pending",  label: "❌ Faltan" },
  { key: "expiring", label: "🟡 Vencen pronto" },
];

// ── helpers genéricos ──
function readFileAsDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error || new Error("read error"));
    r.readAsDataURL(file);
  });
}
function readFileAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error || new Error("read error"));
    r.readAsText(file);
  });
}
function dataUrlToBase64(d) { const i = d.indexOf(","); return i >= 0 ? d.slice(i + 1) : d; }
function dataUrlToBlob(d) {
  if (!d) return null;
  try {
    const [h, b] = d.split(",");
    const mime = (h.match(/data:([^;]+)/) || [])[1] || "application/octet-stream";
    const bin = atob(b);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  } catch { return null; }
}
function dataUrlToBlobUrl(d) { const b = dataUrlToBlob(d); return b ? URL.createObjectURL(b) : null; }
function formatBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function effectiveStatus(doc) {
  if (doc.status !== "attached") return doc.status;
  if (!doc.expiresAt) return "attached";
  const days = Math.floor((new Date(doc.expiresAt) - new Date()) / 86400000);
  if (days < 0) return "overdue";
  if (days <= 90) return "expiring";
  return "attached";
}

// Resuelve URL viva del documento (signed URL si bucket, base64 si legacy).
async function resolveDocUrl(doc) {
  if (!doc) return null;
  if (doc.storagePath) {
    try { return await getSignedUrlCached(doc.storagePath); }
    catch (e) { console.warn("[vault] signed URL fallo:", e?.message); return null; }
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

// ── classifier llamando a /api/agent con Gonzalo ──
async function classifyPersonalDocument(file, spaceDocs, spaceName) {
  const dataUrl = await readFileAsDataUrl(file);
  const base64 = dataUrlToBase64(dataUrl);
  const docList = spaceDocs.map(d => `[${d.id}] ${d.name} (cat: ${d.category})`).join("\n");
  const promptText = `Analiza este archivo personal (${file.name}, ${file.type || "?"}) y clasifícalo en el vault de ${spaceName}.

DOCUMENTOS DEL VAULT (id entre corchetes, no inventes ids fuera):
${docList || "(sin documentos)"}

Responde EXACTAMENTE con este JSON sin texto extra:
{"match":"<id de la lista o null>","category":"<identificacion|fiscal|propiedades|financiero|seguros|familia|vehiculos|formacion|otros>","newDocName":"<nombre si match=null>","summary":"<1 frase>","confidence":0.0,"detectedExpiry":"<YYYY-MM-DD si detectas fecha caducidad o null>"}

Reglas:
- match debe ser un id de la lista o null. NUNCA inventes ids.
- Si detectas fecha de caducidad (ej. DNI, pasaporte, ITV, seguro), extráela en detectedExpiry.
- confidence 0-1; si <0.6, prefiere match=null.`;
  let attachments = [];
  if (file.type === "application/pdf") attachments = [{ kind: "pdf", media_type: "application/pdf", data: base64 }];
  else if (file.type === "image/jpeg" || file.type === "image/png") attachments = [{ kind: "image", media_type: file.type, data: base64 }];
  else if (file.type === "text/plain") {
    const t = await readFileAsText(file);
    attachments = [{ kind: "text", name: file.name, text: t.slice(0, 50000) }];
  } else {
    return { match: null, category: "otros", newDocName: file.name.replace(/\.[^.]+$/, ""), summary: "Tipo no soportado para análisis", confidence: 0.3, detectedExpiry: null };
  }
  const res = await fetch("/api/agent", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system: "Clasificador documental personal experto. Responde SOLO con JSON válido.",
      messages: [{ role: "user", content: promptText }],
      attachments, max_tokens: 600,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  const raw = (data.text || "").trim();
  const json = raw.replace(/^```json\s*|\s*```$/g, "").replace(/^```\s*|\s*```$/g, "");
  let parsed; try { parsed = JSON.parse(json); } catch { throw new Error("Respuesta no parseable: " + raw.slice(0,200)); }
  return {
    match: parsed.match || null,
    category: parsed.category || "otros",
    newDocName: parsed.newDocName || file.name,
    summary: parsed.summary || "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    detectedExpiry: parsed.detectedExpiry || null,
  };
}

// ── componente principal ──
export default function VaultView({ data, currentMember, onUpdateVault }) {
  const spaces = data?.vault?.spaces || [];
  const [activeSpaceId, setActiveSpaceId] = useState(spaces[0]?.id || null);
  const [editing, setEditing] = useState(null); // null | "new" | space (objeto)
  const activeSpace = spaces.find(s => s.id === activeSpaceId) || spaces[0];
  // Alertas globales de vencimiento (todos los spaces). Se muestran en el
  // header del vault y también las consume Héctor vía window.__vaultAlerts.
  const allAlerts = useMemo(() => checkVaultAlerts(spaces), [spaces]);
  const overdueAlerts = allAlerts.filter(a => a.type === "overdue");
  const urgentAlerts  = allAlerts.filter(a => a.type === "urgent");
  const soonAlerts    = allAlerts.filter(a => a.type === "soon");

  const onSaveSpace = (data) => {
    let nextSpaces;
    if (editing && editing !== "new" && editing.id) {
      // Edit existente
      nextSpaces = spaces.map(s => s.id === editing.id ? { ...s, ...data, updatedAt: new Date().toISOString() } : s);
    } else {
      // Nuevo
      const id = genId();
      const newSpace = {
        id,
        name: data.name,
        relationship: data.relationship,
        email: data.email || "",
        pin: data.pin || "0000",
        accessToken: genToken(),
        createdBy: currentMember?.id ?? null,
        createdAt: new Date().toISOString(),
        privacyLevel: data.privacyLevel || "private",
        documents: generatePersonalDocuments(),
      };
      nextSpaces = [...spaces, newSpace];
      setActiveSpaceId(id);
    }
    onUpdateVault?.({ spaces: nextSpaces });
    setEditing(null);
  };
  const onDeleteSpace = (id) => {
    if (!confirm("¿Eliminar este espacio personal y TODOS sus documentos? Acción irreversible.")) return;
    const next = spaces.filter(s => s.id !== id);
    onUpdateVault?.({ spaces: next });
    if (activeSpaceId === id) setActiveSpaceId(next[0]?.id || null);
    setEditing(null);
  };

  return (
    <div style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#111827", marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 24 }}>🔐</span> Vault Personal
        </div>
        <div style={{ fontSize: 13, color: "#6B7280" }}>
          Tu documentación privada y la de tu familia. Cada espacio es independiente y se accede con PIN.
        </div>
      </div>

      {/* Banner de alertas de vencimiento — agregado para todos los spaces */}
      {(overdueAlerts.length + urgentAlerts.length + soonAlerts.length) > 0 && (
        <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>⚠️ Vencimientos pendientes ({allAlerts.length})</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {overdueAlerts.slice(0, 3).map(a => (
              <div key={a.docId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: 8, fontSize: 12 }}>
                <span>🔴</span><span style={{ fontWeight: 600 }}>{a.doc}</span><span style={{ color: "#6B7280" }}>de {a.spaceName}</span><span style={{ marginLeft: "auto", color: "#991B1B", fontWeight: 600 }}>VENCIDO hace {a.days}d</span>
              </div>
            ))}
            {urgentAlerts.slice(0, 3).map(a => (
              <div key={a.docId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 8, fontSize: 12 }}>
                <span>🟠</span><span style={{ fontWeight: 600 }}>{a.doc}</span><span style={{ color: "#6B7280" }}>de {a.spaceName}</span><span style={{ marginLeft: "auto", color: "#92400E", fontWeight: 600 }}>vence en {a.days}d</span>
              </div>
            ))}
            {soonAlerts.slice(0, 3).map(a => (
              <div key={a.docId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "#DBEAFE", border: "1px solid #93C5FD", borderRadius: 8, fontSize: 12 }}>
                <span>🟡</span><span style={{ fontWeight: 600 }}>{a.doc}</span><span style={{ color: "#6B7280" }}>de {a.spaceName}</span><span style={{ marginLeft: "auto", color: "#1E40AF", fontWeight: 600 }}>vence en {a.days}d</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs por espacio + botón añadir */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, borderBottom: "0.5px solid #E5E7EB", flexWrap: "wrap", alignItems: "stretch" }}>
        {spaces.map(s => {
          const active = activeSpaceId === s.id;
          const isMine = s.createdBy === currentMember?.id && s.relationship === "CEO";
          return (
            <div key={s.id} style={{ display: "flex", alignItems: "stretch" }}>
              <button onClick={() => setActiveSpaceId(s.id)} style={{
                padding: "9px 14px", background: "transparent", border: "none",
                borderBottom: active ? "2px solid #1D9E75" : "2px solid transparent",
                fontSize: 13, fontWeight: active ? 700 : 500,
                color: active ? "#0E7C5A" : "#6B7280",
                cursor: "pointer", fontFamily: "inherit",
              }}>👤 {s.name}{isMine ? " (tú)" : ""}</button>
              {active && (
                <button onClick={() => setEditing(s)} title="Editar espacio" style={{ background: "transparent", border: "none", borderBottom: "2px solid #1D9E75", padding: "9px 8px", fontSize: 13, cursor: "pointer", color: "#6B7280", fontFamily: "inherit" }}>⚙️</button>
              )}
            </div>
          );
        })}
        <button onClick={() => setEditing("new")} title="Añadir nuevo espacio" style={{
          padding: "9px 14px", background: "transparent", border: "none", borderBottom: "2px dashed #BDC3C7",
          fontSize: 13, fontWeight: 500, color: "#1D9E75", cursor: "pointer", fontFamily: "inherit",
        }}>+ Añadir espacio</button>
      </div>

      {!activeSpace ? (
        <div style={{ background: "#fff", border: "1px dashed #E5E7EB", borderRadius: 12, padding: "60px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🔐</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>Aún no tienes ningún espacio personal</div>
          <div style={{ fontSize: 12, color: "#6B7280", marginTop: 6, marginBottom: 16 }}>Crea tu primer espacio para empezar a guardar tu documentación privada.</div>
          <button onClick={() => setEditing("new")} style={{ padding: "10px 22px", borderRadius: 8, background: "#1D9E75", color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>+ Crear mi vault personal</button>
        </div>
      ) : (
        <SpaceContent space={activeSpace} currentMember={currentMember} onUpdateVault={onUpdateVault} spaces={spaces} />
      )}

      {editing && (
        <SpaceModal
          space={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={onSaveSpace}
          onDelete={editing !== "new" ? () => onDeleteSpace(editing.id) : null}
        />
      )}
    </div>
  );
}

function SpaceModal({ space, onClose, onSave, onDelete }) {
  const isNew = !space;
  const [name, setName]                 = useState(space?.name || "");
  const [relationship, setRelationship] = useState(space?.relationship || "Cónyuge");
  const [email, setEmail]               = useState(space?.email || "");
  const [pin, setPin]                   = useState(space?.pin || "0000");
  const [privacyLevel, setPrivacyLevel] = useState(space?.privacyLevel || "private");
  const [showShare, setShowShare] = useState(false);
  const canSave = !!name.trim() && /^\d{4}$/.test(pin);
  const handleSave = () => canSave && onSave({ name: name.trim(), relationship, email: email.trim(), pin, privacyLevel });
  const shareUrl = !isNew && space?.accessToken && typeof window !== "undefined"
    ? `${window.location.origin}/vault/${space.accessToken}`
    : "";
  const copyShareUrl = async () => {
    try { await navigator.clipboard.writeText(shareUrl); alert("Link copiado al portapapeles"); } catch { alert("No se pudo copiar"); }
  };
  const shareViaWhatsApp = () => {
    if (!shareUrl) return;
    const text = encodeURIComponent(`🔐 Acceso a tu vault personal de SoulBaric.\n\nLink: ${shareUrl}\nPIN: ${pin}\n\nAccede desde aquí para subir, ver y compartir tus documentos.`);
    window.open(`https://wa.me/?text=${text}`, "_blank", "noopener,noreferrer");
  };
  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 14, width: 460, maxWidth: "94vw", borderTop: "4px solid #1D9E75", overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{isNew ? "+ Nuevo espacio personal" : `Editar espacio: ${space.name}`}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6B7280" }}>×</button>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Nombre">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Ej: María Díaz" style={fieldStyle} />
          </Field>
          <Field label="Relación">
            <select value={relationship} onChange={e => setRelationship(e.target.value)} style={fieldStyle}>
              {RELATIONSHIPS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </Field>
          <Field label="Email (opcional)">
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="maria@ejemplo.com" style={fieldStyle} />
          </Field>
          <Field label="PIN de acceso (4 dígitos)">
            <input value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="0000" maxLength={4} style={{ ...fieldStyle, letterSpacing: 4, fontFamily: "ui-monospace,monospace", textAlign: "center", width: 120 }} />
          </Field>
          <Field label="Privacidad">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={privacyLabel(privacyLevel === "private")}>
                <input type="radio" name="privacy" checked={privacyLevel === "private"} onChange={() => setPrivacyLevel("private")} />
                <span>🔒 Solo el titular ve sus documentos</span>
              </label>
              <label style={privacyLabel(privacyLevel === "shared")}>
                <input type="radio" name="privacy" checked={privacyLevel === "shared"} onChange={() => setPrivacyLevel("shared")} />
                <span>🔓 CEO también puede ver</span>
              </label>
            </div>
          </Field>

          {/* Compartir acceso (solo en edición, cuando ya hay accessToken) */}
          {!isNew && space?.accessToken && (
            <div style={{ marginTop: 4, padding: "12px 14px", background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#065F46", marginBottom: 2 }}>🔗 Compartir acceso con {name || space.name}</div>
                  <div style={{ fontSize: 11, color: "#0E7C5A" }}>Link privado + PIN. Solo accede a su vault, no a SoulBaric.</div>
                </div>
                <button onClick={() => setShowShare(v => !v)} style={{ padding: "5px 12px", borderRadius: 6, background: "#1D9E75", color: "#fff", border: "none", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{showShare ? "Ocultar" : "Mostrar enlace"}</button>
              </div>
              {showShare && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: "0.5px dashed #86EFAC", display: "flex", flexDirection: "column", gap: 8 }}>
                  <input value={shareUrl} readOnly onClick={(e) => e.target.select()} style={{ ...fieldStyle, background: "#fff", fontFamily: "ui-monospace,monospace", fontSize: 11.5 }} />
                  <div style={{ fontSize: 11, color: "#065F46" }}>PIN actual: <b style={{ fontFamily: "ui-monospace,monospace", letterSpacing: 2 }}>{pin}</b></div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={copyShareUrl} style={{ padding: "6px 10px", borderRadius: 6, background: "#fff", border: "1px solid #86EFAC", color: "#065F46", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>📋 Copiar link</button>
                    <button onClick={shareViaWhatsApp} style={{ padding: "6px 10px", borderRadius: 6, background: "#fff", border: "1px solid #86EFAC", color: "#065F46", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>💬 WhatsApp</button>
                  </div>
                  <div style={{ fontSize: 10.5, color: "#92400E" }}>⚠️ Este link da acceso SOLO al vault personal de {name || space.name}, no al resto de SoulBaric.</div>
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 8 }}>
            {!isNew && onDelete && (
              <button onClick={onDelete} style={{ padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #FCA5A5", color: "#B91C1C", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Eliminar espacio</button>
            )}
            <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
              <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
              <button onClick={handleSave} disabled={!canSave} style={{ padding: "8px 18px", borderRadius: 8, background: canSave ? "#1D9E75" : "#E5E7EB", color: canSave ? "#fff" : "#9CA3AF", border: "none", fontSize: 12, fontWeight: 600, cursor: canSave ? "pointer" : "default", fontFamily: "inherit" }}>{isNew ? "Crear espacio" : "Guardar"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const fieldStyle = { width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" };
function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
function privacyLabel(active) {
  return {
    display: "flex", alignItems: "center", gap: 8,
    padding: "8px 12px", borderRadius: 8,
    border: `1.5px solid ${active ? "#1D9E75" : "#E5E7EB"}`,
    background: active ? "#F0FDF4" : "#fff",
    cursor: "pointer", fontSize: 12.5, fontWeight: active ? 600 : 500, color: "#374151",
  };
}

// ── contenido de un space individual ──
function SpaceContent({ space, currentMember, onUpdateVault, spaces }) {
  const [filter, setFilter] = useState("all");
  const [isDragOverGlobal, setIsDragOverGlobal] = useState(false);
  const [processingFile, setProcessingFile] = useState(null);
  const [recentResults, setRecentResults] = useState([]);
  const fileInputRef = useRef(null);
  const docs = space.documents || [];

  const stats = useMemo(() => computePersonalStats(docs), [docs]);
  const filtered = useMemo(() => {
    if (filter === "all") return docs;
    return docs.filter(d => effectiveStatus(d) === filter);
  }, [docs, filter]);
  const grouped = useMemo(() => {
    const out = {};
    for (const d of filtered) {
      const cat = d.category || "otros";
      (out[cat] ||= []).push(d);
    }
    return out;
  }, [filtered]);

  const updateDocs = (nextDocs) => {
    const nextSpaces = (spaces || []).map(s => s.id === space.id ? { ...s, documents: nextDocs } : s);
    onUpdateVault?.({ spaces: nextSpaces });
  };
  const updateDoc = (id, patch) => updateDocs(docs.map(d => d.id === id ? { ...d, ...patch } : d));

  const processFiles = async (files) => {
    for (const file of Array.from(files || [])) {
      if (file.size > MAX_FILE_BYTES) {
        setRecentResults(r => [{ file: file.name, ok: false, msg: `Excede ${MAX_FILE_BYTES/(1024*1024)}MB`, ts: Date.now() }, ...r].slice(0, 5));
        continue;
      }
      setProcessingFile(file.name);
      try {
        const cls = await classifyPersonalDocument(file, docs, space.name);
        // Subir al bucket "documents" bajo prefijo vault/{spaceId}. Si
        // Supabase no está disponible, fallback a base64 para no bloquear.
        let storagePayload;
        if (storageEnabled()) {
          const meta = await uploadToBucket(file, `vault/${space.id}`);
          storagePayload = { storagePath: meta.storagePath, fileUrl: null, fileName: meta.name, fileType: meta.type, fileSize: meta.size };
        } else {
          const dataUrl = await readFileAsDataUrl(file);
          storagePayload = { storagePath: null, fileUrl: dataUrl, fileName: file.name, fileType: file.type || "", fileSize: file.size };
        }
        const filePayload = {
          ...storagePayload,
          status: "attached",
          uploadedBy: currentMember?.id ?? null, uploadedAt: new Date().toISOString(),
          expiresAt: cls.detectedExpiry || null,
        };
        let nextDocs; let resultLabel;
        if (cls.match && docs.find(d => d.id === cls.match)) {
          nextDocs = docs.map(d => {
            if (d.id !== cls.match) return d;
            const versions = Array.isArray(d.versions) ? d.versions.slice() : [];
            if (d.fileUrl || d.storagePath) versions.unshift({ storagePath: d.storagePath || null, fileUrl: d.fileUrl || null, fileName: d.fileName, fileType: d.fileType, fileSize: d.fileSize, uploadedBy: d.uploadedBy, uploadedAt: d.uploadedAt, archivedAt: new Date().toISOString() });
            return { ...d, ...filePayload, expiresAt: filePayload.expiresAt || d.expiresAt, versions };
          });
          resultLabel = `→ ${docs.find(d => d.id === cls.match)?.name}`;
        } else {
          const newDoc = {
            id: `pdoc_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
            category: cls.category || "otros", subcategory: null,
            name: cls.newDocName || file.name.replace(/\.[^.]+$/, ""),
            description: cls.summary || "",
            required: false, hasExpiry: !!cls.detectedExpiry,
            ...filePayload,
            dueDate: null, versions: [], notes: "",
            createdAt: new Date().toISOString(),
          };
          nextDocs = [...docs, newDoc];
          resultLabel = `→ nuevo: ${newDoc.name} (${PERSONAL_CATEGORY_LABELS[newDoc.category] || newDoc.category})`;
        }
        updateDocs(nextDocs);
        setRecentResults(r => [{ file: file.name, ok: true, msg: resultLabel, confidence: cls.confidence, ts: Date.now() }, ...r].slice(0, 5));
      } catch (e) {
        setRecentResults(r => [{ file: file.name, ok: false, msg: e.message || "Error", ts: Date.now() }, ...r].slice(0, 5));
      } finally {
        setProcessingFile(null);
      }
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragOverGlobal(true); }}
        onDragLeave={() => setIsDragOverGlobal(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragOverGlobal(false); processFiles(e.dataTransfer.files); }}
        onClick={!processingFile ? () => fileInputRef.current?.click() : undefined}
        style={{
          border: `2px dashed ${isDragOverGlobal ? "#1D9E75" : "#BDC3C7"}`,
          borderRadius: 12, padding: "28px 22px", textAlign: "center",
          backgroundColor: isDragOverGlobal ? "#F0FDF4" : "#FAFAFA",
          cursor: processingFile ? "wait" : "pointer", transition: "all 0.2s",
        }}
      >
        {processingFile ? (
          <div>
            <div style={{ fontSize: 28, marginBottom: 6 }}>🏛️</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>Gonzalo está analizando "{processingFile}"…</div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 28, marginBottom: 6 }}>📎</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>Arrastra documentos aquí o haz clic</div>
            <div style={{ fontSize: 12, color: "#7F8C8D", marginTop: 4 }}>Gonzalo los clasificará automáticamente en tu vault</div>
          </div>
        )}
        <input ref={fileInputRef} type="file" multiple accept={ACCEPTED_TYPES} onChange={(e) => { const f = e.target.files; e.target.value = ""; if (f?.length) processFiles(f); }} style={{ display: "none" }} />
      </div>

      {/* Resultados recientes */}
      {recentResults.length > 0 && (
        <div style={{ background: "#fff", border: "0.5px solid #E5E7EB", borderRadius: 10, padding: "8px 14px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Clasificaciones recientes</div>
          {recentResults.map(r => (
            <div key={r.ts} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12 }}>
              <span>{r.ok ? "✅" : "⚠️"}</span>
              <span style={{ color: "#111827", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{r.file}</span>
              <span style={{ color: r.ok ? "#374151" : "#B91C1C", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.msg}</span>
              {typeof r.confidence === "number" && r.ok && <span style={{ fontSize: 10, color: "#9CA3AF" }}>conf. {Math.round(r.confidence * 100)}%</span>}
            </div>
          ))}
        </div>
      )}

      {/* Stats + barra progreso */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "12px 16px" }}>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#0E7C5A" }}>✅ {stats.attached}/{stats.total}</span>
          <span style={{ fontSize: 12, color: "#6B7280" }}>adjuntados</span>
          {stats.pending > 0 && <span style={{ fontSize: 13, fontWeight: 600, color: "#B91C1C" }}>❌ {stats.pending} faltan</span>}
          {stats.expiringSoon > 0 && <span style={{ fontSize: 13, fontWeight: 600, color: "#92400E" }}>🟡 {stats.expiringSoon} próximos</span>}
          <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: stats.pct >= 70 ? "#0E7C5A" : stats.pct >= 40 ? "#92400E" : "#B91C1C" }}>{stats.pct}% completado</span>
        </div>
        <div style={{ height: 6, background: "#F3F4F6", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ width: `${stats.pct}%`, height: "100%", background: stats.pct >= 70 ? "#10B981" : stats.pct >= 40 ? "#F59E0B" : "#E24B4A", transition: "width .3s ease" }} />
        </div>
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {FILTERS.map(f => {
          const active = filter === f.key;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)} style={{
              padding: "6px 14px", borderRadius: 16,
              border: `1px solid ${active ? "#1D9E75" : "#E5E7EB"}`,
              background: active ? "#1D9E75" : "#fff",
              color: active ? "#fff" : "#6B7280",
              fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>{f.label}</button>
          );
        })}
      </div>

      {/* Lista por categoría */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {filtered.length === 0 ? (
          <div style={{ background: "#fff", border: "1px dashed #E5E7EB", borderRadius: 12, padding: "32px 16px", textAlign: "center", color: "#9CA3AF", fontSize: 12 }}>
            Ningún documento coincide con este filtro.
          </div>
        ) : (
          PERSONAL_CATEGORY_ORDER.filter(cat => grouped[cat]).map(cat => (
            <CategorySection key={cat} category={cat} docs={grouped[cat]} onUpdate={updateDoc} currentMember={currentMember} space={space} />
          ))
        )}
      </div>
    </div>
  );
}

function CategorySection({ category, docs, onUpdate, currentMember, space }) {
  const label = PERSONAL_CATEGORY_LABELS[category] || `📂 ${category}`;
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "10px 16px", background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB", fontSize: 12, fontWeight: 700, color: "#374151" }}>{label}</div>
      <div style={{ padding: "8px 0" }}>
        {docs.map(d => <DocumentRow key={d.id} doc={d} onUpdate={onUpdate} currentMember={currentMember} space={space} />)}
      </div>
    </div>
  );
}

function DocumentRow({ doc, onUpdate, currentMember, space }) {
  const eff = effectiveStatus(doc);
  const meta = STATUS_META[eff] || STATUS_META.pending;
  const [busy, setBusy] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const ref = useRef(null);
  const onPick = () => ref.current?.click();
  const onPickChange = async (e) => {
    const f = e.target.files?.[0]; e.target.value = "";
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) { alert("Archivo demasiado grande"); return; }
    setBusy(true);
    try {
      let payload;
      if (storageEnabled()) {
        const ownerKey = space?.id ? `vault/${space.id}` : `vault/_orphan`;
        const meta = await uploadToBucket(f, ownerKey);
        payload = { storagePath: meta.storagePath, fileUrl: null, fileName: meta.name, fileType: meta.type, fileSize: meta.size };
      } else {
        const dataUrl = await readFileAsDataUrl(f);
        payload = { storagePath: null, fileUrl: dataUrl, fileName: f.name, fileType: f.type || "", fileSize: f.size };
      }
      const versions = Array.isArray(doc.versions) ? doc.versions.slice() : [];
      if (doc.fileUrl || doc.storagePath) versions.unshift({ storagePath: doc.storagePath || null, fileUrl: doc.fileUrl || null, fileName: doc.fileName, fileType: doc.fileType, fileSize: doc.fileSize, uploadedBy: doc.uploadedBy, uploadedAt: doc.uploadedAt, archivedAt: new Date().toISOString() });
      onUpdate(doc.id, { ...payload, status: "attached", uploadedBy: currentMember?.id ?? null, uploadedAt: new Date().toISOString(), versions });
    } catch (e) { alert(`No se pudo subir: ${e.message || e}`); }
    finally { setBusy(false); }
  };
  const removeFile = () => {
    if (!confirm("¿Quitar el archivo?")) return;
    const versions = Array.isArray(doc.versions) ? doc.versions.slice() : [];
    if (doc.fileUrl || doc.storagePath) versions.unshift({ storagePath: doc.storagePath || null, fileUrl: doc.fileUrl || null, fileName: doc.fileName, fileType: doc.fileType, fileSize: doc.fileSize, uploadedBy: doc.uploadedBy, uploadedAt: doc.uploadedAt, archivedAt: new Date().toISOString() });
    onUpdate(doc.id, { status: "pending", storagePath: null, fileUrl: null, fileName: null, fileType: null, fileSize: null, uploadedBy: null, uploadedAt: null, versions });
  };

  const hasFile = doc.status === "attached" && (doc.fileUrl || doc.storagePath);
  const expiryLabel = doc.expiresAt ? new Date(doc.expiresAt).toLocaleDateString("es-ES",{day:"numeric",month:"short",year:"numeric"}) : null;

  return (
    <div style={{ borderTop: "0.5px solid #F3F4F6" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px" }}>
        <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>{meta.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{doc.name}</div>
          {doc.description && <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2, lineHeight: 1.4 }}>{doc.description}</div>}
          {hasFile && (
            <div style={{ fontSize: 11, color: "#0E7C5A", marginTop: 4, fontFamily: "ui-monospace,monospace", display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span>📎 {doc.fileName}</span>
              {doc.fileSize > 0 && <span style={{ color: "#6B7280" }}>· {formatBytes(doc.fileSize)}</span>}
              {expiryLabel && <span style={{ color: eff === "expiring" || eff === "overdue" ? "#92400E" : "#6B7280" }}>· vence {expiryLabel}</span>}
            </div>
          )}
        </div>
        <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 8px", borderRadius: 10, background: meta.bg, border: `1px solid ${meta.border}`, color: meta.color, whiteSpace: "nowrap" }}>{meta.label}</span>
      </div>
      <div style={{ padding: "0 16px 12px 46px" }}>
        {hasFile ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={() => setShowPreview(true)} style={iconBtn} title="Ver">👁️ Ver</button>
            <button onClick={async () => { const u = await resolveDocUrl(doc); if (u) { const a = document.createElement("a"); a.href = u; a.download = doc.fileName || "documento"; a.click(); } }} style={iconBtn} title="Descargar">📥 Descargar</button>
            <button onClick={onPick} style={iconBtn} title="Reemplazar">✏️ Reemplazar</button>
            <button onClick={removeFile} style={iconBtnDanger} title="Eliminar">🗑️ Eliminar</button>
            <input ref={ref} type="file" accept={ACCEPTED_TYPES} onChange={onPickChange} style={{ display: "none" }} />
            {showPreview && <PreviewModal doc={doc} onClose={() => setShowPreview(false)} />}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={onPick} disabled={busy} style={iconBtn}>
              {busy ? "⏳ Subiendo…" : "📎 Adjuntar"}
            </button>
            <span style={{ fontSize: 11, color: "#9CA3AF" }}>· o suelta el archivo arriba y Gonzalo lo clasifica</span>
            <input ref={ref} type="file" accept={ACCEPTED_TYPES} onChange={onPickChange} style={{ display: "none" }} />
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewModal({ doc, onClose }) {
  const isPdf   = doc.fileType === "application/pdf";
  const isImage = doc.fileType?.startsWith("image/");
  const resolvedUrl = useDocUrl(doc);
  const [pdfBlobUrl, setPdfBlobUrl] = useState(null);
  useEffect(() => {
    if (!isPdf || !resolvedUrl) return;
    if (!resolvedUrl.startsWith("data:")) { setPdfBlobUrl(resolvedUrl); return; }
    const url = dataUrlToBlobUrl(resolvedUrl);
    setPdfBlobUrl(url);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [isPdf, resolvedUrl]);
  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 4000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 12, width: "92vw", maxWidth: 1100, height: "90vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "12px 18px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.name}</div>
            <div style={{ fontSize: 11, color: "#6B7280", fontFamily: "ui-monospace,monospace" }}>📎 {doc.fileName}</div>
          </div>
          {resolvedUrl && <a href={resolvedUrl} download={doc.fileName} style={{ ...iconBtn, textDecoration: "none" }}>📥 Descargar</a>}
          <button onClick={onClose} style={{ background: "transparent", border: "none", fontSize: 22, cursor: "pointer", color: "#6B7280", padding: "0 4px" }}>×</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {isPdf && (pdfBlobUrl
            ? <iframe src={pdfBlobUrl} title={doc.name} style={{ width: "100%", height: "100%", minHeight: "70vh", border: 0 }} />
            : <div style={{ padding: 40, textAlign: "center", color: "#9CA3AF", fontSize: 12 }}>Cargando previsualización…</div>)}
          {isImage && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 20, height: "100%" }}>
              {resolvedUrl
                ? <img src={resolvedUrl} alt={doc.name} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} />
                : <div style={{ color: "#9CA3AF" }}>Cargando…</div>}
            </div>
          )}
          {!isPdf && !isImage && (
            <div style={{ padding: 40, textAlign: "center", color: "#6B7280", fontSize: 13 }}>Pulsa Descargar para abrir.</div>
          )}
        </div>
      </div>
    </div>
  );
}

const iconBtn = { display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 6, background: "#fff", border: "1px solid #D1D5DB", color: "#374151", fontSize: 11.5, fontWeight: 600, cursor: "pointer", textDecoration: "none", fontFamily: "inherit" };
const iconBtnDanger = { ...iconBtn, color: "#B91C1C", borderColor: "#FCA5A5" };
