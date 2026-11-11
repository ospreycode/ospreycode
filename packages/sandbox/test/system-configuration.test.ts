import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type SandboxHelper,
	type SandboxPolicy,
	sandboxFilesystem,
	startSandboxHelper,
} from "@ospreycode/sandbox/backends";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const entry = fileURLToPath(import.meta.resolve("@ospreycode/sandbox/helper"));

// 真实沙盒的测试要启动几个进程，机器忙的时候默认的 5 秒不够
describe.runIf(process.platform === "darwin")(
	"系统的网络配置（真实沙盒）",
	{ timeout: 30_000 },
	() => {
		let base: string;
		let policy: SandboxPolicy;
		let helper: SandboxHelper;

		beforeAll(async () => {
			// macOS 的 TMPDIR 很深，沙盒后端在 TMPDIR 里建的 socket 会超出路径上限
			base = realpathSync(mkdtempSync("/tmp/osp-scf-"));
			const root = join(base, "home", ".ospreycode");
			const workspace = join(base, "workspace");
			const tmp = join(root, "tmp", "session");
			const cache = join(root, "cache", "project");
			for (const dir of [workspace, tmp, cache]) {
				mkdirSync(dir, { recursive: true });
			}
			policy = {
				mode: "workspace-write",
				workspace,
				tmpdir: tmp,
				cache,
				readOnly: [],
				denyRead: [root],
				denyWrite: [],
				home: join(base, "home"),
				hostRoot: root,
				hostEntries: ["tmp", "cache"],
				install: [],
			};
			helper = await startSandboxHelper({
				entry,
				workspace,
				tmpdir: tmp,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: policy.home,
					TMPDIR: tmp,
				},
				scope: {},
			});
		});

		afterAll(async () => {
			await helper.stop();
			rmSync(base, { recursive: true, force: true });
		});

		// uv 这类程序创建 HTTP 客户端时读系统的代理设置，读不到就崩溃
		test("沙盒里读到的系统代理设置和沙盒外一样", async () => {
			const outside = execFileSync("/usr/sbin/scutil", ["--proxy"], {
				encoding: "utf8",
			});
			const { rules } = await sandboxFilesystem(
				policy,
				{ kind: "command", read: [], write: [], escalated: false },
				"darwin",
			);
			const [file = "", ...args] = await helper.wrap(
				"/usr/sbin/scutil --proxy",
				"/bin/bash",
				rules,
			);
			const child = spawn(file, args, {
				cwd: policy.workspace,
				stdio: ["ignore", "pipe", "inherit"],
			});
			let inside = "";
			child.stdout.on("data", (chunk: Buffer) => {
				inside += chunk.toString();
			});
			await once(child, "close");
			expect(inside).toBe(outside);
		});
	},
);
