// Supabase Storage helpers para el bucket "documents".
// Bucket debe existir en Supabase (crear manualmente o dejar que el primer
// upload intente crearlo). Pública=false; se accede vía signed URLs.

import { supa } from "./sync.js";

export const STORAGE_BUCKET = "documents";
export const MAX_FILE_MB = 10;
export const ALLOWED_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
  "text/plain",
];

export function storageEnabled(){ return !!supa; }

export function validateFile(file){
  if(!file) return "Sin archivo";
  if(file.size > MAX_FILE_MB*1024*1024) return `Máximo ${MAX_FILE_MB}MB`;
  if(!ALLOWED_MIME.includes(file.type||"")) return `Tipo no permitido: ${file.type||"desconocido"}`;
  return null;
}

export async function uploadDocument(file, ownerKey){
  if(!supa) throw new Error("Storage no disponible (sin Supabase)");
  const err = validateFile(file); if(err) throw new Error(err);
  // El bucket se asume creado manualmente en Supabase (crear buckets desde
  // el cliente requiere permisos de RLS que la anon key no suele tener).
  // Si no existe, el upload fallará con un mensaje claro de Supabase.
  const ts = Date.now();
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g,"_");
  const path = `${ownerKey}/${ts}-${safeName}`;
  const { error } = await supa.storage.from(STORAGE_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type,
  });
  if(error) throw new Error(error.message);
  return { storagePath: path, name: file.name, type: file.type, size: file.size };
}

export async function getSignedUrl(storagePath, expiresIn = 3600){
  if(!supa) throw new Error("Storage no disponible");
  const { data, error } = await supa.storage.from(STORAGE_BUCKET).createSignedUrl(storagePath, expiresIn);
  if(error) throw new Error(error.message);
  return data.signedUrl;
}

export async function downloadDocumentBlob(storagePath){
  if(!supa) throw new Error("Storage no disponible");
  const { data, error } = await supa.storage.from(STORAGE_BUCKET).download(storagePath);
  if(error) throw new Error(error.message);
  return data;
}

export async function deleteDocument(storagePath){
  if(!supa) return;
  try { await supa.storage.from(STORAGE_BUCKET).remove([storagePath]); }
  catch(e){ console.warn("[storage] delete", e.message); }
}

export function blobToBase64(blob){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=>{
      const s = String(r.result||"");
      const comma = s.indexOf(",");
      resolve(comma>=0 ? s.slice(comma+1) : s);
    };
    r.onerror = ()=>reject(r.error||new Error("read error"));
    r.readAsDataURL(blob);
  });
}

export function fmtFileSize(bytes){
  if(!bytes) return "0 B";
  if(bytes < 1024) return `${bytes} B`;
  if(bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
}

// Convierte data: URL (base64) a File para poder pasarla a uploadDocument.
// Útil para migrar documentos legacy que se guardaron como base64 dentro
// del JSONB de taskflow_state.
export function dataUrlToFile(dataUrl, fileName, fallbackType = "application/octet-stream") {
  if (!dataUrl) return null;
  try {
    const [header, b64] = dataUrl.split(",");
    const mime = (header.match(/data:([^;]+)/) || [])[1] || fallbackType;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], fileName || "documento", { type: mime });
  } catch { return null; }
}

// Upload directo desde data URL — atajo cuando el componente ya tiene el
// base64 (drag&drop con FileReader.readAsDataURL). Devuelve el mismo
// payload que uploadDocument: {storagePath, name, type, size}.
export async function uploadFromDataUrl(dataUrl, fileName, ownerKey) {
  const file = dataUrlToFile(dataUrl, fileName);
  if (!file) throw new Error("Data URL inválida");
  return uploadDocument(file, ownerKey);
}

// Caché de signed URLs en memoria. createSignedUrl es barata pero la URL
// expira; cachearla 50 minutos (TTL Supabase 60min) evita re-llamar al
// API en cada render. El componente puede ignorar la caché y forzar
// refresh con `getSignedUrlCached(path, {force:true})`.
const _signedUrlCache = new Map(); // path → {url, expiresAt}
export async function getSignedUrlCached(storagePath, opts = {}) {
  const { force = false, expiresIn = 3600 } = opts;
  const now = Date.now();
  const cached = _signedUrlCache.get(storagePath);
  if (!force && cached && cached.expiresAt > now) return cached.url;
  const url = await getSignedUrl(storagePath, expiresIn);
  // Cacheamos un poco antes del expiry real para evitar carrera.
  _signedUrlCache.set(storagePath, { url, expiresAt: now + (expiresIn - 60) * 1000 });
  return url;
}
export function clearSignedUrlCache(path) {
  if (path) _signedUrlCache.delete(path);
  else _signedUrlCache.clear();
}

// ── Migración de documentos legacy base64 → bucket ────────────────────────
// Recorre data.governance.documents[] y data.vault.spaces[*].documents[]
// buscando entradas con `fileUrl` que empiece por "data:" y SIN `storagePath`.
// Sube cada una al bucket bajo el prefijo correcto y devuelve un nuevo objeto
// `data` con storagePath en lugar de fileUrl. Procesamiento en SERIE para no
// saturar; cap configurable (`maxPerRun`) para repartir migraciones grandes
// entre sesiones. Devuelve {migrated, errors, nextData}.
//
// Esta función NO muta el data original: trabaja sobre una copia y el caller
// decide cuándo persistir (setData + push a Supabase).
export async function migrateBase64DocsInData(data, opts = {}) {
  if (!supa) return { migrated: 0, errors: 0, nextData: data, skipped: 0 };
  const { maxPerRun = 10, onProgress } = opts;
  // Clonamos solo lo que vamos a tocar.
  const next = { ...data };
  let migrated = 0, errors = 0, skipped = 0;

  // Helper: sube un doc legacy y devuelve la versión actualizada.
  const upgradeDoc = async (doc, ownerKey) => {
    if (!doc?.fileUrl || !doc.fileUrl.startsWith("data:") || doc.storagePath) {
      return doc; // ya migrado o sin archivo
    }
    if (migrated + errors >= maxPerRun) { skipped++; return doc; }
    try {
      const file = dataUrlToFile(doc.fileUrl, doc.fileName || "documento");
      if (!file) { errors++; return doc; }
      const meta = await uploadDocument(file, ownerKey);
      migrated++;
      onProgress?.({ migrated, errors, lastFile: doc.fileName });
      return { ...doc, storagePath: meta.storagePath, fileUrl: null };
    } catch (e) {
      console.warn("[migrate] upload fallo:", doc.fileName, e?.message);
      errors++;
      return doc;
    }
  };

  // Governance documents
  if (next.governance?.documents) {
    const out = [];
    for (const d of next.governance.documents) {
      if (migrated + errors >= maxPerRun) { out.push(d); skipped++; continue; }
      const ownerKey = `governance/${d.companyId || "_orphan"}`;
      out.push(await upgradeDoc(d, ownerKey));
    }
    next.governance = { ...next.governance, documents: out };
  }

  // Vault spaces
  if (next.vault?.spaces) {
    const outSpaces = [];
    for (const sp of next.vault.spaces) {
      const docsOut = [];
      for (const d of (sp.documents || [])) {
        if (migrated + errors >= maxPerRun) { docsOut.push(d); skipped++; continue; }
        const ownerKey = `vault/${sp.id}`;
        docsOut.push(await upgradeDoc(d, ownerKey));
      }
      outSpaces.push({ ...sp, documents: docsOut });
    }
    next.vault = { ...next.vault, spaces: outSpaces };
  }

  return { migrated, errors, skipped, nextData: next };
}
