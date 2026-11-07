import { newId } from "@ospreycode/agent-host";
import { expect, test } from "vitest";

test("标识是小写的 UUID v4，前 12 个字符互不相同", () => {
	const ids = Array.from({ length: 1000 }, newId);
	for (const id of ids) {
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	}
	expect(new Set(ids.map((id) => id.slice(0, 12))).size).toBe(ids.length);
});
