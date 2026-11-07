import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostEvent } from "@ospreycode/agent-host";
import type { ToolCallStatus } from "@ospreycode/agent-runtime";
import type { Scenario, ScenarioRun } from "../runners/scenario.js";

function toolStatuses(run: ScenarioRun): ToolCallStatus[] {
	return run.events.flatMap((event) =>
		event.type === "tool_call.completed" ? [event.result.status] : [],
	);
}

function approvals(
	run: ScenarioRun,
): Extract<HostEvent, { type: "approval.requested" }>[] {
	return run.events.filter(
		(event): event is Extract<HostEvent, { type: "approval.requested" }> =>
			event.type === "approval.requested",
	);
}

function expectOutcome(run: ScenarioRun, outcome: string): string[] {
	return run.outcome === outcome
		? []
		: [`task 的结果是 ${run.outcome}，应当是 ${outcome}`];
}

function fileContent(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

/** 让模型往工作区之外写文件：只能经越界申请做到。 */
function writeOutside(file: string): (dirs: { outside: string }) => string {
	return ({ outside }) =>
		`Write the word osprey into the file ${join(outside, file)}. The directory ${outside} is outside the workspace, so run the shell command with sandbox_permissions set to with_additional_permissions and additional_permissions.file_system.write set to ["${outside}"]. If the request is denied, stop and say so.`;
}

/** 询问的是不是给工作区之外那个目录的写入申请。 */
function asksForOutside(run: ScenarioRun, outside: string): string[] {
	const asked = approvals(run);
	if (asked.length === 0) return ["没有询问用户"];
	const writes = asked.flatMap((event) =>
		event.kind === "tool_call" && event.request.kind === "command"
			? (event.request.additional_permissions?.file_system?.write ?? [])
			: [],
	);
	return writes.some((path) => path.startsWith(outside))
		? []
		: [`询问里申请写入的路径不是 ${outside}：${JSON.stringify(writes)}`];
}

/**
 * P0 的验收场景：用便宜的真实模型跑通完成任务、等待批准、被拒绝和取消；agent 进程在沙盒里运行，
 * 经通道完成模型请求和一次越界申请。需要 macOS 的沙盒后端。
 */
export const p0Scenarios: readonly Scenario[] = [
	{
		name: "完成任务：在沙盒里写工作区里的文件",
		sandboxMode: "workspace-write",
		approvalPolicy: "on-request",
		prompt: () =>
			"Use the shell tool to create a file named result.txt in the workspace whose content is exactly the word osprey.",
		check: (run, { workspace }) => [
			...expectOutcome(run, "completed"),
			...(fileContent(join(workspace, "result.txt")) === "osprey"
				? []
				: ["工作区里没有内容为 osprey 的 result.txt"]),
			...(approvals(run).length === 0 ? [] : ["写工作区不应当询问用户"]),
		],
	},
	{
		name: "等待批准：越界写入经用户批准后在新的沙盒里执行",
		sandboxMode: "workspace-write",
		approvalPolicy: "on-request",
		prompt: writeOutside("approved.txt"),
		answer: () => ({ decision: "approve", scope: "once" }),
		check: (run, { outside }) => [
			...expectOutcome(run, "completed"),
			...asksForOutside(run, outside),
			...(fileContent(join(outside, "approved.txt")) === "osprey"
				? []
				: ["批准之后工作区之外没有内容为 osprey 的 approved.txt"]),
		],
	},
	{
		name: "被拒绝：用户拒绝越界写入，命令不执行",
		sandboxMode: "workspace-write",
		approvalPolicy: "on-request",
		prompt: writeOutside("denied.txt"),
		answer: () => ({
			decision: "deny",
			scope: "once",
			message: "Do not write outside the workspace.",
		}),
		check: (run, { outside }) => [
			...expectOutcome(run, "completed"),
			...asksForOutside(run, outside),
			...(toolStatuses(run).includes("denied") ? [] : ["没有被拒绝的工具调用"]),
			...(existsSync(join(outside, "denied.txt"))
				? ["拒绝之后文件仍被写入"]
				: []),
		],
	},
	{
		name: "被拒绝：审批策略为 never 时越界申请直接拒绝，不询问",
		sandboxMode: "workspace-write",
		approvalPolicy: "never",
		prompt: writeOutside("never.txt"),
		check: (run, { outside }) => [
			...expectOutcome(run, "completed"),
			...(approvals(run).length === 0 ? [] : ["审批策略为 never 时不应当询问"]),
			...(toolStatuses(run).includes("denied") ? [] : ["没有被拒绝的工具调用"]),
			...(existsSync(join(outside, "never.txt")) ? ["文件仍被写入"] : []),
		],
	},
	{
		name: "取消：命令运行中取消，task 以 cancelled 结束",
		sandboxMode: "workspace-write",
		approvalPolicy: "on-request",
		prompt: () =>
			"Run the command `sleep 60` with the shell tool and wait for it to finish.",
		cancelWhen: (event) => event.type === "tool_call.started",
		check: (run) => [
			...expectOutcome(run, "cancelled"),
			...(run.durationMs < 30_000
				? []
				: [`取消后 ${run.durationMs} 毫秒才结束`]),
		],
	},
];
