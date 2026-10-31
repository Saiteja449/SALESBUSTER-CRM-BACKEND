import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getQuota,
  interpretPrompt,
  searchProspects,
  importToCrm,
  createContactChannel,
  validateEmail,
  validatePhone,
  normalizeProspectContact,
  sanitizeContactDetails,
  computeProspectKey,
  VERIFIED_BUSINESS_REGISTRY,
} from "../controllers/targetIntelligenceController.js";
import { requireSalesManagerOrOwner } from "../routes/targetIntelligenceRoutes.js";

describe("Target Intelligence - Access & Quota Control", () => {
  it("blocks sales reps with 403 in requireSalesManagerOrOwner", () => {
    let statusCode = null;
    let jsonResponse = null;
    const req = { user: { role: "sales person", isOrgOwner: false } };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };
    const next = () => assert.fail("next() should not be called for sales person");

    requireSalesManagerOrOwner(req, res, next);
    assert.equal(statusCode, 403);
    assert.equal(jsonResponse.success, false);
  });

  it("allows sales managers, org owners, and super admins in requireSalesManagerOrOwner", () => {
    const roles = [
      { role: "sales manager", isOrgOwner: false },
      { role: "sales rep", isOrgOwner: true },
      { role: "super_admin", isOrgOwner: false },
      { role: "super admin", isOrgOwner: false },
    ];

    for (const user of roles) {
      let nextCalled = false;
      const req = { user };
      const res = {};
      const next = () => {
        nextCalled = true;
      };
      requireSalesManagerOrOwner(req, res, next);
      assert.equal(nextCalled, true, `Role ${user.role} should be allowed`);
    }
  });

  it("returns organization search and import quota via getQuota", async () => {
    let statusCode = null;
    let jsonResponse = null;
    const req = {
      organization: {
        targetIntelligenceQuota: {
          searchesLimit: 200,
          searchesUsed: 25,
          leadsImportLimit: 1000,
          leadsImported: 110,
        },
      },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    await getQuota(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.data.searchesLimit, 200);
    assert.equal(jsonResponse.data.searchesUsedThisMonth, 25);
  });

  it("interprets natural language prompts into structured criteria via interpretPrompt", async () => {
    let statusCode = null;
    let jsonResponse = null;
    const req = {
      body: { prompt: "Find manufacturing companies in Hyderabad that may need ERP software" },
      organization: {},
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    await interpretPrompt(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.equal(jsonResponse.data.city, "Hyderabad");
    assert.equal(jsonResponse.data.industry, "Manufacturing");
    assert.ok(jsonResponse.data.need.includes("ERP"));
  });
});

describe("Target Intelligence - Contact Sanitization & Validation", () => {
  it("rejects dummy and placeholder phone numbers", () => {
    assert.equal(validatePhone("0000000000"), null);
    assert.equal(validatePhone("1111111111"), null);
    assert.equal(validatePhone("+91 90000 00000"), null);
    assert.equal(validatePhone("123456"), null); // too short
    assert.equal(validatePhone("123456789012345678"), null); // too long
    assert.equal(validatePhone(""), null);
    assert.equal(validatePhone(null), null);

    // Valid numbers
    assert.equal(validatePhone("+91 40 2712 4321"), "+91 40 2712 4321");
    assert.equal(validatePhone("+91 79978 87788"), "+91 79978 87788");
  });

  it("rejects dummy, sample, and placeholder emails", () => {
    assert.equal(validateEmail("none"), null);
    assert.equal(validateEmail("na"), null);
    assert.equal(validateEmail("test@example.com"), null);
    assert.equal(validateEmail("user@dummy.com"), null);
    assert.equal(validateEmail("john.doe@company.com"), null);
    assert.equal(validateEmail("not-an-email"), null);
    assert.equal(validateEmail(""), null);
    assert.equal(validateEmail(null), null);

    // Valid emails
    assert.equal(validateEmail("contact@petsfolio.com"), "contact@petsfolio.com");
    assert.equal(validateEmail("info@hyd-manufacturing.in"), "info@hyd-manufacturing.in");
  });

  it("constructs ContactChannel with truthful sourceName, status, and timestamp", () => {
    const channelWithVal = createContactChannel({
      value: "+91 40 2345 6789",
      sourceName: "OpenStreetMap",
      sourceUrl: "https://www.openstreetmap.org/node/123",
      verificationStatus: "sourced",
    });
    assert.equal(channelWithVal.value, "+91 40 2345 6789");
    assert.equal(channelWithVal.sourceName, "OpenStreetMap");
    assert.equal(channelWithVal.verificationStatus, "sourced");
    assert.ok(channelWithVal.retrievedAt);

    const channelEmpty = createContactChannel({
      value: null,
      verificationStatus: "not_found",
    });
    assert.equal(channelEmpty.value, null);
    assert.equal(channelEmpty.sourceName, null);
    assert.equal(channelEmpty.verificationStatus, "not_found");

    const channelUnavailable = createContactChannel({
      value: null,
      verificationStatus: "unavailable",
    });
    assert.equal(channelUnavailable.value, null);
    assert.equal(channelUnavailable.verificationStatus, "unavailable");
  });
});

describe("Target Intelligence - Separation of Company and Person Contacts", () => {
  it("never treats company contact details as direct person contacts", () => {
    const rawPerson = {
      entityType: "person",
      personName: "Priya Sharma",
      title: "Chief Operating Officer",
      companyName: "Deccan Pharma Labs",
      companyPhone: "+91 40 2345 6789",
      companyEmail: "office@deccanpharma.com",
      directPhone: "", // No direct personal mobile published
      directEmail: "", // No direct personal email published
      source: "OpenStreetMap",
    };

    const normalized = normalizeProspectContact(rawPerson);

    // Company contact details must be preserved under companyContact
    assert.equal(normalized.companyContact.phone.value, "+91 40 2345 6789");
    assert.equal(normalized.companyContact.email.value, "office@deccanpharma.com");
    assert.equal(normalized.companyContact.phone.verificationStatus, "sourced");

    // Person direct contact MUST NOT be populated with company phone/email!
    assert.equal(normalized.personContact.phone.value, null);
    assert.equal(normalized.personContact.email.value, null);
    assert.equal(normalized.personContact.phone.verificationStatus, "unavailable");
    assert.equal(normalized.personContact.email.verificationStatus, "unavailable");

    // Legacy fields for person must reflect absence of direct contacts, not fake direct line
    assert.equal(normalized.directPhone, "");
    assert.equal(normalized.directEmail, "");
    assert.equal(normalized.phone, "");
    assert.equal(normalized.phoneType, "none");
  });

  it("does not discard valid company contact details merely because person direct contact is missing", () => {
    const rawCompany = {
      entityType: "company",
      companyName: "Telangana Engineering Works",
      phone: "+91 40 2777 8888",
      email: "info@t-engineering.com",
      website: "https://www.t-engineering.com",
      source: "OpenStreetMap",
      sourceUrl: "https://www.openstreetmap.org/way/456",
    };

    const normalized = normalizeProspectContact(rawCompany);

    assert.equal(normalized.companyContact.phone.value, "+91 40 2777 8888");
    assert.equal(normalized.companyContact.email.value, "info@t-engineering.com");
    assert.equal(normalized.companyContact.phone.sourceName, "OpenStreetMap");
    assert.equal(normalized.companyContact.phone.verificationStatus, "sourced");
    assert.equal(normalized.personContact.phone.value, null);
    assert.equal(normalized.personContact.email.value, null);
    assert.equal(normalized.contactAvailability.hasCompanyPhone, true);
    assert.equal(normalized.contactAvailability.hasPersonPhone, false);
    assert.ok(normalized.contactAvailability.personContactReason.includes("enrichment provider"));
  });

  it("labels contacts 'verified' ONLY when backed by authoritative corporate registry", () => {
    const reg = VERIFIED_BUSINESS_REGISTRY.petsfolio;
    assert.ok(reg, "Petsfolio verified registry entry must exist");

    const rawRegistryProspect = {
      entityType: "company",
      companyName: reg.canonicalName,
      source: reg.source,
      sourceUrl: reg.website,
      phone: reg.decisionMaker.phone,
      email: reg.decisionMaker.email,
      decisionMaker: {
        name: reg.decisionMaker.name,
        title: reg.decisionMaker.title,
        phone: reg.decisionMaker.phone,
        email: reg.decisionMaker.email,
      },
    };

    const normalized = normalizeProspectContact(rawRegistryProspect);

    assert.equal(normalized.companyContact.phone.verificationStatus, "verified");
    assert.equal(normalized.companyContact.email.verificationStatus, "verified");
    assert.equal(normalized.personContact.phone.verificationStatus, "verified");
    assert.equal(normalized.personContact.email.verificationStatus, "verified");
    assert.equal(normalized.personContact.name, reg.decisionMaker.name);
  });
});

describe("Target Intelligence - Missing Contact Handling", () => {
  it("keeps valid company results visible even when phone and email are missing", () => {
    const rawNoContacts = {
      entityType: "company",
      companyName: "Cyberabad Robotics Labs",
      industry: "Robotics & Automation",
      city: "Hyderabad",
      location: "Gachibowli, Hyderabad, Telangana",
      website: "https://www.cyberabadrobotics.com",
      phone: "",
      email: "",
      source: "OpenStreetMap",
    };

    const normalized = normalizeProspectContact(rawNoContacts);

    assert.equal(normalized.companyName, "Cyberabad Robotics Labs");
    assert.equal(normalized.companyContact.phone.value, null);
    assert.equal(normalized.companyContact.phone.verificationStatus, "not_found");
    assert.equal(normalized.companyContact.email.value, null);
    assert.equal(normalized.companyContact.email.verificationStatus, "not_found");
    assert.equal(normalized.personContact.phone.value, null);
    assert.equal(normalized.personContact.email.value, null);
    assert.equal(normalized.contactAvailability.hasCompanyPhone, false);
    assert.equal(normalized.contactAvailability.hasCompanyEmail, false);
    assert.ok(normalized.contactAvailability.companyContactReason.includes("Not published"));
  });
});

describe("Target Intelligence - Search Diagnostics & Provider Error Handling", () => {
  it("distinguishes empty search results from provider errors with diagnostics", async () => {
    let statusCode = null;
    let jsonResponse = null;
    const req = {
      body: {
        prompt: "Specialized aerospace manufacturing in Antarctica",
        city: "Antarctica",
        industry: "Aerospace",
      },
      organization: {},
      tenantModels: {
        Lead: { find: () => ({ select: async () => [] }) },
        ResolvedProspect: { find: () => ({ select: async () => [] }) },
      },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    await searchProspects(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.ok(jsonResponse.data.diagnostics, "Diagnostics payload must be returned");
    assert.equal(jsonResponse.data.totalCount, 0);
    assert.equal(jsonResponse.data.diagnostics.status, "EMPTY");
    assert.equal(jsonResponse.data.diagnostics.emptyReason, "NO_MATCHING_BUSINESSES");
    assert.equal(jsonResponse.data.diagnostics.enrichmentProviderConfigured, false);
  });

  it("returns prospects with consistent contact field shape when records match", async () => {
    let statusCode = null;
    let jsonResponse = null;
    const req = {
      body: {
        prompt: "Find Petsfolio pet care in Hyderabad",
        city: "Hyderabad",
        industry: "Pet Care & Veterinary",
      },
      organization: {},
      tenantModels: {
        Lead: { find: () => ({ select: async () => [] }) },
        ResolvedProspect: { find: () => ({ select: async () => [] }) },
      },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    await searchProspects(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.success, true);
    assert.ok(jsonResponse.data.prospects.length > 0);

    const firstProspect = jsonResponse.data.prospects[0];
    assert.ok(firstProspect);
    assert.ok(firstProspect.companyContact);
    assert.ok(firstProspect.companyContact.phone);
    assert.ok(firstProspect.companyContact.email);
    assert.ok(firstProspect.personContact);
    assert.ok(firstProspect.contactAvailability);
    assert.equal(firstProspect.companyContact.phone.verificationStatus, "verified");
    assert.equal(firstProspect.companyContact.phone.sourceName, "Official Corporate Registry");
  });
});

describe("Target Intelligence - CRM Import & Attribution Preservation", () => {
  it("rejects prospect lacking any contact phone without crashing", async () => {
    const mockLeadModel = function (doc) {
      Object.assign(this, doc);
      this.save = async () => this;
    };
    mockLeadModel.findOne = async () => null;

    let statusCode = null;
    let jsonResponse = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    const req = {
      body: {
        prospects: [
          {
            id: "p_no_phone",
            companyName: "Silent Enterprise Without Phone",
            companyContact: {
              phone: { value: null, verificationStatus: "not_found" },
              email: { value: "hello@silent.com", verificationStatus: "sourced" },
            },
            personContact: {
              phone: { value: null, verificationStatus: "not_found" },
              email: { value: null, verificationStatus: "unavailable" },
            },
          },
        ],
        duplicateAction: "skip",
      },
      organization: { _id: "org_1" },
      tenantModels: {
        Lead: mockLeadModel,
        User: { findById: async () => null },
      },
    };

    await importToCrm(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.failedCount, 1);
    assert.ok(jsonResponse.results[0].reason.includes("contact phone number"));
  });

  it("does not overwrite richer existing CRM contact data on update and preserves source attribution", async () => {
    let savedLead = null;
    const existingCrmLead = {
      _id: "lead_rich_1",
      name: "Ravi Teja",
      company: "Deccan Solutions Pvt Ltd",
      phone: "+91 99887 76655", // Existing richer direct phone
      phoneNormalized: "919988776655",
      email: "ravi@deccansolutions.com", // Existing richer email
      status: "Follow Up",
      notes: "Original rep conversation note.",
      tags: ["Existing Client"],
      save: async function () {
        savedLead = this;
        return this;
      },
    };

    const mockLeadModel = function () {};
    mockLeadModel.findOne = async () => existingCrmLead;

    let statusCode = null;
    let jsonResponse = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonResponse = data;
        return this;
      },
    };

    const prospectToImport = {
      id: "p_enrich",
      companyName: "Deccan Solutions Pvt Ltd",
      city: "Hyderabad",
      matchScore: 92,
      source: "OpenStreetMap",
      sourceUrl: "https://www.openstreetmap.org/node/999",
      lastVerifiedAt: "2026-10-31T12:00:00.000Z",
      companyContact: {
        phone: { value: "+91 40 2000 1111", sourceName: "OpenStreetMap", verificationStatus: "sourced" },
        email: { value: "office@deccansolutions.com", sourceName: "OpenStreetMap", verificationStatus: "sourced" },
      },
      personContact: {
        name: null,
        phone: { value: null, verificationStatus: "not_found" },
        email: { value: null, verificationStatus: "not_found" },
      },
    };

    const req = {
      body: {
        prospects: [prospectToImport],
        duplicateAction: "update",
        tags: ["AI Target Intelligence"],
      },
      organization: { _id: "org_1" },
      tenantModels: {
        Lead: mockLeadModel,
        User: { findById: async () => null },
      },
    };

    await importToCrm(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonResponse.updatedCount, 1);

    // Verify existing richer contact data was NOT overwritten
    assert.equal(savedLead.phone, "+91 99887 76655", "Must preserve existing lead phone");
    assert.equal(savedLead.email, "ravi@deccansolutions.com", "Must preserve existing lead email");

    // Verify structured source attribution and provenance in notes and aiQualification
    assert.ok(savedLead.notes.includes("Target Intelligence Enriched"));
    assert.ok(savedLead.notes.includes("OpenStreetMap"));
    assert.ok(savedLead.aiQualification?.targetIntelligence, "aiQualification must store target intelligence attribution");
    assert.equal(savedLead.aiQualification.targetIntelligence.source, "OpenStreetMap");
    assert.equal(savedLead.aiQualification.targetIntelligence.companyContact.phone.value, "+91 40 2000 1111");
  });
});
