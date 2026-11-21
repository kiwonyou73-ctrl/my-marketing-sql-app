// «왜» 붙이기의 계산. 여기 숫자는 전부 브라우저가 계산한다(AI 가 말한 숫자를 쓰지 않는다).
import { tablesInSql } from "./sqlguard.js";

const norm = (s) => String(s).trim().replace(/^"|"$/g, "").toLowerCase();

/**
 * ① 산출 근거 대조: AI 가 «읽었다»고 한 테이블과 SQL 이 실제로 읽는 테이블을 비교한다.
 * 반환: { ok, onlyInSql[], onlyInClaim[], missingInDb[] }  — ok 가 false 면 «확인 필요».
 */
export function crossCheckTables(sql, claimedTables, dbTables) {
  const inSql = new Set(tablesInSql(sql));
  const claimed = new Set((claimedTables || []).map(norm).filter(Boolean));
  const dbSet = new Set(dbTables.map(norm));
  const onlyInSql = [...inSql].filter((t) => !claimed.has(t));
  const onlyInClaim = [...claimed].filter((t) => !inSql.has(t));
  const missingInDb = [...claimed].filter((t) => !dbSet.has(t));
  return { ok: !onlyInSql.length && !onlyInClaim.length && !missingInDb.length, onlyInSql, onlyInClaim, missingInDb };
}

const sumColumn = (result, idx) => {
  let s = 0;
  for (const r of result.rows) {
    const v = r[idx];
    if (v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    s += v;
  }
  return s;
};

/**
 * ② 합계 대조: 쪼갠 표의 한 열 합이 원래 결과의 짝이 되는 열 합과 같은지 본다.
 * 조인으로 값이 반복돼 부풀었으면 어긋난다. 반환: { status: "ok" | "mismatch" | "skipped", detail, drillSum, originalSum }
 */
export function reconcileTotals(original, drill, pair) {
  const skip = (detail) => ({ status: "skipped", detail });
  const dName = pair?.drill_column, oName = pair?.original_column;
  if (!dName || !oName) return skip("대조할 열이 정해지지 않아 합계 대조는 하지 못했습니다.");
  if (original.truncated || drill.truncated) return skip("행이 너무 많아 합계 대조는 하지 못했습니다.");
  const find = (res, name) => res.columns.findIndex((c) => norm(c) === norm(name));
  const di = find(drill, dName), oi = find(original, oName);
  if (di < 0 || oi < 0) return skip(`대조할 열(${di < 0 ? `쪼갠 표의 «${dName}»` : `원래 결과의 «${oName}»`})을 찾지 못해 합계 대조는 하지 못했습니다.`);
  const drillSum = sumColumn(drill, di), originalSum = sumColumn(original, oi);
  if (drillSum === null || originalSum === null) return skip("숫자가 아닌 열이라 합계 대조는 하지 못했습니다.");
  const diff = Math.abs(drillSum - originalSum) / Math.max(Math.abs(drillSum), Math.abs(originalSum), 1);
  const detail = `쪼갠 표 «${drill.columns[di]}» 합 ${drillSum.toLocaleString("ko-KR")} · 원래 결과 «${original.columns[oi]}» 합 ${originalSum.toLocaleString("ko-KR")}`;
  return { status: diff <= 0.001 ? "ok" : "mismatch", detail, drillSum, originalSum };
}

/**
 * ② 가장 큰 덩어리: 쪼갠 결과에서 measure 열의 값이 가장 큰 행과 그 비중(열 합계 대비)을 계산한다.
 * measure 열은 AI 가 고른 합산 가능한 숫자 열이다. 열이 없거나 숫자가 아니거나 합이 0 이하면 { error }.
 * 반환: { label, value, share, total, measure, rowIndex } 또는 { error }
 */
export function biggestChunk(result, measureColumn, labelColumns) {
  const colIndex = (name) => result.columns.findIndex((c) => norm(c) === norm(name));
  const m = colIndex(measureColumn);
  if (m < 0) return { error: `합산 열 «${measureColumn || "(없음)"}» 이 결과에 없습니다.` };
  const values = result.rows.map((r) => r[m]);
  if (!values.length) return { error: "쪼갠 결과가 비어 있습니다." };
  if (values.some((v) => v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0))) {
    return { error: `«${result.columns[m]}» 열은 합산할 수 있는 숫자가 아닙니다.` };
  }
  const nums = values.map((v) => v ?? 0);
  const total = nums.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return { error: `«${result.columns[m]}» 열의 합이 0 이어서 비중을 계산할 수 없습니다.` };

  let top = 0;
  nums.forEach((v, i) => { if (v > nums[top]) top = i; });

  let labelIdx = (labelColumns || []).map(colIndex).filter((i) => i >= 0 && i !== m);
  if (!labelIdx.length) {  // AI 가 준 열이 없으면 문자열 열을 쓴다
    labelIdx = result.columns.map((_, i) => i).filter((i) => i !== m && result.rows.some((r) => typeof r[i] === "string")).slice(0, 1);
  }
  const label = labelIdx.length ? labelIdx.map((i) => result.rows[top][i]).join(" · ") : `${top + 1}번째 행`;
  return { label, value: nums[top], share: nums[top] / total, total, measure: result.columns[m], rowIndex: top };
}
