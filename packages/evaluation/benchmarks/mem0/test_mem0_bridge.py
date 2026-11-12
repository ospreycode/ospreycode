"""桥接脚本的测试：用真的 mem0ai 和一个本机的假模型接口，不联网。

在装了 mem0ai 2.2.1 的 Python 里运行：

    cd packages/evaluation/benchmarks/mem0 && python -m unittest -v
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BRIDGE = Path(__file__).with_name("mem0_bridge.py")
DIMS = 64


def embedding(text: str) -> list[float]:
    """按词散列到固定的几维：有相同的词的两段文字向量接近。"""
    vector = [0.0] * DIMS
    for word in re.findall(r"[a-z0-9-]+", text.lower()):
        vector[int(hashlib.sha256(word.encode()).hexdigest(), 16) % DIMS] += 1.0
    return vector


class FakeModelService(BaseHTTPRequestHandler):
    """OpenAI 兼容接口里 Mem0 用到的两个：嵌入，和提炼记忆的 chat completions。"""

    requests: list[tuple[str, dict]] = []
    extracted: list[str] = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        type(self).requests.append((self.path, body))
        if self.path == "/v1/embeddings":
            inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
            reply = {
                "object": "list",
                "model": body["model"],
                "data": [
                    {"object": "embedding", "index": index, "embedding": embedding(text)}
                    for index, text in enumerate(inputs)
                ],
                "usage": {"prompt_tokens": 7, "total_tokens": 7},
            }
        elif self.path == "/v1/chat/completions":
            reply = {
                "id": "chatcmpl-test",
                "object": "chat.completion",
                "created": 0,
                "model": body["model"],
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {"memory": [{"text": text} for text in type(self).extracted]}
                            ),
                        },
                    }
                ],
                "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
            }
        else:
            self.send_error(404)
            return
        payload = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class BridgeTest(unittest.TestCase):
    def setUp(self):
        FakeModelService.requests = []
        FakeModelService.extracted = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeModelService)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def start(self, user_id: str = "run-1") -> subprocess.Popen:
        data = self.directory / "mem0"
        home = self.directory / "home"
        home.mkdir(exist_ok=True)
        config = self.directory / "config.json"
        config.write_text(
            json.dumps(
                {
                    "base_url": f"http://127.0.0.1:{self.server.server_port}/v1",
                    "llm_model": "extract-model",
                    "embedding_model": "embed-model",
                    "embedding_dims": DIMS,
                    "vector_store_path": str(data / "qdrant"),
                    "history_db_path": str(data / "history.db"),
                    "user_id": user_id,
                }
            )
        )
        process = subprocess.Popen(
            [sys.executable, str(BRIDGE), str(config)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={
                "PATH": os.environ["PATH"],
                "HOME": str(home),
                "MEM0_DIR": str(data),
                "MEM0_TELEMETRY": "false",
            },
        )
        self.addCleanup(process.wait)
        self.addCleanup(process.kill)
        return process

    def call(self, process: subprocess.Popen, request: dict) -> dict:
        process.stdin.write(json.dumps(request) + "\n")
        process.stdin.flush()
        return json.loads(process.stdout.readline())

    def finish(self, process: subprocess.Popen) -> int:
        process.stdin.close()
        code = process.wait(timeout=60)
        process.stdout.close()
        process.stderr.close()
        return code

    def test_adds_and_searches_with_the_given_models_and_storage(self):
        FakeModelService.extracted = [
            "The deploy code is K-42",
            "Release notes go in docs/releases/NOTES.md",
        ]
        process = self.start()
        self.assertEqual(
            json.loads(process.stdout.readline()),
            {"ok": True, "result": {"version": "2.2.1"}},
        )

        added = self.call(
            process,
            {
                "op": "add",
                "messages": [
                    {"role": "user", "content": "The deploy code is K-42. Remember it."},
                    {"role": "assistant", "content": "OK"},
                ],
            },
        )
        self.assertEqual(added, {"ok": True, "result": {"added": 2}})

        found = self.call(
            process, {"op": "search", "query": "What is the deploy code?", "limit": 1}
        )
        self.assertEqual(
            found, {"ok": True, "result": {"memories": ["The deploy code is K-42"]}}
        )
        both = self.call(
            process, {"op": "search", "query": "deploy code release notes", "limit": 5}
        )
        self.assertCountEqual(both["result"]["memories"], FakeModelService.extracted)

        self.assertEqual(self.finish(process), 0)

        # 请求只发给配置里的接口，用的是配置里的模型；嵌入带上了维数
        paths = {path for path, _ in FakeModelService.requests}
        self.assertEqual(paths, {"/v1/embeddings", "/v1/chat/completions"})
        for path, body in FakeModelService.requests:
            if path == "/v1/embeddings":
                self.assertEqual(body["model"], "embed-model")
                self.assertEqual(body["dimensions"], DIMS)
            else:
                self.assertEqual(body["model"], "extract-model")
                self.assertNotEqual(body.get("stream"), True)
        # 存储都在这次运行自己的目录里
        self.assertTrue((self.directory / "mem0" / "qdrant").is_dir())
        self.assertTrue((self.directory / "mem0" / "history.db").is_file())
        self.assertEqual(
            sorted(path.name for path in (self.directory / "home").iterdir()), []
        )

    def test_memories_of_another_user_id_are_not_returned(self):
        FakeModelService.extracted = ["The deploy code is K-42"]
        first = self.start("run-1")
        first.stdout.readline()
        self.call(
            first,
            {"op": "add", "messages": [{"role": "user", "content": "The deploy code is K-42."}]},
        )
        self.assertEqual(self.finish(first), 0)

        second = self.start("run-2")
        second.stdout.readline()
        found = self.call(second, {"op": "search", "query": "deploy code", "limit": 5})
        self.assertEqual(found, {"ok": True, "result": {"memories": []}})
        self.assertEqual(self.finish(second), 0)

    def test_failures_are_reported_as_replies_and_the_process_keeps_serving(self):
        process = self.start()
        process.stdout.readline()
        unknown = self.call(process, {"op": "delete"})
        self.assertEqual(unknown["ok"], False)
        self.assertIn("delete", unknown["error"])
        found = self.call(process, {"op": "search", "query": "anything", "limit": 5})
        self.assertEqual(found, {"ok": True, "result": {"memories": []}})
        self.assertEqual(self.finish(process), 0)


if __name__ == "__main__":
    unittest.main()
