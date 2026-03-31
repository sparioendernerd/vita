import asyncio
import logging
from typing import Callable, Coroutine, Any
from google import genai
from google.genai import types
from .gemini_config import build_live_config

logger = logging.getLogger(__name__)


class LiveSessionManager:
    """Manages a Gemini Live audio session."""

    def __init__(self, api_key: str):
        self.client = genai.Client(api_key=api_key)
        self.session: Any = None
        self._session_cm: Any = None
        self._active = False

    async def start(self, vita_config: dict, memories: list[str]) -> None:
        """Open a Gemini Live session with the VITA's personality."""
        model = vita_config.get("liveModel", "gemini-3.1-flash-live-preview")
        config = build_live_config(vita_config, memories)

        logger.info(f"Opening Gemini Live session with model={model}, voice={vita_config.get('voiceName')}")
        self._session_cm = self.client.aio.live.connect(
            model=model,
            config=config,
        )
        self.session = await self._session_cm.__aenter__()
        self._active = True
        logger.info("Gemini Live session opened")

    async def close(self) -> None:
        """Close the Live session."""
        self._active = False
        if self._session_cm:
            try:
                await self._session_cm.__aexit__(None, None, None)
            except Exception as e:
                logger.debug(f"Session close: {e}")
            self._session_cm = None
            self.session = None
        logger.info("Gemini Live session closed")

    @property
    def is_active(self) -> bool:
        return self._active and self.session is not None

    async def send_audio(self, pcm_chunk: bytes) -> None:
        """Send a mic audio chunk to the Live session."""
        if not self.is_active:
            return
        await self.session.send_realtime_input(
            audio=types.Blob(data=pcm_chunk, mime_type="audio/pcm;rate=16000")
        )

    async def send_video_frame(self, jpeg_bytes: bytes) -> None:
        """Send a camera frame to the Live session."""
        if not self.is_active:
            return
        await self.session.send_realtime_input(
            video=types.Blob(data=jpeg_bytes, mime_type="image/jpeg")
        )

    async def receive_loop(
        self,
        on_audio: Callable[[bytes], Coroutine],
        on_tool_call: Callable[[Any], Coroutine],
        on_transcript: Callable[[str], Coroutine],
        on_turn_complete: Callable[[], Coroutine],
    ) -> None:
        """Continuously receive responses from Gemini Live."""
        if not self.session:
            return

        try:
            while self._active:
                try:
                    async for response in self.session.receive():
                        if not self._active:
                            break

                        sc = response.server_content
                        if sc and sc.model_turn:
                            for part in sc.model_turn.parts:
                                if part.inline_data and part.inline_data.data:
                                    await on_audio(part.inline_data.data)
                                if part.text:
                                    await on_transcript(part.text)

                        if sc and sc.turn_complete:
                            await on_turn_complete()

                        if response.tool_call:
                            await on_tool_call(response.tool_call)

                    # If the generator exits normally but session is still active, wait slightly and try reconnecting.
                    if self._active:
                        await asyncio.sleep(0.1)

                except asyncio.CancelledError:
                    raise
                except Exception as loop_err:
                    if self._active:
                        logger.error(f"Receive loop iterator error: {loop_err}")
                        await asyncio.sleep(0.5) # Prevent rapid spin on error before breaking
                    else:
                        break

        except Exception as e:
            if self._active:
                logger.error(f"Receive loop fatal error: {e}")
            raise
