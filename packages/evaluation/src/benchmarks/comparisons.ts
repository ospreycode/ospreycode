import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ComparisonArm } from "../runners/coding-benchmark.js";
import { ranked } from "./dataset.js";
import { type AgentSettings, sandboxComparisonPermissions } from "./pier.js";
import type { BenchmarkManifest } from "./swe-bench-pro-v2.js";

/** 逐项关闭模块的对比里各占一组的可选工具：产品里能经配置开关的只有它们。 */
export const ablationTools = ["grep", "ls"] as const;

/**
 * 逐项关闭模块的各组：基线（`all-tools`）把可选工具都打开，其余每组（`no-<工具>`）只关一个。
 *
 * 每组的用户级配置写在 `directory` 里，内容是 `agent.configFile` 的原文加上 `[tools]`。
 * `agent.configFile` 自己写了 `[tools]` 时报错：各组差在哪里就说不清了。
 */
export function ablationArms(
	agent: AgentSettings,
	directory: string,
): ComparisonArm[] {
	const base =
		agent.configFile === undefined
			? ""
			: readFileSync(agent.configFile, "utf8");
	if (/^\s*(\[\s*tools\s*\]|tools\s*\.)/m.test(base)) {
		throw new Error(
			`${agent.configFile} 里已经有 [tools]：逐项关闭模块的对比要自己写这一节`,
		);
	}
	mkdirSync(directory, { recursive: true });
	const arm = (
		name: string,
		description: string,
		disabled: (typeof ablationTools)[number] | undefined,
	): ComparisonArm => {
		const configFile = join(directory, `${name}.toml`);
		writeFileSync(
			configFile,
			[
				...(base === "" ? [] : [base.trimEnd(), ""]),
				"[tools]",
				...ablationTools.map((tool) => `${tool} = ${tool !== disabled}`),
				"",
			].join("\n"),
		);
		return { name, description, agent: { ...agent, configFile } };
	};
	return [
		arm("all-tools", `可选工具 ${ablationTools.join("、")} 都打开`, undefined),
		...ablationTools.map((tool) =>
			arm(`no-${tool}`, `关掉可选工具 ${tool}`, tool),
		),
	];
}

/**
 * 开关沙盒的两组：基线（`sandbox-off`）是 `danger-full-access`，另一组（`sandbox-on`）是
 * `workspace-write`。两组的任务容器、权限规则文件和放行的域名相同。
 *
 * 要给出用户级配置，并在里面选好模型：运行 agent 之前探测沙盒用的 `ospreycode sandbox` 只从配置里
 * 取模型。
 */
export function sandboxArms(
	agent: Omit<AgentSettings, "permissions"> & { configFile: string },
): ComparisonArm[] {
	return [
		{
			name: "sandbox-off",
			description: "沙盒模式 danger-full-access",
			agent: {
				...agent,
				permissions: sandboxComparisonPermissions("danger-full-access"),
			},
		},
		{
			name: "sandbox-on",
			description: "沙盒模式 workspace-write",
			agent: {
				...agent,
				permissions: sandboxComparisonPermissions("workspace-write"),
			},
		},
	];
}

/** 版本对比里的一个版本。 */
export interface CliVersion {
	/** 组的名字，如 `v0-1-0`：只能用字母、数字、`-` 和 `_`。 */
	name: string;
	/** 任务容器里要安装的 npm 包，写法同 `AgentSettings.cliPackages`。 */
	cliPackages: string[];
}

/** 版本对比的两组：只差任务容器里安装的 CLI 包，基线是旧版本。 */
export function versionArms(
	agent: Omit<AgentSettings, "cliPackages">,
	baseline: CliVersion,
	candidate: CliVersion,
): ComparisonArm[] {
	return [baseline, candidate].map((version) => ({
		name: version.name,
		description: `安装 ${version.cliPackages.join(" ")}`,
		agent: { ...agent, cliPackages: version.cliPackages },
	}));
}

/** 开关沙盒的对比实验每种语言取几道题。 */
export const sandboxComparisonTasksPerLanguage = 4;

const sandboxComparisonSeed = "osprey-p4-sandbox";

/**
 * 开关沙盒的对比实验用的题目清单：SWE-bench Pro V2 的开发题里每种语言
 * `sandboxComparisonTasksPerLanguage` 道，按 `sha256("osprey-p4-sandbox:<题目 id>")` 排在最前的
 * 取。得到的清单交给 `prepareDataset`（`split` 写 `development`）。
 */
export function sandboxComparisonManifest(
	manifest: BenchmarkManifest,
): BenchmarkManifest {
	const development = manifest.tasks.filter(
		(task) => task.split === "development",
	);
	const languages = [...new Set(development.map((task) => task.language))];
	const tasks = languages.flatMap((language) => {
		const own = ranked(
			development.filter((task) => task.language === language),
			sandboxComparisonSeed,
			(task) => task.id,
		);
		if (own.length < sandboxComparisonTasksPerLanguage) {
			throw new Error(
				`${language} 的开发题只有 ${own.length} 道，不够 ${sandboxComparisonTasksPerLanguage} 道`,
			);
		}
		return own.slice(0, sandboxComparisonTasksPerLanguage);
	});
	return {
		...manifest,
		tasks: tasks.sort((a, b) => (a.id < b.id ? -1 : 1)),
	};
}
