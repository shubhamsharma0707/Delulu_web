import { describe, it, expect } from 'vitest';
const { getEcosystem } = require('../database.js');

describe('College Ecosystem Domain Mapping', () => {
  it('maps vitbhopal.ac.in and vitbhopal.edu.in to vitbhopal ecosystem', () => {
    expect(getEcosystem('student@vitbhopal.ac.in')).toBe('vitbhopal');
    expect(getEcosystem('lakshit.24bce11263@vitbhopal.ac.in')).toBe('vitbhopal');
  });

  it('maps rishihood domain to rishihood ecosystem', () => {
    expect(getEcosystem('student@rishihood.edu.in')).toBe('rishihood');
  });

  it('defaults to rishihood for unmapped or empty domains', () => {
    expect(getEcosystem('')).toBe('rishihood');
    expect(getEcosystem(null)).toBe('rishihood');
  });
});
