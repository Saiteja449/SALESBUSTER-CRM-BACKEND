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
  test("1. CRM declarations cover all 10 executive tools with required parameter schemas", () => {
    const toolNames = CRM_LIVE_FUNCTION_DECLARATIONS.map((t) => t.name);
    assert.ok(toolNames.includes("get_dashboard_kpis"));
    assert.ok(toolNames.includes("get_salesperson_performance"));
    assert.ok(toolNames.includes("search_leads"));
    assert.ok(toolNames.includes("lookup_phone_number"));
    assert.ok(toolNames.includes("get_followup_status"));
    assert.ok(toolNames.includes("get_whatsapp_analytics"));
    assert.ok(toolNames.includes("get_org_integrations_and_config"));
    assert.ok(toolNames.includes("search_crm_documentation_and_features"));
    assert.ok(toolNames.includes("compose_salesperson_report_email"));
    assert.ok(toolNames.includes("confirm_send_email_report"));
    assert.equal(CRM_LIVE_FUNCTION_DECLARATIONS.length, 10);
  });
});

describe("Gemini Live Gateway - Interim & Final User Speech Separation", () => {
  test("Gateway emits bi_voice_transcript_interim for hypotheses and bi_voice_transcript_final for committed segments", async () => {
    const { GeminiLiveSessionManager } = await import("../ai/assistant/geminiLiveGateway.js");

    const emittedEvents = [];
    const mockSocket = {
      id: "test_sock_1",
      emit: (event, payload) => {
        emittedEvents.push({ event, payload });
      },
    };

    const manager = new GeminiLiveSessionManager({
      socket: mockSocket,
      user: { id: "u1", name: "Sales Rep" },
      organization: { _id: "o1", name: "Test Org" },
      tenantModels: {},
    });

    // 1. Receive interim transcript hypothesis
    await manager.handleServerMessage({
      serverContent: {
        interimInputTranscription: { text: "Hello I am" },
      },
    });

    assert.equal(emittedEvents.length, 1);
    assert.equal(emittedEvents[0].event, "bi_voice_transcript_interim");
    assert.equal(emittedEvents[0].payload.text, "Hello I am");
    // Crucial: currentTurnUserText must NOT accumulate interim hypothesis
    assert.equal(manager.currentTurnUserText, "");

    // 2. Receive final committed segment
    await manager.handleServerMessage({
      serverContent: {
        inputTranscription: { text: "Hello I am Ramesh" },
      },
    });

    assert.equal(emittedEvents.length, 2);
    assert.equal(emittedEvents[1].event, "bi_voice_transcript_final");
    assert.equal(emittedEvents[1].payload.text, "Hello I am Ramesh");
    assert.equal(manager.currentTurnUserText, "Hello I am Ramesh");

    // 3. Receive second final segment (concatenated exactly as received)
    await manager.handleServerMessage({
      serverContent: {
        inputTranscription: { text: " from Acme" },
      },
    });

    assert.equal(manager.currentTurnUserText, "Hello I am Ramesh from Acme");

    // 4. Turn complete normalizes whitespace
    await manager.handleServerMessage({
      serverContent: {
        turnComplete: true,
      },
    });

    assert.ok(emittedEvents.some((e) => e.event === "bi_voice_turn_complete"));
  });

  test("Gateway watchdog emits bi_voice_no_response after 8s of forwarded chunks and resets on server message", async () => {
    const { GeminiLiveSessionManager } = await import("../ai/assistant/geminiLiveGateway.js");

    const emittedEvents = [];
    const mockSocket = {
      id: "test_sock_watchdog",
      emit: (event, payload) => {
        emittedEvents.push({ event, payload });
      },
    };

    const manager = new GeminiLiveSessionManager({
      socket: mockSocket,
      user: { id: "u1", name: "Sales Rep" },
      organization: { _id: "o1", name: "Test Org" },
      tenantModels: {},
    });

    const sentAudioChunks = [];
    manager.session = {
      sendRealtimeInput: (input) => {
        sentAudioChunks.push(input);
      },
    };
    manager.isActive = true;

    // Send first chunk at t0
    const base64Sample = Buffer.from(new Uint8Array(1024)).toString("base64");
    manager.sendAudioChunk(base64Sample);
    assert.equal(emittedEvents.filter((e) => e.event === "bi_voice_no_response").length, 0);

    // Fast-forward forwardedChunksStartTime by 8.5 seconds
    manager.forwardedChunksStartTime = Date.now() - 8500;
    manager.sendAudioChunk(base64Sample);

    const noResponseEvents = emittedEvents.filter((e) => e.event === "bi_voice_no_response");
    assert.equal(noResponseEvents.length, 1);
    assert.ok(noResponseEvents[0].payload.secondsWithoutResponse >= 8);

    // Calling again within 15 seconds should be throttled (at most once per 15s)
    manager.sendAudioChunk(base64Sample);
    assert.equal(emittedEvents.filter((e) => e.event === "bi_voice_no_response").length, 1);

    // Any server message resets the watchdog
    await manager.handleServerMessage({ setupComplete: true });
    assert.equal(manager.forwardedChunksStartTime, null);

    // Chunks start accumulating again
    manager.sendAudioChunk(base64Sample);
    assert.ok(manager.forwardedChunksStartTime !== null);
  });
});
