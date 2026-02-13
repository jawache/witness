/**
 * Search panel view for Witness.
 * Provides a side panel UI for searching the vault with hybrid, vector, and fulltext modes.
 * Includes path and tag filtering with autocomplete.
 */

import { ItemView, WorkspaceLeaf, AbstractInputSuggest, prepareFuzzySearch, renderResults, getAllTags, MarkdownView } from 'obsidian';
import type { SearchResult as ObsidianSearchResult, EventRef } from 'obsidian';
import type WitnessPlugin from './main';
import type { SearchResult } from './search-engine';

export const VIEW_TYPE_SEARCH = 'witness-search';

/**
 * Folder autocomplete suggest for the path filter input.
 * Uses Obsidian's built-in AbstractInputSuggest with fuzzy matching.
 */
class FolderSuggest extends AbstractInputSuggest<string> {
	private plugin: WitnessPlugin;
	private onSelectCallback: (value: string) => void;

	constructor(app: import('obsidian').App, inputEl: HTMLInputElement, plugin: WitnessPlugin, onSelect: (value: string) => void) {
		super(app, inputEl);
		this.plugin = plugin;
		this.onSelectCallback = onSelect;
		this.limit = 20;
	}

	protected getSuggestions(query: string): string[] {
		const folders = this.app.vault.getAllFolders()
			.map(f => f.path)
			.filter(p => p !== '/');

		if (!query.trim()) {
			return folders.sort();
		}

		const fuzzy = prepareFuzzySearch(query);
		const matches: { path: string; score: number }[] = [];

		for (const path of folders) {
			const result = fuzzy(path);
			if (result) {
				matches.push({ path, score: result.score });
			}
		}

		return matches.sort((a, b) => b.score - a.score).map(m => m.path);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		const query = this.getValue();
		if (query.trim()) {
			const fuzzy = prepareFuzzySearch(query);
			const result = fuzzy(value);
			if (result) {
				renderResults(el, value, result as ObsidianSearchResult);
				return;
			}
		}
		el.setText(value);
	}

	selectSuggestion(value: string, _evt: MouseEvent | KeyboardEvent): void {
		this.setValue('');
		this.onSelectCallback(value);
		this.close();
	}
}

/**
 * Tag autocomplete suggest for the tag filter input.
 * Collects all tags from the vault metadata cache.
 */
class TagSuggest extends AbstractInputSuggest<string> {
	private plugin: WitnessPlugin;
	private onSelectCallback: (value: string) => void;

	constructor(app: import('obsidian').App, inputEl: HTMLInputElement, plugin: WitnessPlugin, onSelect: (value: string) => void) {
		super(app, inputEl);
		this.plugin = plugin;
		this.onSelectCallback = onSelect;
		this.limit = 20;
	}

	protected getSuggestions(query: string): string[] {
		const tags = this.getAllVaultTags();

		if (!query.trim()) {
			return tags.sort();
		}

		const fuzzy = prepareFuzzySearch(query);
		const matches: { tag: string; score: number }[] = [];

		for (const tag of tags) {
			const result = fuzzy(tag);
			if (result) {
				matches.push({ tag, score: result.score });
			}
		}

		return matches.sort((a, b) => b.score - a.score).map(m => m.tag);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		const query = this.getValue();
		if (query.trim()) {
			const fuzzy = prepareFuzzySearch(query);
			const result = fuzzy(value);
			if (result) {
				renderResults(el, value, result as ObsidianSearchResult);
				return;
			}
		}
		el.setText(value);
	}

	selectSuggestion(value: string, _evt: MouseEvent | KeyboardEvent): void {
		this.setValue('');
		this.onSelectCallback(value);
		this.close();
	}

	private getAllVaultTags(): string[] {
		// Use the undocumented but efficient getTags() if available
		const mc = this.app.metadataCache as any;
		if (typeof mc.getTags === 'function') {
			const tagCounts: Record<string, number> = mc.getTags();
			return Object.keys(tagCounts);
		}

		// Fallback: iterate all files
		const tagSet = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache) {
				const tags = getAllTags(cache);
				if (tags) {
					for (const tag of tags) {
						tagSet.add(tag);
					}
				}
			}
		}
		return Array.from(tagSet);
	}
}

export class WitnessSearchView extends ItemView {
	private plugin: WitnessPlugin;
	private currentMode: 'hybrid' | 'vector' | 'fulltext' = 'hybrid';
	private currentQuery = '';
	private resultsContainer: HTMLElement;
	private inputEl: HTMLInputElement;
	private selectedPaths: string[] = [];
	private selectedTags: string[] = [];
	private chipContainer: HTMLElement;
	private rerankEnabled = false;
	private rerankToggleContainer: HTMLElement;
	private searchSeq = 0;
	private dotsInterval: number | null = null;
	private contextualMode = false;
	private contextualTimer: number | null = null;
	private lastContextHash: string | null = null;
	private contextualEventRefs: EventRef[] = [];
	private contextualToggleContainer: HTMLElement;
	private modeSelectEl: HTMLSelectElement;
	private contextualSelectionHandler: (() => void) | null = null;
	private readonly CONTEXTUAL_DEBOUNCE_EDIT = 1500;
	private readonly CONTEXTUAL_DEBOUNCE_NAV = 500;
	private readonly CONTEXTUAL_DEBOUNCE_CURSOR = 800;

	constructor(leaf: WorkspaceLeaf, plugin: WitnessPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_SEARCH;
	}

	getDisplayText(): string {
		return 'Witness Search';
	}

	getIcon(): string {
		return 'search';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('witness-search-container');
		this.buildUI(container);
		this.updateRerankVisibility();
	}

	async onClose(): Promise<void> {
		this.stopDotsAnimation();
		this.stopContextualListening();
	}

	private buildUI(container: HTMLElement): void {
		this.buildSearchInput(container);
		this.buildModeSelector(container);
		this.buildContextualToggle(container);
		this.buildRerankToggle(container);
		this.buildFilters(container);
		this.resultsContainer = container.createDiv({ cls: 'witness-search-results' });

		// Show initial empty state
		this.showEmpty();
	}

	private buildSearchInput(container: HTMLElement): void {
		this.inputEl = container.createEl('input', {
			type: 'text',
			placeholder: 'Search vault...',
			cls: 'witness-search-input',
		});

		let debounceTimer: number;

		this.inputEl.addEventListener('input', () => {
			window.clearTimeout(debounceTimer);
			// Skip debounce when re-ranking — too expensive to fire on every keystroke
			if (this.rerankEnabled) return;
			debounceTimer = window.setTimeout(() => {
				this.executeSearch(this.inputEl.value);
			}, 300);
		});

		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				window.clearTimeout(debounceTimer);
				this.executeSearch(this.inputEl.value);
			}
		});
	}

	private buildModeSelector(container: HTMLElement): void {
		this.modeSelectEl = container.createEl('select', {
			cls: 'witness-search-mode',
		});
		const select = this.modeSelectEl;

		const modes = [
			{ value: 'hybrid', label: 'Hybrid (keyword + semantic)' },
			{ value: 'vector', label: 'Vector (semantic only)' },
			{ value: 'fulltext', label: 'Fulltext (keyword only)' },
		];

		for (const mode of modes) {
			select.createEl('option', { value: mode.value, text: mode.label });
		}

		select.addEventListener('change', () => {
			this.currentMode = select.value as 'hybrid' | 'vector' | 'fulltext';
			if (this.currentQuery) {
				this.executeSearch(this.currentQuery);
			}
		});
	}

	private buildRerankToggle(container: HTMLElement): void {
		this.rerankToggleContainer = container.createDiv({ cls: 'witness-rerank-toggle' });

		const label = this.rerankToggleContainer.createEl('label', { cls: 'witness-rerank-label' });
		const checkbox = label.createEl('input', { type: 'checkbox' });
		label.createSpan({ text: 'Re-rank with LLM' });

		checkbox.addEventListener('change', () => {
			this.rerankEnabled = checkbox.checked;
			this.inputEl.placeholder = checkbox.checked ? 'Search vault (press Enter)...' : 'Search vault...';
			if (this.currentQuery) {
				this.executeSearch(this.currentQuery);
			}
		});

		// Only show when reranking is configured
		this.updateRerankVisibility();
	}

	private updateRerankVisibility(): void {
		const available = this.plugin.settings.enableReranking && !!this.plugin.settings.rerankModel;
		this.rerankToggleContainer.style.display = available ? '' : 'none';
		if (!available) {
			this.rerankEnabled = false;
		}
	}

	private buildFilters(container: HTMLElement): void {
		const filterRow = container.createDiv({ cls: 'witness-filter-row' });

		// Path filter input
		const pathInput = filterRow.createEl('input', {
			type: 'text',
			placeholder: 'Filter by folder...',
			cls: 'witness-filter-input',
		});

		new FolderSuggest(this.app, pathInput, this.plugin, (path: string) => {
			if (!this.selectedPaths.includes(path)) {
				this.selectedPaths.push(path);
				this.renderChips();
				this.rerunSearch();
			}
		});

		// Tag filter input
		const tagInput = filterRow.createEl('input', {
			type: 'text',
			placeholder: 'Filter by tag...',
			cls: 'witness-filter-input',
		});

		new TagSuggest(this.app, tagInput, this.plugin, (tag: string) => {
			if (!this.selectedTags.includes(tag)) {
				this.selectedTags.push(tag);
				this.renderChips();
				this.rerunSearch();
			}
		});

		// Chip container for active filters
		this.chipContainer = container.createDiv({ cls: 'witness-filter-chips' });
	}

	private renderChips(): void {
		this.chipContainer.empty();

		for (const path of this.selectedPaths) {
			this.createChip(path, 'path', () => {
				this.selectedPaths = this.selectedPaths.filter(p => p !== path);
				this.renderChips();
				this.rerunSearch();
			});
		}

		for (const tag of this.selectedTags) {
			this.createChip(tag, 'tag', () => {
				this.selectedTags = this.selectedTags.filter(t => t !== tag);
				this.renderChips();
				this.rerunSearch();
			});
		}
	}

	private createChip(label: string, type: 'path' | 'tag', onRemove: () => void): void {
		const chip = this.chipContainer.createDiv({ cls: `witness-filter-chip witness-filter-chip-${type}` });
		chip.createSpan({ text: label, cls: 'witness-filter-chip-label' });
		const removeBtn = chip.createSpan({ text: '\u00D7', cls: 'witness-filter-chip-remove' });
		removeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			onRemove();
		});
	}

	private rerunSearch(): void {
		if (this.currentQuery) {
			this.executeSearch(this.currentQuery);
		}
	}

	private async executeSearch(query: string): Promise<void> {
		if (!query.trim()) {
			this.currentQuery = '';
			this.showEmpty();
			return;
		}

		this.currentQuery = query;
		const seq = ++this.searchSeq;

		// Ensure search engine is initialised
		try {
			await this.plugin.ensureSearchEngine();
		} catch {
			this.showError('Could not initialise search engine. Check that Ollama is running.');
			return;
		}

		if (this.plugin.vectorStore!.getCount() === 0) {
			this.showError('No documents indexed. Build the index in Settings \u2192 Witness \u2192 Semantic Search.');
			return;
		}

		// Check Ollama for vector/hybrid modes
		if (this.currentMode !== 'fulltext' && this.plugin.ollamaProvider) {
			const available = await this.plugin.ollamaProvider.isAvailable();
			if (!available) {
				this.showError('Ollama is not available. Switch to Fulltext mode or start Ollama.');
				return;
			}
		}

		this.showLoading();
		const startTime = performance.now();
		const searchOpts = {
			mode: this.currentMode,
			limit: 20,
			paths: this.selectedPaths.length > 0 ? this.selectedPaths : undefined,
			tags: this.selectedTags.length > 0 ? this.selectedTags : undefined,
		};

		try {
			if (this.rerankEnabled) {
				// Phase 1: show fast results immediately
				const initialResults = await this.plugin.search(query, { ...searchOpts, rerank: false });
				if (seq !== this.searchSeq) return;
				const phase1Ms = Math.round(performance.now() - startTime);
				this.renderResults(initialResults, phase1Ms, { text: 'Re-ranking with LLM', loading: true });

				// Phase 2: re-rank and update
				const rerankedResults = await this.plugin.search(query, { ...searchOpts, rerank: true });
				if (seq !== this.searchSeq) return;
				const totalMs = Math.round(performance.now() - startTime);
				this.renderResults(rerankedResults, totalMs, { text: `Re-ranked in ${totalMs - phase1Ms}ms`, loading: false });
			} else {
				const results = await this.plugin.search(query, searchOpts);
				if (seq !== this.searchSeq) return;
				const elapsed = Math.round(performance.now() - startTime);
				this.renderResults(results, elapsed);
			}
		} catch (err) {
			this.showError(err instanceof Error ? err.message : 'Search failed');
		}
	}

	private renderResults(results: SearchResult[], elapsedMs: number, rerankStatus?: { text: string; loading: boolean }): void {
		this.resultsContainer.empty();

		if (results.length === 0) {
			this.resultsContainer.createEl('div', {
				text: `No results found for '${this.currentQuery}'`,
				cls: 'witness-search-empty',
			});
			return;
		}

		// Summary line
		this.resultsContainer.createEl('div', {
			text: `${results.length} results (${elapsedMs}ms)`,
			cls: 'witness-search-summary',
		});

		// Re-rank status banner
		if (rerankStatus) {
			const banner = this.resultsContainer.createEl('div', {
				cls: 'witness-search-rerank-status',
			});
			if (rerankStatus.loading) {
				banner.setText(rerankStatus.text);
				this.startDotsAnimation(banner, rerankStatus.text);
			} else {
				banner.setText(rerankStatus.text);
				banner.addClass('is-done');
				this.stopDotsAnimation();
			}
		}

		for (const result of results) {
			const isChunk = !!result.headingPath;
			const item = this.resultsContainer.createEl('div', {
				cls: 'witness-search-result',
			});

			// Line 1: Title + score
			const titleRow = item.createEl('div', { cls: 'witness-search-result-title-row' });
			titleRow.createEl('span', {
				text: result.title,
				cls: 'witness-search-result-title',
			});
			titleRow.createEl('span', {
				text: `${Math.round(result.score * 100)}%`,
				cls: 'witness-search-result-score',
			});

			// Line 2: Path
			item.createEl('div', {
				text: result.path,
				cls: 'witness-search-result-path',
				title: result.path,
			});

			// Line 3: Section heading (only for chunk matches)
			if (isChunk) {
				const sectionRow = item.createEl('div', { cls: 'witness-search-result-section' });
				sectionRow.createEl('span', {
					text: '\u00A7', // § symbol
					cls: 'witness-search-result-section-icon',
				});
				const heading = result.headingPath!.replace(/^##\s*/, '').replace(/ > ###\s*/g, ' > ');
				sectionRow.createEl('span', { text: heading });
			}

			// Snippet
			if (result.snippet) {
				item.createEl('div', {
					text: result.snippet,
					cls: 'witness-search-result-snippet',
				});
			}

			// Cmd+hover: trigger Page Preview popup
			const triggerPreview = (event: MouseEvent | KeyboardEvent) => {
				let linktext = result.path;
				if (isChunk) {
					const parts = result.headingPath!.split(' > ');
					const last = parts[parts.length - 1].replace(/^#+\s*/, '');
					linktext = `${result.path}#${last}`;
				}
				this.app.workspace.trigger('hover-link', {
					event,
					source: VIEW_TYPE_SEARCH,
					hoverParent: this,
					targetEl: item,
					linktext,
					sourcePath: '',
				});
			};

			item.addEventListener('mouseover', (event: MouseEvent) => {
				if (!event.metaKey && !event.ctrlKey) return;
				triggerPreview(event);
			});

			// Also trigger when Cmd is pressed while already hovering
			let keyHandler: ((e: KeyboardEvent) => void) | null = null;
			item.addEventListener('mouseenter', () => {
				keyHandler = (e: KeyboardEvent) => {
					if (e.key === 'Meta' || e.key === 'Control') {
						triggerPreview(e);
					}
				};
				document.addEventListener('keydown', keyHandler);
			});
			item.addEventListener('mouseleave', () => {
				if (keyHandler) {
					document.removeEventListener('keydown', keyHandler);
					keyHandler = null;
				}
			});

			// Click: chunk → navigate to heading, whole doc → just open file
			item.addEventListener('click', () => {
				if (isChunk) {
					const parts = result.headingPath!.split(' > ');
					const last = parts[parts.length - 1].replace(/^#+\s*/, '');
					this.app.workspace.openLinkText(`${result.path}#${last}`, '', false);
				} else {
					this.app.workspace.openLinkText(result.path, '', false);
				}
			});
		}
	}

	private startDotsAnimation(el: HTMLElement, baseText: string): void {
		this.stopDotsAnimation();
		let dotCount = 0;
		this.dotsInterval = window.setInterval(() => {
			dotCount = (dotCount % 3) + 1;
			el.setText(baseText + '.'.repeat(dotCount));
		}, 400);
	}

	private stopDotsAnimation(): void {
		if (this.dotsInterval !== null) {
			window.clearInterval(this.dotsInterval);
			this.dotsInterval = null;
		}
	}

	// ===== Contextual Mode =====

	private buildContextualToggle(container: HTMLElement): void {
		this.contextualToggleContainer = container.createDiv({ cls: 'witness-contextual-toggle' });

		const label = this.contextualToggleContainer.createEl('label', { cls: 'witness-contextual-label' });
		const checkbox = label.createEl('input', { type: 'checkbox' });
		label.createSpan({ text: 'Contextual (auto-search)' });

		checkbox.addEventListener('change', () => {
			this.contextualMode = checkbox.checked;
			this.onContextualModeChanged();
		});
	}

	toggleContextualMode(): void {
		this.contextualMode = !this.contextualMode;
		// Sync the checkbox if it exists
		const checkbox = this.contextualToggleContainer?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
		if (checkbox) checkbox.checked = this.contextualMode;
		this.onContextualModeChanged();
	}

	private onContextualModeChanged(): void {
		if (this.contextualMode) {
			// Dim the search input
			this.inputEl.addClass('is-contextual');
			this.inputEl.readOnly = true;
			// Hide rerank toggle (not compatible)
			this.rerankToggleContainer.style.display = 'none';
			this.rerankEnabled = false;
			// Force vector mode and disable selector
			this.modeSelectEl.value = 'vector';
			this.currentMode = 'vector';
			this.modeSelectEl.disabled = true;
			// Start listening
			this.startContextualListening();
			// Fire immediately for current editor state
			this.scheduleContextualSearch(100);
		} else {
			// Restore the search input
			this.inputEl.removeClass('is-contextual');
			this.inputEl.readOnly = false;
			this.inputEl.value = '';
			this.inputEl.placeholder = 'Search vault...';
			// Restore mode selector
			this.modeSelectEl.disabled = false;
			// Re-show rerank toggle if configured
			this.updateRerankVisibility();
			// Stop listening
			this.stopContextualListening();
			this.showEmpty();
		}
	}

	private startContextualListening(): void {
		this.contextualEventRefs.push(
			this.app.workspace.on('active-leaf-change', () => {
				this.scheduleContextualSearch(this.CONTEXTUAL_DEBOUNCE_NAV);
			})
		);

		this.contextualEventRefs.push(
			this.app.workspace.on('editor-change', () => {
				this.scheduleContextualSearch(this.CONTEXTUAL_DEBOUNCE_EDIT);
			})
		);

		// Detect cursor moves and text selection changes (clicks, keyboard nav, drag-select)
		this.contextualSelectionHandler = () => {
			// Ignore clicks within the search panel itself
			const activeEl = document.activeElement;
			if (activeEl && this.containerEl.contains(activeEl)) return;
			this.scheduleContextualSearch(this.CONTEXTUAL_DEBOUNCE_CURSOR);
		};
		document.addEventListener('selectionchange', this.contextualSelectionHandler);
	}

	private stopContextualListening(): void {
		for (const ref of this.contextualEventRefs) {
			this.app.workspace.offref(ref);
		}
		this.contextualEventRefs = [];
		if (this.contextualSelectionHandler) {
			document.removeEventListener('selectionchange', this.contextualSelectionHandler);
			this.contextualSelectionHandler = null;
		}
		if (this.contextualTimer !== null) {
			window.clearTimeout(this.contextualTimer);
			this.contextualTimer = null;
		}
		this.lastContextHash = null;
	}

	private scheduleContextualSearch(debounceMs: number): void {
		if (this.contextualTimer !== null) {
			window.clearTimeout(this.contextualTimer);
		}
		this.contextualTimer = window.setTimeout(() => {
			this.contextualTimer = null;
			this.executeContextualSearch();
		}, debounceMs);
	}

	private async executeContextualSearch(): Promise<void> {
		if (!this.contextualMode) return;

		const context = this.extractContext();
		if (!context) {
			// No editor context (clicked outside an editor) — keep existing results
			return;
		}

		// Skip if context hasn't changed
		const hash = this.simpleHash(context.text);
		if (hash === this.lastContextHash) return;
		this.lastContextHash = hash;

		// Show preview of what we're searching for
		const preview = context.text.slice(0, 80).replace(/\n/g, ' ');
		this.inputEl.value = preview + (context.text.length > 80 ? '...' : '');

		const seq = ++this.searchSeq;

		try {
			await this.plugin.ensureSearchEngine();
		} catch {
			this.showError('Could not initialise search engine. Check that Ollama is running.');
			return;
		}

		if (this.plugin.vectorStore!.getCount() === 0) {
			this.showError('No documents indexed. Build the index in Settings \u2192 Witness \u2192 Semantic Search.');
			return;
		}

		if (this.plugin.ollamaProvider) {
			const available = await this.plugin.ollamaProvider.isAvailable();
			if (!available) {
				this.showError('Ollama is not available. Start Ollama to use contextual search.');
				return;
			}
		}

		this.showLoading();
		const startTime = performance.now();

		try {
			const results = await this.plugin.search(context.text, {
				mode: 'vector',
				limit: 10,
				paths: this.selectedPaths.length > 0 ? this.selectedPaths : undefined,
				tags: this.selectedTags.length > 0 ? this.selectedTags : undefined,
				rerank: false,
			});

			if (seq !== this.searchSeq) return;

			// Filter out the current file
			const filtered = results.filter(r => r.path !== context.filePath);
			const elapsed = Math.round(performance.now() - startTime);
			this.renderResults(filtered, elapsed);
		} catch (err) {
			if (seq !== this.searchSeq) return;
			this.showError(err instanceof Error ? err.message : 'Contextual search failed');
		}
	}

	private extractContext(): { text: string; filePath: string } | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return null;

		const editor = view.editor;
		const filePath = view.file.path;

		// Find the body start (after frontmatter)
		const bodyStart = this.findBodyStart(editor);

		// Priority 1: selection (strip any frontmatter from selection)
		const selection = editor.getSelection();
		if (selection && selection.trim().length >= 2) {
			const cleaned = this.stripFrontmatter(selection.trim());
			if (cleaned.length >= 2) {
				return { text: cleaned.slice(0, 500), filePath };
			}
		}

		// Priority 2: paragraph around cursor
		const cursor = editor.getCursor();
		const lineCount = editor.lineCount();

		// If cursor is in frontmatter, use the first body paragraph instead
		let start = cursor.line < bodyStart ? bodyStart : cursor.line;

		// Walk backward to find paragraph start (but never above bodyStart)
		let paraStart = start;
		while (paraStart > bodyStart && editor.getLine(paraStart - 1).trim() !== '') {
			paraStart--;
		}

		// Walk forward to find paragraph end
		let paraEnd = start;
		while (paraEnd < lineCount - 1 && editor.getLine(paraEnd + 1).trim() !== '') {
			paraEnd++;
		}

		const lines: string[] = [];
		for (let i = paraStart; i <= paraEnd; i++) {
			lines.push(editor.getLine(i));
		}
		const text = lines.join('\n').trim();

		if (text.length < 2) return null;

		return { text: text.slice(0, 500), filePath };
	}

	private findBodyStart(editor: import('obsidian').Editor): number {
		if (editor.getLine(0).trim() !== '---') return 0;
		for (let i = 1; i < editor.lineCount(); i++) {
			if (editor.getLine(i).trim() === '---') {
				// Skip blank lines after frontmatter
				let start = i + 1;
				while (start < editor.lineCount() && editor.getLine(start).trim() === '') {
					start++;
				}
				return start;
			}
		}
		return 0; // No closing ---, treat whole file as body
	}

	private stripFrontmatter(text: string): string {
		return text.replace(/^---\n[\s\S]*?\n---\n*/, '');
	}

	private simpleHash(text: string): string {
		let hash = 5381;
		for (let i = 0; i < text.length; i++) {
			hash = ((hash << 5) + hash) + text.charCodeAt(i);
			hash = hash & hash;
		}
		return hash.toString(36);
	}

	// ===== Display Helpers =====

	private showLoading(): void {
		this.resultsContainer.empty();
		this.resultsContainer.createEl('div', {
			text: this.rerankEnabled ? 'Searching + re-ranking...' : 'Searching...',
			cls: 'witness-search-loading',
		});
	}

	private showError(message: string): void {
		this.resultsContainer.empty();
		this.resultsContainer.createEl('div', {
			text: message,
			cls: 'witness-search-error',
		});
	}

	private showEmpty(message?: string): void {
		this.resultsContainer.empty();
		this.resultsContainer.createEl('div', {
			text: message ?? (this.contextualMode
				? 'Navigate to a file to see related content'
				: 'Type a query to search your vault'),
			cls: 'witness-search-empty',
		});
	}
}
