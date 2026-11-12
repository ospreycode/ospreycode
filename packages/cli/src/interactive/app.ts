import { resolve } from "node:path";
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
	type ElicitationAnswer,
	type Host,
	type HostEvent,
	InputBlockedError,
	MemoryConflictError,
	MemoryNotFoundError,
	MemoryRejectedError,
	MemoryStateError,
	type QueuedInput,
	SandboxUnavailableError,
	type Session,
	SessionCommandError,
	type SessionConfig,
	type SessionOptions,
	SnapshotError,
	type UndoResult,
	WorkspaceError,
} from "@ospreycode/agent-host";
import { startSessionCleanup } from "../cleanup.js";
import type { CliContext, CliSignal } from "../context.js";
import { writeExportFile } from "../export-file.js";
import { openHost } from "../host.js";
import { resumableSessions, targetSessionId } from "../resume.js";
import {
	attributed,
	describeApproval,
	describeServerApproval,
	serverApprovalOptions,
} from "./approval.js";
import {
	BranchList,
	CheckpointList,
	describeDiff,
	describeRestored,
	type ListedBranch,
	type ListedCheckpoint,
	parseBranch,
	parseDiff,
	parseFork,
	parseRewind,
	parseUndo,
} from "./checkpoints.js";
import { type Clipboard, imageBlock } from "./clipboard.js";
import {
	type CommandActions,
	CommandUsageError,
	parseCommand,
	runCommand,
} from "./commands.js";
import { PromptAutocomplete } from "./completion.js";
import { parseFields } from "./elicitation.js";
import { ExtensionCommands } from "./extensions.js";
import { brief, toolSummary } from "./format.js";
import type { InteractiveOptions } from "./index.js";
import { Attachments, composeInput, editorText } from "./input.js";
import { MemoryCommands } from "./memory.js";
import { cycle, effortLevels, usableModels } from "./models.js";
import { pickSession } from "./session-picker.js";
import { InteractiveState, type ServerQuestion } from "./state.js";
import type { ApprovalAnswer, InputBlock } from "./types.js";
import { ApprovalPanel } from "./view/approval-panel.js";
import { ConversationView } from "./view/conversation.js";
import { PromptEditor } from "./view/editor.js";
import { ElicitationPanel } from "./view/elicitation-panel.js";
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
		error instanceof CommandUsageError ||
		// `/diff`、`/undo` 和 `/rewind N code` 要做的快照没做成：影子仓库里的 git 出了错
		error instanceof SnapshotError ||
		// 记忆操作没做成：没有这条记忆、状态不对、内容不能写入，或者显示之后被别的 Host 改过
		error instanceof MemoryNotFoundError ||
		error instanceof MemoryStateError ||
		error instanceof MemoryRejectedError ||
		error instanceof MemoryConflictError
	);
}

/**
 * 按 session 的记录重画对话（恢复、回退和分叉之后）。`live` 是 Host 已经发给 `onEvent`、界面还
 * 没有处理的事件：其中已经记下的也在 `history()` 里，按 `event_id` 从里面去掉，剩下的是在这之前
 * 的对话；`live` 之后按顺序处理，每个事件只处理一次。
 */
function replay(
	state: InteractiveState,
	session: Session,
	live: readonly HostEvent[],
): void {
	const ids = new Set(
		live.flatMap((event) => ("event_id" in event ? [event.event_id] : [])),
	);
	state.restore(
		session
			.history()
			.filter((event) => !("event_id" in event && ids.has(event.event_id))),
		{ queue: session.inputQueue(), config: session.config() },
	);
}

/** 占着输入框位置、等用户回答的面板，和它回答的那个询问的编号。 */
interface AnswerPanel {
	requestId: string;
	component: ApprovalPanel | ElicitationPanel;
}

/** 交互界面：把 Host 的事件显示出来，把按键变成对 session 的操作。 */
class Interactive {
	readonly #host: Host;
	/** 界面显示的 session：`/fork` 之后换成分叉出来的那个。 */
	#session: Session;
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
	/** 交给 session、还在等 `UserPromptSubmit` hooks 检查的 steering 和 follow-up：被拦下时放回输入框。 */
	readonly #checking = new Map<string, InputBlock[]>();
	#memory: MemoryCommands;
	readonly #extensions: ExtensionCommands;
	/** `/undo`、`/rewind` 上次列出的检查点，命令里的序号指的是它们。 */
	readonly #checkpoints = new CheckpointList();
	/** `/branch` 上次列出的被放弃的分支，命令里的序号指的是它们。 */
	readonly #branches = new BranchList();
	readonly #exit = Promise.withResolvers<number>();
	/** 启动参数：查各个服务有没有凭据时要用其中的凭据来源。 */
	readonly #options: SessionOptions;
	/** session 当前生效的配置，换过设置之后重新取。 */
	#config: SessionConfig;
	/** 各个服务有没有凭据，换模型的按键第一次用到时才查：查它要读系统凭据库。 */
	#credentials: CredentialStatus[] | undefined;
	/** 要等上一个做完才能做下一个的 session 操作排成一串。 */
	#pending: Promise<unknown> = Promise.resolve();
	/**
	 * 回退和换 session 的时候，Host 发来的事件先留在这里，等对话按记录重画之后再按顺序处理：先处理
	 * 的话，它们显示出来的内容会被重画清掉。平时没有。
	 */
	#held: HostEvent[] | undefined;
	/**
	 * 正在换 session（`/fork`）：原来的已经关闭，新的还没有打开。这期间按键引出的操作没有对象，所以
	 * 不接受按键；退出要等它有了结果，关掉换上的那个 session。
	 */
	#switching: Promise<unknown> | undefined;
	#panel: AnswerPanel | undefined;
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
		this.#memory = this.#memoryCommands(parts.session);
		this.#extensions = new ExtensionCommands({
			admin: parts.host.extensions,
			workspace: parts.config.workspace,
			servers: () => this.#session.mcpServers(),
			notice: (text) => this.#state.notice(text),
		});

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

	/** 一个 session 的 `/memory`：记忆的操作经过这个 session 的 `MemoryManager`。 */
	#memoryCommands(session: Session): MemoryCommands {
		const { memory } = session;
		// 关掉长期记忆是 SDK 才有的选项，CLI 不传
		if (memory === undefined) {
			throw new Error("CLI 打开的 session 没有长期记忆");
		}
		return new MemoryCommands(memory, (text) => this.#state.notice(text));
	}

	/** 关闭界面显示的 session；正在换 session 时等它有了结果，关换上的那个。 */
	async close(): Promise<void> {
		await this.#switching;
		await this.#session.close();
	}

	/**
	 * 显示界面，到用户退出或 session 关闭为止，返回退出码。`early` 是界面出来之前 Host 已经发出的
	 * 事件，界面出来后按顺序处理：恢复 session 时里面有交还输入框的 steering 和要用户回答的询问。
	 */
	async run(
		prompt: string | undefined,
		early: readonly HostEvent[],
	): Promise<number> {
		const unsubscribe = this.#context.onSignal((signal) => {
			// 第二个信号不再等 session 关完
			if (this.#closing) this.#exit.resolve(signalExitCode[signal]);
			else this.#finish(signalExitCode[signal]);
		});
		this.#tui.start();
		for (const event of early) this.onEvent(event);
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
		if (this.#held !== undefined) {
			this.#held.push(event);
			return;
		}
		try {
			this.#state.apply(event);
			if (event.type === "input.dequeued" && event.reason === "task_ended") {
				this.#restore(event.inputs);
			}
			if (event.type === "hooks.ran" && event.input_id !== undefined) {
				const input = this.#checking.get(event.input_id);
				this.#checking.delete(event.input_id);
				if (event.blocked && input !== undefined) this.#restore([{ input }]);
			}
			if (event.type === "memory.candidates") {
				this.#memory.announce(event.candidates);
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
		// 任务里的询问先回答：MCP server 的问题不属于任务，排在它们后面
		const question =
			request === undefined ? this.#state.serverQuestions.at(0) : undefined;
		if ((request ?? question)?.request_id !== this.#panel?.requestId) {
			this.#panel =
				request === undefined
					? question === undefined
						? undefined
						: this.#questionPanel(question)
					: {
							requestId: request.request_id,
							component: new ApprovalPanel({
								request,
								description: attributed(
									describeApproval(request, (id) => {
										const call = this.#state.toolCall(id);
										return call === undefined
											? undefined
											: toolSummary(call.arguments);
									}),
									this.#state.subagentName(request.agent_id),
								),
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

	/** MCP server 的一个问题的面板：它的提问是一张表单，它要访问的域名和命令的网络询问一样回答。 */
	#questionPanel(question: ServerQuestion): AnswerPanel {
		const answer = (answer: ApprovalAnswer | ElicitationAnswer) =>
			this.#guard(() => {
				this.#session.respond(question.request_id, answer);
			});
		return {
			requestId: question.request_id,
			component:
				question.type === "elicitation.requested"
					? new ElicitationPanel({
							server: question.server,
							message: question.message,
							fields: parseFields(question.schema),
							answer,
						})
					: new ApprovalPanel({
							request: {
								request_id: question.request_id,
								kind: "network",
								request: question.request,
								reasons: question.reasons,
							},
							description: describeServerApproval(question),
							choices: serverApprovalOptions,
							hint: "先按 ↑↓ 选择，再按 Enter 确认 · Esc 拒绝",
							waiting: () => this.#state.serverQuestions.length - 1,
							// 这种询问在对话区里没有自己的条目，内容都在面板里
							adjacent: () => false,
							answer,
						}),
		};
	}

	#hint(): { text: string; emphasis: boolean } {
		if (this.#closing) return { text: "正在退出…", emphasis: false };
		if (this.#switching !== undefined) {
			return { text: "正在分叉…", emphasis: false };
		}
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
		if (this.#closing || this.#switching !== undefined) {
			return { consume: true };
		}
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
		const question = this.#state.serverQuestions.at(0);
		if (request === undefined && this.#overlay !== undefined) {
			this.#overlay = undefined;
		} else if (this.#state.taskId !== undefined) {
			// 取消任务时 Host 把它挂起的询问都答为拒绝
			this.#cancelling = true;
			this.#refresh();
			await this.#session.cancel();
		} else if (request !== undefined) {
			// 没有任务在运行时的询问来自后台命令，或者是恢复时问要不要重新执行（拒绝就是跳过）：拒绝它
			this.#session.respond(request.request_id, {
				decision: "deny",
				scope: "once",
			});
		} else if (question !== undefined) {
			// MCP server 的问题不属于任务，没有任务可以取消：提问答为不回答，网络访问答为拒绝
			this.#session.respond(
				question.request_id,
				question.type === "elicitation.requested"
					? { action: "cancel" }
					: { decision: "deny", scope: "once" },
			);
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
			await this.close();
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
					this.#checked(this.#session.followUp(input), input);
				} else if (taskId !== undefined) {
					this.#checked(this.#session.steer(input), input);
				} else {
					try {
						await this.#session.submit(input);
					} catch (error) {
						// `UserPromptSubmit` hooks 拦下了这条输入：原因已经随 `hooks.ran` 显示在对话区，
						// 输入放回输入框，改一改就能再发
						if (!(error instanceof InputBlockedError)) throw error;
						this.#restore([{ input }]);
					}
				}
			}),
		);
	}

	/** 记下一条刚交给 session 的 steering 或 follow-up：没有 hooks 要检查时它已经在队列里，不用记。 */
	#checked(inputId: string, input: InputBlock[]): void {
		const { steering, follow_up } = this.#state.queue;
		const queued = [...steering, ...follow_up].some(
			(item) => item.input_id === inputId,
		);
		if (!queued) this.#checking.set(inputId, input);
	}

	/** 排队的和被 hooks 拦下的输入放回输入框，接在已有的内容后面，不自动发送。 */
	#restore(inputs: readonly Pick<QueuedInput, "input">[]): void {
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

	/** `/undo`、`/rewind` 不带参数：列出检查点，之后的命令按这一份的序号引用。 */
	#listCheckpoints(): void {
		this.#state.notice(this.#checkpoints.show(this.#session.checkpoints()));
	}

	/**
	 * 按 session 的记录重画对话（回退、换 session 之后）。这之前留着的事件里已经记下的不画，它们
	 * 接着由 `#release` 按顺序处理。
	 */
	#redraw(): void {
		if (this.#held === undefined) {
			throw new Error("重画对话之前没有把 Host 的事件留着");
		}
		this.#config = this.#session.config();
		replay(this.#state, this.#session, this.#held);
		this.#conversation.clear();
		// 列表不在屏幕上了：要重新列出才能再按序号引用
		this.#checkpoints.forget();
		this.#branches.forget();
	}

	/** 把留着的事件按顺序处理掉，之后的事件照常处理。 */
	#release(): void {
		const held = this.#held;
		if (held === undefined) throw new Error("没有留着的事件");
		this.#held = undefined;
		for (const event of held) this.onEvent(event);
	}

	/** `/rewind N`：把对话回退到一个检查点的输入之前，`code` 同时还原代码；那次输入放回输入框。 */
	async #rewind(
		target: ListedCheckpoint,
		options: { code: boolean; overwrite: boolean },
	): Promise<void> {
		// 对话区里等回答的询问随重画消失，之后没有地方回答
		if (this.#state.approvals.length > 0) {
			throw new CommandUsageError("还有没回答的询问：先回答，再回退会话");
		}
		const { number, checkpoint } = target;
		let restored: UndoResult | undefined;
		this.#held = [];
		try {
			restored = await this.#session.rewind(checkpoint.id, options);
			this.#redraw();
		} finally {
			// 没做成时也照常处理：agent 进程没能重新启动的话，里面有 session 关闭的事件
			this.#release();
		}
		const text = checkpoint.text ?? "";
		this.#state.notice(
			[
				`已把对话回退到第 ${number} 个检查点的输入之前${text === "" ? "" : "，那次输入放回了输入框"}；${restored === undefined ? "代码没有动" : "代码还原到那时："}`,
				...(restored === undefined
					? []
					: describeRestored(restored, `/rewind ${number} code overwrite`)),
				"放弃的那一段对话留在记录里：/branch 列出，可以切回去",
			].join("\n"),
		);
		if (text !== "") this.#restore([{ input: [{ type: "text", text }] }]);
	}

	/** `/branch N`：切回回退时放弃的一个分支，对话换成那一段，代码不动。 */
	async #switchBranch({ number, branch }: ListedBranch): Promise<void> {
		// 对话区里等回答的询问随重画消失，之后没有地方回答
		if (this.#state.approvals.length > 0) {
			throw new CommandUsageError("还有没回答的询问：先回答，再切换分支");
		}
		this.#held = [];
		try {
			await this.#session.switchBranch(branch.id);
			this.#redraw();
		} finally {
			// 没做成时也照常处理：agent 进程没能重新启动的话，里面有 session 关闭的事件
			this.#release();
		}
		this.#state.notice(
			`已切回第 ${number} 个分支：上面是那一段对话，之后的输入接在它后面；刚才这一段成为被放弃的分支，代码没有动`,
		);
	}

	/**
	 * 打开要换上的 session（分叉，或者重新打开原来那个），这期间它发来的事件先留着。没打开时留着的
	 * 事件不处理：它们不属于界面显示的 session。
	 */
	async #opening(
		open: (onEvent: (event: HostEvent) => void) => Promise<Session>,
	): Promise<Session> {
		this.#held = [];
		try {
			return await open((event) => this.onEvent(event));
		} catch (error) {
			this.#held = undefined;
			throw error;
		}
	}

	/**
	 * `/fork`：按正常顺序关闭当前的 session，在同一个 Host 里从它分叉，界面换到分叉上。分叉没有
	 * 成功时重新打开原来的 session；连它也打不开就说明原因、退出。
	 */
	async #fork(target: ListedCheckpoint | undefined): Promise<void> {
		// 排在前面的操作已经让界面开始退出：不再打开新的 session
		if (this.#closing) return;
		const source = this.#session;
		// session 关闭之后才发现分叉不了，就得重新打开它：关闭之前能判断的先判断
		if (this.#state.taskId !== undefined) {
			throw new CommandUsageError("只能在 session 空闲时分叉");
		}
		const { approvals, serverQuestions } = this.#state;
		if (approvals.length > 0 || serverQuestions.length > 0) {
			throw new CommandUsageError("还有没回答的询问：先回答，再分叉");
		}
		let before = source.history();
		if (target !== undefined) {
			const { number, checkpoint } = target;
			if (!checkpoint.on_path) {
				throw new CommandUsageError(
					`第 ${number} 个检查点不在当前的对话路径上，不能从它分叉`,
				);
			}
			const at = before.findIndex(
				(event) => "event_id" in event && event.event_id === checkpoint.id,
			);
			if (at === -1) {
				throw new Error(`当前路径上的检查点不在记录里：${checkpoint.id}`);
			}
			before = before.slice(0, at);
		}
		if (!before.some((event) => event.type === "task.started")) {
			throw new CommandUsageError(
				target === undefined
					? "还没有对话，没有可以分叉的内容"
					: `第 ${target.number} 个检查点之前还没有对话：从这里分叉就是新建一个 session`,
			);
		}
		// 会话中换过的沙盒模式和审批策略是用户现在的工作方式，带到分叉上。模型和推理强度：从当前位置
		// 分叉时接着用现在的；从检查点分叉时不指定，由 Host 按分叉位置的记录决定，和 `/rewind` 一致
		const config = source.config();
		const current: SessionOptions = {
			...this.#options,
			sandboxMode: config.sandboxMode,
			approvalPolicy: config.approvalPolicy,
			model: config.model.id,
			reasoningEffort: config.reasoningEffort,
		};
		const { model, reasoningEffort, ...recorded } = current;
		const switching = (async () => {
			await source.close();
			let opened: Session;
			let failure: Error | undefined;
			try {
				opened = await this.#opening((onEvent) =>
					this.#host.forkSession({
						...(target === undefined
							? current
							: { ...recorded, checkpointId: target.checkpoint.id }),
						sessionId: source.id,
						onEvent,
					}),
				);
			} catch (error) {
				if (!reportable(error)) throw error;
				failure = error;
				try {
					opened = await this.#opening((onEvent) =>
						this.#host.resumeSession({
							...current,
							sessionId: source.id,
							onEvent,
						}),
					);
				} catch (again) {
					if (!reportable(again)) throw again;
					this.#state.notice(`分叉没有成功：${error.message}`, "error");
					this.#state.notice(
						`也没能重新打开 session ${source.id}：${again.message}\n用 ospreycode resume ${source.id} 回到它`,
						"error",
					);
					this.#finish(1);
					return;
				}
			}
			this.#session = opened;
			this.#memory = this.#memoryCommands(opened);
			// 等 hooks 检查的输入是交给原来那个 session 的
			this.#checking.clear();
			this.#state.switched();
			this.#redraw();
			if (failure === undefined) {
				this.#state.notice(
					`已从 session ${source.id} 分叉，现在是 session ${opened.id}：上面是分叉位置之前的对话，之后的输入写在分叉里，原来的 session 不变`,
				);
			} else {
				this.#state.notice(`分叉没有成功：${failure.message}`, "error");
				this.#state.notice(
					`已重新打开 session ${source.id}，之前给出的批准都已失效，需要时会重新询问`,
				);
			}
			this.#release();
		})();
		// 失败由下面的 await 报告，这里只是让等着退出的一方知道它有了结果
		this.#switching = switching.catch(() => {});
		this.#refresh();
		try {
			await switching;
		} finally {
			this.#switching = undefined;
		}
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
		memory: (argument) => this.#memory.run(argument),
		extensions: (argument) => this.#extensions.run(argument),
		// 进展和结果由事件显示：压缩 task 的开始、`context.compacted` 和 task 的结束
		compact: () =>
			this.#serial(async () => {
				await this.#session.compact();
			}),
		// 只读，task 运行中也可以看：不排在别的 session 操作后面
		diff: async (argument) => {
			const since = parseDiff(argument, this.#checkpoints);
			const { text, detail } = describeDiff(
				await this.#session.diff(since?.checkpoint.id),
				since,
			);
			this.#state.notice(text, "info", detail);
		},
		undo: async (argument) => {
			const parsed = parseUndo(argument, this.#checkpoints);
			if (parsed === undefined) {
				this.#listCheckpoints();
				return;
			}
			const { target, overwrite } = parsed;
			await this.#serial(async () => {
				const result = await this.#session.undo(target.checkpoint.id, {
					overwrite,
				});
				this.#state.notice(
					[
						`已把代码还原到第 ${target.number} 个检查点，对话没有动：`,
						...describeRestored(result, `/undo ${target.number} overwrite`),
					].join("\n"),
				);
			});
		},
		rewind: async (argument) => {
			const parsed = parseRewind(argument, this.#checkpoints);
			if (parsed === undefined) {
				this.#listCheckpoints();
				return;
			}
			const { target, ...options } = parsed;
			await this.#serial(() => this.#rewind(target, options));
		},
		branch: async (argument) => {
			const target = parseBranch(argument, this.#branches);
			if (target === undefined) {
				this.#state.notice(this.#branches.show(this.#session.branches()));
				return;
			}
			await this.#serial(() => this.#switchBranch(target));
		},
		fork: async (argument) => {
			const target = parseFork(argument, this.#checkpoints);
			await this.#serial(() => this.#fork(target));
		},
		// 导出只读记录，task 运行中也可以做
		exportSession: async (argument) => {
			const { id } = this.#session;
			const path = resolve(
				this.#context.cwd,
				argument === "" ? `ospreycode-${id}.jsonl` : argument,
			);
			const written = writeExportFile(
				path,
				this.#host.exportSession({
					directory: this.#config.workspace,
					sessionId: id,
				}),
			);
			if ("unwritable" in written) {
				throw new CommandUsageError(
					`写不了 ${path}：${written.unwritable.code}`,
				);
			}
			this.#state.notice(
				`已把 session ${id} 导出到 ${path}（${written.lines} 行，文件只对当前用户可读写）`,
			);
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
 * 要恢复的 session 的标识。命令行没有指定时列出这个工作区的 session 让用户选；用户没有选（取消，
 * 或者进程收到了信号）时返回交互模式的退出码。
 */
async function chooseSession(
	resume: NonNullable<InteractiveOptions["resume"]>,
	parts: {
		host: Host;
		workspace: string;
		terminal: Terminal;
		context: CliContext;
	},
): Promise<{ sessionId: string } | { exitCode: number }> {
	const { host, workspace } = parts;
	if (resume.kind !== "pick") {
		return { sessionId: targetSessionId(resume, host, workspace) };
	}
	const picked = await pickSession(
		parts.terminal,
		parts.context,
		resumableSessions(host, workspace),
	);
	switch (picked.kind) {
		case "selected":
			return { sessionId: picked.sessionId };
		case "cancelled":
			return { exitCode: 0 };
		case "signalled":
			return { exitCode: signalExitCode[picked.signal] };
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
	let sessionId: string | undefined;
	if (options.resume !== undefined) {
		const chosen = await chooseSession(options.resume, {
			host,
			workspace: config.workspace,
			terminal,
			context,
		});
		if ("exitCode" in chosen) return chosen.exitCode;
		sessionId = chosen.sessionId;
	}
	const state = new InteractiveState(config);
	/** 界面出来之前 Host 已经发出的事件，界面出来后按顺序处理。 */
	const early: HostEvent[] = [];
	let ui: Interactive | undefined;
	const opening = {
		...sessionOptions,
		onEvent: (event: HostEvent) => {
			if (ui === undefined) early.push(event);
			else ui.onEvent(event);
		},
	};
	// 先打开 session 再接管终端：打不开时错误照常写到 stderr，这时终端没有被占着
	const session =
		sessionId === undefined
			? await host.openSession(opening)
			: await host.resumeSession({ ...opening, sessionId });
	// 到期的 session 在对话的同时清理；出了错等界面退出之后再报告，不打乱屏幕
	const cleaned = startSessionCleanup(host, context);
	try {
		if (sessionId !== undefined) {
			replay(state, session, early);
			state.notice(`已恢复 session ${session.id}，上面是之前的对话`);
			state.notice("中断前给出的批准都已失效，需要时会重新询问");
		}
		ui = new Interactive({
			host,
			session,
			context,
			clipboard,
			terminal,
			state,
			options: sessionOptions,
			// 恢复的 session 的模型和推理强度按记录，不一定是启动参数解析出来的那一份
			config: session.config(),
		});
		return await ui.run(options.prompt, early);
	} finally {
		// `/fork` 之后界面显示的是分叉出来的 session，要关的是它
		await (ui === undefined ? session.close() : ui.close());
		await cleaned();
	}
}
