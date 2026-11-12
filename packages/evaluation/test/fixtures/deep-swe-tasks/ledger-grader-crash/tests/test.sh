#!/bin/bash
# 夹具的评分脚本：和上游一样在单独的干净仓库里运行，只拿到收集来的补丁（$ARTIFACTS/model.patch）。
# 补丁打不上记 0 分；脚本自己出错、没写下分数时记 -1。上游的路径写死在容器里，这里由环境变量给出。
set -uo pipefail
mkdir -p "$VERIFIER_LOGS"
trap 'if [ ! -f "$VERIFIER_LOGS/reward.txt" ]; then echo -1 >"$VERIFIER_LOGS/reward.txt"; fi' EXIT
if [ -s "$ARTIFACTS/model.patch" ] && ! git apply --whitespace=nowarn "$ARTIFACTS/model.patch"; then
	echo 0 >"$VERIFIER_LOGS/reward.txt"
	exit 0
fi
# 评分要用的工具不在：没有评出结果
exit 127
