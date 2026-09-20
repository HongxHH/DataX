"""Stream adapters translating kernel output to shell events."""

from shell.backend.adapters.base import BaseStreamAdapter
from shell.backend.adapters.registry import get_adapter_for_agent

__all__ = ["BaseStreamAdapter", "get_adapter_for_agent"]
