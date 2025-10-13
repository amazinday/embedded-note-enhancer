import { Plugin, TFile, MarkdownView, App, PluginSettingTab, Setting, MarkdownRenderer } from 'obsidian';

interface EmbeddedNoteEnhancerSettings {
	fontSize: string;
	showCollapseIcon: boolean;
	showEditButton: boolean;
	showJumpButton: boolean;
	jumpInNewTab: boolean;
	autoSaveDelay: number;
	manualSaveOnly: boolean;
	livePreviewEnabled: boolean;
	collapseStates: Record<string, boolean>;
	debugMode: boolean;
}

const DEFAULT_SETTINGS: EmbeddedNoteEnhancerSettings = {
	fontSize: '14px',
	showCollapseIcon: true,
	showEditButton: true,
	showJumpButton: true,
	jumpInNewTab: true,
	autoSaveDelay: 1000,
	manualSaveOnly: false,
	livePreviewEnabled: false,
	collapseStates: {},
	debugMode: false
};

export default class EmbeddedNoteEnhancerPlugin extends Plugin {
	settings!: EmbeddedNoteEnhancerSettings;
	public collapseStates: Map<string, boolean> = new Map();
	public embeddedBlocks: Map<string, HTMLElement> = new Map();
	private mutationObserver?: MutationObserver;
	private periodicCheckInterval?: NodeJS.Timeout;
	private bootstrapSweepInterval?: NodeJS.Timeout;
	private lastEmbeddedCount: number = 0;
	// 调试日志总开关（默认关闭，避免重复输出）
	private debugVerbose: boolean = false;
	
	// 简化日志方法
	private log(message: string, ...args: unknown[]) {
		if (this.settings?.debugMode || this.debugVerbose) {
			console.log(`[EmbeddedNoteEnhancer] ${message}`, ...args);
		}
	}
	
	private warn(message: string, ...args: unknown[]) {
		console.warn(`[EmbeddedNoteEnhancer] ${message}`, ...args);
	}
	
	private error(message: string, ...args: unknown[]) {
		console.error(`[EmbeddedNoteEnhancer] ${message}`, ...args);
	}
	// 日志去抖：同一 key 在 ttl 内只打印一次
	public lastLogTimes: Map<string, number> = new Map();
	// 编辑中的文件集合，用于防止编辑时触发重新渲染
	private editingFiles: Set<string> = new Set();
	// 追踪本插件添加到 DOM 的事件监听器，便于卸载时完全移除
	private trackedEvents: Array<{ el: EventTarget; type: string; handler: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }>=[];
	// 缓存图片嵌入检测结果，避免重复检测
	private imageEmbedCache: Map<HTMLElement, boolean> = new Map();
	// 防止短时间内重复处理同一个容器
	private processingContainers: Set<HTMLElement> = new Set();
	// 缓存文件类型检测结果，避免重复的文件解析
	private fileTypeCache: Map<string, boolean> = new Map();
	// 防止短时间内重复处理，提升性能
	private processingThrottle: Map<string, number> = new Map();
	// 缓存已处理的文件路径，避免重复处理相同的文件结构
	private processedFiles: Set<string> = new Set();
	// 缓存文件的嵌入结构，避免重复计算
	private fileEmbedStructure: Map<string, { timestamp: number; embedCount: number; hasImages: boolean }> = new Map();
	// 追踪正在创建的文件，避免过早处理导致卡死
	private filesBeingCreated: Set<string> = new Set();
	// 防抖定时器，避免在用户输入过程中频繁处理
	private debounceTimer: NodeJS.Timeout | null = null;

	/** 为元素添加监听器并记录，便于后续移除 */
	private addTrackedEventListener(
		el: EventTarget,
		type: string,
		handler: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions
	) {
		try {
			// @ts-ignore - EventTarget in DOM supports addEventListener
			el.addEventListener(type, handler, options);
			this.trackedEvents.push({ el, type, handler, options });
		} catch {}
	}

	/** 移除某个根节点下所有由本插件添加的事件监听器 */
	private removeTrackedEventListenersForRoot(root: HTMLElement) {
		const remaining: typeof this.trackedEvents = [];
		this.trackedEvents.forEach((rec) => {
			const target = rec.el;
			const isNode = target && typeof target === 'object' && 'addEventListener' in target;
			let shouldRemove = false;
			if (isNode) {
				if (target === root) {
					shouldRemove = true;
				} else if (target instanceof Node && root.contains(target)) {
					shouldRemove = true;
				}
			}
			if (shouldRemove) {
				try {
					// @ts-ignore
					target.removeEventListener(rec.type, rec.handler, rec.options);
				} catch {}
			} else {
				remaining.push(rec);
			}
		});
		this.trackedEvents = remaining;
	}

	/** 移除所有由本插件添加的事件监听器 */
	private removeAllTrackedEventListeners() {
		this.trackedEvents.forEach((rec) => {
			try {
				// @ts-ignore
				rec.el.removeEventListener(rec.type, rec.handler, rec.options);
			} catch {}
		});
		this.trackedEvents = [];
	}

	private logOnce(key: string, message: string, ...args: unknown[]) {
		const now = Date.now();
		const last = this.lastLogTimes.get(key) || 0;
		const ttl = 2000; // 增加到2秒，减少重复
		if (now - last > ttl) {
			this.log(message, ...args);
			this.lastLogTimes.set(key, now);
		}
	}

	/** 重新渲染当前 Markdown 视图（不新开面板） */
    private async refreshActiveMarkdownView() {
		try {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			const file = this.app.workspace.getActiveFile();
			if (view && file) {
				await view.leaf.openFile(file, { active: true });
			}
        } catch {}
	}

	/** 获取嵌入内容容器（兼容 markdown-embed-content 与 internal-embed-content） */
	private getEmbedContent(block: HTMLElement): HTMLElement | null {
		return block.querySelector('.markdown-embed-content, .internal-embed-content') as HTMLElement | null;
	}

	async onload() {
		this.log('Plugin loading...');
		await this.loadSettings();

		// 恢复保存的折叠状态
		this.restoreCollapseStates();

		// 添加设置标签页
			this.addSettingTab(new EmbeddedNoteEnhancerSettingTab(this.app, this));

		// 初始化插件功能
			this.initializePlugin();
		}

	/**
	 * 恢复保存的折叠状态
	 */
	private restoreCollapseStates() {
		// 将设置中的折叠状态恢复到内存中的Map
		Object.entries(this.settings.collapseStates).forEach(([blockId, isCollapsed]) => {
			this.collapseStates.set(blockId, isCollapsed);
		});
		this.log('Restored collapse states:', this.settings.collapseStates);
	}

	/**
	 * 保存当前的折叠状态到设置中
	 */
	private saveCurrentCollapseStates() {
		// 将内存中的折叠状态保存到设置中
		this.settings.collapseStates = Object.fromEntries(this.collapseStates);
		this.saveSettings();
		this.log('Saved collapse states:', this.settings.collapseStates);
	}

	/**
	 * 应用保存的折叠状态到所有嵌入块（包括嵌套的）
	 */
	private applySavedCollapseStates() {
		// 查找所有已处理的嵌入块
		const allProcessedBlocks = document.querySelectorAll('.markdown-embed[data-embedded-note-enhanced], .internal-embed[data-embedded-note-enhanced]');
		
		allProcessedBlocks.forEach((block) => {
			const blockId = block.getAttribute('data-block-id');
			if (blockId && this.collapseStates.has(blockId)) {
				const isCollapsed = this.collapseStates.get(blockId);
				if (isCollapsed !== undefined) {
					this.setBlockCollapsed(block as HTMLElement, isCollapsed);
					this.log(`Applied saved collapse state for ${blockId}: ${isCollapsed}`);
				}
			}
		});
	}

	/**
	 * 初始化插件功能
	 */
	public initializePlugin() {
		// 加载样式
		this.addStyles();

		// 在 Markdown 渲染后处理嵌入块（更可靠）
		this.registerMarkdownPostProcessor((element) => {
			this.processEmbeddedBlocksIn(element as HTMLElement);
		});

		// 监听工作区变化
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.processEmbeddedBlocks();
			})
		);

		// 冷启动加强：监听文件打开后再处理一次，确保嵌套内容已渲染
		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				// 预加载文件类型缓存，提升性能
				this.preloadFileTypeCache();
				
				// 简化调用，只保留必要的处理
				setTimeout(() => { this.processEmbeddedBlocks(); }, 200);
				setTimeout(() => { this.applySavedCollapseStates(); }, 800);
				// 文件打开后也启动自愈扫描，确保样式统一
				this.startBootstrapSweep();
			})
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.processEmbeddedBlocks();
			})
		);

		// 监听文件变化
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile) {
					this.handleFileModify(file);
				}
			})
		);

		// 监听文件创建
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (file instanceof TFile) {
					// 文件创建完成，从创建列表中移除
					this.filesBeingCreated.delete(file.path);
					this.filesBeingCreated.delete(file.basename);
					// 延迟处理，确保文件完全创建，但增加延迟时间避免与MutationObserver冲突
					setTimeout(() => {
						this.processEmbeddedBlocks();
					}, 1000); // 从500ms增加到1000ms
				}
			})
		);

		// 监听文件重命名事件（作为保存的替代）
		this.registerEvent(
			this.app.vault.on('rename', (file) => {
				if (file instanceof TFile) {
					this.handleFileSave(file);
				}
			})
		);

		// 冷启动加强：当 metadata 解析完成时，再统一处理一次嵌套
		this.registerEvent(
			(this.app.metadataCache as any).on?.('resolved', () => {
				// 简化调用，避免重复处理
				setTimeout(() => { this.processEmbeddedBlocks(); }, 300);
				// metadata解析完成后也启动自愈扫描，确保样式统一
				this.startBootstrapSweep();
			})
		);

		// 设置 MutationObserver 来监听DOM变化，处理动态添加的嵌套嵌入
		this.setupMutationObserver();

		// 监听工作区渲染完成事件
		this.registerEvent(
			this.app.workspace.on('resize', () => {
				setTimeout(() => {
					this.processEmbeddedBlocks();
				}, 100);
			})
		);

		// 初始处理
		this.log('Starting initial processing...');
		this.processEmbeddedBlocks();
		
		// 冷启动自愈扫描：在短时间内高频尝试，直到嵌入数量稳定
		this.startBootstrapSweep();
		// 在布局就绪后再触发一次，确保冷启动初次渲染后的嵌套也被处理
		this.app.workspace.onLayoutReady?.(() => {
			setTimeout(() => {
				this.processEmbeddedBlocks();
			}, 100);
		});
		// 冷启动兜底：简化调用，只保留必要的处理
		setTimeout(() => {
			this.processEmbeddedBlocks();
		}, 500);
		setTimeout(() => {
			this.processEmbeddedBlocks();
		}, 1500);
		
		// 移除这里的模拟调用，改为在自愈扫描完成后执行
		
		// 设置定期检查，确保嵌套嵌入在文件修改后能够被正确处理
		this.setupPeriodicCheck();
		
		this.log('Plugin loaded successfully');
		
		// 添加全局方法用于手动触发处理（调试用）
			(window as any).embeddedNoteEnhancerPlugin = this;
		
	}

	/** 冷启动短期高频扫描，覆盖二层嵌套渲染滞后 */
	private startBootstrapSweep() {
		if (this.bootstrapSweepInterval) clearInterval(this.bootstrapSweepInterval);
		const deadline = Date.now() + 3000; // 减少到最多自愈3秒
		this.lastEmbeddedCount = 0;
		this.bootstrapSweepInterval = setInterval(() => {
			// 扫一轮
			this.processEmbeddedBlocks();
			// 判断是否稳定：已处理的块数量在两次之间未增长
			const current = this.embeddedBlocks.size;
			if (current === this.lastEmbeddedCount || Date.now() > deadline) {
				clearInterval(this.bootstrapSweepInterval!);
				this.bootstrapSweepInterval = undefined;
				// 自愈扫描完成
				this.log('Bootstrap sweep completed');
				return;
			}
			this.lastEmbeddedCount = current;
		}, 500); // 增加间隔到500ms，减少频率
	}


	/**
	 * 冷启动/重渲染后统一对块与内容应用与"编辑保存后"一致的样式
	 */
	private applyUnifiedBlockStyles(block: HTMLElement) {
		if (!block.matches('.markdown-embed, .internal-embed')) return;
		
		// 检查是否为图片嵌入，如果是则跳过样式应用
		if (this.isImageEmbed(block)) {
			this.log(`Skipping style application for image embed`);
			return;
		}
		
		// 检查是否为PDF嵌入，如果是则跳过样式应用
		if (this.isPdfEmbed(block)) {
			this.log(`Skipping style application for PDF embed`);
			return;
		}
		
		const level = this.calculateNestLevel(block);
		// 移除直接样式设置，使用CSS类
		block.setAttribute('data-nest-level', String(level));
	}

	onunload() {
		this.log('Plugin unloading...');
		
		
		// 清理全局引用
							try { delete (window as any).embeddedNoteEnhancerPlugin; } catch {}
		
		// 清理所有标题栏和还原DOM结构
		this.removeAllTitleBars();

		// 移除所有通过插件添加的事件监听器（兜底）
		this.removeAllTrackedEventListeners();
		
		// 移除样式
		this.removeStyles();
		
		// 清理 MutationObserver
		if (this.mutationObserver) {
			this.mutationObserver.disconnect();
			this.mutationObserver = undefined;
		}
		
		// 清理定期检查
		if (this.periodicCheckInterval) {
			clearInterval(this.periodicCheckInterval);
			this.periodicCheckInterval = undefined;
		}
		
		// 清理自愈扫描
		if (this.bootstrapSweepInterval) {
			clearInterval(this.bootstrapSweepInterval);
			this.bootstrapSweepInterval = undefined;
		}
		
		// 清理防抖定时器
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		
		// 保存当前的折叠状态到设置中
		this.saveCurrentCollapseStates();
		
		// 清理内存引用
		this.embeddedBlocks.clear();
		this.collapseStates.clear();
		this.lastLogTimes.clear();
		this.imageEmbedCache.clear();
		this.processingContainers.clear();
		this.fileTypeCache.clear();
		this.processingThrottle.clear();
		this.processedFiles.clear();
		this.fileEmbedStructure.clear();
		
		// 强制请求 Obsidian 重新渲染当前活动视图到原生状态
		try {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			const file = this.app.workspace.getActiveFile();
			if (view && file) {
				// 延迟重新打开文件，确保所有清理完成
				setTimeout(() => {
					void view.leaf.openFile(file, { active: true });
				}, 100);
			}
		} catch {}
		
		this.log('Plugin unloaded successfully');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * 设置 MutationObserver 来监听DOM变化
	 */
	private setupMutationObserver() {
		this.mutationObserver = new MutationObserver((mutations) => {
			// 检查是否在我们的编辑器中编辑，如果是则跳过处理
			const activeElement = document.activeElement as HTMLElement;
			if ((activeElement && activeElement.closest('.embedded-note-editor')) ||
				document.querySelector('textarea.embedded-note-editor')) {
				return; // 在我们的编辑器中编辑时，不处理DOM变化
			}
			
			// 检查是否有文件正在创建中，如果有则跳过处理避免卡死
			if (this.filesBeingCreated.size > 0) {
				this.log(`Skipping mutation processing due to files being created: ${Array.from(this.filesBeingCreated)}`);
				return;
			}
			
			let shouldProcess = false;
			let shouldReprocessNested = false;
			
			mutations.forEach((mutation) => {
				if (mutation.type === 'childList') {
					mutation.addedNodes.forEach((node) => {
						if (node.nodeType === Node.ELEMENT_NODE) {
							const element = node as HTMLElement;
							// 检查是否添加了新的嵌入块
							if (element.classList.contains('markdown-embed') || 
								element.classList.contains('internal-embed') ||
								element.querySelector('.markdown-embed, .internal-embed')) {
								shouldProcess = true;
							}
							
							// 检查是否添加了嵌入内容区域
							if (element.classList.contains('markdown-embed-content') ||
								element.querySelector('.markdown-embed-content')) {
								shouldReprocessNested = true;
							}
						}
					});
					
					// 检查是否有嵌入块被重新渲染
					mutation.removedNodes.forEach((node) => {
						if (node.nodeType === Node.ELEMENT_NODE) {
							const element = node as HTMLElement;
							if (element.classList.contains('markdown-embed') || 
								element.classList.contains('internal-embed')) {
								shouldReprocessNested = true;
							}
						}
					});
				} else if (mutation.type === 'attributes') {
					const el = mutation.target as HTMLElement;
					// 当嵌入块的 class 变为 is-loaded（Obsidian 完成渲染）时，确保标题栏存在
					if (el.classList.contains('markdown-embed') || el.classList.contains('internal-embed')) {
						if (el.classList.contains('is-loaded')) {
							const hasTitle = !!el.querySelector('.embedded-note-title-bar');
							if (!hasTitle) {
								// 即便之前标记过 data-title-bar-added，但若标题栏被系统重渲染覆盖，应当重新插入
								try { this.processEmbeddedBlock(el); } catch {}
							}
							// 无论是否新插入标题栏，统一应用样式，保证与编辑保存后风格一致
							this.applyUnifiedBlockStyles(el as HTMLElement);
						}
					}
				}
			});
			
			if (shouldProcess) {
				// 延迟处理，确保DOM完全更新
				setTimeout(() => {
					this.processEmbeddedBlocks();
				}, 300);
			}
			
			if (shouldReprocessNested) {
				// 延迟处理嵌套嵌入，确保内容完全重新渲染
				setTimeout(() => {
					this.reprocessAllNestedEmbeds();
				}, 500);
			}
		});
		
		// 开始观察整个文档的变化
		this.mutationObserver.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['class']
		});
	}

	/**
	 * 设置定期检查机制
	 */
	private setupPeriodicCheck() {
		// 每5秒检查一次是否有未处理的嵌套嵌入
		this.periodicCheckInterval = setInterval(() => {
			// 检查是否在我们的编辑器中编辑，如果是则跳过检查
			const activeElement = document.activeElement as HTMLElement;
			if ((activeElement && activeElement.closest('.embedded-note-editor')) ||
				document.querySelector('textarea.embedded-note-editor')) {
				return; // 在我们的编辑器中编辑时，不进行定期检查
			}
			
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView) return;
			
			const container = activeView.contentEl;
			if (!container) return;
			
			// 查找所有未处理的嵌入块
			const unprocessedEmbeds = container.querySelectorAll('.markdown-embed:not([data-title-bar-added]), .internal-embed:not([data-title-bar-added])');
			
			if (unprocessedEmbeds.length > 0) {
				// console.log(`[EmbeddedNoteEnhancer] Found ${unprocessedEmbeds.length} unprocessed embeds during periodic check`);
				unprocessedEmbeds.forEach((embedBlock) => {
					this.processEmbeddedBlock(embedBlock as HTMLElement);
				});
			}
		}, 10000); // 增加检查间隔到10秒
	}

	/**
	 * 添加样式到页面
	 */
	private addStyles() {
		const styleEl = document.createElement('style');
							styleEl.id = 'embedded-note-enhancer-styles';
		styleEl.textContent = `
							/* Embedded Note Enhancer Plugin Styles */
			.embedded-note-title-bar {
				position: relative;
				z-index: 1;
				transition: all 0.2s ease;
                box-sizing: border-box;
                width: 100%;
			}

			/* 强制覆盖所有可能的主题样式 - 最高优先级 */
			.markdown-embed[data-embedded-note-enhanced="true"],
			.internal-embed[data-embedded-note-enhanced="true"],
			div.markdown-embed[data-embedded-note-enhanced="true"],
			span.internal-embed[data-embedded-note-enhanced="true"] {
				margin-left: 0px !important;
				margin-right: 0px !important;
				margin-top: 0px !important;
				margin-bottom: 0px !important;
				box-sizing: border-box !important;
			}

			/* Ensure span.internal-embed behaves like a block when enhanced */
			.internal-embed[data-embedded-note-enhanced="true"],
			.markdown-embed[data-embedded-note-enhanced="true"] {
				display: block;
				width: 100%;
			}

			/* Hide Obsidian's default embed header and open-link icon only when enhanced */
			.markdown-embed[data-embedded-note-enhanced="true"] .markdown-embed-title,
			.markdown-embed[data-embedded-note-enhanced="true"] .markdown-embed-link,
			.internal-embed[data-embedded-note-enhanced="true"] .embed-title,
			.internal-embed[data-embedded-note-enhanced="true"] .markdown-embed-link {
				display: none !important;
			}

			/* When collapsed, hide everything except our custom title bar */
			.markdown-embed.embedded-note-collapsed[data-embedded-note-enhanced="true"] > :not(.embedded-note-title-bar),
			.internal-embed.embedded-note-collapsed[data-embedded-note-enhanced="true"] > :not(.embedded-note-title-bar) {
				display: none !important;
			}

			/* 统一的嵌入块样式（同时覆盖 markdown-embed 与 internal-embed） */
			.markdown-embed[data-embedded-note-enhanced="true"],
			.internal-embed[data-embedded-note-enhanced="true"] {
				margin-top: 0px;
				margin-bottom: 0px;
				border-radius: 6px;
				overflow: hidden;
				box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
				transition: all 0.2s ease;
				border: 1px solid var(--background-modifier-border);
				padding: 0; /* 均衡不同类型容器的默认内边距差异 */
			}

			.markdown-embed[data-embedded-note-enhanced="true"]:hover {
				box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
			}

            /* 嵌套层级样式 - 外框与外层间距：左7px/层，右14px/层 */
            /* 使用更高优先级的选择器确保样式生效 */
            .markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="0"],
            .internal-embed[data-embedded-note-enhanced="true"][data-nest-level="0"],
            div.markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="0"],
            span.internal-embed[data-embedded-note-enhanced="true"][data-nest-level="0"] {
                margin-left: 0px !important;
                margin-right: 0px !important;
                box-sizing: border-box !important;
            }

            .markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="1"],
            .internal-embed[data-embedded-note-enhanced="true"][data-nest-level="1"],
            div.markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="1"],
            span.internal-embed[data-embedded-note-enhanced="true"][data-nest-level="1"] {
                margin-left: 7px !important;
                margin-right: 14px !important;
                box-sizing: border-box !important;
            }

            .markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="2"],
            .internal-embed[data-embedded-note-enhanced="true"][data-nest-level="2"],
            div.markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="2"],
            span.internal-embed[data-embedded-note-enhanced="true"][data-nest-level="2"] {
                margin-left: 14px !important;
                margin-right: 28px !important;
                box-sizing: border-box !important;
            }

            .markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="3"],
            .internal-embed[data-embedded-note-enhanced="true"][data-nest-level="3"],
            div.markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="3"],
            span.internal-embed[data-embedded-note-enhanced="true"][data-nest-level="3"] {
                margin-left: 21px !important;
                margin-right: 42px !important;
                box-sizing: border-box !important;
            }

			/* 统一的标题栏样式 - 使用Obsidian主题变量 */
			.markdown-embed[data-embedded-note-enhanced="true"] .embedded-note-title-bar,
			.internal-embed[data-embedded-note-enhanced="true"] .embedded-note-title-bar {
				background-color: var(--background-secondary);
				color: var(--interactive-accent, var(--text-accent, var(--accent, #7c3aed)));
				border-bottom: 1px solid var(--background-modifier-border);
				position: relative;
				font-weight: var(--font-weight-normal);
			}

			.embedded-note-title-bar:hover {
				background-color: var(--background-modifier-hover) !important;
			}

			.embedded-note-title-bar:active {
				background-color: var(--background-modifier-active) !important;
			}

			.embedded-note-collapse-icon {
				opacity: 0.7;
				color: var(--interactive-accent, var(--text-accent, var(--accent, #7c3aed)));
				transition: transform 0.2s ease, opacity 0.2s ease;
			}

			.embedded-note-title-bar:hover .embedded-note-collapse-icon {
				opacity: 1;
				color: var(--interactive-accent, var(--text-accent, var(--accent, #7c3aed)));
			}

			/* 编辑按钮样式 */
			.embedded-note-edit-btn {
				background: var(--background-primary) !important;
				color: var(--interactive-accent, var(--text-accent, var(--accent, #7c3aed))) !important;
				border: 1px solid var(--interactive-accent, var(--text-accent, var(--accent, #7c3aed))) !important;
				transition: all 0.2s ease !important;
			}

			.embedded-note-edit-btn:hover {
				background: var(--interactive-accent, var(--text-accent, var(--accent, #7c3aed))) !important;
				color: var(--background-primary) !important;
				border-color: var(--interactive-accent, var(--text-accent, var(--accent, #7c3aed))) !important;
			}

			.embedded-note-edit-btn:active {
				background: var(--background-modifier-active) !important;
			}

			/* 跳转按钮样式 */
			.embedded-note-jump-btn {
				background: var(--background-primary) !important;
				color: var(--interactive-accent, var(--text-accent, var(--accent, #7c3aed))) !important;
				border: 1px solid var(--interactive-accent, var(--text-accent, var(--accent, #7c3aed))) !important;
				transition: all 0.2s ease !important;
			}

			.embedded-note-jump-btn:hover {
				background: var(--interactive-accent, var(--text-accent, var(--accent, #7c3aed))) !important;
				color: var(--background-primary) !important;
				border-color: var(--interactive-accent, var(--text-accent, var(--accent, #7c3aed))) !important;
			}

			.embedded-note-jump-btn:active {
				background: var(--background-modifier-active) !important;
			}

			/* 移除嵌套层级指示器样式 */

			/* 确保与不同主题的兼容性 */
			.theme-dark .embedded-note-title-bar {
				border-bottom-color: var(--background-modifier-border);
			}

			.theme-light .embedded-note-title-bar {
				border-bottom-color: var(--background-modifier-border);
			}

			/* Minimal 主题兼容性 */
			.minimal-theme .embedded-note-title-bar {
				background-color: var(--background-secondary);
			}

			/* Blue Topaz 主题兼容性 */
			.blue-topaz .embedded-note-title-bar {
				background-color: var(--background-secondary);
			}

			/* Things 主题兼容性 */
			.things-theme .embedded-note-title-bar {
				background-color: var(--background-secondary);
			}

			/* Dracula 主题兼容性 */
			.dracula-theme .embedded-note-title-bar {
				background-color: var(--background-secondary);
			}

			/* 通用主题兼容性 - 确保在所有主题下都有良好的视觉效果 */
			.markdown-embed[data-embedded-note-enhanced="true"],
			.internal-embed[data-embedded-note-enhanced="true"] {
				background-color: var(--background-primary);
			}

            .markdown-embed[data-embedded-note-enhanced="true"] .markdown-embed-content,
            .internal-embed[data-embedded-note-enhanced="true"] .markdown-embed-content,
            .internal-embed[data-embedded-note-enhanced="true"] .internal-embed-content {
				background-color: var(--background-primary);
                padding-left: 14px;
                padding-right: 14px;
                box-sizing: border-box;
			}

			/* 确保标题栏在嵌入内容上方 */
			.markdown-embed .embedded-note-title-bar {
				margin: 0;
				border-radius: 0;
			}

			/* 响应式设计 */
			@media (max-width: 768px) {
				.embedded-note-title-bar {
					padding: 6px 10px;
					font-size: 13px;
				}
				
				.markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="1"],
				.internal-embed[data-embedded-note-enhanced="true"][data-nest-level="1"],
				div.markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="1"],
				span.internal-embed[data-embedded-note-enhanced="true"][data-nest-level="1"] {
					margin-left: 7px !important;
				}
				
				.markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="2"],
				.internal-embed[data-embedded-note-enhanced="true"][data-nest-level="2"],
				div.markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="2"],
				span.internal-embed[data-embedded-note-enhanced="true"][data-nest-level="2"] {
					margin-left: 14px !important;
				}
				
				.markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="3"],
				.internal-embed[data-embedded-note-enhanced="true"][data-nest-level="3"],
				div.markdown-embed[data-embedded-note-enhanced="true"][data-nest-level="3"],
				span.internal-embed[data-embedded-note-enhanced="true"][data-nest-level="3"] {
					margin-left: 21px !important;
				}
			}

			/* 高对比度模式支持 */
			@media (prefers-contrast: high) {
				.embedded-note-title-bar {
					border: 1px solid var(--text-normal);
				}
			}

			/* 减少动画模式支持 */
			@media (prefers-reduced-motion: reduce) {
				.embedded-note-title-bar,
				.embedded-note-collapse-icon {
					transition: none;
				}
			}

			/* 编辑模式样式（使用 textarea 进行原文编辑） */
			.embedded-note-editor {
				width: 100%;
				min-height: 140px;
				box-sizing: border-box;
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				padding: 8px;
				background-color: var(--background-primary);
				color: var(--text-normal);
				font-family: var(--font-editor);
				font-size: var(--editor-font-size);
				line-height: 1.5;
				resize: vertical;
			}

			/* 嵌套嵌入内容的过渡效果 */
			.markdown-embed-content {
				transition: height 0.3s ease, visibility 0.3s ease;
			}

		`;
		document.head.appendChild(styleEl);
	}

	/**
	 * 处理嵌入块，添加标题栏
	 */
	public processEmbeddedBlocks() {
		// 检查是否有文件正在创建中，如果有则跳过处理避免卡死
		if (this.filesBeingCreated.size > 0) {
			this.log(`Skipping processEmbeddedBlocks due to files being created: ${Array.from(this.filesBeingCreated)}`);
			return;
		}
		
		this.throttledProcess('processEmbeddedBlocks', () => {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return;

		const container = activeView.contentEl;
		if (!container) return;

		this.processEmbeddedBlocksIn(container);
		}, 200); // 增加节流时间
	}

	/**
	 * 在指定容器内处理嵌入块
	 */
	private processEmbeddedBlocksIn(container: HTMLElement) {
		// 查找所有嵌入块 - 尝试多种可能的选择器
		let embeddedBlocks = container.querySelectorAll('.markdown-embed');
		if (embeddedBlocks.length === 0) {
			embeddedBlocks = container.querySelectorAll('.internal-embed');
		}
		if (embeddedBlocks.length === 0) {
			embeddedBlocks = container.querySelectorAll('[data-type="markdown-embed"]');
		}
		
		// 按层级顺序处理，确保父级嵌入块先被处理
		const blocksArray = Array.from(embeddedBlocks) as HTMLElement[];
		blocksArray.sort((a, b) => {
			const aLevel = this.calculateNestLevel(a);
			const bLevel = this.calculateNestLevel(b);
			return aLevel - bLevel;
		});
		
		// 处理所有嵌入块
		blocksArray.forEach((block) => {
			// 检查是否为图片嵌入，如果是则跳过处理
			if (this.isImageEmbed(block)) {
				if (this.debugVerbose) console.log(`[EmbeddedNoteEnhancer] Skipping image embed in main processing:`, block);
				return;
			}
			
			// 检查是否为PDF嵌入，如果是则跳过处理
			if (this.isPdfEmbed(block)) {
				if (this.debugVerbose) console.log(`[EmbeddedNoteEnhancer] Skipping PDF embed in main processing:`, block);
				return;
			}
			
			this.processEmbeddedBlock(block);
			// 冷启动/首轮渲染时强制统一样式
			this.applyUnifiedBlockStyles(block);
		});
		
		// 延迟递归处理嵌套的嵌入块，确保DOM完全渲染
		setTimeout(() => {
			this.processNestedEmbeds(container, 0);
		}, 100);
		
		// 再次延迟处理，确保所有嵌套内容都已渲染
		setTimeout(() => {
			this.processNestedEmbeds(container, 0);
		}, 300);
		
		// 使用更长的延迟来处理复杂的嵌套结构
		setTimeout(() => {
			this.processNestedEmbeds(container, 0);
		}, 600);
		
		// 最后尝试处理所有可能的嵌套嵌入
		setTimeout(() => {
			this.processAllNestedEmbeds(container);
		}, 1000);
	}

	/**
	 * 递归处理嵌套的嵌入块
	 */
	private processNestedEmbeds(container: HTMLElement, depth: number = 0) {
		// 防止无限递归，限制最大深度
		if (depth > 10) {
			this.warn(`Maximum recursion depth reached in processNestedEmbeds`);
			return;
		}

		// 防止短时间内重复处理同一个容器
		if (this.processingContainers.has(container)) {
			this.log(`Container already being processed, skipping`);
			return;
		}

		// 检查当前文件是否需要处理嵌套嵌入
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.file && !this.shouldReprocessNestedEmbeds(activeView.file.path)) {
			this.log(`Skipping nested processing due to cache`);
			return;
		}

		this.processingContainers.add(container);
		
		// 查找所有嵌入块，包括嵌套的
		const allEmbeds = container.querySelectorAll('.markdown-embed, .internal-embed, [data-type="markdown-embed"]');
		
		let hasNewEmbeds = false;
		let processedCount = 0;
		let imageEmbedCount = 0;
		
		allEmbeds.forEach((embedBlock) => {
			// 检查是否为图片嵌入，如果是则跳过处理
			if (this.isImageEmbed(embedBlock as HTMLElement)) {
				imageEmbedCount++;
				this.log(`Skipping nested image embed`);
				return;
			}
			
			// 检查是否为PDF嵌入，如果是则跳过处理
			if (this.isPdfEmbed(embedBlock as HTMLElement)) {
				this.log(`Skipping nested PDF embed`);
				return;
			}
			
			// 只处理尚未处理的嵌入块
			if (!embedBlock.hasAttribute('data-title-bar-added')) {
			this.log(`Processing nested embed: ${embedBlock.className}`);
				this.processEmbeddedBlock(embedBlock as HTMLElement);
				processedCount++;
				hasNewEmbeds = true;
			}
		});
		
		// 如果是第一次处理（depth === 0），缓存文件的嵌入结构信息
		if (depth === 0 && activeView?.file) {
			this.cacheFileEmbedStructure(activeView.file.path, allEmbeds.length, imageEmbedCount > 0);
		}
		
		// 如果发现了新的嵌入块，再次递归处理（处理多层嵌套）
		if (hasNewEmbeds && processedCount > 0) {
			setTimeout(() => {
				this.processNestedEmbeds(container, depth + 1);
			}, 50);
		}

		// 每轮处理后，统一刷新嵌套层级标记，确保缩进样式不丢
		this.refreshAllNestLevels();
		
		// 应用保存的折叠状态到嵌套嵌入
		this.applySavedCollapseStates();

		// 清理容器处理标记
		setTimeout(() => {
			this.processingContainers.delete(container);
		}, 100);
	}

	/**
	 * 处理所有可能的嵌套嵌入（更全面的方法）
	 */
	private processAllNestedEmbeds(container: HTMLElement) {
		// 查找所有可能的嵌入块，使用更广泛的选择器
		const allPossibleEmbeds = container.querySelectorAll(`
			.markdown-embed,
			.internal-embed,
			[data-type="markdown-embed"],
			.markdown-embed-content .markdown-embed,
			.markdown-embed-content .internal-embed,
			.internal-embed-content .markdown-embed,
			.internal-embed-content .internal-embed
		`);
		
		// let processedCount = 0;
		
		allPossibleEmbeds.forEach((embedBlock) => {
			// 只处理尚未处理的嵌入块
			if (!embedBlock.hasAttribute('data-title-bar-added')) {
				// 检查是否为图片嵌入，如果是则跳过处理
				if (this.isImageEmbed(embedBlock as HTMLElement)) {
					this.log(`Skipping comprehensive processing of image embed`);
					return;
				}
				
				// 检查是否为PDF嵌入，如果是则跳过处理
				if (this.isPdfEmbed(embedBlock as HTMLElement)) {
					this.log(`Skipping comprehensive processing of PDF embed`);
					return;
				}
				
				// console.log(`[EmbeddedNoteEnhancer] Comprehensive processing of embed:`, embedBlock);
				// console.log(`[EmbeddedNoteEnhancer] Block classes:`, embedBlock.className);
				// console.log(`[EmbeddedNoteEnhancer] Block parent:`, embedBlock.parentElement);
				
				// 尝试处理这个嵌入块
				try {
					this.processEmbeddedBlock(embedBlock as HTMLElement);
					// processedCount++;
				} catch (error) {
					this.error(`Error processing embed:`, error);
				}
			}
			// 无论是否新处理，都统一一次样式
			this.applyUnifiedBlockStyles(embedBlock as HTMLElement);
		});
		
		// console.log(`[EmbeddedNoteEnhancer] Comprehensive method processed ${processedCount} new embeds`);
		// 处理完成后刷新嵌套层级
		this.refreshAllNestLevels();
		
		// 应用保存的折叠状态到所有嵌入块（包括嵌套的）
		this.applySavedCollapseStates();
	}

	/**
	 * 重新计算并写回所有已增强嵌入块的嵌套层级
	 */
	private refreshAllNestLevels() {
		const all = document.querySelectorAll('.markdown-embed[data-embedded-note-enhanced], .internal-embed[data-embedded-note-enhanced]');
		all.forEach((block) => {
			const level = this.calculateNestLevel(block as HTMLElement);
			(block as HTMLElement).setAttribute('data-nest-level', String(level));
			// 移除直接样式设置，使用CSS类
			// 确保统一样式应用
			this.applyUnifiedBlockStyles(block as HTMLElement);
		});
	}

	/**
	 * 根据当前设置，立即对所有已处理的嵌入块应用原地编辑开关
	 */
    public applyInlineEditingState() {
        this.embeddedBlocks.forEach((block) => {
            const embedContent = block.querySelector('.markdown-embed-content') as HTMLElement | null;
            if (!embedContent) return;
            const isCollapsed = block.classList.contains('embedded-note-collapsed');
            if (block.getAttribute('data-editing') === 'true' && !isCollapsed) {
                this.enableInlineEditing(block);
            } else {
                this.disableInlineEditing(embedContent);
            }
        });
    }

	/**
	 * 根据设置对当前已打开的编辑器应用/移除预览
	 */
	public async applyLivePreviewState() {
		for (const [, block] of this.embeddedBlocks) {
			const embedContent = this.getEmbedContent(block) as HTMLElement | null;
			if (!embedContent) continue;
			const editor = embedContent.querySelector('textarea.embedded-note-editor') as HTMLTextAreaElement | null;
			const existing = embedContent.querySelector('.embedded-note-preview') as HTMLElement | null;
			if (!editor) continue;
            if (this.settings.livePreviewEnabled) {
                // 预览功能已移除；此分支保留兼容但不做任何事
            } else {
				if (existing) existing.remove();
			}
		}
	}

	/**
	 * 处理单个嵌入块
	 */
	private processEmbeddedBlock(block: HTMLElement) {
		// 如果标记已添加，但标题栏不存在，则允许继续补回标题栏
		if (block.hasAttribute('data-title-bar-added')) {
			const hasBar = !!block.querySelector('.embedded-note-title-bar');
			if (hasBar) return;
		}

		// 检查是否为图片嵌入，如果是则跳过处理，使用Obsidian原版方式
		if (this.isImageEmbed(block)) {
			if (this.debugVerbose) console.log(`[EmbeddedNoteEnhancer] Skipping image embed, using native Obsidian behavior:`, block);
			return;
		}

		// 检查是否为PDF嵌入，如果是则跳过处理，使用Obsidian原版方式
		if (this.isPdfEmbed(block)) {
			if (this.debugVerbose) console.log(`[EmbeddedNoteEnhancer] Skipping PDF embed, using native Obsidian behavior:`, block);
			return;
		}

		// 处理div元素和包含嵌入内容的span元素
		if (block.tagName.toLowerCase() !== 'div' && block.tagName.toLowerCase() !== 'span') {
		if (this.debugVerbose) console.log(`[EmbeddedNoteEnhancer] Skipping non-div/span element:`, block.tagName, block);
			return;
		}
		
		// 对于span元素，检查是否包含嵌入内容
		if (block.tagName.toLowerCase() === 'span') {
			const hasEmbedContent = block.querySelector('.markdown-embed-content') || 
									block.querySelector('.embed-title') ||
									block.classList.contains('internal-embed') ||
									block.classList.contains('markdown-embed');
			if (!hasEmbedContent) {
			if (this.debugVerbose) console.log(`[EmbeddedNoteEnhancer] Skipping span without embed content:`, block);
				return;
			}
		}

		// 获取来源信息：优先从链接获取，其次从属性中推断
		let href: string | null = null;
		let embedLink: Element | null = block.querySelector('.markdown-embed-link');
		if (!embedLink) embedLink = block.querySelector('.internal-link');
		if (!embedLink) embedLink = block.querySelector('a[href]');
		if (embedLink) {
			href = (embedLink as HTMLElement).getAttribute('href');
		}
		if (!href) {
			// 某些版本将路径放在 src/href 或 data-src 上
			href = block.getAttribute('src') || block.getAttribute('href') || block.getAttribute('data-src');
		}
		if (!href) {
			// console.log(`[EmbeddedNoteEnhancer] No href/src found in block`);
			return;
		}

		// console.log(`[EmbeddedNoteEnhancer] Found href: ${href}`);

        // 提取文件名/链接文本
		const fileName = this.extractFileName(href);
        if (!fileName) {
			// console.log(`[EmbeddedNoteEnhancer] Failed to extract fileName from href: ${href}`);
			return;
		}

		// 检查是否为不完整的嵌入语法（如 ![[]] 或 ![[ ]）
		if (fileName.trim() === '' || fileName === ' ') {
			// console.log(`[EmbeddedNoteEnhancer] Skipping incomplete embed syntax: ${href}`);
			return;
		}

		// 检查是否包含不完整的字符（如 ![[文件名] 或 ![[文件名]]]）
		if (fileName.includes('[') || fileName.includes(']') || fileName.includes('!')) {
			if (this.debugVerbose) console.log(`[EmbeddedNoteEnhancer] Skipping malformed embed syntax: ${href}`);
			return;
		}

		// 检查文件名是否包含特殊字符，如果有则跳过（可能是用户正在输入）
		if (fileName.includes(' ') || fileName.includes('\n') || fileName.includes('\t')) {
			if (this.debugVerbose) console.log(`[EmbeddedNoteEnhancer] Skipping embed with special characters: ${href}`);
			return;
		}

		// console.log(`[EmbeddedNoteEnhancer] Extracted fileName: ${fileName}`);

        // 检查文件是否存在，如果正在创建则延迟处理
        let fileExists = false;
        let isFileBeingCreated = false;
        
        // 方法1：使用 metadataCache 解析链接
        const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(fileName, this.app.workspace.getActiveFile()?.path || '');
        if (resolvedFile) {
            fileExists = true;
        } else {
            // 方法2：直接检查文件路径
            const directFile = this.app.vault.getAbstractFileByPath(fileName);
            if (directFile) {
                fileExists = true;
            } else {
                // 方法3：检查带 .md 扩展名的文件
                const mdFile = this.app.vault.getAbstractFileByPath(`${fileName}.md`);
                if (mdFile) {
                    fileExists = true;
                } else {
                    // 检查是否正在创建文件
                    isFileBeingCreated = this.filesBeingCreated.has(fileName) || 
                                       this.filesBeingCreated.has(`${fileName}.md`);
                }
            }
        }
        
		this.logOnce('file-exists', `File check: ${fileName} - exists: ${fileExists}`);
        
        if (!fileExists) {
            if (isFileBeingCreated) {
                // 文件正在创建中，延迟处理
				this.log(`File being created, delaying: ${fileName}`);
                // 添加递归深度限制，防止无限循环
                const recursionCount = parseInt(block.getAttribute('data-recursion-count') || '0');
                if (recursionCount >= 3) { // 减少最大递归次数
                    this.warn(`Maximum recursion depth reached for file creation: ${fileName}, removing enhancement`);
                    this.removeEnhancement(block);
                    return;
                }
                
                // 增加递归计数
                block.setAttribute('data-recursion-count', String(recursionCount + 1));
                
                // 增加延迟时间，减少处理频率
                setTimeout(() => {
                    this.processEmbeddedBlock(block);
                }, 2000); // 从1秒增加到2秒
                return;
            } else {
                // 文件不存在且不在创建中，检查是否应该标记为正在创建
                // 只有当文件名看起来完整且有效时才标记为正在创建
                if (fileName && fileName.trim() !== '' && fileName !== ' ' && 
                    !fileName.includes('[') && !fileName.includes(']') && !fileName.includes('!') &&
                    !fileName.includes(' ') && !fileName.includes('\n') && !fileName.includes('\t')) {
                    
                    // 标记为正在创建，但设置超时清理
                    this.filesBeingCreated.add(fileName);
                    this.filesBeingCreated.add(`${fileName}.md`);
                    console.log(`[EmbeddedNoteEnhancer] Detected file creation: ${fileName}`);
                    
                    // 设置超时清理，防止永久卡住
                    setTimeout(() => {
                        this.filesBeingCreated.delete(fileName);
                        this.filesBeingCreated.delete(`${fileName}.md`);
                        this.log(`Cleared file creation tracking for: ${fileName}`);
                    }, 15000); // 增加到15秒后清理
                    
                    // 延迟处理，增加延迟时间
                    setTimeout(() => {
                        this.processEmbeddedBlock(block);
                    }, 2000); // 从1秒增加到2秒
                    return;
                } else {
                    // 文件名不完整或无效，移除增强
                    this.warn(`File does not exist and name appears incomplete, removing enhancement: ${fileName}`);
                    this.removeEnhancement(block);
                    return;
                }
            }
        }

		// 计算嵌套层级
		const nestLevel = this.calculateNestLevel(block);

		// 生成唯一ID
		const blockId = this.generateBlockId(block, fileName);
		
		// 检查是否已经有标题栏，避免重复插入
		const existingTitleBar = block.querySelector('.embedded-note-title-bar');
		if (existingTitleBar) {
			this.logOnce('title-exists', `Title bar already exists, skipping`);
			return;
		}
		
		// 创建标题栏
		const titleBar = this.createTitleBar(fileName, blockId, nestLevel);
		
		// 检查内容区域是否存在且有效（兼容 internal-embed-content）
		let embedContent = this.getEmbedContent(block);
		if (!embedContent) {
			// 兜底：某些重渲染阶段，internal-embed 只剩文件名（无内容容器）。
			// 主动创建内容容器并渲染源文件，避免标题栏丢失后无法恢复。
			try {
				const container = document.createElement('div');
				container.className = 'markdown-embed-content';
				// 先清空原有子节点（通常是一个仅含文件名的文本节点），避免重复显示文件名
				while (block.firstChild) block.removeChild(block.firstChild);
				// 将容器放到块内
				block.appendChild(container);
				// 渲染源文件内容
				const activeFile = this.app.workspace.getActiveFile();
				let file = this.app.metadataCache.getFirstLinkpathDest(fileName, activeFile?.path || '') as TFile | null;
				if (!file) {
					file = this.app.vault.getAbstractFileByPath(fileName) as TFile | null ||
						this.app.vault.getAbstractFileByPath(`${fileName}.md`) as TFile | null;
				}
				if (file) {
					this.app.vault.read(file)
						.then((md) => {
							if (file) {
								void MarkdownRenderer.renderMarkdown(md, container, file.path, this);
							}
						})
						.catch(() => {});
				}
				embedContent = container;
			} catch {}
			if (!embedContent) {
				// 仍无法获得内容容器则放弃本次增强
			return;
			}
		}
		
		// console.log(`[EmbeddedNoteEnhancer] Content area found for block ${blockId}:`, embedContent);
		// console.log(`[EmbeddedNoteEnhancer] Content area text content:`, embedContent.textContent?.substring(0, 100));
		
		// 插入标题栏（兼容 span.internal-embed 初始为 inline 的情况）
		if (block.tagName.toLowerCase() === 'span') {
			// 对于span元素，找到第一个内容元素（如embed-title或markdown-embed-content）
			const firstContentElement = block.querySelector('.embed-title, .markdown-embed-content, .markdown-embed-link');
			if (firstContentElement) {
				block.insertBefore(titleBar, firstContentElement);
			} else {
				block.insertBefore(titleBar, block.firstChild);
			}
			// 移除直接样式设置，使用CSS类
			block.setAttribute('data-embedded-note-enhanced', 'true');
		} else {
			block.insertBefore(titleBar, block.firstChild);
		}
		
		// 标记已处理
		block.setAttribute('data-title-bar-added', 'true');
		block.setAttribute('data-block-id', blockId);
		block.setAttribute('data-file-link', fileName);
		block.setAttribute('data-embedded-note-enhanced', 'true');
		block.setAttribute('data-nest-level', nestLevel.toString());
		// 移除直接样式设置，使用CSS类
		// 确保初始状态为非编辑状态
		block.setAttribute('data-editing', 'false');

		// 关键：设置 tabindex 以允许内部元素获得焦点，并阻止容器级别的快捷键
		block.setAttribute('tabindex', '-1');
		const keydownHandler = (e: KeyboardEvent) => {
			// 当焦点在编辑器内时，阻断传播
			const active = document.activeElement;
			if (active && active.closest('[data-block-id="' + blockId + '"]')) {
				e.stopPropagation();
			}
		};
		this.addTrackedEventListener(block, 'keydown', keydownHandler as EventListener, true);

		// 防止点击默认的"打开嵌入源文件"图标导致新面板/窗口被打开
		// 仅对已经增强过的嵌入块生效
		const stopOpen = (ev: Event) => {
			// 若当前处于编辑模式，直接拦截
			if (block.getAttribute('data-editing') === 'true') {
				ev.preventDefault();
				ev.stopPropagation();
				return;
			}
			// 即便非编辑状态，也阻断默认的 embed 打开行为，保持单窗口
			ev.preventDefault();
			ev.stopPropagation();
		};
		// Obsidian 的默认打开链接元素可能是 .markdown-embed-link 或 .internal-embed .markdown-embed-link
		// 同时兜底拦截内部的 <a> 链接点击
		block.querySelectorAll('.markdown-embed-link, a.internal-link, a[href]')
			.forEach((el) => {
				this.addTrackedEventListener(el as HTMLElement, 'click', stopOpen, true);
			});
		
		// 存储引用
		this.embeddedBlocks.set(blockId, block);
		
		// 设置初始状态
		const isCollapsed = this.collapseStates.get(blockId) || false;
		this.setBlockCollapsed(block, isCollapsed);
		
		// 调试：检查标题栏是否真的被创建
		if (this.debugVerbose) {
		const createdTitleBar = block.querySelector('.embedded-note-title-bar');
			this.log(`Title bar created for block ${blockId}: ${!!createdTitleBar}`);
		}
	}

	/**
	 * 计算嵌套层级
	 */
	private calculateNestLevel(block: HTMLElement): number {
		let level = 0;
		let parent: HTMLElement | null = block.parentElement as HTMLElement | null;
		// 基于真实 DOM 层级来计算：无论父级是否已被我们增强，只要是嵌入块就计数
		while (parent) {
			if (parent.matches?.('.markdown-embed, .internal-embed')) {
				level++;
			}
			parent = parent.parentElement as HTMLElement | null;
		}
		return Math.min(level, 3);
	}

	/**
	 * 创建标题栏元素
	 */
	private createTitleBar(fileName: string, blockId: string, nestLevel: number = 0): HTMLElement {
		const titleBar = document.createElement('div');
		titleBar.className = 'embedded-note-title-bar';
		titleBar.setAttribute('data-block-id', blockId);
		
		// 移除直接样式设置，使用CSS类
		titleBar.style.fontSize = this.settings.fontSize;

		// 移除嵌套层级指示器，改为通过缩进和边框来区分层级

		// 创建标题文本
		const titleText = document.createElement('span');
		titleText.textContent = fileName;
		titleText.className = 'embedded-note-title-text';
		if (nestLevel > 0) {
			titleText.classList.add('nested');
		}

		// 创建折叠图标
		const collapseIcon = document.createElement('span');
		collapseIcon.className = 'embedded-note-collapse-icon';
		collapseIcon.textContent = '▼';

		// 创建编辑切换按钮
		const editBtn = document.createElement('button');
		editBtn.className = 'embedded-note-edit-btn';
		editBtn.textContent = '编辑';
		editBtn.style.display = this.settings.showEditButton ? 'inline-block' : 'none';

		// 创建跳转按钮
		const jumpBtn = document.createElement('button');
		jumpBtn.className = 'embedded-note-jump-btn';
		jumpBtn.textContent = '跳转';
		jumpBtn.style.display = this.settings.showJumpButton ? 'inline-block' : 'none';

		titleBar.appendChild(titleText);
		// 非编辑状态且设置开启时才显示折叠图标
		if (this.settings.showCollapseIcon && titleBar.getAttribute('data-editing') !== 'true') {
			titleBar.appendChild(collapseIcon);
		}
		if (this.settings.showEditButton) {
		titleBar.appendChild(editBtn);
		}
		if (this.settings.showJumpButton) {
			titleBar.appendChild(jumpBtn);
		}

		// 移除鼠标事件处理，使用CSS hover效果

		// 添加点击事件
		const onTitleClick = (e: MouseEvent) => {
			if ((e.target as HTMLElement).closest('.embedded-note-edit-btn') || 
				(e.target as HTMLElement).closest('.embedded-note-jump-btn')) return;
			// 编辑状态下禁止折叠/展开
			// 直接从DOM中查找块，不依赖于 embeddedBlocks 映射
			const block = document.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
			if (block && block.getAttribute('data-editing') === 'true') return;
			this.toggleBlockCollapse(blockId);
		};
		this.addTrackedEventListener(titleBar, 'click', onTitleClick as EventListener);

		// 编辑按钮切换原地编辑
		const onEditClick = (e: MouseEvent) => {
			e.stopPropagation();
			// 直接从DOM中查找块，不依赖于 embeddedBlocks 映射
			const block = document.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
			if (!block) return;
			const embedContent = block.querySelector('.markdown-embed-content') as HTMLElement | null;
			if (!embedContent) return;
			const editing = block.getAttribute('data-editing') === 'true';
			if (editing) {
				this.log(`Disabling inline editing for block ${blockId}`);
				// 若启用手动保存，关闭编辑前强制保存一次
				if (this.settings.manualSaveOnly) {
					const editor = embedContent.querySelector('textarea.embedded-note-editor') as HTMLTextAreaElement | null;
					if (editor) {
						this.saveEditorContent(editor, block);
					}
				}
				this.disableInlineEditing(embedContent);
				block.setAttribute('data-editing', 'false');
				editBtn.textContent = '编辑';
				// 退出编辑时恢复折叠图标显示（若设置允许）
				const icon = titleBar.querySelector('.embedded-note-collapse-icon') as HTMLElement | null;
				if (this.settings.showCollapseIcon) {
					if (icon) icon.style.display = 'block';
					else {
						const newIcon = document.createElement('span');
						newIcon.className = 'embedded-note-collapse-icon';
						newIcon.textContent = '▼';
						titleBar.appendChild(newIcon);
					}
				}
			} else {
				this.log(`Enabling inline editing for block ${blockId}`);
				
				// 如果块处于折叠状态，先展开它
				if (block.classList.contains('embedded-note-collapsed')) {
					this.toggleBlockCollapse(blockId);
					// 等待展开完成后再启用编辑
					setTimeout(() => {
						this.enableInlineEditing(block);
						block.setAttribute('data-editing', 'true');
						editBtn.textContent = '完成';
						// 进入编辑时隐藏折叠图标
						const icon = titleBar.querySelector('.embedded-note-collapse-icon') as HTMLElement | null;
						if (icon) icon.style.display = 'none';
					}, 100); // 短暂延迟确保展开完成
				} else {
					// 如果已经展开，直接启用编辑
				this.enableInlineEditing(block);
				block.setAttribute('data-editing', 'true');
				editBtn.textContent = '完成';
				// 进入编辑时隐藏折叠图标
				const icon = titleBar.querySelector('.embedded-note-collapse-icon') as HTMLElement | null;
				if (icon) icon.style.display = 'none';
				}
			}
		};
		this.addTrackedEventListener(editBtn, 'click', onEditClick as EventListener);

		// 跳转按钮点击事件
		const onJumpClick = (e: MouseEvent) => {
			e.stopPropagation();
			this.jumpToFile(fileName);
		};
		this.addTrackedEventListener(jumpBtn, 'click', onJumpClick as EventListener);

		return titleBar;
	}

	/**
	 * 跳转到指定文件
	 */
	private jumpToFile(fileName: string) {
		try {
			const activeFile = this.app.workspace.getActiveFile();
			let file = this.app.metadataCache.getFirstLinkpathDest(fileName, activeFile?.path || '') as TFile | null;
			if (!file) {
				const direct = this.app.vault.getAbstractFileByPath(fileName) as TFile | null;
				const withMd = this.app.vault.getAbstractFileByPath(`${fileName}.md`) as TFile | null;
				file = direct || withMd;
			}
			
			if (file) {
				if (this.settings.jumpInNewTab) {
					// 在新标签页中打开文件
					const leaf = this.app.workspace.getLeaf('tab');
					leaf.openFile(file);
					this.log(`Jumped to file in new tab: ${file.path}`);
				} else {
					// 在当前视图中打开文件
					const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
					if (activeLeaf) {
						activeLeaf.openFile(file);
						this.log(`Jumped to file in current view: ${file.path}`);
					} else {
						// 如果没有活动的Markdown视图，则在新标签页中打开
						const leaf = this.app.workspace.getLeaf('tab');
						leaf.openFile(file);
						this.log(`No active Markdown view, opened in new tab: ${file.path}`);
					}
				}
			} else {
				this.warn(`File not found: ${fileName}`);
			}
		} catch (error) {
			this.error(`Error jumping to file ${fileName}:`, error);
		}
	}

	/**
	 * 切换块的折叠状态
	 */
	private toggleBlockCollapse(blockId: string) {
		// 不依赖于 embeddedBlocks 映射，直接从DOM中查找
		const block = document.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
		if (!block) {
			this.log(`Block not found for blockId: ${blockId}`);
			return;
		}
		
		// 调试信息：显示找到的块的信息
		const fileName = block.getAttribute('data-file-link') || 'unknown';
		const nestLevel = block.getAttribute('data-nest-level') || 'unknown';
		this.log(`Toggling collapse for blockId: ${blockId}, fileName: ${fileName}, nestLevel: ${nestLevel}`);

		const isCurrentlyCollapsed = this.collapseStates.get(blockId) || false;
		const newState = !isCurrentlyCollapsed;
		
		this.collapseStates.set(blockId, newState);
		// 同时保存到设置中
		this.settings.collapseStates[blockId] = newState;
		this.saveSettings();
		
		this.setBlockCollapsed(block, newState);
	}

	/**
	 * 设置块的折叠状态
	 */
	private setBlockCollapsed(block: HTMLElement, collapsed: boolean) {
		const blockId = block.getAttribute('data-block-id');
		if (!blockId) return;

		// 移除未使用的变量
		// 移除未使用的变量
		const embedContent = this.getEmbedContent(block) as HTMLElement;

		if (collapsed) {
			// Mark container as collapsed so CSS can hide everything except the title bar
			block.classList.add('embedded-note-collapsed');
			if (embedContent) {
				// 禁用编辑模式
				this.disableInlineEditing(embedContent);
			}
		} else {
			block.classList.remove('embedded-note-collapsed');
			if (embedContent) {
                // 仅当该块处于编辑状态时才启用编辑模式
                if (block.getAttribute('data-editing') === 'true') {
                    this.enableInlineEditing(block);
                }
			}
		}

		// 展开/收起后立即刷新该块及子级的嵌套层级
		block.setAttribute('data-nest-level', String(this.calculateNestLevel(block)));
		this.refreshAllNestLevels();
	}

	/**
	 * 禁用原地编辑功能
	 */
    public async disableInlineEditing(embedContent: HTMLElement) {
		// 移除编辑状态标记
		const block = embedContent.closest('.markdown-embed, .internal-embed') as HTMLElement | null;
		if (block) {
			const file = this.resolveLinkedFile(block);
			if (file) {
				this.editingFiles.delete(file.path);
				this.log(`Removed file from editing set: ${file.path}`);
				this.log(`Current editing files: ${Array.from(this.editingFiles)}`);
			}
		}

		// 兼容 contentEditable 与 textarea 两种模式
		embedContent.contentEditable = 'false';
		embedContent.removeAttribute('data-editable');
		
		const editor = embedContent.querySelector('textarea.embedded-note-editor') as HTMLTextAreaElement | null;
        const originalContainer = embedContent.querySelector('.embedded-note-original') as HTMLElement | null;
		const preview = embedContent.querySelector('.embedded-note-preview') as HTMLElement | null;
        if (editor) editor.remove();
		if (preview) preview.remove();
        if (originalContainer) {
            // 将 originalContainer 的内容移回到 embedContent，并移除 originalContainer
            originalContainer.style.display = '';
            const nodesToRestore = Array.from(originalContainer.childNodes);
            nodesToRestore.forEach((child) => {
                embedContent.insertBefore(child, originalContainer);
            });
            originalContainer.remove();
        } else if (editor) {
			// 兜底：若无原始容器，则将编辑器置为只读
			editor.readOnly = true;
			editor.disabled = true;
			editor.style.pointerEvents = 'none';
			editor.oninput = null;
		}

		// 移除直接样式设置
		
		// 移除编辑指示器
		const indicator = embedContent.querySelector('.embedded-note-edit-indicator');
		if (indicator) {
			indicator.remove();
		}

        // 移除直接样式设置
        const blockEl = embedContent.closest('.markdown-embed, .internal-embed') as HTMLElement | null;
        if (blockEl) {
            blockEl.removeAttribute('data-freeze');
		if (this.debugVerbose) console.debug('[EmbeddedNoteEnhancer] unfreeze on', blockEl.getAttribute('data-block-id'));
        }
        // 不再主动渲染；交给 Obsidian 的内置机制在保存后刷新内容
	}

	/**
	 * 处理文件修改事件
	 */
	private handleFileModify(file: TFile) {
		// 清除文件缓存，因为文件已被修改
		this.clearFileCache(file.path);
		
		// 如果文件正在编辑中，跳过处理以避免重新渲染导致新窗口打开
		if (this.editingFiles.has(file.path)) {
			this.log(`Skipping file modify for editing file: ${file.basename}`);
			return;
		}
		// 若任意嵌入编辑器存在，跳过
		if (document.querySelector('textarea.embedded-note-editor')) {
			this.logOnce('skip-modify-during-edit', 'Skip file modify: editor active');
			return;
		}
		
		// 检查是否在我们的编辑器中编辑，如果是则延迟处理
		const activeElement = document.activeElement as HTMLElement;
		const isInOurEditor = activeElement && activeElement.closest('.embedded-note-editor');
		
		// 如果在我们的编辑器中编辑，延迟处理
		const delay = isInOurEditor ? 500 : 200;
		
		setTimeout(() => {
			this.handleFileModifyDelayed(file);
		}, delay);
	}

	/**
	 * 处理文件保存事件
	 */
	private handleFileSave(file: TFile) {
		// 清除文件缓存，因为文件已被保存（可能内容有变化）
		this.clearFileCache(file.path);
		
		// 如果文件正在编辑中，跳过处理以避免重新渲染导致新窗口打开
		if (this.editingFiles.has(file.path)) {
			this.log(`Skipping file save for editing file: ${file.basename}`);
			return;
		}
		// 若任意嵌入编辑器存在，跳过
		if (document.querySelector('textarea.embedded-note-editor')) {
			this.logOnce('skip-save-during-edit', 'Skip file save: editor active');
			return;
		}

		// const fileName = file.basename;
		// console.log(`[EmbeddedNoteEnhancer] File saved: ${fileName}`);
		
		// 文件保存后，延迟处理以确保DOM完全更新
		setTimeout(() => {
			this.handleFileModifyDelayed(file);
		}, 300);
		
		// 再次延迟处理，确保嵌套嵌入被正确处理
		setTimeout(() => {
			this.reprocessAllNestedEmbeds();
		}, 600);
	}

	/**
	 * 延迟的文件修改处理
	 */
	private handleFileModifyDelayed(file: TFile) {
		// 如果文件正在编辑中，跳过处理以避免重新渲染导致新窗口打开
		if (this.editingFiles.has(file.path)) {
			this.log(`Skipping delayed file modify for editing file: ${file.basename}`);
			return;
		}

		const fileName = file.basename;
		const filePath = file.path;
		// console.log(`[EmbeddedNoteEnhancer] Processing delayed file modification for: ${fileName} (${filePath})`);
		
		this.embeddedBlocks.forEach((block) => {
			// 获取嵌入块引用的文件路径
			const blockFileLink = block.getAttribute('data-file-link');
			if (!blockFileLink) return;
			
			// 精确匹配：检查嵌入块是否引用了被修改的文件
			const blockReferencedFile = this.resolveLinkedFile(block);
			if (!blockReferencedFile) {
				// 如果无法解析引用的文件，说明文件可能已被删除
				this.warn(`Cannot resolve file for block, removing enhancement: ${blockFileLink}`);
				this.removeEnhancement(block);
				return;
			}
			
			// 只有当前嵌入块引用的文件就是被修改的文件时，才重新处理
			if (blockReferencedFile.path === filePath) {
				this.log(`Found block referencing modified file ${fileName}`);
				// 重新评估：若文件已不存在，撤销增强；否则维持现状
				const exists = this.checkEmbedFileExists(block);
				if (!exists) {
					this.warn(`File no longer exists, removing enhancement: ${fileName}`);
					this.removeEnhancement(block);
				} else {
					this.log(`File still exists, maintaining current state: ${fileName}`);
					// 文件存在时不需要重新处理，保持当前状态即可
				}
			}
		});
		
		// 重新处理所有嵌套嵌入并刷新层级，确保编辑保存后嵌套感保持
		this.reprocessAllNestedEmbeds();
		this.refreshAllNestLevels();
	}

	/**
	 * 重新处理所有嵌套嵌入
	 */
	private reprocessAllNestedEmbeds() {
		// 检查是否有文件正在编辑中，如果有则跳过重新处理
		if (this.editingFiles.size > 0 || document.querySelector('[data-freeze="true"]') || document.querySelector('textarea.embedded-note-editor')) {
		this.log(`Skipping reprocessAllNestedEmbeds due to editing files: ${Array.from(this.editingFiles)}`);
			return;
		}
		
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return;
		
		const file = activeView.file;
		if (!file) return;
		
		// 检查是否需要重新处理（基于缓存）
		if (!this.shouldReprocessNestedEmbeds(file.path)) {
			return;
		}

		this.logOnce('reprocess-nested', 'Reprocessing all nested embeds after file modification');
		
		const container = activeView.contentEl;
		if (!container) return;
		
		// 查找所有可能的嵌入块
		const allEmbeds = container.querySelectorAll('.markdown-embed, .internal-embed, [data-type="markdown-embed"]');
		
		let reprocessedCount = 0;
		let imageEmbedCount = 0;
		
		allEmbeds.forEach((embedBlock) => {
			// 检查是否为图片嵌入，如果是则跳过处理
			if (this.isImageEmbed(embedBlock as HTMLElement)) {
				imageEmbedCount++;
				this.log(`Skipping reprocess of image embed`);
				return;
			}
			
			// 检查是否为PDF嵌入，如果是则跳过处理
			if (this.isPdfEmbed(embedBlock as HTMLElement)) {
				this.log(`Skipping reprocess of PDF embed`);
				return;
			}
			
			// 检查是否已经处理过
			if (!embedBlock.hasAttribute('data-title-bar-added')) {
				this.log(`Reprocessing unprocessed embed`);
				this.processEmbeddedBlock(embedBlock as HTMLElement);
				reprocessedCount++;
			} else {
				this.log(`Embed already processed, skipping`);
			}
		});
		
		// 缓存文件的嵌入结构信息
		this.cacheFileEmbedStructure(file.path, allEmbeds.length, imageEmbedCount > 0);
		
		this.log(`Reprocessed ${reprocessedCount} nested embeds, found ${imageEmbedCount} image embeds`);
		
		// 如果发现了新的嵌入块，再次递归处理
		if (reprocessedCount > 0) {
			setTimeout(() => {
				this.processNestedEmbeds(container, 0);
			}, 100);
			
			// 再次延迟处理，确保所有嵌套嵌入都被正确处理
			setTimeout(() => {
				this.processAllNestedEmbeds(container);
			}, 300);
		}
	}

	/**
	 * 刷新嵌入内容
	 */
// 刷新逻辑已移除，依赖 Obsidian 自动更新嵌入内容

	/**
	 * 启用原地编辑功能
	 */
    public async enableInlineEditing(block: HTMLElement) {
		const embedContent = this.getEmbedContent(block) as HTMLElement;
		if (!embedContent) return;

		// 标记文件为编辑状态
		const file = this.resolveLinkedFile(block);
		if (file) {
			this.editingFiles.add(file.path);
			this.log(`Added file to editing set: ${file.path}`);
			this.log(`Current editing files: ${Array.from(this.editingFiles)}`);
		}

		// 使用 textarea 进行编辑，避免把提示或其他 DOM 写入文件
        // 防御性校验：若出现多个 textarea，仅保留一个
        const editors = Array.from(embedContent.querySelectorAll('textarea.embedded-note-editor')) as HTMLTextAreaElement[];
        if (editors.length > 1) {
            editors.slice(1).forEach(e => e.remove());
        }
        let editor = editors[0] || (embedContent.querySelector('textarea.embedded-note-editor') as HTMLTextAreaElement | null);
		if (!editor) {
			// 将现有内容移入隐藏容器，供关闭时还原
			let originalContainer = embedContent.querySelector('.embedded-note-original') as HTMLElement | null;
			if (!originalContainer) {
				originalContainer = document.createElement('div');
				originalContainer.className = 'embedded-note-original';
				while (embedContent.firstChild) {
					originalContainer.appendChild(embedContent.firstChild);
				}
				embedContent.appendChild(originalContainer);
			}
			(originalContainer as HTMLElement).style.display = 'none';

			editor = document.createElement('textarea');
			editor.className = 'embedded-note-editor';
			// 初始值使用源文件内容，而不是渲染后的文本
			if (file) {
				try {
					editor.value = await this.app.vault.read(file);
				} catch {
					editor.value = embedContent.textContent || '';
				}
			} else {
				editor.value = embedContent.textContent || '';
			}
			// 插入编辑器（保留 originalContainer）
			embedContent.appendChild(editor);

            // 不再创建额外预览容器，沿用 Obsidian 渲染（保持单窗口）
		}

        // 冻结该块，避免在编辑期间被任何流程重新处理
        block.setAttribute('data-freeze', 'true');
		if (this.debugVerbose) console.debug('[EmbeddedNoteEnhancer] freeze on', block.getAttribute('data-block-id'));

		// 冻结该块，避免在编辑期间被任何流程重新处理
		block.setAttribute('data-freeze', 'true');

		this.isolateEditorEvents(editor);
		this.setupTextareaListeners(editor, block);
        // 不做额外渲染，维持单窗口体验
	}

	/** 解析嵌入块所对应的文件 */
	private resolveLinkedFile(block: HTMLElement): TFile | null {
		const titleBar = block.querySelector('.embedded-note-title-bar');
		const fileLink = block.getAttribute('data-file-link') || titleBar?.textContent?.trim() || '';
		if (!fileLink) return null;
		const activeFile = this.app.workspace.getActiveFile();
		let file = this.app.metadataCache.getFirstLinkpathDest(fileLink, activeFile?.path || '') as TFile | null;
		if (!file) {
			const direct = this.app.vault.getAbstractFileByPath(fileLink) as TFile | null;
			const withMd = this.app.vault.getAbstractFileByPath(`${fileLink}.md`) as TFile | null;
			file = direct || withMd;
		}
		return file;
	}

	/** 检查嵌入引用的文件是否存在 */
	private checkEmbedFileExists(block: HTMLElement): boolean {
		const file = this.resolveLinkedFile(block);
		return !!file;
	}

	/**
	 * 检查文件是否为图片类型
	 */
	private isImageFile(file: TFile): boolean {
		// 检查文件类型缓存
		if (this.fileTypeCache.has(file.path)) {
			return this.fileTypeCache.get(file.path)!;
		}

		const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.tiff', '.ico'];
		const extension = file.extension.toLowerCase();
		const isImage = imageExtensions.includes(`.${extension}`);

		// 缓存结果
		this.fileTypeCache.set(file.path, isImage);
		return isImage;
	}

	/**
	 * 检查文件是否为PDF类型
	 */
	private isPdfFile(file: TFile): boolean {
		const extension = file.extension.toLowerCase();
		return extension === 'pdf';
	}

	/**
	 * 检查嵌入块是否为图片嵌入
	 */
	private isImageEmbed(block: HTMLElement): boolean {
		// 检查缓存
		if (this.imageEmbedCache.has(block)) {
			return this.imageEmbedCache.get(block)!;
		}

		let isImage = false;

		// 快速检查：优先检查DOM结构中的图片元素
		if (block.querySelector('img') ||
			block.querySelector('.image-embed') ||
			block.querySelector('.media-embed')) {
			isImage = true;
		} else if (block.classList.contains('image-embed') || 
				   block.classList.contains('media-embed')) {
			isImage = true;
		} else {
			// 快速文件扩展名检查，避免昂贵的文件解析
			const internalLink = block.querySelector('a.internal-link');
			if (internalLink) {
				const href = internalLink.getAttribute('href');
				if (href && this.isImageExtension(href)) {
					isImage = true;
				}
			}

			// 检查文件链接是否为图片（快速检查）
			if (!isImage) {
				const fileLink = block.getAttribute('data-file-link');
				if (fileLink && this.isImageExtension(fileLink)) {
					isImage = true;
				}
			}

			// 只有在快速检查无法确定时才进行昂贵的文件解析
			if (!isImage) {
				const internalLink = block.querySelector('a.internal-link');
				if (internalLink) {
					const href = internalLink.getAttribute('href');
					if (href && !this.isImageExtension(href)) {
						const activeFile = this.app.workspace.getActiveFile();
						const file = this.app.metadataCache.getFirstLinkpathDest(href, activeFile?.path || '');
						if (file && this.isImageFile(file)) {
							isImage = true;
						}
					}
				}

				// 检查文件链接是否为图片（慢速检查）
				if (!isImage) {
					const fileLink = block.getAttribute('data-file-link');
					if (fileLink && !this.isImageExtension(fileLink)) {
						const activeFile = this.app.workspace.getActiveFile();
						const file = this.app.metadataCache.getFirstLinkpathDest(fileLink, activeFile?.path || '');
						if (file && this.isImageFile(file)) {
							isImage = true;
						}
					}
				}
			}
		}

		// 额外检查：如果是文本嵌入块但包含图片，不应该被排除
		if (isImage) {
			// 检查是否有markdown-embed-content，如果有说明是文本嵌入
			const embedContent = block.querySelector('.markdown-embed-content');
			if (embedContent) {
				// 检查内容中是否只有图片，还是有其他文本内容
				const textContent = embedContent.textContent?.trim() || '';
				const hasOnlyImage = embedContent.children.length === 1 && 
									embedContent.querySelector('img') && 
									textContent.length < 10; // 如果文本内容很少，可能是纯图片
				
				if (!hasOnlyImage) {
					// 如果文本内容较多，说明是包含图片的文本嵌入，不应该被排除
					isImage = false;
					this.log(`Text embed with image detected, not excluding`);
				}
			}
		}

		// 缓存结果
		this.imageEmbedCache.set(block, isImage);
		return isImage;
	}

	/**
	 * 快速检查文件扩展名是否为图片格式（避免昂贵的文件解析）
	 */
	private isImageExtension(filePath: string): boolean {
		const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.tiff', '.ico'];
		const lowerPath = filePath.toLowerCase();
		return imageExtensions.some(ext => lowerPath.endsWith(ext));
	}

	/**
	 * 检查嵌入块是否为PDF嵌入
	 */
	private isPdfEmbed(block: HTMLElement): boolean {
		// 快速检查：查看DOM结构中是否有PDF相关元素
		if (block.querySelector('.pdf-embed') || 
			block.classList.contains('pdf-embed')) {
			return true;
		}

		// 检查文件链接是否为PDF
		const fileLink = block.getAttribute('data-file-link');
		if (fileLink && fileLink.toLowerCase().endsWith('.pdf')) {
			return true;
		}

		// 检查内部链接
		const internalLink = block.querySelector('a.internal-link');
		if (internalLink) {
			const href = internalLink.getAttribute('href');
			if (href && href.toLowerCase().endsWith('.pdf')) {
				return true;
			}
		}

		// 检查嵌入链接
		const embedLink = block.querySelector('.markdown-embed-link');
		if (embedLink) {
			const href = embedLink.getAttribute('href');
			if (href && href.toLowerCase().endsWith('.pdf')) {
				return true;
			}
		}

		// 通过文件解析检查
		const activeFile = this.app.workspace.getActiveFile();
		if (fileLink) {
			const file = this.app.metadataCache.getFirstLinkpathDest(fileLink, activeFile?.path || '');
			if (file && this.isPdfFile(file)) {
				return true;
			}
		}

		if (internalLink) {
			const href = internalLink.getAttribute('href');
			if (href) {
				const file = this.app.metadataCache.getFirstLinkpathDest(href, activeFile?.path || '');
				if (file && this.isPdfFile(file)) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * 节流处理，防止短时间内重复处理
	 */
	private throttledProcess(key: string, callback: () => void, delay: number = 100) {
		const now = Date.now();
		const lastTime = this.processingThrottle.get(key) || 0;
		
		if (now - lastTime < delay) {
			this.log(`Throttling ${key}, last processed ${now - lastTime}ms ago`);
			return;
		}
		
		this.processingThrottle.set(key, now);
		callback();
	}

	/**
	 * 检查文件是否需要重新处理嵌套嵌入
	 */
	private shouldReprocessNestedEmbeds(filePath: string): boolean {
		const now = Date.now();
		const cached = this.fileEmbedStructure.get(filePath);
		
		// 如果没有缓存，需要处理
		if (!cached) {
			return true;
		}
		
		// 如果缓存时间超过5分钟，需要重新处理
		if (now - cached.timestamp > 5 * 60 * 1000) {
			this.fileEmbedStructure.delete(filePath);
			return true;
		}
		
		// 如果有缓存且时间未过期，不需要重新处理
			this.log(`Skipping nested processing for ${filePath} (cached ${Math.round((now - cached.timestamp) / 1000)}s ago)`);
		return false;
	}

	/**
	 * 缓存文件的嵌入结构信息
	 */
	private cacheFileEmbedStructure(filePath: string, embedCount: number, hasImages: boolean) {
		this.fileEmbedStructure.set(filePath, {
			timestamp: Date.now(),
			embedCount,
			hasImages
		});
	}

	/**
	 * 清除文件的缓存，当文件被修改时调用
	 */
	private clearFileCache(filePath: string) {
		this.fileEmbedStructure.delete(filePath);
		this.processedFiles.delete(filePath);
			this.log(`Cleared cache for file: ${filePath}`);
	}

	/**
	 * 预加载文件类型缓存，提升性能
	 */
	private preloadFileTypeCache() {
		try {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView) return;

			const container = activeView.contentEl;
			if (!container) return;

			// 收集所有可能的文件链接
			const fileLinks = new Set<string>();
			
			// 从嵌入块中收集文件链接
			const embeds = container.querySelectorAll('.markdown-embed, .internal-embed');
			embeds.forEach((embed) => {
				const fileLink = embed.getAttribute('data-file-link');
				if (fileLink) fileLinks.add(fileLink);

				const internalLink = embed.querySelector('a.internal-link');
				if (internalLink) {
					const href = internalLink.getAttribute('href');
					if (href) fileLinks.add(href);
				}
			});

			// 预加载文件类型缓存
			fileLinks.forEach((fileLink) => {
				if (!this.fileTypeCache.has(fileLink)) {
					const activeFile = this.app.workspace.getActiveFile();
					const file = this.app.metadataCache.getFirstLinkpathDest(fileLink, activeFile?.path || '');
					if (file) {
						this.isImageFile(file); // 这会缓存结果
					}
				}
			});

			this.log(`Preloaded ${fileLinks.size} file types`);
		} catch (error) {
			if (this.debugVerbose) console.warn('[EmbeddedNoteEnhancer] Error preloading file type cache:', error);
		}
	}

	/** 撤销对嵌入块的增强，恢复为 Obsidian 默认显示 */
	private removeEnhancement(block: HTMLElement) {
		// 先移除该块及其子节点上由插件添加的事件监听器
		this.removeTrackedEventListenersForRoot(block);
		// 清除我们加的标记和 UI
		const titleBar = block.querySelector('.embedded-note-title-bar');
		if (titleBar) titleBar.remove();
		const embedContent = block.querySelector('.markdown-embed-content') as HTMLElement | null;
		if (embedContent) {
			const editor = embedContent.querySelector('textarea.embedded-note-editor') as HTMLTextAreaElement | null;
			if (editor) editor.remove();
			const original = embedContent.querySelector('.embedded-note-original') as HTMLElement | null;
			if (original) original.remove();
		}
		block.removeAttribute('data-title-bar-added');
		block.removeAttribute('data-block-id');
		block.removeAttribute('data-file-link');
		block.removeAttribute('data-editing');
		block.removeAttribute('tabindex');
		block.removeAttribute('data-original-html');
		block.removeAttribute('data-nest-level');
		block.classList.remove('embedded-note-collapsed');
		block.removeAttribute('data-embedded-note-enhanced');
	}

	/** 阻断 textarea 事件向上冒泡，避免触发工作区热键/跳转 */
	private isolateEditorEvents(editor: HTMLTextAreaElement) {
		const stop = (e: Event) => {
			e.stopPropagation();
			(e as Event).stopImmediatePropagation?.();
			// @ts-ignore
			e.cancelBubble = true;
		};
		['keydown','keypress','keyup','mousedown','click','dblclick','wheel','focus','focusin'].forEach((type) => {
			editor.addEventListener(type, stop, true);
			editor.addEventListener(type, stop, false);
		});

		// 特殊处理：在少数主题/插件下，数字键可能仍被全局处理
		editor.addEventListener('keydown', (e: KeyboardEvent) => {
			// 仅当是可打印字符且未按下修饰键时，确保不被外部拦截
			if (!e.ctrlKey && !e.metaKey && !e.altKey) {
				// 阻断传播，保留默认，从而让 textarea 正常输入
				e.stopPropagation();
				(e as Event).stopImmediatePropagation?.();
			}
		}, true);
	}

	/**
	 * 添加编辑指示器
	 */
// 删除常驻编辑提示逻辑

	/**
	 * 设置编辑监听器
	 */
    private setupTextareaListeners(editor: HTMLTextAreaElement, block: HTMLElement) {
		let saveTimeout: NodeJS.Timeout;

		const triggerSave = () => {
            if (this.settings.manualSaveOnly) return;
			if (saveTimeout) clearTimeout(saveTimeout);
            const delay = Math.max(0, this.settings.autoSaveDelay || 1000);
			saveTimeout = setTimeout(() => {
				this.saveEditorContent(editor, block);
            }, delay);
		};

        editor.addEventListener('input', async () => {
            triggerSave();
        });
		editor.addEventListener('blur', () => {
            if (this.settings.manualSaveOnly) return;
			if (saveTimeout) clearTimeout(saveTimeout);
			this.saveEditorContent(editor, block);
		});
		editor.addEventListener('keydown', (e) => {
			if (e.ctrlKey && e.key === 's') {
				e.preventDefault();
				if (saveTimeout) clearTimeout(saveTimeout);
				this.saveEditorContent(editor, block);
			}
		});
	}

    // 移除自定义预览渲染，回退到 Obsidian 的原生渲染

	/**
	 * 保存嵌入内容
	 */
	private async saveEditorContent(editor: HTMLTextAreaElement, block: HTMLElement) {
		try {
			const file = this.resolveLinkedFile(block);
			if (!file) {
				this.warn('Cannot resolve file for block');
				return;
			}

			// 标记文件为编辑状态，防止文件修改事件触发重新渲染
			this.editingFiles.add(file.path);

			// 获取编辑后的内容（textarea 的值）
			const newContent = editor.value;

			// 保存到文件
			await this.app.vault.modify(file, newContent);

			// 显示保存成功提示
			this.showSaveIndicator(editor, true);

			// 延迟移除编辑状态标记，确保文件修改事件处理完成
			setTimeout(() => {
				this.editingFiles.delete(file.path);
			}, 1000);

		} catch (error) {
			this.error('保存嵌入内容失败:', error);
			this.showSaveIndicator(editor, false);
			// 出错时也要移除编辑状态标记
			const file = this.resolveLinkedFile(block);
			if (file) {
				this.editingFiles.delete(file.path);
			}
		}
	}

	/**
	 * 显示保存指示器
	 */
	private showSaveIndicator(targetEl: HTMLElement, success: boolean) {
		// 临时浮层提示，不向 DOM 写入持久元素
		const toast = document.createElement('div');
		toast.textContent = success ? '✅ 已保存' : '❌ 保存失败';
		toast.className = success ? 'embedded-note-toast' : 'embedded-note-toast error';
		const host = targetEl.parentElement || targetEl;
		host.style.position = host.style.position || 'relative';
		host.appendChild(toast);
		setTimeout(() => toast.remove(), 1400);
	}




	/**
	 * 提取文件名
	 */
	private extractFileName(href: string): string | null {
		// [[Note Name]]
		const wikiMatch = href.match(/\[\[([^\]]+)\]\]/);
		if (wikiMatch) return wikiMatch[1];

		try {
			// obsidian://open?file=Path%2FNote.md or app://local/.../Path/Note.md
			// Also handle relative paths like Path/Note.md#heading
			let raw = href;
			// If it's a full URL, parse and try to get the file param or pathname
			if (/^[a-zA-Z]+:\/\//.test(href)) {
				const url = new URL(href);
				const fileParam = url.searchParams.get('file');
				if (fileParam) raw = decodeURIComponent(fileParam);
				else raw = decodeURIComponent(url.pathname);
			}
			// Strip query and hash
			raw = raw.split('#')[0].split('?')[0];
			// Remove leading slashes
			raw = raw.replace(/^\/+/, '');
			// Get basename
			const parts = raw.split('/');
			let base = parts[parts.length - 1];
			// Remove .md extension
			base = base.replace(/\.md$/i, '');
			return base || null;
		} catch (e) {
			return null;
		}
	}

	/**
	 * 生成块ID
	 */
	private generateBlockId(block: HTMLElement, fileName: string): string {
		// 获取当前活动文件的路径，用于区分不同文件中的同名嵌入
		const activeFile = this.app.workspace.getActiveFile();
		const activeFilePath = activeFile?.path || 'unknown';
		
		// 计算嵌套层级
		const nestLevel = this.calculateNestLevel(block);
		
		// 获取父级嵌入的ID（如果存在）
		let parentContext = '';
		let parent = block.parentElement;
		while (parent) {
			const parentBlockId = parent.getAttribute('data-block-id');
			if (parentBlockId) {
				parentContext = `-parent-${parentBlockId}`;
				break;
			}
			parent = parent.parentElement;
		}
		
		// 使用更安全的方法生成唯一ID
		// 1. 使用文件路径的哈希值
		const pathHash = this.simpleHash(activeFilePath);
		// 2. 使用文件名的哈希值
		const nameHash = this.simpleHash(fileName);
		// 3. 使用嵌套层级
		// 4. 使用父级上下文
		// 5. 使用块在DOM中的位置（作为最后的保险）
		const blockIndex = Array.from(block.parentElement?.children || []).indexOf(block);
		
		const baseId = `embedded-${pathHash}-${nameHash}-level${nestLevel}${parentContext}-pos${blockIndex}`;
		
		return baseId;
	}
	
	/**
	 * 简单哈希函数，用于生成短ID
	 */
	private simpleHash(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // 转换为32位整数
		}
		return Math.abs(hash).toString(36);
	}

	/**
	 * 手动触发处理（调试用）
	 */
	public manualTrigger() {
		this.log('Manual trigger called');
		this.processEmbeddedBlocks();
		setTimeout(() => {
			this.reprocessAllNestedEmbeds();
		}, 500);
	}

	/**
	 * 移除样式
	 */
	public removeStyles() {
							const styleEl = document.getElementById('embedded-note-enhancer-styles');
		if (styleEl) {
			styleEl.remove();
		}
	}
	
	


	/**
	 * 还原 Obsidian 原版样式
	 */
	private restoreOriginalObsidianStyles(block: HTMLElement) {
		// 移除直接样式设置
		
		// 移除所有我们添加的类名
		block.classList.remove('embedded-note-collapsed');
		
		// 还原内容区域的样式
		const content = this.getEmbedContent(block) as HTMLElement | null;
		if (content) {
			// 移除直接样式设置
		}

		// 移除标题栏（如果还存在）
		const titleBar = block.querySelector('.embedded-note-title-bar') as HTMLElement | null;
		if (titleBar) {
			titleBar.remove();
		}

		// 移除所有我们添加的编辑器元素
		const editor = block.querySelector('textarea.embedded-note-editor') as HTMLTextAreaElement | null;
		if (editor) {
			editor.remove();
		}

		// 关键：处理原始容器，将内容移回主容器而不是删除
		const original = block.querySelector('.embedded-note-original') as HTMLElement | null;
		if (original) {
			// 将原始容器的内容移回主容器
			const children = Array.from(original.children);
			children.forEach((child) => {
				if (content) {
					content.appendChild(child);
				}
			});
			// 然后删除空的原始容器
			original.remove();
		}

		// 移除直接样式设置

		// 移除所有我们添加的属性
		block.removeAttribute('data-embedded-note-enhanced');
		block.removeAttribute('data-title-bar-added');
		block.removeAttribute('data-block-id');
		block.removeAttribute('data-nest-level');
		block.removeAttribute('data-editing');
		block.removeAttribute('data-file-link');
		block.removeAttribute('tabindex');
		block.removeAttribute('data-original-html');
		
	}
	

	/**
	 * 移除所有标题栏
	 */
	public removeAllTitleBars() {
		this.log('removeAllTitleBars called');
		
		// 处理所有带有增强标记的块
		const enhancedBlocks = document.querySelectorAll('.markdown-embed[data-embedded-note-enhanced], .internal-embed[data-embedded-note-enhanced]');
		enhancedBlocks.forEach((el) => {
			// 逐块清理事件监听器
			this.removeTrackedEventListenersForRoot(el as HTMLElement);
			this.removeTitleBarFromBlock(el as HTMLElement);
		});

		// 处理所有可能存在的标题栏（兜底处理）
		const allTitleBars = document.querySelectorAll('.embedded-note-title-bar');
		allTitleBars.forEach((titleBar) => {
			titleBar.remove();
		});

		// 处理所有可能存在的编辑器元素
		const allEditors = document.querySelectorAll('textarea.embedded-note-editor');
		allEditors.forEach((editor) => {
			editor.remove();
		});

		// 处理所有可能存在的原始容器
		const allOriginals = document.querySelectorAll('.embedded-note-original');
		allOriginals.forEach((original) => {
			original.remove();
		});

		// 处理所有可能存在的预览容器
		const allPreviews = document.querySelectorAll('.embedded-note-preview');
		allPreviews.forEach((preview) => {
			preview.remove();
		});

		// 清理所有嵌入块上的插件相关属性
		const allEmbeds = document.querySelectorAll('.markdown-embed, .internal-embed');
		allEmbeds.forEach((embed) => {
			const block = embed as HTMLElement;
			// 移除所有插件添加的属性
			block.removeAttribute('data-embedded-note-enhanced');
			block.removeAttribute('data-title-bar-added');
			block.removeAttribute('data-block-id');
			block.removeAttribute('data-nest-level');
			block.removeAttribute('data-editing');
			block.removeAttribute('data-file-link');
			block.removeAttribute('tabindex');
			block.removeAttribute('data-original-html');
			
			// 移除插件添加的类名
			block.classList.remove('embedded-note-collapsed');
			
			// 移除直接样式设置
		});

		// 清理内存引用
		this.embeddedBlocks.clear();
		this.collapseStates.clear();


		// 触发布局变更，促使 Obsidian 自身刷新默认嵌入头部与内容
		try { 
			(this.app.workspace as any).trigger?.('layout-change'); 
		} catch {}
		
		// 刷新当前视图，尽量恢复到 Obsidian 原生状态
		void this.refreshActiveMarkdownView();
	}


	/**
	 * 从指定块中移除标题栏并还原样式
	 */
	private removeTitleBarFromBlock(block: HTMLElement) {
		// 先移除事件监听器
		this.removeTrackedEventListenersForRoot(block);
		// 移除标题栏
			const titleBar = block.querySelector('.embedded-note-title-bar');
			if (titleBar) {
				titleBar.remove();
		}

		// 移除编辑器元素
		const editor = block.querySelector('textarea.embedded-note-editor') as HTMLTextAreaElement | null;
		if (editor) {
			editor.remove();
		}

		// 处理原始容器，将内容移回主容器
		const original = block.querySelector('.embedded-note-original') as HTMLElement | null;
		if (original) {
		const embedContent = this.getEmbedContent(block) as HTMLElement | null;
		if (embedContent) {
				// 将原始容器的内容移回主容器
				const children = Array.from(original.children);
				children.forEach((child) => {
					embedContent.appendChild(child);
				});
			}
			// 然后删除空的原始容器
			original.remove();
		}

		// 移除预览容器
		const preview = block.querySelector('.embedded-note-preview') as HTMLElement | null;
		if (preview) {
			preview.remove();
		}

		// 还原原版样式
		this.restoreOriginalObsidianStyles(block);
	}
	
}

/**
 * 设置标签页
 */
class EmbeddedNoteEnhancerSettingTab extends PluginSettingTab {
	plugin: EmbeddedNoteEnhancerPlugin;

	constructor(app: App, plugin: EmbeddedNoteEnhancerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h1', { text: 'Embedded Note Enhancer 设置' });



		// 字体大小
		new Setting(containerEl)
			.setName('字体大小')
			.setDesc('设置标题栏字体大小')
			.addDropdown(dropdown => dropdown
				.addOption('12px', '12px')
				.addOption('14px', '14px')
				.addOption('16px', '16px')
				.addOption('18px', '18px')
				.addOption('20px', '20px')
				.addOption('22px', '22px')
				.addOption('24px', '24px')
				.addOption('26px', '26px')
				.addOption('28px', '28px')
				.addOption('30px', '30px')
				.addOption('32px', '32px')
				.addOption('34px', '34px')
				.addOption('36px', '36px')
				.addOption('38px', '38px')
				.addOption('40px', '40px')
				.addOption('42px', '42px')
				.addOption('44px', '44px')
				.addOption('46px', '46px')
				.addOption('48px', '48px')
				.setValue(this.plugin.settings.fontSize)
				.onChange(async (value) => {
					this.plugin.settings.fontSize = value;
					await this.plugin.saveSettings();
					this.updateTitleBarStyles();
				}));

		// 显示折叠图标
		new Setting(containerEl)
			.setName('显示折叠图标')
			.setDesc('在标题栏右侧显示折叠/展开图标')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showCollapseIcon)
				.onChange(async (value) => {
					this.plugin.settings.showCollapseIcon = value;
					await this.plugin.saveSettings();
					this.updateTitleBarStyles();
				}));

		// 显示编辑按钮
		new Setting(containerEl)
			.setName('显示编辑按钮')
			.setDesc('在标题栏右侧显示编辑按钮，点击可以原地编辑嵌入内容')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showEditButton)
				.onChange(async (value) => {
					this.plugin.settings.showEditButton = value;
					await this.plugin.saveSettings();
					this.updateTitleBarStyles();
				}));

		// 显示跳转按钮
		new Setting(containerEl)
			.setName('显示跳转按钮')
			.setDesc('在标题栏右侧显示跳转按钮，点击可以跳转到对应文件')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showJumpButton)
				.onChange(async (value) => {
					this.plugin.settings.showJumpButton = value;
					await this.plugin.saveSettings();
					this.updateTitleBarStyles();
				}));

		// 跳转方式
		new Setting(containerEl)
			.setName('跳转方式')
			.setDesc('选择跳转按钮的行为：在新标签页中打开文件，或在当前视图中打开文件')
			.addDropdown(dropdown => dropdown
				.addOption('newTab', '新标签页中打开')
				.addOption('currentView', '当前视图中打开')
				.setValue(this.plugin.settings.jumpInNewTab ? 'newTab' : 'currentView')
				.onChange(async (value) => {
					this.plugin.settings.jumpInNewTab = value === 'newTab';
					await this.plugin.saveSettings();
				}));

		// 仅手动保存
		new Setting(containerEl)
			.setName('仅手动保存')
			.setDesc('关闭自动保存，仅在 Ctrl+S 或点击完成时保存')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.manualSaveOnly)
				.onChange(async (value) => {
					this.plugin.settings.manualSaveOnly = value;
					await this.plugin.saveSettings();
				}));

        // 移除"编辑预览（数学等）"设置项，回退到单窗口体验

		// 调试模式
		new Setting(containerEl)
			.setName('调试模式')
			.setDesc('开启后会在控制台输出详细的调试信息，用于问题排查')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugMode)
				.onChange(async (value) => {
					this.plugin.settings.debugMode = value;
					await this.plugin.saveSettings();
				}));
	}

	/**
	 * 创建折叠图标
	 */
	private createCollapseIcon(): HTMLElement {
		const collapseIcon = document.createElement('span');
		collapseIcon.className = 'embedded-note-collapse-icon';
		collapseIcon.textContent = '▼';
		// 移除直接样式设置，使用CSS类
		return collapseIcon;
	}

	/**
	 * 创建编辑按钮
	 */
	private createEditButton(titleBar: HTMLElement): HTMLElement {
		const editBtn = document.createElement('button');
		editBtn.className = 'embedded-note-edit-btn';
		editBtn.textContent = '编辑';
		// 移除直接样式设置，使用CSS类

		// 添加编辑按钮事件处理 - 使用插件的方法
		const onEditClick = (e: MouseEvent) => {
			e.stopPropagation();
			const blockId = titleBar.getAttribute('data-block-id');
			if (!blockId) return;
			
			// 触发插件重新处理这个块，让插件来处理编辑逻辑
			this.plugin.processEmbeddedBlocks();
		};
		editBtn.addEventListener('click', onEditClick);

		return editBtn;
	}

	/**
	 * 创建跳转按钮
	 */
	private createJumpButton(titleBar: HTMLElement): HTMLElement {
		const jumpBtn = document.createElement('button');
		jumpBtn.className = 'embedded-note-jump-btn';
		jumpBtn.textContent = '跳转';
		// 移除直接样式设置，使用CSS类

		// 添加跳转按钮事件处理
		const onJumpClick = (e: MouseEvent) => {
			e.stopPropagation();
			const fileName = titleBar.textContent?.trim() || '';
			if (fileName) {
				// 使用插件的方法进行跳转
				(this.plugin as any).jumpToFile(fileName);
			}
		};
		jumpBtn.addEventListener('click', onJumpClick);

		return jumpBtn;
	}

	/**
	 * 更新标题栏样式
	 */
	private updateTitleBarStyles() {
		const titleBars = document.querySelectorAll('.embedded-note-title-bar');
		titleBars.forEach((titleBar) => {
			const titleBarElement = titleBar as HTMLElement;
			// 使用Obsidian主题变量，不设置颜色
			titleBarElement.style.fontSize = this.plugin.settings.fontSize;
			
			// 处理折叠图标
			let collapseIcon = titleBarElement.querySelector('.embedded-note-collapse-icon') as HTMLElement;
		// 若处于编辑状态，则隐藏折叠图标
		const hostBlock = titleBarElement.closest('.markdown-embed, .internal-embed') as HTMLElement | null;
		const isEditing = hostBlock?.getAttribute('data-editing') === 'true';
		if (this.plugin.settings.showCollapseIcon && !isEditing && !collapseIcon) {
				// 需要显示但不存在，创建它
				collapseIcon = this.createCollapseIcon();
				titleBarElement.appendChild(collapseIcon);
		} else if (collapseIcon) {
			collapseIcon.style.display = this.plugin.settings.showCollapseIcon && !isEditing ? 'block' : 'none';
			}

			// 处理编辑按钮
			let editBtn = titleBarElement.querySelector('.embedded-note-edit-btn') as HTMLElement;
			if (this.plugin.settings.showEditButton && !editBtn) {
				// 需要显示但不存在，创建它
				editBtn = this.createEditButton(titleBarElement);
				titleBarElement.appendChild(editBtn);
			} else if (editBtn) {
				editBtn.style.display = this.plugin.settings.showEditButton ? 'inline-block' : 'none';
			}

			// 处理跳转按钮
			let jumpBtn = titleBarElement.querySelector('.embedded-note-jump-btn') as HTMLElement;
			if (this.plugin.settings.showJumpButton && !jumpBtn) {
				// 需要显示但不存在，创建它
				jumpBtn = this.createJumpButton(titleBarElement);
				titleBarElement.appendChild(jumpBtn);
			} else if (jumpBtn) {
				jumpBtn.style.display = this.plugin.settings.showJumpButton ? 'inline-block' : 'none';
			}

			// 当用户关闭原地编辑时，立即将对应内容置为只读
			const block = titleBarElement.closest('.markdown-embed') as HTMLElement | null;
			if (block) {
				const embedContent = block.querySelector('.markdown-embed-content') as HTMLElement | null;
				if (embedContent) {
					if (block.getAttribute('data-editing') === 'true') {
						this.plugin.enableInlineEditing(block);
					} else {
						this.plugin.disableInlineEditing(embedContent);
					}
				}
			}
		});
	}
}
