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
