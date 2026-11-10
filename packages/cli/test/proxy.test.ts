import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import { startCli, type TestDirectories, testDirectories } from "./harness.js";

let dirs: TestDirectories;
let proxy: Server;
/** 代理收到的 CONNECT 请求的目标。 */
let targets: string[];
let onConnect: () => void;

beforeEach(async () => {
	dirs = testDirectories();
	targets = [];
	onConnect = () => {};
	// 只记下要连到哪里，然后拒绝：测试不联网
	proxy = createServer().on("connect", (request, socket) => {
		targets.push(request.url ?? "");
		socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		onConnect();
	});
	proxy.listen(0, "127.0.0.1");
	await once(proxy, "listening");
});

afterEach(() => {
	proxy.closeAllConnections();
	proxy.close();
	dirs.cleanup();
});

/** 模型服务在一个不存在的 https 地址上：请求只可能经代理发出。 */
function config(extra: string): string {
	return `model = "remote"
${extra}

[models.remote]
protocol = "openai.chat"
service = "fake"
base_url = "https://model.invalid/v1"
model = "remote"
context_window = 100000
max_output_tokens = 4000

[models.remote.price]
input = 1
output = 5
cache_read = 0.1
cache_write = 1.25
`;
}

/** 运行 exec 到代理收到第一个请求为止，然后取消。 */
async function execUntilProxied(env: Record<string, string>): Promise<void> {
	const connected = new Promise<void>((resolve) => {
		onConnect = resolve;
	});
	const cli = startCli(
		[
			"exec",
			"--json",
			"--credential-file",
			`fake=${dirs.credentialFile}`,
			"--sandbox",
			"danger-full-access",
			"任务",
		],
		{ cwd: dirs.workspace, env },
	);
	await Promise.race([
		connected,
		cli.result.then((result) => {
			throw new Error(`exec 没有经过代理就结束了：${result.stderr}`);
		}),
	]);
	cli.child.kill("SIGINT");
	await cli.result;
}

function proxyUrl(): string {
	return `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}

test("配置里的 proxy：模型请求经它发出", async () => {
	dirs.writeConfig(config(`proxy = "${proxyUrl()}"`));
	await execUntilProxied(dirs.env);

	expect(targets[0]).toBe("model.invalid:443");
});

test("没有配置 proxy 时用环境变量 HTTPS_PROXY", async () => {
	dirs.writeConfig(config(""));
	await execUntilProxied({ ...dirs.env, HTTPS_PROXY: proxyUrl() });

	expect(targets[0]).toBe("model.invalid:443");
});
