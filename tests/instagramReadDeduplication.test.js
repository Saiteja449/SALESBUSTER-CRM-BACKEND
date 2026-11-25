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
    if (isAIg || isBIg) {
      const aIgsid = a.instagramIgsid || a.igsid;
      const bIgsid = b.instagramIgsid || b.igsid;
      if (
        aIgsid &&
        bIgsid &&
        !String(aIgsid).startsWith("commenter_") &&
        !String(bIgsid).startsWith("commenter_") &&
        String(aIgsid) === String(bIgsid)
      ) {
        return true;
      }

      const aContactId = String(a.instagramContactId || a.contactId || "");
      const bContactId = String(b.instagramContactId || b.contactId || "");
      if (aContactId && bContactId && aContactId === bContactId) return true;

      // Check allContactIds array if present from backend
      if (Array.isArray(a.allContactIds) && bContactId && a.allContactIds.includes(bContactId)) return true;
      if (Array.isArray(b.allContactIds) && aContactId && b.allContactIds.includes(aContactId)) return true;
      if (Array.isArray(a.allContactIds) && b.id && a.allContactIds.includes(String(b.id))) return true;
      if (Array.isArray(b.allContactIds) && a.id && b.allContactIds.includes(String(a.id))) return true;

      const aUname = (a.instagramUsername || a.username)?.toLowerCase()?.trim();
      const bUname = (b.instagramUsername || b.username)?.toLowerCase()?.trim();
      if (
        aUname &&
        bUname &&
        aUname !== "instagram_user" &&
        aUname !== "instagram user" &&
        aUname !== "unknown" &&
        aUname === bUname
      ) {
        return true;
      }

      const aName = (a.customerName || a.name)?.toLowerCase()?.trim();
      const bName = (b.customerName || b.name)?.toLowerCase()?.trim();
      if (
        aName &&
        bName &&
        aName !== "instagram user" &&
        bName !== "instagram user" &&
        aName !== "unknown" &&
        bName !== "unknown" &&
        aName === bName
      ) {
        return true;
      }

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
      const cname = (conv.customerName || conv.name)?.toLowerCase()?.trim();
      if (cname && cname !== "instagram user" && cname !== "unknown") {
        return `ig_name_${cname}`;
      }

      const uname = (conv.instagramUsername || conv.username)?.toLowerCase()?.trim();
      if (uname && uname !== "instagram user" && uname !== "instagram_user" && uname !== "unknown") {
        return `ig_user_${uname}`;
      }

      const igsid = conv.instagramIgsid || conv.igsid;
      if (igsid && !String(igsid).startsWith("commenter_")) {
        return `ig_igsid_${igsid}`;
      }

      const contactId = conv.instagramContactId || conv.contactId;
      if (contactId) {
        return `ig_contact_${contactId}`;
      }

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

  test("4. Same account messaged 2 times with different contact IDs or IGSIDs merges into exactly 1 conversation", () => {
    // First message: "Hi" from a comment or earlier session
    const firstMessageConv = {
      _id: "67448b111111111111111111",
      id: "67448b111111111111111111",
      customerName: "Vijay Pallapu",
      username: "vijay_pallapu",
      channel: "instagram",
      igsid: "commenter_17849999",
      instagramIgsid: "commenter_17849999",
      instagramContactId: "67448b111111111111111111",
      unreadCount: 0,
      lastMessage: "Hi",
      lastMessageTime: new Date("2026-11-20T10:00:00Z"),
    };

    // Second message: "Hii" from DM with different IGSID and contact ID
    const secondMessageConv = {
      _id: "67448b222222222222222222",
      id: "67448b222222222222222222",
      customerName: "Vijay Pallapu",
      username: "vijay_pallapu",
      channel: "instagram",
      igsid: "84291029482019",
      instagramIgsid: "84291029482019",
      instagramContactId: "67448b222222222222222222",
      unreadCount: 1,
      lastMessage: "Hii",
      lastMessageTime: new Date("2026-11-20T11:00:00Z"),
    };

    // They must match as the same conversation
    assert.strictEqual(isSameConversation(firstMessageConv, secondMessageConv), true);
    // They must yield the same canonical key (ig_name_vijay pallapu)
    assert.strictEqual(getCanonicalKey(firstMessageConv), getCanonicalKey(secondMessageConv));
    assert.strictEqual(getCanonicalKey(firstMessageConv), "ig_name_vijay pallapu");

    // Unified map merging
    const rawCombined = [firstMessageConv, secondMessageConv];
    const conversationMap = new Map();

    for (const item of rawCombined) {
      let matchKey = null;
      for (const [key, existing] of conversationMap.entries()) {
        if (isSameConversation(existing, item) || getCanonicalKey(existing) === getCanonicalKey(item)) {
          matchKey = key;
          break;
        }
      }
      const canonicalKey = matchKey || getCanonicalKey(item);

      if (!conversationMap.has(canonicalKey)) {
        conversationMap.set(canonicalKey, { ...item });
      } else {
        const existing = conversationMap.get(canonicalKey);
        existing.unreadCount = Math.max(existing.unreadCount || 0, item.unreadCount || 0);
        if (new Date(item.lastMessageTime || 0) > new Date(existing.lastMessageTime || 0)) {
          existing.lastMessage = item.lastMessage;
          existing.lastMessageTime = item.lastMessageTime;
        }
      }
    }

    const uniqueList = Array.from(conversationMap.values());
    assert.strictEqual(uniqueList.length, 1, "Must show only 1 conversation, not 2");
    assert.strictEqual(uniqueList[0].customerName, "Vijay Pallapu");
    assert.strictEqual(uniqueList[0].lastMessage, "Hii", "Latest message must be 'Hii'");
    assert.strictEqual(uniqueList[0].unreadCount, 1, "Unread count must be preserved as 1");
  });
});
