import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelEntry } from "@ospreycode/api";
import { scriptedModel } from "@ospreycode/api/testing";
import { runScenario, type Scenario } from "@ospreycode/evaluation";
import { afterEach, beforeEach, expect, test } from "vitest";

/** 脚本模型用的清单条目，地址不会被访问。 */
const model: ModelEntry = {
	id: "scripted",
	protocol: "anthropic.messages",
	service: "test",
	base_url: "https://scripted.invalid/v1",
	model: "scripted",
	context_window: 200_000,
	max_output_tokens: 8_000,
};

let secrets: string;

beforeEach(() => {
	secrets = mkdtempSync("/tmp/osp-eval-test-");
	writeFileSync(join(secrets, "test"), "test-key\n", { mode: 0o600 });
});

afterEach(() => {
	rmSync(secrets, { recursive: true, force: true });
});

test("超出显式给出的上限时不追加额度，即使场景批准其他询问", async () => {
	let calls = 0;
	const scenario: Scenario = {
		name: "模型不停地调用工具",
		sandboxMode: "danger-full-access",
		approvalPolicy: "on-request",
		prompt: () => "loop",
		answer: () => ({ decision: "approve", scope: "once" }),
		check: () => [],
	};
	const result = await runScenario(
		scenario,
		{
			model,
			reasoningEffort: "off",
			credential: { file: join(secrets, "test") },
			budget: { maxCostUsd: null, maxRequests: 2, maxDurationMs: null },
			denyRead: [],
			env: { PATH: process.env.PATH },
			streamModel: scriptedModel(() => {
				calls += 1;
				return {
					content: [
						{
							type: "tool_call",
							call_id: `call_${calls}`,
							name: "shell",
							arguments: JSON.stringify({ command: "true" }),
						},
					],
				};
			}),
		},
		{ timeoutMs: 30_000 },
	);

	expect(result.outcome).toBe("budget_exceeded");
	expect(calls).toBe(2);
	expect(
		result.events.flatMap((event) =>
			event.type === "task.ended" ? [event.limit] : [],
		),
	).toEqual(["requests"]);
	expect(
		result.events.flatMap((event) =>
			event.type === "approval.decided" ? [event.decision] : [],
		),
	).toEqual(["denied"]);
});
