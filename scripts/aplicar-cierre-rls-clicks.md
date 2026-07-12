# Aplicar cierre RLS de taskflow_state — instrucciones de clics

**PREREQ:** Backup completado. Los 3 archivos JSON en Desktop de Antonio
(taskflow_state, tenants, auth.users). Sin backup, NO aplicar.

**Riesgo perceptible:** solo si alguien usa "Modo demo" (tecla en
LoginScreen que activa `kluxor.legacyMode="1"` en localStorage). Ese
usuario quedaría en modo local-only sin sync. Si nadie lo usa (probable),
cero impacto perceptible en producción.

## Paso 1 — Confirmar que nadie usa modo legacy

En cada dispositivo donde alguien usa Kluxor (Antonio, Elena, Luis):
1. Abrir la app en el navegador.
2. Cmd+Opt+I (Mac) → **Application** (o **Almacenamiento** en Firefox).
3. Panel izquierdo → **Local Storage** → `https://tareas-equipo.vercel.app`.
4. Buscar clave `kluxor.legacyMode`.
5. **Si no existe** o vale `null`/`"0"`: bien.
6. **Si existe con valor `"1"`**: pulsar el "🔄 Cambiar usuario" del menú avatar para forzar re-login, o borrar esa clave manualmente.

Antonio: confirma que en TUS dispositivos no hay `kluxor.legacyMode="1"`. En los de Elena/Luis no puedes verlo remotamente — asumimos que no.

## Paso 2 — Aplicar el SQL en Supabase Studio

1. Ir a https://supabase.com/dashboard/projects → proyecto `iqilkicirtmmpvykogot`.
2. Menú izquierdo → **SQL Editor** (icono `</>`).
3. **+ New query**.
4. Abrir el archivo `migrations/2026-07-12-emergency-rls-taskflow-state.sql` en TextEdit (o el que uses para leer).
5. Seleccionar TODO el contenido del archivo (Cmd+A) → Copiar (Cmd+C).
6. Volver a Supabase Studio → pegar en el editor SQL (Cmd+V).
7. Botón verde **Run** (o Cmd+Enter).
8. Debajo del editor debe aparecer: **Success. No rows returned.**

Si sale error rojo: **NO SIGUE**. Pega el error en el chat.

## Paso 3 — Verificar las policies en Supabase

En el mismo SQL Editor:

1. Nuevo query (**+ New query**).
2. Pegar:

```sql
SELECT policyname, cmd, roles, qual::text, with_check::text
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'taskflow_state';
```

3. Run.
4. Debe aparecer **EXACTAMENTE 2 filas**:
   - `taskflow_state_select_own_tenant` · SELECT · {authenticated}
   - `taskflow_state_update_own_tenant` · UPDATE · {authenticated}

Si aparecen otras filas o falta alguna: reportar.

## Paso 4 — Volver al chat

Responde **"RLS aplicada, 2 policies confirmadas"** y sigo yo:
- Corro `smoke_f1_rls_deterministic.mjs` — debe devolver ✓ (UPDATE anon bloqueado).
- Extiendo `smoke_fase2_isolation.mjs` con checks de escritura.
- Verifico que la app sigue funcionando (bundle load, fetch tenant).
- Y con eso, cierro el incidente RLS y reanudamos F1.
