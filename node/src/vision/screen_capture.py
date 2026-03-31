import asyncio
import logging
import cv2
import numpy as np
import mss

logger = logging.getLogger(__name__)


class ScreenCapture:
    """Captures screenshots at a configurable rate, useful for vision."""

    def __init__(self, fps: float = 1.0):
        self.interval = 1.0 / fps
        self._running = False

    def start(self) -> None:
        self._running = True
        logger.info("Screen capture started")

    def stop(self) -> None:
        self._running = False
        logger.info("Screen capture stopped")

    def capture_jpeg(self) -> bytes | None:
        """Capture the primary monitor as a JPEG."""
        if not self._running:
            return None
        
        try:
            with mss.mss() as sct:
                # Capture the primary monitor
                monitor = sct.monitors[1]
                sct_img = sct.grab(monitor)
                
                # Convert to numpy array (BGRA) then to BGR for OpenCV
                img = np.array(sct_img)
                frame = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
                
                # Resize if necessary to save bandwidth (e.g., max height 720)
                h, w = frame.shape[:2]
                if h > 720:
                    scale = 720.0 / h
                    frame = cv2.resize(frame, (int(w * scale), 720))

                _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                return jpeg.tobytes()
        except Exception as e:
            logger.error(f"Failed to capture screen: {e}")
            return None

    async def stream_frames(self):
        """Async generator yielding JPEG screenshots at the configured rate."""
        while self._running:
            frame = await asyncio.get_event_loop().run_in_executor(
                None, self.capture_jpeg
            )
            if frame:
                yield frame
            await asyncio.sleep(self.interval)
