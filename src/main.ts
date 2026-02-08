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
 */
class MCPLogger {
	private app: App;
	private pluginId: string;
	private buffer: string[] = [];
	private flushTimeout: NodeJS.Timeout | null = null;
	private readonly FLUSH_INTERVAL = 1000; // Flush every second
	private readonly MAX_BUFFER = 50; // Or when buffer reaches 50 entries

	constructor(app: App, pluginId: string) {
		this.app = app;
		this.pluginId = pluginId;
	}

	private getLogPath(): string {
		const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
		return normalizePath(`.obsidian/plugins/${this.pluginId}/logs/mcp-${date}.log`);
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
			console.error('[MCPLogger] Failed to write log file:', err);
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
	ollamaBaseUrl: string;
	ollamaModel: string;
	excludedFolders: string[];
	minContentLength: number;
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
	customCommands: [],
	coreToolDescriptions: {},
	enableCommandFallback: false,
	enableTunnel: false,
	tunnelUrl: null,
	tunnelType: 'quick',
	tunnelToken: '',
	tunnelPrimaryHost: '',
	enableAuth: false,
	ollamaBaseUrl: 'http://localhost:11434',
	ollamaModel: 'nomic-embed-text',
	excludedFolders: [],
	minContentLength: 50,
}

export default class WitnessPlugin extends Plugin {
	settings: WitnessSettings;
	private httpServer: http.Server | null = null;
	private mcpServer: McpServer | null = null;
	private transports: Map<string, StreamableHTTPServerTransport> = new Map();
	logger: MCPLogger;
	private tunnelProcess: Tunnel | null = null;
	private tunnelStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
	private tunnelStatusCallback: ((status: string, url: string | null) => void) | null = null;
	vectorStore: OramaSearchEngine | null = null;
	ollamaProvider: OllamaProvider | null = null;

	async onload() {
		await this.loadSettings();

		// Initialize logger
		this.logger = new MCPLogger(this.app, this.manifest.id);

		this.logger.info('Witness plugin loaded');

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

		// Start MCP server if enabled
		if (this.settings.mcpEnabled) {
			await this.startMCPServer();
		}

		// Start tunnel if enabled (after MCP server is up)
		if (this.settings.enableTunnel && this.settings.mcpEnabled) {
			this.startTunnel();
		}
	}

	async onunload() {
		this.logger.info('Witness plugin unloading');
		this.stopTunnel();
		this.stopMCPServer();
		if (this.vectorStore) {
			await this.vectorStore.save();
			this.vectorStore.destroy();
			this.vectorStore = null;
		}
		this.ollamaProvider = null;
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

		// Register write_file tool (DESTRUCTIVE)
		this.mcpServer.tool(
			'write_file',
			this.getToolDescription('write_file', 'Write content to a file in the vault (creates or overwrites)'),
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
					await this.app.vault.modify(existing as any, content);
				} else {
					await this.app.vault.create(path, content);
				}
				return {
					content: [
						{
							type: 'text',
							text: `Successfully wrote to ${path}`,
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
					throw new Error(`Text not found in file: "${find}"`);
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
			},
			{
				readOnlyHint: true,
			},
			async ({ query, mode, path, tag, limit, minScore }) => {
				try {
					// Initialize Ollama provider on first use
					if (!this.ollamaProvider) {
						this.ollamaProvider = new OllamaProvider({
							baseUrl: this.settings.ollamaBaseUrl,
							model: this.settings.ollamaModel,
							log: (level, msg, data) => {
								if (level === 'error') this.logger.error(msg, data);
								else this.logger.info(msg);
							},
						});
						await this.ollamaProvider.resolveModelInfo();
					}

					// For vector/hybrid modes, check Ollama availability
					if (mode !== 'fulltext') {
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

					// Initialize search engine on first use
					if (!this.vectorStore) {
						this.vectorStore = new OramaSearchEngine(this.app, this.ollamaProvider);
						await this.vectorStore.initialize();
						this.logger.info(`Search engine initialized with ${this.vectorStore.getCount()} documents`);

						// Auto-index if needed
						const mdFiles = this.getIndexableFiles();
						const staleFiles = await this.vectorStore.getStaleFiles(mdFiles);

						if (staleFiles.length > 0) {
							this.logger.info(`Indexing ${staleFiles.length} new/changed files...`);
							const result = await this.vectorStore.indexFiles(staleFiles, {
								generateEmbeddings: mode !== 'fulltext',
								minContentLength: this.settings.minContentLength ?? 50,
								getFileTags: (f) => this.getFileTags(f),
								onProgress: (done, total) => {
									this.logger.info(`Indexing progress: ${done}/${total}`);
								},
								onLog: (level, msg, data) => {
									if (level === 'error') this.logger.error(msg, data);
									else this.logger.info(msg);
								},
							});
							await this.vectorStore.save();
							this.logger.info(`Indexed ${result.indexed} files (${result.embedded} embedded, ${result.failed.length} failed), total: ${this.vectorStore.getCount()}`);
						}
					}

					if (this.vectorStore.getCount() === 0) {
						return {
							content: [{
								type: 'text',
								text: 'No documents indexed yet. Ensure your vault has markdown files. For hybrid/vector search, Ollama must be running.',
							}],
							isError: true,
						};
					}

					// Use the shared search method (handles phrases, stop words, boosting)
					const results = await this.search(query, {
						mode: mode ?? 'hybrid',
						limit,
						minScore,
						paths: path ? [path] : undefined,
						tags: tag ? [tag] : undefined,
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
				'Returns file paths with metadata (size, modified time, tags). Does not search file contents — use the search tool for that.'),
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
				limit: z.number().optional().default(50).describe('Maximum number of results'),
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
					return {
						path: f.path,
						size: f.stat.size,
						mtime: f.stat.mtime,
						tags: tags.length > 0 ? tags : undefined,
					};
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
	} = {}): Promise<SearchResult[]> {
		if (!this.vectorStore) {
			throw new Error('Search index not available');
		}

		const { mode = 'hybrid', limit = 10, minScore, paths, tags } = options;

		// Parse quoted phrases for post-boost
		const { cleanQuery, phrases } = this.parseQuotedPhrases(query);

		// Over-fetch when phrases present — boosting may reorder significantly
		const effectiveLimit = phrases.length > 0 ? Math.max(limit * 3, 30) : limit;

		// Strip stop words to improve QPS scoring
		const oramaQuery = this.stripStopWords(cleanQuery || query) || cleanQuery || query;

		this.logger.info(`Search (${mode}) for: "${query}" → orama: "${oramaQuery}"${phrases.length > 0 ? ` [phrases: ${phrases.join(', ')}]` : ''}`);

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
	private async loadIndexCount(): Promise<number> {
		if (this.plugin.vectorStore) {
			return this.plugin.getIndexCount();
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
			return this.plugin.vectorStore.getCount();
		} catch {
			return 0;
		}
	}

	// ===== SEMANTIC SEARCH TAB =====
	private renderSearchTab(pane: HTMLElement): void {
		new SettingGroup(pane)
			.setHeading('Ollama Connection')
			.addSetting(s => s
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
		const modelSetting = new Setting(pane)
			.setName('Embedding Model')
			.setDesc(modelDesc);

		if (this.embeddingModelsCache && this.embeddingModelsCache.length > 0) {
			modelSetting.addDropdown(dropdown => {
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
			modelSetting.addText(text => text
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

		const modelsGroup = new SettingGroup(pane).setHeading('Available Models');
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
		new SettingGroup(pane)
			.setHeading('Index')
			.addSetting(s => {
				indexStatusSetting = s;
				s.setName('Index Status');

				// Show cached count immediately, then try loading from disk
				const count = this.plugin.getIndexCount();
				if (count > 0) {
					s.setDesc(`${count} documents indexed`);
				} else {
					s.setDesc('Checking index...');
					// Eagerly load index from disk to show accurate count
					this.loadIndexCount().then(diskCount => {
						if (diskCount > 0) {
							indexStatusSetting.setDesc(`${diskCount} documents indexed`);
						} else {
							indexStatusSetting.setDesc('No index — will be built on first semantic search');
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
								indexStatusSetting.setDesc(`${this.plugin.getIndexCount()} documents indexed — all up to date`);
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
							if (result.failed.length > 0) {
								const failedPreview = result.failed.slice(0, 5).join('\n');
								const moreText = result.failed.length > 5 ? `\n...and ${result.failed.length - 5} more (see logs)` : '';
								indexStatusSetting.setDesc(
									`${result.indexed} documents indexed (${result.embedded} with embeddings), ${result.failed.length} failed:\n${failedPreview}${moreText}`
								);
							} else {
								indexStatusSetting.setDesc(`${this.plugin.getIndexCount()} documents indexed (${result.embedded} with embeddings)`);
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
				 .setDesc('Clear the existing index and rebuild from scratch on next search');
				s.addButton(button => button
					.setButtonText('Clear Index')
					.onClick(async () => {
						await this.plugin.clearIndex();
						indexStatusSetting.setDesc('Index cleared — will be rebuilt on next semantic search');
					}));
			});

		// Indexing filters
		new SettingGroup(pane)
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
					})));

		// Folder exclusions
		const exclusionsGroup = new SettingGroup(pane)
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
	}
}
