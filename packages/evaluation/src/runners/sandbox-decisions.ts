import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	decideCommand,
	decideFileEdits,
	decideMcpTool,
	decideNetwork,
	decidePermissions,
	loadShellParser,
	type PermissionDecision,
	parseRuleFile,
	type RuleFile,
	type ShellParser,
} from "@ospreycode/sandbox";
import type {
	DecisionCase,
	DecisionDirectories,
	DecisionRequest,
	ExpectedDecision,
} from "../suites/sandbox/decisions.js";

/** 一项权限判断的结果。 */
export interface DecisionResult {
	name: string;
	group: DecisionCase["group"];
	expected: ExpectedDecision;
	actual: ExpectedDecision;
	/** 询问时列出的原因，或拒绝时告诉模型的话。 */
	detail: string[];
}

function directories(): { root: string; dirs: DecisionDirectories } {
	const root = realpathSync(mkdtempSync("/tmp/osp-eval-rules-"));
	const home = join(root, "home");
	const dirs: DecisionDirectories = {
		home,
		workspace: join(home, "work"),
		hostRoot: join(home, ".ospreycode"),
		sessionTmp: join(home, ".ospreycode", "tmp", "s1"),
		credential: join(home, "secrets", "key"),
		tools: join(root, "tools", "bin"),
		outside: join(root, "outside"),
	};
	for (const directory of [
		dirs.workspace,
		dirs.sessionTmp,
		join(dirs.hostRoot, "data"),
		join(home, ".ssh"),
		join(home, "secrets"),
		dirs.tools,
		dirs.outside,
	]) {
		mkdirSync(directory, { recursive: true });
	}
	writeFileSync(dirs.credential, "not-a-real-key\n", { mode: 0o600 });
	// allow 规则要核对可执行文件的身份，所以放真实的文件：PATH 里的工具，和工作区里的同名程序
	for (const path of [
		...["git", "npm", "gh", "deploy"].map((name) => join(dirs.tools, name)),
		join(dirs.workspace, "rm"),
		join(dirs.workspace, "deploy"),
	]) {
		writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
	}
	return { root, dirs };
}

function level(decision: PermissionDecision): ExpectedDecision {
	if (decision.action !== "deny") return decision.action;
	return decision.reason === "policy" ? "deny" : "forbidden";
}

function decide(
	testCase: DecisionCase,
	request: DecisionRequest,
	dirs: DecisionDirectories,
	parser: ShellParser,
): PermissionDecision {
	const rules: RuleFile[] = (testCase.rules?.(dirs) ?? []).map(
		({ source, value }) =>
			parseRuleFile(value, { path: `/rules/${source}.toml`, source, parser }),
	);
	const policy = {
		sandboxMode: testCase.sandboxMode,
		approvalPolicy: testCase.approvalPolicy,
		...(testCase.granular === undefined ? {} : { granular: testCase.granular }),
	};
	switch (request.kind) {
		case "command":
			return decideCommand(
				{
					kind: "command",
					command: request.command,
					workdir: dirs.workspace,
					sandbox_permissions: request.sandbox_permissions ?? "use_default",
					...(request.additional_permissions === undefined
						? {}
						: { additional_permissions: request.additional_permissions }),
				},
				{
					...policy,
					parser,
					rules,
					workspace: dirs.workspace,
					home: dirs.home,
					hostRoot: dirs.hostRoot,
					hostAllowed: [dirs.sessionTmp],
					credentialPaths: [dirs.credential],
					agentWritable: [dirs.workspace, dirs.sessionTmp],
					path: `${dirs.tools}:/bin:/usr/bin`,
				},
			);
		case "file_edits":
			return decideFileEdits(
				{
					kind: "file_edits",
					edits: request.paths.map((path) => ({
						op: "add",
						path,
						old_sha256: null,
						content: "",
					})),
				},
				policy,
			);
		case "permissions":
			return decidePermissions(
				{
					kind: "permissions",
					...(request.write === undefined
						? {}
						: { file_system: { write: request.write } }),
					...(request.network === undefined
						? {}
						: { network: request.network }),
				},
				policy,
			);
		case "network":
			return decideNetwork(
				{ kind: "network", host: request.host, port: 443 },
				{ ...policy, rules },
			);
		case "mcp_tool":
			return decideMcpTool(
				{
					kind: "mcp_tool",
					server: request.server,
					tool: request.tool,
					arguments: "{}",
				},
				{ ...policy, rules, destructive: request.destructive },
			);
	}
}

/**
 * 用 `sandbox` 包的 Permission 判断一组固定的动作，和预期逐项对照。不启动沙盒，也不需要模型：
 * 这一层只看规则匹配和内置的判断。
 */
export async function runDecisionCases(
	cases: readonly DecisionCase[],
): Promise<DecisionResult[]> {
	const parser = await loadShellParser();
	const { root, dirs } = directories();
	try {
		return cases.map((testCase) => {
			const decision = decide(testCase, testCase.request(dirs), dirs, parser);
			return {
				name: testCase.name,
				group: testCase.group,
				expected: testCase.expected,
				actual: level(decision),
				detail:
					decision.action === "ask"
						? decision.reasons
						: decision.action === "deny"
							? [decision.message]
							: [],
			};
		});
	} finally {
		rmSync(root, { recursive: true });
	}
}
