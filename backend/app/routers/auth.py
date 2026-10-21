from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.auth import (
    SESSION_COOKIE_NAME,
    cookie_kwargs,
    create_session_token,
    get_current_user,
    verify_google_id_token,
)
from app.db import get_db
from app.models import User, WorkspaceShare
from app.schemas import GoogleAuthIn, MeOut, UserOut
from app.scope import normalize_email

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _user_out(user: User) -> UserOut:
    return UserOut(id=user.id, name=user.name, email=user.email, avatar_url=user.avatar_url)


@router.post("/google")
def auth_google(body: GoogleAuthIn, request: Request, response: Response, db: Session = Depends(get_db)):
    try:
        claims = verify_google_id_token(body.id_token)
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"Could not verify Google sign-in: {exc}")

    google_id = claims["sub"]
    email = claims.get("email", "")
    name = claims.get("name") or email or "Google user"
    avatar_url = claims.get("picture")
    now = datetime.now(timezone.utc).isoformat()

    user = db.query(User).filter(User.google_id == google_id).first()
    if user is None:
        user = User(
            google_id=google_id,
            email=email,
            name=name,
            avatar_url=avatar_url,
            created_at=now,
            last_login_at=now,
        )
        db.add(user)
    else:
        user.email = email
        user.name = name
        user.avatar_url = avatar_url
        user.last_login_at = now
    db.commit()
    db.refresh(user)

    # Activates every pending invite (shared with this email before the
    # invitee had ever signed in) -- matched case-insensitively since the
    # person who shared can't be expected to type the exact case Google
    # happens to store this account's email in. A share already activated
    # (user_id set) or belonging to a different email is untouched.
    db.query(WorkspaceShare).filter(
        WorkspaceShare.invited_email == normalize_email(email), WorkspaceShare.user_id.is_(None)
    ).update({"user_id": user.id}, synchronize_session=False)
    db.commit()

    token = create_session_token(user.id)
    response.set_cookie(SESSION_COOKIE_NAME, token, **cookie_kwargs(request))

    return {"user": _user_out(user)}


@router.get("/me", response_model=MeOut)
def auth_me(user: User | None = Depends(get_current_user)):
    if user is None:
        return MeOut(authenticated=False, user=None)
    return MeOut(authenticated=True, user=_user_out(user))


@router.post("/logout")
def auth_logout(request: Request, response: Response):
    response.delete_cookie(SESSION_COOKIE_NAME, path="/", samesite="lax")
    return {"ok": True}
