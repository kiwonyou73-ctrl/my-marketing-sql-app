"""POST /api/why  {question, sql, columns, rows, row_count, rows_note} -> {basis, drill}

basis: AI 가 말한 «읽은 테이블 · 조건 · 쓴 지표». 지표는 서버가 schema.json 의 정의 문장을 붙인다(없는 지표는 known=false).
drill: 결과를 한 번 더 쪼개는 SQL (읽기 전용 검사 결과를 blocked 로 함께 준다).

AI 에는 질문 · SQL · 결과 행(최대 50)만 보낸다. 원본 행으로 보이는 입력(user_id · order_id 열에 값이 있는 경우)은 받지 않는다.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _gemini import GeminiError, generate_json  # noqa: E402
from _guard import check  # noqa: E402
from _http import make_handler  # noqa: E402
from _prompts import WHY_RESPONSE_SCHEMA, build_why_system_prompt, load_metric_definitions, sanitize_extra_tables  # noqa: E402

MAX_QUESTION = 500
MAX_SQL = 5000
MAX_ROWS = 50
MAX_COLUMNS = 40
_RAW_ID_COLUMN = re.compile(r"(user_id|order_id)$", re.IGNORECASE)


def _clean_list(value, limit=20, max_len=300):
    if not isinstance(value, list):
        return []
    return [str(v).strip()[:max_len] for v in value if isinstance(v, (str, int, float)) and str(v).strip()][:limit]


def _validate(body):
    """(오류 메시지 | None). 보내도 되는 입력인지 서버에서도 한 번 더 본다."""
    if not isinstance(body, dict):
        return "요청 형식이 올바르지 않습니다."
    q, sql = body.get("question"), body.get("sql")
    if not isinstance(q, str) or not q.strip() or len(q) > MAX_QUESTION:
        return f"질문은 1~{MAX_QUESTION}자여야 합니다."
    if not isinstance(sql, str) or not sql.strip() or len(sql) > MAX_SQL:
        return "SQL 이 비었거나 너무 깁니다."
    ok, reason = check(sql)
    if not ok:
        return f"읽기 전용이 아닌 SQL 은 받지 않습니다: {reason}"
    cols, rows = body.get("columns"), body.get("rows", [])
    if not isinstance(cols, list) or not cols or len(cols) > MAX_COLUMNS or not all(isinstance(c, str) for c in cols):
        return "결과 열 정보가 올바르지 않습니다."
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        return f"결과 행은 {MAX_ROWS}행까지만 받습니다."
    for r in rows:
        if not isinstance(r, list) or len(r) != len(cols) or not all(v is None or isinstance(v, (str, int, float, bool)) for v in r):
            return "결과 행 형식이 올바르지 않습니다."
    if rows and any(_RAW_ID_COLUMN.search(c) for c in cols):
        return "고객·주문 번호가 든 결과 행은 받지 않습니다(집계 결과만 보냅니다)."
    return None


def handle(body):
    err = _validate(body)
    if err:
        return 400, {"error": err}
    extra, err = sanitize_extra_tables(body.get("extra_tables"))
    if err:
        return 400, {"error": err}

    payload = {
        "question": body["question"].strip(),
        "sql": body["sql"].strip(),
        "columns": body["columns"],
        "rows": body.get("rows", []),
        "row_count": body.get("row_count") if isinstance(body.get("row_count"), int) else len(body.get("rows", [])),
        "rows_note": str(body.get("rows_note") or "")[:200],
    }
    try:
        out = generate_json(build_why_system_prompt(extra), json.dumps(payload, ensure_ascii=False), WHY_RESPONSE_SCHEMA)
    except GeminiError as e:
        return e.status, {"error": str(e)}

    ai_basis = out.get("basis") if isinstance(out.get("basis"), dict) else {}
    ai_drill = out.get("drill") if isinstance(out.get("drill"), dict) else {}

    definitions = load_metric_definitions()
    metrics = []
    for m in (ai_basis.get("metrics") or [])[:10]:
        if not isinstance(m, dict):
            continue
        name = str(m.get("name", "")).strip()
        if not name:
            continue
        metrics.append({
            "name": name,
            "how_used": str(m.get("how_used", "")).strip()[:300],
            "known": name in definitions,
            "definition": definitions.get(name),  # 사전 문장(AI 가 쓴 것이 아님)
        })

    drill_sql = ai_drill.get("sql") if isinstance(ai_drill.get("sql"), str) else ""
    drill_sql = drill_sql.strip()
    blocked = None
    if drill_sql:
        ok, reason = check(drill_sql)
        blocked = None if ok else {"reason": reason}

    return 200, {
        "basis": {
            "tables": _clean_list(ai_basis.get("tables"), limit=20, max_len=80),
            "conditions": _clean_list(ai_basis.get("conditions")),
            "metrics": metrics,
        },
        "drill": {
            "sql": drill_sql,
            "reason": str(ai_drill.get("reason", "")).strip()[:300],
            "measure_column": str(ai_drill.get("measure_column", "")).strip()[:100],
            "label_columns": _clean_list(ai_drill.get("label_columns"), limit=5, max_len=100),
            "reconcile": {
                "drill_column": str(ai_drill.get("reconcile_drill_column", "")).strip()[:100],
                "original_column": str(ai_drill.get("reconcile_original_column", "")).strip()[:100],
            },
            "blocked": blocked,
        },
    }


handler = make_handler(handle)
