import type { Reporter, TestModule } from "vitest/node";

/** 运行结束时列出重跑之后才通过的测试（`diagnostic().flaky`），它们不算失败，但要有人看。 */
export class FlakyReporter implements Reporter {
	onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
		const flaky = testModules.flatMap((module) =>
			[...module.children.allTests()]
				.filter((test) => test.diagnostic()?.flaky === true)
				.map((test) => `${module.relativeModuleId} > ${test.fullName}`),
		);
		if (flaky.length === 0) return;
		console.log(
			`重跑之后才通过的测试（不稳定）：\n${flaky.map((name) => `  ${name}`).join("\n")}`,
		);
	}
}
