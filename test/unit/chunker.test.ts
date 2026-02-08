/**
 * Unit tests for markdown-aware chunking.
 */

import { describe, it, expect } from 'vitest';
import { chunkMarkdown, type Chunk } from '../../src/chunker';

describe('chunkMarkdown', () => {
	describe('short documents (< 1000 chars)', () => {
		it('should return a single chunk for short content', () => {
			const content = 'A short note about something.';
			const chunks = chunkMarkdown(content);

			expect(chunks).toHaveLength(1);
			expect(chunks[0].content).toBe(content);
			expect(chunks[0].headingPath).toBe('');
			expect(chunks[0].index).toBe(0);
		});

		it('should return a single chunk even if short content has headings', () => {
			const content = '# Title\n\n## Section 1\n\nSome text.\n\n## Section 2\n\nMore text.';
			const chunks = chunkMarkdown(content);

			expect(chunks).toHaveLength(1);
			expect(chunks[0].content).toBe(content);
		});
	});

	describe('documents without headings', () => {
		it('should return a single chunk for long content without headings', () => {
			const content = 'A'.repeat(2000); // Long but no headings
			const chunks = chunkMarkdown(content);

			expect(chunks).toHaveLength(1);
			expect(chunks[0].content).toBe(content);
			expect(chunks[0].headingPath).toBe('');
		});
	});

	describe('H2-based splitting', () => {
		it('should split at ## boundaries', () => {
			const content = [
				'Preamble text here.',
				'',
				'## First Section',
				'',
				'Content of first section.',
				'',
				'## Second Section',
				'',
				'Content of second section.',
			].join('\n');
			// Pad to exceed MIN_CHUNK_DOC_LENGTH
			const padded = content + '\n' + 'x'.repeat(1000);
			const chunks = chunkMarkdown(padded);

			expect(chunks.length).toBeGreaterThanOrEqual(3); // preamble + 2 sections
			expect(chunks[0].headingPath).toBe(''); // preamble
			expect(chunks[1].headingPath).toBe('## First Section');
			expect(chunks[2].headingPath).toBe('## Second Section');
		});

		it('should not include empty preamble as a chunk', () => {
			const content = [
				'## First Section',
				'',
				'Content of first section.',
				'',
				'## Second Section',
				'',
				'Content of second section.',
			].join('\n');
			const padded = content + '\n' + 'x'.repeat(1000);
			const chunks = chunkMarkdown(padded);

			expect(chunks[0].headingPath).toBe('## First Section');
		});

		it('should correctly extract heading text', () => {
			const content = [
				'## My Heading With Spaces',
				'',
				'Content here.',
				'',
				'## Another Heading',
				'',
				'More content.',
			].join('\n');
			const padded = content + '\n' + 'x'.repeat(1000);
			const chunks = chunkMarkdown(padded);

			expect(chunks[0].headingPath).toBe('## My Heading With Spaces');
			expect(chunks[1].headingPath).toBe('## Another Heading');
		});
	});

	describe('H3 subdivision', () => {
		it('should split large H2 sections at ### boundaries', () => {
			// Create a large H2 section that exceeds maxChunkChars
			const longContent = 'x'.repeat(3500);
			const content = [
				'## Big Section',
				'',
				'### Sub A',
				'',
				longContent,
				'',
				'### Sub B',
				'',
				longContent,
			].join('\n');
			const chunks = chunkMarkdown(content, 4000);

			// Should have at least 2 chunks (Sub A and Sub B)
			expect(chunks.length).toBeGreaterThanOrEqual(2);
			// Check that heading paths include both H2 and H3
			const hasCombinedPath = chunks.some(c =>
				c.headingPath.includes('## Big Section') && c.headingPath.includes('### Sub A')
			);
			expect(hasCombinedPath).toBe(true);
		});
	});

	describe('fixed-size fallback', () => {
		it('should apply fixed-size splitting when section exceeds max', () => {
			// A single H2 section with no H3s that's very long
			const veryLong = 'word '.repeat(5000); // ~25000 chars
			const content = `## Huge Section\n\n${veryLong}`;
			const chunks = chunkMarkdown(content, 6000);

			expect(chunks.length).toBeGreaterThan(1);
			// All chunks should reference the same H2 heading
			for (const chunk of chunks) {
				expect(chunk.headingPath).toBe('## Huge Section');
			}
		});
	});

	describe('index numbering', () => {
		it('should assign sequential indices starting from 0', () => {
			const content = [
				'Preamble.',
				'',
				'## Section A',
				'',
				'Content A.',
				'',
				'## Section B',
				'',
				'Content B.',
				'',
				'## Section C',
				'',
				'Content C.',
			].join('\n');
			const padded = content + '\n' + 'x'.repeat(1000);
			const chunks = chunkMarkdown(padded);

			for (let i = 0; i < chunks.length; i++) {
				expect(chunks[i].index).toBe(i);
			}
		});
	});

	describe('H1 handling', () => {
		it('should not split at H1 headings', () => {
			const content = [
				'# Document Title',
				'',
				'Some intro text.',
				'',
				'## Section A',
				'',
				'Content A.',
				'',
				'## Section B',
				'',
				'Content B.',
			].join('\n');
			const padded = content + '\n' + 'x'.repeat(1000);
			const chunks = chunkMarkdown(padded);

			// Should have preamble (with H1 + intro) + Section A + Section B
			// NOT split at the H1
			expect(chunks.some(c => c.headingPath === '## Section A')).toBe(true);
			expect(chunks.some(c => c.headingPath === '## Section B')).toBe(true);
			// H1 content should be in the preamble
			const preamble = chunks.find(c => c.headingPath === '');
			expect(preamble?.content).toContain('# Document Title');
		});
	});

	describe('H4+ handling', () => {
		it('should not split at H4 headings', () => {
			const content = [
				'## Main Section',
				'',
				'Intro.',
				'',
				'#### Sub Detail',
				'',
				'Detail content.',
				'',
				'#### Another Detail',
				'',
				'More detail.',
			].join('\n');
			const padded = content + '\n' + 'x'.repeat(1000);
			const chunks = chunkMarkdown(padded);

			// The H4s should NOT cause splits — they stay within the H2 chunk
			const mainChunk = chunks.find(c => c.headingPath === '## Main Section');
			expect(mainChunk).toBeDefined();
			expect(mainChunk!.content).toContain('#### Sub Detail');
			expect(mainChunk!.content).toContain('#### Another Detail');
		});
	});

	describe('edge cases', () => {
		it('should handle empty content', () => {
			const chunks = chunkMarkdown('');
			expect(chunks).toHaveLength(1);
			expect(chunks[0].content).toBe('');
		});

		it('should handle content that is just headings', () => {
			const content = [
				'## A',
				'## B',
				'## C',
			].join('\n');
			const padded = content + '\n' + 'x'.repeat(1000);
			const chunks = chunkMarkdown(padded);

			expect(chunks.length).toBeGreaterThanOrEqual(3);
		});

		it('should not confuse ### with ## when looking for H2', () => {
			const content = [
				'### This is H3 not H2',
				'',
				'Content under H3.',
			].join('\n');
			const padded = content + '\n' + 'x'.repeat(1000);
			const chunks = chunkMarkdown(padded);

			// No H2 headings — should be single chunk
			expect(chunks).toHaveLength(1);
		});
	});
});
