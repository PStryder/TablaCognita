#!/usr/bin/env node
// TablaCognita — MCP Relay Server
// Runs as MCP server (stdio or SSE) + WebSocket relay + static file server for editor.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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

// Express app for static files + MCP SSE
const app = express();

// CORS — wide open for MCP client access
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
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
  });
});

// Create HTTP server and attach WebSocket relay
const httpServer = http.createServer(app);
relay.attach(httpServer);

// MCP Server
const mcpServer = new Server(
  { name: 'tabla-cognita', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// Register tool list
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: getToolDefinitions() };
});

// Register tool call handler
const handleTool = createToolHandler(relay, DEFAULT_SESSION_TOKEN);

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: toolArgs } = request.params;
  return handleTool(name, toolArgs || {});
});

// Start
async function start() {
  // Always start HTTP + WebSocket server (editor needs it)
  httpServer.listen(portArg, () => {
    console.error(`[server] HTTP + WebSocket on http://localhost:${portArg}`);
    console.error(`[server] Editor: http://localhost:${portArg}/index.html`);
  });

  if (transportArg === 'stdio') {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error(`[server] MCP stdio transport active`);
  } else if (transportArg === 'sse') {
    console.error(`[server] SSE transport not yet implemented (Phase 6)`);
    process.exit(1);
  }
}

start().catch((err) => {
  console.error('[server] Fatal:', err);
  process.exit(1);
});

// Export for testing
export { mcpServer, httpServer, relay, sessionManager, app };
