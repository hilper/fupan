export const HOLDINGS_PASSES = [
  ["name", 0, 0.31, ""],
  ["qty", 0.31, 0.5, "0123456789,"],
  ["price", 0.5, 0.72, "0123456789.,"],
];

const headings = /^(?:(?:证券|證券)?名[称稱](?:[/／|]?市值)?|市值|持[仓倉]明[细細]|全部\d*|[沪滬深京港]股\d*)$/;

function compact(text) {
  return text.replace(/\s/g, "");
}

function readNumber(text, integer = false) {
  let value = compact(text).replace(/,/g, "");
  if (!integer) value = value.replace(/\.(?=.*\.)/g, "");
  if (!(integer ? /^-?\d+$/ : /^-?\d+(?:\.\d+)?$/).test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function center(line) {
  return (line.y0 + line.y1) / 2;
}

function closestValue(lines, anchor, read) {
  const target = center(anchor);
  let distance = (anchor.y1 - anchor.y0) / 2;
  let value = null;
  for (const line of lines) {
    const gap = Math.abs(center(line) - target);
    if (gap > distance || gap === distance && value != null) continue;
    const parsed = read(line.text);
    if (parsed == null) continue;
    distance = gap;
    value = parsed;
  }
  return value;
}

function readName(text) {
  const name = compact(text);
  return /\p{Script=Han}/u.test(name) ? name : null;
}

export function parseHoldingsLines({ name, qty, price }) {
  const rows = [];
  const quantities = [...qty].sort((first, second) => first.y0 - second.y0);
  for (let index = 0; index + 1 < quantities.length; index++) {
    const holding = quantities[index];
    const available = quantities[index + 1];
    const quantity = readNumber(holding.text, true);
    const gap = available.y0 - holding.y0;
    if (quantity == null || readNumber(available.text, true) == null ||
      gap <= 0 || gap > (holding.y1 - holding.y0) * 2.5) continue;
    const holdingName = closestValue(name, holding, readName);
    if (holdingName && headings.test(holdingName)) continue;
    index += 1;
    const market_value = closestValue(name, available, readNumber);
    const cost = closestValue(price, available, readNumber);
    let current = closestValue(price, holding, readNumber);
    const implied = market_value != null && quantity > 0 ? market_value / quantity : null;
    const implied_price = implied == null ? null : Math.round(implied * 1000) / 1000;
    const flags = [];
    if (!holdingName) flags.push("缺少名稱");
    if (cost == null) flags.push("缺少成本");
    if (quantity <= 0) flags.push("股數須大於 0");
    if (cost != null && cost <= 0) flags.push("成本須大於 0");
    if (implied > 0) {
      if (current == null) current = implied_price;
      else if (Math.abs(current / implied - 1) > 0.02 + Number.EPSILON) {
        current = implied_price;
        flags.push("現價識別可能有誤");
      }
    }
    rows.push({ name: holdingName ?? "", quantity, market_value, price: current, cost, implied_price, flags });
  }
  return rows;
}
