import asyncio
import logging
import os
import sys
from pathlib import Path
from typing import Any
from uuid import uuid4

from google import genai
from google.genai import types

from dotenv import load_dotenv

from .config import load_config, NodeConfig
from .audio.mic_stream import MicStream
from .audio.speaker import Speaker
from .audio.audio_utils import generate_beep, get_start_sound, get_end_sound, get_tool_sound
from .wakeword.detector import WakeWordDetector
from .gateway_client.ws_client import GatewayClient
from .gateway_client.tool_proxy import ToolProxy
from .live_session.session_manager import LiveSessionManager
from .live_session.tool_handler import ToolHandler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("vita.node")

_MEDAL_VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}

_CLIP_COMMENTARY_PROMPT = (
    "You are Graves — the posh, caffeinated, deadpan co-host of Vailen Industries. "
    "British, witty, and mildly condescending. Think Norm MacDonald with an Oxford degree "
    "and a passive-aggressive teapot. Sarcasm is your native tongue, but beneath it lurks "
    "genuine loyalty to Vailen.\n\n"
    "You are watching a 1-minute gameplay clip of Vailen. He just asked you to clip this. Deliver commentary in your voice: "
    "dry, sharp, a verbal side-eye where earned. Pick out a key moment or two — a decent play, "
    "a spectacular mistake, anything that warrants an eyebrow raise. Speak like you're in the "
    "room — casual, human, unscripted. No narration. No exposition. No enthusiasm unless it's "
    "ironic. Under 80 words. Snappy delivery — this is voiced with a heavy posh British Accent."
)


class VitaNode:
    """Main node orchestrator: IDLE -> wake word -> Gemini Live conversation -> IDLE."""

    def __init__(self, config: NodeConfig):
        self.config = config
        self.state = "idle"

        # Components
        self.mic = MicStream(config)
        self.speaker = Speaker(config)
        self.detector = WakeWordDetector(
            config.wake_word_ref_dir,
            config.wake_word_threshold,
            config.wake_word_method,
            config.wake_word_buffer_size,
            config.wake_word_slide_size,
        )
        self.gateway = GatewayClient(config.gateway_url, config.node_id, config.vita_name, config.gateway_token)
        self.tool_proxy = ToolProxy(self.gateway)
        self.session_mgr = LiveSessionManager(config.gemini_api_key)

        # Sounds
        self.start_beep = get_start_sound(config.speaker_sample_rate)
        self.end_beep = get_end_sound(config.speaker_sample_rate)
        self.tool_beep = get_tool_sound(config.speaker_sample_rate)

        self.end_session_event = asyncio.Event()
        self.turn_complete_event = asyncio.Event()

        # Conversation state
        self._last_activity: float = 0
        self._conversation_task: asyncio.Task | None = None

        # Medal clip watcher
        self._clip_client = genai.Client(api_key=config.gemini_api_key)
        self._known_clips: set[Path] = set()

    async def run(self) -> None:
        """Main loop: connect to gateway, start components, wait for wake words."""

        # Connect to gateway
        await self.gateway.connect()
        await self.gateway.send_status("idle")

        # Start the mic (single stream for everything)
        self.mic.start(asyncio.get_event_loop())
        logger.info("Microphone started")

        # Always-on mic drain task — handles routing to detector or Gemini
        asyncio.create_task(self._mic_forward_loop(), name="mic-drain")

        # Prepare detector
        self._wake_event = asyncio.Event()
        self.detector.start(on_detected=self._wake_event.set)
        logger.info("Wake word detector prepared — listening for wake phrase...")

        # Start Medal clip watcher
        self._start_medal_watcher()

        try:
            while True:
                # Block until wake word is detected (detector.process_frame handles the event)
                await self._wake_event.wait()
                self._wake_event.clear()

                if self.state == "idle":
                    logger.info("Wake word detected! Entering conversation mode...")
                    
                    # 1. Pause detector while conversing
                    self.detector.stop()
                    
                    # 2. Start the Gemini conversation
                    await self._start_conversation()

                    # 3. Resume wake word detection
                    self.detector.start(on_detected=self._wake_event.set)
        except (KeyboardInterrupt, asyncio.CancelledError):
            logger.info("Shutting down...")
        finally:
            self.detector.stop()
            self.mic.stop()
            await self._cleanup()

    async def _start_conversation(self) -> None:
        """Transition from IDLE to CONVERSING."""
        self.state = "listening"
        await self.gateway.send_status("listening")

        # Get VITA config and memories from gateway
        session_config = await self.gateway.request_session_config()
        vita_config = session_config.get("vitaConfig")
        memories = session_config.get("memories", [])

        if not vita_config:
            logger.error("Failed to get VITA config from gateway")
            self.state = "idle"
            await self.gateway.send_status("idle")
            return

        # Start speaker
        self.speaker.start()

        # Open Gemini Live session
        await self.session_mgr.start(vita_config, memories)
        
        # Play Start Beep
        await self.speaker.enqueue(self.start_beep)

        # Create tool handler
        self.end_session_event.clear()
        self.turn_complete_event.clear()
        
        def _on_end():
            loop = asyncio.get_event_loop()
            loop.call_soon_threadsafe(self.end_session_event.set)

        tool_handler = ToolHandler(self.tool_proxy, self.session_mgr.session, on_end_session=_on_end)
        self._tool_handler = tool_handler

        self.state = "conversing"
        await self.gateway.send_status("conversing")
        self._last_activity = asyncio.get_event_loop().time()

        # Start concurrent tasks
        speaker_task = asyncio.create_task(self.speaker.play_loop())
        receive_task = asyncio.create_task(
            self.session_mgr.receive_loop(
                on_audio=self._on_audio,
                on_tool_call=self._on_tool_call,
                on_transcript=self._on_transcript,
                on_turn_complete=self._on_turn_complete,
            )
        )
        timeout_task = asyncio.create_task(self._silence_watchdog())

        self._conversation_task = asyncio.create_task(
            self._await_conversation_end(speaker_task, receive_task, timeout_task)
        )

    async def _mic_forward_loop(self) -> None:
        """Always-running task: route mic audio.
        
        When idle: feed to detector.
        When conversing: feed to Gemini Live (and silence watchdog).
        """
        async for chunk in self.mic:
            if self.state == "idle":
                self.detector.process_frame(chunk)
            elif self.state in ("listening", "conversing"):
                if self.session_mgr.is_active:
                    await self.session_mgr.send_audio(chunk)
                    self._last_activity = asyncio.get_event_loop().time()

    async def _await_conversation_end(
        self,
        speaker_task: asyncio.Task,
        receive_task: asyncio.Task,
        timeout_task: asyncio.Task,
    ) -> None:
        """Wait for the conversation to end, then clean up."""
        end_event_task = asyncio.create_task(self.end_session_event.wait())
        try:
            # Wait for any task to finish (timeout or receive error ends the session)
            done, pending = await asyncio.wait(
                [receive_task, timeout_task, end_event_task],
                return_when=asyncio.FIRST_COMPLETED,
            )

            # Determine reason
            reason = "unknown"
            if end_event_task in done:
                reason = "end_session_tool"
                # Wait for the model's turn to finish streaming (max 15s)
                try:
                    await asyncio.wait_for(self.turn_complete_event.wait(), timeout=15.0)
                except Exception:
                    pass
                
                # Wait for speaker to finish playing goodbye message
                while not self.speaker._queue.empty():
                    await asyncio.sleep(0.1)
                await asyncio.sleep(0.5)
            elif timeout_task in done:
                reason = "silence_timeout"
            elif receive_task in done:
                reason = "session_ended"

            # Check if any completed task threw a silent error
            for task in done:
                if not task.cancelled() and task.exception():
                    logger.error(f"Task {task.get_name() if hasattr(task, 'get_name') else task} failed with: {task.exception()}")
                    reason = f"error: {task.exception()}"

            logger.info(f"Conversation ended: {reason}")
            
            # Play End Beep
            await self.speaker.enqueue(self.end_beep)
            while not self.speaker._queue.empty():
                await asyncio.sleep(0.1)
            await asyncio.sleep(0.5)

        except Exception as e:
            logger.error(f"Conversation error: {e}")
            reason = f"error: {e}"
        finally:
            # Clean up
            await self.session_mgr.close()

            for task in [speaker_task, receive_task, timeout_task, end_event_task]:
                if not task.done():
                    task.cancel()
                    try:
                        await task
                    except (asyncio.CancelledError, Exception):
                        pass

            self.speaker.stop()
            await self.gateway.notify_session_end(reason)

            self.state = "idle"
            await self.gateway.send_status("idle")

    async def _on_audio(self, data: bytes) -> None:
        """Callback: received audio from Gemini Live."""
        await self.speaker.enqueue(data)

    async def _on_tool_call(self, tool_call: Any) -> None:
        """Callback: received tool call from Gemini Live."""
        # Play subtle tool sound first
        await self.speaker.enqueue(self.tool_beep)
        # Process the tool call
        if hasattr(self, '_tool_handler'):
            await self._tool_handler.handle_tool_call(tool_call)

    async def _on_transcript(self, text: str) -> None:
        """Callback: received transcript from Gemini Live."""
        logger.info(f"[VITA] {text}")
        await self.gateway.send_transcript("model", text)

    async def _on_turn_complete(self) -> None:
        """Callback: Gemini finished speaking."""
        self._last_activity = asyncio.get_event_loop().time()
        self.turn_complete_event.set()

    async def _silence_watchdog(self) -> None:
        """End the session if no activity for silence_timeout seconds."""
        while self.state == "conversing":
            await asyncio.sleep(5)
            elapsed = asyncio.get_event_loop().time() - self._last_activity
            if elapsed > self.config.silence_timeout:
                logger.info(f"Silence timeout ({self.config.silence_timeout}s)")
                return

    # ------------------------------------------------------------------
    # Medal clip watcher
    # ------------------------------------------------------------------

    def _start_medal_watcher(self) -> None:
        """Snapshot existing clips and launch the background watcher task."""
        clips_dir = Path(self.config.medal_clips_dir)
        if clips_dir.exists():
            self._known_clips = {
                f for f in clips_dir.rglob("*")
                if f.suffix.lower() in _MEDAL_VIDEO_EXTS
            }
            logger.info(f"Medal watcher started — tracking {len(self._known_clips)} existing clip(s) in {clips_dir}")
        else:
            logger.warning(f"Medal clips directory not found: {clips_dir} — watcher disabled")
            return
        asyncio.create_task(self._watch_medal_clips(), name="medal-watcher")

    async def _watch_medal_clips(self) -> None:
        """Poll the Medal clips directory every 2 seconds for new video files."""
        clips_dir = Path(self.config.medal_clips_dir)
        while True:
            await asyncio.sleep(2)
            if self.state == "conversing":
                continue
            try:
                current = {
                    f for f in clips_dir.rglob("*")
                    if f.suffix.lower() in _MEDAL_VIDEO_EXTS
                }
            except OSError as e:
                logger.warning(f"Medal watcher scan error: {e}")
                continue

            new_files = current - self._known_clips
            self._known_clips = current

            if new_files:
                latest = max(new_files, key=lambda f: f.stat().st_mtime)
                asyncio.create_task(self._handle_new_clip(latest), name="clip-commentary")

    async def _handle_new_clip(self, clip_path: Path) -> None:
        """Upload a new Medal clip to Gemini, generate commentary, and speak it."""
        logger.info(f"New Medal clip detected: {clip_path.name} — waiting for Medal to finish writing...")
        await asyncio.sleep(4)

        if self.state == "conversing":
            logger.info("Live session active — skipping clip commentary")
            return

        uploaded_file = None
        loop = asyncio.get_event_loop()
        try:
            # Upload clip to Gemini Files API
            logger.info(f"Uploading {clip_path.name} to Gemini Files API...")
            uploaded_file = await loop.run_in_executor(
                None,
                lambda: self._clip_client.files.upload(
                    file=clip_path,
                    config=types.UploadFileConfig(
                        mime_type="video/mp4",
                        display_name=clip_path.name,
                    ),
                ),
            )

            # Poll until the file is processed
            timeout = 60
            elapsed = 0
            while uploaded_file.state.name == "PROCESSING":
                if elapsed >= timeout:
                    logger.error("Gemini file processing timed out")
                    return
                await asyncio.sleep(1)
                elapsed += 1
                file_name = uploaded_file.name
                uploaded_file = await loop.run_in_executor(
                    None, lambda: self._clip_client.files.get(name=file_name)
                )

            if uploaded_file.state.name != "ACTIVE":
                logger.error(f"Uploaded file in unexpected state: {uploaded_file.state.name}")
                return

            # Generate commentary text via gemini-2.5-flash
            logger.info("Generating clip commentary...")
            active_file = uploaded_file
            commentary_response = await loop.run_in_executor(
                None,
                lambda: self._clip_client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=[active_file, _CLIP_COMMENTARY_PROMPT],
                ),
            )
            commentary_text = commentary_response.text
            logger.info(f"[CLIP] {commentary_text}")

            # Generate TTS audio — gemini-2.5-flash-preview-tts returns 24kHz 16-bit PCM
            tts_response = await loop.run_in_executor(
                None,
                lambda: self._clip_client.models.generate_content(
                    model="gemini-2.5-flash-preview-tts",
                    contents=commentary_text,
                    config=types.GenerateContentConfig(
                        response_modalities=["AUDIO"],
                        speech_config=types.SpeechConfig(
                            voice_config=types.VoiceConfig(
                                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                                    voice_name="Algieba"
                                )
                            )
                        ),
                    ),
                ),
            )
            audio_data: bytes = tts_response.candidates[0].content.parts[0].inline_data.data

            # Play through speaker (start/stop around the clip playback)
            if self.state == "conversing":
                logger.info("Live session started during commentary generation — skipping playback")
                return

            self.speaker.start()
            speaker_task = asyncio.create_task(self.speaker.play_loop())
            # 24kHz 16-bit mono = 48000 bytes/second; sleep for the actual playback duration
            playback_duration = len(audio_data) / (24000 * 2)
            try:
                await self.speaker.enqueue(audio_data)
                await asyncio.sleep(playback_duration)
            finally:
                self.speaker.stop()
                speaker_task.cancel()
                try:
                    await speaker_task
                except asyncio.CancelledError:
                    pass

            # Delete the uploaded Gemini file 3 seconds after playback finishes
            await asyncio.sleep(3)
            file_name = uploaded_file.name
            await loop.run_in_executor(None, lambda: self._clip_client.files.delete(name=file_name))
            uploaded_file = None

        except Exception as e:
            logger.error(f"Clip commentary failed: {e}")
        finally:
            # Error-path cleanup: delete uploaded file if not already deleted
            if uploaded_file is not None:
                try:
                    file_name = uploaded_file.name
                    await loop.run_in_executor(
                        None, lambda: self._clip_client.files.delete(name=file_name)
                    )
                except Exception:
                    pass

    async def _cleanup(self) -> None:
        """Clean up all resources.

        Order matters: detector (sounddevice/PortAudio) must be stopped and
        given a moment to finish its current read cycle *before* MicStream
        (PyAudio) terminates PortAudio — otherwise the shared PortAudio state
        is torn down beneath lwake and it throws an MME error.
        """
        if self.session_mgr.is_active:
            await self.session_mgr.close()
        self.speaker.stop()

        # Give the lwake listener thread one slide-window to notice _running=False
        # and exit its read loop cleanly before we kill PortAudio underneath it.
        await asyncio.sleep(self.config.wake_word_slide_size + 0.1)

        self.mic.stop()
        await self.gateway.disconnect()


async def main():
    load_dotenv()

    config = load_config()

    # Generate node ID if not set
    if not config.node_id:
        config.node_id = f"node-{uuid4().hex[:8]}"

    if not config.gemini_api_key:
        logger.error("GEMINI_API_KEY not set")
        sys.exit(1)

    logger.info(f"Starting VITA Node {config.node_id} (vita={config.vita_name})")
    logger.info(f"Gateway: {config.gateway_url}")

    node = VitaNode(config)
    try:
        await node.run()
    except KeyboardInterrupt:
        pass  # Already handled inside run(); suppress the top-level traceback.


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass  # Clean exit — no traceback on Ctrl+C.
