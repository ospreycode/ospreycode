#!/usr/bin/env bash
# 在题目的环境里运行一次 agent：先检查环境，再运行 CLI 的非交互模式，最后把改动导出成补丁。
# Pier 的适配在任务容器里调用它，本地夹具的测试直接调用它，两边走的是同一段流程。
#
# 参数全部经环境变量给出，缺一个就报错；标了"可以为空"的也要显式给出。
#
# 退出码：
#   0   agent 运行过，结果在 $OSPREY_LOGS 里（exit-code、events.jsonl、stderr.log、model.patch）
#   70  开始前的检查没过：环境故障，agent 没有运行，原因在 $OSPREY_LOGS/environment-failure.txt
#   71  导不出补丁（题目的仓库被改坏了）
set -euo pipefail

: "${OSPREY_CLI:?要给出 CLI 的可执行文件}"
: "${OSPREY_WORKSPACE:?要给出题目仓库的目录}"
: "${OSPREY_LOGS:?要给出放结果的目录}"
: "${OSPREY_INSTRUCTION:?要给出题目说明的文件}"
: "${OSPREY_MODEL:?要给出模型}"
: "${OSPREY_RULES:?要给出权限规则文件}"
: "${OSPREY_CREDENTIAL_OPTION:?要给出 --credential-env 或 --credential-file}"
: "${OSPREY_CREDENTIAL:?要给出凭据的来源}"
: "${OSPREY_MAX_COST:?要给出费用上限}"
: "${OSPREY_MAX_REQUESTS:?要给出请求次数的上限}"
: "${OSPREY_TIMEOUT_SEC:?要给出时限}"
# 不该出现在 agent 环境里的路径（隐藏测试和参考答案），用空格分开，可以为空
: "${OSPREY_HIDDEN_PATHS?要给出 OSPREY_HIDDEN_PATHS}"
# 仓库里不该有的 commit（上游的修复），可以为空
: "${OSPREY_FORBIDDEN_COMMIT?要给出 OSPREY_FORBIDDEN_COMMIT}"
# 必须访问不到的 https 地址，可以为空（本地夹具没有网络隔离）
: "${OSPREY_BLOCKED_URL?要给出 OSPREY_BLOCKED_URL}"

mkdir -p "$OSPREY_LOGS"

environment_failure() {
	echo "$1" >"$OSPREY_LOGS/environment-failure.txt"
	echo "环境检查没过：$1" >&2
	exit 70
}

for hidden in $OSPREY_HIDDEN_PATHS; do
	if [ -e "$hidden" ]; then
		environment_failure "agent 的环境里有不该出现的 $hidden"
	fi
done

cd "$OSPREY_WORKSPACE"
if [ "$(git rev-parse --show-toplevel 2>/dev/null)" != "$(pwd -P)" ]; then
	environment_failure "$OSPREY_WORKSPACE 不是 git 仓库的根目录"
fi

if [ -n "$OSPREY_FORBIDDEN_COMMIT" ] &&
	git cat-file -e "$OSPREY_FORBIDDEN_COMMIT^{commit}" 2>/dev/null; then
	environment_failure "仓库里有上游修复的 commit $OSPREY_FORBIDDEN_COMMIT"
fi

# 别的分支、标签和 stash 里可能有题目之后的提交：每个引用都要在 HEAD 的历史里
while read -r object ref; do
	if ! git merge-base --is-ancestor "$object" HEAD 2>/dev/null; then
		environment_failure "引用 $ref 不在 HEAD 的历史里"
	fi
done < <(git for-each-ref --format='%(objectname) %(refname)')

if [ -n "$OSPREY_BLOCKED_URL" ]; then
	command -v curl >/dev/null || environment_failure "没有 curl，确认不了网络被限制"
	# 必须失败的探测：按 agent 的环境变量（带代理）访问一次，再绕过代理访问一次。
	# 地址要用 https：代理拒绝 CONNECT 时 curl 失败；http 的地址代理回 403，curl 仍算成功。
	if curl -sS -o /dev/null --max-time 15 "$OSPREY_BLOCKED_URL" 2>/dev/null; then
		environment_failure "经代理访问到了 $OSPREY_BLOCKED_URL，网络没有被限制"
	fi
	if curl -sS -o /dev/null --max-time 15 --noproxy '*' "$OSPREY_BLOCKED_URL" 2>/dev/null; then
		environment_failure "不经代理访问到了 $OSPREY_BLOCKED_URL，网络没有被限制"
	fi
fi

# 开始和结束时各给整个工作区建一个 tree，补丁是两者之差：不依赖仓库开始时是否干净，
# agent 提交过、换过分支也一样。用单独的 index 文件，不动仓库自己的 index。
snapshot() {
	local index
	index=$(mktemp)
	cp "$(git rev-parse --git-path index)" "$index"
	GIT_INDEX_FILE="$index" git add -A
	GIT_INDEX_FILE="$index" git write-tree
	rm -f "$index"
}

start_tree=$(snapshot) || environment_failure "给工作区建快照失败"

set +e
"$OSPREY_CLI" exec - \
	--cd "$OSPREY_WORKSPACE" \
	--model "$OSPREY_MODEL" \
	--sandbox danger-full-access \
	--rules "$OSPREY_RULES" \
	"$OSPREY_CREDENTIAL_OPTION" "$OSPREY_CREDENTIAL" \
	--json \
	--max-cost "$OSPREY_MAX_COST" \
	--max-requests "$OSPREY_MAX_REQUESTS" \
	--timeout "${OSPREY_TIMEOUT_SEC}s" \
	<"$OSPREY_INSTRUCTION" >"$OSPREY_LOGS/events.jsonl" 2>"$OSPREY_LOGS/stderr.log" &
agent=$!

# CLI 到时限会自己停下并收尾；再过一分钟还没退出就由这里结束它，补丁照样导出。
(
	trap 'kill "$sleeper" 2>/dev/null; exit 0' TERM
	sleep $((OSPREY_TIMEOUT_SEC + 60)) &
	sleeper=$!
	wait "$sleeper"
	kill -TERM "$agent" 2>/dev/null
	sleep 30 &
	sleeper=$!
	wait "$sleeper"
	kill -KILL "$agent" 2>/dev/null
) &
watchdog=$!

wait "$agent"
code=$?
kill -TERM "$watchdog" 2>/dev/null
wait "$watchdog" 2>/dev/null
set -e
echo "$code" >"$OSPREY_LOGS/exit-code"

if ! end_tree=$(snapshot) ||
	! git diff --binary "$start_tree" "$end_tree" >"$OSPREY_LOGS/model.patch"; then
	echo "导不出补丁" >&2
	exit 71
fi
