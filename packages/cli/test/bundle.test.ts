import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("打包的结果带第三方许可证文件：打进来的包各有名字、版本、许可证和许可证全文", () => {
	const notices = readFileSync(
		fileURLToPath(new URL("../dist/THIRD-PARTY-LICENSES.txt", import.meta.url)),
		"utf8",
	)
		.split(`\n\n${"-".repeat(72)}\n\n`)
		.slice(1);

	const names = notices.map((notice) =>
		notice.split("@").slice(0, -1).join("@"),
	);
	// 沙盒后端、图片缩放和配置解析都打进了入口文件
	expect(names).toEqual(
		expect.arrayContaining([
			"@anthropic-ai/sandbox-runtime",
			"@silvia-odwyer/photon-node",
			"smol-toml",
		]),
	);
	// 自己的包不算第三方，运行时从 node_modules 加载的包带着自己的许可证文件
	expect(names.filter((name) => name.startsWith("@ospreycode/"))).toEqual([]);
	expect(names).not.toContain("@earendil-works/pi-tui");
	for (const notice of notices) {
		const [title, license, ...text] = notice.split("\n");
		expect(title).toMatch(/^(@[^/]+\/)?[^/@]+@\d+\.\d+\.\d+/);
		expect(license).toMatch(/^License: \S/);
		expect(text.join("\n").trim().length, title).toBeGreaterThan(100);
	}
});
