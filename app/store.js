// 저장한 질문: 이 브라우저(localStorage)에 두고, JSON 파일로 내려받고 가져올 수 있다.
// 저장하기 전에 항상 읽기 전용 검사(runner.guardSql)를 거친다. 가져오는 파일도 마찬가지다.
import { guardSql } from "./runner.js";

const KEY = "marketing-sql-app.saved-questions.v1";
const MAX_NAME = 60;
const MAX_SQL = 20000;
export const CHANGED_EVENT = "saved-questions-changed";

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    throw new Error("이 브라우저에 저장하지 못했습니다(저장 공간을 쓸 수 없는 상태입니다). 대신 «내려받기»로 파일에 남길 수 있습니다.");
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

export const loadSaved = () => read().filter((q) => q && typeof q.name === "string" && typeof q.sql === "string");

async function validate({ name, sql }) {
  if (typeof name !== "string" || !name.trim()) throw new Error("저장할 이름을 입력해 주세요.");
  if (name.trim().length > MAX_NAME) throw new Error(`이름은 ${MAX_NAME}자 이하로 써 주세요.`);
  if (typeof sql !== "string" || !sql.trim()) throw new Error("저장할 SQL 이 비어 있습니다.");
  if (sql.length > MAX_SQL) throw new Error("SQL 이 너무 깁니다.");
  const g = await guardSql(sql);
  if (!g.ok) throw new Error(`읽기 전용 검사에서 막혀 저장하지 않았습니다: ${g.reason}`);
}

function upsert(list, { name, question, sql }) {
  const clean = { name: name.trim(), question: String(question || "").trim(), sql: sql.trim(), saved_at: new Date().toISOString() };
  const i = list.findIndex((q) => q.name === clean.name);
  if (i >= 0) { list[i] = { ...list[i], ...clean }; return true; }
  list.push({ id: newId(), ...clean });
  return false;
}

/** 이름을 붙여 저장. 같은 이름이 있으면 덮어쓴다. 반환: { replaced } */
export async function saveQuestion(q) {
  await validate(q);
  const list = loadSaved();
  const replaced = upsert(list, q);
  write(list);
  return { replaced };
}

export function deleteSaved(id) {
  write(loadSaved().filter((q) => q.id !== id));
}

/** 내려받을 JSON 문자열 */
export function exportJson() {
  const questions = loadSaved().map(({ name, question, sql, saved_at }) => ({ name, question, sql, saved_at }));
  return JSON.stringify({ version: 1, exported_at: new Date().toISOString(), questions }, null, 2);
}

/** 가져오기. 검사에서 막힌 질문은 건너뛴다. 반환: { added, replaced, skipped: [{ name, reason }] } */
export async function importJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("JSON 파일이 아닙니다."); }
  const items = Array.isArray(data) ? data : data && data.questions;
  if (!Array.isArray(items)) throw new Error("질문 목록(questions)을 찾지 못했습니다.");
  const list = loadSaved();
  const out = { added: 0, replaced: 0, skipped: [] };
  for (const it of items) {
    const sql = Array.isArray(it?.sql) ? it.sql.join("\n") : it?.sql;
    try {
      await validate({ name: it?.name, sql });
    } catch (e) {
      out.skipped.push({ name: typeof it?.name === "string" ? it.name : "(이름 없음)", reason: e.message });
      continue;
    }
    if (upsert(list, { name: it.name, question: it.question, sql })) out.replaced++; else out.added++;
  }
  if (out.added || out.replaced) write(list);
  return out;
}
