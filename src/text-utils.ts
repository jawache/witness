/**
 * Pure text utility functions for stripping markdown and truncating text.
 * Extracted from main.ts for testability.
 */

/**
 * Strip markdown formatting from text, returning plain text.
 * Handles headings, bold/italic, links, wiki-links, code blocks,
 * blockquotes, lists, HTML, highlights, and collapses whitespace.
 */
export function stripMarkdown(text: string): string {
	return text
		// Remove headings (# ## ### etc.)
		.replace(/^#{1,6}\s+/gm, '')
		// Remove bold/italic markers
		.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
		.replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
		// Remove strikethrough
		.replace(/~~([^~]+)~~/g, '$1')
		// Remove code blocks (must be before inline code)
		.replace(/```[\s\S]*?```/g, '')
		// Remove inline code
		.replace(/`([^`]+)`/g, '$1')
		// Remove images ![alt](url)
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		// Remove links [text](url) → text
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		// Remove wiki links [[target|alias]] → alias, [[target]] → target
		.replace(/\[\[([^|\]]*)\|([^\]]*)\]\]/g, '$2')
		.replace(/\[\[([^\]]*)\]\]/g, '$1')
		// Remove blockquotes
		.replace(/^>\s+/gm, '')
		// Remove horizontal rules
		.replace(/^[-*_]{3,}\s*$/gm, '')
		// Remove list markers (- * + and numbered)
		.replace(/^[\s]*[-*+]\s+/gm, '')
		.replace(/^[\s]*\d+\.\s+/gm, '')
		// Remove HTML tags
		.replace(/<[^>]+>/g, '')
		// Remove highlight markers
		.replace(/==([^=]+)==/g, '$1')
		// Collapse multiple newlines/spaces
		.replace(/\n{2,}/g, ' ')
		.replace(/\n/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

/**
 * Truncate text at a word boundary, adding ellipsis if truncated.
 * Falls back to hard truncation if no space found after 70% of maxLength.
 */
export function truncateAtWord(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	const truncated = text.substring(0, maxLength);
	const lastSpace = truncated.lastIndexOf(' ');
	return (lastSpace > maxLength * 0.7 ? truncated.substring(0, lastSpace) : truncated) + '…';
}
