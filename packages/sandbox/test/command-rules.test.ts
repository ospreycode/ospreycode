import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
	type AdditionalPermissions,
	type CommandContext,
	type CommandRule,
	decideCommand,
	type GranularApproval,
	granularCategories,
	type PermissionDecision,
	type RuleFile,
	suggestedRule,
} from "@ospreycode/sandbox";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	type CommandFixture,
	createCommandFixture,
} from "./command-fixture.js";

let fixture: CommandFixture;
beforeAll(async () => {
	fixture = await createCommandFixture();
});
afterAll(() => {
	fixture.remove();
});

const allow: PermissionDecision = { action: "allow" };

/** `local_binding` 的询问理由：要说明放开的是本机所有端口，并且能在所有网卡上监听。 */
const asksPorts = expect.stringMatching(
	/^申请监听和连接本机端口：.*本机所有端口.*所有网卡上监听/,
);

/** 在工作区根目录执行这条命令时的判断。 */
function decide(
	command: string,
	rules: RuleFile[] = [],
	context: Partial<CommandContext> = {},
): PermissionDecision {
	return decideCommand(
		fixture.command(command),
		fixture.context({ rules, ...context }),
	);
}

/** 这条命令带着额外权限的申请时的判断。 */
function decideWith(
	command: string,
	permissions: AdditionalPermissions,
	rules: RuleFile[],
	context: Partial<CommandContext> = {},
): PermissionDecision {
	return decideCommand(
		fixture.command(command, {
			sandbox_permissions: "with_additional_permissions",
			additional_permissions: permissions,
		}),
		fixture.context({ rules, ...context }),
	);
}

/** `granular` 下只关闭这几个类别。 */
function granular(...off: (keyof GranularApproval)[]): Partial<CommandContext> {
	return {
		approvalPolicy: "granular",
		granular: Object.fromEntries(
			granularCategories.map((category) => [category, !off.includes(category)]),
		) as GranularApproval,
	};
}

const never: Partial<CommandContext> = { approvalPolicy: "never" };
const fullAccess: Partial<CommandContext> = {
	sandboxMode: "danger-full-access",
};
const forbiddenRule = { action: "deny", reason: "forbidden_rule" };
const policy = { action: "deny", reason: "policy" };

describe("forbidden 和 prompt 规则", () => {
	const noRm = () =>
		fixture.rules("repo", {
			rules: [
				{
					pattern: ["rm"],
					decision: "forbidden",
					justification: "Move files to .trash/ instead.",
				},
			],
		});

	test("重定向和 sh -c 绕不过 forbidden", () => {
		for (const command of ["rm -r build/ 2>/dev/null", "sh -c 'rm -rf x'"]) {
			expect(decide(command, [noRm()]), command).toMatchObject(forbiddenRule);
		}
	});

	test("按文件名、不分大小写匹配，穿过包装命令", () => {
		for (const command of [
			"rm x",
			"/bin/rm x",
			"./rm x",
			"RM x",
			"'r'm x",
			"env A=1 rm x",
			"nohup rm x",
			"timeout -s KILL 5 rm x",
			"nice -n 10 rm x",
			"command rm x",
			"exec rm x",
			"time rm x",
			"ls | xargs -n 1 rm",
			String.raw`find . -name '*.log' -exec rm {} \;`,
			"env nohup timeout 5 rm x",
			"busybox rm x",
		]) {
			expect(decide(command, [noRm()]), command).toMatchObject(forbiddenRule);
		}
	});

	test("控制流、命令替换、子 shell、trap 和脚本参数里的命令也算", () => {
		for (const command of [
			"if test -d x; then rm x; fi",
			"for f in a b; do rm $f; done",
			"echo $(rm x)",
			"echo `rm x`",
			"(cd x && rm y)",
			"make || { rm x; }",
			"trap 'rm x' EXIT",
			"bash -lc 'make && rm x'",
			'eval "rm x"',
			"sh -c \"bash -c 'rm x'\"",
			"cat <<EOF\n$(rm x)\nEOF",
		]) {
			expect(decide(command, [noRm()]), command).toMatchObject(forbiddenRule);
		}
	});

	test("只是提到这个词的命令不受影响", () => {
		for (const command of ["echo rm x", "git rm x", "rmdir x", "ls rm"]) {
			expect(decide(command, [noRm()]), command).toEqual(allow);
		}
	});

	test("forbidden 规则的 justification 写进给模型的拒绝原因", () => {
		const decision = decide("make && rm x", [noRm()]);
		expect(decision).toMatchObject(forbiddenRule);
		expect(decision).toHaveProperty(
			"message",
			"`rm x` is blocked by a `forbidden` permission rule. Move files to .trash/ instead.",
		);
	});

	test("prompt 规则每次执行前询问，理由取 justification", () => {
		const rules = [
			fixture.rules("user", {
				rules: [
					{
						pattern: ["gh", "pr", ["view", "list"]],
						decision: "prompt",
						justification: "查看 PR 前先确认",
					},
					{ pattern: ["make", "deploy"], decision: "prompt" },
				],
			}),
		];
		const ask = {
			action: "ask",
			category: "rules",
			categories: ["rules"],
			reasons: ["查看 PR 前先确认"],
		};
		expect(decide("gh pr view 7888", rules)).toEqual(ask);
		expect(decide("gh pr list --web | head", rules)).toEqual(ask);
		expect(decide("gh pr --repo openai/codex view 7888", rules)).toEqual(allow);
		expect(decide("gh pr create", rules)).toEqual(allow);
		expect(decide("env X=1 make deploy", rules)).toEqual({
			action: "ask",
			category: "rules",
			categories: ["rules"],
			reasons: ["权限规则要求执行前询问：make deploy"],
		});
	});

	test("多条规则同时匹配时取最严的", () => {
		const rules = [
			fixture.rules("user", {
				rules: [
					{ pattern: ["git"], decision: "allow" },
					{ pattern: ["git", "push"], decision: "prompt" },
				],
			}),
			fixture.rules("repo", {
				rules: [{ pattern: ["git", "push", "--force"], decision: "forbidden" }],
			}),
		];
		expect(decide("git status", rules)).toEqual(allow);
		expect(decide("git push origin main", rules)).toMatchObject({
			action: "ask",
			category: "rules",
		});
		expect(decide("git push --force", rules)).toMatchObject(forbiddenRule);
		// 一段命中 allow、另一段命中 forbidden
		expect(decide("git status && git push --force", rules)).toMatchObject(
			forbiddenRule,
		);
	});

	test("danger-full-access 下规则照样生效", () => {
		expect(decide("rm x", [noRm()], fullAccess)).toMatchObject(forbiddenRule);
		const prompt = fixture.rules("repo", {
			rules: [{ pattern: ["make", "deploy"], decision: "prompt" }],
		});
		expect(decide("make deploy", [prompt], fullAccess)).toMatchObject({
			action: "ask",
			category: "rules",
		});
	});
});

describe("危险命令判断", () => {
	const forced = (command: string) => ({
		action: "ask",
		category: "sandbox_approval",
		categories: ["dangerous_command"],
		reasons: [`强制删除：${command}`],
	});

	test("强制删除先询问，不管选项怎么写", () => {
		for (const command of [
			"rm -f x",
			"rm -rf build/",
			"rm -fr build/",
			"rm -Rf build/",
			"rm -r -f build/",
			"rm -v --force x",
			"rm --forc x",
			"rm build/ -rf",
			"RM -rf build/",
			"/bin/rm -rf build/",
		]) {
			expect(decide(command), command).toEqual(forced(command));
		}
	});

	test("穿过包装命令和脚本参数", () => {
		for (const [command, deletion] of [
			["env A=1 rm -rf build/", "rm -rf build/"],
			["nohup rm -rf build/ &", "rm -rf build/"],
			["timeout 10 rm -rf build/", "rm -rf build/"],
			["ls | xargs rm -f", "rm -f"],
			[String.raw`find . -name '*.o' -exec rm -f {} \;`, "rm -f {}"],
			["bash -lc 'cd build && rm -rf out'", "rm -rf out"],
			["test -d build && rm -rf build/ 2>/dev/null", "rm -rf build/"],
			["rm -rf $BUILD_DIR/out", "rm -rf $BUILD_DIR/out"],
		] as const) {
			expect(decide(command), command).toEqual(forced(deletion));
		}
	});

	test("不带强制选项的删除不问", () => {
		for (const command of [
			"rm x",
			"rm -r build/",
			"rm -i -- -f",
			"rmdir -p a/b",
			"git rm -f x",
			"echo rm -rf x",
		]) {
			expect(decide(command), command).toEqual(allow);
		}
	});

	test("never 和关闭 sandbox_approval 时直接拒绝；danger-full-access 下照样询问", () => {
		// 类别里危险命令判断单独记，不和越界申请混在 sandbox_approval 里
		const refused = { ...policy, categories: ["dangerous_command"] };
		expect(decide("rm -rf build/", [], never)).toMatchObject(refused);
		expect(
			decide("rm -rf build/", [], granular("sandbox_approval")),
		).toMatchObject(refused);
		expect(decide("rm -rf build/", [], granular("rules"))).toEqual(
			forced("rm -rf build/"),
		);
		expect(decide("rm -rf build/", [], fullAccess)).toEqual(
			forced("rm -rf build/"),
		);
	});

	test("用户级和启动参数的 allow 规则盖过它，前缀不用写 -f", () => {
		for (const source of ["user", "startup"] as const) {
			// 评测时的权限规则文件只有这一条
			const rules = [
				fixture.rules(source, {
					rules: [{ pattern: ["rm"], decision: "allow" }],
				}),
			];
			for (const command of [
				"rm -rf build/",
				"rm -rf build/ 2>/dev/null",
				"rm -rf $BUILD_DIR/out",
				"rm -rf build/*",
				"cd build && rm -rf out",
				"/bin/rm -f x",
				"ls | xargs rm -f",
				"bash -c 'rm -rf build/'",
			]) {
				expect(decide(command, rules, never), command).toEqual(allow);
			}
		}
	});

	test("仓库来源的 allow、不是规则里那个程序的 rm、eval 和有语法错误的脚本盖不过", () => {
		const rule: CommandRule = { pattern: ["rm"], decision: "allow" };
		const user = [fixture.rules("user", { rules: [rule] })];
		// 仓库里的文件写 allow 加载不了；就算有也不算数
		const repo: RuleFile = {
			path: "/repo/.ospreycode/rules/x.toml",
			source: "repo",
			rules: { rules: [rule], network_rules: [], mcp_rules: [] },
		};
		expect(decide("rm -rf build/", [repo])).toEqual(forced("rm -rf build/"));

		fixture.executable(join(fixture.workspace, "rm"));
		expect(decide("./rm -rf build/", user)).toEqual(forced("./rm -rf build/"));
		expect(decide("eval 'rm -rf build/'", user)).toEqual(
			forced("rm -rf build/"),
		);
		expect(decide("rm -rf build/ && (", user)).toMatchObject({
			action: "ask",
			category: "sandbox_approval",
		});
		// 规则前缀位置上的词执行时还会被展开，就不算命中
		const objects = [
			fixture.rules("user", {
				rules: [{ pattern: ["rm", "*.o"], decision: "allow" }],
			}),
		];
		expect(decide("rm '*.o' -f", objects)).toEqual(allow);
		expect(decide("rm *.o -f", objects)).toEqual(forced("rm *.o -f"));
		// 只为别的命令写的 allow 不管用
		const git = [
			fixture.rules("user", {
				rules: [{ pattern: ["git"], decision: "allow" }],
			}),
		];
		expect(decide("git status && rm -rf build/", git)).toEqual(
			forced("rm -rf build/"),
		);
	});
});

describe("allow 规则和越界申请", () => {
	const localBinding: AdditionalPermissions = { local_binding: true };
	const npmTest = () =>
		fixture.rules("user", {
			rules: [
				{
					pattern: ["npm", "test"],
					decision: "allow",
					permissions: { local_binding: true },
				},
			],
		});
	const asksBinding = {
		action: "ask",
		category: "sandbox_approval",
		categories: ["sandbox_approval"],
		reasons: [asksPorts],
	};

	test("申请的额外权限在 allow 规则声明的范围内时不询问", () => {
		expect(decideWith("npm test", localBinding, [])).toEqual(asksBinding);
		expect(decideWith("npm test", localBinding, [npmTest()])).toEqual(allow);
		expect(
			decideWith("npm test -- --watch=false", localBinding, [npmTest()], never),
		).toEqual(allow);
		expect(decideWith("npm run build", localBinding, [npmTest()])).toEqual(
			asksBinding,
		);
	});

	test("超出规则声明的权限和 require_escalated 照常询问", () => {
		const outside = join(fixture.home, "data");
		expect(
			decideWith(
				"npm test",
				{ local_binding: true, file_system: { write: [outside] } },
				[npmTest()],
			),
		).toEqual({
			action: "ask",
			category: "sandbox_approval",
			categories: ["sandbox_approval"],
			reasons: [`申请写入 ${outside}`, asksPorts],
		});
		// 没声明权限的 allow 规则不免去任何越界申请
		const bare = fixture.rules("user", {
			rules: [{ pattern: ["npm", "test"], decision: "allow" }],
		});
		expect(decideWith("npm test", localBinding, [bare])).toEqual(asksBinding);
		expect(
			decideCommand(
				fixture.command("npm test", {
					sandbox_permissions: "require_escalated",
					justification: "要跑端到端测试",
				}),
				fixture.context({ rules: [npmTest()] }),
			),
		).toEqual({
			action: "ask",
			category: "sandbox_approval",
			categories: ["sandbox_approval"],
			reasons: ["申请在沙盒的文件限制之外运行这条命令"],
		});
	});

	test("规则里的 $WORKSPACE/、~/ 和 ssh-agent", () => {
		const gitPush = fixture.rules("user", {
			rules: [
				{
					pattern: ["git", "push"],
					decision: "allow",
					permissions: {
						file_system: {
							read: ["~/.ssh/known_hosts"],
							write: ["$WORKSPACE/.git"],
						},
						unix_sockets: ["ssh-agent"],
					},
				},
			],
		});
		const request = (write: string, socket = "ssh-agent") =>
			decideWith(
				"git push origin main",
				{
					file_system: {
						read: [join(fixture.home, ".ssh/known_hosts")],
						write: [write],
					},
					unix_sockets: [socket],
				},
				[gitPush],
			);
		expect(request(join(fixture.workspace, ".git"))).toEqual(allow);
		expect(request(join(fixture.workspace, ".git/refs"))).toEqual(allow);
		expect(request(join(fixture.home, "other/.git"))).toMatchObject({
			action: "ask",
		});
		expect(
			request(join(fixture.workspace, ".git"), "/var/run/docker.sock"),
		).toMatchObject({ action: "ask" });
	});

	test("申请的路径经符号链接指到声明的范围之外时照常询问", () => {
		const git = join(fixture.workspace, ".git");
		mkdirSync(git);
		symlinkSync(fixture.home, join(git, "out"));
		const rule = fixture.rules("user", {
			rules: [
				{
					pattern: ["git", "fetch"],
					decision: "allow",
					permissions: { file_system: { write: ["$WORKSPACE/.git"] } },
				},
			],
		});
		const request = (path: string) =>
			decideWith("git fetch", { file_system: { write: [path] } }, [rule]);
		expect(request(join(git, "objects"))).toEqual(allow);
		expect(request(join(git, "out"))).toMatchObject({ action: "ask" });
		expect(request(join(git, "../src"))).toMatchObject({ action: "ask" });
	});

	test("整段都是普通的词、每一段都命中 allow 才算", () => {
		const rules = [
			npmTest(),
			fixture.rules("startup", {
				rules: [
					{
						pattern: ["git", ["status", "diff"]],
						decision: "allow",
						permissions: { local_binding: true },
					},
				],
			}),
		];
		for (const command of [
			"npm test && git status",
			"git diff; npm test | git status || npm test",
			"bash -lc 'npm test && git status'",
			'sh -c "npm test"',
		]) {
			expect(decideWith(command, localBinding, rules), command).toEqual(allow);
		}
		for (const command of [
			"npm test && make",
			"npm test && git push",
			"npm test > out.txt",
			"npm test 2>&1 | git status",
			"CI=1 npm test",
			"npm test $EXTRA",
			"npm test src/*.test.ts",
			"npm test ~/src",
			"npm test $(git status)",
			"(npm test)",
			"npm test &",
			"env npm test",
			"bash -lc 'npm test > out.txt'",
			'bash -lc "npm test $EXTRA"',
			"eval 'npm test'",
			"npm test && (",
		]) {
			expect(decideWith(command, localBinding, rules), command).toMatchObject({
				action: "ask",
				category: "sandbox_approval",
			});
		}
	});

	test("每一段命中的规则都要声明申请的权限", () => {
		const rules = [
			npmTest(),
			fixture.rules("user", {
				rules: [{ pattern: ["git", "status"], decision: "allow" }],
			}),
		];
		expect(decideWith("npm test && git status", localBinding, rules)).toEqual(
			asksBinding,
		);
	});

	test("danger-full-access 下没有沙盒可越，越界申请不问", () => {
		expect(decideWith("make", localBinding, [], fullAccess)).toEqual(allow);
		expect(
			decideCommand(
				fixture.command("make", { sandbox_permissions: "require_escalated" }),
				fixture.context(fullAccess),
			),
		).toEqual(allow);
	});
});

describe("可执行文件的身份", () => {
	const localBinding: AdditionalPermissions = { local_binding: true };
	const rules = () => [
		fixture.rules("user", {
			rules: ["x", "git", "ls"].map((name) => ({
				pattern: [name],
				decision: "allow",
				permissions: { local_binding: true },
			})),
		}),
	];
	const matches = (command: string, context: Partial<CommandContext> = {}) =>
		decideWith(command, localBinding, rules(), context).action === "allow";

	test("只写命令名时按 PATH 查到的文件判断", () => {
		expect(matches("x --flag")).toBe(true);
		expect(matches("git status")).toBe(true);
		// PATH 里没有这个命令
		expect(matches("x", { path: "/bin:/usr/bin" })).toBe(false);
		expect(matches("X")).toBe(false);
	});

	test("工作区和临时目录里的同名程序不匹配", () => {
		const local = join(fixture.workspace, "node_modules/.bin/x");
		const tmp = join(fixture.sessionTmp, "x/git");
		fixture.executable(local);
		fixture.executable(tmp);
		expect(matches("./node_modules/.bin/x")).toBe(false);
		expect(matches("node_modules/.bin/x")).toBe(false);
		expect(matches(local)).toBe(false);
		expect(matches(`${tmp} status`)).toBe(false);
	});

	test("写成路径时要等于 PATH 的查找结果，或者在系统目录里", () => {
		expect(matches(join(fixture.tools, "x"))).toBe(true);
		expect(matches(`${join(fixture.tools, "git")} status`)).toBe(true);
		expect(matches("../../tools/bin/x")).toBe(true);
		// 不在 PATH 里的另一份 git，即使 agent 写不了也不算
		const other = join(fixture.home, "opt/git");
		fixture.executable(other);
		expect(matches(`${other} status`)).toBe(false);
		expect(matches("~/opt/git status")).toBe(false);
		// 系统目录里的不经 PATH 也认，但文件名要对得上
		expect(matches("/bin/ls -l", { path: fixture.tools })).toBe(true);
		expect(matches("/bin/cat x", { path: fixture.tools })).toBe(false);
		expect(matches("/bin/nonexistent", { path: fixture.tools })).toBe(false);
	});

	test("PATH 上排在前面的目录 agent 可写时，查到的同名程序不算", () => {
		const bin = join(fixture.workspace, "bin");
		fixture.executable(join(bin, "x"));
		const path = `${bin}:${fixture.tools}:/bin`;
		expect(matches("x", { path })).toBe(false);
		expect(matches(join(fixture.tools, "x"), { path })).toBe(false);
		// 别的命令不受影响
		expect(matches("git status", { path })).toBe(true);
		// PATH 里的相对目录按工作目录解析
		expect(matches("x", { path: `bin:${fixture.tools}` })).toBe(false);
	});

	test("agent 可写的范围不随沙盒模式变化", () => {
		const rm = [
			fixture.rules("user", {
				rules: [{ pattern: ["rm"], decision: "allow" }],
			}),
		];
		fixture.executable(join(fixture.workspace, "rm"));
		// 没有沙盒时工作区照样算 agent 可写：里面的 rm 不是规则里那个命令，盖不过危险命令判断
		expect(decide("rm -rf build/", rm, fullAccess)).toEqual(allow);
		expect(decide("./rm -rf build/", rm, fullAccess)).toMatchObject({
			action: "ask",
			category: "sandbox_approval",
		});
	});
});

describe("内置的 forbidden", () => {
	/** 最宽的配置：没有沙盒，用户还为这些命令写了 allow。 */
	const wideOpen = (): Partial<CommandContext> => ({
		...fullAccess,
		rules: [
			fixture.rules("user", {
				rules: [
					{
						pattern: [["sudo", "rm", "dd", "cat", "claude", "mkfs.ext4"]],
						decision: "allow",
					},
				],
			}),
		],
	});
	const denied = (command: string) => {
		const decision = decide(command, [], wideOpen());
		expect(decision, command).toMatchObject(forbiddenRule);
		expect(decide(command), command).toMatchObject(forbiddenRule);
		return decision;
	};

	test("提权，包装命令和脚本里的也算", () => {
		for (const command of [
			"sudo make install",
			"su -c 'make install'",
			"doas make install",
			"pkexec make install",
			"SUDO make install",
			"/usr/bin/sudo -n true",
			"env sudo make install",
			"timeout 5 sudo ls",
			"bash -c 'sudo make install'",
			"echo $(sudo id)",
			"make && sudo make install",
			"ls | xargs sudo rm",
		]) {
			denied(command);
		}
		expect(denied("make && sudo make install")).toHaveProperty(
			"message",
			"`sudo make install` is forbidden: commands cannot elevate privileges with `sudo`. Run the command without `sudo`.",
		);
		expect(decide("command -v sudo")).toEqual(allow);
		expect(decide("man sudo")).toEqual(allow);
	});

	test("删除根目录和它的直接子目录", () => {
		for (const command of [
			"rm -rf /",
			"rm -rf /*",
			"rm -rf /usr",
			"rm -r /etc/",
			"rm -rf --no-preserve-root /",
			"rm -rf /usr/../",
			"rm -rf build/ /usr",
			"find . -exec rm -rf / \\;",
		]) {
			denied(command);
		}
	});

	test("删除主目录、工作区根目录或它们的上级", () => {
		for (const command of [
			"rm -rf ~",
			"rm -rf ~/",
			"rm -rf $HOME",
			'rm -rf "$HOME"',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash 的写法，不是漏了反引号
			"rm -rf ${HOME}/",
			"rm -rf ~/*",
			`rm -rf ${fixture.home}`,
			`rm -rf ${join(fixture.home, "..")}`,
			"rm -rf .",
			"rm -rf ./",
			"rm -rf ..",
			"rm -rf ../*",
			`rm -rf ${fixture.workspace}`,
			"rm -rf $HOME/work",
			"rm -r ~/work/",
			"rm -rf ~/work/sub/../..",
		]) {
			denied(command);
		}
	});

	test("工作区里面的、主目录里别的目录，以及展开不了的目标交给危险命令判断", () => {
		for (const command of [
			"rm -rf build/",
			"rm -rf ./src/*",
			// 通配删的是工作区里面的东西，工作区根目录还在
			"rm -rf *",
			"rm -rf ./*.log",
			"rm -rf ~/work/build",
			"rm -rf ~/other",
			"rm -rf $BUILD_DIR",
			'rm -rf "$(pwd)"',
			"rm -rf ~user",
			'rm -rf "~"',
			"rm -rf /nonexistent-osp-dir",
			"rm -rf /usr/local/x",
		]) {
			expect(decide(command), command).toMatchObject({
				action: "ask",
				category: "sandbox_approval",
			});
		}
		expect(decide("rm -r build/")).toEqual(allow);
	});

	test("删除 Host 根目录或其中不属于这个沙盒的部分", () => {
		for (const command of [
			"rm -rf ~/.ospreycode",
			"rm -rf ~/.ospreycode/data",
			"rm -rf ~/.ospreycode/tmp",
			"rm -rf ~/.ospreycode/tmp/*",
			"rm -rf ../.ospreycode/data/x",
		]) {
			denied(command);
		}
		expect(decide("rm -r ~/.ospreycode/tmp/s1/build")).toEqual(allow);
		expect(decide("rm -rf ~/.ospreycode/tmp/s1/*")).toMatchObject({
			action: "ask",
		});
	});

	test("写磁盘设备", () => {
		for (const command of [
			"mkfs.ext4 /dev/sda1",
			"mkfs -t ext4 /dev/sda1",
			"newfs_apfs /dev/disk2s1",
			"wipefs -a /dev/sda",
			"fdisk /dev/sda",
			"diskutil eraseDisk JHFS+ Untitled /dev/disk2",
			"diskutil secureErase 0 /dev/disk2",
			"dd if=/dev/zero of=/dev/disk2 bs=1m",
			"dd of=/dev/sda if=image.iso",
			"dd if=image.iso of=/dev/rdisk2",
			"echo x > /dev/disk2",
			"cat image.iso >> /dev/sda",
			"cat image.iso | tee x > /dev/nvme0n1",
		]) {
			denied(command);
		}
		for (const command of [
			"dd if=/dev/zero of=image.bin bs=1m count=1",
			"dd if=/dev/disk2 of=image.bin",
			"echo x > /dev/null",
			"make 2>/dev/stderr",
			"diskutil list",
			"cat < /dev/disk2",
		]) {
			expect(decide(command), command).toEqual(allow);
		}
	});

	test("参数或重定向目标落在 Host 根目录或凭据位置里", () => {
		for (const command of [
			"cat ~/.ospreycode/config.toml",
			"ls $HOME/.ospreycode",
			`ls ${fixture.hostRoot}/`,
			"cat ../.ospreycode/data/sessions.db",
			"grep -r token ~/.ospreycode/",
			"cp -r ~/.ospreycode/data .",
			"tar -czf x.tgz --directory=~/.ospreycode data",
			"ls ~/.ospreycode/tmp",
			"ls ~/.ospreycode/tmp/s1/..",
			"ls ~/.ospreycode/*",
			"echo x > ~/.ospreycode/config.toml",
			"cat < ~/.ospreycode/data/auth.json",
			"cat ~/.ssh/id_ed25519",
			"cat ../.ssh/id_ed25519",
			"cp ~/.ssh/id_ed25519 .",
			"echo key >> ~/.ssh/authorized_keys",
			"bash -c 'cat ~/.ssh/id_ed25519'",
			"echo $(cat ~/.ssh/id_ed25519)",
		]) {
			denied(command);
		}
		for (const command of [
			"ls ~/.ospreycode/tmp/s1",
			"cat ~/.ospreycode/tmp/s1/out.txt > out.txt",
			"echo x > ~/.ospreycode/tmp/s1/x",
			"ls ~",
			"cat ~/.sshrc",
			"echo '~/.ospreycode'",
			"git commit -m 'explain ~/.ssh/config handling'",
		]) {
			expect(decide(command), command).toEqual(allow);
		}
	});

	test("经符号链接到达的位置也认得出", () => {
		mkdirSync(join(fixture.home, ".ssh/keys"));
		symlinkSync(fixture.home, join(fixture.workspace, "h"));
		symlinkSync(join(fixture.home, ".ssh/keys"), join(fixture.workspace, "k"));
		for (const command of [
			"cat h/.ospreycode/data/x",
			"cat h/.ssh/id_ed25519",
			"echo x >> h/.ssh/authorized_keys",
			"cat k/id_ed25519",
			// `..` 按链接解析后的位置取上级
			"cat k/../id_ed25519",
			"rm -rf h/work",
			"rm -r h/.ospreycode/data",
			// 末尾带斜杠时指的是链接指向的目录
			"rm -rf h/",
		]) {
			denied(command);
		}
		// 删的是链接本身
		expect(decide("rm h")).toEqual(allow);
		expect(decide("ls h/other")).toEqual(allow);
	});

	// macOS 默认的文件系统不区分大小写
	test.skipIf(!existsSync("/TMP"))("大小写不同的写法也认得出", () => {
		for (const command of [
			"cat ~/.SSH/id_ed25519",
			"cat ~/.OspreyCode/data/x",
			"rm -rf ~/WORK",
			`rm -rf ${fixture.home.toUpperCase()}`,
			"rm -rf /USR",
		]) {
			denied(command);
		}
	});

	test("脚本里换过目录后相对路径不判断，绝对路径照样判断", () => {
		expect(decide("cd .. && cat .ospreycode/data/x")).toEqual(allow);
		denied("cd .. && cat ~/.ospreycode/data/x");
		denied("cd / && rm -rf ~");
	});

	test("关掉权限检查或沙盒来启动 agent CLI", () => {
		for (const command of [
			"claude --dangerously-skip-permissions",
			"claude -p 'fix it' --dangerously-skip-permissions",
			"codex --dangerously-bypass-approvals-and-sandbox exec 'fix it'",
			"claude --permission-mode bypassPermissions -p hi",
			"claude --permission-mode=bypassPermissions",
			"codex exec --sandbox danger-full-access 'fix it'",
			"gemini --yolo",
			"npx -y @anthropic-ai/claude-code@latest --dangerously-skip-permissions",
			"pnpm dlx @openai/codex --dangerously-bypass-approvals-and-sandbox",
			"/opt/homebrew/bin/Claude --dangerously-skip-permissions",
			"env CI=1 claude --dangerously-skip-permissions",
			"timeout 600 claude -p hi --dangerously-skip-permissions",
			"bash -lc 'codex --dangerously-bypass-approvals-and-sandbox'",
		]) {
			denied(command);
		}
		for (const command of [
			"claude -p 'fix it'",
			"claude --permission-mode plan",
			"codex exec --sandbox workspace-write 'fix it'",
			"grep -r -- --dangerously-skip-permissions docs/",
			"echo claude --dangerously-skip-permissions",
		]) {
			expect(decide(command), command).not.toMatchObject(forbiddenRule);
		}
	});
});

describe("几个要问的原因", () => {
	const rules = () => [
		fixture.rules("repo", {
			rules: [
				{
					pattern: ["make", "deploy"],
					decision: "prompt",
					justification: "部署前先确认",
				},
			],
		}),
	];
	const escalated = (command: string, context: Partial<CommandContext> = {}) =>
		decideWith(command, { local_binding: true }, rules(), context);

	test("合成一次询问，原因都列出；有 prompt 规则时类别是 rules", () => {
		expect(escalated("make deploy")).toEqual({
			action: "ask",
			category: "rules",
			categories: ["rules", "sandbox_approval"],
			reasons: ["部署前先确认", asksPorts],
		});
		expect(escalated("rm -rf dist/ && make deploy")).toEqual({
			action: "ask",
			category: "rules",
			categories: ["rules", "dangerous_command", "sandbox_approval"],
			reasons: ["部署前先确认", "强制删除：rm -rf dist/", asksPorts],
		});
		expect(escalated("rm -rf dist/ && make")).toEqual({
			action: "ask",
			category: "sandbox_approval",
			categories: ["dangerous_command", "sandbox_approval"],
			reasons: ["强制删除：rm -rf dist/", asksPorts],
		});
		// 同一个原因只列一次
		expect(decide("make deploy; make deploy", rules())).toEqual({
			action: "ask",
			category: "rules",
			categories: ["rules"],
			reasons: ["部署前先确认"],
		});
	});

	test("被审批策略拒绝时列出要询问的全部类别，危险命令判断、prompt 规则和越界申请分得开", () => {
		const refused = (...categories: string[]) => ({ ...policy, categories });
		expect(decide("make deploy", rules(), never)).toEqual({
			...refused("rules"),
			message: expect.stringContaining("`never`"),
		});
		expect(decide("rm -rf dist/", rules(), never)).toMatchObject(
			refused("dangerous_command"),
		);
		expect(escalated("make", never)).toMatchObject(refused("sandbox_approval"));
		expect(escalated("rm -rf dist/ && make deploy", never)).toMatchObject(
			refused("rules", "dangerous_command", "sandbox_approval"),
		);
		// granular 下危险命令判断和越界申请都由 sandbox_approval 决定问不问，结果里照样分开
		expect(
			decide("rm -rf dist/", rules(), granular("sandbox_approval")),
		).toEqual({
			...refused("dangerous_command"),
			message: expect.stringContaining("`sandbox_approval`"),
		});
		expect(escalated("make", granular("sandbox_approval"))).toMatchObject(
			refused("sandbox_approval"),
		);
		// 只关了其中一类时，这次调用要问的类别仍然全部列出，说明里写的是关掉的那一类
		expect(
			decide("rm -rf dist/ && make deploy", rules(), granular("rules")),
		).toEqual({
			...refused("rules", "dangerous_command"),
			message: expect.stringContaining("`rules`"),
		});
	});

	test("granular 下涉及的类别有一个关闭就拒绝", () => {
		expect(escalated("make deploy", granular("rules"))).toMatchObject(policy);
		expect(
			escalated("make deploy", granular("sandbox_approval")),
		).toMatchObject(policy);
		expect(escalated("make deploy", granular("mcp_tools"))).toMatchObject({
			action: "ask",
			category: "rules",
		});
		// 只命中 prompt 规则时不受 sandbox_approval 影响，反过来也一样
		expect(
			decide("make deploy", rules(), granular("sandbox_approval")),
		).toMatchObject({ action: "ask", category: "rules" });
		expect(decide("make deploy", rules(), granular("rules"))).toMatchObject(
			policy,
		);
		expect(escalated("make", granular("rules"))).toMatchObject({
			action: "ask",
			category: "sandbox_approval",
		});
	});

	test("never 下要问的都拒绝", () => {
		expect(decide("make deploy", rules(), never)).toMatchObject(policy);
		expect(escalated("make", never)).toMatchObject(policy);
		expect(decide("make", rules(), never)).toEqual(allow);
	});
});

// 要解析 2000 段随机脚本，机器忙的时候默认的 5 秒不够
test("模型写出的任何脚本都能判断，不会抛错", { timeout: 20_000 }, () => {
	const tokens = [
		..."'\"`(){}[];&|<>#!=$~*\\\n\t\0",
		...["$(", "${", "((", "))", "[[", "]]", "&&", "||", "<<", "<<<", "2>&1"],
		...["if", "then", "fi", "for", "in", "do", "done", "case", "esac"],
		...["rm", "-rf", "sudo", "bash", "-c", "eval", "trap", "env", "xargs"],
		...["find", "-exec", "dd", "of=/dev/sda", "$HOME", "..", "/", "x", "你"],
		...["EOF", "function", "$'", "\\x", "time", "cd", "git", "~/.ssh"],
	];
	// 固定种子的伪随机数（mulberry32），失败时能重现
	let seed = 20261110;
	const next = (bound: number) => {
		seed = (seed + 0x6d2b79f5) | 0;
		let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) % bound;
	};
	const rules = [
		fixture.rules("user", {
			rules: [
				{ pattern: ["git"], decision: "allow" },
				{ pattern: ["find"], decision: "prompt" },
				{ pattern: ["dd"], decision: "forbidden" },
			],
		}),
	];
	for (let round = 0; round < 2000; round++) {
		let command = "";
		for (let length = 1 + next(12); length > 0; length--) {
			command += tokens[next(tokens.length)] + (next(5) < 3 ? " " : "");
		}
		const request = fixture.command(command, {
			sandbox_permissions: "with_additional_permissions",
			additional_permissions: { local_binding: true },
			prefix_rule: ["git", "status"],
		});
		const context = fixture.context({ rules });
		expect(() => {
			decideCommand(request, context);
			suggestedRule(request, context);
		}, JSON.stringify(command)).not.toThrow();
	}
});
