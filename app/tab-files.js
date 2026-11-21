// 내 파일 탭: CSV · xlsx 를 끌어다 놓거나 골라서 올린다. 파일 이름이 테이블 이름이 된다.
// 올린 파일은 브라우저 밖으로 나가지 않는다. 올린 직후 준비된 질문을 자동으로 다시 계산하지 않는다.
import { importFile } from "./loader.js";
import { renderReport } from "./report.js";

const panel = document.getElementById("panel-files");

panel.insertAdjacentHTML("beforeend", `
  <div id="drop" class="dropzone" tabindex="0" role="button" aria-label="파일을 끌어다 놓거나 눌러서 고르기">
    <strong>CSV · 엑셀(xlsx) 파일을 여기로 끌어다 놓거나, 눌러서 고르세요</strong>
    <span class="muted small">여러 개를 한꺼번에 올릴 수 있습니다 · CSV 는 UTF-8 · xlsx 는 첫 시트의 첫 행이 컬럼 이름</span>
  </div>
  <input type="file" id="files-input" multiple accept=".csv,.xlsx" hidden>
  <ul class="small muted files-rules">
    <li>파일 이름(확장자 뺀 것)이 테이블 이름이 됩니다. 같은 이름의 테이블이 있으면 새 파일로 바꿉니다(새로고침하면 처음 데이터로 돌아갑니다).</li>
    <li>올린 파일은 이 브라우저 안에서만 읽고, 서버나 AI 로 보내지 않습니다. AI 에는 테이블 이름 · 컬럼 이름 · 타입 · 행 수만 알립니다.</li>
    <li>컬럼 이름의 공백은 밑줄로 바뀝니다. 올린 직후에는 준비된 질문이 자동으로 다시 계산되지 않으니, «준비된 질문» 탭에서 «다시 계산»을 눌러 주세요.</li>
  </ul>
  <div id="files-log" class="cards"></div>
`);

const drop = panel.querySelector("#drop");
const input = panel.querySelector("#files-input");
const log = panel.querySelector("#files-log");

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// 한 번에 하나씩 차례로 올린다(같은 이름이 겹쳐도 순서대로 바뀐다)
let queue = Promise.resolve();

function handleFiles(fileList) {
  const files = [...fileList];
  for (const file of files) {
    const card = el("article", "card");
    card.dataset.state = "queued";
    card.appendChild(el("h4", null, file.name));
    card.appendChild(el("p", "muted small", "차례를 기다리는 중…"));
    log.prepend(card);
    queue = queue.then(async () => {
      card.replaceChildren(el("h4", null, file.name), el("p", "muted small", "읽는 중…"));
      card.dataset.state = "running";
      try {
        renderReport(card, await importFile(file));
      } catch (e) {
        card.replaceChildren(el("h4", null, file.name), el("p", "warn-text", e.message));
        card.dataset.state = "error";
      }
    });
  }
  return queue;
}

drop.addEventListener("click", () => input.click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
input.addEventListener("change", () => { handleFiles(input.files); input.value = ""; });

["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files); });
