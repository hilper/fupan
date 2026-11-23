import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";
import { createDb } from "./db.js";
import { field, h, missingTodayItem, toast } from "./ui.js";
import * as settings from "./screens/settings.js";
import * as holdings from "./screens/holdings.js";
import * as plan from "./screens/plan.js";
import * as planNew from "./screens/plan-new.js";
import * as trade from "./screens/trade.js";
import * as today from "./screens/today.js";
import * as alert from "./screens/alert.js";
import * as evidence from "./screens/evidence.js";
import * as review from "./screens/review.js";
import * as exitReview from "./screens/exit-review.js";
import * as stats from "./screens/stats.js";
import * as rules from "./screens/rules.js";

const tabs = [
  ["today", "今日", [["rect", { x: 3, y: 5, width: 18, height: 16, rx: 2 }], ["path", { d: "M3 10h18M8 3v4M16 3v4" }]]],
  ["holdings", "持倉", [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M12 3v9h9" }]]],
  ["review", "復盤", [["path", { d: "M4 12a8 8 0 1 0 2.3-5.6" }], ["path", { d: "M4 4v4h4" }]]],
  ["stats", "統計", [["path", { d: "M5 20V10M12 20V4M19 20v-7" }]]],
  ["rules", "規則", [["rect", { x: 5, y: 3, width: 14, height: 18, rx: 2 }], ["path", { d: "M9 8h6M9 12h6M9 16h4" }]]],
];

const routes = new Map();
routes.set("settings", { screen: settings });
routes.set("today", { title: "今日待處理", screen: today, subtitle: true });
routes.set("holdings", { title: "持倉", screen: holdings });
routes.set("review", { title: "復盤", screen: review });
routes.set("stats", { title: "季度統計", screen: stats, subtitle: true });
routes.set("rules", { title: "規則清單", screen: rules, subtitle: true });
routes.set("exit-review", { title: "單筆復盤", screen: exitReview, hasId: true, subtitle: true });
routes.set("plan", { title: "計劃卡", screen: plan, hasId: true });
routes.set("plan-new", { title: "新計劃卡", screen: planNew, hasId: true, optionalId: true });
routes.set("trade", { title: "記一筆成交", screen: trade, hasId: true });
routes.set("alert", { title: "處理提醒", screen: alert, hasId: true, todayItem: "提醒", subtitle: true });
routes.set("evidence", { title: "證據", screen: evidence, hasId: true, todayItem: "證據", subtitle: true });
routes.set("evidence-new", {
  title: "加證據", screen: { render: evidence.renderNew }, hasId: true, todayItem: "證據", subtitle: true,
});

const app = document.getElementById("app");
let auth;
let db;
let user = null;
let lastTab = null;
let previousPlanRoute = null;

function icon(parts) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  const attributes = {
    width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  };
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
  for (const [tag, attrs] of parts) {
    const part = document.createElementNS(namespace, tag);
    for (const [key, value] of Object.entries(attrs)) part.setAttribute(key, value);
    svg.append(part);
  }
  return svg;
}

function tabbar(active) {
  return h("nav", { class: "tabbar", "aria-label": "主選單" },
    tabs.map(([name, label, parts]) => h("a", {
      class: name === active ? "tab on" : "tab",
      href: `#${name}`,
      "aria-current": name === active ? "page" : null,
    }, icon(parts), h("span", null, label))),
  );
}

function settingsLink() {
  return h("a", { class: "btn icon-btn", href: "#settings", "aria-label": "設定" }, icon([
    ["path", { d: "M10 3h4l.6 2.3 1.6.9 2.3-.6 2 3.4-1.7 1.7v1.8l1.7 1.7-2 3.4-2.3-.6-1.6.9-.6 2.3h-4l-.6-2.3-1.6-.9-2.3.6-2-3.4 1.7-1.7v-1.8L3.5 9l2-3.4 2.3.6 1.6-.9z" }],
    ["circle", { cx: 12, cy: 11.6, r: 2.7 }],
  ]));
}

function navigate(hash, { replace = false } = {}) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}

function isAuthCallbackHash(hash) {
  return /^#(?:access_token|error|type)=/.test(hash);
}

function currentRoute() {
  const hash = location.hash;
  if (isAuthCallbackHash(hash)) return null;
  const [prefix, ...segments] = hash.slice(1).split("/");
  if (!routes.has(prefix)) {
    history.replaceState(history.state, "", "#today");
    return { prefix: "today", params: [] };
  }
  const params = segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  return { prefix, params };
}

async function signOut() {
  const { error } = await auth.signOut({ scope: "local" });
  if (error) throw new Error(`登出失敗：${authMessage(error)}`, { cause: error });
}

async function renderRoute() {
  const route = currentRoute();
  if (!route) return;
  const { prefix, params } = route;
  const { title, screen, hasId, optionalId, todayItem, subtitle } = routes.get(prefix);
  const [id] = params;
  const validId = /^[1-9]\d{0,18}$/.test(id ?? "") && BigInt(id) <= 9223372036854775807n;
  const invalid = hasId && !(params.length === 1 && validId || optionalId && !params.length);
  const isTab = tabs.some(([name]) => name === prefix);
  const isExitReview = prefix === "exit-review";
  const itemBackKey = isExitReview ? "exitReviewBack" : todayItem ? "todayItemBack" : null;
  if (isTab) lastTab = location.hash;
  if (prefix === "settings" && !history.state?.settingsBack) {
    history.replaceState({ ...history.state, settingsBack: lastTab ?? "#today" }, "");
  }
  if (itemBackKey && !history.state?.[itemBackKey]) {
    history.replaceState({
      ...history.state,
      [itemBackKey]: { sourcePlan: previousPlanRoute, tab: lastTab ?? (isExitReview ? "#review" : "#today") },
    }, "");
  }
  previousPlanRoute = prefix === "plan" && !invalid ? `#plan/${id}` : null;

  const content = h("div", { class: "stack" });
  const itemBack = itemBackKey ? history.state[itemBackKey] : null;
  let backTo = prefix === "settings" ? history.state.settingsBack : lastTab ?? "#today";
  if (invalid || prefix === "plan-new" && validId) backTo = "#holdings";
  if (prefix === "trade" && !invalid) backTo = `#plan/${id}`;
  if (todayItem) backTo = invalid ? "#today" : itemBack.sourcePlan ?? itemBack.tab;
  if (isExitReview) backTo = itemBack.sourcePlan ?? itemBack.tab;
  const back = !isTab && h("a", { class: "back", href: backTo }, "‹ 返回");
  const pageTitle = h("h1", null, screen.title ?? title);
  const pageSubtitle = subtitle && h("p", { class: "lbl", hidden: true });
  const heading = h("header", { class: isExitReview ? "page-header exit-review-header" : "page-header" },
    subtitle ? h("div", { class: isTab ? "page-title" : "page-title assessment-title" },
      pageSubtitle, pageTitle) : pageTitle,
    isTab && h("div", { class: "header-actions" },
      prefix === "holdings" && h("a", { class: "btn", href: "#plan-new" }, "＋ 新計劃卡"),
      settingsLink(),
    ),
  );
  document.body.classList.toggle("with-tabs", isTab);
  app.replaceChildren(
    ...(back ? [back] : []),
    heading,
    content,
    ...(isTab ? [tabbar(prefix)] : []),
  );
  window.scrollTo(0, 0);
  if (invalid) {
    if (isExitReview) return exitReview.missing(content, backTo);
    if (todayItem) return missingTodayItem(content, todayItem);
    content.append(h("div", { class: "card" },
      h("p", null, "找不到這張計劃卡"),
      h("a", { class: "btn", href: "#holdings" }, "返回持倉"),
    ));
    return;
  }
  try {
    await screen.render(content, {
      db, user, params, navigate, toast, signOut,
      setTitle: (value) => { pageTitle.textContent = value; },
      setSubtitle: (value, badge) => {
        if (!pageSubtitle) return;
        pageSubtitle.textContent = value;
        if (badge) pageSubtitle.append(badge);
        pageSubtitle.hidden = !value;
      },
      setBackTo: (hash) => { if (back) back.setAttribute("href", hash); },
      itemBackTo: (planId) => itemBack?.sourcePlan === `#plan/${planId}`
        ? itemBack.sourcePlan : itemBack?.tab ?? backTo,
      backTo,
    });
  } catch (error) {
    content.append(h("p", { class: "form-error", role: "alert" }, error.message));
  }
}

function authMessage(error) {
  const message = error.message || String(error);
  if (error.code === "invalid_credentials" || /invalid login credentials/i.test(message)) {
    return "帳號或密碼錯誤";
  }
  if (error.code === "email_not_confirmed" || /email not confirmed/i.test(message)) {
    return "Email 尚未確認，請先到信箱點確認連結";
  }
  if (error.name === "AuthRetryableFetchError" || /failed to fetch|network|load failed/i.test(message)) {
    return "網路錯誤，請檢查連線後再試";
  }
  return message;
}

function renderAuth(registering = false, initialError = "") {
  const email = h("input", { type: "email", autocomplete: "email", required: true });
  const password = h("input", {
    type: "password", autocomplete: registering ? "new-password" : "current-password", required: true,
  });
  const confirmation = h("input", { type: "password", autocomplete: "new-password", required: true });
  const action = registering ? "建立帳號" : "登入";
  const submit = h("button", { class: "btn pri", type: "submit" }, action);
  const toggle = h("button", {
    class: "btn text-btn", type: "button", onclick: () => renderAuth(!registering),
  }, registering ? "返回登入" : "建立帳號");
  const errorText = h("p", { class: "form-error", role: "alert" }, initialError);
  const status = h("p", { class: "form-status", role: "status" });

  const form = h("form", { class: "card form-stack", onsubmit: submitAuth },
    field("Email", email),
    field("密碼", password),
    registering && field("確認密碼", confirmation),
    submit,
    errorText,
    status,
  );

  async function submitAuth(event) {
    event.preventDefault();
    if (submit.disabled) return;
    errorText.textContent = "";
    status.textContent = "";
    if (registering && confirmation.value !== password.value) {
      errorText.textContent = "兩次輸入的密碼不一致";
      confirmation.focus();
      return;
    }

    submit.disabled = true;
    toggle.disabled = true;
    try {
      const credentials = { email: email.value.trim(), password: password.value };
      const { error } = registering
        ? await auth.signUp({
          ...credentials,
          options: { emailRedirectTo: location.origin + location.pathname },
        })
        : await auth.signInWithPassword(credentials);
      if (error) throw error;
      if (registering) {
        status.textContent = "已寄出確認信，請到信箱點連結後回來登入";
      }
    } catch (error) {
      errorText.textContent = authMessage(error);
    } finally {
      submit.disabled = false;
      toggle.disabled = false;
    }
  }

  document.body.classList.remove("with-tabs");
  app.replaceChildren(h("div", { class: "auth stack" },
    h("h1", null, "復盤"),
    form,
    toggle,
  ));
  window.scrollTo(0, 0);
}

async function start() {
  if (!window.supabase?.createClient) {
    throw new Error("無法載入 vendor/supabase-js-2.45.4.js");
  }
  const initialHash = location.hash;
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  auth = client.auth;
  db = createDb(client);

  const { data, error } = await auth.getSession();
  const remainingHash = location.hash;
  const errorHash = remainingHash.startsWith("#error=") ? remainingHash : initialHash;
  const callbackError = errorHash.startsWith("#error=")
    ? new URLSearchParams(errorHash.slice(1)).get("error_description") ?? ""
    : "";
  if (isAuthCallbackHash(remainingHash)) {
    history.replaceState(history.state, "", "#today");
  }
  if (error) throw new Error(`讀取登入狀態失敗：${authMessage(error)}`, { cause: error });
  user = data.session?.user ?? null;

  window.addEventListener("hashchange", async () => {
    if (user) await renderRoute();
    else currentRoute();
  });
  auth.onAuthStateChange((event, session) => {
    // 等 SDK 釋放 auth lock 再渲染，畫面可能立即發出資料請求。
    setTimeout(async () => {
      if (event === "SIGNED_OUT") {
        user = null;
        lastTab = null;
        previousPlanRoute = null;
        renderAuth();
      } else if (event === "SIGNED_IN" && session?.user) {
        const previousId = user?.id;
        user = session.user;
        if (user.id !== previousId) {
          lastTab = "#today";
          history.replaceState(history.state, "", "#today");
          await renderRoute();
        }
      }
    }, 0);
  });

  if (user) {
    await renderRoute();
  } else {
    currentRoute();
    renderAuth(false, callbackError);
  }
  window.appReady = true;
}

window.appToast = toast;
start().catch(window.appError);
