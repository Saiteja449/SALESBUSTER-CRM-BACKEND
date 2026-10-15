import test from "node:test";
import assert from "node:assert/strict";
import { computeNextRunDate } from "../services/whatsappCampaignScheduler.js";
import { buildLeadAudienceQuery } from "../controllers/whatsappCloudController.js";

test("Campaign Scheduler: computeNextRunDate daily calculation", () => {
  // Base: 2026-10-15 08:00 AM local time
  const baseDate = new Date(2026, 9, 15, 8, 0, 0);

  // Daily at 10:00 -> should run today at 10:00
  const nextToday = computeNextRunDate(
    { frequency: "daily", time: "10:00" },
    baseDate
  );
  assert.ok(nextToday !== null);
  assert.equal(nextToday.getHours(), 10);
  assert.equal(nextToday.getDate(), 15);

  // Daily at 07:00 (already passed today) -> should run tomorrow at 07:00
  const nextTomorrow = computeNextRunDate(
    { frequency: "daily", time: "07:00" },
    baseDate
  );
  assert.ok(nextTomorrow !== null);
  assert.equal(nextTomorrow.getHours(), 7);
  assert.equal(nextTomorrow.getDate(), 16);
});

test("Campaign Scheduler: computeNextRunDate respects endDate", () => {
  const baseDate = new Date("2026-10-15T12:00:00.000Z");
  // Past end date
  const expired = computeNextRunDate(
    { frequency: "daily", time: "10:00", endDate: new Date("2026-10-14") },
    baseDate
  );
  assert.equal(expired, null);
});

test("Campaign Scheduler: computeNextRunDate includes run on the exact endDate", () => {
  // Base: 2026-10-15 08:00 AM local time
  const baseDate = new Date(2026, 9, 15, 8, 0, 0);

  // End date set to 2026-10-15 at midnight (standard HTML date input value)
  const endDateMidnight = new Date(2026, 9, 15, 0, 0, 0);

  // A 10:00 AM run on 2026-10-15 should be permitted because the end-date boundary is inclusive of the entire day
  const nextRun = computeNextRunDate(
    { frequency: "daily", time: "10:00", endDate: endDateMidnight },
    baseDate
  );

  assert.ok(nextRun !== null, "Run on endDate must not be rejected");
  assert.equal(nextRun.getDate(), 15);
  assert.equal(nextRun.getHours(), 10);
});

test("Campaign Scheduler: computeNextRunDate weekly calculation", () => {
  // 2026-10-15 is a Thursday (day 4)
  const baseDate = new Date("2026-10-15T12:00:00.000Z");

  // Next Friday (day 5) at 10:00
  const nextFriday = computeNextRunDate(
    { frequency: "weekly", daysOfWeek: [5], time: "10:00" },
    baseDate
  );
  assert.ok(nextFriday !== null);
  assert.equal(nextFriday.getDay(), 5);
  assert.ok(nextFriday.getTime() > baseDate.getTime());
});

test("Campaign Scheduler: computeNextRunDate custom_dates", () => {
  const baseDate = new Date("2026-10-15T12:00:00.000Z");
  const dates = ["2026-10-14", "2026-10-20", "2026-10-25"];

  const next = computeNextRunDate(
    { frequency: "custom_dates", dates, time: "11:00" },
    baseDate
  );
  assert.ok(next !== null);
  assert.equal(next.getDate(), 20);
  assert.equal(next.getHours(), 11);
});

test("Campaign Scheduler: buildLeadAudienceQuery with status and service", () => {
  const query = buildLeadAudienceQuery({
    leadStatus: ["New", "Follow Up"],
    services: ["Elevator Modernization", "General Enquiry"],
    requireConsent: true,
  });

  assert.deepEqual(query.status, { $in: ["New", "Follow Up"] });
  assert.deepEqual(query.service, {
    $in: ["Elevator Modernization", "General Enquiry"],
  });
  assert.deepEqual(query.hasWhatsAppConsent, { $ne: false });
});
