import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Private single-owner OAuth 2.1 authorization-code + PKCE server.
 * Tokens live in memory. A Render restart may require reauthorization.
 */
export const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
export const CHATGPT_REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
const SCOPES = new Set(['blockbench:read', 'blockbench:write']);
const MAX_FORM_BYTES = 8192;
const MAX_MAP_SIZE = 200;
const random = (n = 32) => randomBytes(n).toString('base64url');
const digest = (data) => createHash('sha256').update(data).digest('base64url');
const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(JSON.stringify(body));
};
function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; base-uri 'none'; frame-ancestors 'none'" });
  res.end(body);
}
const safe = (s) => String(s).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const oauthError = (res, status, message) => json(res, status, { error: message });
function readForm(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) return reject(new Error('expected_form'));
    let data = '', size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) { reject(new Error('request_too_large')); req.destroy(); return; }
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(new URLSearchParams(data)));
    req.on('error', reject);
  });
}
function cleanExpired(map, now) {
  for (const [id, record] of map) if (record.expires <= now) map.delete(id);
  while (map.size > MAX_MAP_SIZE) map.delete(map.keys().next().value);
}
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createOAuthController({ apiKey, baseUrl }) {
  if (!apiKey || apiKey.length < 32) throw new Error('BLOCKMCP_API_KEY must have at least 32 characters');
  const base = new URL(baseUrl).origin;
  if (new URL(baseUrl).protocol !== 'https:' && !base.startsWith('http://localhost:')) throw new Error('OAuth issuer must use HTTPS');
  const resource = base + '/mcp';
  const authorizations = new Map();
  const codes = new Map();
  const access = new Map();
  const refresh = new Map();
  const DCR_ID = 'chatgpt-public-' + createHmac('sha256', apiKey).update('blockmcp-dcr').digest('hex').slice(0, 20);
  const validClient = (s) => s === CHATGPT_CLIENT_ID || s === DCR_ID;
  const redirectAllowed = (s) => s === CHATGPT_REDIRECT_URI;
  const tokenUrl = base + '/oauth/token';
  const challenge = 'Bearer resource_metadata="' + base + '/.well-known/oauth-protected-resource", scope="blockbench:read blockbench:write"';

  function checkBearer(value) {
    if (typeof value !== 'string') return false;
    const match = /^Bearer (\S+)$/i.exec(value);
    if (!match) return false;
    if (sameSecret(match[1], apiKey)) return true; // existing MCP clients
    const item = access.get(digest(match[1]));
    if (!item) return false;
    if (item.expires <= Date.now() || item.audience !== resource) { access.delete(digest(match[1])); return false; }
    return true;
  }

  function getGrantedScopes(value) {
    if (typeof value !== 'string') return [];
    const match = /^Bearer (\S+)$/i.exec(value);
    if (!match) return [];
    if (sameSecret(match[1], apiKey)) return [...SCOPES]; // legacy manual credentials
    const entry = access.get(digest(match[1]));
    if (!entry || entry.expires <= Date.now() || entry.audience !== resource) return [];
    return entry.scope.split(/\s+/).filter(scope => SCOPES.has(scope));
  }

  function issueTokens(clientId, grantedScope) {
    const now = Date.now();
    cleanExpired(access, now); cleanExpired(refresh, now);
    const a = random(32), r = random(48);
    access.set(digest(a), { expires: now + 60 * 60_000, audience: resource, clientId, scope: grantedScope });
    refresh.set(digest(r), { expires: now + 7 * 24 * 60 * 60_000, audience: resource, clientId, scope: grantedScope });
    return { access_token: a, token_type: 'Bearer', expires_in: 3600, refresh_token: r, scope: grantedScope };
  }
  function showApproval(res, ticket, failed = false) {
    html(res, failed ? 403 : 200, '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autorizar BlockMCP Web</title><style>body{font:16px system-ui;background:#121c2b;color:#f3f6ff;padding:35px 18px}main{max-width:480px;margin:0 auto;background:#1d2d44;border-radius:15px;padding:30px}input,button{font:inherit;display:block;width:100%;padding:12px;border-radius:8px;box-sizing:border-box}button{margin-top:20px;background:#8ebaff;border:0;cursor:pointer}input{margin-top:10px;background:#0d1827;color:white;border:1px solid #7991b2}p{line-height:1.5;color:#d4dfef}.error{color:#ffb7b7}</style></head><body><main><h1>Autorizar BlockMCP Web</h1><p>O ChatGPT solicita acesso para inspecionar e editar o seu projeto Blockbench aberto. Apenas autorize se você iniciou esta conexão.</p><p>Para confirmar, informe a chave secreta <b>BLOCKMCP_API_KEY</b> configurada no Render. Ela não será enviada ao ChatGPT.</p>' +
      (failed ? '<p class="error">Chave incorreta. Verifique no Render e tente novamente.</p>' : '') + '<form action="/oauth/approve" method="post"><input type="hidden" name="ticket" value="' + safe(ticket) + '"><label>Chave de autorização<input type="password" name="password" autocomplete="off" minlength="32" required></label><button type="submit">Autorizar ChatGPT</button></form></main></body></html>');
  }
  function handleAuthorize(req, res, url) {
    const p = url.searchParams;
    const clientId = p.get('client_id');
    const redirect = p.get('redirect_uri');
    const scope = p.get('scope') || 'blockbench:read blockbench:write';
    const requestedScopes = scope.trim().split(/\s+/);
    const challenge = p.get('code_challenge');
    if (p.get('response_type') !== 'code' || !validClient(clientId) || !redirectAllowed(redirect) ||
        p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge || '') ||
        requestedScopes.some((s) => !SCOPES.has(s)) || (p.has('resource') && p.get('resource') !== resource)) {
      oauthError(res, 400, 'invalid_request'); return;
    }
    const now = Date.now(); cleanExpired(authorizations, now);
    const ticket = random();
    authorizations.set(ticket, { clientId, redirect, scope: requestedScopes.join(' '), challenge, state: p.get('state') || '', expires: now + 5 * 60_000 });
    showApproval(res, ticket);
  }
  async function handleApprove(req, res) {
    let p;
    try { p = await readForm(req); } catch { oauthError(res, 400, 'invalid_request'); return; }
    const ticket = p.get('ticket');
    const item = authorizations.get(ticket);
    if (!item || item.expires <= Date.now()) { authorizations.delete(ticket); oauthError(res, 400, 'authorization_expired'); return; }
    if (!sameSecret(p.get('password'), apiKey)) { showApproval(res, ticket, true); return; }
    authorizations.delete(ticket);
    cleanExpired(codes, Date.now());
    const code = random(32);
    codes.set(digest(code), { ...item, audience: resource, expires: Date.now() + 60_000 });
    const callback = new URL(item.redirect);
    callback.searchParams.set('code', code);
    if (item.state) callback.searchParams.set('state', item.state);
    callback.searchParams.set('iss', base);
    res.writeHead(303, { location: callback.href, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end();
  }
  async function handleToken(req, res) {
    let p;
    try { p = await readForm(req); } catch { oauthError(res, 400, 'invalid_request'); return; }
    const grant = p.get('grant_type'), clientId = p.get('client_id');
    if (!validClient(clientId) || (p.has('resource') && p.get('resource') !== resource)) { oauthError(res, 400, 'invalid_client'); return; }
    if (grant === 'authorization_code') {
      const code = p.get('code');
      const item = code && codes.get(digest(code));
      if (!item || item.expires <= Date.now() || item.clientId !== clientId || item.redirect !== p.get('redirect_uri')) { oauthError(res, 400, 'invalid_grant'); return; }
      codes.delete(digest(code)); // one-time code
      const verifier = p.get('code_verifier') || '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !sameSecret(digest(verifier), item.challenge)) { oauthError(res, 400, 'invalid_grant'); return; }
      json(res, 200, issueTokens(clientId, item.scope), { 'pragma': 'no-cache' }); return;
    }
    if (grant === 'refresh_token') {
      const token = p.get('refresh_token');
      const item = token && refresh.get(digest(token));
      if (!item || item.expires <= Date.now() || item.clientId !== clientId) { oauthError(res, 400, 'invalid_grant'); return; }
      refresh.delete(digest(token)); // rotate refresh tokens
      json(res, 200, issueTokens(clientId, item.scope), { 'pragma': 'no-cache' }); return;
    }
    oauthError(res, 400, 'unsupported_grant_type');
  }
  async function handleRegister(req, res) {
    let body = '';
    try {
      for await (const chunk of req) { body += chunk.toString(); if (body.length > MAX_FORM_BYTES) throw new Error('too large'); }
      const p = JSON.parse(body);
      if (!Array.isArray(p.redirect_uris) || p.redirect_uris.length !== 1 || !redirectAllowed(p.redirect_uris[0]) ||
        (p.token_endpoint_auth_method && p.token_endpoint_auth_method !== 'none') ||
        (p.grant_types && p.grant_types.some((t) => !['authorization_code', 'refresh_token'].includes(t)))) throw new Error('invalid_client_metadata');
      json(res, 201, { client_id: DCR_ID, client_name: 'ChatGPT BlockMCP', redirect_uris: [CHATGPT_REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
    } catch { oauthError(res, 400, 'invalid_client_metadata'); }
  }
  async function maybeHandle(req, res, url) {
    const path = url.pathname;
    if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      json(res, 200, { resource, authorization_servers: [base], scopes_supported: [...SCOPES] }); return true;
    }
    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      json(res, 200, { issuer: base, authorization_endpoint: base + '/oauth/authorize', token_endpoint: tokenUrl,
        registration_endpoint: base + '/oauth/register', token_endpoint_auth_methods_supported: ['none'],
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], scopes_supported: [...SCOPES],
        authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true }); return true;
    }
    if (req.method === 'GET' && path === '/oauth/authorize') { handleAuthorize(req, res, url); return true; }
    if (req.method === 'POST' && path === '/oauth/approve') { await handleApprove(req, res); return true; }
    if (req.method === 'POST' && path === '/oauth/token') { await handleToken(req, res); return true; }
    if (req.method === 'POST' && path === '/oauth/register') { await handleRegister(req, res); return true; }
    return false;
  }
  return { maybeHandle, checkBearer, getGrantedScopes, challenge, resource, issuer: base };
}
