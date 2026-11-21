// /api 호출. AI 로 보내는 내용은 여기서만 만든다.
// 보내는 것: 질문 · SQL · 결과 행(집계 결과일 때만, 최대 50행). 테이블 설명(schema.json)은 서버가 붙인다.
// 보내지 않는 것: 원본 행. 집계로 보이지 않거나 고객·주문 번호 열이 있으면 행은 빼고 열 이름만 보낸다.
import { isAggregateSql } from "./sqlguard.js";
import { describeUploadsForAi } from "./catalog.js";

export const MAX_AI_ROWS = 50;

async function post(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("서버에 연결하지 못했습니다. tools/serve.py 가 실행 중인지 확인해 주세요.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* JSON 이 아닌 응답 */ }
  if (!res.ok) throw new Error((data && data.error) || `요청 실패 (${res.status})`);
  return data;
}

// 질문 -> { sql, interpretation, blocked: null | { reason } }
// extra_tables: 내가 올린 파일로 만들었거나 바꾼 테이블의 이름 · 컬럼 이름 · 타입 · 행 수(값은 없음)
export async function askSql(question) {
  return post("/api/sql", { question, extra_tables: await describeUploadsForAi() });
}

/**
 * 결과를 AI 로 보낼 모양으로 줄인다. { columns, rows, row_count, rows_note }
 * rows 는 최대 MAX_AI_ROWS 행. 보내면 안 되는 결과면 rows 는 빈 배열이고 rows_note 에 이유가 있다.
 */
export function prepareResultForAi(result, sql) {
  const columns = result.columns;
  const rowCount = result.rows.length;
  let withheld = "";
  if (!isAggregateSql(sql)) withheld = "집계 결과가 아니라서 행은 보내지 않았다.";
  else if (columns.some((c) => /(user_id|order_id)$/i.test(c))) withheld = "고객·주문 번호 열이 있어 행은 보내지 않았다.";
  if (withheld) return { columns, rows: [], row_count: rowCount, rows_note: withheld };
  const note = rowCount > MAX_AI_ROWS ? `행이 많아 앞의 ${MAX_AI_ROWS}행만 보냈다.` : "";
  return { columns, rows: result.rows.slice(0, MAX_AI_ROWS), row_count: rowCount, rows_note: note };
}

// 질문 · SQL · 결과 -> { basis: {tables, conditions, metrics[]}, drill: {sql, reason, measure_column, label_columns, blocked} }
export async function askWhy(question, sql, result) {
  return post("/api/why", { question, sql, ...prepareResultForAi(result, sql), extra_tables: await describeUploadsForAi() });
}
