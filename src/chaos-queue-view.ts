import { ItemView, WorkspaceLeaf, Modal, TFile, TFolder, TAbstractFile, Notice, setIcon, EventRef } from 'obsidian';
import type WitnessPlugin from './main';
import type { ChaosQueueItem } from './main';

export const VIEW_TYPE_CHAOS_QUEUE = 'witness-chaos-queue';

/**
 * Confirmation modal for destructive actions.
 */
export class ConfirmModal extends Modal {
	private message: string;
	private confirmLabel: string;
	private onConfirm: () => void;

	constructor(app: any, message: string, confirmLabel: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.confirmLabel = confirmLabel;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('witness-confirm-modal');

		contentEl.createEl('p', { text: this.message });

		const buttonRow = contentEl.createDiv({ cls: 'witness-confirm-buttons' });
		const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const confirmBtn = buttonRow.createEl('button', {
			text: this.confirmLabel,
			cls: 'mod-warning',
		});
		confirmBtn.addEventListener('click', () => {
			this.onConfirm();
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Wait for Obsidian's metadata cache to reflect a change to a file.
 * Must be called BEFORE the write operation to avoid missing the event.
 */
function waitForCacheUpdate(app: any, filePath: string, timeoutMs = 3000): Promise<void> {
	return new Promise<void>((resolve) => {
		const ref = app.metadataCache.on('changed', (changedFile: TFile) => {
			if (changedFile.path === filePath) {
				app.metadataCache.offref(ref);
				resolve();
			}
		});
		setTimeout(() => {
			app.metadataCache.offref(ref);
			resolve();
		}, timeoutMs);
	});
}

/**
 * Chaos Queue side panel — shows untriaged chaos items grouped by priority.
 */
export class WitnessChaosQueueView extends ItemView {
	private plugin: WitnessPlugin;
	private container: HTMLElement;
	private nextUpContainer: HTMLElement;
	private queueContainer: HTMLElement;
	private nextUpHeader: HTMLElement;
	private nextUpEmpty: HTMLElement;
	private queueHeader: HTMLElement;
	private footerEl: HTMLElement;
	private editMode = false;
	private editBtn: HTMLElement;
	private editToolbar: HTMLElement;
	private selectedFiles: Set<string> = new Set();
	private selectionCountEl: HTMLElement;
	private cardElements: Map<string, HTMLElement> = new Map();
	private vaultEventRefs: EventRef[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: WitnessPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CHAOS_QUEUE;
	}

	getDisplayText(): string {
		return 'Chaos Queue';
	}

	getIcon(): string {
		return 'inbox';
	}

	async onOpen(): Promise<void> {
		this.container = this.containerEl.children[1] as HTMLElement;
		this.container.empty();
		this.container.addClass('witness-chaos-container');
		await this.buildUI();
		this.registerVaultEvents();
	}

	async onClose(): Promise<void> {
		for (const ref of this.vaultEventRefs) {
			this.app.vault.offref(ref);
		}
		this.vaultEventRefs = [];
	}

	private registerVaultEvents(): void {
		// Remove card when a file is deleted
		this.vaultEventRefs.push(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				if (file instanceof TFile && this.cardElements.has(file.path)) {
					this.removeCard(file.path);
				}
			})
		);

		// Update card when a file is renamed/moved
		this.vaultEventRefs.push(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile && this.cardElements.has(oldPath)) {
					// File moved — remove old card and refresh to get correct state
					this.removeCard(oldPath);
				}
			})
		);
	}

	private async buildUI(): Promise<void> {
		// Header
		const header = this.container.createDiv({ cls: 'witness-chaos-header' });
		header.createEl('span', { text: 'Chaos Queue', cls: 'witness-chaos-header-title' });

		this.editBtn = header.createEl('button', { text: 'Bulk Edit', cls: 'witness-chaos-edit-btn' });
		this.editBtn.addEventListener('click', () => this.toggleEditMode());

		// Edit mode toolbar (hidden by default)
		this.editToolbar = this.container.createDiv({ cls: 'witness-chaos-edit-toolbar' });
		this.editToolbar.style.display = 'none';

		const selectAllBtn = this.editToolbar.createEl('button', { text: 'Select All', cls: 'witness-chaos-toolbar-btn' });
		selectAllBtn.addEventListener('click', () => this.selectAll());

		const deselectAllBtn = this.editToolbar.createEl('button', { text: 'Deselect All', cls: 'witness-chaos-toolbar-btn' });
		deselectAllBtn.addEventListener('click', () => this.deselectAll());

		this.selectionCountEl = this.editToolbar.createEl('span', { cls: 'witness-chaos-selection-count' });

		// Bulk action buttons with icons
		const bulkNextBtn = this.editToolbar.createEl('button', { cls: 'witness-chaos-toolbar-icon', attr: { 'aria-label': 'Mark selected as next up' } });
		setIcon(bulkNextBtn, 'star');
		bulkNextBtn.addEventListener('click', () => this.bulkMarkNext());

		const bulkAckBtn = this.editToolbar.createEl('button', { cls: 'witness-chaos-toolbar-icon', attr: { 'aria-label': 'Acknowledge selected' } });
		setIcon(bulkAckBtn, 'check');
		bulkAckBtn.addEventListener('click', () => this.bulkAcknowledge());

		const bulkDeathBtn = this.editToolbar.createEl('button', { cls: 'witness-chaos-toolbar-icon witness-chaos-toolbar-icon-death', attr: { 'aria-label': 'Move selected to death' } });
		setIcon(bulkDeathBtn, 'skull');
		bulkDeathBtn.addEventListener('click', () => this.bulkMoveToDeath());

		// Scrollable content area
		const scrollArea = this.container.createDiv({ cls: 'witness-chaos-scroll' });

		// Next Up section (always visible)
		this.nextUpHeader = scrollArea.createDiv({ cls: 'witness-chaos-group-header witness-chaos-group-next' });
		this.nextUpContainer = scrollArea.createDiv({ cls: 'witness-chaos-group' });
		this.nextUpEmpty = scrollArea.createDiv({ cls: 'witness-chaos-empty-hint', text: 'No items flagged as next up' });

		// Divider
		scrollArea.createDiv({ cls: 'witness-chaos-divider' });

		// Queue section
		this.queueHeader = scrollArea.createDiv({ cls: 'witness-chaos-group-header' });
		this.queueContainer = scrollArea.createDiv({ cls: 'witness-chaos-group' });

		// Footer
		this.footerEl = this.container.createDiv({ cls: 'witness-chaos-footer' });

		// Load items
		await this.renderItems();
	}

	/**
	 * Refresh the queue — re-fetches data and re-renders.
	 */
	async refreshQueue(): Promise<void> {
		this.selectedFiles.clear();
		this.cardElements.clear();
		this.nextUpContainer.empty();
		this.queueContainer.empty();
		await this.renderItems();
	}

	private async renderItems(): Promise<void> {
		const items = this.plugin.getChaosQueue();
		const nextUpItems = items.filter(i => i.priority === 'next');
		const queueItems = items.filter(i => i.priority === 'normal');

		// Update group headers
		this.nextUpHeader.textContent = `Next Up (${nextUpItems.length})`;
		this.queueHeader.textContent = `Queue (${queueItems.length})`;

		// Show empty hint when Next Up is empty
		this.nextUpEmpty.style.display = nextUpItems.length === 0 ? '' : 'none';

		// Render Next Up cards
		for (const item of nextUpItems) {
			await this.renderCard(item, this.nextUpContainer, true);
		}

		// Render Queue cards
		for (const item of queueItems) {
			await this.renderCard(item, this.queueContainer, false);
		}

		// Footer
		this.footerEl.textContent = `${items.length} items pending`;
	}

	private async renderCard(item: ChaosQueueItem, container: HTMLElement, isNextUp: boolean): Promise<void> {
		const card = container.createDiv({ cls: 'witness-chaos-card' });
		this.cardElements.set(item.path, card);

		// Body wrapper (checkbox + content)
		const body = card.createDiv({ cls: 'witness-chaos-card-body' });

		// Checkbox for edit mode
		const checkbox = body.createEl('input', { type: 'checkbox', cls: 'witness-chaos-checkbox' });
		checkbox.style.display = this.editMode ? '' : 'none';
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) {
				this.selectedFiles.add(item.path);
			} else {
				this.selectedFiles.delete(item.path);
			}
			this.updateSelectionCount();
		});

		// Content area (clickable to open file)
		const content = body.createDiv({ cls: 'witness-chaos-card-content' });
		content.addEventListener('click', () => {
			// Guard: don't open if file no longer exists (prevents creating empty files)
			const exists = this.app.vault.getAbstractFileByPath(item.path);
			if (exists) {
				this.app.workspace.openLinkText(item.path, '', false);
			} else {
				this.removeCard(item.path);
				new Notice('File no longer exists');
			}
		});

		content.createDiv({ text: item.title, cls: 'witness-chaos-card-title' });

		// Path display — strip chaos folder prefix, add visual indicator
		const chaosPrefix = this.plugin.settings.chaosFolder + '/';
		const displayPath = item.folder.startsWith(chaosPrefix)
			? item.folder.substring(chaosPrefix.length)
			: item.folder;
		content.createDiv({ text: displayPath ? `› ${displayPath}` : '', cls: 'witness-chaos-card-path' });

		// Load snippet asynchronously
		const snippetEl = content.createDiv({ cls: 'witness-chaos-card-snippet' });
		this.plugin.getFileSnippet(item.file).then(snippet => {
			snippetEl.textContent = snippet;
		});

		// Action buttons (overlay — positioned absolute over card, visible on hover)
		const actions = card.createDiv({ cls: 'witness-chaos-card-actions' });

		if (!isNextUp) {
			// Mark Next button (only in Queue group)
			const nextBtn = actions.createEl('button', { cls: 'witness-chaos-action-btn', attr: { 'aria-label': 'Mark as next up' } });
			setIcon(nextBtn, 'star');
			nextBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.markNext(item);
			});
		}

		// Acknowledge button
		const ackBtn = actions.createEl('button', { cls: 'witness-chaos-action-btn', attr: { 'aria-label': 'Acknowledge' } });
		setIcon(ackBtn, 'check');
		ackBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.acknowledgeItem(item);
		});

		// Move to Death button
		const deathBtn = actions.createEl('button', { cls: 'witness-chaos-action-btn witness-chaos-action-death', attr: { 'aria-label': 'Move to death' } });
		setIcon(deathBtn, 'skull');
		deathBtn.addEventListener('click', async (e) => {
			e.stopPropagation();
			await this.plugin.moveFileToDeath(item.file);
			this.removeCard(item.path);
			new Notice(`Moved to death: ${item.title}`);
		});

		if (isNextUp) {
			// Reset button (only in Next Up group — to un-star)
			const resetBtn = actions.createEl('button', { cls: 'witness-chaos-action-btn', attr: { 'aria-label': 'Remove from next up' } });
			setIcon(resetBtn, 'undo');
			resetBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.resetItem(item);
			});
		}
	}

	// --- Single item actions ---

	private async acknowledgeItem(item: ChaosQueueItem): Promise<void> {
		const cacheReady = waitForCacheUpdate(this.app, item.path);
		await this.plugin.app.fileManager.processFrontMatter(item.file, (fm) => {
			fm.triage = 'acknowledged';
		});
		await cacheReady;
		this.removeCard(item.path);
		new Notice(`Acknowledged: ${item.title}`);
	}

	private async markNext(item: ChaosQueueItem): Promise<void> {
		const cacheReady = waitForCacheUpdate(this.app, item.path);
		await this.plugin.app.fileManager.processFrontMatter(item.file, (fm) => {
			fm.triage = 'next';
		});
		await cacheReady;
		await this.refreshQueue();
		new Notice(`Marked as next: ${item.title}`);
	}

	private moveToDeathWithConfirm(item: ChaosQueueItem): void {
		new ConfirmModal(
			this.app,
			`Move "${item.title}" to death?\n\nThis will move the file to ${this.plugin.settings.deathFolder}/${item.path}.`,
			'Move to Death',
			async () => {
				await this.plugin.moveFileToDeath(item.file);
				this.removeCard(item.path);
				new Notice(`Moved to death: ${item.title}`);
			}
		).open();
	}

	private async resetItem(item: ChaosQueueItem): Promise<void> {
		const cacheReady = waitForCacheUpdate(this.app, item.path);
		await this.plugin.app.fileManager.processFrontMatter(item.file, (fm) => {
			delete fm.triage;
		});
		await cacheReady;
		await this.refreshQueue();
		new Notice(`Reset triage: ${item.title}`);
	}

	private removeCard(path: string): void {
		const card = this.cardElements.get(path);
		if (card) {
			card.remove();
			this.cardElements.delete(path);
			this.selectedFiles.delete(path);
		}
		this.updateGroupCounts();
	}

	private updateGroupCounts(): void {
		const nextUpCount = this.nextUpContainer.childElementCount;
		const queueCount = this.queueContainer.childElementCount;
		this.nextUpHeader.textContent = `Next Up (${nextUpCount})`;
		this.queueHeader.textContent = `Queue (${queueCount})`;
		this.footerEl.textContent = `${nextUpCount + queueCount} items pending`;
		this.nextUpEmpty.style.display = nextUpCount === 0 ? '' : 'none';
	}

	// --- Edit mode ---

	private toggleEditMode(): void {
		this.editMode = !this.editMode;
		this.editToolbar.style.display = this.editMode ? '' : 'none';
		this.editBtn.textContent = this.editMode ? 'Done' : 'Bulk Edit';
		this.editBtn.toggleClass('is-active', this.editMode);

		// Show/hide checkboxes
		const checkboxes = this.container.querySelectorAll('.witness-chaos-checkbox') as NodeListOf<HTMLInputElement>;
		checkboxes.forEach(cb => {
			cb.style.display = this.editMode ? '' : 'none';
			if (!this.editMode) cb.checked = false;
		});

		if (!this.editMode) {
			this.selectedFiles.clear();
		}
		this.updateSelectionCount();
	}

	private selectAll(): void {
		const checkboxes = this.container.querySelectorAll('.witness-chaos-checkbox') as NodeListOf<HTMLInputElement>;
		checkboxes.forEach(cb => { cb.checked = true; });
		this.cardElements.forEach((_, path) => this.selectedFiles.add(path));
		this.updateSelectionCount();
	}

	private deselectAll(): void {
		const checkboxes = this.container.querySelectorAll('.witness-chaos-checkbox') as NodeListOf<HTMLInputElement>;
		checkboxes.forEach(cb => { cb.checked = false; });
		this.selectedFiles.clear();
		this.updateSelectionCount();
	}

	private updateSelectionCount(): void {
		const total = this.cardElements.size;
		const selected = this.selectedFiles.size;
		this.selectionCountEl.textContent = selected > 0 ? `${selected} of ${total} selected` : '';
	}

	// --- Bulk actions ---

	private bulkMarkNext(): void {
		if (this.selectedFiles.size === 0) {
			new Notice('No items selected');
			return;
		}
		const count = this.selectedFiles.size;
		new ConfirmModal(
			this.app,
			`Mark ${count} item${count > 1 ? 's' : ''} as next up?`,
			'Mark Next',
			async () => {
				for (const path of this.selectedFiles) {
					const file = this.plugin.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) {
						await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
							fm.triage = 'next';
						});
					}
				}
				new Notice(`Marked ${count} items as next up`);
				// Small delay for cache to settle
				await new Promise(r => setTimeout(r, 500));
				await this.refreshQueue();
				this.editMode = false;
				this.editToolbar.style.display = 'none';
				this.editBtn.textContent = 'Bulk Edit';
				this.editBtn.removeClass('is-active');
			}
		).open();
	}

	private bulkAcknowledge(): void {
		if (this.selectedFiles.size === 0) {
			new Notice('No items selected');
			return;
		}
		const count = this.selectedFiles.size;
		new ConfirmModal(
			this.app,
			`Acknowledge ${count} item${count > 1 ? 's' : ''}?\n\nThey will no longer appear in the triage queue.`,
			'Acknowledge All',
			async () => {
				for (const path of this.selectedFiles) {
					const file = this.plugin.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) {
						await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
							fm.triage = 'acknowledged';
						});
					}
				}
				new Notice(`Acknowledged ${count} items`);
				await new Promise(r => setTimeout(r, 500));
				await this.refreshQueue();
				this.editMode = false;
				this.editToolbar.style.display = 'none';
				this.editBtn.textContent = 'Bulk Edit';
				this.editBtn.removeClass('is-active');
			}
		).open();
	}

	private bulkMoveToDeath(): void {
		if (this.selectedFiles.size === 0) {
			new Notice('No items selected');
			return;
		}
		const count = this.selectedFiles.size;
		new ConfirmModal(
			this.app,
			`Move ${count} item${count > 1 ? 's' : ''} to death?\n\nFiles will be moved to ${this.plugin.settings.deathFolder}/ preserving their folder structure.`,
			'Move to Death',
			async () => {
				for (const path of this.selectedFiles) {
					const file = this.plugin.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) {
						await this.plugin.moveFileToDeath(file);
					}
				}
				new Notice(`Moved ${count} items to death`);
				await this.refreshQueue();
				this.editMode = false;
				this.editToolbar.style.display = 'none';
				this.editBtn.textContent = 'Bulk Edit';
				this.editBtn.removeClass('is-active');
			}
		).open();
	}
}
