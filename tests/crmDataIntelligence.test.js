import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { resolveSalesperson, listAllSalespeople } from "../ai/assistant/analytics/salespersonResolver.js";
import { resolveAnalyticsDateRange } from "../ai/assistant/analytics/dateRangeResolver.js";
import {
  searchCallRecords,
  getMissedCallAnalytics,
  searchLeadsAdvanced,
  getFollowupAnalytics,
  getConversionAnalytics,
  getRecordingAnalytics,
  getWhatsAppAnalytics,
  getCRMOverview,
  getSalespersonAnalytics,
} from "../ai/assistant/analytics/crmAnalyticsService.js";
import { recordCallEvent } from "../services/callEventService.js";
import { handleMissedCall } from "../controllers/leadController.js";
import { buildAssistantTools } from "../ai/assistant/tools/index.js";
import { getISTDateBoundaries, getISTDateString } from "../ai/assistant/dateUtils.js";

// Helper to create mock response object for controller tests
const createMockRes = () => {
  const res = {
    statusCode: 200,
    data: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.data = payload;
      return this;
    },
  };
  return res;
};

// Fixture Object IDs
const org1Id = new mongoose.Types.ObjectId();
const org2Id = new mongoose.Types.ObjectId();

const repShanmukh1Id = new mongoose.Types.ObjectId();
const repShanmukh2Id = new mongoose.Types.ObjectId();
const repJhansiId = new mongoose.Types.ObjectId();
const repRobertInactiveId = new mongoose.Types.ObjectId();
const mgrAliceId = new mongoose.Types.ObjectId();

// In-Memory Test Fixtures
const usersFixture = [
  {
    _id: repShanmukh1Id,
    name: "Shanmukh Sarma",
    email: "shanmukh.sarma@acme.com",
    role: "sales person",
    status: "active",
    phone: "9876500001",
    organizationId: org1Id,
  },
  {
    _id: repShanmukh2Id,
    name: "Shanmukh Kumar",
    email: "shanmukh.kumar@acme.com",
    role: "sales rep",
    status: "active",
    phone: "9876500002",
    organizationId: org1Id,
  },
  {
    _id: repJhansiId,
    name: "Jhansi Rani",
    email: "jhansi@acme.com",
    role: "sales representative",
    status: "active",
    phone: "9876500003",
    organizationId: org1Id,
  },
  {
    _id: repRobertInactiveId,
    name: "Robert Fox",
    email: "robert@acme.com",
    role: "sales person",
    status: "inactive",
    phone: "9876500004",
    organizationId: org1Id,
  },
  {
    _id: mgrAliceId,
    name: "Alice Manager",
    email: "alice@acme.com",
    role: "sales manager",
    status: "active",
    phone: "9876500005",
    organizationId: org1Id,
  },
];

// Helper to create an in-memory mock tenantModels environment
const createMockTenantDb = () => {
  const boundaries = getISTDateBoundaries();
  const todayStr = boundaries.todayStr;
  const yesterdayStr = boundaries.yesterdayStr;

  let leads = [];
  let callRecords = [];
  let followups = [];
  let telecallerAnalytics = [];
  let messages = [];

  // Seed Leads
  // 1. Shanmukh Sarma: Converted Lead
  const lead1Id = new mongoose.Types.ObjectId();
  leads.push({
    _id: lead1Id,
    name: "Lead Alpha",
    phone: "+919100000001",
    phoneNormalized: "9100000001",
    status: "Converted",
    source: "Call",
    service: "Agri Tech",
    priority: "High",
    assignedTo: repShanmukh1Id,
    dealValue: 50000,
    createdAt: new Date(`${todayStr}T09:00:00+05:30`),
    lastActivity: new Date(`${todayStr}T10:00:00+05:30`),
    lastCallAt: new Date(`${todayStr}T09:30:00+05:30`),
    callCount: 2,
    callHistory: [
      {
        callEventId: "call_alpha_1",
        salespersonId: repShanmukh1Id,
        salespersonName: "Shanmukh Sarma",
        callType: "incoming",
        status: "connected",
        duration: 120,
        calledAt: new Date(`${todayStr}T09:15:00+05:30`),
      },
      {
        callEventId: "call_alpha_2",
        salespersonId: repShanmukh1Id,
        salespersonName: "Shanmukh Sarma",
        callType: "missed",
        status: "missed",
        duration: 0,
        calledAt: new Date(`${todayStr}T09:30:00+05:30`),
      },
    ],
    recordings: [
      {
        _id: new mongoose.Types.ObjectId(),
        name: "Call_Alpha_Recording.mp3",
        duration: 120,
        analysisStatus: "completed",
        transcription: "Customer confirmed contract signing.",
        analysis: "High buying intent. Deal closed.",
        salespersonName: "Shanmukh Sarma",
        uploadedAt: new Date(`${todayStr}T09:20:00+05:30`),
      },
    ],
  });

  // 2. Jhansi Rani: New Lead with Overdue Follow-up
  const lead2Id = new mongoose.Types.ObjectId();
  leads.push({
    _id: lead2Id,
    name: "Lead Beta",
    phone: "+919100000002",
    phoneNormalized: "9100000002",
    status: "Follow Up",
    source: "WhatsApp",
    service: "CRM Software",
    priority: "Medium",
    assignedTo: repJhansiId,
    dealValue: 20000,
    createdAt: new Date(`${yesterdayStr}T11:00:00+05:30`),
    lastActivity: new Date(`${yesterdayStr}T11:30:00+05:30`),
    lastCallAt: new Date(`${yesterdayStr}T11:30:00+05:30`),
    callCount: 1,
    callHistory: [
      {
        callEventId: "call_beta_1",
        salespersonId: repJhansiId,
        salespersonName: "Jhansi Rani",
        callType: "missed",
        status: "missed",
        duration: 0,
        calledAt: new Date(`${yesterdayStr}T11:30:00+05:30`),
      },
    ],
    recordings: [],
  });

  // 3. Inactive Rep (Robert Fox): Lost Lead
  const lead3Id = new mongoose.Types.ObjectId();
  leads.push({
    _id: lead3Id,
    name: "Lead Gamma",
    phone: "+919100000003",
    phoneNormalized: "9100000003",
    status: "Not Interested",
    source: "Meta Ads",
    service: "Consulting",
    priority: "Low",
    assignedTo: repRobertInactiveId,
    dealValue: 0,
    createdAt: new Date("2026-10-15T10:00:00+05:30"),
    lastActivity: new Date("2026-10-15T11:00:00+05:30"),
    lastCallAt: new Date("2026-10-15T11:00:00+05:30"),
    callCount: 1,
    callHistory: [
      {
        callEventId: "call_gamma_1",
        salespersonId: repRobertInactiveId,
        salespersonName: "Robert Fox",
        callType: "outgoing",
        status: "connected",
        duration: 45,
        calledAt: new Date("2026-10-15T11:00:00+05:30"),
      },
    ],
    recordings: [],
  });

  // 4. Unassigned Lead with Missed Call
  const lead4Id = new mongoose.Types.ObjectId();
  leads.push({
    _id: lead4Id,
    name: "Lead Delta",
    phone: "+919100000004",
    phoneNormalized: "9100000004",
    status: "Missed Call",
    source: "Call",
    service: "General Enquiry",
    priority: "High",
    assignedTo: "Unassigned",
    createdAt: new Date(`${todayStr}T08:00:00+05:30`),
    lastActivity: new Date(`${todayStr}T08:00:00+05:30`),
    callCount: 1,
    callHistory: [
      {
        callEventId: "call_delta_missed",
        salespersonId: null,
        salespersonName: "Unassigned",
        callType: "missed",
        status: "missed",
        duration: 0,
        calledAt: new Date(`${todayStr}T08:00:00+05:30`),
      },
    ],
    recordings: [],
  });

  // 5. Customer with multiple missed calls (Lead Epsilon)
  const lead5Id = new mongoose.Types.ObjectId();
  leads.push({
    _id: lead5Id,
    name: "Customer Epsilon",
    phone: "+919100000005",
    phoneNormalized: "9100000005",
    status: "Missed Call",
    source: "Call",
    service: "General Enquiry",
    priority: "High",
    assignedTo: repShanmukh1Id,
    createdAt: new Date(`${todayStr}T07:00:00+05:30`),
    lastCallAt: new Date(`${todayStr}T08:30:00+05:30`),
    callCount: 3,
    callHistory: [
      {
        callEventId: "call_eps_1",
        salespersonId: repShanmukh1Id,
        salespersonName: "Shanmukh Sarma",
        callType: "missed",
        status: "missed",
        duration: 0,
        calledAt: new Date(`${todayStr}T07:00:00+05:30`),
      },
      {
        callEventId: "call_eps_2",
        salespersonId: repShanmukh1Id,
        salespersonName: "Shanmukh Sarma",
        callType: "missed",
        status: "missed",
        duration: 0,
        calledAt: new Date(`${todayStr}T08:00:00+05:30`),
      },
      {
        callEventId: "call_eps_3",
        salespersonId: repShanmukh1Id,
        salespersonName: "Shanmukh Sarma",
        callType: "missed",
        status: "missed",
        duration: 0,
        calledAt: new Date(`${todayStr}T08:30:00+05:30`),
      },
    ],
    recordings: [],
  });

  // 6. Generate 30 additional records for pagination testing (> 25 records)
  for (let i = 1; i <= 30; i++) {
    const pId = new mongoose.Types.ObjectId();
    const pPhone = `+9192000000${String(i).padStart(2, "0")}`;
    const pCalledAt = new Date(Date.now() - i * 3600000);
    callRecords.push({
      _id: new mongoose.Types.ObjectId(),
      callEventId: `paged_call_${i}`,
      organizationId: org1Id,
      leadId: pId,
      salespersonId: i % 2 === 0 ? repShanmukh1Id : repJhansiId,
      salespersonName: i % 2 === 0 ? "Shanmukh Sarma" : "Jhansi Rani",
      customerName: `Pagination Customer ${i}`,
      customerPhone: pPhone,
      customerPhoneNormalized: pPhone.slice(-10),
      callType: i % 3 === 0 ? "missed" : "outgoing",
      callStatus: i % 3 === 0 ? "missed" : "connected",
      duration: i % 3 === 0 ? 0 : 60 + i,
      calledAt: pCalledAt,
      source: "Call",
    });
  }

  // Seed CallRecords
  callRecords.push(
    {
      _id: new mongoose.Types.ObjectId(),
      callEventId: "call_alpha_1",
      organizationId: org1Id,
      leadId: lead1Id,
      salespersonId: repShanmukh1Id,
      salespersonName: "Shanmukh Sarma",
      customerName: "Lead Alpha",
      customerPhone: "+919100000001",
      customerPhoneNormalized: "9100000001",
      callType: "incoming",
      callStatus: "connected",
      duration: 120,
      calledAt: new Date(`${todayStr}T09:15:00+05:30`),
      recordingUrl: "http://example.com/recording1.mp3",
      source: "Call",
    },
    {
      _id: new mongoose.Types.ObjectId(),
      callEventId: "call_alpha_2",
      organizationId: org1Id,
      leadId: lead1Id,
      salespersonId: repShanmukh1Id,
      salespersonName: "Shanmukh Sarma",
      customerName: "Lead Alpha",
      customerPhone: "+919100000001",
      customerPhoneNormalized: "9100000001",
      callType: "missed",
      callStatus: "missed",
      duration: 0,
      calledAt: new Date(`${todayStr}T09:30:00+05:30`),
      source: "Call",
    },
    {
      _id: new mongoose.Types.ObjectId(),
      callEventId: "call_beta_1",
      organizationId: org1Id,
      leadId: lead2Id,
      salespersonId: repJhansiId,
      salespersonName: "Jhansi Rani",
      customerName: "Lead Beta",
      customerPhone: "+919100000002",
      customerPhoneNormalized: "9100000002",
      callType: "missed",
      callStatus: "missed",
      duration: 0,
      calledAt: new Date(`${yesterdayStr}T11:30:00+05:30`),
      source: "Call",
    },
    {
      _id: new mongoose.Types.ObjectId(),
      callEventId: "call_gamma_1",
      organizationId: org1Id,
      leadId: lead3Id,
      salespersonId: repRobertInactiveId,
      salespersonName: "Robert Fox",
      customerName: "Lead Gamma",
      customerPhone: "+919100000003",
      customerPhoneNormalized: "9100000003",
      callType: "outgoing",
      callStatus: "connected",
      duration: 45,
      calledAt: new Date("2026-10-15T11:00:00+05:30"),
      source: "Call",
    },
    {
      _id: new mongoose.Types.ObjectId(),
      callEventId: "call_delta_missed",
      organizationId: org1Id,
      leadId: lead4Id,
      salespersonId: null,
      salespersonName: "Unassigned",
      customerName: "Lead Delta",
      customerPhone: "+919100000004",
      customerPhoneNormalized: "9100000004",
      callType: "missed",
      callStatus: "missed",
      duration: 0,
      calledAt: new Date(`${todayStr}T08:00:00+05:30`),
      source: "Call",
    },
    {
      _id: new mongoose.Types.ObjectId(),
      callEventId: "call_eps_1",
      organizationId: org1Id,
      leadId: lead5Id,
      salespersonId: repShanmukh1Id,
      salespersonName: "Shanmukh Sarma",
      customerName: "Customer Epsilon",
      customerPhone: "+919100000005",
      customerPhoneNormalized: "9100000005",
      callType: "missed",
      callStatus: "missed",
      duration: 0,
      calledAt: new Date(`${todayStr}T07:00:00+05:30`),
      source: "Call",
    },
    {
      _id: new mongoose.Types.ObjectId(),
      callEventId: "call_eps_2",
      organizationId: org1Id,
      leadId: lead5Id,
      salespersonId: repShanmukh1Id,
      salespersonName: "Shanmukh Sarma",
      customerName: "Customer Epsilon",
      customerPhone: "+919100000005",
      customerPhoneNormalized: "9100000005",
      callType: "missed",
      callStatus: "missed",
      duration: 0,
      calledAt: new Date(`${todayStr}T08:00:00+05:30`),
      source: "Call",
    },
    {
      _id: new mongoose.Types.ObjectId(),
      callEventId: "call_eps_3",
      organizationId: org1Id,
      leadId: lead5Id,
      salespersonId: repShanmukh1Id,
      salespersonName: "Shanmukh Sarma",
      customerName: "Customer Epsilon",
      customerPhone: "+919100000005",
      customerPhoneNormalized: "9100000005",
      callType: "missed",
      callStatus: "missed",
      duration: 0,
      calledAt: new Date(`${todayStr}T08:30:00+05:30`),
      source: "Call",
    }
  );

  // Seed Followups
  // Alpha: Done (successfully followed up)
  followups.push({
    _id: new mongoose.Types.ObjectId(),
    leadId: lead1Id,
    leadName: "Lead Alpha",
    date: todayStr,
    time: "10:00 AM",
    priority: "High",
    author: "Shanmukh Sarma",
    done: true,
  });

  // Beta: Overdue (date is yesterday, done is false)
  followups.push({
    _id: new mongoose.Types.ObjectId(),
    leadId: lead2Id,
    leadName: "Lead Beta",
    date: yesterdayStr,
    time: "02:00 PM",
    priority: "High",
    author: "Jhansi Rani",
    done: false,
    notes: "Missed call follow-up required",
  });

  // Delta: Pending Today
  followups.push({
    _id: new mongoose.Types.ObjectId(),
    leadId: lead4Id,
    leadName: "Lead Delta",
    date: todayStr,
    time: "04:00 PM",
    priority: "High",
    author: "Unassigned",
    done: false,
    notes: "Missed call received at 08:00 AM",
  });

  // Epsilon: Overdue Follow-up for Shanmukh
  followups.push({
    _id: new mongoose.Types.ObjectId(),
    leadId: lead5Id,
    leadName: "Customer Epsilon",
    date: yesterdayStr,
    time: "09:00 AM",
    priority: "High",
    author: "Shanmukh Sarma",
    done: false,
    notes: "Customer missed call. Urgent callback needed.",
  });

  // Build Mock Mongoose Models
  const mockUserModel = {
    find: (filter = {}) => {
      let filtered = [...usersFixture];
      if (filter.name) {
        if (filter.name instanceof RegExp) {
          filtered = filtered.filter((u) => filter.name.test(u.name));
        }
      }
      if (filter.$or) {
        filtered = filtered.filter((u) => {
          return filter.$or.some((cond) => {
            if (cond.name && cond.name instanceof RegExp) return cond.name.test(u.name);
            if (cond.email && cond.email instanceof RegExp) return cond.email.test(u.email);
            return false;
          });
        });
      }
      return {
        select: () => ({
          sort: () => ({
            lean: async () => filtered,
          }),
          lean: async () => filtered,
        }),
        lean: async () => filtered,
      };
    },
    findById: (id) => ({
      select: () => ({
        lean: async () => usersFixture.find((u) => u._id.toString() === String(id)) || null,
      }),
      lean: async () => usersFixture.find((u) => u._id.toString() === String(id)) || null,
    }),
    findOne: (filter = {}) => ({
      select: () => ({
        lean: async () => {
          return usersFixture.find((u) => {
            if (filter.email && filter.email instanceof RegExp) return filter.email.test(u.email);
            if (filter.phone && filter.phone.$regex) return u.phone.endsWith(filter.phone.$regex.replace("$", ""));
            return false;
          }) || null;
        },
      }),
      lean: async () => {
        return usersFixture.find((u) => {
          if (filter.email && filter.email instanceof RegExp) return filter.email.test(u.email);
          return false;
        }) || null;
      },
    }),
  };

  const mockLeadModel = {
    countDocuments: async (f = {}) => {
      return leads.length;
    },
    distinct: async (field, f = {}) => {
      const set = new Set();
      for (const l of leads) {
        if (l[field]) set.add(l[field]);
      }
      return Array.from(set);
    },
    find: (f = {}) => {
      let result = [...leads];
      return {
        sort: () => ({
          skip: (s) => ({
            limit: (l) => ({
              select: () => ({
                lean: async () => result.slice(s, s + l),
              }),
              lean: async () => result.slice(s, s + l),
            }),
            lean: async () => result.slice(s),
          }),
          limit: (l) => ({
            select: () => ({
              lean: async () => result.slice(0, l),
            }),
            lean: async () => result.slice(0, l),
          }),
          lean: async () => result,
        }),
        select: () => ({
          lean: async () => result,
        }),
        lean: async () => result,
      };
    },
    findOne: async (f = {}) => {
      if (f._id) {
        return leads.find((l) => l._id.toString() === f._id.toString()) || null;
      }
      if (f.$or) {
        return (
          leads.find((l) =>
            f.$or.some((c) => {
              if (c.phone) {
                if (c.phone instanceof RegExp) return c.phone.test(l.phone);
                return l.phone === c.phone;
              }
              return false;
            })
          ) || null
        );
      }
      return leads[0] || null;
    },
    create: async (data) => {
      const newDoc = {
        _id: new mongoose.Types.ObjectId(),
        callCount: 0,
        callHistory: [],
        repCallCounts: [],
        recordings: [],
        save: async function () {
          return this;
        },
        ...data,
      };
      leads.push(newDoc);
      return newDoc;
    },
    aggregate: async (pipeline) => {
      const total = leads.length;
      const converted = leads.filter((l) => l.status === "Converted").length;
      const wonValue = leads.reduce((acc, l) => acc + (l.dealValue || 0), 0);

      const byRep = {};
      for (const l of leads) {
        const k = l.assignedTo ? String(l.assignedTo) : "Unassigned";
        if (!byRep[k]) byRep[k] = { totalLeads: 0, newLeads: 0, convertedLeads: 0, lostLeads: 0, dealValue: 0 };
        byRep[k].totalLeads++;
        if (l.status === "New") byRep[k].newLeads++;
        if (l.status === "Converted") byRep[k].convertedLeads++;
        if (["Not Interested", "Price Issue", "Not Attended"].includes(l.status)) byRep[k].lostLeads++;
        byRep[k].dealValue += l.dealValue || 0;
      }

      const bySalesperson = Object.keys(byRep).map((k) => ({
        _id: k,
        ...byRep[k],
      }));

      const hasGroup = pipeline.some((p) => p.$group);
      if (hasGroup && !pipeline.some((p) => p.$facet)) {
        return bySalesperson;
      }

      return [
        {
          totals: [
            {
              totalLeads: total,
              convertedLeads: converted,
              lostLeads: 1,
              totalDealValue: wonValue,
              total,
              new: 1,
              active: 3,
              converted,
              lost: 1,
              unassigned: 1,
              dealVal: wonValue,
            },
          ],
          bySalesperson,
          bySource: [{ _id: "Call", totalLeads: 3, convertedLeads: 1 }],
          byService: [{ _id: "Agri Tech", totalLeads: 1, convertedLeads: 1 }],
          lostBreakdown: [{ _id: "Not Interested", count: 1 }],
        },
      ];
    },
  };

  const applyCallFilters = (records, f = {}) => {
    let filtered = [...records];
    if (f.customerPhone && f.customerPhone instanceof RegExp) {
      filtered = filtered.filter((c) => f.customerPhone.test(c.customerPhone));
    }
    if (f.callType && f.callType !== "all") {
      filtered = filtered.filter((c) => c.callType === f.callType);
    }
    if (f.callStatus && f.callStatus !== "all") {
      filtered = filtered.filter((c) => c.callStatus === f.callStatus);
    }
    if (f.$or) {
      filtered = filtered.filter((c) => {
        return f.$or.some((cond) => {
          if (cond.callStatus) return c.callStatus === cond.callStatus;
          if (cond.callType) return c.callType === cond.callType;
          if (cond.salespersonId !== undefined) return String(c.salespersonId) === String(cond.salespersonId);
          if (cond.salespersonName) {
            if (cond.salespersonName instanceof RegExp) return cond.salespersonName.test(c.salespersonName);
            return c.salespersonName === cond.salespersonName;
          }
          return false;
        });
      });
    }
    return filtered;
  };

  const mockCallRecordModel = {
    countDocuments: async (f = {}) => {
      return applyCallFilters(callRecords, f).length;
    },
    find: (f = {}) => {
      const filtered = applyCallFilters(callRecords, f);
      return {
        sort: () => ({
          skip: (s) => ({
            limit: (l) => ({
              lean: async () => filtered.slice(s, s + l),
            }),
            lean: async () => filtered.slice(s),
          }),
          limit: (l) => ({
            lean: async () => filtered.slice(0, l),
          }),
          lean: async () => filtered,
        }),
        lean: async () => filtered,
      };
    },
    findOne: async (f = {}) => {
      if (f.callEventId) {
        return callRecords.find((c) => c.callEventId === f.callEventId) || null;
      }
      return callRecords[0] || null;
    },
    create: async (data) => {
      const rec = {
        _id: new mongoose.Types.ObjectId(),
        save: async function () {
          return this;
        },
        ...data,
      };
      callRecords.push(rec);
      return rec;
    },
    aggregate: async () => {
      return [
        {
          totals: [
            {
              total: callRecords.length,
              incoming: callRecords.filter((c) => c.callType === "incoming" || c.callType === "missed").length,
              outgoing: callRecords.filter((c) => c.callType === "outgoing").length,
              connected: callRecords.filter((c) => c.callStatus === "connected").length,
              missed: callRecords.filter((c) => c.callStatus === "missed").length,
              rejected: 0,
              talkSec: 500,
            },
          ],
        },
      ];
    },
  };

  const mockFollowupModel = {
    countDocuments: async () => followups.length,
    find: (f = {}) => {
      let filtered = [...followups];
      if (f.leadId && f.leadId.$in) {
        const idSet = new Set(f.leadId.$in.map(String));
        filtered = filtered.filter((fu) => idSet.has(fu.leadId.toString()));
      }
      return {
        sort: () => ({
          skip: (s) => ({
            limit: (l) => ({
              lean: async () => filtered.slice(s, s + l),
            }),
            lean: async () => filtered.slice(s),
          }),
          limit: (l) => ({
            lean: async () => filtered.slice(0, l),
          }),
          lean: async () => filtered,
        }),
        lean: async () => filtered,
      };
    },
    distinct: async (field, f = {}) => {
      let filtered = [...followups];
      if (f.done !== undefined) filtered = filtered.filter((fu) => fu.done === f.done);
      if (f.date && f.date.$lt) filtered = filtered.filter((fu) => fu.date < f.date.$lt);
      return Array.from(new Set(filtered.map((fu) => fu[field])));
    },
    create: async (data) => {
      followups.push(data);
      return data;
    },
    aggregate: async () => {
      return [
        {
          overdueCount: [{ c: followups.filter((f) => !f.done && f.date < todayStr).length }],
          todayCount: [{ c: followups.filter((f) => !f.done && f.date === todayStr).length }],
          upcomingCount: [{ c: 0 }],
          completedCount: [{ c: followups.filter((f) => f.done).length }],
          byPriority: [{ _id: "High", count: 3 }],
        },
      ];
    },
  };

  const mockAnalyticsModel = {
    findOneAndUpdate: async () => ({}),
    aggregate: async () => [],
  };

  const tenantModels = {
    User: mockUserModel,
    Lead: mockLeadModel,
    CallRecord: mockCallRecordModel,
    Followup: mockFollowupModel,
    TelecallerAnalytics: mockAnalyticsModel,
  };

  return {
    tenantModels,
    leads,
    callRecords,
    followups,
  };
};

test("PHASE 4: Salesperson Resolution - Exact, Inactive, and Ambiguous Matches", async (t) => {
  const { tenantModels } = createMockTenantDb();

  await t.test("Resolves exact full name (case-insensitive)", async () => {
    const res = await resolveSalesperson({ tenantModels, identifier: "shanmukh sarma" });
    assert.equal(res.resolved, true);
    assert.equal(res.canonicalName, "Shanmukh Sarma");
    assert.equal(res.canonicalId, repShanmukh1Id.toString());
  });

  await t.test("Resolves inactive representative (historical lookup)", async () => {
    const res = await resolveSalesperson({ tenantModels, identifier: "Robert Fox" });
    assert.equal(res.resolved, true);
    assert.equal(res.canonicalName, "Robert Fox");
    assert.equal(res.user.status, "inactive");
  });

  await t.test("Flags ambiguous match when multiple reps match partial name without guessing", async () => {
    // "Shanmukh" matches both "Shanmukh Sarma" and "Shanmukh Kumar"
    const res = await resolveSalesperson({ tenantModels, identifier: "Shanmukh" });
    assert.equal(res.resolved, false);
    assert.equal(res.isAmbiguous, true);
    assert.equal(res.matches.length, 2);
    assert.match(res.message, /Multiple salespeople match/);
  });

  await t.test("Resolves explicit 'Unassigned' or 'Unknown' without guessing", async () => {
    const res = await resolveSalesperson({ tenantModels, identifier: "unassigned" });
    assert.equal(res.resolved, true);
    assert.equal(res.isUnassigned, true);
    assert.equal(res.canonicalName, "Unassigned");
  });
});

test("PHASE 3 & 5: Missed-Call Analytics & Consistency", async (t) => {
  const { tenantModels } = createMockTenantDb();

  await t.test("Question 1: How many missed calls do we have overall?", async () => {
    const res = await getMissedCallAnalytics({
      tenantModels,
      filters: { period: "all_time" },
    });
    assert.equal(res.success, true);
    assert.ok(res.summary.totalMissedCalls >= 5);
    assert.ok(res.summary.uniqueCustomersCount >= 3);
  });

  await t.test("Question 2: How many missed calls did Shanmukh receive?", async () => {
    const res = await getMissedCallAnalytics({
      tenantModels,
      filters: { salespersonNameOrId: "Shanmukh Sarma", period: "all_time" },
    });
    assert.equal(res.success, true);
    assert.equal(res.summary.salespersonEvaluated, "Shanmukh Sarma");
    assert.ok(res.summary.totalMissedCalls >= 4); // Alpha + 3 from Epsilon
  });

  await t.test("Question 3: Show Shanmukh's missed calls today", async () => {
    const res = await getMissedCallAnalytics({
      tenantModels,
      filters: { salespersonNameOrId: "Shanmukh Sarma", period: "today" },
    });
    assert.equal(res.success, true);
    assert.ok(res.summary.totalMissedCalls >= 4);
    assert.ok(res.records.length > 0);
  });

  await t.test("Question 7: Show missed calls without follow-ups", async () => {
    const res = await getMissedCallAnalytics({
      tenantModels,
      filters: { followupStatus: "none" },
    });
    assert.equal(res.success, true);
    assert.ok(res.summary.noFollowupScheduled >= 0);
  });

  await t.test("Question 8: Show missed calls with overdue follow-ups", async () => {
    const res = await getMissedCallAnalytics({
      tenantModels,
      filters: { followupStatus: "overdue" },
    });
    assert.equal(res.success, true);
    assert.ok(res.summary.overdueFollowups >= 1);
  });

  await t.test("Question 13: Show missed calls without salesperson identification", async () => {
    const res = await getMissedCallAnalytics({
      tenantModels,
      filters: { unknownSalespersonOnly: true },
    });
    assert.equal(res.success, true);
    assert.ok(res.summary.unassignedMissedCalls >= 1);
  });
});

test("PHASE 5: Salesperson Performance, Leaderboard, & Rep Comparison", async (t) => {
  const { tenantModels } = createMockTenantDb();

  await t.test("Question 4: Compare Shanmukh and Jhansi", async () => {
    const res = await getSalespersonAnalytics({
      tenantModels,
      filters: { period: "all_time" },
    });
    assert.equal(res.success, true);
    assert.ok(Array.isArray(res.teamLeaderboard));

    const shanmukh = res.teamLeaderboard.find((r) => r.name === "Shanmukh Sarma");
    const jhansi = res.teamLeaderboard.find((r) => r.name === "Jhansi Rani");
    assert.ok(shanmukh, "Shanmukh should be present in leaderboard");
    assert.ok(jhansi, "Jhansi should be present in leaderboard");

    assert.equal(shanmukh.convertedLeads, 1);
    assert.equal(shanmukh.conversionRatePercent, "50%");
  });

  await t.test("Question 6: Show inactive salesperson call records (Robert Fox)", async () => {
    const res = await searchCallRecords({
      tenantModels,
      filters: { salespersonNameOrId: "Robert Fox" },
    });
    assert.equal(res.success, true);
    assert.equal(res.totalCount, 1);
    assert.equal(res.records[0].salesperson, "Robert Fox");
    assert.equal(res.records[0].callStatus, "connected");
  });
});

test("PHASE 5: Advanced Lead Search & Multi-Filter Queries", async (t) => {
  const { tenantModels } = createMockTenantDb();

  await t.test("Question 9: Show all leads assigned to Shanmukh", async () => {
    const res = await searchLeadsAdvanced({
      tenantModels,
      filters: { salespersonNameOrId: "Shanmukh Sarma" },
    });
    assert.equal(res.success, true);
    assert.ok(res.totalCount >= 2);
  });

  await t.test("Question 14: Show all activity for a particular customer by phone", async () => {
    const callRes = await searchCallRecords({
      tenantModels,
      filters: { customerPhone: "9100000005" },
    });
    assert.equal(callRes.success, true);
    assert.equal(callRes.totalCount, 3); // Epsilon 3 missed calls
  });

  await t.test("Question 15: Execute combined salesperson, date, status and follow-up filters", async () => {
    const res = await searchLeadsAdvanced({
      tenantModels,
      filters: {
        salespersonNameOrId: "Shanmukh Sarma",
        status: "Converted",
        service: "Agri Tech",
      },
    });
    assert.equal(res.success, true);
    assert.ok(res.totalCount >= 1);
  });
});

test("PHASE 8: Pagination Beyond 25 Records", async (t) => {
  const { tenantModels } = createMockTenantDb();

  await t.test("Question 12: Show records beyond the first 25 results using page 2", async () => {
    // Total call records seeded: 30 paged + 8 special = 38 records
    const page1 = await searchCallRecords({
      tenantModels,
      filters: { period: "all_time" },
      pagination: { page: 1, limit: 15 },
    });
    assert.equal(page1.success, true);
    assert.equal(page1.records.length, 15);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.page, 1);

    const page2 = await searchCallRecords({
      tenantModels,
      filters: { period: "all_time" },
      pagination: { page: 2, limit: 15 },
    });
    assert.equal(page2.success, true);
    assert.equal(page2.records.length, 15);
    assert.equal(page2.page, 2);

    const page3 = await searchCallRecords({
      tenantModels,
      filters: { period: "all_time" },
      pagination: { page: 3, limit: 15 },
    });
    assert.equal(page3.success, true);
    assert.ok(page3.records.length > 0);
  });
});

test("PHASE 3: Call Event Consistency & Idempotent Recording", async (t) => {
  const { tenantModels } = createMockTenantDb();

  await t.test("Idempotent webhook: Duplicate callEventId does NOT create duplicate records", async () => {
    const stableId = "webhook_evt_unique_99";
    const phone = "+919999900001";

    // 1st dispatch
    const firstCall = await recordCallEvent({
      CallRecordModel: tenantModels.CallRecord,
      LeadModel: tenantModels.Lead,
      AnalyticsModel: tenantModels.TelecallerAnalytics,
      callEventId: stableId,
      customerPhone: phone,
      callType: "missed",
      callStatus: "missed",
      salespersonName: "Shanmukh Sarma",
      salespersonId: repShanmukh1Id.toString(),
    });
    assert.equal(firstCall.isDuplicate, false);

    // 2nd duplicate retry
    const secondCall = await recordCallEvent({
      CallRecordModel: tenantModels.CallRecord,
      LeadModel: tenantModels.Lead,
      AnalyticsModel: tenantModels.TelecallerAnalytics,
      callEventId: stableId,
      customerPhone: phone,
      callType: "missed",
      callStatus: "missed",
      salespersonName: "Shanmukh Sarma",
      salespersonId: repShanmukh1Id.toString(),
    });
    assert.equal(secondCall.isDuplicate, true);
    assert.equal(secondCall.callEventId, stableId);
  });

  await t.test("Missed call on Converted lead preserves Converted status while recording event", async () => {
    const convertedLead = {
      _id: new mongoose.Types.ObjectId(),
      name: "VIP Converted",
      phone: "+919999900002",
      status: "Converted",
      assignedTo: repShanmukh1Id.toString(),
      save: async function () {
        return this;
      },
    };

    let createdFollowup = null;
    let recordedCallEventData = null;

    const mockLeadModel = {
      findOne: async () => convertedLead,
    };
    const mockFollowupModel = {
      create: async (data) => {
        createdFollowup = data;
        return data;
      },
    };
    const mockCallRecordModel = {
      findOne: async () => null,
      create: async (data) => {
        recordedCallEventData = data;
        return data;
      },
    };

    const req = {
      body: {
        phone: "+919999900002",
        number: "+919876500001",
        callTimestamp: Date.now(),
        sendWhatsApp: false,
      },
      user: { _id: repShanmukh1Id.toString(), name: "Shanmukh Sarma", role: "sales person" },
      tenantModels: {
        Lead: mockLeadModel,
        Followup: mockFollowupModel,
        CallRecord: mockCallRecordModel,
      },
    };
    const res = createMockRes();

    await handleMissedCall(req, res);

    assert.equal(res.statusCode, 200);
    // Converted status must be preserved!
    assert.equal(convertedLead.status, "Converted");
    // Call event must be recorded!
    assert.ok(recordedCallEventData, "CallRecord should be created even for Converted lead");
    assert.equal(recordedCallEventData.callStatus, "missed");
    assert.ok(createdFollowup, "Followup must be created");
  });

  await t.test("Unidentified salesperson is marked Unassigned and NOT attributed to manager", async () => {
    let createdLead = null;
    let createdCallRecord = null;

    const mockLeadModel = {
      findOne: async () => null,
      create: async (data) => {
        createdLead = data;
        return { ...data, _id: new mongoose.Types.ObjectId() };
      },
    };
    const mockFollowupModel = {
      create: async () => ({}),
    };
    const mockCallRecordModel = {
      findOne: async () => null,
      create: async (data) => {
        createdCallRecord = data;
        return data;
      },
    };

    const req = {
      body: {
        phone: "+919999900099",
        number: "+919876599999", // Unmapped SIM number
        sendWhatsApp: false,
      },
      // Auth user is a sales manager!
      user: { _id: mgrAliceId.toString(), name: "Alice Manager", role: "sales manager" },
      tenantModels: {
        Lead: mockLeadModel,
        Followup: mockFollowupModel,
        CallRecord: mockCallRecordModel,
        User: {
          findOne: () => ({
            select: () => ({
              lean: async () => null,
            }),
          }),
        },
      },
    };
    const res = createMockRes();

    await handleMissedCall(req, res);

    assert.equal(res.statusCode, 200);
    // The lead and call must NOT be attributed to the manager Alice!
    assert.equal(createdLead.assignedTo, "Unassigned");
    assert.notEqual(createdLead.assignedTo, mgrAliceId.toString());
    assert.equal(createdCallRecord.salespersonName, "Unassigned");
    assert.notEqual(createdCallRecord.salespersonId, mgrAliceId.toString());
  });
});

test("PHASE 5: Complete CRM Tool Registry & Coverage", async () => {
  const { tenantModels } = createMockTenantDb();

  const { tools, toolsByName } = buildAssistantTools({
    tenantModels,
    organization: { name: "Test Org" },
    user: { name: "Manager" },
  });

  const expectedTools = [
    "get_crm_overview",
    "get_missed_call_analytics",
    "search_call_records",
    "get_salesperson_analytics",
    "get_salesperson_performance",
    "search_leads_advanced",
    "search_leads",
    "get_followup_analytics",
    "get_followup_status",
    "get_conversion_analytics",
    "get_recording_analytics",
    "get_whatsapp_analytics",
    "lookup_phone_number",
    "get_dashboard_kpis",
  ];

  for (const toolName of expectedTools) {
    assert.ok(toolsByName[toolName], `Tool '${toolName}' must be registered and available in assistant`);
  }
});
