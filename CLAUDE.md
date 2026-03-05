# TablaCognita

MCP-native collaborative markdown editor. Three components:
- **Editor** (browser): CodeMirror 6, single source of truth, all doc state
- **Relay** (Node.js): Stateless MCP↔WebSocket bridge
- **AI Client**: Any MCP-capable app

## Quick Start

```bash
npm install
npm test          # 122 tests
npm start         # Starts relay (stdio MCP) + editor server on :3000
```

## Architecture

```
server/index.js    — MCP server + Express + WebSocket relay entry point
server/relay.js    — WebSocket relay, request/response correlation
server/sessions.js — Session management (1 session = 1 browser tab = 1 MCP client)
server/tools.js    — MCP tool definitions and handlers

shared/protocol.js      — Message types, error codes, constants
shared/sections.js      — Section parser (heading-based + I10 paragraph fallback)
shared/fuzzy.js         — 4-level fuzzy matching (exact → ws-normalized → md-stripped → Levenshtein)
shared/locks.js         — Lock state machine (explicit + auto, TTL, owner tracking)
shared/notifications.js — Notification debouncing and validation

editor/app.js      — Browser editor: CodeMirror 6, WebSocket client, request handlers
editor/index.html  — Editor shell with importmap for ESM CDN
editor/styles.css  — Dark theme

test/              — Node.js test runner, no deps needed
```

## Key Invariants (from DESIGN.md)

- I1: Browser is single source of truth (relay holds zero doc state)
- I2: Section IDs stable across renames
- I3: Locks have bounded lifetime (max 120s)
- I4: One session = one browser tab = one MCP client
- I5: Dirty flags reset only on get_section()
- I8: Auto-lock is atomic with the edit
- I9: Agent edits are undoable (CM6 transactions)
- I10: Headingless docs get implicit paragraph sections

## Development

- Pure ESM (`"type": "module"`)
- Node.js 18+, no build step
- Tests: `node --test test/*.test.js`
- shared/ modules work in both Node.js and browser
