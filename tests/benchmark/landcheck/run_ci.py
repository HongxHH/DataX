# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ============================================================================
"""Landcheck NL2SQL CI entry (no LLM by default).

Tier A (always): deterministic unit tests — scorer / artifacts / security /
enum linking / label+order contracts / Shell copy mapping.

Tier B (optional, needs MySQL landcheck): ``--validate-gold``.

Never runs Agent / LLM here — use ``run_l1_eval.py`` for nightly / manual.

Examples:
  python tests/benchmark/landcheck/run_ci.py
  python tests/benchmark/landcheck/run_ci.py --validate-gold
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT_DIR = HERE.parents[2]

# Fast, no LLM / no Semantic Service. Paths relative to repo root.
UNIT_TARGETS = [
    "tests/benchmark/landcheck/test_scorer.py",
    "tests/benchmark/landcheck/test_artifacts.py",
    "tests/test_nl2sql_security_sensitive.py",
    "tests/test_nl2sql_enum_linking.py",
    "tests/test_nl2sql_label_contract.py",
    "tests/test_nl2sql_order_contract.py",
    "shell/backend/tests/test_sql_security_copy.py",
    "shell/backend/tests/test_nl2sql_adapter.py",
    "shell/backend/tests/test_chat_errors.py",
]


def _run(cmd: list[str]) -> int:
    print("+", " ".join(cmd), flush=True)
    completed = subprocess.run(cmd, cwd=str(PROJECT_DIR), check=False)
    return int(completed.returncode)


def main() -> int:
    parser = argparse.ArgumentParser(description="Landcheck NL2SQL CI (unit + optional validate-gold)")
    parser.add_argument(
        "--validate-gold",
        action="store_true",
        help="also execute gold SQL against MySQL landcheck (no LLM)",
    )
    parser.add_argument("-q", "--quiet", action="store_true", help="pytest -q")
    args = parser.parse_args()

    pytest_cmd = [sys.executable, "-m", "pytest", *UNIT_TARGETS]
    pytest_cmd.append("-q" if args.quiet else "-v")
    code = _run(pytest_cmd)
    if code != 0:
        return code

    if args.validate_gold:
        gold_cmd = [
            sys.executable,
            str(HERE / "run_l1_eval.py"),
            "--validate-gold",
            "--out",
            str(HERE / "runs" / "ci_validate_gold"),
        ]
        code = _run(gold_cmd)
        if code != 0:
            return code

    print("landcheck CI OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
