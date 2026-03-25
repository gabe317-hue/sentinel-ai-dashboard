/**
 * SENTINEL-AI — Sanctions Checker (Vercel/serverless version)
 * ============================================================
 * Vercel-compatible version: no filesystem cache (serverless read-only FS).
 * Downloads OFAC SDN list fresh per pipeline run (cached in module memory
 * across warm Lambda invocations).
 *
 * Data source: U.S. Treasury OFAC SDN List (public domain, no API key)
 * URL: https://www.treasury.gov/ofac/downloads/sdn.csv
 */

const fetch = require('node-fetch');

const OFAC_SDN_CSV_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv';
const MIN_MATCH_TOKENS = 4; // Require at least 4 distinctive words to match (3 was too loose for Honduran data)

// Module-level cache — persists across warm Lambda invocations on Vercel
let _cachedList = null;
let _cacheTime  = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

const LEGAL_SUFFIXES = [
  'S\\.A\\.', 'SA', 'S\\.R\\.L\\.', 'SRL', 'S DE R\\.?L\\.?', 'S DE RL',
  'LTDA\\.?', 'LTDA', 'CIA\\.?', 'CIA', 'CORP\\.?', 'INC\\.?', 'INC',
  'DE C\\.V\\.', 'DE CV', 'S\\.A\\. DE C\\.V\\.', 'SARL', 'S\\.C\\.', 'SC',
  'S\\.A\\. DE CV', 'DE R\\.L\\.', 'DE RL', 'DE CAPITAL VARIABLE',
];
const SUFFIX_REGEX = new RegExp(
  '\\b(' + LEGAL_SUFFIXES.join('|') + ')\\b\\.?', 'gi'
);
const STOP_WORDS = new Set([
  // Spanish articles, prepositions, conjunctions
  'DE', 'LA', 'LAS', 'LOS', 'EL', 'Y', 'E', 'DEL', 'CON', 'EN', 'AL', 'SU',
  // English articles / prepositions
  'THE', 'OF', 'AND', 'FOR', 'IN', 'AN', 'A', 'TO', 'AT',
  // Legal entity type words — too generic to be meaningful match tokens
  'SOCIEDAD', 'RESPONSABILIDAD', 'LIMITADA', 'ANONIMA', 'CAPITAL',
  'VARIABLE', 'EMPRESA', 'INVERSIONES', 'COMERCIAL', 'INDUSTRIAL',
  'CORPORACION', 'GRUPO', 'NACIONAL', 'INTERNACIONAL', 'SERVICES',
  'HOLDINGS', 'HOLDING', 'TRADING', 'ENTERPRISES', 'SOLUTIONS',
  // Common Spanish business sector words (too generic across industries)
  'SERVICIOS', 'CONSULTORES', 'CONSULTORIA', 'CONSTRUCCIONES', 'CONSTRUCTORA',
  'SUMINISTROS', 'DISTRIBUIDORA', 'DISTRIBUCIONES', 'IMPORTADORA', 'IMPORTACIONES',
  'EXPORTADORA', 'EXPORTACIONES', 'REPRESENTACIONES', 'REPRESENTANTE',
  'AGROPECUARIA', 'AGROPECUARIO', 'FINANCIERA', 'FINANCIERO',
  'TECNOLOGIA', 'TECNOLOGIAS', 'ALIMENTOS', 'TRANSPORTE', 'LOGISTICA',
  'ASOCIADOS', 'ASOCIADAS', 'HERMANOS', 'BROTHERS',
  'MANAGEMENT', 'GLOBAL', 'UNIVERSAL', 'CENTRAL', 'GENERAL',
  'DEVELOPMENT', 'INTERNATIONAL', 'RESOURCES', 'PROPERTIES',
  'INVESTMENT', 'INVESTMENTS', 'VENTURE', 'VENTURES',
  'COMERCIALIZADORA', 'COMERCIALIZACION', 'PROVEEDORA', 'PROVEEDORES',
  'HONDURAS', 'HONDURENA', 'HONDURENO', 'CENTROAMERICA', 'CENTROAMERICANA',
]);

function normalizeName(name) {
  if (!name) return '';
  return name.toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(SUFFIX_REGEX, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(normalizedName) {
  return normalizedName.split(' ').filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

function parseCSVLine(line) {
  const result = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

function parseOFACCsv(csvText) {
  const entries = [];
  for (const line of csvText.split('\n')) {
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);
    if (cols.length < 4) continue;
    const sdnType = (cols[2] || '').trim();
    if (sdnType === 'vessel' || sdnType === 'aircraft') continue;
    const rawName = cols[1] ? cols[1].replace(/^"|"$/g, '').trim() : '';
    if (!rawName || rawName === 'Name') continue;
    const program = cols[3] ? cols[3].replace(/^"|"$/g, '').trim() : 'OFAC-SDN';
    const norm    = normalizeName(rawName);
    const tokens  = tokenize(norm);
    if (tokens.length === 0) continue;
    entries.push({ name: rawName, program, norm, tokens });
  }
  return entries;
}

async function buildSanctionsList() {
  const now = Date.now();
  if (_cachedList && (now - _cacheTime) < CACHE_TTL) {
    return _cachedList;
  }
  try {
    console.log('[Sanctions] Downloading OFAC SDN list...');
    const res = await fetch(OFAC_SDN_CSV_URL, {
      timeout: 20000,
      headers: { 'User-Agent': 'Sentinel-AI/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = await res.text();
    _cachedList = parseOFACCsv(csv);
    _cacheTime  = now;
    console.log(`[Sanctions] Loaded ${_cachedList.length} SDN entries`);
    return _cachedList;
  } catch (err) {
    console.warn('[Sanctions] Failed to load SDN list:', err.message);
    return _cachedList || [];
  }
}

function checkSanctions(vendorName, sanctionsList) {
  if (!vendorName || !sanctionsList || sanctionsList.length === 0) return null;
  const normVendor   = normalizeName(vendorName);
  const vendorTokens = new Set(tokenize(normVendor));
  if (vendorTokens.size === 0) return null;
  for (const entry of sanctionsList) {
    const entryTokenSet = new Set(entry.tokens);
    if (entryTokenSet.size === 0) continue;
    let overlap = 0;
    for (const tok of vendorTokens) {
      if (entryTokenSet.has(tok)) overlap++;
    }
    if (overlap < MIN_MATCH_TOKENS) continue;
    const minLen   = Math.min(vendorTokens.size, entryTokenSet.size);
    const coverage = overlap / minLen;
    if (coverage >= 0.75) {
      return { name: entry.name, program: entry.program, overlap, coverage: Math.round(coverage * 100) };
    }
  }
  return null;
}

module.exports = { buildSanctionsList, checkSanctions };
