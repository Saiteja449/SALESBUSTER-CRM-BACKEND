import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { VoiceTelemetry } from "../ai/assistant/voiceTelemetry.js";
import { executeToolCall } from "../ai/assistant/toolRunner.js";
import { CRM_LIVE_FUNCTION_DECLARATIONS } from "../ai/assistant/geminiLiveGateway.js";

describe("Voice Telemetry & Correlated Timing Instrumentation", () => {
  test("1. Generates unique session and logs safe timing without leaking sensitive payloads", () => {
    const logs = [];
    const origLog = console.log;
    console.log = (msg) => {
      try {
        logs.push(JSON.parse(msg));
      } catch (e) {
        logs.push(msg);
      }
    };

    try {
      const telemetry = new VoiceTelemetry({
        socketId: "sock_test_123",
        orgId: "org_test_456",
        userId: "user_test_789",
        provider: "gemini",
      });

      assert.ok(telemetry.sessionId.startsWith("vses_"));

      // Start turn
      const turnId = telemetry.startTurn("turn_001");
      assert.equal(turnId, "turn_001");

      // Record first provider response
      const firstResponseMs = telemetry.recordFirstProviderResponse(turnId);
      assert.ok(typeof firstResponseMs === "number");

      // Record first audio
      const firstAudioMs = telemetry.recordFirstAudio(turnId);
      assert.ok(typeof firstAudioMs === "number");

      // Record tool execution with dummy sensitive payload to verify stripping
      telemetry.recordToolExecution({
        turnId,
        toolName: "get_dashboard_kpis",
        toolCallId: "call_kpi_1",
        durationMs: 45,
        ok: true,
        concurrent: true,
        data: "SECRET_SENSITIVE_DATA",
        audio: "RAW_AUDIO_BYTES",
      });

      // End turn
      const totalTurnMs = telemetry.endTurn(turnId);
      assert.ok(typeof totalTurnMs === "number");

      // Verify telemetry logs
      assert.ok(logs.length >= 4);
      const toolLog = logs.find((l) => l.event === "tool_execution");
      assert.ok(toolLog);
      assert.equal(toolLog.toolName, "get_dashboard_kpis");
      assert.equal(toolLog.concurrent, true);
      assert.equal(toolLog.data, undefined, "Sensitive payload must be stripped");
      assert.equal(toolLog.audio, undefined, "Sensitive audio bytes must be stripped");
    } finally {
      console.log = origLog;
    }
  });
});

describe("Safe Concurrent Tool Execution for Gemini Live", () => {
  const mockTools = {
    get_dashboard_kpis: {
      invoke: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return JSON.stringify({ totalLeads: 128, converted: 34 });
      },
    },
    get_salesperson_performance: {
      invoke: async () => {
        await new Promise((r) => setTimeout(r, 70));
        return JSON.stringify({ topPerformer: "Aarav Sharma", wonDeals: 12 });
      },
    },
    failing_tool: {
      invoke: async () => {
        throw new Error("Simulated database timeout");
      },
    },
  };

  test("1. Concurrently executes independent CRM queries in parallel, bounding total latency", async () => {
    const functionCalls = [
      { id: "call_1", name: "get_dashboard_kpis", args: { period: "today" } },
      { id: "call_2", name: "get_salesperson_performance", args: { period: "this_week" } },
    ];

    const startTime = Date.now();

    // Parallel execution via Promise.all (as implemented in geminiLiveGateway)
    const functionResponses = await Promise.all(
      functionCalls.map(async (fc) => {
        const result = await executeToolCall({
          toolCall: { id: fc.id, name: fc.name, args: fc.args || {} },
          toolsByName: mockTools,
          timeoutMs: 3000,
        });

        return {
          id: fc.id,
          name: fc.name,
          response: { output: result.output },
        };
      })
    );

    const totalDurationMs = Date.now() - startTime;

    // Both tools took ~60ms and ~70ms.
    // If sequential: ~130ms+. If concurrent: ~70-95ms.
    assert.ok(totalDurationMs < 125, `Expected concurrent execution (<125ms), got ${totalDurationMs}ms`);
    assert.equal(functionResponses.length, 2);
    assert.equal(functionResponses[0].id, "call_1");
    assert.equal(functionResponses[1].id, "call_2");

    const kpiOutput = JSON.parse(functionResponses[0].response.output);
    assert.equal(kpiOutput.totalLeads, 128);

    const salesOutput = JSON.parse(functionResponses[1].response.output);
    assert.equal(salesOutput.topPerformer, "Aarav Sharma");
  });

  test("2. Resilient concurrent execution handles tool failure without crashing batch", async () => {
    const functionCalls = [
      { id: "call_kpi", name: "get_dashboard_kpis", args: {} },
      { id: "call_err", name: "failing_tool", args: {} },
    ];

    const functionResponses = await Promise.all(
      functionCalls.map(async (fc) => {
        const result = await executeToolCall({
          toolCall: { id: fc.id, name: fc.name, args: fc.args || {} },
          toolsByName: mockTools,
          timeoutMs: 3000,
        });

        return {
          id: fc.id,
          name: fc.name,
          response: { output: result.output },
        };
      })
    );

    assert.equal(functionResponses.length, 2);
    assert.equal(functionResponses[0].id, "call_kpi");
    const successRes = JSON.parse(functionResponses[0].response.output);
    assert.equal(successRes.totalLeads, 128);

    assert.equal(functionResponses[1].id, "call_err");
    const errorRes = JSON.parse(functionResponses[1].response.output);
    assert.equal(errorRes.ok, false);
    assert.equal(errorRes.error_code, "EXECUTION_FAILURE");
    assert.ok(errorRes.message.includes("Simulated database timeout"));
  });
});

describe("CRM Live Function Declarations & Tool Grounding", () => {
  test("1. CRM declarations cover all 8 executive tools with required parameter schemas", () => {
    const toolNames = CRM_LIVE_FUNCTION_DECLARATIONS.map((t) => t.name);
    assert.ok(toolNames.includes("get_dashboard_kpis"));
    assert.ok(toolNames.includes("get_salesperson_performance"));
    assert.ok(toolNames.includes("search_leads"));
    assert.ok(toolNames.includes("lookup_phone_number"));
    assert.ok(toolNames.includes("get_followup_status"));
    assert.ok(toolNames.includes("get_whatsapp_analytics"));
    assert.ok(toolNames.includes("get_org_integrations_and_config"));
    assert.ok(toolNames.includes("search_crm_documentation_and_features"));
    assert.ok(toolNames.includes("close_voice_session"));
    assert.equal(CRM_LIVE_FUNCTION_DECLARATIONS.length, 9);
  });
});
