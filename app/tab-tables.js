// 테이블 탭: 지금 올라와 있는 테이블의 이름 · 행 수 · 컬럼 이름 · 타입. 올린 파일로 바뀌면 다시 그린다.
import { initDb } from "./db.js";
import { listTableInfo, TABLES_CHANGED } from "./catalog.js";

const panel = document.getElementById("panel-tables");
panel.insertAdjacentHTML("beforeend", `<div id="tables-list" class="cards"><p class="muted">데이터 준비 중…</p></div>`);
const list = panel.querySelector("#tables-list");

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

async function render() {
  const info = await listTableInfo();
  list.replaceChildren();
  info.forEach((t) => {
    const card = el("article", "card");
    card.dataset.table = t.name;
    card.dataset.origin = t.origin;
    card.dataset.rows = String(t.rowCount);

    const head = el("div", "card-head");
    head.appendChild(el("h4", null, t.name));
    head.appendChild(el("span", `badge ${t.origin === "upload" ? "warn-soft" : "ok"}`,
      t.origin === "upload" ? (t.replaced ? "내 파일로 바뀜" : "내 파일") : "기본 데이터"));
    card.appendChild(head);

    const meta = el("p", "meta small");
    meta.append(el("span", null, `${t.rowCount.toLocaleString("ko-KR")}행`), el("span", null, `컬럼 ${t.columns.length}개`));
    if (t.origin === "upload") {
      meta.append(el("span", null, `파일 ${t.file}`), el("span", null, `올린 시각 ${new Date(t.loadedAt).toLocaleString("ko-KR", { hour12: false })}`));
    }
    card.appendChild(meta);

    const det = el("details");
    det.appendChild(el("summary", null, "컬럼 이름 · 타입"));
    const table = el("table", "result cols");
    const hr = table.createTHead().insertRow();
    ["컬럼 이름", "타입"].forEach((h) => hr.appendChild(el("th", null, h)));
    const body = table.createTBody();
    t.columns.forEach((c) => {
      const tr = body.insertRow();
      tr.insertCell().textContent = c.name;
      tr.insertCell().textContent = c.type;
    });
    const wrap = el("div", "table-wrap");
    wrap.appendChild(table);
    det.appendChild(wrap);
    card.appendChild(det);
    list.appendChild(card);
  });
  panel.dataset.rendered = String(Date.now());
}

const safeRender = () => render().catch((e) => { list.replaceChildren(el("p", "warn-text", `테이블 목록을 만들지 못했습니다: ${e.message}`)); });
window.addEventListener(TABLES_CHANGED, safeRender);
initDb().then(safeRender).catch(() => { /* 묻기 탭에 오류가 표시된다 */ });
