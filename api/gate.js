// Sentinel-AI — Page Gate
// All HTML pages route through here via vercel.json rewrites.
// Checks cookie; if invalid, shows login page. If valid, serves the HTML file.

const fs   = require('fs');
const path = require('path');

const COOKIE_NAME   = 'snl-auth';
const COOKIE_SECRET = 'snl-auth-ok-2026';

function getCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function loginHTML(redirect, error) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sentinel AI — Acceso Restringido</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Syne:wght@700;900&display=swap');
  *{margin:0;padding:0;box-sizing:border-box;}
  body{background:#0a0e1a;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:'JetBrains Mono',monospace;}
  .box{width:320px;text-align:center;}
  .lock{font-size:28px;margin-bottom:16px;opacity:0.7;}
  .logo{font-family:'Syne',sans-serif;font-size:32px;font-weight:900;color:#fff;letter-spacing:-1px;margin-bottom:4px;}
  .logo span{color:#00c8ff;}
  .sub{font-size:10px;letter-spacing:3px;color:rgba(0,200,255,0.5);text-transform:uppercase;margin-bottom:32px;}
  input[type=password]{width:100%;padding:12px 16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:8px;color:#fff;font-size:14px;font-family:inherit;outline:none;margin-bottom:12px;}
  input[type=password]:focus{border-color:#00c8ff;}
  button{width:100%;padding:12px;background:#00c8ff;border:none;border-radius:8px;color:#0a0e1a;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit;letter-spacing:2px;}
  button:hover{background:#33d4ff;}
  .error{color:#ff3d57;font-size:11px;margin-bottom:12px;padding:8px;background:rgba(255,61,87,0.1);border-radius:6px;border:1px solid rgba(255,61,87,0.2);}
  .warn{font-size:10px;color:rgba(255,255,255,0.2);margin-top:20px;line-height:1.6;}
</style>
</head>
<body>
<div class="box">
  <div class="lock">🔒</div>
  <div class="logo">SENTINEL<span>-AI</span></div>
  <div class="sub">Acceso Restringido</div>
  ${error ? '<div class="error">Contraseña incorrecta. Intente nuevamente.</div>' : ''}
  <form method="GET" action="/api/auth">
    <input type="hidden" name="redirect" value="${redirect}">
    <input type="password" name="pw" placeholder="Contraseña de acceso" autofocus autocomplete="current-password">
    <button type="submit">INGRESAR</button>
  </form>
  <div class="warn">Sistema de uso exclusivo autorizado.<br>Todo acceso es registrado.</div>
</div>
</body>
</html>`;
}

module.exports = (req, res) => {
  const token = getCookie(req.headers.cookie, COOKIE_NAME);
  const page  = req.query.page || 'index';
  const error = req.query.error === '1';

  // Reconstruct original path for redirect after login
  const originalPath = page === 'index' ? '/' : `/HTML/${page}`;

  if (token !== COOKIE_SECRET) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(loginHTML(originalPath, error));
  }

  // Serve the HTML file
  const fileName = page.endsWith('.html') ? page : (page === 'index' ? 'index.html' : page + '.html');
  const filePath = path.join(process.cwd(), 'HTML', fileName);

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).send(content);
  } catch (e) {
    res.status(404).send('Página no encontrada.');
  }
};
