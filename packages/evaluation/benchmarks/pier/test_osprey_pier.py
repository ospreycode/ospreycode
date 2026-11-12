"""适配的单元测试：用记录调用的假环境，不启动容器。

在装了 datacurve-pier 0.3.1 的 Python 里运行：

    cd packages/evaluation/benchmarks/pier && python -m unittest -v
"""

import asyncio
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml
from pier.agents.installed.base import NonZeroAgentExitCodeError
from pier.environments.base import ExecResult
from pier.environments.docker.docker import DockerEnvironment
from pier.models.agent.context import AgentContext
from pier.models.task.config import EnvironmentConfig
from pier.models.trial.paths import EnvironmentPaths, TrialPaths

import osprey_pier

TASK = "instance_example__calc-0123456789abcdef0123456789abcdef01234567-vnan"
BENCHMARKS = Path(osprey_pier.__file__).resolve().parent.parent
CODING_RULES = BENCHMARKS / "coding-rules.toml"
SANDBOX_RULES = BENCHMARKS / "sandbox-comparison-rules.toml"


class FakeEnvironment:
    """记下上传和执行的内容，按预先给出的结果回应。"""

    env_paths = EnvironmentPaths()
    default_user = None

    def __init__(self, name: str, results: list[ExecResult] | None = None):
        self.environment_name = name
        self.uploads: list[tuple[str, str]] = []
        self.commands: list[tuple[str, dict[str, str] | None, object]] = []
        self._results = list(results or [])

    async def upload_file(self, source_path, target_path):
        self.uploads.append((Path(source_path).read_text(), target_path))

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
        self.commands.append((command, env, user))
        if "run-agent.sh" in command or "git apply" in command:
            return self._results.pop(0)
        return ExecResult(return_code=0)

    def agent_process_env(self, env):
        return {**(env or {}), "HTTPS_PROXY": "http://agent:token@proxy:8080"}


def osprey(logs: Path, **overrides) -> osprey_pier.OspreyCode:
    kwargs = {
        "logs_dir": logs,
        "model_name": "claude-haiku-5-5",
        "cli_packages": "@ospreycode/cli@0.1.0",
        "model_host": "api.anthropic.com",
        "credential": "anthropic=EVAL_KEY",
        "max_cost_usd": 2,
        "max_requests": "none",
        "timeout_sec": 2880,
        "sandbox_mode": "danger-full-access",
        "rules_file": str(CODING_RULES),
        "allowed_hosts": "",
        "sandbox_container": "no",
        "commit": "no",
        **overrides,
    }
    return osprey_pier.OspreyCode(**kwargs)


class OspreyCodeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.logs = Path(self.temp.name) / "agent"
        self.addCleanup(self.temp.cleanup)
        patcher = mock.patch.dict(os.environ, {"EVAL_KEY": "secret-value"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_密钥的环境变量没有设置时不启动(self):
        with self.assertRaisesRegex(ValueError, "OTHER_KEY"):
            osprey(self.logs, credential="anthropic=OTHER_KEY")
        with self.assertRaisesRegex(ValueError, "credential"):
            osprey(self.logs, credential="anthropic")

    def test_权限的参数写错时不启动(self):
        with self.assertRaisesRegex(ValueError, "sandbox_mode"):
            osprey(self.logs, sandbox_mode="read-only")
        with self.assertRaisesRegex(ValueError, "no-such-rules.toml"):
            osprey(self.logs, rules_file="/tmp/no-such-rules.toml")
        with self.assertRaisesRegex(ValueError, "sandbox_container"):
            osprey(self.logs, sandbox_container="true")
        with self.assertRaisesRegex(ValueError, "commit"):
            osprey(self.logs, commit="")
        # 探测沙盒的命令只从用户级配置里取模型
        with self.assertRaisesRegex(ValueError, "config_file"):
            osprey(self.logs, sandbox_container="yes")

    def test_安装步骤和放行的域名(self):
        agent = osprey(self.logs)
        spec = agent.install_spec()
        install = spec.steps[-1].run
        self.assertIn("@ospreycode/cli@0.1.0", install)
        self.assertIn("--ignore-scripts", install)
        self.assertIn(f"node-v{osprey_pier.NODE_VERSION}-linux-x64", install)
        self.assertEqual(spec.verification_command, "/opt/osprey/bin/ospreycode --version")
        self.assertEqual(agent.network_allowlist().domains, ["api.anthropic.com"])
        self.assertFalse(any("bubblewrap" in step.run for step in spec.steps))

    def test_开沙盒的容器多装三样依赖并放行给出的域名(self):
        config = Path(self.temp.name) / "config.toml"
        config.write_text('model = "claude-haiku-5-5"\n')
        agent = osprey(
            self.logs,
            sandbox_mode="workspace-write",
            rules_file=str(SANDBOX_RULES),
            allowed_hosts="registry.npmjs.org pypi.org",
            sandbox_container="yes",
            config_file=str(config),
        )
        spec = agent.install_spec()
        packages = [step for step in spec.steps if "bubblewrap" in step.run]
        self.assertEqual(len(packages), 1)
        self.assertEqual(packages[0].user, "root")
        self.assertIn("apt-get install -y bubblewrap socat ripgrep", packages[0].run)
        # CLI 的安装还是最后一步
        self.assertIn("@ospreycode/cli@0.1.0", spec.steps[-1].run)
        self.assertCountEqual(
            agent.network_allowlist().domains,
            ["api.anthropic.com", "registry.npmjs.org", "pypi.org"],
        )

        environment = FakeEnvironment(TASK, [ExecResult(return_code=0)])
        asyncio.run(agent.run("任务", environment, AgentContext()))
        self.assertIn((SANDBOX_RULES.read_text(), "/installed-agent/rules.toml"), environment.uploads)
        _, env, _ = environment.commands[-1]
        self.assertEqual(env["OSPREY_SANDBOX"], "workspace-write")
        self.assertEqual(env["OSPREY_SANDBOX_PROBE"], "yes")
        self.assertEqual(env["OSPREY_COMMIT"], "no")

    def test_要求收尾提交时告诉脚本(self):
        agent = osprey(self.logs, commit="yes")
        environment = FakeEnvironment("datacurve/example-task", [ExecResult(return_code=0)])
        asyncio.run(agent.run("任务", environment, AgentContext()))
        _, env, _ = environment.commands[-1]
        self.assertEqual(env["OSPREY_COMMIT"], "yes")
        self.assertEqual(env["OSPREY_SANDBOX_PROBE"], "no")
        # 题目名里没有上游修复的 commit
        self.assertEqual(env["OSPREY_FORBIDDEN_COMMIT"], "")

    def test_运行时给出脚本要的全部变量(self):
        agent = osprey(self.logs)
        environment = FakeEnvironment(TASK, [ExecResult(return_code=0)])
        asyncio.run(agent.run("修好 sum", environment, AgentContext()))

        self.assertEqual(
            [target for _, target in environment.uploads],
            [
                "/installed-agent/run-agent.sh",
                "/installed-agent/rules.toml",
                "/installed-agent/instruction.md",
            ],
        )
        self.assertEqual(environment.uploads[1][0], CODING_RULES.read_text())
        self.assertEqual(environment.uploads[2][0], "修好 sum")
        command, env, _ = environment.commands[-1]
        self.assertEqual(command, 'OSPREY_WORKSPACE="$PWD" bash /installed-agent/run-agent.sh')
        script = osprey_pier.RUN_SCRIPT.read_text()
        required = set(re.findall(r'^: "\$\{(OSPREY_[A-Z_]+)', script, re.MULTILINE))
        self.assertEqual(required - {"OSPREY_WORKSPACE"}, {k for k in env if k.startswith("OSPREY_")})
        self.assertEqual(env["OSPREY_MODEL"], "claude-haiku-5-5")
        self.assertEqual(env["OSPREY_SANDBOX"], "danger-full-access")
        self.assertEqual(env["OSPREY_SANDBOX_PROBE"], "no")
        self.assertEqual(env["OSPREY_COMMIT"], "no")
        self.assertEqual(env["OSPREY_CREDENTIAL"], "anthropic=EVAL_KEY")
        self.assertEqual(env["EVAL_KEY"], "secret-value")
        self.assertEqual(env["OSPREY_MAX_COST"], "2")
        self.assertEqual(env["OSPREY_MAX_REQUESTS"], "none")
        self.assertEqual(env["OSPREY_TIMEOUT_SEC"], "2880")
        self.assertEqual(env["OSPREY_HIDDEN_PATHS"], "/tests /solution")
        self.assertEqual(env["OSPREY_FORBIDDEN_COMMIT"], "0123456789abcdef0123456789abcdef01234567")
        self.assertEqual(env["OSPREY_LOGS"], "/logs/agent")
        # Pier 给 agent 的代理设置要留着：CLI 靠它访问模型服务
        self.assertEqual(env["HTTPS_PROXY"], "http://agent:token@proxy:8080")

    def test_配置文件放进容器里的用户目录(self):
        config = Path(self.temp.name) / "config.toml"
        config.write_text('model = "custom"\n')
        agent = osprey(self.logs, config_file=str(config))
        environment = FakeEnvironment(TASK, [ExecResult(return_code=0)])
        asyncio.run(agent.run("任务", environment, AgentContext()))

        self.assertIn(('model = "custom"\n', "/installed-agent/config.toml"), environment.uploads)
        self.assertTrue(any("~/.ospreycode/config.toml" in command for command, _, _ in environment.commands))

    def test_环境检查没过时报环境故障(self):
        agent = osprey(self.logs)
        environment = FakeEnvironment(TASK, [ExecResult(return_code=70, stderr="环境检查没过：网络没有被限制")])
        with self.assertRaisesRegex(osprey_pier.EnvironmentCheckError, "网络没有被限制"):
            asyncio.run(agent.run("任务", environment, AgentContext()))

    def test_导不出补丁时照常评分(self):
        agent = osprey(self.logs)
        environment = FakeEnvironment(TASK, [ExecResult(return_code=71, stderr="导不出补丁")])
        # Pier 遇到这个异常会继续评分
        with self.assertRaises(NonZeroAgentExitCodeError):
            asyncio.run(agent.run("任务", environment, AgentContext()))

    def test_从事件流里取用量(self):
        agent = osprey(self.logs)
        self.logs.mkdir(parents=True)
        usage = {"input": 100, "output": 20, "cache_read": 30, "cache_write": 5, "reasoning": 7, "cost_usd": 0.012}
        (self.logs / "events.jsonl").write_text(
            json.dumps({"type": "session.started"})
            + "\n"
            + json.dumps({"type": "session.ended", "usage": usage})
            + '\n{"type": "sess'
        )
        context = AgentContext()
        agent.populate_context_post_run(context)

        self.assertEqual(context.n_input_tokens, 135)
        self.assertEqual(context.n_cache_tokens, 30)
        self.assertEqual(context.n_output_tokens, 20)
        self.assertEqual(context.cost_usd, 0.012)

    def test_没有事件流时不填用量(self):
        context = AgentContext()
        osprey(self.logs).populate_context_post_run(context)
        self.assertTrue(context.is_empty())

    def test_别的题目名里没有修复的commit(self):
        self.assertEqual(osprey_pier.fix_commit("fix-sum"), "")
        self.assertEqual(
            osprey_pier.fix_commit("swebench-pro/" + TASK),
            "0123456789abcdef0123456789abcdef01234567",
        )


class PatchReplayTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.job = Path(self.temp.name) / "job"
        self.logs = Path(self.temp.name) / "regrade" / "agent"

    def trial(self, name: str, task: str, patch: str | None) -> None:
        directory = self.job / name
        (directory / "agent").mkdir(parents=True)
        (directory / "result.json").write_text(json.dumps({"task_name": task}))
        if patch is not None:
            (directory / "agent" / "model.patch").write_text(patch)

    def replay(self, environment: FakeEnvironment) -> None:
        agent = osprey_pier.PatchReplay(logs_dir=self.logs, source_job=str(self.job))
        asyncio.run(agent.run("任务", environment, AgentContext()))

    def test_把同一道题的补丁打上(self):
        self.trial("calc__aaa", TASK, "diff --git a/sum.js b/sum.js\n")
        self.trial("other__bbb", "other", "diff --git a/x b/x\n")
        environment = FakeEnvironment(TASK, [ExecResult(return_code=0)])
        self.replay(environment)

        self.assertEqual(environment.uploads, [("diff --git a/sum.js b/sum.js\n", "/tmp/model.patch")])
        self.assertEqual(environment.commands[-1][0], "git apply --whitespace=nowarn /tmp/model.patch")
        self.assertEqual(json.loads((self.logs / "replay.json").read_text()), {"source_trial": "calc__aaa"})

    def test_空补丁什么都不打(self):
        self.trial("calc__aaa", TASK, "")
        environment = FakeEnvironment(TASK)
        self.replay(environment)
        self.assertEqual(environment.uploads, [])
        self.assertEqual(environment.commands, [])

    def test_上一遍没有导出补丁是环境故障(self):
        self.trial("calc__aaa", TASK, None)
        with self.assertRaisesRegex(osprey_pier.EnvironmentCheckError, "没有导出补丁"):
            self.replay(FakeEnvironment(TASK))

    def test_上一遍没有这道题或者有不止一次是环境故障(self):
        self.trial("other__bbb", "other", "x")
        with self.assertRaisesRegex(osprey_pier.EnvironmentCheckError, "实际有 0 次"):
            self.replay(FakeEnvironment(TASK))
        self.trial("calc__aaa", TASK, "x")
        self.trial("calc__ccc", TASK, "x")
        with self.assertRaisesRegex(osprey_pier.EnvironmentCheckError, "实际有 2 次"):
            self.replay(FakeEnvironment(TASK))

    def test_补丁打不上是环境故障(self):
        self.trial("calc__aaa", TASK, "diff --git a/sum.js b/sum.js\n")
        environment = FakeEnvironment(TASK, [ExecResult(return_code=1, stderr="error: patch failed")])
        with self.assertRaisesRegex(osprey_pier.EnvironmentCheckError, "patch failed"):
            self.replay(environment)


class SandboxDockerEnvironmentTest(unittest.TestCase):
    def test_在_Pier_的_compose_文件之后追加安全选项(self):
        temp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        environment_dir = temp / "environment"
        environment_dir.mkdir()
        (environment_dir / "Dockerfile").write_text("FROM scratch\n")
        kwargs = {
            "environment_dir": environment_dir,
            "environment_name": TASK,
            "session_id": "task__abc",
            "trial_paths": TrialPaths(trial_dir=temp / "trial"),
            "task_env_config": EnvironmentConfig(
                docker_image="example.com/image:1", allow_internet=False
            ),
        }
        plain = DockerEnvironment(**kwargs)._docker_compose_paths
        sandbox = osprey_pier.SandboxDockerEnvironment(**kwargs)._docker_compose_paths
        self.assertEqual(sandbox[:-1], plain)
        self.assertEqual(
            yaml.safe_load(sandbox[-1].read_text()),
            {
                "services": {
                    "main": {
                        "security_opt": [
                            "seccomp=unconfined",
                            "apparmor=unconfined",
                            "systempaths=unconfined",
                        ]
                    }
                }
            },
        )


if __name__ == "__main__":
    unittest.main()
