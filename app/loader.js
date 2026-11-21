// 내 파일 올리기: CSV(UTF-8, BOM 무시)와 xlsx(첫 시트, 첫 행 = 컬럼 이름)를 읽어 테이블로 만든다.
// 올린 파일은 이 브라우저 안에서만 읽는다(서버로 보내지 않는다). 새로고침하면 사라진다.
import { listTableNames, loadCsvBytes } from "./db.js";
import { listTableInfo, recordUpload } from "./catalog.js";
import { runSql } from "./runner.js";

// xlsx 읽기 도구(SheetJS). CDN 주소에 버전을 고정하고, xlsx 를 처음 올릴 때만 불러온다.
const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
let sheetjsPromise = null;
const loadSheetJs = () => (sheetjsPromise ??= import(SHEETJS_URL).catch((e) => {
  sheetjsPromise = null;
  throw new Error(`xlsx 읽기 도구를 불러오지 못했습니다(인터넷 연결을 확인해 주세요): ${e.message}`);
}));

export const PREVIEW_ROWS = 20;

// ---------- 이름 정리 ----------

/** 파일 이름(확장자 뺀 것) -> 테이블 이름. 글자·숫자·밑줄만 남기고 나머지는 밑줄. */
export function sanitizeTableName(fileName) {
  const base = String(fileName).replace(/\.(csv|xlsx)$/i, "");
  let name = base.normalize("NFC").replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "");
  if (!name) name = "table";
  if (/^\d/.test(name)) name = `_${name}`;
  return { name, changed: name !== base };
}

/** 컬럼 이름 정리: 공백은 밑줄로, 빈 이름은 column<번호>, 겹치면 _2 _3. 반환 { names, changes: [{ from, to, why }] } */
export function sanitizeColumns(raw) {
  const names = [];
  const changes = [];
  const seen = new Set();
  raw.forEach((r, i) => {
    const from = String(r ?? "");
    let to = from.trim().replace(/\s+/g, "_");
    let why = to !== from ? "공백을 밑줄로 바꿨습니다" : "";
    if (!to) { to = `column${i + 1}`; why = "이름이 비어 있어 번호를 붙였습니다"; }
    let unique = to, k = 2;
    while (seen.has(unique.toLowerCase())) unique = `${to}_${k++}`;
    if (unique !== to) { to = unique; why = why ? `${why}, 같은 이름이 있어 번호를 붙였습니다` : "같은 이름이 있어 번호를 붙였습니다"; }
    seen.add(to.toLowerCase());
    names.push(to);
    if (to !== from) changes.push({ from, to, why });
  });
  return { names, changes };
}

// ---------- CSV ----------

/** UTF-8 로만 읽는다(앞의 BOM 은 무시). UTF-8 이 아니면 오류. */
export function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new Error("UTF-8 로 읽을 수 없는 파일입니다. 엑셀에서 «CSV UTF-8»로 저장하거나 xlsx 로 올려 주세요.");
  }
}

/** 첫 줄에서 구분 문자(쉼표 · 세미콜론 · 탭 · 파이프)를 고른다. */
export function detectDelimiter(text) {
  const counts = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  let inQuote = false;
  for (let i = 0; i < text.length && i < 20000; i++) {
    const ch = text[i];
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && (ch === "\n" || ch === "\r")) break;
    else if (!inQuote && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ",";
}

/**
 * CSV 를 직접 읽어 첫 줄(컬럼 이름)과 데이터 행 수를 센다. 큰따옴표 안의 쉼표·줄바꿈을 처리하고, 완전히 빈 줄은 세지 않는다.
 * DuckDB 가 센 행 수와 따로 비교하려고 DuckDB 와 별개로 구현했다.
 * 반환 { header: string[], rowCount }
 */
export function scanCsv(text, delimiter = ",") {
  let header = null;
  let rowCount = 0;
  let field = "";
  let record = [];
  let inQuote = false;
  let fieldWasQuoted = false;

  const endField = () => { record.push(field); field = ""; fieldWasQuoted = false; };
  const endRecord = () => {
    const quoted = fieldWasQuoted;
    endField();
    const empty = record.length === 1 && record[0] === "" && !quoted;
    if (!empty) {
      if (header === null) header = record; else rowCount++;
    }
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuote = false;
      } else field += ch;
    } else if (ch === '"' && field === "") { inQuote = true; fieldWasQuoted = true; }
    else if (ch === delimiter) endField();
    else if (ch === "\n") endRecord();
    else if (ch === "\r") { if (text[i + 1] === "\n") i++; endRecord(); }
    else field += ch;
  }
  if (field !== "" || record.length) endRecord();
  return { header: header ?? [], rowCount };
}

// ---------- xlsx ----------

/** xlsx 바이트 -> { csvText, fileRows, sheetName, sheetCount }. 첫 시트의 첫 행을 컬럼 이름으로 본다. 날짜는 yyyy-mm-dd. */
export async function xlsxToCsv(bytes) {
  const XLSX = await loadSheetJs();
  let wb;
  try {
    wb = XLSX.read(bytes, { type: "array", cellDates: true });
  } catch (e) {
    throw new Error(`xlsx 파일을 읽지 못했습니다: ${e.message}`);
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("시트가 없는 xlsx 입니다.");
  const ws = wb.Sheets[sheetName];

  // 시각이 들어 있는 날짜 셀이 하나라도 있으면 날짜+시각으로, 아니면 날짜만 쓴다
  let hasTime = false;
  for (const key of Object.keys(ws)) {
    if (key[0] === "!") continue;
    const cell = ws[key];
    if (cell && cell.t === "d" && cell.v instanceof Date && (cell.v.getUTCHours() || cell.v.getUTCMinutes() || cell.v.getUTCSeconds())) { hasTime = true; break; }
  }
  const dateNF = hasTime ? "yyyy-mm-dd hh:mm:ss" : "yyyy-mm-dd";
  const csvText = XLSX.utils.sheet_to_csv(ws, { FS: ",", RS: "\n", blankrows: false, dateNF, rawNumbers: true });
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: true, defval: null });
  return { csvText, fileRows: Math.max(grid.length - 1, 0), sheetName, sheetCount: wb.SheetNames.length };
}

/** 바꾸기 전과 후의 컬럼 이름 비교. 같으면 null, 다르면 { removed, added } (대소문자는 구분하지 않는다) */
export function diffColumns(oldNames, newNames) {
  const o = new Set(oldNames.map((n) => n.toLowerCase()));
  const n = new Set(newNames.map((x) => x.toLowerCase()));
  const removed = oldNames.filter((x) => !n.has(x.toLowerCase()));
  const added = newNames.filter((x) => !o.has(x.toLowerCase()));
  return removed.length || added.length ? { removed, added } : null;
}

/** DuckDB 의 오류를 사람이 고칠 수 있는 안내로 바꾼다(원문 첫 줄을 덧붙인다). */
export function explainLoadError(e) {
  const first = String(e.message).split("\n")[0];
  if (/sniff|dialect|delimiter|Error when sniffing/i.test(first)) {
    return `테이블로 올리지 못했습니다: CSV 형식을 읽지 못했습니다. 빈 칸만 있는 줄 · 열 수가 다른 줄 · 닫히지 않은 따옴표가 있는지 확인해 주세요. (${first})`;
  }
  if (/Could not convert|Conversion Error/i.test(first)) {
    return `테이블로 올리지 못했습니다: 값을 컬럼 타입으로 바꾸지 못했습니다. (${first})`;
  }
  return `테이블로 올리지 못했습니다: ${first}`;
}

// ---------- 올리기 ----------

/**
 * 파일 하나를 읽어 테이블로 올린다.
 * 반환 report: { fileName, tableName, tableNameChanged, replaced, columnChanges, fileRows, tableRows, match,
 *               columns: [{ name, type }], preview: { columns, rows }, sheet?: { name, count } }
 * 읽을 수 없으면 Error(한국어 메시지).
 */
export async function importFile(file) {
  const ext = (/\.([^.]+)$/.exec(file.name)?.[1] || "").toLowerCase();
  if (ext !== "csv" && ext !== "xlsx") throw new Error("CSV(.csv)와 엑셀(.xlsx) 파일만 올릴 수 있습니다.");

  const bytes = new Uint8Array(await file.arrayBuffer());
  let csvText, csvBytes, sheet = null, fileRowsFromSheet = null;
  if (ext === "csv") {
    csvText = decodeUtf8(bytes);
    csvBytes = bytes;
  } else {
    const x = await xlsxToCsv(bytes);
    csvText = x.csvText;
    csvBytes = new TextEncoder().encode(x.csvText);
    fileRowsFromSheet = x.fileRows;
    sheet = { name: x.sheetName, count: x.sheetCount };
  }

  const delimiter = ext === "xlsx" ? "," : detectDelimiter(csvText);
  const scan = scanCsv(csvText, delimiter);
  if (!scan.header.length) throw new Error("비어 있는 파일입니다(첫 행에 컬럼 이름이 있어야 합니다).");
  const fileRows = fileRowsFromSheet ?? scan.rowCount;

  const cols = sanitizeColumns(scan.header);
  const t = sanitizeTableName(file.name);
  const existing = (await listTableNames()).find((n) => n.toLowerCase() === t.name.toLowerCase());
  const tableName = existing ?? t.name;

  // 같은 이름의 테이블을 바꾸기 전에, 지금 컬럼을 기억해 둔다(바뀐 컬럼을 알려 주려고)
  const before = existing ? (await listTableInfo()).find((x) => x.name === existing) : null;

  try {
    await loadCsvBytes(tableName, csvBytes, { delimiter, names: cols.names });
  } catch (e) {
    throw new Error(explainLoadError(e));
  }

  const tableRows = (await runSql(`SELECT COUNT(*) AS n FROM "${tableName.replace(/"/g, '""')}"`)).rows[0][0];
  const info = (await listTableInfo()).find((x) => x.name === tableName);
  const columnDiff = before ? diffColumns(before.columns.map((c) => c.name), (info?.columns ?? []).map((c) => c.name)) : null;
  const preview = await runSql(`SELECT * FROM "${tableName.replace(/"/g, '""')}" LIMIT ${PREVIEW_ROWS}`);

  const report = {
    fileName: file.name,
    tableName,
    tableNameChanged: t.changed,
    replaced: Boolean(existing),
    columnChanges: cols.changes,
    columnDiff,
    fileRows,
    tableRows,
    match: fileRows === tableRows,
    columns: info?.columns ?? [],
    preview,
    sheet,
  };
  recordUpload({ name: tableName, file: file.name, loadedAt: new Date().toISOString(), replaced: Boolean(existing), renamed: cols.changes });
  return report;
}
