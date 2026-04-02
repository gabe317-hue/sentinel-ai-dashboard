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

      default:
        return res.status(400).json({
          error: 'Invalid action',
          valid: ['list', 'download', 'sync'],
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
