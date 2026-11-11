import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	connectStdio,
	type McpConnection,
	type ProtocolVerdict,
	type StdioLaunch,
} from "@ospreycode/mcp";
import { expect, onTestFinished, test, vi } from "vitest";
import {
	client,
	closeAfterTest,
	fixturePath,
	launchFixture,
	probeTimeoutMs,
	rejection,
	temporaryDirectory,
} from "./helpers.js";

async function connect(
	options: { onStderr?: (text: string) => void; onClose?: () => void } = {},
): Promise<McpConnection> {
	return closeAfterTest(
		await connectStdio(
			{ ...launchFixture("server.ts"), onStderr: options.onStderr },
			{ client, probeTimeoutMs, onClose: options.onClose },
		),
	);
}

/** `pid` 这个进程退出了没有。 */
function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("连接后给出 server 的名字、版本和协商出的协议版本", async () => {
	const connection = await connect();

	expect(connection.server).toEqual({ name: "fixture", version: "1.2.3" });
	expect(connection.protocolVersion).toBe("2026-07-28");
});

test("pid 是启动的 server 进程的 pid", async () => {
	const connection = await connect();

	const reported = await connection.callTool({ name: "pid", arguments: {} });

	expect(reported.content).toEqual([
		{ type: "text", text: String(connection.pid) },
	]);
});

test("列出工具，server 声明的属性原样返回", async () => {
	const connection = await connect();

	const tools = await connection.listTools();

	expect(tools.map((tool) => tool.name)).toEqual([
		"echo",
		"fail",
		"sum",
		"media",
		"wait",
		"cancellation-seen",
		"progress",
		"resume",
		"ask",
		"add-tool",
		"stderr",
		"exit",
		"pid",
	]);
	expect(tools[0]).toMatchObject({
		name: "echo",
		title: "回显",
		description: "原样返回 text",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
		annotations: { readOnlyHint: true, idempotentHint: true },
	});
});

test("调用工具，返回它的内容", async () => {
	const connection = await connect();

	const result = await connection.callTool({
		name: "echo",
		arguments: { text: "你好" },
	});

	expect(result).toEqual({
		content: [{ type: "text", text: "你好" }],
		isError: false,
	});
});

test("工具自己报的错在结果的 isError 里，不抛错", async () => {
	const connection = await connect();

	const result = await connection.callTool({ name: "fail", arguments: {} });

	expect(result).toEqual({
		content: [{ type: "text", text: "工具执行失败" }],
		isError: true,
	});
});

test("结构化的结果原样返回", async () => {
	const connection = await connect();

	const result = await connection.callTool({
		name: "sum",
		arguments: { a: 1, b: 2 },
	});

	expect(result.structuredContent).toEqual({ sum: 3 });
	expect(result.isError).toBe(false);
});

test("图片、音频、资源链接和内嵌资源各自转成对应的内容块", async () => {
	const connection = await connect();

	const result = await connection.callTool({ name: "media", arguments: {} });

	expect(result.content).toEqual([
		{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		{ type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
		{
			type: "resource_link",
			uri: "file:///notes.txt",
			name: "notes",
			description: "一份笔记",
			mimeType: "text/plain",
		},
		{
			type: "resource",
			uri: "file:///a.txt",
			mimeType: "text/plain",
			text: "内容",
		},
		{
			type: "resource",
			uri: "file:///b.bin",
			mimeType: "application/octet-stream",
			blob: "YmxvYg==",
		},
	]);
});

test("server 不存在的工具按协议错误报出，带错误码", async () => {
	const connection = await connect();

	const error = await rejection(
		connection.callTool({ name: "no-such-tool", arguments: {} }),
		"protocol",
	);

	expect(error.code).toBe(-32602);
});

test("server 写到 stderr 的内容交给 onStderr", async () => {
	let stderr = "";
	const written = Promise.withResolvers<void>();
	const connection = await connect({
		onStderr: (text) => {
			stderr += text;
			if (stderr.includes("\n")) written.resolve();
		},
	});

	await connection.callTool({ name: "stderr", arguments: {} });
	await written.promise;

	expect(stderr).toContain("fixture：诊断信息");
});

test("进度通知交给 onProgress", async () => {
	const connection = await connect();
	const seen: unknown[] = [];
	let resumed: Promise<unknown> | undefined;

	const result = await connection.callTool(
		{ name: "progress", arguments: {} },
		{
			onProgress: (progress) => {
				seen.push(progress);
				// 工具报完进度后等着这个调用，保证结果在进度之后才来
				resumed = connection.callTool({ name: "resume", arguments: {} });
			},
		},
	);
	await resumed;

	expect(result.content).toEqual([{ type: "text", text: "完成" }]);
	expect(seen).toEqual([{ progress: 1, total: 2, message: "第 1 步" }]);
});

test("server 自己退出时调用 onClose，没完成的调用和之后的调用都以 closed 失败", async () => {
	const closed = Promise.withResolvers<void>();
	const connection = await connect({ onClose: () => closed.resolve() });

	await rejection(
		connection.callTool({ name: "exit", arguments: {} }),
		"closed",
	);
	await closed.promise;

	await rejection(
		connection.callTool({ name: "echo", arguments: { text: "x" } }),
		"closed",
	);
	await rejection(connection.listTools(), "closed");
});

/**
 * 启动 fixture，并留下一个拿着 server 的 stderr 副本（fd 9）的进程，执行 `holder` 这段 shell；
 * 它的 pid 写在目录里的 `holder.pid`，`$dir` 是这个目录。连接时要给 `prior`：
 * 探测用的兄弟进程也会运行这条命令，而它的 stderr 不是管道。
 */
function launchWithStderrHolder(
	holder: string,
	server: string[] = [process.execPath, fixturePath("server.ts")],
): {
	launch: StdioLaunch;
	directory: string;
} {
	const directory = temporaryDirectory();
	onTestFinished(() => {
		const pidFile = join(directory, "holder.pid");
		if (!existsSync(pidFile)) return;
		const holder = Number(readFileSync(pidFile, "utf8"));
		if (isRunning(holder)) process.kill(holder);
	});
	return {
		directory,
		launch: {
			command: "/bin/bash",
			args: [
				"-c",
				// 这个进程不占 stdin 和 stdout，只拿着 stderr
				`dir=$1; shift; (exec 9<&2 0<&- >/dev/null 2>&1; ${holder}) & echo $! > "$dir/holder.pid"; exec "$@"`,
				"bash",
				directory,
				...server,
			],
			env: {},
			cwd: directory,
		},
	};
}

/** 像沙盒里的收尾进程那样读 stderr，读到 EOF（Host 关闭了连接）就留下 `eof` 这个文件。 */
const readUntilClosed = 'read -r -u 9 _; echo eof > "$dir/eof"';

test("server 退出了，它留下的进程还拿着 stderr：照样调用 onClose，没完成的调用以 closed 失败", async () => {
	const { launch, directory } = launchWithStderrHolder("exec sleep 30");
	const closed = Promise.withResolvers<void>();
	const connection = closeAfterTest(
		await connectStdio(launch, {
			client,
			prior: { era: "legacy" },
			onClose: () => closed.resolve(),
		}),
	);
	const holder = Number(readFileSync(join(directory, "holder.pid"), "utf8"));

	await rejection(
		connection.callTool({ name: "exit", arguments: {} }),
		"closed",
	);
	await closed.promise;

	// 不是等那个进程自己结束才发现的
	expect(isRunning(holder)).toBe(true);
	await rejection(connection.listTools(), "closed");
});

test("server 退出后，读着它的 stderr 等连接关闭的进程读到 EOF，随后调用 onClose", async () => {
	const { launch, directory } = launchWithStderrHolder(readUntilClosed);
	const closed = Promise.withResolvers<void>();
	const connection = closeAfterTest(
		await connectStdio(launch, {
			client,
			prior: { era: "legacy" },
			onClose: () => closed.resolve(),
		}),
	);

	await rejection(
		connection.callTool({ name: "exit", arguments: {} }),
		"closed",
	);
	await closed.promise;

	expect(existsSync(join(directory, "eof"))).toBe(true);
});

test("close() 也关闭 stderr 的连接：读着它的进程读到 EOF", async () => {
	const { launch, directory } = launchWithStderrHolder(readUntilClosed);
	const connection = await connectStdio(launch, {
		client,
		prior: { era: "legacy" },
	});
	expect(existsSync(join(directory, "eof"))).toBe(false);

	await connection.close();

	await vi.waitFor(
		() => expect(existsSync(join(directory, "eof"))).toBe(true),
		{ timeout: 5000 },
	);
});

test("close() 结束 server 进程，不调用 onClose，之后的调用以 closed 失败", async () => {
	let closeNotified = false;
	const connection = await connect({
		onClose: () => {
			closeNotified = true;
		},
	});
	const pid = await connection.callTool({ name: "pid", arguments: {} });
	const serverPid = Number((pid.content[0] as { text: string }).text);
	expect(isRunning(serverPid)).toBe(true);

	await connection.close();

	expect(isRunning(serverPid)).toBe(false);
	expect(closeNotified).toBe(false);
	await rejection(
		connection.callTool({ name: "echo", arguments: { text: "x" } }),
		"closed",
	);
	await rejection(connection.listTools(), "closed");
});

test("中止信号取消调用：server 收到取消，调用以 cancelled 失败", async () => {
	const connection = await connect();
	const controller = new AbortController();

	// wait 工具开始等待时报一次进度：这时中止，server 那边一定已经在处理这次调用
	const call = connection.callTool(
		{ name: "wait", arguments: {} },
		{ signal: controller.signal, onProgress: () => controller.abort() },
	);

	await rejection(call, "cancelled");
	const seen = await connection.callTool({
		name: "cancellation-seen",
		arguments: {},
	});
	expect(seen.content).toEqual([{ type: "text", text: "server 收到了取消" }]);
});

test("调用时信号已经中止，直接以 cancelled 失败", async () => {
	const connection = await connect();

	await rejection(
		connection.callTool(
			{ name: "echo", arguments: { text: "x" } },
			{ signal: AbortSignal.abort() },
		),
		"cancelled",
	);
});

test("过了时限以 timeout 失败", async () => {
	const connection = await connect();

	await rejection(
		connection.callTool({ name: "wait", arguments: {} }, { timeoutMs: 50 }),
		"timeout",
	);
});

test.for<[string, ProtocolVerdict | undefined]>([
	["要探测", undefined],
	["沿用探测结果", { era: "legacy" }],
])("命令启动不了时连接以 transport 失败（%s）", async ([_name, prior]) => {
	await rejection(
		connectStdio(
			{ ...launchFixture("server.ts"), command: "/nonexistent/mcp-server" },
			{ client, prior },
		),
		"transport",
	);
});

test("server 一启动就退出、留下的进程还拿着 stderr：连接以 transport 失败，不等到超时", async () => {
	const { launch } = launchWithStderrHolder("exec sleep 30", [
		"/bin/sh",
		"-c",
		"echo 配置不对 >&2; exit 3",
	]);
	let stderr = "";

	await rejection(
		connectStdio(
			{
				...launch,
				onStderr: (text) => {
					stderr += text;
				},
			},
			{ client, prior: { era: "legacy" } },
		),
		"transport",
	);

	expect(stderr).toBe("配置不对\n");
});

test("连接还没完成时中止，以 cancelled 失败", async () => {
	const controller = new AbortController();

	const connecting = connectStdio(launchFixture("silent-server.ts"), {
		client,
		signal: controller.signal,
	});
	controller.abort();

	await rejection(connecting, "cancelled");
});
