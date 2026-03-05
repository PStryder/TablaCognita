# TablaCognita

**Co-write with any AI. In your browser. No data on anyone's server.**

TablaCognita is a browser-based Markdown editor where AI is a first-class participant, not a feature bolted onto a text box. Select text and send it to your AI. Watch edits land in real time. Undo anything. The AI sees the document through MCP tools — the same protocol that powers Claude Desktop, Cursor, and every other MCP-capable client.

Your document lives in your browser. The relay server is a stateless wire. Nobody stores your writing.

## How It Works

```
┌──────────────┐   MCP (stdio | HTTP)   ┌──────────────┐   WebSocket   ┌──────────────────┐
│  Your AI     │◄───────────────────────►│    Relay      │◄────────────►│  Browser Editor   │
│  (Claude,    │   Tool calls/results    │  (stateless)  │              │  (source of truth)│
│   Cursor,    │                         │               │              │                   │
│   any MCP)   │                         └──────────────┘              │  CodeMirror 6     │
└──────────────┘                                                       │  Live preview     │
                                                                       │  Section tracking │
                                                                       │  Lock management  │
                                                                       └──────────────────┘
```

The AI reads and writes through 17 MCP tools. The editor handles section addressing, fuzzy text matching, collision avoidance, and undo. The relay just passes messages. That's it.

## Quick Start

```bash
git clone https://github.com/pstryder/tablacognita.git
cd tablacognita
npm install
npm start
```

Open `http://localhost:3000` in your browser. The editor is live.

Connect your MCP client. For Claude Desktop, add to your config:

```json
{
  "mcpServers": {
    "tabla-cognita": {
      "command": "node",
      "args": ["server/index.js", "--transport", "stdio"],
      "cwd": "/path/to/tablacognita"
    }
  }
}
```

Your AI can now read your document, edit sections, replace text, and respond to selections you send it from the editor.

## What Your AI Can Do

**Read** — `read_document`, `get_structure`, `get_section`. The AI sees your full document, section outline, or individual sections by heading name or stable ID.

**Write** — `replace_section`, `replace_text`, `insert_after`, `append`. Section-level edits with auto-locking. Fuzzy text matching that works through markdown formatting (`**bold text**` matched by searching "bold text"). Full document replacement requires your confirmation in the browser.

**Coordinate** — `request_edit_lock`, `release_lock`, `get_cursor_context`, `get_dirty_regions`, `poll_context`. The AI knows where your cursor is, which sections you've edited since it last looked, and can lock sections for multi-step operations. All locks have TTLs — nothing stays locked forever.

**Manage** — `open_document`, `snapshot`, `restore_snapshot`, `get_revision_history`. Named checkpoints saved to your browser's IndexedDB. Restore any snapshot with one tool call.

## Key Design Decisions

**Browser is source of truth.** The relay holds zero document state. If the relay restarts, your document is still in your browser. The AI reconnects and continues.

**Section IDs are stable.** Rename a heading from "Introduction" to "Overview" — the section ID doesn't change. The AI can always find its way back.

**Agent edits are undoable.** Every AI edit goes through CodeMirror's transaction system. Ctrl+Z works on AI edits exactly like your own.

**Locks are intent signals, not mutexes.** Auto-locks during edits are atomic and invisible. Explicit locks for multi-step operations have TTLs and never block you — just a gentle indicator that the AI is working on a section.

**Notifications are fire-and-forget.** The editor tells the AI when you move between sections, rename headings, or delete content. If the transport doesn't support notifications, the AI can poll instead. No feature depends on notifications arriving.

**No data leaves your browser.** Documents live in CodeMirror's state. Snapshots live in IndexedDB. The relay is a WebSocket bridge with no storage. There is nothing to subpoena.

## Project Structure

```
server/
  index.js          — MCP server + Express + WebSocket relay
  relay.js          — WebSocket relay, request/response correlation
  sessions.js       — Session management
  tools.js          — MCP tool definitions and handlers

editor/
  index.html        — Editor shell with CodeMirror 6 via ESM CDN
  app.js            — Editor logic, WebSocket handlers, all tool implementations
  styles.css        — Dark theme

shared/
  protocol.js       — Message types, error codes, constants
  sections.js       — Section parser with stable ID registry
  fuzzy.js          — 4-level fuzzy matching cascade
  locks.js          — Lock state machine with TTL
  notifications.js  — Notification debouncing and validation

test/
  relay.test.js     — Full relay round-trip tests
  sections.test.js  — Section parser unit tests
  fuzzy.test.js     — Fuzzy matching unit tests
  locks.test.js     — Lock state machine tests
  notifications.test.js — Notification system tests
  mock-browser.js   — Mock WebSocket client for automated testing
```

## Running Tests

```bash
npm test              # All 122 tests
npm run test:sections # Section parser only
npm run test:fuzzy    # Fuzzy matching only
npm run test:relay    # Relay round-trip only
```

## Transport Modes

```bash
npm start                    # HTTP transport (default, port 3000)
npm run start:stdio          # stdio transport (for local MCP clients)
npm start -- --port 8080     # Custom port
```

## Requirements

- Node.js 18+
- A modern browser
- Any MCP-capable AI client

## Architecture Details

See [DESIGN.md](DESIGN.md) for the full specification: tool contracts, WebSocket protocol, invariants, failure modes, and build plan.

## License

Apache 2.0

## Credits

TablaCognita was designed and built by [Pete Marchetti (PStryder)](https://github.com/pstryder) at Technomancy Laboratories, with architectural review and first live edit by Kee (Claude Opus 4.6).

*The page that knows. — tabla cognita*
