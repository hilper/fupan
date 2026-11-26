import { latestFx } from "../calc.js";
import { todayStr } from "../format.js";
import { recognizeReview } from "../ocr.js";
import { isReviewDate, parseReviewLines, reviewFlags, tradeKey } from "../ocr-parse.js";
import { confirmDialog, decimalInput, field, h, missingPlan } from "../ui.js";

export const title = "從截圖匯入成交";

const directions = { buy: "買入", sell: "賣出", dividend: "派息" };
const inactiveMessage = "只有已鎖定且尚未清倉的計劃卡可以匯入成交";
const importingPlans = new Set();

function mergeScreenshots(screenshots) {
  const merged = [];
  const seen = new Map();
  let lastSection = -1;
  for (const [index, rows] of screenshots.entries()) {
    const sections = new Map([[-1, lastSection]]);
    // 有重疊列時，沿用先前圖片的段落，避免重複拍到的標題被當成新段。
    for (const row of rows) {
      const match = seen.get(tradeKey(row));
      if (row.section >= 0 && match != null && !sections.has(row.section)) {
        sections.set(row.section, match);
      }
    }
    let section = lastSection;
    const newKeys = new Map();
    for (const row of rows) {
      const key = tradeKey(row);
      if (!sections.has(row.section)) sections.set(row.section, index === 0 ? row.section : section + 1);
      section = sections.get(row.section);
      if (seen.has(key)) continue;
      newKeys.set(key, section);
      merged.push({ ...row, section, defaultSection: index === 0 && row.section === 0 });
    }
    for (const [key, value] of newKeys) seen.set(key, value);
    lastSection = section;
  }
  return merged;
}

function valueError(row, today) {
  if (!isReviewDate(row.trade_date) || row.trade_date > today) return "請輸入今天或之前的有效日期";
  if (!(row.quantity > 0)) return "數量須大於 0";
  if (!(row.price > 0)) return "價格須大於 0";
  if (row.fee == null || row.fee < 0) return "費用須為 0 或以上";
  return "";
}

function checkHoldings(existing, selected) {
  // 已記錄成交依資料庫順序，同日新成交按截圖由下往上補入。
  const timeline = [...existing, ...selected].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
  let units = 0;
  for (const row of timeline) {
    const quantity = Math.round(Number(row.quantity) * 10000);
    units += row.side === "buy" ? quantity : -quantity;
    if (units < 0) throw new Error(`賣出超過持股：${row.trade_date}`);
  }
  if (units === 0) {
    throw new Error("匯入後持股為 0。清倉那筆請用『記一筆成交』記錄，才會產生單筆復盤");
  }
}

export async function render(root, ctx) {
  const { db, params, navigate, toast } = ctx;
  const plan = await db.getPlan(params[0]);
  if (!root.isConnected) return;
  if (!plan) return missingPlan(root);
  const back = `#plan/${plan.id}`;
  if (plan.status !== "active") {
    root.append(h("section", { class: "card" },
      h("p", null, inactiveMessage),
      h("a", { class: "btn", href: back }, "返回計劃卡"),
    ));
    return;
  }

  let recorded = new Set((await db.listTrades(plan.id)).map(tradeKey));
  if (!root.isConnected) return;
  let entries = [];
  const picker = h("input", { type: "file", accept: "image/*", multiple: true, onchange: readFiles });
  const status = h("p", { class: "form-status", role: "status" });
  const errorText = h("p", { class: "form-error", role: "alert" });
  const list = h("div", { class: "form-stack" });
  const submit = h("button", {
    class: "btn pri", type: "button", hidden: true, disabled: true, onclick: save,
  }, "匯入 0 筆");
  const controls = h("fieldset", { class: "form-stack plan-form-fields" },
    field("選擇截圖", picker), status, list, errorText, submit,
  );
  root.append(
    h("p", { class: "lbl import-subtitle" }, `${plan.name} · ${plan.symbol}`),
    h("p", { class: "lbl" }, "支援券商『投资回顾』頁截圖；截圖只在手機上辨識，不會上傳。"),
    controls,
  );

  function updateCount() {
    const count = entries.filter(({ checkbox }) => checkbox.checked && !checkbox.disabled).length;
    submit.disabled = count === 0;
    submit.textContent = `匯入 ${count} 筆`;
  }

  function appendRow(row, number) {
    const direction = directions[row.kind];
    if (row.kind === "dividend") {
      const date = row.trade_date || "—";
      const amount = row.amount == null ? "—" : Math.abs(row.amount).toFixed(2);
      list.append(h("section", { class: "card" },
        h("div", { class: "lbl" }, `第 ${number} 筆 · ${direction} · ${date} · ${amount} · 股息不匯入`),
      ));
      return;
    }

    const checkbox = h("input", { type: "checkbox", onchange: updateCount });
    const date = h("input", { type: "date", inputmode: "decimal", value: row.trade_date });
    const quantity = h("input", { type: "text", inputmode: "decimal", value: row.quantity });
    const price = h("input", { type: "text", inputmode: "decimal", value: row.price });
    const fee = h("input", { type: "text", inputmode: "decimal", value: row.fee?.toFixed(2) });
    const note = h("p", { class: "lbl" });
    const warning = h("p", { class: "warn import-warning", role: "status" });
    const card = h("section", { class: "card" },
      h("div", { class: "record-head" },
        h("label", { class: "check-label" }, checkbox, `第 ${number} 筆 · ${direction}`), note,
      ),
      h("div", { class: "grid-two" },
        field("日期", date), field("數量", quantity), field("價格", price), field("費用", fee),
      ),
      warning,
    );
    let values = { ...row, side: row.kind };

    function refresh() {
      const duplicate = recorded.has(tradeKey(values));
      checkbox.disabled = duplicate;
      if (checkbox.disabled) checkbox.checked = false;
      note.textContent = duplicate ? "已記錄" : "";
      note.hidden = !note.textContent;
      warning.textContent = values.flags.join("、");
      warning.hidden = !values.flags.length;
      card.classList.toggle("import-row-warning", Boolean(values.flags.length));
    }

    function edit() {
      values = {
        ...values,
        trade_date: date.value,
        quantity: decimalInput(quantity.value.trim()),
        price: decimalInput(price.value.trim()),
        fee: decimalInput(fee.value.trim()),
      };
      values.flags = reviewFlags(values);
      if (!(values.quantity > 0)) values.flags.push("數量須大於 0");
      if (!(values.price > 0)) values.flags.push("價格須大於 0");
      if (values.fee == null && values.amount != null) values.flags.push("缺少費用");
      refresh();
      updateCount();
    }

    for (const input of [date, quantity, price, fee]) input.addEventListener("input", edit);
    refresh();
    checkbox.checked = row.defaultSection && !checkbox.disabled && !row.flags.length;
    entries.push({ number, checkbox, refresh, get values() { return values; } });
    list.append(card);
  }

  async function readFiles() {
    const files = Array.from(picker.files);
    if (!files.length) return;
    picker.value = "";
    controls.disabled = true;
    entries = [];
    list.replaceChildren();
    submit.hidden = true;
    errorText.textContent = "";
    status.textContent = "";
    try {
      const screenshots = [];
      for (const [index, file] of files.entries()) {
        if (!root.isConnected) return;
        const prefix = files.length > 1 ? `截圖 ${index + 1}/${files.length} · ` : "";
        try {
          const lines = await recognizeReview(file, {
            onProgress: (message) => { status.textContent = prefix + message; },
          });
          screenshots.push(parseReviewLines(lines).rows);
        } catch (error) {
          throw new Error(`${prefix}${error.message}`, { cause: error });
        }
      }
      if (!root.isConnected) return;
      const rows = mergeScreenshots(screenshots);
      let previousSection;
      for (const [index, row] of rows.entries()) {
        if (row.section !== 0 && row.section !== previousSection) {
          list.append(h("p", { class: "lbl import-section" }, "較早的持倉（預設不匯入）"));
        }
        appendRow(row, index + 1);
        previousSection = row.section;
      }
      submit.hidden = !rows.length;
      status.textContent = `已識別 ${files.length} 張截圖，共 ${rows.length} 筆`;
      if (!rows.length) status.append(h("br"), "找不到成交，請確認截圖包含『投资回顾』的成交列表。");
      updateCount();
    } catch (error) {
      status.textContent = "";
      errorText.textContent = error.message;
    } finally {
      controls.disabled = false;
    }
  }

  async function save() {
    if (controls.disabled || submit.disabled) return;
    if (importingPlans.has(plan.id)) {
      errorText.textContent = "這張計劃卡正在匯入成交，請稍候再試";
      return;
    }
    importingPlans.add(plan.id);
    controls.disabled = true;
    errorText.textContent = "";
    try {
      const [currentPlan, existing] = await Promise.all([db.getPlan(plan.id), db.listTrades(plan.id)]);
      if (!root.isConnected) return;
      if (currentPlan?.status !== "active") throw new Error(inactiveMessage);
      recorded = new Set(existing.map(tradeKey));
      for (const entry of entries) entry.refresh();
      updateCount();

      const today = todayStr();
      const checked = entries.filter(({ checkbox }) => checkbox.checked && !checkbox.disabled);
      if (!checked.length) return;
      for (const entry of checked) {
        const problem = valueError(entry.values, today);
        if (problem) throw new Error(`第 ${entry.number} 筆：${problem}`);
      }
      const selected = checked.reverse().map(({ values }) => values)
        .sort((a, b) => a.trade_date.localeCompare(b.trade_date));
      checkHoldings(existing, selected);

      const count = selected.length;
      const buys = selected.filter((row) => row.side === "buy").length;
      const summary = `匯入 ${count} 筆：買入 ${buys} 筆、賣出 ${count - buys} 筆，`
        + `最早 ${selected[0].trade_date}、最晚 ${selected[count - 1].trade_date}`;
      if (!await confirmDialog(summary) || !root.isConnected) return;

      const hk = currentPlan.market === "HK";
      const currency = hk ? "HKD" : "CNY";
      let written = 0;
      try {
        const fxRows = hk ? await db.listFx() : [];
        for (const { side, trade_date, quantity, price, fee } of selected) {
          const fx_to_cny = hk ? latestFx(fxRows, trade_date) : 1;
          if (!(fx_to_cny > 0)) throw new Error(`找不到 ${trade_date} 可用的港幣匯率`);
          const trade = { plan_id: plan.id, side, trade_date, quantity, price, fee, currency, fx_to_cny };
          const saved = await db.addTrade({ ...trade, in_plan: true, reason: "" });
          written++;
          recorded.add(tradeKey(trade));
          if (saved) recorded.add(tradeKey(saved));
        }
      } catch (error) {
        for (const entry of entries) entry.refresh();
        updateCount();
        throw new Error(
          `已匯入 ${written} 筆，第 ${written + 1} 筆失敗：${error.message}；重新匯入會自動略過已記錄的`,
          { cause: error },
        );
      }
      toast(`已匯入 ${count} 筆`);
      if (root.isConnected) navigate(back, { replace: true });
    } catch (error) {
      errorText.textContent = error.message;
    } finally {
      controls.disabled = false;
      importingPlans.delete(plan.id);
    }
  }
}
