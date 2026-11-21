"""Vercel용 handler 클래스를 handle(body) -> (status, dict) 에서 만들어 준다.

로컬(tools/serve.py)은 handle 을 직접 부르고, Vercel 은 이 handler 클래스를 쓴다.
"""
import json
from http.server import BaseHTTPRequestHandler

MAX_BODY = 1_000_000


def make_handler(handle):
    class handler(BaseHTTPRequestHandler):
        def _send(self, status, obj):
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return self._send(400, {"error": "Content-Length 가 올바르지 않습니다."})
            if length > MAX_BODY:
                return self._send(413, {"error": "요청이 너무 큽니다."})
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                return self._send(400, {"error": "JSON 형식이 아닙니다."})
            try:
                status, obj = handle(body)
            except Exception as e:
                status, obj = 500, {"error": f"서버 오류: {e}"}
            self._send(status, obj)

        def do_GET(self):
            self._send(405, {"error": "POST 로 호출하세요."})

    return handler
