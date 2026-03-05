// TablaCognita — Section parser unit tests

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSections,
  findSection,
  countTopLevelSections,
  getSectionContent,
  replaceSection,
  insertAfterSection,
  simpleHash,
} from '../shared/sections.js';

const SAMPLE_DOC = `# Introduction

This is the intro paragraph.

## Getting Started

To begin, follow these steps.

### Prerequisites

- Node.js 18+
- A modern browser

## Features

TablaCognita supports **real-time** collaboration.

## Conclusion

The end.`;

describe('parseSections', () => {
  it('parses heading-based sections', () => {
    const sections = parseSections(SAMPLE_DOC);
    assert.ok(sections.length >= 4);
    assert.equal(sections[0].heading, 'Introduction');
    assert.equal(sections[0].level, 1);
    assert.equal(sections[0].id, 'sec_1');
    assert.equal(sections[0].line_start, 1);
  });

  it('assigns correct levels', () => {
    const sections = parseSections(SAMPLE_DOC);
    const levels = sections.map(s => s.level);
    assert.deepEqual(levels, [1, 2, 3, 2, 2]); // h1, h2, h3, h2, h2
  });

  it('calculates correct line ranges', () => {
    const sections = parseSections(SAMPLE_DOC);
    const intro = sections[0];
    // Introduction starts at line 1 and ends before Getting Started
    assert.equal(intro.line_start, 1);
    assert.ok(intro.line_end > 1);

    // Sections should not overlap
    for (let i = 1; i < sections.length; i++) {
      assert.ok(sections[i].line_start > sections[i-1].line_start,
        `Section ${sections[i].id} starts after ${sections[i-1].id}`);
    }
  });

  it('last section extends to document end', () => {
    const sections = parseSections(SAMPLE_DOC);
    const last = sections[sections.length - 1];
    const totalLines = SAMPLE_DOC.split('\n').length;
    assert.equal(last.line_end, totalLines);
  });

  it('handles empty document', () => {
    const sections = parseSections('');
    assert.equal(sections.length, 0);
  });

  it('handles document with only whitespace', () => {
    const sections = parseSections('   \n\n   ');
    assert.equal(sections.length, 0);
  });

  it('handles single heading with no body', () => {
    const sections = parseSections('# Just a Title');
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, 'Just a Title');
    assert.equal(sections[0].line_start, 1);
    assert.equal(sections[0].line_end, 1);
  });

  it('I10: creates implicit paragraph sections for headingless docs', () => {
    const content = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph.';
    const sections = parseSections(content);
    assert.ok(sections.length >= 2);
    assert.equal(sections[0].level, 0);
    assert.equal(sections[0].heading, null);
    assert.ok(sections[0].id.startsWith('para_'));
  });

  it('I10: paragraph IDs are content-hashed', () => {
    const content = 'Hello world.\n\nGoodbye world.';
    const sections = parseSections(content);
    assert.equal(sections.length, 2);
    // Same content → same hash
    const content2 = 'Hello world.\n\nGoodbye world.';
    const sections2 = parseSections(content2);
    assert.equal(sections[0].id, sections2[0].id);
  });

  it('tracks dirty flags from dirtyMap', () => {
    const dirtyMap = new Map([['sec_1', true], ['sec_2', false]]);
    const sections = parseSections(SAMPLE_DOC, dirtyMap);
    assert.equal(sections[0].dirty, true);
    assert.equal(sections[1].dirty, false);
  });

  it('handles h1 through h6', () => {
    const doc = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6';
    const sections = parseSections(doc);
    assert.equal(sections.length, 6);
    assert.deepEqual(sections.map(s => s.level), [1, 2, 3, 4, 5, 6]);
  });

  it('ignores # in code blocks (plain text, no fence detection yet)', () => {
    // Note: This test documents current behavior. A future improvement
    // could skip headings inside fenced code blocks.
    const doc = '# Real Heading\n\nSome text\n\n# Another Heading';
    const sections = parseSections(doc);
    assert.equal(sections.length, 2);
  });
});

describe('findSection', () => {
  const sections = parseSections(SAMPLE_DOC);

  it('finds by exact ID', () => {
    const s = findSection(sections, 'sec_1');
    assert.equal(s.heading, 'Introduction');
  });

  it('finds by exact heading', () => {
    const s = findSection(sections, 'Features');
    assert.equal(s.id, 'sec_4');
  });

  it('finds by case-insensitive heading', () => {
    const s = findSection(sections, 'introduction');
    assert.equal(s.id, 'sec_1');
  });

  it('returns null for non-existent section', () => {
    const s = findSection(sections, 'NonExistent');
    assert.equal(s, null);
  });

  it('throws SECTION_AMBIGUOUS for duplicate headings', () => {
    const doc = '# Intro\n\n## Examples\n\nFirst.\n\n## Examples\n\nSecond.';
    const secs = parseSections(doc);
    assert.throws(
      () => findSection(secs, 'Examples'),
      (err) => {
        assert.equal(err.code, 'SECTION_AMBIGUOUS');
        assert.equal(err.matches.length, 2);
        return true;
      }
    );
  });

  it('prefers ID match over heading match', () => {
    // If there's a section whose heading is "sec_2" (unlikely but test the priority)
    const s = findSection(sections, 'sec_2');
    assert.equal(s.id, 'sec_2');
  });
});

describe('countTopLevelSections', () => {
  it('counts h1 sections', () => {
    assert.equal(countTopLevelSections(SAMPLE_DOC), 1);
  });

  it('counts multiple h1s', () => {
    assert.equal(countTopLevelSections('# One\n\n# Two\n\n# Three'), 3);
  });

  it('returns 0 for no headings', () => {
    assert.equal(countTopLevelSections('Just plain text.'), 0);
  });
});

describe('getSectionContent', () => {
  it('extracts section text', () => {
    const sections = parseSections(SAMPLE_DOC);
    const content = getSectionContent(SAMPLE_DOC, sections[0]);
    assert.ok(content.startsWith('# Introduction'));
    assert.ok(content.includes('intro paragraph'));
  });
});

describe('replaceSection', () => {
  it('replaces full section content', () => {
    const sections = parseSections(SAMPLE_DOC);
    const conclusion = sections.find(s => s.heading === 'Conclusion');
    const newDoc = replaceSection(SAMPLE_DOC, conclusion, '## Conclusion\n\nUpdated ending.');
    assert.ok(newDoc.includes('Updated ending.'));
    assert.ok(!newDoc.includes('The end.'));
    // Other sections preserved
    assert.ok(newDoc.includes('# Introduction'));
  });

  it('keeps heading when keepHeading is true', () => {
    const sections = parseSections(SAMPLE_DOC);
    const conclusion = sections.find(s => s.heading === 'Conclusion');
    const newDoc = replaceSection(SAMPLE_DOC, conclusion, 'Just the body.', true);
    assert.ok(newDoc.includes('## Conclusion'));
    assert.ok(newDoc.includes('Just the body.'));
    assert.ok(!newDoc.includes('The end.'));
  });
});

describe('insertAfterSection', () => {
  it('inserts after specified section', () => {
    const sections = parseSections(SAMPLE_DOC);
    const intro = sections[0];
    const newDoc = insertAfterSection(SAMPLE_DOC, intro, '\n## New Section\n\nInserted content.');
    assert.ok(newDoc.includes('New Section'));
    // Original content still there
    assert.ok(newDoc.includes('# Introduction'));
    assert.ok(newDoc.includes('## Getting Started'));
  });
});

describe('simpleHash', () => {
  it('returns consistent hashes', () => {
    assert.equal(simpleHash('hello'), simpleHash('hello'));
  });

  it('returns different hashes for different input', () => {
    assert.notEqual(simpleHash('hello'), simpleHash('world'));
  });

  it('returns non-negative numbers', () => {
    assert.ok(simpleHash('test') >= 0);
    assert.ok(simpleHash('') >= 0);
  });
});
