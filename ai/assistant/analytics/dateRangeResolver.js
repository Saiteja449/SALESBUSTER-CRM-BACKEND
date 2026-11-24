const datePartsInZone = (date, timezone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const zonedMidnight = (dateStr, timezone, endOfDay = false) => {
  const [year, month, day] = dateStr.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  let guess = target;
  // Reconcile UTC with the requested zone; iterate to handle offset transitions.
  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const represented = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second, endOfDay ? 999 : 0);
    guess += target - represented;
  }
  return new Date(guess);
};

const shiftDate = (dateStr, days) => {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const zonedClock = (dateStr, clock, timezone) => {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute, second] = clock.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    guess += target - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  }
  return new Date(guess);
};

const formatRange = (startStr, endStr, label, timezone, startClock, endClock) => {
  const start = startClock ? zonedClock(startStr, startClock, timezone) : zonedMidnight(startStr, timezone);
  const end = endClock ? zonedClock(endStr, endClock, timezone) : zonedMidnight(endStr, timezone, true);
  return {
    start, end, startStr, endStr, label, isAllTime: false,
    dateMatchStage: (field = "createdAt") => ({ [field]: { $gte: start, $lte: end } }),
    stringDateMatchStage: (field = "date") => ({ [field]: { $gte: startStr, $lte: endStr } }),
  };
};

/**
 * Enhanced Date Range Resolver with organization timezone awareness,
 * month name extraction, and helper match-stage generators.
 */
export const resolveAnalyticsDateRange = ({
  period = "today",
  startDate = null,
  endDate = null,
  timezone = "Asia/Kolkata",
}) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    timezone = "Asia/Kolkata";
  }
  // 1. If explicit startDate/endDate provided
  if (startDate || endDate) {
    const rawStart = startDate || endDate;
    const sStr = String(rawStart).includes("T") ? String(rawStart).split("T")[0] : String(rawStart).trim();
    const eStr = endDate
      ? (String(endDate).includes("T") ? String(endDate).split("T")[0] : String(endDate).trim())
      : sStr;

    return formatRange(sStr, eStr, sStr === eStr ? `Date (${sStr})` : `Date Range (${sStr} to ${eStr})`, timezone);
  }

  // 2. Natural month detection in period string (e.g. "november", "october 2026")
  const rawPeriod = String(period || "today").toLowerCase().trim();
  const months = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
  ];
  const monthIdx = months.findIndex((m) => rawPeriod.includes(m));
  if (monthIdx !== -1) {
    const todayStr = datePartsInZone(new Date(), timezone);
    const [currYear] = todayStr.split("-");
    const yearMatch = rawPeriod.match(/\b(202\d)\b/);
    const targetYear = yearMatch ? yearMatch[1] : currYear;
    const targetMonthStr = String(monthIdx + 1).padStart(2, "0");

    const startStr = `${targetYear}-${targetMonthStr}-01`;
    const lastDay = new Date(parseInt(targetYear, 10), monthIdx + 1, 0).getDate();
    const endStr = `${targetYear}-${targetMonthStr}-${String(lastDay).padStart(2, "0")}`;

    const monthNameCapitalized = months[monthIdx].charAt(0).toUpperCase() + months[monthIdx].slice(1);
    return formatRange(startStr, endStr, `${monthNameCapitalized} ${targetYear}`, timezone);
  }

  // 3. Fall back to standard period mapper
  const today = datePartsInZone(new Date(), timezone);
  const [year, month] = today.split("-").map(Number);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const currentMonthEnd = shiftDate(`${year}-${String(month).padStart(2, "0")}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`, 0);
  const priorMonthEnd = shiftDate(monthStart, -1);
  const priorMonthStart = `${priorMonthEnd.slice(0, 7)}-01`;
  const dayOfWeek = new Date(`${today}T00:00:00Z`).getUTCDay();
  const mondayOffset = (dayOfWeek + 6) % 7;
  const weekStart = shiftDate(today, -mondayOffset);
  const key = String(period || "today").toLowerCase().replace(/[\s-]/g, "_");
  const ranges = {
    today: [today, today], yesterday: [shiftDate(today, -1), shiftDate(today, -1)],
    this_week: [weekStart, today], thisweek: [weekStart, today],
    last_week: [shiftDate(weekStart, -7), shiftDate(weekStart, -1)], lastweek: [shiftDate(weekStart, -7), shiftDate(weekStart, -1)],
    this_month: [monthStart, currentMonthEnd], thismonth: [monthStart, currentMonthEnd],
    last_month: [priorMonthStart, priorMonthEnd], lastmonth: [priorMonthStart, priorMonthEnd],
    last_7_days: [shiftDate(today, -6), today], last7days: [shiftDate(today, -6), today],
    last_30_days: [shiftDate(today, -29), today], last30days: [shiftDate(today, -29), today],
    morning: [today, today, "06:00:00", "12:00:00"], this_morning: [today, today, "06:00:00", "12:00:00"], thismorning: [today, today, "06:00:00", "12:00:00"],
    afternoon: [today, today, "12:00:00", "18:00:00"], this_afternoon: [today, today, "12:00:00", "18:00:00"],
    evening: [today, today, "18:00:00", "23:59:59"], this_evening: [today, today, "18:00:00", "23:59:59"],
  };
  if (["all_time", "alltime", "all", "complete", "overall", "lifetime"].includes(key)) {
    return { start: new Date("2020-01-01T00:00:00Z"), end: zonedMidnight(today, timezone, true), startStr: "2020-01-01", endStr: today, label: "All Time (Complete History)", isAllTime: true,
      dateMatchStage: () => ({}), stringDateMatchStage: () => ({}) };
  }
  const bounds = ranges[key] || ranges[period] || ranges.today;
  const resolved = formatRange(bounds[0], bounds[1], `${String(period).replace(/_/g, " ")} (${bounds[0]} to ${bounds[1]})`, timezone, bounds[2], bounds[3]);

  return {
    ...resolved,
    dateMatchStage: (field = "createdAt") =>
      resolved.isAllTime ? {} : { [field]: { $gte: resolved.start, $lte: resolved.end } },
    stringDateMatchStage: (field = "date") =>
      resolved.isAllTime ? {} : { [field]: { $gte: resolved.startStr, $lte: resolved.endStr } },
  };
};

