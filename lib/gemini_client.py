"""Gemini REST 호출 공통 (표준 라이브러리만).

키는 환경 변수 GEMINI_API_KEY, 모델은 GEMINI_MODEL (없으면 gemini-3.5-flash-lite).
키는 URL이 아니라 헤더로 보내고, 오류 메시지에 키가 섞이면 가린다.
"""
import json
import os
import urllib.error
import urllib.request

DEFAULT_MODEL = "gemini-3.5-flash-lite"
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
TIMEOUT_SEC = 40


class GeminiError(Exception):
    """사용자에게 그대로 보여 줘도 되는 한국어 메시지를 담는다. status 는 응답 코드."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def model_name():
    return os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL


def _redact(text, key):
    return text.replace(key, "***") if key else text


def generate_json(system_text, user_text, response_schema):
    """시스템 지시 + 사용자 글을 보내고, JSON 으로 받은 답(dict)을 돌려준다."""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise GeminiError("GEMINI_API_KEY 가 설정되어 있지 않습니다. .env 파일(또는 Vercel 환경 변수)에 넣어 주세요.", 503)

    body = {
        "systemInstruction": {"parts": [{"text": system_text}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": response_schema,
        },
    }
    req = urllib.request.Request(
        ENDPOINT.format(model=model_name()),
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode("utf-8")).get("error", {}).get("message", "")
        except Exception:
            pass
        detail = _redact(detail, key)[:300]
        if e.code in (400, 403) and "key" in detail.lower():
            raise GeminiError("Gemini 키가 올바르지 않거나 권한이 없습니다. GEMINI_API_KEY 를 확인해 주세요.", 502)
        if e.code == 404:
            raise GeminiError(f"모델 '{model_name()}' 을 찾을 수 없습니다. GEMINI_MODEL 을 확인해 주세요.", 502)
        if e.code == 429:
            raise GeminiError("Gemini 호출 한도를 넘었습니다. 잠시 뒤 다시 시도해 주세요.", 429)
        raise GeminiError(f"Gemini 호출 실패({e.code}): {detail}")
    except (urllib.error.URLError, TimeoutError) as e:
        raise GeminiError(f"Gemini 에 연결하지 못했습니다: {_redact(str(getattr(e, 'reason', e)), key)}")

    try:
        text = payload["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        reason = (payload.get("promptFeedback") or {}).get("blockReason", "")
        raise GeminiError("Gemini 가 답을 주지 않았습니다." + (f" (차단 사유: {reason})" if reason else ""))
    text = text.strip()
    if text.startswith("```"):  # 코드 펜스로 감싼 경우
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    try:
        out = json.loads(text)
    except json.JSONDecodeError:
        raise GeminiError("Gemini 의 답이 JSON 형식이 아닙니다. 다시 시도해 주세요.")
    if not isinstance(out, dict):
        raise GeminiError("Gemini 의 답 형식이 예상과 다릅니다.")
    return out
