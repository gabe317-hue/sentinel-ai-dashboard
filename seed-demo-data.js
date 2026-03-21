/**
 * SENTINEL-AI HONDURAS — Demo Data Seeder
 *
 * Run this script ONCE to populate Supabase with realistic demo alerts.
 * Usage: node seed-demo-data.js
 *
 * Requires environment variables:
 *   SUPABASE_URL=https://xxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ...
 *
 * Or edit the values directly below (lines marked with <-- EDIT)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';         // <-- EDIT
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'YOUR_KEY';     // <-- EDIT

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

// ── Realistic Honduran demo contracts ─────────────────────────
const DEMO_ALERTS = [
  // ── ALTO severity (3+ patterns) ──────────────────────────────
  {
    title: 'MONTO FRACCIONADO + URGENCIA — Secretaría de Salud',
    description: 'Contrato: HN-SESAL-2026-0312\nProveedor: Distribuidora Médica Central S.A.\nMonto: L. 987,500\nTipo: Contratación Directa\n\nPatrones detectados (3):\n[MONTO_FRACCIONADO] Monto L. 987,500 cerca del umbral de licitación pública (L. 1,000,000)\n[URGENCIA_INJUSTIFICADA] Adjudicado 18 horas después de la publicación (umbral: 72h)\n[PROVEEDOR_SIN_HISTORIAL] Proveedor sin contratos previos registrados en el sistema',
    severity: 'ALTO',
    status: 'Pendiente',
    source: 'HonduCompras EDCA-SEFIN',
    contract_id: 'HN-SESAL-2026-0312',
    vendor_id: 'RTN-08019051234567',
    patterns: 'MONTO_FRACCIONADO, URGENCIA_INJUSTIFICADA, PROVEEDOR_SIN_HISTORIAL',
    pattern_count: 3,
    entidad: 'Secretaría de Salud',
    monto: 987500,
    tipo_contratacion: 'Contratación Directa por Excepción',
    proveedor_nombre: 'Distribuidora Médica Central S.A.',
    fecha_publicacion: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    fecha_adjudicacion: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 18 * 60 * 60 * 1000).toISOString(),
  },
  {
    title: 'ADJUDICACIÓN DIRECTA + FRACCIONADO — HONDUTEL',
    description: 'Contrato: HN-HTEL-2026-0287\nProveedor: TecnoSoluciones de Honduras S. de R.L.\nMonto: L. 945,000\nTipo: Excepción Art. 63\n\nPatrones detectados (3):\n[ADJUDICACION_DIRECTA] Contratación por excepción por L. 945,000 sin proceso competitivo\n[MONTO_FRACCIONADO] Monto L. 945,000 cerca del umbral de licitación pública (L. 1,000,000)\n[PROVEEDOR_SIN_HISTORIAL] Proveedor sin contratos previos registrados en el sistema',
    severity: 'ALTO',
    status: 'Pendiente',
    source: 'HonduCompras EDCA-SEFIN',
    contract_id: 'HN-HTEL-2026-0287',
    vendor_id: 'RTN-08019098765432',
    patterns: 'ADJUDICACION_DIRECTA, MONTO_FRACCIONADO, PROVEEDOR_SIN_HISTORIAL',
    pattern_count: 3,
    entidad: 'HONDUTEL',
    monto: 945000,
    tipo_contratacion: 'Excepción Art. 63 Ley de Contratación',
    proveedor_nombre: 'TecnoSoluciones de Honduras S. de R.L.',
    fecha_publicacion: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    fecha_adjudicacion: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 + 36 * 60 * 60 * 1000).toISOString(),
  },
  {
    title: 'TRIPLE PATRÓN — Secretaría de Educación',
    description: 'Contrato: HN-SEDUC-2026-0445\nProveedor: Impresiones y Suministros del Norte\nMonto: L. 962,000\nTipo: Contratación Directa\n\nPatrones detectados (3):\n[MONTO_FRACCIONADO] Monto L. 962,000 cerca del umbral de licitación pública (L. 1,000,000)\n[URGENCIA_INJUSTIFICADA] Adjudicado 24 horas después de la publicación (umbral: 72h)\n[ADJUDICACION_DIRECTA] Contratación por excepción por L. 962,000 sin proceso competitivo',
    severity: 'ALTO',
    status: 'Pendiente',
    source: 'HonduCompras EDCA-SEFIN',
    contract_id: 'HN-SEDUC-2026-0445',
    vendor_id: 'RTN-05019034521987',
    patterns: 'MONTO_FRACCIONADO, URGENCIA_INJUSTIFICADA, ADJUDICACION_DIRECTA',
    pattern_count: 3,
    entidad: 'Secretaría de Educación',
    monto: 962000,
    tipo_contratacion: 'Contratación Directa por Excepción',
    proveedor_nombre: 'Impresiones y Suministros del Norte',
    fecha_publicacion: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    fecha_adjudicacion: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000).toISOString(),
  },

  // ── MEDIO severity (2 patterns) ───────────────────────────────
  {
    title: 'MONTO FRACCIONADO + URGENCIA — SANAA',
    description: 'Contrato: HN-SANAA-2026-0198\nProveedor: Constructora Hidráulica del Sur S.A.\nMonto: L. 918,750\nTipo: Licitación Privada\n\nPatrones detectados (2):\n[MONTO_FRACCIONADO] Monto L. 918,750 cerca del umbral de licitación pública (L. 1,000,000)\n[URGENCIA_INJUSTIFICADA] Adjudicado 48 horas después de la publicación (umbral: 72h)',
    severity: 'MEDIO',
    status: 'Pendiente',
    source: 'HonduCompras EDCA-SEFIN',
    contract_id: 'HN-SANAA-2026-0198',
    vendor_id: 'RTN-08019067891234',
    patterns: 'MONTO_FRACCIONADO, URGENCIA_INJUSTIFICADA',
    pattern_count: 2,
    entidad: 'SANAA (Servicio Autónomo Nacional de Acueductos)',
    monto: 918750,
    tipo_contratacion: 'Licitación Privada',
    proveedor_nombre: 'Constructora Hidráulica del Sur S.A.',
    fecha_publicacion: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    fecha_adjudicacion: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000 + 48 * 60 * 60 * 1000).toISOString(),
  },
  {
    title: 'ADJUDICACIÓN DIRECTA + PROVEEDOR NUEVO — ENP',
    description: 'Contrato: HN-ENP-2026-0156\nProveedor: Logística Portuaria Internacional\nMonto: L. 780,000\nTipo: Contratación Directa\n\nPatrones detectados (2):\n[ADJUDICACION_DIRECTA] Contratación por excepción por L. 780,000 sin proceso competitivo\n[PROVEEDOR_SIN_HISTORIAL] Proveedor sin contratos previos registrados en el sistema',
    severity: 'MEDIO',
    status: 'Pendiente',
    source: 'HonduCompras EDCA-SEFIN',
    contract_id: 'HN-ENP-2026-0156',
    vendor_id: 'RTN-08019011223344',
    patterns: 'ADJUDICACION_DIRECTA, PROVEEDOR_SIN_HISTORIAL',
    pattern_count: 2,
    entidad: 'Empresa Nacional Portuaria (ENP)',
    monto: 780000,
    tipo_contratacion: 'Contratación Directa por Excepción',
    proveedor_nombre: 'Logística Portuaria Internacional',
    fecha_publicacion: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    fecha_adjudicacion: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    title: 'FRACCIONADO + PROVEEDOR NUEVO — Secretaría de Obras Públicas',
    description: 'Contrato: HN-SOPTRAVI-2026-0334\nProveedor: Vialidad y Construcciones S. de R.L.\nMonto: L. 993,200\nTipo: Licitación Privada\n\nPatrones detectados (2):\n[MONTO_FRACCIONADO] Monto L. 993,200 cerca del umbral de licitación pública (L. 1,000,000)\n[PROVEEDOR_SIN_HISTORIAL] Proveedor sin contratos previos registrados en el sistema',
    severity: 'MEDIO',
    status: 'Pendiente',
    source: 'HonduCompras EDCA-SEFIN',
    contract_id: 'HN-SOPTRAVI-2026-0334',
    vendor_id: 'RTN-05019099887766',
    patterns: 'MONTO_FRACCIONADO, PROVEEDOR_SIN_HISTORIAL',
    pattern_count: 2,
    entidad: 'Secretaría de Obras Públicas (SOPTRAVI)',
    monto: 993200,
    tipo_contratacion: 'Licitación Privada',
    proveedor_nombre: 'Vialidad y Construcciones S. de R.L.',
    fecha_publicacion: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    fecha_adjudicacion: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    title: 'URGENCIA + PROVEEDOR NUEVO — Municipalidad de Tegucigalpa',
    description: 'Contrato: HN-AMDC-2026-0521\nProveedor: Servicios Municipales Integrados\nMonto: L. 650,000\nTipo: Contratación Directa\n\nPatrones detectados (2):\n[URGENCIA_INJUSTIFICADA] Adjudicado 12 horas después de la publicación (umbral: 72h)\n[PROVEEDOR_SIN_HISTORIAL] Proveedor sin contratos previos registrados en el sistema',
    severity: 'MEDIO',
    status: 'Enviada',
    source: 'HonduCompras EDCA-SEFIN',
    contract_id: 'HN-AMDC-2026-0521',
    vendor_id: 'RTN-08019055443322',
    patterns: 'URGENCIA_INJUSTIFICADA, PROVEEDOR_SIN_HISTORIAL',
    pattern_count: 2,
    entidad: 'Alcaldía Municipal del Distrito Central (AMDC)',
    monto: 650000,
    tipo_contratacion: 'Contratación Directa por Excepción',
    proveedor_nombre: 'Servicios Municipales Integrados',
    fecha_publicacion: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
    fecha_adjudicacion: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000).toISOString(),
  },

  // ── BAJO severity (1 pattern) ──────────────────────────────────
  {
    title: 'MONTO FRACCIONADO — Instituto Hondureño de Seguridad Social',
    description: 'Contrato: HN-IHSS-2026-0089\nProveedor: Farmacéutica Nacional S.A.\nMonto: L. 925,000\nTipo: Licitación Pública\n\nPatrones detectados (1):\n[MONTO_FRACCIONADO] Monto L. 925,000 cerca del umbral de licitación pública (L. 1,000,000)',
    severity: 'BAJO',
    status: 'Pendiente',
    source: 'HonduCompras EDCA-SEFIN',
    contract_id: 'HN-IHSS-2026-0089',
    vendor_id: 'RTN-08019022334455',
    patterns: 'MONTO_FRACCIONADO',
    pattern_count: 1,
    entidad: 'Instituto Hondureño de Seguridad Social (IHSS)',
    monto: 925000,
    tipo_contratacion: 'Licitación Pública',
    proveedor_nombre: 'Farmacéutica Nacional S.A.',
    fecha_publicacion: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    fecha_adjudicacion: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    title: 'ADJUDICACIÓN DIRECTA — Secretaría de Finanzas',
    description: 'Contrato: HN-SEFIN-2026-0067\nProveedor: Consultoría Financiera Centroamericana\nMonto: L. 720,000\nTipo: Contratación Directa\n\nPatrones detectados (1):\n[ADJUDICACION_DIRECTA] Contratación por excepción por L. 720,000 sin proceso competitivo',
    severity: 'BAJO',
    status: 'Enviada',
    source: 'HonduCompras EDCA-SEFIN',
    contract_id: 'HN-SEFIN-2026-0067',
    vendor_id: 'RTN-08019033221100',
    patterns: 'ADJUDICACION_DIRECTA',
    pattern_count: 1,
    entidad: 'Secretaría de Finanzas (SEFIN)',
    monto: 720000,
    tipo_contratacion: 'Contratación Directa por Excepción',
    proveedor_nombre: 'Consultoría Financiera Centroamericana',
    fecha_publicacion: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    fecha_adjudicacion: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    title: 'URGENCIA INJUSTIFICADA — Banco Central de Honduras',
    description: 'Contrato: HN-BCH-2026-0034\nProveedor: Sistemas y Redes Tecnológicas\nMonto: L. 580,000\nTipo: Licitación Privada\n\nPatrones detectados (1):\n[URGENCIA_INJUSTIFICADA] Adjudicado 55 horas después de la publicación (umbral: 72h)',
    severity: 'BAJO',
    status: 'Pendiente',
    source: 'HonduCompras EDCA-SEFIN',
    contract_id: 'HN-BCH-2026-0034',
    vendor_id: 'RTN-08019044556677',
    patterns: 'URGENCIA_INJUSTIFICADA',
    pattern_count: 1,
    entidad: 'Banco Central de Honduras (BCH)',
    monto: 580000,
    tipo_contratacion: 'Licitación Privada',
    proveedor_nombre: 'Sistemas y Redes Tecnológicas',
    fecha_publicacion: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    fecha_adjudicacion: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000 + 55 * 60 * 60 * 1000).toISOString(),
  },
];

async function seedData() {
  console.log('🚀 Sentinel-AI — Inserting demo data into Supabase...\n');

  if (SUPABASE_URL === 'YOUR_SUPABASE_URL') {
    console.error('❌ ERROR: Edit this file and set your SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  // Add timestamps
  const alertsWithTimestamps = DEMO_ALERTS.map((a, i) => ({
    ...a,
    created_at: new Date(Date.now() - (DEMO_ALERTS.length - i) * 2 * 60 * 60 * 1000).toISOString(),
  }));

  const { data, error } = await supabase
    .from('alerts')
    .insert(alertsWithTimestamps)
    .select();

  if (error) {
    console.error('❌ Error inserting:', error.message);
    console.error('Detail:', error.details || error.hint || '');
    process.exit(1);
  }

  console.log(`✅ Inserted ${data.length} demo alerts successfully!\n`);

  const alto  = data.filter(a => a.severity === 'ALTO').length;
  const medio = data.filter(a => a.severity === 'MEDIO').length;
  const bajo  = data.filter(a => a.severity === 'BAJO').length;

  console.log(`   ALTO:  ${alto} alertas`);
  console.log(`   MEDIO: ${medio} alertas`);
  console.log(`   BAJO:  ${bajo} alertas`);
  console.log(`\n🎯 Open your dashboard to see the alerts:`);
  console.log(`   https://sentinel-ai-dashboard-beta.vercel.app/mvp.html\n`);
}

seedData().catch(e => { console.error(e); process.exit(1); });
