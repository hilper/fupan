import { buildPositions, effectivePlan, snapshot } from "../calc.js";
import { fmtDate, fmtMoney, fmtPct, todayStr } from "../format.js";
import { allowedPlanAmendments, detailsValue, h, missingSupplementFields, pnlColor } from "../ui.js";

const evidenceLabels = { strengthen: "強化", weaken: "削弱", none: "不變" };

export async function loadPortfolio(db, today) {
  const [settings, plans, amendments, trades, cashFlows, fxRows] = await Promise.all([
    db.getSettings(), db.listPlans(), db.listAmendments(), db.listTrades(),
    db.listCashFlows(), db.listFx(),
  ]);
  const byPlan = new Map();
  for (const row of allowedPlanAmendments(amendments)) {
    if (!byPlan.has(row.plan_id)) byPlan.set(row.plan_id, []);
    byPlan.get(row.plan_id).push(row);
  }
  const held = [...buildPositions(trades, today).values()].filter((position) => position.quantity > 0);
  const latestPrices = await db.latestPrices(held.map((position) => position.symbol));
  const effective = plans.map((plan) => effectivePlan(plan, byPlan.get(plan.id) ?? []));
  const pendingCounts = new Map(plans.filter((plan) => plan.status === "active")
    .map((plan) => [plan.id, missingSupplementFields(plan).length]));
  const portfolio = snapshot({ settings, plans: effective, trades, cashFlows, latestPrices, fxRows, today });
  return { settings, plans: effective, portfolio, latestPrices, pendingCounts };
}

const newPlanLink = () => h("a", { class: "btn pri", href: "#plan-new" }, "＋ 新計劃卡");

function riskCard(portfolio, settings) {
  const { max_single, max_sector, total_cny, cash_cny, loss_at_stop_pct } = portfolio;
  function limit(label, value, ceiling, name, main = false) {
    const over = value != null && value > Number(ceiling);
    return h("div", { class: main ? "risk-main" : `risk-tile${over ? " over" : ""}` },
      h("p", { class: "lbl" }, label),
      h("div", { class: "record-meta" },
        h("strong", { class: over ? "up" : "" }, fmtPct(value)), name,
      ),
      h("p", { class: "lbl" }, `上限 ${fmtPct(ceiling)}`),
    );
  }
  return h("section", { class: "card" },
    h("div", { class: "record-head" }, h("h2", null, "風險預算"), h("span", { class: "lbl" }, "按計劃卡止損線計算")),
    limit("全部觸發止損時的組合虧損", loss_at_stop_pct, settings.loss_budget_pct, null, true),
    h("div", { class: "grid-two" },
      limit("最大單票", max_single.weight_pct, settings.single_max_pct, max_single.name ?? "—"),
      limit("最大行業", max_sector.weight_pct, settings.sector_max_pct, max_sector.sector ?? "—"),
    ),
    h("p", { class: "lbl" }, `總資產 ¥${fmtMoney(total_cny)} · 現金 ¥${fmtMoney(cash_cny)}`),
  );
}

function pendingLabel(count) {
  return count > 0 && h("span", { class: "plan-pending" }, `待補 ${count}`);
}

function holdingRow(position, evidence, today, pending) {
  const { plan, weight_pct, pnl_pct, stop_dist_pct } = position;
  const overdue = plan.next_review_date && plan.next_review_date <= today;
  return h("a", { class: "record holding-row", href: `#plan/${plan.id}` },
    h("div", { class: "holding-name" },
      h("strong", null, plan.name),
      pendingLabel(pending),
      h("span", { class: "lbl" }, plan.symbol),
      h("span", { class: evidence === "weaken" ? "chip warn" : "chip" }, evidenceLabels[evidence] ?? "尚無證據"),
    ),
    h("div", { class: "holding-metrics grid-two" },
      detailsValue("倉位", fmtPct(weight_pct)),
      detailsValue("浮動盈虧", fmtPct(pnl_pct), pnlColor(pnl_pct)),
      detailsValue("距止損", fmtPct(stop_dist_pct), stop_dist_pct != null && stop_dist_pct <= 0 ? "warn" : ""),
      detailsValue("複查", fmtDate(plan.next_review_date), overdue ? "warn" : ""),
    ),
  );
}

function planList(title, plans, route, reviewStatuses, pendingCounts) {
  if (!plans.length) return null;
  return h("section", { class: "card" },
    h("h2", null, title),
    plans.map((plan) => {
      const reviewLabel = reviewStatuses?.get(plan.id) === "done" ? "已完成" : "待寫";
      const pending = pendingCounts.get(plan.id);
      return h("a", { class: "record record-head plan-link", href: `#${route}/${plan.id}` },
        reviewStatuses ? h("div", { class: "record-meta" },
          h("strong", null, plan.name), h("span", { class: "lbl" }, plan.symbol),
        ) : [
          pending > 0 ? h("div", { class: "holding-name" },
            h("strong", null, plan.name), pendingLabel(pending)) : h("strong", null, plan.name),
          h("span", { class: "lbl" }, plan.symbol),
        ],
        reviewStatuses && h("span", { class: "lbl" }, `復盤：${reviewLabel}`),
      );
    }),
  );
}

export async function render(root, { db }) {
  const today = todayStr();
  const [{ settings, plans, portfolio, pendingCounts }, evidence] = await Promise.all([
    loadPortfolio(db, today), db.listEvidenceDirections(),
  ]);
  const held = portfolio.positions.filter(({ plan }) => plan.status === "active");
  const heldIds = new Set(held.map(({ plan }) => plan.id));
  const closed = plans.filter((plan) => plan.status === "closed");
  const reviews = closed.length ? await db.listExitReviews() : [];
  const reviewStatuses = new Map(reviews.map(({ plan_id, status }) => [plan_id, status]));
  if (!root.isConnected) return;
  if (!settings.start_date) {
    root.append(h("section", { class: "card risk-notice" },
      h("p", null, "請先到設定填寫起始日與起始現金"),
      h("a", { class: "btn", href: "#settings" }, "前往設定"),
    ));
  }
  root.append(riskCard(portfolio, settings));
  const missing = portfolio.missing_prices.filter((item) => item !== "HKD 匯率");
  if (missing.length) {
    root.append(h("p", { class: "lbl" }, `以下代碼尚無行情，暫用成本計算：${missing.join("、")}`));
  }
  if (portfolio.missing_prices.includes("HKD 匯率")) {
    root.append(h("p", { class: "lbl" }, "HKD 匯率尚無資料，暫按 1 換算。"));
  }
  if (!plans.length) {
    root.append(h("section", { class: "card" },
      h("p", { class: "empty compact" }, "還沒有計劃卡。買入之前，先寫下理由。"),
      newPlanLink(),
    ));
    return;
  }
  root.append(h("section", { class: "card holdings-list" },
    h("h2", null, "持有中"),
    held.length ? held.map((pos) => holdingRow(pos, evidence.get(pos.plan.id), today, pendingCounts.get(pos.plan.id)))
      : h("p", { class: "lbl" }, "目前沒有持倉"),
  ));
  for (const [title, group, route, statuses] of [
    ["已鎖定、未買入", plans.filter((plan) => plan.status === "active" && !heldIds.has(plan.id)), "plan"],
    ["草稿", plans.filter((plan) => plan.status === "draft"), "plan-new"],
    ["已清倉", closed, "plan", reviewStatuses],
  ]) {
    const section = planList(title, group, route, statuses, pendingCounts);
    if (section) root.append(section);
  }
}
