import os
import time
import uuid

import jwt
from fastapi import Request
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

SESSION_COOKIE_NAME = "session"
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60  # 7 days
JWT_ALGORITHM = "HS256"
# Hostnames the browser reaches the backend as during local dev (directly, or
# via the Vite proxy) -- cookies for these MUST NOT set Secure, since the
# browser silently refuses to store a Secure cookie over plain http.
LOCAL_HOSTNAMES = {"localhost", "127.0.0.1"}

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")

_SESSION_SECRET = os.environ.get("SESSION_SECRET")
if not _SESSION_SECRET:
    # Dev-only fallback so sign-in is testable without configuring a secret
    # first -- sessions just won't survive a backend restart. Render (and any
    # real deployment) MUST set SESSION_SECRET explicitly, or every restart
    # would silently log everyone out.
    _SESSION_SECRET = uuid.uuid4().hex
    print(
        "WARNING: SESSION_SECRET is not set -- using a random per-process secret. "
        "Sessions will be invalidated on every backend restart. Set SESSION_SECRET "
        "in production."
    )


def verify_google_id_token(token: str) -> dict:
    """Verifies a Google ID token's signature, audience, issuer, and expiry
    via Google's own library -- the frontend's claimed name/email/picture are
    never trusted without this. Returns the verified claims (sub, email,
    name, picture, ...). Raises if GOOGLE_CLIENT_ID isn't configured or the
    token fails verification."""
    if not GOOGLE_CLIENT_ID:
        raise RuntimeError("GOOGLE_CLIENT_ID is not configured on the server")
    return google_id_token.verify_oauth2_token(token, google_requests.Request(), audience=GOOGLE_CLIENT_ID)


def create_session_token(user_id: int) -> str:
    now = int(time.time())
    payload = {"sub": str(user_id), "iat": now, "exp": now + SESSION_TTL_SECONDS}
    return jwt.encode(payload, _SESSION_SECRET, algorithm=JWT_ALGORITHM)


def decode_session_token(token: str) -> int | None:
    """Returns the user id encoded in a valid, unexpired session token, or
    None if it's missing, malformed, expired, or forged (wrong signature)."""
    try:
        payload = jwt.decode(token, _SESSION_SECRET, algorithms=[JWT_ALGORITHM])
        return int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError, TypeError):
        return None


def cookie_kwargs(request: Request, max_age: int | None = SESSION_TTL_SECONDS) -> dict:
    secure = request.url.hostname not in LOCAL_HOSTNAMES
    kwargs = {"httponly": True, "secure": secure, "samesite": "lax", "path": "/"}
    if max_age is not None:
        kwargs["max_age"] = max_age
    return kwargs
