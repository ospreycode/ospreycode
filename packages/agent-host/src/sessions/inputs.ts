import type {
	InputContent,
	InputInserted,
	PendingInput,
} from "@ospreycode/agent-runtime";
import type { UserContent } from "@ospreycode/api/protocol";
import type { TaskOutcome } from "./events.js";
import { newId } from "./ids.js";

/** 排队的一条用户输入。 */
export interface QueuedInput {
	input_id: string;
	/** `steering` 并入当前 task；`follow_up` 等当前 task 完成后作为新的 task。 */
	kind: "steering" | "follow_up";
	/** 用户给的输入：提及的路径还没有展开。 */
	input: InputContent[];
}

/** 两个队列的完整快照：队列每次变化都随事件记下，恢复时据此重建。 */
export interface InputQueueSnapshot {
	/** 等待插入当前 task 的 steering，按输入的顺序。 */
	steering: QueuedInput[];
	/** follow-up 列表，按开始的顺序。 */
	follow_up: QueuedInput[];
	/** 列表暂停：上一个 task 没有以 `completed` 结束，等用户继续。 */
	follow_up_paused: boolean;
}

/** `input.queued` 的内容：一条 steering 或 follow-up 排进了队列。 */
export interface InputQueued extends QueuedInput {
	queue: InputQueueSnapshot;
}

/** `input.inserted` 的内容：steering 插进了当前 task。 */
export interface InputInsertedRecord {
	input_ids: string[];
	/** 放这些输入的 user 消息。 */
	message_id: string;
	/** 跟在哪次工具调用的结果后面；不跟在工具结果后面时为空。 */
	after_tool_call_id: string | null;
	queue: InputQueueSnapshot;
}

/**
 * `input.dequeued` 的内容：输入没有交给模型就离开了队列。`returned` 是用户取回；`task_ended` 是 task
 * 结束时还没插入的 steering，前端把它放回输入框；`follow_up_started` 是 follow-up 作为新的 task 开始。
 */
export interface InputDequeued {
	inputs: QueuedInput[];
	reason: "returned" | "task_ended" | "follow_up_started";
	queue: InputQueueSnapshot;
}

/** `input.follow_up_paused` 的内容：follow-up 列表暂停或继续。 */
export interface FollowUpPaused {
	paused: boolean;
	queue: InputQueueSnapshot;
}

/** `background.delivered` 的内容：这些后台通知交给了这个 task 的模型。 */
export interface BackgroundDelivered {
	notification_ids: string[];
}

/** 队列变化时要记的事件。 */
export type InputEvent =
	| ({ type: "input.queued" } & InputQueued)
	| ({ type: "input.inserted" } & InputInsertedRecord)
	| ({ type: "input.dequeued" } & InputDequeued)
	| ({ type: "input.follow_up_paused" } & FollowUpPaused)
	| ({ type: "background.delivered" } & BackgroundDelivered);

/** 交给模型的一条后台通知。 */
export interface Notice {
	/** 产生它的后台命令；不是哪一条后台命令产生的（归属不明的网络拒绝）为空。 */
	background_id: string | null;
	/** 交给模型的文字，不含固定前缀。 */
	text: string;
	/**
	 * 监视命令输出的行：同一条命令还没交给模型的行合并成一条通知，只保留最近的
	 * `maxMonitorLines` 行，其余只记行数。
	 */
	monitor?: { lines: string[]; dropped: number };
	/** 用户操作导致的结束（在前端停止命令、切换沙盒模式）不唤醒 session。 */
	wake: boolean;
}

/** 排在队列里的通知。 */
interface Notification extends Notice {
	notification_id: string;
}

/** 通知进入上下文时的固定前缀：系统指令里说明它不是用户的输入，也不是批准。 */
export const notificationPrefix = "Automatic notification, not user input.";

/** 暂时不交给模型的监视通知里，每条命令保留的行数。 */
export const maxMonitorLines = 100;

/** 连续由后台通知开始、中间没有用户输入的 task 的上限。 */
export const maxConsecutiveWakeups = 3;

function render(notification: Notification): UserContent[] {
	const { monitor } = notification;
	const body =
		monitor === undefined
			? notification.text
			: [
					notification.text,
					...(monitor.dropped === 0
						? []
						: [`(${monitor.dropped} earlier lines are not shown)`]),
					...monitor.lines,
				].join("\n");
	return [{ type: "text", text: `${notificationPrefix} ${body}` }];
}

/**
 * steering、follow-up 和后台通知的队列。队列只在 Host 这边：runtime 在插入时机用 `input/take` 取走
 * steering 和通知，报告插入的位置；follow-up 和唤醒由 Host 在 session 空闲时作为新的 task 开始。
 */
export class InputQueues {
	#record: (event: InputEvent) => void;
	#steering: QueuedInput[] = [];
	#followUp: QueuedInput[] = [];
	#paused = false;
	/** runtime 取走、还没报告插入位置的 steering：这期间 task 结束了也要放回输入框。 */
	#taken = new Map<string, QueuedInput>();
	#notifications: Notification[] = [];
	/** runtime 取走、还没报告插入位置的通知。 */
	#takenNotifications = new Set<string>();
	/** 连续由后台通知开始的 task 的个数，用户有输入时清零。 */
	#wakeups = 0;
	/** 唤醒开始的 task 里有调用被 `forbidden` 规则或 hook 阻止：到用户下一次输入之前不再唤醒。 */
	#wakeBlocked = false;
	/**
	 * 上一个 task 没有以 `completed` 结束：到用户下一次输入之前不唤醒，自动继续会违背取消的意图，
	 * 或反复撞上同一个错误、绕过预算。follow-up 列表是空的、没有记暂停时也一样。
	 */
	#wakeHeld = false;

	constructor(record: (event: InputEvent) => void) {
		this.#record = record;
	}

	/** 当前的队列。 */
	snapshot(): InputQueueSnapshot {
		return {
			steering: [...this.#steering],
			follow_up: [...this.#followUp],
			follow_up_paused: this.#paused,
		};
	}

	#queue(kind: QueuedInput["kind"], input: InputContent[]): string {
		const queued: QueuedInput = { input_id: newId(), kind, input };
		(kind === "steering" ? this.#steering : this.#followUp).push(queued);
		this.#record({ type: "input.queued", ...queued, queue: this.snapshot() });
		return queued.input_id;
	}

	/** 排一条 steering，返回它的编号。 */
	steer(input: InputContent[]): string {
		return this.#queue("steering", input);
	}

	/** 排一条 follow-up，返回它的编号。 */
	followUp(input: InputContent[]): string {
		return this.#queue("follow_up", input);
	}

	/** 取回排队的输入：给了编号只取那一条，不给取回全部。返回取回的输入，已经不在队列里的不算。 */
	dequeue(inputId?: string): QueuedInput[] {
		const wanted = (queued: QueuedInput) =>
			inputId === undefined || queued.input_id === inputId;
		const inputs = [...this.#steering, ...this.#followUp].filter(wanted);
		if (inputs.length === 0) return [];
		this.#steering = this.#steering.filter((queued) => !wanted(queued));
		this.#followUp = this.#followUp.filter((queued) => !wanted(queued));
		this.#record({
			type: "input.dequeued",
			inputs,
			reason: "returned",
			queue: this.snapshot(),
		});
		return inputs;
	}

	/** 有没有等待插入的 steering。 */
	hasSteering(): boolean {
		return this.#steering.length > 0;
	}

	/** 有没有等待交给模型的通知。 */
	hasNotifications(): boolean {
		return this.#notifications.length > 0;
	}

	/** 用户有了新的输入：唤醒的限制重新算起。 */
	userInput(): void {
		this.#wakeups = 0;
		this.#wakeBlocked = false;
		this.#wakeHeld = false;
	}

	/** 唤醒开始的 task 里有调用被 `forbidden` 规则或 hook 阻止。 */
	blockWakeups(): void {
		this.#wakeBlocked = true;
	}

	/**
	 * 排一条通知，返回它的编号。同一条监视命令还没交给模型的行并进已有的那条通知，返回的是那一条的
	 * 编号。
	 */
	notify(notice: Notice): string {
		const { monitor } = notice;
		const merged =
			monitor === undefined
				? undefined
				: this.#notifications.find(
						(queued) =>
							queued.monitor !== undefined &&
							queued.background_id === notice.background_id,
					);
		if (merged?.monitor === undefined || monitor === undefined) {
			const notification = { notification_id: newId(), ...notice };
			this.#notifications.push(notification);
			return notification.notification_id;
		}
		const lines = [...merged.monitor.lines, ...monitor.lines];
		const extra = Math.max(0, lines.length - maxMonitorLines);
		merged.monitor = {
			lines: lines.slice(extra),
			dropped: merged.monitor.dropped + monitor.dropped + extra,
		};
		merged.wake ||= notice.wake;
		return merged.notification_id;
	}

	/** runtime 在插入时机取走全部 steering 和通知：steering 在前，通知在后。 */
	take(): PendingInput[] {
		const steering = this.#steering;
		const notifications = this.#notifications;
		this.#steering = [];
		this.#notifications = [];
		for (const queued of steering) this.#taken.set(queued.input_id, queued);
		for (const { notification_id } of notifications) {
			this.#takenNotifications.add(notification_id);
		}
		return [
			...steering.map(
				({ input_id, input }): PendingInput => ({
					input_id,
					kind: "steering",
					content: input,
				}),
			),
			...notifications.map(
				(notification): PendingInput => ({
					input_id: notification.notification_id,
					kind: "notification",
					content: render(notification),
				}),
			),
		];
	}

	/**
	 * runtime 报告了插入的位置。编号都要是它刚取走的：不是的话说明 runtime 有缺陷或被攻破，
	 * 返回 false，由调用方按协议错误处理。
	 */
	inserted(data: InputInserted): boolean {
		const known = (id: string) =>
			this.#taken.has(id) || this.#takenNotifications.has(id);
		if (!data.input_ids.every(known)) return false;
		const steering = data.input_ids.filter((id) => this.#taken.delete(id));
		const notifications = data.input_ids.filter((id) =>
			this.#takenNotifications.delete(id),
		);
		if (steering.length > 0) {
			this.#record({
				type: "input.inserted",
				input_ids: steering,
				message_id: data.message_id,
				after_tool_call_id: data.after_tool_call_id,
				queue: this.snapshot(),
			});
		}
		if (notifications.length > 0) {
			this.#record({
				type: "background.delivered",
				notification_ids: notifications,
			});
		}
		return true;
	}

	/**
	 * task 结束：还没插入的 steering 离开队列（前端把它放回输入框，不自动发送）；结果不是
	 * `completed` 时 follow-up 列表暂停，到用户下一次输入之前后台通知也不唤醒 session。
	 * 要在 `task.ended` 之前调用，事件记在这个 task 里。
	 */
	taskEnded(outcome: TaskOutcome): void {
		const inputs = [...this.#taken.values(), ...this.#steering];
		this.#taken.clear();
		this.#takenNotifications.clear();
		this.#steering = [];
		if (inputs.length > 0) {
			this.#record({
				type: "input.dequeued",
				inputs,
				reason: "task_ended",
				queue: this.snapshot(),
			});
		}
		if (outcome === "completed") return;
		this.#wakeHeld = true;
		if (!this.#paused && this.#followUp.length > 0) {
			this.#paused = true;
			this.#record({
				type: "input.follow_up_paused",
				paused: true,
				queue: this.snapshot(),
			});
		}
	}

	/** follow-up 列表是不是暂停着。 */
	get paused(): boolean {
		return this.#paused;
	}

	/** 用户让暂停的 follow-up 列表继续。 */
	resume(): void {
		if (!this.#paused) return;
		this.#paused = false;
		this.#record({
			type: "input.follow_up_paused",
			paused: false,
			queue: this.snapshot(),
		});
	}

	/** session 空闲时取 follow-up 列表的第一条作为新的 task；列表暂停或为空时没有。 */
	nextFollowUp(): QueuedInput | undefined {
		if (this.#paused) return undefined;
		return this.#followUp.shift();
	}

	/** `nextFollowUp` 取出的那一条已经作为新的 task 开始：事件记在新的 task 里。 */
	followUpStarted(queued: QueuedInput): void {
		this.#record({
			type: "input.dequeued",
			inputs: [queued],
			reason: "follow_up_started",
			queue: this.snapshot(),
		});
	}

	/**
	 * session 空闲时要不要为排队的通知开始一个 task：要的话取走全部通知，返回 task 的输入和通知的编号。
	 * 不唤醒的情况：上一个 task 没有以 `completed` 结束；连续的唤醒到了上限；唤醒的 task 里有调用被阻止过；
	 * 排着的通知都来自用户自己的操作。留下的通知等用户下一次开始 task 时交给模型。
	 */
	wake(): { input: UserContent[]; notification_ids: string[] } | undefined {
		if (
			this.#wakeHeld ||
			this.#wakeBlocked ||
			this.#wakeups >= maxConsecutiveWakeups ||
			!this.#notifications.some((notification) => notification.wake)
		) {
			return undefined;
		}
		this.#wakeups += 1;
		const notifications = this.#notifications;
		this.#notifications = [];
		return {
			input: notifications.flatMap(render),
			notification_ids: notifications.map(
				({ notification_id }) => notification_id,
			),
		};
	}

	/** `wake` 取出的通知已经随新的 task 交给模型：事件记在新的 task 里。 */
	delivered(notificationIds: string[]): void {
		this.#record({
			type: "background.delivered",
			notification_ids: notificationIds,
		});
	}
}
