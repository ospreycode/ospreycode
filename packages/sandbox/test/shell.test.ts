import {
	loadShellParser,
	type ShellCommand,
	type ShellParser,
	type ShellScript,
} from "@ospreycode/sandbox";
import { beforeAll, describe, expect, test } from "vitest";

let parser: ShellParser;
beforeAll(async () => {
	parser = await loadShellParser();
});

/** 命令的词：字面值，不是字面值的写成 undefined。 */
function values(command: ShellCommand): (string | undefined)[] {
	return command.words.map((word) => word.value);
}

/** 脚本里每条命令的词，用空格连起来；不是字面值的词用源码里的写法。 */
function lines(script: ShellScript): string[] {
	return script.commands.map((command) =>
		command.words.map((word) => word.value ?? word.text).join(" "),
	);
}

describe("字面命令", () => {
	test("控制流、命令替换、子 shell 和函数体里的命令都找得到", () => {
		expect(
			lines(
				parser.parse(
					"if test -d x; then rm -rf x; elif a; then b; else c; fi; " +
						"for f in *.txt; do rm -f $f; done; " +
						"while read l; do echo $l; done; " +
						"case $x in a) git status;; esac; " +
						"echo $(date) `whoami` <(cat z) | (cd /tmp && ls); " +
						"f() { make; }; ! grep -q x y; { a1; b1; } & wait",
				),
			),
		).toEqual([
			"test -d x",
			"rm -rf x",
			"a",
			"b",
			"c",
			"rm -f $f",
			"read l",
			"echo $l",
			"git status",
			"echo $(date) `whoami` <(cat z)",
			"date",
			"whoami",
			"cat z",
			"cd /tmp",
			"ls",
			"make",
			"grep -q x y",
			"a1",
			"b1",
			"wait",
		]);
	});

	test("变量赋值前缀和重定向不算命令的词", () => {
		const script = parser.parse("A=1 B=$(id) env >out 2>&1 <in");
		expect(lines(script)).toEqual(["env", "id"]);
		expect(
			script.redirects.map(({ operator, target }) => [operator, target.value]),
		).toEqual([
			[">", "out"],
			[">&", "1"],
			["<", "in"],
		]);
	});

	test("重定向之后的词仍然是命令的参数", () => {
		const script = parser.parse("rm >/dev/null -rf build/ | cat");
		expect(lines(script)).toEqual(["rm -rf build/", "cat"]);
		expect(script.redirects.map(({ target }) => target.value)).toEqual([
			"/dev/null",
		]);
	});

	test("heredoc 正文里的命令替换也找得到", () => {
		const script = parser.parse("cat <<EOF\n$(rm -rf x)\nEOF");
		expect(lines(script)).toEqual(["cat", "rm -rf x"]);
	});
});

describe("词", () => {
	test("去掉引号和转义后得到字面值", () => {
		const [command] = parser.parse(
			String.raw`"rm" r\m 'r'"m" $'r\x6d' "a \"b\" \$c" a\ b "x  y" ''`,
		).commands;
		expect(values(command)).toEqual([
			"rm",
			"rm",
			"rm",
			"rm",
			'a "b" $c',
			"a b",
			"x  y",
			"",
		]);
	});

	test("带变量、命令替换的词不是字面值，但各部分分得清", () => {
		const [command] = parser.parse(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash 的写法，不是漏了反引号
			'echo "$HOME/x" ${HOME}/y "  $(pwd)  z" ${x:-1} ~/a "~/a" *.txt',
		).commands;
		expect(values(command)).toEqual([
			"echo",
			undefined,
			undefined,
			undefined,
			undefined,
			"~/a",
			"~/a",
			"*.txt",
		]);
		expect(command.words.slice(1).map((word) => word.parts)).toEqual([
			[
				{ kind: "variable", name: "HOME" },
				{ kind: "literal", text: "/x", quoted: true },
			],
			[
				{ kind: "variable", name: "HOME" },
				{ kind: "literal", text: "/y", quoted: false },
			],
			[
				{ kind: "literal", text: "  ", quoted: true },
				{ kind: "dynamic" },
				{ kind: "literal", text: "  z", quoted: true },
			],
			[{ kind: "dynamic" }],
			[{ kind: "literal", text: "~/a", quoted: false }],
			[{ kind: "literal", text: "~/a", quoted: true }],
			[{ kind: "literal", text: "*.txt", quoted: false }],
		]);
	});
});

describe("包装命令", () => {
	/** 一层层去掉包装后的命令。 */
	function unwrapped(command: ShellCommand): string[] {
		return command.wrapped.flatMap((inner) => [
			inner.words.map((word) => word.value ?? word.text).join(" "),
			...unwrapped(inner),
		]);
	}

	test("跳过包装命令自己的选项、时长和变量赋值", () => {
		const inner = (script: string) =>
			unwrapped(parser.parse(script).commands[0]);
		expect(inner("timeout -k 5 10s nice -n 5 rm -rf x")).toEqual([
			"nice -n 5 rm -rf x",
			"rm -rf x",
		]);
		expect(inner("env -i -u A B=1 C=2 nohup make all")).toEqual([
			"nohup make all",
			"make all",
		]);
		expect(inner("sudo -u root -E rm x")).toEqual(["rm x"]);
		expect(inner("xargs -0 -n 1 -I{} rm -f {}")).toEqual(["rm -f {}"]);
		expect(inner("stdbuf -oL setsid exec time -p ls")).toEqual([
			"setsid exec time -p ls",
			"exec time -p ls",
			"time -p ls",
			"ls",
		]);
		expect(inner("command rm x")).toEqual(["rm x"]);
	});

	test("find 的每个 -exec 各是一条命令", () => {
		const [command] = parser.parse(
			String.raw`find . -name '*.pyc' -exec rm -f {} \; -o -execdir echo {} +`,
		).commands;
		expect(unwrapped(command)).toEqual(["rm -f {}", "echo {}"]);
	});

	test("不执行命令的用法不算包装", () => {
		for (const script of ["command -v sudo", "env", "exec 3>&1", "xargs"]) {
			expect(parser.parse(script).commands[0].wrapped).toEqual([]);
		}
	});
});

describe("脚本参数", () => {
	test("bash -c、sh -c、eval 和 trap 的字面脚本递归解析", () => {
		const nested = (script: string) => {
			const [command] = parser.parse(script).commands;
			return [
				command.script?.via,
				command.script && lines(command.script.body),
			];
		};
		expect(nested("bash -lc 'cd x && rm -rf y'")).toEqual([
			"shell",
			["cd x", "rm -rf y"],
		]);
		expect(nested('sh -e -c "rm -rf x" arg0')).toEqual(["shell", ["rm -rf x"]]);
		expect(nested("bash -o pipefail -c 'a | b'")).toEqual([
			"shell",
			["a", "b"],
		]);
		expect(nested("eval rm -rf 'x y'")).toEqual(["eval", ["rm -rf x y"]]);
		expect(nested("trap 'rm -rf /tmp/x' EXIT INT")).toEqual([
			"trap",
			["rm -rf /tmp/x"],
		]);
	});

	test("包装命令里的 shell 也解析它的脚本", () => {
		const [command] = parser.parse("xargs -I{} sh -c 'rm -rf {}'").commands;
		const [shell] = command.wrapped;
		expect(shell.script && lines(shell.script.body)).toEqual(["rm -rf {}"]);
	});

	test("不是字面值的脚本和不带 -c 的调用没有可解析的脚本", () => {
		for (const script of [
			'bash -c "$CMD"',
			"bash build.sh -c x",
			'eval "$(ssh-agent)"',
			"trap - EXIT",
			"trap EXIT",
		]) {
			expect(parser.parse(script).commands[0].script).toBeUndefined();
		}
	});
});

describe("整段的性质", () => {
	test("只由普通的词和 &&、||、;、| 连接的脚本，各段按顺序列出", () => {
		const script = parser.parse(
			`git status && npm test -- --watch=false | tail -20 || echo 'a b'; ls "x y"/'*.ts';`,
		);
		expect(script.plain).toBe(true);
		expect(lines(script)).toEqual([
			"git status",
			"npm test -- --watch=false",
			"tail -20",
			"echo a b",
			"ls x y/*.ts",
		]);
	});

	test("带重定向、变量、命令替换、子 shell、后台运行等的脚本不算普通", () => {
		for (const script of [
			"npm test > out.txt",
			"npm test 2>&1",
			"echo $HOME",
			'echo "$(date)"',
			"FOO=1 npm test",
			"(npm test)",
			"npm test &",
			"npm test |& cat",
			"if true; then npm test; fi",
			"cat <<< x",
			"npm test # 注释",
			"",
		]) {
			expect(parser.parse(script).plain, script).toBe(false);
		}
	});

	test("执行时还会被 bash 展开的词不算普通", () => {
		for (const script of [
			"ls *.ts",
			"ls src/?.ts",
			"ls [ab].ts",
			"ls {a,b}.ts",
			'ls {a,"b"}.ts',
			"echo {1..3}",
			"ls ~",
			"ls ~/src",
			"ls ~user/src",
			"make PREFIX=~/opt",
			"l* -l",
		]) {
			expect(parser.parse(script).plain, script).toBe(false);
		}
		// 加了引号就是字面值；find 的 {} 和词中间的 ~ 不展开
		for (const script of [
			"ls '*.ts' \"{a,b}\" '~'",
			String.raw`ls \*.ts`,
			String.raw`find . -name x -exec echo {} \;`,
			"git diff HEAD~1 HEAD^",
		]) {
			expect(parser.parse(script).plain, script).toBe(true);
		}
	});

	test("语法错误记在结果里，能认出的命令照样列出", () => {
		const script = parser.parse('rm -rf "x');
		expect(script.hasError).toBe(true);
		expect(lines(script)).toEqual(["rm -rf x"]);
		expect(parser.parse("echo ok").hasError).toBe(false);
	});

	test("heredoc 和换行", () => {
		expect(parser.parse("cat <<EOF\nx\nEOF").multiline).toBe(true);
		expect(parser.parse("a\nb").multiline).toBe(true);
		expect(parser.parse('git commit -m "a\nb"').multiline).toBe(true);
		expect(parser.parse("a; b").multiline).toBe(false);
	});
});

/**
 * Codex 的 `try_parse_word_only_commands_sequence` 的测试用例（openai/codex rust-v0.167.0 的
 * `codex-rs/shell-command/src/bash.rs`，Apache-2.0）：两边用同一套语法，结果应当一致。
 */
describe("和 Codex 的解析对照", () => {
	/** 整段是普通的命令时各段的词，否则没有结果。 */
	function sequence(script: string): (string | undefined)[][] | undefined {
		const parsed = parser.parse(script);
		return parsed.plain && !parsed.hasError
			? parsed.commands.map(values)
			: undefined;
	}

	test("Codex 接受的脚本，各段的词相同", () => {
		for (const [script, expected] of [
			["ls -1", [["ls", "-1"]]],
			[
				"ls && pwd; echo 'hi there' | wc -l",
				[["ls"], ["pwd"], ["echo", "hi there"], ["wc", "-l"]],
			],
			['echo "hello world"', [["echo", "hello world"]]],
			["echo 'hi there'", [["echo", "hi there"]]],
			[
				'git commit -m "line1\nline2"',
				[["git", "commit", "-m", "line1\nline2"]],
			],
			[`echo "/usr"'/'"local"/bin`, [["echo", "/usr/local/bin"]]],
			[`echo '/usr'"/"'local'/bin`, [["echo", "/usr/local/bin"]]],
			["echo 123 456", [["echo", "123", "456"]]],
			['rg -n "foo" -g"*.py"', [["rg", "-n", "foo", "-g*.py"]]],
			["grep -n 'pattern' -g'*.txt'", [["grep", "-n", "pattern", "-g*.txt"]]],
			['rg -g"*.py" pattern', [["rg", "-g*.py", "pattern"]]],
			[String.raw`echo "\n"`, [["echo", String.raw`\n`]]],
			[
				`echo "~HOME" 'HEAD~1' "HEAD^" 'foo#bar' "=sh" 'file~'`,
				[["echo", "~HOME", "HEAD~1", "HEAD^", "foo#bar", "=sh", "file~"]],
			],
			[
				String.raw`echo -"{a,b}" '*?[]~^#=\\'`,
				[["echo", "-{a,b}", String.raw`*?[]~^#=\\`]],
			],
		] as const) {
			expect(sequence(script), script).toEqual(expected);
		}
	});

	test("Codex 拒绝的脚本", () => {
		for (const script of [
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash 的写法，不是漏了反引号
			'echo "hi ${USER}"',
			'echo "$HOME"',
			"(ls)",
			"ls || (pwd && echo hi)",
			"ls > out.txt",
			"echo hi & echo bye",
			"echo $(pwd)",
			"echo `pwd`",
			"echo $HOME",
			'echo "hi $USER"',
			"find . -{delete,print}",
			"rg --pre{=,=sh} pattern payload.sh",
			"find . -del*",
			"find . -delet?",
			"find . -delet[e]",
			"echo ~",
			"echo ~HOME",
			"l* -l",
			"FOO=bar ls",
			"ls &&",
			"&& ls",
			"ls ;; pwd",
			"ls | | wc",
			'rg -g"$VAR" pattern',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash 的写法，不是漏了反引号
			'rg -g"${VAR}" pattern',
			'rg -g"$(pwd)" pattern',
			`rg -g"$(echo '*.py')" pattern`,
		]) {
			expect(sequence(script), script).toBeUndefined();
		}
	});

	test("和 Codex 不同：转义按 bash 的规则解码，zsh 才展开的写法是字面值", () => {
		for (const [script, expected] of [
			[String.raw`find . -de\lete`, ["find", ".", "-delete"]],
			['find . "-de\\\nlete"', ["find", ".", "-delete"]],
			[String.raw`echo "\\"`, ["echo", "\\"]],
			[String.raw`echo "\$HOME\`\"\\\n"`, ["echo", '$HOME`"\\\\n']],
			["echo HEAD~1", ["echo", "HEAD~1"]],
			["echo HEAD^", ["echo", "HEAD^"]],
			["echo file~", ["echo", "file~"]],
			["echo =sh", ["echo", "=sh"]],
			["echo foo^bar", ["echo", "foo^bar"]],
			["echo foo#bar", ["echo", "foo#bar"]],
		] as const) {
			expect(sequence(script), script).toEqual([expected]);
		}
	});
});
