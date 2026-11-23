import { fmtDate } from "../format.js";
import {
  choiceField, decisionForm, field, h, localTimestamp, missingTodayItem, safeHttpUrl,
} from "../ui.js";

const sourceTypes = {
  announcement: "公告", news: "新聞", earnings: "財報", price: "價格", manual: "其他",
};

export const infoTypes = { fact: "事實", forecast: "預測", opinion: "觀點", rumor: "傳聞" };
export const confidenceLabels = { high: "高", mid: "中", low: "低" };

const directions = { strengthen: "強化", weaken: "削弱", none: "無關" };
const directionTones = { strengthen: "down", weaken: "up" };

function options(labels) {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

export const directionOptions = options(directions);

export function directionChip(direction) {
  return h("span", { class: `chip ${directionTones[direction] ?? ""}` }, directions[direction] ?? "—");
}

function judgmentLabel(status, direction) {
  if (status === "agreed") return directionTones[direction] ? `同意${directions[direction]}` : "同意";
  return { pending: "待確認", disagreed: "不同意", irrelevant: "無關" }[status] ?? "—";
}

export function evidenceLogRow(evidence) {
  const date = fmtDate(evidence.published_at ?? evidence.created_at);
  return h("li", { class: "record" },
    h("a", { class: "evidence-log-link", href: `#evidence/${evidence.id}` },
      h("div", { class: "record-meta" },
        h("span", { class: "lbl" }, [date, sourceTypes[evidence.source_kind], evidence.source_name]
          .filter(Boolean).join(" · ")),
        directionChip(evidence.direction),
        evidence.origin === "ai" && h("span", { class: "chip soft-chip" },
          judgmentLabel(evidence.ai_status, evidence.direction)),
        evidence.info_type === "rumor" && h("span", { class: "chip soft-chip" }, "傳聞"),
      ),
      h("strong", null, evidence.title),
    ),
  );
}

function detailRow(label, value) {
  return h("div", { class: "assessment-row" },
    h("dt", { class: "lbl" }, label),
    h("dd", null, value ?? "—"),
  );
}

function confirmationForm(root, ctx, evidence, backTo) {
  const judgment = choiceField("你的判斷", options({
    agreed: judgmentLabel("agreed", evidence.direction), disagreed: "不同意", irrelevant: "無關",
  }));
  const conclusion = h("textarea", { rows: 3, required: true });

  return decisionForm([
    judgment.element,
    field("你的結論（寫入證據日誌）", conclusion, "至少 4 字"),
  ], "寫入證據日誌", async () => {
    const text = conclusion.value.trim();
    if (!judgment.value) throw new Error("請選擇你的判斷");
    if ([...text].length < 4) throw new Error("結論至少 4 字");
    await ctx.db.confirmEvidence(evidence.id, { ai_status: judgment.value, user_conclusion: text });
    if (!root.isConnected) return;
    ctx.toast("已寫入");
    ctx.navigate(backTo);
  }, "card assessment-form");
}

export async function render(root, ctx) {
  const evidence = await ctx.db.getEvidence(ctx.params[0]);
  if (!root.isConnected) return;
  if (!evidence) return missingTodayItem(root, "證據", ctx.setBackTo);

  const ai = evidence.origin === "ai";
  const pending = ai && evidence.ai_status === "pending";
  const typeLabel = ai ? "信息評估" : "證據";
  const backTo = ctx.itemBackTo(evidence.plan_id);
  ctx.setTitle(evidence.title || typeLabel);
  ctx.setSubtitle([evidence.plans?.name, typeLabel].filter(Boolean).join(" · "));
  ctx.setBackTo(backTo);

  const url = safeHttpUrl(evidence.url);
  const timestamp = evidence.published_at ?? evidence.created_at;
  root.append(h("section", { class: "card" },
    h("div", { class: "record-head" },
      h("span", { class: "lbl" }, [evidence.source_name, localTimestamp(timestamp, true)]
        .filter(Boolean).join(" · ")),
      url && h("a", { class: "original-link", href: url, target: "_blank", rel: "noopener noreferrer" }, "查看原文 ↗"),
    ),
    evidence.info_type === "rumor" && h("div", null, h("span", { class: "chip soft-chip" }, "傳聞 · 只記錄")),
    h("blockquote", { class: "assessment-quote" }, `「${evidence.excerpt}」`),
    h("dl", { class: "assessment-details" },
      detailRow("類型", infoTypes[evidence.info_type]),
      detailRow("關聯", evidence.related_clause || "—"),
      detailRow("影響", directionChip(evidence.direction)),
      detailRow("新信息", evidence.is_new == null ? "—" : evidence.is_new ? "是" : "否"),
      ai && detailRow("AI 把握", confidenceLabels[evidence.ai_confidence]),
      ai && evidence.ai_note && detailRow("AI 說明", evidence.ai_note),
      evidence.counter_evidence && detailRow("反面證據", evidence.counter_evidence),
    ),
  ));
  root.append(pending ? confirmationForm(root, ctx, evidence, backTo) :
    h("section", { class: "card" }, h("dl", { class: "assessment-details" },
      ai && detailRow("你的判斷", judgmentLabel(evidence.ai_status, evidence.direction)),
      detailRow("你的結論", evidence.user_conclusion || "—"),
      ai && detailRow("確認時間", localTimestamp(evidence.confirmed_at)),
    )));
}

export async function renderNew(root, ctx) {
  const plan = await ctx.db.getPlan(ctx.params[0]);
  if (!root.isConnected) return;
  if (!plan) return missingTodayItem(root, "證據", ctx.setBackTo);
  ctx.setBackTo(ctx.itemBackTo(plan.id));
  ctx.setSubtitle(`${plan.name} · ${plan.symbol}`);
  if (!["active", "closed"].includes(plan.status)) {
    root.append(h("p", { class: "card" }, "草稿計劃卡不能加證據。"));
    return;
  }

  const sourceKind = choiceField("來源類型", options(sourceTypes), "manual");
  const sourceName = h("input", { type: "text", required: true });
  const url = h("input", { type: "url" });
  const published = h("input", { type: "date" });
  const title = h("input", { type: "text", required: true });
  const excerpt = h("textarea", { rows: 3, required: true });
  const infoType = choiceField("類型", options(infoTypes));
  const relatedClause = h("input", { type: "text" });
  const direction = choiceField("影響", directionOptions);
  const isNew = choiceField("是否新信息（選填）", options({ yes: "是", no: "否" }));
  const conclusion = h("textarea", { rows: 3, required: true });

  root.append(decisionForm([
    sourceKind.element,
    field("來源名稱", sourceName),
    field("原文網址（選填）", url),
    field("發布日期（選填）", published),
    field("標題", title),
    field("原文引用", excerpt),
    infoType.element,
    field("關聯條款（選填）", relatedClause, "例如：理由 2、失效條件"),
    direction.element,
    isNew.element,
    field("你的結論", conclusion, "至少 4 字"),
  ], "記錄證據", save));

  async function save() {
    const values = {
      plan_id: plan.id,
      source_kind: sourceKind.value,
      source_name: sourceName.value.trim(),
      title: title.value.trim(),
      excerpt: excerpt.value.trim(),
      info_type: infoType.value,
      related_clause: relatedClause.value.trim(),
      direction: direction.value,
      is_new: isNew.value ? isNew.value === "yes" : null,
      user_conclusion: conclusion.value.trim(),
    };
    const rawUrl = url.value.trim();
    if (!values.source_name) throw new Error("請填寫來源名稱");
    if (rawUrl && !safeHttpUrl(rawUrl)) throw new Error("原文網址須為有效的 http:// 或 https:// 網址");
    values.url = rawUrl || null;
    const date = published.value ? new Date(published.value + "T00:00:00") : null;
    if (published.validity.badInput || (date && !Number.isFinite(date.getTime()))) {
      throw new Error("請輸入有效的發布日期");
    }
    values.published_at = date?.toISOString() ?? null;
    if (!values.title) throw new Error("請填寫標題");
    if (!values.excerpt) throw new Error("請填寫原文引用");
    if (!values.info_type) throw new Error("請選擇類型");
    if (!values.direction) throw new Error("請選擇影響");
    if ([...values.user_conclusion].length < 4) throw new Error("結論至少 4 字");

    await ctx.db.addEvidence(values);
    if (!root.isConnected) return;
    ctx.toast("已記錄");
    ctx.navigate(`#plan/${plan.id}`);
  }
}
