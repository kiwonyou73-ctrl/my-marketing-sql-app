// DuckDB-WASM 기동과 기본 CSV 5개 적재. 데이터는 이 브라우저 안에서만 읽는다.
// rawQuery 는 검사 없이 실행하므로 app/runner.js 만 가져다 쓴다(앱의 SQL 실행 통로는 runner.runSql 하나).
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

export const BASE_TABLES = ["campaigns", "ad_spend_daily", "users", "coupons", "orders"];

let readyPromise = null;
let db = null;
let conn = null;

async function boot(onProgress) {
  onProgress?.("DuckDB 불러오는 중…");
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  // 다른 주소의 워커는 바로 만들 수 없어서 Blob 으로 감싸 불러온다
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
  );
  const worker = new Worker(workerUrl);
  db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await db.connect();

  for (const t of BASE_TABLES) {
    onProgress?.(`데이터 불러오는 중… ${t}`);
    const res = await fetch(new URL(`../data/${t}.csv`, import.meta.url)); // 페이지 위치와 무관하게 app/ 기준
    if (!res.ok) throw new Error(`data/${t}.csv 를 불러오지 못했습니다 (${res.status})`);
    await db.registerFileBuffer(`${t}.csv`, new Uint8Array(await res.arrayBuffer()));
    await conn.query(`CREATE OR REPLACE TABLE "${t}" AS SELECT * FROM read_csv('${t}.csv')`);
  }
  return conn;
}

// 여러 번 불러도 한 번만 기동한다.
export function initDb(onProgress) {
  if (!readyPromise) readyPromise = boot(onProgress);
  return readyPromise;
}

// 검사 없이 실행. runner.js 전용.
export async function rawQuery(sql) {
  const c = await initDb();
  return c.query(sql);
}

// 지금 올라와 있는 테이블 이름(소문자)
export async function listTables() {
  return (await listTableNames()).map((n) => n.toLowerCase());
}

// 지금 올라와 있는 테이블 이름(만든 그대로의 대소문자)
export async function listTableNames() {
  const t = await rawQuery("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'");
  return t.toArray().map((r) => String(r.table_name));
}

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;
const quoteLit = (s) => `'${String(s).replace(/'/g, "''")}'`;
let uploadSeq = 0;

/**
 * 올린 CSV 바이트를 테이블로 만든다(같은 이름이 있으면 바꾼다). 사용자 SQL 이 아니라 앱이 만든 문장이다.
 * names 는 컬럼 이름(공백을 정리한 것), delimiter 는 구분 문자. 파일은 브라우저 메모리 안에서만 읽고, 끝나면 지운다.
 */
export async function loadCsvBytes(tableName, bytes, { delimiter, names }) {
  const c = await initDb();
  const fname = `upload_${++uploadSeq}.csv`;
  await db.registerFileBuffer(fname, bytes);
  try {
    await c.query(
      `CREATE OR REPLACE TABLE ${quoteIdent(tableName)} AS SELECT * FROM read_csv('${fname}', ` +
      `header = true, delim = ${quoteLit(delimiter)}, quote = '"', sample_size = -1, ` +
      `names = [${names.map(quoteLit).join(", ")}])`
    );
  } finally {
    await db.dropFile(fname);
  }
}
