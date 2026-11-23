import { addDays, planLossEstimate, symbolInfo } from "../calc.js";
import { fmtPct, todayStr } from "../format.js";
import {
  confirmDialog, field, h, missingPlan, planFields, planInput, planSections, readPlanInput,
  seg, setFieldError,
} from "../ui.js";

const roles = ["核心", "成長", "周期", "交易", "觀察"].map((role) => ({ value: role, label: role }));
const timeFormat = new Intl.DateTimeFormat("zh-TW", {
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export async function render(root, ctx) {
  const { db, navigate, params, toast } = ctx;
  const [draft, settings] = await Promise.all([
    params[0] ? db.getPlan(params[0]) : null,
    db.getSettings(),
  ]);
  if (!root.isConnected) return;
  if (params[0] && !draft) return missingPlan(root);
  if (draft && draft.status !== "draft") return navigate(`#plan/${draft.id}`, { replace: true });

  let id = draft?.id;
  const defaultReview = addDays(todayStr(), 30);
  const values = {
    ...draft,
    role: draft?.role ?? "觀察",
    next_review_date: draft?.next_review_date ?? defaultReview,
  };
  const pending = new Map();
  const invalid = new Set();
  let timer;
  let saving;
  let locking = false;
  let reviewedDate = false;
  let readyToCreate = false;
  let counterInput;
  let counterRequest;
  let counterBusy = false;
  let counterError = "";

  const completion = h("strong", { "aria-live": "polite" });
  const saveStatus = h("p", { class: "form-status", role: "status" });
  const saveError = h("p", { class: "form-error", role: "alert" });
  const lockError = h("p", { class: "form-error", role: "alert" });
  const retry = h("button", { class: "btn", type: "button", hidden: true, onclick: flush }, "重試保存");
  const market = h("p", { class: "lbl", "aria-live": "polite" });
  const ratio = h("p", { class: "plan-calculation" });
  const loss = h("p", { class: "plan-calculation" });
  const missing = h("p", { class: "lbl" });
  const lock = h("button", { class: "btn pri", type: "submit" }, "鎖定計劃卡");
  const askCounter = h("button", {
    class: "btn", type: "button", onclick: requestCounterView,
  }, "請 AI 寫最強的看空理由");
  const refreshCounter = h("button", {
    class: "btn text-btn counter-refresh", type: "button", hidden: true, onclick: loadCounterView,
  }, "重新整理");
  const counterStatus = h("p", { class: "form-status", role: "status" });
  const counterResult = h("div", { class: "counter-result", hidden: true });
  const counterPanel = h("div", { class: "counter-panel" },
    h("div", { class: "counter-actions" }, askCounter, refreshCounter), counterStatus, counterResult,
  );

  function waitingForCounter() {
    return ["queued", "running"].includes(counterRequest?.status);
  }

  function updateCounterButtons() {
    askCounter.disabled = !id || counterBusy || waitingForCounter();
    refreshCounter.disabled = counterBusy;
    refreshCounter.hidden = !id || !(waitingForCounter() || counterError || counterRequest?.status === "error");
  }

  function showCounterView() {
    updateCounterButtons();
    const { status, error, result } = counterRequest ?? {};
    counterStatus.textContent = counterError || (
      waitingForCounter() ? "已送出，Mac 約 10 分鐘內處理"
        : status === "error" ? error || "反方觀點處理失敗" : ""
    );
    const hasError = Boolean(counterError || status === "error");
    counterStatus.classList.toggle("form-status", !hasError);
    counterStatus.classList.toggle("form-error", hasError);
    const view = status === "done" && result?.counter_view;
    counterResult.hidden = !view;
    counterResult.replaceChildren();
    if (view) {
      counterResult.append(
        h("strong", null, "AI 的看空理由"),
        h("p", { class: "plan-read-text" }, view),
      );
      if (result.invalidation_checkable === false) {
        counterResult.append(h("p", { class: "warn plan-read-text" },
          `失效條件不易驗證：${result.invalidation_note}`));
      }
      counterResult.append(
        h("button", { class: "btn", type: "button", onclick: () => {
          counterInput.value = view;
          counterInput.dispatchEvent(new Event("input", { bubbles: true }));
        } }, "採用到第 9 欄"),
        h("p", { class: "lbl" }, "AI 只是幫你找反方，是否同意由你決定"),
      );
    }
  }

  async function loadCounterView() {
    if (!id || counterBusy) return;
    counterBusy = true;
    updateCounterButtons();
    try {
      counterRequest = await db.latestCounterView(id);
      counterError = "";
    } catch (error) {
      counterError = error.message;
    } finally {
      counterBusy = false;
      if (root.isConnected) showCounterView();
    }
  }

  async function requestCounterView() {
    if (askCounter.disabled || locking) return;
    counterBusy = true;
    counterError = "";
    updateCounterButtons();
    try {
      if (!await flush()) {
        counterError = saveError.textContent;
        return;
      }
      if (locking || !root.isConnected) return;
      counterRequest = await db.requestCounterView(id);
    } catch (error) {
      counterError = error.message;
    } finally {
      counterBusy = false;
      if (root.isConnected) showCounterView();
    }
  }

  function record(key, value) {
    if (values[key] === value) return;
    values[key] = value;
    pending.set(key, value);
  }

  function updateField(key, wrapper, input, value, error) {
    setFieldError(wrapper, input, error);
    if (error) {
      invalid.add(key);
      pending.delete(key);
      delete values[key];
      if (key === "symbol") {
        pending.delete("market");
        delete values.market;
      }
      return;
    }
    invalid.delete(key);
    record(key, value);
  }

  function schedule() {
    clearTimeout(timer);
    if (id || readyToCreate) timer = setTimeout(flush, 800);
  }

  function identity(key, label) {
    const input = h("input", { type: "text", value: values[key], autocomplete: "off" });
    const wrapper = field(label, input);

    function read(commit) {
      const raw = input.value.trim();
      if (key === "symbol") {
        const info = symbolInfo(raw);
        updateField(key, wrapper, input, info?.symbol,
          !info && (raw || id) ? "代碼格式不對" : "");
        market.textContent = info ? `${info.symbol} · ${info.market === "HK" ? "港股" : "A 股"}` : "";
        if (info) {
          record("market", info.market);
          if (commit) input.value = info.symbol;
        }
      } else {
        updateField(key, wrapper, input, raw, !raw && id ? "此欄必填" : "");
      }
      refresh();
      if (commit) {
        readyToCreate = identityComplete();
        void flush();
      } else {
        schedule();
      }
    }

    input.addEventListener("input", () => read(false));
    input.addEventListener("change", () => read(true));
    input.addEventListener("blur", () => {
      if (!id && !saving && !saveError.textContent) read(true);
    });
    return wrapper;
  }

  const codeField = identity("symbol", "代碼");
  const nameField = identity("name", "名稱");
  const sectorField = identity("sector", "行業");
  if (draft) market.textContent = `${draft.symbol} · ${draft.market === "HK" ? "港股" : "A 股"}`;

  const dateSeen = h("input", { type: "checkbox" });
  dateSeen.addEventListener("change", () => {
    reviewedDate = dateSeen.checked;
    if (reviewedDate && !draft?.next_review_date && values.next_review_date) {
      pending.set("next_review_date", values.next_review_date);
    }
    refresh();
    void flush();
  });

  function editor(key) {
    const definition = planFields[key];
    const input = planInput(definition, values[key] ?? (key === "confidence" ? 50 : null));
    if (key === "counter_view") counterInput = input;
    const wrapper = field(definition.label, input, definition.optional ? "可留空" : null);
    const current = key === "confidence" && h("output", { for: input.id },
      values[key] == null ? "尚未設定" : `${values[key]}%`);
    const choose = current && h("button", {
      class: "btn", type: "button", hidden: values[key] != null, onclick: () => read(true),
    }, "採用目前滑桿數值");

    function read(commit) {
      const { value, error } = readPlanInput(definition, input);
      updateField(key, wrapper, input, value, error);
      if (current) {
        current.textContent = `${value}%`;
        choose.hidden = true;
      }
      if (key === "next_review_date") {
        reviewedDate = false;
        dateSeen.checked = false;
      }
      refresh();
      if (commit) void flush();
      else schedule();
    }

    input.addEventListener("input", () => read(false));
    input.addEventListener("change", () => read(true));
    if (current) wrapper.append(current, choose);
    return wrapper;
  }

  const sections = planSections.map(([title, keys], index) => {
    const state = h("span", { class: "lbl" });
    const number = h("span", { class: "plan-step", "aria-hidden": "true" }, index + 1);
    const fields = new Map(keys.map((key) => [key, editor(key)]));
    const pair = (...items) => h("div", { class: "grid-two" }, items.map((key) => fields.get(key)));
    let content = [...fields.values()];
    if (index === 2) content = [pair(...keys), ratio];
    if (index === 4) content = [pair(...keys), loss];
    if (index === 5) content = [pair(...keys.slice(0, 2)), pair(...keys.slice(2))];
    if (index === 8) content.unshift(counterPanel);
    return {
      title, keys, state, number,
      card: h("section", { class: "card plan-step-card" },
        h("header", { class: "plan-step-heading" }, number, h("h2", null, title), state),
        content,
      ),
    };
  });

  const formContent = h("fieldset", { class: "stack plan-form-fields" },
    h("section", { class: "card" },
      h("div", { class: "grid-two" }, codeField, nameField),
      market, sectorField,
      h("div", { class: "field" },
        h("span", { class: "lbl", id: "plan-role-label" }, "角色"),
        seg(roles, values.role, (role) => {
          record("role", role);
          void flush();
        }, "plan-role-label"),
      ),
    ),
    sections.map(({ card }) => card),
    h("section", { class: "card" }, editor("next_review_date"),
      h("label", { class: "check-label" }, dateSeen, "我已確認下次複查日")),
    h("div", { class: "card" }, lock, missing, lockError),
  );

  root.append(h("div", { class: "draft-summary" },
    h("div", { class: "record-head" }, completion, h("p", { class: "lbl" }, "寫完鎖定，之後只能追加修訂")),
    saveStatus, saveError, retry,
  ), h("form", { onsubmit: lockDraft, novalidate: true }, formContent));
  refresh();
  if (id) void loadCounterView();

  function identityComplete() {
    return ["symbol", "name", "sector"].every((key) => values[key] && !invalid.has(key));
  }

  function filled(key) {
    return values[key] != null && values[key] !== "" && !invalid.has(key);
  }

  function refresh() {
    const incomplete = [];
    for (const section of sections) {
      const complete = section.keys.every((key) => filled(key) || planFields[key].optional && !invalid.has(key));
      section.state.textContent = complete ? "已填" : "未完成";
      section.number.classList.toggle("done", complete);
      if (!complete) incomplete.push(section.title);
    }
    completion.textContent = `已完成 ${sections.length - incomplete.length} / 10`;
    const remaining = [...incomplete];
    if (!identityComplete()) remaining.unshift("代碼、名稱與行業");
    if (!reviewedDate || !filled("next_review_date")) remaining.push("確認下次複查日");
    missing.textContent = remaining.length ? `尚需完成：${remaining.join("、")}` : "";
    lock.disabled = locking || Boolean(remaining.length);
    formContent.disabled = locking;
    updateCounterButtons();

    const gain = values.expected_up_pct;
    const downside = values.expected_down_pct;
    ratio.textContent = filled("expected_up_pct") && filled("expected_down_pct")
      ? `賺賠比 ${downside ? (gain / downside).toFixed(1) + " : 1" : "—"}` : "賺賠比 —";
    const estimate = filled("planned_weight_pct") && filled("expected_down_pct") && planLossEstimate(values, settings);
    loss.textContent = estimate
      ? `觸發止損時組合虧損 ${fmtPct(estimate.pct)}${estimate.over ? ` · 超過單筆虧損上限 ${fmtPct(settings.loss_budget_pct)}` : ""}`
      : "觸發止損時組合虧損 —";
    loss.classList.toggle("warn", Boolean(estimate?.over));
  }

  function flush() {
    clearTimeout(timer);
    if (saving) return saving;
    if (!id && !(readyToCreate && identityComplete()) || id && !pending.size) return Promise.resolve(true);
    saving = persist().finally(() => { saving = null; });
    return saving;
  }

  async function persist() {
    saveError.textContent = "";
    saveStatus.textContent = "保存中…";
    retry.hidden = true;

    while (!id || pending.size) {
      const batch = new Map(pending);
      pending.clear();
      try {
        if (id) {
          await db.saveDraft(id, Object.fromEntries(batch));
        } else {
          const created = await db.createDraft({
            next_review_date: defaultReview,
            role: values.role,
            ...Object.fromEntries(batch),
            symbol: values.symbol, market: values.market, name: values.name, sector: values.sector,
          });
          id = created.id;
          updateCounterButtons();
          if (root.isConnected) history.replaceState(history.state, "", `#plan-new/${id}`);
        }
      } catch (error) {
        for (const [key, value] of batch) {
          if (!pending.has(key) && !invalid.has(key) && !(key === "market" && invalid.has("symbol"))) {
            pending.set(key, value);
          }
        }
        saveStatus.textContent = "";
        saveError.textContent = error.message;
        retry.hidden = false;
        return false;
      }
    }

    saveStatus.textContent = `已自動保存 ${timeFormat.format(new Date())}`;
    return true;
  }

  async function lockDraft(event) {
    event.preventDefault();
    if (lock.disabled) return;
    lockError.textContent = "";
    locking = true;
    refresh();
    try {
      if (!await confirmDialog("鎖定後內容不能修改，只能追加修訂。確定鎖定？")) return;
      readyToCreate = true;
      if (!await flush()) {
        lockError.textContent = saveError.textContent;
        return;
      }
      await db.lockPlan(id);
      toast("已鎖定");
      if (root.isConnected) navigate(`#plan/${id}`, { replace: true });
    } catch (error) {
      lockError.textContent = error.cause?.message ?? error.message;
    } finally {
      locking = false;
      refresh();
    }
  }
}
