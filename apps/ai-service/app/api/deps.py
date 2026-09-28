from typing import Annotated

from fastapi import Depends, Request

from app.core.config import Settings, get_settings
from app.llm.base import ChatProvider


def get_provider(request: Request) -> ChatProvider:
    provider: ChatProvider = request.app.state.provider
    return provider


Provider = Annotated[ChatProvider, Depends(get_provider)]
AppSettings = Annotated[Settings, Depends(get_settings)]
