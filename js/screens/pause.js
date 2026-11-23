import { fmtDate, fmtMoney, fmtPct } from "../format.js";
import { detailsValue, field, h, pnlColor, setFieldError } from "../ui.js";

export function renderPause(root, { navigate, setTitle }, { plan, trade, quote, current, stats, onConfirm }) {
  setTitle("先停一下");
  window.scrollTo(0, 0);
  const side = trade.side === "buy" ? "買入" : "賣出";
  const quantity = `${trade.quantity} 股`;
  const distance = current?.stop_dist_pct ?? (quote && Number(plan.stop_price) > 0
    ? (Number(quote.close) / Number(plan.stop_price) - 1) * 100 : null);
  const comparison = h("section", { class: "card" },
    h("div", { class: "grid-two pause-columns" },
      h("section", { class: "pause-column" },
        h("h2", null, "計劃卡怎麼說"),
        detailsValue("買入理由", plan.thesis),
        detailsValue("失效條件", plan.invalidation),
        detailsValue("止損價", fmtMoney(plan.stop_price)),
        detailsValue("加倉條件", plan.add_condition),
        detailsValue("加倉價", fmtMoney(plan.add_price)),
        detailsValue("減倉條件", plan.reduce_condition),
        detailsValue("減倉價", fmtMoney(plan.reduce_price)),
        detailsValue("目標", plan.target),
        detailsValue("目標價", fmtMoney(plan.target_price)),
      ),
      h("section", { class: "pause-column" },
        h("h2", null, "現在的情況"),
        detailsValue("現價", quote ? fmtMoney(quote.close) : "尚無行情"),
        detailsValue("行情日期", fmtDate(quote?.trade_date)),
        detailsValue("浮動盈虧", fmtPct(current?.pnl_pct), pnlColor(current?.pnl_pct)),
        detailsValue("距止損", fmtPct(distance), distance != null && distance <= 0 ? "warn" : ""),
        detailsValue("這筆成交", side),
        detailsValue("數量", quantity),
        detailsValue("價格", `${fmtMoney(trade.price)} ${trade.currency}`),
      ),
    ),
  );
  const history = stats.count
    ? `近 90 天計劃外操作 ${stats.count} 次，${stats.avg_after_pct == null
      ? "尚無行情可計算事後平均" : `事後平均 ${fmtPct(stats.avg_after_pct)}`}`
    : "近 90 天沒有計劃外操作";
  const reason = h("textarea", { rows: 4, required: true });
  const reasonField = field("哪個條件變了？", reason, "請填寫計劃外成交理由，至少 4 字");
  const submit = h("button", { class: "btn", type: "submit", disabled: true }, "標記為計劃外並記錄");
  const cancel = h("button", {
    class: "btn pri", type: "button", onclick: () => navigate(`#plan/${plan.id}`),
  }, "取消，不做這筆");
  const errorText = h("p", { class: "form-error", role: "alert" });
  const controls = h("fieldset", { class: "form-stack plan-form-fields" }, reasonField, cancel, submit);
  reason.addEventListener("input", () => {
    const tooShort = [...reason.value.trim()].length < 4;
    setFieldError(reasonField, reason, tooShort ? "理由至少 4 字" : "");
    submit.disabled = tooShort;
  });

  async function save(event) {
    event.preventDefault();
    const why = reason.value.trim();
    if (controls.disabled || [...why].length < 4) return;
    errorText.textContent = "";
    controls.disabled = true;
    try {
      await onConfirm(why);
    } catch (error) {
      errorText.textContent = error.message;
      controls.disabled = false;
    }
  }

  root.replaceChildren(
    h("p", null, "你想", h("strong", null, `${side} ${plan.name} ${quantity}`), "。這筆成交在計劃之外。"),
    comparison,
    h("p", { class: "card risk-notice" }, history),
    h("form", { class: "form-stack", onsubmit: save }, controls, errorText),
  );
}
