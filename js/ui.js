import { fmtDate, fmtMoney, fmtPct } from "./format.js";

export function h(tag, attrs, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value == null) continue;
    if (name === "dataset") {
      Object.assign(element.dataset, value);
    } else if (name.startsWith("on") && typeof value === "function") {
      element.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (typeof value === "boolean" && !name.startsWith("aria-")) {
      element.toggleAttribute(name, value);
    } else {
      element.setAttribute(name, value);
    }
  }

  for (const child of children.flat(Infinity)) {
    if (child == null || typeof child === "boolean") continue;
    if (child instanceof Node) {
      element.append(child);
    } else {
      const text = document.createTextNode("");
      text.textContent = String(child);
      element.append(text);
    }
  }
  return element;
}

export function toast(msg, kind) {
  const region = document.getElementById("toast-region");
  const notice = h("div", { class: kind === "error" ? "toast error" : "toast" }, msg);
  region.append(notice);
  setTimeout(() => notice.remove(), 5500);
}

export function confirmDialog(text) {
  const dialog = h("dialog", { "aria-label": "確認操作" },
    h("form", { method: "dialog", class: "stack" },
      h("p", null, text),
      h("div", { class: "dialog-actions" },
        h("button", { class: "btn", value: "cancel", autofocus: true }, "取消"),
        h("button", { class: "btn pri", value: "confirm" }, "確認"),
      ),
    ),
  );
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "confirm");
    }, { once: true });
    dialog.showModal();
  });
}

let fieldId = 0;

export function field(label, input, hint, error) {
  input.id ||= `field-${++fieldId}`;
  const hintId = `${input.id}-hint`;
  const errorId = `${input.id}-error`;
  input.setAttribute("aria-describedby", hint ? `${hintId} ${errorId}` : errorId);
  if (error) input.setAttribute("aria-invalid", "true");
  return h("div", { class: "field" },
    h("label", { class: "lbl", for: input.id }, label),
    input,
    hint && h("p", { class: "lbl", id: hintId }, hint),
    h("p", { class: "field-error", id: errorId, "aria-live": "polite" }, error),
  );
}

export function seg(options, value, onChange, labelId) {
  const group = h("div", { class: "seg", role: "group", "aria-labelledby": labelId });
  for (const option of options) {
    group.append(h("button", {
      type: "button",
      "aria-pressed": option.value === value,
      onclick: (event) => {
        for (const button of group.children) {
          button.setAttribute("aria-pressed", button === event.currentTarget);
        }
        onChange(option.value);
      },
    }, option.label));
  }
  return group;
}

export function choiceField(label, options, initial = "", onChange) {
  const labelId = `field-${++fieldId}`;
  let value = initial;
  return {
    element: h("div", { class: "field" },
      h("span", { class: "lbl", id: labelId }, label),
      seg(options, value, (selected) => {
        value = selected;
        onChange?.(selected);
      }, labelId),
    ),
    get value() { return value; },
  };
}

export function decisionForm(fields, submitLabel, save, className = "card") {
  const errorText = h("p", { class: "form-error", role: "alert" });
  const controls = h("fieldset", { class: "form-stack plan-form-fields" },
    fields, h("button", { type: "submit", class: "btn pri" }, submitLabel),
  );
  return h("form", {
    class: `${className} form-stack decision-form`, novalidate: true,
    onsubmit: async (event) => {
      event.preventDefault();
      if (controls.disabled) return;
      errorText.textContent = "";
      controls.disabled = true;
      try {
        await save();
      } catch (error) {
        errorText.textContent = error.message;
        controls.disabled = false;
      }
    },
  }, controls, errorText);
}

const localClock = new Intl.DateTimeFormat("zh-TW", {
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function localTimestamp(value, short = false) {
  if (!value) return "—";
  const date = new Date(value);
  const day = fmtDate(date);
  if (day === "—") return day;
  return `${short ? day.slice(5).replace("-", "/") : day} ${localClock.format(date)}`;
}

export function safeHttpUrl(value) {
  if (!/^https?:\/\//i.test(value ?? "")) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export const planSections = [
  ["買入理由", ["thesis"]],
  ["催化劑與時間", ["catalyst", "catalyst_due"]],
  ["預期報酬", ["expected_up_pct", "expected_down_pct"]],
  ["失效條件", ["invalidation", "stop_price"]],
  ["倉位", ["planned_weight_pct", "max_weight_pct"]],
  ["加倉 / 減倉條件", ["add_condition", "add_price", "reduce_condition", "reduce_price"]],
  ["目標與持有期", ["target", "target_price", "holding_period"]],
  ["信心程度", ["confidence"]],
  ["反方觀點", ["counter_view"]],
  ["情緒與信息來源", ["emotion_source"]],
];

// 欄位型別、合法範圍和是否可空，供草稿與修訂共用。
export const planFields = {
  thesis: { label: "買入理由", type: "long" },
  catalyst: { label: "催化劑", type: "long" },
  catalyst_due: { label: "催化劑時間", type: "date" },
  expected_up_pct: { label: "預期上漲 (%)", type: "percent", max: 1000 },
  expected_down_pct: { label: "預期下跌 (%)", type: "percent", max: 1000 },
  invalidation: { label: "基本面失效條件", type: "long" },
  stop_price: { label: "止損價", type: "price" },
  planned_weight_pct: { label: "計劃倉位 (%)", type: "percent", max: 100 },
  max_weight_pct: { label: "最高倉位 (%)", type: "percent", max: 100 },
  add_condition: { label: "加倉條件", type: "long" },
  add_price: { label: "加倉價", type: "price", optional: true },
  reduce_condition: { label: "減倉條件", type: "long" },
  reduce_price: { label: "減倉價", type: "price", optional: true },
  target: { label: "目標", type: "long" },
  target_price: { label: "目標價", type: "price", optional: true },
  holding_period: { label: "持有期", type: "text" },
  confidence: { label: "信心 (%)", type: "range" },
  counter_view: { label: "反方觀點", type: "long" },
  emotion_source: { label: "情緒與信息來源", type: "long" },
  next_review_date: { label: "下次複查日", type: "date" },
};

export const supplementPlanFields = [
  "catalyst", "catalyst_due", "expected_up_pct", "expected_down_pct", "invalidation",
  "max_weight_pct", "add_condition", "add_price", "reduce_condition", "reduce_price",
  "target", "target_price", "holding_period", "confidence", "counter_view", "emotion_source",
];

export function isPlanValueBlank(value) {
  // 與資料庫 trim() 的空白判定一致。
  return value == null || (typeof value === "string" && value.replaceAll(" ", "") === "");
}

export function missingSupplementFields(plan) {
  return supplementPlanFields.filter((key) => isPlanValueBlank(plan[key]));
}

export function displayPlanValue(key, value) {
  if (value == null || value === "") return "—";
  const { type } = planFields[key] ?? {};
  if (type === "price") return fmtMoney(value);
  if (type === "percent" || type === "range") return fmtPct(value);
  if (type === "date") return fmtDate(value);
  return value;
}

export const amendablePlanFields = [
  "stop_price", "add_price", "reduce_price", "target_price", "max_weight_pct", "planned_weight_pct",
  "invalidation", "add_condition", "reduce_condition", "target", "holding_period", "catalyst", "catalyst_due",
  "counter_view", "emotion_source", "confidence",
];

export function allowedPlanAmendments(rows) {
  return rows.filter((row) => amendablePlanFields.includes(row.field));
}

export function decimalInput(value) {
  return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number.isFinite(Number(value))
    ? Number(value) : null;
}

export function planInput(definition, value) {
  if (definition.type === "long") return h("textarea", { rows: 3 }, value);
  const numeric = definition.type === "price" || definition.type === "percent";
  return h("input", {
    type: numeric ? "text" : definition.type,
    inputmode: numeric ? "decimal" : null,
    min: definition.type === "range" ? 0 : null,
    max: definition.type === "range" ? 100 : null,
    value,
  });
}

export function confidenceField(value, label = planFields.confidence.label) {
  const input = planInput(planFields.confidence, value ?? 50);
  const wrapper = field(label, input);
  const current = h("output", { for: input.id }, value == null ? "尚未設定" : `${value}%`);
  const choose = h("button", {
    class: "btn", type: "button", hidden: value != null,
    onclick: () => input.dispatchEvent(new Event("change", { bubbles: true })),
  }, "採用目前滑桿數值");

  function selectValue() {
    current.textContent = `${input.value}%`;
    choose.hidden = true;
  }

  input.addEventListener("input", selectValue);
  input.addEventListener("change", selectValue);
  wrapper.append(current, choose);
  return { input, wrapper, get selected() { return choose.hidden; } };
}

function counterTime(value) {
  const fraction = (value?.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0");
  const millis = Date.parse(value?.replace(/\.\d+/, "." + fraction.slice(0, 3)));
  // Postgres 保留到微秒，Date.parse 只保留到毫秒。
  return Number.isFinite(millis) ? millis * 1000 + Number(fraction.slice(3, 6)) : -Infinity;
}

export function counterAdopted({ request, plan, amendments = [] }) {
  const view = request?.result?.counter_view;
  if (request?.status !== "done" || !view) return { adopted: false, at: null };

  let latest;
  let latestTime = -Infinity;
  for (const row of amendments) {
    if (row.field !== "counter_view") continue;
    const time = counterTime(row.created_at);
    if (!latest || time > latestTime ||
        (time === latestTime && Number(row.id ?? 0) > Number(latest.id ?? 0))) {
      latest = row;
      latestTime = time;
    }
  }

  const current = latest ? latest.new_value : plan.counter_view;
  if ((current ?? "").replace(/\s/g, "") === view.replace(/\s/g, "")) {
    return { adopted: true, at: (latest ? latest.created_at : request.done_at) ?? null };
  }
  if (request.done_at && latestTime > counterTime(request.done_at)) {
    return { adopted: true, at: latest.created_at };
  }
  return { adopted: false, at: null };
}

export function adoptedCounterView(result, { at, retry } = {}) {
  const date = fmtDate(at);
  const content = counterViewResult(result);
  content.hidden = true;
  const toggle = h("button", {
    type: "button", class: "btn text-btn counter-original", "aria-expanded": false,
    onclick: () => {
      content.hidden = !content.hidden;
      toggle.setAttribute("aria-expanded", !content.hidden);
      toggle.textContent = content.hidden ? "看 AI 原文" : "收起 AI 原文";
    },
  }, "看 AI 原文");
  return h("div", { class: "counter-adopted" },
    h("div", { class: "counter-adopted-row" },
      h("span", { class: "lbl" }, date === "—" ? "已採用 AI 看空理由"
        : `已採用 AI 看空理由（${date.slice(5).replace("-", "/")}）`),
      toggle, retry,
    ),
    content,
  );
}

export function counterViewResult(result, action) {
  return h("div", { class: "counter-result" },
    h("strong", null, "AI 的看空理由"),
    h("p", { class: "plan-read-text" }, result.counter_view),
    result.invalidation_checkable === false && h("p", { class: "warn plan-read-text" },
      `失效條件不易驗證：${result.invalidation_note}`),
    h("p", { class: "lbl" }, "AI 只是幫你找反方，是否同意由你決定"),
    action,
  );
}

export function readPlanInput(definition, input) {
  const raw = input.value.trim();
  if (definition.type === "date") {
    return { value: raw || null, error: input.validity.badInput ? "請輸入有效日期" : "" };
  }
  if (definition.type === "range") return { value: Number(raw) };
  if (!["percent", "price"].includes(definition.type)) return { value: raw };
  if (!raw) return { value: null };
  const value = decimalInput(raw);
  if (definition.type === "percent" && (value == null || value < 0 || value > definition.max)) {
    return { error: `請輸入 0–${definition.max} 的百分比` };
  }
  if (definition.type === "price" && (value == null || value <= 0)) {
    return { error: "價格須大於 0" };
  }
  return { value };
}

export function setFieldError(wrapper, input, message = "") {
  wrapper.querySelector(".field-error").textContent = message;
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

export function detailsValue(label, value, className = "", badge = false) {
  return h("div", { class: "details-value" },
    h("div", { class: "record-meta" }, h("span", { class: "lbl" }, label),
      badge && h("span", { class: "chip" }, "已修訂")),
    h("p", { class: className }, value ?? "—"),
  );
}

export function missingPlan(root) {
  root.replaceChildren(h("div", { class: "card" },
    h("p", null, "找不到這張計劃卡"),
    h("a", { class: "btn", href: "#holdings" }, "返回持倉"),
  ));
}

export function missingTodayItem(root, item, setBackTo) {
  setBackTo?.("#today");
  root.replaceChildren(h("div", { class: "card" },
    h("p", null, `找不到這則${item}`),
    h("a", { class: "btn", href: "#today" }, "返回今日"),
  ));
}

export function pnlColor(value) {
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "";
}

export const pnl_sources = [
  { value: "thesis", label: "理由應驗" },
  { value: "market", label: "大盤帶動" },
  { value: "valuation", label: "估值變化" },
  { value: "unrelated", label: "與理由無關" },
];

export const thesis_verdict = [
  { value: "right", label: "對" },
  { value: "wrong", label: "錯" },
  { value: "unclear", label: "無法判斷" },
];

export const decision_quality = [
  { value: "good", label: "好" },
  { value: "ok", label: "普通" },
  { value: "bad", label: "差" },
];

export const error_tags = [
  { value: "analysis", label: "分析錯誤", example: "理由本身錯了；漏看了關鍵風險" },
  { value: "information", label: "信息錯誤", example: "依賴了不可靠或過時的信息" },
  { value: "sizing", label: "倉位錯誤", example: "理由對但買太少；沒把握卻買太多" },
  { value: "entry", label: "進場錯誤", example: "追高、怕錯過、沒等條件成立就買" },
  { value: "exit", label: "出場錯誤", example: "碰到失效條件不賣；小賺就跑" },
  { value: "discipline", label: "紀律錯誤", example: "沒寫計劃就下單；計劃外操作" },
  { value: "emotion", label: "情緒錯誤", example: "賠了想打回來、連賺後膨脹" },
];

export function shortDate(value) {
  const date = fmtDate(value);
  return date === "—" ? date : date.slice(5).replace("-", "/");
}

export function signedPct(value) {
  return value == null ? "—" : `${value > 0 ? "+" : ""}${fmtMoney(value)}%`;
}

export function reviewDeadline(dueDate, today) {
  // SQL 日期以 UTC 午夜相減，避免日光節約時間影響日數。
  const days = (Date.parse(dueDate) - Date.parse(today)) / 86400000;
  const label = days === 0 ? "今天到期" : days < 0 ? `已逾期 ${-days} 天` : `剩 ${days} 天`;
  return h("span", { class: days < 0 ? "chip up" : "chip warn" }, label);
}
