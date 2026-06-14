-- Fase 1 multi-tenant — matrículas tenant_id.
-- Ejecutado en panel Supabase (SQL Editor) el 2026-06-14.
-- SQL estrictamente aditiva. data JSONB de la fila id=1 NO se toca.
-- Backup previo: commit ce4682d (backup/taskflow_state-id1-2026-06-13.json.enc).
-- Passphrase en 1Password del CEO ("Kluxor backup 2026-06-13").
--
-- Verificación post-ejecución desde la anon key (sandbox):
--   SHA-256 de data JSONB pre/post = 48c3fa8580971c1c8c3f49bbc2aaf0030666d368f5e69fbca9ee35f5d50081db
--   bytes 2.650.074 · 57 projects · 57 negotiations · 599 bankMovements · ceoMemory(5) · governance(4)
--   updated_at intacto: 2026-06-13T21:42:34.558+00:00 (no hay trigger que bumpee mtime).
--   E2E real validado por el CEO tras hard reload (Cmd+Shift+R).
--
-- Cero cambios de código de la app en esta fase. La columna tenant_id vive
-- presente, poblada e inerte — ningún consumidor del cliente la lee.
-- sync.js sigue accediendo por .eq("id",1) como antes.

-- ────────────────────────────────────────────────────────────────────
-- FORWARD (las 4 sentencias ejecutadas, en orden)
-- ────────────────────────────────────────────────────────────────────

-- 1) Registro de tenants. RLS activada en la propia tabla (anon no la lee).
CREATE TABLE public.tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  owner_uid   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
-- (Activado por el CEO en el paso 1, sin policies aún — bloqueo total para anon).

-- 2) Tenant del CEO actual. owner_uid = supabaseUid de Antonio.
--    UUID devuelto: 89934a37-60d9-49ac-8a41-dad10601ad81 (guardado en 1Password).
INSERT INTO public.tenants (name, owner_uid)
VALUES ('Antonio Díaz · ALMA DIMO', '2d958a69-9484-4306-b015-6b0a6356fbd1')
RETURNING id;

-- 3) Matrícula tenant_id en taskflow_state (aditiva, nullable, FK).
ALTER TABLE public.taskflow_state
  ADD COLUMN tenant_id uuid REFERENCES public.tenants(id);

-- 4) Backfill de la fila histórica id=1.
UPDATE public.taskflow_state
   SET tenant_id = '89934a37-60d9-49ac-8a41-dad10601ad81'
 WHERE id = 1
RETURNING id, tenant_id;

-- ────────────────────────────────────────────────────────────────────
-- ROLLBACK (en orden inverso, descomentar y ejecutar si hace falta).
-- Cada sentencia es segura individualmente: si el paso correspondiente
-- nunca llegó a ejecutarse, el rollback falla limpio sin tocar datos.
-- ────────────────────────────────────────────────────────────────────

-- -- Rollback 4 (poner tenant_id de id=1 a NULL):
-- UPDATE public.taskflow_state SET tenant_id = NULL WHERE id = 1;

-- -- Rollback 3 (quitar columna):
-- ALTER TABLE public.taskflow_state DROP COLUMN tenant_id;

-- -- Rollback 2 (borrar fila del tenant):
-- DELETE FROM public.tenants WHERE owner_uid = '2d958a69-9484-4306-b015-6b0a6356fbd1';

-- -- Rollback 1 (borrar tabla):
-- DROP TABLE public.tenants;

-- Los 2,7 MB de data de la fila id=1 nunca se tocan en ninguno de los
-- rollbacks. Si todo falla, restaurar desde backup/taskflow_state-id1-2026-06-13.json.enc
-- (commit ce4682d) con la passphrase en 1Password.
