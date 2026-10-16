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
"""CLI: aggregate B1/B2 from an L1 run, optionally launching the B1 subset first."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
PROJECT_DIR = HERE.parents[2]
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

from tests.benchmark.resume_metrics.constants import B1_CASE_IDS, METRIC_CARD_VERSION  # noqa: E402
from tests.benchmark.resume_metrics.linking_aggregate import aggregate_linking_from_run  # noqa: E402


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


def _probe_full_table_count(database: str, base_url: str, limit: int = 500) -> int | None:
    url = f"{base_url.rstrip('/')}/api/semantic/v1/advanced-search/table-list?databaseName={database}&limit={limit}"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:  # noqa: S310 - local semantic
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return None
    if isinstance(payload, list):
        return len(payload)
    if isinstance(payload, dict):
        for key in ("tables", "data", "entities", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                return len(value)
    return None


def _env_snapshot(*, n_full: int | None) -> dict[str, Any]:
    return {
        "metric_card_version": METRIC_CARD_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "openai_model": os.environ.get("OPENAI_MODEL"),
        "semantic_layer_base_url": os.environ.get("SEMANTIC_LAYER_BASE_URL"),
        "mysql_database": os.environ.get("MYSQL_DATABASE"),
        "n_full": n_full,
        "path": "L1 score.json aggregation (schema_linking)",
    }


def _run_l1_subset(out_dir: Path, *, python_exe: str) -> int:
    cmd = [
        python_exe,
        str(PROJECT_DIR / "tests" / "benchmark" / "landcheck" / "run_l1_eval.py"),
        "--out",
        str(out_dir),
        "--ids",
        *B1_CASE_IDS,
    ]
    return subprocess.call(cmd, cwd=str(PROJECT_DIR))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Resume metric B: linking recall / shrink aggregate")
    parser.add_argument(
        "--from-run",
        type=Path,
        default=None,
        help="Existing L1 out dir containing <case_id>/score.json",
    )
    parser.add_argument(
        "--run-l1",
        action="store_true",
        help="Run landcheck L1 on B1 case ids into --out before aggregating",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=HERE / "runs" / "linking_latest",
        help="Output dir for report (and L1 artifacts when --run-l1)",
    )
    parser.add_argument(
        "--n-full",
        type=int,
        default=None,
        help="Full catalog table count for B2; default: probe Semantic table-list",
    )
    parser.add_argument(
        "--database",
        default=None,
        help="Semantic databaseName for n_full probe (default: MYSQL_DATABASE or landcheck)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    _load_dotenv()
    out_dir = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    run_dir = args.from_run
    if args.run_l1:
        run_dir = out_dir / "l1"
        run_dir.mkdir(parents=True, exist_ok=True)
        code = _run_l1_subset(run_dir, python_exe=sys.executable)
        if code != 0:
            return code
    if run_dir is None:
        print("Provide --from-run DIR or --run-l1", file=sys.stderr)
        return 2

    n_full = args.n_full
    if n_full is None:
        base = os.environ.get("SEMANTIC_LAYER_BASE_URL") or "http://localhost:32000"
        database = args.database or os.environ.get("MYSQL_DATABASE") or "landcheck"
        n_full = _probe_full_table_count(database, base)

    report = aggregate_linking_from_run(run_dir, case_ids=B1_CASE_IDS, n_full=n_full)
    report["environment"] = _env_snapshot(n_full=n_full)
    report_path = out_dir / "linking_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"wrote": str(report_path), "b1": report.get("b1"), "b2": report.get("b2")}, ensure_ascii=False))
    if report.get("resume_allowed_line"):
        print(report["resume_allowed_line"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
