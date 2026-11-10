import {
	type DecisionCase,
	formatSandboxReport,
	runDecisionCases,
	type SandboxConditions,
	sandboxDecisionCases,
	sandboxReport,
} from "@ospreycode/evaluation";
import { expect, test } from "vitest";

const conditions: SandboxConditions = {
	platform: "darwin",
	arch: "arm64",
	kernel: "25.6.0",
	osVersion: "Darwin Kernel Version 25.6.0",
	nodeVersion: "26.13.0",
	version: "0.1.0",
	commit: "0000000",
};

test("固定命令集和各种权限组合的判断都和设计一致", async () => {
	const results = await runDecisionCases(sandboxDecisionCases);

	expect(results).toHaveLength(sandboxDecisionCases.length);
	expect(results.filter((result) => result.actual !== result.expected)).toEqual(
		[],
	);
	// 每一组都有内容：分组写错时这里能看出来
	expect(new Set(results.map((result) => result.group))).toEqual(
		new Set([
			"development",
			"dangerous_command",
			"builtin_forbidden",
			"command_rules",
			"escalation",
			"matrix",
		]),
	);
});

test("和预期不一致的判断按多问和漏问分开报告", async () => {
	const base = {
		group: "development",
		sandboxMode: "workspace-write",
		approvalPolicy: "on-request",
	} as const;
	const command =
		(text: string): DecisionCase["request"] =>
		() => ({ kind: "command", command: text });
	const cases: DecisionCase[] = [
		{ ...base, name: "一致", request: command("ls"), expected: "allow" },
		{
			...base,
			name: "把强制删除当成直接执行",
			request: command("rm -rf build"),
			expected: "allow",
		},
		{
			...base,
			name: "把列目录当成要询问",
			request: command("ls"),
			expected: "ask",
		},
		{
			...base,
			name: "把提权当成询问",
			request: command("sudo ls"),
			expected: "ask",
		},
	];

	const results = await runDecisionCases(cases);
	const report = sandboxReport(conditions, results, []);

	expect(results.map((result) => result.actual)).toEqual([
		"allow",
		"ask",
		"allow",
		"forbidden",
	]);
	expect(report.passed).toBe(false);
	expect(report.decisions.overAsked.map((result) => result.name)).toEqual([
		"把强制删除当成直接执行",
	]);
	expect(report.decisions.underAsked.map((result) => result.name)).toEqual([
		"把列目录当成要询问",
	]);
	expect(report.decisions.other.map((result) => result.name)).toEqual([
		"把提权当成询问",
	]);
	expect(report.decisions.groups).toEqual({
		development: { total: 4, mismatched: 3 },
	});
	const text = formatSandboxReport(report);
	expect(text).toContain("多问（该直接执行的被询问或拒绝）：1 项");
	expect(text).toContain("把强制删除当成直接执行：预期 allow，实际 ask");
	expect(text).toContain("漏问（该询问或拒绝的直接执行了）：1 项");
});
