import asyncio
import pyaudio
from ..config import NodeConfig


class Speaker:
    """Plays 24kHz 16-bit mono PCM audio chunks."""

    def __init__(self, config: NodeConfig):
        self.sample_rate = config.speaker_sample_rate
        self.channels = config.speaker_channels
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._pa: pyaudio.PyAudio | None = None
        self._stream: pyaudio.Stream | None = None
        self._playing = False

    def start(self) -> None:
        self._pa = pyaudio.PyAudio()
        self._stream = self._pa.open(
            format=pyaudio.paInt16,
            channels=self.channels,
            rate=self.sample_rate,
            output=True,
        )
        self._playing = True

    def stop(self) -> None:
        self._playing = False
        if self._stream:
            self._stream.stop_stream()
            self._stream.close()
            self._stream = None
        if self._pa:
            self._pa.terminate()
            self._pa = None

    async def enqueue(self, pcm_data: bytes) -> None:
        await self._queue.put(pcm_data)

    def clear(self) -> None:
        """Flush the playback queue (for barge-in support)."""
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    async def play_loop(self) -> None:
        """Continuously dequeue and play audio. Run as an async task."""
        while self._playing:
            try:
                data = await asyncio.wait_for(self._queue.get(), timeout=0.1)
                if self._stream and self._playing:
                    # Write in executor to avoid blocking the event loop
                    loop = asyncio.get_event_loop()
                    await loop.run_in_executor(None, self._stream.write, data)
            except asyncio.TimeoutError:
                continue
