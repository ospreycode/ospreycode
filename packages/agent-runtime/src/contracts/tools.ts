import type { ToolDeclaration, UserContent } from "@ospreycode/api/protocol";

/** 谁执行工具：runtime 在 agent 沙盒里执行，或者经 `tool_call/run` 交给 Host 执行。 */
export type ToolExecutor = "runtime" | "host";

/**
 * runtime 一侧的工具声明。除了交给模型的部分，还写明并发、重试和恢复依据的三项；
 * MCP 工具的这三项由 Host 决定，不采信 server 的标注。
 */
export interface ToolSpec {
	declaration: ToolDeclaration;
	/** 只读：同一轮里只读的调用可以同时执行。 */
	read_only: boolean;
	/** 能安全地重复执行：恢复时可以直接重新执行，不询问用户。 */
	idempotent: boolean;
	/** 能和其他调用同时执行。 */
	concurrent: boolean;
	executor: ToolExecutor;
}

/** 拒绝的来源：审批策略、用户、hook、`forbidden` 规则。 */
export type DenialReason = "policy" | "user" | "hook" | "forbidden_rule";

/**
 * 被审批策略拒绝的调用要询问的类别：审批策略 `granular` 的类别，其中内置的危险命令判断从
 * `sandbox_approval` 里单独分出来记作 `dangerous_command`，`sandbox_approval` 在这里只表示
 * 越界申请。评测报告按它分别统计被拒的原因。
 */
export type DenialCategory =
	| "dangerous_command"
	| "sandbox_approval"
	| "rules"
	| "request_permissions"
	| "skill_approval"
	| "mcp_elicitations"
	| "mcp_tools"
	| "network";

/** 命令沙盒的网络：不能联网、经 Host 的代理按域名放行、不受限制（`danger-full-access`）。 */
export type SandboxNetwork = "denied" | "proxy" | "unrestricted";

/** 命令在哪个沙盒里运行，模型据此区分"被沙盒拦下"和普通的失败。 */
export interface SandboxSummary {
	mode: string;
	writable_roots: string[];
	network: SandboxNetwork;
}

/** shell 命令的结构化结果。 */
export interface ShellOutcome {
	/** 被信号结束时为空。 */
	exit_code: number | null;
	signal: string | null;
	/** Host 保存完整输出的文件，模型用读文件工具续读。 */
	output_path: string;
	/** 完整输出的字节数。 */
	output_bytes: number;
	sandbox: SandboxSummary;
}

/**
 * 一次工具调用的结果。`content` 是交给模型的内容，其余字段供 Host、评测和界面使用。
 *
 * - `running`：命令在后台运行（模型要求的，或前台命令超时后转入的），`background_id` 是后台命令编号
 * - `interrupted`：结果不确定，例如异常退出时核对不上的文件工具、恢复时选择跳过的调用
 */
export type ToolResult =
	| { status: "succeeded"; content: UserContent[]; shell?: ShellOutcome }
	| {
			status: "failed";
			content: UserContent[];
			/** 不是工具本身报告的失败时写明原因，如沙盒启动失败的 `sandbox_launch`。 */
			reason?: string;
			shell?: ShellOutcome;
	  }
	| { status: "running"; content: UserContent[]; background_id: string }
	| { status: "timed_out"; content: UserContent[]; shell?: ShellOutcome }
	| { status: "cancelled"; content: UserContent[] }
	| { status: "interrupted"; content: UserContent[] }
	| {
			status: "denied";
			content: UserContent[];
			reason: "policy";
			/** 这次调用要询问的全部类别；审批策略不询问其中至少一类。 */
			categories: DenialCategory[];
			message?: string;
	  }
	| {
			status: "denied";
			content: UserContent[];
			reason: Exclude<DenialReason, "policy">;
			/** 用户在批准对话框里写给模型的话，或 hook 给出的理由。 */
			message?: string;
	  };

/** 工具调用结果的状态。 */
export type ToolCallStatus = ToolResult["status"];
