"""POST /api/sql  {question} -> {sql, interpretation, blocked}

질문 + schema.json(테이블 설명)만 AI에 보낸다. 데이터 행은 받지도 보내지도 않는다.
받은 SQL은 읽기 전용 검사(_guard)를 거치고, 막히면 blocked 에 이유를 담는다.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # 로컬 · Vercel 양쪽에서 공통 모듈 import

from _gemini import GeminiError, generate_json  # noqa: E402
from _guard import check  # noqa: E402
from _http import make_handler  # noqa: E402
from _prompts import SQL_RESPONSE_SCHEMA, build_sql_system_prompt, sanitize_extra_tables  # noqa: E402

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


handler = make_handler(handle)
