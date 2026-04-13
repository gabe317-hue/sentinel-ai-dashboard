/**
 * SENTINEL-AI HONDURAS
 * Vercel Serverless Function — api/rss-proxy.js
 *
 * Server-side RSS proxy for Honduras news sources.
 * Bypasses browser CORS restrictions — runs on Vercel edge.
 * No npm dependencies — pure Node.js + built-in fetch.
 *
 * Endpoint:
 *   GET /api/rss-proxy?source=elheraldo
 *   GET /api/rss-proxy?source=laprensa
 *   GET /api/rss-proxy?source=proceso
 *   GET /api/rss-proxy?source=criterio
 *   GET /api/rss-proxy?source=icn
 *
 * Session 11 — Apr 13, 2026
 */

const SOURCES = {
  confidencial:     'https://confidencialhn.com/feed/',
  elpais:   'https://www.elpais.hn/feed/',
  proceso:  'https://proceso.hn/feed/',
  criterio: 'https://criterio.hn/feed/',
  icn:      'https://icndiario.com/feed/',
};

/**
 * Parse RSS XML text into array of items.
 * Handles both plain text and CDATA-wrapped fields.
 * No external XML parser needed.
 */
function parseRSS(xmlText) {
  const items = [];
  const itemMatches = xmlText.match(/<item[\s>]([\s\S]*?)<\/item>/g) || [];

  for (const itemXml of itemMatches) {
    const get = (tag) => {
      // Try CDATA first
      const cdata = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`));
      if (cdata) return cdata[1].trim();
      // Plain text
      const plain = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return plain ? plain[1].trim() : '';
    };

    // <link> in RSS is often bare text between tags (not an attribute)
    let link = get('link');
    // Fallback: atom:link href attribute
    if (!link) {
      const m = itemXml.match(/<link[^>]+href="([^"]+)"/);
      link = m ? m[1] : '';
    }
    // Strip any remaining HTML from description
    const rawDesc = get('description');
    const description = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

    items.push({
      title:       get('title') || '(sin título)',
      link:        link,
      pubDate:     get('pubDate'),
      description: description,
    });

    if (items.length >= 25) break;
  }

  return items;
}

module.exports = async function handler(req, res) {
  // CORS — allow calls from same Vercel domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { source } = req.query;

  if (!source || !SOURCES[source]) {
    return res.status(400).json({
      error: `Fuente inválida. Opciones: ${Object.keys(SOURCES).join(', ')}`,
    });
  }

  try {
    const response = await fetch(SOURCES[source], {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Sentinel-AI/1.0; +https://sentinel-ai-dashboard-beta.vercel.app)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} desde ${SOURCES[source]}`);
    }

    const xmlText = await response.text();
    const items   = parseRSS(xmlText);

    // Cache 5 min at Vercel edge — reduces load on news servers
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

    return res.status(200).json({ source, count: items.length, items });

  } catch (err) {
    console.error(`[rss-proxy] Error fetching ${source}:`, err.message);
    return res.status(502).json({ error: err.message, source });
  }
};
