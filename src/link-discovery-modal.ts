/**
 * Link Discovery Spike — modal that shows the generated LLM prompt
 * for the user to copy and paste into Ollama for evaluation.
 */

import { Modal, App, Notice } from 'obsidian';

export class LinkDiscoveryPromptModal extends Modal {
	private title: string;
	private prompt: string;

	constructor(app: App, title: string, prompt: string) {
		super(app);
		this.title = title;
		this.prompt = prompt;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('witness-link-discovery-modal');

		contentEl.createEl('h2', { text: `Link discovery: "${this.title}"` });

		// Copy button
		const copyBtn = contentEl.createEl('button', {
			text: 'Copy prompt to clipboard',
			cls: 'witness-ld-copy-btn',
		});
		copyBtn.addEventListener('click', () => {
			navigator.clipboard.writeText(this.prompt);
			new Notice('Prompt copied to clipboard');
			copyBtn.textContent = 'Copied!';
			setTimeout(() => { copyBtn.textContent = 'Copy prompt to clipboard'; }, 2000);
		});

		// Prompt display
		const promptEl = contentEl.createEl('pre', {
			cls: 'witness-ld-prompt',
		});
		promptEl.createEl('code', { text: this.prompt });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
