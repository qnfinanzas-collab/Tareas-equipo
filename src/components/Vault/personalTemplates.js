// personalTemplates — plantilla de documentación personal y familiar.
// Se siembra en cada `space` del vault al crear un titular nuevo.
//
// 8 categorías × 35+ documentos. Cada doc lleva `hasExpiry` para que el
// motor de alertas sepa qué docs vigilar (DNI, pasaporte, ITV, seguros).
// Todos arrancan en `status:"pending"` y `required:false` — al ser un
// vault personal, ningún documento es "obligatorio" por defecto, pero
// la plantilla cubre todo lo recomendable.

export const PERSONAL_CATEGORY_LABELS = {
  identificacion: "🪪 Identificación personal",
  fiscal:         "📊 Fiscal personal",
  propiedades:    "🏠 Propiedades",
  financiero:     "💳 Financiero personal",
  seguros:        "🛡️ Seguros",
  familia:        "👨‍👩‍👧‍👦 Familia y sucesión",
  vehiculos:      "🚗 Vehículos",
  formacion:      "🎓 Formación",
  otros:          "📂 Otros",
};
export const PERSONAL_CATEGORY_ORDER = [
  "identificacion","fiscal","propiedades","financiero",
  "seguros","familia","vehiculos","formacion","otros",
];

export const PERSONAL_DOCUMENT_TEMPLATES = {
  identificacion: [
    { name: "DNI / NIE",                 description: "Documento nacional de identidad o NIE vigente", hasExpiry: true },
    { name: "Pasaporte",                 description: "Pasaporte vigente", hasExpiry: true },
    { name: "Permiso de conducir",       description: "Carnet de conducir vigente", hasExpiry: true },
    { name: "Certificado digital personal", description: "Certificado FNMT persona física", hasExpiry: true },
    { name: "Foto carnet actualizada",   description: "Foto reciente para documentos oficiales", hasExpiry: false },
  ],
  fiscal: [
    { name: "Declaración IRPF 2025",     description: "Declaración de la renta ejercicio 2025", hasExpiry: false },
    { name: "Declaración IRPF 2024",     description: "Declaración de la renta ejercicio 2024", hasExpiry: false },
    { name: "Declaración Patrimonio",    description: "Impuesto sobre el patrimonio si aplica", hasExpiry: false },
    { name: "Modelo 720",                description: "Declaración bienes en extranjero >50k€", hasExpiry: false },
    { name: "Certificados retenciones",  description: "Certificados de retenciones de empresas", hasExpiry: false },
    { name: "Certificados bancarios",    description: "Certificados fiscales de bancos", hasExpiry: false },
  ],
  propiedades: [
    { name: "Escritura vivienda habitual", description: "Escritura de propiedad de tu vivienda", hasExpiry: false },
    { name: "Notas simples",             description: "Notas simples del Registro de la Propiedad", hasExpiry: false },
    { name: "Hipoteca",                  description: "Escritura de hipoteca vigente", hasExpiry: false },
    { name: "IBI viviendas",             description: "Últimos recibos de IBI", hasExpiry: false },
    { name: "Seguros hogar",             description: "Pólizas de seguro de hogar", hasExpiry: true },
    { name: "Contratos alquiler",        description: "Contratos como arrendador o arrendatario", hasExpiry: true },
  ],
  financiero: [
    { name: "Extractos bancarios",       description: "Extractos de cuentas bancarias", hasExpiry: false },
    { name: "Inversiones",               description: "Documentación de inversiones activas", hasExpiry: false },
    { name: "Préstamos personales",      description: "Contratos de préstamos vigentes", hasExpiry: true },
    { name: "Tarjetas de crédito",       description: "Contratos de tarjetas", hasExpiry: true },
  ],
  seguros: [
    { name: "Seguro de vida",            description: "Póliza de seguro de vida", hasExpiry: true },
    { name: "Seguro de salud",           description: "Póliza de seguro médico", hasExpiry: true },
    { name: "Seguro auto",               description: "Póliza de seguro del vehículo", hasExpiry: true },
    { name: "Seguro RC profesional",     description: "Responsabilidad civil profesional", hasExpiry: true },
  ],
  familia: [
    { name: "Libro de familia",          description: "Libro de familia actualizado", hasExpiry: false },
    { name: "Testamento",                description: "Testamento vigente ante notario", hasExpiry: false },
    { name: "Capitulaciones matrimoniales", description: "Régimen económico matrimonial", hasExpiry: false },
    { name: "Poderes notariales personales", description: "Poderes otorgados ante notario", hasExpiry: false },
    { name: "Seguros vida beneficiarios", description: "Detalle de beneficiarios en seguros de vida", hasExpiry: false },
  ],
  vehiculos: [
    { name: "Ficha técnica",             description: "Ficha técnica del vehículo", hasExpiry: false },
    { name: "Permiso circulación",       description: "Permiso de circulación", hasExpiry: false },
    { name: "ITV vigente",               description: "Inspección técnica del vehículo", hasExpiry: true },
    { name: "Contrato renting/leasing",  description: "Contrato de renting o leasing si aplica", hasExpiry: true },
  ],
  formacion: [
    { name: "Títulos académicos",        description: "Títulos universitarios y formativos", hasExpiry: false },
    { name: "Certificados profesionales", description: "Certificaciones profesionales vigentes", hasExpiry: true },
  ],
};

// Genera la lista canónica de documentos personales para un space.
// Estado inicial: pending para todos. required:false porque ningún
// doc personal es estrictamente obligatorio (a diferencia del societario).
export function generatePersonalDocuments() {
  const out = [];
  const now = new Date().toISOString();
  for (const [category, docs] of Object.entries(PERSONAL_DOCUMENT_TEMPLATES)) {
    for (const d of docs) {
      out.push({
        id: `pdoc_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        category,
        subcategory: null,
        name: d.name,
        description: d.description || "",
        required: false,
        hasExpiry: !!d.hasExpiry,
        status: "pending",
        fileUrl: null, fileName: null, fileType: null, fileSize: null,
        expiresAt: null, dueDate: null,
        uploadedBy: null, uploadedAt: null,
        versions: [], notes: "",
        createdAt: now,
      });
    }
  }
  return out;
}

// Stats para el header de un space.
export function computePersonalStats(documents) {
  const list = documents || [];
  const accountable = list.filter(d => d.status !== "not_applicable");
  const attached = accountable.filter(d => d.status === "attached").length;
  const pending  = accountable.filter(d => d.status === "pending" || d.status === "overdue").length;
  const expiringSoon = list.filter(d => {
    if (!d.expiresAt || d.status !== "attached") return false;
    const days = Math.floor((new Date(d.expiresAt) - new Date()) / 86400000);
    return days >= 0 && days <= 90;
  }).length;
  const total = accountable.length;
  const pct = total > 0 ? Math.round((attached / total) * 100) : 0;
  return { total, attached, pending, expiringSoon, pct };
}

// Calcula alertas de vencimiento agregadas para todo el vault. Tres niveles:
//   overdue: ya vencido
//   urgent: <30 días
//   soon:   <90 días
export function checkVaultAlerts(spaces) {
  const out = [];
  const today = new Date();
  for (const space of spaces || []) {
    for (const doc of space.documents || []) {
      if (!doc.expiresAt || doc.status !== "attached") continue;
      const days = Math.floor((new Date(doc.expiresAt) - today) / 86400000);
      if (days < 0) {
        out.push({ type: "overdue", spaceId: space.id, spaceName: space.name, docId: doc.id, doc: doc.name, days: Math.abs(days), expiresAt: doc.expiresAt });
      } else if (days < 30) {
        out.push({ type: "urgent", spaceId: space.id, spaceName: space.name, docId: doc.id, doc: doc.name, days, expiresAt: doc.expiresAt });
      } else if (days < 90) {
        out.push({ type: "soon", spaceId: space.id, spaceName: space.name, docId: doc.id, doc: doc.name, days, expiresAt: doc.expiresAt });
      }
    }
  }
  return out;
}
