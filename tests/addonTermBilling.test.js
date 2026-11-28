import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateAddonQuote, resolveAuthoritativePrice } from '../controllers/cashfreeController.js';
import { isAddonActive } from '../services/addonEntitlementService.js';

test('mid-cycle add-on uses remaining days and adds GST once', () => {
  const addon = { id: 'whatsapp_campaigns', price: 1000, isActive: true };
  const item = calculateAddonQuote({ addon, term: 'quarterly', startsAt: new Date('2026-02-15T00:00:00Z'), planStart: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-04-01T00:00:00Z'), prorate: true });
  assert.equal(item.daysCovered, 45);
  assert.equal(item.totalTermDays, 90);
  assert.equal(item.baseAmount, 1500);
  const price = resolveAuthoritativePrice({ purpose: 'addon', addonType: 'whatsapp_campaigns', addonItems: [item], dynamicAddons: [addon] });
  assert.equal(price.gstAmount, 270);
  assert.equal(price.amount, 1770);
});

test('499/month add-on on 92-day quarterly plan with 65 days remaining prorates to 1057.66 before GST', () => {
  const addon = { id: 'bi_analyst', price: 499, isActive: true };
  const item = calculateAddonQuote({
    addon,
    term: 'quarterly',
    durationMonths: 3,
    planStart: new Date('2026-01-01T00:00:00Z'),
    startsAt: new Date('2026-01-28T10:15:30Z'),
    expiresAt: new Date('2026-04-03T00:00:00Z'),
    prorate: true,
  });
  assert.equal(item.totalTermDays, 92);
  assert.equal(item.daysCovered, 65);
  assert.equal(item.baseAmount, 1057.66);

  const price = resolveAuthoritativePrice({
    purpose: 'addon',
    addonType: 'bi_analyst',
    addonItems: [item],
    dynamicAddons: [addon],
    dynamicGstRate: 18,
  });
  assert.equal(price.baseAmount, 1057.66);
  assert.equal(price.gstAmount, 190.38);
  assert.equal(price.amount, 1248.04);
});

test('proration and remaining-day count are identical across different times on the same calendar date', () => {
  const addon = { id: 'bi_analyst', price: 499, isActive: true };
  const planStart = new Date('2026-01-01T14:20:00Z');
  const expiresAt = new Date('2026-04-03T08:45:00Z');
  const purchaseTimestamps = [
    new Date('2026-01-28T00:00:00.000Z'),
    new Date('2026-01-28T09:15:30.500Z'),
    new Date('2026-01-28T23:59:59.999Z'),
  ];

  for (const startsAt of purchaseTimestamps) {
    const quote = calculateAddonQuote({
      addon,
      term: 'quarterly',
      durationMonths: 3,
      planStart,
      startsAt,
      expiresAt,
      prorate: true,
    });
    assert.equal(quote.totalTermDays, 92);
    assert.equal(quote.daysCovered, 65);
    assert.equal(quote.baseAmount, 1057.66);
  }
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
