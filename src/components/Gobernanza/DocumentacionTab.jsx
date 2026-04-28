// DocumentacionTab — gestión de documentación societaria por empresa.
// Lista agrupada por categoría con estado visual (✅❌🟡⚪) y filtros.
// La subida de archivos, gestión de versiones y compartir llegan en
// commits siguientes — este commit cierra la UI base de visualización.
import React, { useMemo, useState, useRef, useEffect } from "react";
import { CATEGORY_LABELS, CATEGORY_ORDER, computeDocStats } from "./documentTemplates.js";

// Sincroniza alertas de gobernanza con el estado de documentación. Por
// cada documento required pendiente o vencido genera una entrada en
// governance.alerts. Re-ejecuta solo cuando cambian los documentos.
function syncDocAlerts(documents, companies, onUpdateGovernance, existingAlerts) {
  const dynamic = [];
  const today = new Date();
  for (const d of documents || []) {
    if (!d.required) continue;
    const company = (companies || []).find(c => c.id === d.companyId);
    const companyName = company?.name || "(empresa)";
    if (d.status === "pending") {
      dynamic.push({
        id: `doc-pending-${d.id}`,
        level: "warning",
        title: `Falta documento: ${d.name}`,
        message: `${companyName} — documento obligatorio pendiente de subir`,
        source: "documents",
        docId: d.id,
        companyId: d.companyId,
      });
    } else if (d.status === "overdue") {
      dynamic.push({
        id: `doc-overdue-${d.id}`,
        level: "critical",
        title: `Documento vencido: ${d.name}`,
        message: `${companyName} — supera la fecha límite, regulariza cuanto antes`,
        source: "documents",
        docId: d.id,
        companyId: d.companyId,
      });
    } else if (d.expiresAt) {
      const days = Math.floor((new Date(d.expiresAt) - today) / 86400000);
      if (days >= 0 && days <= 90) {
        dynamic.push({
          id: `doc-expiring-${d.id}`,
          level: "info",
          title: `${d.name} caduca en ${days}d`,
          message: `${companyName} — renueva antes de ${d.expiresAt.slice(0,10)}`,
          source: "documents",
          docId: d.id,
          companyId: d.companyId,
        });
      }
    }
  }
  // Mantenemos las alertas que NO vienen de documents (manuales) y
  // sustituimos las dinámicas por la lista recién calculada.
  const manual = (existingAlerts || []).filter(a => a.source !== "documents");
  const next = [...manual, ...dynamic];
  // Igualdad por id — si la lista coincide, no escribimos para no entrar
  // en bucle infinito de useEffect.
  const sameLen = next.length === (existingAlerts || []).length;
  const sameIds = sameLen && next.every(a => (existingAlerts || []).some(b => b.id === a.id));
  if (!sameIds) onUpdateGovernance?.({ alerts: next });
}

const STATUS_META = {
  attached:       { icon: "✅", label: "Adjuntado",   color: "#0E7C5A", bg: "#F0FDF4", border: "#86EFAC" },
  pending:        { icon: "❌", label: "Falta",       color: "#B91C1C", bg: "#FEF2F2", border: "#FCA5A5" },
  overdue:        { icon: "🔴", label: "Vencido",     color: "#991B1B", bg: "#FEE2E2", border: "#F87171" },
  not_applicable: { icon: "⚪", label: "No aplica",   color: "#6B7280", bg: "#F9FAFB", border: "#E5E7EB" },
  draft:          { icon: "📝", label: "Borrador",    color: "#92400E", bg: "#FFFBEB", border: "#FCD34D" },
  expiring:       { icon: "🟡", label: "Próximo a vencer", color: "#92400E", bg: "#FEF3C7", border: "#FCD34D" },
};

const FILTERS = [
  { key: "all",       label: "Todos" },
  { key: "attached",  label: "✅ OK" },
  { key: "pending",   label: "❌ Faltan" },
  { key: "expiring",  label: "🟡 Próximos" },
  { key: "not_applicable", label: "⚪ No aplica" },
];

// Devuelve el "estado efectivo" para visualización: si hay archivo y
// expiresAt está dentro de 90 días → expiring; si no, devuelve status.
function effectiveStatus(doc) {
  if (doc.status !== "attached") return doc.status;
  if (!doc.expiresAt) return "attached";
  const days = Math.floor((new Date(doc.expiresAt) - new Date()) / 86400000);
  if (days < 0) return "overdue";
  if (days <= 90) return "expiring";
  return "attached";
}

export default function DocumentacionTab({ governance, currentMember, onUpdateGovernance }) {
  const companies = governance?.companies || [];
  const [companyId, setCompanyId] = useState(companies[0]?.id || "");
  const [filter, setFilter] = useState("all");

  if (companies.length === 0) {
    return (
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "40px 20px", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: "#111827" }}>Aún no hay empresas registradas</div>
        <div style={{ fontSize: 12, color: "#7F8C8D", maxWidth: 380, margin: "0 auto" }}>
          Para gestionar documentación societaria, primero registra una empresa en el tab Dashboard. Al crearla, generaremos automáticamente la lista de documentos necesarios según su tipo.
        </div>
      </div>
    );
  }

  const company = companies.find(c => c.id === companyId) || companies[0];
  const allDocs = governance?.documents || [];
  const companyDocs = useMemo(() => allDocs.filter(d => d.companyId === company.id), [allDocs, company.id]);
  const stats = useMemo(() => computeDocStats(companyDocs), [companyDocs]);

  // Sincroniza alertas dinámicas de governance basadas en el estado de
  // documentos. Se ejecuta sobre TODOS los docs (no solo de la empresa
  // seleccionada) para que Gonzalo vea el cuadro completo en su contexto.
  useEffect(() => {
    syncDocAlerts(allDocs, companies, onUpdateGovernance, governance?.alerts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDocs.length, allDocs.map(d => d.status).join("|")]);

  // Aplica filtro al listado. "expiring" mira el estado efectivo.
  const filtered = useMemo(() => {
    if (filter === "all") return companyDocs;
    return companyDocs.filter(d => effectiveStatus(d) === filter);
  }, [companyDocs, filter]);

  // Toast simple para confirmar copia/share. Auto-cierra en 2s.
  const [toast, setToast] = useState(null);
  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  };

  // Agrupa por categoría respetando CATEGORY_ORDER. Las cuentas anuales y
  // fiscal se sub-agrupan por subcategory (año / trimestre).
  const grouped = useMemo(() => {
    const out = {};
    for (const d of filtered) {
      const cat = d.category || "otros";
      if (!out[cat]) out[cat] = {};
      const sub = d.subcategory || "_";
      if (!out[cat][sub]) out[cat][sub] = [];
      out[cat][sub].push(d);
    }
    return out;
  }, [filtered]);

  const updateDoc = (id, patch) => {
    const next = allDocs.map(d => d.id === id ? { ...d, ...patch } : d);
    onUpdateGovernance?.({ documents: next });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header con selector de empresa + resumen */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "14px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 4 }}>📋 Documentación societaria</div>
            <div style={{ fontSize: 11, color: "#6B7280" }}>Archivos legales, fiscales y de gobierno por empresa</div>
          </div>
          <select value={companyId} onChange={e => setCompanyId(e.target.value)} style={{ padding: "8px 12px", borderRadius: 8, border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", background: "#fff", minWidth: 220 }}>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {/* Resumen stats con barra de progreso */}
        <div style={{ paddingTop: 10, borderTop: "0.5px solid #F3F4F6" }}>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
            <StatPill icon="✅" label={`${stats.attached}/${stats.total}`} sub="adjuntados" color="#0E7C5A" />
            {stats.pending > 0 && <StatPill icon="❌" label={String(stats.pending)} sub="faltan" color="#B91C1C" />}
            {stats.overdue > 0 && <StatPill icon="🔴" label={String(stats.overdue)} sub="vencidos" color="#991B1B" />}
            {stats.expiringSoon > 0 && <StatPill icon="🟡" label={String(stats.expiringSoon)} sub="próximos" color="#92400E" />}
            <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: stats.pct >= 90 ? "#0E7C5A" : stats.pct >= 60 ? "#92400E" : "#B91C1C" }}>{stats.pct}% completado</span>
          </div>
          <div style={{ height: 6, background: "#F3F4F6", borderRadius: 4, overflow: "hidden" }}>
            <div style={{
              width: `${stats.pct}%`,
              height: "100%",
              background: stats.pct >= 90 ? "#10B981" : stats.pct >= 60 ? "#F59E0B" : "#E24B4A",
              transition: "width .3s ease",
            }} />
          </div>
        </div>
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {FILTERS.map(f => {
          const active = filter === f.key;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)} style={{
              padding: "6px 14px", borderRadius: 16,
              border: `1px solid ${active ? "#8E44AD" : "#E5E7EB"}`,
              background: active ? "#8E44AD" : "#fff",
              color: active ? "#fff" : "#6B7280",
              fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>{f.label}</button>
          );
        })}
      </div>

      {/* Lista agrupada por categoría */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {filtered.length === 0 ? (
          <div style={{ background: "#fff", border: "1px dashed #E5E7EB", borderRadius: 12, padding: "32px 16px", textAlign: "center", color: "#9CA3AF", fontSize: 12 }}>
            Ningún documento coincide con este filtro.
          </div>
        ) : (
          CATEGORY_ORDER.filter(cat => grouped[cat]).map(cat => (
            <CategorySection key={cat} category={cat} subgroups={grouped[cat]} onUpdate={updateDoc} currentMember={currentMember} company={company} showToast={showToast} />
          ))
        )}
      </div>

      {/* Toast inferior */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#111827", color: "#fff", padding: "10px 18px", borderRadius: 10, fontSize: 13, fontWeight: 500, boxShadow: "0 6px 20px rgba(0,0,0,0.18)", zIndex: 5000 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

function StatPill({ icon, label, sub, color }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ fontSize: 14 }}>{icon}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color }}>{label}</span>
      <span style={{ fontSize: 11, color: "#6B7280" }}>{sub}</span>
    </div>
  );
}

function CategorySection({ category, subgroups, onUpdate, currentMember, company, showToast }) {
  const label = CATEGORY_LABELS[category] || `📂 ${category}`;
  const subKeys = Object.keys(subgroups).sort((a, b) => b.localeCompare(a)); // recientes primero
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "10px 16px", background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB", fontSize: 12, fontWeight: 700, color: "#374151", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ padding: "8px 0" }}>
        {subKeys.map(sub => (
          <div key={sub}>
            {sub !== "_" && (
              <div style={{ padding: "6px 16px", fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.4 }}>{sub}</div>
            )}
            {subgroups[sub].map(doc => <DocumentRow key={doc.id} doc={doc} onUpdate={onUpdate} currentMember={currentMember} company={company} showToast={showToast} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

// Lee un File como dataURL (base64). Tope 10MB para no destrozar localStorage.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = "application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("read error"));
    reader.readAsDataURL(file);
  });
}

function formatBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Acciones de compartir. data URLs no se pueden mandar como adjunto en
// mailto:, así que el mailto incluye un mensaje sugerente y el WhatsApp
// abre la app con texto. La copia al portapapeles es del propio data URL
// para que el destinatario pueda pegarlo y descargarlo desde un blob.
function shareViaEmail(doc, company, sender) {
  const subject = encodeURIComponent(`[${company?.name || "Sociedad"}] — ${doc.name}`);
  const body = encodeURIComponent(
`Hola,

Te paso el documento "${doc.name}" de ${company?.name || "(sociedad)"}.
${doc.description ? `\n${doc.description}\n` : ""}
${doc.fileName ? `Archivo: ${doc.fileName}` : "El archivo aún no está disponible."}

Atentamente,
${sender?.name || ""}`
  );
  window.open(`mailto:?subject=${subject}&body=${body}`);
}
function shareViaWhatsApp(doc, company) {
  const text = encodeURIComponent(
    `📄 Documento "${doc.name}" de ${company?.name || "(sociedad)"}.${doc.fileName ? `\nArchivo: ${doc.fileName}` : ""}`
  );
  window.open(`https://wa.me/?text=${text}`, "_blank", "noopener,noreferrer");
}
async function copyDataUrlToClipboard(dataUrl) {
  if (!dataUrl) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(dataUrl);
      return true;
    }
  } catch {}
  // Fallback: textarea oculto
  try {
    const ta = document.createElement("textarea");
    ta.value = dataUrl;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return true;
  } catch { return false; }
}
function printDocument(doc) {
  if (!doc.fileUrl) return;
  // Abre el archivo en una pestaña nueva con auto-print. Funciona bien
  // con PDF e imágenes; con .docx el navegador descargará el archivo.
  const w = window.open();
  if (!w) return;
  if (doc.fileType?.startsWith("image/")) {
    w.document.write(`<img src="${doc.fileUrl}" style="max-width:100%" onload="window.print()" />`);
  } else if (doc.fileType === "application/pdf") {
    w.document.write(`<iframe src="${doc.fileUrl}" style="width:100%;height:100vh;border:0" onload="this.contentWindow && this.contentWindow.print && this.contentWindow.print()"></iframe>`);
  } else {
    // Para otros tipos: descargar y avisar.
    const a = w.document.createElement("a");
    a.href = doc.fileUrl;
    a.download = doc.fileName || "documento";
    w.document.body.appendChild(a);
    a.click();
  }
}

function DocumentRow({ doc, onUpdate, currentMember, company, showToast }) {
  const eff = effectiveStatus(doc);
  const meta = STATUS_META[eff] || STATUS_META.pending;
  const [isDragOver, setIsDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const fileInputRef = useRef(null);

  const toggleApplicability = () => {
    if (doc.status === "not_applicable") onUpdate(doc.id, { status: "pending" });
    else if (doc.status === "pending")    onUpdate(doc.id, { status: "not_applicable" });
  };

  const handleFiles = async (files) => {
    const file = files && files[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      alert(`El archivo supera ${MAX_FILE_BYTES / (1024 * 1024)} MB. Comprime o sube en otro formato.`);
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      // Si ya había un archivo, lo movemos al historial.
      const versions = Array.isArray(doc.versions) ? doc.versions.slice() : [];
      if (doc.fileUrl) {
        versions.unshift({
          fileUrl: doc.fileUrl,
          fileName: doc.fileName,
          fileType: doc.fileType,
          fileSize: doc.fileSize,
          uploadedBy: doc.uploadedBy,
          uploadedAt: doc.uploadedAt,
          archivedAt: new Date().toISOString(),
        });
      }
      onUpdate(doc.id, {
        status: "attached",
        fileUrl: dataUrl,
        fileName: file.name,
        fileType: file.type || "",
        fileSize: file.size,
        uploadedBy: currentMember?.id ?? null,
        uploadedAt: new Date().toISOString(),
        versions,
      });
    } catch (e) {
      alert(`No se pudo leer el archivo: ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const onPick = () => fileInputRef.current?.click();
  const onPickChange = (e) => { handleFiles(e.target.files); e.target.value = ""; };
  const onDrop = (e) => { e.preventDefault(); setIsDragOver(false); handleFiles(e.dataTransfer.files); };
  const onDragOver = (e) => { e.preventDefault(); setIsDragOver(true); };
  const onDragLeave = () => setIsDragOver(false);

  const removeFile = () => {
    if (!confirm("¿Quitar el archivo? El documento volverá a quedar pendiente. (La versión anterior se conserva en el historial.)")) return;
    const versions = Array.isArray(doc.versions) ? doc.versions.slice() : [];
    if (doc.fileUrl) {
      versions.unshift({
        fileUrl: doc.fileUrl, fileName: doc.fileName, fileType: doc.fileType, fileSize: doc.fileSize,
        uploadedBy: doc.uploadedBy, uploadedAt: doc.uploadedAt, archivedAt: new Date().toISOString(),
      });
    }
    onUpdate(doc.id, {
      status: "pending", fileUrl: null, fileName: null, fileType: null, fileSize: null,
      uploadedBy: null, uploadedAt: null, versions,
    });
  };

  const restoreVersion = (idx) => {
    const versions = (doc.versions || []).slice();
    const v = versions[idx];
    if (!v) return;
    versions.splice(idx, 1);
    if (doc.fileUrl) {
      versions.unshift({
        fileUrl: doc.fileUrl, fileName: doc.fileName, fileType: doc.fileType, fileSize: doc.fileSize,
        uploadedBy: doc.uploadedBy, uploadedAt: doc.uploadedAt, archivedAt: new Date().toISOString(),
      });
    }
    onUpdate(doc.id, {
      status: "attached",
      fileUrl: v.fileUrl, fileName: v.fileName, fileType: v.fileType, fileSize: v.fileSize,
      uploadedBy: v.uploadedBy, uploadedAt: v.uploadedAt, versions,
    });
    setShowVersions(false);
  };

  const hasFile = doc.status === "attached" && doc.fileUrl;
  const versionsCount = (doc.versions || []).length;

  return (
    <div style={{ borderTop: "0.5px solid #F3F4F6" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px" }}>
        <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>{meta.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: doc.status === "not_applicable" ? "#9CA3AF" : "#111827" }}>
            {doc.name}
            {doc.required && doc.status !== "not_applicable" && <span style={{ color: "#E24B4A", marginLeft: 4 }}>*</span>}
          </div>
          {doc.description && (
            <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2, lineHeight: 1.4 }}>{doc.description}</div>
          )}
          {hasFile && (
            <div style={{ fontSize: 11, color: "#0E7C5A", marginTop: 4, fontFamily: "ui-monospace,monospace", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>📎 {doc.fileName}</span>
              {doc.fileSize > 0 && <span style={{ color: "#6B7280" }}>· {formatBytes(doc.fileSize)}</span>}
              {doc.uploadedAt && <span style={{ color: "#6B7280" }}>· {new Date(doc.uploadedAt).toLocaleDateString("es-ES",{day:"numeric",month:"short",year:"numeric"})}</span>}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 8px", borderRadius: 10, background: meta.bg, border: `1px solid ${meta.border}`, color: meta.color, whiteSpace: "nowrap" }}>{meta.label}</span>
          {(doc.status === "not_applicable" || doc.status === "pending") && (
            <button onClick={toggleApplicability} title={doc.status === "not_applicable" ? "Activar este documento" : "Marcar como no aplica"} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: "transparent", border: "1px solid #D1D5DB", color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>{doc.status === "not_applicable" ? "+ Activar" : "No aplica"}</button>
          )}
        </div>
      </div>

      {/* Acciones según estado */}
      {doc.status !== "not_applicable" && (
        <div style={{ padding: "0 16px 12px 46px" }}>
          {hasFile ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <a href={doc.fileUrl} download={doc.fileName} style={iconBtn} title="Descargar">📥 Descargar</a>
              <button onClick={() => shareViaEmail(doc, company, currentMember)} style={iconBtn} title="Compartir por email">📧 Email</button>
              <button onClick={() => shareViaWhatsApp(doc, company)} style={iconBtn} title="Compartir por WhatsApp">💬 WhatsApp</button>
              <button onClick={async () => { const ok = await copyDataUrlToClipboard(doc.fileUrl); showToast?.(ok ? "Link copiado al portapapeles (válido 7 días)" : "No se pudo copiar el link"); }} style={iconBtn} title="Copiar link del documento">🔗 Copiar link</button>
              <button onClick={() => printDocument(doc)} style={iconBtn} title="Imprimir">🖨️ Imprimir</button>
              <button onClick={onPick} style={iconBtn} title="Reemplazar archivo">✏️ Reemplazar</button>
              <button onClick={removeFile} style={iconBtnDanger} title="Eliminar archivo">🗑️ Eliminar</button>
              {versionsCount > 0 && (
                <button onClick={() => setShowVersions(v => !v)} style={iconBtn} title="Historial de versiones">🕘 Versiones ({versionsCount})</button>
              )}
              <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES} onChange={onPickChange} style={{ display: "none" }} />
            </div>
          ) : (
            <div
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onClick={onPick}
              style={{
                padding: "16px 14px",
                background: isDragOver ? "#F5EEFA" : "#FAFAFA",
                border: `1.5px dashed ${isDragOver ? "#8E44AD" : "#D1D5DB"}`,
                borderRadius: 8,
                textAlign: "center",
                cursor: busy ? "wait" : "pointer",
                transition: "background .15s ease, border-color .15s ease",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 4 }}>📎 {busy ? "Subiendo…" : "Adjuntar documento"}</div>
              <div style={{ fontSize: 11, color: "#9CA3AF" }}>Arrastra el archivo aquí o haz clic. PDF, DOCX, JPG, PNG · máx 10 MB.</div>
              <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES} onChange={onPickChange} style={{ display: "none" }} />
            </div>
          )}

          {showVersions && versionsCount > 0 && (
            <div style={{ marginTop: 8, padding: "8px 12px", background: "#F9FAFB", border: "0.5px solid #E5E7EB", borderRadius: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Historial de versiones</div>
              {(doc.versions || []).map((v, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: i > 0 ? "0.5px dashed #E5E7EB" : "none" }}>
                  <span style={{ fontSize: 12, color: "#111827", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.fileName || "(sin nombre)"}</span>
                  <span style={{ fontSize: 10.5, color: "#9CA3AF" }}>{v.archivedAt ? new Date(v.archivedAt).toLocaleDateString("es-ES",{day:"numeric",month:"short",year:"numeric"}) : ""}</span>
                  <a href={v.fileUrl} download={v.fileName} style={{ fontSize: 11, color: "#8E44AD", textDecoration: "none" }}>📥</a>
                  <button onClick={() => restoreVersion(i)} style={{ fontSize: 11, padding: "2px 6px", borderRadius: 6, background: "transparent", border: "1px solid #D1D5DB", color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>↩ Restaurar</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const iconBtn = { display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 6, background: "#fff", border: "1px solid #D1D5DB", color: "#374151", fontSize: 11.5, fontWeight: 600, cursor: "pointer", textDecoration: "none", fontFamily: "inherit" };
const iconBtnDanger = { ...iconBtn, color: "#B91C1C", borderColor: "#FCA5A5" };
