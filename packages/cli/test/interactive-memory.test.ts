import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { createHost } from "@ospreycode/agent-host";
import { describe, expect, test } from "vitest";
import { runCli, textReply } from "./harness.js";
import {
	interactiveFixture,
	lastUserMessage,
	toolCallsReply,
} from "./interactive-fixture.js";
import { key, type TestTerminal } from "./interactive-terminal.js";

const fixture = interactiveFixture();

/** 输入一条命令并提交；多行的内容用 Ctrl+J 换行。 */
async function command(terminal: TestTerminal, text: string): Promise<void> {
	const [first = "", ...rest] = text.split("\n");
	await terminal.type(first);
	for (const next of rest) {
		await terminal.press("\n");
		await terminal.type(next);
	}
	await terminal.press(key.enter);
}

/** 终端上最后出现的一个记忆编号。 */
function lastId(terminal: TestTerminal, prefix: "p" | "u"): string {
	const ids = terminal.text().match(new RegExp(`${prefix}-[0-9a-f]{8}`, "g"));
	const id = ids?.at(-1);
	if (id === undefined) throw new Error(`终端上没有 ${prefix}- 开头的记忆编号`);
	return id;
}

/** 各个项目的 session 记录文件和它们的 WAL 里的全部字节。 */
function recorded(): Buffer {
	const projects = join(fixture.dirs.root, "data", "projects");
	return Buffer.concat(
		readdirSync(projects)
			.flatMap((project) => {
				const file = join(projects, project, "sessions.sqlite");
				return [file, `${file}-wal`];
			})
			.filter(existsSync)
			.map((file) => readFileSync(file)),
	);
}

const propose = toolCallsReply([
	{
		name: "memory_propose",
		arguments: {
			scope: "project",
			kind: "fact",
			title: "测试用 npm run test:unit",
			body: "实际运行验证过：npm test 会连带跑端到端测试。",
		},
	},
]);

describe("/memory", () => {
	test("任务结束时列出模型提议的候选；确认之前不告诉模型，修改后确认的内容从下一个任务起告诉模型", async () => {
		const server = await fixture.useModel((call) =>
			call === 0 ? propose : textReply("好"),
		);
		const { terminal } = await fixture.start();
		await command(terminal, "跑一下测试");
		await terminal.waitFor("有 1 条记忆候选待确认，确认之后才会生效：");
		const id = lastId(terminal, "p");
		expect(terminal.text()).toContain(
			`[${id}] project fact：测试用 npm run test:unit`,
		);

		await command(terminal, `/memory show ${id}`);
		await terminal.waitFor(`[${id}] project fact · 待确认 · 版本 1`);
		expect(terminal.text()).toContain(
			"实际运行验证过：npm test 会连带跑端到端测试。",
		);
		expect(terminal.text()).toContain(
			"内容来自：会话里的内容（模型写出，没有经用户改写）",
		);
		expect(terminal.text()).toMatch(/来源：session [0-9a-f-]+（1 个事件）/);

		// 没确认：下一个任务里模型看不到它
		await command(terminal, "第二个任务");
		await terminal.waitFor(/(完成[\s\S]*){2}/);
		expect(lastUserMessage(server.requests.at(-1))).toBe("第二个任务");

		await command(
			terminal,
			`/memory confirm ${id} 单元测试用 npm run test:unit`,
		);
		await terminal.waitFor("已确认，从下一个任务起告诉模型");
		await command(terminal, "/memory");
		await terminal.waitFor("生效（1 条）");
		expect(terminal.text()).toContain(
			`[${id}] project fact：单元测试用 npm run test:unit`,
		);

		await command(terminal, "第三个任务");
		await terminal.waitFor(/(完成[\s\S]*){3}/);
		const sent = lastUserMessage(server.requests.at(-1));
		expect(sent).toContain("<memory_update>");
		expect(sent).toContain(
			`[${id}] project fact: 单元测试用 npm run test:unit (stated by the user)`,
		);

		// 彻底删除：来源和列过它的地方就在这个打开着的 session 里，脱敏不了，写明之后要执行的命令、
		// 在哪个目录下执行和原因
		await command(terminal, `/memory delete ${id}`);
		await terminal.waitFor(`已彻底删除 [${id}]，连同它的全部旧版本`);
		await terminal.waitFor(
			"它的内容还留在下面这些 session 的记录里，之后这样脱敏：",
		);
		// session 的编号后面跟着来源事件的编号和记忆的编号；终端窄时在它们之间折行
		const printed = new RegExp(
			`ospreycode session redact ([0-9a-f-]{36})\\s+([0-9a-f-]{36})\\s+--memory\\s+${id}`,
		);
		await terminal.waitFor(printed);
		await terminal.waitFor("在这个目录下执行：");
		await terminal.waitFor("这次没有脱敏：");
		expect(terminal.text()).toContain("正被一个 Host 进程打开着");
		// 按编号找不到的那一种也写明
		await terminal.waitFor("模型在回复里复述过它的地方不在其中");
		const [, sessionId, eventId] = printed.exec(terminal.text()) ?? [];
		if (sessionId === undefined || eventId === undefined) {
			throw new Error("终端上没有要执行的命令");
		}

		// 关闭之后照着写明的命令执行：记录文件里再也找不到这条记忆的标题和正文
		await command(terminal, "/quit");
		expect(await fixture.exitCode()).toBe(0);
		const texts = ["npm run test:unit", "连带跑端到端测试"];
		for (const text of texts) expect(recorded().includes(text)).toBe(true);
		const result = await runCli(
			["session", "redact", sessionId, eventId, "--memory", id, "--yes"],
			{ cwd: fixture.dirs.workspace, env: fixture.dirs.env },
		);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		for (const text of texts) expect(recorded().includes(text)).toBe(false);
	});

	test("直接添加、纠正、回滚、不再使用、恢复、标记过期和彻底删除，列表写明每条的状态", async () => {
		await fixture.useModel(() => textReply("好"));
		const { terminal } = await fixture.start();
		await command(terminal, "/memory");
		await terminal.waitFor("还没有记忆");

		await command(
			terminal,
			"/memory add user preference 回复用中文\n用户说的：解释和总结都用中文，\n代码注释也用中文。",
		);
		await terminal.waitFor("已添加，从下一个任务起告诉模型");
		const id = lastId(terminal, "u");

		await command(terminal, `/memory correct ${id} 回复和注释都用中文`);
		await terminal.waitFor("已纠正，旧版本留着");
		await command(terminal, `/memory show ${id}`);
		await terminal.waitFor(`[${id}] user preference · 生效 · 版本 2`);
		expect(terminal.text()).toContain("内容来自：用户");
		expect(terminal.text()).toMatch(/版本 1（[^）]+）：回复用中文/);
		// 只改了标题，正文不变，多行的正文原样留着
		expect(terminal.text()).toMatch(
			/回复和注释都用中文\n\s+用户说的：解释和总结都用中文，\n\s+代码注释也用中文。/,
		);

		await command(terminal, `/memory rollback ${id} 1`);
		await terminal.waitFor("已回滚到版本 1 的内容");
		await command(terminal, `/memory retire ${id}`);
		await terminal.waitFor("不再使用，可以用 /memory restore 恢复");
		await command(terminal, "/memory");
		await terminal.waitFor("不再使用（1 条）");
		await command(terminal, `/memory restore ${id}`);
		await terminal.waitFor("已恢复");
		await command(terminal, `/memory expire ${id}`);
		await terminal.waitFor("已标记过期，纠正之后重新生效");
		await command(terminal, "/memory");
		await terminal.waitFor("已过期（1 条）");

		await command(terminal, `/memory delete ${id}`);
		await terminal.waitFor(`已彻底删除 [${id}]，连同它的全部旧版本`);
		await command(terminal, `/memory show ${id}`);
		await terminal.waitFor(`没有编号为 ${id} 的记忆`);
	});

	test("写法不对、内容不能写入时说明原因，session 照常继续", async () => {
		await fixture.useModel(() => textReply("好"));
		const { terminal } = await fixture.start();
		await command(terminal, "/memory forget everything");
		await terminal.waitFor("/memory 的用法：");
		await command(terminal, "/memory add project fact 只有标题");
		await terminal.waitFor("记忆要有正文");
		await command(terminal, "/memory add team fact 标题\n正文");
		await terminal.waitFor("添加记忆的写法：/memory add SCOPE KIND 标题");
		await command(terminal, "/memory retire p-00000000");
		await terminal.waitFor("没有编号为 p-00000000 的记忆");
		await command(
			terminal,
			"/memory add project fact 部署的密钥\nsk-abcdefghijklmnopqrstuvwxyz0123456789",
		);
		await terminal.waitFor("记忆里有疑似密钥的内容，没有写入");

		await command(terminal, "还在吗");
		await terminal.waitFor("完成");
	});

	test("显示之后被另一个 Host 改过的记忆：操作报冲突，不悄悄覆盖；重新查看后可以继续", async () => {
		await fixture.useModel(() => textReply("好"));
		const { terminal } = await fixture.start();
		await command(
			terminal,
			"/memory add user preference 缩进用 tab\n用户说的。",
		);
		await terminal.waitFor("已添加");
		const id = lastId(terminal, "u");

		// 另一个项目里的 Host 改了这条 user 记忆
		const other = realpathSync(mkdtempSync("/tmp/osp-cli-other-"));
		try {
			const session = await createHost({
				root: fixture.dirs.root,
				env: fixture.dirs.env,
				credentialStore: null,
			}).openSession({
				workspace: other,
				credentials: { fake: { file: fixture.dirs.credentialFile } },
				sandboxMode: "danger-full-access",
				onEvent: () => {},
			});
			session.memory?.correct(id, 1, { title: "缩进用两个空格" });
			await session.close();
		} finally {
			rmSync(other, { recursive: true, force: true });
		}

		await command(terminal, `/memory retire ${id}`);
		await terminal.waitFor("要改的是版本 1，现在是版本 2。重新查看后再操作");
		await command(terminal, `/memory show ${id}`);
		await terminal.waitFor("缩进用两个空格");
		await command(terminal, `/memory retire ${id}`);
		await terminal.waitFor("不再使用，可以用 /memory restore 恢复");
	});
});
