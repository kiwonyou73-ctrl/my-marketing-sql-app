"""POST /api/sql  {question} -> {sql, interpretation, blocked}

질문 + schema.json(테이블 설명)만 AI에 보낸다. 데이터 행은 받지도 보내지도 않는다.
받은 SQL은 읽기 전용 검사(lib/sql_guard.py)를 거치고, 막히면 blocked 에 이유를 담는다.
"""
import os
import sys
from http.server import BaseHTTPRequestHandler

# 공통 모듈은 api/ 밖의 lib/ 에 둔다(api/ 안의 .py 는 전부 Vercel 함수가 되기 때문). 로컬 · Vercel 양쪽에서 같은 방식으로 찾는다.
_LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

from gemini_client import GeminiError, generate_json  # noqa: E402
from http_json import serve_not_post, serve_post  # noqa: E402
from prompts import SQL_RESPONSE_SCHEMA, build_sql_system_prompt, sanitize_extra_tables  # noqa: E402
from sql_guard import check  # noqa: E402

MAX_QUESTION = 500


def handle(body):
    question = body.get("question") if isinstance(body, dict) else None
    if not isinstance(question, str) or not question.strip():
        return 400, {"error": "질문을 입력해 주세요."}
    question = question.strip()
    if len(question) > MAX_QUESTION:
        return 400, {"error": f"질문은 {MAX_QUESTION}자 이하로 써 주세요."}

    extra, err = sanitize_extra_tables(body.get("extra_tables"))
    if err:
        return 400, {"error": err}

    try:
        out = generate_json(build_sql_system_prompt(extra), question, SQL_RESPONSE_SCHEMA)
    except GeminiError as e:
        return e.status, {"error": str(e)}

    sql = out.get("sql")
    if not isinstance(sql, str) or not sql.strip():
        return 502, {"error": "AI 가 SQL 을 만들지 못했습니다. 질문을 바꿔 다시 시도해 주세요."}
    sql = sql.strip()
    interpretation = out.get("interpretation") if isinstance(out.get("interpretation"), str) else ""

    ok, reason = check(sql)
    return 200, {
        "sql": sql,
        "interpretation": interpretation.strip(),
        "blocked": None if ok else {"reason": reason},
    }


class handler(BaseHTTPRequestHandler):  # Vercel 은 이 이름(handler)의 클래스를 찾아 함수로 쓴다
    def do_POST(self):
        serve_post(self, handle)

    def do_GET(self):
        serve_not_post(self)
