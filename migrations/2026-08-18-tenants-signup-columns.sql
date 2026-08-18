-- migrations/2026-08-18-tenants-signup-columns.sql
-- ================================================================
-- Añade a public.tenants las 4 columnas que /api/signup.js escribe
-- (plan, status, trial_start, trial_ends_at) y backfilea los 3
-- tenants fundacionales existentes.
--
-- CONTEXTO:
--   Tras aplicar 2026-08-18-invitations-table.sql, el flujo end-to-end
--   /api/signup falló en el paso "crear tenant" con:
--     "Could not find the 'plan' column of 'tenants' in the schema cache"
--
--   El código hardcodea plan/status/trial_start/trial_ends_at desde el
--   commit 21178b2 (12/07). El esquema real de tenants (schema-01
--   columns.csv del backup 2026-08-18) confirma: solo 4 columnas
--   (id, name, owner_uid, created_at). Faltan las 4 de signup.
--
-- DECISIÓN DE PRODUCTO (Antonio, 18/08/2026):
--   Los 3 tenants fundacionales existentes NUNCA deben ver muro de pago.
--   Se marcan como plan='founder' + status='active'. trial_start y
--   trial_ends_at quedan NULL (no aplican a founder).
--
-- SEGURIDAD:
--   ADD COLUMN nullable sin default → operación near-instant en Postgres
--   11+, AccessExclusiveLock momentáneo, sin reescritura de filas.
--   Las 3 filas existentes obtienen NULL en las nuevas columnas y luego
--   el UPDATE del backfill las pone a 'founder'/'active'.
--
--   NO se tocan id, name, owner_uid, created_at. NO se cambian tipos.
--   NO se añade NOT NULL ni CHECK — brief de Antonio explícito.
--
--   Transacción envolvente: si cualquier paso falla, nada queda a medias.
--
-- SEPARADO DE ESTE SQL:
--   /api/signup.js:124 escribe `email` en tenant_members, columna que
--   NO existe en esa tabla (confirmado desde el backup). El fix
--   recomendado es quitar el campo email del INSERT (código, no schema)
--   porque el email ya vive en auth.users vía user_uid. Ese cambio va
--   aparte, en un commit distinto.
--
-- ROLLBACK: al final del fichero, comentado.
-- ================================================================


BEGIN;

-- ── 1. Añadir las 4 columnas nullable ────────────────────────────
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS plan          text;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS status        text;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS trial_start   timestamptz;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;


-- ── 2. Backfill de los 3 tenants fundacionales ───────────────────
-- Idempotente: la condición WHERE plan IS NULL solo pilla los que
-- aún no tienen valor. Reejecutar la migración no reescribe los
-- tenants nuevos que /api/signup ya creó con plan='trial'.
UPDATE public.tenants
   SET plan   = 'founder',
       status = 'active'
 WHERE plan IS NULL;


-- ── 3. Refrescar cache de PostgREST ──────────────────────────────
-- Sin este NOTIFY, /api/signup seguiría viendo 'plan does not exist'
-- hasta que PostgREST reciclara solo.
NOTIFY pgrst, 'reload schema';


COMMIT;


-- ================================================================
-- VERIFICACIÓN POST-APLICACIÓN (queries separadas, solo lectura):
-- ================================================================
--
-- -- 1. Las 4 columnas nuevas presentes
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='tenants'
--   AND column_name IN ('plan','status','trial_start','trial_ends_at')
-- ORDER BY ordinal_position;
-- -- Esperado: 4 filas, todas is_nullable='YES', sin default.
--
-- -- 2. Los 3 tenants fundacionales marcados
-- SELECT id, name, plan, status, trial_start, trial_ends_at
-- FROM public.tenants
-- ORDER BY created_at;
-- -- Esperado: 3 filas, plan='founder', status='active',
-- --           trial_start y trial_ends_at ambos NULL.
--
-- -- 3. Ningún tenant queda con plan NULL tras el backfill
-- SELECT COUNT(*) FROM public.tenants WHERE plan IS NULL;
-- -- Esperado: 0.
--
-- -- 4. Estructura intacta del resto de columnas
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='tenants'
--   AND column_name IN ('id','name','owner_uid','created_at')
-- ORDER BY ordinal_position;
-- -- Esperado: 4 filas idénticas a antes (id uuid PK gen_random_uuid,
-- --           name/owner_uid NOT NULL, created_at NOT NULL default now).
--
-- ================================================================


-- ================================================================
-- ROLLBACK (solo si algo va mal — ejecutar en SQL Editor manualmente):
-- ================================================================
--
-- BEGIN;
-- ALTER TABLE public.tenants DROP COLUMN IF EXISTS trial_ends_at;
-- ALTER TABLE public.tenants DROP COLUMN IF EXISTS trial_start;
-- ALTER TABLE public.tenants DROP COLUMN IF EXISTS status;
-- ALTER TABLE public.tenants DROP COLUMN IF EXISTS plan;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
--
-- Efectos del rollback:
--   - Los 3 tenants fundacionales vuelven a tener solo 4 columnas.
--   - Cualquier tenant creado post-migración vía /api/signup pierde
--     sus valores de plan/status/trial* (pero conserva id, name,
--     owner_uid, created_at → sigue existiendo y funcional).
--   - /api/signup volverá a fallar con "plan does not exist" hasta
--     que se re-aplique la migración.
--   - NO afecta a taskflow_state, tenant_members, invitations ni al
--     resto de tablas — el ALTER es local a tenants.
--
-- ================================================================
