import { arch, version as osVersion, release } from "node:os";
import { version } from "@ospreycode/agent-host";
import {
	type SandboxConditions,
	type SandboxReport,
	sandboxReport,
} from "../../reports/sandbox.js";
import {
	runSandboxCase,
	type SandboxCase,
	type SandboxCaseResult,
	type SandboxRunOptions,
} from "../../runners/sandbox.js";
import { runDecisionCases } from "../../runners/sandbox-decisions.js";
import { commandCases, type DecisionCase, matrixCases } from "./decisions.js";
import { developerCases } from "./developer.js";
import { probeCases } from "./probes.js";
import { profileCases } from "./profiles.js";

/** 权限判断的固定输入：固定命令集，加上沙盒模式和审批策略的各种组合。 */
export const sandboxDecisionCases: DecisionCase[] = [
	...commandCases,
	...matrixCases,
];

/**
 * 在真实沙盒里运行的用例：逃逸探测、命名权限配置和正常的开发操作。
 * 只在某个平台上运行的由 `platforms` 标明。
 */
export const sandboxCases: SandboxCase[] = [
	...probeCases,
	...profileCases,
	...developerCases,
];

/** 运行整套 sandbox 专项评测要给出的内容。 */
export interface SandboxEvaluationOptions extends SandboxRunOptions {
	/** 被测的 commit，写进报告。 */
	commit: string;
	/** GitHub 托管 runner 的镜像版本（runner 的环境变量 `ImageVersion`）。 */
	imageVersion?: string;
}

/**
 * 运行整套 sandbox 专项评测，返回报告。不需要模型和网络。
 *
 * 用例一个接一个地运行：并行会让沙盒内外的耗时互相影响。
 */
export async function runSandboxEvaluation(
	options: SandboxEvaluationOptions,
): Promise<SandboxReport> {
	const decisions = await runDecisionCases(sandboxDecisionCases);
	const cases: SandboxCaseResult[] = [];
	for (const testCase of sandboxCases) {
		cases.push(await runSandboxCase(testCase, options));
	}
	const conditions: SandboxConditions = {
		platform: options.platform,
		arch: arch(),
		kernel: release(),
		osVersion: osVersion(),
		nodeVersion: process.versions.node,
		version,
		commit: options.commit,
		...(options.imageVersion === undefined
			? {}
			: { imageVersion: options.imageVersion }),
	};
	return sandboxReport(conditions, decisions, cases);
}
