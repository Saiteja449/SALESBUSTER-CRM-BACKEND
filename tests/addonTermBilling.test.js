import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateAddonQuote, resolveAuthoritativePrice } from '../controllers/cashfreeController.js';
import { isAddonActive } from '../services/addonEntitlementService.js';

test('mid-cycle add-on uses remaining days and adds GST once', () => {
  const item = calculateAddonQuote({ addon: { quarterlyPrice: 3000 }, term: 'quarterly', startsAt: new Date('2026-02-15T00:00:00Z'), planStart: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-04-01T00:00:00Z'), prorate: true });
  assert.equal(item.daysCovered, 45);
  assert.equal(item.totalTermDays, 90);
  assert.equal(item.baseAmount, 1500);
  const price = resolveAuthoritativePrice({ purpose: 'addon', addonType: 'whatsapp_campaigns', addonItems: [item] });
  assert.equal(price.gstAmount, 270);
  assert.equal(price.amount, 1770);
});

test('dated access expires while legacy grants stay active', () => {
  const now = new Date('2026-03-01T00:00:00Z');
  const org = { addons: { biAnalyst: true } };
  assert.equal(isAddonActive(org, 'biAnalyst', now), true);
  org.addonEntitlements = [{ addonId: 'bi_analyst', expiresAt: '2026-02-28' }];
  assert.equal(isAddonActive(org, 'biAnalyst', now), false);
  org.addonEntitlements = [{ addonId: 'bi_analyst', startsAt: '2026-04-01', expiresAt: '2026-07-01' }];
  assert.equal(isAddonActive(org, 'biAnalyst', now), false);
});
