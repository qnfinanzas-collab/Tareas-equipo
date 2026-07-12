// Estado inicial de un tenant nuevo. Idéntico a /initialState/blank.json
// pero embebido aquí para portabilidad en el bundle serverless de Vercel.
// Si se cambia uno, actualizar el otro.

export const BLANK_STATE = {
  _seededAgents: false,
  ceoProfile: { name: "", company: "", sector: "", description: "" },
  members: [],
  projects: [],
  boards: {},
  negotiations: [],
  agents: [],
  permissions: {},
  governance: { companies: [] },
  ceoMemory: {},
  vault: {},
  workspaces: [],
  accountingEntries: [],
  bankAccounts: [],
  bankMovements: [],
  movementCategories: [],
  chartOfAccounts: [],
  invoices: [],
  financeMovements: [],
  aiSchedule: [],
  favoriteProjectIds: [],
  favoriteNegotiationIds: [],
};
