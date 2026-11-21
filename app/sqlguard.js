// 읽기 전용 SQL 검사 (lib/sql_guard.py 와 같은 규칙. tests/guard_cases.json 으로 둘을 함께 시험한다).
// 이 파일은 순수 함수만 둔다. DuckDB 로 SELECT 문인지 한 번 더 확인하는 층은 runner.js 에 있다.

const FORBIDDEN_WORDS = [
  "insert", "update", "delete", "drop", "create", "alter", "truncate",
  "copy", "attach", "detach", "install", "load", "export", "import",
  "pragma", "call", "merge", "vacuum", "checkpoint", "grant", "revoke",
  "set", "reset", "use", "begin", "commit", "rollback", "execute",
];
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN_WORDS.join("|")})\\b`);
const READ_FUNC_RE = /\b(read_[a-z0-9_]*|[a-z0-9_]*_scan|glob|sniff_csv|query|query_table|getenv|current_setting)\s*\(/;
const FROM_STRING_RE = /\b(from|join)\s*\(*\s*''/;

/**
 * 주석은 지우고 작은따옴표 문자열·$$ 문자열은 내용을 비운다.
 * 큰따옴표 식별자는 기본으로 내용을 비우고, keepIdentifiers 면 그대로 둔다(테이블 이름을 읽을 때).
 * 닫히지 않은 따옴표·주석이면 { error } 를 돌려준다.
 */
export function maskSql(sql, { keepIdentifiers = false } = {}) {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const nxt = i + 1 < n ? sql[i + 1] : "";
    if (ch === "-" && nxt === "-") {
      const j = sql.indexOf("\n", i);
      i = j === -1 ? n : j;
      out += " ";
    } else if (ch === "/" && nxt === "*") {
      const j = sql.indexOf("*/", i + 2);
      if (j === -1) return { text: null, error: "닫히지 않은 주석(/*)이 있습니다." };
      i = j + 2;
      out += " ";
    } else if (ch === "'" || ch === '"') {
      const q = ch;
      const start = i;
      i += 1;
      for (;;) {
        if (i >= n) return { text: null, error: "닫히지 않은 따옴표가 있습니다." };
        if (sql[i] === q) {
          if (i + 1 < n && sql[i + 1] === q) { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      out += q === '"' && keepIdentifiers ? sql.slice(start, i) : q + q;
    } else if (ch === "$" && nxt === "$") {
      const j = sql.indexOf("$$", i + 2);
      if (j === -1) return { text: null, error: "닫히지 않은 $$ 문자열이 있습니다." };
      i = j + 2;
      out += "''";
    } else {
      out += ch;
      i += 1;
    }
  }
  return { text: out, error: null };
}

/** { ok, reason } — ok 이면 실행해도 된다. */
export function checkLexical(sql) {
  if (typeof sql !== "string" || !sql.trim()) return { ok: false, reason: "SQL이 비어 있습니다." };
  const { text: masked, error } = maskSql(sql);
  if (error) return { ok: false, reason: error };
  let text = masked.trim().toLowerCase();
  while (text.endsWith(";")) text = text.slice(0, -1).trimEnd();
  if (!text) return { ok: false, reason: "SQL이 비어 있습니다." };
  if (text.includes(";")) return { ok: false, reason: "문장은 하나만 실행할 수 있습니다(세미콜론으로 이어진 여러 문장 불가)." };
  const first = /^[a-z_]+/.exec(text);
  if (!first || (first[0] !== "select" && first[0] !== "with")) {
    return { ok: false, reason: "읽기(SELECT · WITH)만 실행할 수 있습니다." };
  }
  let m = FORBIDDEN_RE.exec(text);
  if (m) return { ok: false, reason: `쓰기·설정 명령은 실행할 수 없습니다: ${m[1].toUpperCase()}` };
  m = READ_FUNC_RE.exec(text);
  if (m) return { ok: false, reason: `파일·외부 읽기 함수는 쓸 수 없습니다: ${m[1]}()` };
  if (FROM_STRING_RE.test(text)) return { ok: false, reason: "FROM 뒤에 파일 경로(문자열)를 직접 쓸 수 없습니다." };
  return { ok: true, reason: "" };
}

const AGG_RE = /\b(count|sum|avg|min|max|median|mode|stddev\w*|variance|var_\w+|string_agg|group_concat|list|array_agg|any_value|first|last|arg_min|arg_max|approx_\w+|bool_and|bool_or|quantile\w*|corr|covar_\w+)\s*\(/;

/**
 * 결과가 «집계 결과»로 보이는가. GROUP BY 가 있거나 집계 함수를 쓰면 true.
 * 윈도 함수(OVER)만 있고 GROUP BY 가 없으면 행이 그대로 남으므로 false. AI 로 행을 보낼지 정할 때만 쓴다.
 */
export function isAggregateSql(sql) {
  const { text } = maskSql(sql);
  if (text == null) return false;
  const t = text.toLowerCase();
  if (/\bgroup\s+by\b/.test(t)) return true;
  if (/\bover\s*\(/.test(t)) return false;
  return AGG_RE.test(t);
}

/**
 * SQL 이 읽는 테이블 이름(소문자). CTE 이름과 FROM (서브쿼리)·테이블 함수는 뺀다.
 * 쉼표로 이어 쓴 FROM a, b 는 읽지 못한다(그러면 «확인 필요»로 표시될 수 있다).
 */
export function tablesInSql(sql) {
  const { text } = maskSql(sql, { keepIdentifiers: true });
  if (text == null) return [];
  const ident = '(?:"(?:[^"]|"")+"|[A-Za-z_\\u00C0-\\uFFFF][\\w\\u00C0-\\uFFFF$]*)';
  const clean = (s) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s).toLowerCase();

  const ctes = new Set();
  const cteRe = new RegExp(`(?:\\bwith\\s+(?:recursive\\s+)?|,\\s*)(${ident})\\s*(?:\\([^)]*\\)\\s*)?as\\s*(?:not\\s+materialized\\s*|materialized\\s*)?\\(`, "gi");
  for (let m; (m = cteRe.exec(text)); ) ctes.add(clean(m[1]));

  const found = new Set();
  const fromRe = new RegExp(`\\b(from|join)\\s+(${ident})(?:\\s*\\.\\s*(${ident}))?(\\s*\\()?`, "gi");
  for (let m; (m = fromRe.exec(text)); ) {
    if (m[4]) continue; // 테이블 함수: from generate_series(...)
    if (m[1].toLowerCase() === "from" && isNotTableFrom(text, m.index)) continue;
    const name = clean(m[3] || m[2]);
    if (!ctes.has(name)) found.add(name);
  }
  return [...found];
}

// EXTRACT(month FROM col) · SUBSTRING(s FROM 2) · TRIM(x FROM s) · IS DISTINCT FROM 의 FROM 은 테이블이 아니다.
function isNotTableFrom(text, idx) {
  if (/\bdistinct\s*$/i.test(text.slice(0, idx))) return true;
  let depth = 0;
  for (let k = idx - 1; k >= 0; k--) {
    const c = text[k];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) return /\b(extract|substring|trim|overlay|position)\s*$/i.test(text.slice(0, k));
      depth--;
    }
  }
  return false;
}
