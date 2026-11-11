import { flag, type ParsedArgs } from "./parse.js";

/** 命令行指定的要恢复的 session：写明的标识，或者当前工作区最近写过的那个（`--last`）。 */
export type ResumeTarget = { kind: "id"; sessionId: string } | { kind: "last" };

/**
 * `resume` 和 `exec resume` 的位置参数。`--last` 占 `SESSION_ID` 的位置：写了它，第一个位置参数就
 * 不是 `SESSION_ID`，所以位置参数的个数由这两条命令自己检查，命令表里只有总的上限。返回要恢复的
 * session（两样都没写时为空）和它之后的位置参数。
 */
export function resumeArgs(args: ParsedArgs): {
	target: ResumeTarget | undefined;
	rest: readonly string[];
} {
	if (flag(args, "last")) {
		return { target: { kind: "last" }, rest: args.positionals };
	}
	const sessionId = args.positionals.at(0);
	return {
		target: sessionId === undefined ? undefined : { kind: "id", sessionId },
		rest: args.positionals.slice(1),
	};
}
