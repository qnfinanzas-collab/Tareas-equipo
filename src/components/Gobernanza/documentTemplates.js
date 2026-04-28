// documentTemplates — plantillas de documentación societaria por tipo de
// empresa. Se usan al crear una empresa para sembrar `data.governance.documents`
// con la lista de archivos requeridos. Cada documento arranca en estado
// "pending" salvo `required:false` que arranca en "not_applicable" para
// que el usuario decida si lo activa.
//
// Cada categoría representa una sección plegable del DocumentacionTab.

export const CATEGORY_LABELS = {
  constitucion:     "📂 Constitución y estructura",
  gobierno:         "📂 Órganos de gobierno",
  cuentas_anuales:  "📂 Cuentas anuales",
  fiscal:           "📂 Obligaciones fiscales",
  laboral:          "📂 Laboral y Seguridad Social",
  contratos:        "📂 Contratos vigentes",
  proteccion_datos: "📂 Protección de datos",
  patrimonio:       "📂 Patrimonio inmobiliario",
  otros:            "📂 Otros",
};
// Orden de visualización de categorías en la lista
export const CATEGORY_ORDER = [
  "constitucion", "gobierno", "cuentas_anuales", "fiscal",
  "laboral", "contratos", "proteccion_datos", "patrimonio", "otros",
];

export const DOCUMENT_TEMPLATES = {
  holding: {
    constitucion: [
      { name: "Escritura de constitución", required: true,  description: "Escritura pública de constitución de la sociedad ante notario" },
      { name: "Estatutos sociales",        required: true,  description: "Normas internas que regulan el funcionamiento de la sociedad" },
      { name: "CIF / NIF",                 required: true,  description: "Código de identificación fiscal de la sociedad" },
      { name: "Inscripción Registro Mercantil", required: true, description: "Certificación de inscripción en el RM provincial" },
      { name: "Alta censal (Modelo 036)",  required: true,  description: "Declaración censal de inicio de actividad en Hacienda" },
      { name: "Certificado digital",       required: true,  description: "Certificado FNMT para operar telemáticamente con AEAT y RM" },
      { name: "LEI (Legal Entity Identifier)", required: false, description: "Identificador global para operaciones financieras internacionales" },
      { name: "Registro titularidad real", required: true,  description: "Identificación de titulares reales (>25% participación)" },
    ],
    gobierno: [
      { name: "Libro de actas",            required: true,  description: "Libro legalizado en RM donde se registran las actas de juntas" },
      { name: "Libro registro de socios",  required: true,  description: "Libro legalizado con participaciones de cada socio" },
      { name: "Nombramiento administrador",required: true,  description: "Escritura de nombramiento inscrita en RM" },
      { name: "Poderes notariales",        required: false, description: "Poderes de representación otorgados ante notario" },
      { name: "Protocolo familiar",        required: false, description: "Acuerdo familiar sobre gobierno, sucesión y dividendos" },
      { name: "Pacto de socios",           required: false, description: "Acuerdo privado entre socios sobre derechos y obligaciones" },
    ],
    proteccion_datos: [
      { name: "Registro actividades tratamiento", required: true, description: "Documento RGPD con tipos de datos tratados" },
      { name: "Política de privacidad",   required: true, description: "Texto legal para web, formularios y comunicaciones" },
      { name: "Contratos encargados tratamiento", required: true, description: "Contratos con proveedores que tratan datos personales" },
    ],
    contratos: [
      { name: "Seguro Responsabilidad Civil", required: false, description: "Póliza RC para la sociedad" },
      { name: "Seguro D&O (administradores)", required: false, description: "Seguro de responsabilidad para administradores y directivos" },
    ],
  },
  operativa: {
    constitucion: [
      { name: "Escritura de constitución", required: true,  description: "Escritura pública de constitución" },
      { name: "Estatutos sociales",        required: true,  description: "Normas internas de la sociedad" },
      { name: "CIF / NIF",                 required: true,  description: "Código de identificación fiscal" },
      { name: "Inscripción Registro Mercantil", required: true, description: "Certificación inscripción RM" },
      { name: "Alta censal (Modelo 036)",  required: true,  description: "Declaración censal inicio actividad" },
      { name: "Alta IAE",                  required: true,  description: "Impuesto Actividades Económicas (exento si <1M€ facturación)" },
      { name: "Certificado digital",       required: true,  description: "Certificado FNMT para operar telemáticamente" },
      { name: "Registro titularidad real", required: true,  description: "Titulares reales >25% participación" },
      { name: "Licencia de actividad",     required: false, description: "Licencia municipal según actividad (si aplica)" },
    ],
    gobierno: [
      { name: "Libro de actas",            required: true,  description: "Libro legalizado de actas de juntas" },
      { name: "Libro registro de socios",  required: true,  description: "Libro legalizado de participaciones" },
      { name: "Nombramiento administrador",required: true,  description: "Escritura nombramiento inscrita en RM" },
      { name: "Poderes notariales",        required: false, description: "Poderes de representación" },
    ],
    laboral: [
      { name: "Inscripción empresa Seguridad Social", required: true, description: "Código cuenta cotización (CCC)" },
      { name: "Plan prevención riesgos laborales", required: true, description: "Documento PRL obligatorio si hay empleados" },
      { name: "Calendario laboral",        required: true, description: "Calendario con festivos nacionales, autonómicos y locales" },
      { name: "Contratos de trabajo",      required: true, description: "Contratos de todos los empleados activos" },
      { name: "Nóminas",                   required: true, description: "Recibos de salario mensuales" },
    ],
    proteccion_datos: [
      { name: "Registro actividades tratamiento", required: true, description: "Documento RGPD" },
      { name: "Política de privacidad",   required: true, description: "Texto legal para web y formularios" },
      { name: "Contratos encargados tratamiento", required: true, description: "Contratos con proveedores de datos" },
    ],
    contratos: [
      { name: "Seguro Responsabilidad Civil", required: false, description: "Póliza RC" },
      { name: "Seguro D&O",                required: false, description: "Seguro administradores" },
      { name: "Contrato alquiler oficina/local", required: false, description: "Contrato arrendamiento" },
      { name: "Línea crédito bancaria",   required: false, description: "Póliza de crédito si existe" },
    ],
  },
  patrimonial: {
    constitucion: [
      { name: "Escritura de constitución", required: true,  description: "Escritura pública de constitución" },
      { name: "Estatutos sociales",        required: true,  description: "Normas internas" },
      { name: "CIF / NIF",                 required: true,  description: "Código identificación fiscal" },
      { name: "Inscripción Registro Mercantil", required: true, description: "Certificación inscripción RM" },
      { name: "Alta censal (Modelo 036)",  required: true,  description: "Declaración censal" },
      { name: "Certificado digital",       required: true,  description: "Certificado FNMT" },
      { name: "Registro titularidad real", required: true,  description: "Titulares reales" },
    ],
    gobierno: [
      { name: "Libro de actas",            required: true,  description: "Libro legalizado actas" },
      { name: "Libro registro de socios",  required: true,  description: "Libro legalizado participaciones" },
      { name: "Nombramiento administrador",required: true,  description: "Escritura nombramiento" },
    ],
    patrimonio: [
      { name: "Escrituras de propiedad inmuebles", required: true, description: "Escrituras de cada inmueble en propiedad" },
      { name: "Notas simples Registro Propiedad", required: true,  description: "Notas simples actualizadas de cada inmueble" },
      { name: "Contratos de alquiler vigentes", required: false, description: "Contratos de arrendamiento de cada inmueble alquilado" },
      { name: "Seguros de inmuebles",      required: true, description: "Pólizas de seguro de cada inmueble" },
      { name: "Certificaciones energéticas", required: true, description: "Certificado energético de cada inmueble alquilado" },
      { name: "Recibos IBI",               required: true, description: "Últimos recibos de IBI de cada inmueble" },
    ],
  },
};

// Documentos de cuentas anuales para una empresa y año dados.
// Ej: cuentas2025 = ["Balance", "P&L", "Memoria", ...]
const CUENTAS_ANUALES = [
  { name: "Balance de situación",        required: true },
  { name: "Cuenta de pérdidas y ganancias", required: true },
  { name: "Memoria",                     required: true },
  { name: "Informe de gestión",          required: false },
  { name: "Informe de auditoría",        required: false },
  { name: "Acta aprobación junta",       required: true },
  { name: "Justificante depósito RM",    required: true },
];

// Genera la lista canónica de documentos al crear una empresa.
// Devuelve un array nuevo con ids únicos. companyId es obligatorio.
export function generateDocumentsForCompany(company){
  if (!company || !company.id) return [];
  const tpl = DOCUMENT_TEMPLATES[company.type] || DOCUMENT_TEMPLATES.operativa;
  const out = [];
  const now = new Date().toISOString();
  for (const [category, docs] of Object.entries(tpl)) {
    for (const d of docs) {
      out.push({
        id: `doc_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        companyId: company.id,
        category,
        subcategory: null,
        name: d.name,
        description: d.description || "",
        required: !!d.required,
        // Required → pending; opcional → not_applicable hasta que el usuario lo active.
        status: d.required ? "pending" : "not_applicable",
        fileUrl: null,
        fileName: null,
        fileType: null,
        fileSize: null,
        expiresAt: null,
        dueDate: null,
        uploadedBy: null,
        uploadedAt: null,
        versions: [],
        notes: "",
        createdAt: now,
      });
    }
  }
  // Cuentas anuales del ejercicio en curso y anterior.
  const yr = new Date().getFullYear();
  for (const yearOffset of [-1, 0]) {
    const year = yr + yearOffset;
    for (const c of CUENTAS_ANUALES) {
      out.push({
        id: `doc_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        companyId: company.id,
        category: "cuentas_anuales",
        subcategory: String(year),
        name: c.name,
        description: `Cuentas anuales del ejercicio ${year}`,
        required: !!c.required,
        status: c.required ? "pending" : "not_applicable",
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

// Stats agregados para el header. Considera solo documentos de la empresa
// (filtrar antes de pasar) y solo `status` no "not_applicable" para los
// totales (los opcionales sin activar no cuentan en el progreso).
export function computeDocStats(documents){
  const list = documents || [];
  const accountable = list.filter(d => d.status !== "not_applicable");
  const attached = accountable.filter(d => d.status === "attached").length;
  const pending  = accountable.filter(d => d.status === "pending").length;
  const overdue  = accountable.filter(d => d.status === "overdue").length;
  const expiringSoon = list.filter(d => {
    if (!d.expiresAt) return false;
    const days = Math.floor((new Date(d.expiresAt) - new Date()) / 86400000);
    return days >= 0 && days <= 90;
  }).length;
  const total = accountable.length;
  const pct = total > 0 ? Math.round((attached / total) * 100) : 0;
  return { total, attached, pending, overdue, expiringSoon, pct };
}
