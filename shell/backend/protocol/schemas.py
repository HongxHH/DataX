"""Request/response schemas for shell API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class CreateSessionRequest(BaseModel):
    title: str | None = None


class ChatRequest(BaseModel):
    session_id: str = Field(min_length=1)
    query: str = Field(min_length=1)
    # Fast 默认：关思考；前端「深度思考」打开时为 true
    enable_thinking: bool = False


class SwitchProfileRequest(BaseModel):
    profile_id: str = Field(min_length=1)
