import logging
import time
from pathlib import Path
from typing import Callable

import numpy as np
from lwake.features import extract_embedding_features, extract_mfcc_features, dtw_cosine_normalized_distance

logger = logging.getLogger(__name__)

class WakeWordDetector:
    """Frame-based wake word detector.
    
    Instead of opening its own mic stream, this version accepts audio frames
    from the main MicStream. This avoids hardware conflicts on Windows.
    """

    def __init__(
        self,
        reference_dir: str,
        threshold: float = 0.2,
        method: str = "embedding",
        buffer_size: float = 2.0,
        slide_size: float = 0.25,
        sample_rate: int = 16000,
        debug_mode: bool = False
    ):
        self.reference_dir = Path(reference_dir)
        self.threshold = threshold
        self.method = method
        self.sample_rate = sample_rate
        self.debug_mode = debug_mode
        
        # Buffer management
        self.buffer_size_samples = int(buffer_size * sample_rate)
        self.slide_size_samples = int(slide_size * sample_rate)
        self.audio_buffer = np.zeros(self.buffer_size_samples, dtype=np.float32)
        self._new_samples_count = 0
        
        self._active = False
        self._on_detected: Callable[[], None] | None = None
        
        # Load reference samples
        self.support_set = []
        if self.reference_dir.exists():
            for file in self.reference_dir.glob("*.wav"):
                try:
                    if method == "mfcc":
                        feat = extract_mfcc_features(path=str(file))
                    else:
                        feat = extract_embedding_features(path=str(file))
                    self.support_set.append((file.name, feat))
                except Exception as e:
                    logger.error(f"[WakeWord] Failed to load {file.name}: {e}")
        else:
            logger.error(f"[WakeWord] Reference directory not found: {self.reference_dir}")

        logger.info(f"[WakeWord] Prepared {len(self.support_set)} reference samples (threshold={threshold}, method={method})")


        self._last_debug_time = 0
        self._best_dist_window = 1.0

    def start(self, on_detected: Callable[[], None]):
        self._on_detected = on_detected
        self._active = True
        self._new_samples_count = 0
        self._last_debug_time = time.time()
        self._best_dist_window = 1.0
        logger.info("[WakeWord] Detector active (waiting for frames)")

    def stop(self):
        self._active = False
        logger.info("[WakeWord] Detector paused")

    def process_frame(self, pcm_data: bytes):
        """Add new audio data and check for wake word if enough data has accumulated."""
        if not self._active:
            return

        # Convert bytes to float32
        new_samples = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32) / 32768.0
        
        # Update rolling buffer
        self.audio_buffer = np.roll(self.audio_buffer, -len(new_samples))
        self.audio_buffer[-len(new_samples):] = new_samples
        
        self._new_samples_count += len(new_samples)
        
        # Only process if we've accumulated at least 'slide_size' worth of new data
        if self._new_samples_count >= self.slide_size_samples:
            self._new_samples_count = 0
            self._check_matches()

    def _check_matches(self):
        try:
            # Volume check
            rms = np.sqrt(np.mean(self.audio_buffer**2))
            
            if self.method == "mfcc":
                features = extract_mfcc_features(y=self.audio_buffer, sample_rate=self.sample_rate)
            else:
                features = extract_embedding_features(y=self.audio_buffer, sample_rate=self.sample_rate)
            
            if features is None:
                return

            for name, ref_feat in self.support_set:
                distance = dtw_cosine_normalized_distance(features, ref_feat)
                if distance < self._best_dist_window:
                    self._best_dist_window = distance
                    self._best_match_name = name

                if distance < self.threshold:
                    logger.info(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    logger.info(f" 🔥 Wake Word Triggered: {name} (dist={distance:.4f})")
                    logger.info(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    if self._on_detected:
                        self.audio_buffer.fill(0)
                        self._on_detected()
                    return

            # Periodic debug log
            now = time.time()
            if self.debug_mode and now - self._last_debug_time > 3.0:
                logger.info(f"[WakeWord Debug] Vol={rms:.4f} | Best Dist={self._best_dist_window:.4f} ({self._best_match_name or 'none'})")
                self._last_debug_time = now
                self._best_dist_window = 1.0  # Reset for next window
                self._best_match_name = None
        except Exception as e:
            logger.error(f"[WakeWord] Error during matching: {e}")
