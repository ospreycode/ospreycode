#!/usr/bin/env node
import http from "node:http";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.js";
import type { CliSignal } from "./context.js";

// @types/node 里还没有这个函数的声明
declare module "node:http" {
	function setGlobalProxyFromEnv(
		env?: Readonly<Record<string, string | undefined>>,
	): () => void;
}

/** 和这个文件打包在同一个目录里的另一个进程入口。 */
function sibling(name: string): string {
	return fileURLToPath(new URL(name, import.meta.url));
}

// 只在作为进程入口运行时启动：被别的模块引用时不读也不改进程的状态
if (import.meta.main) {
	const { env } = process;
	const code = await runCli({
		argv: process.argv.slice(2),
		env,
		cwd: process.cwd(),
		platform: process.platform,
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
		onSignal(listener) {
			const signals: CliSignal[] = ["SIGINT", "SIGTERM"];
			for (const signal of signals) process.on(signal, listener);
			return () => {
				for (const signal of signals) process.off(signal, listener);
			};
		},
		useProxy(proxy) {
			// Node 的 fetch 默认不用代理。配置的 proxy 顶替 HTTPS_PROXY，NO_PROXY 照启动环境
			const httpsProxy = proxy ?? env.HTTPS_PROXY ?? env.https_proxy;
			if (httpsProxy === undefined) return;
			http.setGlobalProxyFromEnv({
				https_proxy: httpsProxy,
				no_proxy: env.NO_PROXY ?? env.no_proxy,
			});
		},
		entries: {
			agent: sibling("./agent.js"),
			applyEdits: sibling("./apply-edits.js"),
			sandboxHelper: sibling("./sandbox-helper.js"),
		},
	});
	// 管道另一头读得慢时直接退出会丢掉最后几行，等 stdout 和 stderr 写完
	await Promise.all(
		[process.stdout, process.stderr].map(
			(stream) => new Promise<void>((done) => stream.write("", () => done())),
		),
	);
	process.exit(code);
}
