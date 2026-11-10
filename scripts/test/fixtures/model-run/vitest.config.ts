import { join } from "node:path";
import { mergeConfig } from "vitest/config";
import base from "../../../../vitest.config.js";

const state = process.env.MODEL_RUN_STATE;
if (state === undefined) {
	throw new Error("要用 MODEL_RUN_STATE 给出存放结果的目录");
}

/**
 * 用仓库的测试配置（`model` 标签、全局初始化和报告）运行 cases.ts 里故意失败的用例，
 * 由 scripts/test/model-run.test.ts 在子进程里启动，在仓库根目录运行。
 */
export default mergeConfig(base, {
	test: {
		include: ["scripts/test/fixtures/model-run/cases.ts"],
		// 和外层的测试运行共用仓库的缓存目录，不让两边同时写结果缓存
		cache: false,
		reporters: [["json", { outputFile: join(state, "report.json") }]],
	},
});
