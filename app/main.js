import "./tab-ask.js";
import "./tab-prepared.js";
import "./tab-tables.js";
import "./tab-files.js";

// 탭 전환. 주소에는 아무것도 붙이지 않는다. 고른 탭은 이 브라우저 탭의 sessionStorage 에 적어 두고
// 새로고침하면 거기서 읽는다(저장소를 못 쓰면 첫 탭으로 열린다).
// 옛 주소 #ask 처럼 해시가 붙어 들어오면 그 탭을 열고 해시는 주소에서 지운다.
const TABS = ["prepared", "ask", "tables", "files"];
const STORE_KEY = "marketing-sql:tab";
const tabButtons = document.querySelectorAll(".tabs [role=tab]");
const panels = document.querySelectorAll("[data-panel]");

function remembered() {
  try { return sessionStorage.getItem(STORE_KEY); } catch { return null; }
}

function showTab(name, { remember = true } = {}) {
  if (!TABS.includes(name)) name = TABS[0];
  tabButtons.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  panels.forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (remember) { try { sessionStorage.setItem(STORE_KEY, name); } catch { /* 저장소를 못 써도 탭은 바뀐다 */ } }
}

function takeHash() {
  const name = location.hash.slice(1);
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  return TABS.includes(name) ? name : null;
}

tabButtons.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
window.addEventListener("hashchange", () => { const n = takeHash(); if (n) showTab(n); });
showTab(takeHash() || remembered());
