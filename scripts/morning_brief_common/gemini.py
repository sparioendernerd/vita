from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from typing import Any


class GeminiError(RuntimeError):
    pass


class GeminiClient:
    def __init__(self, api_key: str, text_model: str, tts_model: str) -> None:
        self.api_key = api_key
        self.text_model = text_model
        self.tts_model = tts_model

    def generate_text(self, prompt: str, *, model: str | None = None, response_mime_type: str | None = None) -> str:
        payload: dict[str, Any] = {"contents": [{"parts": [{"text": prompt}]}]}
        if response_mime_type:
            payload["generationConfig"] = {"responseMimeType": response_mime_type}
        body = self._post(model or self.text_model, payload)
        return _extract_text(body)

    def generate_json(self, prompt: str, *, model: str | None = None) -> dict[str, Any]:
        text = self.generate_text(prompt, model=model, response_mime_type="application/json")
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            value = json.loads(_extract_json_object(text))
        if not isinstance(value, dict):
            raise GeminiError("Gemini JSON response was not an object.")
        return value

    def generate_tts(self, prompt: str, *, voice_name: str) -> bytes:
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {
                            "voiceName": voice_name,
                        }
                    }
                },
            },
            "model": self.tts_model,
        }
        body = self._post(self.tts_model, payload)
        try:
            data = body["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
        except (KeyError, IndexError, TypeError) as exc:
            raise GeminiError(f"Gemini TTS response did not include audio data: {body}") from exc
        return base64.b64decode(data)

    def _post(self, model: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        request = urllib.request.Request(
            url=url,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": self.api_key,
            },
            data=json.dumps(payload).encode("utf-8"),
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise GeminiError(f"Gemini request failed ({exc.code}): {detail}") from exc
        except urllib.error.URLError as exc:
            raise GeminiError(f"Gemini request failed: {exc}") from exc


def _extract_text(body: dict[str, Any]) -> str:
    texts: list[str] = []
    for candidate in body.get("candidates", []):
        content = candidate.get("content", {})
        for part in content.get("parts", []):
            text = part.get("text")
            if isinstance(text, str):
                texts.append(text)
    return "\n".join(texts).strip()


def _extract_json_object(value: str) -> str:
    start = value.find("{")
    end = value.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise GeminiError(f"Could not extract JSON object from Gemini response: {value}")
    return value[start : end + 1]
