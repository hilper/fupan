import { adoptedInQuarter, nextQuarterStart, quarterOf } from "../calc.js";
import { fmtDate, todayStr } from "../format.js";
import { choiceField, confirmDialog, decisionForm, field, h, setFieldError } from "../ui.js";

function button(label, onclick, primary = false) {
  return h("button", { type: "button", class: primary ? "btn pri" : "btn", onclick }, label);
}

function disclosure(label, makeForm, primary = false) {
  const panel = h("div", { class: "rule-panel", hidden: true });
  const trigger = button(label, () => {
    panel.hidden = !panel.hidden;
    trigger.setAttribute("aria-expanded", String(!panel.hidden));
    if (panel.hidden) panel.replaceChildren();
    else {
      panel.append(makeForm());
      panel.querySelector("input, textarea, button")?.focus();
    }
  }, primary);
  trigger.setAttribute("aria-expanded", "false");
  return { trigger, panel };
}

function adoptForm(rules, save) {
  const today = todayStr();
  const method = choiceField("方式", [
    { value: "active", label: "正式" },
    { value: "trial", label: "試行" },
  ], "trial");
  const date = h("input", {
    type: "date", min: today, value: nextQuarterStart(today), required: true,
  });
  const dateField = field("生效日", date);
  const quota = h("p", { class: "lbl", role: "status" });
  const limit = h("p", { class: "lbl warn" }, "這一季已採用 2 條");
  const form = decisionForm([method.element, dateField, quota, limit], "確認採用", async () => {
    if (!updateQuota()) throw new Error("請確認生效日與季度額度");
    await save({ status: method.value, effective_from: date.value });
  }, "rule-form");
  const submit = form.querySelector("button[type=submit]");

  function updateQuota() {
    date.min = todayStr();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.value) || date.value < date.min) {
      setFieldError(dateField, date, "請輸入今天或之後的生效日");
      quota.textContent = "";
      limit.hidden = true;
      submit.disabled = true;
      return false;
    }
    setFieldError(dateField, date);
    const { label } = quarterOf(date.value);
    const count = adoptedInQuarter(rules, date.value);
    quota.textContent = `${label} 已採用 ${count} / 2 條`;
    limit.hidden = count < 2;
    submit.disabled = count >= 2;
    return !submit.disabled;
  }

  date.addEventListener("input", updateQuota);
  date.addEventListener("change", updateQuota);
  updateQuota();
  return form;
}

function withdrawForm(save) {
  const reason = h("textarea", { rows: 2, required: true, minlength: 4 });
  return decisionForm([field("撤回理由", reason, "例如：沒有減少出場錯誤")], "確認撤回", async () => {
    const value = reason.value.trim();
    if ([...value].length < 4) throw new Error("撤回理由至少 4 字");
    await save(value);
  }, "rule-form");
}

function addForm(save) {
  const text = h("textarea", { rows: 3, required: true, minlength: 6 });
  const source = h("textarea", { rows: 2, required: true });
  return decisionForm([
    field("規則文字", text, "至少 6 字"),
    field("來源", source, "哪幾筆交易、哪個錯誤類別"),
  ], "新增候選", async () => {
    const value = text.value.trim();
    const source_note = source.value.trim();
    if ([...value].length < 6) throw new Error("規則文字至少 6 字");
    if (!source_note) throw new Error("請填寫規則來源");
    await save({ text: value, source_note });
  }, "rule-form");
}

function ruleGroup(title, rows, className = "") {
  if (!rows.length) return null;
  return h("section", { class: `card rule-group ${className}` },
    h("div", { class: "record-head" },
      h("h2", null, title),
      h("span", { class: "lbl" }, `${rows.length} 條`),
    ),
    rows,
  );
}

export async function render(root, { db, setSubtitle, toast }) {
  let rules = await db.listRules();
  if (!root.isConnected) return;
  let saving = false;
  let rejectedDetails;

  async function commit(save, message) {
    if (saving) throw new Error("正在儲存另一條規則，請稍後再試");
    saving = true;
    try {
      const row = await save();
      if (!root.isConnected) return;
      if (rules.some(({ id }) => id === row.id)) {
        rules = rules.map((rule) => rule.id === row.id ? row : rule);
      } else {
        rules.push(row);
        rules.sort((a, b) => a.code.localeCompare(b.code, "zh-TW", { numeric: true }));
      }
      draw();
      toast(message);
    } finally {
      saving = false;
    }
  }

  function directAction(label, save, message, confirmation) {
    return button(label, async (event) => {
      const control = event.currentTarget;
      control.disabled = true;
      try {
        if (confirmation && !await confirmDialog(confirmation)) return;
        if (control.isConnected) await commit(save, message);
      } catch (error) {
        if (control.isConnected) toast(error.message, "error");
      } finally {
        control.disabled = false;
      }
    });
  }

  function candidateCard(rule) {
    const adopt = disclosure("採用", () => adoptForm(rules, (values) => commit(
      () => db.adoptRule(rule.id, values), "已採用規則",
    )), true);
    return h("article", { class: "card rule-candidate" },
      h("div", { class: "record-head" },
        h("span", { class: "lbl" }, rule.code),
        h("span", { class: "chip" }, rule.proposed_by === "ai" ? "AI 提議" : "自己新增"),
      ),
      h("strong", { class: "rule-text" }, rule.text),
      h("p", { class: "lbl rule-text" }, "來源：", rule.source_note || "—"),
      h("div", { class: "grid-two" },
        adopt.trigger,
        directAction("不採用", () => db.rejectRule(rule.id), "已標記不採用", "確定不採用這條候選規則？"),
      ),
      adopt.panel,
    );
  }

  function ruleRow(rule, note, actions, panel) {
    return h("article", { class: "record rule-row" },
      h("span", { class: "lbl" }, rule.code),
      h("div", { class: "rule-body" },
        h("p", { class: "rule-text" }, rule.text),
        h("p", { class: "lbl rule-text" }, note),
        actions && h("div", { class: "record-meta" }, actions),
        panel,
      ),
    );
  }

  function currentRule(rule) {
    const withdraw = disclosure("撤回", () => withdrawForm((reason) => commit(
      () => db.withdrawRule(rule.id, reason), "已撤回規則",
    )));
    return ruleRow(rule, `${fmtDate(rule.effective_from)} 起 · 來源 ${rule.source_note || "—"}`, [
      rule.status === "trial" && directAction("轉為正式", () => db.promoteRule(rule.id), "已轉為正式規則"),
      withdraw.trigger,
    ], withdraw.panel);
  }

  function draw() {
    const version = rules.filter(({ status }) => ["active", "trial", "withdrawn"].includes(status)).length;
    setSubtitle(`第 ${version} 版 · 每季最多改 2 條`);
    const candidates = rules.filter(({ status }) => status === "candidate");
    const active = rules.filter(({ status }) => status === "active");
    const trials = rules.filter(({ status }) => status === "trial");
    const withdrawn = rules.filter(({ status }) => status === "withdrawn");
    const rejected = rules.filter(({ status }) => status === "rejected");
    const add = disclosure("＋ 新增規則", () => addForm((values) => commit(
      () => db.addRule(values), "已新增候選規則",
    )));
    const wasRejectedOpen = rejectedDetails?.open ?? false;
    rejectedDetails = rejected.length ? h("details", { class: "card rule-rejected", open: wasRejectedOpen },
      h("summary", null, `不採用的候選（${rejected.length}）`),
      rejected.map((rule) => ruleRow(rule, `來源 ${rule.source_note || "—"}`)),
    ) : null;
    root.replaceChildren(...[
      !rules.length && h("p", { class: "card empty" }, "還沒有規則。季度復盤後，從錯誤排行第一名開始寫第一條。"),
      candidates.length > 0 && h("section", { class: "rule-candidates" },
        h("h2", null, "待你決定"),
        candidates.map(candidateCard),
      ),
      ruleGroup("生效中", active.map(currentRule)),
      ruleGroup("試行中", trials.map(currentRule), "rule-trials"),
      ruleGroup("已撤回", withdrawn.map((rule) =>
        ruleRow(rule, `${fmtDate(rule.withdrawn_at)} 撤回 · ${rule.withdraw_reason || "—"}`)), "rule-withdrawn"),
      rejectedDetails,
      h("section", { class: "card" },
        h("p", { class: "lbl" }, "規則只在季度復盤時修改；平時想到的先記成候選。"),
        add.trigger,
        add.panel,
      ),
    ].filter(Boolean));
  }

  draw();
}
