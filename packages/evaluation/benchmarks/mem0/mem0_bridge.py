"""Mem0 对照组的桥接进程：evaluation 经标准输入输出和 Mem0 的 Python 版按行交换 JSON。

按 mem0ai 2.2.1 的接口写，由 packages/evaluation/src/runners/mem0.ts 启动，用法见
packages/evaluation/README.md。一道题的一次运行一个进程。

启动参数是一个 JSON 配置文件的路径，里面有：

- ``base_url``：evaluation 开的记录用量的代理，模型和嵌入请求都发给它
- ``llm_model``、``embedding_model``、``embedding_dims``
- ``vector_store_path``、``history_db_path``：这次运行自己的向量库和历史库
- ``user_id``：这次运行在 Mem0 里的 ``user_id``

启动后先写一行 ``{"ok": true, "result": {"version": "<mem0ai 的版本>"}}``，之后每读一行请求
写一行回应，标准输入关闭时退出：

- ``{"op": "add", "messages": [{"role": ..., "content": ...}]}`` → ``{"added": <条数>}``
- ``{"op": "search", "query": ..., "limit": N}`` → ``{"memories": [<文字>, ...]}``

出错时回应是 ``{"ok": false, "error": "<原因>"}``。
"""

from __future__ import annotations

import json
import sys
from importlib.metadata import version
from pathlib import Path

# 真正的密钥由代理加到上游请求上，不进这个进程
PLACEHOLDER_KEY = "held-by-the-evaluation-proxy"
COLLECTION = "osprey_evaluation"


def memory_config(config: dict) -> dict:
    """Mem0 的配置：存储位置都显式给出，默认的位置在 ``MEM0_DIR`` 之外、题目之间会共用。"""
    model = {"api_key": PLACEHOLDER_KEY, "openai_base_url": config["base_url"]}
    return {
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "path": config["vector_store_path"],
                "collection_name": COLLECTION,
                "embedding_model_dims": config["embedding_dims"],
                "on_disk": True,
            },
        },
        "llm": {
            "provider": "openai",
            "config": {**model, "model": config["llm_model"]},
        },
        "embedder": {
            "provider": "openai",
            "config": {
                **model,
                "model": config["embedding_model"],
                "embedding_dims": config["embedding_dims"],
            },
        },
        "history_db_path": config["history_db_path"],
    }


def handle(memory, user_id: str, request: dict) -> dict:
    if request["op"] == "add":
        added = memory.add(request["messages"], user_id=user_id, infer=True)
        return {"added": len(added["results"])}
    if request["op"] == "search":
        found = memory.search(
            request["query"],
            top_k=request["limit"],
            filters={"user_id": user_id},
        )
        return {"memories": [entry["memory"] for entry in found["results"]]}
    raise ValueError(f"不认识的操作：{request['op']}")


def main() -> None:
    config = json.loads(Path(sys.argv[1]).read_text())
    # Mem0 和它的依赖往标准输出写的提示不能混进回应里
    protocol = sys.stdout
    sys.stdout = sys.stderr

    def reply(payload: dict) -> None:
        protocol.write(json.dumps(payload) + "\n")
        protocol.flush()

    from mem0 import Memory

    memory = Memory.from_config(memory_config(config))
    reply({"ok": True, "result": {"version": version("mem0ai")}})
    for line in sys.stdin:
        try:
            result = handle(memory, config["user_id"], json.loads(line))
        except Exception as error:  # noqa: BLE001 协议的边界：出错作为失败的回应交回去
            reply({"ok": False, "error": f"{type(error).__name__}: {error}"})
        else:
            reply({"ok": True, "result": result})


if __name__ == "__main__":
    main()
