// 앱에서 SQL 을 실행하는 유일한 통로. AI 가 쓴 SQL · 내가 쓴 SQL · 원인 SQL 모두 runSql 을 거친다.
// 순서: 문자열 검사(sqlguard) -> DuckDB 로 SELECT 문인지 확인 -> 결과 열을 화면용 타입으로 바꿔 실행.
import { rawQuery } from "./db.js";
import { checkLexical } from "./sqlguard.js";

export class SqlBlockedError extends Error {}

const stripSemicolons = (sql) => sql.trim().replace(/;+\s*$/, "");
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** 실행하기 전의 전체 검사. { ok, reason } */
export async function guardSql(sql) {
  const lex = checkLexical(sql);
  if (!lex.ok) return lex;
  // DuckDB 가 SQL 을 SELECT 문 하나로 읽는지 확인한다(json_serialize_sql 은 SELECT 만 직렬화한다).
  try {
    const t = await rawQuery(`SELECT json_serialize_sql(${lit(stripSemicolons(sql))}) AS j`);
    const parsed = JSON.parse(t.toArray()[0].j);
    if (parsed.error) {
      // SELECT 가 아니라는 오류만 막는다. 그 밖의 오류(문법·직렬화 미지원)는 실행 단계의 오류 메시지에 맡긴다.
      if (/only select/i.test(parsed.error_message || "")) {
        return { ok: false, reason: "읽기(SELECT)만 실행할 수 있습니다." };
      }
    } else if ((parsed.statements || []).length !== 1) {
      return { ok: false, reason: "문장은 하나만 실행할 수 있습니다." };
    }
  } catch (e) {
    return { ok: false, reason: `SQL 검사 중 오류: ${e.message}` };
  }
  return { ok: true, reason: "" };
}

// 화면에서 다루기 쉽게: 큰 정수형·날짜·중첩 타입은 열 단위로 바꿔서 받는다.
function displayExpr(name, type) {
  const t = String(type).toUpperCase();
  const col = q(name);
  if (/^(DECIMAL|HUGEINT|UHUGEINT|UBIGINT)/.test(t)) return `CAST(${col} AS DOUBLE) AS ${col}`;
  if (/^(DATE|TIME|TIMESTAMP|INTERVAL|UUID|BLOB|BIT|ENUM|STRUCT|MAP|UNION)/.test(t) || t.includes("[")) {
    return `CAST(${col} AS VARCHAR) AS ${col}`;
  }
  return col;
}

const toPlain = (v) => {
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  return v === undefined ? null : v;
};

/**
 * 검사를 통과한 SQL 만 실행한다.
 * 반환: { columns: string[], rows: any[][], truncated: boolean }  (rows 는 최대 maxRows 개)
 * 검사에서 막히면 SqlBlockedError, 실행 오류는 일반 Error.
 */
export async function runSql(sql, { maxRows = 1000 } = {}) {
  const g = await guardSql(sql);
  if (!g.ok) throw new SqlBlockedError(g.reason);

  const inner = stripSemicolons(sql);
  const desc = (await rawQuery(`DESCRIBE SELECT * FROM (${inner}) AS _q`)).toArray();
  const names = desc.map((r) => String(r.column_name));
  const select = desc.map((r) => displayExpr(r.column_name, r.column_type)).join(", ");
  const table = await rawQuery(`SELECT ${select} FROM (${inner}) AS _q LIMIT ${maxRows + 1}`);

  const cols = names.map((_, i) => table.getChildAt(i));
  const rows = [];
  for (let r = 0; r < table.numRows; r++) rows.push(cols.map((c) => toPlain(c.get(r))));
  const truncated = rows.length > maxRows;
  return { columns: names, rows: truncated ? rows.slice(0, maxRows) : rows, truncated };
}
