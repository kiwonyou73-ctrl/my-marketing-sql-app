import "./tab-ask.js";
import "./tab-prepared.js";
import "./tab-tables.js";
import "./tab-files.js";

// 탭 전환. 선택한 탭은 주소의 #뒤에 남겨서 새로고침해도 유지한다.
const TABS = ["prepared", "ask", "tables", "files"];
const tabButtons = document.querySelectorAll(".tabs [role=tab]");
const panels = document.querySelectorAll("[data-panel]");

function showTab(name) {
  if (!TABS.includes(name)) name = TABS[0];
  tabButtons.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  panels.forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
}

tabButtons.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
showTab(location.hash.slice(1));
