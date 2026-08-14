// One-time helper: run `npm run get-refresh-token` locally (NOT on your public server) to
// mint a Google OAuth refresh token for the Primo Care owner's Gmail/Calendar account.
// You only need to do this once per Google account. Requires GOOGLE_CLIENT_ID and
// GOOGLE_CLIENT_SECRET to already be set in your .env file (see README.md step 1).

require('dotenv').config();
const http = require('http');
const https = require('https');
const url = require('url');
const querystring = require('querystring');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:53682/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env. See README.md step 1 first.');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.compose'
];

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + querystring.stringify({
  access_type: 'offline',
  prompt: 'consent', // forces a refresh_token to be issued even on repeat runs
  scope: SCOPES.join(' '),
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI
});

console.log('\n1. Open this URL in a browser, and sign in as the Primo Care owner\'s Google account:\n');
console.log(authUrl + '\n');
console.log('2. After granting access, you\'ll be redirected to localhost — this script is listening and will capture it automatically.\n');

// Exchanges the authorization code for tokens using Node's built-in https module directly,
// rather than the googleapis/gaxios client. Some recent Node.js versions have a regression
// (nodejs/node#63989) that makes gaxios's keep-alive HTTP agent throw a false "Premature
// close" error specifically against oauth2.googleapis.com — going straight through https
// with a fresh, non-keep-alive connection sidesteps that bug entirely.
function exchangeCodeForTokens(code){
  return new Promise(function(resolve, reject){
    var body = querystring.stringify({
      code: code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    });
    var req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Connection': 'close' // avoid keep-alive socket reuse, which is what triggers the bug
      },
      agent: new https.Agent({ keepAlive: false })
    }, function(res){
      var chunks = [];
      res.on('data', function(c){ chunks.push(c); });
      res.on('end', function(){
        var text = Buffer.concat(chunks).toString('utf8');
        var data;
        try { data = JSON.parse(text); }
        catch(e){ return reject(new Error('Could not parse response: ' + text)); }
        if(res.statusCode >= 400){
          return reject(new Error((data && (data.error_description || data.error)) || ('HTTP ' + res.statusCode)));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const server = http.createServer(function(req, res){
  var qs = new url.URL(req.url, REDIRECT_URI).searchParams;
  var code = qs.get('code');
  if (!code) {
    res.end('No code received. Check the terminal and try again.');
    return;
  }
  exchangeCodeForTokens(code).then(function(tokens){
    res.end('Success! You can close this tab and go back to your terminal.');
    server.close();

    console.log('\nDone. Add this line to your .env file:\n');
    console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
    if (!tokens.refresh_token) {
      console.log('WARNING: no refresh_token was returned. This usually means you\'ve already');
      console.log('authorized this app before. Go to https://myaccount.google.com/permissions,');
      console.log('remove access for this app, then run this script again.');
    }
    process.exit(0);
  }).catch(function(err){
    console.error('Error exchanging code for tokens:', err.message);
    res.end('Error — check the terminal.');
    server.close();
    process.exit(1);
  });
});

server.listen(53682);
