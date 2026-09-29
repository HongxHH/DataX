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
"""Landcheck NL2SQL L1 golden-set runner.

Modes:
  --validate-gold   Only execute each case's gold_sql and check expect / patterns.
  (default)         Run landcheck_nl2sql Agent per case, then score.

Examples:
  python tests/benchmark/landcheck/run_l1_eval.py --validate-gold
  python tests/benchmark/landcheck/run_l1_eval.py --ids lc_zhigu_rooms_area
  python tests/benchmark/landcheck/run_l1_eval.py --out runs/landcheck_l1
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from loguru import logger

HERE = Path(__file__).resolve().parent
PROJECT_DIR = HERE.parents[2]
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

from tests.benchmark.landcheck.artifacts import (  # noqa: E402
    StreamArtifactCollector,
    write_case_replay_artifacts,
)
from tests.benchmark.landcheck.db import execute_sql, load_mysql_settings  # noqa: E402
from tests.benchmark.landcheck.scorer import score_case  # noqa: E402

DEFAULT_CASES = HERE / "cases.json"
DEFAULT_CONFIG = PROJECT_DIR / "dataagent" / "core" / "flex" / "examples" / "landcheck_nl2sql.yaml"
# Same multi-mode stream as Shell NL2SQL adapter so trajectory has node names.
DEFAULT_STREAM_MODE = ["updates", "custom", "values"]


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


def load_suite(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def filter_cases(suite: dict[str, Any], ids: list[str] | None, tags: list[str] | None) -> list[dict[str, Any]]:
    cases = list(suite.get("cases") or [])
    if ids:
        want = set(ids)
        cases = [c for c in cases if c.get("id") in want]
    if tags:
        want_tags = set(tags)
        cases = [c for c in cases if want_tags.intersection(set(c.get("tags") or []))]
    return cases


def validate_gold_case(case: dict[str, Any], defaults: dict[str, Any]) -> dict[str, Any]:
    gold_sql = case.get("gold_sql")
    if not gold_sql:
        result = score_case(
            case,
            pred_sql="",
            pred_columns=[],
            pred_rows=[],
            defaults=defaults,
        )
        result["mode"] = "validate_gold"
        result["note"] = "no gold_sql"
        return result

    columns, rows = execute_sql(gold_sql)
    result = score_case(
        case,
        pred_sql=gold_sql,
        pred_columns=columns,
        pred_rows=rows,
        defaults=defaults,
    )
    result["mode"] = "validate_gold"
    result["gold_columns"] = columns
    result["gold_row_count"] = len(rows)
    return result


def _schema_tables(final_state: dict[str, Any] | None) -> list[str]:
    if not final_state:
        return []
    schema = final_state.get("schema") or {}
    if isinstance(schema, dict):
        return [str(k) for k in schema.keys()]
    return []


async def run_agent_case(
    case: dict[str, Any],
    *,
    agent: Any,
    out_dir: Path,
    defaults: dict[str, Any],
) -> dict[str, Any]:
    from dataagent.agents.nl2sql.workflow.state import get_default_state

    case_id = str(case.get("id"))
    case_dir = out_dir / case_id
    case_dir.mkdir(parents=True, exist_ok=True)
    # SDK rejects workspace="" from get_default_state; give each case a real dir.
    workspace_dir = case_dir / "workspace"
    workspace_dir.mkdir(parents=True, exist_ok=True)
    session_id = f"landcheck_l1_{case_id}"

    query = str(case.get("query") or "")
    t0 = time.perf_counter()
    collector = StreamArtifactCollector()
    final_state: dict[str, Any] | None = None
    error: str | None = None
    try:
        initial_state = get_default_state(query)
        # Empty string would fail DataAgent._validate_workspace; let kwargs win.
        initial_state.pop("workspace", None)
        if not str(initial_state.get("session_id") or "").strip():
            initial_state["session_id"] = session_id
        if not str(initial_state.get("user_id") or "").strip():
            initial_state["user_id"] = "landcheck_l1_eval"
        async for chunk in agent.astream(
            initial_state=initial_state,
            stream_mode=DEFAULT_STREAM_MODE,
            workspace=str(workspace_dir),
            session_id=session_id,
        ):
            collector.feed(chunk)
        final_state = collector.final_state
        if final_state is None:
            raw = await agent.chat(
                query,
                workspace=str(workspace_dir),
                session_id=session_id,
            )
            final_state = dict(raw) if isinstance(raw, dict) else {}
            collector.final_state = final_state
    except Exception as exc:  # noqa: BLE001 - eval harness must continue
        error = str(exc)
        logger.exception("case {} agent failed", case_id)

    e2e_ms = (time.perf_counter() - t0) * 1000.0
    artifacts = write_case_replay_artifacts(case_dir, collector=collector, agent_error=error)
    pred_sql = str((final_state or {}).get("sql") or "").strip()
    linked = _schema_tables(final_state)
    from dataagent.utils.env_utils import get_env_bool

    (case_dir / "pred.sql").write_text(pred_sql + ("\n" if pred_sql else ""), encoding="utf-8")
    (case_dir / "state_meta.json").write_text(
        json.dumps(
            {
                "error": error,
                "e2e_ms": e2e_ms,
                "llm_total_tokens": (final_state or {}).get("llm_total_tokens"),
                "schema_tables": linked[:50],
                "trajectory_steps": len(collector.steps),
                "artifacts": artifacts,
                "context_dump": get_env_bool("DATAAGENT_CONTEXT_DUMP"),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    score_mode = case.get("score_mode") or "full"
    pred_columns: list[str] | None = None
    pred_rows: list[list[Any]] | None = None
    exec_error: str | None = None
    if score_mode != "sql_patterns_only" and pred_sql:
        try:
            pred_columns, pred_rows = execute_sql(pred_sql)
            (case_dir / "pred_result.json").write_text(
                json.dumps({"columns": pred_columns, "rows": pred_rows[:50]}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:  # noqa: BLE001
            exec_error = str(exc)
            pred_columns, pred_rows = [], []

    scored = score_case(
        case,
        pred_sql=pred_sql,
        pred_columns=pred_columns,
        pred_rows=pred_rows,
        defaults=defaults,
        linked_tables=linked or None,
    )
    if error:
        scored["agent_error"] = error
        scored["passed"] = False
    if exec_error:
        scored["exec_error"] = exec_error
        scored["passed"] = False
    scored["e2e_ms"] = e2e_ms
    scored["mode"] = "agent"
    (case_dir / "score.json").write_text(json.dumps(scored, ensure_ascii=False, indent=2), encoding="utf-8")
    return scored


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    idx = (len(ordered) - 1) * pct
    lo = int(idx)
    hi = min(lo + 1, len(ordered) - 1)
    frac = idx - lo
    return ordered[lo] * (1 - frac) + ordered[hi] * frac


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(results)
    passed = sum(1 for r in results if r.get("passed"))
    exec_pass = sum(
        1
        for r in results
        if (r.get("execution") or {}).get("passed") and not (r.get("execution") or {}).get("skipped")
    )
    exec_total = sum(1 for r in results if not (r.get("execution") or {}).get("skipped", True))
    table_pass = sum(1 for r in results if (r.get("table_recall") or {}).get("passed"))
    pattern_pass = sum(1 for r in results if (r.get("sql_patterns") or {}).get("passed"))
    linking_reports = [
        (r.get("table_recall") or {}).get("schema_linking")
        for r in results
        if (r.get("table_recall") or {}).get("schema_linking") is not None
    ]
    linking_pass = sum(1 for x in linking_reports if x and x.get("passed"))
    latencies = [float(r["e2e_ms"]) for r in results if isinstance(r.get("e2e_ms"), (int, float))]
    return {
        "total": total,
        "passed": passed,
        "pass_rate": round(passed / total, 4) if total else 0.0,
        "execution_consistency": {
            "passed": exec_pass,
            "total": exec_total,
            "rate": round(exec_pass / exec_total, 4) if exec_total else None,
        },
        "table_recall_pass": table_pass,
        "sql_pattern_pass": pattern_pass,
        "schema_linking_recall": {
            "passed": linking_pass,
            "total": len(linking_reports),
            "rate": round(linking_pass / len(linking_reports), 4) if linking_reports else None,
        },
        "latency_ms": {
            "p50": round(_percentile(latencies, 0.50), 1) if latencies else None,
            "p95": round(_percentile(latencies, 0.95), 1) if latencies else None,
            "n": len(latencies),
        },
        "failed_ids": [r.get("case_id") for r in results if not r.get("passed")],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Landcheck NL2SQL L1 golden-set eval")
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES, help="cases.json path")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG, help="landcheck_nl2sql.yaml")
    parser.add_argument("--out", type=Path, default=HERE / "runs" / "latest", help="output directory")
    parser.add_argument("--ids", nargs="*", default=None, help="subset of case ids")
    parser.add_argument("--tags", nargs="*", default=None, help="filter by tags")
    parser.add_argument(
        "--validate-gold",
        action="store_true",
        help="only execute gold_sql and score (no LLM)",
    )
    parser.add_argument(
        "--dump-llm",
        action="store_true",
        help="set DATAAGENT_CONTEXT_DUMP=1 so NL2SQL writes per-round prompts under workspace/.memory/context_dump",
    )
    return parser.parse_args()


async def _amain(args: argparse.Namespace) -> int:
    _load_dotenv()
    # YAML / tools often resolve paths relative to the repo root.
    os.environ.setdefault("DATAAGENT_REPO_ROOT", str(PROJECT_DIR))
    if args.dump_llm:
        os.environ["DATAAGENT_CONTEXT_DUMP"] = "1"
        logger.info("DATAAGENT_CONTEXT_DUMP=1 (--dump-llm)")
    suite = load_suite(args.cases)
    defaults = dict(suite.get("defaults") or {})
    cases = filter_cases(suite, args.ids, args.tags)
    if not cases:
        logger.error("no cases selected")
        return 2

    out_dir = args.out.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    settings = load_mysql_settings()
    logger.info("mysql {}:{}/{}", settings.host, settings.port, settings.database)
    if suite.get("data_snapshot"):
        logger.info("suite data_snapshot: {}", suite["data_snapshot"])

    results: list[dict[str, Any]] = []
    if args.validate_gold:
        for case in cases:
            logger.info("validate-gold {}", case.get("id"))
            results.append(validate_gold_case(case, defaults))
    else:
        if not args.config.exists():
            raise FileNotFoundError(f"config not found: {args.config}")
        from dataagent.interface.sdk.agent import DataAgent

        agent = DataAgent.from_config(str(args.config))
        for case in cases:
            logger.info("agent-run {}", case.get("id"))
            results.append(
                await run_agent_case(
                    case,
                    agent=agent,
                    out_dir=out_dir,
                    defaults=defaults,
                )
            )

    summary = summarize(results)
    report = {
        "suite": suite.get("name"),
        "version": suite.get("version"),
        "data_snapshot": suite.get("data_snapshot"),
        "metric_coverage": suite.get("metric_coverage"),
        "mode": "validate_gold" if args.validate_gold else "agent",
        "summary": summary,
        "results": results,
    }
    report_path = out_dir / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    logger.info("wrote {}", report_path)
    return 0 if summary["passed"] == summary["total"] else 1


def main() -> None:
    args = parse_args()
    raise SystemExit(asyncio.run(_amain(args)))


if __name__ == "__main__":
    main()
