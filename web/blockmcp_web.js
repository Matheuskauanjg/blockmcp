/* BlockMCP Web: browser-only Blockbench MCP client.
 * Loads into https://web.blockbench.net/ and calls the authenticated Render relay.
 * This is intentionally a safe subset of the desktop plugin, not a replacement.
 */
(() => {
  "use strict";
  const STORAGE = "blockmcp_web_credentials";
  const DEFAULT_SERVER_URL = "__DEFAULT_SERVER_URL__";
  let socket = null;
  let reconnectTimer = null;
  let reconnectEnabled = false;
  let action = null;
  let config = { url: DEFAULT_SERVER_URL, key: "" };

  function notify(message, duration = 3500) {
    Blockbench.showQuickMessage("[BlockMCP Web] " + message, duration);
  }
  function loadConfig() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(STORAGE) || "{}");
      config = { url: stored.url || DEFAULT_SERVER_URL, key: stored.key || "" };
    } catch { config = { url: DEFAULT_SERVER_URL, key: "" }; }
  }
  function stop() {
    reconnectEnabled = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const previous = socket;
    socket = null;
    if (previous) previous.close();
  }
  function wsAddress(text) {
    const target = new URL(text);
    if (target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1"].includes(target.hostname))) {
      throw new Error("Use HTTPS (ou HTTP somente em localhost).");
    }
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    target.pathname = "/bridge";
    target.search = "";
    target.hash = "";
    return target.href;
  }
  function connect() {
    stop();
    if (!config.key || config.key.length < 32) { notify("Informe uma chave de pelo menos 32 caracteres."); return; }
    let address;
    try { address = wsAddress(config.url); } catch (error) { notify(error.message); return; }
    reconnectEnabled = true;
    const open = () => {
      if (!reconnectEnabled) return;
      const connection = new WebSocket(address);
      socket = connection;
      let authenticated = false;
      connection.addEventListener("open", () => {
        connection.send(JSON.stringify({ type: "auth", key: config.key }));
      });
      connection.addEventListener("message", async (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message?.type === "ready") {
          authenticated = true;
          notify("Conectado ao servidor MCP.");
          return;
        }
        if (!authenticated || message?.type !== "call" || typeof message.id !== "string") return;
        if (typeof message.name !== "string") return;
        try {
          const data = await runTool(message.name, message.args || {});
          if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "result", id: message.id, data }));
        } catch (error) {
          if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "result", id: message.id, error: String(error?.message || error) }));
        }
      });
      connection.addEventListener("close", (event) => {
        if (socket !== connection) return;
        socket = null;
        if (!reconnectEnabled) return;
        if (event.code === 1008 || event.code === 4001) {
          reconnectEnabled = false;
          notify(event.code === 1008 ? "Chave rejeitada ou origem não autorizada." : "Outra aba assumiu a conexão.", 6000);
          return;
        }
        if (authenticated) notify("Desconectado. Tentando reconectar...");
        reconnectTimer = setTimeout(open, 3500);
      });
      connection.addEventListener("error", () => {});
    };
    open();
  }
  function requireProject() {
    if (typeof Project === "undefined" || !Project) throw new Error("Abra ou crie um projeto no Blockbench primeiro.");
  }
  function cubeData(cube) {
    return {
      uuid: cube.uuid, name: cube.name, from: [...cube.from], to: [...cube.to],
      rotation: [...cube.rotation], origin: [...cube.origin],
      parent: cube.parent?.name || null
    };
  }
  function validCubeBounds(from, to) {
    if (from && to && from.some((value, index) => value > to[index])) throw new Error("O vetor from não pode ultrapassar to.");
  }
  function edit(label, aspects, fn) {
    Undo.initEdit(aspects);
    try {
      const result = fn();
      Undo.finishEdit(label, aspects);
      Canvas.updateAll();
      return result;
    } catch (error) {
      try { Undo.cancelEdit(); } catch {}
      throw error;
    }
  }
  async function runTool(name, args) {
    requireProject();
    switch (name) {
      case "get_project_info":
        return {
          name: Project.name || "Sem nome",
          format: (typeof Format !== "undefined" && Format?.id) || null,
          cubes: Cube.all.length,
          groups: Group.all.length,
          textures: Texture.all.length,
          animations: Animation.all.length
        };
      case "list_cubes":
        return { total: Cube.all.length, cubes: Cube.all.slice(0, Math.max(1, Math.min(500, args.limit || 150))).map(cubeData) };
      case "list_groups":
        return Group.all.map(group => ({
          uuid: group.uuid, name: group.name,
          origin: [...group.origin], rotation: [...group.rotation],
          parent: group.parent?.name || null, children: group.children?.length || 0
        }));
      case "list_textures":
        return Texture.all.map(texture => ({
          uuid: texture.uuid, name: texture.name, width: texture.width, height: texture.height
        }));
      case "list_animations":
        return Animation.all.map(animation => ({
          uuid: animation.uuid, name: animation.name, length: animation.length, loop: animation.loop
        }));

      case "get_cube_faces": {
        const cube = Cube.all.find(item => item.uuid === args.uuid);
        if (!cube) throw new Error("Cubo não encontrado: " + args.uuid);
        const faces = {};
        for (const [direction, face] of Object.entries(cube.faces)) {
          faces[direction] = { uv: [...face.uv], texture: face.texture || null, rotation: face.rotation || 0 };
        }
        return { uuid: cube.uuid, name: cube.name, faces };
      }
      case "get_texture_data": {
        const texture = Texture.all.find(item => item.uuid === args.uuid);
        if (!texture) throw new Error("Textura não encontrada: " + args.uuid);
        const dataUrl = texture.getDataURL();
        if (dataUrl.length > 900000) throw new Error("Textura muito grande para transferir pelo MCP.");
        return { uuid: texture.uuid, name: texture.name, width: texture.width, height: texture.height, data_url: dataUrl };
      }
      case "set_cube_faces": {
        const cube = Cube.all.find(item => item.uuid === args.uuid);
        if (!cube) throw new Error("Cubo não encontrado: " + args.uuid);
        const allowed = new Set(["north", "south", "east", "west", "up", "down"]);
        for (const [dir, data] of Object.entries(args.faces)) {
          if (!allowed.has(dir) || !cube.faces[dir]) throw new Error("Face inválida: " + dir);
          if (data.texture && !Texture.all.some(texture => texture.uuid === data.texture)) {
            throw new Error("Textura não encontrada: " + data.texture);
          }
        }
        return edit("BlockMCP: atualizar UV por face", { elements: [cube], uv_only: true }, () => {
          cube.box_uv = false;
          for (const [dir, data] of Object.entries(args.faces)) {
            cube.faces[dir].uv = [...data.uv];
            if (data.texture) cube.faces[dir].texture = data.texture;
          }
          return { uuid: cube.uuid, changed_faces: Object.keys(args.faces) };
        });
      }
      case "create_texture": {
        const canvas = document.createElement("canvas");
        canvas.width = args.width;
        canvas.height = args.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D indisponível.");
        ctx.fillStyle = args.color || "#956227";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const texture = edit("BlockMCP: criar textura", { textures: [] }, () =>
          new Texture({ name: args.name, width: args.width, height: args.height })
            .fromDataURL(canvas.toDataURL("image/png")).add(false)
        );
        await new Promise(resolve => {
          if (texture.img?.complete && texture.img?.naturalWidth) return resolve();
          if (texture.img?.addEventListener) texture.img.addEventListener("load", resolve, { once: true });
          setTimeout(resolve, 1200);
        });
        return { uuid: texture.uuid, name: texture.name, width: texture.width, height: texture.height };
      }
      case "paint_texture_rects": {
        const texture = Texture.all.find(item => item.uuid === args.uuid);
        if (!texture) throw new Error("Textura não encontrada: " + args.uuid);
        for (const r of args.rects) {
          if (r.x + r.width > texture.width || r.y + r.height > texture.height) {
            throw new Error("Pintura fora do limite da textura.");
          }
        }
        texture.edit(canvas => {
          const ctx = canvas.getContext("2d");
          ctx.imageSmoothingEnabled = false;
          for (const r of args.rects) {
            ctx.fillStyle = r.color;
            ctx.fillRect(r.x, r.y, r.width, r.height);
          }
        }, { edit_name: "BlockMCP: pintar textura", no_undo: false });
        Canvas.updateAll();
        return { uuid: texture.uuid, painted_rectangles: args.rects.length };
      }
      case "apply_group_uvs": {
        const texture = Texture.all.find(item => item.uuid === args.texture);
        if (!texture) throw new Error("Textura não encontrada: " + args.texture);
        const assignments = [];
        for (const m of args.mappings) {
          const group = Group.all.find(g => g.uuid === m.group || g.name === m.group);
          if (!group) throw new Error("Grupo não encontrado: " + m.group);
          const cubes = Cube.all.filter(cube => cube.parent === group);
          if (cubes.length === 0) throw new Error("Grupo sem cubos: " + m.group);
          assignments.push({ cubes, uv: m.uv });
        }
        const cubes = [...new Set(assignments.flatMap(item => item.cubes))];
        return edit("BlockMCP: aplicar atlas UV aos grupos", { elements: cubes, uv_only: true }, () => {
          for (const assignment of assignments) {
            for (const cube of assignment.cubes) {
              cube.box_uv = false;
              for (const face of Object.values(cube.faces)) {
                face.uv = [...assignment.uv];
                face.texture = texture.uuid;
              }
            }
          }
          return { texture: texture.uuid, mapped_cubes: cubes.length, mapped_groups: assignments.length };
        });
      }
      case "create_group":
        return edit("BlockMCP: criar grupo", { outliner: true }, () => {
          const group = new Group({ name: args.name, ...(args.origin ? { origin: args.origin } : {}) }).init();
          group.addTo();
          return { uuid: group.uuid, name: group.name };
        });
      case "create_cube": {
        validCubeBounds(args.from, args.to);
        const group = args.group ? Group.all.find(item => item.uuid === args.group || item.name === args.group) : null;
        if (args.group && !group) throw new Error("Grupo não encontrado: " + args.group);
        return edit("BlockMCP: criar cubo", { elements: [], outliner: true }, () => {
          const cube = new Cube({ name: args.name, from: args.from, to: args.to }).init();
          if (group) cube.addTo(group);
          else cube.addTo();
          return cubeData(cube);
        });
      }
      case "update_cube": {
        const cube = Cube.all.find(item => item.uuid === args.uuid);
        if (!cube) throw new Error("Cubo não encontrado: " + args.uuid);
        validCubeBounds(args.from || cube.from, args.to || cube.to);
        return edit("BlockMCP: editar cubo", { elements: [cube] }, () => {
          if (args.name !== undefined) cube.name = args.name;
          if (args.from) cube.from = [...args.from];
          if (args.to) cube.to = [...args.to];
          if (args.rotation) cube.rotation = [...args.rotation];
          return cubeData(cube);
        });
      }
      case "delete_cube": {
        const cube = Cube.all.find(item => item.uuid === args.uuid);
        if (!cube) throw new Error("Cubo não encontrado: " + args.uuid);
        return edit("BlockMCP: excluir cubo", { elements: [cube], outliner: true }, () => {
          const deleted = { uuid: cube.uuid, name: cube.name };
          cube.remove();
          return { deleted };
        });
      }
      default:
        throw new Error("Ferramenta não permitida: " + name);
    }
  }
  function showConnectionDialog() {
    new Dialog({
      id: "blockmcp_web_connection",
      title: "BlockMCP Web — Conectar ao Render",
      form: {
        url: { label: "Endereço do servidor (HTTPS)", type: "text", value: config.url },
        key: { label: "Chave secreta do servidor", type: "password", value: config.key }
      },
      onConfirm(form) {
        const next = { url: String(form.url || "").trim().replace(/\/+$/, ""), key: String(form.key || "").trim() };
        try { wsAddress(next.url); } catch (error) { notify(error.message); return false; }
        config = next;
        try { sessionStorage.setItem(STORAGE, JSON.stringify(config)); } catch {}
        connect();
      }
    }).show();
  }
  Plugin.register("blockmcp_web", {
    title: "BlockMCP Web Bridge",
    author: "Matheuskauanjg",
    description: "Conecta o Blockbench Web a um servidor MCP remoto autenticado.",
    icon: "hub",
    version: "0.1.0",
    min_version: "5.0.0",
    variant: "web",
    tags: ["Utility", "AI"],
    onload() {
      loadConfig();
      action = new Action("blockmcp_web_connect", {
        name: "Conectar BlockMCP Web",
        description: "Configurar conexão MCP remota para este navegador",
        icon: "hub",
        click: showConnectionDialog
      });
      MenuBar.menus.tools.addAction(action);
      if (config.key && config.url) connect();
      else notify("Abra Ferramentas > Conectar BlockMCP Web.");
    },
    onunload() {
      stop();
      action?.delete();
      action = null;
    }
  });
})();
