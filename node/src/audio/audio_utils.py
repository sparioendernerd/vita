import numpy as np


def resample(pcm_data: bytes, from_rate: int, to_rate: int) -> bytes:
    """Resample 16-bit PCM audio between sample rates."""
    if from_rate == to_rate:
        return pcm_data
    samples = np.frombuffer(pcm_data, dtype=np.int16)
    duration = len(samples) / from_rate
    new_length = int(duration * to_rate)
    indices = np.linspace(0, len(samples) - 1, new_length)
    resampled = np.interp(indices, np.arange(len(samples)), samples.astype(np.float64))
    return resampled.astype(np.int16).tobytes()


def generate_tone(
    frequency: float,
    duration_ms: int,
    sample_rate: int,
    waveform: str = "sine",
    volume: float = 0.5,
    attack_ms: int = 20,
    release_ms: int = 50,
) -> bytes:
    """Generate a tone with an ADSR envelope."""
    t = np.linspace(0, duration_ms / 1000.0, int(sample_rate * duration_ms / 1000.0), endpoint=False)
    
    if waveform == "sine":
        audio = np.sin(2 * np.pi * frequency * t)
    elif waveform == "square":
        audio = np.where(np.sin(2 * np.pi * frequency * t) >= 0, 1.0, -1.0)
    elif waveform == "triangle":
        audio = 2 * np.abs(2 * (t * frequency - np.floor(t * frequency + 0.5))) - 1
    elif waveform == "sawtooth":
        audio = 2 * (t * frequency - np.floor(t * frequency + 0.5))
    else:
        audio = np.sin(2 * np.pi * frequency * t)

    # Apply volume
    audio *= volume

    # Apply ADSR-like envelope (just Attack and Release for simplicity)
    num_samples = len(t)
    at_samples = int(sample_rate * attack_ms / 1000.0)
    re_samples = int(sample_rate * release_ms / 1000.0)

    envelope = np.ones(num_samples)
    if at_samples > 0:
        envelope[:at_samples] = np.linspace(0, 1, at_samples)
    if re_samples > 0:
        envelope[-re_samples:] = np.linspace(1, 0, re_samples)
    
    audio *= envelope
    
    # Convert to 16-bit PCM
    return (audio * 32767).astype(np.int16).tobytes()


def generate_sweep(
    start_freq: float,
    end_freq: float,
    duration_ms: int,
    sample_rate: int,
    volume: float = 0.5,
    attack_ms: int = 10,
    release_ms: int = 10
) -> bytes:
    """Generate a frequency sweep (chirp)."""
    t = np.linspace(0, duration_ms / 1000.0, int(sample_rate * duration_ms / 1000.0), endpoint=False)
    
    # Linear frequency sweep
    audio = np.sin(2 * np.pi * (start_freq + (end_freq - start_freq) * t / (2 * (duration_ms / 1000.0))) * t)
    audio *= volume

    # Envelope
    num_samples = len(t)
    at_samples = int(min(num_samples // 2, sample_rate * attack_ms / 1000.0))
    re_samples = int(min(num_samples // 2, sample_rate * release_ms / 1000.0))

    envelope = np.ones(num_samples)
    if at_samples > 0:
        envelope[:at_samples] = np.linspace(0, 1, at_samples)
    if re_samples > 0:
        envelope[-re_samples:] = np.linspace(1, 0, re_samples)
    
    audio *= envelope
    return (audio * 32767).astype(np.int16).tobytes()


def generate_beep(frequency: float, duration_ms: int, sample_rate: int, volume: float = 0.5) -> bytes:
    """Legacy wrapper for backward compatibility."""
    return generate_tone(frequency, duration_ms, sample_rate, volume=volume)


def get_start_sound(sample_rate: int) -> bytes:
    """A stylish "power up" or "listening" sound."""
    # A short upward sweep + a soft chime
    sweep = generate_sweep(440, 880, 150, sample_rate, volume=0.3)
    tone = generate_tone(880, 100, sample_rate, waveform="sine", volume=0.4, attack_ms=10, release_ms=80)
    return sweep + tone


def get_end_sound(sample_rate: int) -> bytes:
    """A stylish "power down" or "closing" sound."""
    # A downward sweep + a soft low tone
    sweep = generate_sweep(880, 440, 200, sample_rate, volume=0.3)
    tone = generate_tone(440, 150, sample_rate, waveform="sine", volume=0.4, attack_ms=20, release_ms=100)
    return sweep + tone


def get_tool_sound(sample_rate: int) -> bytes:
    """A subtle, minimalist tool use sound."""
    # A very short, soft 'blip'
    return generate_tone(1200, 40, sample_rate, waveform="sine", volume=0.15, attack_ms=5, release_ms=20)
