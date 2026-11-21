// 묻기 탭: 질문 -> SQL -> 실행 -> 결과 표 -> 왜(① 산출 근거 · ② 원인 한 단계).
// 원인 단계가 실패해도 ①과 원래 결과는 그대로 둔다.
import { askSql, askWhy } from "./api.js";
import { initDb, listTables } from "./db.js";
import { runSql, SqlBlockedError } from "./runner.js";
import { renderTable, fmtNumber } from "./table.js";
import { biggestChunk, crossCheckTables, reconcileTotals } from "./why.js";
import { saveQuestion } from "./store.js";

const panel = document.getElementById("panel-ask");

panel.insertAdjacentHTML("beforeend", `
  <p id="ask-db" class="muted small" role="status">데이터 준비 중…</p>
  <form id="ask-form" class="ask-form">
    <label for="ask-question">질문</label>
    <textarea id="ask-question" rows="3" maxlength="500"
      placeholder="예) 2025년 12월 가입자 수와 매출 알려줘"></textarea>
    <div class="row">
      <button type="submit" id="ask-submit" disabled>묻기</button>
      <span id="ask-status" class="muted" role="status"></span>
    </div>
  </form>
  <div id="ask-result" hidden>
    <p id="ask-interp" class="interp"></p>
    <p id="ask-verdict" class="verdict"></p>
    <details id="ask-sql-box" open><summary>AI 가 쓴 SQL</summary><pre id="ask-sql" class="sql"></pre></details>
    <section id="ask-data" class="block" hidden>
      <h3>결과</h3>
      <div id="ask-table"></div>
      <form id="ask-save" class="row save-row">
        <input id="ask-save-name" type="text" maxlength="60" placeholder="저장할 이름" aria-label="저장할 이름">
        <button type="submit" id="ask-save-btn">이름 붙여 저장</button>
        <span id="ask-save-msg" class="muted small" role="status"></span>
      </form>
    </section>
    <section id="ask-why" class="block" hidden>
      <h3>① 산출 근거</h3>
      <div id="why-basis" class="why-body"></div>
      <h3>② 원인 한 단계</h3>
      <div id="why-drill" class="why-body"></div>
    </section>
  </div>
`);

const $ = (id) => panel.querySelector(id);
const form = $("#ask-form"), input = $("#ask-question"), submit = $("#ask-submit"), status = $("#ask-status");
const dbNote = $("#ask-db"), result = $("#ask-result");
const interp = $("#ask-interp"), verdict = $("#ask-verdict"), sqlBox = $("#ask-sql");
const dataBlock = $("#ask-data"), dataTable = $("#ask-table");
const whyBlock = $("#ask-why"), basisBox = $("#why-basis"), drillBox = $("#why-drill");
const saveForm = $("#ask-save"), saveName = $("#ask-save-name"), saveBtn = $("#ask-save-btn"), saveMsg = $("#ask-save-msg");
let lastRun = null; // 방금 실행에 성공한 { question, sql } — 저장할 대상

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const badge = (ok, okText, badText) => el("span", `badge ${ok ? "ok" : "warn"}`, ok ? okText : badText);
const setPhase = (p) => { result.dataset.phase = p; };
const setVerdict = (text, kind) => { verdict.textContent = text; verdict.className = `verdict ${kind}`; };

// ---- 데이터 준비 ----
initDb((msg) => { dbNote.textContent = msg; })
  .then(async () => {
    dbNote.textContent = `데이터 준비됨 (테이블 ${(await listTables()).length}개, 이 브라우저 안에서만 읽습니다)`;
    submit.disabled = false;
    panel.dataset.dbReady = "1";
  })
  .catch((e) => { dbNote.textContent = `데이터를 불러오지 못했습니다: ${e.message}`; });

// ---- ① 산출 근거 ----
function renderBasis(sql, basis, dbTables) {
  basisBox.replaceChildren();

  const check = crossCheckTables(sql, basis.tables, dbTables);
  const tRow = el("p");
  tRow.append(el("strong", null, "읽은 테이블: "), el("span", null, basis.tables.join(", ") || "(없음)"), " ");
  tRow.append(badge(check.ok, "SQL 과 일치", "확인 필요"));
  basisBox.appendChild(tRow);
  if (!check.ok) {
    const why = [];
    if (check.onlyInSql.length) why.push(`SQL 은 읽는데 근거에 빠진 테이블: ${check.onlyInSql.join(", ")}`);
    if (check.onlyInClaim.length) why.push(`근거에는 있는데 SQL 에 없는 테이블: ${check.onlyInClaim.join(", ")}`);
    if (check.missingInDb.length) why.push(`지금 올라와 있지 않은 테이블: ${check.missingInDb.join(", ")}`);
    basisBox.appendChild(el("p", "warn-text small", why.join(" / ")));
  }

  const cRow = el("div");
  cRow.appendChild(el("strong", null, "조건"));
  const cl = el("ul");
  (basis.conditions.length ? basis.conditions : ["(적은 조건 없음)"]).forEach((c) => cl.appendChild(el("li", null, c)));
  cRow.appendChild(cl);
  basisBox.appendChild(cRow);

  const mRow = el("div");
  mRow.appendChild(el("strong", null, "쓴 지표 정의 (데이터 사전)"));
  if (!basis.metrics.length) {
    mRow.appendChild(el("p", "muted small", "사전의 지표 정의가 필요한 계산은 아닙니다."));
  } else {
    const ml = el("ul");
    basis.metrics.forEach((m) => {
      const li = el("li");
      li.append(el("strong", null, m.name), " ", badge(m.known, "사전에 있음", "사전에 없음 — 확인 필요"));
      if (m.definition) li.appendChild(el("div", "small", `사전: ${m.definition}`));
      if (m.how_used) li.appendChild(el("div", "small muted", `이 질문에서는: ${m.how_used}`));
      ml.appendChild(li);
    });
    mRow.appendChild(ml);
  }
  basisBox.appendChild(mRow);
}

// ---- ② 원인 한 단계 ----
async function renderDrill(drill, original) {
  drillBox.replaceChildren();
  if (!drill.sql) {
    drillBox.appendChild(el("p", "muted", `쪼갤 수 없었습니다. ${drill.reason || ""}`.trim()));
    return;
  }
  if (drill.reason) drillBox.appendChild(el("p", null, drill.reason));
  const det = el("details");
  det.append(el("summary", null, "쪼개는 SQL"), el("pre", "sql", drill.sql));
  drillBox.appendChild(det);

  if (drill.blocked) {
    drillBox.appendChild(el("p", "warn-text", `실행 차단: ${drill.blocked.reason}`));
    return;
  }
  let res;
  try {
    res = await runSql(drill.sql);  // 원래 SQL 과 같은 검사를 다시 거친다
  } catch (e) {
    const prefix = e instanceof SqlBlockedError ? "실행 차단" : "쪼개는 SQL 이 실패했습니다";
    drillBox.appendChild(el("p", "warn-text", `${prefix}: ${e.message}`));
    return;
  }
  const chunk = biggestChunk(res, drill.measure_column, drill.label_columns);
  const rec = reconcileTotals(original, res, drill.reconcile);
  const tableBox = el("div");
  drillBox.appendChild(tableBox);
  renderTable(tableBox, res, { highlightRow: chunk.error ? -1 : chunk.rowIndex });

  const recLine = el("p", "small");
  if (rec.status === "ok") {
    recLine.append(badge(true, "합계 일치", ""), ` ${rec.detail}`);
  } else if (rec.status === "mismatch") {
    recLine.className = "small warn-text";
    recLine.append(badge(false, "", "확인 필요"), ` 합계가 원래 결과와 다릅니다 — 조인으로 값이 반복됐을 수 있어 아래 숫자를 믿기 어렵습니다. (${rec.detail})`);
  } else {
    recLine.className = "small muted";
    recLine.textContent = rec.detail;
  }
  recLine.dataset.reconcile = rec.status;
  drillBox.appendChild(recLine);

  const line = el("p", "chunk");
  if (chunk.error) {
    line.className = "chunk warn-text";
    line.textContent = `가장 큰 덩어리는 계산하지 못했습니다: ${chunk.error}`;
  } else {
    line.append(
      el("strong", null, "가장 큰 덩어리: "),
      `${chunk.label} — ${chunk.measure} ${fmtNumber(chunk.value)} (전체 ${fmtNumber(chunk.total)}의 ${(chunk.share * 100).toFixed(1)}%)`,
    );
    if (rec.status === "mismatch") line.append(" ", badge(false, "", "확인 필요"));
    line.dataset.label = chunk.label;
    line.dataset.value = String(chunk.value);
    line.dataset.share = String(chunk.share);
    line.dataset.total = String(chunk.total);
  }
  drillBox.appendChild(line);
  drillBox.appendChild(el("p", "muted small", "이 숫자는 AI 가 아니라 이 브라우저가 위 표에서 계산했습니다."));
}

// ---- 전체 흐름 ----
async function ask(question) {
  setPhase("sql");
  lastRun = null;
  result.hidden = true; dataBlock.hidden = true; whyBlock.hidden = true;
  status.textContent = "SQL 만드는 중…";

  const r = await askSql(question);
  interp.textContent = r.interpretation ? `해석: ${r.interpretation}` : "";
  sqlBox.textContent = r.sql;
  result.hidden = false;
  if (r.blocked) {
    setVerdict(`실행 차단: ${r.blocked.reason}`, "bad");
    setPhase("blocked");
    return;
  }

  setPhase("running");
  status.textContent = "실행 중…";
  let res;
  try {
    res = await runSql(r.sql);
  } catch (e) {
    setVerdict(`${e instanceof SqlBlockedError ? "실행 차단" : "실행 실패"}: ${e.message}`, "bad");
    setPhase(e instanceof SqlBlockedError ? "blocked" : "run-error");
    return;
  }
  setVerdict("읽기 전용 검사 통과 · 실행 완료", "ok");
  dataBlock.hidden = false;
  renderTable(dataTable, res);
  lastRun = { question, sql: r.sql };
  saveName.value = question.length > 40 ? `${question.slice(0, 40)}…` : question;
  saveMsg.textContent = "";

  // 여기부터 실패해도 위의 SQL · 결과 표는 그대로 둔다
  setPhase("why");
  status.textContent = "산출 근거와 원인 만드는 중…";
  whyBlock.hidden = false;
  basisBox.replaceChildren(el("p", "muted", "만드는 중…"));
  drillBox.replaceChildren();
  let why;
  try {
    why = await askWhy(question, r.sql, res);
  } catch (e) {
    basisBox.replaceChildren(el("p", "warn-text", `산출 근거를 만들지 못했습니다: ${e.message}`));
    setPhase("why-error");
    return;
  }
  renderBasis(r.sql, why.basis, await listTables());

  setPhase("drill");
  status.textContent = "원인 SQL 실행 중…";
  drillBox.replaceChildren(el("p", "muted", "실행 중…"));
  try {
    await renderDrill(why.drill, res);
  } catch (e) {
    drillBox.replaceChildren(el("p", "warn-text", `원인 한 단계를 보여 주지 못했습니다: ${e.message}`));
  }
  setPhase("done");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = input.value.trim();
  if (!question) { status.textContent = "질문을 입력해 주세요."; return; }
  submit.disabled = true;
  try {
    await ask(question);
    status.textContent = "";
  } catch (err) {
    status.textContent = err.message;
    setPhase("error");
  } finally {
    submit.disabled = false;
  }
});

// 이름을 붙여 저장: 읽기 전용 검사를 거친 뒤 이 브라우저에 남긴다(준비된 질문 탭에서 다시 계산).
saveForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!lastRun) { saveMsg.textContent = "저장할 결과가 없습니다. 먼저 질문을 실행해 주세요."; return; }
  saveBtn.disabled = true;
  try {
    const { replaced } = await saveQuestion({ name: saveName.value, question: lastRun.question, sql: lastRun.sql });
    saveMsg.textContent = `${replaced ? "같은 이름이 있어 덮어썼습니다" : "저장했습니다"} — «준비된 질문» 탭에서 다시 계산할 수 있습니다.`;
  } catch (err) {
    saveMsg.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

// 개발 편의: 주소에 ?autoask=질문 이 있으면 데이터가 준비된 뒤 한 번 자동으로 묻는다(화면 확인용).
const auto = new URLSearchParams(location.search).get("autoask");
if (auto) {
  initDb().then(() => { input.value = auto; form.requestSubmit(); });
}
