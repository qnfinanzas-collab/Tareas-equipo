# Backups Kluxor — Fase 0 multi-tenant

Esta carpeta solo contiene **dumps cifrados** de `taskflow_state`. Los
plaintext y la passphrase NUNCA entran en git (ver `.gitignore`).

## Convención de nombres

```
taskflow_state-id{N}-YYYY-MM-DD.json.enc
```

`{N}` = id de la fila (hoy siempre 1; cuando llegue multi-tenant, irá por
`tenant_id` y se anotará en el commit).

## Cifrado

OpenSSL AES-256-CBC con PBKDF2 (200000 iteraciones, salt aleatorio).

Cifrar:
```bash
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in taskflow_state-id1-YYYY-MM-DD.json \
  -out taskflow_state-id1-YYYY-MM-DD.json.enc \
  -pass pass:<PASSPHRASE>
```

Descifrar (cuando haga falta restaurar):
```bash
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -d \
  -in taskflow_state-id1-YYYY-MM-DD.json.enc \
  -out taskflow_state-id1-YYYY-MM-DD.json \
  -pass pass:<PASSPHRASE>
```

## Passphrase

NO vive aquí. Guardada en 1Password del CEO bajo entrada "Kluxor backup
{fecha}". Sin la passphrase, el `.enc` es inutilizable. **Si se pierde
la passphrase, el backup se pierde.** Verificar 1Password antes de
confiar en el .enc.

## Copias redundantes de cada backup

Cada dump existe en tres sitios:
1. `~/Desktop/kluxor-backups/` (plaintext, fuera del repo, persistente local).
2. `/tmp/kluxor-backup-faseN/` (plaintext, volátil — solo para la sesión).
3. `backup/*.json.enc` aquí en el repo (cifrado, en GitHub).

La copia 3 es la única que sobrevive un wipe del Mac.

## Restauración

Para volver a poner una fila id=1 en producción a partir del `.enc`:

1. Descifrar localmente.
2. Validar JSON con `jq . taskflow_state-id1-YYYY-MM-DD.json > /dev/null`.
3. UPSERT en Supabase con:
   ```sql
   UPDATE taskflow_state SET data = '<jsonb>' WHERE id = 1;
   ```
   (o, si la fila se borró, INSERT con id=1).
4. Validar que el cliente vuelve a montar el estado completo (smoke C1).

**Nunca restaurar sin confirmar con el CEO antes** — restaurar machaca
cualquier dato que esté en producción en el momento.
