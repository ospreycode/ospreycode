import {
	Container,
	isKeyRelease,
	matchesKey,
	type Terminal,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import {
	AgentStartError,
	ConfigError,
	CredentialError,
	type CredentialStatus,
	type Host,
	type HostEvent,
	type QueuedInput,
	SandboxUnavailableError,
	type Session,
	SessionCommandError,
	type SessionConfig,
	type SessionOptions,
	WorkspaceError,
} from "@ospreycode/agent-host";
import type { CliContext, CliSignal } from "../context.js";
import { openHost } from "../host.js";
import { describeApproval } from "./approval.js";
import { type Clipboard, imageBlock } from "./clipboard.js";
import {
	type CommandActions,
	CommandUsageError,
	parseCommand,
	runCommand,
} from "./commands.js";
import { PromptAutocomplete } from "./completion.js";
import { brief, toolSummary } from "./format.js";
import type { InteractiveOptions } from "./index.js";
import { Attachments, composeInput, editorText } from "./input.js";
import { cycle, effortLevels, usableModels } from "./models.js";
import { InteractiveState } from "./state.js";
import { ApprovalPanel } from "./view/approval-panel.js";
import { ConversationView } from "./view/conversation.js";
import { PromptEditor } from "./view/editor.js";
import { Picker } from "./view/picker.js";
import { QueueView } from "./view/queue.js";
import { QueuePanel } from "./view/queue-panel.js";
import { HintLine, StatusLine } from "./view/status.js";

/** 被信号结束时的退出码：128 加信号的编号。 */
const signalExitCode: Record<CliSignal, number> = {
	SIGINT: 130,
	SIGTERM: 143,
};

/** 命令没做成、session 照常继续的失败：把原因显示在对话区。其余的错误是缺陷，让交互模式退出。 */
function reportable(error: unknown): error is Error {
	return (
		error instanceof SessionCommandError ||
		error instanceof ConfigError ||
		error instanceof CredentialError ||
		error instanceof SandboxUnavailableError ||
		error instanceof WorkspaceError ||
		error instanceof AgentStartError ||
		error instanceof CommandUsageError
	);
}

/** 交互界面：把 Host 的事件显示出来，把按键变成对 session 的操作。 */
class Interactive {
	readonly #host: Host;
	readonly #session: Session;
	readonly #context: CliContext;
	readonly #clipboard: Clipboard;
	readonly #terminal: Terminal;
	readonly #state: InteractiveState;
	readonly #tui: TuiMainScreen;
	readonly #conversation: ConversationView;
	readonly #editor: PromptEditor;
	/** 输入框的位置：有询问时换成询问的面板，打开列表时换成列表。 */
	readonly #bottom = new Container();
	readonly #attachments = new Attachments();
	readonly #exit = Promise.withResolvers<number>();
	/** 启动参数：查各个服务有没有凭据时要用其中的凭据来源。 */
	readonly #options: SessionOptions;
	/** session 当前生效的配置，换过设置之后重新取。 */
	#config: SessionConfig;
	/** 各个服务有没有凭据，换模型的按键第一次用到时才查：查它要读系统凭据库。 */
	#credentials: CredentialStatus[] | undefined;
	/** 要等上一个做完才能做下一个的 session 操作排成一串。 */
	#pending: Promise<unknown> = Promise.resolve();
	#panel: { requestId: string; component: ApprovalPanel } | undefined;
	#overlay: Picker | QueuePanel | undefined;
	#cancelling = false;
	#exitArmed = false;
	#closing = false;
	#stopped = false;

	constructor(parts: {
		host: Host;
		session: Session;
		context: CliContext;
		clipboard: Clipboard;
		terminal: Terminal;
		state: InteractiveState;
		options: SessionOptions;
		config: SessionConfig;
	}) {
		this.#host = parts.host;
		this.#session = parts.session;
		this.#context = parts.context;
		this.#clipboard = parts.clipboard;
		this.#terminal = parts.terminal;
		this.#state = parts.state;
		this.#options = parts.options;
		this.#config = parts.config;

		this.#tui = new TuiMainScreen(parts.terminal);
		this.#conversation = new ConversationView(this.#state);
		this.#editor = new PromptEditor(this.#tui, {
			followUp: (text) => this.#send(text, "follow_up"),
			quit: () => this.#finish(0),
			cycleModel: (step) => this.#cycleModel(step),
			cycleEffort: () => this.#cycleEffort(),
			pasteImage: () => this.#pasteImage(),
			openQueue: () => this.#openQueue(),
		});
		this.#editor.onSubmit = (text) => this.#send(text, "enter");
		this.#editor.setAutocompleteProvider(
			new PromptAutocomplete(
				{
					sandboxModes: () => [
						"read-only",
						"workspace-write",
						...Object.keys(this.#config.permissionProfiles),
					],
					models: () => this.#config.models.map((model) => model.id),
				},
				this.#config.workspace,
			),
		);
		this.#tui.addChild(this.#conversation);
		this.#tui.addChild(new QueueView(this.#state));
		this.#tui.addChild(new HintLine(() => this.#hint()));
		this.#tui.addChild(this.#bottom);
		this.#tui.addChild(
			new StatusLine(this.#state.status, parts.context.env.HOME),
		);
		this.#tui.addInputListener((data) => this.#intercept(data));
	}

	/** 显示界面，到用户退出或 session 关闭为止，返回退出码。 */
	async run(prompt: string | undefined): Promise<number> {
		const unsubscribe = this.#context.onSignal((signal) => {
			// 第二个信号不再等 session 关完
			if (this.#closing) this.#exit.resolve(signalExitCode[signal]);
			else this.#finish(signalExitCode[signal]);
		});
		this.#tui.start();
		this.#refresh();
		if (prompt !== undefined) this.#send(prompt, "enter");
		try {
			return await this.#exit.promise;
		} finally {
			unsubscribe();
			this.#stopped = true;
			await this.#terminal.drainInput();
			this.#tui.stop();
		}
	}

	/** Host 的一个事件。在 Host 的调用里不能抛出：出错时让交互模式带着这个错误退出。 */
	onEvent(event: HostEvent): void {
		try {
			this.#state.apply(event);
			if (event.type === "input.dequeued" && event.reason === "task_ended") {
				this.#restore(event.inputs);
			}
			if (
				event.type === "task.started" ||
				event.type === "task.ended" ||
				// 取消时还有没插入的 steering：它们插入之后同一个任务接着做
				event.type === "input.inserted"
			) {
				this.#cancelling = false;
			}
			if (event.type === "session.ended" && event.reason !== "closed") {
				this.#finish(1);
			}
			this.#refresh();
		} catch (error) {
			this.#exit.reject(error);
		}
	}

	#refresh(): void {
		if (this.#stopped) return;
		const request = this.#state.approvals.at(0);
		if (request?.request_id !== this.#panel?.requestId) {
			this.#panel =
				request === undefined
					? undefined
					: {
							requestId: request.request_id,
							component: new ApprovalPanel({
								request,
								description: describeApproval(request, (id) => {
									const call = this.#state.toolCall(id);
									return call === undefined
										? undefined
										: toolSummary(call.arguments);
								}),
								waiting: () => this.#state.approvals.length - 1,
								adjacent: () => {
									const last = this.#state.entries.at(-1);
									return last?.kind === "approval" && last.request === request;
								},
								answer: (answer) =>
									this.#guard(() => {
										this.#session.respond(request.request_id, answer);
									}),
							}),
						};
		}
		const shown = this.#panel?.component ?? this.#overlay ?? this.#editor;
		if (this.#bottom.children[0] !== shown) {
			this.#bottom.clear();
			this.#bottom.addChild(shown);
			this.#tui.setFocus(shown);
		}
		this.#conversation.sync();
		this.#tui.requestRender();
	}

	#hint(): { text: string; emphasis: boolean } {
		if (this.#closing) return { text: "正在退出…", emphasis: false };
		// 询问的面板和列表自己写着按键
		if (this.#bottom.children[0] !== this.#editor) {
			return { text: "", emphasis: false };
		}
		if (this.#exitArmed) {
			return { text: "再按一次 Ctrl+C 退出", emphasis: true };
		}
		if (this.#state.taskId !== undefined) {
			return this.#cancelling
				? { text: "正在取消…", emphasis: true }
				: {
						text: "运行中 · Enter 插入当前任务 · Alt+Enter 排到之后 · Alt+↑ 管理排队的输入 · Ctrl+C 取消",
						emphasis: false,
					};
		}
		if (this.#state.queue.follow_up_paused) {
			return {
				text: "follow-up 列表暂停着 · Alt+Enter 排进列表 · Alt+↑ 管理列表，按 R 继续",
				emphasis: false,
			};
		}
		return {
			text: "Enter 发送 · Shift+Enter 换行 · / 命令 · @ 文件 · Ctrl+V 粘贴图片 · Ctrl+C 两次退出",
			emphasis: false,
		};
	}

	/**
	 * 运行一个按键或命令引出的动作，不让它的失败落进界面库的按键处理里：命令没做成的原因显示在
	 * 对话区，别的错误让交互模式带着它退出。
	 */
	#guard(action: () => void | Promise<void>): void {
		new Promise<void>((resolve) => {
			resolve(action());
		})
			.catch((error: unknown) => {
				if (!reportable(error)) throw error;
				this.#state.notice(error.message, "error");
			})
			.then(() => this.#refresh())
			.catch((error: unknown) => this.#exit.reject(error));
	}

	/**
	 * 排在前一个 session 操作之后做：开始任务、重启 agent 进程的命令都要等一会，这期间的输入按
	 * 轮到它时的状态决定是开始任务还是插入当前任务。
	 */
	#serial<Result>(operation: () => Promise<Result>): Promise<Result> {
		const result = this.#pending.then(operation);
		// 失败由调用方处理，这里只是不让排在后面的操作跟着失败
		this.#pending = result.catch(() => {});
		return result;
	}

	/** 全局的按键：Ctrl+C 不管焦点在哪里都是"取消当前的动作"。 */
	#intercept(data: string): { consume: true } | undefined {
		if (isKeyRelease(data)) return undefined;
		if (this.#closing) return { consume: true };
		if (!matchesKey(data, "ctrl+c")) {
			if (this.#exitArmed) {
				this.#exitArmed = false;
				this.#refresh();
			}
			return undefined;
		}
		this.#guard(() => this.#interrupt());
		return { consume: true };
	}

	async #interrupt(): Promise<void> {
		const request = this.#state.approvals.at(0);
		if (request === undefined && this.#overlay !== undefined) {
			this.#overlay = undefined;
		} else if (this.#state.taskId !== undefined) {
			// 取消任务时 Host 把它挂起的询问都答为拒绝
			this.#cancelling = true;
			this.#refresh();
			await this.#session.cancel();
		} else if (request !== undefined) {
			// 没有任务在运行时的询问来自后台命令：拒绝它
			this.#session.respond(request.request_id, {
				decision: "deny",
				scope: "once",
			});
		} else if (this.#editor.getText() !== "") {
			this.#editor.setText("");
			this.#attachments.clear();
		} else if (this.#exitArmed) {
			this.#finish(0);
		} else {
			this.#exitArmed = true;
		}
	}

	/** 关闭 session 后以这个退出码结束。 */
	#finish(code: number): void {
		if (this.#closing) return;
		this.#closing = true;
		this.#guard(async () => {
			this.#refresh();
			await this.#session.close();
			// 关闭过程中的事件画出来再停界面
			this.#refresh();
			this.#tui.renderNow();
			this.#exit.resolve(code);
		});
	}

	/** 输入框里提交的一条输入：会话内命令马上执行，别的发给 session。 */
	#send(text: string, key: "enter" | "follow_up"): void {
		const command = parseCommand(text);
		if (command !== undefined) {
			this.#editor.addToHistory(text);
			this.#guard(() => runCommand(command, this.#actions));
			return;
		}
		const input = composeInput(text, {
			workspace: this.#config.workspace,
			attachments: this.#attachments,
		});
		if (input.length === 0) return;
		this.#editor.addToHistory(text);
		this.#guard(() =>
			this.#serial(async () => {
				const { taskId, queue } = this.#state;
				if (
					key === "follow_up" &&
					(taskId !== undefined || queue.follow_up_paused)
				) {
					this.#session.followUp(input);
				} else if (taskId !== undefined) {
					this.#session.steer(input);
				} else {
					await this.#session.submit(input);
				}
			}),
		);
	}

	/** 排队的输入放回输入框，接在已有的内容后面，不自动发送。 */
	#restore(inputs: readonly QueuedInput[]): void {
		const existing = this.#editor.getExpandedText();
		const returned = inputs.map((item) =>
			editorText(item.input, this.#attachments),
		);
		this.#editor.setText(
			[...(existing === "" ? [] : [existing]), ...returned].join("\n"),
		);
	}

	/**
	 * 会话中换了设置：状态行跟着变。取 session 当前生效的配置，不自己重新解析：配置文件改了而还没有
	 * `/reload` 时，重新解析会把没生效的沙盒模式和审批策略显示出来。
	 */
	#reconfigured(): void {
		this.#config = this.#session.config();
		this.#state.configured(this.#config);
	}

	#setModel(model: string): Promise<void> {
		return this.#serial(async () => {
			await this.#session.setModel(model);
			this.#reconfigured();
			this.#state.notice(`模型换成 ${model}，从下一次模型请求起生效`);
		});
	}

	readonly #actions: CommandActions = {
		notice: (text) => this.#state.notice(text),
		current: () => this.#state.status,
		setSandboxMode: (mode) =>
			this.#serial(async () => {
				const previous = this.#state.status.sandboxMode;
				await this.#session.setSandboxMode(mode);
				this.#reconfigured();
				// 换了才有 sandbox_mode.changed；没换时也给一句回应
				if (this.#state.status.sandboxMode === previous) {
					this.#state.notice(`沙盒模式已经是 ${previous}`);
				}
			}),
		setApprovalPolicy: async (policy) => {
			this.#session.setApprovalPolicy(policy);
			this.#reconfigured();
		},
		setModel: (model) => this.#setModel(model),
		setReasoningEffort: (level) =>
			this.#serial(async () => {
				await this.#session.setReasoningEffort(level);
				this.#reconfigured();
				this.#state.notice(`推理强度换成 ${level}，从下一次模型请求起生效`);
			}),
		pickModel: () => {
			this.#overlay = new Picker({
				title: "切换模型",
				hint: "↑↓ 选择 · Enter 切换 · Esc 取消",
				items: this.#config.models.map((model) => ({
					value: model.id,
					label: model.id,
					description: model.service,
				})),
				selected: this.#config.model.id,
				onSelect: (model) => {
					this.#overlay = undefined;
					this.#guard(() => this.#setModel(model));
				},
				onCancel: () => this.#closeOverlay(),
			});
		},
		pickBackground: () => {
			const running = this.#session.backgroundCommands();
			if (running.length === 0) {
				this.#state.notice("没有在运行的后台命令");
				return;
			}
			this.#overlay = new Picker({
				title: "后台命令",
				hint: "↑↓ 选择 · Enter 停止选中的命令 · Esc 关闭",
				items: running.map((command) => ({
					value: command.background_id,
					label: `${command.background_id}  ${brief(command.command, 60)}`,
					description: `${command.kind === "monitor" ? "监视" : "命令"} · ${command.started_at}`,
				})),
				onSelect: (id) => {
					this.#overlay = undefined;
					this.#guard(async () => {
						const stopped = await this.#session.stopBackgroundCommand(id);
						this.#state.notice(
							stopped ? `已停止后台命令 ${id}` : `后台命令 ${id} 已经结束了`,
						);
					});
				},
				onCancel: () => this.#closeOverlay(),
			});
		},
		reload: () =>
			this.#serial(async () => {
				await this.#session.reload();
				this.#reconfigured();
				this.#credentials = undefined;
				this.#state.notice("已重新读取配置、权限规则、规则文件和扩展");
			}),
		clearCache: async () => {
			this.#host.clearCache({ directory: this.#config.workspace });
			this.#state.notice("已清空这个项目的构建缓存");
		},
		quit: () => this.#finish(0),
	};

	#closeOverlay(): void {
		this.#overlay = undefined;
		this.#refresh();
	}

	#cycleModel(step: 1 | -1): void {
		this.#guard(async () => {
			this.#credentials ??= await this.#host.credentialStatus(
				this.#options.credentials === undefined
					? {}
					: { credentials: this.#options.credentials },
			);
			const usable = usableModels(this.#config, this.#credentials);
			const next = cycle(
				usable.map((model) => model.id),
				this.#config.model.id,
				step,
			);
			if (next === undefined) {
				this.#state.notice("没有别的能切换过去的模型：它们的服务没有凭据");
				return;
			}
			await this.#setModel(next);
		});
	}

	#cycleEffort(): void {
		this.#guard(async () => {
			const levels = effortLevels(this.#config.model);
			const next = cycle(levels, this.#config.reasoningEffort, 1);
			if (next === undefined) {
				this.#state.notice(
					levels.length === 0
						? `${this.#config.model.id} 不能调推理强度`
						: `${this.#config.model.id} 只有 ${levels.join("、")} 这一级推理强度`,
				);
				return;
			}
			await this.#actions.setReasoningEffort(next);
		});
	}

	#pasteImage(): void {
		this.#guard(async () => {
			let bytes: Uint8Array | undefined;
			try {
				bytes = await this.#clipboard.readImage();
			} catch (error) {
				// 剪贴板是外部的：读不出来说明原因，session 照常继续
				this.#state.notice(
					`读不了剪贴板：${(error as Error).message}`,
					"error",
				);
				return;
			}
			if (bytes === undefined) return;
			const image = imageBlock(bytes);
			if (image === undefined) {
				this.#state.notice(
					"剪贴板里的图片不是 PNG、JPEG、GIF 或 WebP，没有粘贴",
					"warning",
				);
				return;
			}
			this.#editor.insertTextAtCursor(this.#attachments.add(image));
		});
	}

	#openQueue(): void {
		const panel = new QueuePanel(this.#state, {
			retrieve: (item) =>
				this.#guard(() => {
					this.#restore(this.#session.dequeue(item.input_id));
					this.#overlay = undefined;
				}),
			remove: (item) =>
				this.#guard(() => {
					this.#session.dequeue(item.input_id);
				}),
			move: (item, step) =>
				this.#guard(() => {
					const moved = this.#move(item, step);
					if (moved !== undefined) panel.select(moved);
				}),
			// 继续之后列表里的输入接着开始任务，面板里没有别的要做
			resume: () =>
				this.#guard(async () => {
					await this.#serial(() => this.#session.resumeFollowUps());
					this.#overlay = undefined;
				}),
			close: () => this.#closeOverlay(),
		});
		this.#overlay = panel;
		this.#refresh();
	}

	/**
	 * 把排队的一条输入在它的列表里移一位，返回它的新编号。SDK 只能取回和排到末尾：从换位置的地方起
	 * 把后面的都取回，换好顺序再排回去。
	 */
	#move(item: QueuedInput, step: 1 | -1): string | undefined {
		const queue = this.#session.inputQueue();
		const list = item.kind === "steering" ? queue.steering : queue.follow_up;
		const from = list.findIndex((queued) => queued.input_id === item.input_id);
		const to = from + step;
		if (from === -1 || to < 0 || to >= list.length) return undefined;
		// 暂停的列表刚继续、第一条还没开始的那一刻，取回的 follow-up 排不回去：这时不动它
		if (
			item.kind === "follow_up" &&
			this.#state.taskId === undefined &&
			!queue.follow_up_paused
		) {
			return undefined;
		}
		const first = Math.min(from, to);
		const taken = list
			.slice(first)
			.flatMap((queued) => this.#session.dequeue(queued.input_id));
		const [a, b, ...rest] = taken;
		let moved: string | undefined;
		for (const queued of [b, a, ...rest]) {
			const id =
				queued.kind === "steering"
					? this.#session.steer(queued.input)
					: this.#session.followUp(queued.input);
			if (queued.input_id === item.input_id) moved = id;
		}
		return moved;
	}
}

/**
 * 在给定的终端上运行交互模式，返回退出码。和 `runInteractive` 分开：测试传入自己的终端和剪贴板，
 * 不需要真的终端。session 打开之前的失败照常抛出，由调用方报告。
 */
export async function runInteractiveOn(
	options: InteractiveOptions,
	terminal: Terminal,
	clipboard: Clipboard,
): Promise<number> {
	const { context } = options;
	const host = openHost(context);
	const sessionOptions: SessionOptions = {
		...options.session,
		...(options.approvalPolicy === undefined
			? {}
			: { approvalPolicy: options.approvalPolicy }),
	};
	const config = host.resolveConfig(sessionOptions);
	context.useProxy(config.proxy);
	const state = new InteractiveState(config);
	let ui: Interactive | undefined;
	// 先打开 session 再接管终端：打不开时错误照常写到 stderr，终端没有动过
	const session = await host.openSession({
		...sessionOptions,
		onEvent: (event) => {
			if (ui === undefined) state.apply(event);
			else ui.onEvent(event);
		},
	});
	try {
		ui = new Interactive({
			host,
			session,
			context,
			clipboard,
			terminal,
			state,
			options: sessionOptions,
			config,
		});
		return await ui.run(options.prompt);
	} finally {
		await session.close();
	}
}
