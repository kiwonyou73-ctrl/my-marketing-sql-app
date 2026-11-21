"""AI 로 보내는 «올린 테이블 설명» 검사(api/_prompts.py sanitize_extra_tables) 시험.

    python tests/test_extra_tables.py
이름 · 컬럼 이름 · 타입 · 행 수만 통과하고, 값·행이 섞인 요청은 거절되는지 본다.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

from _prompts import build_sql_system_prompt, sanitize_extra_tables  # noqa: E402

GOOD = [{"name": "users", "row_count": 59130, "columns": [{"name": "user_id", "type": "VARCHAR"}, {"name": "signup_date", "type": "DATE"}]}]
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("OK   " if ok else "FAIL ") + name + (f"  → {detail}" if detail else ""))


out, err = sanitize_extra_tables(GOOD)
check("정상 입력 통과", err is None and out == GOOD)
check("없으면(None) 빈 목록", sanitize_extra_tables(None) == ([], None))
check("빈 목록 통과", sanitize_extra_tables([]) == ([], None))

dirty = [{"name": "users", "row_count": 1, "columns": [{"name": "a", "type": "VARCHAR", "sample": "홍길동", "values": ["x"]}],
          "rows": [["U000001", "홍길동"]], "preview": [{"a": "x"}]}]
out, err = sanitize_extra_tables(dirty)
check("이름·컬럼·타입·행 수 말고 다른 키는 버림(값·행이 안 남음)", err is None and "홍길동" not in json.dumps(out, ensure_ascii=False) and "rows" not in out[0] and "sample" not in out[0]["columns"][0], json.dumps(out, ensure_ascii=False))

bad_cases = {
    "목록이 아님": {"name": "x"},
    "표가 21개": [dict(GOOD[0], name=f"t{i}") for i in range(21)],
    "이름 없음": [{"row_count": 1, "columns": [{"name": "a", "type": "INT"}]}],
    "이름이 81자": [dict(GOOD[0], name="x" * 81)],
    "행 수가 음수": [dict(GOOD[0], row_count=-1)],
    "행 수가 bool": [dict(GOOD[0], row_count=True)],
    "행 수가 문자열": [dict(GOOD[0], row_count="10")],
    "컬럼이 없음": [dict(GOOD[0], columns=[])],
    "컬럼이 201개": [dict(GOOD[0], columns=[{"name": f"c{i}", "type": "INT"} for i in range(201)])],
    "컬럼이 문자열": [dict(GOOD[0], columns=["a", "b"])],
    "타입이 41자": [dict(GOOD[0], columns=[{"name": "a", "type": "T" * 41}])],
    "타입이 숫자": [dict(GOOD[0], columns=[{"name": "a", "type": 5}])],
}
for name, raw in bad_cases.items():
    out, err = sanitize_extra_tables(raw)
    check(f"거절: {name}", out is None and bool(err))

p0 = build_sql_system_prompt()
p1 = build_sql_system_prompt(GOOD)
NOTE_HEAD = "\n\nextra_tables\n지금 이 브라우저에"  # 올린 테이블 설명 부분의 머리말
check("올린 테이블이 없으면 프롬프트에 올린 테이블 설명 부분이 없음", NOTE_HEAD not in p0 and '"row_count":59130' not in p0)
check("올린 테이블이 있으면 프롬프트 끝에 이름·컬럼·타입·행 수가 붙음", NOTE_HEAD in p1 and '"row_count":59130' in p1 and p1.startswith(p0))

print(f"\n{sum(results)}/{len(results)} 통과")
sys.exit(0 if all(results) else 1)
