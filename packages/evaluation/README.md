# @ospreycode/evaluation

检查各部分单独和组合起来是否真的有效。设计见仓库里的 `docs/packages/evaluation.md`。

只在本仓库里使用，不发布到 npm。

## 用法

- `runScenario(scenario, environment, {timeoutMs})` 经 Host 的 SDK 运行一个场景：从干净的临时目录和 HOME 开始，按场景的脚本回答询问、在指定的事件出现时取消，task 结束后关闭 session，按结构化的结果检查（task 的结果、工具调用的状态、文件和用量），不看模型写的原文。
- `p0Scenarios` 是 P0 的验收场景：完成任务、等待批准（含一次越界申请）、被用户拒绝、被审批策略拒绝、运行中取消。它们需要 macOS 的沙盒后端和真实模型。
- `summarize`、`formatSummary` 汇总一组场景的通过数、费用和耗时。

P0 的验收场景写成带 `model` 标签的测试（`test/p0.model.test.ts`），由维护者在本机运行：

```sh
OSPREYCODE_TEST_KEYS=~/.ospreycode-test-keys npm run test:model
```

## 运行环境

Node.js `^24.15.0 || >=26.0.0`。

## 许可证

Apache-2.0
