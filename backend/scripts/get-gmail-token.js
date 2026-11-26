// One-time helper: run LOCALLY to get a Gmail refresh token for the accounts mailbox.
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-gmail-token.js
// Sign in as accounts@blueocean.org.in when the browser opens. Paste the printed token into Render.
const http = require('http');
const { URL, URLSearchParams } = require('url');

const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) { console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.'); process.exit(1); }
const REDIRECT = 'http://localhost:53682/oauth2callback';

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: id, redirect_uri: REDIRECT, response_type: 'code',
  scope: 'https://www.googleapis.com/auth/gmail.send',
  access_type: 'offline', prompt: 'consent',
  login_hint: 'accounts@blueocean.org.in',
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== '/oauth2callback') return res.end();
  const code = u.searchParams.get('code');
  if (!code) { res.end('No code returned: ' + (u.searchParams.get('error') || '')); return; }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
  });
  const t = await r.json();
  res.end(t.refresh_token ? 'Done. Return to the terminal.' : 'Failed. See terminal.');
  if (t.refresh_token) console.log('\nGOOGLE_REFRESH_TOKEN=' + t.refresh_token + '\n');
  else console.error('No refresh token returned:', t);
  process.exit(0);
}).listen(53682, () => console.log('Open this URL in your browser:\n\n' + authUrl + '\n'));
