// One-time helper: run LOCALLY to get a Gmail refresh token for accounts@blueocean.org.in.
// Put this file in the same folder as the client_secret_*.json file downloaded from Google Cloud, then run:
//     node get-gmail-token.js
// (or: node get-gmail-token.js path\to\client_secret.json)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');

// ---- load client id/secret from the downloaded JSON (or from env vars) ----
let id = process.env.GOOGLE_CLIENT_ID;
let secret = process.env.GOOGLE_CLIENT_SECRET;
if (!id || !secret) {
  let file = process.argv[2];
  if (!file) {
    const found = fs.readdirSync(__dirname).find((f) => /^client_secret.*\.json$/i.test(f));
    if (found) file = path.join(__dirname, found);
  }
  if (!file || !fs.existsSync(file)) {
    console.error('Could not find the client_secret_*.json file. Put it in the same folder as this script,\nor run: node get-gmail-token.js path\\to\\client_secret.json');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = cfg.web || cfg.installed || {};
  id = c.client_id;
  secret = c.client_secret;
}
if (!id || !secret) { console.error('client_id / client_secret not found.'); process.exit(1); }

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: id,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/gmail.send', // sending only
  access_type: 'offline',
  prompt: 'consent',
  login_hint: 'accounts@blueocean.org.in',
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== '/oauth2callback') { res.end(); return; }
  const code = u.searchParams.get('code');
  if (!code) {
    res.end('No code returned: ' + (u.searchParams.get('error') || 'unknown'));
    console.error('Google returned an error:', u.searchParams.get('error'));
    process.exit(1);
  }
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
    });
    const t = await r.json();
    if (t.refresh_token) {
      res.end('Done. You can close this tab and return to the terminal.');
      console.log('\nGOOGLE_CLIENT_ID=' + id);
      console.log('GOOGLE_REFRESH_TOKEN=' + t.refresh_token + '\n');
      console.log('Add these (plus GOOGLE_CLIENT_SECRET) in Render > Environment. Do not share or commit them.');
    } else {
      res.end('Failed. See the terminal.');
      console.error('No refresh token returned:', t);
    }
  } catch (e) {
    res.end('Failed. See the terminal.');
    console.error('Token request failed:', e.message);
  }
  server.close();
  process.exit(0);
});

server.listen(PORT, () => console.log('Open this URL in your browser and sign in as accounts@blueocean.org.in:\n\n' + authUrl + '\n'));
