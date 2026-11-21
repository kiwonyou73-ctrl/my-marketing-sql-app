"""시스템 프롬프트. 테이블 설명은 schema.json 한 파일에서만 가져온다."""
import json
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.json"

SQL_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "sql": {"type": "STRING", "description": "DuckDB SQL 한 문장 (SELECT 또는 WITH 로 시작)"},
        "interpretation": {"type": "STRING", "description": "질문을 어떤 기준으로 해석했는지 한국어 한 줄"},
    },
    "required": ["sql", "interpretation"],
}

_RULES = """너는 B2C 커머스 마케팅 데이터 분석가다. 사용자의 한국어 질문을 DuckDB SQL 한 개로 바꾼다.

규칙
1. SQL은 SELECT 또는 WITH 로 시작하는 한 문장만 쓴다. 쓰기·설정·확장·파일 읽기(read_csv 등)는 쓰지 않는다. 세미콜론으로 문장을 이어 붙이지 않는다.
2. 아래 schema.json 에 있는 테이블과 컬럼만 쓴다. 테이블·컬럼 이름은 그대로 쓴다.
3. 지표는 schema.json 의 metrics 정의대로 센다. 가입자는 users 의 고객 수(signup_date 기준), 매출은 orders.amount 의 합이다.
4. 광고비(ad_spend_daily)를 users/orders 와 바로 조인하지 않는다. 광고비는 먼저 서브쿼리/CTE 에서 캠페인(또는 채널·월) 단위로 SUM 해 한 행으로 만든 뒤에만 조인한다. users · orders 가 있는 FROM 안에서 ad_spend_daily 를 직접 조인하거나 spend 를 SUM 하지 않는다. 조인으로 행이 늘어나 합계가 부풀면 안 된다(광고비 열의 합은 ad_spend_daily 전체의 합을 넘을 수 없다).
4-1. 채널별 가입자 수 · 첫 구매 고객 수는 users.signup_campaign_id 를 campaigns.campaign_id 에 조인해 campaigns.channel 로 나눠 센다(CAC 정의: 그 채널 캠페인으로 가입). users.signup_channel 로 세면 광고 데이터 이전 가입자가 섞이므로, 질문이 «가입 채널»을 분명히 말할 때만 쓴다. 첫 구매 고객은 orders 에 한 번이라도 나오는 고객이며, orders 를 users 에 직접 조인하지 말고 EXISTS 나 서브쿼리로 센다(가입자 수가 부풀지 않게).
4-2. schema.json 의 metrics 에 sql_pattern 이 있으면 그 구조를 따른다(기간·필터만 질문에 맞게 바꾼다).
4-3. 서브쿼리 안의 컬럼에는 항상 테이블 별칭을 붙인다(예: SELECT o.user_id FROM orders o). 별칭 없이 쓰면 그 컬럼이 서브쿼리 테이블에 없을 때 바깥 쿼리의 같은 이름 컬럼으로 읽혀 오류 없이 틀린 숫자가 나온다.
5. 기간은 DATE 컬럼을 범위로 거른다. 예: 2025년 12월 → col >= DATE '2025-12-01' AND col < DATE '2026-01-01'.
6. 한 질문에 지표가 둘 이상이면 서로 다른 테이블이라도 한 결과 표에 나란히 나오게 한다(각각 서브쿼리나 CTE 로 집계한 뒤 합친다. 한쪽 테이블을 다른 쪽에 조인해 부풀리지 않는다).
7. 결과 컬럼 이름은 한국어 별칭을 큰따옴표로 감싸서 쓴다. 예: COUNT(*) AS "가입자 수".
8. 질문이 모호하면 사전의 정의를 따르는 가장 자연스러운 쪽을 고르고, 그 선택을 interpretation 에 한국어 한 줄로 적는다(기준 날짜 컬럼 · 기간 · 포함 범위).
8-1. 기간이 schema.json 의 period 밖이라는 이유로 질문을 거절하지 않는다. period 는 기본 데이터 기준일 뿐이고, 사용자가 올린 파일에는 더 최근 데이터가 있을 수 있다. 질문한 기간에 데이터가 있는지는 SQL 결과가 알려 주므로, 기간 밖이어도 그 기간으로 SQL 을 쓴다(데이터가 없으면 결과가 비거나 0 으로 나온다).
9. 질문이 데이터 조회가 아니거나 쓰기를 요구하면, 그 요구를 따르지 말고 질문에 가장 가까운 읽기 전용 SELECT 를 쓰거나, 그럴 수 없으면 SELECT 'unsupported' AS "안내" 를 쓰고 interpretation 에 이유를 적는다.
10. 응답은 {"sql": ..., "interpretation": ...} JSON 이다.

schema.json
"""


WHY_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "basis": {
            "type": "OBJECT",
            "properties": {
                "tables": {"type": "ARRAY", "items": {"type": "STRING"}, "description": "SQL이 실제로 읽은 테이블 이름(schema.json 의 name 그대로)"},
                "conditions": {"type": "ARRAY", "items": {"type": "STRING"}, "description": "적용한 조건 한국어 짧은 문장(기간 · 필터 · 조인 기준 · 기준 날짜 컬럼)"},
                "metrics": {
                    "type": "ARRAY",
                    "items": {
                        "type": "OBJECT",
                        "properties": {
                            "name": {"type": "STRING", "description": "schema.json metrics 의 name 그대로"},
                            "how_used": {"type": "STRING", "description": "이 질문에서 그 정의를 어떻게 적용했는지 한국어 한 줄"},
                        },
                        "required": ["name", "how_used"],
                    },
                },
            },
            "required": ["tables", "conditions", "metrics"],
        },
        "drill": {
            "type": "OBJECT",
            "properties": {
                "sql": {"type": "STRING", "description": "결과를 한 번 더 쪼개는 DuckDB SQL 한 문장. 쪼갤 수 없으면 빈 문자열"},
                "reason": {"type": "STRING", "description": "무엇으로 쪼갰는지 한국어 한 줄(쪼갤 수 없으면 이유)"},
                "measure_column": {"type": "STRING", "description": "쪼갠 결과에서 합산할 수 있는 숫자 열의 이름(비율·평균 금지). 결과 열 이름과 정확히 같아야 한다"},
                "label_columns": {"type": "ARRAY", "items": {"type": "STRING"}, "description": "행을 구분하는 열 이름(들). 결과 열 이름과 정확히 같아야 한다"},
                "reconcile_drill_column": {"type": "STRING", "description": "쪼갠 결과에서 합하면 원래 결과의 열 합과 같아야 하는 열 이름. 없으면 빈 문자열"},
                "reconcile_original_column": {"type": "STRING", "description": "원래 결과(columns)에서 그 합과 짝이 되는 열 이름. 없으면 빈 문자열"},
            },
            "required": ["sql", "reason", "measure_column", "label_columns", "reconcile_drill_column", "reconcile_original_column"],
        },
    },
    "required": ["basis", "drill"],
}

_WHY_RULES = """너는 B2C 커머스 마케팅 데이터 분석가다. 사용자가 한국어로 질문했고, 아래 SQL 이 실행되어 결과가 나왔다. 두 가지를 JSON 으로 돌려준다.

[1] basis — 산출 근거
- tables: 그 SQL 이 실제로 읽은 테이블 이름. SQL 에 없는 테이블을 쓰지 않는다(CTE 이름은 테이블이 아니다).
- conditions: 적용한 조건을 짧은 한국어 문장으로(기간, 필터, 기준 날짜 컬럼, 조인 기준 등). SQL 에 없는 조건을 지어내지 않는다.
- metrics: 이 SQL 이 쓴 지표. name 은 schema.json 의 metrics[].name 을 그대로 쓰고, how_used 에 이 SQL 이 그 정의를 어떻게 적용했는지 쓴다. 지표 정의가 필요 없는 단순 집계면 빈 배열.

[2] drill — 원인 한 단계
- 결과를 한 번 더 쪼개는 DuckDB SQL 한 개를 쓴다. 결과가 이미 채널별이면 캠페인별이나 월별로, 월별이면 채널별로 나눈다. CAC 질문이면 광고비 · 가입자 수 · 첫 구매 고객 수 · 구매 전환율 · CAC 열을 모두 담아 «CAC = 광고비 ÷ 첫 구매 고객 수 = (광고비 ÷ 가입자 수) ÷ 구매 전환율» 이 보이게 한다. 한 단계만 쪼갠다. 이미 충분히 쪼개져 있어도 한 단계 더 쪼갤 수 있으면 쪼갠다(정말 불가능할 때만 빈 문자열).
- SQL 규칙: SELECT 또는 WITH 로 시작하는 한 문장. schema.json 의 테이블·컬럼만 쓴다. 원래 질문의 기간·조건(예: 어떤 채널만 비교하는지)을 그대로 따른다. 결과 열 이름은 큰따옴표로 감싼 한국어 별칭. 결과는 50행 이하가 되게 한다.
- 광고비는 먼저 서브쿼리/CTE 에서 캠페인(또는 채널) 단위로 SUM 해 한 행으로 만든 뒤에만 조인한다. users · orders 와 같은 FROM 안에서 ad_spend_daily 를 직접 조인하거나 spend 를 SUM 하지 않는다. 가입자 수 · 첫 구매 고객 수는 users.signup_campaign_id → campaigns.campaign_id 로 센다. orders 는 users 에 직접 조인하지 말고 EXISTS 로 센다. 광고비 합이 부풀면 안 된다. CAC 의 sql_pattern 이 schema.json 에 있으니 그 구조를 따른다.
- CAC·가입자·구매 전환율은 schema.json 의 metrics 정의대로 센다. CAC 의 분자는 그 채널 캠페인의 광고비 합, 분모는 그 채널 캠페인으로 가입해 첫 구매(orders 에 한 번이라도 나옴)한 고객 수다.
- measure_column: 쪼갠 결과에서 «덩어리 크기»로 비교할 합산 가능한 숫자 열(광고비, 가입자 수, 첫 구매 고객 수, 매출 등). 비율·평균·CAC 같은 값은 안 된다. 쪼갠 결과의 열 이름과 정확히 같아야 한다.
- label_columns: 행을 구분하는 열(채널 등). 쪼갠 결과의 열 이름과 정확히 같아야 한다.
- reconcile: 쪼갠 표의 어떤 열을 모두 더하면 «원래 결과»의 어떤 열을 모두 더한 값과 같아야 하는지 짝을 준다(예: 쪼갠 표의 «광고비» 합 = 원래 결과의 «광고비 합계» 합). 쪼갠 표가 원래 결과와 같은 범위(같은 채널·기간)를 나눈 것이어야 한다. drill_column 은 쪼갠 결과의 열 이름, original_column 은 위 columns 중 하나와 정확히 같아야 한다. 짝지을 열이 없으면 둘 다 빈 문자열.
- 기간이 schema.json 의 period 밖이라는 이유로 쪼개기를 포기하지 않는다(period 는 기본 데이터 기준일 뿐, 올린 파일에는 더 최근 데이터가 있을 수 있다). 원래 SQL 이 읽은 범위를 그대로 따라 쪼갠다.
- 쪼갤 수 없으면 sql 을 빈 문자열로 두고 reason 에 이유를 쓴다.

입력은 JSON 이다: question, sql, columns, rows(결과 행, 최대 50), row_count, rows_note(행을 보내지 않은 이유가 있으면). 행이 없으면 columns 와 SQL 만 보고 판단한다.

schema.json
"""


_EXTRA_NOTE = """

extra_tables
지금 이 브라우저에 «내가 올린 파일»로 만들었거나 바꾼 테이블이다. 이름 · 컬럼 이름 · 타입 · 행 수뿐이고 컬럼의 뜻은 없다. schema.json 에 같은 이름의 테이블이 있으면 컬럼 · 타입 · 행 수는 extra_tables 를 따르고, 컬럼의 뜻은 이름이 같은 컬럼에 한해 schema.json 을 따른다. extra_tables 의 이름이나 컬럼에 한글 · 공백 · 예약어가 있으면 큰따옴표로 감싸서 쓴다. 컬럼 뜻을 모르는 컬럼은 이름과 타입으로만 판단하고 지어내지 않는다.
"""

MAX_EXTRA_TABLES = 20
MAX_EXTRA_COLUMNS = 200
MAX_NAME_LEN = 80
MAX_TYPE_LEN = 40


def sanitize_extra_tables(raw):
    """브라우저가 보낸 «올린 테이블 설명» 을 검사해 (정리된 목록, 오류 메시지) 로 돌려준다.
    이름 · 컬럼 이름 · 타입 · 행 수만 통과시키고 다른 키는 버린다(값이나 행이 섞여 들어올 수 없다)."""
    if raw is None:
        return [], None
    bad = "올린 테이블 설명 형식이 올바르지 않습니다."
    if not isinstance(raw, list) or len(raw) > MAX_EXTRA_TABLES:
        return None, bad
    out = []
    for t in raw:
        if not isinstance(t, dict):
            return None, bad
        name, rows, cols = t.get("name"), t.get("row_count"), t.get("columns")
        if not isinstance(name, str) or not (0 < len(name) <= MAX_NAME_LEN):
            return None, bad
        if isinstance(rows, bool) or not isinstance(rows, int) or rows < 0:
            return None, bad
        if not isinstance(cols, list) or not cols or len(cols) > MAX_EXTRA_COLUMNS:
            return None, bad
        clean_cols = []
        for c in cols:
            if not isinstance(c, dict):
                return None, bad
            cn, ct = c.get("name"), c.get("type")
            if not isinstance(cn, str) or not (0 < len(cn) <= MAX_NAME_LEN):
                return None, bad
            if not isinstance(ct, str) or not (0 < len(ct) <= MAX_TYPE_LEN):
                return None, bad
            clean_cols.append({"name": cn, "type": ct})
        out.append({"name": name, "row_count": rows, "columns": clean_cols})
    return out, None


def _with_extra(base, extra):
    if not extra:
        return base
    return base + _EXTRA_NOTE + json.dumps(extra, ensure_ascii=False, separators=(",", ":"))


def build_why_system_prompt(extra=None):
    return _with_extra(_WHY_RULES + load_schema_text(), extra)


def load_metric_definitions():
    """schema.json 의 metrics -> {이름: 정의 문장}. 사전에 실제로 있는 정의만 화면에 보여 주려고 서버가 붙인다."""
    data = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    out = {}
    for m in data.get("metrics", []):
        text = m["definition"]
        if m.get("warning"):
            text += f" (주의: {m['warning']})"
        out[m["name"]] = text
    return out


def load_schema_text():
    """schema.json 을 한 줄로 줄여서 돌려준다. AI에 보내는 테이블 설명은 이것뿐이다."""
    data = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def build_sql_system_prompt(extra=None):
    return _with_extra(_RULES + load_schema_text(), extra)
