"""Harbor adapter for agentx, so Terminal-Bench (or any Harbor dataset) can run
agentx next to the built-in claude-code and codex agents.

    PYTHONPATH=bench/harbor harbor run -d terminal-bench@2.0 \
      -a agentx_agent:AgentX -m anthropic/claude-opus-5-5 \
      --ak tier=claude-code --ak tarball=/abs/path/agentix-cli-x.y.z.tgz

Inside each task container it installs Node 22, agentx, and the engine CLI
the tier drives (claude or codex), writes a clean single-agent config whose
workspace is the task's working directory, and runs the instruction through
`agentx exec --json`. No fleet wiki, memory or skills come along: every run
starts from an empty agentx, which keeps the comparison fair and keeps
private data out of results.

Token accounting matches Harbor's claude-code agent: n_input_tokens is fresh
input + cache reads + cache writes, n_cache_tokens is cache reads. Cost is
priced from those tokens with LiteLLM, the same way Harbor prices codex.

Agent kwargs (--ak key=value):
    tier             claude-code (default) | codex-cli. The orchestrator and
                     sdk tiers are refused: their usage drops cache counts and
                     falls back to a 70/30 input/output estimate, which would
                     make any token or cost comparison wrong.
    tarball          local path to an `npm pack` of agentx; default installs
                     agentix-cli from npm (pin with --agent-version)
    billing          subscription (default) | api. claude-code tier only: "api"
                     bills ANTHROPIC_API_KEY instead of CLAUDE_CODE_OAUTH_TOKEN
    setup_workspace  true (default) writes agentx's managed CLAUDE.md etc. into
                     the workspace, as daemon boot does; false leaves it bare
    max_minutes      agentx's own time cap (default 240, the schema maximum)
"""

import json
import shlex
import uuid
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

STATE_DIR = "/tmp/agentx-home"  # registry state lives here, never in the task dir
RESULT_FILE = "agentx-result.json"
STDERR_FILE = "agentx-stderr.log"
AGENT_ID = "bench"
SUPPORTED_TIERS = ("claude-code", "codex-cli")

# Credentials forwarded from the host when set. On the claude-code tier the
# agent's `billing` picks which one `claude` gets: CLAUDE_CODE_OAUTH_TOKEN
# (subscription, the default) or ANTHROPIC_API_KEY (billing=api).
FORWARDED_ENV = (
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
)


class AgentX(BaseInstalledAgent):
    def __init__(
        self,
        *args,
        tier: str = "claude-code",
        tarball: str | None = None,
        billing: str = "subscription",
        setup_workspace: bool = True,
        max_minutes: int = 240,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        if tier not in SUPPORTED_TIERS:
            raise ValueError(
                f"tier={tier!r} is not benchmarkable yet; use one of {SUPPORTED_TIERS}"
            )
        if billing not in ("subscription", "api"):
            raise ValueError(f"billing={billing!r}; use 'subscription' or 'api'")
        self._tier = tier
        self._billing = billing
        self._tarball = Path(tarball).expanduser() if tarball else None
        self._setup_workspace = setup_workspace
        self._max_minutes = int(max_minutes)
        if self._tarball and not self._tarball.is_file():
            raise FileNotFoundError(f"agentx tarball not found: {self._tarball}")

    @staticmethod
    def name() -> str:
        return "agentx"

    def get_version_command(self) -> str | None:
        return ". ~/.nvm/nvm.sh; agentx --version"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment, ("curl", "bash", "git", "procps")
        )

        if self._tarball:
            await environment.upload_file(self._tarball, "/tmp/agentx.tgz")
            package = "/tmp/agentx.tgz"
        else:
            package = f"agentix-cli@{self._version or 'latest'}"

        engine = {
            "claude-code": (
                "curl -fsSL https://downloads.claude.ai/claude-code-releases/bootstrap.sh | bash && "
                "echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.bashrc && "
                'export PATH="$HOME/.local/bin:$PATH" && claude --version'
            ),
            "codex-cli": "npm install -g @openai/codex && codex --version",
        }[self._tier]

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"npm install -g {shlex.quote(package)} && agentx --version && "
                f"{engine}"
            ),
        )

    def _agent_model(self) -> str | None:
        # Harbor models are provider-qualified ("anthropic/claude-opus-5-5");
        # agentx takes the bare model id the engine CLI expects.
        return self.model_name.split("/", 1)[-1] if self.model_name else None

    def _agentx_config(self, workspace: str) -> dict[str, Any]:
        agent: dict[str, Any] = {
            "name": "Bench",
            "workspace": workspace,
            "tier": self._tier,
            "permissionMode": "bypassPermissions",
            "billing": self._billing,
            "maxExecutionMinutes": self._max_minutes,
        }
        if model := self._agent_model():
            agent["model"] = model
        return {
            "node": {"id": "bench", "name": "Bench", "bind": "127.0.0.1:18899"},
            "agents": {AGENT_ID: agent},
        }

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        workspace = (await self.exec_as_agent(environment, command="pwd")).stdout.strip()

        await self.exec_as_agent(environment, command=f"mkdir -p {STATE_DIR}")
        await self._upload_config_text(
            environment,
            content=json.dumps(self._agentx_config(workspace), indent=2),
            remote_path=f"{STATE_DIR}/agentx.json",
            filename="agentx.json",
        )

        env = {k: v for k in FORWARDED_ENV if (v := self._get_env(k))}
        # Same switches Harbor's claude-code agent sets for its baseline:
        # allow skip-permissions as root, and no telemetry traffic.
        env["IS_SANDBOX"] = "1"
        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"

        # Pass the instruction through the environment, not argv: no quoting
        # hazards and no ARG_MAX ceiling on long task descriptions.
        var = f"AGENTX_TASK_{uuid.uuid4().hex.upper()}"
        env[var] = instruction

        logs = self.environment_logs_dir.as_posix()
        flags = "--json" + (" --setup-workspace" if self._setup_workspace else "")
        await self.exec_as_agent(
            environment,
            env=env,
            command=(
                ". ~/.nvm/nvm.sh; "
                'export PATH="$HOME/.local/bin:$PATH"; '
                f"cd {STATE_DIR} && "
                f'printf "%s" "${var}" | agentx exec -a {AGENT_ID} {flags} '
                f"> {logs}/{RESULT_FILE} 2> {logs}/{STDERR_FILE}; "
                # exec exits 1 on an agent error; the result JSON says why,
                # and populate_context_post_run still records its usage.
                "true"
            ),
        )

        # Read it back from inside the container: the host copy of the logs
        # dir is only synced live on mounted (local Docker) environments.
        cat = await self.exec_as_agent(
            environment, command=f"cat {logs}/{RESULT_FILE} 2>/dev/null || true"
        )
        result = self._parse_result(cat.stdout or "")
        if result is None:
            raise NonZeroAgentExitCodeError(
                f"agentx exec produced no result; see {STDERR_FILE}"
            )
        if result.get("error"):
            raise NonZeroAgentExitCodeError(
                f"agentx: {result.get('errorKind') or 'error'}: {result['error']}"
            )

    @staticmethod
    def _parse_result(text: str) -> dict[str, Any] | None:
        lines = [l for l in text.splitlines() if l.strip()]
        try:
            return json.loads(lines[-1]) if lines else None
        except json.JSONDecodeError:
            return None

    def _read_result(self) -> dict[str, Any] | None:
        try:
            return self._parse_result((self.logs_dir / RESULT_FILE).read_text())
        except OSError:
            return None

    def populate_context_post_run(self, context: AgentContext) -> None:
        result = self._read_result()
        if not result:
            return
        usage = result.get("usage") or {}
        fresh = usage.get("inputTokens") or 0
        cache_read = usage.get("cacheReadTokens") or 0
        cache_write = usage.get("cacheCreateTokens") or 0
        output = usage.get("outputTokens") or 0

        context.n_input_tokens = fresh + cache_read + cache_write
        context.n_cache_tokens = cache_read
        context.n_output_tokens = output
        context.cost_usd = self._price(
            result.get("billedModel") or self._agent_model(),
            fresh, output, cache_read, cache_write,
        )
        context.metadata = {
            "tier": self._tier,
            "cache_write_tokens": cache_write,
            "num_turns": result.get("numTurns"),
            "billed_model": result.get("billedModel"),
            "agentx_duration_ms": result.get("durationMs"),
            "error_kind": result.get("errorKind"),
        }

    def _price(
        self, model: str | None, fresh: int, output: int, cache_read: int, cache_write: int
    ) -> float | None:
        if not model:
            return None
        try:
            import litellm
        except ImportError:
            self.logger.debug("litellm not available; leaving agentx cost_usd as None")
            return None
        key = next(
            (k for k in (model, self.model_name) if k and litellm.model_cost.get(k)),
            None,
        )
        if key is None:
            self.logger.debug(f"No LiteLLM pricing for '{model}'; cost_usd left as None")
            return None
        try:
            # LiteLLM's prompt_tokens includes the cached parts.
            input_cost, output_cost = litellm.cost_per_token(
                model=key,
                prompt_tokens=fresh + cache_read + cache_write,
                completion_tokens=output,
                cache_read_input_tokens=cache_read,
                cache_creation_input_tokens=cache_write,
            )
        except Exception:
            self.logger.debug(f"LiteLLM pricing failed for '{key}'", exc_info=True)
            return None
        return float(input_cost + output_cost)
