// TablaCognita — Fuzzy text matching and replacement
// Implements the 4-level matching cascade from the DESIGN.md spec.

import { parseSections, findSection } from './sections.js';

/**
 * Perform fuzzy search and replace in document content.
 * 4-level cascade: exact → whitespace-normalized → markdown-stripped → Levenshtein
 *
 * @param {string} content - Full document content
 * @param {string} search - Text to find
 * @param {string} replace - Replacement text
 * @param {object} options - { fuzzy, markdown_aware, section, occurrence }
 * @returns {{ newContent, data } | { error }} Result or error
 */
export function fuzzyReplace(content, search, replace, options = {}) {
  const { fuzzy = true, markdown_aware = true, section: sectionQuery, occurrence } = options;
  let searchIn = content;
  let offset = 0;

  // Scope to section if specified
  if (sectionQuery) {
    const allSections = parseSections(content);
    const section = findSection(allSections, sectionQuery);
    if (!section) {
      return { error: {
        code: 'SECTION_NOT_FOUND',
        message: `No section matching '${sectionQuery}'`,
        suggestions: allSections.slice(0, 3).map(s => ({ id: s.id, heading: s.heading, line_start: s.line_start })),
      }};
    }
    const lines = content.split('\n');
    searchIn = lines.slice(section.line_start - 1, section.line_end).join('\n');
    offset = lines.slice(0, section.line_start - 1).join('\n').length + (section.line_start > 1 ? 1 : 0);
  }

  // Level 1: Exact match
  let matches = findAllOccurrences(searchIn, search);
  if (matches.length > 0) {
    return applyReplace(content, matches, search, replace, offset, occurrence, false, false);
  }

  // Level 2: Whitespace-normalized
  matches = findOccurrencesNormalized(searchIn, search);
  if (matches.length > 0) {
    return applyReplace(content, matches, search, replace, offset, occurrence, false, false);
  }

  // Level 3: Markdown-stripped (if enabled)
  if (markdown_aware) {
    matches = findOccurrencesMarkdownAware(searchIn, search);
    if (matches.length > 0) {
      return applyReplace(content, matches, search, replace, offset, occurrence, false, true);
    }
  }

  // Level 4: Levenshtein (if fuzzy and search >= 20 chars)
  if (fuzzy && search.length >= 20) {
    const maxDist = Math.max(3, Math.floor(search.length * 0.15));
    matches = findFuzzyMatches(searchIn, search, maxDist);
    if (matches.length > 0) {
      return applyReplace(content, matches, search, replace, offset, occurrence, true, false);
    }
  }

  // No match at any level
  return {
    error: {
      code: 'FUZZY_MATCH_FAILED',
      message: `No match for '${search.slice(0, 50)}${search.length > 50 ? '...' : ''}'`,
      candidates: [],
    },
  };
}

// --- Level 1: Exact ---
export function findAllOccurrences(text, search) {
  const results = [];
  let idx = text.indexOf(search);
  while (idx !== -1) {
    results.push({ start: idx, end: idx + search.length, matched: search });
    idx = text.indexOf(search, idx + 1);
  }
  return results;
}

// --- Level 2: Whitespace-normalized ---
export function normalizeWhitespace(str) {
  return str.replace(/\s+/g, ' ').trim();
}

export function findOccurrencesNormalized(text, search) {
  const normSearch = normalizeWhitespace(search);
  const normText = normalizeWhitespace(text);
  const results = [];

  let idx = normText.indexOf(normSearch);
  while (idx !== -1) {
    const origStart = mapNormalizedToOriginal(text, idx);
    const origEnd = mapNormalizedToOriginal(text, idx + normSearch.length);
    results.push({
      start: origStart,
      end: origEnd,
      matched: text.slice(origStart, origEnd),
    });
    idx = normText.indexOf(normSearch, idx + 1);
  }
  return results;
}

function mapNormalizedToOriginal(original, normalizedPos) {
  let origIdx = 0;
  let normIdx = 0;
  let inWhitespace = false;

  // Skip leading whitespace mapping
  while (origIdx < original.length && /\s/.test(original[origIdx])) {
    origIdx++;
  }

  while (normIdx < normalizedPos && origIdx < original.length) {
    if (/\s/.test(original[origIdx])) {
      if (!inWhitespace) {
        normIdx++; // single space in normalized
        inWhitespace = true;
      }
      origIdx++;
    } else {
      inWhitespace = false;
      normIdx++;
      origIdx++;
    }
  }
  return origIdx;
}

// --- Level 3: Markdown-stripped ---
export function stripMarkdown(str) {
  return str
    .replace(/\*\*(.+?)\*\*/g, '$1')   // bold
    .replace(/\*(.+?)\*/g, '$1')        // italic
    .replace(/~~(.+?)~~/g, '$1')        // strikethrough
    .replace(/`(.+?)`/g, '$1')          // inline code
    .replace(/\[(.+?)\]\(.+?\)/g, '$1'); // links
}

export function findOccurrencesMarkdownAware(text, search) {
  const strippedSearch = stripMarkdown(search);
  // Build character maps from stripped positions → raw positions
  const { stripped, spanStart, spanEnd } = buildStrippedMap(text);
  const results = [];

  let idx = stripped.indexOf(strippedSearch);
  while (idx !== -1) {
    const firstCharIdx = idx;
    const lastCharIdx = idx + strippedSearch.length - 1;

    // Expand to include enclosing formatting markers
    const rawStart = spanStart[firstCharIdx];
    const rawEnd = lastCharIdx < spanEnd.length ? spanEnd[lastCharIdx] : text.length;

    results.push({
      start: rawStart,
      end: rawEnd,
      matched: text.slice(rawStart, rawEnd),
    });
    idx = stripped.indexOf(strippedSearch, idx + 1);
  }
  return results;
}

/**
 * Build character-level maps from stripped text positions to raw text positions.
 * Returns:
 *   stripped: the stripped text string
 *   map[i]: raw index where stripped char i sits in raw text
 *   spanStart[i]: raw index where the enclosing formatting span starts (e.g., the opening **)
 *   spanEnd[i]: raw index AFTER the enclosing formatting span ends (e.g., after closing **)
 *
 * For a match spanning stripped[a..b], the raw match is rawText[spanStart[a]..spanEnd[b]].
 */
function buildStrippedMap(rawText) {
  const map = [];       // map[strippedCharIdx] = rawCharIdx
  const spanStart = []; // spanStart[strippedCharIdx] = raw start of enclosing span
  const spanEnd = [];   // spanEnd[strippedCharIdx] = raw end of enclosing span (exclusive)
  let i = 0;

  while (i < rawText.length) {
    // ** bold ** — must check before single *
    if (rawText[i] === '*' && rawText[i+1] === '*') {
      const end = rawText.indexOf('**', i + 2);
      if (end !== -1) {
        const sStart = i;
        const sEnd = end + 2;
        for (let j = i + 2; j < end; j++) {
          map.push(j);
          spanStart.push(sStart);
          spanEnd.push(sEnd);
        }
        i = sEnd;
        continue;
      }
    }
    // * italic *
    if (rawText[i] === '*') {
      const end = findClosingSingle(rawText, '*', i + 1);
      if (end !== -1) {
        const sStart = i;
        const sEnd = end + 1;
        for (let j = i + 1; j < end; j++) {
          map.push(j);
          spanStart.push(sStart);
          spanEnd.push(sEnd);
        }
        i = sEnd;
        continue;
      }
    }
    // ~~ strikethrough ~~
    if (rawText[i] === '~' && rawText[i+1] === '~') {
      const end = rawText.indexOf('~~', i + 2);
      if (end !== -1) {
        const sStart = i;
        const sEnd = end + 2;
        for (let j = i + 2; j < end; j++) {
          map.push(j);
          spanStart.push(sStart);
          spanEnd.push(sEnd);
        }
        i = sEnd;
        continue;
      }
    }
    // ` inline code `
    if (rawText[i] === '`') {
      const end = rawText.indexOf('`', i + 1);
      if (end !== -1) {
        const sStart = i;
        const sEnd = end + 1;
        for (let j = i + 1; j < end; j++) {
          map.push(j);
          spanStart.push(sStart);
          spanEnd.push(sEnd);
        }
        i = sEnd;
        continue;
      }
    }
    // [text](url) links
    if (rawText[i] === '[') {
      const closeBracket = rawText.indexOf('](', i + 1);
      if (closeBracket !== -1) {
        const closeParen = rawText.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const sStart = i;
          const sEnd = closeParen + 1;
          for (let j = i + 1; j < closeBracket; j++) {
            map.push(j);
            spanStart.push(sStart);
            spanEnd.push(sEnd);
          }
          i = sEnd;
          continue;
        }
      }
    }
    // Regular character — span is just itself
    map.push(i);
    spanStart.push(i);
    spanEnd.push(i + 1);
    i++;
  }

  const stripped = map.map(idx => rawText[idx]).join('');
  return { stripped, map, spanStart, spanEnd };
}

/**
 * Find closing single marker that isn't part of a double marker.
 */
function findClosingSingle(text, char, startIdx) {
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === char) {
      // Make sure this isn't part of ** (for *)
      if (char === '*' && text[i+1] === '*') continue;
      if (char === '*' && i > 0 && text[i-1] === '*') continue;
      return i;
    }
  }
  return -1;
}

// --- Level 4: Levenshtein ---
export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization for memory efficiency
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i-1] === b[j-1]
        ? prev[j-1]
        : 1 + Math.min(prev[j], curr[j-1], prev[j-1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export function findFuzzyMatches(text, search, maxDist) {
  const results = [];
  const searchLen = search.length;
  const step = Math.max(1, Math.floor(searchLen / 4));

  for (let i = 0; i <= text.length - searchLen + maxDist; i += step) {
    // Check candidates of varying lengths to handle insertions/deletions
    let bestDist = Infinity;
    let bestLen = searchLen;

    for (let len = searchLen - maxDist; len <= searchLen + maxDist; len++) {
      if (i + len > text.length || len <= 0) continue;
      const candidate = text.slice(i, i + len);
      const dist = levenshtein(search, candidate);
      if (dist < bestDist) {
        bestDist = dist;
        bestLen = len;
      }
    }

    if (bestDist <= maxDist) {
      results.push({
        start: i,
        end: i + bestLen,
        matched: text.slice(i, i + bestLen),
        distance: bestDist,
      });
      // Skip ahead to avoid overlapping matches
      i += bestLen - step;
    }
  }
  return results;
}

// --- Apply replacement ---
function applyReplace(content, matches, search, replace, offset, occurrence, fuzzyApplied, markdownStripped) {
  if (matches.length > 1 && occurrence === undefined) {
    return {
      error: {
        code: 'FUZZY_MATCH_AMBIGUOUS',
        message: `${matches.length} matches for '${search.slice(0, 50)}'`,
        matches: matches.map(m => {
          const absStart = offset + m.start;
          const line = content.slice(0, absStart).split('\n').length;
          const allSections = parseSections(content);
          const sec = allSections.find(s => s.line_start <= line && s.line_end >= line);
          return {
            text: m.matched,
            section_id: sec?.id || null,
            line,
            context: content.slice(Math.max(0, absStart - 30), offset + m.end + 30),
          };
        }),
      },
    };
  }

  const matchIdx = (occurrence !== undefined) ? occurrence - 1 : 0;
  if (matchIdx < 0 || matchIdx >= matches.length) {
    return {
      error: {
        code: 'FUZZY_MATCH_FAILED',
        message: `Occurrence ${occurrence} not found (only ${matches.length} matches)`,
        candidates: [],
      },
    };
  }

  const match = matches[matchIdx];
  const absStart = offset + match.start;
  const absEnd = offset + match.end;
  const newContent = content.slice(0, absStart) + replace + content.slice(absEnd);
  const line = content.slice(0, absStart).split('\n').length;
  const allSections = parseSections(content);
  const sec = allSections.find(s => s.line_start <= line && s.line_end >= line);

  return {
    newContent,
    data: {
      matched: match.matched,
      matched_plain: stripMarkdown(match.matched),
      section_id: sec?.id || null,
      line,
      fuzzy_applied: fuzzyApplied,
      markdown_stripped: markdownStripped,
    },
  };
}
