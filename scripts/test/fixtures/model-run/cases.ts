import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "vitest";
import {
	charge,
	checkLedger,
	expectNoModelError,
	throwIfTransient,
} from "../../../model-test.js";

const state = process.env.MODEL_RUN_STATE as string;

/** 记下这个用例又运行了一次，返回这是第几次。 */
function attempt(name: string): number {
	const file = join(state, name);
	appendFileSync(file, "x");
	return readFileSync(file, "utf8").length;
}

beforeEach(checkLedger);

test("第一次遇到服务过载", { tags: ["model"] }, () => {
	if (attempt("overloaded-once") === 1) {
		expectNoModelError({ category: "overloaded", message: "busy" });
	}
});

test("task 第一次因为网络中断失败", { tags: ["model"] }, () => {
	if (attempt("network-once") === 1) {
		throwIfTransient({ outcome: "failed", error: "network: socket hang up" });
	}
});

test("一直限流", { tags: ["model"] }, () => {
	attempt("rate-limited");
	expectNoModelError({ category: "rate_limit", message: "slow down" });
});

test("请求格式错误", { tags: ["model"] }, () => {
	attempt("invalid-request");
	expectNoModelError({ category: "invalid_request", message: "bad schema" });
});

test("用了 token 却没有费用", { tags: ["model"] }, () => {
	charge({ input: 10, output: 10 });
});

test("花掉超过上限的费用", { tags: ["model"] }, () => {
	charge({ input: 1000, output: 1000, cost_usd: 1.5 });
});

test("账本超过上限之后的测试", { tags: ["model"] }, () => {
	attempt("after-limit");
});
