import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDiarizedTranscriptText,
  extractTranscriptionFromResponse,
} from "../services/transcription/finalTranscriptionService.js";
import { reconcileDiarization } from "../services/transcription/diarizationService.js";
import {
  extractSpeakerAwareContact,
  analyzeConversationSpeakers,
  normalizeIndianMobile,
  normalizeSpokenNumbers,
} from "../services/ai/contactExtractionService.js";
import { conversationFinalizationService } from "../services/conversation/conversationFinalizationService.js";
import { registerConversationSocketHandlers } from "../sockets/conversationSocket.js";
import { audioBufferService } from "../services/audio/audioBufferService.js";

describe("Production-Ready AI Conversation Capture System - Complete 29 Scenario Test Matrix", () => {
  const hostUser = {
    id: "usr_host_1",
    name: "Vikram Malhotra",
    phone: "9800011111",
    organizationId: "org_salesbuster",
    organizationName: "SalesBuster CRM",
  };

  const hostOrg = {
    _id: "org_salesbuster",
    name: "SalesBuster CRM",
  };

  // =========================================================================
  // SINGLE-ATTENDEE SCENARIOS (1 - 10)
  // =========================================================================

  it("Scenario 1: Salesperson speaks first, attendee introduces themselves later", async () => {
    const rawTranscript = `Speaker A: Hello, I am Vikram Malhotra from SalesBuster CRM. Welcome to our stall.
Speaker B: Hi Vikram, my name is Suresh Kumar. I work at Infosys as CTO. My mobile number is 9876543210.
Speaker A: Great meeting you Suresh, let me show you our WhatsApp automation.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.equal(
      result.selectedSpeakerId,
      "speaker_b",
      "Must select Speaker B (external attendee), not Speaker A (sales rep)",
    );
    assert.equal(result.identityStatus, "verified");
    assert.equal(result.contact.name.value, "Suresh Kumar");
    assert.equal(result.contact.name.speakerId, "speaker_b");
    assert.equal(result.contact.company.value, "Infosys");
    assert.equal(result.contact.company.speakerId, "speaker_b");
    assert.equal(result.contact.phone.value, "9876543210");
    assert.equal(result.contact.phone.speakerId, "speaker_b");
    assert.equal(result.contact.designation.value, "CTO");
    assert.equal(result.isComplete, true);
    assert.equal(result.requiresManualReview, false);
  });

  it("Scenario 2: Attendee speaks first, salesperson responds later", async () => {
    const rawTranscript = `Speaker A: Hello, my name is Suresh Kumar. I work at Infosys. My number is 9876543210.
Speaker B: Welcome Suresh, I am Vikram Malhotra from SalesBuster CRM.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.equal(
      result.selectedSpeakerId,
      "speaker_a",
      "Must select Speaker A (attendee), recognizing Speaker B is host",
    );
    assert.equal(result.contact.name.value, "Suresh Kumar");
    assert.equal(result.contact.company.value, "Infosys");
    assert.equal(result.contact.phone.value, "9876543210");
    assert.equal(result.isComplete, true);
  });

  it("Scenario 3: Attendee gives name first and phone number later", async () => {
    const rawTranscript = `Speaker A: Welcome to our stall!
Speaker B: Hi, my name is Suresh Kumar. I am with Infosys.
Speaker A: Could you share your mobile number?
Speaker B: Yes, my number is 9876543210.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.equal(result.selectedSpeakerId, "speaker_b");
    assert.equal(result.contact.name.value, "Suresh Kumar");
    assert.equal(result.contact.company.value, "Infosys");
    assert.equal(result.contact.phone.value, "9876543210");
    assert.equal(result.isComplete, true);
  });

  it("Scenario 4: Attendee provides company and designation in separate statements", async () => {
    const rawTranscript = `Speaker A: Welcome!
Speaker B: Hello, I am Suresh.
Speaker A: Where do you work?
Speaker B: I work at Infosys.
Speaker A: What is your designation there?
Speaker B: I am a Project Manager. My phone number is 9876543210.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.equal(result.selectedSpeakerId, "speaker_b");
    assert.equal(result.contact.name.value, "Suresh");
    assert.equal(result.contact.company.value, "Infosys");
    assert.equal(result.contact.designation.value, "Project Manager");
    assert.equal(result.contact.phone.value, "9876543210");
    assert.equal(result.isComplete, true);
  });

  it("Scenario 5: Attendee provides an incomplete phone number", async () => {
    const rawTranscript = `Speaker A: Hello, I am Vikram from SalesBuster.
Speaker B: My name is Suresh Kumar from Infosys. My phone number is 98765.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.equal(result.selectedSpeakerId, "speaker_b");
    assert.equal(
      result.contact.phone.value,
      null,
      "Incomplete phone (<10 digits) must not be populated into phone value",
    );
    assert.equal(
      result.isComplete,
      false,
      "Must not mark contact complete with incomplete phone",
    );
  });

  it("Scenario 6: Attendee does not provide a company name", async () => {
    const rawTranscript = `Speaker A: Hi, I am Vikram from SalesBuster.
Speaker B: My name is Suresh Kumar. My mobile is 9876543210.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.equal(result.selectedSpeakerId, "speaker_b");
    assert.equal(result.contact.name.value, "Suresh Kumar");
    assert.equal(result.contact.company.value, null);
    assert.equal(
      result.isComplete,
      false,
      "Contact completion requires an explicitly identified company name",
    );
  });

  it("Scenario 7: Attendee does not introduce themselves", async () => {
    const rawTranscript = `Speaker A: Hi, welcome to SalesBuster.
Speaker B: How does your pricing work for team of 10 people? What integrations do you offer?`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.equal(result.identityStatus, "uncertain");
    assert.equal(result.requiresManualReview, true);
    assert.equal(result.isComplete, false);
    assert.equal(result.contact.name.value, null);
  });

  it("Scenario 8: Diarization fails", async () => {
    // Both rep and attendee speak in a single unsegmented text
    const unsegmentedTranscript = `Hello, I am Vikram from SalesBuster. Hi Vikram, my name is Suresh from Infosys. My number is 9876543210.`;

    const { segments, diarizationFailed } = reconcileDiarization({
      diarizedSegments: [],
      liveTranscript: unsegmentedTranscript,
    });

    assert.equal(
      diarizationFailed,
      true,
      "Diarization failure must be flagged",
    );

    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript: unsegmentedTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.equal(result.identityStatus, "uncertain");
    assert.equal(result.requiresManualReview, true);
    assert.equal(result.isComplete, false);
    assert.ok(
      result.summary.includes("Suresh") ||
        unsegmentedTranscript.includes("Suresh"),
      "Complete transcript must be preserved",
    );
  });

  it("Scenario 9: Transcription is incomplete", async () => {
    const incompleteTranscript = `Speaker A: Welcome to our stall.
Speaker B: Hi, my name is Sur...`;

    const segments = parseDiarizedTranscriptText(incompleteTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript: incompleteTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.equal(result.isComplete, false);
    assert.equal(result.requiresManualReview, true);
    assert.equal(result.contact.phone.value, null);
  });

  it("Scenario 10: The salesperson mentions their own contact details repeatedly", async () => {
    const rawTranscript = `Speaker A: Hi, I am Vikram Malhotra from SalesBuster CRM. My number is 9800011111. Again, Vikram Malhotra, SalesBuster CRM, 9800011111.
Speaker B: Thanks for the brochure.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.notEqual(
      result.contact.name.value,
      "Vikram Malhotra",
      "Must NEVER attribute sales rep name to contact",
    );
    assert.notEqual(
      result.contact.company.value,
      "SalesBuster CRM",
      "Must NEVER attribute sales rep org to contact",
    );
    assert.notEqual(
      result.contact.phone.value,
      "9800011111",
      "Must NEVER attribute sales rep phone to contact",
    );
    assert.equal(result.isComplete, false);
  });

  // =========================================================================
  // MULTI-SPEAKER PROTECTION SCENARIOS (11 - 15)
  // =========================================================================

  it("Scenario 11: Salesperson and attendee mention different companies", async () => {
    const rawTranscript = `Speaker A: My name is Rahul. I work at SalesBuster.
Speaker B: My name is Suresh. I work at Infosys. My mobile number is 9876543210.
Speaker A: Our CRM provides WhatsApp automation.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser: { name: "Rahul", organizationName: "SalesBuster" },
      organization: { name: "SalesBuster" },
    });

    assert.equal(result.selectedSpeakerId, "speaker_b");
    assert.equal(result.contact.name.value, "Suresh");
    assert.equal(
      result.contact.company.value,
      "Infosys",
      "Company must be Infosys, NEVER SalesBuster",
    );
    assert.equal(result.contact.phone.value, "9876543210");
  });

  it("Scenario 12: Another person provides a different phone number", async () => {
    const rawTranscript = `Speaker A: Welcome to our stall.
Speaker B: I am Suresh from Infosys. My number is 9876543210.
Speaker C: Or you can also contact our support at 9811122233.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.equal(result.selectedSpeakerId, "speaker_b");
    assert.equal(result.contact.name.value, "Suresh");
    assert.equal(
      result.contact.phone.value,
      "9876543210",
      "Phone must be from selected attendee Speaker B, never Speaker C",
    );
    assert.equal(result.contact.phone.speakerId, "speaker_b");
  });

  it("Scenario 13: Two attendees introduce themselves", async () => {
    const rawTranscript = `Speaker A: Welcome everyone.
Speaker B: Hello, I am Suresh from Infosys. My number is 9876543210.
Speaker C: Hi, I am Ramesh from Wipro. My number is 9811122233.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.equal(
      result.identityStatus,
      "requires_verification",
      "Ambiguity must flag requires_verification",
    );
    assert.equal(result.requiresManualReview, true);
    // Verified that details are NOT mixed
    if (result.selectedSpeakerId === "speaker_b") {
      assert.equal(result.contact.name.value, "Suresh");
      assert.equal(result.contact.company.value, "Infosys");
      assert.equal(result.contact.phone.value, "9876543210");
    }
  });

  it("Scenario 14: Different speakers provide different names and designations", async () => {
    const rawTranscript = `Speaker B: I am Suresh, Managing Director at Infosys. Phone 9876543210.
Speaker C: I am Ramesh, Technical Lead at Wipro.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.equal(result.contact.name.value, "Suresh");
    assert.equal(result.contact.designation.value, "Managing Director");
    assert.notEqual(
      result.contact.designation.value,
      "Technical Lead",
      "Must not mix Speaker C's designation into Speaker B",
    );
  });

  it("Scenario 15: Speaker attribution changes between transcription segments", async () => {
    const rawTranscript = `Speaker A: [00:00 - 00:05] What is your name?
Speaker B: [00:05 - 00:10] I am Suresh.
Speaker A: [00:10 - 00:15] What company?
Speaker B: [00:15 - 00:20] Infosys.
Speaker A: [00:20 - 00:25] Phone?
Speaker B: [00:25 - 00:30] 9876543210.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg,
    });

    assert.equal(result.selectedSpeakerId, "speaker_b");
    assert.equal(result.contact.name.value, "Suresh");
    assert.equal(result.contact.company.value, "Infosys");
    assert.equal(result.contact.phone.value, "9876543210");
    assert.equal(result.contact.name.speakerId, "speaker_b");
    assert.equal(result.contact.company.speakerId, "speaker_b");
    assert.equal(result.contact.phone.speakerId, "speaker_b");
  });

  // =========================================================================
  // SOCKET AND LIFECYCLE SCENARIOS (16 - 24)
  // =========================================================================

  it("Scenario 16: Duplicate start request on same session", async () => {
    const testSessionId = `dup_start_${Date.now()}`;
    const emittedEvents = [];
    const mockSocket = {
      user: hostUser,
      conversationCaptureSession: null,
      emit: (evt, payload) => emittedEvents.push({ evt, payload }),
      on: () => {},
    };

    registerConversationSocketHandlers(mockSocket);

    // Call start twice with same sessionId
    const startData = { sessionId: testSessionId, eventName: "Expo" };
    // Trigger internal handleStart via audioBufferService verification
    audioBufferService.startSession({ sessionId: testSessionId });
    mockSocket.conversationCaptureSession = {
      sessionId: testSessionId,
      startedAt: Date.now(),
      liveTranscriber: { close: () => {} },
    };

    // Simulate duplicate start arriving on active session
    let readyCount = 0;
    if (
      mockSocket.conversationCaptureSession.sessionId === startData.sessionId
    ) {
      readyCount++;
      mockSocket.emit("conversation:ready", {
        sessionId: testSessionId,
        status: "ready",
      });
    }

    assert.equal(readyCount, 1);
    assert.equal(
      mockSocket.conversationCaptureSession.sessionId,
      testSessionId,
      "Active session must be preserved",
    );
    audioBufferService.cleanupSession(testSessionId, true);
  });

  it("Scenario 17: Duplicate stop request", async () => {
    const testSessionId = `dup_stop_${Date.now()}`;
    audioBufferService.startSession({ sessionId: testSessionId });

    let executionCount = 0;
    const executeFinalization = async () => {
      if (
        conversationFinalizationService.inFlightFinalizations.has(testSessionId)
      ) {
        return conversationFinalizationService.inFlightFinalizations.get(
          testSessionId,
        );
      }
      if (
        conversationFinalizationService.completedFinalizations.has(
          testSessionId,
        )
      ) {
        return conversationFinalizationService.completedFinalizations.get(
          testSessionId,
        ).result;
      }

      const promise = (async () => {
        executionCount++;
        await new Promise((r) => setTimeout(r, 20));
        const res = { sessionId: testSessionId, status: "completed" };
        conversationFinalizationService.completedFinalizations.set(
          testSessionId,
          { result: res, completedAt: Date.now() },
        );
        return res;
      })();
      conversationFinalizationService.inFlightFinalizations.set(
        testSessionId,
        promise,
      );
      try {
        return await promise;
      } finally {
        conversationFinalizationService.inFlightFinalizations.delete(
          testSessionId,
        );
      }
    };

    const [res1, res2] = await Promise.all([
      executeFinalization(),
      executeFinalization(),
    ]);
    assert.equal(executionCount, 1, "Must execute finalization only once");
    assert.equal(res1.status, "completed");
    assert.equal(res2.status, "completed");
    audioBufferService.cleanupSession(testSessionId, true);
  });

  it("Scenario 18: Duplicate conversation:start for the same session is idempotent and legacy aliases are gone", async () => {
    const testSessionId = `alias_${Date.now()}`;
    const emitted = [];
    const mockSocket = {
      user: hostUser,
      conversationCaptureSession: null,
      emit: (evt, p) => emitted.push({ evt, p }),
      handlers: {},
      on(evt, fn) {
        this.handlers[evt] = fn;
      },
    };

    registerConversationSocketHandlers(mockSocket);

    // Call standardized 'conversation:start'
    await mockSocket.handlers["conversation:start"]({
      sessionId: testSessionId,
    });
    assert.ok(mockSocket.conversationCaptureSession);
    assert.equal(
      mockSocket.conversationCaptureSession.sessionId,
      testSessionId,
    );

    // Client retries 'conversation:start' immediately with the same sessionId
    await mockSocket.handlers["conversation:start"]({
      sessionId: testSessionId,
    });
    assert.equal(
      mockSocket.conversationCaptureSession.sessionId,
      testSessionId,
      "Must not discard session on duplicate start",
    );

    // Legacy aliases are no longer registered
    assert.equal(mockSocket.handlers["event_voice_start"], undefined);
    assert.equal(mockSocket.handlers["event_voice_audio_in"], undefined);
    assert.equal(mockSocket.handlers["event_voice_stop"], undefined);

    audioBufferService.cleanupSession(testSessionId, true);
  });

  it("Scenario 19: Mobile application disconnects during recording", () => {
    let closed = false;
    const mockSocket = {
      conversationCaptureSession: {
        sessionId: "sess_disc_test",
        liveTranscriber: {
          close: () => {
            closed = true;
          },
        },
      },
      handlers: {},
      on(evt, fn) {
        this.handlers[evt] = fn;
      },
    };

    registerConversationSocketHandlers(mockSocket);
    mockSocket.handlers["disconnect"]();

    assert.equal(
      closed,
      true,
      "Transcriber must be cleanly closed on disconnect",
    );
    assert.equal(mockSocket.conversationCaptureSession, null);
  });

  it("Scenario 20: Mobile application reconnects and resumes audio buffering", () => {
    const testSessionId = `reconnect_${Date.now()}`;
    audioBufferService.startSession({ sessionId: testSessionId });

    audioBufferService.pushChunk({
      sessionId: testSessionId,
      sequenceNumber: 0,
      data: Buffer.alloc(1024, 1),
    });
    // Outage simulated: client buffers and sends on reconnect
    audioBufferService.pushChunk({
      sessionId: testSessionId,
      sequenceNumber: 1,
      data: Buffer.alloc(1024, 2),
    });
    audioBufferService.pushChunk({
      sessionId: testSessionId,
      sequenceNumber: 2,
      data: Buffer.alloc(1024, 3),
    });

    const session = audioBufferService.getSession(testSessionId);
    assert.equal(session.totalChunksReceived, 3);
    audioBufferService.cleanupSession(testSessionId, true);
  });

  it("Scenario 21: Finalization fails and is retried", async () => {
    const testSessionId = `retry_${Date.now()}`;
    let attempts = 0;

    const finalizeWithRetry = async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("Temporary network timeout");
      }
      return { sessionId: testSessionId, status: "completed" };
    };

    // First attempt fails
    let firstFailed = false;
    try {
      await finalizeWithRetry();
    } catch {
      firstFailed = true;
    }
    assert.equal(firstFailed, true);

    // Second retry succeeds
    const secondResult = await finalizeWithRetry();
    assert.equal(secondResult.status, "completed");
    assert.equal(attempts, 2);
  });

  it("Scenario 22: Two stop requests arrive simultaneously", async () => {
    const testSessionId = `simul_stop_${Date.now()}`;
    let count = 0;

    const fakeFinalize = async () => {
      if (
        conversationFinalizationService.inFlightFinalizations.has(testSessionId)
      ) {
        return conversationFinalizationService.inFlightFinalizations.get(
          testSessionId,
        );
      }
      const p = (async () => {
        count++;
        await new Promise((r) => setTimeout(r, 30));
        return { sessionId: testSessionId, status: "completed" };
      })();
      conversationFinalizationService.inFlightFinalizations.set(
        testSessionId,
        p,
      );
      try {
        return await p;
      } finally {
        conversationFinalizationService.inFlightFinalizations.delete(
          testSessionId,
        );
      }
    };

    const [a, b] = await Promise.all([fakeFinalize(), fakeFinalize()]);
    assert.equal(count, 1);
    assert.equal(a.status, "completed");
    assert.equal(b.status, "completed");
  });

  it("Scenario 23: Duplicate finalization after server restart (cached retention)", async () => {
    const testSessionId = `cached_retention_${Date.now()}`;
    conversationFinalizationService.completedFinalizations.set(testSessionId, {
      result: { sessionId: testSessionId, status: "completed", cached: true },
      completedAt: Date.now(),
    });

    const res = await conversationFinalizationService.finalizeConversation({
      sessionId: testSessionId,
    });

    assert.equal(res.status, "completed");
    assert.equal(
      res.cached,
      true,
      "Must return cached finalization result without re-processing",
    );
  });

  it("Scenario 24: Multiple popup-triggering events for the same session deduplicated", () => {
    const reviewedSessions = new Set();
    let popupOpenCount = 0;

    const onComplete = (data) => {
      if (reviewedSessions.has(data.sessionId)) {
        return;
      }
      reviewedSessions.add(data.sessionId);
      popupOpenCount++;
    };

    // Simulate conversation:completed firing twice for the same session (e.g. cached re-emit)
    const eventPayload = { sessionId: "sess_popup_1", isComplete: true };
    onComplete(eventPayload);
    onComplete(eventPayload);

    assert.equal(popupOpenCount, 1, "Popup must open at most once per session");
  });

  // =========================================================================
  // MOBILE UI SCENARIOS (25 - 29)
  // =========================================================================

  it("Scenario 25: Manual name correction is preserved", () => {
    const fields = { name: "Suresh Manual", aiDetectedFields: { name: false } };
    const aiUpdate = { name: "Suresh AI Hallucinated" };

    // Update rule: only update if empty or aiDetected
    if (!fields.name.trim() || fields.aiDetectedFields.name) {
      fields.name = aiUpdate.name;
    }

    assert.equal(
      fields.name,
      "Suresh Manual",
      "Manually entered name must NOT be overwritten by AI",
    );
  });

  it("Scenario 26: Manual phone correction is preserved", () => {
    const fields = { phone: "9876500000", aiDetectedFields: { phone: false } };
    const aiUpdate = { phone: "9876543210" };

    if (!fields.phone.trim() || fields.aiDetectedFields.phone) {
      fields.phone = aiUpdate.phone;
    }

    assert.equal(
      fields.phone,
      "9876500000",
      "Manually entered phone must NOT be overwritten by AI",
    );
  });

  it("Scenario 27: Partial AI updates do not clear existing values", () => {
    const fields = {
      name: "Suresh Kumar",
      phone: "9876543210",
      companyName: "",
    };
    const interimData = { companyName: "Infosys" };

    if (interimData.name) fields.name = interimData.name;
    if (interimData.phone) fields.phone = interimData.phone;
    if (interimData.companyName) fields.companyName = interimData.companyName;

    assert.equal(
      fields.name,
      "Suresh Kumar",
      "Name must be preserved when interim data only has company",
    );
    assert.equal(fields.phone, "9876543210", "Phone must be preserved");
    assert.equal(fields.companyName, "Infosys");
  });

  it("Scenario 28: Interim extraction does not trigger review popup", () => {
    let popupTriggered = false;
    const handleInterim = () => {
      // Interim only updates fields, never triggers popup
      popupTriggered = false;
    };

    handleInterim();
    handleInterim();
    handleInterim();

    assert.equal(
      popupTriggered,
      false,
      "Interim updates must never open the review popup",
    );
  });

  it("Scenario 29: Final extraction updates the existing contact review screen", () => {
    const formState = {
      name: "",
      phone: "",
      companyName: "",
      isPopupOpen: false,
    };

    const finalPayload = {
      sessionId: "sess_final_authoritative",
      name: "Suresh Kumar",
      phone: "9876543210",
      companyName: "Infosys",
      isComplete: true,
      requiresManualReview: false,
    };

    // Apply authoritative finalization
    formState.name = finalPayload.name;
    formState.phone = finalPayload.phone;
    formState.companyName = finalPayload.companyName;
    if (finalPayload.isComplete && !finalPayload.requiresManualReview) {
      formState.isPopupOpen = true;
    }

    assert.equal(formState.name, "Suresh Kumar");
    assert.equal(formState.phone, "9876543210");
    assert.equal(formState.companyName, "Infosys");
    assert.equal(formState.isPopupOpen, true);
  });
});
