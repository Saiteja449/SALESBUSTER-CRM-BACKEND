import { tool } from "@langchain/core/tools";
import { z } from "zod";
import crypto from "crypto";
import { resolveDateRange, formatDuration } from "../dateUtils.js";
import { sendEmail } from "../../../helpers/emailHelper.js";
import { buildOwnerDirectory } from "../analytics/ownerResolver.js";

// Session-level or global pending draft cache with 15-minute TTL
export const pendingEmailDrafts = new Map();

// Helper to clean expired drafts
const pruneExpiredDrafts = () => {
  const now = Date.now();
  for (const [id, draft] of pendingEmailDrafts.entries()) {
    if (now - draft.createdAt > 15 * 60 * 1000) {
      pendingEmailDrafts.delete(id);
    }
  }
};

/**
 * Builds a styled, modern responsive HTML email for sales reports
 */
export const buildReportHtmlEmail = ({
  organizationName = "SalesBuster CRM",
  recipientName = "Sales Representative",
  periodLabel = "Today",
  stats = {},
  reportType = "Daily Sales Performance Report",
}) => {
  const {
    totalLeads = 0,
    convertedLeads = 0,
    conversionRate = "0%",
    totalDealValue = "₹0",
    followUps = 0,
    totalCalls = 0,
    connectedCalls = 0,
    talkTime = "0s",
  } = stats;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${reportType}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <div style="max-width: 640px; margin: 24px auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 20px rgba(0,0,0,0.04);">
    
    <!-- Header Banner -->
    <div style="background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); padding: 32px 28px; text-align: left; border-bottom: 3px solid #3b82f6;">
      <div style="display: inline-block; padding: 4px 12px; background-color: rgba(59, 130, 246, 0.2); border-radius: 9999px; color: #60a5fa; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px;">
        ${organizationName} • AI Voice Agent Triggered
      </div>
      <h1 style="margin: 0 0 6px 0; color: #ffffff; font-size: 22px; font-weight: 700;">
        ${reportType}
      </h1>
      <p style="margin: 0; color: #94a3b8; font-size: 13px;">
        Prepared for <strong style="color: #f1f5f9;">${recipientName}</strong> &bull; Period: <span style="color: #38bdf8; font-weight: 600;">${periodLabel}</span>
      </p>
    </div>

    <!-- Body Content -->
    <div style="padding: 28px;">
      
      <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #334155;">
        Hi <strong>${recipientName}</strong>,<br>
        Here is your performance summary for <strong>${periodLabel}</strong> generated directly through the SalesBuster AI Voice Assistant.
      </p>

      <!-- 2x2 Metric Grid -->
      <table style="width: 100%; border-collapse: separate; border-spacing: 12px 12px; margin-bottom: 24px;">
        <tr>
          <td style="width: 50%; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; text-align: center;">
            <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px;">Leads Handled</div>
            <div style="font-size: 26px; font-weight: 800; color: #0f172a; margin-top: 4px;">${totalLeads}</div>
            <div style="font-size: 11px; color: #64748b; margin-top: 4px;">Follow-ups: ${followUps}</div>
          </td>
          <td style="width: 50%; background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 16px; text-align: center;">
            <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: #166534; letter-spacing: 0.5px;">Converted Deals</div>
            <div style="font-size: 26px; font-weight: 800; color: #15803d; margin-top: 4px;">${convertedLeads}</div>
            <div style="font-size: 11px; color: #166534; margin-top: 4px;">Conversion Rate: <strong>${conversionRate}</strong></div>
          </td>
        </tr>
        <tr>
          <td style="width: 50%; background-color: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 16px; text-align: center;">
            <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: #1e40af; letter-spacing: 0.5px;">Deal Value</div>
            <div style="font-size: 22px; font-weight: 800; color: #1d4ed8; margin-top: 4px;">${totalDealValue}</div>
            <div style="font-size: 11px; color: #1e40af; margin-top: 4px;">Closed Pipeline</div>
          </td>
          <td style="width: 50%; background-color: #faf5ff; border: 1px solid #e9d5ff; border-radius: 12px; padding: 16px; text-align: center;">
            <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: #6b21a8; letter-spacing: 0.5px;">Calls & Talk Time</div>
            <div style="font-size: 22px; font-weight: 800; color: #7e22ce; margin-top: 4px;">${totalCalls} <span style="font-size: 13px; font-weight: 500; color: #9333ea;">(${connectedCalls} conn)</span></div>
            <div style="font-size: 11px; color: #6b21a8; margin-top: 4px;">Talk Duration: <strong>${talkTime}</strong></div>
          </td>
        </tr>
      </table>

      <!-- Key Insights Box -->
      <div style="background-color: #f1f5f9; border-radius: 12px; padding: 16px 20px; margin-bottom: 24px; border-left: 4px solid #3b82f6;">
        <h4 style="margin: 0 0 6px 0; font-size: 13px; font-weight: 700; color: #0f172a;">Executive Performance Summary</h4>
        <p style="margin: 0; font-size: 12px; color: #475569; line-height: 1.5;">
          ${convertedLeads > 0 
            ? `Great momentum! You secured ${convertedLeads} converted deal(s) during ${periodLabel} with a ${conversionRate} closing efficiency.`
            : `Keep following up! You handled ${totalLeads} lead(s) and logged ${totalCalls} call(s) during ${periodLabel}. Prioritize active follow-ups to drive conversions.`}
        </p>
      </div>

      <!-- Action Button -->
      <div style="text-align: center; margin: 28px 0 12px 0;">
        <a href="${process.env.FRONTEND_URL || 'https://crm.salesbuster.com'}" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 600; padding: 12px 28px; border-radius: 8px; box-shadow: 0 2px 4px rgba(37, 99, 235, 0.2);">
          Open SalesBuster CRM Dashboard &rarr;
        </a>
      </div>

    </div>

    <!-- Footer -->
    <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 28px; text-align: center;">
      <p style="margin: 0; font-size: 11px; color: #94a3b8;">
        This automated email report was composed and verified via the SalesBuster AI Voice Agent.<br>
        &copy; ${new Date().getFullYear()} ${organizationName}. All rights reserved.
      </p>
    </div>

  </div>
</body>
</html>`;
};

/**
 * Creates the two tools required for the Voice Agent email report workflow:
 * 1. compose_salesperson_report_email (Draft creation & HITL confirmation prompt)
 * 2. confirm_send_email_report (Execution or cancellation based on user response)
 */
export const createEmailReportTools = ({ tenantModels, organization, user, socket }) => {
  const composeTool = tool(
    async ({
      period = "today",
      salespersonNameOrId = "",
      sendToAll = false,
      customStart = null,
      customEnd = null,
    }) => {
      try {
        pruneExpiredDrafts();

        const {
          Lead: LeadModel,
          User: UserModel,
          TelecallerAnalytics: AnalyticsModel,
        } = tenantModels;

        if (!LeadModel || !UserModel) {
          return JSON.stringify({
            status: "error",
            error: "Required CRM database models not found in tenant context.",
          });
        }

        const range = resolveDateRange(period, customStart, customEnd);
        const { start, end, label, startStr, endStr } = range;
        const orgName = organization?.name || "Our Organization";

        // 1. Resolve Target Salesperson(s)
        const activeUsers = await UserModel.find({
          status: "active",
          role: { $in: ["sales person", "sales manager", "sales representative"] },
        })
          .select("name email role phone")
          .lean();

        if (!activeUsers || activeUsers.length === 0) {
          return JSON.stringify({
            status: "error",
            message: "No active sales representatives found in your organization.",
          });
        }

        let targetReps = [];
        const isAll =
          Boolean(sendToAll) ||
          salespersonNameOrId.trim().toLowerCase() === "all" ||
          salespersonNameOrId.trim().toLowerCase() === "everyone" ||
          salespersonNameOrId.trim().toLowerCase() === "team";

        if (isAll) {
          targetReps = activeUsers.filter((u) => Boolean(u.email));
        } else if (salespersonNameOrId && salespersonNameOrId.trim()) {
          const search = salespersonNameOrId.trim().toLowerCase();
          targetReps = activeUsers.filter((u) => {
            const nameMatch = (u.name || "").toLowerCase().includes(search);
            const emailMatch = (u.email || "").toLowerCase().includes(search);
            const idMatch = u._id.toString().toLowerCase() === search;
            return nameMatch || emailMatch || idMatch;
          });
        } else {
          // If neither specified, default to caller if sales rep, or first active sales rep
          const selfMatch = activeUsers.find(
            (u) => u._id.toString() === (user?.id || user?._id)?.toString()
          );
          targetReps = selfMatch ? [selfMatch] : [activeUsers[0]];
        }

        if (targetReps.length === 0) {
          return JSON.stringify({
            status: "error",
            message: `Could not find any active salesperson matching "${salespersonNameOrId}".`,
          });
        }

        // 2. Aggregate Lead Outcomes for Period
        const leadPipeline = [
          ...(range.isAllTime ? [] : [{ $match: { createdAt: { $gte: start, $lte: end } } }]),
          {
            $group: {
              _id: "$assignedTo",
              totalLeads: { $sum: 1 },
              convertedLeads: {
                $sum: { $cond: [{ $eq: ["$status", "Converted"] }, 1, 0] },
              },
              followUps: {
                $sum: { $cond: [{ $eq: ["$status", "Follow Up"] }, 1, 0] },
              },
              totalDealValue: {
                $sum: { $cond: [{ $gt: ["$dealValue", 0] }, "$dealValue", 0] },
              },
            },
          },
        ];
        const leadStats = await LeadModel.aggregate(leadPipeline);

        // 3. Aggregate Call Telemetry for Period
        let callStats = [];
        if (AnalyticsModel) {
          const matchCallStage = range.isAllTime
            ? {}
            : { date: { $gte: startStr, $lte: endStr } };

          callStats = await AnalyticsModel.aggregate([
            ...(Object.keys(matchCallStage).length > 0 ? [{ $match: matchCallStage }] : []),
            {
              $group: {
                _id: { $ifNull: ["$salespersonId", "$salesperson"] },
                salespersonName: { $first: "$salesperson" },
                totalCalls: { $sum: "$totalCalls" },
                talkTimeSeconds: { $sum: "$talkTime" },
                connectedCalls: { $sum: "$connected" },
              },
            },
          ]);
        }

        const callStatsMap = new Map();
        for (const c of callStats) {
          const key = c._id ? String(c._id).toLowerCase() : "";
          if (key) callStatsMap.set(key, c);
          if (c.salespersonName) callStatsMap.set(c.salespersonName.toLowerCase(), c);
        }

        // 4. Build Rep Metric Cards
        const ownerDir = await buildOwnerDirectory({ tenantModels });
        const compiledDrafts = targetReps.map((rep) => {
          const owner = ownerDir.resolveOwner(rep._id || rep.id);
          const uid = owner.id || (rep._id ? rep._id.toString() : "");
          const uname = (owner.name && owner.name !== "Former/Unknown team member")
            ? owner.name
            : (rep.name || rep.email || "Sales Representative");
          const unameLower = uname.toLowerCase();

          const lStat = leadStats.find((l) => {
            const assigned = String(l._id || "");
            return assigned === uid || (uname && assigned.toLowerCase() === unameLower);
          });
          const cStat = callStatsMap.get(uid.toLowerCase()) || callStatsMap.get(unameLower);

          const totalL = lStat ? lStat.totalLeads : 0;
          const convL = lStat ? lStat.convertedLeads : 0;
          const followUps = lStat ? lStat.followUps : 0;
          const dealVal = lStat && lStat.totalDealValue > 0 ? lStat.totalDealValue : 0;
          const convRate = totalL > 0 ? Math.round((convL / totalL) * 100) : 0;

          const totalCalls = cStat ? cStat.totalCalls : 0;
          const connected = cStat ? cStat.connectedCalls : 0;
          const talkSec = cStat ? cStat.talkTimeSeconds : 0;

          const statsObj = {
            totalLeads: totalL,
            convertedLeads: convL,
            conversionRate: `${convRate}%`,
            totalDealValue: dealVal > 0 ? `₹${dealVal.toLocaleString("en-IN")}` : "₹0",
            followUps,
            totalCalls,
            connectedCalls: connected,
            talkTime: formatDuration(talkSec),
          };

          const subject = `[SalesBuster] Performance Report - ${uname} (${label})`;
          const htmlMessage = buildReportHtmlEmail({
            organizationName: orgName,
            recipientName: uname,
            periodLabel: label,
            stats: statsObj,
            reportType: isAll
              ? "Team Sales Performance Report"
              : "Sales Representative Performance Report",
          });

          return {
            repId: uid,
            salespersonId: uid,
            name: uname,
            salesperson: uname,
            salespersonName: uname,
            email: rep.email,
            stats: statsObj,
            subject,
            htmlMessage,
          };
        });

        const draftId = `draft_${crypto.randomBytes(4).toString("hex")}`;
        const primaryRecipient = compiledDrafts[0];

        const draftPayload = {
          draftId,
          createdAt: Date.now(),
          organizationId: organization?._id,
          period,
          periodLabel: label,
          targetCount: compiledDrafts.length,
          recipients: compiledDrafts.map((d) => ({ name: d.name, email: d.email })),
          subject: primaryRecipient.subject,
          htmlPreview: primaryRecipient.htmlMessage,
          stats: primaryRecipient.stats,
          compiledDrafts,
        };

        // Cache draft for user confirmation
        pendingEmailDrafts.set(draftId, draftPayload);

        // Emit real-time confirmation request to socket UI
        if (socket) {
          socket.emit("email_report_confirmation_required", {
            draftId,
            periodLabel: label,
            recipientName: isAll ? `All Active Salespersons (${compiledDrafts.length})` : primaryRecipient.name,
            recipientEmail: isAll ? `${compiledDrafts.length} recipients` : primaryRecipient.email,
            subject: primaryRecipient.subject,
            stats: primaryRecipient.stats,
            htmlPreview: primaryRecipient.htmlMessage,
          });
        }

        // Return structured instruction for Gemini Spoken Response
        return JSON.stringify({
          status: "requires_confirmation",
          draftId,
          periodLabel: label,
          recipientCount: compiledDrafts.length,
          primaryRecipient: {
            name: primaryRecipient.name,
            email: primaryRecipient.email,
          },
          stats: primaryRecipient.stats,
          actionRule:
            "CRITICAL: The report email is composed and waiting for confirmation. Do NOT assume it is sent yet. State the recipient name, email, period, and key stats aloud conversationally, and ask the user directly: 'Would you like me to send this email now?'",
        });
      } catch (err) {
        console.error("[EmailReportTool] Error composing report email:", err);
        return JSON.stringify({
          status: "error",
          error: `Failed to compose report email: ${err.message}`,
        });
      }
    },
    {
      name: "compose_salesperson_report_email",
      description:
        "Composes a comprehensive daily, weekly, monthly, or custom date range sales performance report email for one or all sales representatives, and stages it for mandatory user confirmation before sending.",
      schema: z.object({
        period: z
          .enum([
            "today",
            "yesterday",
            "this_week",
            "last_week",
            "this_month",
            "last_month",
            "last_7_days",
            "last_30_days",
            "custom",
            "all_time",
          ])
          .default("today")
          .describe("Time period for the report (e.g. today for daily, this_week for weekly, this_month for monthly, or custom)"),
        salespersonNameOrId: z
          .string()
          .optional()
          .describe("Name or ID of the salesperson (e.g. 'Ramesh', 'Priya'). Use 'all' or leave blank with sendToAll=true for entire team."),
        sendToAll: z
          .boolean()
          .optional()
          .describe("Set to true to generate and email reports to all active sales team members."),
        customStart: z
          .string()
          .optional()
          .describe("YYYY-MM-DD custom start date when period is 'custom'"),
        customEnd: z
          .string()
          .optional()
          .describe("YYYY-MM-DD custom end date when period is 'custom'"),
      }),
    }
  );

 const executeConfirmEmailReport = async ({ draftId, confirmed, socket = null }) => {
  try {
    pruneExpiredDrafts();

    // If draftId not provided, pick latest pending draft
    let draft = null;
    if (draftId && pendingEmailDrafts.has(draftId)) {
      draft = pendingEmailDrafts.get(draftId);
    } else if (pendingEmailDrafts.size > 0) {
      draft = Array.from(pendingEmailDrafts.values()).pop();
    }

    if (!draft) {
      return {
        status: "error",
        success: false,
        message: "No active report email draft found awaiting confirmation. Please ask to compose a new report.",
      };
    }

    const effectiveDraftId = draft.draftId;

    // If user cancelled
    if (!confirmed) {
      pendingEmailDrafts.delete(effectiveDraftId);
      if (socket) {
        socket.emit("email_report_cancelled", {
          draftId: effectiveDraftId,
          message: "Report email dispatch was cancelled.",
        });
      }
      return {
        status: "cancelled",
        success: true,
        message: "Understood. The report email has been cancelled and was not sent.",
      };
    }

    // User confirmed -> Dispatch emails
    console.log(`[EmailReportTool] Dispatching ${draft.compiledDrafts.length} report email(s)...`);

    const sendResults = [];
    for (const item of draft.compiledDrafts) {
      if (!item.email) {
        sendResults.push({ rep: item.name, success: false, reason: "No email address" });
        continue;
      }

      const sent = await sendEmail({
        email: item.email,
        subject: item.subject,
        message: `Sales Performance Report for ${item.name} (${draft.periodLabel}). Total Leads: ${item.stats?.totalLeads || 0}, Converted: ${item.stats?.convertedLeads || 0}`,
        htmlMessage: item.htmlMessage,
      });

      sendResults.push({ rep: item.name, email: item.email, success: sent });
    }

    pendingEmailDrafts.delete(effectiveDraftId);

    const allSucceeded = sendResults.every((r) => r.success);
    const successCount = sendResults.filter((r) => r.success).length;

    if (socket) {
      socket.emit("email_report_sent", {
        draftId: effectiveDraftId,
        success: allSucceeded,
        sentCount: successCount,
        totalCount: sendResults.length,
        details: sendResults,
      });
    }

    return {
      status: "sent",
      success: allSucceeded,
      sentCount: successCount,
      totalCount: sendResults.length,
      recipients: sendResults.map((r) => `${r.rep} (${r.email})`),
      message:
        successCount === 1
          ? `The report email has been successfully sent to ${sendResults[0].rep} at ${sendResults[0].email}.`
          : `Successfully sent report emails to ${successCount} sales team member(s).`,
    };
  } catch (err) {
    console.error("[EmailReportTool] Error confirming and sending report email:", err);
    return {
      status: "error",
      success: false,
      error: `Failed to deliver email: ${err.message}`,
    };
  }
};

  const confirmTool = tool(
    async ({ draftId, confirmed }) => {
      const res = await executeConfirmEmailReport({ draftId, confirmed, socket });
      return JSON.stringify(res);
    },
    {
      name: "confirm_send_email_report",
      description:
        "Executes or cancels the staged report email dispatch after receiving explicit human-in-the-loop confirmation from the user (e.g. 'yes, send it', 'send the email', 'confirm', or 'no, cancel it', 'don't send').",
      schema: z.object({
        draftId: z
          .string()
          .optional()
          .describe("The draft ID of the report email to confirm or cancel (optional if only one pending draft)"),
        confirmed: z
          .boolean()
          .describe("True if the user confirmed to send the email; false if the user cancelled or declined."),
      }),
    }
  );

  return { composeTool, confirmTool };
};

