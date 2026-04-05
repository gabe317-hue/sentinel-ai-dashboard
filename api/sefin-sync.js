/**
 * SENTINEL-AI HONDURAS
 * Vercel Serverless Function — api/sefin-sync.js
 *
 * Backend proxy for SEFIN data synchronization
 * Bypasses CORS restrictions by running on server-side
 *
 * Endpoints:
 * - GET  /api/sefin-sync?action=list              -> Get list of available files
 * - GET  /api/sefin-sync?action=download&url=... -> Download specific CSV file
 * - POST /api/sefin-sync?action=sync              -> Run full sync
 *
 * This endpoint is called by:
 * 1. Frontend: syncSEFINDaily() and syncSEFINHistoricalData()
 * 2. Vercel Cron: Scheduled task at 02:00 UTC daily
 */

const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  // Set CORS headers to allow frontend requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET and POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed',
      allowed: ['GET', 'POST'],
    });
  }

  const action = req.query.action || 'list';

  try {
    console.log(`[SEFIN] Action: ${action}, Time: ${new Date().toISOString()}`);

    switch (action) {
      case 'list':
        return handleListDownloads(res);

      case 'download':
        return handleDownloadCSV(req, res);

      case 'sync':
        return handleSync(req, res);

      case 'payment':
        return handlePaymentData(req, res);

      case 'record':
        return handleRecordData(req, res);

      default:
        return res.status(400).json({
          error: 'Invalid action',
          valid: ['list', 'download', 'sync', 'payment', 'record'],
        });
    }
  } catch (error) {
    console.error('[SEFIN] Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/sefin-sync?action=list
 * Returns list of available SEFIN CSV files
 */
async function handleListDownloads(res) {
  console.log('[SEFIN] Fetching list of available downloads...');

  try {
    const response = await fetch(
      'http://contratacionesabiertas.gob.hn/api/v1/descargas/',
      {
        method: 'GET',
        timeout: 30000,
        headers: {
          'User-Agent': 'Sentinel-AI-Honduras/1.0',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    const downloads = data.descargas || [];

    console.log(`[SEFIN] Found ${downloads.length} available files`);

    return res.status(200).json({
      success: true,
      count: downloads.length,
      downloads: downloads.slice(0, 12), // Limit to last 12 months
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[SEFIN] List fetch failed:', error.message);
    return res.status(503).json({
      success: false,
      error: 'No se pudo conectar a SEFIN API',
      detail: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * GET /api/sefin-sync?action=download&url=...
 * Downloads a specific SEFIN CSV file and returns as JSON
 */
async function handleDownloadCSV(req, res) {
  const csvUrl = req.query.url;

  if (!csvUrl) {
    return res.status(400).json({
      error: 'Missing url parameter',
      example: '/api/sefin-sync?action=download&url=http://...',
    });
  }

  console.log(`[SEFIN] Downloading: ${csvUrl.substring(0, 80)}...`);

  try {
    const response = await fetch(csvUrl, {
      method: 'GET',
      timeout: 60000,
      headers: {
        'User-Agent': 'Sentinel-AI-Honduras/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const csvContent = await response.text();
    console.log(`[SEFIN] Downloaded ${csvContent.length} bytes`);

    // Parse CSV to JSON
    const records = parseCSVtoJSON(csvContent);
    console.log(`[SEFIN] Parsed ${records.length} records from CSV`);

    return res.status(200).json({
      success: true,
      recordCount: records.length,
      records: records,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[SEFIN] Download failed:', error.message);
    return res.status(503).json({
      success: false,
      error: 'No se pudo descargar el archivo CSV',
      detail: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * POST /api/sefin-sync?action=sync
 * Run full sync: get latest file and return data for frontend to insert
 */
async function handleSync(req, res) {
  console.log('[SEFIN] Starting sync operation...');

  try {
    // Step 1: Get list of available files
    const listResponse = await fetch(
      'http://contratacionesabiertas.gob.hn/api/v1/descargas/',
      {
        method: 'GET',
        timeout: 30000,
        headers: {
          'User-Agent': 'Sentinel-AI-Honduras/1.0',
        },
      }
    );

    if (!listResponse.ok) {
      throw new Error(`Failed to get list: ${listResponse.status}`);
    }

    const data = await listResponse.json();
    const downloads = data.descargas || [];

    if (downloads.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No files available',
        recordCount: 0,
        records: [],
        timestamp: new Date().toISOString(),
      });
    }

    // Step 2: Download the most recent file
    const latestFile = downloads[0];
    const csvUrl = latestFile.urls?.csv;

    if (!csvUrl) {
      return res.status(200).json({
        success: true,
        message: 'No CSV URL available for latest file',
        recordCount: 0,
        records: [],
        timestamp: new Date().toISOString(),
      });
    }

    console.log(`[SEFIN] Downloading latest: ${latestFile.año}-${latestFile.mes}`);

    const csvResponse = await fetch(csvUrl, {
      method: 'GET',
      timeout: 60000,
      headers: {
        'User-Agent': 'Sentinel-AI-Honduras/1.0',
      },
    });

    if (!csvResponse.ok) {
      throw new Error(`Failed to download CSV: ${csvResponse.status}`);
    }

    const csvContent = await csvResponse.text();
    const records = parseCSVtoJSON(csvContent);

    console.log(`[SEFIN] Sync complete: ${records.length} records`);

    return res.status(200).json({
      success: true,
      message: 'Sync completed successfully',
      recordCount: records.length,
      records: records,
      latestFile: {
        año: latestFile.año,
        mes: latestFile.mes,
        publicador: latestFile.publicador,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[SEFIN] Sync failed:', error.message);
    return res.status(503).json({
      success: false,
      error: 'Error en sincronización SEFIN',
      detail: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * GET /api/sefin-sync?action=record&ocid=...
 * Fetch full contract lifecycle from SEFIN record endpoint (OCDS format)
 * Returns planning, awards, contracts, and implementation.transactions (PAGADO stage)
 */
async function handleRecordData(req, res) {
  const ocid = req.query.ocid;

  if (!ocid) {
    return res.status(400).json({
      error: 'Missing ocid parameter',
      example: '/api/sefin-sync?action=record&ocid=ocds-lcuori-P2023-60-60-400',
    });
  }

  console.log(`[RECORD] Fetching full record for OCID: ${ocid}`);

  try {
    const recordUrl = `http://contratacionesabiertas.gob.hn/api/v1/record/${encodeURIComponent(ocid)}/`;

    const response = await fetch(recordUrl, {
      method: 'GET',
      timeout: 8000,
      headers: {
        'User-Agent': 'Sentinel-AI-Honduras/1.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`[RECORD] API returned ${response.status} for ${ocid}`);
      return res.status(response.status).json({
        success: false,
        error: `SEFIN API returned ${response.status}`,
        ocid: ocid,
        url: recordUrl,
        timestamp: new Date().toISOString(),
      });
    }

    // Use text() first to avoid hanging on malformed JSON
    const rawText = await response.text();
    console.log(`[RECORD] Got response: ${rawText.length} bytes`);

    // Return raw text preview so we can see what the API returns
    let recordData = {};
    let parseError = null;
    try {
      recordData = JSON.parse(rawText);
    } catch (e) {
      parseError = e.message;
    }

    if (parseError) {
      return res.status(200).json({
        success: false,
        ocid: ocid,
        parse_error: parseError,
        raw_preview: rawText.substring(0, 500),
        timestamp: new Date().toISOString(),
      });
    }

    // Extract key fields for SOBRECOSTO detection
    const record = recordData.record || recordData;
    const releases = record.releases || recordData.releases || [];
    const compiledRelease = record.compiledRelease || releases[releases.length - 1] || {};

    const transactions = compiledRelease.implementation?.transactions || [];
    const obligations = compiledRelease.implementation?.financialObligations || [];
    const contracts = compiledRelease.contracts || [];
    const awards = compiledRelease.awards || [];
    const planning = compiledRelease.planning || {};

    const totalPagado = transactions.reduce((sum, t) => sum + (Number(t.value?.amount) || 0), 0);
    const montoContrato = contracts[0]?.value?.amount || awards[0]?.value?.amount || 0;
    const montoPlanificado = planning.budget?.amount?.amount || 0;

    return res.status(200).json({
      success: true,
      ocid: ocid,
      bytes: rawText.length,
      summary: {
        monto_contrato: montoContrato,
        monto_planificado: montoPlanificado,
        monto_pagado_real: totalPagado,
        num_transactions: transactions.length,
        num_obligations: obligations.length,
        sobrecosto: montoContrato > 0 && totalPagado > montoContrato * 1.15,
        pct_exceso: montoContrato > 0 ? Math.round((totalPagado / montoContrato - 1) * 100) : null,
      },
      top_keys: Object.keys(recordData).slice(0, 10),
      record_keys: Object.keys(record || {}).slice(0, 10),
      compiled_keys: Object.keys(compiledRelease || {}).slice(0, 10),
      releases_count: releases.length,
      transactions: transactions.slice(0, 3),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[RECORD] Fetch failed:', error.message);
    return res.status(503).json({
      success: false,
      error: 'No se pudo conectar a SEFIN Record API',
      detail: error.message,
      ocid: ocid,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Parse CSV content to JSON array
 * Handles various CSV formats and encoding
 */
function parseCSVtoJSON(csvContent) {
  try {
    // Remove BOM if present
    const cleanContent = csvContent.replace(/^\uFEFF/, '');

    const lines = cleanContent
      .trim()
      .split('\n')
      .filter(line => line.trim());

    if (lines.length < 2) {
      console.warn('[SEFIN] CSV has less than 2 lines');
      return [];
    }

    const headers = parseCSVLine(lines[0]);
    const records = [];

    for (let i = 1; i < lines.length; i++) {
      try {
        const values = parseCSVLine(lines[i]);
        const obj = {};

        headers.forEach((header, index) => {
          obj[header] = values[index] || '';
        });

        records.push(obj);
      } catch (lineError) {
        console.warn(`[SEFIN] Error parsing line ${i}:`, lineError.message);
        continue;
      }
    }

    return records;
  } catch (error) {
    console.error('[SEFIN] CSV parse error:', error.message);
    return [];
  }
}

/**
 * GET /api/sefin-sync?action=payment&docId=...
 * Fetch payment data from SEFIN documentoF01F07 endpoint
 */
async function handlePaymentData(req, res) {
  const docId = req.query.docId;

  if (!docId) {
    return res.status(400).json({
      error: 'Missing docId parameter',
      example: '/api/sefin-sync?action=payment&docId=OCDS-87BJ3A-123456',
    });
  }

  console.log(`[PAYMENT] Fetching payment data for document: ${docId}`);

  try {
    const paymentUrl = `https://guancasco.sefin.gob.hn/EDCA_WEBAPI/datosabiertos/api/v1/documentoF01F07/${docId}`;

    const response = await fetch(paymentUrl, {
      method: 'GET',
      timeout: 30000,
      headers: {
        'User-Agent': 'Sentinel-AI-Honduras/1.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`[PAYMENT] API returned ${response.status} for ${docId}`);
      return res.status(response.status).json({
        success: false,
        error: `SEFIN API returned ${response.status}`,
        docId: docId,
        timestamp: new Date().toISOString(),
      });
    }

    const paymentData = await response.json();
    console.log(`[PAYMENT] Successfully fetched payment data for ${docId}`);

    // Extract key fields for SOBRECOSTO detection
    const extracted = {
      docId: docId,
      implementation: {
        transactions: paymentData.implementation?.transactions || [],
        financialObligations: paymentData.implementation?.financialObligations || [],
      },
      contracts: paymentData.contracts || [],
      planning: paymentData.planning || {},
    };

    return res.status(200).json({
      success: true,
      data: extracted,
      recordsAvailable: {
        transactions: extracted.implementation.transactions.length,
        obligations: extracted.implementation.financialObligations.length,
        contracts: extracted.contracts.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[PAYMENT] Fetch failed:', error.message);
    return res.status(503).json({
      success: false,
      error: 'No se pudo conectar a SEFIN Payment API',
      detail: error.message,
      docId: docId,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Parse a CSV line, handling quoted fields
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        // Toggle quote state
        insideQuotes = !insideQuotes;
      }
    } else if (char === ',' && !insideQuotes) {
      // Field delimiter
      result.push(current.trim().toLowerCase());
      current = '';
    } else {
      current += char;
    }
  }

  // Add last field
  result.push(current.trim().toLowerCase());

  return result;
}
