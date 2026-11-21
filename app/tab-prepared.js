// 준비된 질문 탭: presets/questions.json 의 검증된 질문 + 내가 저장한 질문.
// «다시 계산» 은 지금 올라와 있는 데이터로 SQL 을 실행하고(runner.runSql: 읽기 전용 검사 포함),
// 결과 · 계산한 시각 · 행 수 · 읽은 테이블을 보여 준다.
import { initDb, listTables } from "./db.js";
import { runSql, SqlBlockedError } from "./runner.js";
import { tablesInSql } from "./sqlguard.js";
import { renderTable } from "./table.js";
import { CHANGED_EVENT, deleteSaved, exportJson, importJson, loadSaved } from "./store.js";
import { TABLES_CHANGED } from "./catalog.js";

const panel = document.getElementById("panel-prepared");

panel.insertAdjacentHTML("beforeend", `
  <div class="toolbar">
    <button type="button" class="btn" id="pre-export">저장한 질문 내려받기 (JSON)</button>
    <label class="btn" for="pre-import">저장한 질문 가져오기</label>
    <input type="file" id="pre-import" accept=".json,application/json" hidden>
    <span id="pre-msg" class="muted small" role="status"></span>
  </div>
  <h3 class="list-title">준비된 질문</h3>
  <div id="pre-list" class="cards"><p class="muted">불러오는 중…</p></div>
  <h3 class="list-title">내가 저장한 질문</h3>
  <div id="saved-list" class="cards"></div>
`);

const $ = (s) => panel.querySelector(s);
const preList = $("#pre-list"), savedList = $("#saved-list"), msg = $("#pre-msg");

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let dbReady = false;
const sqlOf = (q) => (Array.isArray(q.sql) ? q.sql.join("\n") : q.sql);

async function recompute(card, q, button) {
  const out = card.querySelector(".card-result");
  button.disabled = true;
  out.replaceChildren(el("p", "muted small", "계산 중…"));
  const sql = sqlOf(q);
  try {
    // 읽는 테이블이 지금 올라와 있는지 먼저 본다
    const tables = tablesInSql(sql);
    const have = await listTables();
    const missing = tables.filter((t) => !have.includes(t));
    if (missing.length) {
      throw new Error(`테이블 «${missing.join(", ")}» 이 지금 올라와 있지 않습니다. «내 파일» 탭에서 올려 주세요.`);
    }
    const res = await runSql(sql);
    const now = new Date();
    out.replaceChildren();
    const meta = el("p", "meta small");
    meta.append(
      el("span", null, `계산한 시각 ${now.toLocaleString("ko-KR", { hour12: false })}`),
      el("span", null, `${res.rows.length.toLocaleString("ko-KR")}행${res.truncated ? " 이상" : ""}`),
      el("span", null, `읽은 테이블 ${tables.join(", ") || "(없음)"}`),
    );
    meta.dataset.computedAt = now.toISOString();
    meta.dataset.rows = String(res.rows.length);
    meta.dataset.tables = tables.join(",");
    out.appendChild(meta);
    const box = el("div");
    out.appendChild(box);
    renderTable(box, res);
    card.dataset.state = "done";
    delete card.dataset.stale;
  } catch (e) {
    const prefix = e instanceof SqlBlockedError ? "실행 차단: " : "";
    out.replaceChildren(el("p", "warn-text", `${prefix}${e.message}`));
    card.dataset.state = e instanceof SqlBlockedError ? "blocked" : "error";
  } finally {
    button.disabled = !dbReady;
  }
}

function renderCard(q, { deletable = false } = {}) {
  const card = el("article", "card");
  card.dataset.id = q.id || "";

  const head = el("div", "card-head");
  head.appendChild(el("h4", null, q.name));
  const actions = el("div", "card-actions");
  const run = el("button", "btn primary", "다시 계산");
  run.type = "button";
  run.disabled = !dbReady;
  run.dataset.role = "recompute";
  run.addEventListener("click", () => recompute(card, q, run));
  actions.appendChild(run);
  if (deletable) {
    const del = el("button", "btn", "삭제");
    del.type = "button";
    del.addEventListener("click", () => {
      if (!confirm(`«${q.name}» 질문을 지울까요?`)) return;
      try { deleteSaved(q.id); } catch (e) { msg.textContent = e.message; }
    });
    actions.appendChild(del);
  }
  head.appendChild(actions);
  card.appendChild(head);

  if (q.question) card.appendChild(el("p", "card-question", q.question));

  if (q.definitions?.length) {
    const det = el("details");
    det.appendChild(el("summary", null, "쓴 지표 정의 (데이터 사전)"));
    const ul = el("ul", "small");
    q.definitions.forEach((d) => {
      const li = el("li");
      li.append(el("strong", null, d.name), ` — ${d.definition}`);
      ul.appendChild(li);
    });
    det.appendChild(ul);
    card.appendChild(det);
  }
  if (q.notes?.length) {
    const ul = el("ul", "small muted card-notes");
    q.notes.forEach((n) => ul.appendChild(el("li", null, n)));
    card.appendChild(ul);
  }

  const sqlDet = el("details");
  sqlDet.append(el("summary", null, "SQL 보기"), el("pre", "sql", sqlOf(q)));
  card.appendChild(sqlDet);

  card.appendChild(el("div", "card-result"));
  return card;
}

function renderSaved() {
  savedList.replaceChildren();
  const list = loadSaved();
  if (!list.length) {
    savedList.appendChild(el("p", "muted small", "아직 없습니다. «묻기» 탭에서 결과가 나온 뒤 이름을 붙여 저장하면 여기에 쌓입니다."));
    return;
  }
  list.forEach((q) => {
    const card = renderCard(q, { deletable: true });
    card.dataset.saved = "1";
    savedList.appendChild(card);
  });
}

async function renderPresets() {
  try {
    const res = await fetch(new URL("../presets/questions.json", import.meta.url));
    if (!res.ok) throw new Error(`presets/questions.json 을 불러오지 못했습니다 (${res.status})`);
    const data = await res.json();
    preList.replaceChildren();
    (data.questions || []).forEach((q) => preList.appendChild(renderCard(q)));
  } catch (e) {
    preList.replaceChildren(el("p", "warn-text", e.message));
  }
}

function setRecomputeEnabled(on) {
  dbReady = on;
  panel.querySelectorAll("[data-role=recompute]").forEach((b) => { b.disabled = !on; });
}

$("#pre-export").addEventListener("click", () => {
  const blob = new Blob([exportJson()], { type: "application/json" });
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = "saved_questions.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  msg.textContent = `저장한 질문 ${loadSaved().length}개를 내려받았습니다.`;
});

$("#pre-import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const r = await importJson(await file.text());
    const skipped = r.skipped.length ? ` · 건너뜀 ${r.skipped.length}개 (${r.skipped.map((s) => `${s.name}: ${s.reason}`).join(" / ")})` : "";
    msg.textContent = `가져왔습니다: 새로 ${r.added}개 · 덮어씀 ${r.replaced}개${skipped}`;
  } catch (err) {
    msg.textContent = `가져오지 못했습니다: ${err.message}`;
  }
});

window.addEventListener(CHANGED_EVENT, renderSaved);

// 파일을 올려 테이블이 바뀌면, 그 테이블을 읽어 계산해 둔 결과에 «이전 데이터로 계산한 것» 표시만 붙인다.
// 자동으로 다시 계산하지 않는다 — «다시 계산»은 내가 누른다.
window.addEventListener(TABLES_CHANGED, (e) => {
  const changed = e.detail?.tables || [];
  panel.querySelectorAll(".card").forEach((card) => {
    const meta = card.querySelector(".meta");
    if (!meta?.dataset.tables || card.querySelector(".stale-note")) return;
    if (!meta.dataset.tables.split(",").some((t) => changed.includes(t))) return;
    meta.after(el("p", "stale-note small", "파일을 올리기 전 데이터로 계산한 결과입니다. «다시 계산»을 누르면 지금 데이터로 바뀝니다."));
    card.dataset.stale = "1";
  });
});

renderPresets();
renderSaved();
initDb().then(() => setRecomputeEnabled(true)).catch(() => { /* 묻기 탭에 오류가 표시된다 */ });
