"""읽기 전용 SQL 검사 (표준 라이브러리만).

check(sql) -> (ok, 이유). SELECT · WITH 한 문장만 통과시킨다.
AI가 쓴 SQL이든 사람이 쓴 SQL이든 실행 직전에 같은 검사를 거친다.
이 검사는 금지 목록 방식이라, 브라우저 쪽은 여기에 DuckDB json_serialize_sql 확인을 더한다.
같은 사례 파일(tests/guard_cases.json)로 두 구현을 함께 시험한다.
"""
import re

# 문장 맨 앞이나 CTE 안에 올 수 있는 쓰기·설정·확장 명령
FORBIDDEN_WORDS = (
    "insert", "update", "delete", "drop", "create", "alter", "truncate",
    "copy", "attach", "detach", "install", "load", "export", "import",
    "pragma", "call", "merge", "vacuum", "checkpoint", "grant", "revoke",
    "set", "reset", "use", "begin", "commit", "rollback", "execute",
)
_FORBIDDEN_RE = re.compile(r"\b(" + "|".join(FORBIDDEN_WORDS) + r")\b")

# 파일 · URL · 환경을 읽거나 SQL 문자열을 실행하는 함수
_READ_FUNC_RE = re.compile(
    r"\b(read_[a-z0-9_]*|[a-z0-9_]*_scan|glob|sniff_csv|query|query_table|getenv|current_setting)\s*\("
)
# FROM '파일.csv' 처럼 문자열을 테이블 자리에 쓰는 형태 (문자열은 아래에서 ''로 가려진다)
_FROM_STRING_RE = re.compile(r"\b(from|join)\s*\(*\s*''")


def _mask(sql: str):
    """주석은 지우고, 작은따옴표 문자열 · 큰따옴표 식별자 · $$ 문자열은 내용을 비운다.
    닫히지 않은 문자열/주석이 있으면 (None, 이유)."""
    out = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if ch == "-" and nxt == "-":  # 한 줄 주석
            j = sql.find("\n", i)
            i = n if j == -1 else j
            out.append(" ")
        elif ch == "/" and nxt == "*":  # 블록 주석
            j = sql.find("*/", i + 2)
            if j == -1:
                return None, "닫히지 않은 주석(/*)이 있습니다."
            i = j + 2
            out.append(" ")
        elif ch in ("'", '"'):  # 문자열 / 식별자 ('' 와 "" 는 따옴표 이스케이프)
            q = ch
            i += 1
            while True:
                if i >= n:
                    return None, "닫히지 않은 따옴표가 있습니다."
                if sql[i] == q:
                    if i + 1 < n and sql[i + 1] == q:
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            out.append(q + q)
        elif ch == "$" and nxt == "$":  # $$ ... $$
            j = sql.find("$$", i + 2)
            if j == -1:
                return None, "닫히지 않은 $$ 문자열이 있습니다."
            i = j + 2
            out.append("''")
        else:
            out.append(ch)
            i += 1
    return "".join(out), None


def check(sql):
    """(True, "") 이면 실행해도 된다. (False, 이유) 이면 실행하지 않는다."""
    if not isinstance(sql, str) or not sql.strip():
        return False, "SQL이 비어 있습니다."
    masked, err = _mask(sql)
    if err:
        return False, err
    text = masked.strip().lower()
    while text.endswith(";"):  # 끝의 세미콜론은 허용
        text = text[:-1].rstrip()
    if not text:
        return False, "SQL이 비어 있습니다."
    if ";" in text:
        return False, "문장은 하나만 실행할 수 있습니다(세미콜론으로 이어진 여러 문장 불가)."
    first = re.match(r"[a-z_]+", text)
    if not first or first.group(0) not in ("select", "with"):
        return False, "읽기(SELECT · WITH)만 실행할 수 있습니다."
    m = _FORBIDDEN_RE.search(text)
    if m:
        return False, f"쓰기·설정 명령은 실행할 수 없습니다: {m.group(1).upper()}"
    m = _READ_FUNC_RE.search(text)
    if m:
        return False, f"파일·외부 읽기 함수는 쓸 수 없습니다: {m.group(1)}()"
    if _FROM_STRING_RE.search(text):
        return False, "FROM 뒤에 파일 경로(문자열)를 직접 쓸 수 없습니다."
    return True, ""
