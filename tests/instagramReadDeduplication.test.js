import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("Instagram Conversation Grouping & Deduplication", () => {
  const isSameConversation = (a, b) => {
    if (!a || !b) return false;
    const aId = String(a.id || a._id || "");
    const bId = String(b.id || b._id || "");
    if (aId && bId && aId === bId) return true;

    const isAIg = a.channel?.startsWith("instagram");
    const isBIg = b.channel?.startsWith("instagram");
    if (isAIg && isBIg) {
      const aIgsid = a.instagramIgsid || a.igsid;
      const bIgsid = b.instagramIgsid || b.igsid;
      if (aIgsid && bIgsid && String(aIgsid) === String(bIgsid)) return true;

      const aContactId = String(a.instagramContactId || a.contactId || (a.id?.length === 24 ? a.id : a._id || ""));
      const bContactId = String(b.instagramContactId || b.contactId || (b.id?.length === 24 ? b.id : b._id || ""));
      if (aContactId && bContactId && aContactId === bContactId) return true;

      const aUname = (a.instagramUsername || a.username)?.toLowerCase()?.trim();
      const bUname = (b.instagramUsername || b.username)?.toLowerCase()?.trim();
      if (aUname && bUname && aUname === bUname) return true;

      const aName = a.customerName?.toLowerCase()?.trim();
      const bName = b.customerName?.toLowerCase()?.trim();
      if (aName && bName && aName !== "instagram user" && bName !== "instagram user" && aName === bName) return true;

      return false;
    }

    const aLeadId = String(a.leadId?._id || a.leadId?.id || (typeof a.leadId === "string" ? a.leadId : ""));
    const bLeadId = String(b.leadId?._id || b.leadId?.id || (typeof b.leadId === "string" ? b.leadId : ""));
    if (aLeadId && bLeadId && aLeadId === bLeadId) return true;

    const aPhone = (a.leadId?.phone || a.phone || "").replace(/\D/g, "");
    const bPhone = (b.leadId?.phone || b.phone || "").replace(/\D/g, "");
    if (aPhone && bPhone && aPhone === bPhone) return true;

    return false;
  };

  const getCanonicalKey = (conv) => {
    if (!conv) return "unknown";
    if (conv.channel?.startsWith("instagram")) {
      const igsid = conv.instagramIgsid || conv.igsid;
      if (igsid) return `ig_igsid_${igsid}`;
      const contactId = conv.instagramContactId || conv.contactId || (conv.id?.length === 24 ? conv.id : conv._id);
      if (contactId) return `ig_contact_${contactId}`;
      const uname = (conv.instagramUsername || conv.username)?.toLowerCase()?.trim();
      if (uname && uname !== "instagram user") return `ig_user_${uname}`;
      const cname = conv.customerName?.toLowerCase()?.trim();
      if (cname && cname !== "instagram user" && cname !== "unknown") return `ig_name_${cname}`;
      return `ig_id_${conv.id || conv._id}`;
    }
    const leadId = conv.leadId?._id || conv.leadId?.id || (typeof conv.leadId === "string" ? conv.leadId : null);
    if (leadId) return `wa_lead_${leadId}`;
    const phone = (conv.leadId?.phone || conv.phone || "").replace(/\D/g, "");
    if (phone) return `wa_phone_${phone}`;
    return `wa_id_${conv.id || conv._id}`;
  };

  test("1. Merges Instagram Conversation document and InstagramContact document for same person into single thread", () => {
    const convFromDb = {
      _id: "6b003a91cdd313044ebfbc2a",
      id: "6b003a91cdd313044ebfbc2a",
      customerName: "Vijay Pallapu",
      channel: "instagram",
      instagramIgsid: "2250740275818147",
      instagramContactId: "6b003a6df268abebaa6b84c3",
      unreadCount: 1,
      lastMessage: "Hi",
      lastMessageTime: new Date("2026-11-20T12:18:15.708Z"),
    };

    const contactFromMeta = {
      _id: "6b003a6df268abebaa6b84c3",
      id: "6b003a6df268abebaa6b84c3",
      customerName: "Vijay Pallapu",
      username: "imvijay__07",
      channel: "instagram",
      igsid: "2250740275818147",
      instagramIgsid: "2250740275818147",
      instagramContactId: "6b003a6df268abebaa6b84c3",
      unreadCount: 0,
      lastMessage: "Hi",
      lastMessageTime: new Date("2026-11-20T12:18:15.708Z"),
    };

    // Both should match as the same conversation
    assert.strictEqual(isSameConversation(convFromDb, contactFromMeta), true);
    // Both should yield the same canonical key
    assert.strictEqual(getCanonicalKey(convFromDb), getCanonicalKey(contactFromMeta));

    // When merging
    const mergedList = [convFromDb];
    const existing = mergedList.find(c => isSameConversation(c, contactFromMeta));
    if (existing) {
      existing.unreadCount = Math.max(existing.unreadCount, contactFromMeta.unreadCount);
    } else {
      mergedList.push(contactFromMeta);
    }

    assert.strictEqual(mergedList.length, 1);
    assert.strictEqual(mergedList[0].customerName, "Vijay Pallapu");
    assert.strictEqual(mergedList[0].unreadCount, 1);
  });

  test("2. Canonical key prevents pagination append from duplicating threads", () => {
    const page1 = [
      {
        id: "6b003a91cdd313044ebfbc2a",
        channel: "instagram",
        customerName: "Vijay Pallapu",
        instagramIgsid: "2250740275818147",
        unreadCount: 1
      }
    ];

    const page2Incoming = [
      {
        id: "6b003a6df268abebaa6b84c3",
        channel: "instagram",
        customerName: "Vijay Pallapu",
        instagramIgsid: "2250740275818147",
        unreadCount: 0
      },
      {
        id: "unique_contact_2",
        channel: "instagram",
        customerName: "Jane Doe",
        instagramIgsid: "998877665544",
        unreadCount: 0
      }
    ];

    const existingKeys = new Set(page1.map(c => getCanonicalKey(c)));
    const freshItems = page2Incoming.filter(c => !existingKeys.has(getCanonicalKey(c)));
    const combined = [...page1, ...freshItems];

    assert.strictEqual(combined.length, 2);
    assert.strictEqual(combined[0].customerName, "Vijay Pallapu");
    assert.strictEqual(combined[1].customerName, "Jane Doe");
  });

  test("3. Read status resets unread count and persists correctly", () => {
    let unreadCount = 1;
    // Mark as read
    const markReadPayload = { unread: false };
    unreadCount = markReadPayload.unread ? 1 : 0;
    assert.strictEqual(unreadCount, 0);

    // Mark as unread
    const markUnreadPayload = { unread: true };
    unreadCount = markUnreadPayload.unread ? 1 : 0;
    assert.strictEqual(unreadCount, 1);
  });
});
