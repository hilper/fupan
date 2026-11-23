const money = new Intl.NumberFormat("zh-TW", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const percent = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });

function formatNumber(value, formatter, suffix = "") {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "—";
  return formatter.format(Number(value)) + suffix;
}

export function fmtMoney(value) {
  return formatNumber(value, money);
}

export function fmtPct(value) {
  return formatNumber(value, percent, "%");
}

export function fmtDate(value) {
  if (!value) return "—";
  // SQL date 沒有時區，直接保留日期，避免被當成 UTC 午夜換算。
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayStr() {
  return fmtDate(new Date());
}
