# SalesBuster CRM BI Analyst - Metric Definitions & Query Semantics

This document establishes canonical definitions, data sources, ownership semantics, date boundaries, and filtering invariants for the SalesBuster CRM BI Analyst. All analytics services, tool runners, and system prompts adhere strictly to these contracts.

---

## 1. Timezone & Temporal Grounding

- **Default Timezone**: `Asia/Kolkata` (India Standard Time, UTC+05:30), unless overridden by the organization's configured timezone (`organization.timezone`).
- **Standard Date Boundaries**:
  - `today`: 00:00:00 to 23:59:59.999 IST of the current calendar date (`YYYY-MM-DD`).
  - `yesterday`: 00:00:00 to 23:59:59.999 IST of the previous calendar date.
  - `this_week`: Monday 00:00:00 IST of current week to current time / end of Sunday.
  - `last_week`: Monday 00:00:00 IST to Sunday 23:59:59.999 IST of the previous week.
  - `this_month`: 1st day of the current month 00:00:00 IST to end of the current month.
  - `last_month`: 1st day to last day 23:59:59.999 IST of the preceding month.
  - `all_time`: Complete historical data (no date lower-bound filter).
  - `custom`: Explicit `startDate` and `endDate` in `YYYY-MM-DD` format.
- **Event-Date vs Creation-Date Invariant**:
  - **Created Date**: Filtered strictly on `createdAt`. Example: "leads created this month".
  - **Activity / Event Date**: Filtered strictly on the event's occurrence timestamp (`calledAt` for calls, `date` for scheduled follow-ups, `timestamp` for WhatsApp messages, `lastActivity` / `updatedAt` for lead interactions).
  - **Conversions in Period**: When asking for "conversions this month", leads converted during this month must be evaluated. If status is `Converted`, conversion date semantics use `updatedAt` (or status change timestamp) when `createdAt` was in an earlier period.

---

## 2. Lead Metrics

| Metric | Data Source | Field / Query Rule | Notes / Legacy Handling |
| :--- | :--- | :--- | :--- |
| **Total Leads** | `Lead` | Total matching count of leads within the requested creation or filter scope. | Scoped to tenant database. |
| **New Leads** | `Lead` | `status: "New"` (case-insensitive). | Default initial stage. |
| **Active Leads** | `Lead` | `status: { $in: ["New", "Follow Up", "Missed Call"] }` (open, non-terminal pipeline). | Excludes Converted, Lost, and Not Interested. |
| **Converted Leads** | `Lead` | `status: { $regex: /^converted$/i }`. | Successfully won client accounts. |
| **Lost Leads** | `Lead` | `status: { $in: ["Not Interested", "Price Issue", "Not Attended", "Lost"] }`. | Supports legacy and standard lost statuses. |
| **Assigned Leads** | `Lead` | `assignedTo: { $exists: true, $nin: ["Unassigned", "", null] }`. | Assigned to a specific representative ID or name. |
| **Unassigned Leads** | `Lead` | `assignedTo: { $in: ["Unassigned", "", null] }` or `{ $exists: false }`. | Unallocated inbound leads. |
| **Active Pipeline Value** | `Lead` | Sum of `dealValue` for open/active leads (`status` NOT in Converted/Lost). | Represents open commercial pipeline. |
| **Converted Revenue** | `Lead` | Sum of `dealValue` exclusively for `status: "Converted"`. | True realized revenue from converted deals. |
| **Total Deal Value** | `Lead` | Sum of `dealValue` across the specific queried population. Must never be labeled as converted revenue without qualification. | Total deal value must explicitly state its scope. |
| **Inactive Leads (X days)** | `Lead` | No activity in X days. Evaluated against `lastActivity`, fallback to `lastCallAt`, `updatedAt`, and `createdAt`. | If a lead has recent WhatsApp or notes (`lastActivity`), they are active even if no recent phone call was made. |

---

## 3. Follow-up Metrics

| Metric | Data Source | Field / Query Rule | Notes |
| :--- | :--- | :--- | :--- |
| **Due Today** | `Followup` | `done: false`, `date: todayStr` (`YYYY-MM-DD` IST). | Pending tasks scheduled for today. |
| **Overdue** | `Followup` | `done: false`, `date: { $lt: todayStr }`. | Critical tasks requiring immediate escalation. |
| **Upcoming** | `Followup` | `done: false`, `date: { $gt: todayStr }`. | Future scheduled follow-ups. |
| **Completed** | `Followup` | `done: true`. | Successfully closed/finished tasks. |
| **No Follow-up** (`no_followup`) | `Lead` cross-ref `Followup` | Lead has **zero** follow-up records in `Followup` (neither pending nor completed). | True untouched leads. |
| **No Pending Follow-up** (`no_pending`) | `Lead` cross-ref `Followup` | Lead has no active incomplete follow-ups (`done: false`). | May have historical completed follow-ups. |
| **Cross-Ref Failures** | Tool Contract | If `FollowupModel` query fails, the tool MUST return an explicit error or `coverage: "partial"`. It must NEVER silently return an unfiltered lead list. | Enforced in `searchLeadsAdvanced`. |

---

## 4. Call & Recording Metrics

| Metric | Data Source | Field / Query Rule | Notes |
| :--- | :--- | :--- | :--- |
| **Call Records** | `CallRecord` + `Lead.callHistory` | Primary from `CallRecord`, complemented & deduplicated by `callEventId` or composite `leadId + timestamp`. | No silent truncation: hard caps report `hasMore: true` and `coverage: "partial"`. |
| **Missed Calls** | `CallRecord` + `Lead.callHistory` + `Lead(status="Missed Call")` | Calls with `callStatus: "missed"` or `callType: "missed"`. | Accurately linked to current lead owner and follow-up status. |
| **Unique Callers / Customers**| Call Records | Distinct count of customer phone numbers normalized by last 10 digits. | Deduplicated customer count. |
| **Available Recordings** | `CallRecord` (`recordingUrl`) + `Lead.recordings` | Records where audio recording URL is present and accessible. | Aggregated across both call events and lead uploads. |
| **Missing Recordings** | `CallRecord` | `callStatus: "connected"`, `duration > 15s`, and no recording URL present. | Flags calls that should have audio for QA/coaching. |
| **Recording AI Status** | `Lead.recordings` | `analysisStatus`: `"completed"`, `"pending"`, `"failed"`. Missing `uploadedAt` defaults to lead `createdAt` (never `new Date()`). | Deterministic date filtering. |

---

## 5. WhatsApp & Conversation Metrics

| Metric | Data Source | Field / Query Rule | Notes |
| :--- | :--- | :--- | :--- |
| **Connection Status** | `WhatsAppSession` + `User` | Rep session status: `connected`, `connecting`, `qr`, `disconnected`. Shows connection type, connected phone (if authorized), and `updatedAt`. | **Credentials, tokens, and QR strings are strictly redacted.** |
| **Conversation Search** | `Conversation` | Customer name, phone, lead association, assigned rep (`userId`), unread count, content snippet, date range. | Full chronological search. |
| **Message Thread** | `Message` | Chronological messages for conversation / phone, sorted by `timestamp` ascending. | Paginated safely; customer content wrapped as untrusted data. |
| **Conversation Summary** | `Conversation` | Structured transcript summary: key points, customer intent, unresolved questions, sentiment, next steps. | Generated from live messages / transcript segments. |
| **Unreplied / Unread Chats** | `Lead` + `Conversation` | `unreadCount > 0` or `hasUnread: true`. Filterable by rep and date. | Leads awaiting frontline response. |
| **BI Chat History vs WhatsApp**| `AIAssistantChat` vs `Conversation`/`Message` | Assistant internal managerial sessions (`AIAssistantChat`) are completely segregated from customer WhatsApp conversations. | Strictly isolated models and scopes. |

---

## 6. Ownership Semantics: Current Owner vs Event Owner

- **Current Lead Owner (`assignedTo`)**: The sales representative currently responsible for the lead account. All lead searches, conversion attribution, and current pipeline credit use `assignedTo`.
- **Historical Event Owner (`salespersonId` / `salespersonName`)**: The representative who made a specific call, attended an event, or authored a task at that historical moment.
- **Task Author (`author`)**: The user who scheduled a follow-up, distinct from the representative assigned to execute the follow-up on the lead.
- **Reporting Clarification**: Team analytics must explicitly label whether metrics are attributed by **Current Lead Assignment** or **Historical Event Activity**.

---

## 7. Tool Response Contract Standards

Every BI Analyst tool returns a standard JSON contract:
```json
{
  "success": true,
  "dataCoverage": "complete", // "complete" | "partial" | "unavailable"
  "errorCode": null,          // e.g. "DATABASE_UNAVAILABLE", "TIMEOUT", "AMBIGUOUS_SALESPERSON"
  "message": "",
  "periodEvaluated": "November 2026",
  "timezone": "Asia/Kolkata",
  "filtersApplied": {},
  "totalMatchingCount": 42,
  "returnedCount": 10,
  "page": 1,
  "totalPages": 5,
  "limit": 10,
  "hasMore": true,
  "continuationHint": "Showing page 1 of 5. Call with page: 2 to retrieve more records.",
  "summary": {},
  "records": [],
  "coverageWarnings": []
}
```
**Critical Rule**: Never return a numeric zero count to represent an error, database failure, or missing model. In failures, `success: false` or `dataCoverage: "unavailable"` is mandatory.

