import { isAbsolute } from "node:path";
import {
	filesystemRules,
	type SandboxPolicy,
	startSandboxHelper,
	withAdditionalPermissions,
	writableRoots,
} from "@ospreycode/sandbox/backends";
import type { CommandLauncher, EditLauncher } from "../actions/tool-calls.js";
import type { ProcessTracker } from "./registry.js";

/**
 * 一个 session 的沙盒：agent 进程的启动命令、命令沙盒和 apply-edits 的启动方式，session 结束时
 * 停掉辅助进程。没有沙盒时没有可写范围之外的文件，也就没有 `edits`。
 */
export interface SessionSandbox {
	agentArgv: readonly string[];
	commands: CommandLauncher;
	edits?: EditLauncher;
	stop(): Promise<void>;
}

function shellQuote(words: readonly string[]): string {
	return words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

/** P0 的沙盒后端还做不到的越界申请，返回交给模型的原因。 */
function unsupported(
	request: Parameters<CommandLauncher["unsupported"]>[0],
): string | undefined {
	if (request.sandbox_permissions === "require_escalated") {
		return "This sandbox cannot lift its file restrictions for a command yet. Ask for the specific paths with `sandbox_permissions: with_additional_permissions` and `additional_permissions.file_system` instead.";
	}
	const permissions = request.additional_permissions ?? {};
	if (
		permissions.unix_sockets !== undefined ||
		permissions.local_binding === true
	) {
		return "This sandbox cannot grant `unix_sockets` or `local_binding` yet. Only `additional_permissions.file_system` is supported.";
	}
	const paths = [
		...(permissions.file_system?.read ?? []),
		...(permissions.file_system?.write ?? []),
	];
	const relative = paths.find((path) => !isAbsolute(path));
	if (relative !== undefined) {
		return `Paths in additional_permissions must be absolute: ${relative}`;
	}
	return undefined;
}

/** `danger-full-access` 下没有沙盒：agent 进程和命令由 Host 直接启动。 */
export function unsandboxedSession(
	agentCommand: readonly string[],
	bash: string,
): SessionSandbox {
	return {
		agentArgv: agentCommand,
		commands: {
			unsupported: () => undefined,
			argv: async (request) => [bash, "-c", request.command],
			summary: () => ({
				mode: "danger-full-access",
				writable_roots: ["/"],
				network: "unrestricted",
			}),
		},
		stop: async () => {},
	};
}

/** 启动沙盒的方式。 */
export interface SandboxedSessionOptions {
	/** 辅助进程的入口文件。 */
	helperEntry: string;
	policy: SandboxPolicy;
	env: Record<string, string>;
	bash: string;
	/** agent 进程的完整命令：Node 加入口文件。 */
	agentCommand: readonly string[];
	/** apply-edits 的完整命令：Node 加入口文件。 */
	applyEditsCommand: readonly string[];
	/** 辅助进程记进进程登记表。 */
	tracker: ProcessTracker;
}

/**
 * 为 session 启动两个辅助进程：离线的为 agent 进程和 apply-edits 生成启动命令，不能联网；命令的
 * 为每条 shell 命令单独生成命令沙盒，批准的越界申请只加在这一条命令的沙盒上。
 */
export async function sandboxedSession(
	options: SandboxedSessionOptions,
): Promise<SessionSandbox> {
	const { policy, bash, tracker } = options;
	const start = async () => {
		const helper = await startSandboxHelper({
			entry: options.helperEntry,
			policy,
			env: options.env,
		});
		try {
			await tracker.add(helper.pid, "helper");
		} catch (error) {
			await helper.stop();
			throw error;
		}
		return helper;
	};
	const started = await Promise.allSettled([start(), start()]);
	const helpers = started.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);
	const stop = async () => {
		await Promise.all(
			helpers.map(async (helper) => {
				await helper.stop();
				await tracker.remove(helper.pid);
			}),
		);
	};
	const [offline, commands] = helpers;
	if (offline === undefined || commands === undefined) {
		await stop();
		const failure = started.find((result) => result.status === "rejected");
		throw (failure as PromiseRejectedResult).reason;
	}
	try {
		return {
			agentArgv: await offline.wrap(shellQuote(options.agentCommand), bash),
			commands: {
				unsupported,
				argv: (request) =>
					commands.wrap(
						request.command,
						bash,
						request.sandbox_permissions === "with_additional_permissions"
							? withAdditionalPermissions(
									policy,
									request.additional_permissions ?? {},
								)
							: undefined,
					),
				summary: (request) => ({
					mode: policy.mode,
					writable_roots: [
						...writableRoots(policy),
						...(request.sandbox_permissions === "with_additional_permissions"
							? (request.additional_permissions?.file_system?.write ?? [])
							: []),
					],
					network: "denied",
				}),
			},
			// 写权限只给这次批准的文件，工作区也不给
			edits: (paths) =>
				offline.wrap(shellQuote(options.applyEditsCommand), bash, {
					allowRead: filesystemRules(policy).allowRead,
					allowWrite: [...paths],
				}),
			stop,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}
