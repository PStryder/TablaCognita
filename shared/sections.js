// TablaCognita — Section parser and utilities
// Shared between editor (browser) and tests (Node.js).

/**
 * Parse markdown content into a section tree.
 * Handles both heading-based and headingless (paragraph) documents.
 *
 * @param {string} content - Full markdown document content
 * @param {Map} [dirtyMap] - Optional dirty tracking map (section_id → bool)
 * @returns {Array} Section objects
 */
export function parseSections(content, dirtyMap = new Map()) {
  const lines = content.split('\n');
  const sections = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      if (current) {
        current.line_end = i; // 0-indexed end → this is the line BEFORE the new heading
        sections.push(current);
      }
      const level = match[1].length;
      const heading = match[2].trim();
      const id = `sec_${sections.length + 1}`;
      current = {
        id,
        heading,
        level,
        line_start: i + 1, // 1-indexed
        line_end: lines.length, // default to end, adjusted when next section found
        locked: false,
        locked_by: null,
        dirty: dirtyMap.get(id) || false,
      };
    }
  }

  if (current) {
    current.line_end = lines.length;
    sections.push(current);
  }

  // I10: Headingless documents → implicit paragraph sections
  if (sections.length === 0 && content.trim()) {
    const paragraphs = content.split(/\n{2,}/);
    let lineOffset = 1;
    for (const para of paragraphs) {
      if (!para.trim()) { lineOffset += 1; continue; }
      const paraLines = para.split('\n').length;
      const hash = simpleHash(para.trim()).toString(36).slice(0, 4);
      const id = `para_${hash}`;
      sections.push({
        id,
        heading: null,
        level: 0,
        line_start: lineOffset,
        line_end: lineOffset + paraLines - 1,
        locked: false,
        locked_by: null,
        dirty: dirtyMap.get(id) || false,
      });
      lineOffset += paraLines + 1; // +1 for blank line separator
    }
  }

  return sections;
}

/**
 * Find a section by heading text or section ID.
 * Throws structured errors for ambiguous/not-found cases.
 */
export function findSection(sections, query) {
  // ID match first (most specific)
  const byId = sections.find(s => s.id === query);
  if (byId) return byId;

  // Exact heading match
  const byHeading = sections.filter(s => s.heading === query);
  if (byHeading.length === 1) return byHeading[0];
  if (byHeading.length > 1) {
    throw {
      code: 'SECTION_AMBIGUOUS',
      message: `${byHeading.length} sections match '${query}'`,
      matches: byHeading.map(s => ({ id: s.id, heading: s.heading, line_start: s.line_start })),
    };
  }

  // Case-insensitive heading match
  const byHeadingCI = sections.filter(s => s.heading?.toLowerCase() === query.toLowerCase());
  if (byHeadingCI.length === 1) return byHeadingCI[0];
  if (byHeadingCI.length > 1) {
    throw {
      code: 'SECTION_AMBIGUOUS',
      message: `${byHeadingCI.length} sections match '${query}' (case-insensitive)`,
      matches: byHeadingCI.map(s => ({ id: s.id, heading: s.heading, line_start: s.line_start })),
    };
  }

  return null;
}

/**
 * Count top-level (h1) sections in content.
 */
export function countTopLevelSections(content) {
  return (content.match(/^# .+$/gm) || []).length;
}

/**
 * Get section content (the text within a section's line range).
 */
export function getSectionContent(content, section) {
  const lines = content.split('\n');
  return lines.slice(section.line_start - 1, section.line_end).join('\n');
}

/**
 * Replace a section's content in the document.
 * Returns the new full document content and metadata.
 */
export function replaceSection(content, section, newSectionContent, keepHeading = false) {
  const lines = content.split('\n');
  const before = lines.slice(0, section.line_start - 1);
  const after = lines.slice(section.line_end);

  let newContent;
  if (keepHeading) {
    const headingLine = lines[section.line_start - 1];
    newContent = [...before, headingLine, newSectionContent, ...after].join('\n');
  } else {
    newContent = [...before, newSectionContent, ...after].join('\n');
  }

  return newContent;
}

/**
 * Insert text after a section.
 */
export function insertAfterSection(content, section, text) {
  const lines = content.split('\n');
  const before = lines.slice(0, section.line_end);
  const after = lines.slice(section.line_end);
  return [...before, text, ...after].join('\n');
}

/**
 * Simple hash for content-based IDs (I10).
 */
export function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Stable section ID registry (I2).
 * Maintains a mapping from stable IDs to section metadata.
 * Call reconcile() after each reparse to update positions while preserving IDs.
 *
 * 3-pass matching:
 *   Pass 1: Exact heading + closest position → keep existing ID
 *   Pass 2: Position-based ±5 lines at same level → keep ID (handles renames)
 *   Pass 3: New ID for unmatched sections (hash of heading + monotonic counter)
 */
export class SectionRegistry {
  constructor() {
    this.entries = new Map(); // stableId → { heading, level, line_start }
    this.counter = 0;
  }

  /**
   * Generate a new unique section ID.
   */
  _newId(heading, level) {
    this.counter++;
    if (level === 0) {
      return `para_${this.counter}`;
    }
    const hash = simpleHash(heading || '').toString(36).slice(0, 4);
    return `sec_${hash}_${this.counter}`;
  }

  /**
   * Reconcile freshly parsed sections with existing registry entries.
   * Returns new section array with stable IDs assigned.
   */
  reconcile(rawSections) {
    const usedIds = new Set();
    const assignments = new Array(rawSections.length).fill(null);

    // Pass 1: Exact heading match (closest position wins)
    for (let i = 0; i < rawSections.length; i++) {
      const raw = rawSections[i];
      if (raw.heading === null) continue;
      let bestId = null;
      let bestDist = Infinity;
      for (const [id, entry] of this.entries) {
        if (usedIds.has(id)) continue;
        if (entry.heading === raw.heading && entry.level === raw.level) {
          const dist = Math.abs(entry.line_start - raw.line_start);
          if (dist < bestDist) {
            bestDist = dist;
            bestId = id;
          }
        }
      }
      if (bestId) {
        usedIds.add(bestId);
        assignments[i] = bestId;
      }
    }

    // Pass 2: Position-based match for renamed/moved sections (±5 lines, same level)
    for (let i = 0; i < rawSections.length; i++) {
      if (assignments[i]) continue;
      const raw = rawSections[i];
      let bestId = null;
      let bestDist = Infinity;
      for (const [id, entry] of this.entries) {
        if (usedIds.has(id)) continue;
        if (entry.level !== raw.level) continue;
        const dist = Math.abs(entry.line_start - raw.line_start);
        if (dist <= 5 && dist < bestDist) {
          bestDist = dist;
          bestId = id;
        }
      }
      if (bestId) {
        usedIds.add(bestId);
        assignments[i] = bestId;
      }
    }

    // Pass 3: New IDs for unmatched sections
    for (let i = 0; i < rawSections.length; i++) {
      if (!assignments[i]) {
        assignments[i] = this._newId(rawSections[i].heading, rawSections[i].level);
      }
    }

    // Rebuild registry and return sections with stable IDs
    this.entries.clear();
    return rawSections.map((raw, i) => {
      const id = assignments[i];
      this.entries.set(id, {
        heading: raw.heading,
        level: raw.level,
        line_start: raw.line_start,
      });
      return { ...raw, id };
    });
  }

  /**
   * Reset registry (for write_document / open_document).
   * Counter is NOT reset to prevent ID reuse across resets.
   */
  reset() {
    this.entries.clear();
  }
}
