// 올린 파일 한 개의 결과 카드를 그린다(내 파일 탭). 값은 textContent 로만 넣는다.
import { renderTable } from "./table.js";

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** importFile 이 돌려준 report 를 card(요소)에 그린다. 행 수가 같으면 ✓, 다르면 ✕. */
export function renderReport(card, r) {
  card.replaceChildren();
  card.dataset.state = "done";
  card.dataset.table = r.tableName;
  card.dataset.match = r.match ? "1" : "0";

  const head = el("div", "card-head");
  head.appendChild(el("h4", null, `${r.fileName} → 테이블 «${r.tableName}»`));
  head.appendChild(el("span", `badge ${r.replaced ? "warn-soft" : "ok"}`, r.replaced ? "기존 테이블을 바꿨습니다" : "새 테이블"));
  card.appendChild(head);

  // 파일에서 읽은 행 수와 테이블에 올라간 행 수를 나란히
  const cmp = el("p", `rowcmp ${r.match ? "ok" : "bad"}`);
  cmp.dataset.fileRows = String(r.fileRows);
  cmp.dataset.tableRows = String(r.tableRows);
  cmp.append(
    el("span", null, `파일에서 읽은 행 수 ${r.fileRows.toLocaleString("ko-KR")}`),
    el("span", null, `테이블에 올라간 행 수 ${r.tableRows.toLocaleString("ko-KR")}`),
    el("strong", "mark", r.match ? "✓ 같음" : "✕ 다름"),
  );
  card.appendChild(cmp);

  const notes = [];
  if (r.tableNameChanged) notes.push(`파일 이름에 쓸 수 없는 글자가 있어 테이블 이름을 «${r.tableName}»(으)로 정리했습니다.`);
  if (r.sheet) notes.push(`xlsx 의 첫 시트 «${r.sheet.name}»을 읽었습니다${r.sheet.count > 1 ? ` (시트 ${r.sheet.count}개 중 첫 번째만)` : ""}.`);
  r.columnChanges.forEach((c) => notes.push(`컬럼 «${c.from}» → «${c.to}» (${c.why})`));
  if (r.columnDiff) {
    const parts = [];
    if (r.columnDiff.removed.length) parts.push(`없어진 컬럼: ${r.columnDiff.removed.join(", ")}`);
    if (r.columnDiff.added.length) parts.push(`새 컬럼: ${r.columnDiff.added.join(", ")}`);
    notes.push(`기존 테이블과 컬럼이 다릅니다 — ${parts.join(" / ")}. 이 테이블을 읽는 준비된 질문은 오류가 나거나 값이 달라질 수 있습니다.`);
  }
  if (notes.length) {
    const ul = el("ul", "small notes");
    notes.forEach((n) => ul.appendChild(el("li", null, n)));
    card.appendChild(ul);
  }

  card.appendChild(el("p", "small muted", `컬럼 ${r.columns.length}개: ${r.columns.map((c) => `${c.name} (${c.type})`).join(", ")}`));
  card.appendChild(el("p", "small", `처음 ${r.preview.rows.length}행 미리 보기`));
  const box = el("div");
  card.appendChild(box);
  renderTable(box, r.preview, { maxShow: 20 });
}
