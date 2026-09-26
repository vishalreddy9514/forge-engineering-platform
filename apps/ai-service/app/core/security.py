import secrets
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import Settings, get_settings

_bearer = HTTPBearer(auto_error=False)


def require_service_token(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> None:
    """Allow only internal callers (API, worker) holding the shared service token.

    The comparison is constant-time so response timing does not leak how much of a guessed
    token was correct.
    """
    expected = settings.service_token.get_secret_value()
    if credentials is None or not secrets.compare_digest(
        credentials.credentials.encode(), expected.encode()
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid service token",
            headers={"WWW-Authenticate": "Bearer"},
        )


ServiceAuth = Depends(require_service_token)
