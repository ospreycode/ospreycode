import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
	ConfigError,
	createHost,
	type Host,
	type SandboxRunOptions,
	type SandboxRunResult,
} from "@ospreycode/agent-host";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type TestDirectories, testDirectories, testModel } from "./harness.js";

const supported = process.platform === "darwin" || process.platform === "linux";

let dirs: TestDirectories;
let host: Host;
let server: Server | undefined;
const warnings: string[] = [];

beforeEach(() => {
	dirs = testDirectories();
	host = createHost({ root: dirs.root, env: dirs.env, credentialStore: null });
	server = undefined;
	warnings.length = 0;
	// 配置要能解析出选用的模型；这里不会发模型请求
	writeFileSync(
		join(dirs.root, "config.toml"),
		`model = "scripted"

[models.scripted]
protocol = "${testModel.protocol}"
service = "${testModel.service}"
base_url = "${testModel.base_url}"
model = "${testModel.model}"
context_window = ${testModel.context_window}
max_output_tokens = ${testModel.max_output_tokens}
`,
	);
	writeFileSync(join(dirs.workspace, "readme.txt"), "workspace file\n");
});

afterEach(() => {
	server?.close();
	dirs.cleanup();
});

interface Captured extends SandboxRunResult {
	stdout: string;
	stderr: string;
}

/** 在沙盒里运行一条 shell 命令，标准输出和标准错误接到文件上读回来。 */
async function run(
	script: string,
	options: Partial<SandboxRunOptions> = {},
): Promise<Captured> {
	const outPath = join(dirs.home, "stdout.txt");
	const errPath = join(dirs.home, "stderr.txt");
	const out = openSync(outPath, "w");
	const err = openSync(errPath, "w");
	try {
		const result = await host.runInSandbox({
			workspace: dirs.workspace,
			command: ["sh", "-c", script],
			stdio: ["ignore", out, err],
			onWarning: (message) => warnings.push(message),
			...options,
		});
		return {
			...result,
			stdout: readFileSync(outPath, "utf8"),
			stderr: readFileSync(errPath, "utf8"),
		};
	} finally {
		closeSync(out);
		closeSync(err);
	}
}

describe.runIf(supported)("runInSandbox（真实沙盒）", () => {
	test("read-only：能读工作区，写不进去；临时目录可写", async () => {
		const result = await run(
			'cat readme.txt; echo changed > readme.txt; echo tmp > "$TMPDIR/scratch" && cat "$TMPDIR/scratch"',
			{ permissions: "read-only" },
		);

		expect(result.stdout).toBe("workspace file\ntmp\n");
		expect(result.stderr).not.toBe("");
		expect(readFileSync(join(dirs.workspace, "readme.txt"), "utf8")).toBe(
			"workspace file\n",
		);
	});

	test("workspace-write：能写工作区和构建缓存，写不到别处", async () => {
		const outside = join(dirs.home, "outside.txt");
		const result = await run(
			`echo new > created.txt; mkdir -p "$XDG_CACHE_HOME" && echo cached > "$XDG_CACHE_HOME/artifact"; echo leaked > '${outside}'`,
			{ permissions: "workspace-write" },
		);

		expect(result.exit_code).not.toBe(0);
		expect(readFileSync(join(dirs.workspace, "created.txt"), "utf8")).toBe(
			"new\n",
		);
		expect(existsSync(outside)).toBe(false);
		// 缓存写在这个项目的缓存目录里，命令结束后留着
		const [project] = host.listProjects();
		if (project === undefined) throw new Error("工作区没有登记成项目");
		expect(
			readFileSync(
				join(dirs.root, "cache", project.project_id, "xdg", "artifact"),
				"utf8",
			),
		).toBe("cached\n");
	});

	test("不给 permissions 时按配置里的沙盒模式", async () => {
		// 不是 git 仓库的目录默认是 read-only
		const denied = await run("echo x > made.txt");
		expect(denied.exit_code).not.toBe(0);

		mkdirSync(join(dirs.workspace, ".git"));
		const allowed = await run("echo x > made.txt");
		expect(allowed.exit_code).toBe(0);
		expect(existsSync(join(dirs.workspace, "made.txt"))).toBe(true);
	});

	test("读不到 Host 根目录和配置里指定的凭据文件", async () => {
		writeFileSync(
			join(dirs.root, "config.toml"),
			`${readFileSync(join(dirs.root, "config.toml"), "utf8")}
[credentials]
test = { file = "${dirs.credentialFile}" }
`,
		);
		const result = await run(
			`cat '${join(dirs.root, "config.toml")}'; cat '${dirs.credentialFile}'`,
			{ permissions: "workspace-write" },
		);

		expect(result.exit_code).not.toBe(0);
		expect(result.stdout).toBe("");
	});

	test("退出码和结束命令的信号照原样返回", async () => {
		expect(await run("exit 7")).toMatchObject({ exit_code: 7, signal: null });
		expect(await run("kill -TERM $$")).toMatchObject({
			exit_code: null,
			signal: "SIGTERM",
		});
	});

	test("权限规则没有放行的域名直接拒绝，不询问", async () => {
		server = createServer((_request, response) => response.end("reached"));
		await new Promise<void>((resolve) =>
			server?.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		const result = await run(
			`curl -sS -m 5 http://example.com/ ; curl -sS -m 5 http://127.0.0.1:${port}/`,
			{ permissions: "workspace-write" },
		);

		expect(result.exit_code).not.toBe(0);
		expect(result.stdout).not.toContain("reached");
		expect(result.stdout).not.toContain("Example Domain");
	});

	test("中止时结束命令，连同它留在后台的进程", async () => {
		const abort = new AbortController();
		const marker = join(dirs.workspace, "late.txt");
		const running = run(
			"(sleep 2; echo late > late.txt) & echo started > started.txt; sleep 30",
			{ permissions: "workspace-write", signal: abort.signal },
		);
		while (!existsSync(join(dirs.workspace, "started.txt"))) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		abort.abort();
		const result = await running;

		expect(result.exit_code).not.toBe(0);
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(existsSync(marker)).toBe(false);
	});

	test("命令结束后它留在后台的进程也结束，临时目录删掉", async () => {
		const result = await run(
			"(sleep 1; echo late > late.txt) >/dev/null 2>&1 & echo done",
			{ permissions: "workspace-write" },
		);

		expect(result).toMatchObject({ exit_code: 0, stdout: "done\n" });
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(existsSync(join(dirs.workspace, "late.txt"))).toBe(false);
		expect(readdirSync(join(dirs.root, "tmp"))).toEqual([]);
		expect(readdirSync(join(dirs.root, "output"))).toEqual([]);
	});
});

test("danger-full-access 下不用沙盒直接运行", async () => {
	const outside = join(dirs.home, "outside.txt");
	const result = await run(`echo free > '${outside}'; echo ok`, {
		permissions: "danger-full-access",
	});

	expect(result).toMatchObject({ exit_code: 0, stdout: "ok\n" });
	expect(readFileSync(outside, "utf8")).toBe("free\n");
});

test("不存在的权限配置：照配置的报错抛出 ConfigError，不建目录", async () => {
	await expect(run("true", { permissions: "no-such-profile" })).rejects.toThrow(
		ConfigError,
	);
	expect(existsSync(join(dirs.root, "tmp"))).toBe(false);
});
