import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = 'local-testing-key-not-to-use-in-production-0123456789';
const appFile = fileURLToPath(new URL('../server.mjs', import.meta.url));
async function reserveEphemeralPort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolveClose) => socket.close(resolveClose));
  return port;
}
async function withApp(run) {
  const port = await reserveEphemeralPort();
  const proc = spawn(process.execPath, [appFile], {
    env: { ...process.env, PORT: String(port), BLOCKMCP_API_KEY: KEY, BLOCKMCP_PUBLIC_URL: 'http://localhost:' + port },
    stdio: ['ignore','pipe','pipe']
  });
  const url = 'http://127.0.0.1:' + port;
  const logChunks = [];
  proc.stdout.on('data', d => logChunks.push(d.toString()));
  proc.stderr.on('data', d => logChunks.push(d.toString()));
  try {
    let started = false;
    for (let i = 0; i < 100; i++) {
      if (proc.exitCode !== null) throw new Error('Server exited: ' + logChunks.join(''));
      try {
        const res = await fetch(url + '/health', { signal: AbortSignal.timeout(250) });
        if (res.ok) { started = true; break; }
      } catch { /* wait until server starts */ }
      await new Promise(done => setTimeout(done, 70));
    }
    if (!started) throw new Error('Server did not start: ' + logChunks.join(''));
    return await run(url);
  } finally {
    proc.kill('SIGTERM');
    await Promise.race([once(proc, 'exit'), new Promise(done => setTimeout(done, 1500))]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
}
const rpc = async (url, id, method, params, authorization = KEY) => {
  const r = await fetch(url + '/mcp', {
    method:'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: authorization ? 'Bearer ' + authorization : '',
      'MCP-Protocol-Version': '2025-03-26'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const data = await r.text();
  let payload;
  try { payload = JSON.parse(data); }
  catch { throw new Error(method + ': HTTP ' + r.status + ' non-JSON response ' + data.slice(0,600)); }
  return { status:r.status, headers:r.headers, payload };
};

test('MCP initializes and discovers nine tools on streamable HTTP, even without Blockbench connected', { timeout: 15000 }, async () => withApp(async url => {
  const denied = await rpc(url, 0, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test', version:'1'} }, null);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /resource_metadata/);
  const start = await rpc(url, 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test',version:'1'} });
  assert.equal(start.status, 200);
  assert.equal(start.payload.result.serverInfo.name, 'BlockMCP Web Bridge');
  const tools = await rpc(url, 2, 'tools/list', {});
  assert.equal(tools.status, 200);
  assert.ok(Array.isArray(tools.payload.result.tools), JSON.stringify(tools.payload));
  const names = tools.payload.result.tools.map(tool => tool.name);
  for(const name of ['get_project_info','list_cubes','list_groups','list_textures','list_animations','create_group','create_cube','update_cube','delete_cube'])
    assert.ok(names.includes(name), 'Missing MCP tool: ' + name);
  const read = tools.payload.result.tools.find(tool => tool.name === 'get_project_info');
  const write = tools.payload.result.tools.find(tool => tool.name === 'create_cube');
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(write.annotations.readOnlyHint, false);
  assert.deepEqual(read.securitySchemes,[{type:'oauth2',scopes:['blockbench:read']}]);
  assert.deepEqual(write.securitySchemes,[{type:'oauth2',scopes:['blockbench:write']}]);
  const call = await rpc(url, 3, 'tools/call', { name:'get_project_info', arguments:{} });
  assert.equal(call.status, 200);
  assert.equal(call.payload.result.isError, true);
  assert.match(call.payload.result.content[0].text, /offline/);
}));
