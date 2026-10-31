import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CRM_LIVE_FUNCTION_DECLARATIONS, GeminiLiveSessionManager } from "../ai/assistant/geminiLiveGateway.js";

describe("Voice BI Analyst Stop/Start & 'Okay Bye' Auto-Close", () => {
  test("1. close_voice_session declaration exists with valid farewell parameter schema", () => {
    const closeTool = CRM_LIVE_FUNCTION_DECLARATIONS.find((t) => t.name === "close_voice_session");
    assert.ok(closeTool, "close_voice_session declaration must exist");
    assert.equal(closeTool.parameters.type, "OBJECT");
    assert.ok(closeTool.parameters.properties.farewellMessage);
    assert.equal(closeTool.parameters.properties.farewellMessage.type, "STRING");
  });

  test("2. Farewell regex matches various goodbye phrases reliably", () => {
    const EXIT_PHRASES_REGEX = /\b(okay\s*bye|ok\s*bye|good\s*bye|bye\s*bye|\bbye\b|exit\s+(?:voice|session)|close\s+(?:voice|session)|stop\s+(?:voice|session))\b/i;

    assert.ok(EXIT_PHRASES_REGEX.test("okay bye"));
    assert.ok(EXIT_PHRASES_REGEX.test("Okay Bye!"));
    assert.ok(EXIT_PHRASES_REGEX.test("ok bye"));
    assert.ok(EXIT_PHRASES_REGEX.test("alright, bye bye"));
    assert.ok(EXIT_PHRASES_REGEX.test("goodbye"));
    assert.ok(EXIT_PHRASES_REGEX.test("Bye!"));
    assert.ok(EXIT_PHRASES_REGEX.test("close session"));
    assert.ok(EXIT_PHRASES_REGEX.test("stop session"));

    // Should NOT match normal CRM questions containing 'by' or unrelated terms
    assert.equal(EXIT_PHRASES_REGEX.test("Show leads grouped by salesperson"), false);
    assert.equal(EXIT_PHRASES_REGEX.test("Sort by date"), false);
  });

  test("3. close_voice_session tool invocation emits bi_voice_close_requested and marks closing requested", async () => {
    const emittedEvents = [];
    const mockSocket = {
      id: "mock_sock_001",
      emit: (event, payload) => {
        emittedEvents.push({ event, payload });
      },
    };

    const sessionManager = new GeminiLiveSessionManager({
      socket: mockSocket,
      user: { id: "u123", name: "Sales Manager", role: "sales manager" },
      organization: { _id: "org123", name: "Acme Corp" },
      tenantModels: {},
      voiceName: "Aoede",
    });

    assert.equal(sessionManager.isClosingRequested, false);
    assert.ok(sessionManager.toolsByName["close_voice_session"]);

    const resultStr = await sessionManager.toolsByName["close_voice_session"].invoke({
      farewellMessage: "Okay, goodbye! Have a great day!",
    });

    const result = JSON.parse(resultStr);
    assert.equal(result.success, true);
    assert.equal(result.status, "closing");
    assert.equal(sessionManager.isClosingRequested, true);

    const closeRequestedEvt = emittedEvents.find((e) => e.event === "bi_voice_close_requested");
    assert.ok(closeRequestedEvt);
    assert.equal(closeRequestedEvt.payload.reason, "user_farewell");
    assert.equal(closeRequestedEvt.payload.farewell, "Okay, goodbye! Have a great day!");
  });

  test("4. pause() and resume() cleanly toggle isPaused and gate sendAudioChunk", () => {
    const mockSocket = { id: "sock_pause_test", emit: () => {} };
    const sessionManager = new GeminiLiveSessionManager({
      socket: mockSocket,
      user: { id: "u123" },
      organization: { _id: "org123" },
      tenantModels: {},
    });

    assert.equal(sessionManager.isPaused, false);

    // Call pause()
    sessionManager.pause();
    assert.equal(sessionManager.isPaused, true);

    // When paused, sendAudioChunk should not queue chunks
    sessionManager.sendAudioChunk("AAAA");
    assert.equal(sessionManager.pendingAudioQueue.length, 0);

    // Call resume()
    sessionManager.resume();
    assert.equal(sessionManager.isPaused, false);
  });
});

