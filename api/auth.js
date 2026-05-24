// Sentinel-AI — Auth endpoint
// Validates site password and sets access cookie (7-day expiry).
// To revoke access: change SENTINEL_PASSWORD in Vercel env vars → redeploy.

module.exports = (req, res) => {
  const PASSWORD = process.env.SENTINEL_PASSWORD;
  const COOKIE_SECRET = 'snl-auth-ok-2026';

  if (!PASSWORD) {
    return res.status(500).send('SENTINEL_PASSWORD env var not configured.');
  }

  const { pw, redirect } = req.query;
  const target = redirect && redirect.startsWith('/') ? redirect : '/HTML/index.html';

  if (pw === PASSWORD) {
    // Valid — set HttpOnly cookie (7 days) and redirect to original page
    res.setHeader(
      'Set-Cookie',
      `snl-auth=${COOKIE_SECRET}; HttpOnly; Path=/; Max-Age=604800; SameSite=Strict`
    );
    res.redirect(302, target);
  } else {
    // Invalid — redirect back to blocked page with error flag
    res.redirect(302, `${target}?error=1`);
  }
};
