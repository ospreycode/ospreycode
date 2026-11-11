import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentConfig,
	openHostChannel,
	ReceivedImages,
	type RecordedInstructions,
	toolRegistry,
} from "@ospreycode/agent-runtime";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openRuntimeChannel } from "../src/channel/open.js";
import { loadRuleFiles } from "../src/instructions/rule-files.js";
import { AgentLoop } from "../src/loop/agent-loop.js";
import { ToolExecutor } from "../src/tool-executor/executor.js";
import { FileRecords } from "../src/tool-executor/file-records.js";
import {
	type FakeHost,
	startFakeHost,
	type Turn,
	text,
	textOf,
} from "./fake-host.js";
import { socketPair } from "./socket-pair.js";

let base: string;
let workspace: string;
let host: FakeHost | undefined;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "osp-rules-")));
	workspace = join(base, "repo", "packages", "app");
	mkdirSync(workspace, { recursive: true });
});

afterEach(async () => {
	await host?.close();
	host = undefined;
	rmSync(base, { recursive: true, force: true });
});

const done: Turn = { content: [{ type: "text", text: "done" }] };

/** 跑一个只有一次模型请求的 task，返回这次请求。 */
async function firstRequest(
	config: Partial<AgentConfig> = {},
): Promise<ModelRequest> {
	host = await startFakeHost({
		config: { workspace, ...config },
		model: () => done,
	});
	await host.start("hello");
	await host.until(() => host?.ends.length === 1);
	expect(host.failures).toEqual([]);
	return host.requests[0] as ModelRequest;
}

function recorded(fake: FakeHost): RecordedInstructions[] {
	return fake.events.flatMap((event) =>
		event.type === "instructions.recorded" ? [event.data] : [],
	);
}

test("规则文件放在系统指令之后的一条 user 消息里：用户级在前，然后从上级目录到工作区，各带来源路径", async () => {
	writeFileSync(join(base, "repo", "AGENTS.md"), "repo rule: use tabs");
	writeFileSync(join(workspace, "CLAUDE.md"), "app rule: no default exports");
	const userPath = join(base, "home", ".ospreycode", "AGENTS.md");
	const request = await firstRequest({
		user_instructions: {
			path: userPath,
			content: "user rule: reply in Chinese",
		},
	});

	expect(request.messages.map((message) => message.role)).toEqual([
		"system",
		"user",
		"user",
	]);
	const [system, context, input] = request.messages as [
		Message,
		Message,
		Message,
	];
	// 系统指令只有代码生成的内容：没有规则文件的内容，也没有日期
	const prompt = textOf(system);
	expect(prompt).toContain("# Rule files");
	expect(prompt).toContain(`Workspace: ${workspace}`);
	expect(prompt).not.toContain("use tabs");
	expect(prompt).not.toContain("2026-11-10");

	expect(context.content.map((block) => textOf({ content: [block] }))).toEqual([
		`<rule_file path=${JSON.stringify(userPath)} source="user">\nuser rule: reply in Chinese\n</rule_file>`,
		`<rule_file path=${JSON.stringify(join(base, "repo", "AGENTS.md"))} source="repository">\nrepo rule: use tabs\n</rule_file>`,
		`<rule_file path=${JSON.stringify(join(workspace, "CLAUDE.md"))} source="repository">\napp rule: no default exports\n</rule_file>`,
		"<environment>\nCurrent date: 2026-11-10\nOperating system: test-os\n</environment>",
	]);
	expect(input.content).toEqual(text("hello"));

	// 已经告诉模型的系统指令段落和规则文件上报给 Host，只报一次
	const [snapshot, ...rest] = recorded(host as FakeHost);
	expect(rest).toEqual([]);
	expect(snapshot?.sections.map((section) => section.name)).toEqual([
		"Introduction",
		"Tools",
		"Rules",
		"Rule files",
		"Workspace",
	]);
	expect(
		snapshot?.rule_files.map(({ path, source, included }) => ({
			path,
			source,
			included,
		})),
	).toEqual([
		{ path: userPath, source: "user", included: true },
		{
			path: join(base, "repo", "AGENTS.md"),
			source: "repository",
			included: true,
		},
		{
			path: join(workspace, "CLAUDE.md"),
			source: "repository",
			included: true,
		},
	]);
});

test("每个目录里只取第一个存在的名字：AGENTS.override.md 先于 AGENTS.md，AGENTS.md 先于 CLAUDE.md", async () => {
	writeFileSync(join(base, "repo", "AGENTS.override.md"), "override rule");
	writeFileSync(join(base, "repo", "AGENTS.md"), "plain rule");
	writeFileSync(join(workspace, "AGENTS.md"), "agents rule");
	writeFileSync(join(workspace, "CLAUDE.md"), "claude rule");
	const request = await firstRequest();

	const context = textOf(request.messages[1] as Message);
	expect(context).toContain("override rule");
	expect(context).not.toContain("plain rule");
	expect(context).toContain("agents rule");
	expect(context).not.toContain("claude rule");
});

test("没有规则文件时上下文消息只有日期和操作系统", async () => {
	const request = await firstRequest();

	expect(request.messages[1]).toMatchObject({
		role: "user",
		content: text(
			"<environment>\nCurrent date: 2026-11-10\nOperating system: test-os\n</environment>",
		),
	});
});

test("工作区和上级目录里的规则文件合计超过 32 KiB 时，放不下的整份不放、写明路径和大小，不截断；用户级的不计入", async () => {
	const big = (label: string, bytes: number) =>
		`${label}\n${"x".repeat(bytes - label.length - 1)}`;
	writeFileSync(join(base, "repo", "AGENTS.md"), big("root rule", 20 * 1024));
	writeFileSync(
		join(base, "repo", "packages", "AGENTS.md"),
		big("packages rule", 20 * 1024),
	);
	writeFileSync(join(workspace, "AGENTS.md"), big("app rule", 10 * 1024));
	const userPath = join(base, "home", ".ospreycode", "AGENTS.md");
	const request = await firstRequest({
		user_instructions: { path: userPath, content: big("user rule", 40 * 1024) },
	});

	const blocks = (request.messages[1] as Message).content.map((block) =>
		textOf({ content: [block] }),
	);
	// 用户级的 40 KiB 不计入上限；根目录的 20 KiB 放入；中间目录的 20 KiB 放不下，整份不放；
	// 工作区的 10 KiB 还放得下
	expect(blocks[0]).toContain(big("user rule", 40 * 1024));
	expect(blocks[1]).toContain(big("root rule", 20 * 1024));
	expect(blocks[2]).toBe(
		`<rule_file path=${JSON.stringify(join(base, "repo", "packages", "AGENTS.md"))} source="repository" bytes="20480" included="false">\nNot included: the rule files of the workspace and its parent directories are over the total limit of 32768 bytes. Read this file with the read tool when you need it.\n</rule_file>`,
	);
	expect(blocks[3]).toContain(big("app rule", 10 * 1024));
	expect(
		recorded(host as FakeHost)[0]?.rule_files.map((file) => file.included),
	).toEqual([true, true, false, true]);
});

test("配置变了之后只把变了的系统指令段落作为 system 消息追加，已发出的消息不变", async () => {
	writeFileSync(join(workspace, "AGENTS.md"), "app rule");
	host = await startFakeHost({ config: { workspace }, model: () => done });
	await host.start("first");
	await host.until(() => host?.ends.length === 1);
	await host.channel.notify("config/update", { approval_policy: "never" });
	await host.start("second");
	await host.until(() => host?.ends.length === 2);

	const [first, second] = host.requests as [ModelRequest, ModelRequest];
	// 前缀不变：第二次请求以第一次请求的全部消息开头
	expect(second.messages.slice(0, first.messages.length)).toEqual(
		first.messages,
	);
	expect(second.messages.map((message) => message.role)).toEqual([
		"system",
		"user",
		"user",
		"assistant",
		"user",
		"system",
	]);
	expect(textOf(second.messages[5] as Message)).toBe(
		`The system instructions changed. Each section below replaces the earlier section with the same heading.\n\n# Workspace\nWorkspace: ${workspace}\nSandbox mode: workspace-write. Approval policy: never.`,
	);
	// 追加之后重新上报已经告诉模型的段落
	const snapshots = recorded(host);
	expect(snapshots).toHaveLength(2);
	expect(snapshots[1]?.sections.at(-1)?.text).toContain(
		"Approval policy: never",
	);
	expect(host.failures).toEqual([]);
});

test("重启后不重新生成开头的消息：规则文件变了追加 user 角色的替换说明，系统指令变了追加补丁", async () => {
	// 第一次运行：记下历史和上报的快照
	writeFileSync(join(base, "repo", "AGENTS.md"), "repo rule v1");
	writeFileSync(join(workspace, "AGENTS.md"), "app rule");
	const first = await firstRequest();
	const snapshot = recorded(host as FakeHost)[0] as RecordedInstructions;
	await host?.close();
	host = undefined;

	// 重启前：一个规则文件改了，一个删了，多了一个；审批策略也换了
	writeFileSync(join(base, "repo", "AGENTS.md"), "repo rule v2");
	rmSync(join(workspace, "AGENTS.md"));
	writeFileSync(join(base, "repo", "packages", "AGENTS.md"), "packages rule");

	const [hostSide, agentSide] = await socketPair();
	const requests: ModelRequest[] = [];
	const events: RecordedInstructions[] = [];
	const ended = Promise.withResolvers<void>();
	const failures: Error[] = [];
	const hostChannel = openHostChannel(hostSide, (error) =>
		failures.push(error),
	);
	const images = new ReceivedImages();
	hostChannel.handle("model/request", async ({ message_id, request }) => {
		requests.push({ ...request, messages: images.restore(request.messages) });
		return {
			message: {
				role: "assistant",
				message_id,
				content: [{ type: "text", text: "done" }],
				protocol: "anthropic.messages",
				service: "test",
				requested_model: request.model,
				model: request.model,
				reasoning_effort: request.reasoning_effort,
				stop_reason: "end_turn",
				usage: {
					input: 1,
					output: 1,
					cache_read: 0,
					cache_write: 0,
					reasoning: 0,
				},
			},
		};
	});
	hostChannel.handle("task/end", async () => {
		ended.resolve();
		return { continue: false };
	});
	hostChannel.on("record/append", ({ event }) => {
		if (event.type === "instructions.recorded") events.push(event.data);
	});
	const channel = openRuntimeChannel(agentSide, (error) =>
		failures.push(error),
	);
	const config: AgentConfig = {
		workspace,
		writable_roots: [workspace],
		model: {
			id: "test-model",
			protocol: "anthropic.messages",
			reasoning_effort: "off",
			context_window: 200_000,
			max_output_tokens: 8_000,
		},
		sandbox_mode: "workspace-write",
		approval_policy: "never",
		tools: ["read", "edit", "write", "shell"],
		user_instructions: null,
		date: "2026-11-11",
		os: "test-os",
	};
	const loop = new AgentLoop(
		channel,
		config,
		toolRegistry,
		new ToolExecutor(
			channel,
			{ workspace, writableRoots: [workspace], records: new FileRecords() },
			[],
		),
		await loadRuleFiles(workspace, null),
		{
			history: [...first.messages],
			invalidated: new Map(),
			instructions: snapshot,
			loadedSkills: new Map(),
		},
	);
	loop.start({ input: text("continue"), message_id: randomUUID() });
	await ended.promise;
	hostChannel.close();

	const [request] = requests as [ModelRequest];
	// 开头还是重启前发过的消息，原样不动
	expect(request.messages.slice(0, first.messages.length)).toEqual(
		first.messages,
	);
	const added = request.messages.slice(first.messages.length);
	expect(added.map((message) => message.role)).toEqual([
		"user",
		"user",
		"system",
	]);
	expect(added[0]?.content).toEqual(text("continue"));
	expect(
		(added[1] as Message).content.map((block) => textOf({ content: [block] })),
	).toEqual([
		"<rule_files_update>\nThe rule files changed since the start of the session. Each <rule_file> below replaces the earlier one with the same path.\n</rule_files_update>",
		`<rule_file path=${JSON.stringify(join(base, "repo", "AGENTS.md"))} source="repository">\nrepo rule v2\n</rule_file>`,
		`<rule_file path=${JSON.stringify(join(base, "repo", "packages", "AGENTS.md"))} source="repository">\npackages rule\n</rule_file>`,
		`<rule_file path=${JSON.stringify(join(workspace, "AGENTS.md"))} source="repository" removed="true">\nThis rule file no longer exists. Its earlier content no longer applies.\n</rule_file>`,
	]);
	expect(textOf(added[2] as Message)).toContain("Approval policy: never");
	// 新的快照上报一次，下次重启和它比较
	expect(events).toHaveLength(1);
	expect(events[0]?.rule_files.map((file) => file.path)).toEqual([
		join(base, "repo", "AGENTS.md"),
		join(base, "repo", "packages", "AGENTS.md"),
	]);
	expect(failures).toEqual([]);
});
