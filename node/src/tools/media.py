import ctypes
import logging

logger = logging.getLogger(__name__)

# Virtual Key Codes
# https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes
VK_VOLUME_MUTE = 0xAD
VK_VOLUME_DOWN = 0xAE
VK_VOLUME_UP = 0xAF
VK_MEDIA_NEXT_TRACK = 0xB0
VK_MEDIA_PREV_TRACK = 0xB1
VK_MEDIA_STOP = 0xB2
VK_MEDIA_PLAY_PAUSE = 0xB3

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002

def _press_key(vk_code: int):
    """Simulate a key press and release using ctypes."""
    try:
        # Press
        ctypes.windll.user32.keybd_event(vk_code, 0, KEYEVENTF_EXTENDEDKEY, 0)
        # Release
        ctypes.windll.user32.keybd_event(vk_code, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0)
        return True
    except Exception as e:
        logger.error(f"Failed to press key {hex(vk_code)}: {e}")
        return False

def media_play_pause():
    """Toggle media playback."""
    logger.info("Executing Media: Play/Pause")
    return {"result": "Toggled play/pause", "success": _press_key(VK_MEDIA_PLAY_PAUSE)}

def media_next_track():
    """Skip to next track."""
    logger.info("Executing Media: Next Track")
    return {"result": "Skipped to next track", "success": _press_key(VK_MEDIA_NEXT_TRACK)}

def media_prev_track():
    """Go to previous track."""
    logger.info("Executing Media: Previous Track")
    return {"result": "Went to previous track", "success": _press_key(VK_MEDIA_PREV_TRACK)}

def media_volume_up():
    """Increase system volume."""
    logger.info("Executing Media: Volume Up")
    # Press multiple times for better effect
    success = True
    for _ in range(5):
        if not _press_key(VK_VOLUME_UP):
            success = False
    return {"result": "Increased volume", "success": success}

def media_volume_down():
    """Decrease system volume."""
    logger.info("Executing Media: Volume Down")
    success = True
    for _ in range(5):
        if not _press_key(VK_VOLUME_DOWN):
            success = False
    return {"result": "Decreased volume", "success": success}

def media_mute():
    """Toggle volume mute."""
    logger.info("Executing Media: Mute")
    return {"result": "Toggled mute", "success": _press_key(VK_VOLUME_MUTE)}
