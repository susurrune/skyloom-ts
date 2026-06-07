/**
 * Web server for Skyloom — HTTP API + optional chat UI.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createSystemContext } from '../core/factory';
import { getLogger } from '../core/logger';

const log = getLogger('web-server');

export interface WebServerOptions {
  port: number;
}

/**
 * Start the Skyloom web server.
 */
export async function startWebServer(port: number = 3000): Promise<void> {
  const ctx = createSystemContext();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      // API routes
      if (pathname === '/api/chat' && req.method === 'POST') {
        await handleChatRequest(req, res, ctx);
      } else if (pathname === '/api/agents' && req.method === 'GET') {
        handleListAgents(res, ctx);
      } else if (pathname === '/api/status' && req.method === 'GET') {
        handleStatus(res, ctx);
      } else if (pathname.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } else {
        // Serve static UI or fallback
        serveUI(req, res, pathname);
      }
    } catch (e) {
      log.error('request_error', { path: pathname, error: String(e) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      log.info('web_server_started', { port });
      console.log(`\n  Skyloom web server running at http://localhost:${port}`);
      console.log(`  API: http://localhost:${port}/api/chat`);
      console.log();
      resolve();
    });
  });
}

async function handleChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ReturnType<typeof createSystemContext>
): Promise<void> {
  const buffers: Buffer[] = [];
  for await (const chunk of req) {
    buffers.push(chunk as Buffer);
  }
  const body = JSON.parse(Buffer.concat(buffers).toString('utf-8'));
  const { message, agent: agentName = 'fog', stream = false } = body;

  if (!message) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'message is required' }));
    return;
  }

  const agent = ctx.agentMap.get(agentName);
  if (!agent) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Agent '${agentName}' not found` }));
    return;
  }

  await agent.init();

  if (stream) {
    // Streaming response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    try {
      for await (const event of agent.chatStream(message)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (e) {
      res.write(`data: ${JSON.stringify({ type: 'error', text: String(e) })}\n\n`);
    }
    res.end();
  } else {
    // Non-streaming response
    try {
      const response = await agent.chat(message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
  }
}

function handleListAgents(
  res: ServerResponse,
  ctx: ReturnType<typeof createSystemContext>
): void {
  const agents = [...ctx.agentMap.entries()].map(([name, agent]) => ({
    name,
    displayName: agent.displayName,
    emoji: agent.emoji,
    specialty: agent.specialty,
    state: agent.state,
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ agents }));
}

function handleStatus(
  res: ServerResponse,
  ctx: ReturnType<typeof createSystemContext>
): void {
  const statuses: Record<string, any> = {};
  for (const [name, agent] of ctx.agentMap) {
    statuses[name] = agent.getStatus();
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    agents: statuses,
    workspace: ctx.workspacePath,
    mcp: ctx.mcpStatus,
  }));
}

function serveUI(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): void {
  // Serve a minimal chat UI at the root
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Skyloom Chat</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #eee; height: 100vh; display: flex; flex-direction: column; }
    header { padding: 12px 20px; background: #16213e; border-bottom: 1px solid #0f3460; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 18px; color: #e94560; }
    header select { background: #0f3460; color: #eee; border: 1px solid #333; padding: 4px 8px; border-radius: 4px; }
    #messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 80%; padding: 12px 16px; border-radius: 12px; line-height: 1.5; white-space: pre-wrap; }
    .user { background: #0f3460; align-self: flex-end; border-bottom-right-radius: 4px; }
    .assistant { background: #16213e; align-self: flex-start; border-bottom-left-radius: 4px; }
    .system { background: #1a1a2e; color: #888; align-self: center; font-size: 13px; font-style: italic; }
    .tool { background: #1a2a1a; color: #8c8; align-self: center; font-size: 13px; }
    .thinking { color: #888; font-style: italic; padding: 8px 16px; }
    #input-area { padding: 12px 20px; background: #16213e; border-top: 1px solid #0f3460; display: flex; gap: 8px; }
    #input { flex: 1; background: #0f3460; border: 1px solid #333; color: #eee; padding: 10px 14px; border-radius: 8px; font-size: 14px; outline: none; }
    #input:focus { border-color: #e94560; }
    #send { background: #e94560; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; }
    #send:hover { background: #c73650; }
    .error { color: #e94560; padding: 8px 16px; text-align: center; }
  </style>
</head>
<body>
  <header>
    <h1>≈ Skyloom</h1>
    <select id="agent-select">
      <option value="fog">≋ 雾 Fog</option>
      <option value="rain">⸽ 雨 Rain</option>
      <option value="frost">✱ 霜 Frost</option>
      <option value="snow">❉ 雪 Snow</option>
      <option value="dew">∘ 露 Dew</option>
      <option value="fair">☼ 晴 Fair</option>
    </select>
  </header>
  <div id="messages">
    <div class="msg system">Welcome to Skyloom. Select an agent and start chatting!</div>
  </div>
  <div id="input-area">
    <input id="input" type="text" placeholder="Type a message..." autofocus>
    <button id="send">Send</button>
  </div>
  <script>
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const agentSelect = document.getElementById('agent-select');
    let streaming = false;

    function addMessage(role, content) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.textContent = content;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }

    async function sendMessage() {
      const text = input.value.trim();
      if (!text || streaming) return;
      input.value = '';
      addMessage('user', text);

      const agent = agentSelect.value;
      const thinking = addMessage('thinking', '...');

      try {
        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, agent }),
        });
        const data = await resp.json();
        thinking.remove();
        if (data.error) {
          addMessage('error', 'Error: ' + data.error);
        } else {
          addMessage('assistant', data.response);
        }
      } catch (e) {
        thinking.remove();
        addMessage('error', 'Connection error');
      }
    }

    send.addEventListener('click', sendMessage);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
  </script>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
