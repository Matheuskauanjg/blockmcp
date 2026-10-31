import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createOAuthController, CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI } from '../oauth.mjs';
const SECRET = 'test-secret-with-64-random-characters-REPLACE_FOR_REAL_SETUP';
const BASE = 'https://blockmcp-web-bridge.onrender.com';
const resource = BASE + '/mcp';
const verifier = 'abcABC123--abcABC123--abcABC123--abcABC123--abcABC123';
const challenge = createHash('sha256').update(verifier).digest('base64url');
async function withServer(fn) {
  const controller = createOAuthController({ apiKey: SECRET, baseUrl: BASE });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, BASE);
    if (await controller.maybeHandle(req, res, url)) return;
    if (url.pathname === '/test-auth') { res.writeHead(controller.checkBearer(req.headers.authorization) ? 200 : 401); res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn('http://127.0.0.1:' + server.address().port, controller); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('ChatGPT discovery, PKCE exchange, rotation and token verification', async () => withServer(async (url, controller) => {
  const r = await fetch(url + '/.well-known/oauth-protected-resource');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).resource, resource);
  const metadata = await (await fetch(url + '/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  const registration = await fetch(url + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CHATGPT_REDIRECT_URI], token_endpoint_auth_method: 'none' }) });
  assert.equal(registration.status, 201);
  const q = new URLSearchParams({ response_type: 'code', client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT_URI, code_challenge: challenge, code_challenge_method: 'S256', resource, state: 'state123' });
  const authPage = await fetch(url + '/oauth/authorize?' + q);
  assert.equal(authPage.status, 200);
  // Chrome applies form-action restrictions across the approval POST 303 redirect.
  // The CSP must allow both our same-origin form and the official ChatGPT callback.
  assert.equal(authPage.headers.get('content-security-policy')?.includes("form-action 'self' https://chatgpt.com;"), true);
  assert.equal(authPage.headers.get('content-security-policy')?.includes('https://*'), false);
  const ticket = (await authPage.text()).match(/name="ticket" value="([^"]+)"/)[1];
  const denied = await fetch(url + '/oauth/approve', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket, password: 'wrong' }) });
  assert.equal(denied.status, 403);
  const approved = await fetch(url + '/oauth/approve', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket, password: SECRET }), redirect: 'manual' });
  assert.equal(approved.status, 303);
  const callback = new URL(approved.headers.get('location'));
  assert.equal(callback.searchParams.get('iss'), BASE);
  assert.equal(callback.searchParams.get('state'), 'state123');
  const code = callback.searchParams.get('code');
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: CHATGPT_CLIENT_ID, redirect_uri: CHATGPT_REDIRECT_URI, code_verifier: verifier, resource });
  const tokenResponse = await fetch(url + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json();
  assert.equal(controller.checkBearer('Bearer ' + token.access_token), true);
  assert.equal(controller.checkBearer('Bearer wrong'), false);
  assert.equal((await fetch(url + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })).status, 400);
  const refreshed = await fetch(url + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CHATGPT_CLIENT_ID, refresh_token: token.refresh_token, resource }) });
  assert.equal(refreshed.status, 200);
  assert.notEqual((await refreshed.json()).access_token, token.access_token);
}));
test('rejects arbitrary redirect and registration', async () => withServer(async (url) => {
  const q = new URLSearchParams({ response_type: 'code', client_id: CHATGPT_CLIENT_ID, redirect_uri: 'https://attacker.invalid/cb', code_challenge: challenge, code_challenge_method: 'S256' });
  assert.equal((await fetch(url + '/oauth/authorize?' + q)).status, 400);
  const reg = await fetch(url + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://attacker.invalid/cb'] }) });
  assert.equal(reg.status, 400);
}));
