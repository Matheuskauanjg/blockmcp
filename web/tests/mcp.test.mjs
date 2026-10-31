import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

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

test('MCP initializes and discovers fifteen tools on streamable HTTP, even without Blockbench connected', { timeout: 15000 }, async () => withApp(async url => {
  // Discovering tool metadata is safe without OAuth. Execution remains guarded.
  const deniedGet = await fetch(url + '/mcp');
  assert.equal(deniedGet.status, 401);
  assert.match(deniedGet.headers.get('www-authenticate'), /resource_metadata/);
  const anonymousStart = await rpc(url, 0, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test', version:'1'} }, null);
  assert.equal(anonymousStart.status, 200);
  const anonymousTools = await rpc(url, 10, 'tools/list', {}, null);
  assert.equal(anonymousTools.status, 200);
  assert.equal(anonymousTools.payload.result.tools.length, 15);
  const anonymousCall = await rpc(url, 11, 'tools/call', { name:'get_project_info', arguments:{} }, null);
  assert.equal(anonymousCall.status, 200);
  assert.equal(anonymousCall.payload.result.isError, true);
  assert.ok(anonymousCall.payload.result._meta?.['mcp/www_authenticate']?.length);
  const start = await rpc(url, 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'test',version:'1'} });
  assert.equal(start.status, 200);
  assert.equal(start.payload.result.serverInfo.name, 'BlockMCP Web Bridge');
  const tools = await rpc(url, 2, 'tools/list', {});
  assert.equal(tools.status, 200);
  assert.ok(Array.isArray(tools.payload.result.tools), JSON.stringify(tools.payload));
  // This is where the ChatGPT app update validates tool metadata.
  // A successful JSON-RPC tools/list is insufficient if even one schema
  // contains invalid JSON Schema 2020-12 keywords or tuple syntax.
  const validator = new Ajv2020({ strict: false, allErrors: true });
  for(const tool of tools.payload.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.doesNotThrow(() => validator.compile(tool.inputSchema), 'Invalid MCP inputSchema: '+tool.name);
    assert.equal(tool.inputSchema.$schema === undefined ||
      tool.inputSchema.$schema === 'https://json-schema.org/draft/2020-12/schema', true, tool.name);
  }
  const vec = tools.payload.result.tools.find(t => t.name === 'create_cube').inputSchema.properties.from;
  assert.equal(vec.type,'array');
  assert.equal(vec.minItems, 3);
  assert.equal(vec.maxItems, 3);
  assert.equal(Array.isArray(vec.items),false);
  const names = tools.payload.result.tools.map(tool => tool.name);
  for(const name of ['get_project_info','list_cubes','list_groups','list_textures','list_animations','create_group','create_cube','update_cube','delete_cube','get_cube_faces','get_texture_data','set_cube_faces','create_texture','paint_texture_rects','apply_group_uvs'])
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
