import { addDays, buildPositions, effectivePlan, latestFx, outOfPlanStats, snapshot } from "../calc.js";
import { fmtMoney, todayStr } from "../format.js";
import { allowedPlanAmendments, confirmDialog, decimalInput, field, h, missingPlan, seg, setFieldError } from "../ui.js";
import { finalizeClose } from "./plan.js";
import { renderPause } from "./pause.js";

const sides = [{ value: "buy", label: "買入" }, { value: "sell", label: "賣出" }];

function checkSale(trade, trades) {
  if (trade.side !== "sell") return "";
  const held = buildPositions(trades, trade.trade_date).get(trade.plan_id)?.quantity ?? 0;
  if (trade.quantity > held) return `賣出數量不能超過該日持股，目前股數 ${held}`;
  // 補登賣出也會影響其後已登錄的賣出。以資料庫的數量精度檢查餘額。
  let units = Math.round((held - trade.quantity) * 10000);
  for (const later of trades) {
    if (later.trade_date <= trade.trade_date) continue;
    units += Math.round(Number(later.quantity) * 10000) * (later.side === "buy" ? 1 : -1);
    if (units < 0) return `這筆賣出會使 ${later.trade_date} 的已記錄賣出超過可用股數`;
  }
  return "";
}

export async function render(root, ctx) {
  const { db, navigate, params, toast } = ctx;
  const plan = await db.getPlan(params[0]);
  if (!root.isConnected) return;
  if (!plan) return missingPlan(root);
  const back = `#plan/${plan.id}`;
  if (plan.status !== "active") {
    root.append(h("section", { class: "card" },
      h("p", null, "只有已鎖定且尚未清倉的計劃卡可以記成交。"),
      h("a", { class: "btn", href: back }, "返回計劃卡"),
    ));
    return;
  }

  const hk = plan.market === "HK";
  const currency = hk ? "HKD" : "CNY";
  const today = todayStr();
  const fxRows = hk ? await db.listFx() : [];
  if (!root.isConnected) return;
  let side = "buy";
  let fxEdited = false;
  let writing = false;

  const date = h("input", { type: "date", value: today, max: today, required: true });
  const quantity = h("input", { type: "text", inputmode: "decimal", required: true });
  const price = h("input", { type: "text", inputmode: "decimal", required: true });
  const fee = h("input", { type: "text", inputmode: "decimal", value: "0", required: true });
  const fx = hk && h("input", {
    type: "text", inputmode: "decimal", value: latestFx(fxRows, today), required: true,
  });
  const dateField = field("成交日期", date);
  const quantityField = field("數量（股）", quantity, hk ? "整數股" : "整數股；買入通常為 100 的倍數");
  const priceField = field(`價格（${currency}）`, price);
  const feeField = field(`費用（${currency}）`, fee);
  const fxField = hk && field("匯率（1 港幣 = ? 人民幣）", fx);
  const errorText = h("p", { class: "form-error", role: "alert" });

  if (hk) {
    fx.addEventListener("input", () => { fxEdited = Boolean(fx.value.trim()); });
    const updateFx = () => {
      if (!fxEdited && date.value) fx.value = latestFx(fxRows, date.value) ?? "";
    };
    date.addEventListener("input", updateFx);
    date.addEventListener("change", updateFx);
  }

  const controls = h("fieldset", { class: "form-stack plan-form-fields" },
    h("section", { class: "card" },
      h("div", { class: "record-head" }, h("h2", null, plan.name), h("span", { class: "lbl" }, plan.symbol)),
      h("div", { class: "field" },
        h("span", { class: "lbl", id: "trade-direction" }, "方向"),
        seg(sides, side, (value) => { side = value; }, "trade-direction"),
      ),
      dateField, quantityField,
      h("div", { class: "grid-two" }, priceField, feeField),
      fxField,
    ),
    h("section", { class: "card" },
      h("h2", null, "這筆在計劃內嗎？"),
      h("div", { class: "grid-two" },
        h("button", { class: "btn pri", type: "button", onclick: () => submit(true) }, "在計劃內"),
        h("button", { class: "btn", type: "button", onclick: () => submit(false) }, "不在計劃內"),
      ),
    ),
  );
  root.append(h("form", { class: "form-stack", onsubmit: (event) => event.preventDefault() }, controls, errorText));

  function readValues() {
    const quantityText = quantity.value.trim();
    const qty = decimalInput(quantityText);
    const unitPrice = decimalInput(price.value.trim());
    const commission = decimalInput(fee.value.trim());
    const fxRate = hk ? decimalInput(fx.value.trim()) : 1;
    const dateError = !date.value || !date.validity.valid ? "請輸入今天或之前的日期" : "";
    let quantityError = "";
    if (qty != null && /\.\d*[1-9]/.test(quantityText)) {
      quantityError = "股數必須是整數。是不是把數量和價格填反了？";
    } else if (qty == null || qty <= 0) {
      quantityError = "數量須大於 0";
    }
    const priceError = unitPrice == null || unitPrice <= 0 ? "價格須大於 0" : "";
    const feeError = commission == null || commission < 0 ? "費用須為 0 或以上" : "";
    const fxError = fxRate == null || fxRate <= 0 ? "匯率須大於 0" : "";
    setFieldError(dateField, date, dateError);
    setFieldError(quantityField, quantity, quantityError);
    setFieldError(priceField, price, priceError);
    setFieldError(feeField, fee, feeError);
    if (hk) setFieldError(fxField, fx, fxError);
    if (dateError || quantityError || priceError || feeError || fxError) return null;
    return {
      plan_id: plan.id, side, trade_date: date.value, quantity: qty, price: unitPrice,
      fee: commission, currency, fx_to_cny: fxRate,
    };
  }

  function needsLotConfirmation(trade) {
    return !hk && trade.side === "buy" && trade.quantity % 100 !== 0;
  }

  function confirmTrade(trade) {
    const action = trade.side === "buy" ? "買入" : "賣出";
    const amount = fmtMoney(trade.quantity * trade.price);
    const summary = `${action} ${plan.name} ${trade.quantity} 股 · 每股 ${trade.price} ${currency} · 金額 ${amount} ${currency}`;
    if (!needsLotConfirmation(trade)) return confirmDialog(summary);
    const reminder = `A 股買入通常以 100 股為單位。確定是 ${trade.quantity} 股嗎？`;
    return confirmDialog(h("span", null, reminder, h("br"), summary));
  }

  async function submit(inPlan) {
    if (controls.disabled) return;
    errorText.textContent = "";
    const trade = readValues();
    if (!trade) return;

    controls.disabled = true;
    try {
      if (inPlan) {
        await saveTrade(trade, true, "");
        return;
      }

      const ownTrades = await db.listTrades(plan.id);
      const saleError = checkSale(trade, ownTrades);
      if (saleError) {
        setFieldError(quantityField, quantity, saleError);
        return;
      }
      const confirmBeforePause = needsLotConfirmation(trade);
      if (confirmBeforePause && !await confirmTrade(trade)) return;
      const [amendments, allTrades] = await Promise.all([db.listAmendments(plan.id), db.listTrades()]);
      const recentStart = addDays(today, -89);
      const previous = allTrades.filter((row) =>
        row.in_plan === false && row.trade_date >= recentStart && row.trade_date <= today);
      const prices = await db.latestPrices([plan.symbol, ...previous.map((row) => row.symbol)]);
      const effective = effectivePlan(plan, allowedPlanAmendments(amendments));
      const current = snapshot({
        settings: { start_cash: 0 }, plans: [effective], trades: ownTrades, cashFlows: [],
        latestPrices: prices, fxRows, today,
      }).positions[0];
      if (!root.isConnected) return;
      renderPause(root, ctx, {
        plan: effective, trade, quote: prices.get(plan.symbol), current,
        stats: outOfPlanStats(previous, prices, today),
        onConfirm: async (reason) => {
          if (await saveTrade(trade, false, reason, confirmBeforePause) === false) {
            pauseControls.disabled = false;
          }
        },
      });
      const pauseControls = root.querySelector("form fieldset");
    } catch (error) {
      errorText.textContent = error.message;
    } finally {
      controls.disabled = writing;
    }
  }

  async function saveTrade(trade, inPlan, reason, confirmed = false) {
    if (writing) return;
    writing = true;
    let written = false;
    try {
      if (!confirmed && !await confirmTrade(trade)) return false;
      if (!root.isConnected) return;
      if (trade.side === "sell") {
        const saleError = checkSale(trade, await db.listTrades(plan.id));
        if (saleError) {
          if (!inPlan) throw new Error(saleError);
          setFieldError(quantityField, quantity, saleError);
          return;
        }
      }
      if (!root.isConnected) return;
      await db.addTrade({ ...trade, in_plan: inPlan, reason });
      written = true;
      toast("已記錄");
      if (trade.side === "sell") {
        try {
          await finalizeClose(db, plan, today);
        } catch (error) {
          toast(error.message, "error");
        }
      }
      if (root.isConnected) navigate(back, { replace: true });
    } finally {
      writing = written;
    }
  }
}
