// 测试用的 pier：没有 Docker 时在本机目录里把夹具题目跑一遍，写出和 Pier 0.3.1 一样的 job 目录。
//
// 和真的 Pier 一致的部分：命令行参数、job 和 trial 的目录、result.json 里评测要读的字段、
// 两个 agent 的行为（OspreyCode 调 run-agent.sh，PatchReplay 把上一遍的补丁打到干净的仓库上再评分）。
// 不一样的部分：题目的"镜像"是 environment/workspace 里的文件建成的 git 仓库
// （environment/leaked-history 里有文件时，另有一个带着答案的分支），没有网络隔离，
// CLI 用本机构建好的（FAKE_PIER_CLI），密钥从文件读（FAKE_PIER_CREDENTIAL_FILE）。

import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

// 出错时只打印一行原因：测试里有故意让它失败的情况
process.on("uncaughtException", (error) => {
	console.error(`假的 pier：${error.message}`);
	process.exit(1);
});

function required(name) {
	const value = process.env[name];
	if (value === undefined) throw new Error(`假的 pier 要有环境变量 ${name}`);
	return value;
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
	console.log(required("FAKE_PIER_VERSION"));
	process.exit(0);
}
if (args.shift() !== "run") throw new Error("假的 pier 只会 run");

const flags = new Set(["--yes", "--disable-verification"]);
const options = {};
const kwargs = {};
while (args.length > 0) {
	const name = args.shift();
	if (flags.has(name)) {
		options[name] = true;
	} else if (name === "--agent-kwarg") {
		const [key, ...value] = args.shift().split("=");
		kwargs[key] = value.join("=");
	} else {
		options[name] = args.shift();
	}
}
const option = (name) => {
	if (options[name] === undefined) throw new Error(`pier run 缺少 ${name}`);
	return options[name];
};
const kwarg = (name) => {
	if (kwargs[name] === undefined) throw new Error(`agent 缺少参数 ${name}`);
	return kwargs[name];
};
if (option("--env") !== "docker" || option("--n-attempts") !== "1") {
	throw new Error("评测应当用 docker 环境，每个 job 里一道题只运行一次");
}

const adapter = required("PYTHONPATH").split(":")[0];
const agentClass = option("--agent-import-path");
if (
	agentClass === "osprey_pier:OspreyCode" &&
	options["--disable-verification"] !== true
) {
	throw new Error("假的 pier 不在 agent 用过的仓库里评分");
}
const job = join(option("--jobs-dir"), option("--job-name"));
mkdirSync(job, { recursive: true });

function run(command, commandArgs, settings) {
	const result = spawnSync(command, commandArgs, {
		encoding: "utf8",
		...settings,
	});
	if (result.error !== undefined) throw result.error;
	return result;
}

/** 按题目的"镜像"建一个干净的仓库。 */
function container(task, trial) {
	const app = join(trial, "container", "app");
	cpSync(join(task, "environment", "workspace"), app, { recursive: true });
	const git = (...gitArgs) => {
		const result = run(
			"git",
			[
				"-c",
				"user.name=fixture",
				"-c",
				"user.email=fixture@example.com",
			].concat(gitArgs),
			{ cwd: app },
		);
		if (result.status !== 0) throw new Error(result.stderr);
	};
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-q", "-m", "base");
	const leaked = join(task, "environment", "leaked-history");
	if (existsSync(leaked)) {
		git("checkout", "-q", "-b", "upstream");
		cpSync(leaked, app, { recursive: true });
		git("commit", "-q", "-a", "-m", "fix");
		git("checkout", "-q", "main");
	}
	return app;
}

class EnvironmentCheckError extends Error {}

function ospreyCode(task, taskName, trial, app) {
	const [credentialId, variable] = kwarg("credential").split("=");
	required(variable);
	const result = run("bash", [join(adapter, "run-agent.sh")], {
		cwd: app,
		env: {
			PATH: required("PATH"),
			HOME: required("HOME"),
			OSPREY_CLI: required("FAKE_PIER_CLI"),
			OSPREY_WORKSPACE: app,
			OSPREY_LOGS: join(trial, "agent"),
			OSPREY_INSTRUCTION: join(task, "instruction.md"),
			OSPREY_MODEL: option("--model"),
			OSPREY_RULES: join(adapter, "..", "coding-rules.toml"),
			OSPREY_CREDENTIAL_OPTION: "--credential-file",
			OSPREY_CREDENTIAL: `${credentialId}=${required("FAKE_PIER_CREDENTIAL_FILE")}`,
			OSPREY_MAX_COST: kwarg("max_cost_usd"),
			OSPREY_MAX_REQUESTS: kwarg("max_requests"),
			OSPREY_TIMEOUT_SEC: kwarg("timeout_sec"),
			OSPREY_HIDDEN_PATHS: `${join(trial, "container", "tests")} ${join(trial, "container", "solution")}`,
			OSPREY_FORBIDDEN_COMMIT:
				/-([0-9a-f]{40})(?:-v[0-9a-zA-Z]+)?$/.exec(taskName)?.[1] ?? "",
			OSPREY_BLOCKED_URL: "",
		},
	});
	if (result.status === 70) throw new EnvironmentCheckError(result.stderr);
	if (result.status !== 0) {
		throw new Error(
			`run-agent.sh 的退出码是 ${result.status}：${result.stderr}`,
		);
	}
}

function patchReplay(taskName, app) {
	const source = kwarg("source_job");
	const trials = readdirSync(source)
		.map((name) => join(source, name))
		.filter(
			(directory) =>
				existsSync(join(directory, "result.json")) &&
				JSON.parse(readFileSync(join(directory, "result.json"), "utf8"))
					.task_name === taskName,
		);
	if (trials.length !== 1) {
		throw new EnvironmentCheckError(
			`${taskName} 应当正好运行过一次，实际有 ${trials.length} 次`,
		);
	}
	const patch = join(trials[0], "agent", "model.patch");
	if (!existsSync(patch)) throw new EnvironmentCheckError("没有导出补丁");
	if (readFileSync(patch).length === 0) return;
	const applied = run("git", ["apply", "--whitespace=nowarn", patch], {
		cwd: app,
	});
	if (applied.status !== 0) throw new EnvironmentCheckError(applied.stderr);
}

function verify(task, trial, app) {
	const logs = join(trial, "verifier");
	run("bash", [join(task, "tests", "test.sh")], {
		cwd: app,
		env: { PATH: required("PATH"), VERIFIER_LOGS: logs },
	});
	return {
		rewards: { reward: Number(readFileSync(join(logs, "reward.txt"), "utf8")) },
	};
}

const dataset = option("--path");
for (const [index, id] of readdirSync(dataset).sort().entries()) {
	const task = join(dataset, id);
	const taskName = /^name = "(.+)"$/m.exec(
		readFileSync(join(task, "task.toml"), "utf8"),
	)[1];
	const trialName = `${id.slice(0, 32)}__fake${String(index).padStart(3, "0")}`;
	const trial = join(job, trialName);
	mkdirSync(join(trial, "agent"), { recursive: true });
	mkdirSync(join(trial, "verifier"));
	const app = container(task, trial);
	const result = {
		task_name: taskName,
		trial_name: trialName,
		exception_info: null,
		verifier_result: null,
		agent_execution: { started_at: new Date().toISOString() },
	};
	try {
		if (agentClass === "osprey_pier:OspreyCode") {
			ospreyCode(task, taskName, trial, app);
		} else if (agentClass === "osprey_pier:PatchReplay") {
			patchReplay(taskName, app);
		} else {
			throw new Error(`不认识的 agent：${agentClass}`);
		}
	} catch (error) {
		// 和 Pier 一样：agent 出的错记在这道题的结果里，job 继续
		result.exception_info = {
			exception_type: error.constructor.name,
			exception_message: error.message,
		};
	}
	result.agent_execution.finished_at = new Date().toISOString();
	// 和 Pier 一样：重放补丁出了错就不评分
	if (
		result.exception_info === null &&
		options["--disable-verification"] !== true
	) {
		result.verifier_result = verify(task, trial, app);
	}
	writeFileSync(join(trial, "result.json"), JSON.stringify(result, null, 2));
}
