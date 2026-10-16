# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ============================================================================
"""CLI: Job-path cold vs reuse E2E for resume metric C1.

Uses ``SubagentSubprocessRunner`` (same hydrate path as LocalFlexAdapter / submit_subagent),
not Swarm worker locks. Reuse still starts a new subprocess; messages/state come from disk.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PROJECT_DIR = HERE.parents[2]
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

from tests.benchmark.resume_metrics.constants import (  # noqa: E402
    DEFAULT_REUSE_K,
    DEFAULT_REUSE_TIMEOUT_SEC,
    DEFAULT_REUSE_WARMUP,
    METRIC_CARD_VERSION,
    REUSE_Q1,
    REUSE_Q2,
)
from tests.benchmark.resume_metrics.reuse_math import summarize_reuse_trials  # noqa: E402

DEFAULT_CONFIG = PROJECT_DIR / "dataagent" / "core" / "flex" / "examples" / "landcheck_nl2sql.yaml"


def _load_dotenv() -> None:
    env_path = PROJECT_DIR / ".env"
    if not env_path.exists():
        return
    try:
        from dotenv import load_dotenv

        load_dotenv(env_path)
    except Exception:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            text = line.strip()
            if not text or text.startswith("#") or "=" not in text:
                continue
            key, _, value = text.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def _message_count(workspace: Path) -> int:
    path = workspace / ".memory" / "messages.json"
    if not path.is_file():
        return 0
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    if isinstance(payload, list):
        return len(payload)
    if isinstance(payload, dict):
        messages = payload.get("messages")
        if isinstance(messages, list):
            return len(messages)
    return 0


async def _run_one_query(
    *,
    runner: Any,
    query: str,
    config_path: Path,
    workspace_dir: Path,
    parent_session_id: str,
    sub_id: int,
    timeout_sec: int,
    reuse_workspace: bool,
) -> dict[str, Any]:
    from dataagent.actions.tools.local_tool.sandbox import NoopSandbox

    workspace_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    outcome = await runner.run(
        query=query,
        config_path=config_path,
        workspace_dir=workspace_dir,
        subagent_output_dir=None,
        subagent_session_id=workspace_dir.name,
        user_id="resume_reuse_metric",
        parent_session_id=parent_session_id,
        sub_id=sub_id,
        timeout=timeout_sec,
        sandbox=NoopSandbox(),
        reuse_workspace=reuse_workspace,
    )
    e2e_ms = (time.perf_counter() - t0) * 1000.0
    return {
        "e2e_ms": e2e_ms,
        "status": getattr(outcome, "status", None),
        "error": getattr(outcome, "error", "") or "",
        "message_count": _message_count(workspace_dir),
        "reuse_workspace": reuse_workspace,
    }


async def _trial(
    *,
    mode: str,
    config_path: Path,
    parent_root: Path,
    trial_idx: int,
    timeout_sec: int,
) -> dict[str, Any]:
    from dataagent.core.agents.subagent_subprocess_runner import SubagentSubprocessRunner

    runner = SubagentSubprocessRunner()
    parent_session_id = f"reuse_{mode}_{trial_idx}_{uuid.uuid4().hex[:8]}"
    trial_dir = parent_root / f"{mode}_{trial_idx}"
    if trial_dir.exists():
        shutil.rmtree(trial_dir)
    trial_dir.mkdir(parents=True)

    if mode == "cold":
        ws1 = trial_dir / "q1_ws"
        ws2 = trial_dir / "q2_ws"
        r1 = await _run_one_query(
            runner=runner,
            query=REUSE_Q1,
            config_path=config_path,
            workspace_dir=ws1,
            parent_session_id=parent_session_id,
            sub_id=1,
            timeout_sec=timeout_sec,
            reuse_workspace=False,
        )
        r2 = await _run_one_query(
            runner=runner,
            query=REUSE_Q2,
            config_path=config_path,
            workspace_dir=ws2,
            parent_session_id=parent_session_id,
            sub_id=2,
            timeout_sec=timeout_sec,
            reuse_workspace=False,
        )
        return {
            "mode": "cold",
            "trial_idx": trial_idx,
            "q1": r1,
            "q2": r2,
            "reused_workspace": False,
        }

    # reuse: Q2 hydrates the same workspace as Q1
    ws = trial_dir / "shared_ws"
    r1 = await _run_one_query(
        runner=runner,
        query=REUSE_Q1,
        config_path=config_path,
        workspace_dir=ws,
        parent_session_id=parent_session_id,
        sub_id=1,
        timeout_sec=timeout_sec,
        reuse_workspace=False,
    )
    r2 = await _run_one_query(
        runner=runner,
        query=REUSE_Q2,
        config_path=config_path,
        workspace_dir=ws,
        parent_session_id=parent_session_id,
        sub_id=1,
        timeout_sec=timeout_sec,
        reuse_workspace=True,
    )
    return {
        "mode": "reuse",
        "trial_idx": trial_idx,
        "q1": r1,
        "q2": r2,
        "reused_workspace": True,
        "c2_messages_grew": r2["message_count"] > r1["message_count"],
    }


async def run_bench(
    *,
    out_dir: Path,
    config_path: Path,
    k: int,
    warmup: int,
    timeout_sec: int,
) -> dict[str, Any]:
    work = out_dir / "workspaces"
    work.mkdir(parents=True, exist_ok=True)
    raw_trials: list[dict[str, Any]] = []

    total = warmup + k
    for i in range(total):
        cold = await _trial(
            mode="cold",
            config_path=config_path,
            parent_root=work,
            trial_idx=i,
            timeout_sec=timeout_sec,
        )
        reuse = await _trial(
            mode="reuse",
            config_path=config_path,
            parent_root=work,
            trial_idx=i,
            timeout_sec=timeout_sec,
        )
        raw_trials.append({"cold": cold, "reuse": reuse, "warmup": i < warmup})

    counted = [t for t in raw_trials if not t["warmup"]]
    cold_q2 = [float(t["cold"]["q2"]["e2e_ms"]) for t in counted]
    reuse_q2 = [float(t["reuse"]["q2"]["e2e_ms"]) for t in counted]
    flags = [bool(t["reuse"]["reused_workspace"]) for t in counted]
    cold_msgs = [int(t["cold"]["q2"]["message_count"]) for t in counted]
    reuse_msgs = [int(t["reuse"]["q2"]["message_count"]) for t in counted]

    summary = summarize_reuse_trials(
        cold_q2_ms=cold_q2,
        reuse_q2_ms=reuse_q2,
        reused_flags=flags,
        cold_msg_counts=cold_msgs,
        reuse_msg_counts=reuse_msgs,
    )
    return {
        "metric_card_version": METRIC_CARD_VERSION,
        "metric": "C",
        "path": "Job/SubagentSubprocessRunner (reuse_workspace hydrate)",
        "q1": REUSE_Q1,
        "q2": REUSE_Q2,
        "config": str(config_path),
        "k": k,
        "warmup": warmup,
        "timeout_sec": timeout_sec,
        "trials": raw_trials,
        **summary,
        "honesty": (
            "Reuse still spawns a new subprocess each turn; "
            "measured gain is workspace hydrate (messages/snapshot/artifacts), not process keep-alive."
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Resume metric C: Job-path cold vs reuse E2E")
    parser.add_argument("--out", type=Path, default=HERE / "runs" / "reuse_latest")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--k", type=int, default=DEFAULT_REUSE_K)
    parser.add_argument("--warmup", type=int, default=DEFAULT_REUSE_WARMUP)
    parser.add_argument("--timeout-sec", type=int, default=DEFAULT_REUSE_TIMEOUT_SEC)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Write a template report without spawning subagents",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    _load_dotenv()
    out_dir = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.dry_run:
        report = {
            "metric_card_version": METRIC_CARD_VERSION,
            "metric": "C",
            "dry_run": True,
            "path": "Job/SubagentSubprocessRunner (reuse_workspace hydrate)",
            "q1": REUSE_Q1,
            "q2": REUSE_Q2,
            "config": str(args.config),
            "k": args.k,
            "warmup": args.warmup,
            "note": "dry-run only; re-run without --dry-run to measure",
            "environment": {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "openai_model": os.environ.get("OPENAI_MODEL"),
            },
        }
    else:
        if not args.config.is_file():
            print(f"config not found: {args.config}", file=sys.stderr)
            return 2
        report = asyncio.run(
            run_bench(
                out_dir=out_dir,
                config_path=args.config,
                k=args.k,
                warmup=args.warmup,
                timeout_sec=args.timeout_sec,
            )
        )
        report["environment"] = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "openai_model": os.environ.get("OPENAI_MODEL"),
            "semantic_layer_base_url": os.environ.get("SEMANTIC_LAYER_BASE_URL"),
            "mysql_database": os.environ.get("MYSQL_DATABASE"),
        }

    path = out_dir / "reuse_report.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"wrote": str(path), "c1": report.get("c1"), "dry_run": report.get("dry_run")}, ensure_ascii=False))
    line = report.get("resume_allowed_line")
    if line:
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
