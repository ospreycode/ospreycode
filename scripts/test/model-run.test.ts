import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { modelServices } from "../model-keys.ts";

/** vitest 的 JSON 报告里用到的部分。 */
interface Report {
	testResults: {
		assertionResults: {
			title: string;
			status: string;
			failureMessages: string[];
		}[];
	}[];
}

const repo = fileURLToPath(new URL("../..", import.meta.url));
const vitest = join(
	dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
	"vitest.mjs",
);

let base: string;
let state: string;
let exitCode: number | null;
let stdout: string;
let results: Map<string, { status: string; failure: string }>;

/** 用例运行了几次。 */
function attempts(name: string): number {
	return readFileSync(join(state, name), "utf8").length;
}

function result(title: string): { status: string; failure: string } {
	const found = results.get(title);
	if (found === undefined) throw new Error(`报告里没有用例 ${title}`);
	return found;
}

// 用仓库的测试配置跑一遍 fixtures/model-run 里的用例，下面的测试各看结果的一部分
beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "ospreycode-model-run-"));
	const keys = join(base, "keys");
	state = join(base, "state");
	mkdirSync(keys, { mode: 0o700 });
	mkdirSync(state);
	for (const service of modelServices) {
		writeFileSync(join(keys, service), "test-key", { mode: 0o600 });
	}
	writeFileSync(join(keys, "base-url"), "https://relay.example.com/v1\n");
	const run = spawnSync(
		process.execPath,
		[
			vitest,
			"run",
			"--config",
			"scripts/test/fixtures/model-run/vitest.config.ts",
			"--tags-filter=model",
		],
		{
			cwd: repo,
			env: {
				PATH: process.env.PATH,
				HOME: base,
				OSPREYCODE_TEST_KEYS: keys,
				MODEL_RUN_STATE: state,
			},
			encoding: "utf8",
		},
	);
	exitCode = run.status;
	stdout = run.stdout;
	const report = JSON.parse(
		readFileSync(join(state, "report.json"), "utf8"),
	) as Report;
	results = new Map(
		report.testResults.flatMap((file) =>
			file.assertionResults.map((test) => [
				test.title,
				{ status: test.status, failure: test.failureMessages.join("\n") },
			]),
		),
	);
}, 120_000);

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

test("有用例失败时整次运行失败", () => {
	expect(exitCode).toBe(1);
});

test("模型服务的临时故障只重跑一次，断言失败不重跑", () => {
	expect(attempts("overloaded-once")).toBe(2);
	expect(result("第一次遇到服务过载").status).toBe("passed");
	expect(attempts("network-once")).toBe(2);
	expect(result("task 第一次因为网络中断失败").status).toBe("passed");
	expect(attempts("rate-limited")).toBe(2);
	expect(result("一直限流").status).toBe("failed");
	expect(attempts("invalid-request")).toBe(1);
	expect(result("请求格式错误").status).toBe("failed");
});

test("运行结束时列出重跑之后才通过的测试，不列一直失败的", () => {
	const listed = stdout
		.slice(stdout.indexOf("重跑之后才通过的测试"))
		.split("\n")
		.filter((line) => line.startsWith("  "));
	expect(listed).toEqual([
		"  scripts/test/fixtures/model-run/cases.ts > 第一次遇到服务过载",
		"  scripts/test/fixtures/model-run/cases.ts > task 第一次因为网络中断失败",
	]);
});

test("用了 token 却没有费用的用量记不进账本", () => {
	expect(result("用了 token 却没有费用")).toMatchObject({
		status: "failed",
		failure: expect.stringContaining("没有费用"),
	});
});

test("账本超过每次运行的上限后，其余模型测试失败；结束时报告合计", () => {
	expect(result("花掉超过上限的费用").status).toBe("passed");
	expect(result("账本超过上限之后的测试")).toMatchObject({
		status: "failed",
		failure: expect.stringContaining("超过上限 1 美元"),
	});
	expect(existsSync(join(state, "after-limit"))).toBe(false);
	expect(stdout).toContain("模型测试这次一共花了 1.5000 美元");
});
