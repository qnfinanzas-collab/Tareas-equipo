-- dump-policies.sql — vuelca las policies RLS actuales de Supabase para
-- versionarlas en el repo (F0 · migración baseline previa a cualquier
-- cambio de RLS en el frente de facturación).
--
-- CÓMO USARLO:
--   1. Abre Supabase dashboard → SQL Editor → New query.
--   2. Pega TODO este archivo, ejecuta.
--   3. Copia el output completo de la sección "OUTPUT ESPERADO"
--      (bloques CREATE POLICY... generados).
--   4. Pega el output aquí (o en el chat) y yo lo persisto en
--      migrations/2026-07-08-policies-baseline.sql como bloque FORWARD.
--
-- NO CAMBIA NADA en Supabase — es solo SELECT.

-- ────────────────────────────────────────────────────────────────────
-- Vuelca policies RLS activas de todas las tablas del schema public.
-- Formatea cada policy como sentencia CREATE POLICY reproducible.
-- ────────────────────────────────────────────────────────────────────

SELECT
  '-- Tabla: ' || schemaname || '.' || tablename || E'\n' ||
  '-- Policy: ' || policyname || E'\n' ||
  'CREATE POLICY ' || quote_ident(policyname) ||
  ' ON ' || quote_ident(schemaname) || '.' || quote_ident(tablename) ||
  E'\n  AS ' || permissive ||
  E'\n  FOR ' || cmd ||
  E'\n  TO ' || array_to_string(roles, ', ') ||
  CASE WHEN qual IS NOT NULL     THEN E'\n  USING (' || qual || ')' ELSE '' END ||
  CASE WHEN with_check IS NOT NULL THEN E'\n  WITH CHECK (' || with_check || ')' ELSE '' END ||
  ';' || E'\n'
  AS policy_statement
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- ────────────────────────────────────────────────────────────────────
-- Verificación adicional: RLS activada / desactivada por tabla.
-- Necesario para saber si hay tablas con RLS enabled pero SIN policies
-- (bloqueo total anon) — patrón usado en tenants tras Fase 1.
-- ────────────────────────────────────────────────────────────────────

SELECT
  '-- ' || schemaname || '.' || tablename || ' | RLS: ' ||
  CASE WHEN rowsecurity THEN 'ENABLED' ELSE 'DISABLED' END ||
  ' | policies: ' || (
    SELECT COUNT(*) FROM pg_policies p
    WHERE p.schemaname = t.schemaname AND p.tablename = t.tablename
  )::text
  AS rls_status
FROM pg_tables t
WHERE schemaname = 'public'
ORDER BY tablename;

-- ────────────────────────────────────────────────────────────────────
-- OUTPUT ESPERADO:
--   Primera query: N filas, una por policy. Cada fila es un CREATE
--   POLICY reproducible. Copia TODAS.
--   Segunda query: N filas, una por tabla. Muestra si RLS está
--   activado y cuántas policies tiene. Copia TODAS.
--
-- Formato final que yo persistiré en la migration:
--
--   -- ==== FORWARD (baseline capturado del proyecto Supabase el
--   -- 2026-07-08 antes del upgrade a Pro + activación de PITR) ====
--
--   -- policies:
--   <output primera query>
--
--   -- estado RLS por tabla:
--   <output segunda query>
--
--   -- ==== ROLLBACK (DROP de las policies creadas arriba) ====
--   -- DROP POLICY IF EXISTS <policyname> ON public.<tablename>;
--   -- ...
-- ────────────────────────────────────────────────────────────────────
