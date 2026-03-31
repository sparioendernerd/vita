from pydantic import BaseModel, Field
import os


class NodeConfig(BaseModel):
    gateway_url: str = Field(default="ws://localhost:8765")
    gateway_token: str = Field(default="")  # auth token for the gateway
    node_id: str = Field(default="")
    vita_name: str = Field(default="graves")
    gemini_api_key: str = Field(default="")

    # Audio settings
    mic_sample_rate: int = 16000
    mic_channels: int = 1
    mic_chunk_size: int = 1280  # 80ms at 16kHz
    speaker_sample_rate: int = 24000
    speaker_channels: int = 1

    # Wake word (local-wake)
    wake_word_ref_dir: str = Field(default="wakeword/refs")  # folder containing .wav samples
    wake_word_threshold: float = 0.1       # lower = more sensitive (adjust after comparing)
    wake_word_method: str = "embedding"    # 'embedding' (default) or 'mfcc'
    wake_word_buffer_size: float = 2.0     # seconds — should match max recording length
    wake_word_slide_size: float = 0.25     # seconds — lower = more precise but higher CPU
    wake_word_debug: bool = False          # log volume/distance periodically

    # Session
    silence_timeout: float = 30.0  # seconds of silence before ending session

    # Medal clip watcher
    medal_clips_dir: str = Field(default=r"C:\Medal\Clips")

    # Vision
    vision_enabled: bool = False
    camera_index: int = 0
    camera_fps: float = 1.0  # frames per second to send


def load_config() -> NodeConfig:
    host = os.getenv("GATEWAY_HOST", "localhost")
    if host == "0.0.0.0":
        host = "localhost"
    port = os.getenv("GATEWAY_PORT", "8765")
    default_url = f"ws://{host}:{port}"

    return NodeConfig(
        gateway_url=os.getenv("GATEWAY_URL", default_url),
        gateway_token=os.getenv("VITA_GATEWAY_TOKEN", ""),
        node_id=os.getenv("NODE_ID", ""),
        vita_name=os.getenv("VITA_NAME", "graves"),
        gemini_api_key=os.getenv("GEMINI_API_KEY", ""),
        wake_word_ref_dir=os.getenv("WAKE_WORD_REF_DIR", "wakeword/refs"),
        wake_word_threshold=float(os.getenv("WAKE_WORD_THRESHOLD", "0.1")),
        wake_word_method=os.getenv("WAKE_WORD_METHOD", "embedding"),
        wake_word_buffer_size=float(os.getenv("WAKE_WORD_BUFFER_SIZE", "2.0")),
        wake_word_slide_size=float(os.getenv("WAKE_WORD_SLIDE_SIZE", "0.25")),
        wake_word_debug=os.getenv("WAKE_WORD_DEBUG", "False").lower() == "true",
        medal_clips_dir=os.getenv("MEDAL_CLIPS_DIR", r"C:\Medal\Clips"),
    )
