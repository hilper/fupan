import { quadrant } from "../calc.js";
import { todayStr } from "../format.js";
import { decision_quality, error_tags, h, pnlColor, reviewDeadline, shortDate, signedPct } from "../ui.js";

function draftRow(review, today) {
  return h("a", { class: "record record-head plan-link", href: `#exit-review/${review.id}` },
    h("div", { class: "holding-name" },
      h("div", { class: "record-meta" },
        h("strong", null, review.plans?.name ?? "—"),
        h("span", { class: "lbl" }, review.plans?.symbol),
      ),
      h("span", { class: "lbl" }, `${shortDate(review.closed_date)} 清倉`),
    ),
    reviewDeadline(review.due_date, today),
  );
}

function completedRow(review) {
  const quality = decision_quality.find(({ value }) => value === review.decision_quality);
  const outcome = quadrant(review.decision_quality, review.excess_pct);
  const tags = error_tags.filter(({ value }) => review.error_tags.includes(value)).map(({ label }) => label);
  return h("a", { class: "record review-completed-row", href: `#exit-review/${review.id}` },
    h("div", { class: "record-head" },
      h("strong", null, review.plans?.name ?? "—"),
      h("span", { class: "record-meta" },
        h("span", { class: "lbl" }, "超額收益"),
        h("strong", { class: pnlColor(review.excess_pct) }, signedPct(review.excess_pct)),
      ),
    ),
    h("div", { class: "record-meta" },
      quality && h("span", { class: "chip" }, `決策品質：${quality.label}`),
      outcome && h("span", { class: outcome.key === "bad-win" ? "chip warn" : "chip" }, outcome.label),
    ),
    tags.length > 0 && h("p", { class: "lbl" }, tags.join("，")),
  );
}

export async function render(root, { db }) {
  const reviews = await db.listExitReviews();
  if (!root.isConnected) return;
  const today = todayStr();
  const drafts = reviews.filter(({ status }) => status === "draft")
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const completed = reviews.filter(({ status }) => status === "done");

  root.replaceChildren(...[
    drafts.length > 0 && h("section", { class: "card" },
      h("h2", null, "待寫"), drafts.map((review) => draftRow(review, today)),
    ),
    completed.length > 0 && h("section", { class: "card" },
      h("h2", null, "已完成"), completed.map(completedRow),
    ),
    reviews.length === 0 && h("p", { class: "card empty" }, "還沒有清倉的交易。清倉後會在這裡出現單筆復盤。"),
    h("p", { class: "lbl" }, "季度統計與規則在『統計』『規則』分頁"),
  ].filter(Boolean));
}
