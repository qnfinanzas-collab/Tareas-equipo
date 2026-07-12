# BACKUP DE EMERGENCIA — antes de cerrar RLS

**Motivo:** las policies RLS de `taskflow_state` permiten UPDATE anónimo. La anon key está en el bundle público. Cualquier persona puede sobrescribir la fila id=1 (tenant de Antonio) con `curl`. Necesitamos backup antes de aplicar el SQL que cierra la puerta.

**Duración estimada:** 5 minutos. Todo con clics, cero terminal.

---

## Paso 1 — Abrir Supabase Studio

1. Ir a https://supabase.com/dashboard/projects
2. Login con la cuenta del proyecto.
3. Seleccionar el proyecto **`iqilkicirtmmpvykogot`** (el URL contiene `iqilkicirtmmpvykogot.supabase.co`).

---

## Paso 2 — Backup de `taskflow_state` (LA CROWN JEWEL)

Esta tabla contiene el JSONB con los datos de todos los tenants: proyectos, tareas, negociaciones, memoria CEO, todo. Es la que hay que blindar.

1. En el menú lateral izquierdo: **SQL Editor** (icono `</>`, penúltimo grupo).
2. Botón verde **+ New query** (arriba derecha del editor).
3. Pegar este SQL:

```sql
-- Backup de taskflow_state (JSON completo con timestamp).
select jsonb_build_object(
  'exportedAt',    now(),
  'exportedFrom',  'taskflow_state',
  'rowCount',      count(*),
  'rows',          jsonb_agg(row_to_json(t.*))
) as backup
from public.taskflow_state t;
```

4. Botón **Run** (o Cmd+Enter).
5. Debajo del editor aparece la fila resultado. En la columna `backup`, botón **⋮** (tres puntos) → **View row** (o clic directo en la celda).
6. En el modal que se abre, botón **Copy value** (arriba derecha).
7. Pegar en un fichero de texto local en el Mac de Antonio, por ejemplo:
   - Abrir la app **TextEdit**.
   - Format → **Make Plain Text** (Cmd+Shift+T) — muy importante, si no rompe el JSON.
   - Cmd+V.
   - Guardar como: `~/Desktop/backup-taskflow_state-2026-07-12.json`.
8. Verificar tamaño: el archivo debe pesar entre **1 MB y 5 MB** (el JSON con proyectos, tareas, boards de Antonio). Si pesa 100 bytes, algo falló.

---

## Paso 3 — Backup de `tenants`

Tabla pequeña. Registra los tenants existentes.

1. Nuevo query (**+ New query**).
2. Pegar:

```sql
select jsonb_build_object(
  'exportedAt',    now(),
  'exportedFrom',  'tenants',
  'rowCount',      count(*),
  'rows',          jsonb_agg(row_to_json(t.*))
) as backup
from public.tenants t;
```

3. Run.
4. Copiar valor del resultado.
5. Guardar como `~/Desktop/backup-tenants-2026-07-12.json`.

---

## Paso 4 — Backup de `auth.users`

Los usuarios registrados (Antonio, Elena, Luis, Marc, Albert). Sin esto no se pueden restaurar accesos.

1. Nuevo query.
2. Pegar:

```sql
-- auth.users tiene columnas sensibles (encrypted_password, etc). Solo
-- extraemos lo mínimo para reconstruir: id, email, created_at, y metadata.
select jsonb_build_object(
  'exportedAt',    now(),
  'exportedFrom',  'auth.users (subset)',
  'rowCount',      count(*),
  'rows',          jsonb_agg(jsonb_build_object(
    'id',                u.id,
    'email',             u.email,
    'created_at',        u.created_at,
    'raw_user_meta_data',u.raw_user_meta_data,
    'raw_app_meta_data', u.raw_app_meta_data
  ))
) as backup
from auth.users u;
```

3. Run.
4. Copiar valor.
5. Guardar como `~/Desktop/backup-auth-users-2026-07-12.json`.

---

## Paso 5 — Verificación rápida

Antonio, abre los tres archivos en TextEdit y comprueba:
- `backup-taskflow_state-2026-07-12.json` → debe empezar por `{"exportedAt":`, contener `"rowCount":1` (o el número de tenants), y verse el JSONB con proyectos.
- `backup-tenants-2026-07-12.json` → debe contener al menos una fila con tu `id` (89934a37-…-ad81) y tu `owner_uid`.
- `backup-auth-users-2026-07-12.json` → varias filas con emails conocidos (qn.finanzas@gmail.com, elenaburgueno.finanzas@gmail.com, etc).

Si los tres se ven bien: **backup completado**. Responde en el chat y sigo con el resto (auditoría del código + SQL de cierre RLS).

Si algo falla: pega el error en el chat, lo desatasco.

---

## Nota sobre el backup permanente

Este backup es de EMERGENCIA — hecho a mano para no perder tiempo. El backup regular versionado (cifrado con openssl, guardado en `backup/`) queda como parte de F0 según tu plan original — este es solo un cinturón para hoy.

## Estado del incidente mientras backupeas

- `taskflow_state.id=1.updated_at = 1999-12-31T23:59:59+00:00` (evidencia forense del bug — se auto-corrige al primer cambio en la app).
- `data` (proyectos, tareas, memoria CEO) → **intacto**, cero pérdida.
- La ventana de riesgo sigue abierta hasta el SQL de cierre. Cuanto antes esté el backup, antes cerramos.
