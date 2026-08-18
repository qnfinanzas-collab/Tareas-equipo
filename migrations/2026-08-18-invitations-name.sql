-- migrations/2026-08-18-invitations-name.sql
-- ================================================================
-- Añade la columna `name` a public.invitations para persistir el
-- nombre completo del invitado (nombre + apellidos).
--
-- CONTEXTO:
--   Rediseño F1.2 "El Umbral": la invitación pasa de ser solo
--   {email} a ser {email, name}. El invitado se convoca por
--   nombre, no solo por correo, para reforzar el tono de club
--   privado desde el primer contacto.
--
--   Cero readers en producción hoy. La tabla invitations la crean
--   /api/create-invite y la lee /api/signup — ambos vía service_role,
--   ninguno consumidor del cliente. Añadir la columna es transparente
--   hasta que create-invite empiece a escribirla y SignupView a
--   mostrarla (cambios de código en commits posteriores).
--
-- ESTADO DE LA TABLA:
--   Creada hoy (migración 2026-08-18-invitations-table.sql, commit
--   6de7e67). Filas esperadas: <10 (los intentos de signup fallidos
--   + cualquier invitación pendiente creada durante la sesión). ADD
--   COLUMN nullable sobre tabla con datos vivos pero sin readers y
--   con volumen bajo → operación instantánea y transparente.
--
-- GARANTÍA DE INTEGRIDAD:
--   Este script solo modifica el schema de invitations añadiendo
--   una columna nueva. NO ejecuta ningún UPDATE ni DELETE sobre
--   filas existentes. Las invitaciones ya emitidas conservan sus
--   valores en las 9 columnas originales y obtienen NULL en la
--   nueva columna `name`, lo cual es correcto (no las inventamos
--   retroactivamente).
--
-- ROLLBACK: al final del fichero, comentado.
-- ================================================================


BEGIN;


-- ── 1. Añadir la columna name ────────────────────────────────────
-- Nullable, sin default, sin CHECK. Las invitaciones ya emitidas
-- quedan con name = NULL (aceptable — no reinventamos su historia).
-- IF NOT EXISTS hace la migración idempotente por si se reejecuta.
ALTER TABLE public.invitations
  ADD COLUMN IF NOT EXISTS name text;


-- ── 2. Refrescar cache de PostgREST ──────────────────────────────
-- Sin este NOTIFY, /api/create-invite seguiría sin ver la columna
-- al intentar escribirla, hasta que PostgREST reciclara solo.
NOTIFY pgrst, 'reload schema';


COMMIT;


-- ================================================================
-- VERIFICACIÓN POST-APLICACIÓN (queries separadas, solo lectura):
-- ================================================================
--
-- -- 1. La columna name existe, es nullable, sin default
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='invitations'
--   AND column_name='name';
-- -- Esperado: 1 fila. data_type=text. is_nullable=YES. column_default=NULL.
--
-- -- 2. Las 9 columnas originales intactas + name nueva = 10 total
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='invitations'
-- ORDER BY ordinal_position;
-- -- Esperado: 10 filas (id, token, email, invited_by, tenant_id,
-- --           expires_at, used_at, revoked_at, created_at, name).
--
-- -- 3. Invitaciones existentes tienen name=NULL
-- SELECT id, email, name, created_at FROM public.invitations
-- ORDER BY created_at DESC;
-- -- Esperado: todas las filas tienen name IS NULL (correcto —
-- --           se emitieron antes de existir la columna).
--
-- ================================================================


-- ================================================================
-- ROLLBACK (solo si algo va mal — ejecutar en SQL Editor manualmente):
-- ================================================================
--
-- BEGIN;
-- ALTER TABLE public.invitations DROP COLUMN IF EXISTS name;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
--
-- Efectos del rollback:
--   - Se pierden los nombres de las invitaciones creadas después
--     de la migración (los datos de esa columna). Las 9 columnas
--     originales permanecen intactas.
--   - /api/create-invite volverá a poder trabajar solo con {email}
--     (si aún no se ha modificado para escribir name) o fallará
--     con "column name does not exist" (si ya se modificó).
--   - NO afecta a tenants, tenant_members, taskflow_state ni a
--     ninguna otra tabla — el ALTER es local a invitations.
--
-- ================================================================
