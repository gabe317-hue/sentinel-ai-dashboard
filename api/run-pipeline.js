const { runPipeline } = require('../data-pipeline');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  console.log('[Handler] Pipeline triggered:', req.method, new Date().toISOString());
  try {
    const result = await runPipeline();
    return res.status(200).json({ success: true, timestamp: new Date().toISOString(), ...result });
  } catch (error) {
    console.error('[Handler] Pipeline failed:', error.message);
    if (error.message.includes('Missing Supabase credentials')) {
      return res.status(503).json({ success: false, error: 'Configure SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en Vercel', timestamp: new Date().toISOString() });
    }
    return res.status(500).json({ success: false, error: error.message, timestamp: new Date().toISOString() });
  }
};
