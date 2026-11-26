import { addDays, symbolInfo } from "../calc.js";
import { todayStr } from "../format.js";
import { HOLDINGS_PASSES, parseHoldingsLines } from "../holdings-parse.js";
import { recognizeColumns } from "../ocr.js";
import { field, h } from "../ui.js";

function marketLabel(candidate) {
  if (candidate.kind === "etf") return "ETF";
  return candidate.market === "HK" ? "港股" : "A 股";
}

const failedLookup = { best: null, candidates: [], notes: ["查詢失敗"] };

export async function render(root, { db, navigate, toast }) {
  let existing = new Set();
  let entries = [];
  let created = 0;
  const picker = h("input", { type: "file", accept: "image/*", multiple: true, onchange: readFiles });
  const summary = h("p", { class: "lbl", role: "status" });
  const status = h("p", { class: "form-status", role: "status" });
  const errorText = h("p", { class: "form-error", role: "alert" });
  const list = h("div", { class: "form-stack" });
  const explanation = h("p", { class: "lbl", hidden: true },
    "每檔先記一筆期初持倉：股數與成本價取自截圖，日期為今天。成本價是券商的攤薄成本，之後可匯入『投资回顾』截圖換成詳細成交。");
  const submit = h("button", {
    class: "btn pri", type: "button", hidden: true, disabled: true, onclick: save,
  }, "建立 0 張草稿");
  const controls = h("fieldset", { class: "form-stack plan-form-fields holdings-import" },
    field("選擇截圖", picker), summary, status, list, explanation, errorText, submit,
  );
  root.append(h("p", { class: "lbl" },
    "支援券商『持仓明细』頁；截圖只在手機上辨識，不會上傳。可一次選多張，重疊的會合併。"), controls);

  function selectedEntries() {
    return entries.filter(({ checkbox }) => checkbox.checked && !checkbox.disabled);
  }

  function updateCount() {
    const count = selectedEntries().length;
    const searching = entries.some((entry) => entry.searching);
    submit.textContent = `建立 ${count} 張草稿`;
    submit.disabled = count === 0 || searching;
    picker.disabled = searching;
  }

  async function refreshExisting() {
    const plans = await db.listPlans();
    existing = new Set(plans.filter(({ status }) => status === "draft" || status === "active")
      .map(({ symbol }) => symbol));
  }

  function lookupItem({ name, row }) {
    const price = row.implied_price > 0 ? row.implied_price : row.price;
    return { name: name.value.trim(), ...(price > 0 ? { price } : {}) };
  }

  function appendRow(row) {
    const checkbox = h("input", { type: "checkbox", "aria-label": "選取這檔持倉", onchange: select });
    const name = h("input", { type: "text", value: row.name, autocomplete: "off", oninput: editName });
    const candidate = h("select", { onchange: chooseCandidate });
    const manual = h("input", {
      type: "text", autocomplete: "off", autocapitalize: "characters", placeholder: "例如 002050.SZ",
      oninput: chooseManual,
    });
    const candidateField = field("候選代碼", candidate);
    const manualField = field("手動輸入代碼", manual);
    const chip = h("span", { class: "chip" });
    const retry = h("button", { class: "btn", type: "button", onclick: searchAgain }, "重新查代碼");
    const notes = h("p", { class: "lbl" });
    const duplicate = h("p", { class: "lbl" });
    const warning = h("p", { class: "warn import-warning" });
    const position = h("p", { class: "lbl" });
    const inputs = h("fieldset", { class: "form-stack plan-form-fields" },
      h("div", { class: "holdings-import-row-head" }, checkbox, field("名稱", name)),
      chip, candidateField, manualField, retry,
    );
    list.append(h("section", { class: "card holdings-import-row" },
      inputs,
      position,
      duplicate, notes, warning,
    ));

    const entry = {
      row, name, checkbox, searching: false, created: false, lookupName: row.name, result: null,
      get symbol() {
        return entry.result?.best ?? entry.result?.candidates.find((item) => item.symbol === candidate.value)
          ?? symbolInfo(manual.value);
      },
      refresh,
      applyResult(result) {
        entry.result = result;
        candidate.replaceChildren(h("option", { value: "" }, result?.candidates.length ? "選擇候選代碼" : "無候選代碼"),
          ...(result?.candidates ?? []).map((item) => h("option", { value: item.symbol },
            `${item.symbol} · ${item.name} · ${marketLabel(item)}${item.price == null ? "" : ` · ${item.price}`}`)));
        manual.value = "";
        const best = result?.best;
        if (best) {
          name.value = best.name;
          entry.lookupName = best.name;
        }
        refresh();
        checkbox.checked = Boolean(best && !checkbox.disabled && !selectedEntries().some(
          (other) => other !== entry && other.symbol.symbol === best.symbol));
        updateCount();
      },
    };
    entries.push(entry);
    refresh();
    return entry;

    function refresh() {
      const symbol = entry.symbol;
      const unit = symbol?.kind === "etf" || symbol?.kind === "lof" ? "份" : "股";
      position.textContent = `${row.quantity} ${unit} · 成本 ${row.cost ?? "—"} · 現價 ${row.price ?? "—"}`;
      const matched = entry.result?.best;
      const alreadyExists = entry.created || symbol && existing.has(symbol.symbol);
      const hasName = Boolean(name.value.trim());
      checkbox.disabled = entry.searching || !symbol || !hasName || row.quantity <= 0 ||
        !(row.cost > 0) || Boolean(alreadyExists);
      if (checkbox.disabled) checkbox.checked = false;
      chip.hidden = !matched;
      chip.textContent = matched ? `${matched.symbol} · ${marketLabel(matched)}` : "";
      candidateField.hidden = Boolean(matched);
      candidate.disabled = !entry.result?.candidates.length;
      manualField.hidden = Boolean(matched);
      duplicate.hidden = !alreadyExists;
      duplicate.textContent = alreadyExists ? "已有計劃卡，略過" : "";
      const lookupNotes = [...(entry.result?.notes ?? [])];
      if (matched && matched.name !== row.name) {
        lookupNotes.unshift(`截圖識別為『${row.name}』，已更正`);
      }
      notes.textContent = lookupNotes.join("；");
      notes.hidden = !notes.textContent;
      const flags = row.flags.filter((flag) => flag !== "缺少名稱" || !hasName);
      warning.textContent = flags.join("、");
      warning.hidden = !flags.length;
      const failed = entry.result?.notes.includes("查詢失敗");
      retry.hidden = !hasName || Boolean(entry.result && !failed && name.value.trim() === entry.lookupName);
      inputs.disabled = entry.searching || entry.created;
    }

    function select() {
      if (checkbox.checked) {
        for (const other of selectedEntries()) {
          if (other !== entry && other.symbol.symbol === entry.symbol.symbol) other.checkbox.checked = false;
        }
      }
      updateCount();
    }

    function editName() {
      checkbox.checked = false;
      entry.applyResult(null);
    }

    function chooseCandidate() {
      manual.value = "";
      refresh();
      select();
    }

    function chooseManual() {
      candidate.value = "";
      refresh();
      select();
    }

    async function searchAgain() {
      if (entry.searching || controls.disabled) return;
      const item = lookupItem(entry);
      entry.lookupName = item.name;
      entry.searching = true;
      status.textContent = "查詢代碼中…";
      refresh();
      updateCount();
      let result;
      try {
        [result] = await db.lookupSymbols([item]);
      } catch {
        result = failedLookup;
      } finally {
        entry.searching = false;
        if (root.isConnected) {
          entry.applyResult(result);
          if (!entries.some((other) => other.searching)) status.textContent = "";
        }
      }
    }
  }

  async function readFiles() {
    const files = Array.from(picker.files ?? []);
    if (!files.length || controls.disabled) return;
    controls.disabled = true;
    entries = [];
    created = 0;
    summary.textContent = errorText.textContent = "";
    explanation.hidden = submit.hidden = true;
    list.replaceChildren();
    const seen = new Set();
    const rows = [];
    let duplicates = 0;
    try {
      for (const [index, file] of files.entries()) {
        if (!root.isConnected) return;
        const lines = await recognizeColumns(file, HOLDINGS_PASSES, {
          onProgress: (progress) => { status.textContent = `第 ${index + 1}/${files.length} 張 · ${progress}`; },
        });
        for (const row of parseHoldingsLines(lines)) {
          const key = `${row.name}|${row.quantity}`;
          if (row.name && seen.has(key)) {
            duplicates += 1;
          } else {
            if (row.name) seen.add(key);
            rows.push(row);
          }
        }
      }
      if (!root.isConnected) return;
      summary.textContent = `已識別 ${files.length} 張截圖，共 ${rows.length} 檔（重疊 ${duplicates} 檔已合併）`;
      if (!rows.length) return;
      await refreshExisting();
      if (!root.isConnected) return;
      const searchable = rows.map(appendRow).filter((entry) => entry.name.value.trim());
      explanation.hidden = submit.hidden = false;
      status.textContent = "查詢代碼中…";
      for (let index = 0; index < searchable.length && root.isConnected; index += 30) {
        const batch = searchable.slice(index, index + 30);
        try {
          const results = await db.lookupSymbols(batch.map(lookupItem));
          batch.forEach((entry, offset) => entry.applyResult(results[offset] ?? failedLookup));
        } catch {
          batch.forEach((entry) => entry.applyResult(failedLookup));
        }
      }
      updateCount();
    } catch (error) {
      errorText.textContent = error.message;
    } finally {
      status.textContent = "";
      controls.disabled = false;
      picker.value = "";
    }
  }

  async function save() {
    if (controls.disabled || submit.disabled) return;
    controls.disabled = true;
    status.textContent = "建立草稿中…";
    errorText.textContent = "";
    const today = todayStr();
    let draftRequestError;
    try {
      await refreshExisting();
      for (const entry of entries) entry.refresh();
      const selected = selectedEntries();
      for (const entry of selected) {
        if (!root.isConnected) return;
        const { row, name, symbol } = entry;
        const draft = await db.createDraft({
          symbol: symbol.symbol, name: name.value.trim(), market: symbol.market,
          origin: "backfill", role: "觀察", sector: symbol.kind === "etf" ? "ETF" : "",
          opening_quantity: row.quantity, opening_cost: row.cost, opening_date: today,
          next_review_date: addDays(today, 30),
        });
        created += 1;
        entry.created = true;
        existing.add(symbol.symbol);
        try {
          await db.requestPlanDraft(draft.id);
        } catch (error) {
          draftRequestError ??= error.message;
        }
      }
      if (created && root.isConnected) {
        toast(`已建立 ${created} 張草稿`);
        if (draftRequestError) toast(draftRequestError, "error");
        navigate("#holdings");
      }
    } catch (error) {
      errorText.textContent = `已建立 ${created} 張，第 ${created + 1} 張失敗：${error.cause?.message ?? error.message}`;
    } finally {
      status.textContent = "";
      controls.disabled = false;
      for (const entry of entries) entry.refresh();
      updateCount();
    }
  }
}
