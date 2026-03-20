/**
 * SENTINEL-AI HONDURAS
 * Vercel Serverless Function — api/run-pipeline.js
 *
 * This endpoint is called by Vercel Cron Job at 02:00 UTC daily.
 * It can also be called manually to trigger the pipeline on demand.
 *
 * GET  /api/run-pipeline  -> runs the pipeline and returns a JSON summary
 * POST /api/run-pipeline  -> same as GET (useful for webhook triggers)
 *
 * Environment variables required (set in Vercel Dashboard -> Settings -> Environment Variables):
 *   SUPABASE_URL              — your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (NOT anon key)
 */

const { runPipeline } = require('../lib/data-pipeline');

module.exports = async function handler(req, res) {
  // Only allow GET and POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed',
      allowed: ['GET', 'POST'],
    });
  }

  console.log('[Handler] Pipeline triggered:', req.method, new Date().toISOString());

  try {
    const result = await runPipeline();

    return res.status(200).json({
      success: true,
      message: 'Pipeline ejecutado correctamente',
      timestamp: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    console.error('[Handler] Pipeline failed:', error.message);

    // Check for common configuration errors
    if (error.message.includes('Missing Supabase credentials')) {
      return res.status(503).json({
        success: false,
        error: 'Configuracion incompleta',
        detail: 'Configure SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en las variables de entorno de Vercel',
        timestamp: new Date().toISOString(),
      });
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
};
