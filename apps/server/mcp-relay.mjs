// The P9 MCP server's stdio end (mcp.mjs). The chat's adapter starts this with P9_MCP_SOCKET (the daemon's desktop
// socket or pipe) and P9_MCP_TOKEN (that chat's token); each stdin line goes to POST /mcp, each reply comes back as a
// stdout line. Requests run side by side, so a cancel reaches the daemon while a tool call waits for the user.
// Node's standard library only: the bundle copies this file as it is (scripts/bundle-daemon.mjs).
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const socketPath = process.env.P9_MCP_SOCKET, token = process.env.P9_MCP_TOKEN;
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n');

function post(line) {
  return new Promise((resolve) => {
    const req = request({ socketPath, method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', 'x-p9-mcp': token } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', () => resolve({ status: 0 }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.end(line);
  });
}

// stdin closed: the agent is done with this server. Exiting closes the open requests, which cancels any approval still waiting.
createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let id;
  try { id = JSON.parse(line).id; } catch {}
  const { status, text } = await post(line);
  if (status === 200 && text) process.stdout.write(text.trim() + '\n');
  else if (status !== 204 && id !== undefined && id !== null) out({ jsonrpc: '2.0', id, error: { code: -32603, message: status ? 'P9 refused (' + status + ')' : 'P9 is not running' } });
}).on('close', () => process.exit(0));
