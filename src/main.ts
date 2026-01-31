import { App, Plugin, PluginSettingTab, Setting, Modal, SuggestModal } from 'obsidian';
import * as http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import getRawBody from 'raw-body';

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
		find_files?: string;
		execute_command?: string;
	};
	// Command fallback system (opt-in)
	enableCommandFallback: boolean;
}

const DEFAULT_SETTINGS: WitnessSettings = {
	mcpPort: 3000,
	mcpEnabled: false,
	authToken: '',
	serverInstructions: 'Before performing any operations, use get_orientation to load the orientation document. This helps understand the chaos/order system and current vault state.',
	orientationPath: '',
	customCommands: [],
	coreToolDescriptions: {},
	enableCommandFallback: false
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
				instructions: this.settings.serverInstructions,
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
			},
			{
				readOnlyHint: true,
			},
			async ({ path }) => {
				console.log(`[MCP] read_file called with path: "${path}"`);
				const file = this.app.vault.getAbstractFileByPath(path);
				console.log(`[MCP] File lookup:`, file ? `Found: ${file.path}` : 'NOT FOUND');
				if (!file) {
					throw new Error('File not found');
				}
				const content = await this.app.vault.read(file as any);
				console.log(`[MCP] read_file success, length: ${content.length} chars`);
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

		// Register search tool (READ-ONLY)
		this.mcpServer.tool(
			'search',
			this.getToolDescription('search', 'Search for text content across all files in the vault'),
			{
				query: z.string().describe('Text to search for'),
				caseSensitive: z.boolean().optional().describe('Case sensitive search (default: false)'),
				path: z.string().optional().describe('Limit search to specific folder (default: entire vault)'),
			},
			{
				readOnlyHint: true,
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
					isError: false,
				};
			}
		);

		// Register find_files tool (READ-ONLY)
		this.mcpServer.tool(
			'find_files',
			this.getToolDescription('find_files', 'Find files by filename pattern (fast, name-only search)'),
			{
				pattern: z.string().describe('Pattern to match in filename (case-insensitive)'),
				path: z.string().optional().describe('Limit search to specific folder (default: entire vault)'),
			},
			{
				readOnlyHint: true,
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
		this.mcpServer.tool(
			'get_orientation',
			'Load the orientation document to understand vault structure and organizational context',
			{},
			{
				readOnlyHint: true,
			},
			async () => {
				console.log('[MCP] get_orientation called');
				const orientationPath = this.settings.orientationPath;
				console.log(`[MCP] orientationPath from settings: "${orientationPath}"`);

				if (!orientationPath) {
					console.error('[MCP] No orientation document path configured');
					throw new Error('Orientation document path not configured in settings');
				}

				const file = this.app.vault.getAbstractFileByPath(orientationPath);
				console.log(`[MCP] File lookup result:`, file ? `Found: ${file.path}` : 'NOT FOUND');

				if (!file) {
					console.error(`[MCP] File not found at path: ${orientationPath}`);
					throw new Error(`Orientation document not found at: ${orientationPath}. Please create this file or update the path in settings.`);
				}

				const content = await this.app.vault.read(file as any);
				console.log(`[MCP] Successfully read file, length: ${content.length} chars`);

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

	private async handleMCPRequest(req: IncomingMessage, res: ServerResponse) {
		console.log(`[MCP] ${req.method} ${req.url}`);
		console.log(`[MCP] Headers:`, JSON.stringify({
			'mcp-session-id': req.headers['mcp-session-id'],
			'content-type': req.headers['content-type'],
			'accept': req.headers['accept'],
		}));
		console.log(`[MCP] Active sessions: ${this.transports.size}`, Array.from(this.transports.keys()));

		if (!this.mcpServer) {
			console.error('[MCP] Server not initialized!');
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
				console.log(`[MCP] POST body method: ${body?.method}, id: ${body?.id}`);
			} else {
				console.log(`[MCP] GET request (SSE stream) for session: ${sessionId}`);
			}

			// Check if this is an initialize request
			const isInitialize = body?.method === 'initialize';

			// New session - create transport
			if (!sessionId && isInitialize) {
				console.log('[MCP] Creating new session (initialize request)');
				const transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => `session-${Date.now()}-${Math.random()}`,
					onsessioninitialized: (newSessionId) => {
						console.log(`[MCP] Session initialized: ${newSessionId}`);
						this.transports.set(newSessionId, transport);
					},
				});

				// Connect transport to server (only once per transport)
				console.log('[MCP] Connecting transport to MCP server...');
				await this.mcpServer.connect(transport);
				console.log('[MCP] Transport connected, handling initialize request...');

				// Handle the initialize request
				await transport.handleRequest(req, res, body);
				console.log('[MCP] Initialize request handled');
				return;
			}

			// Existing session - reuse transport
			if (sessionId && this.transports.has(sessionId)) {
				console.log(`[MCP] Using existing session: ${sessionId}`);
				const transport = this.transports.get(sessionId)!;
				await transport.handleRequest(req, res, body);
				console.log(`[MCP] Request handled for session: ${sessionId}`);
				return;
			}

			// Unknown session
			console.error(`[MCP] Unknown/expired session: ${sessionId}`);
			console.error(`[MCP] Available sessions:`, Array.from(this.transports.keys()));
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid or expired session' }));
		} catch (err) {
			console.error('[MCP] Error handling request:', err);
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

		// ===== BASIC SETTINGS =====
		containerEl.createEl('h3', {text: 'Basic Settings'});

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

		// ===== SERVER CONFIGURATION =====
		containerEl.createEl('h3', {text: 'Server Configuration'});

		const serverInstructionsSetting = new Setting(containerEl)
			.setName('Server Instructions')
			.setDesc('Instructions shown to AI assistants about how to use this MCP server');

		let instructionsTextArea: HTMLTextAreaElement;

		serverInstructionsSetting.addTextArea(text => {
			instructionsTextArea = text.inputEl;
			text
				.setPlaceholder('Enter server instructions')
				.setValue(this.plugin.settings.serverInstructions)
				.onChange(async (value) => {
					this.plugin.settings.serverInstructions = value;
					await this.plugin.saveSettings();
				});
			text.inputEl.rows = 4;
			text.inputEl.cols = 50;
		});

		// Add reset button
		serverInstructionsSetting.addButton(button => button
			.setIcon('reset')
			.setTooltip('Reset to default')
			.onClick(async () => {
				this.plugin.settings.serverInstructions = DEFAULT_SETTINGS.serverInstructions;
				instructionsTextArea.value = DEFAULT_SETTINGS.serverInstructions;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Orientation Document')
			.setDesc('Path to a file that helps AI understand your vault structure and organization')
			.addButton(button => {
				button.setButtonText(this.plugin.settings.orientationPath || 'Select file');
				button.onClick(() => {
					new FileSuggestModal(this.app, async (selectedFile) => {
						this.plugin.settings.orientationPath = selectedFile;
						button.setButtonText(selectedFile);
						await this.plugin.saveSettings();
					}).open();
				});
			});

		// ===== CUSTOM COMMANDS =====
		containerEl.createEl('h3', {text: 'Custom Commands'});
		containerEl.createEl('p', {
			text: 'Expose specific Obsidian commands as MCP tools with custom names and descriptions.',
			cls: 'setting-item-description'
		});

		// Add custom command button
		new Setting(containerEl)
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
					this.display(); // Refresh UI
				}));

		// Display existing custom commands in compact list
		this.plugin.settings.customCommands.forEach((cmd, index) => {
			const setting = new Setting(containerEl);

			// Tool name with warning indicator for destructive commands only
			const toolNameText = cmd.readOnly ? cmd.name : `⚠️ ${cmd.name}`;
			setting.setName(toolNameText);

			// Show command ID as description
			const commands = (this.app as any).commands.commands;
			const commandName = cmd.commandId && commands[cmd.commandId]
				? commands[cmd.commandId].name
				: 'No command selected';
			setting.setDesc(commandName);

			// Edit button
			setting.addButton(button => button
				.setButtonText('Edit')
				.onClick(() => {
					new CommandEditModal(this.app, this.plugin, cmd, () => {
						this.display(); // Refresh after edit
					}).open();
				}));

			// Enabled toggle with label
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
				// Move toggle into container
				toggleContainer.appendChild(toggle.toggleEl);
			});

			// Delete button
			setting.addButton(button => button
				.setIcon('trash')
				.setTooltip('Delete')
				.onClick(async () => {
					this.plugin.settings.customCommands.splice(index, 1);
					await this.plugin.saveSettings();
					this.display(); // Refresh UI
				}));
		});

		// ===== COMMAND FALLBACK =====
		containerEl.createEl('h3', {text: 'Advanced Options'});

		new Setting(containerEl)
			.setName('Enable Command Fallback')
			.setDesc('⚠️ WARNING: Enables list_all_commands and execute_any_command tools for unrestricted command access. Use with caution!')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableCommandFallback)
				.onChange(async (value) => {
					this.plugin.settings.enableCommandFallback = value;
					await this.plugin.saveSettings();
					// Restart server to apply changes
					if (this.plugin.settings.mcpEnabled) {
						this.plugin.stopMCPServer();
						await this.plugin.startMCPServer();
					}
				}));
	}
}
