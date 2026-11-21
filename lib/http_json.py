"""JSON 요청 · 응답 공통 코드 (표준 라이브러리만).

api/*.py 의 `class handler(BaseHTTPRequestHandler)` 가 이 함수들을 부른다.
(Vercel 은 각 파일에 `class handler(BaseHTTPRequestHandler)` 가 소스에 그대로 적혀 있어야 함수로 인식한다.)
"""
import json

MAX_BODY = 1_000_000


def send_json(h, status, obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    h.send_response(status)
    h.send_header("Content-Type", "application/json; charset=utf-8")
    h.send_header("Content-Length", str(len(data)))
    h.send_header("Cache-Control", "no-store")
    h.end_headers()
    h.wfile.write(data)


def serve_post(h, handle):
    """요청 본문(JSON)을 읽어 handle(body) -> (status, dict) 를 부르고 JSON 으로 답한다."""
    try:
        length = int(h.headers.get("Content-Length") or 0)
    except ValueError:
        return send_json(h, 400, {"error": "Content-Length 가 올바르지 않습니다."})
    if length > MAX_BODY:
        return send_json(h, 413, {"error": "요청이 너무 큽니다."})
    try:
        body = json.loads(h.rfile.read(length) or b"{}")
    except json.JSONDecodeError:
        return send_json(h, 400, {"error": "JSON 형식이 아닙니다."})
    try:
        status, obj = handle(body)
    except Exception as e:
        status, obj = 500, {"error": f"서버 오류: {e}"}
    send_json(h, status, obj)


def serve_not_post(h):
    send_json(h, 405, {"error": "POST 로 호출하세요."})
