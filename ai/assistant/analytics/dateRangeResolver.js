import { getISTDateBoundaries, getISTDateString, resolveDateRange as baseResolveDateRange } from "../dateUtils.js";

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
  // 1. If explicit startDate/endDate provided
  if (startDate) {
    const sStr = String(startDate).includes("T") ? String(startDate).split("T")[0] : String(startDate).trim();
    const eStr = endDate
      ? (String(endDate).includes("T") ? String(endDate).split("T")[0] : String(endDate).trim())
      : sStr;

    const start = new Date(`${sStr}T00:00:00+05:30`);
    const end = new Date(`${eStr}T23:59:59.999+05:30`);

    return {
      start,
      end,
      startStr: sStr,
      endStr: eStr,
      label: sStr === eStr ? `Date (${sStr})` : `Date Range (${sStr} to ${eStr})`,
      isAllTime: false,
      dateMatchStage: (field = "createdAt") => ({ [field]: { $gte: start, $lte: end } }),
      stringDateMatchStage: (field = "date") => ({ [field]: { $gte: sStr, $lte: eStr } }),
    };
  }

  // 2. Natural month detection in period string (e.g. "november", "october 2026")
  const rawPeriod = String(period || "today").toLowerCase().trim();
  const months = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
  ];
  const monthIdx = months.findIndex((m) => rawPeriod.includes(m));
  if (monthIdx !== -1) {
    const boundaries = getISTDateBoundaries();
    const [currYear] = boundaries.todayStr.split("-");
    const yearMatch = rawPeriod.match(/\b(202\d)\b/);
    const targetYear = yearMatch ? yearMatch[1] : currYear;
    const targetMonthStr = String(monthIdx + 1).padStart(2, "0");

    const startStr = `${targetYear}-${targetMonthStr}-01`;
    const lastDay = new Date(parseInt(targetYear, 10), monthIdx + 1, 0).getDate();
    const endStr = `${targetYear}-${targetMonthStr}-${String(lastDay).padStart(2, "0")}`;

    const start = new Date(`${startStr}T00:00:00+05:30`);
    const end = new Date(`${endStr}T23:59:59.999+05:30`);
    const monthNameCapitalized = months[monthIdx].charAt(0).toUpperCase() + months[monthIdx].slice(1);

    return {
      start,
      end,
      startStr,
      endStr,
      label: `${monthNameCapitalized} ${targetYear}`,
      isAllTime: false,
      dateMatchStage: (field = "createdAt") => ({ [field]: { $gte: start, $lte: end } }),
      stringDateMatchStage: (field = "date") => ({ [field]: { $gte: startStr, $lte: endStr } }),
    };
  }

  // 3. Fall back to standard period mapper
  const resolved = baseResolveDateRange(period, startDate, endDate);

  return {
    ...resolved,
    dateMatchStage: (field = "createdAt") =>
      resolved.isAllTime ? {} : { [field]: { $gte: resolved.start, $lte: resolved.end } },
    stringDateMatchStage: (field = "date") =>
      resolved.isAllTime ? {} : { [field]: { $gte: resolved.startStr, $lte: resolved.endStr } },
  };
};

