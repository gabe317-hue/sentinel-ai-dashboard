/**
 * SEFIN Integration for SOBRECOSTO Detection
 *
 * This module adds SEFIN budget execution data to the data-pipeline
 * to enable real SOBRECOSTO (overpayment) detection.
 *
 * Integration Steps:
 * 1. Import this module at the top of data-pipeline.js
 * 2. Add SEFIN data fetch to the main pipeline function
 * 3. Replace the SOBRECOSTO detection logic (line 309-334)
 * 4. Pass SEFIN data to pattern detection
 */

// ════════════════════════════════════════════════════════════════════════════
// STEP 1: Add to imports at top of data-pipeline.js
// ════════════════════════════════════════════════════════════════════════════

/*
// Add this import:
const { SEFINDataIntegration } = require('./sefin-integration.js');
*/

// ════════════════════════════════════════════════════════════════════════════
// STEP 2: SEFIN Integration Module
// ════════════════════════════════════════════════════════════════════════════

class SEFINDataIntegration {
  constructor(cacheDirPath = '/tmp/sefin-cache') {
    this.cacheDirPath = cacheDirPath;
    this.cacheTimeout = 3600000; // 1 hour
    this.budgetData = [];
    this.lastFetch = null;
  }

  /**
   * Fetch SEFIN data from API
   * Falls back to cached data if API fails
   */
  async fetchSEFINData() {
    // Check cache first
    const cached = this.loadFromCache();
    if (cached) {
      console.log('[SEFIN] Loaded from cache');
      this.budgetData = cached;
      return cached;
    }

    try {
      console.log('[SEFIN] Fetching budget execution data...');

      // Try API endpoint
      const response = await fetch(
        'http://contratacionesabiertas.gob.hn/api/v1/descargas/ejecucion',
        { timeout: 30000 }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      let data = await response.json();

      // Normalize field names
      this.budgetData = this.normalizeData(data);
      this.saveToCache(this.budgetData);

      console.log(`[SEFIN] Fetched ${this.budgetData.length} budget records`);
      return this.budgetData;

    } catch (error) {
      console.error(`[SEFIN] Fetch failed: ${error.message}`);
      console.log('[SEFIN] Using empty data (SOBRECOSTO detection disabled)');
      this.budgetData = [];
      return [];
    }
  }

  /**
   * Normalize field names across different SEFIN data sources
   */
  normalizeData(records) {
    if (!Array.isArray(records)) return [];

    return records.map(r => ({
      entity_name: r.entidad || r.entity || r.nombre_ministerio || '',
      allocated_amount: parseFloat(r.monto_asignado || r.asignado || 0),
      executed_amount: parseFloat(r.ejecutado_acumulado || r.ejecutado || 0),
      transaction_date: r.fecha_ejecucion || r.fecha || '',
      budget_code: r.codigo_presupuestario || r.codigo || ''
    })).filter(r => r.allocated_amount > 0);
  }

  /**
   * Find matching SEFIN budget record for a contract
   * Uses entity name fuzzy matching + amount validation
   */
  findMatchingBudget(contract) {
    if (this.budgetData.length === 0) return null;

    const contractEntity = (contract.entidad || '').toLowerCase().trim();
    const contractAmount = parseFloat(contract.monto || 0);
    const contractDate = contract.fecha_adjudicacion || '';

    let bestMatch = null;
    let bestScore = 0;

    for (const budget of this.budgetData) {
      // 1. Fuzzy entity match
      const budgetEntity = budget.entity_name.toLowerCase();
      const entityScore = this.fuzzyMatch(contractEntity, budgetEntity);
      if (entityScore < 0.5) continue; // Require 50%+ similarity

      // 2. Amount validation (within 15%)
      const amountDiff = Math.abs(contractAmount - budget.allocated_amount) / contractAmount;
      if (amountDiff > 0.15) continue;

      // 3. Date proximity (within 60 days)
      const daysDiff = this.daysDifference(contractDate, budget.transaction_date);
      if (daysDiff > 60) continue;

      // Calculate match score
      const score = (entityScore + (1 - amountDiff) + (1 - daysDiff / 60)) / 3;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = budget;
      }
    }

    return bestMatch;
  }

  /**
   * Fuzzy match two strings (0-1, where 1 = perfect match)
   */
  fuzzyMatch(str1, str2) {
    if (str1 === str2) return 1;

    const words1 = new Set(str1.split(/\s+/));
    const words2 = new Set(str2.split(/\s+/));
    const common = [...words1].filter(w => words2.has(w)).length;
    const union = new Set([...words1, ...words2]).size;

    return union > 0 ? common / union : 0;
  }

  /**
   * Calculate days between two dates
   */
  daysDifference(date1, date2) {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    return Math.abs((d2 - d1) / (1000 * 60 * 60 * 24));
  }

  /**
   * Load SEFIN data from cache
   */
  loadFromCache() {
    try {
      const fs = require('fs');
      const cacheFile = `${this.cacheDirPath}/sefin-budget.json`;

      if (!fs.existsSync(cacheFile)) return null;

      const stats = fs.statSync(cacheFile);
      const age = Date.now() - stats.mtime.getTime();

      if (age > this.cacheTimeout) return null;

      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      return data;
    } catch (error) {
      return null;
    }
  }

  /**
   * Save SEFIN data to cache
   */
  saveToCache(data) {
    try {
      const fs = require('fs');
      const path = require('path');

      if (!fs.existsSync(this.cacheDirPath)) {
        fs.mkdirSync(this.cacheDirPath, { recursive: true });
      }

      const cacheFile = `${this.cacheDirPath}/sefin-budget.json`;
      fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error(`[SEFIN] Cache save failed: ${error.message}`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 3: Updated SOBRECOSTO Detection Function
// ════════════════════════════════════════════════════════════════════════════

/**
 * Detect SOBRECOSTO pattern using SEFIN data
 * Replace the old detection (lines 309-334) with this function
 */
function detectSOBRECOSTO(contract, sefinIntegration, SOBRECOSTO_THRESHOLD = 0.15) {
  const monto = parseFloat(contract.monto || 0);
  const monto_pagado = parseFloat(contract.monto_pagado || 0);
  const presupuesto = parseFloat(contract.presupuesto || 0);

  if (monto < 100000) return null; // Skip small contracts

  // NEW: Try SEFIN data first (actual payment data)
  if (sefinIntegration && sefinIntegration.budgetData.length > 0) {
    const budgetMatch = sefinIntegration.findMatchingBudget(contract);

    if (budgetMatch) {
      const difference = budgetMatch.executed_amount - budgetMatch.allocated_amount;
      const ratio = difference / budgetMatch.allocated_amount;

      if (ratio > SOBRECOSTO_THRESHOLD) {
        const pctOver = (ratio * 100).toFixed(1);
        const fmtL = n => 'L ' + Number(n).toLocaleString('es-HN', {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0
        });

        return {
          tipo: 'SOBRECOSTO',
          descripcion: `SEFIN: Pagado ${fmtL(budgetMatch.executed_amount)} vs Presupuesto ${fmtL(budgetMatch.allocated_amount)} (+${pctOver}%)`,
          source: 'SEFIN'
        };
      }
    }
  }

  // Fallback: Use payment data from EDCA (if available)
  if (monto_pagado > 0 && monto_pagado > monto * (1 + SOBRECOSTO_THRESHOLD)) {
    const pctOver = ((monto_pagado / monto - 1) * 100).toFixed(0);
    const fmtL = n => 'L ' + Number(n).toLocaleString('es-HN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    });

    return {
      tipo: 'SOBRECOSTO',
      descripcion: `EDCA: Pagado ${fmtL(monto_pagado)} vs Contratado ${fmtL(monto)} (+${pctOver}%)`,
      source: 'EDCA'
    };
  }

  // Final Fallback: Use budget comparison
  if (presupuesto > 0 && monto > presupuesto * (1 + SOBRECOSTO_THRESHOLD)) {
    const pctOver = ((monto / presupuesto - 1) * 100).toFixed(0);
    const fmtL = n => 'L ' + Number(n).toLocaleString('es-HN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    });

    return {
      tipo: 'SOBRECOSTO',
      descripcion: `PRESUPUESTO: Adjudicado ${fmtL(monto)} vs Presupuesto ${fmtL(presupuesto)} (+${pctOver}%)`,
      source: 'PRESUPUESTO'
    };
  }

  return null; // No SOBRECOSTO detected
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 4: Integration in Main Pipeline Function
// ════════════════════════════════════════════════════════════════════════════

/**
 * How to integrate into the main pipeline function:
 *
 * async function analyzeContracts() {
 *   // ... existing code ...
 *
 *   // NEW: Initialize SEFIN integration
 *   const sefinIntegration = new SEFINDataIntegration();
 *   await sefinIntegration.fetchSEFINData();
 *
 *   // Existing contract fetching...
 *   const contracts = await fetchContracts();
 *
 *   // For each contract, detect patterns:
 *   for (const contract of contracts) {
 *     const patterns = [];
 *
 *     // ... existing pattern detection ...
 *
 *     // NEW: SOBRECOSTO detection with SEFIN
 *     const sobrecosto = detectSOBRECOSTO(contract, sefinIntegration, SOBRECOSTO_THRESHOLD);
 *     if (sobrecosto) {
 *       patterns.push(sobrecosto);
 *     }
 *
 *     // ... rest of pattern detection and alert saving ...
 *   }
 * }
 */

// ════════════════════════════════════════════════════════════════════════════
// Export for use in data-pipeline.js
// ════════════════════════════════════════════════════════════════════════════

module.exports = {
  SEFINDataIntegration,
  detectSOBRECOSTO
};
