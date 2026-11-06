import { describe, expect, test } from "vitest";
import { parseLog, unsignedCommits } from "../check-dco.ts";

function commit(message: string, authorEmail = "dev@example.com") {
	return { sha: "abc123", authorEmail, message };
}

describe("unsignedCommits", () => {
	test("接受和作者邮箱一致的 Signed-off-by，不分大小写", () => {
		expect(
			unsignedCommits([
				commit("fix: x\n\nSigned-off-by: Dev <dev@example.com>\n"),
				commit("fix: y\n\nSigned-off-by: Dev <DEV@Example.com>"),
			]),
		).toEqual([]);
	});

	test("拦下没有签署或签署人不是作者的提交", () => {
		const unsigned = unsignedCommits([
			commit("fix: x"),
			commit("fix: y\n\nSigned-off-by: Other <other@example.com>"),
			commit("fix: z, see Signed-off-by: Dev <dev@example.com> in the docs"),
		]);
		expect(unsigned).toHaveLength(3);
	});
});

describe("parseLog", () => {
	test("解析 git log 用 NUL 和 RS 分隔的输出", () => {
		const output =
			"a1\0a@example.com\0first\n\nSigned-off-by: A <a@example.com>\n\x1e\n" +
			"b2\0b@example.com\0second\n\x1e\n";
		expect(parseLog(output)).toEqual([
			{
				sha: "a1",
				authorEmail: "a@example.com",
				message: "first\n\nSigned-off-by: A <a@example.com>\n",
			},
			{ sha: "b2", authorEmail: "b@example.com", message: "second\n" },
		]);
	});
});
