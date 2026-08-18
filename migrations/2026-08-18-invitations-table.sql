-- migrations/2026-08-18-invitations-table.sql
-- ================================================================
-- Crea la tabla public.invitations para desbloquear F1.2 Antesala.
--
-- CONTEXTO:
--   Los endpoints api/create-invite.js y api/signup.js escriben contra
--   esta tabla desde el commit 21178b2 (12/07/2026). Nunca se creó.
--   Los signups self-service llevan fallando con PGRST205 desde entonces.
--
-- SCHEMA REAL EXIGIDO POR EL CÓDIGO:
--   - api/create-invite.js:48-58   → INSERT {token, email, invited_by, tenant_id, expires_at}
--   - api/signup.js:42-45          → SELECT {id, email, token, used_at, revoked_at, expires_at}
--   - api/signup.js:134-138        → UPDATE {used_at}
--
-- SEGURIDAD (aprendizaje del incidente RLS taskflow_state del 12/07):
--   RLS ACTIVADA desde el minuto uno con policies estrictas. No confiamos
--   en "los endpoints usan service_role" — service_role bypassa RLS por
--   diseño, pero la tabla debe quedar cerrada por si algún día un cliente
--   la lee directamente con anon key.
--
-- ROLLBACK: al final del fichero, comentado.
-- ================================================================


-- ── 1. Extensión requerida para gen_random_uuid() ────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ── 2. Tabla ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invitations (
  id           bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token        uuid         NOT NULL DEFAULT gen_random_uuid(),
  email        text         NOT NULL,
  invited_by   uuid         NOT NULL,
  tenant_id    uuid         NULL,
  expires_at   timestamptz  NOT NULL,
  used_at      timestamptz  NULL,
  revoked_at   timestamptz  NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),

  -- El token es único: es la credencial de un solo uso que viaja en la URL.
  CONSTRAINT invitations_token_unique UNIQUE (token),

  -- Email normalizado (los endpoints hacen .toLowerCase() antes de INSERT/SELECT).
  CONSTRAINT invitations_email_lowercase CHECK (email = lower(email)),

  -- Formato email básico. No es un validador RFC completo — es defensa
  -- extra si un caller esquiva la validación del endpoint.
  CONSTRAINT invitations_email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  -- Consistencia temporal: no puede caducar antes de crearse.
  CONSTRAINT invitations_expires_after_creation CHECK (expires_at > created_at)
);


-- ── 3. Foreign keys ──────────────────────────────────────────────
--
-- invited_by → auth.users(id):
--   ON DELETE CASCADE — si borras el user en Supabase Auth, sus invitaciones
--   colgadas se limpian también (no dejamos basura).
--
-- tenant_id → public.tenants(id):
--   ON DELETE SET NULL — la invitación puede quedar huérfana del tenant
--   pero se preserva por historial. api/signup.js siempre crea un tenant
--   nuevo al aceptar; el link a un tenant existente es futuro.
--
ALTER TABLE public.invitations
  ADD CONSTRAINT invitations_invited_by_fk
    FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.invitations
  ADD CONSTRAINT invitations_tenant_id_fk
    FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


-- ── 4. Índices ───────────────────────────────────────────────────
-- token: ya cubierto por UNIQUE (índice implícito B-tree).
-- (email, expires_at): para cleanup de expiradas por email.
-- invited_by: para SELECT del owner viendo sus invitaciones.
CREATE INDEX IF NOT EXISTS idx_invitations_email_expires
  ON public.invitations (email, expires_at);

CREATE INDEX IF NOT EXISTS idx_invitations_invited_by
  ON public.invitations (invited_by);


-- ── 5. Row Level Security ────────────────────────────────────────
--
-- ESTRATEGIA:
--   - service_role  → bypass automático (Supabase lo hace por diseño).
--                     Los endpoints api/create-invite.js y api/signup.js
--                     usan supaAdmin (service_role), no tocan estas policies.
--   - authenticated → SELECT solo sus propias invitaciones (invited_by = auth.uid()).
--                     Sin INSERT / UPDATE / DELETE directos (todo via endpoint).
--   - anon          → DENY todo. Ningún cliente sin auth toca esta tabla.
--
-- Sin políticas explícitas para INSERT/UPDATE/DELETE → RLS bloquea por
-- default (fail-closed). Ese es el comportamiento que queremos.
--
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations FORCE ROW LEVEL SECURITY;

-- Owner ve sus propias invitaciones (dashboard futuro para gestionar).
CREATE POLICY invitations_select_own
  ON public.invitations
  FOR SELECT
  TO authenticated
  USING (invited_by = auth.uid());

-- NOTA: NO se crea policy para anon. Sin policy = deny (RLS por default).


-- ── 6. GRANTs mínimos ────────────────────────────────────────────
-- service_role tiene todos los permisos por defecto en Supabase — NO
-- necesita GRANT explícito, pero lo dejamos por claridad y para que un
-- rebuild del schema no dependa de asunciones del proveedor.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invitations TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.invitations_id_seq TO service_role;

-- authenticated: solo SELECT (filtrado por policy select_own).
GRANT SELECT ON public.invitations TO authenticated;

-- anon: NADA. No hay GRANT — deny por defecto.


-- ── 7. Refrescar cache de PostgREST ──────────────────────────────
-- Sin este NOTIFY, /api/* seguiría devolviendo PGRST205 hasta que
-- PostgREST reciclara solo. Manual = instantáneo.
NOTIFY pgrst, 'reload schema';


-- ================================================================
-- VERIFICACIÓN POST-APLICACIÓN (ejecutar como queries separadas
-- desde el SQL Editor para confirmar que todo quedó bien):
-- ================================================================
--
-- -- 1. Tabla existe con las 9 columnas
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='invitations'
-- ORDER BY ordinal_position;
--
-- -- 2. RLS habilitada + policies
-- SELECT relname, relrowsecurity, relforcerowsecurity
-- FROM pg_class WHERE relname='invitations';
-- SELECT policyname, cmd, roles, qual
-- FROM pg_policies WHERE tablename='invitations';
--
-- -- 3. FKs correctas
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'public.invitations'::regclass AND contype='f';
--
-- -- 4. Índices
-- SELECT indexname, indexdef FROM pg_indexes
-- WHERE schemaname='public' AND tablename='invitations';
--
-- -- 5. Las 7 tablas anteriores siguen intactas (sanity check)
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema='public' ORDER BY table_name;
-- -- Esperado: ceo_memory, hector_chat, hector_panel_state, hector_tickets,
-- --           invitations (NUEVA), taskflow_state, tenant_members, tenants
--
-- -- 6. Datos de los 3 tenants intactos
-- SELECT id, name FROM public.tenants ORDER BY id;
-- SELECT id, tenant_id FROM public.taskflow_state ORDER BY id;
--
-- ================================================================


-- ================================================================
-- ROLLBACK (solo si algo va mal — ejecutar en SQL Editor manualmente):
-- ================================================================
--
-- BEGIN;
-- DROP POLICY IF EXISTS invitations_select_own ON public.invitations;
-- DROP TABLE IF EXISTS public.invitations CASCADE;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
--
-- Efectos secundarios del rollback:
--   - Se pierden todas las invitaciones creadas hasta ese momento.
--   - Los endpoints /api/create-invite y /api/signup vuelven a PGRST205.
--   - NO afecta a tenants, tenant_members ni taskflow_state (FKs son
--     salientes desde invitations, no entrantes).
--
-- ================================================================
