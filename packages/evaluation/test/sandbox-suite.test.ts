import { join } from "node:path";
import {
	formatSandboxReport,
	type ProbeCall,
	runSandboxCase,
	type SandboxCaseResult,
	type SandboxConditions,
	sandboxCases,
	sandboxReport,
} from "@ospreycode/evaluation";
import { describe, expect, test } from "vitest";

const platform = process.platform;
const supported = platform === "darwin" || platform === "linux";
const options = {
	env: { PATH: process.env.PATH },
	timeoutMs: 60_000,
	platform,
};

function shell(
	label: string,
	command: string,
	check: ProbeCall["check"],
): ProbeCall {
	return { label, tool: "shell", arguments: { command }, check };
}

const base = {
	protection: "out_of_bounds_write",
	platforms: ["darwin", "linux"],
	sandboxMode: "workspace-write",
	approvalPolicy: "never",
} as const;

// 真实沙盒起进程比较慢，机器忙的时候一个用例要十几秒
describe.runIf(supported)("真实沙盒里的用例", { timeout: 120_000 }, () => {
	const here = sandboxCases.filter((testCase) =>
		(testCase.platforms as readonly string[]).includes(platform),
	);

	test("每一项防护在这个平台上都有用例", () => {
		expect(new Set(here.map((testCase) => testCase.protection))).toEqual(
			new Set([
				"out_of_bounds_read",
				"out_of_bounds_write",
				"protected_path",
				"network",
				"credentials",
				"local_services",
				"child_process",
				"residual_process",
				"escalation",
				"developer_operation",
			]),
		);
	});

	test.each(here)("$name", async (testCase) => {
		const result = await runSandboxCase(testCase, options);

		expect(result.probes.filter((probe) => probe.problems.length > 0)).toEqual(
			[],
		);
		expect(result.problems).toEqual([]);
		// 缺少程序（如没装 rustup）的用例跳过，原因写在结果里
		expect(["passed", "skipped"]).toContain(result.status);
		if (result.status === "skipped") expect(result.reason).toBeDefined();
	});

	test("沙盒没拦住的写入记为不通过，并指出是哪一次调用", async () => {
		const result = await runSandboxCase(
			{
				...base,
				name: "预期写错的用例",
				prepare: (dirs) => ({
					calls: [
						shell("写工作区", "echo x > inside.txt", (r) =>
							r.status === "failed" ? [] : ["写工作区应当被拦住"],
						),
						shell(
							"写工作区之外",
							`echo x > '${join(dirs.outside, "escape.txt")}'`,
							(r) => (r.status === "failed" ? [] : ["没有拦住"]),
						),
					],
				}),
			},
			options,
		);

		expect(result.status).toBe("failed");
		expect(
			result.probes.map((probe) => [probe.label, probe.status, probe.problems]),
		).toEqual([
			["写工作区", "succeeded", ["写工作区应当被拦住"]],
			["写工作区之外", "failed", []],
		]);
	});

	test("带对照的调用不启用沙盒时也做不成，就不算沙盒拦住了它", async () => {
		const failed: ProbeCall["check"] = (r) =>
			r.status === "failed" ? [] : ["应当失败"];
		const result = await runSandboxCase(
			{
				...base,
				name: "对照",
				prepare: (dirs) => ({
					calls: [
						{
							...shell(
								"写工作区之外",
								`echo x > '${join(dirs.outside, "escape.txt")}'`,
								failed,
							),
							control: true,
						},
						{
							...shell("读一个不存在的文件", "cat no-such-file", failed),
							control: true,
						},
					],
				}),
			},
			options,
		);

		expect(result.status).toBe("failed");
		expect(result.probes.map((probe) => [probe.label, probe.problems])).toEqual(
			[
				["写工作区之外", []],
				[
					"读一个不存在的文件",
					["对照无效：不启用沙盒时这次调用也没有成功（failed）"],
				],
			],
		);
	});

	test("量额外耗时的用例另在不启用沙盒时运行一遍", async () => {
		const result = await runSandboxCase(
			{
				...base,
				name: "量耗时",
				protection: "developer_operation",
				measureOverhead: true,
				prepare: () => ({
					calls: [
						shell("列目录", "ls", (r) =>
							r.status === "succeeded" ? [] : ["应当成功"],
						),
					],
				}),
			},
			options,
		);

		expect(result.status).toBe("passed");
		expect(result.probes[0]?.baselineMs).toBeTypeOf("number");
		const report = sandboxReport(conditions, [], [result]);
		expect(report.overhead).toEqual([
			{
				name: "量耗时",
				label: "列目录",
				sandboxMs: result.probes[0]?.durationMs,
				baselineMs: result.probes[0]?.baselineMs,
			},
		]);
	});
});

const conditions: SandboxConditions = {
	platform,
	arch: process.arch,
	kernel: "test",
	osVersion: "test",
	nodeVersion: process.versions.node,
	version: "0.1.0",
	commit: "0000000",
};

test("只在别的平台上运行的用例跳过并写明原因", async () => {
	const other = platform === "darwin" ? "linux" : "darwin";
	const result = await runSandboxCase(
		{
			...base,
			name: "别的平台的用例",
			platforms: [other],
			prepare: () => {
				throw new Error("不该准备");
			},
		},
		options,
	);

	expect(result).toEqual({
		name: "别的平台的用例",
		protection: "out_of_bounds_write",
		status: "skipped",
		reason: `只在 ${other} 上运行`,
		probes: [],
		problems: [],
	});
});

test("缺少用例需要的程序时跳过", async () => {
	const result = await runSandboxCase(
		{
			...base,
			name: "要一个没有的程序",
			requires: ["osprey-eval-no-such-program"],
			prepare: () => {
				throw new Error("不该准备");
			},
		},
		options,
	);

	expect(result.status).toBe("skipped");
	expect(result.reason).toContain("osprey-eval-no-such-program");
});

test("报告按防护汇总，跳过和后端不支持的分开计数", () => {
	const result = (
		name: string,
		protection: SandboxCaseResult["protection"],
		status: SandboxCaseResult["status"],
		reason?: string,
	): SandboxCaseResult => ({
		name,
		protection,
		status,
		...(reason === undefined ? {} : { reason }),
		probes: [],
		problems: status === "failed" ? ["留下了进程"] : [],
	});
	const report = sandboxReport(
		{ ...conditions, imageVersion: "20261101.1.0" },
		[],
		[
			result("甲", "network", "passed"),
			result("乙", "network", "skipped", "只在 linux 上运行"),
			result("丙", "residual_process", "failed"),
			result("丁", "credentials", "unsupported", "没有可用的沙盒后端"),
		],
	);

	expect(report.passed).toBe(false);
	expect(report.protections).toEqual({
		network: { passed: 1, failed: 0, skipped: 1, unsupported: 0 },
		residual_process: { passed: 0, failed: 1, skipped: 0, unsupported: 0 },
		credentials: { passed: 0, failed: 0, skipped: 0, unsupported: 1 },
	});
	const text = formatSandboxReport(report);
	expect(text).toContain("runner 镜像版本：20261101.1.0");
	expect(text).toContain("- 未批准的网络访问：通过 1，跳过 1");
	expect(text).toContain("跳过 乙（只在 linux 上运行）");
	expect(text).toContain("不通过 丙\n  - 留下了进程");
	expect(text).toContain("后端不支持 丁（没有可用的沙盒后端）");
	expect(
		sandboxReport(conditions, [], [result("甲", "network", "passed")]).passed,
	).toBe(true);
});
