import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API_KEY = process.env.BLOCKMCP_API_KEY || "";
if (API_KEY.length < 32) {
  console.error("BLOCKMCP_API_KEY must be set to a secret of at least 32 characters.");
  process.exit(1);
}
const PORT = Number(process.env.PORT || 3000);
const publicOrigins = new Set(["https://web.blockbench.net", "https://www.blockbench.net"]);
for (const origin of (process.env.BLOCKMCP_ALLOWED_ORIGINS || "").split(",")) {
  if (origin.trim()) publicOrigins.add(origin.trim());
}
const matchKey = (candidate) => {
  if (typeof candidate !== "string") return false;
  const given = Buffer.from(candidate, "utf8"), known = Buffer.from(API_KEY, "utf8");
  return given.length === known.length && timingSafeEqual(given, known);
};
let editor = null;
const pending = new Map();
const clientSocket = () => editor?.readyState === WebSocket.OPEN ? editor : null;
const failPending = (message) => {
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(message)); }
  pending.clear();
};
function invoke(name, args) {
  const socket = clientSocket();
  if (!socket) return Promise.reject(new Error("Blockbench Web is offline. Open the web plugin and connect."));
  if (pending.size >= 16) return Promise.reject(new Error("Too many concurrent requests."));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Blockbench did not answer within 30 seconds.")); }, 30000);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ type: "call", id, name, args })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const toolList = [
  ["get_project_info", "Inspect the active Blockbench project and format.", z.object({})],
  ["list_cubes", "List cube geometry and coordinates in the current project.", z.object({ limit: z.number().int().min(1).max(500).optional() })],
  ["list_groups", "List bones and groups in the current model.", z.object({})],
  ["list_textures", "List texture names, identifiers and sizes (not image data).", z.object({})],
  ["list_animations", "List animation names and lengths.", z.object({})],
  ["create_group", "Create an undoable group/bone.", z.object({ name: z.string().min(1).max(100), origin: vec3.optional() })],
  ["create_cube", "Add a cube. Changes are undoable in Blockbench.", z.object({ name: z.string().min(1).max(100), from: vec3, to: vec3, group: z.string().optional() })],
  ["update_cube", "Change properties of an existing cube by UUID.", z.object({ uuid: z.string().min(1), name: z.string().min(1).max(100).optional(), from: vec3.optional(), to: vec3.optional(), rotation: vec3.optional() })],
  ["delete_cube", "Delete a cube by UUID. This is undoable.", z.object({ uuid: z.string().min(1) })]
];
function newMcpServer() {
  const mcp = new McpServer({ name: "BlockMCP Web Bridge", version: "0.1.0" }, {
    instructions: "Controls the currently connected Blockbench Web browser tab. First inspect the project, then edit it with UUIDs. Editing tools require a project and run with Undo. The browser must stay open and connected.",
    capabilities: { tools: {} }
  });
  for (const [name, description, schema] of toolList) {
    mcp.registerTool(name, { description, inputSchema: schema.shape }, async (args) => {
      try {
        const data = await invoke(name, schema.parse(args));
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (e) {
        return { content: [{ type: "text", text: String(e?.message || e) }], isError: true };
      }
    });
  }
  return mcp;
}

const pluginCode = readFileSync(new URL("./blockmcp_web.js", import.meta.url));
const page = readFileSync(new URL("./index.html", import.meta.url));
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const origin = req.headers.origin;
  if (origin && publicOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id, MCP-Protocol-Version");
  }
  if (req.method === "OPTIONS") { res.writeHead(origin && !publicOrigins.has(origin) ? 403 : 204); res.end(); return; }
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(page.toString().replaceAll("URL_DO_SERVIDOR", process.env.RENDER_EXTERNAL_URL || ("https://" + req.headers.host))); return;
  }
  if (url.pathname === "/blockmcp_web.js" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "access-control-allow-origin": "*" });
    res.end(pluginCode.toString().replace("__DEFAULT_SERVER_URL__", process.env.RENDER_EXTERNAL_URL || ("https://" + req.headers.host))); return;
  }
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, browserConnected: !!clientSocket() })); return;
  }
  if (url.pathname !== "/mcp") { res.writeHead(404); res.end("Not found"); return; }
  if (origin && !publicOrigins.has(origin)) { res.writeHead(403); res.end("Origin not allowed"); return; }
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
  if (!bearer || !matchKey(bearer[1])) {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="BlockMCP"' });
    res.end(JSON.stringify({ error: "Authorization: Bearer <key> required" })); return;
  }
  if (req.method === "GET" || req.method === "DELETE") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
  if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) { res.writeHead(415); res.end(); return; }
  if (Number(req.headers["content-length"] || 0) > 1024 * 1024) { res.writeHead(413); res.end(); return; }
  try {
    const mcp = newMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
    res.once("close", () => { mcp.close().catch(() => {}); });
  } catch (error) {
    console.error("MCP transport error:", error?.message);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    if (!res.writableEnded) res.end(JSON.stringify({ error: "Internal server error" }));
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/bridge" || !publicOrigins.has(req.headers.origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (ws) => {
  let authed = false;
  const authTimeout = setTimeout(() => { if (!authed) ws.close(1008, "Auth timeout"); }, 7000);
  ws.on("message", (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { ws.close(1003, "Invalid JSON"); return; }
    if (!authed) {
      if (message?.type !== "auth" || !matchKey(message.key)) { ws.close(1008, "Authentication failed"); return; }
      authed = true;
      clearTimeout(authTimeout);
      if (editor && editor !== ws) { failPending("Editor was replaced by a new connection."); editor.close(4001, "New Blockbench connection"); }
      editor = ws;
      ws.send(JSON.stringify({ type: "ready" }));
      return;
    }
    if (ws !== editor || message?.type !== "result" || typeof message.id !== "string") return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(String(message.error)));
    else task.resolve(message.data);
  });
  ws.on("close", () => {
    clearTimeout(authTimeout);
    if (editor === ws) { editor = null; failPending("Blockbench disconnected."); }
  });
  ws.on("error", () => {});
});
server.listen(PORT, "0.0.0.0", () => console.log("BlockMCP Web listening on port " + PORT));
