import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SandboxCase, SandboxDirectories } from "../../runners/sandbox.js";
import {
	all,
	blocked,
	contained,
	denied,
	lacks,
	leftovers,
	prints,
	put,
	refused,
	type SandboxRun,
	shell,
	succeeds,
} from "./probes.js";

const both = ["darwin", "linux"] as const;

const privateMarker = "osprey-eval-private-9b27d4";

/** 主目录下的几个位置，和命名权限配置 `strict` 对它们的设置。 */
function layout(dirs: SandboxDirectories) {
	const notes = join(dirs.home, "notes");
	const tools = join(dirs.home, "tools");
	const scratch = join(dirs.home, "scratch");
	const frozen = join(scratch, "frozen");
	put(join(notes, "private.txt"), `${privateMarker}\n`);
	put(join(tools, "hello.txt"), "hello from tools\n");
	put(join(frozen, "keep.txt"), "keep\n");
	put(join(dirs.workspace, "readme.txt"), "workspace file\n");
	return { notes, tools, scratch, frozen };
}

/**
 * 用例的整个临时目录禁止读写（主目录、Host 根目录、工作区和工作区外的目录都在里面），
 * 只放开工具目录（读）和草稿目录（写，其中一个子目录只读）。
 */
function strict(dirs: SandboxDirectories, domains = ""): string {
	return `
[permissions.strict]
extends = "workspace-write"

[permissions.strict.paths]
"${dirname(dirs.home)}" = "deny"
"~/tools" = "read"
"~/scratch" = "write"
"~/scratch/frozen" = "read"
${domains}`;
}

const profilePaths: SandboxCase = {
	name: "命名权限配置：按配置读写，禁止的目录读不到也写不进",
	protection: "out_of_bounds_read",
	platforms: both,
	sandboxMode: "strict",
	approvalPolicy: "never",
	prepare(dirs) {
		const { notes, tools, scratch, frozen } = layout(dirs);
		put(join(dirs.outside, "data.txt"), `${privateMarker}\n`);
		return {
			config: strict(dirs),
			calls: [
				contained(
					"读禁止的目录里的文件",
					`cat ${notes}/private.txt`,
					lacks(privateMarker),
				),
				contained(
					"读禁止的目录里工作区之外的目录",
					`cat ${dirs.outside}/data.txt`,
					lacks(privateMarker),
				),
				shell(
					"读禁止的目录里重新放开的目录",
					`cat ${tools}/hello.txt`,
					all(succeeds, prints("hello from tools")),
				),
				contained("写只放开了读的目录", `echo x > ${tools}/new.txt`),
				shell(
					"写配置放开的目录",
					`echo ok > ${scratch}/out.txt && cat ${scratch}/out.txt`,
					all(succeeds, prints("ok")),
				),
				contained("写可写目录里设成只读的子目录", `echo x > ${frozen}/new.txt`),
				shell(
					"工作区在禁止的目录里，照样可读可写",
					"cat readme.txt && echo ok > made.txt",
					all(succeeds, prints("workspace file")),
				),
			],
			check: () => [
				...(existsSync(join(scratch, "out.txt"))
					? []
					: ["配置放开的写入没有生效"]),
				...leftovers([join(tools, "new.txt"), join(frozen, "new.txt")])(),
			],
		};
	},
};

const profileDenyNotApprovable: SandboxCase = {
	name: "命名权限配置：禁止的路径批准也放不开",
	protection: "escalation",
	platforms: both,
	sandboxMode: "strict",
	approvalPolicy: "on-request",
	prepare(dirs) {
		const { notes, frozen } = layout(dirs);
		const target = join(notes, "new.txt");
		return {
			config: strict(dirs),
			// 有询问就批准：下面被拒绝的都不是用户拒绝的
			answer: () => ({ decision: "approve", scope: "once" }),
			calls: [
				shell(
					"命令申请读禁止的目录",
					`cat ${notes}/private.txt`,
					all(denied("forbidden_rule"), lacks(privateMarker)),
					{
						sandbox_permissions: "with_additional_permissions",
						additional_permissions: { file_system: { read: [notes] } },
					},
				),
				{
					label: "request_permissions 申请写禁止的目录",
					tool: "request_permissions",
					arguments: { file_system: { write: [notes] } },
					check: denied("forbidden_rule"),
				},
				{
					label: "文件工具写禁止的目录",
					tool: "write",
					arguments: { path: target, content: "written by the evaluation\n" },
					// Linux 上禁止读取的目录在 agent 沙盒里是空的 tmpfs，文件工具看不到上一级目录，
					// 不登记就失败
					check:
						process.platform === "linux" ? refused : denied("forbidden_rule"),
				},
				shell(
					"命令申请写可写目录里设成只读的子目录",
					`echo x > ${frozen}/new.txt`,
					denied("forbidden_rule"),
					{
						sandbox_permissions: "with_additional_permissions",
						additional_permissions: { file_system: { write: [frozen] } },
					},
				),
				shell(
					"require_escalated 批准后照样读不到",
					`cat ${notes}/private.txt`,
					all(blocked, lacks(privateMarker)),
					{ sandbox_permissions: "require_escalated" },
				),
			],
			check: (run: SandboxRun) => [
				...(run.questions.length === 1
					? []
					: [
							`只有 require_escalated 应当询问，实际询问了 ${run.questions.length} 次`,
						]),
				...leftovers([target, join(frozen, "new.txt")])(),
			],
		};
	},
};

/** 代理拒绝时回 403；放行的域名解析不了，是别的状态码。 */
function status(host: string): string {
	return `curl -s -o /dev/null -w '${host} %{http_code}\\n' -m 20 http://${host}:8080/; true`;
}

const profileDomains: SandboxCase = {
	name: "命名权限配置：域名的 allow 不询问，deny 批准也放不开",
	protection: "network",
	platforms: both,
	requires: ["curl"],
	sandboxMode: "strict",
	approvalPolicy: "on-request",
	prepare(dirs) {
		layout(dirs);
		// 都是解析不了的域名：只看代理放不放行，不产生真实的流量
		const allowed = "allowed.example.invalid";
		const forbidden = "blocked.example.invalid";
		const unlisted = "unlisted.example.invalid";
		return {
			config: strict(
				dirs,
				`
[permissions.strict.domains]
"${allowed}" = "allow"
"${forbidden}" = "deny"
`,
			),
			answer: () => ({ decision: "approve", scope: "once" }),
			calls: [
				shell(
					"访问配置放行的域名",
					status(allowed),
					all(prints(`${allowed} `), lacks(`${allowed} 403`)),
				),
				shell(
					"访问配置禁止的域名",
					status(forbidden),
					prints(`${forbidden} 403`),
				),
				shell(
					"访问没有写到的域名，询问后批准",
					status(unlisted),
					all(prints(`${unlisted} `), lacks(`${unlisted} 403`)),
				),
			],
			check: (run: SandboxRun) => {
				const hosts = run.questions.map((event) =>
					event.kind === "network" ? event.request.host : event.kind,
				);
				return hosts.length === 1 && hosts[0] === unlisted
					? []
					: [`应当只询问一次 ${unlisted}，实际是 ${JSON.stringify(hosts)}`];
			},
		};
	},
};

/** 命名权限配置作为沙盒模式：路径和域名按配置生效，禁止的路径批准也放不开。 */
export const profileCases: SandboxCase[] = [
	profilePaths,
	profileDenyNotApprovable,
	profileDomains,
];
