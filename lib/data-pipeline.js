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

// Cloudflare Worker proxy — routes around Vercel's AWS IP block on HonduCompras.
// Worker source: Vercel Deployment/cloudflare-worker/honduras-proxy.js
// Direct API (browser only): https://contratacionesabiertas.gob.hn/api/v1
const EDCA_BASE_URL = 'https://honduras-proxy.gabe317.workers.dev/api/v1';


// Fraud detection thresholds (Honduran Lempiras)
const THRESHOLD_FRACCIONADO_MIN = 900000;   // L. 900,000 — lower bound near bidding limit
const THRESHOLD_FRACCIONADO_MAX = 999999;   // L. 999,999 — upper bound (just below L. 1M limit)
const THRESHOLD_DIRECTO_MONTO   = 500000;   // L. 500,000 — direct award alert threshold
const URGENCIA_HORAS            = 72;       // hours from publication to award for urgency flag
const DAYS_LOOKBACK             = 30;       // days back to fetch contracts (covers partial months)
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

// ── EDCA-SEFIN API: bulk downloads approach ──────────────────
//
// The releases endpoint has 61,000+ pages with no date filter — fetching
// the last pages times out. Instead we use /descargas/ which provides
// pre-built monthly JSON files. Much faster and more reliable.
//
// Flow:
//   1. GET /api/v1/descargas/  → list of monthly files (year, month, urls.json)
//   2. Find files matching our date range
//   3. Download each monthly JSON file through the Worker proxy
//   4. Filter releases by date range in memory

async function fetchDownloadsCatalogue() {
  const url = `${EDCA_BASE_URL}/descargas/`;
  console.log(`[Pipeline] Fetching downloads catalogue: ${url}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Sentinel-AI/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[Pipeline] Downloads catalogue returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (err) {
    clearTimeout(timeout);
    console.warn(`[Pipeline] Downloads catalogue error: ${err.message}`);
    return null;
  }
}

async function fetchMonthlyReleases(jsonUrl, startDate, endDate) {
  if (!jsonUrl) return [];

  // Route through Cloudflare Worker proxy (same as the main API calls)
  const proxiedUrl = jsonUrl.replace(
    'https://contratacionesabiertas.gob.hn',
    'https://honduras-proxy.gabe317.workers.dev'
  );
  console.log(`[Pipeline] Downloading monthly file: ${proxiedUrl}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000); // 55s for larger files

  try {
    const res = await fetch(proxiedUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Sentinel-AI/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[Pipeline] Monthly file returned ${res.status}`);
      return [];
    }

    const data = await res.json();

    // Monthly bulk files may use top-level array, releases array, or releasePackage.releases
    const releases = Array.isArray(data)
      ? data
      : (data.releases || data.releasePackage?.releases || []);

    console.log(`[Pipeline] Monthly file: ${releases.length} total releases`);

    // Filter to only contracts within our date range
    const filtered = releases.filter(r => {
      const d = new Date(r.publishedDate || r.date || '');
      return !isNaN(d) && d >= startDate && d <= endDate;
    });

    console.log(`[Pipeline] After date filter: ${filtered.length} releases match`);
    return filtered;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.warn(`[Pipeline] Timeout downloading monthly file`);
    } else {
      console.warn(`[Pipeline] Monthly file error: ${err.message}`);
    }
    return [];
  }
}

async function fetchAllContracts(fechaInicio, fechaFin) {
  const startDate = new Date(fechaInicio);
  const endDate   = new Date(fechaFin);
  endDate.setHours(23, 59, 59, 999);

  // Step 1: Get catalogue of available monthly download files
  const catalogue = await fetchDownloadsCatalogue();
  if (!catalogue || catalogue.length === 0) {
    console.warn('[Pipeline] Downloads catalogue unavailable — no contracts fetched');
    return [];
  }
  console.log(`[Pipeline] Catalogue: ${catalogue.length} monthly files available`);

  // Step 2: Build the set of year-month keys our date range spans
  const targetMonths = new Set();
  const cursor = new Date(startDate);
  cursor.setDate(1); // move to first of month
  while (cursor <= endDate) {
    const mm = String(cursor.getMonth() + 1).padStart(2, '0');
    targetMonths.add(`${cursor.getFullYear()}-${mm}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  console.log(`[Pipeline] Target months: ${[...targetMonths].join(', ')}`);

  // Step 3: Find matching files in the catalogue
  let filesToFetch = catalogue.filter(d => {
    const mm = String(Number(d.month)).padStart(2, '0');
    return targetMonths.has(`${d.year}-${mm}`);
  });

  // Fallback: if no exact match (current month not published yet), use the 2 most recent
  if (filesToFetch.length === 0) {
    console.warn('[Pipeline] No files for target months — falling back to 2 most recent files');
    filesToFetch = catalogue.slice(-2);
  }

  console.log(`[Pipeline] Files to download: ${filesToFetch.length} — ${
    filesToFetch.map(f => `${f.year}-${String(Number(f.month)).padStart(2,'0')}`).join(', ')
  }`);

  // Step 4: Download all relevant monthly files in parallel
  const results = await Promise.all(
    filesToFetch
      .filter(f => f.urls?.json)
      .map(f => fetchMonthlyReleases(f.urls.json, startDate, endDate))
  );

  const allContracts = results.flat();
  console.log(`[Pipeline] Total contracts in date range: ${allContracts.length}`);
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
  // Parse OCDS (Open Contracting Data Standard) release format
  // Docs: https://contratacionesabiertas.gob.hn/manual_api/

  // Awards contain the actual contract value and supplier
  const award   = (raw.awards   && raw.awards[0])   || {};
  const tender  = raw.tender    || {};
  const buyer   = raw.buyer     || {};
  const supplier = (award.suppliers && award.suppliers[0]) || {};

  // Extract amount — prefer award value, fall back to tender value
  const monto = parseFloat(
    award.value?.amount ||
    tender.value?.amount ||
    0
  );

  // Procurement method (direct, open, etc.)
  const tipoContratacion = tender.procurementMethod ||
    tender.procurementMethodDetails || '';

  return {
    id:                 raw.ocid || raw.id || null,
    numero:             raw.ocid || String(raw.id || ''),
    monto,
    proveedor_id:       supplier.id || supplier.identifier?.id || null,
    proveedor_nombre:   supplier.name || 'Proveedor Desconocido',
    entidad:            buyer.name || raw.publisher?.name || 'Entidad Desconocida',
    tipo_contratacion:  tipoContratacion,
    fecha_publicacion:  raw.publishedDate || raw.date || tender.tenderPeriod?.startDate || null,
    fecha_adjudicacion: award.date || tender.tenderPeriod?.endDate || null,
    descripcion:        tender.title || tender.description || '',
    departamento:       tender.deliveryLocation?.description || '',
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
