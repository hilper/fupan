import { addDays, effectivePlan } from "../calc.js";
import { fmtDate, fmtMoney, fmtPct, todayStr } from "../format.js";
import {
  allowedPlanAmendments, choiceField, decisionForm, detailsValue, displayPlanValue, field, h,
  localTimestamp, missingTodayItem, planFields,
} from "../ui.js";
import { directionOptions } from "./evidence.js";

const titles = {
  stop: "跌破止損線",
  add: "碰到加倉價",
  reduce: "碰到減倉價",
  target: "到達目標價",
  weight: "倉位超過上限",
  review_due: "到了複查日",
  catalyst_due: "催化劑時間已過",
  stale: "行情延遲",
};

const relevantFields = {
  stop: ["invalidation", "stop_price"],
  add: ["add_condition", "add_price"],
  reduce: ["reduce_condition", "reduce_price"],
  target: ["target", "target_price", "holding_period"],
  weight: ["planned_weight_pct", "max_weight_pct"],
  review_due: ["thesis", "invalidation"],
  catalyst_due: ["catalyst", "catalyst_due"],
};

const choices = {
  stop: ["hold", "reduce", "close"],
  add: ["add", "hold"],
  reduce: ["reduce", "close", "hold"],
  target: ["reduce", "close", "hold"],
  weight: ["reduce", "hold"],
  review_due: ["noted"],
  catalyst_due: ["noted"],
  stale: ["noted"],
};

function decisionLabel(kind, value) {
  if (value === "hold") {
    if (kind === "add") return "不動";
    if (kind === "weight") return "維持";
    return "繼續持有";
  }
  if (value === "noted") return kind === "stale" ? "知道了" : "已檢查";
  return { add: "加倉", reduce: "減倉", close: "清倉" }[value] ?? "—";
}

function alertTone(kind) {
  if (kind === "stop") return "up";
  return ["add", "reduce", "target", "weight"].includes(kind) ? "warn" : "";
}

function description({ kind, detail = {}, plans }) {
  switch (kind) {
    case "stop":
      return `收盤 ${fmtMoney(detail.close)}，低於止損線 ${fmtMoney(detail.stop_price ?? plans?.stop_price)}`;
    case "add":
    case "reduce":
    case "target":
      return `收盤 ${fmtMoney(detail.close)}，計劃價 ${fmtMoney(detail.level)}`;
    case "weight": {
      const scopes = { plan: "計劃卡最高倉位", single: "單票上限", sector: `行業（${detail.sector || "—"}）上限` };
      const weight = detail.weight_pct == null ? "—" : `${fmtMoney(detail.weight_pct)}%`;
      return `${scopes[detail.scope] ?? "倉位上限"} ${fmtPct(detail.limit_pct)}，現在 ${weight}`;
    }
    case "review_due":
      return `計劃複查日 ${fmtDate(detail.next_review_date)}`;
    case "catalyst_due":
      return `計劃寫的時間 ${fmtDate(detail.catalyst_due)}`;
    case "stale":
      return `行情停在 ${fmtDate(detail.last_price_date)}，Mac 可能沒有執行`;
    default:
      return "";
  }
}

function planIdentity(plan) {
  return plan ? `${plan.name} · ${plan.symbol}` : "組合";
}

export function actionableAlerts(alerts) {
  return alerts.filter((alert) => alert.kind !== "stale")
    .sort((a, b) => Number(b.kind === "stop") - Number(a.kind === "stop"));
}

export function alertCard(alert) {
  const tone = alertTone(alert.kind);
  return h("a", { class: `card action-card ${tone ? "alert-" + tone : ""}`, href: `#alert/${alert.id}` },
    h("div", { class: "record-head" },
      h("strong", null, planIdentity(alert.plans)),
      h("span", { class: `chip ${tone}` }, titles[alert.kind]),
    ),
    h("p", null, description(alert)),
    h("p", { class: "lbl" }, `觸發日 ${fmtDate(alert.trigger_date)} · 要寫理由 ›`),
  );
}

export function staleNotice(alert, ctx) {
  const acknowledge = h("button", { class: "btn text-btn", type: "button", onclick: async () => {
    if (acknowledge.disabled) return;
    acknowledge.disabled = true;
    try {
      await ctx.db.resolveAlert(alert.id, { resolution: "noted", resolution_note: "已知悉行情延遲" });
      notice.remove();
    } catch (error) {
      if (notice.isConnected) ctx.toast(error.message, "error");
      acknowledge.disabled = false;
    }
  } }, "知道了");
  const notice = h("div", { class: "stale-notice" }, h("p", { class: "lbl" }, description(alert)), acknowledge);
  return notice;
}

function resolvedResult(alert) {
  return h("section", { class: "card" },
    h("h2", null, "處理結果"),
    detailsValue("決定", decisionLabel(alert.kind, alert.resolution)),
    detailsValue("理由", alert.resolution_note),
    detailsValue("處理時間", localTimestamp(alert.resolved_at)),
  );
}

function renderDecision(root, ctx, alert, plan) {
  const { kind } = alert;
  const reviewDue = kind === "review_due";
  const catalystDue = kind === "catalyst_due";
  const hint = h("p", { class: "lbl", hidden: true },
    "止損價沒變的話，明天收盤仍低於止損線會再提醒。要調整請到計劃卡追加修訂。");
  const options = choices[kind].map((value) => ({ value, label: decisionLabel(kind, value) }));
  const decision = choiceField("決定", options, options.length === 1 ? options[0].value : "",
    (value) => { hint.hidden = kind !== "stop" || value !== "hold"; });
  const reason = h("textarea", { rows: 3, required: true });
  const today = todayStr();
  const reviewDate = reviewDue && h("input", {
    type: "date", value: addDays(today, 30), min: addDays(today, 1), required: true,
  });
  const result = catalystDue && h("textarea", { rows: 3, required: true });
  const direction = catalystDue && choiceField("影響", directionOptions);

  const form = decisionForm([
    decision.element, field("理由", reason, "至少 4 字"), hint,
    reviewDue && field("新的複查日期", reviewDate),
    catalystDue && field("催化劑結果", result, "至少 4 字"),
    catalystDue && direction.element,
  ], "確認處理", save);

  async function save() {
    const resolution = decision.value;
    let note = reason.value.trim();
    if (!resolution) throw new Error("請選擇決定");
    if ([...note].length < 4) throw new Error("理由至少 4 字");
    if (reviewDue && (!reviewDate.value || reviewDate.validity.badInput || reviewDate.value <= todayStr())) {
      throw new Error("新的複查日期須晚於今天");
    }
    const resultText = catalystDue ? result.value.trim() : "";
    if (catalystDue && [...resultText].length < 4) throw new Error("催化劑結果至少 4 字");
    if (catalystDue && !direction.value) throw new Error("請選擇催化劑結果的影響");

    if (reviewDue || catalystDue) {
      const latest = await ctx.db.getAlert(alert.id);
      if (latest?.status !== "open") throw new Error("這則提醒已處理過");
    }
    if (reviewDue) await ctx.db.setNextReview(alert.plan_id, reviewDate.value, { allowClosed: true });
    if (catalystDue) {
      const evidence = await ctx.db.addEvidence({
        plan_id: alert.plan_id,
        source_kind: "manual",
        source_name: "催化劑到期檢查",
        title: `催化劑：${[...(plan.catalyst ?? "")].slice(0, 40).join("")}`,
        excerpt: resultText,
        info_type: "fact",
        related_clause: "催化劑",
        direction: direction.value,
        user_conclusion: note,
        external_id: `catalyst-alert/${alert.id}`,
      });
      note = evidence.user_conclusion;
    }
    const resolved = await ctx.db.resolveAlert(alert.id, { resolution, resolution_note: note });
    if (!root.isConnected) return;
    ctx.toast("已處理");
    if (["add", "reduce", "close"].includes(resolution)) {
      form.replaceWith(resolvedResult(resolved), h("div", { class: "grid-two" },
        h("a", { class: "btn pri", href: `#trade/${alert.plan_id}` }, "去記這筆成交"),
        h("a", { class: "btn", href: "#today" }, "回今日"),
      ));
    } else {
      ctx.navigate("#today");
    }
  }

  return form;
}

export async function render(root, ctx) {
  const alert = await ctx.db.getAlert(ctx.params[0]);
  if (!root.isConnected) return;
  if (!alert) return missingTodayItem(root, "提醒", ctx.setBackTo);

  ctx.setTitle(titles[alert.kind]);
  ctx.setSubtitle(planIdentity(alert.plans));
  ctx.setBackTo(ctx.itemBackTo(alert.plan_id));
  const tone = alertTone(alert.kind);
  root.append(h("div", { class: `card ${tone ? "alert-" + tone : ""}` },
    h("p", null, description(alert)),
    h("p", { class: "lbl" }, `觸發日 ${fmtDate(alert.trigger_date)}`),
  ));
  if (alert.status === "resolved") {
    root.append(resolvedResult(alert));
    return;
  }

  let plan = null;
  const fields = relevantFields[alert.kind];
  if (alert.plan_id != null && fields) {
    const [original, amendments] = await Promise.all([
      ctx.db.getPlan(alert.plan_id), ctx.db.listAmendments(alert.plan_id),
    ]);
    if (!root.isConnected) return;
    if (!original) return missingTodayItem(root, "提醒", ctx.setBackTo);
    plan = effectivePlan(original, allowedPlanAmendments(amendments));
    root.append(h("section", { class: "card" },
      h("h2", null, "計劃卡怎麼說"),
      fields.map((key) => detailsValue(
        planFields[key].label, displayPlanValue(key, plan[key]), "", plan.amended.has(key),
      )),
    ));
  }
  root.append(renderDecision(root, ctx, alert, plan));
}
