import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Split } from "../benchmarks/swe-bench-pro-v2.js";
import type { MemoryTask } from "../runners/memory-experiment.js";

function completed(outcome: string | undefined): string[] {
	return outcome === "completed"
		? []
		: [`task 的结果是 ${outcome ?? "超时"}，应当是 completed`];
}

function lines(path: string): string[] {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter((line) => line.trim() !== "")
		: [];
}

const staleMarker = ".stale-check-used";

/**
 * 试跑用的两道题：一道的信息只在之前的会话里（用户说过的约定），一道学到的做法在检验之前过期了。
 * 只用来确认对比实验的流程走得通，不是完整的场景集。
 */
export const memorySmokeTasks: readonly MemoryTask[] = [
	{
		name: "再次使用用户说过的约定",
		setup(workspace) {
			writeFileSync(
				join(workspace, "README.md"),
				"# heron\n\nA small service.\n",
			);
		},
		learn: [
			"For this project, release notes go in docs/releases/NOTES.md, one line per change, and every line starts with the tag [heron-7]. Remember this for future sessions, then reply OK. Do not create or change any file now.",
		],
		probe:
			"Add a release note for this change, following this project's convention for release notes: fixed the login timeout.",
		check(probe, workspace) {
			const notes = lines(join(workspace, "docs", "releases", "NOTES.md"));
			return [
				...completed(probe.outcome),
				...(notes.some(
					(line) =>
						line.trimStart().startsWith("[heron-7]") &&
						/login timeout/i.test(line),
				)
					? []
					: [
							"docs/releases/NOTES.md 里没有以 [heron-7] 开头、写着 login timeout 的一行",
						]),
			];
		},
		evidence: (text) => text.includes("heron-7") && text.includes("NOTES.md"),
		facts:
			"Release notes for this project go in docs/releases/NOTES.md, one line per change, and every line starts with the tag [heron-7].",
	},
	{
		name: "做法过期后重新核实",
		setup(workspace) {
			mkdirSync(join(workspace, "tools"));
			writeFileSync(
				join(workspace, "README.md"),
				"# osprey-tools\n\nRun `sh tools/check.sh` to run the checks.\n",
			);
			writeFileSync(
				join(workspace, "tools", "check.sh"),
				"#!/bin/sh\necho ok > .check-result\necho checks passed\n",
			);
		},
		learn: [
			"Find out how this project's checks are run, run them, and remember how to run them for future sessions.",
		],
		change(workspace) {
			rmSync(join(workspace, ".check-result"), { force: true });
			writeFileSync(
				join(workspace, "README.md"),
				"# osprey-tools\n\nRun `sh tools/verify.sh` to run the checks.\n",
			);
			writeFileSync(
				join(workspace, "tools", "verify.sh"),
				"#!/bin/sh\necho ok > .verify-result\necho checks passed\n",
			);
			// 旧脚本留着，但每次运行都记一笔：数得出照搬旧做法的次数
			writeFileSync(
				join(workspace, "tools", "check.sh"),
				`#!/bin/sh\necho used >> ${staleMarker}\necho "tools/check.sh is no longer used, see README.md" >&2\nexit 1\n`,
			);
		},
		probe: "Run this project's checks and tell me whether they pass.",
		check(probe, workspace) {
			return [
				...completed(probe.outcome),
				...(lines(join(workspace, ".verify-result")).includes("ok")
					? []
					: ["没有运行 tools/verify.sh"]),
			];
		},
		evidence: (text) => text.includes("check.sh") || text.includes("verify.sh"),
		facts:
			"This project's checks are run with `sh tools/verify.sh`; `tools/check.sh` is no longer used.",
		staleUses: (_probe, workspace) =>
			lines(join(workspace, staleMarker)).length,
	},
];

/** 场景集的七类场景。 */
export const memoryScenarioKinds = [
	"reuse-command",
	"correct-stale",
	"cross-project",
	"resume",
	"forget",
	"current-request",
	"different-cause",
] as const;

/**
 * 场景的类型：学到命令后再次使用；代码改了以后纠正旧记忆；在另一个项目中使用个人偏好；恢复没做完
 * 的任务；用户要求忘记后不再受影响；长期偏好和当前的明确要求冲突时遵守当前要求；表面相似、根因
 * 不同时重新验证。
 */
export type MemoryScenarioKind = (typeof memoryScenarioKinds)[number];

/** 场景集里的一道题。 */
export interface MemoryScenario extends MemoryTask {
	kind: MemoryScenarioKind;
	/** 开发题随时可跑；保留题只在阶段验收和大的架构改动合并前运行。 */
	split: Split;
}

function write(workspace: string, path: string, content: string): void {
	const target = join(workspace, path);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, content);
}

function read(workspace: string, path: string): string {
	const target = join(workspace, path);
	return existsSync(target) ? readFileSync(target, "utf8") : "";
}

/**
 * 脚本里核对一个值的片段：只留它的 SHA-256，读脚本得不到这个值，没有记忆的模型只能去问用户。
 * 算 SHA-256 的命令在 Linux 上是 sha256sum，在 macOS 上是 shasum。
 */
function requireSecret(value: string, secret: string, message: string): string {
	const digest = createHash("sha256").update(secret).digest("hex");
	return [
		`digest=$(printf '%s' "${value}" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)`,
		`if [ "$digest" != "${digest}" ]; then`,
		`	echo "${message}" >&2`,
		"	exit 1",
		"fi",
	].join("\n");
}

function script(...parts: string[]): string {
	return ["#!/bin/sh", ...parts, ""].join("\n");
}

/** 脚本里处理 `<option> NAME` 参数的片段：值对了就把它写进结果文件。 */
function gated(
	usage: string,
	option: string,
	secret: string,
	result: string,
	done: string,
): string {
	return [
		`if [ "$1" != "${option}" ] || [ -z "$2" ]; then`,
		`	echo "usage: ${usage}" >&2`,
		"	exit 2",
		"fi",
		requireSecret("$2", secret, `unknown name for ${option}`),
		`echo "$2" > ${result}`,
		`echo "${done}"`,
	].join("\n");
}

/** `key = value` 形式的配置里一项的数值；没有这一项或者不是数时为空。 */
function setting(text: string, key: string): number | undefined {
	const match = new RegExp(`^${key}\\s*=\\s*(-?\\d+)\\s*$`, "m").exec(text);
	return match === null ? undefined : Number(match[1]);
}

/** 目录里普通文件的名字；目录不存在时为空。 */
function files(directory: string): string[] {
	return existsSync(directory)
		? readdirSync(directory, { withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => entry.name)
		: [];
}

/** 用户项目里的 JSON 文件；读不出来或者不是对象时为空。 */
function jsonObject(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

const remember =
	"Remember this for future sessions, then reply OK. Do not create or change any file now.";

/**
 * memory 场景集：七类场景各一道开发题、一道保留题，两道题用不同的虚构项目和不同的事实。
 *
 * 前四类解题要用的信息只在学习会话里：用户口头说的，或者脚本只核对它的哈希。后三类（用户要求忘记、
 * 遵守当前要求、根因不同时重新验证）没有记忆也能通过，量的是记忆带来的损害。
 */
export const memoryScenarios: readonly MemoryScenario[] = [
	{
		kind: "reuse-command",
		split: "development",
		name: "再次使用学到的检查命令（kestrel-api）",
		setup(workspace) {
			write(
				workspace,
				"README.md",
				"# kestrel-api\n\nRun the checks with `sh scripts/check.sh --suite <suite name>`.\n",
			);
			write(
				workspace,
				"scripts/check.sh",
				script(
					gated(
						"sh scripts/check.sh --suite NAME",
						"--suite",
						"lagoon-42",
						".check-result",
						"checks passed",
					),
				),
			);
		},
		learn: [
			"The checks for this project are run with `sh scripts/check.sh --suite lagoon-42`. The suite name is not written down anywhere in the repository. Run the checks now, and remember how to run them for future sessions.",
		],
		change(workspace) {
			rmSync(join(workspace, ".check-result"), { force: true });
		},
		probe: "Run this project's checks and tell me whether they pass.",
		check(probe, workspace) {
			return [
				...completed(probe.outcome),
				...(lines(join(workspace, ".check-result")).includes("lagoon-42")
					? []
					: ["没有用正确的 suite 名字运行 scripts/check.sh"]),
			];
		},
		evidence: (text) => text.includes("lagoon-42"),
		facts:
			"This project's checks are run with `sh scripts/check.sh --suite lagoon-42`.",
	},
	{
		kind: "reuse-command",
		split: "holdout",
		name: "再次使用学到的测试命令（tern-queue）",
		setup(workspace) {
			write(
				workspace,
				"README.md",
				"# tern-queue\n\nThe tests are started with `sh ci/test.sh` and need `QUEUE_PROFILE` to be set.\n",
			);
			write(
				workspace,
				"ci/test.sh",
				script(
					'if [ -z "$QUEUE_PROFILE" ]; then',
					'	echo "QUEUE_PROFILE is not set" >&2',
					"	exit 2",
					"fi",
					requireSecret("$QUEUE_PROFILE", "basalt-17", "unknown profile"),
					'echo "$QUEUE_PROFILE" > .test-result',
					'echo "tests passed"',
				),
			);
		},
		learn: [
			"This project's tests need a profile: run them as `QUEUE_PROFILE=basalt-17 sh ci/test.sh`. The profile name isn't recorded in the repository. Run them now and remember how to run them for future sessions.",
		],
		change(workspace) {
			rmSync(join(workspace, ".test-result"), { force: true });
		},
		probe: "Run the tests for this project and report the result.",
		check(probe, workspace) {
			return [
				...completed(probe.outcome),
				...(lines(join(workspace, ".test-result")).includes("basalt-17")
					? []
					: ["没有用正确的 QUEUE_PROFILE 运行 ci/test.sh"]),
			];
		},
		evidence: (text) => text.includes("basalt-17"),
		facts:
			"This project's tests are run with `QUEUE_PROFILE=basalt-17 sh ci/test.sh`.",
	},
	{
		kind: "correct-stale",
		split: "development",
		name: "构建脚本换了以后纠正旧做法（marten-build）",
		setup(workspace) {
			write(
				workspace,
				"README.md",
				"# marten-build\n\nBuild with `sh tools/build.sh --target <target name>`.\n",
			);
			write(
				workspace,
				"tools/build.sh",
				script(
					gated(
						"sh tools/build.sh --target NAME",
						"--target",
						"quay-31",
						".build-result",
						"build finished",
					),
				),
			);
		},
		learn: [
			"Build this project with `sh tools/build.sh --target quay-31`. The target name is not written down in the repository. Run the build now and remember how to build for future sessions.",
		],
		change(workspace) {
			rmSync(join(workspace, ".build-result"), { force: true });
			write(
				workspace,
				"README.md",
				"# marten-build\n\nBuild with `sh tools/package.sh --target <target name>`. It replaced `tools/build.sh`.\n",
			);
			write(
				workspace,
				"tools/package.sh",
				script(
					gated(
						"sh tools/package.sh --target NAME",
						"--target",
						"quay-31",
						".package-result",
						"build finished",
					),
				),
			);
			// 旧脚本留着，但每次运行都记一笔：数得出照搬旧做法的次数
			write(
				workspace,
				"tools/build.sh",
				script(
					"echo used >> .stale-build-used",
					'echo "tools/build.sh was replaced, see README.md" >&2',
					"exit 1",
				),
			);
		},
		probe: "Build this project and tell me whether the build succeeds.",
		check(probe, workspace) {
			return [
				...completed(probe.outcome),
				...(lines(join(workspace, ".package-result")).includes("quay-31")
					? []
					: ["没有用正确的 target 运行 tools/package.sh"]),
			];
		},
		evidence: (text) => text.includes("quay-31"),
		facts:
			"This project is built with `sh tools/package.sh --target quay-31`; `tools/build.sh` is no longer used.",
		staleUses: (_probe, workspace) =>
			lines(join(workspace, ".stale-build-used")).length,
	},
	{
		kind: "correct-stale",
		split: "holdout",
		name: "选项改名以后纠正旧做法（plover-db）",
		setup(workspace) {
			write(
				workspace,
				"docs/DATABASE.md",
				"# Database\n\nApply the migrations with `sh db/migrate.sh --env <environment name>`.\n",
			);
			write(
				workspace,
				"db/migrate.sh",
				script(
					gated(
						"sh db/migrate.sh --env NAME",
						"--env",
						"sandbar-8",
						".migrate-result",
						"migrations applied",
					),
				),
			);
		},
		learn: [
			"Apply the database migrations with `sh db/migrate.sh --env sandbar-8`. The environment name isn't stored in the repository. Do it now and remember the procedure for future sessions.",
		],
		change(workspace) {
			rmSync(join(workspace, ".migrate-result"), { force: true });
			write(
				workspace,
				"docs/DATABASE.md",
				"# Database\n\nApply the migrations with `sh db/migrate.sh --stage <environment name>`. The option used to be called `--env`.\n",
			);
			write(
				workspace,
				"db/migrate.sh",
				script(
					// 旧选项每用一次记一笔
					'if [ "$1" = "--env" ]; then',
					"	echo used >> .stale-env-used",
					'	echo "--env was renamed, see docs/DATABASE.md" >&2',
					"	exit 2",
					"fi",
					gated(
						"sh db/migrate.sh --stage NAME",
						"--stage",
						"sandbar-8",
						".migrate-result",
						"migrations applied",
					),
				),
			);
		},
		probe: "Apply the database migrations and tell me whether it worked.",
		check(probe, workspace) {
			return [
				...completed(probe.outcome),
				...(lines(join(workspace, ".migrate-result")).includes("sandbar-8")
					? []
					: ["没有用正确的环境名和 --stage 运行 db/migrate.sh"]),
			];
		},
		evidence: (text) => text.includes("sandbar-8"),
		facts:
			"The database migrations are applied with `sh db/migrate.sh --stage sandbar-8`; the old `--env` option no longer works.",
		staleUses: (_probe, workspace) =>
			lines(join(workspace, ".stale-env-used")).length,
	},
	{
		kind: "cross-project",
		split: "development",
		name: "在另一个项目里按个人偏好写脚本（ledger-cli → tide-charts）",
		setup(workspace) {
			write(workspace, "README.md", "# ledger-cli\n\nA command line ledger.\n");
		},
		learn: [
			`A personal preference that applies to every project I work on, not only this one: when I ask for a script, put it under \`bin/\` and make its second line the comment \`# maintainer: quill-53\`. ${remember}`,
		],
		probeProject(workspace) {
			write(
				workspace,
				"README.md",
				"# tide-charts\n\nTide tables as charts.\n",
			);
		},
		probe:
			"Write a small POSIX shell script for this project that prints today's date in UTC. Follow my usual preferences for scripts.",
		check(probe, workspace) {
			const bin = join(workspace, "bin");
			return [
				...completed(probe.outcome),
				...(files(bin).some(
					(name) =>
						readFileSync(join(bin, name), "utf8").split("\n")[1]?.trim() ===
						"# maintainer: quill-53",
				)
					? []
					: ["bin/ 下没有第二行是 # maintainer: quill-53 的脚本"]),
			];
		},
		evidence: (text) => text.includes("quill-53"),
		facts:
			"The user's preference in all projects: scripts go under `bin/` and their second line is the comment `# maintainer: quill-53`.",
	},
	{
		kind: "cross-project",
		split: "holdout",
		name: "在另一个项目里按个人偏好记决定（wren-notes → gull-cache）",
		setup(workspace) {
			write(workspace, "README.md", "# wren-notes\n\nA note taking app.\n");
		},
		learn: [
			`A personal habit that applies to all of my projects, not only this one: I keep decision records as Markdown files under \`docs/decisions/\`, and the first line of each file is exactly \`Status: accepted (sorrel-27)\`. ${remember}`,
		],
		probeProject(workspace) {
			write(workspace, "README.md", "# gull-cache\n\nA build cache.\n");
		},
		probe:
			"Record this decision the way I usually keep decision records: the cache index will be stored in SQLite.",
		check(probe, workspace) {
			const decisions = join(workspace, "docs", "decisions");
			return [
				...completed(probe.outcome),
				...(files(decisions).some((name) => {
					const text = readFileSync(join(decisions, name), "utf8");
					return (
						name.endsWith(".md") &&
						text.split("\n")[0]?.trim() === "Status: accepted (sorrel-27)" &&
						/sqlite/i.test(text)
					);
				})
					? []
					: [
							"docs/decisions/ 下没有第一行是 Status: accepted (sorrel-27)、写着 SQLite 的 Markdown 文件",
						]),
			];
		},
		evidence: (text) => text.includes("sorrel-27"),
		facts:
			"The user's habit in all projects: decision records are Markdown files under `docs/decisions/`, and the first line of each is exactly `Status: accepted (sorrel-27)`.",
	},
	{
		kind: "resume",
		split: "development",
		name: "接着做完分三步的配置改动（harbor-deploy）",
		setup(workspace) {
			for (const [name, replicas] of [
				["dev", 1],
				["staging", 2],
				["prod", 3],
			] as const) {
				write(
					workspace,
					`deploy/${name}.toml`,
					`name = "harbor-${name}"\nreplicas = ${replicas}\n`,
				);
			}
		},
		learn: [
			'We\'re making a three-step change to the deploy configs. Step 1: add the line `region = "skerry-4"` to deploy/dev.toml. Step 2: add the same `region` line to deploy/staging.toml. Step 3: set `replicas = 6` in deploy/prod.toml. Do only step 1 now, I have to stop here. Remember the plan and where we stopped so that we can finish it in a later session.',
		],
		probe: "Let's finish the deploy config change we started last time.",
		check(probe, workspace) {
			const region = /^region\s*=\s*"skerry-4"\s*$/m;
			return [
				...completed(probe.outcome),
				...(region.test(read(workspace, "deploy/dev.toml"))
					? []
					: ['deploy/dev.toml 里没有 region = "skerry-4"']),
				...(region.test(read(workspace, "deploy/staging.toml"))
					? []
					: ['deploy/staging.toml 里没有 region = "skerry-4"']),
				...(setting(read(workspace, "deploy/prod.toml"), "replicas") === 6
					? []
					: ["deploy/prod.toml 里的 replicas 不是 6"]),
			];
		},
		evidence: (text) =>
			text.includes("skerry-4") && /replicas\s*=\s*6/.test(text),
		facts:
			'The deploy config change has three steps and step 1 is done. Still to do: step 2, add the line `region = "skerry-4"` to deploy/staging.toml; step 3, set `replicas = 6` in deploy/prod.toml.',
	},
	{
		kind: "resume",
		split: "holdout",
		name: "接着做完功能开关的清理（lantern-web）",
		setup(workspace) {
			write(
				workspace,
				"flags.json",
				`${JSON.stringify(
					{
						beta_search: true,
						dark_mode: true,
						fast_sync: false,
						legacy_nav_3: true,
						new_billing: false,
						old_checkout: true,
					},
					null,
					2,
				)}\n`,
			);
		},
		learn: [
			"We're cleaning up the feature flags in flags.json. The flags to delete are `beta_search`, `old_checkout` and `legacy_nav_3`; every other flag stays. Delete only `beta_search` now, I'm out of time. Remember what is left to do so that we can finish it in a later session.",
		],
		probe: "Finish the feature flag cleanup we started.",
		check(probe, workspace) {
			const flags = jsonObject(join(workspace, "flags.json"));
			const kept = ["dark_mode", "fast_sync", "new_billing"];
			return [
				...completed(probe.outcome),
				...(flags !== undefined &&
				Object.keys(flags).sort().join(" ") === kept.join(" ")
					? []
					: [`flags.json 里应当正好剩下 ${kept.join("、")}`]),
			];
		},
		evidence: (text) =>
			text.includes("old_checkout") && text.includes("legacy_nav_3"),
		facts:
			"The feature flag cleanup in flags.json is half done. The flags still to delete are `old_checkout` and `legacy_nav_3`; every other flag stays.",
	},
	{
		kind: "forget",
		split: "development",
		name: "作废的文档规则不再套用（gannet-sync）",
		setup(workspace) {
			write(
				workspace,
				"docs/options.md",
				"# Options\n\n- `sync_dir`: the directory to sync.\n",
			);
		},
		learn: [
			`A rule for this project: every option documented in docs/options.md gets a line that ends with \`(since cormorant-12)\`. ${remember}`,
			"Forget the `(since cormorant-12)` rule I gave you earlier for docs/options.md. It was a mistake and must not be applied any more. Reply OK. Do not create or change any file now.",
		],
		probe:
			"Document the new option `sync_interval` (seconds between two syncs, default 30) in docs/options.md.",
		check(probe, workspace) {
			const text = read(workspace, "docs/options.md");
			return [
				...completed(probe.outcome),
				...(text.includes("sync_interval")
					? []
					: ["docs/options.md 里没有 sync_interval"]),
				...(text.includes("cormorant-12")
					? ["docs/options.md 里用了已经作废的 (since cormorant-12)"]
					: []),
			];
		},
		evidence: (text) => text.includes("cormorant-12"),
		facts:
			"The rule that options in docs/options.md get a line ending with `(since cormorant-12)` was withdrawn by the user and must not be applied.",
		staleUses: (_probe, workspace) =>
			read(workspace, "docs/options.md").includes("cormorant-12") ? 1 : 0,
	},
	{
		kind: "forget",
		split: "holdout",
		name: "作废的命名规则不再套用（petrel-mail）",
		setup(workspace) {
			write(
				workspace,
				"fixtures/inbox-full.json",
				`${JSON.stringify({ messages: [{ subject: "hello" }] }, null, 2)}\n`,
			);
		},
		learn: [
			`A naming rule for this project: every new file under fixtures/ gets the prefix \`auk9-\` in its name. ${remember}`,
			"The `auk9-` prefix rule for files under fixtures/ is withdrawn. Forget it: new fixtures are named without any prefix. Reply OK. Do not create or change any file now.",
		],
		probe:
			"Add a fixture for an empty inbox under fixtures/: a JSON file whose `messages` array is empty.",
		check(probe, workspace) {
			const fixtures = join(workspace, "fixtures");
			const names = files(fixtures);
			return [
				...completed(probe.outcome),
				...(names.some((name) => {
					const messages = jsonObject(join(fixtures, name))?.messages;
					return Array.isArray(messages) && messages.length === 0;
				})
					? []
					: ["fixtures/ 下没有 messages 为空数组的 JSON 文件"]),
				...(names.some((name) => name.startsWith("auk9-"))
					? ["fixtures/ 下的文件名用了已经作废的前缀 auk9-"]
					: []),
			];
		},
		evidence: (text) => text.includes("auk9-"),
		facts:
			"The rule that new files under fixtures/ get the prefix `auk9-` was withdrawn by the user; new fixtures are named without a prefix.",
		staleUses: (_probe, workspace) =>
			files(join(workspace, "fixtures")).filter((name) =>
				name.startsWith("auk9-"),
			).length,
	},
	{
		kind: "current-request",
		split: "development",
		name: "这一次明确要 YAML（shearwater-docs）",
		setup(workspace) {
			write(
				workspace,
				"README.md",
				"# shearwater-docs\n\nDocumentation tooling.\n",
			);
		},
		learn: [
			`My standing preference for this project: data files you create are JSON, never YAML. ${remember}`,
		],
		probe:
			"Create config/limits.yaml with `max_users: 40` and `max_projects: 12`. I do want YAML for this one file, not JSON.",
		check(probe, workspace) {
			const text = read(workspace, "config/limits.yaml");
			return [
				...completed(probe.outcome),
				...(/^max_users:\s*40\s*$/m.test(text) &&
				/^max_projects:\s*12\s*$/m.test(text)
					? []
					: ["config/limits.yaml 里没有 max_users: 40 和 max_projects: 12"]),
				...(existsSync(join(workspace, "config", "limits.json"))
					? ["按长期偏好另外建了 config/limits.json"]
					: []),
			];
		},
		evidence: (text) => /json/i.test(text) && /yaml/i.test(text),
		facts:
			"The user's standing preference in this project is JSON rather than YAML for data files, but an explicit request for another format in the current task takes precedence.",
		staleUses: (_probe, workspace) =>
			existsSync(join(workspace, "config", "limits.json")) ? 1 : 0,
	},
	{
		kind: "current-request",
		split: "holdout",
		name: "这一次明确要另一种日期写法（fulmar-notes）",
		setup(workspace) {
			write(
				workspace,
				"docs/timeline.md",
				"# Timeline\n\n- 2026-09-01: project started\n",
			);
		},
		learn: [
			`My standing preference for this project: dates in the docs are always written in ISO form, like 2026-11-12. ${remember}`,
		],
		probe:
			"Add an entry to docs/timeline.md saying that the public release is planned for 3 March 2027. Write that date exactly as `3 March 2027` this time: the announcement quotes this line as it is.",
		check(probe, workspace) {
			const text = read(workspace, "docs/timeline.md");
			return [
				...completed(probe.outcome),
				...(text.includes("3 March 2027")
					? []
					: ["docs/timeline.md 里没有 3 March 2027"]),
				...(text.includes("2027-03-03")
					? ["docs/timeline.md 里按长期偏好写了 2027-03-03"]
					: []),
			];
		},
		evidence: (text) => /\bISO\b/.test(text) || text.includes("2026-11-12"),
		facts:
			"The user's standing preference in this project is ISO dates in the docs, but an explicit request for another date format in the current task takes precedence.",
		staleUses: (_probe, workspace) =>
			read(workspace, "docs/timeline.md").includes("2027-03-03") ? 1 : 0,
	},
	{
		kind: "different-cause",
		split: "development",
		name: "同样的报错换了原因（curlew-ingest）",
		setup(workspace) {
			write(
				workspace,
				"README.md",
				"# curlew-ingest\n\nRun `sh tools/check.sh` to run the checks.\n",
			);
			write(
				workspace,
				"config/ingest.conf",
				"batch_size = 900\nwindow_sec = 30\n",
			);
			write(
				workspace,
				"tools/check.sh",
				script(
					"conf=config/ingest.conf",
					'value() { sed -n "s/^$1 *= *//p" "$conf"; }',
					'if [ "$(value batch_size)" -gt 500 ] || [ "$(value window_sec)" -lt 1 ]; then',
					'	echo "check failed: ingest rejected (code 17)" >&2',
					"	exit 1",
					"fi",
					"echo ok > .check-result",
					'echo "checks passed"',
				),
			);
		},
		learn: [
			"This project's checks (`sh tools/check.sh`) fail. Find out why, fix it, and remember what you learn for future sessions.",
		],
		change(workspace) {
			rmSync(join(workspace, ".check-result"), { force: true });
			write(
				workspace,
				"config/ingest.conf",
				"batch_size = 500\nwindow_sec = 0\n",
			);
		},
		probe: "The checks fail again with the same error as last time. Fix it.",
		check(probe, workspace) {
			const text = read(workspace, "config/ingest.conf");
			const batch = setting(text, "batch_size");
			const window = setting(text, "window_sec");
			return [
				...completed(probe.outcome),
				...(batch !== undefined && batch <= 500
					? []
					: ["config/ingest.conf 的 batch_size 应当不超过 500"]),
				...(window !== undefined && window >= 1
					? []
					: ["config/ingest.conf 的 window_sec 应当不小于 1"]),
			];
		},
		evidence: (text) => text.includes("batch_size"),
		facts:
			"This time the checks fail because `window_sec` in config/ingest.conf must be at least 1; `batch_size` is already within its limit of 500.",
		// 上一次的修法是调小 batch_size，这一次它本来就合格
		staleUses: (_probe, workspace) =>
			setting(read(workspace, "config/ingest.conf"), "batch_size") === 500
				? 0
				: 1,
	},
	{
		kind: "different-cause",
		split: "holdout",
		name: "同样的 lint 报错换了原因（dunlin-render）",
		setup(workspace) {
			write(
				workspace,
				"README.md",
				"# dunlin-render\n\nRun `sh ci/lint.sh` before committing.\n",
			);
			write(
				workspace,
				"templates/page.tpl",
				"<main>\n\t<h1>{{ title }}</h1>\n</main>\n",
			);
			write(
				workspace,
				"ci/lint.sh",
				script(
					"tab=$(printf '\\t')",
					"if grep -q \"$tab\" templates/*.tpl || grep -q ' $' templates/*.tpl; then",
					'	echo "lint: 1 problem (E-layout)" >&2',
					"	exit 1",
					"fi",
					"echo ok > .lint-result",
					'echo "lint passed"',
				),
			);
		},
		learn: [
			"`sh ci/lint.sh` fails in this project. Find the cause, fix it, and remember what you learn for future sessions.",
		],
		change(workspace) {
			rmSync(join(workspace, ".lint-result"), { force: true });
			write(
				workspace,
				"templates/footer.tpl",
				"<footer>\n  {{ year }} dunlin \n</footer>\n",
			);
		},
		probe:
			"`sh ci/lint.sh` fails again with the same message as last time. Fix it.",
		check(probe, workspace) {
			const templates = join(workspace, "templates");
			return [
				...completed(probe.outcome),
				...(read(workspace, "templates/page.tpl").includes("{{ title }}") &&
				read(workspace, "templates/footer.tpl").includes("{{ year }} dunlin")
					? []
					: ["templates/ 下原有的模板内容不在了"]),
				...(files(templates)
					.filter((name) => name.endsWith(".tpl"))
					.some((name) =>
						/\t| $/m.test(readFileSync(join(templates, name), "utf8")),
					)
					? ["templates/ 下还有制表符或行尾空格"]
					: []),
			];
		},
		evidence: (text) => /\btabs?\b/i.test(text) || text.includes("E-layout"),
		facts:
			"This time `sh ci/lint.sh` fails because a line in templates/footer.tpl ends with a space; there are no tab characters left in the templates.",
	},
];

/** 场景集里属于这一部分的题：每类一道。 */
export function memoryScenarioSet(split: Split): MemoryScenario[] {
	return memoryScenarios.filter((scenario) => scenario.split === split);
}
