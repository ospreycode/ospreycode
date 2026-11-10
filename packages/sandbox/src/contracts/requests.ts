import type { GranularCategory } from "./modes.js";

/** 命令要不要越出当前的沙盒，照 Codex 的 shell 参数。 */
export type SandboxPermissions =
	| "use_default"
	| "with_additional_permissions"
	| "require_escalated";

/** 只为一条命令加上的权限；路径都是绝对路径。 */
export interface AdditionalPermissions {
	file_system?: { read?: string[]; write?: string[] };
	/** socket 文件的路径，或符号 `ssh-agent`（Host 换成自己环境里的 `SSH_AUTH_SOCK`）。 */
	unix_sockets?: string[];
	/** 允许监听端口和连接本机端口。 */
	local_binding?: boolean;
}

/** shell 命令。 */
export interface CommandRequest {
	kind: "command";
	/** 按 bash 语法执行的完整命令。 */
	command: string;
	/** 工作目录的真实路径，在工作区之内。 */
	workdir: string;
	sandbox_permissions: SandboxPermissions;
	/** `with_additional_permissions` 时申请的权限。 */
	additional_permissions?: AdditionalPermissions;
	/** 模型写给用户的一句话，只作参考。 */
	justification?: string;
	/** 模型建议保存的规则前缀，用户确认后才保存。 */
	prefix_rule?: string[];
}

/** 一个文件的改动：`add` 新建文件，要求它不存在；`update` 改已有的文件。 */
export interface FileEdit {
	op: "add" | "update";
	/** 规范化的绝对路径：各级都不能是符号链接。 */
	path: string;
	/** 改动前内容的 SHA-256；`add` 为空。 */
	old_sha256: string | null;
	/** 完整的新内容。 */
	content: string;
}

/** 写到可写范围之外的文件改动，批准后由 apply-edits 执行。同一路径在一次申请里只出现一次。 */
export interface FileEditsRequest {
	kind: "file_edits";
	edits: FileEdit[];
}

/** `request_permissions` 工具：本任务内之后多条命令共用的权限，用户可以只批准其中一部分。 */
export interface PermissionsRequest {
	kind: "permissions";
	file_system?: { read?: string[]; write?: string[] };
	/** 要放行的域名。 */
	network?: string[];
	justification?: string;
}

/**
 * 命令访问了还没放行的域名，由代理挂起连接后交给 Permission。没有协议：sandbox-runtime 的询问
 * 回调只给出主机和端口。
 */
export interface NetworkRequest {
	kind: "network";
	/** 规范化后的主机：小写的 A-label，IPv6 地址写在方括号里。 */
	host: string;
	port: number;
}

/** MCP 工具调用：按越界处理，默认每次询问。 */
export interface McpToolRequest {
	kind: "mcp_tool";
	/** Host 分配的 server 标签。 */
	server: string;
	tool: string;
	/** 模型写出的参数原文。 */
	arguments: string;
}

/**
 * 向运行中的后台命令的 stdin 写入。只有要重新批准时才成为一次申请：这条命令是越界或带额外权限
 * 启动的，或者启动它的 task 已经结束。
 */
export interface StdinRequest {
	kind: "stdin";
	/** Host 分配的后台命令编号。 */
	background_id: string;
	/** 这条后台命令的命令行。 */
	command: string;
	/** 要写入的内容。 */
	input: string;
}

/** 交给 Permission 判断的一个动作。 */
export type PermissionRequest =
	| CommandRequest
	| FileEditsRequest
	| PermissionsRequest
	| NetworkRequest
	| McpToolRequest
	| StdinRequest;

/**
 * 一次询问的类别：`granular` 的类别，其中内置的危险命令判断从 `sandbox_approval` 里单独分出来
 * 记作 `dangerous_command`，`sandbox_approval` 在这里只表示越界申请。问不问仍然按 `granular`
 * 的类别决定；分开是为了让被拒绝的结果和评测报告能把这两种原因分别统计。
 */
export type AskCategory = GranularCategory | "dangerous_command";

/**
 * Permission 的判断：
 *
 * - `allow`：按申请的权限执行，没有申请越界时就是当前策略的命令沙盒
 * - `ask`：询问用户，`category` 是 `granular` 下决定问不问的类别，`categories` 列出这次询问
 *   涉及的全部类别，`reasons` 列出要问的原因（命中的 `prompt` 规则的理由、危险命令判断、
 *   越界申请等）
 * - `deny`：不执行，`message` 告诉模型原因和替代做法。`reason` 是 `policy` 时是要询问的动作被
 *   拒绝了（审批策略不询问，或者这类动作固定拒绝），`categories` 同 `ask`
 */
export type PermissionDecision =
	| { action: "allow" }
	| {
			action: "ask";
			category: GranularCategory;
			categories: AskCategory[];
			reasons: string[];
	  }
	| {
			action: "deny";
			reason: "policy";
			categories: AskCategory[];
			message: string;
	  }
	| { action: "deny"; reason: "forbidden_rule"; message: string };

/** 批准的权限：`request_permissions` 申请的权限里的一部分。 */
export interface GrantedPermissions {
	file_system?: { read?: string[]; write?: string[] };
	network?: string[];
}

/**
 * 用户对一次询问的回答。批准的范围：只这一次、本任务内同一资源上的同类动作、保存为规则；
 * 拒绝可以只这一次，或者保存为禁止的规则，`message` 是用户写给模型的话。
 */
export type ApprovalAnswer =
	| {
			decision: "approve";
			scope: "once" | "task" | "rule";
			/** 回答 `request_permissions` 的询问时只批准其中的这一部分；不写时批准申请的全部。 */
			granted?: GrantedPermissions;
	  }
	| { decision: "deny"; scope: "once" | "rule"; message?: string };
