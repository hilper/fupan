import { addDays, effectivePlan, holdingDays, quadrant, suggestedErrorTags, tradeReturn } from "../calc.js";
import { fmtDate, fmtMoney, todayStr } from "../format.js";
import {
  allowedPlanAmendments, confirmDialog, decision_quality, detailsValue, displayPlanValue, error_tags,
  field, h, localTimestamp, planFields, pnl_sources, pnlColor, reviewDeadline, seg, shortDate,
  signedPct, thesis_verdict,
} from "../ui.js";

const quadrantNotes = {
  "good-win": "決策好、結果好",
  "good-lose": "決策好但結果差，不必改方法",
  "bad-win": "決策差但賺了，最危險，要標錯誤",
  "bad-lose": "決策差、結果差",
};

export function missing(root, backTo) {
  root.replaceChildren(h("div", { class: "card" },
    h("p", null, "找不到這則單筆復盤"),
    h("a", { class: "btn", href: backTo }, "返回"),
  ));
}

function section(id, title, note, ...children) {
  return h("section", { class: "card review-section", "aria-labelledby": id },
    h("div", { class: "record-meta" },
      h("h2", { id }, title),
      note && h("span", { class: "lbl" }, note),
    ),
    children,
  );
}

function selectedLabels(options, selected) {
  const labels = options.filter(({ value }) => selected.includes(value)).map(({ label }) => label);
  return h("p", null, labels.join("，") || "—");
}

function multipleChoice(options, selected, onChange, labelId, className) {
  const values = new Set(selected);
  return h("div", { class: className, role: "group", "aria-labelledby": labelId },
    options.map(({ value, label, example }) => {
      const exampleId = example ? `review-example-${value}` : null;
      const button = h("button", {
        type: "button",
        class: "btn",
        "aria-pressed": values.has(value),
        "aria-describedby": exampleId,
        onclick: () => {
          if (values.has(value)) values.delete(value);
          else values.add(value);
          button.setAttribute("aria-pressed", values.has(value));
          onChange(options.filter((option) => values.has(option.value)).map((option) => option.value));
        },
      }, label);
      return example ? h("div", { class: "review-tag-option" },
        button, h("span", { class: "lbl", id: exampleId }, example),
      ) : button;
    }),
  );
}

function resultCard(review, benchmark) {
  function metric(label, value) {
    return h("div", { class: "nav-metric" },
      h("span", { class: "lbl" }, label),
      h("strong", { class: pnlColor(value) }, signedPct(value)),
    );
  }

  return section("review-result", "1 結果", "自動",
    h("div", { class: "grid-three" },
      metric("這筆收益", review.return_pct),
      metric(`${benchmark}同期`, review.bench_return_pct),
      metric("超額收益", review.excess_pct),
    ),
    review.bench_return_pct == null && h("p", { class: "lbl" }, "基準行情不足"),
  );
}

function evidenceSummary(planId, evidence) {
  const counts = { strengthen: 0, weaken: 0 };
  for (const { origin, ai_status, direction } of evidence) {
    if (origin !== "user" && !(origin === "ai" && ["agreed", "disagreed"].includes(ai_status))) continue;
    if (direction === "strengthen" || direction === "weaken") counts[direction]++;
  }
  return h("a", { class: "original-link", href: `#plan/${planId}` },
    `證據日誌：強化 ${counts.strengthen} 則、削弱 ${counts.weaken} 則 ›`,
  );
}

function executionCard(deviations, amendments) {
  return section("review-execution", "4 執行有沒有走樣", "系統比對",
    deviations.length ? [
      h("strong", { class: "warn" }, `計劃外 ${deviations.length} 次`),
      h("ul", { class: "record-list" }, deviations.map((row) =>
        h("li", { class: "record" },
          h("p", null, `${shortDate(row.trade_date)} · ${row.side === "buy" ? "買入" : "賣出"} ${row.quantity} 股 · 價格 ${fmtMoney(row.price)}`),
          h("p", { class: "record-note" }, row.reason),
        ),
      )),
    ] : h("p", null, "全部按計劃執行"),
    amendments.length > 0 && [
      h("strong", null, `計劃卡修訂 ${amendments.length} 次`),
      h("ul", { class: "record-list" }, amendments.map((row) =>
        h("li", { class: "record" },
          h("p", { class: "plan-read-text" }, `${planFields[row.field]?.label ?? row.field}：${displayPlanValue(row.field, row.new_value)}`),
          h("p", { class: "record-note" }, row.reason),
        ),
      )),
    ],
    h("p", { class: "lbl" }, "倉位大小對不對？想一想再打下面的分數。"),
  );
}

function afterSaleCard(review) {
  function followUp(months, days, value) {
    const label = `${months} 個月後`;
    return value == null
      ? h("p", { class: "lbl" }, `${label} ${shortDate(addDays(review.closed_date, days))} 自動補填`)
      : h("p", { class: "record-meta" },
        label, h("strong", { class: pnlColor(value) }, signedPct(value)),
      );
  }

  return section("review-after-sale", "5 賣出之後", "自動補填",
    followUp(1, 30, review.after_1m_pct),
    followUp(3, 91, review.after_3m_pct),
    (review.after_1m_pct != null || review.after_3m_pct != null) && h("p", { class: "lbl" }, "賣出後再漲為紅"),
  );
}

function pastNextTimes(rows) {
  return h("details", { class: "review-past" },
    h("summary", null, `你以前寫過的『下次怎麼做』（${rows.length} 則）`),
    h("ul", { class: "record-list" }, rows.map((row) =>
      h("li", { class: "record" },
        h("div", { class: "record-meta" },
          h("time", { class: "lbl", datetime: row.completed_at }, fmtDate(row.completed_at)),
          h("strong", null, row.plans?.name ?? "—"),
        ),
        h("p", { class: "plan-read-text" }, row.next_time),
      ),
    )),
  );
}

function updateOutcome(target, quality, excess) {
  const outcome = quadrant(quality, excess);
  target.replaceChildren(
    h("p", { class: "record-meta" },
      h("strong", null, "結果"),
      excess == null ? "—" : h("span", { class: pnlColor(excess) },
        `${excess > 0 ? "跑贏" : "跑輸"}（超額 ${signedPct(excess)}）`,
      ),
    ),
    h("div", { class: "record-meta", hidden: !outcome },
      outcome && h("span", { class: outcome.key === "bad-win" ? "chip warn" : "chip" }, outcome.label),
      outcome && h("span", { class: "lbl" }, quadrantNotes[outcome.key]),
    ),
  );
}

function detailSections(review, details, controls) {
  const { plan, amendments, evidence, past, benchmark } = details;
  return [
    resultCard(review, benchmark),
    section("review-thesis", "2 理由對不對", null,
      detailsValue("買入理由", displayPlanValue("thesis", plan.thesis)),
      detailsValue("催化劑", displayPlanValue("catalyst", plan.catalyst)),
      detailsValue("催化劑時間", displayPlanValue("catalyst_due", plan.catalyst_due)),
      evidenceSummary(review.plan_id, evidence),
      controls.thesis,
    ),
    section("review-pnl-sources", "3 賺賠來自哪裡", null, controls.sources),
    executionCard(review.deviations, amendments),
    afterSaleCard(review),
    section("review-next-time", "6 下次怎麼做", null,
      controls.nextTime, pastNextTimes(past), controls.repeat,
    ),
    section("review-quality", "決策品質", null,
      h("p", { class: "lbl" }, "理由是否充分、計劃是否完整、是否照著做"),
      controls.quality, controls.outcome,
    ),
    section("review-error-tags", "錯誤標籤", null, controls.suggestion, controls.tags),
  ];
}

function setHeader(ctx, review, days) {
  ctx.setTitle(`單筆復盤 · ${review.plans.name}`);
  ctx.setSubtitle(`${shortDate(review.closed_date)} 清倉 · 持有 ${days ?? "—"} 天`,
    review.status === "draft" && reviewDeadline(review.due_date, todayStr()));
}

function showCompleted(root, ctx, review, details) {
  setHeader(ctx, review, details.days);
  const outcome = h("div", { class: "review-outcome" });
  updateOutcome(outcome, review.decision_quality, review.excess_pct);
  root.replaceChildren(
    h("p", { class: "lbl" }, `已完成 ${localTimestamp(review.completed_at)} · 內容已鎖定`),
    ...detailSections(review, details, {
      thesis: selectedLabels(thesis_verdict, [review.thesis_verdict]),
      sources: selectedLabels(pnl_sources, review.pnl_sources),
      nextTime: h("p", { class: "plan-read-text" }, review.next_time),
      repeat: h("p", { class: "lbl" }, `重複錯誤：${review.is_repeat ? "是" : "否"}`),
      quality: selectedLabels(decision_quality, [review.decision_quality]),
      outcome,
      tags: selectedLabels(error_tags, review.error_tags),
    }),
  );
}

function tagSelectionRemembered(key, remember = false) {
  try {
    if (remember) localStorage.setItem(key, "1");
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function showDraft(root, ctx, review, details, pendingReturns, initialSave) {
  const { db, toast } = ctx;
  // 資料表的空陣列無法區分初始值與使用者清空，記住這個瀏覽器上已保存的操作。
  const tagKey = `exit-review-error-tags:${ctx.user.id}:${review.id}`;
  const suggested = !review.error_tags.length && !tagSelectionRemembered(tagKey)
    ? suggestedErrorTags(review.deviations) : [];
  const values = {
    thesis_verdict: review.thesis_verdict,
    pnl_sources: review.pnl_sources,
    next_time: review.next_time,
    is_repeat: review.is_repeat,
    decision_quality: review.decision_quality,
    error_tags: suggested.length ? suggested : review.error_tags,
  };

  const pending = new Map(Object.entries(pendingReturns));
  let timer;
  let saving;
  let completing = false;
  let closed = false;
  const saveStatus = h("p", { class: "form-status", role: "status" }, initialSave.time);
  const saveError = h("p", { class: "form-error", role: "alert" }, initialSave.error);
  const retry = h("button", {
    type: "button", class: "btn", hidden: !initialSave.error, onclick: () => {
      cancelSaveTimer();
      void flush();
    },
  }, "重試保存");
  const completionError = h("p", { class: "form-error", role: "alert" });
  const missingFields = h("ul", { class: "review-missing", "aria-live": "polite", id: "review-missing" });
  const complete = h("button", {
    type: "submit", class: "btn pri", "aria-describedby": "review-missing",
  }, "完成復盤");
  const outcome = h("div", { class: "review-outcome" });
  const suggestion = h("p", { class: "lbl warn", hidden: !suggested.length }, "依計劃外操作預選");

  function refresh() {
    const missing = [
      !values.thesis_verdict && "選擇理由對不對",
      !values.pnl_sources.length && "至少選擇一項賺賠來源",
      [...values.next_time.trim()].length < 4 && "「下次怎麼做」至少填寫 4 字",
      !values.decision_quality && "選擇決策品質",
      values.decision_quality === "bad" && !values.error_tags.length && "決策品質為「差」時，至少選擇一個錯誤標籤",
    ].filter(Boolean);
    missingFields.replaceChildren(...missing.map((message) => h("li", null, message)));
    missingFields.hidden = !missing.length;
    complete.disabled = completing || missing.length > 0;
    editor.disabled = completing;
    updateOutcome(outcome, values.decision_quality, review.excess_pct);
  }

  function cancelSaveTimer() {
    clearTimeout(timer);
    timer = null;
  }

  function scheduleSave() {
    cancelSaveTimer();
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, 800);
  }

  function change(key, value) {
    if (values[key] === value) return;
    values[key] = value;
    pending.set(key, value);
    if (key === "error_tags") suggestion.hidden = true;
    completionError.textContent = "";
    refresh();
    scheduleSave();
  }

  async function flush() {
    while (saving) await saving;
    if (timer != null || completing || closed || !pending.size) return;

    const changes = Object.fromEntries(pending);
    retry.disabled = true;
    saveError.textContent = "";
    saveStatus.textContent = "正在保存…";
    saving = (async () => {
      try {
        const updated = await db.saveExitReviewDraft(review.id, changes);
        if (!updated) {
          closed = true;
          if (root.isConnected) await render(root, ctx);
          return;
        }
        for (const [key, value] of Object.entries(changes)) {
          if (pending.get(key) === value) pending.delete(key);
        }
        if (Object.hasOwn(changes, "error_tags")) tagSelectionRemembered(tagKey, true);
        saveStatus.textContent = `已自動保存 ${localTimestamp(updated.updated_at).slice(-5)}`;
        retry.hidden = true;
      } catch (error) {
        saveError.textContent = error.message;
        saveStatus.textContent = "";
        retry.hidden = false;
      } finally {
        retry.disabled = false;
      }
    })();
    const currentSave = saving;
    await currentSave;
    if (saving === currentSave) saving = null;
  }

  async function submit(event) {
    event.preventDefault();
    if (complete.disabled || closed) return;
    completing = true;
    refresh();
    try {
      if (!await confirmDialog("完成後內容鎖定，不能再修改。確定完成？")) return;
      cancelSaveTimer();
      if (saving) await saving;
      if (closed || !root.isConnected) return;
      const result = await db.completeExitReview(review.id, { ...values, ...Object.fromEntries(pending) });
      closed = true;
      toast("單筆復盤已完成");
      if (root.isConnected) showCompleted(root, ctx, { ...review, ...result }, details);
    } catch (error) {
      completionError.textContent = error.message;
    } finally {
      completing = false;
      if (!closed) {
        refresh();
        if (pending.size && root.isConnected) scheduleSave();
      }
    }
  }

  const nextTime = h("textarea", {
    rows: 3, oninput: (event) => change("next_time", event.currentTarget.value),
  }, values.next_time);
  const repeat = h("input", {
    type: "checkbox", checked: values.is_repeat,
    onchange: (event) => change("is_repeat", event.currentTarget.checked),
  });
  const controls = {
    thesis: seg(thesis_verdict, values.thesis_verdict, (value) => change("thesis_verdict", value), "review-thesis"),
    sources: multipleChoice(pnl_sources, values.pnl_sources, (value) => change("pnl_sources", value),
      "review-pnl-sources", "review-choices"),
    nextTime: field("下次怎麼做", nextTime, "至少 4 字"),
    repeat: h("label", { class: "check-label" }, repeat, "這句話之前寫過（標記為重複錯誤）"),
    quality: seg(decision_quality, values.decision_quality,
      (value) => change("decision_quality", value), "review-quality"),
    outcome,
    suggestion,
    tags: multipleChoice(error_tags, values.error_tags, (value) => change("error_tags", value),
      "review-error-tags", "review-tags"),
  };
  const editor = h("fieldset", { class: "review-form plan-form-fields" },
    ...detailSections(review, details, controls), missingFields, completionError, complete,
  );
  setHeader(ctx, review, details.days);
  root.replaceChildren(
    h("div", { class: "record-meta review-save" }, saveStatus, saveError, retry),
    h("form", { onsubmit: submit }, editor),
  );
  refresh();
}

export async function render(root, ctx) {
  const { db, params, setBackTo, itemBackTo } = ctx;
  const original = await db.getExitReviewById(params[0]);
  if (!root.isConnected) return;
  if (!original?.plans) return missing(root, ctx.backTo);
  setBackTo(itemBackTo(original.plan_id));

  const [trades, amendments, evidence, past] = await Promise.all([
    db.listTrades(original.plan_id), db.listAmendments(original.plan_id),
    db.listEvidence(original.plan_id), db.listPastNextTimes(original.id),
  ]);
  if (!root.isConnected) return;

  const hk = original.plans.market === "HK";
  const details = {
    plan: effectivePlan(original.plans, allowedPlanAmendments(amendments)),
    amendments, evidence, past,
    benchmark: hk ? "恒生指數" : "滬深 300",
    days: holdingDays(trades, original.closed_date),
  };
  if (original.status === "done") return showCompleted(root, ctx, original, details);

  const benchmark = hk ? "HSI.HK" : "000300.SH";
  const firstBuy = trades.find((trade) => trade.side === "buy");
  const [start, end] = await Promise.all([
    firstBuy ? db.priceOn(benchmark, firstBuy.trade_date) : null,
    db.priceOn(benchmark, original.closed_date),
  ]);
  if (!root.isConnected) return;
  const recalculated = tradeReturn(trades, start, end);
  const differs = Object.entries(recalculated).some(([key, value]) => {
    const previous = original[key];
    return value == null || previous == null
      ? value !== previous : Math.abs(value - Number(previous)) > 0.00005;
  });

  let review = original;
  let pendingReturns = {};
  const initialSave = {};
  if (differs) {
    review = { ...original, ...recalculated };
    try {
      const updated = await db.saveExitReviewDraft(original.id, recalculated);
      if (!root.isConnected) return;
      if (!updated) return render(root, ctx);
      review = { ...review, ...updated };
      initialSave.time = `已自動保存 ${localTimestamp(updated.updated_at).slice(-5)}`;
    } catch (error) {
      pendingReturns = recalculated;
      initialSave.error = error.message;
    }
  }

  if (root.isConnected) showDraft(root, ctx, review, details, pendingReturns, initialSave);
}
