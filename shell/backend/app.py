"""FastAPI application for the DataAgent UI shell."""

from __future__ import annotations

import asyncio
import shutil
import time
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from dataagent.core.workspace.lock import WorkspaceBusyError
from dataagent.utils.constants import DEFAULT_USER_ID
from dataagent.utils.runtime_paths import resolve_effective_workspace_root

from shell.backend.config import semantic_layer_url
from shell.backend.protocol.events import (
    SSE_FLUSH,
    SSE_PADDING,
    ShellEventType,
    iter_stream_with_heartbeat,
    sse_encode,
)
from shell.backend.protocol.schemas import ChatRequest, CreateSessionRequest, SwitchProfileRequest
from shell.backend.adapters.base import aclose_stream
from shell.backend.adapters.sql_security_copy import SQL_SECURITY_USER_MESSAGE, sql_security_user_message
from shell.backend.adapters.subagent_bridge import DelegationAccumulator
from shell.backend.runtime.agent_pool import get_pool
from shell.backend.session.process_snapshot import ProcessSnapshot
from shell.backend.session.trajectory import load_session_trajectory
from shell.backend.session.store import (
    allocate_kernel_run_id,
    append_user_message,
    create_session,
    delete_session,
    ensure_session,
    get_session,
    list_sessions,
    resolve_chat_query,
    sanitize_session_id,
    upsert_assistant_message,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    get_pool()
    yield


app = FastAPI(title="DataAgent Shell", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    # HAZARD: 源列表写死本机 Vite/后端端口；部署到非 localhost 或改端口时需同步，否则浏览器会 CORS 失败。
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8787",
        "http://localhost:8787",
        "http://127.0.0.1:8788",
        "http://localhost:8788",
    ],
    allow_origin_regex=r"http://(127\.0\.0\.1|localhost):51\d{2}",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def check_semantic_service() -> dict[str, Any]:
    url = semantic_layer_url()
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{url}/advanced-search/table-list", params={"limit": 1})
            ok = resp.status_code < 500
            return {"url": url, "reachable": ok, "status_code": resp.status_code}
    except Exception as exc:
        # HAZARD: 捕获所有异常当「不可达」。DNS/证书/超时混在 error 字符串里，监控无法分类。
        return {"url": url, "reachable": False, "error": str(exc)}


@app.get("/api/health")
async def health() -> dict[str, Any]:
    pool = get_pool()
    agent = pool.get_agent()
    profile = pool.get_profile_dict()
    semantic = await check_semantic_service()
    semantic_required = bool(profile.get("features", {}).get("semantic_required", profile.get("agent_type") == "nl2sql"))
    return {
        "status": "ok",
        "profile": profile,
        "layout": profile.get("layout"),
        "agent": agent.get_agent_info(),
        "semantic_layer": semantic,
        "semantic_required": semantic_required,
    }


@app.get("/api/profile")
async def api_get_profile() -> dict[str, Any]:
    pool = get_pool()
    return {"profile": pool.get_profile_dict()}


@app.get("/api/profiles")
async def api_list_profiles() -> dict[str, Any]:
    pool = get_pool()
    return {"profiles": pool.list_profiles(), "current": pool.get_profile_dict()}


@app.post("/api/profile/switch")
async def api_switch_profile(body: SwitchProfileRequest) -> dict[str, Any]:
    pool = get_pool()
    try:
        profile = pool.switch_profile(body.profile_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    agent = pool.get_agent()
    return {
        "profile": pool.get_profile_dict(),
        "agent": agent.get_agent_info(),
        "layout": profile.layout,
    }


@app.get("/api/sessions")
async def api_list_sessions() -> dict[str, Any]:
    return {"sessions": list_sessions()}


@app.post("/api/sessions")
async def api_create_session(body: CreateSessionRequest | None = None) -> dict[str, Any]:
    title = body.title if body else None
    session = create_session(title=title)
    return {"session": session}


@app.get("/api/sessions/{session_id}")
async def api_get_session(session_id: str) -> dict[str, Any]:
    session = get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"session": session}


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str) -> dict[str, Any]:
    if not delete_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    _delete_session_workspace(session_id)
    return {"ok": True, "id": session_id}


@app.get("/api/sessions/{session_id}/trajectory")
async def api_session_trajectory(session_id: str) -> dict[str, Any]:
    if not session_id.strip():
        raise HTTPException(status_code=400, detail="session_id is required")
    try:
        otel_dir = _session_workspace_root(session_id) / ".otel"
    except Exception:
        return {"groups": []}
    return load_session_trajectory(otel_dir)


_WORKSPACE_FILE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".md": "text/markdown; charset=utf-8",
    ".sql": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
}


def _delete_session_workspace(session_id: str) -> None:
    """Best-effort remove the kernel workspace folder named after this session."""
    try:
        root = _session_workspace_root(session_id).resolve()
    except Exception:
        return
    safe = sanitize_session_id(session_id)
    if not root.is_dir() or root.name != safe:
        return
    home = Path.home().resolve()
    try:
        root.relative_to(home)
    except ValueError:
        return
    shutil.rmtree(root, ignore_errors=True)


def _session_workspace_root(session_id: str) -> Path:
    pool = get_pool()
    agent = pool.get_agent()
    settings = agent.config.get_all() if hasattr(agent.config, "get_all") else {}
    return resolve_effective_workspace_root(config=settings, session_id=session_id, user_id=DEFAULT_USER_ID)


@app.get("/api/workspace-file")
async def api_workspace_file(session_id: str, path: str):
    """Serve a file that lives under the Copilot session workspace (sql/csv/png/md)."""
    if not session_id.strip() or not path.strip():
        raise HTTPException(status_code=400, detail="session_id and path are required")
    root = _session_workspace_root(session_id).resolve()
    target = Path(path).expanduser().resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="path outside session workspace") from exc
    if not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    media = _WORKSPACE_FILE_MIME.get(target.suffix.lower(), "application/octet-stream")
    safe_name = target.name.replace('"', "")
    return FileResponse(
        target,
        media_type=media,
        headers={"content-disposition": f'inline; filename="{safe_name}"'},
    )


_RUNNING_ASSISTANT_CONTENT = "处理中…"
_CANCELLED_ASSISTANT_CONTENT = "已取消当前请求"
_NO_RESULT_ASSISTANT_CONTENT = "生成已结束，但没有收到最终结论。请重新提问。"
_SSE_HEARTBEAT_S = 15.0  # HAZARD: 写死；过小刷连接，过大会被代理 idle 掐断。
_CHECKPOINT_INTERVAL_S = 1.5  # HAZARD: 写盘节流写死；过小会刷盘，过大会让刷新后的 running 态更滞后。
_CHECKPOINT_EVENTS = frozenset(
    {
        ShellEventType.PLAN,
        ShellEventType.TOOL,
        ShellEventType.ARTIFACT,
        ShellEventType.STAGE,
        ShellEventType.CONTEXT,
        ShellEventType.CONTEXT_USAGE,
        ShellEventType.PROMPT_INVENTORY,
        ShellEventType.SPAN,
    }
)


def _persist_assistant_turn(
    session_id: str,
    *,
    agent_type: str,
    content: str,
    result: dict[str, Any] | None,
    snapshot: ProcessSnapshot,
    delegations_acc: DelegationAccumulator,
    status: str = "done",
    turn_started_at: int | None = None,
    turn_ended_at: int | None = None,
    finalize: bool = True,
) -> None:
    extras = snapshot.persist_kwargs(finalize_stages=finalize)
    sql = extras.pop("sql", None)
    columns = None
    rows_preview = None
    if finalize:
        delegations = delegations_acc.finalize(interrupted=status == "error")
    else:
        delegations = delegations_acc.snapshot()
    if isinstance(result, dict):
        sql = str(result.get("sql") or "") or sql
        columns = result.get("columns") if agent_type == "nl2sql" else None
        rows_preview = result.get("rows_preview") if agent_type == "nl2sql" else None
        raw_delegations = result.get("delegations")
        if isinstance(raw_delegations, list) and raw_delegations and not delegations:
            delegations = raw_delegations
    upsert_assistant_message(
        session_id,
        content,
        sql=sql,
        columns=columns,
        rows_preview=rows_preview,
        delegations=delegations or None,
        status=status,
        turn_started_at=turn_started_at,
        turn_ended_at=turn_ended_at,
        **extras,
    )


_WORKSPACE_BUSY_MESSAGE = "当前会话工作区正被占用。请等待上一轮结束，或先停止生成后再试。"


def _user_facing_error_text(text: str) -> str:
    """Map kernel/stream errors to Chinese copy. Keep in sync with web ``chatErrors.ts``."""
    raw = text.strip()
    if raw in {_WORKSPACE_BUSY_MESSAGE, _NO_RESULT_ASSISTANT_CONTENT, _CANCELLED_ASSISTANT_CONTENT, SQL_SECURITY_USER_MESSAGE}:
        return raw
    if "连接中断" in raw:
        return raw
    lowered = raw.lower()
    compact = lowered.replace(" ", "")
    if "workspace is busy" in lowered or "workspacebusyerror" in compact:
        return _WORKSPACE_BUSY_MESSAGE
    if "already running" in lowered or "本次未启动" in raw:
        return "子 Agent 正在运行。请停止当前生成，或换一个新的 worker 再问。"
    security = sql_security_user_message(raw)
    if security:
        return security
    if "semantic" in lowered or "语义" in raw:
        return "语义层暂时不可用。请确认 Semantic Service（:32000）已启动后重试。"
    if "timeout" in lowered or "timed out" in lowered or "超时" in raw:
        return "等待模型或子 Agent 超时，请稍后重试。"
    return f"生成失败：{raw[:240]}" if raw else "生成失败：未知错误"


def _user_facing_stream_error(exc: BaseException) -> str:
    if isinstance(exc, WorkspaceBusyError):
        return _WORKSPACE_BUSY_MESSAGE
    return _user_facing_error_text(str(exc).strip() or type(exc).__name__)


async def _stop_stream_on_disconnect(request: Request, stream: AsyncIterator[Any]) -> None:
    while True:
        if await request.is_disconnected():
            await aclose_stream(stream)
            return
        await asyncio.sleep(0.3)


@app.post("/api/chat")
async def api_chat(body: ChatRequest, request: Request) -> StreamingResponse:
    pool = get_pool()
    adapter = pool.get_adapter()
    agent_type = str(pool.get_agent().type or "react")

    ensure_session(body.session_id)
    kernel_run_id = allocate_kernel_run_id(body.session_id) if agent_type != "nl2sql" else None
    agent_query = resolve_chat_query(agent_type, body.session_id, body.query)
    append_user_message(body.session_id, body.query)

    async def event_generator() -> AsyncGenerator[str, None]:
        result_payload: dict[str, Any] | None = None
        snapshot = ProcessSnapshot()
        delegations_acc = DelegationAccumulator()
        turn_started_at = int(time.time() * 1000)
        last_checkpoint = 0.0
        stream: AsyncIterator[dict[str, Any]] = adapter.stream_events(
            agent_query,
            body.session_id,
            run_id=kernel_run_id,
        )
        cancelled = False
        stream_error: str | None = None
        watch = asyncio.create_task(_stop_stream_on_disconnect(request, stream))

        def checkpoint() -> None:
            nonlocal last_checkpoint
            now = time.monotonic()
            if now - last_checkpoint < _CHECKPOINT_INTERVAL_S:
                return
            last_checkpoint = now
            _persist_assistant_turn(
                body.session_id,
                agent_type=agent_type,
                content=_RUNNING_ASSISTANT_CONTENT,
                result=None,
                snapshot=snapshot,
                delegations_acc=delegations_acc,
                status="running",
                turn_started_at=turn_started_at,
                finalize=False,
            )

        def persist_end(content: str, status: str) -> None:
            _persist_assistant_turn(
                body.session_id,
                agent_type=agent_type,
                content=content,
                result=result_payload,
                snapshot=snapshot,
                delegations_acc=delegations_acc,
                status=status,
                turn_started_at=turn_started_at,
                turn_ended_at=int(time.time() * 1000),
                finalize=True,
            )

        yield SSE_PADDING
        try:
            async for item in iter_stream_with_heartbeat(stream, heartbeat_s=_SSE_HEARTBEAT_S):
                if item is None:
                    if await request.is_disconnected():
                        cancelled = True
                        break
                    yield SSE_FLUSH
                    continue
                if await request.is_disconnected():
                    cancelled = True
                    break
                event = str(item.get("event") or "")
                data = item.get("data")
                if not event:
                    continue
                if isinstance(data, dict):
                    snapshot.ingest(event, data)
                    delegations_acc.ingest_shell_event(event, data)

                if event == ShellEventType.RESULT and isinstance(data, dict):
                    result_payload = data
                    content = (
                        str(data.get("message") or "查询完成")
                        if agent_type == "nl2sql"
                        else str(data.get("message") or "完成")
                    )
                    persist_end(content, "done")
                elif event == ShellEventType.ERROR:
                    if isinstance(data, dict):
                        raw_error = str(data.get("message") or _NO_RESULT_ASSISTANT_CONTENT)
                    else:
                        raw_error = str(data or _NO_RESULT_ASSISTANT_CONTENT)
                    stream_error = _user_facing_error_text(raw_error)
                    data = {"message": stream_error} if not isinstance(data, dict) else {**data, "message": stream_error}
                    persist_end(stream_error, "error")
                elif event in _CHECKPOINT_EVENTS:
                    checkpoint()

                encoded = sse_encode(event, data)
                if event in (ShellEventType.STAGE, ShellEventType.THINK):
                    encoded += SSE_PADDING
                yield encoded
        except (asyncio.CancelledError, GeneratorExit):
            cancelled = True
            raise
        except Exception as exc:
            # HAZARD: 流式循环兜底捕获所有异常并转成中文 ERROR；内核 bug 也会被当成用户可读失败。
            stream_error = _user_facing_stream_error(exc)
            persist_end(stream_error, "error")
            yield sse_encode(ShellEventType.ERROR, {"message": stream_error})
        finally:
            watch.cancel()
            with suppress(Exception, asyncio.CancelledError):
                await watch
            await aclose_stream(stream)
            if result_payload is None and cancelled and stream_error is None:
                persist_end(_CANCELLED_ASSISTANT_CONTENT, "error")

        if result_payload is None and stream_error is None and not cancelled:
            persist_end(_NO_RESULT_ASSISTANT_CONTENT, "error")
            yield sse_encode(ShellEventType.ERROR, {"message": _NO_RESULT_ASSISTANT_CONTENT})
        elif cancelled and result_payload is None and stream_error is None:
            yield sse_encode(ShellEventType.ERROR, {"message": _CANCELLED_ASSISTANT_CONTENT})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Content-Encoding": "identity",
        },
    )
