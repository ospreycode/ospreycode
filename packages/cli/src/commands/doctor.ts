import { doctor } from "@ospreycode/agent-host";
import { flag, type ParsedArgs } from "../args/parse.js";
import type { CliContext } from "../context.js";
import { hostRoot } from "../host.js";

/**
 * `ospreycode doctor`：逐项检查运行环境，每项一行写明通过还是失败；`--json` 输出一个 JSON 数组，
 * 字段和 Host SDK 的 `DoctorCheck` 相同。有一项失败时退出码是 1。
 */
export async function runDoctor(
	args: ParsedArgs,
	context: CliContext,
): Promise<number> {
	const checks = await doctor({
		root: hostRoot(context),
		env: context.env,
		workspace: context.cwd,
	});
	if (flag(args, "json")) {
		context.stdout.write(`${JSON.stringify(checks)}\n`);
	} else {
		for (const check of checks) {
			context.stdout.write(
				`[${check.ok ? "通过" : "失败"}] ${check.id}：${check.message}\n`,
			);
		}
	}
	return checks.every((check) => check.ok) ? 0 : 1;
}
