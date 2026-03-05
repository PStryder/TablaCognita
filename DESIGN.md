# TablaCognita — MCP-Native Collaborative Editor

## Architecture Overview

```
                        MCP (stdio | SSE)
┌──────────────────┐ ◄──────────────────────►  ┌──────────────────────┐
│   AI Client      │                           │   Relay Server       │
│  (Claude Desktop,│    Tool calls / results   │   (Node.js)          │
│   Cursor, etc.)  │                           │                      │
└──────────────────┘                           │  - MCP endpoint      │
                                               │  - WebSocket server  │
                                               │  - Session router    │
┌──────────────────┐ ◄──────────────────────►  │  - NO document state │
│   Browser Editor │    WebSocket (JSON)       └──────────────────────┘
│                  │
│  - CodeMirror 6  │    Source of truth for:
│  - MD preview    │    - Document content
│  - Section IDs   │    - Lock state
│  - Lock state    │    - Cursor position
│  - Snapshots     │    - Edit history
│  (IndexedDB)     │    - Section structure
└──────────────────┘
```

Three components, one relay pattern:

**Editor (Browser)** — CodeMirror 6 markdown editor with live rendered preview.
Holds ALL document state. Manages sections, locks, cursor tracking, and the
section-ID registry. This is the single source of truth.

**Relay (Node.js)** — Stateless MCP-to-WebSocket protocol bridge. Receives MCP
tool calls from AI clients, translates them to WebSocket request/response pairs,
forwards to the connected browser tab, returns results. The only state it holds
is session routing: which MCP connection maps to which WebSocket connection.

**AI Client** — Any MCP-capable application. Connects via MCP (stdio for local
dev, SSE for hosted). Sees the document through the tool interface. Receives
proactive notifications when the editor pushes state changes.

### Data flow

Every interaction follows the same path:

```
Agent calls tool ──► Relay receives MCP request
                     Relay sends WebSocket message to browser (with request_id)
                     Browser processes, returns WebSocket response (same request_id)
                     Relay returns MCP tool result to agent
```

For proactive notifications (editor → agent):

```
User acts in editor ──► Browser sends WebSocket notification
                        Relay forwards as MCP notification (SSE) or queues (stdio)
```

---

## Component Specifications

### Project Structure

```
TablaCognita/
├── server/
│   ├── index.js            # Entry point, transport setup (stdio / SSE)
│   ├── tools.js            # MCP tool definitions and handlers
│   ├── relay.js            # WebSocket relay, request/response correlation
│   └── sessions.js         # Session token generation, routing map
├── editor/
│   ├── index.html          # Editor shell
│   ├── app.js              # Editor initialization, UI orchestration
│   ├── sections.js         # Markdown → section tree parser, stable ID assignment
│   ├── locks.js            # Lock state machine, TTL timers, UI indicators
│   ├── ws.js               # WebSocket client, message dispatch
│   ├── gdrive.js           # Google Drive OAuth + export (Phase 5)
│   ├── preview.js          # Markdown rendering (marked/markdown-it)
│   └── styles.css
├── test/
│   ├── mock-browser.js     # Mock WebSocket client with canned responses
│   ├── relay.test.js       # Automated relay round-trip tests
│   └── fixtures/           # Test markdown files, expected responses
├── shared/
│   └── protocol.js         # Message types, error codes, shared constants
├── package.json
└── README.md
```

### Relay Server

**Runtime**: Node.js
**Dependencies**: `@modelcontextprotocol/sdk`, `ws`, `express` (static serving)
**State**: `Map<session_token, WebSocket>` — nothing else.

The relay process does two things:
1. Exposes an MCP endpoint (stdio or SSE, selected at startup)
2. Runs a WebSocket server on the same port as the static file server

When a tool call arrives, it looks up the session token from the MCP connection
context, finds the corresponding WebSocket, sends the request, waits for the
response, and returns it. If no browser is connected: error `NO_EDITOR_CONNECTED`.

### Browser Editor

**Editor engine**: CodeMirror 6 with `@codemirror/lang-markdown`
**Preview**: `marked` (fast, CommonMark-compliant, pluggable)
**Layout**: Split pane — editor left, rendered preview right
**State management**: All state is local to the browser tab:
  - Document content (CodeMirror's EditorState)
  - Section registry (parsed from content on every change)
  - Active locks (Map<section_id, LockInfo>)
  - Edit log (for dirty region tracking)

---

## Contracts

### MCP Tool Definitions

Tools are grouped by purpose. Each definition includes parameters, return
schema, error cases, and side effects.

#### Document State

##### `read_document()`

Read the full document content with line numbers.

```
Parameters: none
Returns: {
  content: string,          // full markdown content
  total_lines: number,
  sections: number,         // count of top-level sections
  has_unsaved_changes: bool // user has unsynced edits
}
Errors: NO_EDITOR_CONNECTED, DOCUMENT_NOT_OPEN
Side effects: none
```

##### `get_structure()`

Get the section outline without full content. Cheap orientation tool for
long documents.

```
Parameters: none
Returns: {
  sections: [
    {
      id: string,           // stable section ID (e.g. "sec_1")
      heading: string,      // current heading text
      level: number,        // 1-6 (h1-h6)
      line_start: number,
      line_end: number,
      locked: bool,         // currently locked?
      locked_by: string?,   // "agent" | "user" | null
      dirty: bool           // user-edited since last agent read?
    }
  ]
}
Errors: NO_EDITOR_CONNECTED, DOCUMENT_NOT_OPEN
Side effects: none
```

##### `get_section(section)`

Read a single section's content by heading text or section ID.

```
Parameters:
  section: string (required) // heading text OR section ID ("sec_1")

Returns: {
  id: string,
  heading: string,
  level: number,
  content: string,           // full text of this section (heading + body)
  line_start: number,
  line_end: number,
  dirty: bool
}
Errors: NO_EDITOR_CONNECTED, DOCUMENT_NOT_OPEN, SECTION_NOT_FOUND
        SECTION_AMBIGUOUS (multiple headings match — returns suggestions)
Side effects: resets dirty flag for this section (agent has now "seen" it)
```

#### Editing

All edit tools auto-lock the target section for the duration of the operation.
The lock is acquired, the edit applied, and the lock released in one atomic
WebSocket round-trip. The editor shows a brief flash indicator ("AI edited
section N") rather than a sustained lock.

##### `replace_section(section, content)`

Replace the full content of a section. The primary editing tool — section-level
granularity is the sweet spot between precision and stability.

```
Parameters:
  section: string (required)       // heading text or section ID
  content: string (required)       // new section body
  keep_heading: bool (default: false) // if true, preserve existing heading line;
                                      // content is treated as body-only

Returns: {
  id: string,
  heading: string,             // heading after replacement
  lines_before: number,
  lines_after: number,
  new_section_ids: string[],   // IDs of any new sections created by headings
                               // within the replacement content
  lock_held_ms: number         // how long the auto-lock was active
}
Errors: NO_EDITOR_CONNECTED, DOCUMENT_NOT_OPEN, SECTION_NOT_FOUND,
        SECTION_AMBIGUOUS, SECTION_LOCKED_BY_USER
Side effects: auto-lock/unlock, editor UI flash indicator
```

When `keep_heading: false` (default), `content` must include the heading line
as the first line — the entire section (heading + body) is replaced. When
`keep_heading: true`, the existing heading is preserved and `content` replaces
only the body below it. This prevents the common agent error of accidentally
deleting or mangling the heading when only the body needs to change.

##### `replace_text(search, replace, options?)`

Targeted string replacement within the document.

```
Parameters:
  search: string (required)       // text to find
  replace: string (required)      // replacement text
  options: {
    fuzzy: bool (default: true),  // tolerate minor whitespace/punctuation diffs
    markdown_aware: bool (default: true), // strip MD formatting before matching
    section: string?,             // limit search to a section (heading or ID)
    occurrence: number?           // which occurrence (default: error if >1)
  }

Returns: {
  matched: string,                // the actual text that was matched (raw MD)
  matched_plain: string,          // the matched text with MD formatting stripped
  section_id: string,             // which section contained the match
  line: number,                   // line number of the match
  fuzzy_applied: bool,            // whether fuzzy matching was used
  markdown_stripped: bool         // whether MD formatting was stripped for match
}
Errors: NO_EDITOR_CONNECTED, DOCUMENT_NOT_OPEN,
        FUZZY_MATCH_FAILED (no match — returns 3 closest candidates),
        FUZZY_MATCH_AMBIGUOUS (multiple matches — returns all with context)
Side effects: auto-lock/unlock of containing section
```

**Fuzzy matching levels** (applied in order, first match wins):
1. **Exact**: literal string match
2. **Whitespace-normalized**: collapse runs of whitespace, trim
3. **Markdown-stripped**: remove `**`, `*`, `` ` ``, `~~`, `[]()` link syntax,
   then match against plaintext. If agent searches for "bold text", it matches
   `**bold text**` in the document. The replacement operates on the RAW markdown
   — the agent's `replace` string should include desired formatting.
4. **Levenshtein**: if `fuzzy: true` AND search is ≥ 20 characters, allow edit
   distance ≤ 15% of search length, with a minimum absolute threshold of 3
   edits. Searches shorter than 20 characters skip this level entirely —
   short strings produce pathological matches (15% of 6 chars < 1 edit,
   15% of 10 chars ≈ 1.5 edits which can match unrelated text).

When `markdown_aware: true` (default), level 3 is attempted before level 4.
When `markdown_aware: false`, only levels 1, 2, and 4 are used.

**Critical**: the replacement always operates on the original markdown text,
not the stripped version. If matching "bold text" against `**bold text**`, the
entire `**bold text**` span is replaced with whatever the agent provides. The
`matched` field in the response shows the raw markdown that was replaced so
the agent can see what formatting was present.

##### `insert_after(section, text)`

Insert content after the end of a section.

```
Parameters:
  section: string (required)  // heading text or section ID
  text: string (required)     // markdown to insert

Returns: {
  inserted_at_line: number,
  new_section_ids: string[]   // IDs of any new sections created by the insert
}
Errors: NO_EDITOR_CONNECTED, DOCUMENT_NOT_OPEN, SECTION_NOT_FOUND
Side effects: auto-lock/unlock, section registry update
```

##### `append(text)`

Append content to the end of the document. Trivially safe — no collision risk.

```
Parameters:
  text: string (required)

Returns: {
  inserted_at_line: number,
  new_section_ids: string[]
}
Errors: NO_EDITOR_CONNECTED, DOCUMENT_NOT_OPEN
Side effects: section registry update
```

##### `write_document(content)`

Full document replacement. Nuclear option. Requires explicit user confirmation
via a dialog in the **browser editor** — the human whose work would be
overwritten makes the call, not the agent.

```
Parameters:
  content: string (required)

Returns: {
  accepted: bool,               // did the user confirm in the browser?
  lines_before: number,
  lines_after: number,
  diff_summary: string          // e.g. "+14 -8 lines across 3 sections"
}
Errors: NO_EDITOR_CONNECTED, DOCUMENT_NOT_OPEN, CONFIRMATION_DENIED,
        CONFIRMATION_TIMEOUT (user didn't respond within 60s)
Side effects:
  1. Editor dims the document and shows a full diff overlay (current left,
     proposed right) with per-line additions/deletions highlighted
  2. An auto-snapshot of the current content is saved to IndexedDB (or Drive
     if connected) BEFORE the user sees the diff — safety net regardless of
     the user's choice
  3. User clicks Accept or Reject:
     - Accept: document replaced via CM6 transaction (undoable per I9),
       all section IDs regenerated, diff overlay closes
     - Reject: no changes, diff overlay closes, agent receives
       CONFIRMATION_DENIED
  4. If no response in 60s: auto-reject, agent receives CONFIRMATION_TIMEOUT
```

The auto-snapshot before confirmation (step 2) means the user is never more
than one click away from recovery, even if they accept and then regret it.
Combined with I9 (Ctrl+Z undoes the replacement), this gives two independent
recovery paths.

#### Collision Avoidance

##### `request_edit_lock(section, ttl?)`

Explicitly lock a section for multi-step operations (read → think → write).
For simple one-shot edits, use the editing tools directly — they auto-lock.

```
Parameters:
  section: string (required)
  ttl: number (optional, default: 30, max: 120) // seconds

Returns: {
  id: string,
  heading: string,
  locked: true,
  ttl: number,
  user_cursor_in_section: bool  // heads up if user is here
}
Errors: NO_EDITOR_CONNECTED, SECTION_NOT_FOUND,
        SECTION_LOCKED_BY_USER (user declined to yield)
Side effects:
  - Editor shows sustained lock indicator on the section
  - If user's cursor is in the section: editor prompts
    "AI wants to edit this section. Move cursor to allow?"
  - User can accept (cursor moves out) or decline (SECTION_LOCKED_BY_USER)
```

##### `release_lock(section)`

Release an explicitly held lock.

```
Parameters:
  section: string (required)  // heading, ID, or "all"

Returns: { released: string[] } // list of section IDs released
Errors: LOCK_NOT_HELD (you didn't hold this lock — maybe it expired)
Side effects: editor removes lock indicator
```

##### `get_cursor_context()`

Where is the user working? Returns the section containing their cursor
and surrounding context.

```
Parameters: none
Returns: {
  section_id: string?,
  section_heading: string?,
  line: number,
  column: number,
  nearby_text: string,         // ~200 chars around cursor
  selection: string?,          // if user has text selected
  idle_seconds: number         // time since last keystroke
}
Errors: NO_EDITOR_CONNECTED
Side effects: none
```

##### `get_dirty_regions()`

What has the user changed since the agent's last read of each section?

```
Parameters: none
Returns: {
  dirty_sections: [
    {
      id: string,
      heading: string,
      lines_changed: number,
      last_edited: timestamp
    }
  ],
  clean_sections: number      // count of unchanged sections
}
Errors: NO_EDITOR_CONNECTED, DOCUMENT_NOT_OPEN
Side effects: none (does NOT reset dirty flags — only get_section does that)
```

##### `poll_context()`

Universal polling fallback for agents on transports that don't support
notifications (stdio). Returns any queued state changes since last poll.

```
Parameters: none
Returns: {
  events: [
    {
      event: string,           // same event names as notifications
      data: object,            // same data shape as notification payloads
      timestamp: ISO-8601
    }
  ],
  cursor: {                    // current cursor state (from browser)
    section_id: string?,       // null if browser disconnected
    line: number?,
    idle_seconds: number?
  } | null,                    // null if browser disconnected
  dirty_count: number?         // null if browser disconnected
}
Errors: none — this tool ALWAYS succeeds. Events are relay-local.
        If browser is disconnected, events are still returned;
        cursor and dirty_count are null.
Side effects: drains the event queue (events are returned once, then discarded)
```

**This is a two-phase operation, not a simple relay forward:**

1. **Phase A (relay-local, no WebSocket):** Drain the session's event queue.
   The relay maintains a bounded queue per session (max 50 events, FIFO
   eviction). Events are queued on all transports — SSE gets push AND queue,
   stdio gets queue only. This phase always succeeds, even if the browser is
   disconnected.

2. **Phase B (WebSocket round-trip to browser):** Fetch current cursor position
   and dirty section count via a lightweight `get_poll_state` WebSocket message.
   This is a single request/response — cheaper than separate `get_cursor_context`
   + `get_dirty_regions` calls. If the browser is disconnected, Phase B is
   skipped and cursor/dirty_count are returned as `null`.

This is the ONLY tool that is not a pure relay forward. Every other tool maps
1:1 to a WebSocket request. `poll_context` is hybrid because the event queue
is relay state (the one exception to I1's "relay holds zero state" — the queue
is ephemeral, not document state, and losing it on relay restart is acceptable).

Agents that want to stay aware can call `poll_context` at natural checkpoints —
before starting a multi-step edit, after completing one, or on any cadence that
suits their workflow.

#### Session & Document Management

##### `open_document(source?)`

Open or create a document.

```
Parameters:
  source: string? // one of:
    - null/empty: new blank document
    - file path: read from local filesystem (local mode only)
    - URL: fetch remote markdown
    - google drive ID: fetch from Drive (Phase 5 — requires Drive auth)

Returns: {
  total_lines: number,
  sections: number,
  source_type: "blank" | "file" | "url" | "drive",
  source_ref: string?
}
Errors: NO_EDITOR_CONNECTED, SOURCE_NOT_FOUND, SOURCE_READ_FAILED,
        DRIVE_NOT_CONNECTED (if drive ID used without auth)
Side effects: replaces current editor content, resets all locks and dirty flags
```

v1 supports: blank, file path, URL. Drive ID support ships in Phase 5.

##### `snapshot(label)`

Create a named checkpoint in browser-local IndexedDB storage.

```
Parameters:
  label: string (required)  // human-readable snapshot name

Returns: {
  storage: "local",          // v1 is always local
  snapshot_id: string,
  timestamp: ISO-8601,
  lines: number
}
Errors: NO_EDITOR_CONNECTED, DOCUMENT_NOT_OPEN
Side effects: saves full document content + section map to IndexedDB
```

Phase 5 extends this: if Drive is connected, snapshots also push to Drive
as named revisions. The return schema adds `storage: "drive"`, `drive_url`,
`revision_id` fields.

##### `get_revision_history()`

List available snapshots.

```
Parameters: none
Returns: {
  revisions: [
    {
      id: string,
      label: string?,
      source: "local",        // Phase 5 adds "drive"
      timestamp: ISO-8601,
      lines: number
    }
  ]
}
Errors: NO_EDITOR_CONNECTED
```

##### `restore_snapshot(snapshot_id)`

Restore a previous snapshot. Triggers the same confirmation flow as
`write_document` (I6) since it replaces the full document.

```
Parameters:
  snapshot_id: string (required)

Returns: {
  accepted: bool,
  lines_restored: number,
  label: string,
  snapshot_timestamp: ISO-8601
}
Errors: NO_EDITOR_CONNECTED, SNAPSHOT_NOT_FOUND, CONFIRMATION_DENIED,
        CONFIRMATION_TIMEOUT
Side effects: same confirmation flow as write_document, auto-snapshot of
              current content before restore
```

### WebSocket Protocol

All messages are JSON. Every request from the relay includes an `id` field.
Responses echo the same `id`. Notifications have no `id`.

#### Message Envelope

```json
// Request (relay → browser)
{
  "id": "req_a1b2c3",
  "type": "replace_section",
  "params": { "section": "Introduction", "content": "# Introduction\n..." }
}

// Response (browser → relay)
{
  "id": "req_a1b2c3",
  "ok": true,
  "data": { "id": "sec_1", "heading": "Introduction", "lines_after": 12 }
}

// Error response (see "Structured error payloads" for full schemas)
{
  "id": "req_a1b2c3",
  "ok": false,
  "error": {
    "code": "SECTION_NOT_FOUND",
    "message": "No section matching 'Intro' found",
    "suggestions": [
      { "id": "sec_1", "heading": "Introduction", "line_start": 1 },
      { "id": "sec_4", "heading": "Getting Started", "line_start": 45 }
    ]
  }
}

// Notification (browser → relay, no request_id)
{
  "type": "notification",
  "event": "cursor_moved",
  "data": { "section_id": "sec_3", "line": 42 }
}

// Notification (browser → relay, user-initiated)
{
  "type": "notification",
  "event": "user_selection",
  "data": {
    "section_id": "sec_2",
    "selected_text": "This paragraph needs work...",
    "instruction": "Make this more concise"
  }
}
```

#### Request types (relay → browser)

One-to-one mapping with MCP tools. The relay translates the MCP tool name and
parameters into the WebSocket request `type` and `params`.

| WebSocket type        | MCP tool              |
|-----------------------|-----------------------|
| `read_document`       | `read_document()`     |
| `get_structure`       | `get_structure()`     |
| `get_section`         | `get_section()`       |
| `replace_section`     | `replace_section()`   |
| `replace_text`        | `replace_text()`      |
| `insert_after`        | `insert_after()`      |
| `append`              | `append()`            |
| `write_document`      | `write_document()`    |
| `request_lock`        | `request_edit_lock()` |
| `release_lock`        | `release_lock()`      |
| `get_cursor`          | `get_cursor_context()`|
| `get_dirty`           | `get_dirty_regions()` |
| `open_document`       | `open_document()`     |
| `snapshot`            | `snapshot()`          |
| `get_revisions`       | `get_revision_history()` |
| `restore_snapshot`    | `restore_snapshot()`  |
| `get_poll_state`      | `poll_context()` *(Phase B only — see note)* |

**Note on `poll_context`**: Unlike every other tool, `poll_context` is NOT a
simple relay forward. Phase A (drain event queue) is handled entirely within
the relay. Only Phase B (cursor + dirty count) triggers a WebSocket request
(`get_poll_state`). If the browser is disconnected, Phase A still succeeds
and Phase B is skipped. See the `poll_context` contract for details.

#### Notification events (browser → relay)

| Event              | When                                     | Forwarded to agent as |
|--------------------|------------------------------------------|-----------------------|
| `cursor_moved`     | User cursor enters a different section   | MCP notification      |
| `section_deleted`  | User deletes a section                   | MCP notification      |
| `section_renamed`  | User changes a heading                   | MCP notification      |
| `user_selection`   | User selects text + clicks "Send to AI"  | MCP notification      |
| `document_changed` | Bulk edit (paste, undo large block)      | MCP notification      |

**Notification throttling**: `cursor_moved` is debounced to 1 per second max.
Other notifications fire immediately.

### Error Codes

| Code                     | Meaning                                         | Agent should...                        |
|--------------------------|--------------------------------------------------|----------------------------------------|
| `NO_EDITOR_CONNECTED`    | No browser tab linked to this session            | Tell user to open the editor           |
| `DOCUMENT_NOT_OPEN`      | Editor is open but no document loaded            | Call `open_document()`                 |
| `SECTION_NOT_FOUND`      | Heading/ID doesn't exist                         | Use `suggestions[].id` directly to retry |
| `SECTION_AMBIGUOUS`      | Multiple sections match the heading text         | Use `matches[].id` to pick the right one |
| `SECTION_LOCKED_BY_USER` | User declined to yield the section               | Work on a different section, ask later |
| `LOCK_NOT_HELD`          | Lock expired or was never acquired               | Re-acquire if needed                   |
| `LOCK_EXPIRED`           | Your lock timed out                              | Re-read section, re-acquire, retry     |
| `FUZZY_MATCH_FAILED`     | No match for search text                         | Check `candidates` field               |
| `FUZZY_MATCH_AMBIGUOUS`  | Multiple matches found                           | Narrow with `section` or `occurrence`  |
| `CONFIRMATION_DENIED`    | User rejected `write_document`                   | Use `replace_section` instead          |
| `CONFIRMATION_TIMEOUT`   | User didn't respond to `write_document` in 60s   | Retry or use `replace_section`         |
| `SOURCE_NOT_FOUND`       | File/URL/Drive ID doesn't exist                  | Check path and retry                   |
| `SNAPSHOT_NOT_FOUND`     | Snapshot ID doesn't exist in IndexedDB            | Call `get_revision_history()` for valid IDs |
| `DRIVE_NOT_CONNECTED`    | Google Drive not authenticated (Phase 5)          | Tell user to connect Drive             |

#### Structured error payloads

Error responses that include recovery hints use structured objects, not string
arrays. This lets agents retry directly from the error without an extra
`get_structure()` round-trip.

```json
// SECTION_NOT_FOUND
{
  "code": "SECTION_NOT_FOUND",
  "message": "No section matching 'Intro' found",
  "suggestions": [
    { "id": "sec_1", "heading": "Introduction", "line_start": 1 },
    { "id": "sec_4", "heading": "Getting Started", "line_start": 45 }
  ]
}

// SECTION_AMBIGUOUS
{
  "code": "SECTION_AMBIGUOUS",
  "message": "2 sections match 'Examples'",
  "matches": [
    { "id": "sec_3", "heading": "Examples", "line_start": 30 },
    { "id": "sec_7", "heading": "Examples", "line_start": 112 }
  ]
}

// FUZZY_MATCH_FAILED
{
  "code": "FUZZY_MATCH_FAILED",
  "message": "No match for 'exmple function'",
  "candidates": [
    { "text": "example function", "section_id": "sec_2", "line": 15, "distance": 1 },
    { "text": "example functions", "section_id": "sec_5", "line": 78, "distance": 2 }
  ]
}

// FUZZY_MATCH_AMBIGUOUS
{
  "code": "FUZZY_MATCH_AMBIGUOUS",
  "message": "3 matches for 'the result'",
  "matches": [
    { "text": "the result", "section_id": "sec_2", "line": 22, "context": "...returns the result of..." },
    { "text": "the result", "section_id": "sec_4", "line": 55, "context": "...compare the result with..." },
    { "text": "the result", "section_id": "sec_6", "line": 89, "context": "...log the result to..." }
  ]
}
```

---

## Invariants

Rules that must hold at all times. Violation of any invariant is a bug.

### I1: Browser is single source of truth
The relay server holds ZERO document state. If the relay process restarts,
no document data is lost — the browser tab still has everything. The agent
reconnects and continues.

One narrow exception: the `poll_context` event queue lives in the relay (it's
ephemeral notification state, not document state). Losing it on relay restart
means the agent misses queued notifications — acceptable, since I7 already
says notifications are best-effort.

### I2: Section IDs are stable across renames
When a user changes a heading from "Introduction" to "Overview", the section
ID (`sec_1`) does not change. The agent can always address sections by ID.
IDs are only regenerated on full document replacement (`write_document`).

### I3: Locks have bounded lifetime
Every lock has a TTL. Auto-locks (from edit tools) last only for the duration
of the WebSocket round-trip. Explicit locks expire after their TTL (default
30s, max 120s). There is no way to create an immortal lock.

### I4: One-to-one session binding
A session token maps to exactly one WebSocket connection (one browser tab) and
exactly one MCP connection (one AI client). The relationship is:

  1 session token = 1 browser tab = 1 MCP client

If a second browser tab connects with the same token, the first is disconnected.
If a second MCP client connects with the same token, the first is disconnected.
There is no multi-agent-per-document support in v1. Multi-agent is a future
extension that would require per-agent lock namespaces and attribution tracking.

### I5: Dirty tracking resets only on targeted read
A section's dirty flag is set when the user edits it. It resets ONLY when
the agent calls `get_section()` for that specific section — meaning the agent
has seen the changes. Calling `read_document()` does NOT reset dirty flags
(too coarse — agent may not process every section).

This is a **one-way ratchet**: there is no "mark unread" operation. If an agent
calls `get_section()` but doesn't meaningfully process the content, the dirty
flag is still cleared. This is a known limitation — the alternative (requiring
explicit acknowledgment) adds protocol complexity for marginal benefit. In
practice, agents that call `get_section` will process the content in the same
tool-use cycle.

### I6: write_document always requires confirmation
There is no flag to bypass the confirmation dialog for full document
replacement. This is a hard constraint, not a default.

### I7: Notifications are fire-and-forget
Editor → agent notifications are best-effort. If the MCP transport doesn't
support notifications (some stdio implementations), they are silently dropped.
No tool behavior depends on the agent having received a notification.

### I8: Auto-lock is atomic with the edit
When `replace_section` auto-locks, the lock acquisition, edit application, and
lock release happen in a single WebSocket request/response. The browser never
shows a sustained lock indicator for auto-locked edits — just a brief flash.
From the user's perspective, the text changed; from the agent's perspective,
the tool call returned.

### I9: Agent edits are undoable
All programmatic edits dispatch as CodeMirror transactions and participate
in the editor's undo history. The browser-side WebSocket handler calls
`view.dispatch()` for every agent edit — never direct state replacement.

### I10: Flat documents have implicit sections
When a document has no markdown headings, the section model still functions.
The editor creates implicit paragraph-level sections using the following
parser rules:

**Boundary**: any run of 2 or more consecutive newlines (`\n\n+`). A single
newline is NOT a boundary (it's a soft break within a paragraph). Whitespace-
only lines (spaces/tabs + newline) count as empty and contribute to a boundary
run.

**ID assignment**: content-hashed. Each paragraph's ID is a short hash of its
initial content at creation time (e.g., `para_a3f2`, `para_9bc1`). This means:
- Inserting a new paragraph between two existing ones does NOT change their IDs
- Editing a paragraph's content does NOT change its ID (hash is set at creation)
- Two paragraphs with identical initial content get a disambiguation suffix
  (`para_a3f2_1`, `para_a3f2_2`) based on document order

**Tradeoff**: content-hashing is more stable than positional indexing on inserts,
but adds complexity for the duplicate-content edge case. The disambiguation
suffix IS positional, so reordering identical paragraphs breaks those specific
IDs — an acceptable edge case for headingless documents.

`get_structure()` returns implicit sections with `level: 0` and `heading: null`
to distinguish them from heading-based sections. Agents working with flat
documents should prefer `replace_text()` over `replace_section()` since string
matching is more robust than section addressing in this mode.

### I11: Stdio-mode agents see more errors by design
Notifications (I7) silently drop on stdio transport. This means stdio agents
never receive `section_deleted`, `section_renamed`, or `cursor_moved` pushes.
They operate with a staler world model and will hit `SECTION_NOT_FOUND` or
`SECTION_AMBIGUOUS` more often than SSE agents.

This is acceptable because error responses include recovery information
(suggestions, current structure). But agent system prompts for stdio mode
should instruct the agent to call `get_structure()` before multi-step editing
sequences, and to handle `SECTION_NOT_FOUND` gracefully by re-reading
structure rather than failing.

---

## Conditionals

Edge cases and their resolution. Format: IF condition THEN behavior.

### Connection lifecycle

**IF** the browser tab closes or navigates away
**THEN** WebSocket disconnects → relay marks session as disconnected → all
subsequent MCP tool calls return `NO_EDITOR_CONNECTED` until a new tab
connects with the same session token.

**IF** the relay server restarts
**THEN** MCP connection and WebSocket both drop. Agent must reconnect via MCP.
Browser auto-reconnects WebSocket (exponential backoff). No data lost (I1).

**IF** the MCP connection drops while the agent holds explicit locks
**THEN** relay detects disconnect → sends WebSocket `release_all_locks` to
browser → all agent locks are released. Lock TTL also covers this, but
immediate release on disconnect is cleaner.

### Lock contention

**IF** agent calls `request_edit_lock(section)` and user's cursor is in that
section
**THEN** browser prompts: "AI wants to edit [section heading]. Finish your
thought?" with Accept (cursor moves to next section) and Decline buttons.
Agent's tool call blocks until user responds or timeout → returns
`SECTION_LOCKED_BY_USER` on decline/timeout.

Lock prompt timeout is configurable in editor settings (default: 15s).
This is a **tuning target** — too short and users feel rushed, too long and
the agent blocks unnecessarily. Expose in editor preferences UI.

**IF** agent calls `replace_section` (auto-lock) and user's cursor is in that
section
**THEN** edit proceeds without prompting. Auto-lock is too brief to conflict.
CodeMirror preserves cursor position across programmatic edits. The user sees
the text change around their cursor — same experience as a collaborator typing.

**IF** agent's explicit lock TTL expires
**THEN** lock is released silently. Agent's next edit tool call on that section
will auto-lock normally. If the agent calls `release_lock` after expiry, it
gets `LOCK_NOT_HELD` — informational, not fatal.

### Section resolution

**IF** agent uses a heading string that matches multiple sections (e.g., two
sections called "Examples")
**THEN** return `SECTION_AMBIGUOUS` with structured `matches` array (see error
payloads). Agent uses `matches[n].id` directly to retry — no extra round-trip.

**IF** agent uses a heading string that matches no sections
**THEN** return `SECTION_NOT_FOUND` with structured `suggestions` array (see
error payloads). Agent uses `suggestions[n].id` directly to retry.

**IF** user renames a heading that the agent previously read
**THEN** section ID is unchanged (I2). Agent can still use the old heading if
it was unambiguous — the editor matches by ID first, heading second. Browser
sends `section_renamed` notification if the transport supports it.

### Editing edge cases

**IF** `replace_text` with `fuzzy: true` finds a match with minor differences
**THEN** proceed with the replacement. Return `fuzzy_applied: true` and the
actual matched text so the agent knows what was replaced.

**IF** `replace_text` with `fuzzy: true` still finds no match
**THEN** return `FUZZY_MATCH_FAILED` with up to 3 closest candidates (Levenshtein
distance) and their line numbers. Agent can adjust search string.

**IF** user is actively typing during an auto-locked edit
**THEN** CodeMirror's transaction system handles this. The programmatic edit
and user keystrokes are applied as separate transactions. If they touch
different regions: both apply cleanly. If they touch the same region: the
programmatic edit lands first (it was dispatched first), user's keystroke
applies on top. This is CodeMirror's native behavior — no custom logic needed.

### Google Drive (Phase 5 — not present in v1)

These conditionals apply only after Phase 5 ships. In v1, snapshots are
always IndexedDB-local and there is no Drive integration.

**IF** user clicks "Open in Google Docs" but hasn't authenticated with Google
**THEN** trigger OAuth2 popup. After auth, proceed with export.

**IF** `snapshot()` is called and Drive IS connected
**THEN** snapshot saves to both IndexedDB (always) and Drive (as a named
revision). Return includes both `snapshot_id` and `drive_url`.

**IF** `snapshot()` is called and Drive is NOT connected
**THEN** snapshot saves to IndexedDB only. Return `storage: "local"`.

**IF** document was opened from a Drive ID
**THEN** `snapshot()` creates a new revision on the same Drive doc (not a new
doc). Revision label is the snapshot label.

**IF** document was created from scratch and Drive is connected
**THEN** first `snapshot()` to Drive creates a new doc. Subsequent snapshots
update that doc. The Drive doc ID is stored for the session.

---

## Build Plan

### Phase 1: Skeleton (the "hello world" of relay)

**Goal**: Prove the three-component relay pattern works end-to-end.

- [ ] `server/index.js` — MCP server (stdio transport) with one tool: `read_document`
- [ ] `server/relay.js` — WebSocket server, request/response correlation via `id`
- [ ] `server/sessions.js` — hardcoded single session (no token management yet)
- [ ] `editor/index.html` — CodeMirror 6 with markdown mode, no preview pane
- [ ] `editor/ws.js` — WebSocket client, responds to `read_document` with editor content
- [ ] `shared/protocol.js` — message type constants, error code enum

- [ ] `server/test/mock-browser.js` — mock WebSocket client that responds to
  relay requests with canned content. Allows automated validation of the relay
  wiring without a real browser in the loop:
  - Connects to relay's WebSocket endpoint with a test session token
  - Responds to `read_document` with a fixture markdown string
  - Logs all received messages for assertion
  - Can be driven by a simple test script (`node test/relay.test.js`)

**Validation**: Two levels:
1. Automated: run `mock-browser.js` + test script that calls MCP tools via
   the SDK client and asserts responses match fixtures
2. Manual: open real editor in browser, connect Claude Desktop via MCP config,
   call `read_document`, see editor content returned

**Exit criteria**: Automated test passes — tool call → WebSocket → mock browser
→ WebSocket → tool result, round-trip verified without manual intervention.

### Phase 2: Core Tools

**Goal**: Full read/write toolset, section-aware addressing.

- [ ] `editor/sections.js` — markdown parser that extracts heading tree, assigns
  stable IDs (hash of initial heading + creation order), updates on every
  CodeMirror change
- [ ] Add all document state tools: `get_structure`, `get_section`
- [ ] Add all editing tools: `replace_section`, `replace_text`, `insert_after`,
  `append`, `write_document`
- [ ] `write_document` confirmation UI: diff view overlay, accept/reject buttons
- [ ] Dirty region tracking: per-section edit log, reset on `get_section` read
- [ ] Fuzzy matching for `replace_text`: 4-level cascade (exact → whitespace-
  normalized → markdown-stripped → Levenshtein). See replace_text contract.
- [ ] `snapshot(label)` — IndexedDB storage, auto-snapshot before `write_document`
- [ ] `restore_snapshot(id)` — restores with confirmation flow (reuses
  `write_document` diff overlay)
- [ ] `get_revision_history()` — list IndexedDB snapshots

**Validation**: Claude can read structure, read a section, replace it, insert
after it, and append. Dirty flags track correctly. Fuzzy replace finds targets
through markdown formatting (`**bold**` matched by "bold"). `write_document`
shows diff, blocks on confirmation, and auto-snapshots before applying.
Snapshots can be listed and restored.

### Phase 3: Collision Avoidance

**Goal**: Intent signaling system — locks, cursor awareness, dirty regions.

- [ ] `editor/locks.js` — lock state machine: acquire, hold with TTL, release,
  auto-release on timeout
- [ ] Lock UI indicators: subtle highlight on locked sections, "AI editing..."
  badge
- [ ] Auto-lock wiring: edit tools acquire/release within the WebSocket handler
- [ ] Explicit lock flow: `request_edit_lock` with cursor-conflict prompting
- [ ] `get_cursor_context` — report cursor section, position, idle time, selection
- [ ] `get_dirty_regions` — report sections with unread user edits
- [ ] Flash indicator on auto-locked edits ("AI edited Introduction")

**Validation**: Lock a section, see the UI indicator. Let TTL expire, confirm
release. Request lock on section where cursor is, see prompt. Edit via
`replace_section`, see brief flash. Check dirty regions after typing.

**Tuning target**: CM6 transaction collision feel. When the agent's `replace_section`
lands while the user is typing in an adjacent section, the visual experience
needs playtesting. CM6 handles the state correctly, but does the cursor jump?
Does the scroll position shift? Does the flash indicator feel right at 200ms vs
500ms? These are UX questions that can only be answered by using it. Budget time
for iteration here.

### Phase 4: Bidirectional Signals

**Goal**: Editor pushes state to the agent proactively.

- [ ] MCP notification support in the relay (SSE transport sends notifications;
  stdio transport drops them — I7)
- [ ] `cursor_moved` notification with debouncing (1/sec)
- [ ] `section_deleted`, `section_renamed` notifications
- [ ] `document_changed` notification for bulk edits
- [ ] **"Send to AI" button**: user selects text, clicks button, editor sends
  `user_selection` notification with selected text + optional instruction input
- [ ] Relay → agent notification forwarding
- [ ] `poll_context` tool — bounded event queue (max 50, FIFO eviction) in relay,
  drained on poll. Works on all transports. Bundles cursor + dirty count to
  reduce round-trips for stdio agents.
- [ ] Event queue wiring: all notification events are always queued regardless
  of transport. SSE gets push AND queue. Stdio gets queue only.

**Validation**: Move cursor between sections, observe notifications on SSE.
On stdio, call `poll_context`, see queued events. Select text, click "Send
to AI", see it arrive via both notification (SSE) and poll (stdio). Delete a
section, confirm event appears in queue.

### Phase 5: Google Drive Integration

**Goal**: Connect to Google Drive for export, cloud snapshots, and import.

- [ ] `editor/gdrive.js` — Google OAuth2 popup flow, token storage in
  localStorage
- [ ] "Open in Google Docs" button: MD → HTML → Drive API upload with
  `mimeType: 'application/vnd.google-apps.document'` (native conversion)
- [ ] Extend `snapshot()`: when Drive is connected, push to Drive as named
  revision in addition to IndexedDB. Return `drive_url` in response.
- [ ] Extend `get_revision_history()`: merge Drive revisions + local snapshots
  into unified list, deduplicated by timestamp
- [ ] `open_document(drive_id)` — fetch from Drive, load into editor
- [ ] Drive connection status indicator in editor chrome

**Validation**: OAuth flow completes. Click export, see new Google Doc with
formatted content. Snapshot with Drive connected, verify revision appears in
both IndexedDB and Drive. Open from Drive ID, edit, snapshot back.

### Phase 6: Production Polish

**Goal**: Multi-session support, hosted deployment, UX polish.

- [ ] Session token system: editor URL includes token, relay routes by token
- [ ] SSE transport option for MCP (hosted mode)
- [ ] Session management UI: display session status, connected agent info
- [ ] Editor theming (light/dark, configurable)
- [ ] Preview pane rendering with scroll sync
- [ ] Error recovery: WebSocket auto-reconnect, stale session handling
- [ ] Rate limiting on MCP tool calls (prevent runaway agents)
- [ ] Session token security: cryptographically random tokens, expiration,
  rate limiting per token. v1 local-only with hardcoded session doesn't need
  this — but hosted deployment does. Tokens in URLs should be short-lived
  or exchanged for session cookies after initial connect.
- [ ] Deploy: relay on Fly.io / Railway, editor static on CDN, MCP endpoint
  on relay URL

---

## Commentary

### Why this works

The relay-not-storage architecture sidesteps the hardest problems in
collaborative editing. You don't need CRDT because there's one source of truth
(the browser). You don't need a database because the document lives in
CodeMirror's state tree. You don't need auth for document ownership because
the session token scopes everything.

The intent signaling system (locks + cursor awareness + dirty tracking) gives
you the *feeling* of real-time collaboration without the complexity. It works
because of the fundamental asymmetry: agents make discrete, bounded edits;
humans type continuously. The lock pattern makes agent edits visible; the
dirty region tracking prevents agents from overwriting unseen human edits.

### The "Send to AI" feature is the killer differentiator

Every other AI writing tool makes you describe what you want in a chat box
disconnected from the document. "Send to AI" inverts this: you select the
text, provide a brief instruction, and the agent receives both the selection
and the context. The editor becomes an input surface for the agent, not just
an output surface.

This is the UX moment that makes it feel like co-writing rather than
copy-paste-between-windows.

### Section-based addressing is the right primitive

Line numbers shift on every edit. Character offsets are fragile. JSON paths
are for structured data, not prose. Headings are how humans already organize
documents, and they're stable across edits to other sections. The stable ID
system (I2) gives agents a reliable addressing scheme even when headings
change.

The one limitation: unstructured documents with no headings. Handled by I10:
the editor creates implicit paragraph-level sections with content-hashed IDs
(`para_a3f2`, etc). Less stable than heading-based sections, but functional.
Agents should prefer `replace_text()` over section addressing in flat docs.

### Google Docs as complement, not competition

The editor doesn't try to be Google Docs. It's a focused co-writing surface
with AI participation as the core design principle. The "Open in Google Docs"
button is an explicit exit ramp: once you and the AI have drafted something,
push it to Docs for formatting, sharing, commenting — the things Google Docs
is built for.

This positions TablaCognita as the drafting/creation tool and Google Docs as the
publishing/collaboration tool. Different stages of the writing lifecycle,
not competing products.

### Hosting economics

The relay server is stateless and lightweight. It holds open WebSocket
connections and MCP sessions, but processes no compute-heavy work. A single
$5/month VPS handles hundreds of concurrent sessions. The expensive part
(LLM inference) is on the AI client side, not yours.

Storage cost is zero (no backend storage). Google Drive API calls are free
up to reasonable limits. The only scaling concern is WebSocket connection
count, which is solved by horizontal scaling with sticky sessions.

### What this doesn't solve (and shouldn't try to)

- **Multi-human collaboration**: Out of scope. One human, one AI agent per
  session (I4). If you want multiple humans, use Google Docs.
- **Multi-agent**: Out of scope for v1. One agent per session. Multi-agent
  would require per-agent lock namespaces, edit attribution, and conflict
  resolution between agents — significant complexity for marginal v1 value.
- **Offline editing**: Requires a WebSocket connection for AI participation.
  The editor itself works offline (it's a browser app), but the AI tools
  are unavailable.
- **Version control**: Snapshots are manual checkpoints, not git. For
  version-controlled writing, use a proper git workflow with .md files.
- **Rich formatting**: Markdown only. No WYSIWYG, no embedded spreadsheets,
  no drawing tools. Markdown is the right format for AI co-writing because
  it's plain text that both humans and agents can read and write natively.
