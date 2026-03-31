import asyncio
import pyaudio
import numpy as np
from ..config import NodeConfig


class MicStream:
    """Captures audio from the microphone as 16kHz 16-bit mono PCM."""

    def __init__(self, config: NodeConfig):
        self.sample_rate = config.mic_sample_rate
        self.channels = config.mic_channels
        self.chunk_size = config.mic_chunk_size
        self._queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=100)
        self._pa: pyaudio.PyAudio | None = None
        self._stream: pyaudio.Stream | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stopped = False

    def _audio_callback(self, in_data, frame_count, time_info, status):
        if self._loop and in_data:
            try:
                self._loop.call_soon_threadsafe(self._queue.put_nowait, in_data)
            except asyncio.QueueFull:
                pass  # Drop frame silently — consumer (Gemini) not active
        return (None, pyaudio.paContinue)

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._pa = pyaudio.PyAudio()
        self._stream = self._pa.open(
            format=pyaudio.paInt16,
            channels=self.channels,
            rate=self.sample_rate,
            input=True,
            frames_per_buffer=self.chunk_size,
            stream_callback=self._audio_callback,
        )
        self._stream.start_stream()

    def stop(self) -> None:
        self._stopped = True
        if self._stream:
            self._stream.stop_stream()
            self._stream.close()
            self._stream = None
        if self._pa:
            self._pa.terminate()
            self._pa = None

    async def read_chunk(self) -> bytes:
        return await self._queue.get()

    async def __aiter__(self):
        while not self._stopped:
            try:
                yield await self.read_chunk()
            except asyncio.CancelledError:
                break
