import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { FlakyReporter } from "./scripts/flaky-reporter.js";

interface Manifest {
	name: string;
	exports: Record<string, { import: string }>;
}

const root = new URL("./", import.meta.url);

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(new URL(path, root), "utf8"));
}

function exactMatch(specifier: string): RegExp {
	return new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

const { workspaces } = readJson("package.json") as { workspaces: string[] };

// 测试经包名引用其他包时直接用源码，不必先构建：exports 里的 ./dist/x.js 对应 src/x.ts。
const alias = workspaces.flatMap((dir) => {
	const manifest = readJson(`${dir}/package.json`) as Manifest;
	return Object.entries(manifest.exports).map(([subpath, target]) => ({
		find: exactMatch(manifest.name + subpath.slice(1)),
		replacement: fileURLToPath(
			new URL(
				`${dir}/${target.import.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")}`,
				root,
			),
		),
	}));
});

export default defineConfig({
	resolve: { alias },
	test: {
		tags: [
			{
				name: "model",
				// 模型测试的时限比一个 run 的时间上限（5 分钟）宽，让 Host 的上限先生效
				timeout: 6 * 60_000,
				// 只对模型服务的限流、过载、网络中断和超时重跑一次（scripts/model-test.ts 抛出的错误），断言失败不重跑
				retry: { count: 1, condition: /^模型服务暂时不可用/ },
			},
		],
		globalSetup: ["./scripts/model-keys.ts"],
		// 默认的报告（CI 上另有 github-actions）之外，运行结束时列出重跑之后才通过的测试
		reporters: [...configDefaults.reporters, new FlakyReporter()],
	},
});
