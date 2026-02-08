/**
 * Search panel view for Witness.
 * Provides a side panel UI for searching the vault with hybrid, vector, and fulltext modes.
 * Includes path and tag filtering with autocomplete.
 */

import { ItemView, WorkspaceLeaf, AbstractInputSuggest, prepareFuzzySearch, renderResults, getAllTags } from 'obsidian';
import type { SearchResult as ObsidianSearchResult } from 'obsidian';
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
	}

	async onClose(): Promise<void> {
		// Cleanup
	}

	private buildUI(container: HTMLElement): void {
		this.buildSearchInput(container);
		this.buildModeSelector(container);
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
		const select = container.createEl('select', {
			cls: 'witness-search-mode',
		});

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

		// Check if vector store is ready
		if (!this.plugin.vectorStore) {
			// For fulltext mode, we need to initialize the store first
			if (!this.plugin.ollamaProvider) {
				const { OllamaProvider } = await import('./ollama-provider');
				this.plugin.ollamaProvider = new OllamaProvider({
					baseUrl: this.plugin.settings.ollamaBaseUrl,
					model: this.plugin.settings.ollamaModel,
				});
				await this.plugin.ollamaProvider.resolveModelInfo();
			}

			// Check Ollama for vector/hybrid modes
			if (this.currentMode !== 'fulltext') {
				const available = await this.plugin.ollamaProvider!.isAvailable();
				if (!available) {
					this.showError('Ollama is not available. Fulltext search still works.');
					return;
				}
			}

			const { OramaSearchEngine } = await import('./vector-store');
			this.plugin.vectorStore = new OramaSearchEngine(this.app, this.plugin.ollamaProvider!);
			await this.plugin.vectorStore.initialize();
		}

		if (this.plugin.vectorStore.getCount() === 0) {
			this.showError('No documents indexed yet. Build the index in Settings \u2192 Witness \u2192 Semantic Search.');
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

		try {
			// Use shared search method (handles phrases, stop words, boosting)
			const results = await this.plugin.search(query, {
				mode: this.currentMode,
				limit: 20,
				paths: this.selectedPaths.length > 0 ? this.selectedPaths : undefined,
				tags: this.selectedTags.length > 0 ? this.selectedTags : undefined,
			});

			const elapsed = Math.round(performance.now() - startTime);
			this.renderResults(results, elapsed);
		} catch (err) {
			this.showError(err instanceof Error ? err.message : 'Search failed');
		}
	}

	private renderResults(results: SearchResult[], elapsedMs: number): void {
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

	private showLoading(): void {
		this.resultsContainer.empty();
		this.resultsContainer.createEl('div', {
			text: 'Searching...',
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

	private showEmpty(): void {
		this.resultsContainer.empty();
		this.resultsContainer.createEl('div', {
			text: 'Type a query to search your vault',
			cls: 'witness-search-empty',
		});
	}
}
