import { fmtDate, fmtMoney } from "../format.js";
import { h, localTimestamp, pnlColor, reviewDeadline, shortDate } from "../ui.js";
import { actionableAlerts, alertCard, staleNotice } from "./alert.js";
import { confidenceLabels, directionChip, infoTypes } from "./evidence.js";

const weekday = new Intl.DateTimeFormat("zh-TW", { weekday: "short" });

function performanceValue(label, value) {
  const percentage = value == null ? "—" : `${value > 0 ? "+" : ""}${fmtMoney(value * 100)}%`;
  return h("div", { class: "nav-metric" },
    h("span", { class: "lbl" }, label),
    h("strong", { class: pnlColor(value) }, percentage),
  );
}

function performanceCard(nav) {
  if (nav?.ret == null) {
    return h("p", { class: "card" }, "尚無淨值資料（需先在設定填起始日，並等 Mac 每日更新）");
  }
  const excess = nav.bench_ret == null ? null : Number(nav.ret) - Number(nav.bench_ret);
  return h("section", { class: "card", "aria-label": "組合表現" },
    h("div", { class: "grid-three nav-metrics" },
      performanceValue("組合", nav.ret),
      performanceValue("混合基準", nav.bench_ret),
      performanceValue("超額", excess),
    ),
    h("p", { class: "lbl" }, `以 ${fmtDate(nav.nav_date)} 收盤計算`),
  );
}

function actionSection(title, cards) {
  if (!cards.length) return null;
  return h("section", { class: "today-section" },
    h("div", { class: "record-head" },
      h("h2", null, title), h("span", { class: "lbl" }, cards.length),
    ),
    cards,
  );
}

function aiCard(evidence) {
  const freshness = evidence.is_new == null ? "—" : evidence.is_new ? "新信息" : "舊信息";
  return h("a", { class: "card action-card", href: `#evidence/${evidence.id}` },
    h("div", { class: "record-head" },
      h("strong", null, [evidence.plans?.name, evidence.source_name].filter(Boolean).join(" · ")),
      h("div", { class: "record-meta" }, directionChip(evidence.direction), evidence.related_clause),
    ),
    h("p", null, evidence.title),
    h("p", { class: "lbl" }, [
      infoTypes[evidence.info_type] ?? "—",
      freshness,
      `AI 把握：${confidenceLabels[evidence.ai_confidence] ?? "—"} ›`,
    ].join(" · ")),
  );
}

function reviewCard(review, today) {
  return h("a", { class: "card review-action", href: `#exit-review/${review.id}` },
    h("span", { class: "holding-name" },
      h("strong", null, review.plans?.name ?? "—"),
      h("span", { class: "lbl" }, `${shortDate(review.closed_date)} 清倉 · 三天內完成`),
    ),
    reviewDeadline(review.due_date, today),
  );
}

function jobStatus(run) {
  if (!run) return "Mac 端的自動更新還沒開始執行";
  const status = run.ok === null ? "執行中" : run.ok ? "成功" : "失敗";
  return `資料更新：daily ${localTimestamp(run.finished_at ?? run.started_at)} ${status}`;
}

export async function render(root, ctx) {
  const now = new Date();
  const today = fmtDate(now);
  ctx.setSubtitle(`${now.getMonth() + 1}月${now.getDate()}日 ${weekday.format(now)}`);
  const [alerts, pendingEvidence, reviews, nav, jobRuns] = await Promise.all([
    ctx.db.listOpenAlerts(), ctx.db.listPendingAiEvidence(), ctx.db.listDraftExitReviews(),
    ctx.db.latestNav(), ctx.db.latestJobRuns(),
  ]);
  if (!root.isConnected) return;

  const actionable = actionableAlerts(alerts);
  const evidence = pendingEvidence.filter((row) => row.info_type !== "rumor");
  const count = actionable.length + evidence.length + reviews.length;
  root.replaceChildren(...[
    h("p", { class: "lbl today-count" }, `今日待處理 ${count} 件`),
    ...alerts.filter((alert) => alert.kind === "stale").map((alert) => staleNotice(alert, ctx)),
    performanceCard(nav),
    actionSection("條件已觸發 · 今天要做決定", actionable.map(alertCard)),
    actionSection("AI 信息評估 · 等你確認", evidence.map(aiCard)),
    actionSection("待寫單筆復盤", reviews.map((review) => reviewCard(review, today))),
    count === 0 && h("p", { class: "empty" }, "今天沒有要處理的事。"),
    h("p", { class: "lbl" }, jobStatus(jobRuns.find((run) => run.job === "daily"))),
  ].filter(Boolean));
}
