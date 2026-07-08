# Backup pre-facturación (F0 — Prerequisitos infra)

**Objetivo**: red de seguridad antes de tocar Vercel (migración a equipo
`kluxor`) o Supabase (upgrade a Pro + PITR). Si algo se rompe durante F0,
este backup permite restaurar exactamente el estado del **2026-07-08**.

**Alcance del dump**: 3 fuentes que juntas contienen todo el estado
tenant/data/identidad:

1. `public.taskflow_state` — los ~2.7 MB de JSONB por tenant (proyectos,
   tareas, negociaciones, places, dayPlans, memoria, etc.).
2. `public.tenants` — la tabla que asocia `tenant_id` con `owner_uid`.
3. `auth.users` — usuarios autenticados (Antonio, Elena, Luis y demás
   invitados actuales). Necesario porque un rollback tendría que
   restaurar la asociación email↔uid.

Datos sensibles → todo cifrado antes de salir del portátil.

---

## Prerequisitos en tu máquina

- OpenSSL (`openssl version` — viene de serie en macOS).
- Acceso al dashboard Supabase con la cuenta owner.
- 1Password abierto para guardar la passphrase.
- 15-20 minutos.

---

## Paso 1 — Generar passphrase

En terminal:

```bash
openssl rand -base64 32
```

Copia la salida. Es una cadena tipo `Xy7kL9pR/qWm2NvZ8+dJcH5tYbF3aGqE...`.

Guarda AHORA mismo en 1Password:

- **Entrada**: `Kluxor · backup pre-facturación 2026-07-08`
- **Campo password**: la passphrase generada.
- **Campo notes**: `Cifra los dumps de taskflow_state + tenants + auth.users generados el 2026-07-08 antes del F0 (Vercel Pro + Supabase Pro). Necesaria para restaurar si algo se rompe.`

**Sin la passphrase, los dumps son inservibles**. Guardarla es el paso más importante del backup.

---

## Paso 2 — Dump de las 3 tablas (SQL Editor Supabase)

Abre el dashboard Supabase → **SQL Editor** → New query.

Ejecuta las 3 queries (una por una — el resultado de cada una se
descarga con el botón "Download CSV" o "Export"; guarda los 3 archivos
en la carpeta `~/kluxor-backup-2026-07-08/`).

### 2a) Dump `taskflow_state`

```sql
SELECT
  id,
  tenant_id,
  data,
  updated_at
FROM public.taskflow_state
ORDER BY id;
```

Descarga como JSON → `~/kluxor-backup-2026-07-08/taskflow_state.json`.

> El dashboard puede tardar unos segundos (2.7 MB por fila). Si el
> Export JSON no está disponible, usa "Copy" y pega en un archivo.

### 2b) Dump `tenants`

```sql
SELECT
  id,
  name,
  owner_uid,
  created_at
FROM public.tenants
ORDER BY created_at;
```

Descarga como JSON → `~/kluxor-backup-2026-07-08/tenants.json`.

### 2c) Dump `auth.users` (parcial — solo campos necesarios)

`auth.users` no es visible desde SQL Editor por defecto (esquema
protegido). Usa la vista de **Authentication → Users** del dashboard →
botón **Export** → CSV con todos los usuarios.

Guarda como `~/kluxor-backup-2026-07-08/auth_users.csv`.

> Este export contiene emails + uids. Es el binding que resuelve
> `resolveSessionMember`. Necesario para restaurar la identidad de
> Antonio/Elena/Luis en un rollback.

---

## Paso 3 — Cifrar los 3 archivos

En terminal (desde la carpeta `~/kluxor-backup-2026-07-08/`):

```bash
cd ~/kluxor-backup-2026-07-08

# Pega la passphrase cuando openssl la pida (dos veces por confirmación).
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in taskflow_state.json -out taskflow_state.json.enc
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in tenants.json -out tenants.json.enc
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in auth_users.csv -out auth_users.csv.enc
```

**Borra los archivos sin cifrar** (importante):

```bash
rm taskflow_state.json tenants.json auth_users.csv
```

Solo deben quedar los `.enc` en la carpeta.

---

## Paso 4 — Verificar que un `.enc` se puede descifrar

Prueba con uno de los tres (el más pequeño, `tenants.json.enc`) para
confirmar que la passphrase funciona:

```bash
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -d \
  -in tenants.json.enc -out /tmp/verify-tenants.json
cat /tmp/verify-tenants.json | head -5
rm /tmp/verify-tenants.json
```

Debe pedirte la passphrase y mostrar las primeras líneas del JSON con
`id`, `name`, `owner_uid`. Si no descifra, la passphrase no era
correcta — repite Paso 3 con la passphrase del 1Password.

---

## Paso 5 — Adjuntar los `.enc` a la entrada de 1Password

Abre la entrada `Kluxor · backup pre-facturación 2026-07-08`:

- Añade attachment: `taskflow_state.json.enc`
- Añade attachment: `tenants.json.enc`
- Añade attachment: `auth_users.csv.enc`

Verifica que los 3 attachments están guardados. Después borra los
archivos locales:

```bash
rm ~/kluxor-backup-2026-07-08/*.enc
rmdir ~/kluxor-backup-2026-07-08
```

Los `.enc` viven exclusivamente en 1Password. La passphrase también.
Sin ambos no hay restauración → 1Password se convierte en el
single-point-of-truth del backup. Si pierdes acceso a 1Password, se
pierde el backup — asegúrate de tener recovery configurado.

---

## Paso 6 — Notificar en el chat

Cuando los 3 attachments estén en 1Password y los archivos locales
borrados, avísame con:

> "Backup F0 hecho: 3 dumps cifrados en 1Password entrada 'Kluxor ·
> backup pre-facturación 2026-07-08', passphrase guardada, locales
> borrados."

Con ese mensaje puedo empezar el paso 2 de F0 (migration policies
baseline).

---

## Restauración (solo si algo se rompe durante F0-F1)

Descifra los `.enc` con:

```bash
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -d \
  -in taskflow_state.json.enc -out taskflow_state.json
```

Y para restaurar:

- `taskflow_state.json` → importar via Supabase SQL Editor `INSERT` por
  cada fila (o `pg_restore` si tienes acceso directo a Postgres).
- `tenants.json` → `INSERT INTO public.tenants ...` con los campos
  originales.
- `auth_users.csv` → **NO se restaura directo**. `auth.users` requiere
  llamada a `supa.auth.admin.createUser` con el mismo `id` (uid) — se
  hace desde un script Node con service_role. Si llega este momento,
  paramos F0 y hacemos el script ad-hoc.

---

## Después del backup

Cuando Paso 6 esté confirmado, pasamos a los pasos de infra que
haces tú desde los paneles (guiado):

1. Migration `2026-07-08-policies-baseline.sql` — yo la prepararé con
   el output de la query `scripts/queries/dump-policies.sql` (que
   ejecutas también desde SQL Editor).
2. Crear equipo Vercel `kluxor` a nombre de Antonio persona física
   (facturación provisional autónomo). Nombre corto y agnóstico de
   sociedad futura.
3. Migrar el proyecto actual al equipo `kluxor` con env vars
   completas (Supabase URL/KEY, Anthropic key). Confirmar que
   `maxDuration:180` de `api/agent.js` ya surte efecto (Héctor deja
   de cortarse a 10s en operaciones largas).
4. Supabase → Settings → Billing → Upgrade to Pro. Activar PITR (Point
   In Time Recovery) desde Database → Backups.
5. Verificación conjunta (yo desde el repo, tú desde tu iPhone):
   - `npm run smoke:prod` verde.
   - `node scripts/smoke/smoke_fase2_isolation.mjs` verde (aislamiento
     inter-tenant intacto).
   - Un turno largo con Héctor que antes se cortaba: ahora debe
     completarse sin ERR_LAMBDA_TIMEOUT.

Con F0 cerrado, entramos en F1a (SQL migration para tablas
`subscriptions` + `invitations`) — decisión producto por delante:
grandfathering Antonio/Elena/Luis con `plan='circulo'`.
