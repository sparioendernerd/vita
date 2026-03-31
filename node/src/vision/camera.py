import asyncio
import logging
import cv2

logger = logging.getLogger(__name__)


class Camera:
    """Captures JPEG frames from a camera at a configurable rate."""

    def __init__(self, camera_index: int = 0, fps: float = 1.0):
        self.camera_index = camera_index
        self.interval = 1.0 / fps
        self._cap: cv2.VideoCapture | None = None

    def start(self) -> None:
        self._cap = cv2.VideoCapture(self.camera_index)
        if not self._cap.isOpened():
            raise RuntimeError(f"Cannot open camera {self.camera_index}")
        logger.info(f"Camera {self.camera_index} opened")

    def stop(self) -> None:
        if self._cap:
            self._cap.release()
            self._cap = None
        logger.info("Camera stopped")

    def capture_jpeg(self) -> bytes | None:
        if not self._cap:
            return None
        ret, frame = self._cap.read()
        if not ret:
            return None
        _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        return jpeg.tobytes()

    async def stream_frames(self):
        """Async generator yielding JPEG frames at the configured rate."""
        while self._cap and self._cap.isOpened():
            frame = await asyncio.get_event_loop().run_in_executor(
                None, self.capture_jpeg
            )
            if frame:
                yield frame
            await asyncio.sleep(self.interval)
