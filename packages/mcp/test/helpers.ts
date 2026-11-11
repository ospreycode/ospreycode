import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type McpConnection,
	McpError,
	type McpErrorKind,
	type StdioLaunch,
} from "@ospreycode/mcp";
import { expect, onTestFinished } from "vitest";

/** 客户端自报的名字和版本。 */
export const client = { name: "mcp-test", version: "0.0.0" };

/**
 * 要探测本地 fixture 的测试用的探测超时。全部包的测试并行运行时进程启动得慢，
 * 默认的 5 秒里 fixture 可能来不及回应，新协议的 server 就被判成旧的。
 */
export const probeTimeoutMs = 15_000;

/** `test/fixtures/` 下的文件。 */
export function fixturePath(name: string): string {
	return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/** 这个测试用的临时目录，测试结束时删掉。 */
export function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "mcp-test-"));
	onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

/** 用 node 运行一个 fixture 的命令行；环境变量只有明确给出的这些。 */
export function launchFixture(
	name: string,
	env: Record<string, string> = {},
): StdioLaunch {
	return {
		command: process.execPath,
		args: [fixturePath(name)],
		env,
		cwd: temporaryDirectory(),
	};
}

/** fixture 记在文件里的各行。 */
export function readLog(path: string): string[] {
	return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

/** 测试结束时关闭连接。 */
export function closeAfterTest(connection: McpConnection): McpConnection {
	onTestFinished(() => connection.close());
	return connection;
}

/** `promise` 应当以某一类 `McpError` 失败；返回这个错误。 */
export async function rejection(
	promise: Promise<unknown>,
	kind: McpErrorKind,
): Promise<McpError> {
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(McpError);
	expect((error as McpError).kind).toBe(kind);
	return error as McpError;
}
