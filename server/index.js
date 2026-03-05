#!/usr/bin/env node
// TablaCognita — MCP Relay Server
// Runs as MCP server (stdio or Streamable HTTP) + WebSocket relay + static file server for editor.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { SessionManager } from './sessions.js';
import { Relay } from './relay.js';
import { getToolDefinitions, createToolHandler } from './tools.js';
import { DEFAULT_HTTP_PORT, DEFAULT_SESSION_TOKEN } from '../shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse args
const args = process.argv.slice(2);
const transportArg = args.includes('--transport') ? args[args.indexOf('--transport') + 1] : 'stdio';
const portArg = args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1]) : DEFAULT_HTTP_PORT;

// Core services
const sessionManager = new SessionManager();
const relay = new Relay(sessionManager);

// Express app for static files + MCP Streamable HTTP
const app = express();

// CORS — wide open for MCP client access
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

app.use(express.static(path.join(__dirname, '..', 'editor')));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));

// File read endpoint for open_document
// NOTE: No path restriction — intentionally open for MVP. Restrict before production.
app.get('/api/read-file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }
  try {
    const resolved = path.resolve(filePath);
    const content = fs.readFileSync(resolved, 'utf-8');
    res.json({ content });
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: `Failed to read file: ${err.message}` });
  }
});

// Health endpoint
app.get('/health', (_req, res) => {
  const token = DEFAULT_SESSION_TOKEN;
  res.json({
    status: 'ok',
    session: token,
    editor_connected: sessionManager.hasEditor(token),
    transport: transportArg,
  });
});

// --- Streamable HTTP MCP Transport ---
// Each MCP client gets its own transport + Server instance, but all share the same relay.
const mcpSessions = new Map(); // sessionId → { transport, server }

function createMcpServer() {
  const server = new Server(
    { name: 'tabla-cognita', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolDefinitions(),
  }));

  const handleTool = createToolHandler(relay, DEFAULT_SESSION_TOKEN);
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;
    return handleTool(name, toolArgs || {});
  });

  return server;
}

// MCP endpoint — handles POST (messages), GET (SSE stream), DELETE (close session)
app.use('/mcp', express.json());

app.all('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  // Existing session — route to its transport
  if (sessionId && mcpSessions.has(sessionId)) {
    const { transport } = mcpSessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // Unknown session ID — 404
  if (sessionId && !mcpSessions.has(sessionId)) {
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Session not found. Client must reinitialize.' },
      id: null,
    });
    return;
  }

  // No session ID — new initialization request
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  const server = createMcpServer();
  await server.connect(transport);

  // Handle the initialization request first (generates session ID)
  await transport.handleRequest(req, res, req.body);

  // Store session (sessionId is set after handleRequest processes the init)
  const sid = transport.sessionId;
  if (sid) {
    mcpSessions.set(sid, { transport, server });
    console.error(`[mcp] New Streamable HTTP session: ${sid}`);
  }

  // Clean up on close
  transport.onclose = () => {
    console.error(`[mcp] Session closed: ${sid}`);
    mcpSessions.delete(sid);
    server.close();
  };

  transport.onerror = (err) => {
    console.error(`[mcp] Transport error for ${sid}:`, err.message);
  };
});

// Create HTTP server and attach WebSocket relay
const httpServer = http.createServer(app);
relay.attach(httpServer);

// Start
async function start() {
  // Always start HTTP + WebSocket server (editor needs it)
  httpServer.listen(portArg, '0.0.0.0', () => {
    console.error(`[server] HTTP + WebSocket on http://0.0.0.0:${portArg}`);
    console.error(`[server] Editor: http://localhost:${portArg}/index.html`);
    console.error(`[server] MCP (Streamable HTTP): http://localhost:${portArg}/mcp`);
  });

  if (transportArg === 'stdio') {
    // Also start stdio transport for local MCP clients
    const mcpServer = createMcpServer();
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error(`[server] MCP stdio transport active`);
  }
}

start().catch((err) => {
  console.error('[server] Fatal:', err);
  process.exit(1);
});

// Export for testing
export { httpServer, relay, sessionManager, app };
