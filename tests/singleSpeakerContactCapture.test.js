/**
 * Test Suite: Single-Speaker Contact Capture & Auto-Fill Matrix
 * Covers Scenarios A through J explicitly:
 * - Scenario A: Complete conversation (Name, phone, company, designation, summary)
 * - Scenario B: Missing company (Name and phone populate; company is empty; save proceeds)
 * - Scenario C: Partial conversation (Name and company first, phone later; prior fields preserved)
 * - Scenario D: Incorrect interim extraction replaced by higher-confidence final extraction
 * - Scenario E: Manual field editing preserved against subsequent AI updates
 * - Scenario F: Salesperson vs attendee differentiation (sales rep intro ignored)
 * - Scenario G: Phone number spoken in chunks ("98765 43210" or formatted)
 * - Scenario H: Canonical alias normalization (customerName, mobileNumber, organization, jobTitle, etc.)
 * - Scenario I: Finalization race condition (mergeContactData passes merged object directly to save)
 * - Scenario J: No hallucination (missing company/designation not invented)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Backend extractor & transcript parser
import {
  extractNameFromText,
  extractPhoneFromText,
  extractCompanyFromText,
  extractDesignationFromText,
  analyzeConversationSpeakers,
  extractSpeakerAwareContact
} from '../services/ai/contactExtractionService.js';

import { parseDiarizedTranscriptText } from '../services/transcription/finalTranscriptionService.js';

// Mobile normalization and merge helpers
import {
  normalizeExtractedContact,
  mergeContactData,
  extractPhoneNumber,
  redactPhone
} from '../../MOBILE-APP/src/utils/voiceEntityExtractor.js';

describe('Single-Speaker Contact Detail Capture & Auto-Fill Matrix (Scenarios A - J)', () => {
  const hostUser = {
    id: 'usr_host_1',
    name: 'Vikram Malhotra',
    phone: '9800011111',
    organizationId: 'org_salesbuster',
    organizationName: 'SalesBuster CRM'
  };

  const hostOrg = {
    _id: 'org_salesbuster',
    name: 'SalesBuster CRM'
  };

  // Scenario A: Complete conversation (Name, phone, company, designation, summary)
  test('Scenario A: Complete conversation extracts all fields accurately', async () => {
    const rawTranscript = `Speaker A: Hello, may I know your name?
Speaker B: My name is Rahul Sharma.
Speaker A: Which company are you working for?
Speaker B: I am working at ABC Technologies.
Speaker A: What is your designation?
Speaker B: I am the Business Development Manager.
Speaker A: Can I get your mobile number?
Speaker B: My number is 9876543210.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg
    });

    assert.equal(result.selectedSpeakerId, 'speaker_b');
    assert.equal(result.contact.name.value, 'Rahul Sharma');
    assert.equal(result.contact.phone.value, '9876543210');
    assert.equal(result.contact.company.value, 'ABC Technologies');
    assert.equal(result.contact.designation.value, 'Business Development Manager');
    assert.equal(result.isComplete, true);
    assert.equal(result.requiresManualReview, false);

    // Verify mobile normalizer handles this cleanly
    const normalized = normalizeExtractedContact({
      name: result.contact.name.value,
      phone: result.contact.phone.value,
      company: result.contact.company.value,
      designation: result.contact.designation.value,
      summary: result.summary
    });
    assert.equal(normalized.name.value, 'Rahul Sharma');
    assert.equal(normalized.phone.value, '9876543210');
    assert.equal(normalized.companyName.value, 'ABC Technologies');
    assert.equal(normalized.designation.value, 'Business Development Manager');
  });

  // Scenario B: Missing company (Name and phone populate; company is empty; save proceeds)
  test('Scenario B: Missing company allows save to proceed when Name & Phone are present', async () => {
    const rawTranscript = `Speaker A: Hi there, welcome to our booth. What is your name?
Speaker B: I am Ananya Iyer.
Speaker A: Could you share your phone number so we can stay in touch?
Speaker B: Sure, my number is 9123456780.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg
    });

    assert.equal(result.contact.name.value, 'Ananya Iyer');
    assert.equal(result.contact.phone.value, '9123456780');
    assert.equal(result.contact.company.value, null);
    // Name and phone are valid, company is optional, so no manual review required for minimum save
    assert.equal(result.requiresManualReview, false);

    const normalized = normalizeExtractedContact({
      name: result.contact.name.value,
      phone: result.contact.phone.value,
      company: result.contact.company.value
    });
    assert.equal(normalized.companyName.value, '');

    // In mobile logic:
    const canSave = Boolean(normalized.name.value && normalized.phone.value.length === 10);
    assert.equal(canSave, true);
  });

  // Scenario C: Partial conversation (Name and company first, phone later; prior fields preserved)
  test('Scenario C: Interim partial extraction preserves earlier detected fields as new fields arrive', () => {
    let currentFields = {
      name: { value: '', source: 'empty', confidence: 0, isManuallyEdited: false },
      phone: { value: '', source: 'empty', confidence: 0, isManuallyEdited: false },
      companyName: { value: '', source: 'empty', confidence: 0, isManuallyEdited: false },
      designation: { value: '', source: 'empty', confidence: 0, isManuallyEdited: false },
      summary: { value: '', source: 'empty', confidence: 0, isManuallyEdited: false }
    };

    // Step 1: Name and company arrive in interim 1
    const interim1 = normalizeExtractedContact({
      name: 'Priya Patel',
      companyName: 'Tata Consultancy'
    });
    currentFields = mergeContactData(currentFields, interim1, { source: 'ai_interim' });

    assert.equal(currentFields.name.value, 'Priya Patel');
    assert.equal(currentFields.companyName.value, 'Tata Consultancy');
    assert.equal(currentFields.phone.value, '');

    // Step 2: Phone arrives in interim 2 without company/name
    const interim2 = normalizeExtractedContact({
      phone: '9845012345'
    });
    currentFields = mergeContactData(currentFields, interim2, { source: 'ai_interim' });

    assert.equal(currentFields.name.value, 'Priya Patel', 'Prior name must not be cleared');
    assert.equal(currentFields.companyName.value, 'Tata Consultancy', 'Prior company must not be cleared');
    assert.equal(currentFields.phone.value, '9845012345', 'New phone must be populated');
  });

  // Scenario D: Incorrect interim extraction replaced by higher-confidence final extraction
  test('Scenario D: Higher confidence final extraction corrects interim value', () => {
    let currentFields = {
      name: { value: 'Rahul', source: 'ai_interim', confidence: 0.6, isManuallyEdited: false },
      phone: { value: '9876543210', source: 'ai_interim', confidence: 0.8, isManuallyEdited: false },
      companyName: { value: '', source: 'empty', confidence: 0, isManuallyEdited: false },
      designation: { value: '', source: 'empty', confidence: 0, isManuallyEdited: false },
      summary: { value: '', source: 'empty', confidence: 0, isManuallyEdited: false }
    };

    // Final extraction contains full name "Rahul Sharma" with higher confidence
    const finalExtraction = normalizeExtractedContact({
      name: 'Rahul Sharma',
      phone: '9876543210',
      companyName: 'ABC Corp'
    });
    finalExtraction.name.confidence = 0.95;

    currentFields = mergeContactData(currentFields, finalExtraction, { source: 'ai_final' });

    assert.equal(currentFields.name.value, 'Rahul Sharma');
    assert.equal(currentFields.companyName.value, 'ABC Corp');
    assert.equal(currentFields.name.source, 'ai_final');
  });

  // Scenario E: Manual field editing preserved against subsequent AI updates
  test('Scenario E: Manually edited fields are NEVER overwritten by AI interim or final updates', () => {
    let currentFields = {
      name: { value: 'Custom Edited Name', source: 'manual', confidence: 1.0, isManuallyEdited: true },
      phone: { value: '9876500000', source: 'manual', confidence: 1.0, isManuallyEdited: true },
      companyName: { value: 'Original Corp', source: 'ai_interim', confidence: 0.7, isManuallyEdited: false },
      designation: { value: '', source: 'empty', confidence: 0, isManuallyEdited: false },
      summary: { value: '', source: 'empty', confidence: 0, isManuallyEdited: false }
    };

    // Incoming AI final payload tries to overwrite name, phone, and company
    const incomingFinal = normalizeExtractedContact({
      name: 'AI Detected Name',
      phone: '9999999999',
      companyName: 'Updated AI Corp',
      designation: 'Director'
    });

    currentFields = mergeContactData(currentFields, incomingFinal, { source: 'ai_final' });

    assert.equal(currentFields.name.value, 'Custom Edited Name', 'Manual name must be preserved');
    assert.equal(currentFields.phone.value, '9876500000', 'Manual phone must be preserved');
    assert.equal(currentFields.companyName.value, 'Updated AI Corp', 'Non-manual company can be updated');
    assert.equal(currentFields.designation.value, 'Director', 'New designation should be added');
  });

  // Scenario F: Salesperson vs attendee differentiation (sales rep intro ignored)
  test('Scenario F: Salesperson introduction details are ignored; only attendee details captured', async () => {
    const rawTranscript = `Speaker A: Hi, my name is Vikram Malhotra from SalesBuster CRM and my number is 9800011111.
Speaker B: Nice to meet you Vikram. I am Amit Verma from ZenTech. My phone is 9123498765.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg
    });

    assert.equal(result.selectedSpeakerId, 'speaker_b');
    assert.equal(result.contact.name.value, 'Amit Verma');
    assert.equal(result.contact.company.value, 'ZenTech');
    assert.equal(result.contact.phone.value, '9123498765');
  });

  // Scenario G: Phone number spoken in chunks ("98765 43210" or formatted)
  test('Scenario G: Phone numbers formatted or spoken in chunks are properly normalized to 10 digits', () => {
    const chunkedText = 'You can reach me at 98765 43210';
    const extractedMobile = extractPhoneNumber(chunkedText);
    assert.equal(extractedMobile, '9876543210');

    const hyphenated = 'Call me on +91-98765-43210';
    assert.equal(extractPhoneNumber(hyphenated), '9876543210');

    const backendExtracted = extractPhoneFromText('My mobile is 98765 43210.');
    assert.equal(backendExtracted.value, '9876543210');
  });

  // Scenario H: Canonical alias normalization (customerName, mobileNumber, organization, jobTitle, etc.)
  test('Scenario H: Canonical response aliases normalize correctly to standard schema', () => {
    const weirdPayload = {
      customerName: 'Kavita Sundaram',
      mobileNumber: '+91 98450 11223',
      organization: 'Hindustan Aeronautics Limited',
      jobTitle: 'Principal Avionics Engineer',
      keyDiscussion: 'Discussed next-gen telemetry dashboards and timeline.'
    };

    const normalized = normalizeExtractedContact(weirdPayload);

    assert.equal(normalized.name.value, 'Kavita Sundaram');
    assert.equal(normalized.phone.value, '9845011223');
    assert.equal(normalized.companyName.value, 'Hindustan Aeronautics Limited');
    assert.equal(normalized.designation.value, 'Principal Avionics Engineer');
    assert.equal(normalized.summary.value, 'Discussed next-gen telemetry dashboards and timeline.');
  });

  // Scenario I: Finalization race condition (mergeContactData passes merged object directly to save)
  test('Scenario I: Final contact merge is synchronous and produces immediate save-ready object', () => {
    const currentRef = {
      name: { value: 'Vikram', source: 'ai_interim', confidence: 0.8, isManuallyEdited: false },
      phone: { value: '', source: 'empty', confidence: 0, isManuallyEdited: false },
      companyName: { value: 'Infosys', source: 'ai_interim', confidence: 0.8, isManuallyEdited: false },
      designation: { value: '', source: 'empty', confidence: 0, isManuallyEdited: false },
      summary: { value: '', source: 'empty', confidence: 0, isManuallyEdited: false }
    };

    const finalRawFromSocket = {
      contactName: 'Vikram Seth',
      phoneNumber: '9812345678',
      role: 'Senior Project Manager'
    };

    const normalized = normalizeExtractedContact(finalRawFromSocket);
    const finalMerged = mergeContactData(currentRef, normalized, { source: 'ai_final' });

    // Verify object is synchronously complete and does not rely on async React state setters
    assert.equal(finalMerged.name.value, 'Vikram Seth');
    assert.equal(finalMerged.phone.value, '9812345678');
    assert.equal(finalMerged.companyName.value, 'Infosys');
    assert.equal(finalMerged.designation.value, 'Senior Project Manager');

    // Construct save payload as GuestHomeScreen does
    const savePayload = {
      name: finalMerged.name.value,
      phone: finalMerged.phone.value,
      companyName: finalMerged.companyName.value,
      designation: finalMerged.designation.value
    };

    assert.equal(savePayload.name, 'Vikram Seth');
    assert.equal(savePayload.phone, '9812345678');
    assert.equal(savePayload.companyName, 'Infosys');
    assert.equal(savePayload.designation, 'Senior Project Manager');
  });

  // Scenario J: No hallucination (missing company/designation not invented)
  test('Scenario J: Missing details are NOT hallucinated or inferred from unrelated sentences', async () => {
    const rawTranscript = `Speaker A: Hi! Welcome to the expo.
Speaker B: Thank you, I am Rajesh Kumar. Here is my number: 9988776655.
Speaker A: Great, what brings you here?
Speaker B: Just exploring some interesting tools.`;

    const segments = parseDiarizedTranscriptText(rawTranscript);
    const result = await extractSpeakerAwareContact({
      segments,
      rawTranscript,
      hostUser,
      organization: hostOrg
    });

    assert.equal(result.contact.name.value, 'Rajesh Kumar');
    assert.equal(result.contact.phone.value, '9988776655');
    assert.equal(result.contact.company.value, null, 'Company must be null, not hallucinated from "expo" or "tools"');
    assert.equal(result.contact.designation.value, null, 'Designation must be null');
    assert.equal(result.requiresManualReview, false);
  });

  test('Voice Listener Lifecycle: Save/Send action immediately halts active voice session', async () => {
    let isListening = true;
    let stopCallCount = 0;

    const mockLiveVoice = {
      isConnected: true,
      status: 'listening',
      stopVoiceSession: async () => {
        stopCallCount++;
        isListening = false;
        return true;
      }
    };

    // Replicate stopVoiceListener logic
    const stopVoiceListener = async () => {
      if (isListening || mockLiveVoice.isConnected || mockLiveVoice.status !== 'idle') {
        isListening = false;
        await mockLiveVoice.stopVoiceSession();
      }
    };

    assert.equal(isListening, true);
    await stopVoiceListener();
    assert.equal(isListening, false);
    assert.equal(stopCallCount, 1);
  });

  test('Privacy check: Phone redaction preserves first 2 and last 4 digits only', () => {
    assert.equal(redactPhone('9876543210'), '98****3210');
    assert.equal(redactPhone(''), '***');
    assert.equal(redactPhone(null), '***');
  });
});
