import { fmtDate } from "./format.js";

function rounded(value, digits = 2) {
  if (value == null) return null;
  const scale = 10 ** digits;
  const magnitude = Math.abs(value) * scale;
  return (Math.sign(value) * Math.round(magnitude + magnitude * Number.EPSILON) / scale) || 0;
}

function hasValue(value) {
  return value != null && String(value).trim() !== "";
}

export function symbolInfo(code) {
  const input = String(code ?? "").trim().toUpperCase();
  if (/^\d{5}(?:\.HK)?$/.test(input)) {
    return { symbol: input.slice(0, 5) + ".HK", market: "HK", currency: "HKD" };
  }
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(input)) {
    return { symbol: input, market: "A", currency: "CNY" };
  }
  if (!/^\d{6}$/.test(input)) return null;
  const exchanges = { 6: "SH", 9: "SH", 0: "SZ", 3: "SZ", 4: "BJ", 8: "BJ" };
  const exchange = exchanges[input[0]];
  return exchange ? { symbol: input + "." + exchange, market: "A", currency: "CNY" } : null;
}

function sortedTrades(trades) {
  return [...trades].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
}

function totalsByPlan(trades, asOf) {
  const positions = new Map();
  for (const trade of sortedTrades(trades)) {
    if (trade.trade_date > asOf) break;
    const { plan_id, symbol, market } = trade;
    if (!positions.has(plan_id)) {
      positions.set(plan_id, { symbol, market, quantity: 0, avg_cost: 0, cost_cny: 0, realized_cny: 0 });
    }
    const pos = positions.get(plan_id);
    const quantity = Number(trade.quantity);
    const gross = quantity * Number(trade.price);
    const fee = Number(trade.fee);
    const fx = Number(trade.fx_to_cny);
    const held = pos.quantity;
    // 成交數量在資料庫以四位小數保存，避免清倉留下浮點殘差。
    const delta = trade.side === "buy" ? quantity : -quantity;
    pos.quantity = rounded(held + delta, 4);
    if (trade.side === "buy") {
      const cost = gross + fee;
      if (pos.quantity) pos.avg_cost = (pos.avg_cost * held + cost) / pos.quantity;
      pos.cost_cny += cost * fx;
    } else {
      const soldCost = held ? pos.cost_cny * quantity / held : 0;
      pos.cost_cny -= soldCost;
      pos.realized_cny += (gross - fee) * fx - soldCost;
    }
    if (!pos.quantity) pos.cost_cny = 0;
  }
  return positions;
}

export function buildPositions(trades, asOf) {
  const positions = totalsByPlan(trades, asOf);
  for (const pos of positions.values()) {
    pos.avg_cost = rounded(pos.avg_cost);
    pos.cost_cny = rounded(pos.cost_cny);
    pos.realized_cny = rounded(pos.realized_cny);
  }
  return positions;
}

function cashTotal(settings, trades, cashFlows, asOf) {
  let cash = Number(settings.start_cash ?? 0);
  for (const flow of cashFlows) {
    if (settings.start_date && flow.flow_date >= settings.start_date && flow.flow_date <= asOf) {
      cash += Number(flow.amount_cny);
    }
  }
  for (const trade of trades) {
    if (trade.trade_date > asOf) continue;
    const gross = Number(trade.quantity) * Number(trade.price);
    const amount = (trade.side === "buy" ? -gross : gross) - Number(trade.fee);
    cash += amount * Number(trade.fx_to_cny);
  }
  return cash;
}

export function cashOn(settings, trades, cashFlows, asOf) {
  return rounded(cashTotal(settings, trades, cashFlows, asOf));
}

export function latestFx(fxRows, day) {
  let earliest;
  let prior;
  for (const row of fxRows) {
    if (!earliest || row.rate_date < earliest.rate_date) earliest = row;
    if (row.rate_date <= day && (!prior || row.rate_date > prior.rate_date)) prior = row;
  }
  const match = prior ?? earliest;
  return match ? Number(match.hkd_cny) : null;
}

export function tradeReturn(tradesOfPlan, benchStart, benchEnd) {
  let buy = 0;
  let sell = 0;
  let fees = 0;
  for (const trade of tradesOfPlan) {
    const fx = Number(trade.fx_to_cny);
    const gross = Number(trade.quantity) * Number(trade.price) * fx;
    if (trade.side === "buy") buy += gross;
    else sell += gross;
    fees += Number(trade.fee) * fx;
  }
  const ret = buy ? (sell - buy - fees) / buy * 100 : null;
  const bench = hasValue(benchStart) && Number(benchStart) && hasValue(benchEnd)
    ? (Number(benchEnd) / Number(benchStart) - 1) * 100 : null;
  return {
    return_pct: rounded(ret, 4),
    bench_return_pct: rounded(bench, 4),
    excess_pct: rounded(ret != null && bench != null ? ret - bench : null, 4),
  };
}

export function holdingDays(trades, closedDate) {
  let firstBuy;
  for (const trade of trades) {
    if (trade.side === "buy" && (!firstBuy || trade.trade_date < firstBuy)) {
      firstBuy = trade.trade_date;
    }
  }
  return firstBuy ? (Date.parse(closedDate) - Date.parse(firstBuy)) / 86400000 : null;
}

export function quadrant(decisionQuality, excessPct) {
  if (decisionQuality == null || excessPct == null) return null;
  if (decisionQuality === "bad") {
    return excessPct > 0 ? { key: "bad-win", label: "僥倖" } : { key: "bad-lose", label: "該賠" };
  }
  return excessPct > 0 ? { key: "good-win", label: "實力" } : { key: "good-lose", label: "運氣不好" };
}

export function suggestedErrorTags(deviations) {
  return deviations?.length ? ["discipline"] : [];
}

const numericPlanFields = new Set([
  "stop_price", "add_price", "reduce_price", "target_price", "max_weight_pct",
  "planned_weight_pct", "expected_up_pct", "expected_down_pct", "confidence",
]);

function amendmentTime(row) {
  const time = row.created_at ?? "";
  const fraction = (time.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0");
  const millis = Date.parse(time.replace(/\.\d+/, "." + fraction.slice(0, 3)));
  // Postgres 保留到微秒，Date.parse 只保留到毫秒。
  return Number.isFinite(millis) ? millis * 1000 + Number(fraction.slice(3, 6)) : -Infinity;
}

export function effectivePlan(plan, amendments) {
  const latest = new Map();
  for (const row of amendments) {
    const previous = latest.get(row.field);
    const time = amendmentTime(row);
    if (!previous || time > previous.time ||
        (time === previous.time && Number(row.id ?? 0) > Number(previous.row.id ?? 0))) {
      latest.set(row.field, { row, time });
    }
  }
  const amendedValues = Object.fromEntries([...latest].map(([field, { row }]) => [
    field, numericPlanFields.has(field) ? Number(row.new_value) : row.new_value,
  ]));
  return { ...plan, ...amendedValues, amended: new Set(latest.keys()) };
}

export function snapshot({ settings, plans, trades, cashFlows, latestPrices, fxRows, today }) {
  const totals = totalsByPlan(trades, today);
  const cash = cashTotal(settings, trades, cashFlows, today);
  const hkd = latestFx(fxRows, today);
  const missing = new Set();
  const positions = [];
  const sectors = new Map();
  let total = cash;
  let loss = 0;
  let largest = null;
  for (const plan of plans) {
    const held = totals.get(plan.id);
    if (!held || held.quantity <= 0) continue;
    const quote = latestPrices.get(plan.symbol);
    const price = quote ? Number(quote.close) : null;
    const reference = price ?? held.avg_cost;
    const fx = plan.market === "HK" ? hkd ?? 1 : 1;
    const stop = hasValue(plan.stop_price) ? Number(plan.stop_price) : null;
    if (price == null) missing.add(plan.symbol);
    if (plan.market === "HK" && hkd == null) missing.add("HKD 匯率");

    const value = reference * held.quantity * fx;
    const lossAtStop = stop == null ? 0 : Math.max(0, reference - stop) * held.quantity * fx;
    total += value;
    loss += lossAtStop;
    sectors.set(plan.sector, (sectors.get(plan.sector) ?? 0) + value);
    if (!largest || value > largest.value) largest = { name: plan.name, value };
    positions.push({
      plan,
      quantity: held.quantity,
      avg_cost: rounded(held.avg_cost),
      price: rounded(price),
      price_date: quote?.trade_date ?? null,
      value_cny: value,
      pnl_pct: price != null && held.avg_cost ? rounded((price / held.avg_cost - 1) * 100) : null,
      stop_dist_pct: price != null && stop ? rounded((price / stop - 1) * 100) : null,
      loss_at_stop_cny: rounded(lossAtStop),
    });
  }
  let largestSector = null;
  for (const [sector, value] of sectors) {
    if (!largestSector || value > largestSector.value) largestSector = { sector, value };
  }
  const weight = (value) => total > 0 ? rounded(value / total * 100) : null;
  return {
    total_cny: rounded(total),
    cash_cny: rounded(cash),
    positions: positions.map((pos) => ({
      ...pos, value_cny: rounded(pos.value_cny), weight_pct: weight(pos.value_cny),
    })),
    loss_at_stop_pct: weight(loss),
    max_single: { name: largest?.name ?? null, weight_pct: largest ? weight(largest.value) : 0 },
    max_sector: { sector: largestSector?.sector ?? null, weight_pct: largestSector ? weight(largestSector.value) : 0 },
    missing_prices: [...missing],
  };
}

export function addDays(day, days) {
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function outOfPlanStats(trades, latestPrices, today) {
  const start = addDays(today, -89);
  let count = 0;
  let priced = 0;
  let sum = 0;
  for (const trade of trades) {
    if (trade.in_plan !== false || trade.trade_date < start || trade.trade_date > today) continue;
    count++;
    const close = Number(latestPrices.get(trade.symbol)?.close);
    if (!(close > 0)) continue;
    const price = Number(trade.price);
    sum += ((trade.side === "buy" ? close / price : price / close) - 1) * 100;
    priced++;
  }
  return { count, avg_after_pct: priced ? rounded(sum / priced) : null };
}

export function planLossEstimate(plan, settings) {
  if (!hasValue(plan.planned_weight_pct) || !hasValue(plan.expected_down_pct)) return null;
  const pct = Number(plan.planned_weight_pct) * Number(plan.expected_down_pct) / 100;
  if (!Number.isFinite(pct)) return null;
  return { pct: rounded(pct), over: pct > Number(settings.loss_budget_pct) };
}

const planCheckNumber = new Intl.NumberFormat("zh-TW", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function checkValue(value) {
  if (!hasValue(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function exceeds(value, limit, scale = 1) {
  // 避免運算誤差把剛好等於門檻的數值判成超過。
  return value - limit > Number.EPSILON * Math.max(scale, Math.abs(value), Math.abs(limit)) * 4;
}

export function planChecks({ plan, settings, price, portfolio, history }) {
  const number = (value) => planCheckNumber.format(value);
  const pct = (value) => `${number(value)}%`;
  const checks = [];
  const add = (key, status, text) => checks.push({ key, status, text });
  const up = checkValue(plan.expected_up_pct);
  const down = checkValue(plan.expected_down_pct);
  const stop = checkValue(plan.stop_price);
  const confidence = checkValue(plan.confidence);
  const weight = checkValue(plan.planned_weight_pct);
  const maxWeight = checkValue(plan.max_weight_pct);
  const distance = stop != null && price > 0 ? (price - stop) / price * 100 : null;
  const rewardRisk = checkValue(settings?.min_reward_risk);
  const stopMin = checkValue(settings?.stop_min_pct);
  const stopMax = checkValue(settings?.stop_max_pct);
  const singleLimit = checkValue(settings?.single_max_pct);
  const lossBudget = checkValue(settings?.loss_budget_pct);
  const sectorLimit = checkValue(settings?.sector_max_pct);
  const settingsMissing = "缺少設定中的規則門檻";

  if (up == null || down == null) {
    add("reward_risk", "skip", "填了預期上漲與下跌才能算賺賠比");
  } else if (down <= 0) {
    add("reward_risk", "skip", "預期下跌須大於 0 才能算賺賠比");
  } else if (rewardRisk == null) {
    add("reward_risk", "skip", settingsMissing);
  } else {
    const ratio = up / down;
    const over = exceeds(rewardRisk, ratio);
    add("reward_risk", over ? "warn" : "ok",
      `賺賠比 ${number(ratio)} : 1${over ? `，低於 ${number(rewardRisk)} : 1` : ""}`);
  }

  if (stop == null) {
    add("stop_distance", "skip", "填了止損價才能算");
  } else if (distance == null) {
    add("stop_distance", "skip", "還沒有這支股票的行情，收盤後由 Mac 抓取");
  } else if (stop >= price) {
    add("stop_distance", "warn", "止損價不低於現價");
  } else if (stopMin == null || stopMax == null) {
    add("stop_distance", "skip", settingsMissing);
  } else {
    const message = `止損距現價 ${pct(distance)}`;
    if (exceeds(stopMin, distance, 100)) {
      add("stop_distance", "warn", `${message}，比 ${pct(stopMin)} 還近，容易被正常波動洗出場`);
    } else if (exceeds(distance, stopMax, 100)) {
      add("stop_distance", "warn", `${message}，超過 ${pct(stopMax)}，一次虧損偏大`);
    } else {
      add("stop_distance", "ok", message);
    }
  }

  if (confidence == null || up == null || down == null) {
    add("expected_value", "skip", "填了信心、預期上漲與下跌才能算期望值");
  } else {
    const gain = confidence * up;
    const loss = (100 - confidence) * down;
    const ev = exceeds(gain, loss) || exceeds(loss, gain) ? (gain - loss) / 100 : 0;
    const signed = (ev > 0 ? "+" : ev < 0 ? "−" : "") + pct(Math.abs(ev));
    add("expected_value", ev <= 0 ? "warn" : "ok",
      `以信心 ${Math.round(confidence)}% 當勝率，期望值 ${signed}${ev <= 0 ? "，不划算" : ""}`);
  }

  const group = confidence == null ? null : confidence < 60 ? "low" : confidence < 80 ? "mid" : "high";
  const confidenceLimit = group === "low" ? checkValue(settings?.low_conf_max_weight_pct)
    : group === "mid" ? checkValue(settings?.mid_conf_max_weight_pct) : singleLimit;
  if (confidence == null || weight == null) {
    add("confidence_weight", "skip", "填了信心與計劃倉位才能檢查");
  } else if (confidenceLimit == null) {
    add("confidence_weight", "skip", settingsMissing);
  } else if (exceeds(weight, confidenceLimit)) {
    add("confidence_weight", "warn", `信心 ${Math.round(confidence)} 但計劃倉位 ${pct(weight)}，建議不超過 ${pct(confidenceLimit)}`);
  } else {
    add("confidence_weight", "ok", `信心 ${Math.round(confidence)}，計劃倉位 ${pct(weight)} 在 ${pct(confidenceLimit)} 以內`);
  }

  if (weight == null) {
    add("single_limit", "skip", "填了計劃倉位才能檢查單票上限");
  } else if (singleLimit == null) {
    add("single_limit", "skip", settingsMissing);
  } else if (exceeds(weight, singleLimit)) {
    add("single_limit", "warn", `計劃倉位 ${pct(weight)} 超過單票上限 ${pct(singleLimit)}`);
  } else if (maxWeight != null && exceeds(maxWeight, singleLimit)) {
    add("single_limit", "warn", `最高倉位 ${pct(maxWeight)} 超過單票上限 ${pct(singleLimit)}`);
  } else {
    add("single_limit", "ok", `倉位在單票上限 ${pct(singleLimit)} 以內`);
  }

  const useStopDistance = distance > 0;
  const downside = useStopDistance ? distance : down;
  if (distance != null && distance <= 0 && down == null) {
    add("stop_loss_budget", "skip", "止損價不低於現價，無法估算止損虧損");
  } else if (weight == null || downside == null) {
    add("stop_loss_budget", "skip", "填了計劃倉位，並有行情與止損價或預期下跌，才能算止損虧損");
  } else if (lossBudget == null) {
    add("stop_loss_budget", "skip", settingsMissing);
  } else {
    const loss = weight * downside / 100;
    if (exceeds(loss, lossBudget, useStopDistance ? Math.abs(weight) : 1)) {
      add("stop_loss_budget", "warn", `觸發止損會虧掉組合 ${pct(loss)}，超過上限 ${pct(lossBudget)}`);
    } else {
      add("stop_loss_budget", "ok", `觸發止損約虧組合 ${pct(loss)}`);
    }
  }

  if (portfolio == null) {
    add("sector_limit", "skip", "到設定填起始日與起始現金後才能算");
  } else if (!hasValue(plan.sector) || weight == null) {
    add("sector_limit", "skip", "填了行業與計劃倉位才能檢查行業上限");
  } else if (sectorLimit == null) {
    add("sector_limit", "skip", settingsMissing);
  } else {
    const weights = portfolio.positions
      .filter((position) => position.plan.sector === plan.sector &&
        (plan.id == null || position.plan.id !== plan.id))
      .map((position) => checkValue(position.weight_pct));
    if (weights.includes(null)) {
      add("sector_limit", "skip", "缺少同行業持倉權重，無法計算行業合計");
    } else {
      const total = weights.reduce((sum, value) => sum + value, weight);
      const message = `${plan.sector}行業合計 ${pct(total)}`;
      if (exceeds(total, sectorLimit)) {
        add("sector_limit", "warn", `加上這張，${message}，超過 ${pct(sectorLimit)}`);
      } else {
        add("sector_limit", "ok", message);
      }
    }
  }

  const record = history?.find(({ key }) => key === group);
  if (!record || record.n < 5) {
    add("calibration", "skip", "信心的歷史命中率還不夠 5 筆");
  } else {
    const below = group !== "low" && record.pct < (group === "high" ? 80 : 60);
    const label = group === "high" ? record.label : `信心 ${record.label}`;
    add("calibration", below ? "warn" : "ok",
      `你過去${label} 的卡實際${below ? "只" : ""}對了 ${pct(record.pct)}（${record.n} 筆）`);
  }

  return checks;
}

const periodMonths = { month: 1, quarter: 3, year: 12 };

export function shiftPeriod(kind, anchor, step) {
  const date = new Date(anchor + "T00:00:00Z");
  const months = periodMonths[kind];
  const firstMonth = Math.floor(date.getUTCMonth() / months) * months;
  date.setUTCMonth(firstMonth + step * months, 1);
  return date.toISOString().slice(0, 10);
}

export function periodRange(kind, anchor) {
  const start = shiftPeriod(kind, anchor, 0);
  const end = addDays(shiftPeriod(kind, anchor, 1), -1);
  const year = start.slice(0, 4);
  const quarter = Math.ceil(Number(start.slice(5, 7)) / 3);
  const labels = { month: start.slice(0, 7), quarter: `${year} Q${quarter}`, year };
  return { start, end, label: labels[kind] };
}

function withinPeriod(date, start, end) {
  return date >= start && date <= end;
}

export function navStats(navRows, start, end) {
  const rows = navRows.filter(({ nav_date, ret }) => ret != null && withinPeriod(nav_date, start, end))
    .sort((a, b) => a.nav_date.localeCompare(b.nav_date));
  if (!rows.length) {
    return { days: 0, ret_pct: null, bench_pct: null, excess_pct: null, max_drawdown_pct: null };
  }

  let portfolioReturn = 0;
  let benchmarkReturn = 0;
  let peakReturn = 0;
  let drawdown = 0;
  for (const row of rows) {
    // 累乘後直接保留相對起始淨值的變化，避免從接近 1 的數字減 1。
    portfolioReturn += (1 + portfolioReturn) * Number(row.ret);
    benchmarkReturn += (1 + benchmarkReturn) * Number(row.bench_ret ?? 0);
    peakReturn = Math.max(peakReturn, portfolioReturn);
    drawdown = Math.min(drawdown, (portfolioReturn - peakReturn) / (1 + peakReturn));
  }
  return {
    days: rows.length,
    ret_pct: rounded(portfolioReturn * 100),
    bench_pct: rounded(benchmarkReturn * 100),
    excess_pct: rounded((portfolioReturn - benchmarkReturn) * 100),
    max_drawdown_pct: rounded(drawdown * 100),
  };
}

export function executionRate(trades, start, end) {
  const rows = trades.filter(({ trade_date }) => withinPeriod(trade_date, start, end));
  const total = rows.length;
  const in_plan = rows.filter((trade) => trade.in_plan).length;
  return { total, in_plan, pct: total ? rounded(in_plan / total * 100) : null };
}

function average(rows, getValue) {
  const values = rows.map(getValue).filter((value) => value != null);
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : null;
}

export function closedStats(reviews, tradesByPlan) {
  const eligible = reviews.filter(({ return_pct }) => return_pct != null);
  const wins = eligible.filter(({ return_pct }) => Number(return_pct) > 0);
  const losses = eligible.filter(({ return_pct }) => Number(return_pct) <= 0);
  const planOnly = eligible.filter(({ deviations }) => !deviations?.length);
  const withDeviations = eligible.filter(({ deviations }) => deviations?.length);
  const getReturn = (review) => review.return_pct;
  const getHold = ({ plan_id, closed_date }) => holdingDays(tradesByPlan.get(plan_id) ?? [], closed_date);
  const avgWin = average(wins, getReturn);
  const avgLoss = average(losses, getReturn);
  return {
    count: reviews.length,
    win_rate_pct: eligible.length ? rounded(wins.length / eligible.length * 100) : null,
    avg_win_pct: rounded(avgWin),
    avg_loss_pct: rounded(avgLoss),
    payoff: avgWin != null && avgLoss ? rounded(avgWin / Math.abs(avgLoss)) : null,
    expectancy_pct: rounded(average(eligible, getReturn)),
    avg_hold_win: rounded(average(wins, getHold), 1),
    avg_hold_loss: rounded(average(losses, getHold), 1),
    in_plan_avg_pct: rounded(average(planOnly, getReturn)),
    out_plan_avg_pct: rounded(average(withDeviations, getReturn)),
    after_1m_avg_pct: rounded(average(eligible, (review) => review.after_1m_pct)),
    after_3m_avg_pct: rounded(average(eligible, (review) => review.after_3m_pct)),
  };
}

export function accuracyByConfidence(doneReviews) {
  const groups = [
    { key: "high", label: "信心 80%+", min: 80, max: 100 },
    { key: "mid", label: "60–79%", min: 60, max: 79 },
    { key: "low", label: "低於 60%", min: 0, max: 59 },
  ];
  return groups.map(({ key, label, min, max }) => {
    const rows = doneReviews.filter(({ confidence }) => confidence != null && confidence >= min && confidence <= max);
    const n = rows.length;
    const right = rows.filter(({ thesis_verdict }) => thesis_verdict === "right").length;
    return { key, label, n, right, pct: n ? rounded(right / n * 100) : null };
  });
}

export function aiAgreement(evidenceRows, start, end) {
  const confirmed = evidenceRows.filter(({ origin, ai_status, confirmed_at }) =>
    origin === "ai" && ["agreed", "disagreed", "irrelevant"].includes(ai_status)
      && withinPeriod(fmtDate(confirmed_at), start, end));
  const n = confirmed.length;
  const agreed = confirmed.filter(({ ai_status }) => ai_status === "agreed").length;
  return { n, agreed, pct: n ? rounded(agreed / n * 100) : null };
}

export function errorRanking(doneReviews) {
  const totals = new Map();
  for (const { error_tags, excess_pct } of doneReviews) {
    for (const tag of new Set(error_tags)) {
      const row = totals.get(tag) ?? { tag, count: 0, excess_sum_pct: 0 };
      row.count++;
      row.excess_sum_pct += Number(excess_pct ?? 0);
      totals.set(tag, row);
    }
  }
  return [...totals.values()]
    .sort((a, b) => b.count - a.count || a.excess_sum_pct - b.excess_sum_pct)
    .map((row) => ({ ...row, excess_sum_pct: rounded(row.excess_sum_pct) }));
}

export function quarterOf(date) {
  const { start, label } = periodRange("quarter", date);
  return { start, label };
}

export function nextQuarterStart(date) {
  return shiftPeriod("quarter", date, 1);
}

export function adoptedInQuarter(rules, date) {
  const { start, end } = periodRange("quarter", date);
  return rules.filter(({ status, effective_from }) =>
    (status === "active" || status === "trial") && withinPeriod(effective_from, start, end)).length;
}
