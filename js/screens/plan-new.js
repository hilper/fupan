import { addDays, planChecks, planLossEstimate, symbolInfo } from "../calc.js";
import { fmtPct, todayStr } from "../format.js";
import {
  confidenceField, confirmDialog,
  field, fieldSourceChip, fieldSources, h, isPlanValueBlank, missingPlan, planChecksCard, planEditTime,
  numberCheckNote, officialFactsTable, planCheckPanel, planFields, planInput, planSections, planTimestamp, readPlanInput, seg,
  setFieldError, supplementPlanFields,
} from "../ui.js";
import { loadPortfolio } from "./holdings.js";

const roles = ["核心", "成長", "周期", "交易", "觀察"].map((role) => ({ value: role, label: role }));
const timeFormat = new Intl.DateTimeFormat("zh-TW", {
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export async function render(root, ctx) {
  const { db, navigate, params, toast } = ctx;
  const [draft, settings] = await Promise.all([
    params[0] ? db.getPlan(params[0]) : null,
    db.getSettings().catch(() => null),
  ]);
  if (!root.isConnected) return;
  if (params[0] && !draft) return missingPlan(root);
  if (draft && draft.status !== "draft") return navigate(`#plan/${draft.id}`, { replace: true });

  let drafts = draft ? await db.listDrafts().catch(() => []) : [];
  if (!root.isConnected) return;
  let id = draft?.id;
  const backfill = draft?.origin === "backfill";
  const opening = draft?.opening_quantity;
  const today = todayStr();
  const defaultReview = addDays(today, 30);
  const values = {
    ...draft,
    role: draft?.role ?? "觀察",
    next_review_date: backfill ? draft.next_review_date : draft?.next_review_date ?? defaultReview,
  };
  const pending = new Map();
  const invalid = new Set();
  const editors = new Map();
  const touched = new Set();
  const provenance = new Map();
  const draftEdits = new Map();
  const draftResults = new Map();
  let sources = new Map();
  let draftRequest;
  let draftError = "";
  let draftBusy = false;
  let draftPoll;
  let timer;
  let saving;
  let locking = false;
  let reviewedDate = false;
  let readyToCreate = false;
  let rulePrice = null;
  let priceSymbol;
  let priceRequest = 0;
  let portfolio = null;
  let checkHistory = null;
  let lastSavedAt;

  const completion = h("strong", { "aria-live": "polite" });
  const draftNav = h("nav", { class: "record-head", "aria-label": "草稿導覽", hidden: true });
  const saveStatus = h("p", { class: "form-status", role: "status" });
  const saveError = h("p", { class: "form-error", role: "alert" });
  const lockError = h("p", { class: "form-error", role: "alert" });
  const retry = h("button", { class: "btn", type: "button", hidden: true, onclick: flush }, "重試保存");
  const market = h("p", { class: "lbl", "aria-live": "polite" });
  const ratio = h("p", { class: "plan-calculation" });
  const loss = h("p", { class: "plan-calculation" });
  const draftStatus = h("p", { role: "status" });
  const draftNote = h("small", { class: "lbl", hidden: true },
    "財報數字已與東方財富官方數據逐一核對，標 ⚠ 的請自行查證；每一欄都可修改。");
  const draftRetry = h("button", { type: "button", class: "btn", onclick: startDraftRequest }, "重試");
  const draftPanel = h("div", { class: "draft-ai-status", hidden: true }, draftStatus, draftNote, draftRetry);
  const draftFacts = h("div", { hidden: true });
  const ruleCard = h("div");
  const missing = h("p", { class: "lbl" });
  const lock = h("button", { class: "btn pri", type: "submit" }, "鎖定計劃卡");
  const planCheck = planCheckPanel({
    draft: true,
    load: () => db.latestPlanCheck(id),
    send: async () => {
      if (!await flush()) throw new Error(saveError.textContent);
      return db.requestPlanCheck(id);
    },
    canSend: () => Boolean(id && !locking && filled("thesis")),
    changedAfter: (doneAt) => planTimestamp(lastSavedAt) > planTimestamp(doneAt),
    onFix(key) {
      const input = editors.get(key);
      const optional = input.closest(".plan-optional");
      if (optional) optional.open = true;
      input.scrollIntoView({ block: "center" });
      input.focus({ preventScroll: true });
    },
  });

  function updateDraftStatus() {
    const { status, error, done_at: doneAt, result } = draftRequest ?? {};
    const failure = draftError || (status === "error" ? error || "處理失敗" : "");
    const done = !failure && status === "done";
    draftPanel.hidden = !failure && !status && !draftBusy;
    draftRetry.hidden = !failure || draftBusy;
    draftNote.hidden = !done || !result?.number_check;
    draftFacts.hidden = !done || !result?.facts;
    if (!draftFacts.hidden) draftFacts.replaceChildren(officialFactsTable(result.facts));
    draftStatus.className = failure ? "form-error" : "form-status";
    draftStatus.textContent = failure ? `AI 起草失敗：${failure}`
      : done ? `AI 起草完成 · ${planEditTime(doneAt)} · DeepSeek` : "AI 起草中…";
  }

  function updateProvenance(rows) {
    for (const row of rows) draftEdits.set(row.id, row);
    sources = fieldSources([...draftEdits.values()]);
    const originals = new Map();
    for (const row of draftEdits.values()) {
      if (row.actor === "ai" && (!originals.has(row.field) || row.id > originals.get(row.field).id)) {
        originals.set(row.field, row);
      }
    }
    for (const [key, entry] of provenance) {
      const { chip, original, originalValue, confirm } = entry;
      const source = sources.get(key);
      const badge = fieldSourceChip(source);
      chip.replaceChildren(...(badge ? [badge] : []));
      chip.hidden = !badge;
      const edit = originals.get(key);
      const result = draftResults.get(edit?.request_id);
      entry.result = result;
      if (original) {
        original.hidden = !edit;
        if (edit) {
          originalValue.textContent = String(result?.[key] ?? edit.new_value);
          if (key === "stop_price" && result?.stop_basis) {
            originalValue.textContent += `\n依據：${result.stop_basis}`;
          }
        }
      }
      updateNumberNote(key);
      if (confirm) confirm.hidden = source !== "ai";
    }
    refresh();
  }

  function updateNumberNote(key) {
    const { warning, result } = provenance.get(key) ?? {};
    if (!warning) return;
    const input = editors.get(key);
    const note = key === "stop_price"
      ? numberCheckNote(result?.number_check, "stop_basis")
      : numberCheckNote(result?.number_check, key, input.value);
    warning.replaceChildren(...(note ? [note] : []));
    warning.hidden = !note;
  }

  function scheduleDraftPoll() {
    clearTimeout(draftPoll);
    if (root.isConnected) draftPoll = setTimeout(loadDraftRequest, 5000);
  }

  async function loadDraftRequest() {
    if (!root.isConnected || draftBusy) return;
    draftBusy = true;
    try {
      const [request, rows] = await Promise.all([db.latestPlanDraft(id), db.listPlanEdits(id)]);
      if (!root.isConnected) return;
      draftRequest = request;
      if (request) draftError = "";
      if (request?.status === "done") {
        draftResults.set(request.id, request.result);
        const plan = await db.getPlan(id);
        if (!root.isConnected) return;
        for (const key of request.result?.written ?? []) {
          const input = editors.get(key);
          if (!input || touched.has(key) || !isPlanValueBlank(input.value) ||
              !isPlanValueBlank(values[key]) || isPlanValueBlank(plan?.[key])) continue;
          values[key] = plan[key];
          input.value = plan[key];
        }
      }
      updateProvenance(rows);
      const missingResults = new Set(rows.filter((row) =>
        row.actor === "ai" && row.request_id != null && !draftResults.has(row.request_id))
        .map((row) => row.request_id));
      await Promise.all([...missingResults].map(async (requestId) => {
        const older = await db.latestPlanDraft(id, requestId);
        if (older) draftResults.set(requestId, older.result);
      }));
      if (missingResults.size && root.isConnected) updateProvenance([]);
      if (["queued", "running"].includes(request?.status)) scheduleDraftPoll();
    } catch {
      scheduleDraftPoll();
    } finally {
      draftBusy = false;
      if (root.isConnected) updateDraftStatus();
    }
  }

  async function startDraftRequest() {
    if (!id || draftBusy) return;
    draftBusy = true;
    draftError = "";
    draftRequest = null;
    updateDraftStatus();
    try {
      draftRequest = await db.requestPlanDraft(id);
      scheduleDraftPoll();
    } catch (error) {
      draftError = error.message;
    } finally {
      draftBusy = false;
      if (root.isConnected) updateDraftStatus();
    }
  }

  function sourceLabel(key, label) {
    const chip = h("span", { hidden: true });
    const warning = h("div", { hidden: true });
    const originalValue = h("p", { class: "plan-read-text" });
    const original = h("details", { class: "plan-draft-original", hidden: true },
      h("summary", null, "看 AI 原稿"), originalValue);
    const confirm = ["thesis", "stop_price"].includes(key) ? h("button", {
      class: "btn text-btn", type: "button", hidden: true, onclick: async () => {
        if (locking || confirm.disabled) return;
        confirm.disabled = true;
        try {
          if (!await flush() || sources.get(key) !== "ai" || !filled(key)) return;
          const value = String(values[key]);
          const rows = await db.addPlanEdits([{
            plan_id: id, field: key, old_value: value, new_value: value, actor: "user", action: "edit",
          }]);
          if (root.isConnected) updateProvenance(rows);
        } catch (error) {
          if (root.isConnected) toast(error.message, "error");
        } finally {
          confirm.disabled = false;
        }
      },
    }, key === "stop_price" ? "確認此價" : "確認") : null;
    provenance.set(key, { chip, original, originalValue, confirm, warning });
    const heading = h("div", { class: "record-meta plan-field-heading" }, chip, confirm);
    label.replaceWith(heading);
    heading.prepend(label);
    return [warning, original];
  }

  function record(key, value) {
    if (values[key] === value) return;
    values[key] = value;
    touched.add(key);
    pending.set(key, value);
  }

  function updateField(key, wrapper, input, value, error) {
    setFieldError(wrapper, input, error);
    if (error) {
      touched.add(key);
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
    const wrapper = field(label, input, backfill && key === "sector" ? "可留空" : null);
    if (key === "sector") {
      editors.set(key, input);
      input.after(...sourceLabel(key, wrapper.querySelector("label")));
    }

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
        updateField(key, wrapper, input, raw, key === "name" && !raw && id ? "此欄必填" : "");
      }
      refresh();
      if (commit) {
        readyToCreate = identityComplete();
        void flush();
      } else {
        schedule();
      }
    }

    input.addEventListener("input", () => {
      touched.add(key);
      read(false);
    });
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
    const confidence = key === "confidence" ? confidenceField(values[key]) : null;
    const input = confidence?.input ?? planInput(definition, values[key]);
    editors.set(key, input);
    const optional = definition.optional || backfill && ["planned_weight_pct", "next_review_date"].includes(key);
    const hint = backfill && key === "next_review_date" ? "留空時，鎖定後預設為 30 天後" : optional ? "可留空" : null;
    const wrapper = confidence?.wrapper ?? field(definition.label, input, hint);
    input.after(...sourceLabel(key, wrapper.querySelector("label")));

    function read(commit) {
      const { value, error } = readPlanInput(definition, input);
      updateField(key, wrapper, input, value, error);
      updateNumberNote(key);
      if (key === "next_review_date") {
        reviewedDate = false;
        dateSeen.checked = false;
      }
      refresh();
      if (commit) void flush();
      else schedule();
    }

    input.addEventListener("input", () => {
      touched.add(key);
      read(false);
    });
    input.addEventListener("change", () => read(true));
    return wrapper;
  }

  const sections = [];
  function step(index, keys, calculation) {
    const [title] = planSections[index];
    const state = h("span", { class: "lbl" });
    const number = h("span", { class: "plan-step", "aria-hidden": "true" }, index + 1);
    const fields = new Map(keys.map((key) => [key, editor(key)]));
    const pair = (items) => h("div", { class: "grid-two" }, items.map((key) => fields.get(key)));
    let content = [...fields.values()];
    if (index === 2) content = [pair(keys)];
    if (index === 5) content = [pair(keys.slice(0, 2)), pair(keys.slice(2))];
    sections.push({ keys, state, number });
    return h("section", { class: "card plan-step-card" },
      h("header", { class: "plan-step-heading" }, number, h("h2", null, title), state),
      content, calculation,
    );
  }

  const roleLabel = h("span", { class: "lbl", id: "plan-role-label" }, "角色");
  const roleChip = h("span", { hidden: true });
  provenance.set("role", { chip: roleChip });
  const optionalSummary = h("summary");
  const formContent = h("fieldset", { class: "stack plan-form-fields" },
    !backfill && h("h2", null, "鎖定前必填"),
    h("section", { class: "card" },
      h("div", { class: "grid-two" }, codeField, nameField),
      market, sectorField,
      h("div", { class: "field" },
        h("div", { class: "record-meta" }, roleLabel, roleChip),
        seg(roles, values.role, (role) => {
          record("role", role);
          void flush();
        }, "plan-role-label"),
      ),
    ),
    backfill && h("h2", null, "鎖定前必填"),
    step(0, ["thesis"]),
    step(3, ["stop_price"]),
    step(4, ["planned_weight_pct"], loss),
    h("section", { class: "card" }, editor("next_review_date"),
      !backfill && h("label", { class: "check-label" }, dateSeen, "我已確認下次複查日")),
    h("section", { class: "card" }, planCheck.panel),
    ruleCard,
    h("div", { class: "card" }, lock, missing, lockError),
    h("details", { class: "plan-optional" }, optionalSummary, h("div", { class: "stack" },
      planSections.map(([, keys], index) => {
        const optionalKeys = keys.filter((key) => supplementPlanFields.includes(key));
        return optionalKeys.length ? step(index, optionalKeys, index === 2 ? ratio : null) : null;
      }),
    )),
  );

  root.append(draftNav);
  if (backfill) {
    root.append(h("section", { class: "card opening-summary" },
      h("span", { class: "chip" }, "補建卡"),
      opening != null && h("p", { class: "lbl" },
        `期初持倉：${opening} 股 · 成本 ${draft.opening_cost} · ${draft.opening_date}（截圖匯入）`)));
  }
  root.append(h("div", { class: "draft-summary" },
    completion,
    saveStatus, saveError, retry, draftPanel, draftFacts,
  ), h("form", { onsubmit: lockDraft, novalidate: true }, formContent));
  renderDraftNav();
  refresh();
  if (id) {
    void loadDraftRequest();
    void planCheck.refresh();
  }
  if (settings?.start_date) {
    void loadPortfolio(db, today).then((data) => {
      portfolio = data.portfolio;
      updateChecks();
    }, () => {});
  }
  void db.getPlanCheckHistory().then((data) => {
    checkHistory = data;
    updateChecks();
  }, () => {});

  function identityComplete() {
    return ["symbol", "name"].every((key) => values[key] && !invalid.has(key));
  }

  function renderDraftNav() {
    const index = drafts.findIndex((item) => item.id === id);
    draftNav.hidden = drafts.length < 2 || index < 0;
    if (draftNav.hidden) return;
    const next = drafts[(index + 1) % drafts.length];
    draftNav.replaceChildren(h("span", { class: "lbl" }, `草稿 ${index + 1} / ${drafts.length}`),
      h("button", { class: "btn", type: "button", onclick: async () => {
        if (!locking && await flush() && !locking && root.isConnected) navigate(`#plan-new/${next.id}`);
      } }, "下一張 ›"));
  }

  function filled(key) {
    return !isPlanValueBlank(values[key]) && !invalid.has(key);
  }

  async function loadRulePrice() {
    const symbol = symbolInfo(values.symbol)?.symbol;
    if (symbol === priceSymbol) return;
    priceSymbol = symbol;
    const request = ++priceRequest;
    rulePrice = null;
    if (!symbol) return;

    const prices = await db.latestPrices([symbol]).catch(() => null);
    if (request !== priceRequest) return;
    rulePrice = Number(prices?.get(symbol)?.close) || null;
    updateChecks();
  }

  function updateChecks() {
    if (!root.isConnected) return;
    const checks = planChecks({
      plan: { ...values, id }, settings, price: rulePrice, portfolio, history: checkHistory,
    });
    const card = planChecksCard(checks);
    const details = card.querySelector("details");
    if (details && ruleCard.querySelector("details")?.open) details.open = true;
    ruleCard.replaceChildren(card);
  }

  function refresh() {
    for (const section of sections) {
      const complete = section.keys.every((key) => filled(key) || planFields[key].optional && !invalid.has(key));
      section.state.textContent = complete ? "已填" : "未完成";
      section.number.classList.toggle("done", complete);
    }
    const optionalFilled = supplementPlanFields.filter(filled).length;
    optionalSummary.textContent = `其他項目（可鎖定後再補）· 已填 ${optionalFilled} / ${supplementPlanFields.length}`;
    const confirmedFields = ["thesis", "stop_price"].map((key) => {
      const label = planFields[key].label;
      if (sources.get(key) === "ai") return [false, `確認${label}（AI 起草，請修改或確認）`];
      return [filled(key) && (key !== "thesis" || Boolean(values.thesis?.trim())), label];
    });
    const required = backfill ? confirmedFields : [
      [filled("symbol") && filled("name"), "代碼與名稱"],
      [filled("sector"), "行業"],
      ...confirmedFields,
      [filled("planned_weight_pct"), planFields.planned_weight_pct.label],
      [reviewedDate && filled("next_review_date"), "確認下次複查日"],
    ];
    const remaining = required.filter(([done]) => !done).map(([, label]) => label);
    completion.textContent = `必填 ${required.length - remaining.length} / ${required.length}`;
    missing.textContent = remaining.length ? `尚需完成：${remaining.join("、")}` : "";
    lock.disabled = locking || Boolean(remaining.length);
    formContent.disabled = locking;
    planCheck.update();

    const gain = values.expected_up_pct;
    const downside = values.expected_down_pct;
    ratio.textContent = filled("expected_up_pct") && filled("expected_down_pct")
      ? `賺賠比 ${downside ? (gain / downside).toFixed(1) + " : 1" : "—"}` : "賺賠比 —";
    const estimate = filled("planned_weight_pct") && filled("expected_down_pct") && planLossEstimate(values, settings ?? {});
    loss.textContent = estimate
      ? `觸發止損時組合虧損 ${fmtPct(estimate.pct)}${estimate.over ? ` · 超過單筆虧損上限 ${fmtPct(settings.loss_budget_pct)}` : ""}`
      : "";
    loss.hidden = !estimate;
    loss.classList.toggle("warn", Boolean(estimate?.over));

    void loadRulePrice();
    updateChecks();
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
          const saved = await db.saveDraft(id, Object.fromEntries(batch));
          lastSavedAt = saved?.updated_at ?? new Date().toISOString();
          // 欄位與紀錄由資料庫一併保存，這裡只更新畫面出處。
          const rows = await db.listPlanEdits(id).catch(() => null);
          if (root.isConnected) {
            if (rows) updateProvenance(rows);
            else scheduleDraftPoll();
          }
        } else {
          const created = await db.createDraft({
            next_review_date: defaultReview,
            role: values.role,
            ...Object.fromEntries(batch),
            symbol: values.symbol, market: values.market, name: values.name, sector: values.sector ?? "",
          });
          id = created.id;
          void startDraftRequest();
          if (root.isConnected) {
            history.replaceState(history.state, "", `#plan-new/${id}`);
            void db.listDrafts().then((rows) => {
              drafts = rows;
              if (root.isConnected) renderDraftNav();
            }, () => {});
          }
        }
        planCheck.update();
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
      const confirmation = backfill
        ? `鎖定後已填的內容不能修改；空白項目之後可以補填一次。${opening != null ? `鎖定時會寫入期初持倉 ${opening} 股。` : ""}確定鎖定？`
        : "鎖定後已填的內容不能修改；空白的項目之後可以補填一次。確定鎖定？";
      if (!await confirmDialog(confirmation)) return;
      readyToCreate = true;
      if (!await flush()) {
        lockError.textContent = saveError.textContent;
        return;
      }
      await db.lockPlan(id);
      void db.requestCounterView(id).catch(() => {});
      toast("已鎖定");
      if (!root.isConnected) return;
      const remaining = await db.listDrafts().catch(() => drafts.filter((item) => item.id !== id));
      const index = drafts.findIndex((item) => item.id === id);
      const later = new Set(index < 0 ? [] : drafts.slice(index + 1).map((item) => item.id));
      const next = remaining.find((item) => later.has(item.id)) ?? remaining[0];
      if (root.isConnected) navigate(next ? `#plan-new/${next.id}` : `#plan/${id}`, { replace: true });
    } catch (error) {
      lockError.textContent = error.cause?.message ?? error.message;
    } finally {
      locking = false;
      refresh();
    }
  }
}
