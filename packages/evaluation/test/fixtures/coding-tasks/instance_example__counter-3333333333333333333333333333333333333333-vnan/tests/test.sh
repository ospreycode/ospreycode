#!/bin/bash
# 夹具的评分脚本：和上游一样把 1 或 0 写进 reward.txt。上游的路径写死在容器里，
# 这里在补丁打好的仓库里运行，放结果的目录由 VERIFIER_LOGS 给出。
if [ "$(sh count.sh | tr '\n' ' ')" = "1 2 3 " ]; then echo 1; else echo 0; fi >"$VERIFIER_LOGS/reward.txt"
