/**
 * Date and Timezone Utilities for SalesBuster CRM Intelligence Assistant
 * Standardized to India Standard Time (Asia/Kolkata, UTC+05:30)
 */

export const getISTNow = () => {
  return new Date();
};

/**
 * Returns formatted YYYY-MM-DD string for a date in Asia/Kolkata timezone
 */
export const getISTDateString = (date = new Date()) => {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};

/**
 * Returns comprehensive IST boundaries for deterministic CRM data querying
 */
export const getISTDateBoundaries = () => {
  const now = new Date();
  const todayStr = getISTDateString(now);

  // Today boundaries
  const todayStart = new Date(`${todayStr}T00:00:00+05:30`);
  const todayEnd = new Date(`${todayStr}T23:59:59.999+05:30`);

  // Morning window: 06:00 AM to 12:00 PM IST
  const morningStart = new Date(`${todayStr}T06:00:00+05:30`);
  const morningEnd = new Date(`${todayStr}T12:00:00+05:30`);

  // Afternoon window: 12:00 PM to 06:00 PM IST
  const afternoonStart = new Date(`${todayStr}T12:00:00+05:30`);
  const afternoonEnd = new Date(`${todayStr}T18:00:00+05:30`);

  // Evening window: 06:00 PM to 11:59 PM IST
  const eveningStart = new Date(`${todayStr}T18:00:00+05:30`);
  const eveningEnd = new Date(`${todayStr}T23:59:59.999+05:30`);

  // Yesterday
  const yesterdayDate = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayStr = getISTDateString(yesterdayDate);
  const yesterdayStart = new Date(`${yesterdayStr}T00:00:00+05:30`);
  const yesterdayEnd = new Date(`${yesterdayStr}T23:59:59.999+05:30`);

  // This Week (Starting Monday 00:00 IST)
  const istFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  });
  const weekday = istFormatter.format(now); // "Mon", "Tue", etc.
  const weekdayOffsets = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const daysSinceMonday = weekdayOffsets[weekday] ?? 0;
  const thisWeekStartDate = new Date(todayStart.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  const thisWeekStartStr = getISTDateString(thisWeekStartDate);
  const thisWeekStart = new Date(`${thisWeekStartStr}T00:00:00+05:30`);

  // Last Week (Monday 00:00 to Sunday 23:59 IST of previous week)
  const lastWeekStartDate = new Date(thisWeekStartDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lastWeekStartStr = getISTDateString(lastWeekStartDate);
  const lastWeekStart = new Date(`${lastWeekStartStr}T00:00:00+05:30`);
  const lastWeekEndDate = new Date(thisWeekStartDate.getTime() - 1);
  const lastWeekEndStr = getISTDateString(lastWeekEndDate);
  const lastWeekEnd = new Date(`${lastWeekEndStr}T23:59:59.999+05:30`);

  // Last 7 Days (rolling 7 days inclusive)
  const last7DaysDate = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
  const last7DaysStr = getISTDateString(last7DaysDate);
  const last7DaysStart = new Date(`${last7DaysStr}T00:00:00+05:30`);

  // Last 30 Days (rolling 30 days inclusive)
  const last30DaysDate = new Date(todayStart.getTime() - 29 * 24 * 60 * 60 * 1000);
  const last30DaysStr = getISTDateString(last30DaysDate);
  const last30DaysStart = new Date(`${last30DaysStr}T00:00:00+05:30`);

  // This Month (1st of current month 00:00 IST)
  const [year, month] = todayStr.split("-");
  const monthStartStr = `${year}-${month}-01`;
  const thisMonthStart = new Date(`${monthStartStr}T00:00:00+05:30`);

  // Last Month (1st to last day of previous month)
  const currentMonthNum = parseInt(month, 10);
  const currentYearNum = parseInt(year, 10);
  const lastMonthYear = currentMonthNum === 1 ? currentYearNum - 1 : currentYearNum;
  const lastMonthNum = currentMonthNum === 1 ? 12 : currentMonthNum - 1;
  const lastMonthStr = String(lastMonthNum).padStart(2, "0");
  const lastMonthStartStr = `${lastMonthYear}-${lastMonthStr}-01`;
  const lastMonthStart = new Date(`${lastMonthStartStr}T00:00:00+05:30`);
  const lastMonthEnd = new Date(thisMonthStart.getTime() - 1);
  const lastMonthEndStr = getISTDateString(lastMonthEnd);

  // All Time (Complete History)
  const allTimeStart = new Date("2020-01-01T00:00:00+05:30");
  const allTimeEnd = new Date(`${todayStr}T23:59:59.999+05:30`);

  return {
    now,
    todayStr,
    yesterdayStr,
    monthStartStr,
    today: { start: todayStart, end: todayEnd, label: `Today (${todayStr})`, isAllTime: false },
    morning: { start: morningStart, end: morningEnd, label: `This Morning (06:00 AM - 12:00 PM IST, ${todayStr})`, isAllTime: false },
    afternoon: { start: afternoonStart, end: afternoonEnd, label: `This Afternoon (12:00 PM - 06:00 PM IST, ${todayStr})`, isAllTime: false },
    evening: { start: eveningStart, end: eveningEnd, label: `This Evening (06:00 PM - 11:59 PM IST, ${todayStr})`, isAllTime: false },
    yesterday: { start: yesterdayStart, end: yesterdayEnd, label: `Yesterday (${yesterdayStr})`, isAllTime: false },
    thisWeek: { start: thisWeekStart, end: todayEnd, label: `This Week (${thisWeekStartStr} to ${todayStr})`, isAllTime: false },
    lastWeek: { start: lastWeekStart, end: lastWeekEnd, label: `Last Week (${lastWeekStartStr} to ${lastWeekEndStr})`, isAllTime: false },
    thisMonth: { start: thisMonthStart, end: todayEnd, label: `This Month (${monthStartStr} to ${todayStr})`, isAllTime: false },
    lastMonth: { start: lastMonthStart, end: lastMonthEnd, label: `Last Month (${lastMonthStartStr} to ${lastMonthEndStr})`, isAllTime: false },
    last7Days: { start: last7DaysStart, end: todayEnd, label: `Last 7 Days (${last7DaysStr} to ${todayStr})`, isAllTime: false },
    last30Days: { start: last30DaysStart, end: todayEnd, label: `Last 30 Days (${last30DaysStr} to ${todayStr})`, isAllTime: false },
    allTime: { start: allTimeStart, end: allTimeEnd, label: "All Time (Complete History)", isAllTime: true },
  };
};

/**
 * Resolves period identifier to start and end dates with robust support for
 * both snake_case ("this_month") and camelCase ("thisMonth"), as well as "all_time".
 */
export const resolveDateRange = (period = "today", customStart = null, customEnd = null) => {
  const boundaries = getISTDateBoundaries();

  if (period === "custom" && customStart) {
    const sStr = customStart.includes("T") ? customStart.split("T")[0] : customStart;
    const eStr = customEnd ? (customEnd.includes("T") ? customEnd.split("T")[0] : customEnd) : sStr;
    return {
      start: new Date(`${sStr}T00:00:00+05:30`),
      end: new Date(`${eStr}T23:59:59.999+05:30`),
      startStr: sStr,
      endStr: eStr,
      label: `Custom Range (${sStr} to ${eStr})`,
      isAllTime: false,
    };
  }

  // Normalize period string (remove spaces, hyphens, and convert to lowercase)
  const rawKey = String(period || "today").toLowerCase().replace(/[\s\-]/g, "_");

  // Comprehensive lookup dictionary mapping all representations
  const periodMap = {
    today: boundaries.today,
    yesterday: boundaries.yesterday,

    // Mornings / Times of day
    morning: boundaries.morning,
    this_morning: boundaries.morning,
    thismorning: boundaries.morning,
    afternoon: boundaries.afternoon,
    this_afternoon: boundaries.afternoon,
    evening: boundaries.evening,
    this_evening: boundaries.evening,

    // Weeks
    this_week: boundaries.thisWeek,
    thisweek: boundaries.thisWeek,
    last_week: boundaries.lastWeek,
    lastweek: boundaries.lastWeek,

    // Rolling days
    last_7_days: boundaries.last7Days,
    last7days: boundaries.last7Days,
    last_30_days: boundaries.last30Days,
    last30days: boundaries.last30Days,

    // Months
    this_month: boundaries.thisMonth,
    thismonth: boundaries.thisMonth,
    last_month: boundaries.lastMonth,
    lastmonth: boundaries.lastMonth,

    // All Time / Overall / Complete
    all_time: boundaries.allTime,
    alltime: boundaries.allTime,
    all: boundaries.allTime,
    complete: boundaries.allTime,
    overall: boundaries.allTime,
    lifetime: boundaries.allTime,
  };

  const mapped = periodMap[rawKey] || boundaries[period] || boundaries.today;

  return {
    start: mapped.start,
    end: mapped.end,
    startStr: getISTDateString(mapped.start),
    endStr: getISTDateString(mapped.end),
    label: mapped.label,
    isAllTime: mapped.isAllTime || false,
  };
};

/**
 * Formats talk time in seconds to human readable string (e.g., 2h 15m or 45m 12s)
 */
export const formatDuration = (seconds = 0) => {
  const s = Math.max(0, parseInt(seconds, 10) || 0);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const remainingSeconds = s % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
};
