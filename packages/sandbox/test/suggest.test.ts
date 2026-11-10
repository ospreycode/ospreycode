import { join } from "node:path";
import {
	type AdditionalPermissions,
	type CommandRule,
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

const binding: AdditionalPermissions = { local_binding: true };

/** 模型为这条命令申请监听本机端口，并建议保存这个前缀。 */
function suggest(
	command: string,
	prefix: string[] | undefined,
	rules: RuleFile[] = [],
): CommandRule | undefined {
	return suggestedRule(
		fixture.command(command, {
			sandbox_permissions: "with_additional_permissions",
			additional_permissions: binding,
			...(prefix === undefined ? {} : { prefix_rule: prefix }),
		}),
		fixture.context({ rules }),
	);
}

/** `suggest` 的建议被接受时要保存的规则。 */
const saved = (pattern: string[]): CommandRule => ({
	pattern,
	decision: "allow",
	permissions: binding,
});

/** 模型为这条命令申请额外权限，并建议保存这个前缀。 */
function suggestWith(
	command: string,
	prefix: string[],
	permissions: AdditionalPermissions,
): CommandRule | undefined {
	return suggestedRule(
		fixture.command(command, {
			sandbox_permissions: "with_additional_permissions",
			additional_permissions: permissions,
			prefix_rule: prefix,
		}),
		fixture.context(),
	);
}

/**
 * 把前缀的第一个词放进 PATH 里的工具目录，再用前缀本身当命令：这样建议被拒只可能是因为前缀
 * 本身不接受，而不是可执行文件找不到。
 */
function suggestInstalled(prefix: string[]): CommandRule | undefined {
	fixture.executable(join(fixture.tools, prefix[0]));
	return suggest(prefix.join(" "), prefix);
}

describe("建议的规则", () => {
	test("能覆盖整条命令的前缀可以保存为 allow 规则", () => {
		expect(suggest("npm test", ["npm", "test"])).toEqual(
			saved(["npm", "test"]),
		);
		expect(suggest("npm test -- --watch=false", ["npm", "test"])).toEqual(
			saved(["npm", "test"]),
		);
		expect(suggest("gh pr view 7888 | gh pr list", ["gh", "pr"])).toEqual(
			saved(["gh", "pr"]),
		);
		expect(suggestInstalled(["cargo", "build"])).toEqual(
			saved(["cargo", "build"]),
		);
		expect(suggest("npm test", undefined)).toBeUndefined();
		expect(suggest("npm test", [])).toBeUndefined();
	});

	test("这次申请的额外权限写进规则，工作区里的路径写成 $WORKSPACE/", () => {
		const known = join(fixture.home, ".ssh/known_hosts");
		expect(
			suggestWith("git push origin main", ["git", "push"], {
				file_system: {
					read: [known],
					write: [join(fixture.workspace, ".git")],
				},
				unix_sockets: ["ssh-agent"],
			}),
		).toEqual({
			pattern: ["git", "push"],
			decision: "allow",
			permissions: {
				file_system: { read: [known], write: ["$WORKSPACE/.git"] },
				unix_sockets: ["ssh-agent"],
			},
		});
	});

	test("申请完全越出沙盒的命令不提供建议：规则声明不了这项权限，保存了下次照样询问", () => {
		expect(
			suggestedRule(
				fixture.command("npm test", {
					sandbox_permissions: "require_escalated",
					prefix_rule: ["npm", "test"],
				}),
				fixture.context(),
			),
		).toBeUndefined();
	});

	test("shell 和解释器不接受，带了脚本参数、版本号或 .exe 也一样", () => {
		for (const prefix of [
			["bash"],
			["bash", "-lc"],
			["sh", "-c"],
			["zsh"],
			["dash", "build.sh"],
			["fish"],
			["python"],
			["python3", "-c"],
			["python3", "manage.py", "test"],
			["python3.12", "manage.py"],
			["Python.exe", "manage.py"],
			["pypy3"],
			["node", "build.js"],
			["node22", "build.js"],
			["perl", "-e"],
			["ruby", "script.rb"],
			["php", "-r"],
			["lua"],
			["osascript"],
			["pwsh", "-Command"],
			["cmd.exe", "/c"],
			["awk"],
			["Rscript", "analysis.R"],
			["julia", "-e"],
			// 既是解释器又是工具链的也按命令名拒绝
			["bun", "test"],
			["deno", "task"],
		]) {
			expect(suggestInstalled(prefix), prefix.join(" ")).toBeUndefined();
		}
	});

	test("把后面的参数当命令执行的包装命令和脚本运行器不接受", () => {
		for (const prefix of [
			["env"],
			["sudo"],
			["timeout", "60"],
			["nice"],
			["nohup"],
			["xargs"],
			["watch"],
			["setsid"],
			["time"],
			["find", "."],
			["npx", "tsc"],
			["bunx", "tsc"],
			["uvx", "ruff"],
			["mise", "exec"],
			["direnv", "exec"],
			["npm", "exec"],
			["pnpm", "dlx"],
			["uv", "run"],
			["docker", "run"],
		]) {
			expect(suggestInstalled(prefix), prefix.join(" ")).toBeUndefined();
		}
		// 同一个命令的其他子命令可以
		expect(suggestInstalled(["mise", "install"])).toBeDefined();
		expect(suggestInstalled(["docker", "ps"])).toBeDefined();
	});

	test("npm run 这类只拒绝没写脚本名的前缀", () => {
		for (const runner of ["npm", "pnpm", "yarn"]) {
			expect(suggestInstalled([runner, "run"]), runner).toBeUndefined();
			expect(suggestInstalled([runner, "run", "build"]), runner).toEqual(
				saved([runner, "run", "build"]),
			);
		}
		expect(suggest("npm run build", ["npm", "run"])).toBeUndefined();
	});

	test("git 必须带子命令，子命令前不能有全局选项", () => {
		expect(suggest("git status", ["git"])).toBeUndefined();
		for (const [command, prefix] of [
			["git -C /srv/repo status", ["git", "-C", "/srv/repo", "status"]],
			["git -c core.pager=cat log", ["git", "-c", "core.pager=cat", "log"]],
			["git --git-dir=x/.git status", ["git", "--git-dir=x/.git", "status"]],
			["git --work-tree . status", ["git", "--work-tree", ".", "status"]],
			["git --exec-path=bin status", ["git", "--exec-path=bin"]],
		] as const) {
			expect(suggest(command, [...prefix]), command).toBeUndefined();
		}
		expect(suggest("git status --short", ["git", "status"])).toEqual(
			saved(["git", "status"]),
		);
	});

	test("第一个词写成路径的不接受", () => {
		const npm = join(fixture.tools, "npm");
		expect(suggest(`${npm} test`, [npm, "test"])).toBeUndefined();
		expect(suggest("./x", ["./x"])).toBeUndefined();
	});

	test("破坏性命令、命中内置规则或危险命令判断的命令不提供建议", () => {
		for (const prefix of [
			["rm"],
			["rm", "-rf"],
			["rmdir"],
			["shred"],
			["dd"],
		]) {
			expect(suggestInstalled(prefix), prefix.join(" ")).toBeUndefined();
		}
		expect(
			suggest("npm test && rm -rf dist/", ["npm", "test"]),
		).toBeUndefined();
		expect(
			suggest("git status ~/.ospreycode/data", ["git", "status"]),
		).toBeUndefined();
		expect(
			suggest("npm test > ~/.ssh/authorized_keys", ["npm", "test"]),
		).toBeUndefined();
	});

	test("带 heredoc 或换行的命令不提供建议", () => {
		expect(suggest("npm test <<EOF\nx\nEOF", ["npm", "test"])).toBeUndefined();
		expect(suggest("npm test\nnpm test", ["npm", "test"])).toBeUndefined();
		expect(suggest("git status 'a\nb'", ["git", "status"])).toBeUndefined();
	});

	test("不能覆盖每一段的建议丢掉", () => {
		for (const command of [
			"npm run build",
			"npm test && make",
			"npm test | tail -20",
			"npm test > out.txt",
			"CI=1 npm test",
			"npm test $EXTRA",
			"env npm test",
			"eval 'npm test'",
			"./node_modules/.bin/npm test",
		]) {
			expect(suggest(command, ["npm", "test"]), command).toBeUndefined();
		}
		// bash -c 的脚本拆开后每一段都能覆盖
		expect(suggest("bash -lc 'npm test && npm test'", ["npm", "test"])).toEqual(
			saved(["npm", "test"]),
		);
	});

	test("已有规则能匹配的建议丢掉", () => {
		const prompt = fixture.rules("repo", {
			rules: [{ pattern: ["npm", "test"], decision: "prompt" }],
		});
		expect(suggest("npm test", ["npm", "test"], [prompt])).toBeUndefined();
		const forbidden = fixture.rules("repo", {
			rules: [{ pattern: ["npm"], decision: "forbidden" }],
		});
		expect(suggest("npm test", ["npm", "test"], [forbidden])).toBeUndefined();

		// 已有的 allow 已经免去了这次询问：再存一条没有用
		const allowed = fixture.rules("user", {
			rules: [{ pattern: ["npm"], decision: "allow", permissions: binding }],
		});
		expect(suggest("npm test", ["npm", "test"], [allowed])).toBeUndefined();
		// 已有的 allow 没声明这次申请的权限：新规则把权限带上
		const bare = fixture.rules("user", {
			rules: [{ pattern: ["npm"], decision: "allow" }],
		});
		expect(suggest("npm test", ["npm", "test"], [bare])).toEqual(
			saved(["npm", "test"]),
		);
	});
});
