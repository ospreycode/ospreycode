import {
	type CommandContext,
	type CommandRequest,
	decideCommand,
	decideFileEdits,
	decidePermissions,
	type FileEditsRequest,
	type GranularApproval,
	granularCategories,
	loadShellParser,
	type PermissionsRequest,
	type PolicyContext,
	type ShellParser,
} from "@ospreycode/sandbox";
import { beforeAll, describe, expect, test } from "vitest";

let parser: ShellParser;
beforeAll(async () => {
	parser = await loadShellParser();
});

const onRequest: PolicyContext = {
	sandboxMode: "workspace-write",
	approvalPolicy: "on-request",
};
const never: PolicyContext = { ...onRequest, approvalPolicy: "never" };
const fullAccess: PolicyContext = {
	sandboxMode: "danger-full-access",
	approvalPolicy: "on-request",
};

/** `granular` 下只关闭这几个类别，其余的照常询问。 */
function granular(...off: (keyof GranularApproval)[]): PolicyContext {
	return {
		...onRequest,
		approvalPolicy: "granular",
		granular: Object.fromEntries(
			granularCategories.map((category) => [category, !off.includes(category)]),
		) as GranularApproval,
	};
}

const command: CommandRequest = {
	kind: "command",
	command: "make",
	workdir: "/work",
	sandbox_permissions: "use_default",
};
const escalated: CommandRequest = {
	...command,
	sandbox_permissions: "with_additional_permissions",
	additional_permissions: { file_system: { write: ["/outside"] } },
};
const edits: FileEditsRequest = {
	kind: "file_edits",
	edits: [
		{ op: "add", path: "/outside/new.txt", old_sha256: null, content: "x" },
		{ op: "update", path: "/outside/old.txt", old_sha256: "ab", content: "y" },
	],
};
const permissions: PermissionsRequest = {
	kind: "permissions",
	file_system: { read: ["/data"], write: ["/outside"] },
};

describe("命令", () => {
	/** 没有权限规则时判断命令的环境；规则、内置判断和可执行文件身份的测试在 command-rules.test.ts。 */
	const inWorkspace = (context: PolicyContext): CommandContext => ({
		...context,
		parser,
		rules: [],
		workspace: "/work",
		home: "/home/u",
		hostRoot: "/home/u/.ospreycode",
		hostAllowed: [],
		credentialPaths: ["/home/u/.ospreycode"],
		agentWritable: ["/work"],
		path: "/usr/bin:/bin",
	});

	test("没有申请越界的直接执行；申请越界的按审批策略询问或拒绝", () => {
		expect(decideCommand(command, inWorkspace(never))).toEqual({
			action: "allow",
		});
		expect(decideCommand(escalated, inWorkspace(onRequest))).toEqual({
			action: "ask",
			category: "sandbox_approval",
			categories: ["sandbox_approval"],
			reasons: ["申请写入 /outside"],
		});
		expect(decideCommand(escalated, inWorkspace(never))).toMatchObject({
			action: "deny",
			reason: "policy",
			categories: ["sandbox_approval"],
		});
		expect(
			decideCommand(escalated, inWorkspace(granular("sandbox_approval"))),
		).toMatchObject({
			action: "deny",
			reason: "policy",
			categories: ["sandbox_approval"],
		});
	});

	test("没有沙盒时没有可越的范围，直接执行", () => {
		expect(decideCommand(escalated, inWorkspace(fullAccess))).toEqual({
			action: "allow",
		});
	});

	test("申请本机服务和本地端口时，询问的理由说明后果", () => {
		const asks = (
			additional: CommandRequest["additional_permissions"],
		): unknown =>
			decideCommand(
				{
					...command,
					sandbox_permissions: "with_additional_permissions",
					additional_permissions: additional,
				},
				inWorkspace(onRequest),
			);
		expect(
			asks({ unix_sockets: ["/var/run/docker.sock", "/tmp/app.sock"] }),
		).toEqual({
			action: "ask",
			category: "sandbox_approval",
			categories: ["sandbox_approval"],
			reasons: [
				expect.stringMatching(
					/^申请连接 Docker 的 socket \/var\/run\/docker\.sock：.*完全访问/,
				),
				"申请连接 Unix socket /tmp/app.sock",
			],
		});
		expect(asks({ local_binding: true })).toEqual({
			action: "ask",
			category: "sandbox_approval",
			categories: ["sandbox_approval"],
			reasons: [expect.stringMatching(/本机所有端口.*所有网卡上监听.*局域网/)],
		});
	});
});

test("可写范围之外的文件改动按越界申请询问或拒绝", () => {
	expect(decideFileEdits(edits, onRequest)).toEqual({
		action: "ask",
		category: "sandbox_approval",
		categories: ["sandbox_approval"],
		reasons: ["申请新建 /outside/new.txt", "申请修改 /outside/old.txt"],
	});
	expect(decideFileEdits(edits, never)).toMatchObject({
		action: "deny",
		reason: "policy",
		categories: ["sandbox_approval"],
	});
	expect(decideFileEdits(edits, granular("sandbox_approval"))).toMatchObject({
		action: "deny",
	});
	// 关掉别的类别不影响它
	expect(decideFileEdits(edits, granular("request_permissions"))).toMatchObject(
		{ action: "ask" },
	);
});

test("request_permissions 的申请有自己的类别；没有沙盒时直接放行", () => {
	expect(decidePermissions(permissions, onRequest)).toEqual({
		action: "ask",
		category: "request_permissions",
		categories: ["request_permissions"],
		reasons: ["申请在本任务内读取 /data", "申请在本任务内写入 /outside"],
	});
	expect(decidePermissions(permissions, never)).toMatchObject({
		action: "deny",
		reason: "policy",
		categories: ["request_permissions"],
	});
	expect(
		decidePermissions(permissions, granular("request_permissions")),
	).toMatchObject({ action: "deny" });
	expect(
		decidePermissions(permissions, granular("sandbox_approval")),
	).toMatchObject({ action: "ask" });
	expect(decidePermissions(permissions, fullAccess)).toEqual({
		action: "allow",
	});
});
