import { describe, expect, it } from 'vitest';
import { isSubscriptionExpired } from '../../functions/modules/subscription/main-handler.js';

describe('isSubscriptionExpired helper', () => {
    const now = 1795247583; // 2026-11-21

    it('returns false for subscriptions with future expire timestamp', () => {
        const activeSub = {
            id: 'active',
            userInfo: { expire: now + 86400 },
        };
        expect(isSubscriptionExpired(activeSub, now)).toBe(false);
    });

    it('returns true for subscriptions with past expire timestamp (valid year 2000+)', () => {
        const expiredSub = {
            id: 'expired',
            userInfo: { expire: now - 86400 },
        };
        expect(isSubscriptionExpired(expiredSub, now)).toBe(true);
    });

    it('returns false when expire is 0 (unlimited) or missing or ancient mock number (< year 2000)', () => {
        expect(isSubscriptionExpired({ id: 'unlimited', userInfo: { expire: 0 } }, now)).toBe(false);
        expect(isSubscriptionExpired({ id: 'mock-number', userInfo: { expire: 2000 } }, now)).toBe(false);
        expect(isSubscriptionExpired({ id: 'no-userinfo' }, now)).toBe(false);
        expect(isSubscriptionExpired(null, now)).toBe(false);
    });

    it('honors expiresAt field if present', () => {
        const expiredByField = {
            id: 'field-expired',
            expiresAt: (now - 3600) * 1000, // ms
        };
        expect(isSubscriptionExpired(expiredByField, now)).toBe(true);

        const futureByField = {
            id: 'field-future',
            expiresAt: (now + 3600) * 1000,
        };
        expect(isSubscriptionExpired(futureByField, now)).toBe(false);
    });
});
