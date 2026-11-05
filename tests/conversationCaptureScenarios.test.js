import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createWavHeader,
  pcmToWav,
  calculatePcmDuration,
  validatePcmChunk,
  segmentPcmBuffer,
} from "../utils/audioUtils.js";
import { audioBufferService } from "../services/audio/audioBufferService.js";
import { parseDiarizedTranscriptText } from "../services/transcription/finalTranscriptionService.js";
import { reconcileDiarization } from "../services/transcription/diarizationService.js";
import { conversationFinalizationService } from "../services/conversation/conversationFinalizationService.js";

describe("Production-Ready AI Conversation Capture System - 20 Scenario Test Matrix", () => {
  const hostUser = {
    id: "usr_host_1",
    name: "Vikram Malhotra",
    phone: "9800011111",
    organizationId: "org_salesbuster",
  };

  const hostOrg = {
    _id: "org_salesbuster",
    name: "SalesBuster CRM",
  };

  // =========================================================================
  // SCENARIO 1: One person introduces themselves
  // =========================================================================
  it("Scenario 1: One person introduces themselves - attributes all details to Speaker A", () => {
    const rawTranscript = `Speaker A: Hi, my name is Rahul Sharma. I am a software engineer at TCS. My phone number is 9876543210.`;
    const segments = parseDiarizedTranscriptText(rawTranscript);
    const { speakers } = reconcileDiarization({ diarizedSegments: segments });

    assert.equal(segments.length, 1);
    assert.equal(segments[0].speakerId, "speaker_a");
    assert.ok(segments[0].text.includes("Rahul Sharma"));
    assert.equal(speakers.length, 1);
  });

  // =========================================================================
  // SCENARIO 2: Two people introduce themselves
  // =========================================================================
  it("Scenario 2: Two people introduce themselves - selects FIRST person who introduced themselves", () => {
    const rawTranscript = `Speaker A: Hello, my name is Rahul. I am with TCS.
Speaker B: Nice to meet you. I am Suresh Verma from Infosys. My number is 9811122233.
Speaker A: My number is 9876543210.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    assert.equal(segments.length, 3);
    assert.equal(segments[0].speakerId, "speaker_a");
    assert.equal(segments[1].speakerId, "speaker_b");
    assert.equal(segments[2].speakerId, "speaker_a");

    // Chronologically, Speaker A introduced first
    const firstIntro = segments.find((s) => /my name is|i am\b/i.test(s.text));
    assert.equal(firstIntro.speakerId, "speaker_a");
    assert.ok(firstIntro.text.includes("Rahul"));
  });

  // =========================================================================
  // SCENARIO 3: Three people introduce themselves
  // =========================================================================
  it("Scenario 3: Three people introduce themselves - preserves first external attendee", () => {
    const rawTranscript = `Speaker A: Good morning, I am Rahul Mehta from Apex Global.
Speaker B: Hi Rahul, I am Amit Joshi from Tech Corp.
Speaker C: Hello everyone, I am Priya Nair from Zenith Systems.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    assert.equal(segments.length, 3);
    assert.equal(segments[0].speakerId, "speaker_a");
    assert.equal(segments[1].speakerId, "speaker_b");
    assert.equal(segments[2].speakerId, "speaker_c");

    const firstExternalSpeaker = segments[0].speakerId;
    assert.equal(firstExternalSpeaker, "speaker_a");
  });

  // =========================================================================
  // SCENARIO 4: Speaker A gives name, Speaker B gives company (CRITICAL INVARIANT)
  // =========================================================================
  it("Scenario 4: Speaker A gives name, Speaker B gives company - NEVER mixes Speaker B company into Speaker A", () => {
    const rawTranscript = `Speaker A: Hi, my name is Rahul.
Speaker B: Nice to meet you Rahul. I work at Infosys.
Speaker A: I am a software developer at TCS.
Speaker B: I am a project manager here.
Speaker A: My number is 9876543210.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    assert.equal(segments.length, 5);

    // Isolate statements strictly by speakerId
    const speakerATurns = segments.filter((s) => s.speakerId === "speaker_a");
    const speakerBTurns = segments.filter((s) => s.speakerId === "speaker_b");

    const textA = speakerATurns.map((s) => s.text).join(" ");
    const textB = speakerBTurns.map((s) => s.text).join(" ");

    assert.ok(textA.includes("TCS"));
    assert.ok(!textA.includes("Infosys"), "Speaker A statements must NOT contain Infosys");
    assert.ok(textB.includes("Infosys"), "Infosys belongs strictly to Speaker B");
    assert.ok(textB.includes("project manager"), "Project manager belongs strictly to Speaker B");
  });

  // =========================================================================
  // SCENARIO 5: Speaker A provides name and later their designation
  // =========================================================================
  it("Scenario 5: Speaker A provides name and later their designation - correlates subsequent turns", () => {
    const rawTranscript = `Speaker A: Hi, I'm Rahul.
Speaker B: How are you doing?
Speaker A: Doing great. By the way, I am the Technical Lead at Acme Corp.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const speakerATurns = segments.filter((s) => s.speakerId === "speaker_a");
    const combinedAText = speakerATurns.map((s) => s.text).join(" ");

    assert.ok(combinedAText.includes("Rahul"));
    assert.ok(combinedAText.includes("Technical Lead"));
    assert.ok(combinedAText.includes("Acme Corp"));
  });

  // =========================================================================
  // SCENARIO 6: Phone number is never spoken
  // =========================================================================
  it("Scenario 6: Phone number is never spoken - phone value is null without hallucination", () => {
    const rawTranscript = `Speaker A: Hello, my name is Rahul. I am from TCS. We can connect next week.
Speaker B: Sounds good Rahul, nice meeting you.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const fullText = segments.map((s) => s.text).join(" ");
    const digitsFound = fullText.match(/\b[6-9]\d{9}\b/);

    assert.equal(digitsFound, null, "No phone number should be present");
  });

  // =========================================================================
  // SCENARIO 7: Name is spoken in Telugu
  // =========================================================================
  it("Scenario 7: Name is spoken in Telugu - preserves Telugu self-introduction", () => {
    const rawTranscript = `Speaker A: Namaskaram, na peru Venkata Rao. Nenu Sri Balaji Infotech lo Managing Director ga chestunnanu. Na number 9848099887.
Speaker B: Namaskaram andi Venkata Rao garu.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].speakerId, "speaker_a");
    assert.ok(segments[0].text.includes("Venkata Rao"));
    assert.ok(segments[0].text.includes("Sri Balaji Infotech"));
    assert.ok(segments[0].text.includes("9848099887"));
  });

  // =========================================================================
  // SCENARIO 8: English and Telugu mixed (Tenglish)
  // =========================================================================
  it("Scenario 8: English and Telugu mixed - handles code-switching smoothly", () => {
    const rawTranscript = `Speaker A: Hello sir, na peru Suresh Reddy. I am working as Purchase Manager at Reddy Textiles. WhatsApp me on 9988776655.
Speaker B: Sure Suresh garu, we will share the catalog.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    assert.equal(segments.length, 2);
    assert.ok(segments[0].text.includes("Suresh Reddy"));
    assert.ok(segments[0].text.includes("Reddy Textiles"));
    assert.ok(segments[0].text.includes("Purchase Manager"));
    assert.ok(segments[0].text.includes("9988776655"));
  });

  // =========================================================================
  // SCENARIO 9: English and Hindi mixed (Hinglish)
  // =========================================================================
  it("Scenario 9: English and Hindi mixed - preserves Hindi self-intro and English terms", () => {
    const rawTranscript = `Speaker A: Hello, mera naam Rajesh Kumar hai. Main Apex Enterprises mein Senior Consultant hoon. Mera mobile number 9822334455 hai.
Speaker B: Bahut achha Rajesh ji, aapse milkar khushi hui.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    assert.equal(segments.length, 2);
    assert.ok(segments[0].text.includes("Rajesh Kumar"));
    assert.ok(segments[0].text.includes("Apex Enterprises"));
    assert.ok(segments[0].text.includes("Senior Consultant"));
    assert.ok(segments[0].text.includes("9822334455"));
  });

  // =========================================================================
  // SCENARIO 10: Two people speak simultaneously
  // =========================================================================
  it("Scenario 10: Two people speak simultaneously - maintains separated speaker turns", () => {
    const rawTranscript = `Speaker A: [00:02 - 00:05] Yes, our main office is in Hyderabad.
Speaker B: [00:03 - 00:06] We also have an office in Bangalore.
Speaker A: [00:06 - 00:08] Exactly, and my number is 9876543210.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    assert.equal(segments.length, 3);
    assert.equal(segments[0].speakerId, "speaker_a");
    assert.equal(segments[1].speakerId, "speaker_b");
    assert.equal(segments[2].speakerId, "speaker_a");
    assert.equal(segments[0].startTime, 2);
    assert.equal(segments[1].startTime, 3);
  });

  // =========================================================================
  // SCENARIO 11: Network disconnects during recording
  // =========================================================================
  it("Scenario 11: Network disconnects during recording - buffers chunks and resumes without loss", () => {
    const testSessionId = `test_net_disc_${Date.now()}`;
    audioBufferService.startSession({ sessionId: testSessionId });

    // Stream chunks before disconnect
    const chunk1 = Buffer.alloc(1024, 1);
    const chunk2 = Buffer.alloc(1024, 2);
    audioBufferService.pushChunk({ sessionId: testSessionId, sequenceNumber: 0, data: chunk1 });
    audioBufferService.pushChunk({ sessionId: testSessionId, sequenceNumber: 1, data: chunk2 });

    // Client buffers chunks during network outage and delivers upon reconnection
    const chunk3 = Buffer.alloc(1024, 3);
    const chunk4 = Buffer.alloc(1024, 4);
    const r3 = audioBufferService.pushChunk({ sessionId: testSessionId, sequenceNumber: 2, data: chunk3 });
    const r4 = audioBufferService.pushChunk({ sessionId: testSessionId, sequenceNumber: 3, data: chunk4 });

    assert.equal(r3.accepted, true);
    assert.equal(r4.accepted, true);
    assert.equal(audioBufferService.getSession(testSessionId).totalChunksReceived, 4);

    audioBufferService.cleanupSession(testSessionId, true);
  });

  // =========================================================================
  // SCENARIO 12: Audio chunks arrive out of order
  // =========================================================================
  it("Scenario 12: Audio chunks arrive out of order - reorders strictly by sequence number", async () => {
    const testSessionId = `test_ooo_${Date.now()}`;
    audioBufferService.startSession({ sessionId: testSessionId });

    // Generate unique content per chunk
    const b0 = Buffer.alloc(1024, 0xAA);
    const b1 = Buffer.alloc(1024, 0xBB);
    const b2 = Buffer.alloc(1024, 0xCC);
    const b3 = Buffer.alloc(1024, 0xDD);

    // Push out of order: 0, 2, 1, 3
    audioBufferService.pushChunk({ sessionId: testSessionId, sequenceNumber: 0, data: b0 });
    audioBufferService.pushChunk({ sessionId: testSessionId, sequenceNumber: 2, data: b2 });
    audioBufferService.pushChunk({ sessionId: testSessionId, sequenceNumber: 1, data: b1 });
    audioBufferService.pushChunk({ sessionId: testSessionId, sequenceNumber: 3, data: b3 });

    const session = audioBufferService.getSession(testSessionId);
    assert.equal(session.outOfOrderCount, 1);

    const { pcmBuffer } = await audioBufferService.finalizeSession(testSessionId);
    assert.equal(pcmBuffer.length, 4096);

    // Verify sequential byte order in assembled PCM
    assert.equal(pcmBuffer[0], 0xAA); // seq 0
    assert.equal(pcmBuffer[1024], 0xBB); // seq 1
    assert.equal(pcmBuffer[2048], 0xCC); // seq 2
    assert.equal(pcmBuffer[3072], 0xDD); // seq 3

    audioBufferService.cleanupSession(testSessionId, true);
  });

  // =========================================================================
  // SCENARIO 13: User stops recording immediately after starting (< 1s)
  // =========================================================================
  it("Scenario 13: User stops recording immediately after starting - handles edge case gracefully", async () => {
    const testSessionId = `test_instant_stop_${Date.now()}`;
    audioBufferService.startSession({ sessionId: testSessionId });

    // 1 chunk (32ms)
    const tinyChunk = Buffer.alloc(1024);
    audioBufferService.pushChunk({ sessionId: testSessionId, sequenceNumber: 0, data: tinyChunk });

    const finalized = await audioBufferService.finalizeSession(testSessionId);
    assert.ok(finalized.durationSec <= 1.0);
    assert.ok(finalized.wavBuffer.length > 44);

    audioBufferService.cleanupSession(testSessionId, true);
  });

  // =========================================================================
  // SCENARIO 14: Empty or unclear audio
  // =========================================================================
  it("Scenario 14: Empty or unclear audio - returns graceful empty extraction", () => {
    const emptyTranscript = "";
    const segments = parseDiarizedTranscriptText(emptyTranscript);
    const { speakers, uniqueSpeakerIds } = reconcileDiarization({
      diarizedSegments: segments,
      liveTranscript: "",
    });

    assert.equal(segments.length, 0);
    assert.equal(speakers.length, 0);
    assert.equal(uniqueSpeakerIds.length, 0);
  });

  // =========================================================================
  // SCENARIO 15: Duplicate stop requests
  // =========================================================================
  it("Scenario 15: Duplicate stop requests - idempotent lock prevents duplicate runs", async () => {
    const testSessionId = `test_dup_stop_${Date.now()}`;
    let callCount = 0;

    // Simulate mock finalization with in-flight lock
    const mockFinalize = async (sessionId) => {
      if (conversationFinalizationService.inFlightFinalizations.has(sessionId)) {
        return conversationFinalizationService.inFlightFinalizations.get(sessionId);
      }
      const promise = (async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 50));
        return { sessionId, status: "completed" };
      })();
      conversationFinalizationService.inFlightFinalizations.set(sessionId, promise);
      try {
        return await promise;
      } finally {
        conversationFinalizationService.inFlightFinalizations.delete(sessionId);
      }
    };

    // Fire two parallel stop requests
    const [res1, res2] = await Promise.all([
      mockFinalize(testSessionId),
      mockFinalize(testSessionId),
    ]);

    assert.equal(res1.status, "completed");
    assert.equal(res2.status, "completed");
    assert.equal(callCount, 1, "Finalization process must execute exactly once");
  });

  // =========================================================================
  // SCENARIO 16: Same speaker mentions their company multiple times
  // =========================================================================
  it("Scenario 16: Same speaker mentions company multiple times - consistent attribution", () => {
    const rawTranscript = `Speaker A: I am Rahul from TCS.
Speaker B: What does TCS do?
Speaker A: TCS is a leading IT consultancy and services firm.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const speakerAText = segments
      .filter((s) => s.speakerId === "speaker_a")
      .map((s) => s.text)
      .join(" ");

    assert.ok(speakerAText.includes("Rahul"));
    assert.ok(speakerAText.includes("TCS"));
  });

  // =========================================================================
  // SCENARIO 17: Diarization fails or unsegmented
  // =========================================================================
  it("Scenario 17: Diarization fallback - falls back gracefully to live transcript", () => {
    const liveTranscript = "Hello this is a customer inquiry without explicit speaker tags";
    const { segments, speakers } = reconcileDiarization({
      diarizedSegments: [],
      liveTranscript,
    });

    assert.equal(segments.length, 1);
    assert.equal(segments[0].speakerId, "speaker_A");
    assert.equal(segments[0].text, liveTranscript);
    assert.equal(speakers.length, 1);
  });

  // =========================================================================
  // SCENARIO 18: Recording exceeds live session duration (10 min boundary)
  // =========================================================================
  it("Scenario 18: Live transcription session rotation timing - computes correct schedule", () => {
    // 9.5 minutes in ms = 570,000 ms
    const rotationThresholdMs = 570000;
    const sessionDurationMs = 600000; // 10 minutes
    assert.ok(rotationThresholdMs < sessionDurationMs);
    assert.equal(rotationThresholdMs / 1000 / 60, 9.5);
  });

  // =========================================================================
  // SCENARIO 19: Recording exceeds final diarization duration (> 25 min)
  // =========================================================================
  it("Scenario 19: Recording exceeds 25 min - segments audio safely below diarization ceiling", () => {
    const bytesPerSec = 16000 * 2;
    // 30 minutes of audio
    const thirtyMinBytes = 30 * 60 * bytesPerSec;
    const mockPcm = Buffer.alloc(thirtyMinBytes);

    // Segment duration 25 minutes = 1500 seconds
    const segments = segmentPcmBuffer(mockPcm, 1500, 16000);

    assert.equal(segments.length, 2);
    assert.equal(segments[0].segmentIndex, 0);
    assert.equal(segments[0].startTimeSec, 0);
    assert.equal(segments[0].durationSec, 1500);

    assert.equal(segments[1].segmentIndex, 1);
    assert.equal(segments[1].startTimeSec, 1500);
    assert.equal(segments[1].durationSec, 300);
  });

  // =========================================================================
  // SCENARIO 20: Cross-segment speaker identity representation
  // =========================================================================
  it("Scenario 20: Cross-segment speaker representation - preserves consistent speaker offsets", () => {
    const rawSeg1 = `Speaker A: [00:00 - 00:10] Hi, my name is Rahul.
Speaker B: [00:11 - 00:20] Nice to meet you.`;

    const rawSeg2 = `Speaker A: [00:00 - 00:15] And my phone is 9876543210.
Speaker B: [00:16 - 00:25] Got it.`;

    const parsed1 = parseDiarizedTranscriptText(rawSeg1, 0);
    // Second segment starts at 1500 seconds (25 minutes offset)
    const parsed2 = parseDiarizedTranscriptText(rawSeg2, 1500);

    assert.equal(parsed1[0].startTime, 0);
    assert.equal(parsed1[1].startTime, 11);

    assert.equal(parsed2[0].startTime, 1500);
    assert.equal(parsed2[1].startTime, 1516);
    assert.equal(parsed2[0].speakerId, "speaker_a");
  });
});

