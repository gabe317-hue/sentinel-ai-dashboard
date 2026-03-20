/**
 * SENTINEL-AI HONDURAS
 * Data Pipeline — lib/data-pipeline.js
 *
 * Fetches contracts from HonduCompras (EDCA-SEFIN API),
 * analyzes them for 4 fraud patterns, and saves alerts to Supabase.
 *
 * Fraud patterns detected:
 *   1. MONTO_FRACCIONADO  — Contract near bidding threshold (split contract)
 *   2. URGENCIA_INJUSTIFICADA — Awarded < 72h after publication
 *   3. PROVEEDOR_SIN_HISTORIAL — First-time vendor with no prior contracts
 *   4. ADJUDICACION_DIRECTA — Direct award (no competition) above L. 500,000
 *
 * Severity:
 *   ALTO  — 3+ patterns detected
 *   MEDIO — 2 patterns detected
 *   BAJO  — 1 pattern detected
 *
 * Runs nightly via Vercel Cron Job at 02:00 UTC
 */

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

// ── Configuration ─────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const EDCA_BASE_URL = 'https://guancasco.sefin.gob.hn/EDCA_WEBAPI/datosabiertos/api/v1';

// Fraud detection thresholds (Honduran Lempiras)
const THRESHOLD_FRACCIONADO_MIN = 900000;   // L. 900,000 — lower bound near bidding limit
const THRESHOLD_FRACCIONADO_MAX = 999999;   // L. 999,999 — upper bound (just below L. 1M limit)
const THRESHOLD_DIRECTO_MONTO   = 500000;   // L. 500,000 — direct award alert threshold
const URGENCIA_HORAS            = 72;       // hours from publication to award for urgency flag
const DAYS_LOOKBACK             = 7;        // how many days back to fetch contracts
const PAGE_SIZE                 = 100;      // records per API page

// ── Supabase client ───────────────────────────────────────────
function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      'Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables.'
    );
  }
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });
}

// ── Date helpers ──────────────────────────────────────────────
function getDateRange(daysBack = DAYS_LOOKBACK) {
  const end   = new Date();
  const start = new Date();
  start.setDate(start.getDate() - daysBack);
  return {
    fechaInicio: start.toISOString().split('T')[0],
    fechaFin:    end.toISOString().split('T')[0],
  };
}

function hoursBetween(dateA, dateB) {
  return Math.abs(new Date(dateA) - new Date(dateB)) / (1000 * 60 * 60);
}

// ── EDCA-SEFIN API fetch ──────────────────────────────────────
async function fetchContractsPage(fechaInicio, fechaFin, pagina = 1) {
  const url = `${EDCA_BASE_URL}/contratos?fechaInicio=${fechaInicio}&fechaFin=${fechaFin}&pagina=${pagina}&registrosPorPagina=${PAGE_SIZE}`;
  console.log(`[Pipeline] Fetching page ${pagina}: ${url}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Sentinel-AI/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[Pipeline] API returned ${res.status} for page ${pagina}`);
      return null;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.warn(`[Pipeline] Timeout fetching page ${pagina}`);
    } else {
      console.warn(`[Pipeline] Fetch error on page ${pagina}: ${err.message}`);
    }
    return null;
  }
}

async function fetchAllContracts(fechaInicio, fechaFin) {
  const allContracts = [];
  let pagina = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await fetchContractsPage(fechaInicio, fechaFin, pagina);

    if (!data) break;

    // Handle different API response shapes
    const records = data.data || data.contratos || data.records || data || [];
    const contractList = Array.isArray(records) ? records : [];

    if (contractList.length === 0) {
      hasMore = false;
    } else {
      allContracts.push(...contractList);
      hasMore = contractList.length === PAGE_SIZE;
      pagina++;

      // Safety: max 20 pages per run (2,000 contracts)
      if (pagina > 20) {
        console.warn('[Pipeline] Hit page limit (20). Stopping pagination.');
        hasMore = false;
      }
    }
  }

  console.log(`[Pipeline] Total contracts fetched: ${allContracts.length}`);
  return allContracts;
}

// ── Duplicate detection ───────────────────────────────────────
async function getExistingContractIds(supabase) {
  const { data, error } = await supabase
    .from('alerts')
    .select('contract_id')
    .not('contract_id', 'is', null);

  if (error) {
    console.warn('[Pipeline] Could not fetch existing contract IDs:', error.message);
    return new Set();
  }

  return new Set((data || []).map(r => String(r.contract_id)));
}

// ── Vendor history check ──────────────────────────────────────
async function getVendorContractCounts(supabase, vendorIds) {
  if (!vendorIds || vendorIds.length === 0) return {};

  const { data, error } = await supabase
    .from('alerts')
    .select('vendor_id')
    .in('vendor_id', vendorIds);

  if (error) {
    console.warn('[Pipeline] Vendor history lookup failed:', error.message);
    return {};
  }

  const counts = {};
  (data || []).forEach(r => {
    counts[r.vendor_id] = (counts[r.vendor_id] || 0) + 1;
  });
  return counts;
}

// ── Fraud pattern analysis ────────────────────────────────────
function normalizeContract(raw) {
  // Map EDCA-SEFIN API fields to our internal format
  // The API may use different field names — we handle the common ones
  return {
    id:              raw.id || raw.numero_contrato || raw.numeroContrato || raw.contract_id || null,
    numero:          raw.numero_contrato || raw.numeroContrato || raw.numero || String(raw.id || ''),
    monto:           parseFloat(raw.monto || raw.valor || raw.montoContrato || raw.importe || 0),
    proveedor_id:    raw.proveedor_id || raw.proveedorId || raw.rtn_proveedor || raw.rtn || null,
    proveedor_nombre: raw.proveedor || raw.nombreProveedor || raw.proveedor_nombre || 'Proveedor Desconocido',
    entidad:         raw.entidad || raw.institucion || raw.nombre_institucion || 'Entidad Desconocida',
    tipo_contratacion: raw.tipo_contratacion || raw.tipoContratacion || raw.modalidad || '',
    fecha_publicacion: raw.fecha_publicacion || raw.fechaPublicacion || raw.fecha_inicio || null,
    fecha_adjudicacion: raw.fecha_adjudicacion || raw.fechaAdjudicacion || raw.fecha_firma || null,
    descripcion:     raw.objeto || raw.descripcion || raw.descripcion_contrato || '',
    departamento:    raw.departamento || raw.municipio || '',
  };
}

function detectPatterns(contract, vendorCounts = {}) {
  const patterns = [];
  const { monto, tipo_contratacion, fecha_publicacion, fecha_adjudicacion, proveedor_id } = contract;

  // Pattern 1: MONTO_FRACCIONADO
  // Contract amount is suspiciously close to the bidding threshold (L. 900K-999K)
  if (monto >= THRESHOLD_FRACCIONADO_MIN && monto <= THRESHOLD_FRACCIONADO_MAX) {
    patterns.push({
      tipo: 'MONTO_FRACCIONADO',
      descripcion: `Monto L. ${monto.toLocaleString()} cerca del umbral de licitacion publica (L. 1,000,000)`,
    });
  }

  // Pattern 2: URGENCIA_INJUSTIFICADA
  // Contract awarded less than 72 hours after publication
  if (fecha_publicacion && fecha_adjudicacion) {
    const horas = hoursBetween(fecha_publicacion, fecha_adjudicacion);
    if (horas > 0 && horas < URGENCIA_HORAS) {
      patterns.push({
        tipo: 'URGENCIA_INJUSTIFICADA',
        descripcion: `Adjudicado ${Math.round(horas)} horas despues de la publicacion (umbral: ${URGENCIA_HORAS}h)`,
      });
    }
  }

  // Pattern 3: PROVEEDOR_SIN_HISTORIAL
  // Vendor has no previous contracts in Sentinel-AI (first-time vendor)
  if (proveedor_id && vendorCounts[proveedor_id] === undefined) {
    patterns.push({
      tipo: 'PROVEEDOR_SIN_HISTORIAL',
      descripcion: `Proveedor sin contratos previos registrados en el sistema`,
    });
  }

  // Pattern 4: ADJUDICACION_DIRECTA
  // Direct award (exception) above L. 500,000 — no competitive process
  const tipoLower = String(tipo_contratacion).toLowerCase();
  const isDirecta = tipoLower.includes('excep') ||
                    tipoLower.includes('direc') ||
                    tipoLower.includes('trato directo') ||
                    tipoLower.includes('contratacion directa');
  if (isDirecta && monto > THRESHOLD_DIRECTO_MONTO) {
    patterns.push({
      tipo: 'ADJUDICACION_DIRECTA',
      descripcion: `Contratacion por excepcion por L. ${monto.toLocaleString()} sin proceso competitivo`,
    });
  }

  return patterns;
}

function calcSeverity(patterns) {
  if (patterns.length >= 3) return 'ALTO';
  if (patterns.length === 2) return 'MEDIO';
  if (patterns.length === 1) return 'BAJO';
  return null; // No fraud patterns — not an alert
}

// ── Build alert record for Supabase ──────────────────────────
function buildAlertRecord(contract, patterns, severity) {
  const patternTipos = patterns.map(p => p.tipo).join(', ');
  const patternDescriptions = patterns.map(p => `[${p.tipo}] ${p.descripcion}`).join('\n');

  // Build a concise title
  const mainPattern = patterns[0]?.tipo?.replace(/_/g, ' ') || 'ANOMALIA';
  const title = `${mainPattern} — ${contract.entidad}`;

  // Full description with all patterns
  const description =
    `Contrato: ${contract.numero}\n` +
    `Proveedor: ${contract.proveedor_nombre}\n` +
    `Monto: L. ${contract.monto.toLocaleString()}\n` +
    `Tipo: ${contract.tipo_contratacion || 'No especificado'}\n` +
    `\nPatrones detectados (${patterns.length}):\n${patternDescriptions}`;

  return {
    // Core fields
    title,
    description,
    severity,                          // 'ALTO' | 'MEDIO' | 'BAJO'
    status: 'Pendiente',               // default status for new alerts
    source: 'HonduCompras EDCA-SEFIN', // data source
    contract_id: String(contract.id || contract.numero),
    vendor_id: contract.proveedor_id ? String(contract.proveedor_id) : null,

    // Pattern metadata stored as JSONB if column exists, else as text
    patterns: patternTipos,
    pattern_count: patterns.length,

    // Contextual data
    entidad: contract.entidad,
    departamento: contract.departamento || null,
    monto: contract.monto || 0,
    tipo_contratacion: contract.tipo_contratacion || null,
    fecha_publicacion: contract.fecha_publicacion || null,
    fecha_adjudicacion: contract.fecha_adjudicacion || null,
    proveedor_nombre: contract.proveedor_nombre || null,

    // Timestamps
    created_at: new Date().toISOString(),
  };
}

// ── Insert alerts into Supabase ───────────────────────────────
async function insertAlerts(supabase, alerts) {
  if (alerts.length === 0) return { inserted: 0, errors: 0 };

  let inserted = 0;
  let errors   = 0;

  // Insert in batches of 50 to avoid request size limits
  const BATCH_SIZE = 50;
  for (let i = 0; i < alerts.length; i += BATCH_SIZE) {
    const batch = alerts.slice(i, i + BATCH_SIZE);

    const { error } = await supabase
      .from('alerts')
      .insert(batch);

    if (error) {
      console.error(`[Pipeline] Insert error (batch ${Math.floor(i/BATCH_SIZE) + 1}):`, error.message);
      errors += batch.length;
    } else {
      inserted += batch.length;
      console.log(`[Pipeline] Inserted batch ${Math.floor(i/BATCH_SIZE) + 1}: ${batch.length} alerts`);
    }
  }

  return { inserted, errors };
}

// ── Main pipeline function ────────────────────────────────────
async function runPipeline() {
  const startTime = Date.now();
  console.log('[Pipeline] ========== SENTINEL-AI PIPELINE START ==========');

  const supabase = getSupabase();
  const { fechaInicio, fechaFin } = getDateRange(DAYS_LOOKBACK);
  console.log(`[Pipeline] Date range: ${fechaInicio} to ${fechaFin}`);

  // Step 1: Fetch contracts from HonduCompras
  const rawContracts = await fetchAllContracts(fechaInicio, fechaFin);
  const contractsFetched = rawContracts.length;

  if (contractsFetched === 0) {
    console.warn('[Pipeline] No contracts fetched. Check API availability.');
    return {
      contractsFetched: 0,
      contractsAnalyzed: 0,
      alertsCreated: 0,
      alertsSkipped: 0,
      durationMs: Date.now() - startTime,
    };
  }

  // Step 2: Normalize contracts
  const contracts = rawContracts.map(normalizeContract);

  // Step 3: Filter out duplicates (already in Supabase)
  const existingIds = await getExistingContractIds(supabase);
  const newContracts = contracts.filter(c =>
    c.id && !existingIds.has(String(c.id))
  );
  const contractsAnalyzed = newContracts.length;
  const skippedDuplicates = contractsFetched - contractsAnalyzed;
  console.log(`[Pipeline] New contracts to analyze: ${contractsAnalyzed} (${skippedDuplicates} duplicates skipped)`);

  if (contractsAnalyzed === 0) {
    return {
      contractsFetched,
      contractsAnalyzed: 0,
      alertsCreated: 0,
      alertsSkipped: skippedDuplicates,
      durationMs: Date.now() - startTime,
    };
  }

  // Step 4: Get vendor history for all new contracts
  const vendorIds = [...new Set(newContracts.map(c => c.proveedor_id).filter(Boolean))];
  const vendorCounts = await getVendorContractCounts(supabase, vendorIds);
  console.log(`[Pipeline] Vendor IDs analyzed: ${vendorIds.length}`);

  // Step 5: Analyze each contract for fraud patterns
  const alertRecords = [];
  let contractsNoPattern = 0;

  for (const contract of newContracts) {
    const patterns = detectPatterns(contract, vendorCounts);
    const severity = calcSeverity(patterns);

    if (!severity) {
      contractsNoPattern++;
      continue; // No patterns detected — skip
    }

    const alertRecord = buildAlertRecord(contract, patterns, severity);
    alertRecords.push(alertRecord);

    console.log(
      `[Pipeline] Alert: ${severity} — ${contract.entidad} — ` +
      `L. ${contract.monto.toLocaleString()} — ${patterns.map(p => p.tipo).join(', ')}`
    );
  }

  console.log(`[Pipeline] Alerts generated: ${alertRecords.length} | No pattern: ${contractsNoPattern}`);

  // Step 6: Insert alerts into Supabase
  const { inserted, errors } = await insertAlerts(supabase, alertRecords);

  const durationMs = Date.now() - startTime;
  console.log(`[Pipeline] ========== PIPELINE COMPLETE (${durationMs}ms) ==========`);
  console.log(`[Pipeline] Summary: ${contractsFetched} fetched | ${contractsAnalyzed} analyzed | ${inserted} alerts created | ${errors} errors`);

  return {
    contractsFetched,
    contractsAnalyzed,
    alertsGenerated:    alertRecords.length,
    alertsCreated:      inserted,
    alertsSkipped:      skippedDuplicates + contractsNoPattern,
    insertErrors:       errors,
    dateRange:          { fechaInicio, fechaFin },
    durationMs,
  };
}

module.exports = { runPipeline };
