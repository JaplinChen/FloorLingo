"""
FloorLingo Python SDK.

Official client library for the FloorLingo WhatsApp API Gateway.

Example usage::

    from floorlingo import FloorLingoClient

    client = FloorLingoClient(
        base_url="http://localhost:2785",
        api_key="owa_k1_…",
    )

    client.sessions.start("my-session")
    result = client.messages.send_text("my-session", {
        "chatId": "628123456789@c.us",
        "text": "Hello from the FloorLingo Python SDK!",
    })
    print(result["messageId"])
"""

from __future__ import annotations

from .client import FloorLingoClient
from .errors import (
    FloorLingoApiError,
    FloorLingoAuthError,
    FloorLingoConflictError,
    FloorLingoError,
    FloorLingoForbiddenError,
    FloorLingoNotFoundError,
    FloorLingoNotImplementedError,
    FloorLingoRateLimitError,
    FloorLingoTimeoutError,
)

__all__ = [
    "FloorLingoClient",
    "FloorLingoError",
    "FloorLingoApiError",
    "FloorLingoAuthError",
    "FloorLingoForbiddenError",
    "FloorLingoNotFoundError",
    "FloorLingoConflictError",
    "FloorLingoRateLimitError",
    "FloorLingoNotImplementedError",
    "FloorLingoTimeoutError",
]
