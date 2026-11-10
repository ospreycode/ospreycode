import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createHost, type Session } from "@ospreycode/agent-host";
import type { Message, ModelRequest } from "@ospreycode/api/protocol";
import {
	type Script,
	type ScriptedTurn,
	scriptedModel,
} from "@ospreycode/api/testing";
import type { SandboxMode } from "@ospreycode/sandbox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	EventLog,
	type TestDirectories,
	testDirectories,
	testModel,
} from "./harness.js";

let dirs: TestDirectories;
let session: Session | undefined;
let log: EventLog;
/** 脚本模型收到的每次请求：Host 发给模型的样子。 */
let requests: ModelRequest[];

beforeEach(() => {
	dirs = testDirectories();
	log = new EventLog();
	requests = [];
	session = undefined;
});

afterEach(async () => {
	await session?.close();
	dirs.cleanup();
	// Host 发出的每个事件都要符合对外事件的 schema
	expect(log.invalid).toEqual([]);
});

async function open(
	script: Script,
	sandboxMode: SandboxMode = "danger-full-access",
): Promise<Session> {
	session = await createHost({
		root: dirs.root,
		env: dirs.env,
		credentialStore: null,
		streamModel: scriptedModel((request, call) => {
			requests.push(request);
			return script(request, call);
		}),
	}).openSession({
		workspace: dirs.workspace,
		model: "scripted",
		models: { scripted: testModel },
		credentials: { test: { file: dirs.credentialFile } },
		sandboxMode,
		approvalPolicy: "on-request",
		onEvent: log.push,
	});
	return session;
}

const say = (text: string): ScriptedTurn => ({
	content: [{ type: "text", text }],
});

function read(callId: string, path: string): ScriptedTurn {
	return {
		content: [
			{
				type: "tool_call",
				call_id: callId,
				name: "read",
				arguments: JSON.stringify({ path }),
			},
		],
	};
}

/** 一张纯白的 PNG：测试只关心它的尺寸，不为它引入图片库。 */
function png(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	// 8 位、RGB、不隔行；每行开头一个过滤类型的字节
	header.set([8, 2, 0, 0, 0], 8);
	const rows = Buffer.alloc(height * (1 + width * 3), 255);
	for (let y = 0; y < height; y++) rows[y * (1 + width * 3)] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function shown(bytes: Buffer, width: number, height: number) {
	return [
		{ type: "text", text: `[Image, image/png, ${width}x${height}.]` },
		{ type: "image", media_type: "image/png", data: bytes.toString("base64") },
	];
}

async function ended(taskId: string) {
	return log.waitFor("task.ended", (event) => event.task_id === taskId);
}

/** 请求里的工具结果消息。 */
function toolResults(request: ModelRequest | undefined): Message[] {
	return (request?.messages ?? []).filter(
		(message) => message.role === "tool_result",
	);
}

// 解码在 agent 进程的 WASM 里做，机器忙的时候加载它要几秒
describe("read 读图片", { timeout: 30_000 }, () => {
	test("图片作为工具结果里的图片块记进事件、发给模型；之后的请求和重启后的请求里图片都还在", async () => {
		const shot = png(64, 32);
		writeFileSync(join(dirs.workspace, "shot.png"), shot);
		const current = await open((_request, call) =>
			call === 0 ? read("call_1", "shot.png") : say(`第 ${call} 次回答`),
		);

		expect(await ended(await current.submit("图里有什么？"))).toMatchObject({
			outcome: "completed",
		});
		const [completed] = log.events.filter(
			(event) => event.type === "tool_call.completed",
		);
		expect(completed).toMatchObject({
			result: { status: "succeeded", content: shown(shot, 64, 32) },
		});
		expect(toolResults(requests[1])).toMatchObject([
			{ call_id: "call_1", is_error: false, content: shown(shot, 64, 32) },
		]);

		// 之后的请求里 runtime 只带引用，Host 换回图片再发给模型
		expect(await ended(await current.submit("再看一遍"))).toMatchObject({
			outcome: "completed",
		});
		expect(toolResults(requests[2])).toEqual(toolResults(requests[1]));

		// agent 进程重启后按 session 记录重建历史，图片仍然只带引用
		await current.reload();
		expect(await ended(await current.submit("重启之后呢"))).toMatchObject({
			outcome: "completed",
		});
		expect(
			requests[3]?.messages.slice(0, requests[2]?.messages.length),
		).toEqual(requests[2]?.messages);
		expect(log.types()).not.toContain("error");
	});

	test("读了图片、同一条回复里的命令还在运行时 agent 进程被杀：重启后按 session 记录补上的工具结果里图片还在", async () => {
		const shot = png(64, 32);
		writeFileSync(join(dirs.workspace, "shot.png"), shot);
		const current = await open((_request, call) =>
			call === 0
				? {
						content: [
							...read("call_1", "shot.png").content,
							{
								type: "tool_call",
								call_id: "call_2",
								name: "shell",
								arguments: JSON.stringify({ command: "sleep 600" }),
							},
						],
					}
				: say("接着来"),
		);
		const first = await current.submit("看图，再等一会");
		// 图片已经读完，命令还在运行：这条回复的工具结果还没有发给过模型
		await log.waitFor("tool_call.completed");
		await log.waitFor("tool_call.started", (event) => event.name === "shell");
		const agent = await log.waitFor(
			"process.started",
			(event) => event.kind === "agent",
		);
		process.kill(agent.pid, "SIGKILL");
		expect(await ended(first)).toMatchObject({ outcome: "failed" });

		expect(await ended(await current.submit("继续"))).toMatchObject({
			outcome: "completed",
		});
		expect(toolResults(requests[1])).toMatchObject([
			{ call_id: "call_1", is_error: false, content: shown(shot, 64, 32) },
			{ call_id: "call_2" },
		]);
		expect(log.events.filter((event) => event.type === "error")).toHaveLength(
			1,
		);
	});

	test("超过上限的图片在 agent 进程里缩小；坏掉的图片报告失败，不发给模型", async () => {
		writeFileSync(join(dirs.workspace, "wide.png"), png(2600, 130));
		writeFileSync(
			join(dirs.workspace, "broken.png"),
			png(64, 32).subarray(0, 60),
		);
		const current = await open((_request, call) => {
			if (call === 0) return read("call_1", "wide.png");
			if (call === 1) return read("call_2", "broken.png");
			return say("done");
		});

		expect(await ended(await current.submit("看这两张图"))).toMatchObject({
			outcome: "completed",
		});
		const [wide, broken] = toolResults(requests[2]);
		expect(wide).toMatchObject({
			is_error: false,
			content: [
				{
					type: "text",
					text: "[Image, image/png, scaled down from 2600x130 to 2000x100.]",
				},
				{ type: "image", media_type: "image/png" },
			],
		});
		expect(broken).toMatchObject({
			is_error: true,
			content: [
				{
					type: "text",
					text: `${join(dirs.workspace, "broken.png")} is an image that cannot be shown: The image could not be decoded.`,
				},
			],
		});
	});

	test.runIf(process.platform === "darwin")(
		"真实沙盒（macOS）里的 agent 进程照样能读图片",
		async () => {
			const shot = png(64, 32);
			writeFileSync(join(dirs.workspace, "shot.png"), shot);
			const current = await open(
				(_request, call) =>
					call === 0 ? read("call_1", "shot.png") : say("done"),
				"workspace-write",
			);

			expect(await ended(await current.submit("图里有什么？"))).toMatchObject({
				outcome: "completed",
			});
			expect(toolResults(requests[1])).toMatchObject([
				{ call_id: "call_1", is_error: false, content: shown(shot, 64, 32) },
			]);
		},
	);
});
