// 지금 올라와 있는 테이블의 목록·컬럼·타입·행 수와, «내가 올린 파일»로 만든(또는 바꾼) 테이블 기록.
// 읽기는 모두 runSql(읽기 전용 검사 포함)을 거친다.
import { BASE_TABLES } from "./db.js";
import { runSql } from "./runner.js";

export const TABLES_CHANGED = "tables-changed";

const uploads = new Map(); // 소문자 테이블 이름 -> { name, file, loadedAt, replaced, renamed[] }

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

export const isUploaded = (name) => uploads.has(String(name).toLowerCase());
export const uploadInfo = (name) => uploads.get(String(name).toLowerCase());

/** 올리기가 끝나면 부른다. 화면들이 이 이벤트로 목록을 다시 그린다. */
export function recordUpload(info) {
  uploads.set(info.name.toLowerCase(), info);
  window.dispatchEvent(new CustomEvent(TABLES_CHANGED, { detail: { tables: [info.name.toLowerCase()] } }));
}

/** [{ name, origin: "base" | "upload", rowCount, columns: [{ name, type }], file?, loadedAt?, replaced? }] */
export async function listTableInfo() {
  const cols = await runSql(
    `SELECT table_name, column_name, data_type FROM information_schema.columns ` +
    `WHERE table_schema = 'main' ORDER BY table_name, ordinal_position`,
    { maxRows: 20000 },
  );
  const byTable = new Map();
  for (const [t, c, ty] of cols.rows) {
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t).push({ name: c, type: ty });
  }
  const out = [];
  for (const [name, columns] of byTable) {
    const n = (await runSql(`SELECT COUNT(*) AS n FROM ${q(name)}`)).rows[0][0];
    const up = uploadInfo(name);
    out.push({
      name, columns, rowCount: n,
      origin: up ? "upload" : "base",
      ...(up ? { file: up.file, loadedAt: up.loadedAt, replaced: up.replaced } : {}),
    });
  }
  const order = (n) => { const i = BASE_TABLES.indexOf(n.toLowerCase()); return i < 0 ? 99 : i; };
  return out.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
}

/**
 * AI 에 보내는 «올린 테이블 설명»: 이름 · 컬럼 이름 · 타입 · 행 수만. 값은 보내지 않는다(컬럼 뜻도 없다).
 * 올린 파일로 만들었거나 바꾼 테이블만 담는다(기본 테이블 설명은 서버의 schema.json 이 맡는다).
 */
export async function describeUploadsForAi() {
  if (!uploads.size) return [];
  const info = await listTableInfo();
  return info
    .filter((t) => t.origin === "upload")
    .map((t) => ({ name: t.name, row_count: t.rowCount, columns: t.columns.map((c) => ({ name: c.name, type: c.type })) }));
}
