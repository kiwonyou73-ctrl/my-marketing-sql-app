// 결과 표 그리기 (텍스트로만 넣어서 값 안의 HTML 이 실행되지 않게 한다).
export const fmtNumber = (v) =>
  typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString("ko-KR") : v.toLocaleString("ko-KR", { maximumFractionDigits: 4 })) : v;

export function renderTable(container, result, { maxShow = 200, highlightRow = -1 } = {}) {
  container.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  table.className = "result";

  // 값이 모두 숫자인 열은 머리글과 값을 함께 오른쪽 정렬한다(NULL 은 건너뛴다)
  const numeric = result.columns.map((_, j) => {
    const vals = result.rows.map((r) => r[j]).filter((v) => v !== null);
    return vals.length > 0 && vals.every((v) => typeof v === "number");
  });

  const head = table.createTHead().insertRow();
  result.columns.forEach((c, j) => {
    const th = document.createElement("th");
    th.textContent = c;
    if (numeric[j]) th.className = "num";
    head.appendChild(th);
  });

  const body = table.createTBody();
  result.rows.slice(0, maxShow).forEach((row, i) => {
    const tr = body.insertRow();
    if (i === highlightRow) tr.className = "hl";
    row.forEach((v, j) => {
      const td = tr.insertCell();
      td.textContent = v === null ? "NULL" : String(fmtNumber(v));
      td.className = [numeric[j] ? "num" : "", v === null ? "null" : ""].filter(Boolean).join(" ");
    });
  });
  wrap.appendChild(table);
  container.appendChild(wrap);

  const notes = [];
  notes.push(`${result.rows.length.toLocaleString("ko-KR")}행${result.truncated ? " 이상 (앞부분만 가져옴)" : ""}`);
  if (result.rows.length > maxShow) notes.push(`화면에는 앞의 ${maxShow}행만 보입니다`);
  const p = document.createElement("p");
  p.className = "muted small";
  p.textContent = notes.join(" · ");
  container.appendChild(p);
}
