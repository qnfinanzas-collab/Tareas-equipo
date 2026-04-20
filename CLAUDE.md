# TaskFlow — Guía para Claude Code

## Descripción del proyecto
TaskFlow es una app de gestión de tareas y equipos tipo Trello, con planificador IA que lee Google Calendar en tiempo real. Está pensada para integrarse con el CRM SoulBaric.

## Stack
- **React 18** + **Vite 5**
- Un solo fichero de componente: `src/App.jsx` (~1600 líneas)
- Sin librerías de UI externas — todo CSS inline con variables de diseño propias
- Sin estado persistente aún (los datos se resetean al recargar)

## Arrancar en local
```bash
npm install
npm run dev        # → http://localhost:3000
npm run build      # → dist/
npm run preview    # previsualiza el build
```

## Estructura actual
```
taskflow-project/
├── index.html
├── vite.config.js
├── package.json
├── src/
│   ├── main.jsx          # Entry point React
│   └── App.jsx           # Toda la app (componentes + lógica)
```

## Funcionalidades implementadas
- Tableros Kanban con drag & drop (sin librería externa)
- Colores exclusivos por persona (MP palette, 8 entradas)
- Matriz de Eisenhower automática (Q1–Q4 por urgencia + prioridad)
- Planificador IA async que lee ICS de Google Calendar
  - URL ICS de Marc Díaz ya configurada en INITIAL_DATA
  - Motor de margen de transporte (30 min por defecto)
  - Asignación automática respetando mañanas 08:00–13:00 fijas
- Sistema de alertas (críticas, avisos, asesor IA)
- Control de tiempo por tarea con cronómetro
- Reportes de tiempo por miembro y proyecto
- Gestión de proyectos (crear / editar / eliminar con confirmación inline)
- Gestión de usuarios (crear / editar / eliminar con confirmación inline)
- Sincronización Google Calendar (enlace wa.me para GCal + WhatsApp)
- Vista de disponibilidad semanal con bloqueos recurrentes

## Usuarios predefinidos
| ID | Nombre        | Color    | Rol     | ICS configurado |
|----|---------------|----------|---------|-----------------|
| 5  | Marc Díaz     | Coral    | Manager | Sí              |
| 6  | Antonio Díaz  | Rosa     | Editor  | No              |
| 7  | Albert Díaz   | Verde    | Editor  | No              |
| 0–4| Equipo demo   | Varios   | Varios  | No              |

## Próximos pasos sugeridos
1. **Persistencia** — conectar `localStorage` o una BD (Supabase / PocketBase)
2. **Google Calendar OAuth2** — integración real para leer/escribir eventos
3. **WhatsApp real** — Twilio API en lugar de enlaces wa.me
4. **Integración SoulBaric CRM** — campo `external_id` en tareas + webhooks
5. **Auth** — login por usuario para que cada miembro vea solo su vista
6. **Split de fichero** — separar en módulos: `components/`, `hooks/`, `data/`

## Convenciones de código
- Paleta de colores: constante `MP[]` (array indexado por member.id)
- Disponibilidad: objeto `avail` en cada miembro (ver `BASE_AVAIL`)
- Datos: todo en `useState(INITIAL_DATA)` en el componente raíz `TaskFlow`
- Callbacks: `useCallback` para evitar re-renders innecesarios
- Confirmaciones de borrado: inline en la UI (sin `window.confirm`)
- ICS fetch: proxy CORS `api.allorigins.win` para evitar bloqueos del navegador
