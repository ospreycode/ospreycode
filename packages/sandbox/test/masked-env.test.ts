import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type SandboxHelper,
	type SandboxPolicy,
	sandboxFilesystem,
	startSandboxHelper,
} from "@ospreycode/sandbox/backends";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const platform = process.platform;
const bash = platform === "darwin" ? "/bin/bash" : "/usr/bin/bash";
const entry = fileURLToPath(import.meta.resolve("@ospreycode/sandbox/helper"));

const secret = "real-secret-0123456789";

// 真实沙盒的测试每个都要启动几个进程，机器忙的时候默认的 5 秒不够
describe.runIf(platform === "darwin" || platform === "linux")(
	"环境变量的 mask（真实沙盒）",
	{ timeout: 30_000 },
	() => {
		let base: string;
		let policy: SandboxPolicy;
		let env: Record<string, string>;
		let server: Server;
		let port: number;
		/** 本机的 HTTPS 服务收到的 `authorization` 头，按收到的顺序。 */
		let received: (string | undefined)[];
		const helpers: SandboxHelper[] = [];

		beforeAll(async () => {
			// macOS 的 TMPDIR 很深，沙盒后端在 TMPDIR 里建的 socket 会超出路径上限
			base = realpathSync(mkdtempSync("/tmp/osp-mask-"));
			const root = join(base, "home", ".ospreycode");
			const workspace = join(base, "workspace");
			const tmp = join(root, "tmp", "session");
			const cache = join(root, "cache", "project");
			const tls = join(base, "tls");
			for (const dir of [workspace, tmp, cache, tls]) {
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
			// 本机的 HTTPS 服务用一张临时的自签名证书
			const key = join(tls, "key.pem");
			const cert = join(tls, "cert.pem");
			execFileSync(
				"openssl",
				[
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-keyout",
					key,
					"-out",
					cert,
					"-days",
					"2",
					"-subj",
					"/CN=localhost",
					"-addext",
					"subjectAltName=DNS:localhost",
				],
				{ stdio: "ignore" },
			);
			env = {
				PATH: process.env.PATH ?? "",
				HOME: policy.home,
				TMPDIR: tmp,
				// 辅助进程的代理去连本机的服务时要认这张证书
				NODE_EXTRA_CA_CERTS: cert,
			};
			received = [];
			server = createServer(
				{ key: readFileSync(key), cert: readFileSync(cert) },
				(request, response) => {
					received.push(request.headers.authorization);
					response.end("ok");
				},
			);
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			({ port } = server.address() as AddressInfo);
		});

		afterAll(async () => {
			await Promise.all(helpers.map((helper) => helper.stop()));
			server.close();
			rmSync(base, { recursive: true, force: true });
		});

		async function run(sandbox: SandboxHelper, script: string) {
			const { rules } = await sandboxFilesystem(
				policy,
				{ kind: "command", read: [], write: [], escalated: false },
				platform as "darwin" | "linux",
			);
			const [file = "", ...args] = await sandbox.wrap(script, bash, rules);
			const child = spawn(file, args, {
				cwd: policy.workspace,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			await once(child, "close");
			await sandbox.cleanup();
			return { stdout, stderr };
		}

		// biome-ignore lint/suspicious/noTemplateCurlyInString: 是沙盒里的 shell 展开的变量，不是模板字符串
		const authorization = "Authorization: Bearer ${API_KEY}";
		// 沙盒里的 NO_PROXY 有 localhost：让 curl 连本机的服务也经代理
		const request = (host: string) =>
			`curl -s -o /dev/null -w '%{http_code}' --max-time 20 --noproxy '' -H "${authorization}" 'https://${host}:${port}/'`;

		test("沙盒里只看到占位值，请求发往指定的域名时代理换成真实值", async () => {
			const sandbox = await startSandboxHelper({
				entry,
				workspace: policy.workspace,
				tmpdir: policy.tmpdir,
				env,
				scope: {
					network: { allowedDomains: ["localhost"], deniedDomains: [] },
					maskedEnv: [{ name: "API_KEY", hosts: ["localhost"] }],
				},
				secrets: { API_KEY: secret },
			});
			helpers.push(sandbox);

			const seen = await run(sandbox, 'printf %s "$API_KEY"');
			expect(seen.stdout).not.toBe("");
			expect(seen.stdout).not.toContain(secret);
			// 辅助进程启动时的环境变量里也没有：macOS 上沙盒里读得到别的进程启动时的环境变量
			const listed = await run(sandbox, `ps eww -p ${sandbox.pid}`);
			expect(listed.stdout).not.toContain(secret);

			const sent = await run(sandbox, request("localhost"));
			expect(sent.stdout).toBe("200");
			expect(received).toEqual([`Bearer ${secret}`]);
		});

		test("没有指定给它的域名收到的是占位值", async () => {
			received.length = 0;
			const sandbox = await startSandboxHelper({
				entry,
				workspace: policy.workspace,
				tmpdir: policy.tmpdir,
				env,
				scope: {
					network: { allowedDomains: ["localhost"], deniedDomains: [] },
					maskedEnv: [{ name: "API_KEY", hosts: ["api.example.invalid"] }],
				},
				secrets: { API_KEY: secret },
			});
			helpers.push(sandbox);
			const sent = await run(sandbox, request("localhost"));
			expect(sent.stdout).toBe("200");
			expect(received).toHaveLength(1);
			expect(received[0]).toMatch(/^Bearer /);
			expect(received[0]).not.toContain(secret);
		});
	},
);
