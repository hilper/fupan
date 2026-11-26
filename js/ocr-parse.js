const pricePattern = /^\d+\.\d+$/;
const quantityPattern = /^[+-]\d+$/;
const amountPattern = /^[+-]?\d+(?:\.\d+)?$/;
const datePattern = /(\d{4})\D?(\d{2})\D?(\d{2})/;

function compact(text) {
  return text.replace(/\s/g, "");
}

function numericText(text) {
  return compact(text).replace(/,/g, "").replace(/[_−–]/g, "-");
}

function center(line) {
  return (line.y0 + line.y1) / 2;
}

function closestLine(lines, target, lower, upper, matches = () => true) {
  let closest;
  for (const line of lines) {
    const y = center(line);
    if (y < lower || y > upper || !matches(line)) continue;
    if (!closest || Math.abs(y - target) < Math.abs(center(closest) - target)) closest = line;
  }
  return closest;
}

export function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function tradeKey(row) {
  return `${row.side ?? row.kind}|${row.trade_date}|${Number(row.quantity)}|${Number(row.price).toFixed(3)}`;
}

export function isReviewDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function localToday() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function reviewFlags(row, today = localToday()) {
  const { trade_date: date, amount, kind, fee, price, quantity, actionText } = row;
  const flags = [];
  if (!date) flags.push("缺少日期");
  else if (!isReviewDate(date)) flags.push("日期不合法");
  else if (date > today) flags.push("日期晚於今天");
  if (amount == null) flags.push("缺少金額");
  else if (kind === "buy" && amount >= 0 || kind === "sell" && amount <= 0) {
    flags.push("金額正負與買賣方向不符");
  }
  if (fee < 0) flags.push("費用為負數");
  else if (fee > price * quantity * 0.01 + 50) flags.push("費用偏高");

  const readsBuy = /[买入]/.test(actionText);
  const readsSell = /[卖出]/.test(actionText);
  if (readsBuy && !readsSell && kind === "sell" || readsSell && !readsBuy && kind === "buy") {
    flags.push("識別文字與買賣方向不符");
  }
  return flags;
}

function readDate(lines, priceLine, quantityLine, halfHeight) {
  let invalid = "";
  for (const line of lines) {
    const y = center(line);
    if (y < priceLine.y0 || y > quantityLine.y1 + halfHeight) continue;
    const match = compact(line.text).match(datePattern);
    if (!match) continue;
    const date = match.slice(1).join("-");
    if (isReviewDate(date)) return date;
    invalid ||= date;
  }
  return invalid;
}

export function parseReviewLines({ full, left, mid, right }) {
  const rows = [];
  const middle = [...mid].sort((first, second) => first.y0 - second.y0);
  const titles = full.filter((line) => /建仓|清仓/.test(compact(line.text)));
  const today = localToday();
  for (let index = 0; index + 1 < middle.length; index++) {
    const priceLine = middle[index];
    const priceText = numericText(priceLine.text);
    if (!pricePattern.test(priceText)) continue;
    const quantityLine = middle[index + 1];
    const quantityText = numericText(quantityLine.text);
    const height = priceLine.y1 - priceLine.y0;
    if (!quantityPattern.test(quantityText) || quantityLine.y0 <= priceLine.y0
      || quantityLine.y0 - priceLine.y0 > 2 * height) continue;

    const price = Number(priceText);
    const quantity = Math.abs(Number(quantityText));
    const qtySign = quantityText[0];
    const kind = price === 0 || quantity === 0 ? "dividend" : qtySign === "+" ? "buy" : "sell";
    const y = center(priceLine);
    const halfHeight = height / 2;
    const amountLine = closestLine(right, y, priceLine.y0 - halfHeight, quantityLine.y1 + halfHeight,
      (line) => amountPattern.test(numericText(line.text)));
    const amount = amountLine ? Number(numericText(amountLine.text)) : null;
    const actionText = closestLine(full, y, y - halfHeight, y + halfHeight)?.text ?? "";
    const gross = price * quantity;
    // 賣出金額是扣除費用後的實收，買入金額則包含費用。
    const fee = amount == null ? null
      : round2(kind === "sell" ? gross - Math.abs(amount) : Math.abs(amount) - gross);
    const row = {
      price, quantity, qtySign, kind, amount, actionText, fee,
      trade_date: readDate(left, priceLine, quantityLine, halfHeight),
      section: titles.filter((line) => center(line) < priceLine.y0).length - 1,
    };
    rows.push({ ...row, flags: reviewFlags(row, today) });
  }
  return { rows };
}
