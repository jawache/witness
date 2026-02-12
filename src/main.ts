import { App, Plugin, PluginSettingTab, Setting, SettingGroup, SecretComponent, Modal, SuggestModal, normalizePath, Notice, TFile, TFolder, ItemView, WorkspaceLeaf } from 'obsidian';
import * as http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import getRawBody from 'raw-body';
import { Tunnel, bin as cloudflaredBin, install as installCloudflared, use as useCloudflared } from 'cloudflared';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OllamaProvider, type EmbeddingModelInfo } from './ollama-provider';
import { OramaSearchEngine } from './vector-store';
import type { SearchResult } from './search-engine';
import { WitnessSearchView, VIEW_TYPE_SEARCH } from './search-view';

/**
 * Logger that writes to both console and file.
 * Logs are stored in .obsidian/plugins/witness/logs/
 * Prefix determines the log file name (e.g. 'mcp' → mcp-2026-02-08.log).
 */
class FileLogger {
	private app: App;
	private pluginId: string;
	private prefix: string;
	private buffer: string[] = [];
	private flushTimeout: NodeJS.Timeout | null = null;
	private readonly FLUSH_INTERVAL = 1000; // Flush every second
	private readonly MAX_BUFFER = 50; // Or when buffer reaches 50 entries

	constructor(app: App, pluginId: string, prefix: string = 'mcp') {
		this.app = app;
		this.pluginId = pluginId;
		this.prefix = prefix;
	}

	private getLogPath(): string {
		const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
		return normalizePath(`.obsidian/plugins/${this.pluginId}/logs/${this.prefix}-${date}.log`);
	}

	private formatMessage(level: string, message: string, data?: any): string {
		const timestamp = new Date().toISOString();
		let line = `[${timestamp}] [${level}] ${message}`;
		if (data !== undefined) {
			if (data instanceof Error) {
				line += ` ${data.message}`;
				if (data.stack) line += `\n${data.stack}`;
			} else {
				line += ` ${typeof data === 'string' ? data : JSON.stringify(data)}`;
			}
		}
		return line;
	}

	private scheduleFlush() {
		if (this.flushTimeout) return;
		this.flushTimeout = setTimeout(() => this.flush(), this.FLUSH_INTERVAL);
	}

	private async flush() {
		this.flushTimeout = null;
		if (this.buffer.length === 0) return;

		const lines = this.buffer.join('\n') + '\n';
		this.buffer = [];

		try {
			const logPath = this.getLogPath();
			const adapter = this.app.vault.adapter;

			// Ensure logs directory exists
			const logsDir = normalizePath(`.obsidian/plugins/${this.pluginId}/logs`);
			if (!await adapter.exists(logsDir)) {
				await adapter.mkdir(logsDir);
			}

			// Append to log file
			if (await adapter.exists(logPath)) {
				const existing = await adapter.read(logPath);
				await adapter.write(logPath, existing + lines);
			} else {
				await adapter.write(logPath, lines);
			}
		} catch (err) {
			// Don't recurse - just log to console if file write fails
			console.error(`[FileLogger:${this.prefix}] Failed to write log file:`, err);
		}
	}

	private log(level: string, message: string, data?: any) {
		const formatted = this.formatMessage(level, message, data);

		// Always log to console
		if (level === 'ERROR') {
			console.error(formatted);
		} else {
			console.log(formatted);
		}

		// Buffer for file write
		this.buffer.push(formatted);

		// Flush if buffer is full, otherwise schedule
		if (this.buffer.length >= this.MAX_BUFFER) {
			this.flush();
		} else {
			this.scheduleFlush();
		}
	}

	info(message: string, data?: any) {
		this.log('INFO', message, data);
	}

	error(message: string, data?: any) {
		this.log('ERROR', message, data);
	}

	debug(message: string, data?: any) {
		this.log('DEBUG', message, data);
	}

	mcp(message: string, data?: any) {
		this.log('MCP', message, data);
	}

	// Force flush (call on plugin unload)
	async close() {
		if (this.flushTimeout) {
			clearTimeout(this.flushTimeout);
			this.flushTimeout = null;
		}
		await this.flush();
	}
}

/**
 * Debounce queue for background indexing.
 * Accumulates file change events and fires a callback after a per-file debounce delay.
 */
class IndexQueue {
	private pending = new Map<string, { action: 'index' | 'delete' | 'rename'; timer: number; oldPath?: string }>();
	private debounceMs: number;
	private onReady: () => void;

	constructor(debounceMs: number, onReady: () => void) {
		this.debounceMs = debounceMs;
		this.onReady = onReady;
	}

	add(path: string, event: 'create' | 'modify' | 'delete', oldPath?: string) {
		const existing = this.pending.get(path);
		if (existing) window.clearTimeout(existing.timer);

		let action: 'index' | 'delete' | 'rename';
		if (event === 'delete') {
			action = 'delete';
		} else if (oldPath) {
			action = 'rename';
		} else {
			action = 'index';
		}

		const timer = window.setTimeout(() => {
			this.onReady();
		}, this.debounceMs);

		this.pending.set(path, { action, timer, oldPath });
	}

	drain(): Array<{ path: string; action: 'index' | 'delete' | 'rename'; oldPath?: string }> {
		const items = Array.from(this.pending.entries()).map(
			([path, { action, oldPath }]) => ({ path, action, oldPath })
		);
		this.pending.clear();
		return items;
	}

	get size(): number {
		return this.pending.size;
	}

	clear() {
		for (const { timer } of this.pending.values()) {
			window.clearTimeout(timer);
		}
		this.pending.clear();
	}
}

interface CustomCommandConfig {
	name: string;           // MCP tool name
	description: string;    // Tool description
	commandId: string;      // Obsidian command ID
	readOnly: boolean;      // true = readOnlyHint, false = destructiveHint
	enabled: boolean;       // Can disable without removing
}

interface WitnessSettings {
	mcpPort: number;
	mcpEnabled: boolean;
	authToken: string;
	// Server-level configuration
	serverInstructions: string;
	// Orientation document
	orientationPath: string;
	// Vault folder paths (chaos → order lifecycle)
	chaosFolder: string;
	lifeFolder: string;
	orderFolder: string;
	deathFolder: string;
	// Custom commands exposed as MCP tools
	customCommands: CustomCommandConfig[];
	// Core tool description overrides
	coreToolDescriptions: {
		read_file?: string;
		write_file?: string;
		list_files?: string;
		edit_file?: string;
		search?: string;
		find?: string;
		find_files?: string;
		move_file?: string;
		create_folder?: string;
		delete?: string;
		copy_file?: string;
		execute_command?: string;
		semantic_search?: string;
		get_next_chaos?: string;
		mark_triage?: string;
	};
	// Command fallback system (opt-in)
	enableCommandFallback: boolean;
	// Remote access via Cloudflare Tunnel
	enableTunnel: boolean;
	tunnelUrl: string | null;
	tunnelType: 'quick' | 'named';
	tunnelToken: string;
	tunnelPrimaryHost: string;
	// Authentication (simple token)
	enableAuth: boolean;
	// Ollama / Semantic Search
	enableSemanticSearch: boolean;
	ollamaBaseUrl: string;
	ollamaModel: string;
	excludedFolders: string[];
	minContentLength: number;
	idleThresholdMinutes: number;
	// Re-ranking
	enableReranking: boolean;
	rerankModel: string;
}

// Helper function to generate random credentials
function generateRandomId(length: number = 32): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	// Use Node's crypto module for compatibility
	const nodeCrypto = require('crypto');
	const randomBytes = nodeCrypto.randomBytes(length);
	for (let i = 0; i < length; i++) {
		result += chars[randomBytes[i] % chars.length];
	}
	return result;
}

const DEFAULT_SETTINGS: WitnessSettings = {
	mcpPort: 3000,
	mcpEnabled: false,
	authToken: '',
	serverInstructions: 'Before performing any operations, use get_vault_context to load the vault structure and organizational context. This helps understand the chaos/order system and current vault state.',
	orientationPath: '',
	chaosFolder: '1-chaos',
	lifeFolder: '2-life',
	orderFolder: '3-order',
	deathFolder: '4-death',
	customCommands: [],
	coreToolDescriptions: {},
	enableCommandFallback: false,
	enableTunnel: false,
	tunnelUrl: null,
	tunnelType: 'quick',
	tunnelToken: '',
	tunnelPrimaryHost: '',
	enableAuth: false,
	enableSemanticSearch: true,
	ollamaBaseUrl: 'http://localhost:11434',
	ollamaModel: 'nomic-embed-text',
	excludedFolders: [],
	minContentLength: 50,
	idleThresholdMinutes: 2,
	enableReranking: false,
	rerankModel: '',
}

export default class WitnessPlugin extends Plugin {
	settings: WitnessSettings;
	private httpServer: http.Server | null = null;
	private mcpServer: McpServer | null = null;
	private transports: Map<string, StreamableHTTPServerTransport> = new Map();
	logger: FileLogger;
	private tunnelProcess: Tunnel | null = null;
	private tunnelStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
	private tunnelStatusCallback: ((status: string, url: string | null) => void) | null = null;
	vectorStore: OramaSearchEngine | null = null;
	ollamaProvider: OllamaProvider | null = null;
	private indexLogger: FileLogger;
	private indexQueue: IndexQueue;
	private statusBarEl: HTMLElement | null = null;
	private backgroundIndexing = false;
	private reconcileTimer: number | null = null;
	private lastAppActivity = 0;
	private idleCheckTimer: number | null = null;
	private saveDirty = false;
	private saveTimer: number | null = null;
	private countdownTimer: number | null = null;
	private waitingForIdle = false;
	private get IDLE_THRESHOLD_MS(): number {
		return (this.settings.idleThresholdMinutes ?? 2) * 60_000;
	}
	private static readonly SAVE_INTERVAL_MS = 30_000; // debounce saves to every 30s

	async onload() {
		await this.loadSettings();

		// Initialize loggers
		this.logger = new FileLogger(this.app, this.manifest.id);
		this.indexLogger = new FileLogger(this.app, this.manifest.id, 'indexing');

		this.logger.info('Witness plugin loaded');

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar('loading...');

		// Add settings tab
		this.addSettingTab(new WitnessSettingTab(this.app, this));

		// Register search panel view
		this.registerView(VIEW_TYPE_SEARCH, (leaf) => new WitnessSearchView(leaf, this));

		// Add ribbon icon to toggle search panel
		this.addRibbonIcon('search', 'Witness Search', () => {
			this.toggleSearchPanel();
		});

		// Add command to toggle search panel
		this.addCommand({
			id: 'toggle-search-panel',
			name: 'Toggle search panel',
			callback: () => {
				this.toggleSearchPanel();
			},
		});

		// Add reindex vault command
		this.addCommand({
			id: 'reindex-vault',
			name: 'Reindex vault',
			callback: async () => {
				try {
					await this.ensureSearchEngine();
					if (!this.vectorStore) return;

					await this.vectorStore.clear();
					const mdFiles = this.getIndexableFiles();
					this.indexLogger.info(`Manual reindex: ${mdFiles.length} files`);
					this.updateStatusBar(`reindexing ${mdFiles.length} files...`);

					const result = await this.vectorStore.indexFiles(mdFiles, {
						generateEmbeddings: true,
						minContentLength: this.settings.minContentLength ?? 50,
						getFileTags: (f) => this.getFileTags(f),
						onProgress: (done, total) => {
							this.updateStatusBar(`reindexing ${done}/${total}...`);
						},
						onLog: (level, msg) => this.indexLogger.info(msg),
					});

					await this.vectorStore.save();
					this.indexLogger.info(`Manual reindex complete: ${result.indexed} indexed, ${result.embedded} embedded`);
					this.updateStatusBar();
				} catch (err) {
					this.indexLogger.error('Manual reindex failed', err);
					this.updateStatusBar('reindex failed');
				}
			},
		});

		// Background indexing: vault event listeners
		this.indexQueue = new IndexQueue(3000, () => this.processQueue());

		this.registerEvent(this.app.vault.on('create', (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				this.indexQueue.add(file.path, 'create');
			}
		}));

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				this.indexQueue.add(file.path, 'modify');
			}
		}));

		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				this.indexQueue.add(file.path, 'delete');
			}
		}));

		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile && file.extension === 'md') {
				this.indexQueue.add(file.path, 'create', oldPath);
			}
		}));

		// Track all app activity to defer indexing until the user is idle
		this.lastAppActivity = Date.now();
		const onActivity = () => {
			this.lastAppActivity = Date.now();
			this.manageCountdownTimer();
		};
		document.addEventListener('mousemove', onActivity, { passive: true });
		document.addEventListener('keydown', onActivity, { passive: true });
		document.addEventListener('click', onActivity, { passive: true });
		document.addEventListener('scroll', onActivity, { capture: true, passive: true });
		this.register(() => {
			document.removeEventListener('mousemove', onActivity);
			document.removeEventListener('keydown', onActivity);
			document.removeEventListener('click', onActivity);
			document.removeEventListener('scroll', onActivity, { capture: true } as EventListenerOptions);
		});

		// Start MCP server if enabled
		if (this.settings.mcpEnabled) {
			await this.startMCPServer();
		}

		// Start tunnel if enabled (after MCP server is up)
		if (this.settings.enableTunnel && this.settings.mcpEnabled) {
			this.startTunnel();
		}

		// Non-blocking background indexing (5s delay to avoid competing with Obsidian's startup I/O)
		if (this.settings.enableSemanticSearch) {
			setTimeout(() => this.startBackgroundIndexing(), 5000);
		}
	}

	async onunload() {
		this.logger.info('Witness plugin unloading');
		if (this.reconcileTimer) {
			window.clearInterval(this.reconcileTimer);
			this.reconcileTimer = null;
		}
		if (this.idleCheckTimer) {
			window.clearTimeout(this.idleCheckTimer);
			this.idleCheckTimer = null;
		}
		if (this.saveTimer) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.countdownTimer) {
			window.clearInterval(this.countdownTimer);
			this.countdownTimer = null;
		}
		this.indexQueue?.clear();
		this.stopTunnel();
		this.stopMCPServer();
		if (this.vectorStore) {
			// Flush any pending dirty save before destroying
			await this.flushSave();
			this.vectorStore.destroy();
			this.vectorStore = null;
		}
		this.ollamaProvider = null;
		await this.indexLogger?.close();
		await this.logger.close();
	}

	/**
	 * Toggle the search panel open/closed in the right sidebar.
	 */
	async toggleSearchPanel(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SEARCH);
		if (existing.length > 0) {
			existing[0].detach();
		} else {
			const leaf = this.app.workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: VIEW_TYPE_SEARCH, active: true });
				this.app.workspace.revealLeaf(leaf);
			}
		}
	}

	/**
	 * Reset the Ollama provider and vector store so they reinitialise
	 * with the current settings on next semantic_search call.
	 */
	resetSemanticSearch(): void {
		if (this.vectorStore) {
			this.vectorStore.destroy();
			this.vectorStore = null;
		}
		this.ollamaProvider = null;
	}

	getIndexCount(): number {
		return this.vectorStore?.getCount() ?? 0;
	}

	getIndexableFiles(): TFile[] {
		const allFiles = this.app.vault.getMarkdownFiles();
		const excluded = this.settings.excludedFolders;
		return allFiles.filter(f => {
			// Exclude by folder
			if (excluded?.length && excluded.some(folder => f.path.startsWith(folder + '/') || f.path === folder)) {
				return false;
			}
			return true;
		});
	}

	/**
	 * Extract tags from a file via Obsidian's metadataCache.
	 * Returns tags with # prefix (e.g., ['#topic', '#recipe']).
	 */
	getFileTags(file: TFile): string[] {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return [];
		const tags: string[] = [];
		// Tags in frontmatter
		if (cache.frontmatter?.tags) {
			const fmTags = Array.isArray(cache.frontmatter.tags)
				? cache.frontmatter.tags
				: [cache.frontmatter.tags];
			for (const t of fmTags) {
				const tag = String(t).startsWith('#') ? String(t) : `#${t}`;
				tags.push(tag);
			}
		}
		// Inline tags
		if (cache.tags) {
			for (const t of cache.tags) {
				if (!tags.includes(t.tag)) {
					tags.push(t.tag);
				}
			}
		}
		return tags;
	}

	async clearIndex(): Promise<void> {
		if (this.vectorStore) {
			await this.vectorStore.clear();
			this.vectorStore = null;
		} else {
			// VectorStore not loaded — delete the file directly
			if (await this.app.vault.adapter.exists('.witness/index.orama')) {
				await this.app.vault.adapter.remove('.witness/index.orama');
			}
		}
		this.ollamaProvider = null;
		this.updateStatusBar();
	}

	/**
	 * Update the status bar text. Call with no args to show idle state.
	 */
	updateStatusBar(text?: string) {
		if (!this.statusBarEl) return;
		if (text) {
			this.statusBarEl.setText(`Witness: ${text}`);
		} else {
			const fileCount = this.vectorStore?.getFileCount() ?? 0;
			this.statusBarEl.setText(fileCount > 0 ? `Witness: ${fileCount.toLocaleString()} files indexed` : 'Witness');
		}
		// Manage countdown timer: start when idle with pending work, stop otherwise
		this.manageCountdownTimer();
	}

	/**
	 * Start or stop the countdown timer based on whether there's pending work
	 * waiting for idle. Shows "indexing in M:SS" in the status bar.
	 */
	private manageCountdownTimer(): void {
		const needsCountdown = this.waitingForIdle && !this.backgroundIndexing && !this.isAppIdle();

		if (needsCountdown && !this.countdownTimer) {
			// Start ticking every 5 seconds
			this.countdownTimer = window.setInterval(() => this.updateCountdown(), 5_000);
			// Immediately show the first countdown
			this.updateCountdown();
		} else if (!needsCountdown && this.countdownTimer) {
			window.clearInterval(this.countdownTimer);
			this.countdownTimer = null;
		}
	}

	/**
	 * Update the status bar with the idle countdown.
	 */
	private updateCountdown(): void {
		if (!this.statusBarEl) return;
		if (this.backgroundIndexing || !this.waitingForIdle) {
			if (this.countdownTimer) {
				window.clearInterval(this.countdownTimer);
				this.countdownTimer = null;
			}
			return;
		}

		const elapsed = Date.now() - this.lastAppActivity;
		const remaining = Math.max(0, this.IDLE_THRESHOLD_MS - elapsed);

		if (remaining === 0) {
			if (this.countdownTimer) {
				window.clearInterval(this.countdownTimer);
				this.countdownTimer = null;
			}
			return;
		}

		const secs = Math.ceil(remaining / 1000);
		const mins = Math.floor(secs / 60);
		const remSecs = secs % 60;
		const timeStr = `${mins}:${remSecs.toString().padStart(2, '0')}`;
		const queueCount = this.indexQueue?.size ?? 0;
		const pendingText = queueCount > 0 ? `${queueCount} pending, ` : '';
		this.statusBarEl.setText(`Witness: ${pendingText}indexing in ${timeStr}`);
	}

	/**
	 * Ensure OllamaProvider and VectorStore are initialized.
	 * Consolidates the duplicate initialization logic from multiple call sites.
	 */
	async ensureSearchEngine(): Promise<void> {
		if (this.vectorStore) return;
		if (!this.ollamaProvider) {
			this.ollamaProvider = new OllamaProvider({
				baseUrl: this.settings.ollamaBaseUrl,
				model: this.settings.ollamaModel,
				log: (level: string, msg: string, data?: any) => {
					if (level === 'error') this.logger.error(msg, data);
					else this.logger.info(msg);
				},
			});
			await this.ollamaProvider.resolveModelInfo();
		}
		this.vectorStore = new OramaSearchEngine(this.app, this.ollamaProvider);
		await this.vectorStore.initialize();
	}

	/**
	 * Whether the app has been idle (no mouse, keyboard, click, scroll)
	 * for at least IDLE_THRESHOLD_MS.
	 */
	private isAppIdle(): boolean {
		return Date.now() - this.lastAppActivity >= this.IDLE_THRESHOLD_MS;
	}

	/**
	 * Wait until the app is idle, checking every 10 seconds.
	 * Returns immediately if already idle.
	 */
	private waitForIdle(): Promise<void> {
		if (this.isAppIdle()) return Promise.resolve();
		this.waitingForIdle = true;
		this.manageCountdownTimer();
		return new Promise(resolve => {
			const check = () => {
				if (this.isAppIdle()) {
					this.waitingForIdle = false;
					resolve();
				} else {
					this.idleCheckTimer = window.setTimeout(check, 10_000);
				}
			};
			this.idleCheckTimer = window.setTimeout(check, 10_000);
		});
	}

	/**
	 * Mark the index as dirty and schedule a save after SAVE_INTERVAL_MS.
	 * Avoids serialising the full 279 MB+ index after every small change.
	 */
	private scheduleSave(): void {
		this.saveDirty = true;
		if (this.saveTimer) return; // already scheduled
		this.saveTimer = window.setTimeout(async () => {
			this.saveTimer = null;
			await this.flushSave();
		}, WitnessPlugin.SAVE_INTERVAL_MS);
	}

	/**
	 * Persist the index to disk immediately if dirty.
	 * Called by the debounce timer and on plugin unload.
	 */
	private async flushSave(): Promise<void> {
		if (!this.saveDirty || !this.vectorStore) return;
		this.saveDirty = false;
		try {
			await this.vectorStore.save();
			this.indexLogger.info('Index saved to disk');
		} catch (err) {
			this.indexLogger.error('Failed to save index', err);
		}
	}

	/**
	 * Process the background indexing queue.
	 * Waits for app idleness before starting any work.
	 */
	private async processQueue(): Promise<void> {
		if (!this.settings.enableSemanticSearch) return;
		if (this.backgroundIndexing) return;
		if (!this.vectorStore) return;

		// Wait until the user has been idle before doing any work
		await this.waitForIdle();

		// Re-check after waiting — state may have changed
		if (this.backgroundIndexing || !this.vectorStore) return;
		this.backgroundIndexing = true;

		try {
			const items = this.indexQueue.drain();
			if (items.length === 0) return;

			const toDelete = items.filter(i => i.action === 'delete');
			const toRename = items.filter(i => i.action === 'rename');
			const toIndex = items.filter(i => i.action === 'index');
			let changed = false;

			// Process deletes
			for (const item of toDelete) {
				await this.vectorStore!.removeFile(item.path);
				this.indexLogger.info(`Removed: ${item.path}`);
				changed = true;
			}

			// Process renames (light metadata update, no re-embedding)
			const renameFallbacks: TFile[] = [];
			for (const item of toRename) {
				if (!item.oldPath) continue;
				const file = this.app.vault.getAbstractFileByPath(item.path);
				if (file instanceof TFile) {
					const moved = await this.vectorStore!.moveFile(item.oldPath, item.path, file);
					if (moved > 0) {
						this.indexLogger.info(`Moved: ${item.oldPath} → ${item.path} (${moved} chunks)`);
						changed = true;
					} else {
						// Old path not in index — fall back to full index
						renameFallbacks.push(file);
					}
				}
			}

			// Process indexes (including rename fallbacks)
			const allFilesToIndex = [
				...toIndex
					.map(i => this.app.vault.getAbstractFileByPath(i.path))
					.filter((f): f is TFile => f instanceof TFile),
				...renameFallbacks,
			];

			// Defer the active file — it will change again soon while the user is editing
			const activeFile = this.app.workspace.getActiveFile();
			const filesToIndex: TFile[] = [];
			for (const file of allFilesToIndex) {
				if (activeFile && file.path === activeFile.path) {
					this.indexQueue.add(file.path, 'modify');
					this.indexLogger.info(`Deferred active file: ${file.path}`);
				} else {
					filesToIndex.push(file);
				}
			}

			if (filesToIndex.length > 0) {
				this.updateStatusBar(`indexing ${filesToIndex.length} file${filesToIndex.length > 1 ? 's' : ''}...`);
				const result = await this.vectorStore!.indexFiles(filesToIndex, {
					generateEmbeddings: true,
					minContentLength: this.settings.minContentLength ?? 50,
					getFileTags: (f) => this.getFileTags(f),
					onProgress: (done, total) => {
						this.updateStatusBar(`indexing ${done}/${total}...`);
					},
					onLog: (_level, msg) => this.indexLogger.info(msg),
					isUserActive: () => !this.isAppIdle(),
				});
				this.indexLogger.info(`Indexed ${result.indexed} file${result.indexed > 1 ? 's' : ''} (${result.embedded} embedded)`);
				changed = true;
			}

			if (changed) {
				this.scheduleSave();
			}
		} catch (err) {
			this.indexLogger.error('Background indexing failed', err);
			this.updateStatusBar('indexing error');
		} finally {
			this.backgroundIndexing = false;
			this.updateStatusBar();
		}
	}

	/**
	 * Start background indexing: initialise the search engine, run an initial
	 * reconciliation, then start a periodic reconciliation timer.
	 */
	private async startBackgroundIndexing(): Promise<void> {
		try {
			await this.ensureSearchEngine();
		} catch {
			this.indexLogger.info('Could not initialize search engine, skipping background indexing');
			this.updateStatusBar();
			return;
		}

		// Discard any events queued during the startup delay — reconcile catches everything
		this.indexQueue.clear();

		// Search engine is loaded — update status bar so user knows it's ready
		this.updateStatusBar();

		// Run initial reconciliation immediately (skip idle wait — startup is expected to do work)
		await this.reconcile(true);

		// Start periodic reconciliation (every 60 seconds)
		this.reconcileTimer = window.setInterval(() => this.reconcile(), 60_000);
	}

	/**
	 * Bidirectional reconciliation scan.
	 * Forward: find stale files (new/modified since last index).
	 * Reverse: find orphaned index entries (files deleted while plugin was off).
	 */
	private async reconcile(skipIdleWait = false): Promise<void> {
		if (!this.settings.enableSemanticSearch) return;
		if (this.backgroundIndexing) return;
		if (!this.vectorStore) return;

		// Wait until the user has been idle before doing any work (skip on initial startup)
		if (!skipIdleWait) {
			await this.waitForIdle();
		}

		// Re-check after waiting
		if (this.backgroundIndexing || !this.vectorStore) return;
		this.backgroundIndexing = true;

		try {
			const RECONCILE_BATCH_SIZE = 10;
			const mdFiles = this.getIndexableFiles();
			const vaultPaths = new Set(mdFiles.map(f => f.path));

			// Reverse: find orphaned index entries (files deleted while plugin was off)
			const orphanedPaths = this.vectorStore.getOrphanedPaths(vaultPaths);

			// Forward: find files needing indexing (new/modified)
			const allStaleFiles = await this.vectorStore.getStaleFiles(mdFiles);

			// Defer the active file — will be picked up when the user switches away
			const activeFile = this.app.workspace.getActiveFile();
			const nonActiveStale = activeFile
				? allStaleFiles.filter(f => f.path !== activeFile.path)
				: allStaleFiles;

			// Cap batch size to avoid long blocking — rest picked up next cycle
			const staleFiles = nonActiveStale.slice(0, RECONCILE_BATCH_SIZE);
			if (staleFiles.length < nonActiveStale.length) {
				this.indexLogger.info(`Reconcile: processing ${staleFiles.length}/${nonActiveStale.length} stale files (rest next cycle)`);
			}

			if (staleFiles.length === 0 && orphanedPaths.length === 0) return;

			// Remove orphans
			for (const path of orphanedPaths) {
				await this.vectorStore.removeFile(path);
				this.indexLogger.info(`Reconcile removed orphan: ${path}`);
			}

			// Index stale files
			if (staleFiles.length > 0) {
				this.updateStatusBar(`indexing ${staleFiles.length} files...`);
				await this.vectorStore.indexFiles(staleFiles, {
					generateEmbeddings: true,
					minContentLength: this.settings.minContentLength ?? 50,
					getFileTags: (f) => this.getFileTags(f),
					onProgress: (done, total) => this.updateStatusBar(`indexing ${done}/${total}...`),
					onLog: (_level, msg) => this.indexLogger.info(msg),
					isUserActive: () => !this.isAppIdle(),
				});
			}

			if (staleFiles.length > 0 || orphanedPaths.length > 0) {
				this.scheduleSave();
				this.indexLogger.info(`Reconcile: ${staleFiles.length} indexed, ${orphanedPaths.length} orphans removed`);
			}
		} catch (err) {
			this.indexLogger.error('Reconciliation failed', err);
		} finally {
			this.backgroundIndexing = false;
			this.updateStatusBar();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	/**
	 * Check if the Dataview plugin is installed and its API is available.
	 */
	private isDataviewAvailable(): boolean {
		return !!(this.app as any).plugins?.plugins?.dataview?.api;
	}

	/**
	 * Get the Dataview API, or null if unavailable.
	 */
	private getDataviewApi(): any | null {
		return (this.app as any).plugins?.plugins?.dataview?.api ?? null;
	}

	/**
	 * Process a markdown string, replacing ```dataview codeblocks with query results.
	 * Returns the original content unchanged if Dataview is not available.
	 */
	async resolveDataviewBlocks(content: string): Promise<string> {
		const dvApi = this.getDataviewApi();
		if (!dvApi) return content;

		// Match ```dataview ... ``` blocks
		const dataviewBlockRegex = /```dataview\n([\s\S]*?)```/g;

		// Collect all matches first (to avoid regex state issues with async)
		const matches: Array<{ full: string; query: string }> = [];
		let match;
		while ((match = dataviewBlockRegex.exec(content)) !== null) {
			matches.push({ full: match[0], query: match[1].trim() });
		}

		if (matches.length === 0) return content;

		this.logger.mcp(`Resolving ${matches.length} Dataview block(s)`);

		let result = content;
		for (const m of matches) {
			try {
				const queryResult = await dvApi.queryMarkdown(m.query);
				if (queryResult.successful) {
					result = result.replace(m.full, queryResult.value.trim());
					this.logger.mcp(`Dataview query resolved: "${m.query.substring(0, 60)}..."`);
				} else {
					const errorMsg = `> [!warning] Dataview query failed: ${queryResult.error}`;
					result = result.replace(m.full, errorMsg);
					this.logger.error(`Dataview query failed: ${queryResult.error}`);
				}
			} catch (err: any) {
				const errorMsg = `> [!warning] Dataview error: ${err.message}`;
				result = result.replace(m.full, errorMsg);
				this.logger.error(`Dataview error: ${err.message}`);
			}
		}

		return result;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Regenerate authentication token
	 */
	async regenerateAuthToken() {
		this.settings.authToken = generateRandomId(32);
		await this.saveSettings();
	}

	async startMCPServer() {
		if (this.httpServer || this.mcpServer) {
			this.logger.info('MCP server already running');
			return;
		}

		// Create MCP server with SDK
		this.mcpServer = new McpServer(
			{
				name: 'witness',
				version: '0.1.0',
			},
			{
				capabilities: {
					tools: {},
				},
				instructions: this.settings.serverInstructions,
			}
		);

		// Register tools
		this.registerTools();

		// Create HTTP server
		this.httpServer = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
			// CORS headers for cross-origin requests
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Session-Id');

			// Handle preflight requests
			if (req.method === 'OPTIONS') {
				res.writeHead(204);
				res.end();
				return;
			}

			// Health check endpoint (no auth required)
			if (req.url === '/health') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ status: 'ok', plugin: 'witness' }));
				return;
			}

			// MCP Streamable HTTP endpoint - handle both POST and GET (for SSE)
			// Match /mcp or /mcp?token=xxx
			const parsedUrl = new URL(req.url || '', `http://localhost:${this.settings.mcpPort}`);
			if (parsedUrl.pathname === '/mcp') {
				// Validate authentication if enabled
				if (this.settings.enableAuth) {
					const authValid = this.validateAuth(req);
					if (!authValid) {
						this.logger.mcp('Authentication failed for MCP request');
						res.writeHead(401, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing access token' }));
						return;
					}
				}
				await this.handleMCPRequest(req, res);
				return;
			}

			// Not found
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Not found' }));
		});

		this.httpServer.listen(this.settings.mcpPort, 'localhost', () => {
			this.logger.info(`MCP server listening on http://localhost:${this.settings.mcpPort}`);
		});

		this.httpServer.on('error', (err) => {
			this.logger.error('MCP server error:', err);
		});
	}

	private getToolDescription(toolName: keyof WitnessSettings['coreToolDescriptions'], defaultDescription: string): string {
		return this.settings.coreToolDescriptions[toolName] || defaultDescription;
	}

	private registerTools() {
		if (!this.mcpServer) return;

		// Register read_file tool (READ-ONLY)
		this.mcpServer.tool(
			'read_file',
			this.getToolDescription('read_file', 'Read the contents of a file from the vault'),
			{
				path: z.string().describe('Path to the file relative to vault root'),
				render: z.boolean().optional().default(false).describe('Resolve Dataview queries in the file before returning (requires Dataview plugin)'),
			},
			{
				readOnlyHint: true,
			},
			async ({ path, render }) => {
				this.logger.mcp(`read_file called with path: "${path}", render: ${render}`);
				const file = this.app.vault.getAbstractFileByPath(path);
				this.logger.mcp(`File lookup:`, file ? `Found: ${file.path}` : 'NOT FOUND');
				if (!file) {
					throw new Error('File not found');
				}
				let content = await this.app.vault.read(file as any);

				if (render) {
					content = await this.resolveDataviewBlocks(content);
				}

				this.logger.mcp(`read_file success, length: ${content.length} chars`);
				return {
					content: [
						{
							type: 'text',
							text: content,
						},
					],
					isError: false,
				};
			}
		);

		// Register write_file tool (creates new files only)
		this.mcpServer.tool(
			'write_file',
			this.getToolDescription('write_file', 'Write content to a file in the vault (creates new files only — use edit_file to modify existing files)'),
			{
				path: z.string().describe('Path to the file relative to vault root'),
				content: z.string().describe('Content to write to the file'),
			},
			{
				destructiveHint: true,
			},
			async ({ path, content }) => {
				const existing = this.app.vault.getAbstractFileByPath(path);
				if (existing) {
					throw new Error(
						`File already exists: ${path}. ` +
						`Use edit_file for targeted changes, or re-read the file with read_file and use edit_file to replace the content. ` +
						`Do NOT delete and recreate the file — this loses file metadata and timestamps.`
					);
				}
				await this.app.vault.create(path, content);
				return {
					content: [
						{
							type: 'text',
							text: `Successfully created ${path}`,
						},
					],
					isError: false,
				};
			}
		);

		// Register list_files tool (READ-ONLY)
		this.mcpServer.tool(
			'list_files',
			this.getToolDescription('list_files', 'List files and folders in a directory'),
			{
				path: z.string().optional().describe('Directory path (default: vault root)'),
			},
			{
				readOnlyHint: true,
			},
			async ({ path }) => {
				const dir = path || '/';
				const folder = this.app.vault.getAbstractFileByPath(dir);
				if (!folder || !(folder as any).children) {
					throw new Error('Directory not found');
				}
				const files = (folder as any).children.map((f: any) => ({
					name: f.name,
					path: f.path,
					type: f.children ? 'folder' : 'file',
				}));
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(files, null, 2),
						},
					],
					isError: false,
				};
			}
		);

		// Register edit_file tool (DESTRUCTIVE)
		this.mcpServer.tool(
			'edit_file',
			this.getToolDescription('edit_file', 'Find and replace text in a file (surgical edits)'),
			{
				path: z.string().describe('Path to the file relative to vault root'),
				find: z.string().describe('Text to find (exact match)'),
				replace: z.string().describe('Text to replace with'),
			},
			{
				destructiveHint: true,
			},
			async ({ path, find, replace }) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!file) {
					throw new Error('File not found');
				}
				const content = await this.app.vault.read(file as any);

				// Check if find text exists
				if (!content.includes(find)) {
					throw new Error(
						`Text not found in file: "${find.slice(0, 80)}${find.length > 80 ? '...' : ''}". ` +
						`The file may have changed since you last read it. ` +
						`Re-read the file with read_file first, then retry edit_file with the current content. ` +
						`Do NOT delete and recreate the file — this loses file metadata and timestamps.`
					);
				}

				// Replace all occurrences
				const newContent = content.replace(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replace);
				const occurrences = (content.match(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

				await this.app.vault.modify(file as any, newContent);

				return {
					content: [
						{
							type: 'text',
							text: `Successfully replaced ${occurrences} occurrence(s) in ${path}`,
						},
					],
					isError: false,
				};
			}
		);

		// Register unified search tool (READ-ONLY)
		// Replaces the old brute-force search and semantic_search tools
		this.mcpServer.tool(
			'search',
			this.getToolDescription('search',
				'Search for documents by meaning, keyword, or both. Returns ranked results with snippets.\n' +
				'Modes: "hybrid" (default, combines keyword + semantic), "vector" (semantic only), "fulltext" (keyword only).\n' +
				'Use "quoted phrases" in the query for exact phrase matching (e.g., \'"carbon intensity"\').\n' +
				'Use path to limit results to a folder (e.g., "chaos/" or "order/knowledge/").\n' +
				'Use tag to filter by Obsidian tag (e.g., "#recipe", "#topic").\n' +
				'Fulltext mode works without Ollama. Vector and hybrid modes require Ollama running with an embedding model.\n' +
				'Results are ranked by relevance score and deduplicated per file, returning the best-matching section.'),
			{
				query: z.string().describe('Search query. Supports quoted phrases for exact matching.'),
				mode: z.enum(['hybrid', 'vector', 'fulltext']).optional().default('hybrid')
					.describe('Search mode: hybrid (keyword+semantic), vector (semantic only), fulltext (keyword only)'),
				path: z.string().optional().describe('Limit to files under this folder (e.g., "chaos/" or "order/knowledge/")'),
				tag: z.string().optional().describe('Only files with this tag (e.g., "#recipe", "#topic")'),
				limit: z.number().optional().default(10).describe('Maximum number of results to return'),
				minScore: z.number().optional().default(0.3).describe('Minimum similarity score (0-1, applies to hybrid and vector modes)'),
				rerank: z.boolean().optional().default(false).describe('Re-rank results using an LLM for higher precision. Adds ~1-3s but significantly improves result ordering for complex queries.'),
			},
			{
				readOnlyHint: true,
			},
			async ({ query, mode, path, tag, limit, minScore, rerank }) => {
				try {
					// Initialize search engine on first use
					await this.ensureSearchEngine();

					// For vector/hybrid modes, check Ollama availability
					if (mode !== 'fulltext' && this.ollamaProvider) {
						if (!(await this.ollamaProvider.isAvailable())) {
							return {
								content: [{
									type: 'text',
									text: 'Ollama is not running. Start Ollama for hybrid/vector search, or use mode: "fulltext" for keyword-only search.\n\n  ollama pull nomic-embed-text',
								}],
								isError: true,
							};
						}
					}

					if (this.vectorStore!.getCount() === 0) {
						return {
							content: [{
								type: 'text',
								text: 'No documents indexed yet. Ensure your vault has markdown files. For hybrid/vector search, Ollama must be running.',
							}],
							isError: true,
						};
					}

					// Use the shared search method (handles phrases, stop words, boosting, reranking)
					const results = await this.search(query, {
						mode: mode ?? 'hybrid',
						limit,
						minScore,
						paths: path ? [path] : undefined,
						tags: tag ? [tag] : undefined,
						rerank,
					});

					// Return structured JSON
					if (results.length === 0) {
						return {
							content: [{
								type: 'text',
								text: `No results found for: "${query}"`,
							}],
							isError: false,
						};
					}

					const jsonResults = results.map(r => ({
						path: r.path,
						title: r.title,
						section: r.headingPath ? r.headingPath.replace(/^##\s*/, '').replace(/ > ###\s*/g, ' > ') : undefined,
						score: Math.round(r.score * 100) / 100,
						snippet: r.snippet,
					}));

					return {
						content: [{
							type: 'text',
							text: JSON.stringify(jsonResults, null, 2),
						}],
						isError: false,
					};
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					this.logger.error('Search error:', errorMessage);
					return {
						content: [{
							type: 'text',
							text: `Search failed: ${errorMessage}`,
						}],
						isError: true,
					};
				}
			}
		);

		// Register find tool (READ-ONLY)
		// Replaces the old find_files tool with richer metadata
		this.mcpServer.tool(
			'find',
			this.getToolDescription('find',
				'Find files and folders in the vault by name, path, tag, or frontmatter property.\n' +
				'Use pattern to match filenames (e.g., "weekly" finds all files with "weekly" in the name).\n' +
				'Use path to limit results to a specific folder (e.g., "chaos/inbox").\n' +
				'Use tag to find files with a specific tag (e.g., "#recipe", "#meeting").\n' +
				'Use property to match frontmatter values (e.g., {"key": "status", "value": "draft"}).\n' +
				'Use sortBy to order results by a property (e.g., {"property": "created"} for newest first, {"property": "name", "direction": "asc"} for alphabetical).\n' +
				'Built-in sort properties: "mtime" (modified time), "size", "name". Any frontmatter property also works.\n' +
				'Returns file paths with title, metadata (size, modified time, tags), and full frontmatter. Does not search file contents — use the search tool for that.'),
			{
				pattern: z.string().optional().describe('Pattern to match in filename (case-insensitive)'),
				path: z.string().optional().describe('Limit to files under this folder'),
				tag: z.string().optional().describe('Only files with this tag (e.g., "#recipe")'),
				property: z.object({
					key: z.string(),
					value: z.string(),
				}).optional().describe('Match frontmatter property (e.g., {"key": "status", "value": "draft"})'),
				sortBy: z.object({
					property: z.string().describe('Property to sort by: frontmatter name (e.g., "created") or built-in: "mtime", "size", "name"'),
					direction: z.enum(['asc', 'desc']).optional().describe('Sort direction. Defaults to "desc" for dates/mtime, "asc" for strings'),
				}).optional().describe('Sort results by a property'),
				limit: z.number().optional().default(20).describe('Maximum number of results'),
			},
			{
				readOnlyHint: true,
			},
			async ({ pattern, path, tag, property, sortBy, limit }) => {
				let files = this.app.vault.getMarkdownFiles() as TFile[];

				// Filter by path
				if (path) {
					files = files.filter(f => f.path.startsWith(path));
				}

				// Filter by filename pattern
				if (pattern) {
					const searchRegex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
					files = files.filter(f => searchRegex.test(f.name) || searchRegex.test(f.path));
				}

				// Filter by tag
				if (tag) {
					const normalizedTag = tag.startsWith('#') ? tag : `#${tag}`;
					files = files.filter(f => {
						const fileTags = this.getFileTags(f);
						return fileTags.includes(normalizedTag);
					});
				}

				// Filter by frontmatter property
				if (property) {
					files = files.filter(f => {
						const cache = this.app.metadataCache.getFileCache(f);
						if (!cache?.frontmatter) return false;
						return String(cache.frontmatter[property.key]) === property.value;
					});
				}

				// Sort results
				if (sortBy) {
					const prop = sortBy.property;
					const builtins = new Set(['mtime', 'size', 'name']);

					// Extract sort value for each file
					const getSortValue = (f: TFile): string | number | null => {
						if (prop === 'mtime') return f.stat.mtime;
						if (prop === 'size') return f.stat.size;
						if (prop === 'name') return f.basename;
						const cache = this.app.metadataCache.getFileCache(f);
						const val = cache?.frontmatter?.[prop];
						return val != null ? String(val) : null;
					};

					// Auto-detect dates: check if values match ISO date/datetime pattern
					const isDateProp = prop === 'mtime' || (!builtins.has(prop) && (() => {
						const sample = files.slice(0, 20);
						return sample.some(f => {
							const val = getSortValue(f);
							return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val);
						});
					})());

					// Default direction: desc for dates/mtime, asc otherwise
					const direction = sortBy.direction ?? (isDateProp ? 'desc' : 'asc');

					files.sort((a, b) => {
						const va = getSortValue(a);
						const vb = getSortValue(b);

						// Nulls always sort to end
						if (va == null && vb == null) return 0;
						if (va == null) return 1;
						if (vb == null) return -1;

						let cmp: number;
						if (typeof va === 'number' && typeof vb === 'number') {
							cmp = va - vb;
						} else {
							cmp = String(va).localeCompare(String(vb));
						}

						return direction === 'desc' ? -cmp : cmp;
					});
				}

				// Apply limit
				const limitedFiles = files.slice(0, limit);

				// Build results with metadata
				const results = limitedFiles.map(f => {
					const tags = this.getFileTags(f);
					const cache = this.app.metadataCache.getFileCache(f);
					const fm = cache?.frontmatter;
					const result: Record<string, any> = {
						path: f.path,
						title: f.basename,
						size: f.stat.size,
						mtime: f.stat.mtime,
					};
					if (tags.length > 0) result.tags = tags;
					if (fm) {
						// Copy frontmatter, excluding Obsidian's internal 'position' key
						const { position, ...frontmatter } = fm;
						if (Object.keys(frontmatter).length > 0) result.frontmatter = frontmatter;
					}
					return result;
				});

				return {
					content: [{
						type: 'text',
						text: JSON.stringify(results, null, 2),
					}],
					isError: false,
				};
			}
		);

		// Register move_file tool (DESTRUCTIVE)
		this.mcpServer.tool(
			'move_file',
			this.getToolDescription('move_file', 'Move or rename a file within the vault'),
			{
				from: z.string().describe('Current path of the file relative to vault root'),
				to: z.string().describe('New path for the file relative to vault root'),
			},
			{
				destructiveHint: true,
			},
			async ({ from, to }) => {
				this.logger.mcp(`move_file called: "${from}" -> "${to}"`);
				const file = this.app.vault.getAbstractFileByPath(from);

				if (!file) {
					this.logger.error(`move_file: source not found: ${from}`);
					throw new Error(`Source file not found: ${from}`);
				}

				// Check if destination already exists
				const existing = this.app.vault.getAbstractFileByPath(to);
				if (existing) {
					this.logger.error(`move_file: destination already exists: ${to}`);
					throw new Error(`Destination already exists: ${to}`);
				}

				// Ensure parent directory exists for the destination
				const destDir = to.substring(0, to.lastIndexOf('/'));
				if (destDir) {
					const parentFolder = this.app.vault.getAbstractFileByPath(destDir);
					if (!parentFolder) {
						// Create parent directories
						this.logger.mcp(`Creating parent directory: ${destDir}`);
						await this.app.vault.createFolder(destDir);
					}
				}

				await this.app.vault.rename(file, to);
				this.logger.mcp(`move_file success: "${from}" -> "${to}"`);

				return {
					content: [
						{
							type: 'text',
							text: `Successfully moved ${from} to ${to}`,
						},
					],
					isError: false,
				};
			}
		);

		// Register create_folder tool (DESTRUCTIVE)
		this.mcpServer.tool(
			'create_folder',
			this.getToolDescription('create_folder', 'Create a folder in the vault'),
			{
				path: z.string().describe('Path to the folder to create, relative to vault root'),
				parents: z.boolean().optional().describe('Create parent folders if they don\'t exist (default: true, like mkdir -p)'),
			},
			{
				destructiveHint: true,
			},
			async ({ path, parents = true }) => {
				this.logger.mcp(`create_folder called: "${path}" (parents: ${parents})`);

				// Check if folder already exists
				const existing = this.app.vault.getAbstractFileByPath(path);
				if (existing) {
					if ((existing as any).children !== undefined) {
						// It's a folder, already exists
						return {
							content: [{ type: 'text', text: `Folder already exists: ${path}` }],
							isError: false,
						};
					} else {
						throw new Error(`A file already exists at path: ${path}`);
					}
				}

				if (parents) {
					// Create parent directories recursively
					const parts = path.split('/').filter(p => p);
					let currentPath = '';
					for (const part of parts) {
						currentPath = currentPath ? `${currentPath}/${part}` : part;
						const folder = this.app.vault.getAbstractFileByPath(currentPath);
						if (!folder) {
							this.logger.mcp(`Creating folder: ${currentPath}`);
							await this.app.vault.createFolder(currentPath);
						}
					}
				} else {
					// Check if parent exists
					const parentPath = path.substring(0, path.lastIndexOf('/'));
					if (parentPath) {
						const parent = this.app.vault.getAbstractFileByPath(parentPath);
						if (!parent) {
							throw new Error(`Parent folder does not exist: ${parentPath}. Use parents: true to create it.`);
						}
					}
					await this.app.vault.createFolder(path);
				}

				this.logger.mcp(`create_folder success: "${path}"`);
				return {
					content: [{ type: 'text', text: `Successfully created folder: ${path}` }],
					isError: false,
				};
			}
		);

		// Register delete tool (DESTRUCTIVE)
		this.mcpServer.tool(
			'delete',
			this.getToolDescription('delete', 'Delete a file or folder from the vault'),
			{
				path: z.string().describe('Path to the file or folder to delete, relative to vault root'),
				recursive: z.boolean().optional().describe('Delete folder contents recursively (default: false, like rm without -r)'),
				trash: z.boolean().optional().describe('Move to system trash instead of permanent delete (default: true, safer)'),
			},
			{
				destructiveHint: true,
			},
			async ({ path, recursive = false, trash = true }) => {
				this.logger.mcp(`delete called: "${path}" (recursive: ${recursive}, trash: ${trash})`);

				const file = this.app.vault.getAbstractFileByPath(path);
				if (!file) {
					throw new Error(`Path not found: ${path}`);
				}

				const isFolder = (file as any).children !== undefined;

				// If it's a non-empty folder and recursive is false, error
				if (isFolder && !recursive) {
					const children = (file as any).children;
					if (children && children.length > 0) {
						throw new Error(`Folder is not empty: ${path}. Use recursive: true to delete contents.`);
					}
				}

				if (trash) {
					// Move to system trash
					await this.app.vault.trash(file, true);
					this.logger.mcp(`delete success (trashed): "${path}"`);
					return {
						content: [{ type: 'text', text: `Successfully moved to trash: ${path}` }],
						isError: false,
					};
				} else {
					// Permanent delete
					await this.app.vault.delete(file, true);
					this.logger.mcp(`delete success (permanent): "${path}"`);
					return {
						content: [{ type: 'text', text: `Successfully deleted: ${path}` }],
						isError: false,
					};
				}
			}
		);

		// Register copy_file tool (DESTRUCTIVE)
		this.mcpServer.tool(
			'copy_file',
			this.getToolDescription('copy_file', 'Copy a file to a new location in the vault'),
			{
				source: z.string().describe('Path to the source file, relative to vault root'),
				destination: z.string().describe('Path for the copy, relative to vault root'),
				overwrite: z.boolean().optional().describe('Overwrite destination if it exists (default: false)'),
			},
			{
				destructiveHint: true,
			},
			async ({ source, destination, overwrite = false }) => {
				this.logger.mcp(`copy_file called: "${source}" -> "${destination}" (overwrite: ${overwrite})`);

				const sourceFile = this.app.vault.getAbstractFileByPath(source);
				if (!sourceFile) {
					throw new Error(`Source file not found: ${source}`);
				}

				if ((sourceFile as any).children !== undefined) {
					throw new Error(`Cannot copy folders, only files: ${source}`);
				}

				// Check if destination exists
				const existing = this.app.vault.getAbstractFileByPath(destination);
				if (existing) {
					if (!overwrite) {
						throw new Error(`Destination already exists: ${destination}. Use overwrite: true to replace it.`);
					}
					// Delete existing file first
					await this.app.vault.delete(existing, true);
				}

				// Ensure parent directory exists for the destination
				const destDir = destination.substring(0, destination.lastIndexOf('/'));
				if (destDir) {
					const parentFolder = this.app.vault.getAbstractFileByPath(destDir);
					if (!parentFolder) {
						// Create parent directories
						this.logger.mcp(`Creating parent directory: ${destDir}`);
						const parts = destDir.split('/').filter(p => p);
						let currentPath = '';
						for (const part of parts) {
							currentPath = currentPath ? `${currentPath}/${part}` : part;
							const folder = this.app.vault.getAbstractFileByPath(currentPath);
							if (!folder) {
								await this.app.vault.createFolder(currentPath);
							}
						}
					}
				}

				await this.app.vault.copy(sourceFile as any, destination);
				this.logger.mcp(`copy_file success: "${source}" -> "${destination}"`);

				return {
					content: [{ type: 'text', text: `Successfully copied ${source} to ${destination}` }],
					isError: false,
				};
			}
		);

		// Register execute_command tool (DESTRUCTIVE)
		this.mcpServer.tool(
			'execute_command',
			this.getToolDescription('execute_command', 'Execute an Obsidian command by ID'),
			{
				commandId: z.string().describe('Command ID to execute (e.g., "editor:toggle-bold")'),
			},
			{
				destructiveHint: true,
			},
			async ({ commandId }) => {
				// Get all available commands
				const commands = (this.app as any).commands.commands;

				if (!commands[commandId]) {
					// List available commands if the requested one doesn't exist
					const availableCommands = Object.keys(commands).slice(0, 20).join(', ');
					throw new Error(`Command not found: ${commandId}. Available commands (first 20): ${availableCommands}...`);
				}

				// Execute the command
				await (this.app as any).commands.executeCommandById(commandId);

				return {
					content: [
						{
							type: 'text',
							text: `Successfully executed command: ${commandId}`,
						},
					],
					isError: false,
				};
			}
		);

		// Register get_orientation tool (READ-ONLY)
		// Always resolves Dataview blocks so the AI sees live data
		this.mcpServer.tool(
			'get_orientation',
			'Load the orientation document to understand vault structure and organizational context',
			{},
			{
				readOnlyHint: true,
			},
			async () => {
				this.logger.mcp('get_orientation called');
				const orientationPath = this.settings.orientationPath;
				this.logger.mcp(`orientationPath from settings: "${orientationPath}"`);

				if (!orientationPath) {
					this.logger.error('No orientation document path configured');
					throw new Error('Orientation document path not configured in settings');
				}

				const file = this.app.vault.getAbstractFileByPath(orientationPath);
				this.logger.mcp(`File lookup result:`, file ? `Found: ${file.path}` : 'NOT FOUND');

				if (!file) {
					this.logger.error(`File not found at path: ${orientationPath}`);
					throw new Error(`Orientation document not found at: ${orientationPath}. Please create this file or update the path in settings.`);
				}

				let content = await this.app.vault.read(file as any);

				// Always resolve Dataview blocks in the orientation document
				content = await this.resolveDataviewBlocks(content);

				// Append vault folder locations
				const folders = [
					`- **Chaos**: \`${this.settings.chaosFolder}\``,
					`- **Life**: \`${this.settings.lifeFolder}\``,
					`- **Order**: \`${this.settings.orderFolder}\``,
					`- **Death**: \`${this.settings.deathFolder}\``,
				].join('\n');
				content += `\n\n---\n\n## Vault Folders\n\n${folders}\n`;

				this.logger.mcp(`Successfully read file, length: ${content.length} chars`);

				return {
					content: [
						{
							type: 'text',
							text: content,
						},
					],
					isError: false,
				};
			}
		);

		// Register dataview_query tool
		// Always registered; checks Dataview availability at call time since
		// Dataview may load after Witness during Obsidian startup.
		this.mcpServer.tool(
			'dataview_query',
			'Execute a Dataview Query Language (DQL) query against the vault. Returns structured data from frontmatter, tags, links, and file metadata. Requires the Dataview plugin.',
			{
				query: z.string().describe('DQL query string (e.g., TABLE tags FROM "topics" SORT file.name)'),
				format: z.enum(['markdown', 'json']).optional().default('markdown').describe('Output format: markdown (rendered table) or json (structured data)'),
			},
			{
				readOnlyHint: true,
			},
			async ({ query, format }) => {
				this.logger.mcp(`dataview_query called: "${query.substring(0, 80)}", format: ${format}`);
				const dvApi = this.getDataviewApi();
				if (!dvApi) {
					return {
						content: [{ type: 'text', text: 'Dataview plugin is not installed or not enabled. Install the Dataview community plugin to use this tool.' }],
						isError: true,
					};
				}

				try {
					if (format === 'json') {
						const result = await dvApi.query(query);
						if (!result.successful) {
							return {
								content: [{ type: 'text', text: `Dataview query failed: ${result.error}` }],
								isError: true,
							};
						}
						// Convert Dataview Link objects to plain strings
						const headers = result.value.headers;
						const values = result.value.values.map((row: any[]) =>
							row.map((cell: any) => {
								if (cell === null || cell === undefined) return null;
								if (typeof cell === 'object' && cell.path) return cell.path; // Link object
								if (Array.isArray(cell)) return cell.map((v: any) => typeof v === 'object' && v.path ? v.path : String(v));
								return cell;
							})
						);
						const jsonOutput = JSON.stringify({ headers, values }, null, 2);
						this.logger.mcp(`dataview_query (json) success: ${headers.length} columns, ${values.length} rows`);
						return {
							content: [{ type: 'text', text: jsonOutput }],
							isError: false,
						};
					} else {
						const result = await dvApi.queryMarkdown(query);
						if (!result.successful) {
							return {
								content: [{ type: 'text', text: `Dataview query failed: ${result.error}` }],
								isError: true,
							};
						}
						this.logger.mcp(`dataview_query (markdown) success, length: ${result.value.length}`);
						return {
							content: [{ type: 'text', text: result.value.trim() }],
							isError: false,
						};
					}
				} catch (err: any) {
					this.logger.error(`dataview_query error: ${err.message}`);
					return {
						content: [{ type: 'text', text: `Dataview query error: ${err.message}` }],
						isError: true,
					};
				}
			}
		);

		// Register get_next_chaos tool (READ-ONLY)
		this.mcpServer.tool(
			'get_next_chaos',
			'Get the next unprocessed chaos item for triage review. Returns full file content by default, or a list of pending items with metadata. ' +
			'Filters out items already triaged (processed, acknowledged, or deferred with a future date). ' +
			'Includes deferred items whose defer date has passed.',
			{
				path: z.string().optional().describe('Limit to a subfolder within the chaos folder. Defaults to the configured chaos folder path.'),
				list: z.boolean().optional().describe('When true, return a list of all pending items with metadata instead of the next single item with full content.'),
			},
			{
				readOnlyHint: true,
			},
			async ({ path: chaosPath, list }) => {
				const defaultChaosPath = this.settings.chaosFolder ? `${this.settings.chaosFolder}/` : '1-chaos/';
				this.logger.mcp(`get_next_chaos called: path=${chaosPath || defaultChaosPath}, list=${!!list}`);
				const basePath = chaosPath || defaultChaosPath;
				const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

				// Get all markdown files under the chaos path
				const allFiles = this.app.vault.getMarkdownFiles();
				const chaosFiles = allFiles.filter(f => f.path.startsWith(basePath));

				if (chaosFiles.length === 0) {
					return {
						content: [{ type: 'text', text: JSON.stringify({ items: [], queue: { total: 0, in_path: 0 }, message: `No markdown files found in ${basePath}` }) }],
						isError: false,
					};
				}

				// Filter to untriaged items
				const pending: { file: TFile; date: string | null; frontmatter: Record<string, any> }[] = [];
				for (const file of chaosFiles) {
					const cache = this.app.metadataCache.getFileCache(file);
					const fm = cache?.frontmatter;
					const triageValue = fm?.triage;

					if (triageValue === undefined || triageValue === null || triageValue === '') {
						// No triage field — untriaged
						const dateStr = fm?.created || fm?.date || null;
						pending.push({ file, date: dateStr ? String(dateStr) : null, frontmatter: fm ? { ...fm } : {} });
					} else if (typeof triageValue === 'string' && triageValue.startsWith('deferred ')) {
						// Deferred — check if defer date has passed
						const deferDate = triageValue.replace('deferred ', '').trim();
						if (deferDate <= today) {
							const dateStr = fm?.created || fm?.date || null;
							pending.push({ file, date: dateStr ? String(dateStr) : null, frontmatter: fm ? { ...fm } : {} });
						}
					}
					// Otherwise: processed (date), acknowledged — skip
				}

				// Sort by date descending (newest first), falling back to mtime
				pending.sort((a, b) => {
					const dateA = a.date || new Date(a.file.stat.mtime).toISOString().slice(0, 10);
					const dateB = b.date || new Date(b.file.stat.mtime).toISOString().slice(0, 10);
					return dateB.localeCompare(dateA);
				});

				// Count total untriaged across all chaos
				const allChaosFiles = allFiles.filter(f => f.path.startsWith(defaultChaosPath));
				let totalPending = 0;
				for (const file of allChaosFiles) {
					const cache = this.app.metadataCache.getFileCache(file);
					const triageValue = cache?.frontmatter?.triage;
					if (triageValue === undefined || triageValue === null || triageValue === '') {
						totalPending++;
					} else if (typeof triageValue === 'string' && triageValue.startsWith('deferred ') && triageValue.replace('deferred ', '').trim() <= today) {
						totalPending++;
					}
				}

				const queue = { total: totalPending, in_path: pending.length };

				if (pending.length === 0) {
					return {
						content: [{ type: 'text', text: JSON.stringify({ items: [], queue, message: `No untriaged items in ${basePath}` }) }],
						isError: false,
					};
				}

				if (list) {
					// List mode — compact: path, title, date only, max 10 items
					const items = pending.slice(0, 10).map(p => ({
						path: p.file.path,
						title: p.frontmatter.title || p.file.basename,
						date: p.date,
					}));
					return {
						content: [{ type: 'text', text: JSON.stringify({ items, queue }) }],
						isError: false,
					};
				} else {
					// Single mode — return full content of next item
					const next = pending[0];
					const fileContent = await this.app.vault.read(next.file);
					const { position, ...fm } = next.frontmatter;
					return {
						content: [{
							type: 'text',
							text: JSON.stringify({
								path: next.file.path,
								content: fileContent,
								frontmatter: Object.keys(fm).length > 0 ? fm : undefined,
								queue,
							}, null, 2),
						}],
						isError: false,
					};
				}
			}
		);

		// Register mark_triage tool (DESTRUCTIVE)
		this.mcpServer.tool(
			'mark_triage',
			'Record a triage decision for a chaos item. Sets the triage frontmatter field — no need to manually parse or edit YAML. ' +
			'Actions: "processed" (knowledge extracted, marks with today\'s date), "deferred" (come back later, requires defer_until date), ' +
			'"acknowledged" (reviewed, no action needed).',
			{
				path: z.string().describe('Path to the chaos file to triage'),
				action: z.enum(['processed', 'deferred', 'acknowledged']).describe('Triage action: processed, deferred, or acknowledged'),
				defer_until: z.string().optional().describe('Required for "deferred" action. Date string YYYY-MM-DD for when to resurface the item.'),
			},
			{
				destructiveHint: true,
			},
			async ({ path: filePath, action, defer_until }) => {
				this.logger.mcp(`mark_triage called: path=${filePath}, action=${action}, defer_until=${defer_until || 'n/a'}`);

				if (action === 'deferred' && !defer_until) {
					throw new Error('defer_until date is required when action is "deferred". Provide a YYYY-MM-DD date.');
				}

				const file = this.app.vault.getAbstractFileByPath(filePath);
				if (!file || !(file instanceof TFile)) {
					throw new Error(`File not found: ${filePath}`);
				}

				// Determine triage value
				let triageValue: string;
				if (action === 'processed') {
					triageValue = new Date().toISOString().slice(0, 10); // Today's date
				} else if (action === 'deferred') {
					triageValue = `deferred ${defer_until}`;
				} else {
					triageValue = 'acknowledged';
				}

				// Use Obsidian's processFrontMatter for safe frontmatter updates
				await this.app.fileManager.processFrontMatter(file, (fm) => {
					fm.triage = triageValue;
				});

				this.logger.mcp(`mark_triage: set triage=${triageValue} on ${filePath}`);

				return {
					content: [{
						type: 'text',
						text: JSON.stringify({
							path: filePath,
							action,
							triage: triageValue,
						}),
					}],
					isError: false,
				};
			}
		);

		// Register custom commands as MCP tools
		for (const customCmd of this.settings.customCommands) {
			if (!customCmd.enabled) continue;

			this.mcpServer.tool(
				customCmd.name,
				customCmd.description,
				{},
				{
					readOnlyHint: customCmd.readOnly,
					destructiveHint: !customCmd.readOnly,
				},
				async () => {
					const commands = (this.app as any).commands.commands;
					if (!commands[customCmd.commandId]) {
						throw new Error(`Obsidian command not found: ${customCmd.commandId}`);
					}

					await (this.app as any).commands.executeCommandById(customCmd.commandId);

					return {
						content: [
							{
								type: 'text',
								text: `Successfully executed ${customCmd.name}`,
							},
						],
						isError: false,
					};
				}
			);
		}

		// Register fallback tools if enabled
		if (this.settings.enableCommandFallback) {
			// list_all_commands tool (READ-ONLY)
			this.mcpServer.tool(
				'list_all_commands',
				'List all available Obsidian commands with their IDs',
				{},
				{
					readOnlyHint: true,
				},
				async () => {
					const commands = (this.app as any).commands.commands;
					const commandList = Object.entries(commands).map(([id, cmd]: [string, any]) => ({
						id,
						name: cmd.name || id,
					}));

					const summary = `Total available commands: ${commandList.length}`;
					const resultText = commandList.map(c => `${c.id} - ${c.name}`).join('\n');

					return {
						content: [
							{
								type: 'text',
								text: `${summary}\n\n${resultText}`,
							},
						],
						isError: false,
					};
				}
			);

			// execute_any_command tool (DESTRUCTIVE)
			this.mcpServer.tool(
				'execute_any_command',
				'Execute ANY Obsidian command by ID (use with caution - no restrictions)',
				{
					commandId: z.string().describe('Command ID to execute'),
				},
				{
					destructiveHint: true,
				},
				async ({ commandId }) => {
					const commands = (this.app as any).commands.commands;
					if (!commands[commandId]) {
						throw new Error(`Command not found: ${commandId}. Use list_all_commands to see available commands.`);
					}

					await (this.app as any).commands.executeCommandById(commandId);

					return {
						content: [
							{
								type: 'text',
								text: `Successfully executed command: ${commandId}`,
							},
						],
						isError: false,
					};
				}
			);
		}

	}

	/** Common English stop words that pollute QPS scoring without adding meaning. */
	private static readonly STOP_WORDS = new Set([
		'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
		'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
		'should', 'can', 'could', 'may', 'might', 'must', 'of', 'in', 'to',
		'for', 'with', 'on', 'at', 'by', 'from', 'as', 'into', 'through',
		'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'if', 'then',
		'it', 'its', 'this', 'that', 'these', 'those',
		'he', 'him', 'his', 'she', 'her', 'we', 'us', 'our', 'they', 'them', 'their',
		'i', 'me', 'my', 'you', 'your', 'what', 'which', 'who', 'whom',
	]);

	/**
	 * Parse quoted phrases from a search query.
	 * Returns the clean query (without quotes) and extracted phrases.
	 */
	private parseQuotedPhrases(query: string): { cleanQuery: string; phrases: string[] } {
		const phrases: string[] = [];
		const cleanQuery = query.replace(/"([^"]+)"/g, (_, phrase) => {
			phrases.push(phrase);
			return phrase; // Keep the words in the query for QPS scoring
		});
		return { cleanQuery: cleanQuery.trim(), phrases };
	}

	/**
	 * Strip stop words from query to improve QPS scoring.
	 * Stop words like "the" pollute QPS results without adding search value.
	 * Returns empty string if all words are stop words (caller should fall back to original).
	 */
	stripStopWords(query: string): string {
		return query
			.split(/\s+/)
			.filter(w => !WitnessPlugin.STOP_WORDS.has(w.toLowerCase()))
			.join(' ')
			.trim();
	}

	/**
	 * Boost search results that contain exact phrase matches.
	 * Phrase-matching results appear first, preserving score order within each group.
	 * Uses full chunk content (not just snippet) for matching.
	 */
	private boostByPhrases(results: SearchResult[], phrases: string[]): SearchResult[] {
		const phraseMatches: SearchResult[] = [];
		const rest: SearchResult[] = [];

		for (const r of results) {
			const text = (r.content || r.snippet || '').toLowerCase();
			const title = (r.title || '').toLowerCase();
			const searchText = text + ' ' + title;
			const allMatch = phrases.every(p => searchText.includes(p.toLowerCase()));

			if (allMatch) {
				phraseMatches.push(r);
			} else {
				rest.push(r);
			}
		}

		return [...phraseMatches, ...rest];
	}

	/**
	 * Unified search method used by both MCP tool and sidebar.
	 * Handles phrase parsing, stop word stripping, over-fetching, and phrase boosting.
	 */
	async search(query: string, options: {
		mode?: 'hybrid' | 'vector' | 'fulltext';
		limit?: number;
		minScore?: number;
		paths?: string[];
		tags?: string[];
		rerank?: boolean;
	} = {}): Promise<SearchResult[]> {
		if (!this.vectorStore) {
			throw new Error('Search index not available');
		}

		const { mode = 'hybrid', limit = 10, minScore, paths, tags, rerank = false } = options;

		// Parse quoted phrases for post-boost
		const { cleanQuery, phrases } = this.parseQuotedPhrases(query);

		// Determine how many candidates to fetch from stage 1
		const shouldRerank = rerank && this.settings.enableReranking && this.settings.rerankModel && this.ollamaProvider;
		const rerankCandidateLimit = 30;
		let effectiveLimit: number;
		if (shouldRerank) {
			effectiveLimit = rerankCandidateLimit;
		} else if (phrases.length > 0) {
			effectiveLimit = Math.max(limit * 3, 30);
		} else {
			effectiveLimit = limit;
		}

		// Strip stop words to improve QPS scoring
		const oramaQuery = this.stripStopWords(cleanQuery || query) || cleanQuery || query;

		this.logger.info(`Search (${mode}${shouldRerank ? '+rerank' : ''}) for: "${query}" → orama: "${oramaQuery}"${phrases.length > 0 ? ` [phrases: ${phrases.join(', ')}]` : ''}`);

		let results = await this.vectorStore.search(oramaQuery, {
			mode,
			limit: effectiveLimit,
			minScore,
			paths,
			tags,
		});

		// Boost results containing exact phrase matches to the top
		if (phrases.length > 0 && results.length > 0) {
			results = this.boostByPhrases(results, phrases);
		}

		// Stage 2: Re-rank with LLM if enabled
		if (shouldRerank && results.length > 1) {
			try {
				const candidates = results.map((r, i) => ({
					index: i,
					content: r.content || r.snippet || '',
				}));

				const reranked = await this.ollamaProvider!.rerank(
					this.settings.rerankModel,
					query,
					candidates,
					limit,
				);

				// Map re-ranked scores back onto results
				const rerankedResults: SearchResult[] = [];
				for (const { index, score } of reranked) {
					if (index >= 0 && index < results.length) {
						rerankedResults.push({
							...results[index],
							score: score / 10, // normalise 0-10 to 0-1
						});
					}
				}

				if (rerankedResults.length > 0) {
					this.logger.info(`Reranked ${results.length} → ${rerankedResults.length} results`);
					return rerankedResults;
				}
				// Fall through to normal results if reranking produced nothing
			} catch (err) {
				this.logger.error('Reranking failed, using original results', err);
			}
		}

		return results.slice(0, limit);
	}

	private async handleMCPRequest(req: IncomingMessage, res: ServerResponse) {
		this.logger.mcp(`${req.method} ${req.url}`);
		this.logger.mcp(`Headers:`, JSON.stringify({
			'mcp-session-id': req.headers['mcp-session-id'],
			'content-type': req.headers['content-type'],
			'accept': req.headers['accept'],
		}));
		this.logger.mcp(`Active sessions: ${this.transports.size}`, Array.from(this.transports.keys()));

		if (!this.mcpServer) {
			this.logger.error('Server not initialized!');
			res.writeHead(500);
			res.end('MCP server not initialized');
			return;
		}

		try {
			// Get session ID from header
			const sessionId = req.headers['mcp-session-id'] as string | undefined;

			// For GET requests (SSE), no body to parse
			let body: any = undefined;
			if (req.method === 'POST') {
				const bodyBuffer = await getRawBody(req);
				body = JSON.parse(bodyBuffer.toString());
				this.logger.mcp(`POST body method: ${body?.method}, id: ${body?.id}`);
			} else {
				this.logger.mcp(`GET request (SSE stream) for session: ${sessionId}`);
			}

			// Check if this is an initialize request
			const isInitialize = body?.method === 'initialize';

			// New session - create transport
			if (!sessionId && isInitialize) {
				this.logger.mcp('Creating new session (initialize request)');
				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => `session-${Date.now()}-${Math.random()}`,
					onsessioninitialized: (newSessionId) => {
						this.logger.mcp(`Session initialized: ${newSessionId}`);
						this.transports.set(newSessionId, transport);
					},
				});

				// Connect transport to server (only once per transport)
				this.logger.mcp('Connecting transport to MCP server...');
				await this.mcpServer.connect(transport);
				this.logger.mcp('Transport connected, handling initialize request...');

				// Handle the initialize request
				await transport.handleRequest(req, res, body);
				this.logger.mcp('Initialize request handled');
				return;
			}

			// Existing session - reuse transport
			if (sessionId && this.transports.has(sessionId)) {
				this.logger.mcp(`Using existing session: ${sessionId}`);
				const transport = this.transports.get(sessionId)!;
				await transport.handleRequest(req, res, body);
				this.logger.mcp(`Request handled for session: ${sessionId}`);
				return;
			}

			// Unknown session
			this.logger.error(`Unknown/expired session: ${sessionId}`);
			this.logger.error(`Available sessions:`, Array.from(this.transports.keys()));
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid or expired session' }));
		} catch (err) {
			this.logger.error('Error handling request:', err);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Internal server error' }));
		}
	}

	stopMCPServer() {
		// Close all transports
		for (const [sessionId, transport] of this.transports) {
			this.logger.info(`Closing session: ${sessionId}`);
			transport.close();
		}
		this.transports.clear();

		// Close MCP server
		if (this.mcpServer) {
			this.mcpServer.close();
			this.mcpServer = null;
		}

		// Close HTTP server
		if (this.httpServer) {
			this.httpServer.close(() => {
				this.logger.info('MCP server stopped');
			});
			this.httpServer = null;
		}
	}

	/**
	 * Validate authentication via query parameter or Authorization header
	 * Accepts: ?token=xxx or Authorization: Bearer xxx
	 */
	private validateAuth(req: IncomingMessage): boolean {
		const expectedToken = this.settings.authToken;

		if (!expectedToken) {
			this.logger.mcp('Auth enabled but no token configured - denying access');
			return false;
		}

		// Check query parameter first
		const url = new URL(req.url || '', `http://localhost:${this.settings.mcpPort}`);
		const queryToken = url.searchParams.get('token');
		if (queryToken) {
			if (queryToken === expectedToken) {
				this.logger.mcp('Token validated via query parameter');
				return true;
			}
			this.logger.mcp('Invalid token in query parameter');
			return false;
		}

		// Check Authorization header
		const authHeader = req.headers['authorization'];
		if (authHeader) {
			const parts = authHeader.split(' ');
			if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
				if (parts[1] === expectedToken) {
					this.logger.mcp('Token validated via Authorization header');
					return true;
				}
				this.logger.mcp('Invalid token in Authorization header');
				return false;
			}
			this.logger.mcp('Invalid Authorization header format');
			return false;
		}

		this.logger.mcp('No token provided (query param or header)');
		return false;
	}

	/**
	 * Get the path where we store the cloudflared binary
	 */
	private getCloudflaredBinPath(): string {
		// Store cloudflared binary in a dedicated location in the user's home directory
		// This avoids issues with Obsidian's bundled environment
		const binDir = path.join(os.homedir(), '.witness', 'bin');
		const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
		return path.join(binDir, binName);
	}

	/**
	 * Ensure cloudflared binary is installed
	 */
	private async ensureCloudflaredInstalled(): Promise<boolean> {
		const binPath = this.getCloudflaredBinPath();
		const binDir = path.dirname(binPath);

		// Create directory if it doesn't exist
		if (!fs.existsSync(binDir)) {
			this.logger.info(`Creating cloudflared bin directory: ${binDir}`);
			fs.mkdirSync(binDir, { recursive: true });
		}

		// Check if binary already exists
		if (fs.existsSync(binPath)) {
			this.logger.info(`cloudflared binary found at: ${binPath}`);
			useCloudflared(binPath);
			return true;
		}

		// Install cloudflared
		this.logger.info(`Installing cloudflared to: ${binPath}`);
		new Notice('Installing cloudflared... This may take a moment.');

		try {
			await installCloudflared(binPath);
			this.logger.info('cloudflared installed successfully');
			useCloudflared(binPath);
			return true;
		} catch (err: any) {
			this.logger.error('Failed to install cloudflared:', err.message);
			new Notice(`Failed to install cloudflared: ${err.message}`);
			return false;
		}
	}

	/**
	 * Start a Cloudflare Tunnel to expose the MCP server
	 * Supports both Quick Tunnels (ephemeral URL) and Named Tunnels (permanent URL with token)
	 */
	async startTunnel() {
		if (this.tunnelProcess) {
			this.logger.info('Tunnel already running');
			return;
		}

		if (!this.httpServer) {
			this.logger.error('Cannot start tunnel: MCP server not running');
			return;
		}

		// Primary host check: only start tunnel on the designated machine
		const currentHost = os.hostname();
		if (this.settings.tunnelPrimaryHost && this.settings.tunnelPrimaryHost !== currentHost) {
			this.logger.info(`Tunnel skipped: this machine (${currentHost}) is not the primary host (${this.settings.tunnelPrimaryHost})`);
			this.tunnelStatus = 'disconnected';
			return;
		}

		const isNamed = this.settings.tunnelType === 'named';

		this.tunnelStatus = 'connecting';
		this.logger.info(`Starting Cloudflare ${isNamed ? 'Named' : 'Quick'} Tunnel...`);
		if (this.tunnelStatusCallback) {
			this.tunnelStatusCallback('connecting', null);
		}

		// Validate named tunnel has a token
		if (isNamed && !this.settings.tunnelToken) {
			this.logger.error('Cannot start named tunnel: no token configured');
			this.tunnelStatus = 'error';
			new Notice('Named tunnel requires a token. Please add your Cloudflare tunnel token in settings.');
			if (this.tunnelStatusCallback) {
				this.tunnelStatusCallback('error', null);
			}
			return;
		}

		// Ensure cloudflared is installed
		const installed = await this.ensureCloudflaredInstalled();
		if (!installed) {
			this.tunnelStatus = 'error';
			if (this.tunnelStatusCallback) {
				this.tunnelStatusCallback('error', null);
			}
			return;
		}

		try {
			if (isNamed) {
				// Named tunnel - uses pre-configured token from Cloudflare dashboard
				this.logger.info('Starting named tunnel with token...');
				this.tunnelProcess = Tunnel.withToken(this.settings.tunnelToken);

				// Named tunnels don't emit a 'url' event (that's only for trycloudflare.com)
				// The URL is already known from the dashboard configuration
				// We mark as connected when the first connection is established
				this.tunnelProcess.once('connected', async (connection: { id: string; ip: string; location: string }) => {
					this.logger.info(`Named tunnel connected to ${connection.location} (${connection.ip})`);
					this.tunnelStatus = 'connected';

					if (this.tunnelStatusCallback) {
						this.tunnelStatusCallback('connected', this.settings.tunnelUrl);
					}

					new Notice('Named tunnel connected!');
				});
			} else {
				// Quick tunnel - gets a random trycloudflare.com URL
				const localUrl = `http://localhost:${this.settings.mcpPort}`;
				this.tunnelProcess = Tunnel.quick(localUrl);

				// Listen for the URL event (only fires for quick tunnels)
				this.tunnelProcess.once('url', async (url: string) => {
					this.logger.info(`Cloudflare Tunnel URL: ${url}`);
					this.logger.info(`MCP endpoint available at: ${url}/mcp`);
					this.settings.tunnelUrl = url;
					this.tunnelStatus = 'connected';
					await this.saveSettings();

					new Notice(`Tunnel connected: ${url}/mcp`);

					if (this.tunnelStatusCallback) {
						this.tunnelStatusCallback('connected', url);
					}
				});

				// Listen for connected event
				this.tunnelProcess.once('connected', (connection: { id: string; ip: string; location: string }) => {
					this.logger.info(`Tunnel connected to ${connection.location} (${connection.ip})`);
				});
			}

			// Handle tunnel errors (both types)
			this.tunnelProcess.on('error', (err: Error) => {
				this.logger.error('Tunnel error:', err.message);
				this.tunnelStatus = 'error';
				if (this.tunnelStatusCallback) {
					this.tunnelStatusCallback('error', null);
				}
			});

			// Handle tunnel exit (both types)
			this.tunnelProcess.on('exit', (code: number | null) => {
				this.logger.info(`Tunnel process exited with code: ${code}`);
				this.tunnelProcess = null;
				this.tunnelStatus = 'disconnected';
				if (this.tunnelStatusCallback) {
					this.tunnelStatusCallback('disconnected', null);
				}
			});

		} catch (err) {
			this.logger.error('Failed to start tunnel:', err);
			this.tunnelStatus = 'error';
			this.tunnelProcess = null;
			if (this.tunnelStatusCallback) {
				this.tunnelStatusCallback('error', null);
			}
		}
	}

	/**
	 * Stop the Cloudflare tunnel
	 */
	stopTunnel() {
		if (!this.tunnelProcess) {
			return;
		}

		this.logger.info('Stopping Cloudflare Tunnel...');
		try {
			this.tunnelProcess.stop();
			this.tunnelProcess = null;
			this.tunnelStatus = 'disconnected';
			this.settings.tunnelUrl = null;
			this.logger.info('Tunnel stopped');
		} catch (err) {
			this.logger.error('Error stopping tunnel:', err);
		}
	}

	/**
	 * Regenerate the tunnel (stop and restart)
	 */
	async regenerateTunnel() {
		this.logger.info('Regenerating tunnel...');
		this.stopTunnel();
		// Small delay to ensure clean shutdown
		await new Promise(resolve => setTimeout(resolve, 500));
		await this.startTunnel();
	}

	/**
	 * Get current tunnel status
	 */
	getTunnelStatus(): { status: string; url: string | null } {
		return {
			status: this.tunnelStatus,
			url: this.settings.tunnelUrl,
		};
	}

	/**
	 * Set a callback to be notified of tunnel status changes
	 */
	onTunnelStatusChange(callback: (status: string, url: string | null) => void) {
		this.tunnelStatusCallback = callback;
	}
}

// File picker modal with search functionality
class FileSuggestModal extends SuggestModal<string> {
	files: string[];
	onChoose: (file: string) => void;

	constructor(app: App, onChoose: (file: string) => void) {
		super(app);
		this.files = app.vault.getMarkdownFiles().map(f => f.path);
		this.onChoose = onChoose;
	}

	getSuggestions(query: string): string[] {
		const lowerQuery = query.toLowerCase();
		return this.files.filter(file =>
			file.toLowerCase().includes(lowerQuery)
		);
	}

	renderSuggestion(file: string, el: HTMLElement) {
		el.createEl('div', {text: file});
	}

	onChooseSuggestion(file: string, evt: MouseEvent | KeyboardEvent) {
		this.onChoose(file);
	}
}

// Folder picker modal for exclusion settings
class FolderSuggestModal extends SuggestModal<string> {
	folders: string[];
	onChoose: (folder: string) => void;

	constructor(app: App, onChoose: (folder: string) => void) {
		super(app);
		this.folders = app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder)
			.map(f => f.path)
			.filter(p => p.length > 0)
			.sort();
		this.onChoose = onChoose;
	}

	getSuggestions(query: string): string[] {
		const lowerQuery = query.toLowerCase();
		return this.folders.filter(folder =>
			folder.toLowerCase().includes(lowerQuery)
		);
	}

	renderSuggestion(folder: string, el: HTMLElement) {
		el.createEl('div', { text: folder });
	}

	onChooseSuggestion(folder: string, evt: MouseEvent | KeyboardEvent) {
		this.onChoose(folder);
	}
}

// Command picker modal with search functionality
class CommandSuggestModal extends SuggestModal<{id: string, name: string}> {
	commands: {id: string, name: string}[];
	onChoose: (command: {id: string, name: string}) => void;

	constructor(app: App, commands: {id: string, name: string}[], onChoose: (command: {id: string, name: string}) => void) {
		super(app);
		this.commands = commands;
		this.onChoose = onChoose;
	}

	getSuggestions(query: string): {id: string, name: string}[] {
		const lowerQuery = query.toLowerCase();
		return this.commands.filter(cmd =>
			cmd.name.toLowerCase().includes(lowerQuery) ||
			cmd.id.toLowerCase().includes(lowerQuery)
		);
	}

	renderSuggestion(command: {id: string, name: string}, el: HTMLElement) {
		el.createEl('div', {text: command.name});
		el.createEl('small', {text: command.id, cls: 'setting-item-description'});
	}

	onChooseSuggestion(command: {id: string, name: string}, evt: MouseEvent | KeyboardEvent) {
		this.onChoose(command);
	}
}

// Edit modal for custom commands
class CommandEditModal extends Modal {
	cmd: CustomCommandConfig;
	plugin: WitnessPlugin;
	onSave: () => void;
	commandIdEl: HTMLElement;
	toolNameInput: HTMLInputElement;
	descriptionInput: HTMLTextAreaElement;
	readOnlyToggle: any;

	constructor(app: App, plugin: WitnessPlugin, cmd: CustomCommandConfig, onSave: () => void) {
		super(app);
		this.plugin = plugin;
		this.cmd = cmd;
		this.onSave = onSave;
	}

	onOpen() {
		const {contentEl} = this;

		contentEl.createEl('h2', {text: 'Edit Custom Command'});

		// Command picker
		new Setting(contentEl)
			.setName('Obsidian Command')
			.setDesc('Click to search and select an Obsidian command')
			.addButton(button => {
				const commands = (this.app as any).commands.commands;
				const commandList = Object.entries(commands).map(([id, cmd]: [string, any]) => ({
					id,
					name: cmd.name || id
				}));

				// Display current selection
				const currentCmd = commandList.find(c => c.id === this.cmd.commandId);
				button.setButtonText(currentCmd ? currentCmd.name : 'Select Command');

				button.onClick(() => {
					new CommandSuggestModal(this.app, commandList, (selected) => {
						this.cmd.commandId = selected.id;
						// Auto-generate tool name from command ID if empty or default
						if (!this.cmd.name || this.cmd.name === 'new_command') {
							this.cmd.name = selected.id.replace(/[:-]/g, '_');
							this.toolNameInput.value = this.cmd.name;
						}
						button.setButtonText(selected.name);
					}).open();
				});
			});

		// Tool name
		new Setting(contentEl)
			.setName('Tool Name')
			.setDesc('Name for this MCP tool (e.g., toggle_bold)')
			.addText(text => {
				this.toolNameInput = text.inputEl;
				text
					.setPlaceholder('tool_name')
					.setValue(this.cmd.name)
					.onChange((value) => {
						this.cmd.name = value;
					});
			});

		// Description
		new Setting(contentEl)
			.setName('Description')
			.setDesc('Description shown to AI assistants')
			.addTextArea(text => {
				this.descriptionInput = text.inputEl;
				text
					.setPlaceholder('Command description')
					.setValue(this.cmd.description)
					.onChange((value) => {
						this.cmd.description = value;
					});
				text.inputEl.rows = 3;
				text.inputEl.cols = 50;
			});

		// Read-only toggle
		new Setting(contentEl)
			.setName('Read-only (safe)')
			.setDesc('Mark this command as read-only (non-destructive)')
			.addToggle(toggle => {
				this.readOnlyToggle = toggle;
				toggle
					.setValue(this.cmd.readOnly)
					.onChange((value) => {
						this.cmd.readOnly = value;
					});
			});

		// Buttons
		const buttonContainer = contentEl.createDiv({cls: 'modal-button-container'});
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '10px';
		buttonContainer.style.marginTop = '20px';

		const cancelButton = buttonContainer.createEl('button', {text: 'Cancel'});
		cancelButton.onclick = () => this.close();

		const saveButton = buttonContainer.createEl('button', {text: 'Save', cls: 'mod-cta'});
		saveButton.onclick = async () => {
			await this.plugin.saveSettings();
			this.onSave();
			this.close();
		};
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

type WitnessTab = 'server' | 'commands' | 'remote' | 'search';

class WitnessSettingTab extends PluginSettingTab {
	plugin: WitnessPlugin;
	private activeTab: WitnessTab = 'server';
	private embeddingModelsCache: EmbeddingModelInfo[] | null = null;
	private chatModelsCache: Array<{ name: string; parameterSize: string; family: string }> | null = null;

	constructor(app: App, plugin: WitnessPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		containerEl.createEl('h2', {text: 'Witness Settings'});

		// Tab header
		const header = containerEl.createDiv({cls: 'witness-tab-header'});
		const tabs: {id: WitnessTab; label: string}[] = [
			{id: 'server', label: 'Server'},
			{id: 'commands', label: 'Custom Commands'},
			{id: 'remote', label: 'Remote Access'},
			{id: 'search', label: 'Semantic Search'},
		];
		for (const tab of tabs) {
			const btn = header.createEl('button', {
				text: tab.label,
				cls: `witness-tab-button${tab.id === this.activeTab ? ' witness-tab-active' : ''}`,
			});
			btn.addEventListener('click', () => {
				this.activeTab = tab.id;
				this.display();
			});
		}

		// Tab panes
		const panes: Record<WitnessTab, HTMLElement> = {
			server: containerEl.createDiv({cls: 'witness-tab-content'}),
			commands: containerEl.createDiv({cls: 'witness-tab-content'}),
			remote: containerEl.createDiv({cls: 'witness-tab-content'}),
			search: containerEl.createDiv({cls: 'witness-tab-content'}),
		};

		this.renderServerTab(panes.server);
		this.renderCommandsTab(panes.commands);
		this.renderRemoteTab(panes.remote);
		this.renderSearchTab(panes.search);

		// Show active pane
		panes[this.activeTab].addClass('witness-tab-visible');
	}

	// ===== SERVER TAB =====
	private renderServerTab(pane: HTMLElement): void {
		new SettingGroup(pane)
			.setHeading('Basic Settings')
			.addSetting(s => s
				.setName('Enable MCP Server')
				.setDesc('Start the MCP server to allow AI assistants to interact with your vault')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.mcpEnabled)
					.onChange(async (value) => {
						this.plugin.settings.mcpEnabled = value;
						await this.plugin.saveSettings();
						if (value) {
							await this.plugin.startMCPServer();
						} else {
							this.plugin.stopMCPServer();
						}
					})))
			.addSetting(s => s
				.setName('MCP Server Port')
				.setDesc('Port number for the MCP server (default: 3000)')
				.addText(text => text
					.setPlaceholder('3000')
					.setValue(this.plugin.settings.mcpPort.toString())
					.onChange(async (value) => {
						const port = parseInt(value);
						if (!isNaN(port) && port > 0 && port < 65536) {
							this.plugin.settings.mcpPort = port;
							await this.plugin.saveSettings();
						}
					})));

		new SettingGroup(pane)
			.setHeading('Server Configuration')
			.addSetting(s => {
				s.setName('Server Instructions')
				 .setDesc('Instructions shown to AI assistants about how to use this MCP server');

				let instructionsTextArea: HTMLTextAreaElement;
				s.addTextArea(text => {
					instructionsTextArea = text.inputEl;
					text.setPlaceholder('Enter server instructions')
						.setValue(this.plugin.settings.serverInstructions)
						.onChange(async (value) => {
							this.plugin.settings.serverInstructions = value;
							await this.plugin.saveSettings();
						});
					text.inputEl.rows = 4;
					text.inputEl.cols = 50;
				});
				s.addButton(button => button
					.setIcon('reset')
					.setTooltip('Reset to default')
					.onClick(async () => {
						this.plugin.settings.serverInstructions = DEFAULT_SETTINGS.serverInstructions;
						instructionsTextArea.value = DEFAULT_SETTINGS.serverInstructions;
						await this.plugin.saveSettings();
					}));
			})
			.addSetting(s => {
				s.setName('Orientation Document')
				 .setDesc('Path to a file that helps AI understand your vault structure');
				s.addButton(button => {
					button.setButtonText(this.plugin.settings.orientationPath || 'Select file');
					button.onClick(() => {
						new FileSuggestModal(this.app, async (selectedFile) => {
							this.plugin.settings.orientationPath = selectedFile;
							button.setButtonText(selectedFile);
							await this.plugin.saveSettings();
						}).open();
					});
				});
			});

		// Vault folder paths
		const folderSettings: { key: keyof WitnessSettings; label: string; desc: string }[] = [
			{ key: 'chaosFolder', label: 'Chaos Folder', desc: 'Unprocessed incoming information (articles, notes, clippings)' },
			{ key: 'lifeFolder', label: 'Life Folder', desc: 'Living documents and active references' },
			{ key: 'orderFolder', label: 'Order Folder', desc: 'Structured, processed knowledge' },
			{ key: 'deathFolder', label: 'Death Folder', desc: 'Archived and retired content' },
		];

		const foldersGroup = new SettingGroup(pane)
			.setHeading('Vault Folders');

		for (const { key, label, desc } of folderSettings) {
			foldersGroup.addSetting(s => {
				s.setName(label)
				 .setDesc(desc);
				s.addButton(button => {
					button.setButtonText((this.plugin.settings[key] as string) || 'Select folder');
					button.onClick(() => {
						new FolderSuggestModal(this.app, async (folder) => {
							(this.plugin.settings[key] as string) = folder;
							button.setButtonText(folder);
							await this.plugin.saveSettings();
						}).open();
					});
				});
			});
		}
	}

	// ===== CUSTOM COMMANDS TAB =====
	private renderCommandsTab(pane: HTMLElement): void {
		pane.createEl('p', {
			text: 'Expose specific Obsidian commands as MCP tools with custom names and descriptions.',
			cls: 'setting-item-description'
		});

		new Setting(pane)
			.setName('Add Custom Command')
			.setDesc('Add a new custom command to expose as an MCP tool')
			.addButton(button => button
				.setButtonText('Add Command')
				.setCta()
				.onClick(async () => {
					this.plugin.settings.customCommands.push({
						name: 'new_command',
						description: 'New command description',
						commandId: '',
						readOnly: false,
						enabled: true
					});
					await this.plugin.saveSettings();
					this.display();
				}));

		this.plugin.settings.customCommands.forEach((cmd, index) => {
			const setting = new Setting(pane);

			const toolNameText = cmd.readOnly ? cmd.name : `⚠️ ${cmd.name}`;
			setting.setName(toolNameText);

			const commands = (this.app as any).commands.commands;
			const commandName = cmd.commandId && commands[cmd.commandId]
				? commands[cmd.commandId].name
				: 'No command selected';
			setting.setDesc(commandName);

			setting.addButton(button => button
				.setButtonText('Edit')
				.onClick(() => {
					new CommandEditModal(this.app, this.plugin, cmd, () => {
						this.display();
					}).open();
				}));

			const toggleContainer = setting.controlEl.createDiv();
			toggleContainer.style.display = 'flex';
			toggleContainer.style.alignItems = 'center';
			toggleContainer.style.gap = '5px';

			const toggleLabel = toggleContainer.createSpan({text: 'Enabled'});
			toggleLabel.style.fontSize = '0.9em';
			toggleLabel.style.color = 'var(--text-muted)';

			setting.addToggle(toggle => {
				toggle
					.setValue(cmd.enabled)
					.setTooltip(cmd.enabled ? 'Click to disable' : 'Click to enable')
					.onChange(async (value) => {
						cmd.enabled = value;
						toggle.setTooltip(value ? 'Click to disable' : 'Click to enable');
						await this.plugin.saveSettings();
					});
				toggleContainer.appendChild(toggle.toggleEl);
			});

			setting.addButton(button => button
				.setIcon('trash')
				.setTooltip('Delete')
				.onClick(async () => {
					this.plugin.settings.customCommands.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
				}));
		});

		new SettingGroup(pane)
			.setHeading('Advanced')
			.addSetting(s => s
				.setName('Enable Command Fallback')
				.setDesc('WARNING: Enables list_all_commands and execute_any_command tools for unrestricted command access.')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.enableCommandFallback)
					.onChange(async (value) => {
						this.plugin.settings.enableCommandFallback = value;
						await this.plugin.saveSettings();
						if (this.plugin.settings.mcpEnabled) {
							this.plugin.stopMCPServer();
							await this.plugin.startMCPServer();
						}
					})));
	}

	// ===== REMOTE ACCESS TAB =====
	private renderRemoteTab(pane: HTMLElement): void {
		new Setting(pane)
			.setName('Enable Tunnel')
			.setDesc('Create a Cloudflare tunnel to access your vault from anywhere')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableTunnel)
				.onChange(async (value) => {
					this.plugin.settings.enableTunnel = value;
					await this.plugin.saveSettings();
					if (value) {
						if (this.plugin.settings.mcpEnabled) {
							await this.plugin.startTunnel();
						} else {
							new Notice('Enable MCP Server first to use tunnel');
							this.plugin.settings.enableTunnel = false;
							toggle.setValue(false);
							await this.plugin.saveSettings();
						}
					} else {
						this.plugin.stopTunnel();
					}
					this.display();
				}));

		if (!this.plugin.settings.enableTunnel) return;

		new Setting(pane)
			.setName('Tunnel Type')
			.setDesc('Quick: random URL that changes on restart. Named: permanent URL with your own domain.')
			.addDropdown(dropdown => dropdown
				.addOption('quick', 'Quick Tunnel (ephemeral)')
				.addOption('named', 'Named Tunnel (permanent)')
				.setValue(this.plugin.settings.tunnelType)
				.onChange(async (value: string) => {
					this.plugin.settings.tunnelType = value as 'quick' | 'named';
					await this.plugin.saveSettings();
					if (this.plugin.getTunnelStatus().status !== 'disconnected') {
						await this.plugin.regenerateTunnel();
						setTimeout(() => this.display(), 3000);
					} else {
						this.display();
					}
				}));

		const isNamed = this.plugin.settings.tunnelType === 'named';

		if (isNamed) {
			new Setting(pane)
				.setName('Tunnel Token')
				.setDesc('Token from Cloudflare dashboard (Zero Trust → Networks → Tunnels → Configure)')
				.addComponent(el => new SecretComponent(this.app, el)
					.setValue(this.plugin.settings.tunnelToken)
					.onChange(async (value) => {
						this.plugin.settings.tunnelToken = value;
						await this.plugin.saveSettings();
					}));

			new Setting(pane)
				.setName('Tunnel URL')
				.setDesc('Your tunnel\'s public hostname (e.g., https://witness.example.com)')
				.addText(text => {
					text.setPlaceholder('https://witness.example.com')
						.setValue(this.plugin.settings.tunnelUrl || '')
						.onChange(async (value) => {
							this.plugin.settings.tunnelUrl = value || null;
							await this.plugin.saveSettings();
						});
					text.inputEl.style.width = '300px';
				});

			const currentHost = os.hostname();
			const isPrimary = !this.plugin.settings.tunnelPrimaryHost || this.plugin.settings.tunnelPrimaryHost === currentHost;
			const primaryDesc = this.plugin.settings.tunnelPrimaryHost
				? `Primary: ${this.plugin.settings.tunnelPrimaryHost}` + (isPrimary ? ' (this machine)' : ` (this machine: ${currentHost})`)
				: 'No primary set — all machines will run the tunnel';

			const primarySetting = new Setting(pane)
				.setName('Primary Machine')
				.setDesc(primaryDesc);

			if (!isPrimary) {
				primarySetting.descEl.style.color = 'var(--text-warning)';
			}

			primarySetting.addButton(button => button
				.setButtonText(isPrimary && this.plugin.settings.tunnelPrimaryHost ? 'This machine ✓' : 'Set as primary')
				.setCta()
				.setDisabled(isPrimary && !!this.plugin.settings.tunnelPrimaryHost)
				.onClick(async () => {
					this.plugin.settings.tunnelPrimaryHost = currentHost;
					await this.plugin.saveSettings();
					new Notice(`This machine (${currentHost}) is now the primary tunnel host`);
					this.display();
				}));

			if (this.plugin.settings.tunnelPrimaryHost) {
				primarySetting.addButton(button => button
					.setIcon('x')
					.setTooltip('Clear primary (allow all machines)')
					.onClick(async () => {
						this.plugin.settings.tunnelPrimaryHost = '';
						await this.plugin.saveSettings();
						new Notice('Primary host cleared — all machines will run the tunnel');
						this.display();
					}));
			}
		}

		const { status, url } = this.plugin.getTunnelStatus();

		const statusText = status === 'connected' ? '● Connected' :
			status === 'connecting' ? '○ Connecting...' :
			status === 'error' ? '● Error' : '○ Disconnected';
		const statusColor = status === 'connected' ? 'var(--text-success)' :
			status === 'connecting' ? 'var(--text-warning)' :
			status === 'error' ? 'var(--text-error)' : 'var(--text-muted)';

		const statusSetting = new Setting(pane)
			.setName('Tunnel Status')
			.setDesc(statusText);
		statusSetting.descEl.style.color = statusColor;

		// Authentication
		new SettingGroup(pane)
			.setHeading('Authentication')
			.addSetting(s => s
				.setName('Require Authentication')
				.setDesc('Protect your remote MCP endpoint with a token')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.enableAuth)
					.onChange(async (value) => {
						this.plugin.settings.enableAuth = value;
						if (value && !this.plugin.settings.authToken) {
							this.plugin.settings.authToken = generateRandomId(32);
						}
						await this.plugin.saveSettings();
						this.display();
					})));

		if (this.plugin.settings.enableAuth) {
			const tokenSetting = new Setting(pane)
				.setName('Authentication Token')
				.setDesc('Token required for all MCP requests');

			tokenSetting.addComponent(el => new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.authToken)
				.onChange(async (value) => {
					this.plugin.settings.authToken = value;
					await this.plugin.saveSettings();
				}));

			tokenSetting.addButton(button => button
				.setIcon('reset')
				.setTooltip('Regenerate token')
				.onClick(async () => {
					await this.plugin.regenerateAuthToken();
					new Notice('New token generated!');
					this.display();
				}));
		}

		if (url) {
			let mcpUrl = isNamed ? url : `${url}/mcp`;
			if (isNamed && !mcpUrl.endsWith('/mcp')) {
				mcpUrl = mcpUrl.replace(/\/$/, '') + '/mcp';
			}
			if (this.plugin.settings.enableAuth && this.plugin.settings.authToken) {
				mcpUrl += `?token=${this.plugin.settings.authToken}`;
			}
			const urlSetting = new Setting(pane)
				.setName('Your MCP URL')
				.setDesc(mcpUrl);

			urlSetting.addButton(button => button
				.setButtonText('Copy URL')
				.onClick(() => {
					navigator.clipboard.writeText(mcpUrl);
					new Notice('URL copied to clipboard!');
				}));
		}

		new Setting(pane)
			.setName(isNamed ? 'Reconnect Tunnel' : 'Regenerate Tunnel')
			.setDesc(isNamed ? 'Restart the tunnel connection' : 'Get a new tunnel URL')
			.addButton(button => button
				.setButtonText(isNamed ? 'Reconnect' : 'Regenerate')
				.onClick(async () => {
					await this.plugin.regenerateTunnel();
					setTimeout(() => this.display(), 3000);
				}));

		if (!isNamed) {
			const noteEl = pane.createEl('div', {
				cls: 'setting-item-description',
				text: '⚠️ This URL changes when Obsidian restarts. Switch to a Named Tunnel for a permanent URL.'
			});
			noteEl.style.marginBottom = '20px';
			noteEl.style.color = 'var(--text-warning)';
		}

		this.plugin.onTunnelStatusChange((newStatus) => {
			if (newStatus === 'connected' || newStatus === 'error') {
				this.display();
			}
		});
	}

	/**
	 * Eagerly load the vector store from disk to get the index count,
	 * without requiring Ollama to be running.
	 */
	private async loadIndexFileCount(): Promise<number> {
		if (this.plugin.vectorStore) {
			return this.plugin.vectorStore.getFileCount();
		}
		try {
			if (!this.plugin.ollamaProvider) {
				this.plugin.ollamaProvider = new OllamaProvider({
					baseUrl: this.plugin.settings.ollamaBaseUrl,
					model: this.plugin.settings.ollamaModel,
					log: (level, msg, data) => {
						if (level === 'error') this.plugin.logger.error(msg, data);
						else this.plugin.logger.info(msg);
					},
				});
				await this.plugin.ollamaProvider.resolveModelInfo();
			}
			const vs = new OramaSearchEngine(this.app, this.plugin.ollamaProvider);
			await vs.initialize();
			// Only assign to plugin if nothing else created one during our await
			if (!this.plugin.vectorStore) {
				this.plugin.vectorStore = vs;
			}
			return this.plugin.vectorStore.getFileCount();
		} catch {
			return 0;
		}
	}

	// ===== SEMANTIC SEARCH TAB =====
	private renderSearchTab(pane: HTMLElement): void {
		const searchContent = pane.createDiv();

		new Setting(pane)
			.setName('Enable Semantic Search')
			.setDesc('Enable local vector search via Ollama embeddings. Disable if you only need the MCP server without search.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableSemanticSearch)
				.onChange(async (value) => {
					this.plugin.settings.enableSemanticSearch = value;
					await this.plugin.saveSettings();
					searchContent.style.display = value ? '' : 'none';
				}));

		// Move all content into the collapsible container
		pane.removeChild(searchContent);
		pane.appendChild(searchContent);
		searchContent.style.display = this.plugin.settings.enableSemanticSearch ? '' : 'none';

		const ollamaGroup = new SettingGroup(searchContent)
			.setHeading('Ollama Connection');

		ollamaGroup.addSetting(s => s
			.setName('Base URL')
			.setDesc('The URL where Ollama is running')
			.addText(text => text
				.setPlaceholder('http://localhost:11434')
				.setValue(this.plugin.settings.ollamaBaseUrl)
				.onChange(async (value) => {
					this.plugin.settings.ollamaBaseUrl = value;
					await this.plugin.saveSettings();
					this.plugin.resetSemanticSearch();
					this.embeddingModelsCache = null;
				})));

		// Model selector
		const modelDesc = createFragment(f => {
			f.appendText('Dropdown shows models pulled locally. To add more, run: ');
			f.createEl('code', {text: 'ollama pull <model-name>'});
		});
		ollamaGroup.addSetting(s => {
			s.setName('Embedding Model')
				.setDesc(modelDesc);

			if (this.embeddingModelsCache && this.embeddingModelsCache.length > 0) {
				s.addDropdown(dropdown => {
					for (const model of this.embeddingModelsCache!) {
						const dims = model.dimensions ? `, ${model.dimensions}d` : '';
						const label = `${model.name} (${model.parameterSize}, ${model.family}${dims})`;
						dropdown.addOption(model.name, label);
					}
					const currentModel = this.plugin.settings.ollamaModel;
					if (!this.embeddingModelsCache!.some(m => m.name === currentModel)) {
						dropdown.addOption(currentModel, currentModel);
					}
					dropdown.setValue(currentModel);
					dropdown.onChange(async (value) => {
						this.plugin.settings.ollamaModel = value;
						await this.plugin.saveSettings();
						this.plugin.resetSemanticSearch();
					});
				});
			} else {
				s.addText(text => text
					.setPlaceholder('nomic-embed-text')
					.setValue(this.plugin.settings.ollamaModel)
					.onChange(async (value) => {
						this.plugin.settings.ollamaModel = value;
						await this.plugin.saveSettings();
						this.plugin.resetSemanticSearch();
					}));

				const provider = new OllamaProvider({
					baseUrl: this.plugin.settings.ollamaBaseUrl,
				});
				provider.listEmbeddingModels().then(models => {
					if (models.length > 0) {
						this.embeddingModelsCache = models;
						this.display();
					}
				}).catch(() => {});
			}
		});

		// Available embedding models with pull buttons
		// Models with multiple sizes list each variant separately
		const AVAILABLE_MODELS: [string, string][] = [
			['nomic-embed-text', '274MB download, 768d — general purpose (recommended)'],
			['all-minilm', '46MB download, 384d — fast and lightweight'],
			['mxbai-embed-large', '670MB download, 1024d — high quality'],
			['bge-m3', '1.2GB download, 1024d — multilingual'],
			['bge-large', '670MB download, 1024d — BAAI'],
			['snowflake-arctic-embed:33m', '67MB download, 384d — small'],
			['snowflake-arctic-embed:110m', '223MB download, 768d — medium'],
			['snowflake-arctic-embed:335m', '670MB download, 1024d — large'],
			['snowflake-arctic-embed2', '568MB download, 1024d — multilingual'],
			['nomic-embed-text-v2-moe', '489MB download, 768d — MoE, multilingual'],
			['granite-embedding:30m', '62MB download, 384d — IBM, tiny'],
			['granite-embedding:278m', '557MB download, 768d — IBM'],
			['paraphrase-multilingual', '557MB download, 768d — multilingual'],
			['qwen3-embedding:0.6b', '490MB download, 1024d — small'],
			['qwen3-embedding:8b', '6.6GB download, 4096d — large'],
		];

		const pulledNames = new Set(
			(this.embeddingModelsCache ?? []).map(m => m.name)
		);

		const modelsGroup = new SettingGroup(searchContent).setHeading('Available Models');
		for (const [name, desc] of AVAILABLE_MODELS) {
			const isPulled = pulledNames.has(name) || pulledNames.has(name + ':latest');
			modelsGroup.addSetting(s => {
				s.setName(name).setDesc(desc);
				if (isPulled) {
					s.addButton(btn => btn
						.setButtonText('Installed')
						.setDisabled(true));
				} else {
					let pulling = false;
					s.addButton(btn => btn
						.setButtonText('Pull')
						.onClick(async () => {
							if (pulling) return;
							pulling = true;
							s.setDesc('Downloading...');
							btn.setButtonText('...');
							try {
								const provider = new OllamaProvider({
									baseUrl: this.plugin.settings.ollamaBaseUrl,
								});
								await provider.pullModel(name, (_status, percent) => {
									if (percent !== null) {
										s.setDesc(`Downloading... ${percent}%`);
									}
								});
								new Notice(`${name} pulled successfully`);
								this.embeddingModelsCache = null;
								this.display();
							} catch (e) {
								new Notice(`Failed to pull ${name}: ${(e as Error).message}`);
								s.setDesc(desc);
								btn.setButtonText('Pull');
								pulling = false;
							}
						}));
				}
			});
		}

		// Index status
		let indexStatusSetting: Setting;
		new SettingGroup(searchContent)
			.setHeading('Index')
			.addSetting(s => {
				indexStatusSetting = s;
				s.setName('Index Status');

				// Show cached count immediately, then try loading from disk
				const fileCount = this.plugin.vectorStore?.getFileCount() ?? 0;
				if (fileCount > 0) {
					s.setDesc(`${fileCount} files indexed`);
				} else {
					s.setDesc('Checking index...');
					// Eagerly load index from disk to show accurate count
					this.loadIndexFileCount().then(diskCount => {
						if (diskCount > 0) {
							indexStatusSetting.setDesc(`${diskCount} files indexed`);
						} else {
							indexStatusSetting.setDesc('No index — press Build Index to build it');
						}
					});
				}
			})
			.addSetting(s => {
				s.setName('Build Index')
				 .setDesc('Index all vault documents now');
				s.addButton(button => button
					.setButtonText('Build Index')
					.setCta()
					.onClick(async () => {
						try {
							if (!this.plugin.ollamaProvider) {
								this.plugin.ollamaProvider = new OllamaProvider({
									baseUrl: this.plugin.settings.ollamaBaseUrl,
									model: this.plugin.settings.ollamaModel,
									log: (level, msg, data) => {
										if (level === 'error') this.plugin.logger.error(msg, data);
										else this.plugin.logger.info(msg);
									},
								});
								await this.plugin.ollamaProvider.resolveModelInfo();
							}
							if (!(await this.plugin.ollamaProvider.isAvailable())) {
								new Notice('Ollama is not running. Start it first.');
								return;
							}
							if (!this.plugin.vectorStore) {
								this.plugin.vectorStore = new OramaSearchEngine(this.app, this.plugin.ollamaProvider);
								await this.plugin.vectorStore.initialize();
							}
							// Capture local reference — prevents null errors if clearIndex/reset runs during indexing
							const vs = this.plugin.vectorStore;
							const mdFiles = this.plugin.getIndexableFiles();
							const staleFiles = await vs.getStaleFiles(mdFiles);
							if (staleFiles.length === 0) {
								indexStatusSetting.setDesc(`${vs.getFileCount()} files indexed — all up to date`);
								return;
							}
							button.setDisabled(true);
							button.setButtonText('Indexing...');
							indexStatusSetting.setDesc(`Indexing 0/${staleFiles.length}...`);
							const result = await vs.indexFiles(staleFiles, {
								generateEmbeddings: true,
								minContentLength: this.plugin.settings.minContentLength ?? 50,
								getFileTags: (f) => this.plugin.getFileTags(f),
								onProgress: (done, total) => {
									indexStatusSetting.setDesc(`Indexing ${done}/${total}...`);
								},
								onLog: (level, msg, data) => {
									if (level === 'error') this.plugin.logger.error(msg, data);
									else this.plugin.logger.info(msg);
								},
							});
							await vs.save();
							button.setDisabled(false);
							button.setButtonText('Build Index');
							this.plugin.updateStatusBar();
							if (result.failed.length > 0) {
								const failedPreview = result.failed.slice(0, 5).join('\n');
								const moreText = result.failed.length > 5 ? `\n...and ${result.failed.length - 5} more (see logs)` : '';
								indexStatusSetting.setDesc(
									`${result.indexed} files indexed (${result.embedded} with embeddings), ${result.failed.length} failed:\n${failedPreview}${moreText}`
								);
							} else {
								indexStatusSetting.setDesc(`${vs.getFileCount()} files indexed (${result.embedded} with embeddings)`);
							}
						} catch (e) {
							this.plugin.logger.error('Indexing failed', e);
							indexStatusSetting.setDesc(`Indexing failed: ${(e as Error).message}`);
							button.setDisabled(false);
							button.setButtonText('Build Index');
						}
					}));
			})
			.addSetting(s => {
				s.setName('Clear Index')
				 .setDesc('Clear the existing index');
				s.addButton(button => button
					.setButtonText('Clear Index')
					.onClick(async () => {
						await this.plugin.clearIndex();
						indexStatusSetting.setDesc('No index — press Build Index to build it');
					}));
			});

		// Indexing filters
		new SettingGroup(searchContent)
			.setHeading('Indexing Filters')
			.addSetting(s => s
				.setName('Minimum content length')
				.setDesc('Skip files shorter than this many characters. Short files produce noisy embeddings.')
				.addText(text => text
					.setValue(String(this.plugin.settings.minContentLength ?? 50))
					.setPlaceholder('50')
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 0) {
							this.plugin.settings.minContentLength = num;
							await this.plugin.saveSettings();
						}
					})))
			.addSetting(s => s
				.setName('Idle threshold (minutes)')
				.setDesc('Wait this long after the last mouse/keyboard activity before indexing. Prevents indexing while you\'re working.')
				.addText(text => text
					.setValue(String(this.plugin.settings.idleThresholdMinutes ?? 2))
					.setPlaceholder('2')
					.onChange(async (value) => {
						const num = parseFloat(value);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.idleThresholdMinutes = num;
							await this.plugin.saveSettings();
						}
					})));

		// Folder exclusions
		const exclusionsGroup = new SettingGroup(searchContent)
			.setHeading('Folder Exclusions');

		for (const folder of this.plugin.settings.excludedFolders) {
			exclusionsGroup.addSetting(s => {
				s.setName(folder);
				s.addButton(button => button
					.setButtonText('Remove')
					.onClick(async () => {
						this.plugin.settings.excludedFolders =
							this.plugin.settings.excludedFolders.filter(f => f !== folder);
						await this.plugin.saveSettings();
						this.display();
					}));
			});
		}

		exclusionsGroup.addSetting(s => {
			s.setName('Add Folder')
			 .setDesc('Choose a folder to exclude from semantic search indexing');
			s.addButton(button => button
				.setButtonText('Add Folder')
				.onClick(() => {
					new FolderSuggestModal(this.app, async (folder) => {
						if (!this.plugin.settings.excludedFolders.includes(folder)) {
							this.plugin.settings.excludedFolders.push(folder);
							await this.plugin.saveSettings();
							this.display();
						}
					}).open();
				}));
		});

		// Re-ranking settings
		const rerankGroup = new SettingGroup(searchContent)
			.setHeading('Re-ranking');

		rerankGroup.addSetting(s => s
			.setName('Enable re-ranking')
			.setDesc('Use a small chat model to re-score search results for higher precision. Adds ~1-3 seconds per search.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableReranking)
				.onChange(async (value) => {
					this.plugin.settings.enableReranking = value;
					await this.plugin.saveSettings();
					rerankContent.style.display = value ? '' : 'none';
				})));

		rerankGroup.addSetting(s => {
			s.setName('Re-ranking Model')
				.setDesc('A small chat model for re-ranking (e.g. llama3.2:1b, qwen2.5:1.5b)');

			if (this.chatModelsCache && this.chatModelsCache.length > 0) {
				s.addDropdown(dropdown => {
					dropdown.addOption('', '(none)');
					for (const model of this.chatModelsCache!) {
						const label = `${model.name} (${model.parameterSize}, ${model.family})`;
						dropdown.addOption(model.name, label);
					}
					const currentModel = this.plugin.settings.rerankModel;
					if (currentModel && !this.chatModelsCache!.some(m => m.name === currentModel)) {
						dropdown.addOption(currentModel, currentModel);
					}
					dropdown.setValue(currentModel);
					dropdown.onChange(async (value) => {
						this.plugin.settings.rerankModel = value;
						await this.plugin.saveSettings();
					});
				});
			} else {
				s.addText(text => text
					.setPlaceholder('llama3.2:1b')
					.setValue(this.plugin.settings.rerankModel)
					.onChange(async (value) => {
						this.plugin.settings.rerankModel = value;
						await this.plugin.saveSettings();
					}));

				// Try to load chat models for dropdown
				const provider = new OllamaProvider({
					baseUrl: this.plugin.settings.ollamaBaseUrl,
				});
				provider.listChatModels().then(models => {
					if (models.length > 0) {
						this.chatModelsCache = models;
						this.display();
					}
				}).catch(() => {});
			}
		});

		// Container for conditional re-ranking settings (shown when enabled)
		const rerankContent = searchContent.createDiv();
		rerankContent.style.display = this.plugin.settings.enableReranking ? '' : 'none';
		rerankContent.style.marginTop = '12px';

		// Suggested re-ranking models with pull buttons
		const RERANK_MODELS: [string, string][] = [
			['llama3.2:1b', '1.3GB — fast, good quality (recommended)'],
			['qwen2.5:1.5b', '986MB — multilingual, compact'],
			['phi3:mini', '2.3GB — Microsoft, strong reasoning'],
			['gemma2:2b', '1.6GB — Google, balanced'],
		];

		const rerankPullGroup = new SettingGroup(rerankContent)
			.setHeading('Available Re-ranking Models');

		for (const [modelName, desc] of RERANK_MODELS) {
			rerankPullGroup.addSetting(s => {
				const isPulled = this.chatModelsCache?.some(m => m.name === modelName || m.name.startsWith(modelName.split(':')[0]));
				s.setName(modelName);
				s.setDesc(isPulled ? `Installed — ${desc}` : desc);
				s.addButton(button => {
					button.setButtonText(isPulled ? 'Use' : 'Pull');
					button.onClick(async () => {
						if (isPulled) {
							this.plugin.settings.rerankModel = modelName;
							await this.plugin.saveSettings();
							this.display();
							return;
						}
						button.setDisabled(true);
						button.setButtonText('Pulling...');
						try {
							const provider = new OllamaProvider({
								baseUrl: this.plugin.settings.ollamaBaseUrl,
							});
							await provider.pullModel(modelName, (status, percent) => {
								const pct = percent != null ? ` ${percent}%` : '';
								button.setButtonText(`${status}${pct}`);
							});
							button.setButtonText('Done!');
							this.plugin.settings.rerankModel = modelName;
							await this.plugin.saveSettings();
							this.chatModelsCache = null;
							this.display();
						} catch (e) {
							button.setButtonText('Failed');
							button.setDisabled(false);
						}
					});
				});
			});
		}
	}
}
