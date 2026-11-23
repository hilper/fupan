import { h } from "../ui.js";

export async function render(root, ctx) {
  root.append(h("p", { class: "card empty" }, "這一頁在後續版本開放"));
}
