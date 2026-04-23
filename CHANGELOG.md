# Changelog SoulBaric

## Deuda técnica activa

### AppShell — routing interno por `activeTab`

El AppShell (Sidebar + TopBar) usa `activeTab` como router interno —
sin URLs. Toda la navegación (items de sidebar, breadcrumb, atajos
globales) llama a `setActiveTab("home" | "dealroom" | "mytasks" | …)`.

**Implicación**: no hay deep-links compartibles. Enviar a un compañero
"https://soulbaric.app/deal-room/neg_abc/sess_xyz" no es posible hoy.

**Migración requerida cuando haya usuarios externos consumiendo
links compartidos**:

1. Añadir `react-router-dom`.
2. Mapear cada `activeTab` actual a una ruta:
   - `home` → `/`
   - `dealroom` → `/deal-room` (+ `/deal-room/:negId` + `/deal-room/:negId/:sessId`)
   - `mytasks` → `/mis-tareas`
   - `dashboard` → `/dashboard`
   - `briefings` → `/briefings`
   - resto de tabs (projects, planner, workspaces, agents, users) → rutas propias.
3. Sustituir llamadas a `setActiveTab()` por `navigate()` del router.
4. Derivar `activeTab` / `activeNegId` / `activeSessId` de `useParams`
   en lugar de useState.
5. Asegurar que los atajos globales (⌘⇧H/D/T/A/B) llamen a `navigate`.

Mientras tanto, los atajos internos y el CommandPalette cubren el
flujo de navegación dentro de la app.

## Historial reciente

### 2026-04-23 — AppShell quick-win UX
- `b9a69a8` feat(ui): AppShell con Sidebar + TopBar extraído en App.jsx
- `440dfc2` feat(ui): vistas "Mis tareas" y "Briefings IA"
- (pendiente commit 3) feat(ux): atajos globales + ShortcutsModal
