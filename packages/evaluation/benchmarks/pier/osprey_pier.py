"""Pier 的 agent 适配：在任务容器里运行 Osprey Code，再在干净的镜像里重放补丁评分。

按 datacurve-pier 0.3.1 的接口写，用法见 packages/evaluation/README.md。

- ``OspreyCode``：构建镜像时装好 Node 和 CLI，运行时调用 ``run-agent.sh``（检查环境、
  运行 CLI 的非交互模式、导出补丁），结束后从 CLI 的事件流里取 token 用量和费用。
- ``PatchReplay``：把上一遍导出的补丁打到干净的镜像上，之后由题目自己的测试评分。
  评分不在 agent 用过的容器里做：它可能改过测试工具、留下进程。
- ``SandboxDockerEnvironment``：给任务容器加上开沙盒要的安全选项，开关沙盒的对比实验用。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from pier.agents.base import BaseAgent
from pier.agents.installed.base import BaseInstalledAgent, NonZeroAgentExitCodeError
from pier.environments.base import BaseEnvironment
from pier.environments.docker.docker import DockerEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist

HERE = Path(__file__).resolve().parent
RUN_SCRIPT = HERE / "run-agent.sh"
SANDBOX_COMPOSE = HERE / "sandbox-compose.yaml"
SANDBOX_MODES = ("danger-full-access", "workspace-write")
# sandbox-runtime 在 Linux 上要的三样
SANDBOX_PACKAGES = "bubblewrap socat ripgrep"

# CLI 要求的最低 Node 版本。装在单独的目录里、不进 PATH：题目的测试用镜像自带的 Node。
NODE_VERSION = "24.15.0"
PREFIX = "/opt/osprey"
CLI = f"{PREFIX}/bin/ospreycode"
# 上传到容器里的文件放在 Pier 给 agent 建的目录里
STAGE = "/installed-agent"
# 必须访问不到的地址：不在任何模型服务的域名下
BLOCKED_URL = "https://example.com/"
# run-agent.sh 的退出码：开始前的检查没过
ENVIRONMENT_FAILURE = 70


class EnvironmentCheckError(RuntimeError):
    """环境故障：agent 没有运行，或者补丁没法重放。Pier 记下这个异常后不再评分。"""


def yes_or_no(name: str, value: str) -> bool:
    if value not in ("yes", "no"):
        raise ValueError(f"{name} 要写 yes 或 no")
    return value == "yes"


def fix_commit(task_name: str) -> str:
    """SWE-bench Pro 的题目名里带着上游修复的 commit；别的题目没有，返回空字符串。"""
    match = re.search(r"-([0-9a-f]{40})(?:-v[0-9a-zA-Z]+)?$", task_name)
    return match.group(1) if match else ""


class OspreyCode(BaseInstalledAgent):
    """在任务容器里运行 Osprey Code 的非交互模式。

    参数经 ``--ak`` 给出，都没有默认值：

    - ``cli_packages``：要安装的 npm 包，写法和 ``npm install`` 的参数相同，用空格分开
      （发布后是 ``@ospreycode/cli@<版本>``，发布前是各个包的 tarball 地址）
    - ``model_host``：模型服务的域名，agent 阶段只放行它
    - ``credential``：``<凭据 ID>=<环境变量名>``，密钥从运行 pier 的环境变量里读
    - ``max_cost_usd``、``max_requests``、``timeout_sec``：每个 run 的上限，前两项可以写 ``none``
    - ``sandbox_mode``：``danger-full-access`` 或 ``workspace-write``
    - ``rules_file``：经 ``--rules`` 传给 CLI 的权限规则文件
    - ``allowed_hosts``：模型服务之外另外放行的域名，用空格分开，可以为空
    - ``sandbox_container``：``yes`` 或 ``no``。任务容器要不要按开沙盒来准备：安装 bubblewrap、
      socat 和 ripgrep，运行 agent 之前探测沙盒管不管用。开关沙盒的对比实验两组都写 ``yes``，
      同时用 ``--environment-import-path osprey_pier:SandboxDockerEnvironment``
    - ``commit``：``yes`` 或 ``no``。CLI 结束后要不要把没提交的改动提交到当前分支（DeepSWE）
    - ``config_file``（可选）：放进容器里的用户级 ``config.toml``，用来登记模型清单之外的模型。
      ``sandbox_container`` 是 ``yes`` 时必须给出，并在里面选好模型：探测沙盒用的
      ``ospreycode sandbox`` 只从配置里取模型
    """

    def __init__(
        self,
        *args,
        cli_packages: str,
        model_host: str,
        credential: str,
        max_cost_usd: float | str,
        max_requests: int | str,
        timeout_sec: int,
        sandbox_mode: str,
        rules_file: str,
        allowed_hosts: str,
        sandbox_container: str,
        commit: str,
        config_file: str | None = None,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        if self.model_name is None:
            raise ValueError("要用 -m 给出模型")
        credential_id, separator, variable = credential.partition("=")
        if not credential_id or not separator or not variable:
            raise ValueError("credential 要写成 <凭据 ID>=<环境变量名>")
        if self._get_env(variable) is None:
            raise ValueError(f"环境变量 {variable} 没有设置")
        self._cli_packages = cli_packages
        self._model_host = model_host
        self._credential_id = credential_id
        self._credential_variable = variable
        self._max_cost_usd = str(max_cost_usd)
        self._max_requests = str(max_requests)
        self._timeout_sec = int(timeout_sec)
        if sandbox_mode not in SANDBOX_MODES:
            raise ValueError(f"sandbox_mode 要是 {'、'.join(SANDBOX_MODES)} 之一")
        self._sandbox_mode = sandbox_mode
        self._rules_file = Path(rules_file)
        if not self._rules_file.is_file():
            raise ValueError(f"权限规则文件 {rules_file} 不存在")
        self._allowed_hosts = str(allowed_hosts).split()
        self._sandbox_container = yes_or_no("sandbox_container", sandbox_container)
        self._commit = yes_or_no("commit", commit)
        self._config_file = Path(config_file) if config_file else None
        if self._sandbox_container and self._config_file is None:
            raise ValueError(
                "sandbox_container 是 yes 时要给出 config_file，里面选好模型："
                "ospreycode sandbox 只从配置里取模型"
            )

    @staticmethod
    def name() -> str:
        return "osprey-code"

    def get_version_command(self) -> str | None:
        return f"{CLI} --version"

    def install_spec(self) -> AgentInstallSpec:
        node = f"{PREFIX}/node"
        tarball = (
            f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.gz"
        )
        sandbox_steps = [
            InstallStep(
                user="root",
                env={"DEBIAN_FRONTEND": "noninteractive"},
                run=f"apt-get update && apt-get install -y {SANDBOX_PACKAGES}",
            )
        ]
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._version,
            steps=[
                InstallStep(
                    user="root",
                    env={"DEBIAN_FRONTEND": "noninteractive"},
                    run=(
                        "command -v curl >/dev/null && command -v git >/dev/null || "
                        "(apt-get update && apt-get install -y curl git ca-certificates)"
                    ),
                ),
                *(sandbox_steps if self._sandbox_container else []),
                InstallStep(
                    user="root",
                    run=(
                        "set -euo pipefail; "
                        f"mkdir -p {node} {PREFIX}/cli {PREFIX}/bin; "
                        f"curl -fsSL {tarball} | tar -xz -C {node} --strip-components=1; "
                        f"PATH={node}/bin:$PATH npm install --prefix {PREFIX}/cli "
                        f"--ignore-scripts --no-audit --no-fund {self._cli_packages}; "
                        f"printf '#!/bin/sh\\nexec {node}/bin/node "
                        f'{PREFIX}/cli/node_modules/.bin/ospreycode "$@"\\n\' > {CLI}; '
                        f"chmod 755 {CLI}"
                    ),
                ),
            ],
            verification_command=self.get_version_command(),
        )

    def network_allowlist(self) -> NetworkAllowlist:
        return NetworkAllowlist(domains=[self._model_host, *self._allowed_hosts])

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        instruction_file = self.logs_dir / "instruction.md"
        instruction_file.write_text(instruction)
        uploads = {
            RUN_SCRIPT: f"{STAGE}/run-agent.sh",
            self._rules_file: f"{STAGE}/rules.toml",
            instruction_file: f"{STAGE}/instruction.md",
        }
        if self._config_file is not None:
            uploads[self._config_file] = f"{STAGE}/config.toml"
        for source, target in uploads.items():
            await environment.upload_file(source_path=source, target_path=target)
        await self.exec_as_root(environment, command=f"chmod -R a+rX {STAGE}")
        if self._config_file is not None:
            await self.exec_as_agent(
                environment,
                command=(
                    "mkdir -p ~/.ospreycode && chmod 700 ~/.ospreycode && "
                    f"install -m 600 {STAGE}/config.toml ~/.ospreycode/config.toml"
                ),
            )

        env = {
            **self._extra_env,
            "OSPREY_CLI": CLI,
            "OSPREY_LOGS": str(environment.env_paths.agent_dir),
            "OSPREY_INSTRUCTION": f"{STAGE}/instruction.md",
            "OSPREY_MODEL": self.model_name,
            "OSPREY_SANDBOX": self._sandbox_mode,
            "OSPREY_RULES": f"{STAGE}/rules.toml",
            "OSPREY_CREDENTIAL_OPTION": "--credential-env",
            "OSPREY_CREDENTIAL": f"{self._credential_id}={self._credential_variable}",
            "OSPREY_MAX_COST": self._max_cost_usd,
            "OSPREY_MAX_REQUESTS": self._max_requests,
            "OSPREY_TIMEOUT_SEC": str(self._timeout_sec),
            "OSPREY_HIDDEN_PATHS": (
                f"{environment.env_paths.tests_dir} {environment.env_paths.solution_dir}"
            ),
            "OSPREY_FORBIDDEN_COMMIT": fix_commit(environment.environment_name),
            "OSPREY_BLOCKED_URL": BLOCKED_URL,
            "OSPREY_SANDBOX_PROBE": "yes" if self._sandbox_container else "no",
            "OSPREY_COMMIT": "yes" if self._commit else "no",
            self._credential_variable: self._get_env(self._credential_variable),
        }
        # 不指定目录：在镜像的工作目录里运行，题目的仓库就在那里
        result = await environment.exec(
            command=f'OSPREY_WORKSPACE="$PWD" bash {STAGE}/run-agent.sh',
            env=environment.agent_process_env(env),
        )
        if result.return_code == ENVIRONMENT_FAILURE:
            raise EnvironmentCheckError((result.stderr or "").strip()[-2000:])
        if result.return_code != 0:
            raise NonZeroAgentExitCodeError(
                f"run-agent.sh 的退出码是 {result.return_code}："
                f"{(result.stderr or '').strip()[-2000:]}"
            )

    def populate_context_post_run(self, context: AgentContext) -> None:
        events = self.logs_dir / "events.jsonl"
        if not events.exists():
            return
        usage = None
        for line in events.read_text().splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                # CLI 被强制结束时最后一行可能只写了一半，前面的事件照常使用
                break
            if event.get("type") == "session.ended":
                usage = event["usage"]
        if usage is None:
            return
        context.n_input_tokens = (
            usage["input"] + usage["cache_read"] + usage["cache_write"]
        )
        context.n_cache_tokens = usage["cache_read"]
        context.n_output_tokens = usage["output"]
        context.cost_usd = usage.get("cost_usd")


class PatchReplay(BaseAgent):
    """把上一遍导出的补丁打到干净的镜像上，不调用模型。

    ``source_job``（经 ``--ak`` 给出）是运行 agent 那一遍的 job 目录，里面每道题正好运行过一次。
    """

    def __init__(self, *args, source_job: str, **kwargs):
        super().__init__(*args, **kwargs)
        self._source_job = Path(source_job)

    @staticmethod
    def name() -> str:
        return "osprey-patch-replay"

    def version(self) -> str | None:
        return "1"

    async def setup(self, environment: BaseEnvironment) -> None:
        pass

    def _source_trial(self, task_name: str) -> Path:
        trials = [
            result.parent
            for result in sorted(self._source_job.glob("*/result.json"))
            if json.loads(result.read_text())["task_name"] == task_name
        ]
        if len(trials) != 1:
            raise EnvironmentCheckError(
                f"{self._source_job} 里 {task_name} 应当正好运行过一次，实际有 {len(trials)} 次"
            )
        return trials[0]

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        trial = self._source_trial(environment.environment_name)
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "replay.json").write_text(
            json.dumps({"source_trial": trial.name})
        )
        patch = trial / "agent" / "model.patch"
        if not patch.exists():
            raise EnvironmentCheckError(f"{trial.name} 没有导出补丁")
        if patch.stat().st_size == 0:
            # 没有改动：什么都不打，题目的测试照常运行
            return
        await environment.upload_file(source_path=patch, target_path="/tmp/model.patch")
        result = await environment.exec(
            command="git apply --whitespace=nowarn /tmp/model.patch"
        )
        if result.return_code != 0:
            raise EnvironmentCheckError(
                f"{trial.name} 的补丁在干净的镜像上打不上："
                f"{(result.stderr or '').strip()[-2000:]}"
            )


class SandboxDockerEnvironment(DockerEnvironment):
    """任务容器加上开沙盒要的安全选项，其余和 Pier 的 docker 环境相同。

    Pier 不能给任务容器加安全选项，所以在它的 compose 文件之后再追加一个。用
    ``--environment-import-path osprey_pier:SandboxDockerEnvironment`` 加载，代替 ``--env docker``。
    """

    @property
    def _docker_compose_paths(self) -> list[Path]:
        return [*super()._docker_compose_paths, SANDBOX_COMPOSE]
