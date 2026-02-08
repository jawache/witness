/**
 * Markdown-aware document chunking.
 * Splits documents by headings (H2 primary, H3 fallback) for better
 * retrieval — each section gets its own embedding vector.
 */

export interface Chunk {
	content: string;
	headingPath: string;    // e.g. "## Setup > ### Prerequisites"
	startLine: number;
	endLine: number;
	index: number;
}

const DEFAULT_MAX_CHUNK_CHARS = 6000;
const OVERLAP_CHARS = 200;
const MIN_CHUNK_DOC_LENGTH = 1000;

/**
 * Split markdown content into chunks based on heading structure.
 *
 * Strategy:
 * 1. If the document is short (< MIN_CHUNK_DOC_LENGTH chars) or has no H2 headings,
 *    return it as a single chunk.
 * 2. Split at ## (H2) boundaries. Content before the first H2 is the preamble.
 * 3. If any H2 section exceeds maxChunkChars, subdivide at ### (H3) within it.
 * 4. If still too long, apply fixed-size splitting with overlap.
 */
export function chunkMarkdown(
	content: string,
	maxChunkChars: number = DEFAULT_MAX_CHUNK_CHARS,
): Chunk[] {
	// Short documents stay as a single chunk
	if (content.length < MIN_CHUNK_DOC_LENGTH) {
		return [{ content, headingPath: '', startLine: 0, endLine: countLines(content) - 1, index: 0 }];
	}

	const lines = content.split('\n');

	// Find H2 boundaries
	const h2Indices = findHeadingLines(lines, 2);

	// No H2 headings — return as single chunk
	if (h2Indices.length === 0) {
		return [{ content, headingPath: '', startLine: 0, endLine: lines.length - 1, index: 0 }];
	}

	// Split into sections at H2 boundaries
	const sections = splitAtLines(lines, h2Indices);
	const chunks: Chunk[] = [];

	for (const section of sections) {
		const sectionText = section.lines.join('\n');
		const h2Heading = section.heading; // null for preamble

		if (sectionText.length <= maxChunkChars) {
			// Section fits — add as single chunk
			chunks.push({
				content: sectionText,
				headingPath: h2Heading ? `## ${h2Heading}` : '',
				startLine: section.startLine,
				endLine: section.endLine,
				index: chunks.length,
			});
		} else {
			// Section too long — try splitting at H3
			const h3Indices = findHeadingLines(section.lines, 3);

			if (h3Indices.length > 0) {
				const subSections = splitAtLines(section.lines, h3Indices);

				for (const sub of subSections) {
					const subText = sub.lines.join('\n');
					const h3Heading = sub.heading;
					const headingPath = h2Heading
						? (h3Heading ? `## ${h2Heading} > ### ${h3Heading}` : `## ${h2Heading}`)
						: (h3Heading ? `### ${h3Heading}` : '');

					if (subText.length <= maxChunkChars) {
						chunks.push({
							content: subText,
							headingPath,
							startLine: section.startLine + sub.startLine,
							endLine: section.startLine + sub.endLine,
							index: chunks.length,
						});
					} else {
						// Still too long — fixed-size split with overlap
						const fixedChunks = fixedSizeChunk(subText, maxChunkChars, OVERLAP_CHARS);
						for (const fc of fixedChunks) {
							chunks.push({
								content: fc,
								headingPath,
								startLine: section.startLine + sub.startLine,
								endLine: section.startLine + sub.endLine,
								index: chunks.length,
							});
						}
					}
				}
			} else {
				// No H3 headings — fixed-size split
				const fixedChunks = fixedSizeChunk(sectionText, maxChunkChars, OVERLAP_CHARS);
				for (const fc of fixedChunks) {
					chunks.push({
						content: fc,
						headingPath: h2Heading ? `## ${h2Heading}` : '',
						startLine: section.startLine,
						endLine: section.endLine,
						index: chunks.length,
					});
				}
			}
		}
	}

	// Re-index after all chunks are built
	for (let i = 0; i < chunks.length; i++) {
		chunks[i].index = i;
	}

	return chunks;
}

interface Section {
	lines: string[];
	heading: string | null; // The heading text (without ## prefix), null for preamble
	startLine: number;
	endLine: number;
}

/**
 * Find line indices that start with a heading of the given level.
 */
function findHeadingLines(lines: string[], level: number): number[] {
	const prefix = '#'.repeat(level) + ' ';
	const indices: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(prefix) && !lines[i].startsWith('#'.repeat(level + 1))) {
			indices.push(i);
		}
	}
	return indices;
}

/**
 * Split lines at the given heading indices into sections.
 * Content before the first heading becomes the preamble (heading: null).
 */
function splitAtLines(lines: string[], headingIndices: number[]): Section[] {
	const sections: Section[] = [];

	// Preamble: lines before the first heading
	if (headingIndices[0] > 0) {
		const preambleLines = lines.slice(0, headingIndices[0]);
		// Only include preamble if it has meaningful content
		const preambleText = preambleLines.join('\n').trim();
		if (preambleText.length > 0) {
			sections.push({
				lines: preambleLines,
				heading: null,
				startLine: 0,
				endLine: headingIndices[0] - 1,
			});
		}
	}

	// Each heading section
	for (let i = 0; i < headingIndices.length; i++) {
		const start = headingIndices[i];
		const end = i + 1 < headingIndices.length ? headingIndices[i + 1] : lines.length;
		const sectionLines = lines.slice(start, end);
		const headingLine = lines[start];
		// Extract heading text: strip leading ##+ and trim
		const heading = headingLine.replace(/^#+\s*/, '');

		sections.push({
			lines: sectionLines,
			heading,
			startLine: start,
			endLine: end - 1,
		});
	}

	return sections;
}

/**
 * Split text into fixed-size chunks with overlap.
 */
function fixedSizeChunk(text: string, maxChars: number, overlap: number): string[] {
	const chunks: string[] = [];
	let start = 0;

	while (start < text.length) {
		const end = Math.min(start + maxChars, text.length);
		chunks.push(text.slice(start, end));

		if (end >= text.length) break;
		start = end - overlap;
	}

	return chunks;
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let count = 1;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') count++;
	}
	return count;
}
