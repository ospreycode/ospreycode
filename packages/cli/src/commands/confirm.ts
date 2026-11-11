import { createInterface } from "node:readline";
import type { CliContext } from "../context.js";
import { UsageError } from "../errors.js";

/** 问一句，读回用户输入的一行；输入结束（Ctrl+D）时读回空。 */
export type Ask = (question: string) => Promise<string>;

/** 标准输入不是终端时没法确认，是用法错误；`hint` 说明不询问时该怎么写。 */
export function requireTerminal(context: CliContext, hint: string): void {
	if (context.stdin.isTTY !== true) {
		throw new UsageError(`标准输入不是终端，没法确认：${hint}`);
	}
}

/** 在终端上连着问几句：问题写到 stderr，回答按行从标准输入读。先用 `requireTerminal` 确认是终端。 */
export async function prompting<Result>(
	context: CliContext,
	run: (ask: Ask) => Promise<Result>,
): Promise<Result> {
	const reader = createInterface({ input: context.stdin });
	const lines = reader[Symbol.asyncIterator]();
	try {
		return await run(async (question) => {
			context.stderr.write(question);
			const line = await lines.next();
			return line.done === true ? "" : line.value.trim();
		});
	} finally {
		reader.close();
	}
}

/** 回答是不是同意：只有 y 和 yes 算，别的（包括直接回车）都是不同意。 */
export function agreed(answer: string): boolean {
	return /^y(es)?$/i.test(answer);
}
