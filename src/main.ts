import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import * as http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import getRawBody from 'raw-body';

interface WitnessSettings {
	mcpPort: number;
	mcpEnabled: boolean;
	authToken: string;
}

const DEFAULT_SETTINGS: WitnessSettings = {
	mcpPort: 3000,
	mcpEnabled: false,
	authToken: ''
}

export default class WitnessPlugin extends Plugin {
	settings: WitnessSettings;
	private httpServer: http.Server | null = null;
	private mcpServer: McpServer | null = null;
	private transports: Map<string, StreamableHTTPServerTransport> = new Map();

	async onload() {
		await this.loadSettings();

		console.log('Witness plugin loaded');

		// Add settings tab
		this.addSettingTab(new WitnessSettingTab(this.app, this));

		// Add ribbon icon for quick access
		this.addRibbonIcon('eye', 'Witness', () => {
			console.log('Witness icon clicked');
		});

		// Start MCP server if enabled
		if (this.settings.mcpEnabled) {
			await this.startMCPServer();
		}
	}

	onunload() {
		console.log('Witness plugin unloaded');
		this.stopMCPServer();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async startMCPServer() {
		if (this.httpServer || this.mcpServer) {
			console.log('MCP server already running');
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
			}
		);

		// Register tools
		this.registerTools();

		// Create HTTP server
		this.httpServer = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
			// Health check endpoint
			if (req.url === '/health') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ status: 'ok', plugin: 'witness' }));
				return;
			}

			// MCP Streamable HTTP endpoint - handle both POST and GET (for SSE)
			if (req.url?.startsWith('/mcp')) {
				await this.handleMCPRequest(req, res);
				return;
			}

			// Not found
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Not found' }));
		});

		this.httpServer.listen(this.settings.mcpPort, 'localhost', () => {
			console.log(`Witness MCP server listening on http://localhost:${this.settings.mcpPort}`);
		});

		this.httpServer.on('error', (err) => {
			console.error('MCP server error:', err);
		});
	}

	private registerTools() {
		if (!this.mcpServer) return;

		// Register read_file tool
		this.mcpServer.tool(
			'read_file',
			'Read the contents of a file from the vault',
			{
				path: z.string().describe('Path to the file relative to vault root'),
			},
			async ({ path }) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!file) {
					throw new Error('File not found');
				}
				const content = await this.app.vault.read(file as any);
				return {
					content: [
						{
							type: 'text',
							text: content,
						},
					],
				};
			}
		);

		// Register write_file tool
		this.mcpServer.tool(
			'write_file',
			'Write content to a file in the vault',
			{
				path: z.string().describe('Path to the file relative to vault root'),
				content: z.string().describe('Content to write to the file'),
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
				};
			}
		);

		// Register list_files tool
		this.mcpServer.tool(
			'list_files',
			'List files in a directory',
			{
				path: z.string().optional().describe('Directory path (default: vault root)'),
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
				};
			}
		);

		// Register edit_file tool
		this.mcpServer.tool(
			'edit_file',
			'Find and replace text in a file (surgical edits)',
			{
				path: z.string().describe('Path to the file relative to vault root'),
				find: z.string().describe('Text to find (exact match)'),
				replace: z.string().describe('Text to replace with'),
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
				};
			}
		);

		// Register search tool
		this.mcpServer.tool(
			'search',
			'Search for text across all files in the vault',
			{
				query: z.string().describe('Text to search for'),
				caseSensitive: z.boolean().optional().describe('Case sensitive search (default: false)'),
				path: z.string().optional().describe('Limit search to specific folder (default: entire vault)'),
			},
			async ({ query, caseSensitive = false, path }) => {
				const allFiles = this.app.vault.getMarkdownFiles();
				const results: Array<{ file: string; line: number; text: string }> = [];

				// Filter by path if specified
				const filesToSearch = path
					? allFiles.filter(f => f.path.startsWith(path))
					: allFiles;

				const searchRegex = new RegExp(
					query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
					caseSensitive ? 'g' : 'gi'
				);

				for (const file of filesToSearch) {
					const content = await this.app.vault.read(file);
					const lines = content.split('\n');

					lines.forEach((lineText, index) => {
						if (searchRegex.test(lineText)) {
							results.push({
								file: file.path,
								line: index + 1,
								text: lineText.trim(),
							});
						}
					});
				}

				const summary = `Found ${results.length} match(es) across ${filesToSearch.length} file(s)`;
				const resultText = results.length > 0
					? results.map(r => `${r.file}:${r.line} - ${r.text}`).join('\n')
					: 'No matches found';

				return {
					content: [
						{
							type: 'text',
							text: `${summary}\n\n${resultText}`,
						},
					],
				};
			}
		);

		// Register find_files tool
		this.mcpServer.tool(
			'find_files',
			'Find files by filename pattern (fast, name-only search)',
			{
				pattern: z.string().describe('Pattern to match in filename (case-insensitive)'),
				path: z.string().optional().describe('Limit search to specific folder (default: entire vault)'),
			},
			async ({ pattern, path }) => {
				const allFiles = this.app.vault.getMarkdownFiles();

				// Filter by path if specified
				const filesToSearch = path
					? allFiles.filter(f => f.path.startsWith(path))
					: allFiles;

				// Search in filename only (not content)
				const searchRegex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
				const matches = filesToSearch.filter(f => searchRegex.test(f.name) || searchRegex.test(f.path));

				const summary = `Found ${matches.length} file(s) matching "${pattern}"`;
				const resultText = matches.length > 0
					? matches.map(f => f.path).join('\n')
					: 'No matching files found';

				return {
					content: [
						{
							type: 'text',
							text: `${summary}\n\n${resultText}`,
						},
					],
				};
			}
		);

		// Register execute_command tool
		this.mcpServer.tool(
			'execute_command',
			'Execute an Obsidian command by ID',
			{
				commandId: z.string().describe('Command ID to execute (e.g., "editor:toggle-bold")'),
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
				};
			}
		);
	}

	private async handleMCPRequest(req: IncomingMessage, res: ServerResponse) {
		if (!this.mcpServer) {
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
			}

			// Check if this is an initialize request
			const isInitialize = body?.method === 'initialize';

			// New session - create transport
			if (!sessionId && isInitialize) {
				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => `session-${Date.now()}-${Math.random()}`,
					onsessioninitialized: (newSessionId) => {
						console.log(`New MCP session initialized: ${newSessionId}`);
						this.transports.set(newSessionId, transport);
					},
				});

				// Connect transport to server (only once per transport)
				await this.mcpServer.connect(transport);

				// Handle the initialize request
				await transport.handleRequest(req, res, body);
				return;
			}

			// Existing session - reuse transport
			if (sessionId && this.transports.has(sessionId)) {
				const transport = this.transports.get(sessionId)!;
				await transport.handleRequest(req, res, body);
				return;
			}

			// Unknown session
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid or expired session' }));
		} catch (err) {
			console.error('Error handling MCP request:', err);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Internal server error' }));
		}
	}

	stopMCPServer() {
		// Close all transports
		for (const [sessionId, transport] of this.transports) {
			console.log(`Closing session: ${sessionId}`);
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
				console.log('Witness MCP server stopped');
			});
			this.httpServer = null;
		}
	}
}

class WitnessSettingTab extends PluginSettingTab {
	plugin: WitnessPlugin;

	constructor(app: App, plugin: WitnessPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Witness Settings'});

		new Setting(containerEl)
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
				}));

		new Setting(containerEl)
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
				}));

		new Setting(containerEl)
			.setName('Authentication Token')
			.setDesc('Token for authenticating MCP requests (leave empty to disable auth)')
			.addText(text => text
				.setPlaceholder('Enter token')
				.setValue(this.plugin.settings.authToken)
				.onChange(async (value) => {
					this.plugin.settings.authToken = value;
					await this.plugin.saveSettings();
				}));
	}
}
