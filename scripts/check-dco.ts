import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** `git log` 里检查 DCO 要用的字段。 */
export interface Commit {
	sha: string;
	authorEmail: string;
	message: string;
}

/** 解析 `git log --format=%H%x00%ae%x00%B%x1e` 的输出。 */
export function parseLog(output: string): Commit[] {
	return output
		.split("\x1e")
		.filter((entry) => entry.trim() !== "")
		.map((entry) => {
			const [sha, authorEmail, message] = entry.replace(/^\n/, "").split("\0");
			if (
				sha === undefined ||
				authorEmail === undefined ||
				message === undefined
			) {
				throw new Error(`git log 的输出格式不对：${JSON.stringify(entry)}`);
			}
			return { sha, authorEmail, message };
		});
}

/** 没有和作者邮箱一致的 `Signed-off-by` 的提交。 */
export function unsignedCommits(commits: readonly Commit[]): Commit[] {
	return commits.filter(({ authorEmail, message }) => {
		const signers = Array.from(
			message.matchAll(/^Signed-off-by: .+ <([^<>]+)>\s*$/gm),
			(match) => match[1]?.toLowerCase(),
		);
		return !signers.includes(authorEmail.toLowerCase());
	});
}

function main(): void {
	const range = process.argv[2];
	if (range === undefined) {
		console.error("用法：node scripts/check-dco.ts <提交范围，如 base..head>");
		process.exitCode = 2;
		return;
	}
	const log = execFileSync(
		"git",
		["log", "--no-merges", "--format=%H%x00%ae%x00%B%x1e", range],
		{ cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
	);
	const commits = parseLog(log);
	const unsigned = unsignedCommits(commits);
	for (const { sha } of unsigned) {
		console.error(
			`${sha} 没有和作者邮箱一致的 Signed-off-by，用 git commit -s 签署`,
		);
	}
	if (unsigned.length > 0) {
		process.exitCode = 1;
	} else {
		console.log(`${range} 里的 ${commits.length} 个提交都已签署`);
	}
}

if (import.meta.main) main();
