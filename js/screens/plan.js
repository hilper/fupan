import { addDays, buildPositions, effectivePlan, planChecks, tradeReturn } from "../calc.js";
import { fmtDate, fmtMoney, fmtPct, todayStr } from "../format.js";
import {
  aiCounterViewBlock, allowedPlanAmendments, amendablePlanFields, confidenceField,
  detailsValue, displayPlanValue, field, h, isPlanValueBlank, missingPlan,
  missingSupplementFields, planCheckPanel, planCheckResult, planChecksCard, planFields,
  planInput, planSections, planTimestamp, pnlColor, readPlanInput, setFieldError,
} from "../ui.js";
import { actionableAlerts, alertCard } from "./alert.js";
import { evidenceLogRow } from "./evidence.js";
import { loadPortfolio } from "./holdings.js";

export async function finalizeClose(db, plan, today) {
  const trades = await db.listTrades(plan.id);
  const last = trades[trades.length - 1];
  if (last?.side !== "sell" || last.trade_date > today ||
      buildPositions(trades, today).get(plan.id)?.quantity !== 0) return null;

  let review = await db.getExitReview(plan.id);
  if (!review) {
    const firstBuy = trades.find((trade) => trade.side === "buy");
    const benchmark = plan.market === "HK" ? "HSI.HK" : "000300.SH";
    const closedDate = last.trade_date;
    const [start, end] = await Promise.all([
      firstBuy ? db.priceOn(benchmark, firstBuy.trade_date) : null,
      db.priceOn(benchmark, closedDate),
    ]);
    const deviations = trades.filter((trade) => trade.in_plan === false)
      .map(({ id, trade_date, side, quantity, price, reason }) => ({
        trade_id: id, trade_date, side, quantity, price, reason,
      }));
    try {
      review = await db.createExitReview({
        plan_id: plan.id,
        closed_date: closedDate,
        due_date: addDays(closedDate, 3),
        ...tradeReturn(trades, start, end),
        deviations,
        status: "draft",
      });
    } catch (error) {
      if (error.cause?.code !== "23505") throw error;
      review = await db.getExitReview(plan.id);
      if (!review) throw error;
    }
  }
  await db.closePlan(plan.id);
  return review;
}

function planContent(plan, amendments, { missing = [], supplement, counterViewBlock, check } = {}) {
  const draft = plan.status === "draft";
  const sections = planSections.map(([title, keys], index) => {
    return h("section", { class: "plan-read-section" },
      h("h3", null, `${index + 1}　${title}`),
      keys.map((key) => {
        const blank = isPlanValueBlank(plan[key]);
        const label = index === 8 && key === "counter_view" ? "我寫的" : planFields[key].label;
        return detailsValue(label, blank ? "待補" : displayPlanValue(key, plan[key]),
          blank ? "plan-pending" : "", plan.amended?.has(key));
      }),
      index === 2 && plan.expected_up_pct != null && Number(plan.expected_down_pct) > 0 &&
        h("p", { class: "lbl" }, `賺賠比 ${(plan.expected_up_pct / plan.expected_down_pct).toFixed(1)} : 1`),
      index === 8 && !draft && counterViewBlock,
    );
  });
  return h("section", { class: "card" },
    h("div", { class: "record-head" },
      h("div", { class: "record-meta" }, h("h2", null, "計劃卡"),
        missing.length > 0 && h("span", { class: "plan-pending" }, `待補 ${missing.length} 項`)),
      !draft && h("span", { class: "lbl" }, `${fmtDate(plan.locked_at)} 鎖定 · 修訂 ${amendments.length} 次`)),
    supplement,
    sections,
    check && h("section", { class: "plan-read-section" }, check),
    draft && plan.next_review_date && detailsValue("下次複查日", fmtDate(plan.next_review_date)),
  );
}

async function saveSupplement(root, ctx, planId, values) {
  await ctx.db.supplementPlan(planId, values);
  ctx.toast("已補填");
  if (root.isConnected) await render(root, ctx);
}

function supplementForm(root, ctx, planId, missing) {
  const controls = missing.map((key) => {
    const definition = planFields[key];
    const confidence = key === "confidence" ? confidenceField() : null;
    const input = confidence?.input ?? planInput(definition);
    const wrapper = confidence?.wrapper ?? field(definition.label, input);
    input.addEventListener("input", () => {
      setFieldError(wrapper, input, readPlanInput(definition, input).error);
    });
    return { key, definition, input, wrapper, confidence };
  });
  const errorText = h("p", { class: "form-error", role: "alert" });
  const inputs = h("fieldset", { class: "form-stack plan-form-fields" },
    controls.map(({ wrapper }) => wrapper),
    h("button", { type: "submit", class: "btn pri" }, "儲存補填"),
  );

  async function save(event) {
    event.preventDefault();
    if (inputs.disabled) return;
    errorText.textContent = "";
    const values = {};
    let invalid = false;
    for (const { key, definition, input, wrapper, confidence } of controls) {
      if (confidence && !confidence.selected) continue;
      const { value, error } = readPlanInput(definition, input);
      setFieldError(wrapper, input, error);
      if (error) invalid = true;
      else if (!isPlanValueBlank(value)) values[key] = value;
    }
    if (invalid) return;
    if (!Object.keys(values).length) {
      errorText.textContent = "請至少補填一項";
      return;
    }
    inputs.disabled = true;
    try {
      await saveSupplement(root, ctx, planId, values);
    } catch (error) {
      errorText.textContent = error.cause?.message ?? error.message;
    } finally {
      inputs.disabled = false;
    }
  }

  const form = h("details", { class: "plan-supplement" },
    h("summary", { class: "btn" }, "補填空白項目"),
    h("form", { class: "form-stack", onsubmit: save, novalidate: true }, inputs, errorText),
  );
  return {
    form,
    focus(key) {
      const control = controls.find((item) => item.key === key);
      if (!control) return;
      form.open = true;
      control.input.scrollIntoView({ block: "center" });
      control.input.focus({ preventScroll: true });
    },
  };
}

function heading(plan, status) {
  return h("div", { class: "record-meta plan-meta" },
    h("span", { class: "lbl" }, `${plan.symbol} · ${plan.market === "HK" ? "港股" : "A 股"}`),
    h("span", { class: "chip" }, plan.role),
    h("span", { class: "chip" }, status),
  );
}

function positionCard(plan, held, position, quote) {
  const stop = Number(plan.stop_price);
  const distance = position?.stop_dist_pct ?? (quote && stop ? (quote.close / stop - 1) * 100 : null);
  return h("section", { class: "card" },
    h("h2", null, "持倉摘要"),
    h("div", { class: "grid-three" },
      detailsValue("股數", held?.quantity ?? 0),
      detailsValue("平均成本", fmtMoney(held?.avg_cost)),
      detailsValue("現價", fmtMoney(quote?.close)),
      detailsValue("浮動盈虧", fmtPct(position?.pnl_pct), pnlColor(position?.pnl_pct)),
      detailsValue("距止損", fmtPct(distance), distance != null && distance <= 0 ? "warn" : ""),
      detailsValue("倉位", fmtPct(position ? position.weight_pct : 0)),
    ),
    h("p", { class: "lbl" }, quote ? `行情日期 ${fmtDate(quote.trade_date)}` : "尚無行情，Mac 下次更新後顯示"),
  );
}

function amendmentForm(root, ctx, plan) {
  const labels = { emotion_source: "情緒與來源", confidence: "信心" };
  const select = h("select", null, amendablePlanFields.map((key) =>
    h("option", { value: key }, labels[key] ?? planFields[key].label)));
  const valueField = h("div");
  const reason = h("textarea", { rows: 2, required: true });
  const reasonField = field("修訂理由", reason, "至少 4 字");
  const errorText = h("p", { class: "form-error", role: "alert" });
  const submit = h("button", { type: "submit", class: "btn pri" }, "追加修訂");
  let input;
  let wrapper;
  let confidence;

  function updateInput(value) {
    const definition = planFields[select.value];
    confidence = select.value === "confidence" ? confidenceField(value, "新值") : null;
    input = confidence?.input ?? planInput(definition, value);
    wrapper = confidence?.wrapper ?? field("新值", input);
    valueField.replaceChildren(wrapper);
    input.addEventListener("input", () => {
      setFieldError(wrapper, input, readPlanInput(definition, input).error);
    });
  }

  async function save(event) {
    event.preventDefault();
    if (formFields.disabled) return;
    errorText.textContent = "";
    const { value, error } = readPlanInput(planFields[select.value], input);
    const valueError = error || (isPlanValueBlank(value) || (confidence && !confidence.selected) ? "請填寫新值" : "");
    const why = reason.value.trim();
    const reasonError = [...why].length < 4 ? "理由至少 4 字" : "";
    setFieldError(wrapper, input, valueError);
    setFieldError(reasonField, reason, reasonError);
    if (valueError || reasonError) return;

    formFields.disabled = true;
    let written = false;
    try {
      await ctx.db.addAmendment({ plan_id: plan.id, field: select.value, new_value: String(value), reason: why });
      written = true;
      ctx.toast("已追加修訂");
      if (root.isConnected) await render(root, ctx);
    } catch (error) {
      errorText.textContent = error.message;
    } finally {
      formFields.disabled = written;
    }
  }

  select.addEventListener("change", () => updateInput());
  updateInput();
  const formFields = h("fieldset", { class: "form-stack plan-form-fields" },
    field("修訂欄位", select), valueField, reasonField, submit,
  );
  const form = h("form", { class: "flow-form form-stack", onsubmit: save, novalidate: true },
    formFields, errorText,
  );
  function prefill(key, value, why) {
    if (formFields.disabled) return;
    select.value = key;
    updateInput(value);
    reason.value = why;
    setFieldError(reasonField, reason);
    errorText.textContent = "";
    input.focus();
  }

  return {
    form,
    prefillPlanCheck(key) {
      prefill(key, plan[key], "依 AI 體檢改寫");
    },
  };
}

function reviewCard(root, ctx, plan, today) {
  const shownDate = h("p", null, fmtDate(plan.next_review_date));
  const title = h("h2", null, "下次複查");
  if (plan.status !== "active") return h("section", { class: "card" }, title, shownDate);
  const errorText = h("p", { class: "form-error", role: "alert" });
  const input = h("input", { type: "date", value: addDays(today, 30), required: true });
  const open = h("button", { class: "btn", type: "button", onclick: () => {
    input.value = input.defaultValue;
    errorText.textContent = "";
    form.hidden = false;
    open.hidden = true;
    input.focus();
  } }, "完成複查");
  const submit = h("button", { class: "btn pri", type: "submit" }, "更新複查日");
  const cancel = h("button", { class: "btn", type: "button", onclick: reset }, "取消");
  const form = h("form", { class: "form-stack", hidden: true, onsubmit: save },
    field("新的複查日期", input), h("div", { class: "grid-two" }, cancel, submit), errorText,
  );

  function reset() {
    form.hidden = true;
    open.hidden = false;
    open.focus();
  }

  async function save(event) {
    event.preventDefault();
    if (submit.disabled) return;
    errorText.textContent = "";
    submit.disabled = cancel.disabled = input.disabled = true;
    try {
      const result = await ctx.db.setNextReview(plan.id, input.value);
      shownDate.textContent = fmtDate(result.next_review_date);
      ctx.toast("已更新複查日期");
      if (root.isConnected) reset();
    } catch (error) {
      errorText.textContent = error.message;
    } finally {
      submit.disabled = cancel.disabled = input.disabled = false;
    }
  }

  return h("section", { class: "card" }, title, shownDate, open, form);
}

function tradeHistory(trades) {
  return h("section", { class: "card" },
    h("h2", null, "成交紀錄"),
    trades.length ? h("ul", { class: "record-list" }, trades.map((trade) =>
      h("li", { class: "record" },
        h("div", { class: "record-head" },
          h("strong", null, fmtDate(trade.trade_date), " · ", trade.side === "buy" ? "買入" : "賣出"),
          h("span", { class: trade.in_plan ? "chip" : "chip warn" }, trade.in_plan ? "計劃內" : "計劃外"),
        ),
        h("p", { class: "lbl" }, `${trade.quantity} 股 · 價格 ${fmtMoney(trade.price)} · 費用 ${fmtMoney(trade.fee)} ${trade.currency}`),
        !trade.in_plan && h("p", { class: "record-note warn" }, trade.reason),
      ),
    )) : h("p", { class: "lbl" }, "尚無成交"),
  );
}

function evidenceLog(plan, evidence) {
  return h("section", { class: "card" },
    h("div", { class: "record-head" },
      h("h2", null, "證據日誌"),
      ["active", "closed"].includes(plan.status) &&
        h("a", { class: "btn", href: `#evidence-new/${plan.id}` }, "＋ 加證據"),
    ),
    evidence.length ? h("ul", { class: "record-list" }, evidence.map(evidenceLogRow))
      : h("p", { class: "lbl" }, "還沒有證據。"),
  );
}

export async function render(root, ctx) {
  const { db, params, toast, setTitle } = ctx;
  const original = await db.getPlan(params[0]);
  if (!root.isConnected) return;
  if (!original) return missingPlan(root);
  setTitle(original.name);
  const related = [
    db.listOpenAlerts(original.id),
    db.listEvidence(original.id),
  ];
  if (original.status === "draft") {
    const [alerts, evidence] = await Promise.all(related);
    if (!root.isConnected) return;
    root.replaceChildren(heading(original, "草稿"),
      ...actionableAlerts(alerts).map(alertCard),
      h("a", { class: "btn pri", href: `#plan-new/${original.id}` }, "繼續編輯"),
      planContent(original, []),
      evidenceLog(original, evidence),
    );
    return;
  }

  const today = todayStr();
  const [amendments, trades, alerts, evidence, counterViews] = await Promise.all([
    db.listAmendments(original.id), db.listTrades(original.id),
    ...related,
    db.aiCounterViews(original.id).catch(() => null),
  ]);
  if (counterViews?.length && !counterViews.some((view) => view.changed)) {
    const lastChange = await db.latestChangedCounterView(original.id).catch(() => null);
    if (lastChange?.view_date < counterViews[0].view_date) counterViews.push(lastChange);
  }
  const held = buildPositions(trades, today).get(original.id);
  let review = original.status === "closed" ? await db.getExitReview(original.id) : null;
  let status = original.status;
  if (status === "active" && trades.length && held?.quantity === 0) {
    try {
      review = await finalizeClose(db, original, today);
      if (review) {
        status = "closed";
        if (root.isConnected) toast("已清倉，單筆復盤草稿已建立");
      }
    } catch (error) {
      if (root.isConnected) toast(error.message, "error");
    }
  }
  const plan = effectivePlan({ ...original, status }, allowedPlanAmendments(amendments));
  let position;
  let quote;
  let checks;
  if (status === "active") {
    const holding = held?.quantity > 0;
    const readSettings = () => db.getSettings().catch(() => null);
    const readQuote = () => db.latestPrices([plan.symbol]).then((prices) => prices.get(plan.symbol), () => null);
    const settingsRequest = holding ? null : readSettings();
    const holdingsRequest = holding ? loadPortfolio(db, today)
      : settingsRequest.then((settings) => settings?.start_date ? loadPortfolio(db, today) : null);
    const [holdings, history, directQuote] = await Promise.all([
      holdingsRequest.catch(() => null),
      db.getPlanCheckHistory().catch(() => null),
      holding ? null : readQuote(),
    ]);
    const settings = await (settingsRequest ?? holdings?.settings ?? readSettings());
    position = holdings?.portfolio.positions.find((item) => item.plan.id === plan.id);
    quote = holding ? (holdings ? holdings.latestPrices.get(plan.symbol) : await readQuote()) : directQuote;
    checks = planChecks({
      plan, settings, price: Number(quote?.close) || null,
      portfolio: settings?.start_date ? holdings?.portfolio ?? null : null,
      history,
    });
  } else {
    quote = (await db.latestPrices([original.symbol])).get(original.symbol);
  }

  const statusLabel = { closed: "已清倉", active: held?.quantity > 0 ? "持有中" : "已鎖定未買入" };
  const latestClosedCheck = status === "closed"
    ? await db.latestPlanCheck(plan.id, { doneOnly: true }).catch(() => null) : null;
  if (!root.isConnected) return;
  const missing = status === "active" ? missingSupplementFields(original) : [];
  const supplement = missing.length ? supplementForm(root, ctx, original.id, missing) : null;
  const amendment = status === "active" ? amendmentForm(root, ctx, plan) : null;
  const check = status === "active" ? planCheckPanel({
    load: () => db.latestPlanCheck(plan.id),
    send: () => db.requestPlanCheck(plan.id),
    changedAfter: (doneAt, result) =>
      amendments.some((row) => planTimestamp(row.created_at) > planTimestamp(doneAt)) ||
      result.issues.some(({ field, quote }) => {
        const source = String(plan[field] ?? "").replace(/\s/g, "");
        return quote ? !source.includes(quote.replace(/\s/g, "")) : source.length > 0;
      }),
    onFix(key) {
      if (isPlanValueBlank(plan[key])) {
        supplement?.focus(key);
      } else if (amendablePlanFields.includes(key)) {
        amendment.prefillPlanCheck(key);
      }
    },
  }) : null;
  root.replaceChildren(
    heading(plan, statusLabel[status]),
    ...actionableAlerts(alerts).map(alertCard),
    positionCard(plan, held, position, quote),
    status === "active" ? h("a", { class: "btn pri", href: `#trade/${plan.id}` }, "記一筆成交") : "",
    planContent(plan, amendments, {
      missing,
      supplement: supplement?.form,
      counterViewBlock: counterViews && aiCounterViewBlock(counterViews, { active: status === "active" }),
      check: check?.panel ?? (latestClosedCheck?.result && planCheckResult(latestClosedCheck.result)),
    }),
    checks && planChecksCard(checks),
    h("section", { class: "card" },
      h("h2", null, "修訂紀錄"),
      amendments.length ? h("ul", { class: "record-list" }, amendments.map((row) =>
        h("li", { class: "record" },
          h("div", { class: "record-head" },
            h("strong", null, planFields[row.field]?.label ?? row.field),
            h("time", { class: "lbl", datetime: row.created_at }, row.created_at
              ? new Date(row.created_at).toLocaleString("zh-TW", { hour12: false }) : "—"),
          ),
          h("p", { class: "plan-read-text" }, displayPlanValue(row.field, row.new_value)),
          h("p", { class: "record-note" }, row.reason),
        ),
      )) : h("p", { class: "lbl" }, "尚無修訂"),
      amendment?.form,
    ),
    evidenceLog(plan, evidence),
    reviewCard(root, ctx, plan, today),
    tradeHistory(trades),
    status === "closed" && review ? h("a", {
      class: "card review-action", href: `#exit-review/${review.id}`,
    },
      h("p", null, `單筆復盤：${review.status === "done" ? "已完成" : "草稿"}，到期日 ${fmtDate(review.due_date)}`),
    ) : "",
  );
  try {
    if (sessionStorage.getItem("fupan:scroll-counter") === String(plan.id)) {
      sessionStorage.removeItem("fupan:scroll-counter");
      root.querySelector("#ai-counter")?.closest(".plan-read-section")?.scrollIntoView({ block: "start" });
    }
  } catch {
    // sessionStorage 可能無法存取。
  }
  if (counterViews?.length) void db.markCounterViewsSeen(plan.id).catch(() => {});
  if (check) void check.refresh();
}
