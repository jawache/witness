import { describe, it, expect } from 'vitest';
import { stripMarkdown, truncateAtWord } from '../../src/text-utils';

describe('stripMarkdown', () => {
	it('removes headings', () => {
		expect(stripMarkdown('# Title')).toBe('Title');
		expect(stripMarkdown('## Subtitle')).toBe('Subtitle');
		expect(stripMarkdown('###### Deep heading')).toBe('Deep heading');
	});

	it('removes bold markers', () => {
		expect(stripMarkdown('This is **bold** text')).toBe('This is bold text');
		expect(stripMarkdown('This is __bold__ text')).toBe('This is bold text');
	});

	it('removes italic markers', () => {
		expect(stripMarkdown('This is *italic* text')).toBe('This is italic text');
		expect(stripMarkdown('This is _italic_ text')).toBe('This is italic text');
	});

	it('removes bold italic markers', () => {
		expect(stripMarkdown('This is ***bold italic*** text')).toBe('This is bold italic text');
	});

	it('removes strikethrough', () => {
		expect(stripMarkdown('This is ~~deleted~~ text')).toBe('This is deleted text');
	});

	it('removes inline code', () => {
		expect(stripMarkdown('Use `console.log()` for debugging')).toBe('Use console.log() for debugging');
	});

	it('removes code blocks', () => {
		const input = 'Before\n```javascript\nconst x = 1;\n```\nAfter';
		expect(stripMarkdown(input)).toBe('Before After');
	});

	it('removes images, keeping alt text', () => {
		expect(stripMarkdown('Look at ![my image](https://example.com/img.png) here')).toBe('Look at my image here');
	});

	it('removes markdown links, keeping text', () => {
		expect(stripMarkdown('Click [here](https://example.com) now')).toBe('Click here now');
	});

	it('removes wiki links', () => {
		expect(stripMarkdown('See [[Some Note]] for details')).toBe('See Some Note for details');
	});

	it('removes wiki links with alias', () => {
		expect(stripMarkdown('See [[Some Note|the note]] for details')).toBe('See the note for details');
	});

	it('removes blockquotes', () => {
		expect(stripMarkdown('> This is a quote')).toBe('This is a quote');
	});

	it('removes horizontal rules', () => {
		expect(stripMarkdown('Before\n---\nAfter')).toBe('Before After');
		expect(stripMarkdown('Before\n***\nAfter')).toBe('Before After');
		expect(stripMarkdown('Before\n___\nAfter')).toBe('Before After');
	});

	it('removes unordered list markers', () => {
		expect(stripMarkdown('- Item one\n- Item two')).toBe('Item one Item two');
		expect(stripMarkdown('* Item one\n* Item two')).toBe('Item one Item two');
		expect(stripMarkdown('+ Item one\n+ Item two')).toBe('Item one Item two');
	});

	it('removes ordered list markers', () => {
		expect(stripMarkdown('1. First\n2. Second\n3. Third')).toBe('First Second Third');
	});

	it('removes HTML tags', () => {
		expect(stripMarkdown('Text with <strong>HTML</strong> tags')).toBe('Text with HTML tags');
		expect(stripMarkdown('<div class="test">Content</div>')).toBe('Content');
	});

	it('removes highlight markers', () => {
		expect(stripMarkdown('This is ==highlighted== text')).toBe('This is highlighted text');
	});

	it('collapses multiple newlines into spaces', () => {
		expect(stripMarkdown('Line one\n\n\nLine two')).toBe('Line one Line two');
	});

	it('collapses multiple spaces', () => {
		expect(stripMarkdown('Too   many    spaces')).toBe('Too many spaces');
	});

	it('trims whitespace', () => {
		expect(stripMarkdown('  padded text  ')).toBe('padded text');
	});

	it('handles empty string', () => {
		expect(stripMarkdown('')).toBe('');
	});

	it('handles plain text unchanged', () => {
		expect(stripMarkdown('Just plain text')).toBe('Just plain text');
	});

	it('handles complex mixed markdown', () => {
		const input = '## Overview\n\nThis is a **bold** and *italic* note about [[Topic|the topic]].\n\n> Important quote here\n\n- First point\n- Second point with `code`\n\nSee [link](https://example.com) for more.';
		const result = stripMarkdown(input);
		expect(result).toBe('Overview This is a bold and italic note about the topic. Important quote here First point Second point with code See link for more.');
	});

	it('removes nested list markers with indentation', () => {
		expect(stripMarkdown('  - Nested item\n    - Deep item')).toBe('Nested item Deep item');
	});
});

describe('truncateAtWord', () => {
	it('returns text unchanged if shorter than maxLength', () => {
		expect(truncateAtWord('Short text', 100)).toBe('Short text');
	});

	it('returns text unchanged if exactly maxLength', () => {
		expect(truncateAtWord('12345', 5)).toBe('12345');
	});

	it('truncates at word boundary with ellipsis', () => {
		const result = truncateAtWord('The quick brown fox jumps over the lazy dog', 20);
		expect(result).toMatch(/…$/);
		expect(result.length).toBeLessThanOrEqual(21); // 20 + ellipsis
		// Should break at a space boundary (space at position 19 → "The quick brown fox…")
		expect(result).toBe('The quick brown fox…');
	});

	it('falls back to hard truncation if no space after 70%', () => {
		// A single long word with no spaces
		const longWord = 'abcdefghijklmnopqrstuvwxyz';
		const result = truncateAtWord(longWord, 10);
		expect(result).toBe('abcdefghij…');
	});

	it('handles maxLength of 1', () => {
		const result = truncateAtWord('Hello world', 1);
		expect(result).toBe('H…');
	});

	it('truncates at nearest word boundary before maxLength', () => {
		// "Hello world foo" truncated at 12 should find space at position 11
		const result = truncateAtWord('Hello world foo', 12);
		expect(result).toBe('Hello world…');
	});
});
