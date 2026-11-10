import type { Protection, SandboxCaseResult } from "../runners/sandbox.js";
import type { DecisionResult } from "../runners/sandbox-decisions.js";

/** sandbox 专项评测的实验条件，由运行评测的入口收集后传入。 */
export interface SandboxConditions {
	/** 操作系统：`darwin` 或 `linux`。 */
	platform: string;
	arch: string;
	/** 内核版本（`os.release()`）。 */
	kernel: string;
	/** 操作系统的版本说明（`os.version()`）。 */
	osVersion: string;
	nodeVersion: string;
	/** 被测各包的版本：所有包用同一个版本号，`sandbox` 包也是它。 */
	version: string;
	/** 被测的 commit；工作区有未提交的改动时注明。 */
	commit: string;
	/** GitHub 托管 runner 的镜像版本（环境变量 `ImageVersion`）；不在 runner 上时为空。 */
	imageVersion?: string;
}

/** 权限判断和预期不一致的三种情况。 */
export interface DecisionMismatches {
	/** 多问：该直接执行的被询问或拒绝了。 */
	overAsked: DecisionResult[];
	/** 漏问：该询问或拒绝的直接执行了。 */
	underAsked: DecisionResult[];
	/** 其余的不一致：询问和拒绝之间判错了。 */
	other: DecisionResult[];
}

/** 一次调用在沙盒内外的耗时。 */
export interface OverheadEntry {
	name: string;
	label: string;
	sandboxMs: number;
	baselineMs: number;
}

/** sandbox 专项评测的报告。 */
export interface SandboxReport {
	conditions: SandboxConditions;
	decisions: DecisionMismatches & {
		total: number;
		/** 每组的项数和不一致的项数。 */
		groups: Record<string, { total: number; mismatched: number }>;
	};
	cases: SandboxCaseResult[];
	/** 每一项防护下各种结果的用例数。 */
	protections: Partial<
		Record<Protection, Record<SandboxCaseResult["status"], number>>
	>;
	overhead: OverheadEntry[];
	/** 没有不一致的判断，也没有不通过或后端不支持的用例。 */
	passed: boolean;
}

/** 汇总权限判断和真实沙盒用例的结果。 */
export function sandboxReport(
	conditions: SandboxConditions,
	decisions: readonly DecisionResult[],
	cases: readonly SandboxCaseResult[],
): SandboxReport {
	const mismatched = decisions.filter(
		(result) => result.actual !== result.expected,
	);
	const overAsked = mismatched.filter((result) => result.expected === "allow");
	const underAsked = mismatched.filter((result) => result.actual === "allow");
	const other = mismatched.filter(
		(result) => result.expected !== "allow" && result.actual !== "allow",
	);
	const groups: SandboxReport["decisions"]["groups"] = {};
	for (const result of decisions) {
		const group = groups[result.group] ?? { total: 0, mismatched: 0 };
		group.total += 1;
		if (result.actual !== result.expected) group.mismatched += 1;
		groups[result.group] = group;
	}
	const protections: SandboxReport["protections"] = {};
	for (const result of cases) {
		const counts = protections[result.protection] ?? {
			passed: 0,
			failed: 0,
			skipped: 0,
			unsupported: 0,
		};
		counts[result.status] += 1;
		protections[result.protection] = counts;
	}
	const overhead = cases.flatMap((result) =>
		result.probes.flatMap((probe) =>
			probe.baselineMs === undefined
				? []
				: [
						{
							name: result.name,
							label: probe.label,
							sandboxMs: probe.durationMs,
							baselineMs: probe.baselineMs,
						},
					],
		),
	);
	return {
		conditions,
		decisions: {
			total: decisions.length,
			overAsked,
			underAsked,
			other,
			groups,
		},
		cases: [...cases],
		protections,
		overhead,
		passed:
			mismatched.length === 0 &&
			cases.every(
				(result) => result.status === "passed" || result.status === "skipped",
			),
	};
}

const protectionNames: Record<Protection, string> = {
	out_of_bounds_read: "越界读取",
	out_of_bounds_write: "越界写入",
	protected_path: "受保护的路径",
	network: "未批准的网络访问",
	credentials: "读取凭据",
	local_services: "Unix socket 和本机端口",
	child_process: "子进程",
	residual_process: "session 结束后的残留进程",
	escalation: "越界申请",
	developer_operation: "正常的开发操作",
};

const statusNames: Record<SandboxCaseResult["status"], string> = {
	passed: "通过",
	failed: "不通过",
	skipped: "跳过",
	unsupported: "后端不支持",
};

function mismatchLines(title: string, results: DecisionResult[]): string[] {
	return [
		`${title}：${results.length} 项`,
		...results.map(
			(result) =>
				`  - ${result.name}：预期 ${result.expected}，实际 ${result.actual}${result.detail.length === 0 ? "" : `（${result.detail.join("；")}）`}`,
		),
	];
}

/** 把报告写成给人看的文本：实验条件、权限判断的多问和漏问、每个用例的结果、沙盒内外的耗时。 */
export function formatSandboxReport(report: SandboxReport): string {
	const { conditions, decisions } = report;
	const lines = [
		`sandbox 专项评测：${report.passed ? "通过" : "不通过"}`,
		"",
		"实验条件",
		`- 操作系统：${conditions.platform}（${conditions.arch}），内核 ${conditions.kernel}，${conditions.osVersion}`,
		`- runner 镜像版本：${conditions.imageVersion ?? "不在 GitHub 托管的 runner 上"}`,
		`- Node ${conditions.nodeVersion}，sandbox 包 ${conditions.version}，commit ${conditions.commit}`,
		"- 不需要模型：工具调用是固定的输入，由脚本模型依次发出",
		"",
		`权限判断：${decisions.total} 项固定输入`,
		...Object.entries(decisions.groups).map(
			([group, { total, mismatched }]) =>
				`- ${group}：${total} 项，${mismatched} 项和预期不一致`,
		),
		...mismatchLines("多问（该直接执行的被询问或拒绝）", decisions.overAsked),
		...mismatchLines("漏问（该询问或拒绝的直接执行了）", decisions.underAsked),
		...mismatchLines("询问和拒绝之间判错", decisions.other),
		"",
		"真实沙盒里的用例",
		...Object.entries(report.protections).map(
			([protection, counts]) =>
				`- ${protectionNames[protection as Protection]}：${Object.entries(
					counts,
				)
					.filter(([, count]) => count > 0)
					.map(
						([status, count]) =>
							`${statusNames[status as SandboxCaseResult["status"]]} ${count}`,
					)
					.join("，")}`,
		),
		"",
	];
	for (const result of report.cases) {
		lines.push(
			`${statusNames[result.status]} ${result.name}${result.reason === undefined ? "" : `（${result.reason}）`}`,
		);
		for (const probe of result.probes) {
			if (probe.problems.length === 0) continue;
			lines.push(`  - ${probe.label}：${probe.problems.join("；")}`);
		}
		for (const problem of result.problems) lines.push(`  - ${problem}`);
	}
	if (report.overhead.length > 0) {
		const sandbox = report.overhead.reduce((sum, e) => sum + e.sandboxMs, 0);
		const baseline = report.overhead.reduce((sum, e) => sum + e.baselineMs, 0);
		lines.push(
			"",
			`沙盒内外的耗时（毫秒，各运行一次）：沙盒内合计 ${sandbox}，不启用沙盒合计 ${baseline}`,
			...report.overhead.map(
				(entry) =>
					`- ${entry.name} / ${entry.label}：沙盒内 ${entry.sandboxMs}，不启用沙盒 ${entry.baselineMs}`,
			),
		);
	}
	return lines.join("\n");
}
