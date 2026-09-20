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
import json
from typing import Any

from dataagent.agents.nl2sql.nodes.base_nl2sql_node import BaseNL2SQLNode
from dataagent.agents.nl2sql.utils.nl2sql_utils import sql_sha256
from dataagent.agents.nl2sql.workflow.state import NL2SQLState, Result
from dataagent.utils.constants import DEFAULT_NL2SQL_REF_RETRIES, DEFAULT_NL2SQL_SELECTOR_THRESHOLD
from dataagent.utils.log import logger


class SelectorNode(BaseNL2SQLNode):
    def __init__(self, **kwargs):
        super().__init__(name="selector", **kwargs)
        self.threshold = self.config.get("threshold", DEFAULT_NL2SQL_SELECTOR_THRESHOLD)
        self.shortcut = self.config.get("shortcut", -1)

    async def _aprocess(self, state: NL2SQLState, runtime: Any = None) -> NL2SQLState:
        best = None
        p = ""
        shortcut_vote_count = None
        if self.shortcut >= 0:
            best, vote = self._vote(state["execution_results"])
            if best:
                best.confidence = 1.0
                shortcut_vote_count = vote
                p = f"Shortcut with {vote} votes: {best.sql}"
        if not best:
            res = [
                {"id": r.id, "sql": r.sql, "cols": r.columns, "rows": r.rows_preview, "err": r.error}
                for r in state["execution_results"]
            ]
            context = {
                "schema": state["schema_str"],
                "question": state["question"],
                "sql_rules": state["sql_rules"],
                "res": json.dumps(res, default=str),
            }
            for _ in range(3):
                out = await self.execute_with_llm_json(context)
                if len(out) == len(state["execution_results"]):
                    sel = out
                    for r in res:
                        del r["id"]
                    break
            else:
                # skip if fail
                logger.warning("Selector failed.")
                sel = [{"score": 1, "issues": []}] * len(state["execution_results"])
            for e, s in zip(state["execution_results"], sel, strict=True):
                e.confidence = s["score"]
                e.issues = e.issues + s["issues"]
            best = max(state["execution_results"], key=lambda e: (e.confidence, e.score))
            p = "\n".join([f"Score: {e.confidence:.2f}, Issues: {e.issues}" for e in state["execution_results"]])
        message = f"=== Selector ===\n{p}"
        candidate_summaries = [
            (
                f"candidate_id={e.id} sql_sha256={sql_sha256(e.sql)} "
                f"row_count={len(e.rows) if e.rows is not None else 0} "
                f"confidence={e.confidence:.2f} "
                f"error_code={'EXECUTION_ERROR' if e.error else 'NONE'}"
            )
            for e in state["execution_results"]
        ]
        if shortcut_vote_count is not None:
            candidate_summaries.append(f"shortcut_vote_count={shortcut_vote_count}")
        logger.info("=== Selector ===\n{}", "\n".join(candidate_summaries))
        state["stream_message"] = message
        if best.confidence >= self.threshold or state["sel_retries"] <= 0:
            state["sql"], state["confidence"] = best.sql, best.confidence
            state["columns"], state["rows"], state["rows_preview"] = best.columns, best.rows, best.rows_preview
            persist_note = self._persist_final_result(state, runtime)
            p = f"{state['sql']}\n{state['rows_preview']}"
            if best.rows and best.rows_preview is not None and len(best.rows) > len(best.rows_preview):
                p += f" ... and {len(best.rows) - len(best.rows_preview)} more rows"
            if persist_note:
                p += f"\n{persist_note}"
            message = f"=== Final Result ===\n{p}"
            logger.info(
                "=== Final Result ===\nsql_sha256={} row_count={} confidence={:.2f} error_code={}",
                sql_sha256(best.sql),
                len(best.rows) if best.rows is not None else 0,
                best.confidence,
                "EXECUTION_ERROR" if best.error else "NONE",
            )
            state["stream_message"] = message
            return state
        state["ref_retries"] = self._get_agent_config("CORE.reflector.ref_retries", DEFAULT_NL2SQL_REF_RETRIES)
        state["sel_retries"] -= 1
        for e in state["execution_results"]:
            e.need_ref = True
        state["proceed"], state["validation_results"] = False, list(state["execution_results"])
        state["execution_results"].clear()
        return state

    def _persist_final_result(self, state: NL2SQLState, runtime: Any) -> str:
        from dataagent.agents.nl2sql.persist import persist_nl2sql_result, persist_summary_line, rows_for_persist

        workspace = None
        if runtime is not None:
            workspace = getattr(runtime, "workspace_dir", None)
        if not workspace:
            workspace = state.get("workspace")
        if not workspace:
            try:
                workspace = self._get_agent_config("WORKSPACE.path", None)
            except RuntimeError:
                workspace = None
        if not workspace:
            from dataagent.utils.runtime_paths import resolve_effective_workspace_root

            cfg = {}
            if self._config_manager is not None:
                raw = getattr(self._config_manager, "settings", None)
                cfg = raw if isinstance(raw, dict) else {}
            workspace = resolve_effective_workspace_root(
                config=cfg,
                session_id=str(state.get("session_id") or "") or None,
                user_id=str(state.get("user_id") or "") or None,
            )
        payload = persist_nl2sql_result(
            sql=str(state.get("sql") or ""),
            columns=state.get("columns") if isinstance(state.get("columns"), list) else None,
            rows=rows_for_persist(state.get("rows"), state.get("rows_preview")),
            workspace=workspace,
            run_id=state.get("run_id", state.get("_parent_run_id", 0)),
            sub_id=state.get("sub_id"),
        )
        if not payload:
            return ""
        state.update(payload)
        return persist_summary_line(payload)

    def _vote(self, res: list[Result]) -> tuple[Result, int] | tuple[None, int]:
        result_map = {}
        for r in res:
            if r.error or r.columns is None or r.rows is None:
                continue
            key = frozenset(r.rows)
            if key not in result_map:
                result_map[key] = {"vote": 1, "result": r}
                continue
            candidate = result_map[key]
            candidate["vote"] += 1
            if len(r.sql) < len(candidate["result"].sql):
                candidate["result"] = r
        if not result_map or max(result_map.values(), key=lambda x: x["vote"])["vote"] < self.shortcut:
            return None, 0
        best = max(result_map.values(), key=lambda x: x["vote"])
        return best["result"], best["vote"]
