import { describe, it, expect } from 'vitest';
const { connectionOps, blockOps } = require('../database.js');

describe('Connection Invariants and Edge Case Guard Tests', () => {
  it('connectionOps.isActive returns false for non-active or ended statuses', () => {
    expect(connectionOps.isActive({ status: 'pending' })).toBe(false);
    expect(connectionOps.isActive({ status: 'rejected' })).toBe(false);
    expect(connectionOps.isActive({ status: 'expired' })).toBe(false);
    expect(connectionOps.isActive({ status: 'ended' })).toBe(false);
    expect(connectionOps.isActive(null)).toBe(false);

    expect(connectionOps.isActive({ status: 'accepted' })).toBe(true);
    expect(connectionOps.isActive({ status: 'revealed' })).toBe(true);
  });
});
