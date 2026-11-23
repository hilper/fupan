import { fmtDate, fmtMoney, todayStr } from "../format.js";
import { field, h, seg } from "../ui.js";

export const title = "設定";

function section(title, ...children) {
  return h("section", { class: "card" }, h("h2", null, title), children);
}

function showFieldError(input, message) {
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
  input.parentElement.querySelector(".field-error").textContent = message;
  return Boolean(message);
}

function numberInput(value, min, max) {
  return h("input", { type: "number", inputmode: "decimal", value, min, max, step: "0.01" });
}

function settingsForm(settings, { db, toast }) {
  const date = h("input", { type: "date", value: settings.start_date });
  const cash = numberInput(settings.start_cash);
  const single = numberInput(settings.single_max_pct, 1, 100);
  const sector = numberInput(settings.sector_max_pct, 1, 100);
  const loss = numberInput(settings.loss_budget_pct, 0.1, 10);
  const save = h("button", { class: "btn pri", type: "submit" }, "儲存");

  return h("form", { class: "stack", novalidate: true, onsubmit: submit },
    section("帳戶起點",
      field("起始日", date),
      field("起始現金（人民幣）", cash, "起始日當天的現金。起始日之前已有的持倉，請之後在計劃卡裡補記買入。"),
    ),
    section("風險上限",
      field("單票上限 %", single),
      field("單一行業上限 %", sector),
      field("單筆最大虧損占總資產 %", loss),
    ),
    save,
  );

  async function submit(event) {
    event.preventDefault();
    if (save.disabled) return;

    const invalidFields = [
      showFieldError(date, date.validity.valid ? "" : "請輸入有效日期"),
      showFieldError(cash, Number.isFinite(cash.valueAsNumber) && cash.validity.valid
        ? "" : "請輸入起始現金，最多兩位小數"),
      ...[
        [single, "請輸入 1–100 之間的百分比，最多兩位小數"],
        [sector, "請輸入 1–100 之間的百分比，最多兩位小數"],
        [loss, "請輸入 0.1–10 之間的百分比，最多兩位小數"],
      ].map(([input, message]) => showFieldError(input,
        Number.isFinite(input.valueAsNumber) && input.validity.valid ? "" : message)),
    ];
    const firstInvalid = invalidFields.indexOf(true);
    if (firstInvalid >= 0) {
      [date, cash, single, sector, loss][firstInvalid].focus();
      return;
    }

    save.disabled = true;
    try {
      await db.saveSettings({
        start_date: date.value || null,
        start_cash: cash.valueAsNumber,
        single_max_pct: single.valueAsNumber,
        sector_max_pct: sector.valueAsNumber,
        loss_budget_pct: loss.valueAsNumber,
      });
      toast("已儲存");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      save.disabled = false;
    }
  }
}

function cashFlowList(list, flows) {
  if (flows.length === 0) {
    list.replaceChildren(h("p", { class: "empty compact" }, "目前沒有入金出金紀錄"));
    return;
  }

  list.replaceChildren(h("ul", { class: "record-list" }, flows.map((flow) => {
    const deposit = Number(flow.amount_cny) > 0;
    const direction = deposit ? "up" : "down";
    return h("li", { class: "record" },
      h("div", { class: "record-head" },
        h("div", { class: "record-meta" },
          h("time", { class: "lbl", datetime: flow.flow_date }, fmtDate(flow.flow_date)),
          h("span", { class: `chip ${direction}` }, deposit ? "入金" : "出金"),
        ),
        h("strong", { class: direction }, `${deposit ? "+" : ""}${fmtMoney(flow.amount_cny)}`),
      ),
      flow.note && h("p", { class: "record-note" }, flow.note),
    );
  })));
}

function cashFlowSection(flows, { db, toast }) {
  const list = h("div");
  cashFlowList(list, flows);

  const date = h("input", { type: "date", value: todayStr(), required: true });
  const amount = numberInput(null, 0.01);
  const note = h("input", { type: "text" });
  let type = "deposit";
  const chooser = seg([
    { value: "deposit", label: "入金" },
    { value: "withdrawal", label: "出金" },
  ], type, (value) => { type = value; });
  chooser.setAttribute("aria-label", "類型");
  const add = h("button", { class: "btn pri", type: "submit" }, "新增紀錄");

  return section("入金出金", list,
    h("form", { class: "form-stack flow-form", novalidate: true, onsubmit: submit },
      field("日期", date),
      chooser,
      field("金額（人民幣）", amount),
      field("備註", note),
      add,
    ),
  );

  async function submit(event) {
    event.preventDefault();
    if (add.disabled) return;
    const invalidDate = showFieldError(date, date.validity.valid ? "" : "請輸入有效日期");
    const value = amount.valueAsNumber;
    const invalidAmount = showFieldError(amount, value > 0 && amount.validity.valid
      ? "" : "請輸入大於 0 的金額，最多兩位小數");
    if (invalidDate || invalidAmount) {
      (invalidDate ? date : amount).focus();
      return;
    }

    add.disabled = true;
    try {
      const flow = await db.addCashFlow({
        flow_date: date.value,
        amount_cny: type === "deposit" ? value : -value,
        note: note.value.trim(),
      });
      const index = flows.findIndex((item) => item.flow_date <= flow.flow_date);
      flows.splice(index === -1 ? flows.length : index, 0, flow);
      cashFlowList(list, flows);
      amount.value = "";
      note.value = "";
    } catch (error) {
      toast(error.message, "error");
    } finally {
      add.disabled = false;
    }
  }
}

const jobTime = new Intl.DateTimeFormat("zh-TW", {
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

function jobsSection(runs) {
  if (!runs.length) return section("資料更新狀態",
    h("p", { class: "empty compact" }, "Mac 端的自動更新還沒開始執行"));

  return section("資料更新狀態", h("ul", { class: "record-list" }, runs.map((run) => {
    const timestamp = run.finished_at ?? run.started_at;
    const date = new Date(timestamp);
    const status = run.ok === null ? "執行中" : run.ok ? "成功" : "失敗";
    return h("li", { class: "record" },
      h("div", { class: "record-head" },
        h("div", { class: "record-meta" },
          h("strong", null, run.job),
          h("span", { class: run.ok === false ? "chip warn" : "chip" }, status),
        ),
        h("time", { class: "lbl", datetime: timestamp }, `${fmtDate(date)} ${jobTime.format(date)}`),
      ),
      run.message && h("p", { class: "record-note" }, run.message),
    );
  })));
}

export async function render(root, ctx) {
  const { db, signOut, toast } = ctx;
  const account = h("div", null, section("帳戶起點", h("p", { class: "lbl" }, "載入中…")));
  const flows = h("div", null, section("入金出金", h("p", { class: "lbl" }, "載入中…")));
  const jobs = h("div", null, section("資料更新狀態", h("p", { class: "lbl" }, "載入中…")));
  const logout = h("button", { type: "button", class: "btn", onclick: logoutAccount }, "登出");
  root.append(account, flows, jobs, logout);

  await Promise.all([
    load(account, "帳戶起點", db.getSettings, (data) => settingsForm(data, ctx)),
    load(flows, "入金出金", db.listCashFlows, (data) => cashFlowSection(data, ctx)),
    load(jobs, "資料更新狀態", db.latestJobRuns, jobsSection),
  ]);

  async function load(container, title, fetchData, build) {
    try {
      const data = await fetchData();
      if (root.isConnected) container.replaceChildren(build(data));
    } catch (error) {
      if (root.isConnected) {
        container.replaceChildren(section(title, h("p", { class: "form-error", role: "alert" }, error.message)));
      }
    }
  }

  async function logoutAccount() {
    logout.disabled = true;
    try {
      await signOut();
    } catch (error) {
      toast(error.message, "error");
      logout.disabled = false;
    }
  }
}
