-- ============================================================================
-- 2026-07-12 · EMERGENCIA · Cerrar RLS de taskflow_state
-- ============================================================================
--
-- MOTIVO:
--   La tabla taskflow_state tenía policies permisivas ("modo shadow de
--   Fase 2A" según src/lib/sync.js:13-16) que permitían UPDATE anónimo.
--   Auditoría del 2026-07-12 confirmó determinísticamente que un anon
--   con la clave publishable podía sobrescribir la fila id=1 (tenant de
--   Antonio). Evidencia: updated_at fijado a 1999-12-31T23:59:59Z desde
--   anon persistió en producción.
--
-- REQUISITOS ANTES DE APLICAR:
--   1) Backup completado (backup-taskflow_state-2026-07-12.json guardado
--      en Desktop de Antonio — ver scripts/backup-emergencia-rls.md).
--   2) Nadie usa modo legacy (kluxor.legacyMode="1" en localStorage).
--      Si alguien lo usa, se queda sin sync remoto tras aplicar esto.
--
-- EFECTO:
--   - anon: SELECT/INSERT/UPDATE/DELETE bloqueados.
--   - authenticated con tenant match (RPC current_tenant_id): SELECT/UPDATE.
--   - INSERT/DELETE: solo service_role (backend serverless en F1.2).
--
-- ROLLBACK:
--   Ver bloque comentado al final. Restaura las policies permisivas si
--   algo se rompe. NO uses rollback sin backup.
-- ============================================================================

BEGIN;

-- 1) DROP defensivo de policies existentes.
-- Como no sabemos los nombres exactos que usó quien creó el schema, dropeamos
-- todo lo que haya en pg_policies para esta tabla. Idempotente.
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'taskflow_state'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.taskflow_state', pol.policyname);
  END LOOP;
END $$;

-- 2) Asegurar RLS habilitado (por si alguien lo desactivó).
ALTER TABLE public.taskflow_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.taskflow_state FORCE ROW LEVEL SECURITY;

-- 3) SELECT — solo authenticated con tenant match.
-- current_tenant_id() ya existe como SECURITY DEFINER, STABLE — resuelve
-- el tenant del auth.uid() actual. Anon devuelve NULL y no matchea.
CREATE POLICY taskflow_state_select_own_tenant
  ON public.taskflow_state
  FOR SELECT
  TO authenticated
  USING (tenant_id = public.current_tenant_id());

-- 4) UPDATE — solo authenticated con tenant match, sin poder migrar
-- la fila a otro tenant (WITH CHECK bloquea cambiar tenant_id).
CREATE POLICY taskflow_state_update_own_tenant
  ON public.taskflow_state
  FOR UPDATE
  TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- 5) INSERT — SOLO service_role. La app cliente no crea filas nuevas de
-- taskflow_state; solo el endpoint /api/signup (F1.2) lo hace con
-- service_role, que salta RLS por diseño.
-- No creamos policy para INSERT: sin policy y con RLS forced,
-- INSERT queda bloqueado a authenticated y anon. service_role bypassa RLS.

-- 6) DELETE — nadie. Ni siquiera authenticated. Si hay que borrar un
-- tenant, se hace desde service_role con proceso administrativo.
-- No creamos policy: bloqueado a todos salvo service_role.

COMMIT;

-- ============================================================================
-- VERIFICACIÓN POST-APLICACIÓN (correr en SQL Editor tras el BEGIN/COMMIT):
-- ============================================================================
-- SELECT policyname, cmd, roles, qual::text, with_check::text
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'taskflow_state';
--
-- Debe devolver EXACTAMENTE 2 filas:
--   - taskflow_state_select_own_tenant · SELECT · {authenticated}
--   - taskflow_state_update_own_tenant · UPDATE · {authenticated}
-- ============================================================================

-- ============================================================================
-- ROLLBACK (solo si algo se rompe en producción tras aplicar):
-- ============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS taskflow_state_select_own_tenant ON public.taskflow_state;
-- DROP POLICY IF EXISTS taskflow_state_update_own_tenant ON public.taskflow_state;
-- CREATE POLICY taskflow_state_permissive_temp
--   ON public.taskflow_state
--   FOR ALL
--   TO anon, authenticated
--   USING (true)
--   WITH CHECK (true);
-- COMMIT;
--
-- IMPORTANTE: el rollback restaura el AGUJERO. Solo úsalo si la app se
-- rompe y necesitas restaurar servicio mientras se diagnostica. Luego
-- vuelve a aplicar el cierre.
-- ============================================================================
