import {
  accuracyByConfidence, aiAgreement, closedStats, errorRanking, executionRate,
  navStats, periodRange, shiftPeriod,
} from "../calc.js";
import { fmtMoney, fmtPct, todayStr } from "../format.js";
import { error_tags, h, localTimestamp, pnlColor, seg, signedPct } from "../ui.js";

const periods = [
  { value: "month", label: "月", title: "月度統計" },
  { value: "quarter", label: "季", title: "季度統計" },
  { value: "year", label: "年", title: "年度統計" },
];
const periodStorageKey = "fupan.stats.period";
const errorLabels = new Map(error_tags.map(({ value, label }) => [value, label]));

function preferredPeriod() {
  try {
    const saved = localStorage.getItem(periodStorageKey);
    if (periods.some(({ value }) => value === saved)) return saved;
  } catch {
    // 瀏覽器可能停用儲存。
  }
  return "quarter";
}

function metric(label, value, color = "", note) {
  return h("div", { class: "stats-metric" },
    h("span", { class: "lbl" }, label),
    h("strong", { class: color }, value),
    note && h("span", { class: "lbl" }, note),
  );
}

function ratePct(value) {
  return value == null ? "—" : `${fmtMoney(value)}%`;
}

function holdingCard(stats) {
  const days = (value) => value == null ? "—" : `${value} 天`;
  return h("section", { class: "card" },
    h("h2", null, "持有與執行"),
    h("p", { class: "lbl" }, "平均持有天數"),
    h("p", null, `賺 ${days(stats.avg_hold_win)} / 賠 ${days(stats.avg_hold_loss)}`),
    h("div", { class: "grid-two" },
      metric("計劃內平均", signedPct(stats.in_plan_avg_pct), pnlColor(stats.in_plan_avg_pct)),
      metric("有計劃外操作的平均", signedPct(stats.out_plan_avg_pct), pnlColor(stats.out_plan_avg_pct)),
      metric("賣出後 1 個月平均", signedPct(stats.after_1m_avg_pct), pnlColor(stats.after_1m_avg_pct)),
      metric("賣出後 3 個月平均", signedPct(stats.after_3m_avg_pct), pnlColor(stats.after_3m_avg_pct)),
    ),
    h("p", { class: "lbl" }, "賣出後再漲為正，代表可能賣早了"),
  );
}

function accuracyCard(doneReviews) {
  const groups = accuracyByConfidence(doneReviews);
  const [high, mid] = groups;
  return h("section", { class: "card" },
    high.n > 0 && mid.n > 0 && high.pct <= mid.pct
      && h("strong", null, "『很有把握』時並沒有更準"),
    h("h2", null, "按買入時的信心分組，看理由實際應驗的比例"),
    groups.map(({ label, n, right, pct }) => h("div", { class: "stats-bar" },
      h("span", null, label),
      h("span", { class: "stats-track", "aria-hidden": "true" },
        h("span", { class: "stats-fill", style: `width: ${pct ?? 0}%` }),
      ),
      h("span", null, `${fmtPct(pct)}（${right}/${n}）`),
    )),
  );
}

function agreementCard({ n, pct }) {
  return h("section", { class: "card" },
    h("h2", null, "AI 判斷一致率"),
    h("p", null, n ? `與你判斷一致 ${fmtPct(pct)}（${n} 則）` : "尚無已確認的 AI 評估"),
    h("p", { class: "lbl" }, "這是你同意 AI 判斷的比例，不是 AI 的真實準確度"),
  );
}

function rankingCard(ranking) {
  return h("section", { class: "card stats-ranking" },
    h("div", { class: "record-head" },
      h("h2", null, "錯誤排行"),
      ranking.length > 0 && h("span", { class: "lbl" }, "筆數 · 拖累"),
    ),
    ranking.length ? ranking.slice(0, 5).map(({ tag, count, excess_sum_pct }, index) =>
      h("div", { class: index === 0 ? "stats-error-row first" : "stats-error-row" },
        h("span", null, errorLabels.get(tag) ?? tag),
        h("span", null, count),
        h("span", { class: pnlColor(excess_sum_pct) }, signedPct(excess_sum_pct)),
      )) : h("p", { class: "lbl" }, "本期沒有標記錯誤"),
  );
}

export async function render(root, { db, setTitle, setSubtitle, toast }) {
  let kind = preferredPeriod();
  let anchor = todayStr();
  function updateHeading() {
    setTitle(periods.find(({ value }) => value === kind).title);
    setSubtitle(periodRange(kind, anchor).label);
  }
  updateHeading();

  const [nav, reviews, evidence, trades, requestState] = await Promise.all([
    db.listNav(), db.listExitReviewsWithPlan(), db.listAiConfirmations(), db.listTrades(),
    db.latestRuleRequest().then((request) => ({ request }), (error) => ({ error: error.message })),
  ]);
  if (!root.isConnected) return;

  const tradesByPlan = new Map();
  for (const trade of trades) {
    if (!tradesByPlan.has(trade.plan_id)) tradesByPlan.set(trade.plan_id, []);
    tradesByPlan.get(trade.plan_id).push(trade);
  }
  let latest = requestState.request;
  let requestError = requestState.error ?? "";
  let requestBusy = false;
  let blockedReason = "";
  const figures = h("div", { class: "stack stats-content" });
  const previous = h("button", {
    class: "btn icon-btn", type: "button", "aria-label": "前一期", onclick: () => move(-1),
  }, "‹");
  const next = h("button", {
    class: "btn icon-btn", type: "button", "aria-label": "後一期", onclick: () => move(1),
  }, "›");
  const periodLabel = h("span", { class: "lbl", id: "stats-period-label" }, "統計期間");
  const selector = seg(periods, kind, (selected) => {
    if (selected === kind) return;
    kind = selected;
    anchor = todayStr();
    try {
      localStorage.setItem(periodStorageKey, kind);
    } catch {
      // 這次的選擇仍然有效。
    }
    draw();
  }, periodLabel.id);

  const requestIntro = h("p");
  const requestButton = h("button", {
    class: "btn pri", type: "button", onclick: sendRequest,
  }, "請 AI 提出候選");
  const reasonText = h("p", { class: "lbl warn" });
  const statusText = h("p", { class: "lbl", role: "status" });
  const errorText = h("p", { class: "form-error", role: "alert" });
  root.replaceChildren(
    h("div", { class: "stats-period" }, periodLabel, h("div", { class: "stats-controls" }, previous, selector, next)),
    figures,
    h("section", { class: "card stats-content" },
      h("h2", null, "規則修改候選"), requestIntro,
      requestButton, reasonText, statusText, errorText,
      h("a", { class: "btn text-btn", href: "#rules" }, "前往規則清單 ›"),
    ),
  );

  function move(step) {
    const target = shiftPeriod(kind, anchor, step);
    if (target > periodRange(kind, todayStr()).start) return;
    anchor = target;
    draw();
  }

  function hasPendingRequest() {
    return latest?.status === "queued" || latest?.status === "running";
  }

  function showRequestState() {
    const pending = hasPendingRequest();
    requestButton.disabled = Boolean(requestBusy || blockedReason || pending);
    reasonText.textContent = blockedReason;
    reasonText.hidden = !blockedReason;
    statusText.textContent = pending ? `已送出 ${localTimestamp(latest.created_at, true)}，等待 Mac 處理` : "";
    statusText.hidden = !pending;
    errorText.textContent = requestError || (latest?.status === "error" ? latest.error ?? "" : "");
    errorText.hidden = !errorText.textContent;
  }

  async function sendRequest() {
    if (requestButton.disabled) return;
    requestBusy = true;
    requestError = "";
    showRequestState();
    try {
      latest = await db.latestRuleRequest();
      if (!root.isConnected || blockedReason || hasPendingRequest()) return;
      latest = await db.requestRuleCandidates();
      if (root.isConnected) toast("已送出，Mac 下次執行後會出現在規則頁");
    } catch (error) {
      requestError = error.message;
    } finally {
      requestBusy = false;
      showRequestState();
    }
  }

  function draw() {
    updateHeading();
    const { start, end } = periodRange(kind, anchor);
    next.disabled = start >= periodRange(kind, todayStr()).start;
    const closed = reviews.filter(({ closed_date }) => closed_date >= start && closed_date <= end);
    const done = closed.filter(({ status }) => status === "done");
    const stats = closedStats(closed, tradesByPlan);
    const navResult = navStats(nav, start, end);
    const execution = executionRate(trades, start, end);
    const ranking = errorRanking(done);
    figures.replaceChildren(
      h("section", { class: "card" },
        h("strong", null, `本期已清倉 ${stats.count} 筆`),
        stats.count < 20 && h("p", { class: "lbl warn" }, "樣本不足 20 筆，僅供參考，不據此改規則"),
      ),
      h("section", { class: "card" },
        h("div", { class: "grid-two stats-metrics" },
          metric("超額收益", signedPct(navResult.excess_pct), pnlColor(navResult.excess_pct)),
          metric("最大回撤", signedPct(navResult.max_drawdown_pct)),
          metric("計劃執行率", ratePct(execution.pct), "", `${execution.in_plan} / ${execution.total} 筆`),
          metric("勝率", ratePct(stats.win_rate_pct)),
          metric("賺賠比", fmtMoney(stats.payoff)),
          metric("期望值 / 筆", signedPct(stats.expectancy_pct), pnlColor(stats.expectancy_pct)),
        ),
        navResult.days
          ? h("p", { class: "lbl" },
            "組合 ", h("span", { class: pnlColor(navResult.ret_pct) }, signedPct(navResult.ret_pct)),
            "｜基準 ", h("span", { class: pnlColor(navResult.bench_pct) }, signedPct(navResult.bench_pct)),
            `（${navResult.days} 個交易日）`,
          )
          : h("p", { class: "lbl" }, "尚無淨值資料"),
      ),
      holdingCard(stats),
      accuracyCard(done.map((review) => ({ ...review, confidence: review.plans?.confidence }))),
      agreementCard(aiAgreement(evidence, start, end)),
      rankingCard(ranking),
    );

    const first = ranking[0];
    requestIntro.textContent = first
      ? `只針對『${errorLabels.get(first.tag) ?? first.tag}』看規則修改候選`
      : "本期沒有錯誤可據以修改規則";
    blockedReason = [
      stats.count < 20 && "樣本不足 20 筆",
      !first && "本期沒有標記錯誤",
    ].filter(Boolean).join("，");
    showRequestState();
  }

  draw();
}
