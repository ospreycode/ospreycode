import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type MemoryScenario,
	type MemorySession,
	memoryScenarioKinds,
	memoryScenarioSet,
	memoryScenarios,
} from "@ospreycode/evaluation";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

let base: string;

beforeEach(() => {
	base = mkdtempSync("/tmp/osp-eval-test-");
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

/** 在工作区里运行一条 shell 命令，返回退出码和标准错误。 */
function sh(workspace: string, command: string) {
	const result = spawnSync("sh", ["-c", command], {
		cwd: workspace,
		env: { PATH: process.env.PATH },
		encoding: "utf8",
	});
	return { status: result.status, stderr: result.stderr.trim() };
}

function write(workspace: string, path: string, content: string): void {
	mkdirSync(join(workspace, path, ".."), { recursive: true });
	writeFileSync(join(workspace, path), content);
}

function edit(
	workspace: string,
	path: string,
	change: (text: string) => string,
): void {
	const target = join(workspace, path);
	writeFileSync(target, change(readFileSync(target, "utf8")));
}

/** 工作区里全部文件的内容，连同路径。 */
function contents(workspace: string): string {
	return readdirSync(workspace, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const path = join(entry.parentPath, entry.name);
			return `${path}\n${readFileSync(path, "utf8")}`;
		})
		.join("\n");
}

const completed: MemorySession = {
	sessionId: "probe",
	outcome: "completed",
	events: [],
	usage: {
		input: 0,
		output: 0,
		cache_read: 0,
		cache_write: 0,
		reasoning: 0,
		cost_usd: 0,
	},
	durationMs: 0,
	indexTokens: 0,
};

/** 一道题里模型该做和可能做错的事，由测试代替模型来做。 */
interface Walkthrough {
	/** 学习会话里做的事。 */
	learned?(workspace: string): void;
	/** 检验会话里正确的做法。 */
	solve(workspace: string): void;
	/** 没有记忆时猜着做，或者照搬过期记忆的做法；`stale` 是题目应当数出的误用次数。 */
	mistakes: { what: string; act(workspace: string): void; stale?: number }[];
	/** 解题要用、但检验会话的工作区里找不到的文字。 */
	hidden?: string[];
}

const ok = (workspace: string, command: string) =>
	expect(sh(workspace, command).status, command).toBe(0);

const walkthroughs: Record<string, Walkthrough> = {
	"再次使用学到的检查命令（kestrel-api）": {
		learned: (w) => ok(w, "sh scripts/check.sh --suite lagoon-42"),
		solve: (w) => ok(w, "sh scripts/check.sh --suite lagoon-42"),
		mistakes: [
			{ what: "不带参数运行", act: (w) => sh(w, "sh scripts/check.sh") },
			{
				what: "猜一个 suite 名字",
				act: (w) => sh(w, "sh scripts/check.sh --suite default"),
			},
			{
				what: "不运行脚本，自己写结果文件",
				act: (w) => write(w, ".check-result", "ok\n"),
			},
		],
		hidden: ["lagoon-42"],
	},
	"再次使用学到的测试命令（tern-queue）": {
		learned: (w) => ok(w, "QUEUE_PROFILE=basalt-17 sh ci/test.sh"),
		solve: (w) => ok(w, "QUEUE_PROFILE=basalt-17 sh ci/test.sh"),
		mistakes: [
			{ what: "不设 QUEUE_PROFILE", act: (w) => sh(w, "sh ci/test.sh") },
			{
				what: "猜一个 profile",
				act: (w) => sh(w, "QUEUE_PROFILE=default sh ci/test.sh"),
			},
		],
		hidden: ["basalt-17"],
	},
	"构建脚本换了以后纠正旧做法（marten-build）": {
		learned: (w) => ok(w, "sh tools/build.sh --target quay-31"),
		solve: (w) => ok(w, "sh tools/package.sh --target quay-31"),
		mistakes: [
			{
				what: "照搬旧脚本",
				act: (w) => sh(w, "sh tools/build.sh --target quay-31"),
				stale: 1,
			},
			{
				what: "用新脚本但猜一个 target",
				act: (w) => sh(w, "sh tools/package.sh --target release"),
			},
		],
		hidden: ["quay-31"],
	},
	"选项改名以后纠正旧做法（plover-db）": {
		learned: (w) => ok(w, "sh db/migrate.sh --env sandbar-8"),
		solve: (w) => ok(w, "sh db/migrate.sh --stage sandbar-8"),
		mistakes: [
			{
				what: "照搬旧选项，两次",
				act: (w) => {
					sh(w, "sh db/migrate.sh --env sandbar-8");
					sh(w, "sh db/migrate.sh --env sandbar-8");
				},
				stale: 2,
			},
			{
				what: "用新选项但猜一个环境名",
				act: (w) => sh(w, "sh db/migrate.sh --stage production"),
			},
		],
		hidden: ["sandbar-8"],
	},
	"在另一个项目里按个人偏好写脚本（ledger-cli → tide-charts）": {
		solve: (w) =>
			write(
				w,
				"bin/today.sh",
				"#!/bin/sh\n# maintainer: quill-53\ndate -u +%F\n",
			),
		mistakes: [
			{
				what: "放在项目根目录",
				act: (w) =>
					write(
						w,
						"today.sh",
						"#!/bin/sh\n# maintainer: quill-53\ndate -u +%F\n",
					),
			},
			{
				what: "放在 bin/ 但没有那一行",
				act: (w) => write(w, "bin/today.sh", "#!/bin/sh\ndate -u +%F\n"),
			},
		],
		hidden: ["quill-53", "ledger-cli"],
	},
	"在另一个项目里按个人偏好记决定（wren-notes → gull-cache）": {
		solve: (w) =>
			write(
				w,
				"docs/decisions/0001-cache-index.md",
				"Status: accepted (sorrel-27)\n\n# Cache index\n\nThe cache index is stored in SQLite.\n",
			),
		mistakes: [
			{
				what: "常见的写法，没有那一行",
				act: (w) =>
					write(
						w,
						"docs/decisions/0001-cache-index.md",
						"# Cache index\n\nStatus: accepted\n\nThe cache index is stored in SQLite.\n",
					),
			},
			{
				what: "有那一行但不在约定的目录",
				act: (w) =>
					write(
						w,
						"DECISIONS.md",
						"Status: accepted (sorrel-27)\n\nThe cache index is stored in SQLite.\n",
					),
			},
		],
		hidden: ["sorrel-27", "wren-notes"],
	},
	"接着做完分三步的配置改动（harbor-deploy）": {
		learned: (w) =>
			edit(w, "deploy/dev.toml", (text) => `${text}region = "skerry-4"\n`),
		solve: (w) => {
			edit(w, "deploy/staging.toml", (text) => `${text}region = "skerry-4"\n`);
			edit(w, "deploy/prod.toml", (text) =>
				text.replace("replicas = 3", "replicas = 6"),
			);
		},
		mistakes: [
			{
				what: "照 dev.toml 给另外两个文件都加上 region",
				act: (w) => {
					for (const name of ["staging", "prod"]) {
						edit(
							w,
							`deploy/${name}.toml`,
							(text) => `${text}region = "skerry-4"\n`,
						);
					}
				},
			},
			{ what: "什么都不做", act: () => {} },
		],
		hidden: ["replicas = 6"],
	},
	"接着做完功能开关的清理（lantern-web）": {
		learned: (w) =>
			edit(w, "flags.json", (text) => {
				const { beta_search: _, ...rest } = JSON.parse(text);
				return `${JSON.stringify(rest, null, 2)}\n`;
			}),
		solve: (w) =>
			edit(w, "flags.json", (text) => {
				const { old_checkout: _, legacy_nav_3: __, ...rest } = JSON.parse(text);
				return `${JSON.stringify(rest, null, 2)}\n`;
			}),
		mistakes: [
			{ what: "什么都不做", act: () => {} },
			{
				what: "把名字像旧功能的都删掉，少删一个",
				act: (w) =>
					edit(w, "flags.json", (text) => {
						const { old_checkout: _, ...rest } = JSON.parse(text);
						return `${JSON.stringify(rest, null, 2)}\n`;
					}),
			},
			{
				what: "把文件写坏",
				act: (w) => write(w, "flags.json", '{ "dark_mode": true,'),
			},
		],
	},
	"作废的文档规则不再套用（gannet-sync）": {
		solve: (w) =>
			edit(
				w,
				"docs/options.md",
				(text) =>
					`${text}- \`sync_interval\`: seconds between two syncs, default 30.\n`,
			),
		mistakes: [
			{
				what: "照作废的规则写",
				act: (w) =>
					edit(
						w,
						"docs/options.md",
						(text) =>
							`${text}- \`sync_interval\`: seconds between two syncs, default 30 (since cormorant-12)\n`,
					),
				stale: 1,
			},
			{ what: "什么都不做", act: () => {} },
		],
		hidden: ["cormorant-12"],
	},
	"作废的命名规则不再套用（petrel-mail）": {
		solve: (w) => write(w, "fixtures/inbox-empty.json", '{ "messages": [] }\n'),
		mistakes: [
			{
				what: "照作废的规则起名",
				act: (w) =>
					write(w, "fixtures/auk9-inbox-empty.json", '{ "messages": [] }\n'),
				stale: 1,
			},
			{
				what: "放在别的目录",
				act: (w) => write(w, "inbox-empty.json", '{ "messages": [] }\n'),
			},
		],
		hidden: ["auk9-"],
	},
	"这一次明确要 YAML（shearwater-docs）": {
		solve: (w) =>
			write(w, "config/limits.yaml", "max_users: 40\nmax_projects: 12\n"),
		mistakes: [
			{
				what: "照长期偏好写成 JSON",
				act: (w) =>
					write(
						w,
						"config/limits.json",
						'{ "max_users": 40, "max_projects": 12 }\n',
					),
				stale: 1,
			},
			{
				what: "两种都写",
				act: (w) => {
					write(w, "config/limits.yaml", "max_users: 40\nmax_projects: 12\n");
					write(
						w,
						"config/limits.json",
						'{ "max_users": 40, "max_projects": 12 }\n',
					);
				},
				stale: 1,
			},
		],
	},
	"这一次明确要另一种日期写法（fulmar-notes）": {
		solve: (w) =>
			edit(
				w,
				"docs/timeline.md",
				(text) => `${text}- 3 March 2027: public release planned\n`,
			),
		mistakes: [
			{
				what: "照长期偏好写成 ISO 日期",
				act: (w) =>
					edit(
						w,
						"docs/timeline.md",
						(text) => `${text}- 2027-03-03: public release planned\n`,
					),
				stale: 1,
			},
		],
	},
	"同样的报错换了原因（curlew-ingest）": {
		learned: (w) => {
			expect(sh(w, "sh tools/check.sh")).toEqual({
				status: 1,
				stderr: "check failed: ingest rejected (code 17)",
			});
			edit(w, "config/ingest.conf", (text) =>
				text.replace("batch_size = 900", "batch_size = 400"),
			);
			ok(w, "sh tools/check.sh");
		},
		solve: (w) => {
			// 和上一次一模一样的报错
			expect(sh(w, "sh tools/check.sh")).toEqual({
				status: 1,
				stderr: "check failed: ingest rejected (code 17)",
			});
			edit(w, "config/ingest.conf", (text) =>
				text.replace("window_sec = 0", "window_sec = 30"),
			);
			ok(w, "sh tools/check.sh");
		},
		mistakes: [
			{
				what: "照上一次的修法再调小 batch_size",
				act: (w) => {
					edit(w, "config/ingest.conf", (text) =>
						text.replace("batch_size = 500", "batch_size = 250"),
					);
					expect(sh(w, "sh tools/check.sh").status).toBe(1);
				},
				stale: 1,
			},
		],
	},
	"同样的 lint 报错换了原因（dunlin-render）": {
		learned: (w) => {
			expect(sh(w, "sh ci/lint.sh")).toEqual({
				status: 1,
				stderr: "lint: 1 problem (E-layout)",
			});
			edit(w, "templates/page.tpl", (text) => text.replace("\t", "  "));
			ok(w, "sh ci/lint.sh");
		},
		solve: (w) => {
			expect(sh(w, "sh ci/lint.sh")).toEqual({
				status: 1,
				stderr: "lint: 1 problem (E-layout)",
			});
			edit(w, "templates/footer.tpl", (text) =>
				text.replace("dunlin \n", "dunlin\n"),
			);
			ok(w, "sh ci/lint.sh");
		},
		mistakes: [
			{
				what: "照上一次的修法再找一遍制表符",
				act: (w) => {
					edit(w, "templates/page.tpl", (text) => text.replaceAll("\t", "  "));
					expect(sh(w, "sh ci/lint.sh").status).toBe(1);
				},
			},
			{
				what: "把报错的模板删掉",
				act: (w) => {
					rmSync(join(w, "templates", "footer.tpl"));
					ok(w, "sh ci/lint.sh");
				},
			},
		],
	},
};

/** 走到检验会话开始之前，返回检验会话的工作区。 */
function beforeProbe(scenario: MemoryScenario, name: string): string {
	const walkthrough = walkthroughs[scenario.name] as Walkthrough;
	const root = join(base, name);
	const workspace = join(root, "workspace");
	mkdirSync(workspace, { recursive: true });
	scenario.setup(workspace);
	walkthrough.learned?.(workspace);
	scenario.change?.(workspace);
	if (scenario.probeProject === undefined) return workspace;
	const other = join(root, "other-project");
	mkdirSync(other);
	scenario.probeProject(other);
	return other;
}

describe("场景集的组成", () => {
	test("七类场景各一道开发题、一道保留题，名字不重复", () => {
		expect(memoryScenarios).toHaveLength(14);
		expect(new Set(memoryScenarios.map((scenario) => scenario.name)).size).toBe(
			14,
		);
		for (const split of ["development", "holdout"] as const) {
			expect(memoryScenarioSet(split).map((scenario) => scenario.kind)).toEqual(
				[...memoryScenarioKinds],
			);
			expect(
				memoryScenarioSet(split).every((scenario) => scenario.split === split),
			).toBe(true);
		}
		expect(Object.keys(walkthroughs).sort()).toEqual(
			memoryScenarios.map((scenario) => scenario.name).sort(),
		);
	});

	test("只有在另一个项目中使用个人偏好的题换工作区；只有用户要求忘记的题有两个学习会话", () => {
		for (const scenario of memoryScenarios) {
			expect(scenario.probeProject !== undefined, scenario.name).toBe(
				scenario.kind === "cross-project",
			);
			expect(scenario.learn, scenario.name).toHaveLength(
				scenario.kind === "forget" ? 2 : 1,
			);
		}
	});

	test("诊断组的证据算作解题要用的信息；依赖记忆的四类题里，检验会话的输入不带这些信息", () => {
		for (const scenario of memoryScenarios) {
			expect(scenario.evidence(scenario.facts), scenario.name).toBe(true);
			expect(scenario.evidence("unrelated text"), scenario.name).toBe(false);
		}
		const dependent = memoryScenarios.filter((scenario) =>
			["reuse-command", "correct-stale", "cross-project", "resume"].includes(
				scenario.kind,
			),
		);
		expect(dependent).toHaveLength(8);
		for (const scenario of dependent) {
			expect(scenario.evidence(scenario.probe), scenario.name).toBe(false);
			expect(scenario.learn.some(scenario.evidence), scenario.name).toBe(true);
		}
	});
});

describe.each(
	memoryScenarios.map((scenario) => ({ name: scenario.name, scenario })),
)("$name", ({ scenario }) => {
	const walkthrough = walkthroughs[scenario.name] as Walkthrough;

	test("检验会话开始时还没通过；照正确的做法做完就通过，不算误用过期记忆", () => {
		const workspace = beforeProbe(scenario, "solve");
		expect(scenario.check(completed, workspace)).not.toEqual([]);

		walkthrough.solve(workspace);
		expect(scenario.check(completed, workspace)).toEqual([]);
		expect(scenario.staleUses?.(completed, workspace) ?? 0).toBe(0);
		// task 没有正常完成时，工作区对了也不算通过
		expect(
			scenario.check({ ...completed, outcome: "failed" }, workspace),
		).toHaveLength(1);
		expect(
			scenario.check({ ...completed, outcome: undefined }, workspace),
		).toHaveLength(1);
	});

	test.each(walkthrough.mistakes)("$what：不通过", ({ what, act, stale }) => {
		const workspace = beforeProbe(scenario, what);
		act(workspace);
		expect(scenario.check(completed, workspace)).not.toEqual([]);
		expect(scenario.staleUses?.(completed, workspace) ?? 0).toBe(stale ?? 0);
	});

	const { hidden } = walkthrough;
	if (hidden !== undefined) {
		test("解题要用的信息不在检验会话的工作区里", () => {
			const text = contents(beforeProbe(scenario, "hidden"));
			for (const secret of hidden) expect(text).not.toContain(secret);
		});
	}
});
