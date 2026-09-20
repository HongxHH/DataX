"""Manual e2e harness (not pytest): POST /api/chat for landcheck table list over SSE.

Run against a live shell backend: ``uv run python shell/backend/tests/e2e_chat_tables.py``
"""

from __future__ import annotations

import json
import sys
import uuid

import httpx

BASE = "http://127.0.0.1:8788"
QUERY = "landcheck 库有哪些表？"


def main() -> int:
    session_id = str(uuid.uuid4())
    with httpx.Client(timeout=httpx.Timeout(600.0, connect=10.0)) as client:
        r = client.post(f"{BASE}/api/sessions", json={"title": "e2e tables"})
        session_id = r.json()["session"]["id"]

        events: list[tuple[str, dict]] = []
        tool_names: list[str] = []
        errors: list[str] = []
        result_msg = ""

        with client.stream(
            "POST",
            f"{BASE}/api/chat",
            json={"session_id": session_id, "query": QUERY},
        ) as resp:
            if resp.status_code != 200:
                print(f"chat failed: {resp.status_code} {resp.text}")
                return 1

            event_type = None
            for line in resp.iter_lines():
                if not line:
                    continue
                if line.startswith("event:"):
                    event_type = line.split(":", 1)[1].strip()
                elif line.startswith("data:") and event_type:
                    raw = line.split(":", 1)[1].strip()
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        data = {"raw": raw}
                    events.append((event_type, data))
                    if event_type == "tool":
                        tool_names.append(str(data.get("tool_name") or ""))
                        print(f"  tool: {data.get('tool_name')} status={data.get('status')}", flush=True)
                    if event_type == "stage":
                        print(f"  stage: {data.get('label') or data.get('hint')}", flush=True)
                    if event_type == "error":
                        errors.append(str(data.get("message") or data))
                        print(f"  error: {data}", flush=True)
                    if event_type == "result":
                        result_msg = str(data.get("message") or "")
                    event_type = None

    print(f"session={session_id}")
    print(f"events={len(events)} tools={tool_names}")
    print(f"errors={errors}")
    print(f"result_preview={result_msg[:500]}")

    bad_tools = [t for t in tool_names if t in ("glob", "bash", "grep")]
    gbk_hit = any("gbk" in str(e).lower() for e in errors)
    has_sub = "sub_agent_tool" in tool_names

    if bad_tools:
        print(f"FAIL: unwanted tools {bad_tools}")
        return 2
    if gbk_hit:
        print("FAIL: gbk error in stream")
        return 3
    if not has_sub:
        print("WARN: sub_agent_tool not seen")
    if not result_msg:
        print("FAIL: empty result")
        return 4

    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
