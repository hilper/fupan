import { todayStr } from "./format.js";

const settingsDefaults = {
  start_date: null,
  start_cash: 0,
  single_max_pct: 20,
  sector_max_pct: 35,
  loss_budget_pct: 1,
};

const settingsColumns = Object.keys(settingsDefaults).join(",");
const alertColumns = "*,plans(name,symbol,market,stop_price)";
const counterViewColumns = "status,error,result";
const exitReviewEditableColumns = [
  "thesis_verdict", "pnl_sources", "next_time", "is_repeat", "decision_quality", "error_tags",
  "return_pct", "bench_return_pct", "excess_pct",
];

function exitReviewChanges(values) {
  return Object.fromEntries(exitReviewEditableColumns
    .filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
}

async function readResult(summary, query) {
  try {
    const { data, error } = await query();
    if (error) throw error;
    return data;
  } catch (error) {
    throw new Error(`${summary}：${error?.message || error}`, { cause: error });
  }
}

async function readRows(summary, query) {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    let page;
    try {
      page = await readResult(summary, () => query().range(offset, offset + pageSize - 1));
    } catch (error) {
      if (offset && error.cause?.code === "PGRST103") return rows;
      throw error;
    }
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function updateRule(client, id, statuses, values) {
  try {
    return await readResult("更新規則失敗", () => client.from("rules").update(values)
      .eq("id", id).in("status", statuses).select().single());
  } catch (error) {
    if (error.cause?.code === "PGRST116") {
      throw new Error("這條規則的狀態已改變，請重新整理", { cause: error });
    }
    throw error;
  }
}

export function createDb(client) {
  const rulesByCode = () => readRows("讀取規則失敗", () => client.from("rules").select("*").order("id"));
  // RLS 只回傳目前使用者的個人資料，新增時由 auth.uid() 填入 user_id。
  return {
    async getSettings() {
      const data = await readResult("讀取設定失敗", () => client
        .from("settings").select(settingsColumns).maybeSingle());
      return data ?? { ...settingsDefaults };
    },

    async saveSettings({ start_date, start_cash, single_max_pct, sector_max_pct, loss_budget_pct }) {
      await readResult("儲存設定失敗", () => client
        .from("settings").upsert({
          start_date, start_cash, single_max_pct, sector_max_pct, loss_budget_pct,
        }, { onConflict: "user_id" }));
    },

    async listCashFlows() {
      return readRows("讀取入金出金失敗", () => client
        .from("cash_flows").select("id,flow_date,amount_cny,note")
        .order("flow_date", { ascending: false }).order("id", { ascending: false }));
    },

    async addCashFlow({ flow_date, amount_cny, note }) {
      return readResult("新增入金出金失敗", () => client
        .from("cash_flows").insert({ flow_date, amount_cny, note })
        .select("id,flow_date,amount_cny,note").single());
    },

    async latestJobRuns() {
      const data = await readResult("讀取資料更新狀態失敗", () => client
        .from("job_runs").select("job,started_at,finished_at,ok,message")
        .order("started_at", { ascending: false }).order("id", { ascending: false }).limit(50));
      const latest = new Map();
      for (const run of data) {
        if (!latest.has(run.job)) latest.set(run.job, run);
      }
      return [...latest.values()];
    },

    listPlans() {
      return readRows("讀取計劃卡失敗", () => client
        .from("plans").select("*").order("id", { ascending: false }));
    },

    getPlan(id) {
      return readResult("讀取計劃卡失敗", () => client
        .from("plans").select("*").eq("id", id).maybeSingle());
    },

    createDraft(values) {
      return readResult("建立草稿失敗", () => client
        .from("plans").insert(values).select().single());
    },

    saveDraft(id, values) {
      return readResult("保存草稿失敗", () => client
        .from("plans").update(values).eq("id", id).eq("status", "draft").select().single());
    },

    supplementPlan(id, values) {
      return readResult("補填計劃卡失敗", () => client
        .from("plans").update(values).eq("id", id).not("locked_at", "is", null).select().single());
    },

    requestCounterView(planId) {
      return readResult("送出反方觀點請求失敗", () => client.from("ai_requests")
        .insert({ kind: "counter_view", plan_id: planId }).select(counterViewColumns).single());
    },

    latestCounterView(planId) {
      return readResult("讀取反方觀點請求失敗", () => client.from("ai_requests")
        .select(counterViewColumns).eq("kind", "counter_view").eq("plan_id", planId)
        .order("created_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false })
        .limit(1).maybeSingle());
    },

    lockPlan(id) {
      return readResult("鎖定計劃卡失敗", () => client.rpc("lock_plan", { p_id: id }));
    },

    setNextReview(id, date, { allowClosed = false } = {}) {
      const statuses = allowClosed ? ["active", "closed"] : ["active"];
      return readResult("更新複查日期失敗", () => client
        .from("plans").update({ next_review_date: date }).eq("id", id).in("status", statuses)
        .select("next_review_date").single());
    },

    listAmendments(planId) {
      return readRows("讀取修訂失敗", () => {
        const query = client.from("plan_amendments").select("*")
          .order("created_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false });
        return planId == null ? query : query.eq("plan_id", planId);
      });
    },

    addAmendment({ plan_id, field, new_value, reason }) {
      return readResult("追加修訂失敗", () => client
        .from("plan_amendments").insert({ plan_id, field, new_value, reason }).select().single());
    },

    async listTrades(planId) {
      const rows = await readRows("讀取成交失敗", () => {
        const query = client.from("trades").select("*,plans!inner(symbol,market)")
          .order("trade_date").order("id");
        return planId == null ? query : query.eq("plan_id", planId);
      });
      return rows.map(({ plans, ...trade }) => ({ ...trade, ...plans }));
    },

    addTrade(values) {
      return readResult("記錄成交失敗", () => client.from("trades").insert(values).select().single());
    },

    async latestPrices(symbols) {
      const latest = new Map();
      const unique = [...new Set(symbols)];
      const today = todayStr();
      for (let offset = 0; offset < unique.length; offset += 10) {
        await Promise.all(unique.slice(offset, offset + 10).map(async (symbol) => {
          const quote = await readResult("讀取行情失敗", () => client.from("prices")
            .select("close,trade_date").eq("symbol", symbol).lte("trade_date", today)
            .order("trade_date", { ascending: false }).limit(1).maybeSingle());
          if (quote) latest.set(symbol, quote);
        }));
      }
      return latest;
    },

    async priceOn(symbol, day) {
      const quote = await readResult("讀取歷史行情失敗", () => client.from("prices")
        .select("close").eq("symbol", symbol).lte("trade_date", day)
        .order("trade_date", { ascending: false }).limit(1).maybeSingle());
      return quote?.close ?? null;
    },

    listFx() {
      return readRows("讀取匯率失敗", () => client
        .from("fx_rates").select("rate_date,hkd_cny").order("rate_date"));
    },

    listOpenAlerts(planId) {
      return readRows("讀取提醒失敗", () => {
        const query = client.from("alerts").select(alertColumns).eq("status", "open")
          .order("trigger_date", { ascending: false }).order("id", { ascending: false });
        return planId == null ? query : query.eq("plan_id", planId);
      });
    },

    getAlert(id) {
      return readResult("讀取提醒失敗", () => client.from("alerts")
        .select(alertColumns).eq("id", id).maybeSingle());
    },

    async resolveAlert(id, { resolution, resolution_note }) {
      const row = await readResult("處理提醒失敗", () => client.from("alerts")
        .update({ status: "resolved", resolution, resolution_note, resolved_at: new Date().toISOString() })
        .eq("id", id).eq("status", "open").select().maybeSingle());
      if (!row) throw new Error("這則提醒已處理過");
      return row;
    },

    listPendingAiEvidence() {
      return readRows("讀取待確認證據失敗", () => client.from("evidence")
        .select("*,plans(name,symbol)").eq("origin", "ai").eq("ai_status", "pending")
        .order("published_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }));
    },

    async listEvidence(planId) {
      const rows = await readRows("讀取證據日誌失敗", () => client.from("evidence")
        .select("*").eq("plan_id", planId)
        .order("created_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }));
      const time = (row) => Date.parse(row.published_at ?? row.created_at) || 0;
      return rows.sort((a, b) => time(b) - time(a));
    },

    getEvidence(id) {
      return readResult("讀取證據失敗", () => client.from("evidence")
        .select("*,plans(name,symbol,thesis,invalidation,catalyst)").eq("id", id).maybeSingle());
    },

    async confirmEvidence(id, { ai_status, user_conclusion }) {
      const row = await readResult("確認證據失敗", () => client.from("evidence")
        .update({ ai_status, user_conclusion, confirmed_at: new Date().toISOString() })
        .eq("id", id).eq("ai_status", "pending").select().maybeSingle());
      if (!row) throw new Error("這則證據已確認過");
      return row;
    },

    async addEvidence({ ai_status: _aiStatus, ...values }) {
      try {
        return await readResult("新增證據失敗", () => client.from("evidence")
          .insert({ ...values, origin: "user" }).select().single());
      } catch (error) {
        // 催化劑證據已寫入、提醒尚未結案時，重試沿用已寫入的證據。
        if (!values.external_id || error.cause?.code !== "23505") throw error;
        const existing = await readResult("讀取已記錄證據失敗", () => client.from("evidence")
          .select("*").eq("external_id", values.external_id).eq("plan_id", values.plan_id)
          .eq("origin", "user").maybeSingle());
        if (!existing) throw error;
        return existing;
      }
    },

    listDraftExitReviews() {
      return readRows("讀取待寫單筆復盤失敗", () => client.from("exit_reviews")
        .select("*,plans(name,symbol)").eq("status", "draft").order("due_date").order("id"));
    },

    listExitReviews() {
      return readRows("讀取單筆復盤列表失敗", () => client.from("exit_reviews")
        .select("*,plans(name,symbol,market)")
        .order("completed_at", { ascending: false, nullsFirst: false }).order("due_date").order("id"));
    },

    listExitReviewsWithPlan() {
      return readRows("讀取單筆復盤失敗", () => client.from("exit_reviews")
        .select("*,plans(name,confidence)").order("closed_date").order("id"));
    },

    listNav() {
      return readRows("讀取淨值失敗", () => client.from("nav_daily")
        .select("nav_date,ret,bench_ret").order("nav_date"));
    },

    listAiConfirmations() {
      return readRows("讀取 AI 確認紀錄失敗", () => client.from("evidence")
        .select("origin,ai_status,confirmed_at").eq("origin", "ai").neq("ai_status", "pending").order("id"));
    },

    async listRules() {
      const rows = await rulesByCode();
      return rows.sort((a, b) => a.code.localeCompare(b.code, "zh-TW", { numeric: true }));
    },

    async addRule({ text, source_note }) {
      for (let attempt = 0; ; attempt++) {
        const rules = await rulesByCode();
        let max = 0n;
        for (const { code } of rules) {
          if (!/^R\d+$/.test(code)) continue;
          const number = BigInt(code.slice(1));
          if (number > max) max = number;
        }
        try {
          return await readResult("新增規則失敗", () => client.from("rules")
            .insert({ code: `R${max + 1n}`, text, source_note, status: "candidate", proposed_by: "user" })
            .select().single());
        } catch (error) {
          // 同時新增候選時，重新讀取已使用的代碼再試。
          if (error.cause?.code !== "23505" || attempt >= 2) throw error;
        }
      }
    },

    adoptRule(id, { status, effective_from }) {
      if (status !== "active" && status !== "trial") throw new Error("請選擇正式或試行");
      return updateRule(client, id, ["candidate"], { status, effective_from });
    },

    rejectRule(id) {
      return updateRule(client, id, ["candidate"], { status: "rejected" });
    },

    promoteRule(id) {
      return updateRule(client, id, ["trial"], { status: "active" });
    },

    withdrawRule(id, reason) {
      const withdraw_reason = reason.trim();
      if ([...withdraw_reason].length < 4) throw new Error("撤回理由至少 4 字");
      return updateRule(client, id, ["active", "trial"], {
        status: "withdrawn", withdrawn_at: todayStr(), withdraw_reason,
      });
    },

    requestRuleCandidates() {
      return readResult("送出規則候選請求失敗", () => client.from("ai_requests")
        .insert({ kind: "rule_candidates" }).select("status,created_at,error").single());
    },

    latestRuleRequest() {
      return readResult("讀取規則候選請求失敗", () => client.from("ai_requests")
        .select("status,created_at,error").eq("kind", "rule_candidates")
        .order("created_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false })
        .limit(1).maybeSingle());
    },

    latestNav() {
      return readResult("讀取淨值失敗", () => client.from("nav_daily")
        .select("nav_date,total_cny,ret,bench_ret").order("nav_date", { ascending: false })
        .limit(1).maybeSingle());
    },

    getExitReview(planId) {
      return readResult("讀取單筆復盤失敗", () => client.from("exit_reviews")
        .select("*").eq("plan_id", planId).maybeSingle());
    },

    getExitReviewById(id) {
      return readResult("讀取單筆復盤失敗", () => client.from("exit_reviews")
        .select("*,plans(*)").eq("id", id).maybeSingle());
    },

    saveExitReviewDraft(id, values) {
      return readResult("保存單筆復盤草稿失敗", () => client.from("exit_reviews")
        .update(exitReviewChanges(values)).eq("id", id).eq("status", "draft").select().maybeSingle());
    },

    async completeExitReview(id, values) {
      const row = await readResult("完成單筆復盤失敗", () => client.from("exit_reviews")
        .update({ ...exitReviewChanges(values), status: "done", completed_at: new Date().toISOString() })
        .eq("id", id).eq("status", "draft").select().maybeSingle());
      if (!row) throw new Error("這則復盤已完成");
      return row;
    },

    listPastNextTimes(excludeId) {
      return readResult("讀取以往復盤失敗", () => client.from("exit_reviews")
        .select("next_time,completed_at,plans(name)").eq("status", "done").neq("id", excludeId)
        .order("completed_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false }).limit(20));
    },

    createExitReview(values) {
      return readResult("建立單筆復盤失敗", () => client
        .from("exit_reviews").insert(values).select().single());
    },

    closePlan(id) {
      return readResult("計劃卡清倉失敗", () => client.from("plans")
        .update({ status: "closed", closed_at: new Date().toISOString() })
        .eq("id", id).eq("status", "active").select().maybeSingle());
    },

    async listEvidenceDirections() {
      const rows = await readRows("讀取理由狀態失敗", () => client
        .from("evidence").select("plan_id,direction,created_at").not("direction", "is", null)
        .order("created_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }));
      const directions = new Map();
      for (const row of rows) {
        if (!directions.has(row.plan_id)) directions.set(row.plan_id, row.direction);
      }
      return directions;
    },
  };
}
