"""내 PC용 서버: 화면(정적 파일)과 /api/* 를 한 번에 띄운다.

    python tools/serve.py          # http://127.0.0.1:8780
    python tools/serve.py 8080     # 포트 지정

- 표준 라이브러리만 쓴다(설치 없음).
- 키는 프로젝트 루트의 .env 에서 읽는다(GEMINI_API_KEY, GEMINI_MODEL).
- Vercel과 같은 모양: 허용한 경로(index.html, app/, data/, docs/)만 내려주고,
  /api/<이름> 은 api/<이름>.py 의 handle(body) -> (status, dict) 를 호출한다.
"""
import importlib.util
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIRS = ("app", "data", "docs", "presets", "tests")  # 이 폴더 밑만 공개 (tests 는 내 PC 에서만: .vercelignore 로 배포 제외)
MAX_BODY = 1_000_000  # 요청 본문 상한(바이트)
DEFAULT_PORT = 8780

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def load_env(path: Path) -> None:
    """.env 의 KEY=VALUE 를 환경 변수로. 이미 있는 값은 덮어쓰지 않는다."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def resolve_static(url_path: str):
    """URL 경로 -> 공개해도 되는 실제 파일. 아니면 None."""
    rel = unquote(url_path).lstrip("/")
    if rel in ("", "index.html"):
        target = ROOT / "index.html"
    else:
        parts = rel.split("/")
        if parts[0] not in STATIC_DIRS:
            return None
        target = (ROOT / rel).resolve()
        base = (ROOT / parts[0]).resolve()
        if base != target and base not in target.parents:  # ../ 로 빠져나가기 차단
            return None
    return target if target.is_file() else None


def load_api(name: str):
    """api/<name>.py 를 매번 새로 읽는다(고치면 바로 반영). 없으면 None."""
    if not re.fullmatch(r"[a-z][a-z0-9]*", name):  # _로 시작하는 공통 모듈은 호출 불가
        return None
    file = ROOT / "api" / f"{name}.py"
    if not file.is_file():
        return None
    api_dir = str(ROOT / "api")
    if api_dir not in sys.path:
        sys.path.insert(0, api_dir)  # api/_gemini.py 같은 공통 모듈을 import 하려고
    spec = importlib.util.spec_from_file_location(f"api_{name}", file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod if hasattr(mod, "handle") else None


class Handler(BaseHTTPRequestHandler):
    server_version = "LocalServe/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s\n" % (self.address_string(), fmt % args))

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, obj: dict) -> None:
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            return self._json(405, {"error": "POST 로 호출하세요."})
        f = resolve_static(path)
        if f is None:
            return self._send(404, "찾을 수 없습니다.".encode("utf-8"), "text/plain; charset=utf-8")
        self._send(200, f.read_bytes(), MIME.get(f.suffix.lower(), "application/octet-stream"))

    do_HEAD = do_GET

    def do_POST(self):
        path = urlsplit(self.path).path
        if not path.startswith("/api/"):
            return self._json(404, {"error": "찾을 수 없습니다."})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, {"error": "Content-Length 가 올바르지 않습니다."})
        if length > MAX_BODY:
            return self._json(413, {"error": "요청이 너무 큽니다."})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "JSON 형식이 아닙니다."})
        try:
            mod = load_api(path[len("/api/"):].strip("/"))
        except Exception as e:  # api 파일 자체의 오류
            return self._json(500, {"error": f"api 불러오기 실패: {e}"})
        if mod is None:
            return self._json(404, {"error": "없는 api 입니다."})
        try:
            status, obj = mod.handle(body)
        except Exception as e:
            return self._json(500, {"error": f"서버 오류: {e}"})
        self._json(status, obj)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    load_env(ROOT / ".env")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    key = "있음" if os.environ.get("GEMINI_API_KEY") else "없음(.env 에 GEMINI_API_KEY 를 넣으세요)"
    print(f"http://127.0.0.1:{port}  (Ctrl+C 로 종료)", flush=True)
    print(f"GEMINI_API_KEY: {key} / 모델: {os.environ.get('GEMINI_MODEL') or 'gemini-3.5-flash-lite'}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")


if __name__ == "__main__":
    main()
