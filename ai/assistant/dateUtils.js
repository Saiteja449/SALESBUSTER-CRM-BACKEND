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

  // This Week (Starting Monday)
  // Calculate day of week in IST (0 = Sunday, 1 = Monday, ...)
  const dayOfWeekStr = now.toLocaleDateString("en-US", {
    weekday: "narrow",
    timeZone: "Asia/Kolkata",
  });
  // Determine offset from Monday
  const istFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  });
  const weekday = istFormatter.format(now); // "Mon", "Tue", etc.
  const weekdayOffsets = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const daysSinceMonday = weekdayOffsets[weekday] ?? 0;
  const weekStartDate = new Date(todayStart.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  const weekStartStr = getISTDateString(weekStartDate);
  const thisWeekStart = new Date(`${weekStartStr}T00:00:00+05:30`);

  // This Month
  const [year, month] = todayStr.split("-");
  const monthStartStr = `${year}-${month}-01`;
  const thisMonthStart = new Date(`${monthStartStr}T00:00:00+05:30`);

  // Last Month
  const currentMonthNum = parseInt(month, 10);
  const currentYearNum = parseInt(year, 10);
  const lastMonthYear = currentMonthNum === 1 ? currentYearNum - 1 : currentYearNum;
  const lastMonthNum = currentMonthNum === 1 ? 12 : currentMonthNum - 1;
  const lastMonthStr = String(lastMonthNum).padStart(2, "0");
  const lastMonthStartStr = `${lastMonthYear}-${lastMonthStr}-01`;
  const lastMonthStart = new Date(`${lastMonthStartStr}T00:00:00+05:30`);
  const lastMonthEnd = new Date(thisMonthStart.getTime() - 1);
  const lastMonthEndStr = getISTDateString(lastMonthEnd);

  return {
    now,
    todayStr,
    yesterdayStr,
    monthStartStr,
    today: { start: todayStart, end: todayEnd, label: `Today (${todayStr})` },
    morning: { start: morningStart, end: morningEnd, label: `This Morning (06:00 AM - 12:00 PM IST, ${todayStr})` },
    afternoon: { start: afternoonStart, end: afternoonEnd, label: `This Afternoon (12:00 PM - 06:00 PM IST, ${todayStr})` },
    evening: { start: eveningStart, end: eveningEnd, label: `This Evening (06:00 PM - 11:59 PM IST, ${todayStr})` },
    yesterday: { start: yesterdayStart, end: yesterdayEnd, label: `Yesterday (${yesterdayStr})` },
    thisWeek: { start: thisWeekStart, end: todayEnd, label: `This Week (${weekStartStr} to ${todayStr})` },
    thisMonth: { start: thisMonthStart, end: todayEnd, label: `This Month (${monthStartStr} to ${todayStr})` },
    lastMonth: { start: lastMonthStart, end: lastMonthEnd, label: `Last Month (${lastMonthStartStr} to ${lastMonthEndStr})` },
  };
};

/**
 * Resolves period identifier to start and end dates
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
    };
  }

  const mapped = boundaries[period] || boundaries.today;
  return {
    start: mapped.start,
    end: mapped.end,
    startStr: getISTDateString(mapped.start),
    endStr: getISTDateString(mapped.end),
    label: mapped.label,
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
