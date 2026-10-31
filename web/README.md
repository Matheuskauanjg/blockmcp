# BlockMCP Web Bridge

Implementação **experimental** de plugin Blockbench Web e servidor MCP HTTP remoto, independente do plugin desktop existente. Não oferece as 147 ferramentas do projeto original.

## Arquitetura

Cliente MCP → HTTPS `/mcp` (Bearer API key) → Render → WebSocket WSS `/bridge` (mesma chave) → Plugin em web.blockbench.net → API do Blockbench.

O navegador estabelece a conexão de saída: não há necessidade de abrir portas no computador. Uma aba conectada por servidor. O token é armazenado apenas em **sessionStorage** no navegador, então ainda pode ser lido por scripts/plugins com acesso à mesma origem.

## Desenvolvimento local

```bash
cd web
npm install
BLOCKMCP_API_KEY="$(openssl rand -hex 32)" npm start
```

Em desenvolvimento local, inclua `BLOCKMCP_ALLOWED_ORIGINS=https://web.blockbench.net` (já permitido por padrão) e conecte com URL HTTPS em produção ou HTTP apenas em localhost.

## Render (Web Service Node)

- Repositório: `https://github.com/Matheuskauanjg/blockmcp`
- Branch: `main` ou branch de implementação
- Build: `npm install --prefix web`
- Start: `npm --prefix web start`
- Plano: `free` (atenção à suspensão por inatividade)
- Variável obrigatória: `BLOCKMCP_API_KEY` (segredo aleatório, no mínimo 32 caracteres)

O Render fornece `PORT` e normalmente `RENDER_EXTERNAL_URL`. Abra `https://SEU-SERVICO.onrender.com`.

## Instalação

Em `https://web.blockbench.net/`, use **File → Plugins → Load Plugin from URL** com:

```
https://SEU-SERVICO.onrender.com/blockmcp_web.js
```

Depois: **Tools → Conectar BlockMCP Web**, insira a URL base do Render e a mesma chave. Para um cliente MCP que suporte cabeçalhos customizados:

```json
{
  "servers": {
    "blockmcp-web": {
      "type": "http",
      "url": "https://SEU-SERVICO.onrender.com/mcp",
      "headers": { "Authorization": "Bearer SUA_CHAVE" }
    }
  }
}
```

Os recursos `get_project_info`, `list_cubes`, `list_groups`, `list_textures`, `list_animations`, `create_group`, `create_cube`, `update_cube` e `delete_cube` estão expostos. Os três últimos modificam o editor aberto, e as modificações usam o histórico Undo.

### Segurança e limites

- Não publique a chave nem a coloque em URL/query string. Altere-a no Render se for exposta.
- A URL do plugin é pública; o endpoint de edição é protegido.
- Somente origens `web.blockbench.net`/`www.blockbench.net` podem estabelecer o WebSocket por padrão; `BLOCKMCP_ALLOWED_ORIGINS` permite outras origens explicitamente autorizadas.
- Não há `risky_eval`, acesso ao sistema de arquivos local, upload de modelos nem armazenamento de dados no servidor.
- WebSocket e sessão MCP são mantidos apenas em memória; o navegador precisa continuar aberto. Reinícios e suspensão do Render desconectam temporariamente o plugin.
- Para evitar exposição acidental, não autorize automaticamente chamadas MCP de agentes não confiáveis. Clientes que recebem a chave podem criar/alterar/excluir geometria.
- Atualizações de modelos são reversíveis, mas devem ser verificadas no Blockbench, incluindo Undo/Redo.
- Nenhum teste automatizado substitui o teste manual dentro de `web.blockbench.net`.

Licença: GPL-3.0-only, seguindo a licença do repositório original.
