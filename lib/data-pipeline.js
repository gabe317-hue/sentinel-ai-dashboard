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
const EDCA_BASE_URL = 'https://honduras-proxy.gabe317.workers.dev/api/v1';

// Fraud detection thresholds (Honduran Lempiras)
const THRESHOLD_FRACCIONADO_MIN = 900000;
const THRESHOLD_FRACCIONADO_MAX = 999999;
const THRESHOLD_DIRECTO_MONTO   = 500000;
const URGENCIA_HORAS            = 72;
const DAYS_LOOKBACK             = 30;
const PAGE_SIZE                 = 100;

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables.');
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

function getDateRange(daysBack = DAYS_LOOKBACK) {
  const end = new Date(), start = new Date();
  start.setDate(start.getDate() - daysBack);
  return { fechaInicio: start.toISOString().split('T')[0], fechaFin: end.toISOString().split('T')[0] };
}

function hoursBetween(dateA, dateB) {
  return Math.abs(new Date(dateA) - new Date(dateB)) / (1000 * 60 * 60);
}

// ── EDCA-SEFIN API: bulk downloads approach ──────────────────
// Uses /descargas/ monthly JSON files instead of paginating 61,000+ pages.
// Fallback: if current months not in catalogue, uses 2 most recent files without date filter.

async function fetchDownloadsCatalogue() {
  const url = `${EDCA_BASE_URL}/descargas/`;
  console.log(`[Pipeline] Fetching downloads catalogue: ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Sentinel-AI/1.0' }, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) { console.warn(`[Pipeline] Downloads catalogue returned ${res.status}`); return null; }
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
  const proxiedUrl = jsonUrl.replace('https://contratacionesabiertas.gob.hn', 'https://honduras-proxy.gabe317.workers.dev');
  console.log(`[Pipeline] Downloading monthly file: ${proxiedUrl}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  try {
    const res = await fetch(proxiedUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'Sentinel-AI/1.0' }, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) { console.warn(`[Pipeline] Monthly file returned ${res.status}`); return []; }
    const data = await res.json();
    const releases = Array.isArray(data) ? data : (data.releases || data.releasePackage?.releases || []);
    console.log(`[Pipeline] Monthly file: ${releases.length} total releases`);
    if (!startDate || !endDate) {
      console.log(`[Pipeline] No date filter — returning all ${releases.length} releases`);
      return releases;
    }
    const filtered = releases.filter(r => { const d = new Date(r.publishedDate || r.date || ''); return !isNaN(d) && d >= startDate && d <= endDate; });
    console.log(`[Pipeline] After date filter: ${filtered.length} releases match`);
    return filtered;
  } catch (err) {
    clearTimeout(timeout);
    console.warn(err.name === 'AbortError' ? '[Pipeline] Timeout downloading monthly file' : `[Pipeline] Monthly file error: ${err.message}`);
    return [];
  }
}

async function fetchAllContracts(fechaInicio, fechaFin) {
  const startDate = new Date(fechaInicio);
  const endDate   = new Date(fechaFin);
  endDate.setHours(23, 59, 59, 999);
  const catalogue = await fetchDownloadsCatalogue();
  if (!catalogue || catalogue.length === 0) { console.warn('[Pipeline] Downloads catalogue unavailable'); return []; }
  console.log(`[Pipeline] Catalogue: ${catalogue.length} monthly files available`);
  const targetMonths = new Set();
  const cursor = new Date(startDate);
  cursor.setDate(1);
  while (cursor <= endDate) {
    targetMonths.add(`${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,'0')}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  console.log(`[Pipeline] Target months: ${[...targetMonths].join(', ')}`);
  let filesToFetch = catalogue.filter(d => targetMonths.has(`${d.year}-${String(Number(d.month)).padStart(2,'0')}`));
  const usingFallback = filesToFetch.length === 0;
  if (usingFallback) {
    console.warn('[Pipeline] No files for target months — falling back to 2 most recent (no date filter)');
    filesToFetch = catalogue.slice(-2);
  }
  console.log(`[Pipeline] Files to download: ${filesToFetch.map(f => `${f.year}-${String(Number(f.month)).padStart(2,'0')}`).join(', ')}`);
  const results = await Promise.all(filesToFetch.filter(f => f.urls?.json).map(f => fetchMonthlyReleases(f.urls.json, usingFallback ? null : startDate, usingFallback ? null : endDate)));
  const allContracts = results.flat();
  console.log(`[Pipeline] Total contracts in date range: ${allContracts.length}`);
  return allContracts;
}

async function getExistingContractIds(supabase) {
  const { data, error } = await supabase.from('alerts').select('contract_id').not('contract_id', 'is', null);
  if (error) { console.warn('[Pipeline] Could not fetch existing contract IDs:', error.message); return new Set(); }
  return new Set((data || []).map(r => String(r.contract_id)));
}

async function getVendorContractCounts(supabase, vendorIds) {
  if (!vendorIds || vendorIds.length === 0) return {};
  const { data, error } = await supabase.from('alerts').select('vendor_id').in('vendor_id', vendorIds);
  if (error) { console.warn('[Pipeline] Vendor history lookup failed:', error.message); return {}; }
  const counts = {};
  (data || []).forEach(r => { counts[r.vendor_id] = (counts[r.vendor_id] || 0) + 1; });
  return counts;
}

function normalizeContract(raw) {
  const award    = (raw.awards && raw.awards[0]) || {};
  const tender   = raw.tender  || {};
  const buyer    = raw.buyer   || {};
  const supplier = (award.suppliers && award.suppliers[0]) || {};
  const monto = parseFloat(award.value?.amount || tender.value?.amount || 0);
  return {
    id:                 raw.ocid || raw.id || null,
    numero:             raw.ocid || String(raw.id || ''),
    monto,
    proveedor_id:       supplier.id || supplier.identifier?.id || null,
    proveedor_nombre:   supplier.name || 'Proveedor Desconocido',
    entidad:            buyer.name || raw.publisher?.name || 'Entidad Desconocida',
    tipo_contratacion:  tender.procurementMethod || tender.procurementMethodDetails || '',
    fecha_publicacion:  raw.publishedDate || raw.date || tender.tenderPeriod?.startDate || null,
    fecha_adjudicacion: award.date || tender.tenderPeriod?.endDate || null,
    descripcion:        tender.title || tender.description || '',
    departamento:       tender.deliveryLocation?.description || '',
  };
}

function detectPatterns(contract, vendorCounts = {}) {
  const patterns = [];
  const { monto, tipo_contratacion, fecha_publicacion, fecha_adjudicacion, proveedor_id } = contract;
  if (monto >= THRESHOLD_FRACCIONADO_MIN && monto <= THRESHOLD_FRACCIONADO_MAX)
    patterns.push({ tipo: 'MONTO_FRACCIONADO', descripcion: `Monto L. ${monto.toLocaleString()} cerca del umbral de licitacion publica (L. 1,000,000)` });
  if (fecha_publicacion && fecha_adjudicacion) {
    const horas = hoursBetween(fecha_publicacion, fecha_adjudicacion);
    if (horas > 0 && horas < URGENCIA_HORAS)
      patterns.push({ tipo: 'URGENCIA_INJUSTIFICADA', descripcion: `Adjudicado ${Math.round(horas)} horas despues de la publicacion (umbral: ${URGENCIA_HORAS}h)` });
  }
  if (proveedor_id && vendorCounts[proveedor_id] === undefined)
    patterns.push({ tipo: 'PROVEEDOR_SIN_HISTORIAL', descripcion: 'Proveedor sin contratos previos registrados en el sistema' });
  const tipoLower = String(tipo_contratacion).toLowerCase();
  if ((tipoLower.includes('excep') || tipoLower.includes('direc') || tipoLower.includes('trato directo') || tipoLower.includes('contratacion directa')) && monto > THRESHOLD_DIRECTO_MONTO)
    patterns.push({ tipo: 'ADJUDICACION_DIRECTA', descripcion: `Contratacion por excepcion por L. ${monto.toLocaleString()} sin proceso competitivo` });
  return patterns;
}

function calcSeverity(patterns) {
  if (patterns.length >= 3) return 'ALTO';
  if (patterns.length === 2) return 'MEDIO';
  if (patterns.length === 1) return 'BAJO';
  return null;
}

function buildAlertRecord(contract, patterns, severity) {
  const patternTipos = patterns.map(p => p.tipo).join(', ');
  const patternDescriptions = patterns.map(p => `[${p.tipo}] ${p.descripcion}`).join('\n');
  const title = `${patterns[0]?.tipo?.replace(/_/g,' ') || 'ANOMALIA'} — ${contract.entidad}`;
  const description = `Contrato: ${contract.numero}\nProveedor: ${contract.proveedor_nombre}\nMonto: L. ${contract.monto.toLocaleString()}\nTipo: ${contract.tipo_contratacion || 'No especificado'}\n\nPatrones detectados (${patterns.length}):\n${patternDescriptions}`;
  return {
    title, description, severity, status: 'Pendiente', source: 'HonduCompras EDCA-SEFIN',
    contract_id: String(contract.id || contract.numero),
    vendor_id: contract.proveedor_id ? String(contract.proveedor_id) : null,
    patterns: patternTipos, pattern_count: patterns.length,
    entidad: contract.entidad, departamento: contract.departamento || null,
    monto: contract.monto || 0, tipo_contratacion: contract.tipo_contratacion || null,
    fecha_publicacion: contract.fecha_publicacion || null, fecha_adjudicacion: contract.fecha_adjudicacion || null,
    proveedor_nombre: contract.proveedor_nombre || null, created_at: new Date().toISOString(),
  };
}

async function insertAlerts(supabase, alerts) {
  if (alerts.length === 0) return { inserted: 0, errors: 0 };
  let inserted = 0, errors = 0;
  for (let i = 0; i < alerts.length; i += 50) {
    const batch = alerts.slice(i, i + 50);
    const { error } = await supabase.from('alerts').insert(batch);
    if (error) { console.error(`[Pipeline] Insert error:`, error.message); errors += batch.length; }
    else { inserted += batch.length; console.log(`[Pipeline] Inserted ${batch.length} alerts`); }
  }
  return { inserted, errors };
}

async function runPipeline() {
  const startTime = Date.now();
  console.log('[Pipeline] ========== SENTINEL-AI PIPELINE START ==========');
  const supabase = getSupabase();
  const { fechaInicio, fechaFin } = getDateRange(DAYS_LOOKBACK);
  console.log(`[Pipeline] Date range: ${fechaInicio} to ${fechaFin}`);
  const rawContracts = await fetchAllContracts(fechaInicio, fechaFin);
  const contractsFetched = rawContracts.length;
  if (contractsFetched === 0) {
    console.warn('[Pipeline] No contracts fetched.');
    return { contractsFetched: 0, contractsAnalyzed: 0, alertsCreated: 0, alertsSkipped: 0, durationMs: Date.now() - startTime };
  }
  const contracts = rawContracts.map(normalizeContract);
  const existingIds = await getExistingContractIds(supabase);
  const newContracts = contracts.filter(c => c.id && !existingIds.has(String(c.id)));
  const skippedDuplicates = contractsFetched - newContracts.length;
  console.log(`[Pipeline] New contracts to analyze: ${newContracts.length} (${skippedDuplicates} duplicates skipped)`);
  if (newContracts.length === 0) return { contractsFetched, contractsAnalyzed: 0, alertsCreated: 0, alertsSkipped: skippedDuplicates, durationMs: Date.now() - startTime };
  const vendorIds = [...new Set(newContracts.map(c => c.proveedor_id).filter(Boolean))];
  const vendorCounts = await getVendorContractCounts(supabase, vendorIds);
  const alertRecords = [];
  let contractsNoPattern = 0;
  for (const contract of newContracts) {
    const patterns = detectPatterns(contract, vendorCounts);
    const severity = calcSeverity(patterns);
    if (!severity) { contractsNoPattern++; continue; }
    alertRecords.push(buildAlertRecord(contract, patterns, severity));
    console.log(`[Pipeline] Alert: ${severity} — ${contract.entidad} — L. ${contract.monto.toLocaleString()}`);
  }
  console.log(`[Pipeline] Alerts generated: ${alertRecords.length} | No pattern: ${contractsNoPattern}`);
  const { inserted, errors } = await insertAlerts(supabase, alertRecords);
  const durationMs = Date.now() - startTime;
  console.log(`[Pipeline] ========== COMPLETE (${durationMs}ms) ==========`);
  return { contractsFetched, contractsAnalyzed: newContracts.length, alertsGenerated: alertRecords.length, alertsCreated: inserted, alertsSkipped: skippedDuplicates + contractsNoPattern, insertErrors: errors, dateRange: { fechaInicio, fechaFin }, durationMs };
}

module.exports = { runPipeline };
