// TablaCognita — MCP tool definitions and handlers
// Each tool maps to a WebSocket request type via the relay.

import { ToolToRequest, RequestType, ErrorCode, makeError } from '../shared/protocol.js';

// Phase 1: read_document only
// Phase 2: adds get_structure, get_section, replace_section, replace_text,
//          insert_after, append, write_document, open_document, snapshot,
//          get_revision_history, restore_snapshot
// Phase 3: adds request_edit_lock, release_lock, get_cursor_context, get_dirty_regions
// Phase 4: adds poll_context

export function getToolDefinitions() {
  return [
    // === Document State ===
    {
      name: 'read_document',
      description: 'Read the full document content with line numbers.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'get_structure',
      description: 'Get the section outline without full content. Cheap orientation tool for long documents.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'get_section',
      description: 'Read a single section by heading text or section ID. Resets dirty flag for that section.',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', description: 'Heading text or section ID (e.g. "sec_1")' },
        },
        required: ['section'],
      },
    },

    // === Editing ===
    {
      name: 'replace_section',
      description: 'Replace the full content of a section. Auto-locks during the operation.',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', description: 'Heading text or section ID' },
          content: { type: 'string', description: 'New section content (include heading line unless keep_heading is true)' },
          keep_heading: { type: 'boolean', description: 'If true, preserve existing heading; content is body-only', default: false },
        },
        required: ['section', 'content'],
      },
    },
    {
      name: 'replace_text',
      description: 'Targeted string replacement with fuzzy matching support.',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Text to find' },
          replace: { type: 'string', description: 'Replacement text' },
          options: {
            type: 'object',
            properties: {
              fuzzy: { type: 'boolean', default: true },
              markdown_aware: { type: 'boolean', default: true },
              section: { type: 'string', description: 'Limit search to a section' },
              occurrence: { type: 'number', description: 'Which occurrence (default: error if >1)' },
            },
          },
        },
        required: ['search', 'replace'],
      },
    },
    {
      name: 'insert_after',
      description: 'Insert content after the end of a section.',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', description: 'Heading text or section ID' },
          text: { type: 'string', description: 'Markdown to insert' },
        },
        required: ['section', 'text'],
      },
    },
    {
      name: 'append',
      description: 'Append content to the end of the document.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Markdown to append' },
        },
        required: ['text'],
      },
    },
    {
      name: 'write_document',
      description: 'Full document replacement. Requires user confirmation in the browser editor.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Complete new document content' },
        },
        required: ['content'],
      },
    },

    // === Session & Document Management ===
    {
      name: 'open_document',
      description: 'Open or create a document. Supports blank, file path, or URL.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'File path, URL, or empty for blank document' },
        },
        required: [],
      },
    },
    {
      name: 'snapshot',
      description: 'Create a named checkpoint saved to browser-local IndexedDB storage.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Human-readable snapshot name' },
        },
        required: ['label'],
      },
    },
    {
      name: 'get_revision_history',
      description: 'List available snapshots.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'restore_snapshot',
      description: 'Restore a previous snapshot. Triggers confirmation flow.',
      inputSchema: {
        type: 'object',
        properties: {
          snapshot_id: { type: 'string', description: 'Snapshot ID to restore' },
        },
        required: ['snapshot_id'],
      },
    },

    // === Collision Avoidance (Phase 3) ===
    {
      name: 'request_edit_lock',
      description: 'Explicitly lock a section for multi-step operations.',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', description: 'Heading text or section ID' },
          ttl: { type: 'number', description: 'Lock TTL in seconds (default 30, max 120)' },
        },
        required: ['section'],
      },
    },
    {
      name: 'release_lock',
      description: 'Release an explicitly held lock.',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', description: 'Heading text, section ID, or "all"' },
        },
        required: ['section'],
      },
    },
    {
      name: 'get_cursor_context',
      description: 'Get the section containing the user\'s cursor and surrounding context.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'get_dirty_regions',
      description: 'Get sections the user has changed since the agent last read them.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },

    // === Bidirectional (Phase 4) ===
    {
      name: 'poll_context',
      description: 'Poll for queued state changes. Works on all transports.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ];
}

// Create the tool handler function
export function createToolHandler(relay, sessionToken) {
  return async (toolName, args) => {
    // Special case: poll_context is hybrid (relay-local + WebSocket)
    if (toolName === 'poll_context') {
      return handlePollContext(relay, sessionToken);
    }

    // All other tools: relay to browser
    const requestType = ToolToRequest[toolName];
    if (!requestType) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: makeError(ErrorCode.INVALID_REQUEST, `Unknown tool: ${toolName}`) }) }],
        isError: true,
      };
    }

    const response = await relay.sendRequest(sessionToken, requestType, args);

    if (response.ok === false) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: response.error }) }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(response.data) }],
    };
  };
}

// poll_context: Phase A (drain queue) + Phase B (get cursor/dirty from browser)
async function handlePollContext(relay, sessionToken) {
  // Phase A: drain event queue (relay-local, always succeeds)
  const events = relay.sessions.drainEvents(sessionToken);

  // Phase B: get current cursor + dirty count from browser
  let cursor = null;
  let dirtyCount = null;

  if (relay.sessions.hasEditor(sessionToken)) {
    const response = await relay.sendRequest(sessionToken, RequestType.GET_POLL_STATE, {});
    if (response.ok) {
      cursor = response.data.cursor || null;
      dirtyCount = response.data.dirty_count ?? null;
    }
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ events, cursor, dirty_count: dirtyCount }),
    }],
  };
}
