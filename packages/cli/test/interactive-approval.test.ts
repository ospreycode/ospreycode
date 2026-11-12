import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { shellCallReply, textReply } from "./harness.js";
import {
	interactiveFixture,
	selectFirstChoice,
	toolCallsReply,
} from "./interactive-fixture.js";
import { key } from "./interactive-terminal.js";

const fixture = interactiveFixture();

// 询问来自真实的沙盒：命令要到工作区之外写文件
describe.runIf(process.platform === "darwin")("审批", () => {
	/** 工作区之外的目录，沙盒里写不了。 */
	let outside: string;

	beforeEach(() => {
		outside = join(fixture.dirs.home, "outside");
		mkdirSync(outside);
	});

	const start = () => fixture.start({ sandboxMode: "workspace-write" });

	/** 申请在沙盒之外运行的 `touch`。 */
	const escalatedTouch = (file: string) =>
		shellCallReply(`touch '${join(outside, file)}'`, {
			sandbox_permissions: "require_escalated",
		});

	test("批准一次：显示命令原文、工作目录和原因，批准后命令在沙盒之外运行", async () => {
		const server = await fixture.useModel((call) =>
			call === 0 ? escalatedTouch("once.txt") : textReply("做完了"),
		);
		const { terminal } = await start();
		await terminal.type("写文件");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "批准这一次");

		const asked = terminal.visible();
		expect(asked).toContain("需要确认：在沙盒之外运行命令");
		expect(asked).toContain(`$ touch '${join(outside, "once.txt")}'`);
		expect(asked).toContain(`工作目录：${fixture.dirs.workspace}`);
		expect(asked).toContain("原因：申请在沙盒的文件限制之外运行这条命令");
		expect(existsSync(join(outside, "once.txt"))).toBe(false);

		await terminal.press(key.enter);
		await terminal.waitFor("做完了");
		expect(existsSync(join(outside, "once.txt"))).toBe(true);
		expect(terminal.text()).toContain("→ 已批准这一次");
		expect(server.requests).toHaveLength(2);
	});

	test("询问出现时没有选中的选项：正在打的字和正要按下的 Enter 不会回答它，按 ↑↓ 选了才能确认", async () => {
		await fixture.useModel((call) =>
			call === 0 ? escalatedTouch("stray.txt") : textReply("做完了"),
		);
		const { terminal } = await start();
		await terminal.type("写文件");
		await terminal.press(key.enter);
		await terminal.waitForVisible("先按 ↑↓ 选择");
		expect(terminal.visible()).not.toContain("→ 批准这一次");

		await terminal.type("接着改");
		await terminal.press(key.enter);
		await terminal.press(key.down);
		await terminal.waitForVisible("→ 批准这一次");
		expect(existsSync(join(outside, "stray.txt"))).toBe(false);
		expect(terminal.text()).not.toContain("已批准");

		await terminal.press(key.enter);
		await terminal.waitFor("做完了");
		expect(existsSync(join(outside, "stray.txt"))).toBe(true);
	});

	test("本任务内批准：同一个任务里同样的命令不再问", async () => {
		const server = await fixture.useModel(
			(call) =>
				[
					escalatedTouch("task.txt"),
					escalatedTouch("task.txt"),
					textReply("两次都做了"),
				][call],
		);
		const { terminal } = await start();
		await terminal.type("写文件");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "批准这一次");

		await terminal.press(key.down);
		await terminal.waitForVisible("→ 本任务内批准同样的命令");
		await terminal.press(key.enter);
		await terminal.waitFor("两次都做了");

		expect(terminal.text().match(/需要确认/g)).toHaveLength(1);
		expect(terminal.text()).toContain("→ 已批准，本任务内有效");
		expect(server.requests).toHaveLength(3);
	});

	test("改沙盒可写范围之外的文件：显示要写的内容，批准后文件写成", async () => {
		const target = join(outside, "written.txt");
		await fixture.useModel((call) =>
			call === 0
				? toolCallsReply([
						{
							name: "write",
							arguments: { path: target, content: "范围之外的一行\n" },
						},
					])
				: textReply("写好了"),
		);
		const { terminal } = await start();
		await terminal.type("写文件");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "批准这一次");
		const asked = terminal.visible();
		expect(asked).toContain("需要确认：修改沙盒可写范围之外的文件");
		expect(asked).toContain(target);
		expect(asked).toContain("+范围之外的一行");
		expect(existsSync(target)).toBe(false);

		await terminal.press(key.enter);
		await terminal.waitFor("写好了");
		expect(readFileSync(target, "utf8")).toBe("范围之外的一行\n");
	});

	test("拒绝：命令不运行，模型收到被拒绝的结果后接着回复", async () => {
		const server = await fixture.useModel((call) =>
			call === 0 ? escalatedTouch("denied.txt") : textReply("那就不写了"),
		);
		const { terminal } = await start();
		await terminal.type("写文件");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "批准这一次");

		await terminal.press(key.down, key.down);
		await terminal.waitForVisible("→ 拒绝");
		await terminal.press(key.enter);
		await terminal.waitFor("那就不写了");

		expect(existsSync(join(outside, "denied.txt"))).toBe(false);
		expect(terminal.text()).toContain("→ 已拒绝");
		expect(terminal.text()).toContain("✗ 被用户拒绝");
		expect(JSON.stringify(server.requests[1])).toContain("denied");
	});

	test("保存为规则：先显示要保存的规则让用户确认，确认后命令运行，规则写进用户级的 rules/default.toml", async () => {
		await fixture.useModel((call) =>
			call === 0
				? shellCallReply(`touch '${join(outside, "rule.txt")}'`, {
						sandbox_permissions: "with_additional_permissions",
						additional_permissions: { file_system: { write: [outside] } },
						prefix_rule: ["touch"],
					})
				: textReply("做完了"),
		);
		const { terminal } = await start();
		await terminal.type("写文件");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "批准这一次");
		expect(terminal.visible()).toContain("需要确认：带额外权限运行命令");
		expect(terminal.visible()).toContain(`额外可写：${outside}`);

		await terminal.press(key.down, key.down);
		await terminal.waitForVisible("→ 批准，并保存为规则");
		await terminal.press(key.enter);
		await terminal.waitForVisible("要保存的规则：允许以 touch 开头的命令");
		// 还没有确认：规则没有保存，命令没有运行
		expect(existsSync(join(fixture.dirs.root, "rules", "default.toml"))).toBe(
			false,
		);
		expect(existsSync(join(outside, "rule.txt"))).toBe(false);

		await terminal.press(key.enter);
		await terminal.waitFor("做完了");
		expect(existsSync(join(outside, "rule.txt"))).toBe(true);
		expect(terminal.text()).toContain("→ 已批准，并保存为规则");
		const saved = readFileSync(
			join(fixture.dirs.root, "rules", "default.toml"),
			"utf8",
		);
		expect(saved).toContain("[[rules]]");
		expect(saved).toContain('pattern = [ "touch" ]');
	});

	test("拒绝并写一句话：这句话交给模型", async () => {
		const server = await fixture.useModel((call) =>
			call === 0 ? escalatedTouch("denied.txt") : textReply("明白"),
		);
		const { terminal } = await start();
		await terminal.type("写文件");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "批准这一次");

		await terminal.press(key.down, key.down, key.down);
		await terminal.waitForVisible("→ 拒绝，并写一句话告诉模型");
		await terminal.press(key.enter);
		await terminal.waitForVisible("写给模型的话：");
		await terminal.type("写到工作区里");
		await terminal.press(key.enter);
		await terminal.waitFor("明白");

		expect(existsSync(join(outside, "denied.txt"))).toBe(false);
		expect(terminal.text()).toContain("→ 已拒绝：写到工作区里");
		expect(JSON.stringify(server.requests[1])).toContain("写到工作区里");
	});

	test("request_permissions 只批准一部分：勾选的目录之后能写，没勾选的还是写不了", async () => {
		const granted = join(outside, "granted");
		const refused = join(outside, "refused");
		mkdirSync(granted);
		mkdirSync(refused);
		await fixture.useModel(
			(call) =>
				[
					toolCallsReply([
						{
							name: "request_permissions",
							arguments: {
								file_system: { write: [granted, refused] },
								justification: "The build writes to both directories.",
							},
						},
					]),
					shellCallReply(`touch '${join(granted, "a.txt")}'`),
					shellCallReply(`touch '${join(refused, "b.txt")}'`),
					textReply("做完了"),
				][call],
		);
		const { terminal } = await start();
		await terminal.type("申请权限");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "批准全部");
		const asked = terminal.visible();
		expect(asked).toContain("需要确认：申请本任务内的权限");
		expect(asked).toContain("The build writes to both directories.");

		await terminal.press(key.down);
		await terminal.waitForVisible("→ 只批准一部分");
		await terminal.press(key.enter);
		await terminal.waitForVisible(`[x] 可写 ${refused}`);
		// 去掉第二项的勾选
		await terminal.press(key.down, key.space);
		await terminal.waitForVisible(`[ ] 可写 ${refused}`);
		expect(terminal.visible()).toContain(`[x] 可写 ${granted}`);
		await terminal.press(key.enter);
		await terminal.waitFor("做完了");

		expect(terminal.text()).toContain("→ 已批准其中一部分");
		expect(existsSync(join(granted, "a.txt"))).toBe(true);
		expect(existsSync(join(refused, "b.txt"))).toBe(false);
	});

	/** 经沙盒的代理请求一个解析不了的域名，打印状态码：代理在连接之前先问，它自己拒绝时是 403。 */
	const fetchStatus = (host: string) =>
		shellCallReply(
			`curl -s -o /dev/null -w '%{http_code}' --max-time 20 'http://${host}:8080/'`,
		);

	/** 模型收到的最后一条工具结果。 */
	const lastToolResult = (request: unknown): string => {
		const { messages } = request as {
			messages: { role: string; content: unknown }[];
		};
		const last = messages.findLast((message) => message.role === "tool");
		if (last === undefined) throw new Error("请求里没有工具结果");
		return JSON.stringify(last.content);
	};

	test("网络访问，允许这一次：这个连接放行，同一个域名再连的时候再问", async () => {
		const server = await fixture.useModel(
			(call) =>
				[
					fetchStatus("once.example.invalid"),
					fetchStatus("once.example.invalid"),
					textReply("连过了"),
				][call],
		);
		const { terminal } = await start();
		await terminal.type("连一个域名");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "允许这一次");
		const asked = terminal.visible();
		expect(asked).toContain("需要确认：访问网络");
		expect(asked).toContain("主机：once.example.invalid:8080");
		expect(asked).toContain("发起连接的命令：$ curl -s");
		expect(asked).toContain("原因：申请访问 once.example.invalid:8080");

		await terminal.press(key.enter);
		// 第二次连接又问了：这一次拒绝
		await terminal.waitFor("→ 已批准这一次");
		await terminal.waitForVisible("先按 ↑↓ 选择");
		await terminal.press(key.escape);
		await terminal.waitFor("连过了");

		// 放行之后由代理去连，域名解析不了，但不再是代理自己拒绝的 403
		const allowed = lastToolResult(server.requests[1]);
		expect(allowed).not.toContain("403");
		expect(allowed).not.toContain("was denied");
		const denied = lastToolResult(server.requests[2]);
		expect(denied).toContain("403");
		expect(denied).toContain(
			"Network access to once.example.invalid was denied",
		);
		expect(terminal.text().match(/需要确认：访问网络/g)).toHaveLength(2);
	});

	test("网络访问，本任务内允许这个域名：这个任务里再连不再问，下一个任务重新问", async () => {
		const server = await fixture.useModel(
			(call) =>
				[
					fetchStatus("task.example.invalid"),
					fetchStatus("task.example.invalid"),
					textReply("两次都连了"),
					fetchStatus("task.example.invalid"),
					textReply("这次没连成"),
				][call],
		);
		const { terminal } = await start();
		await terminal.type("连两次");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "允许这一次");
		await terminal.press(key.down);
		await terminal.waitForVisible("→ 本任务内允许这个域名");
		await terminal.press(key.enter);
		await terminal.waitFor("两次都连了");

		expect(terminal.text()).toContain("→ 已批准，本任务内有效");
		expect(terminal.text().match(/需要确认：访问网络/g)).toHaveLength(1);
		expect(lastToolResult(server.requests[1])).not.toContain("403");
		expect(lastToolResult(server.requests[2])).not.toContain("403");

		await terminal.type("再连一次");
		await terminal.press(key.enter);
		await terminal.waitForVisible("先按 ↑↓ 选择");
		await terminal.press(key.escape);
		await terminal.waitFor("这次没连成");
		expect(terminal.text().match(/需要确认：访问网络/g)).toHaveLength(2);
		expect(lastToolResult(server.requests[4])).toContain("403");
	});

	test("网络访问，允许并保存为规则：先显示要保存的规则让用户确认，确认后写进用户级的 rules/default.toml，下一个任务不再问", async () => {
		const server = await fixture.useModel(
			(call) =>
				[
					fetchStatus("saved.example.invalid"),
					textReply("连过了"),
					fetchStatus("saved.example.invalid"),
					textReply("又连了一次"),
				][call],
		);
		const rules = join(fixture.dirs.root, "rules", "default.toml");
		const { terminal } = await start();
		await terminal.type("连一个域名");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "允许这一次");
		await terminal.press(key.down, key.down);
		await terminal.waitForVisible("→ 允许，并保存为规则");
		await terminal.press(key.enter);
		await terminal.waitForVisible(
			"要保存的规则：允许访问 saved.example.invalid",
		);
		// 还没有确认：规则没有保存
		expect(existsSync(rules)).toBe(false);

		await terminal.press(key.enter);
		await terminal.waitFor("连过了");
		expect(terminal.text()).toContain("→ 已批准，并保存为规则");
		const saved = readFileSync(rules, "utf8");
		expect(saved).toContain("[[network_rules]]");
		expect(saved).toContain('host = "saved.example.invalid"');
		expect(saved).toContain('decision = "allow"');
		expect(lastToolResult(server.requests[1])).not.toContain("403");

		await terminal.type("再连一次");
		await terminal.press(key.enter);
		await terminal.waitFor("又连了一次");
		expect(terminal.text().match(/需要确认：访问网络/g)).toHaveLength(1);
		expect(lastToolResult(server.requests[3])).not.toContain("403");
	});

	test("同时有几个询问：排队逐个显示，回答一个再显示下一个", async () => {
		// 一条命令同时连两个名单之外的域名：两个网络访问的询问同时等着
		const curl = (host: string) =>
			`curl -s -o /dev/null --max-time 20 'http://${host}:8080/'`;
		await fixture.useModel((call) =>
			call === 0
				? shellCallReply(
						`${curl("one.example.invalid")} & ${curl("two.example.invalid")} & wait`,
					)
				: textReply("两个都处理了"),
		);
		const { terminal } = await start();
		await terminal.type("连两个域名");
		await terminal.press(key.enter);
		await terminal.waitForVisible("需要确认：访问网络（后面还有 1 个询问）");
		expect(terminal.visible()).toContain("允许这一次");

		// 两个都拒绝：不真的连出去
		await terminal.press(key.escape);
		await terminal.waitForGone("（后面还有 1 个询问）");
		await terminal.waitForVisible("允许这一次");
		await terminal.press(key.escape);
		await terminal.waitFor("两个都处理了");

		const shown = terminal.text();
		expect(shown).toContain("主机：one.example.invalid:8080");
		expect(shown).toContain("主机：two.example.invalid:8080");
		expect(shown.match(/→ 已拒绝/g)).toHaveLength(2);
	});

	test("全屏时终端比询问的面板矮：选项和按键提示留在屏幕上，裁掉的是面板的开头", async () => {
		const curl = (host: string) =>
			`curl -s -o /dev/null --max-time 20 'http://${host}:8080/'`;
		await fixture.useModel((call) =>
			call === 0
				? shellCallReply(
						`${curl("one.example.invalid")} & ${curl("two.example.invalid")} & wait`,
					)
				: textReply("两个都处理了"),
		);
		// 后面还排着一个询问时，面板连要做的具体内容一起显示，比 10 行的屏幕高
		const { terminal } = await fixture.start({
			sandboxMode: "workspace-write",
			rows: 10,
		});
		expect(terminal.alternate).toBe(true);
		await terminal.type("连两个域名");
		await terminal.press(key.enter);
		await terminal.waitForVisible("先按 ↑↓ 选择");

		const rows = terminal.visible().split("\n");
		expect(rows).toHaveLength(10);
		expect(rows.slice(3, 9)).toEqual([
			"  允许这一次",
			"  本任务内允许这个域名",
			"  允许，并保存为规则",
			"  拒绝",
			"  拒绝，并写一句话告诉模型",
			"先按 ↑↓ 选择，再按 Enter 确认 · Esc 拒绝 · Ctrl+C 拒绝并取消任务",
		]);
		expect(rows[9]).toMatch(/^fake · 推理 \w+ · 沙盒 workspace-write · /);
		expect(terminal.visible()).not.toContain("需要确认：访问网络");

		await terminal.press(key.escape);
		await terminal.waitForVisible("先按 ↑↓ 选择");
		await terminal.press(key.escape);
		await terminal.waitFor("两个都处理了");
	});

	test("询问显示着的时候按 Ctrl+C：取消任务，询问撤掉，命令不运行", async () => {
		await fixture.useModel(() => escalatedTouch("cancelled.txt"));
		const { terminal } = await start();
		await terminal.type("写文件");
		await terminal.press(key.enter);
		await selectFirstChoice(terminal, "批准这一次");

		await terminal.press(key.ctrlC);
		await terminal.waitFor("已取消");
		await terminal.waitForVisible("Enter 发送");

		expect(terminal.visible()).not.toContain("→ 批准这一次");
		expect(existsSync(join(outside, "cancelled.txt"))).toBe(false);
	});

	test("审批策略是 never 时不询问，越界的申请直接被拒绝", async () => {
		await fixture.useModel((call) =>
			call === 0 ? escalatedTouch("never.txt") : textReply("没有写成"),
		);
		const { terminal } = await fixture.start({
			sandboxMode: "workspace-write",
			approvalPolicy: "never",
		});
		expect(terminal.visible()).toContain(" · 审批 never · ");
		await terminal.type("写文件");
		await terminal.press(key.enter);
		await terminal.waitFor("没有写成");

		expect(terminal.text()).not.toContain("需要确认");
		expect(existsSync(join(outside, "never.txt"))).toBe(false);
	});
});
