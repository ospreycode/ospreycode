import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import photon from "@silvia-odwyer/photon-node";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	type FakeModelServer,
	fakeModelServer,
	type ModelReply,
	runCli,
	shellCallReply,
	type TestDirectories,
	testDirectories,
	textReply,
} from "./harness.js";
import { type PtyCli, startInPty } from "./pty.js";

// 每个测试都要启动 CLI、Host 和 agent 三层进程
vi.setConfig({ testTimeout: 60_000 });

let dirs: TestDirectories;
let model: FakeModelServer;
/** 模型服务第几次请求给什么回应；测试可以换掉。 */
let reply: (call: number) => ModelReply;
let cli: PtyCli | undefined;

beforeEach(async () => {
	dirs = testDirectories();
	reply = () => textReply("这是真进程的回复");
	model = await fakeModelServer((call) => reply(call));
	dirs.writeConfig(model.config);
	cli = undefined;
});

afterEach(async () => {
	if (cli !== undefined) {
		cli.kill();
		await cli.exit;
	}
	await model.close();
	dirs.cleanup();
});

/** 根命令的参数：凭据从文件读，不启用系统隔离。 */
function args(...rest: string[]): string[] {
	return [
		"--credential-file",
		`fake=${dirs.credentialFile}`,
		"--sandbox",
		"danger-full-access",
		...rest,
	];
}

function start(...rest: string[]): PtyCli {
	cli = startInPty(args(...rest), { cwd: dirs.workspace, env: dirs.env });
	return cli;
}

test("在终端里启动：输入一句话按 Enter 看到模型的回复，/quit 退出，退出码 0", async () => {
	const terminal = start();
	await terminal.waitFor("Enter 发送");
	await terminal.type("你好");
	terminal.write("\r");
	await terminal.waitFor("这是真进程的回复");
	await terminal.waitFor("完成");

	await terminal.type("/quit");
	terminal.write("\r");
	expect(await terminal.exit).toBe(0);
	expect(model.requests).toHaveLength(1);
});

test("命令行上的 PROMPT 直接提交；Ctrl+C 是按键不是信号：第一次提示，第二次退出，退出码 0", async () => {
	const terminal = start("第一条");
	await terminal.waitFor("› 第一条");
	await terminal.waitFor("这是真进程的回复");
	await terminal.waitFor("完成");

	terminal.write("\x03");
	await terminal.waitFor("再按一次 Ctrl+C 退出");
	terminal.write("\x03");
	expect(await terminal.exit).toBe(0);
});

test("默认占着终端的备用缓冲区，退出时回到主缓冲区、把对话写在后面；--tui-mode regular 不进备用缓冲区", async () => {
	const enter = "\x1b[?1049h";
	const leave = "\x1b[?1049l";
	const fullscreen = start();
	await fullscreen.waitFor("Enter 发送");
	await fullscreen.type("你好");
	fullscreen.write("\r");
	await fullscreen.waitFor("这是真进程的回复");
	await fullscreen.waitFor("完成");
	await fullscreen.type("/quit");
	fullscreen.write("\r");
	expect(await fullscreen.exit).toBe(0);

	const raw = fullscreen.raw();
	expect(raw.split(enter)).toHaveLength(2);
	expect(raw.split(leave)).toHaveLength(2);
	expect(raw.indexOf(enter)).toBeLessThan(raw.indexOf(leave));
	const restored = stripTerminalSequences(raw.slice(raw.indexOf(leave)));
	expect(restored).toContain("› 你好");
	expect(restored).toContain("这是真进程的回复");

	const regular = start("--tui-mode", "regular");
	await regular.waitFor("Enter 发送");
	regular.write("\x04");
	expect(await regular.exit).toBe(0);
	expect(regular.raw()).not.toContain(enter);
});

test("在支持 Kitty 图形协议的终端里预览拖进来的 JPEG：打包后的 CLI 把它转成 PNG 画出来，Esc 关掉时删掉图片", async () => {
	const picture = join(dirs.home, "photo.jpg");
	const image = new photon.PhotonImage(
		new Uint8Array(8 * 4 * 4).fill(180),
		8,
		4,
	);
	writeFileSync(picture, image.get_bytes_jpeg(80));
	image.free();
	// 界面库按环境变量认终端
	cli = startInPty(args(), {
		cwd: dirs.workspace,
		env: { ...dirs.env, TERM_PROGRAM: "ghostty" },
	});
	await cli.waitFor("Enter 发送");
	// 终端把拖进来的文件当作一次粘贴送来
	cli.write(`\x1b[200~${picture}\x1b[201~`);
	await cli.waitFor("Ctrl+O 预览图片 #1");
	expect(cli.output()).not.toContain(picture);
	cli.write("\x0f");
	await cli.waitFor("Esc 关闭");

	expect(cli.output()).toContain("图片 #1 · JPEG · 8×4");
	// f=100 是 PNG：Kitty 图形协议只收这一种
	// biome-ignore lint/suspicious/noControlCharactersInRegex: 要认的就是控制序列
	const placed = /\x1b_Ga=T,f=100,[^;]*\bi=(\d+)/.exec(cli.raw());
	expect(placed).not.toBeNull();
	cli.write("\x1b");
	await vi.waitFor(() =>
		expect(cli?.raw()).toContain(`\x1b_Ga=d,d=I,i=${placed?.[1]}`),
	);
	// 第一次 Ctrl+C 清空输入框，之后两次退出
	await cli.type("\x03\x03");
	await cli.waitFor("再按一次 Ctrl+C 退出");
	cli.write("\x03");
	expect(await cli.exit).toBe(0);
});

test("空输入框上 Ctrl+D 退出，退出码 0", async () => {
	const terminal = start();
	await terminal.waitFor("Enter 发送");
	terminal.write("\x04");
	expect(await terminal.exit).toBe(0);
});

/** 命令行里有这段文字的进程。 */
function processesMatching(fragment: string): number[] {
	const found = spawnSync("pgrep", ["-f", fragment], { encoding: "utf8" });
	return found.stdout.split("\n").filter(Boolean).map(Number);
}

/** 一个进程的子进程。 */
function childrenOf(pid: number): number[] {
	const found = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
	return found.stdout.split("\n").filter(Boolean).map(Number);
}

/**
 * Host 根目录里 session 开着时才有的东西：工作区和 session 的锁、登记着的进程。session 正常关闭后
 * 都清掉了；进程被信号直接结束的话它们会留下来。
 */
function leftBehind(): {
	locks: string[];
	processes: { pid: number; kind: string }[];
} {
	const data = join(dirs.root, "data");
	const { processes } = JSON.parse(
		readFileSync(join(data, "processes.json"), "utf8"),
	) as { processes: { pid: number; kind: string }[] };
	return { locks: readdirSync(join(data, "locks")), processes };
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

test("空闲时进程收到 SIGTERM：关闭 session（锁和登记的进程都清掉），agent 进程一起结束，退出码 143", async () => {
	const terminal = start();
	await terminal.waitFor("Enter 发送");
	const children = childrenOf(await terminal.pid);
	expect(children).not.toEqual([]);
	expect(leftBehind().processes).toHaveLength(1);

	await terminal.signal("SIGTERM");
	expect(await terminal.exit).toBe(143);
	expect(leftBehind()).toEqual({ locks: [], processes: [] });
	expect(children.filter(alive)).toEqual([]);
});

test("任务运行中进程收到 SIGINT：取消任务，正在运行的命令和 agent 进程一起结束，退出码 130", async () => {
	// 时长是个别处不会有的数，按它找这条命令的进程
	const command = "sleep 271828";
	reply = () => shellCallReply(command);
	const terminal = start("跑一条长命令");
	await terminal.waitFor(`Running ${command}`);
	await vi.waitFor(() => expect(processesMatching(command)).not.toEqual([]));
	const children = childrenOf(await terminal.pid);
	expect(children).not.toEqual([]);

	await terminal.signal("SIGINT");
	expect(await terminal.exit).toBe(130);
	expect(terminal.output()).toContain("已取消");
	expect(processesMatching(command)).toEqual([]);
	expect(children.filter(alive)).toEqual([]);
	expect(leftBehind()).toEqual({ locks: [], processes: [] });
	expect(model.requests).toHaveLength(1);
});

test("agent 进程连续三次在任务中途被杀：每次都显示原因，第三次 session 关闭，交互模式以退出码 1 结束", async () => {
	// 每一轮的命令时长不同，按它等这一轮的命令跑起来
	const command = (round: number) => `sleep 31415${round}`;
	reply = (call) => shellCallReply(command(call));
	const terminal = start();
	await terminal.waitFor("Enter 发送");

	for (const round of [0, 1, 2]) {
		await terminal.type(`第 ${round + 1} 次`);
		terminal.write("\r");
		await vi.waitFor(
			() => expect(processesMatching(command(round))).not.toEqual([]),
			{ timeout: 30_000 },
		);
		const agent = leftBehind().processes.find(({ kind }) => kind === "agent");
		if (agent === undefined) throw new Error("没有登记着的 agent 进程");
		// 屏幕重画的内容接在已有的输出后面：只看杀掉之后新画出来的
		const before = terminal.output().length;
		process.kill(agent.pid, "SIGKILL");
		await vi.waitFor(
			() =>
				expect(terminal.output().slice(before)).toContain("agent 进程意外退出"),
			{ timeout: 30_000 },
		);
		expect(processesMatching(command(round))).toEqual([]);
	}

	expect(await terminal.exit).toBe(1);
	expect(terminal.output()).toContain("agent 进程连续 3 次异常退出");
	expect(leftBehind()).toEqual({ locks: [], processes: [] });
	expect(model.requests).toHaveLength(3);
});

test.runIf(process.platform === "darwin" || process.platform === "linux")(
	"--sandbox 写命名权限配置的名字：状态行显示这个名字",
	async () => {
		dirs.writeConfig(
			`${model.config}\n[permissions.strict]\nextends = "read-only"\n`,
		);
		cli = startInPty(
			[
				"--credential-file",
				`fake=${dirs.credentialFile}`,
				"--sandbox",
				"strict",
			],
			{ cwd: dirs.workspace, env: dirs.env },
		);
		// 状态行在提示之后才画完：等它本身，不在半个画面上判断
		await cli.waitFor(" · 沙盒 strict · ");

		await cli.type("/quit");
		cli.write("\r");
		expect(await cli.exit).toBe(0);
	},
);

test("标准输入不是终端时不进交互模式：退出码 2，提示改用 ospreycode exec", async () => {
	const result = await runCli(args(), { cwd: dirs.workspace, env: dirs.env });

	expect(result.code).toBe(2);
	expect(result.stderr).toContain("ospreycode exec");
	expect(result.stdout).toBe("");
	expect(model.requests).toHaveLength(0);
});
