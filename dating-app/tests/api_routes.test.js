import { describe, it, expect } from 'vitest';
import request from 'supertest';
const { app } = require('../server.js');

describe('Delulu API Routes & Security Tests', () => {
  it('GET /api/users/me should return 401 when not logged in', async () => {
    const res = await request(app).get('/api/users/me');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('POST /api/auth/send-verification-email should reject invalid email domains', async () => {
    const res = await request(app)
      .post('/api/auth/send-verification-email')
      .send({ email: 'not-a-valid-email' });
    
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('POST /api/connections/request should require authentication', async () => {
    const res = await request(app)
      .post('/api/connections/request')
      .send({ target_user_id: 2 });
    
    expect(res.status).toBe(401);
  });

  it('POST /api/users/report should validate report details and require auth', async () => {
    const res = await request(app)
      .post('/api/users/report')
      .send({ reason: '' });
    
    expect(res.status).toBe(401); // Requires auth first
  });

  it('POST /api/messages/send should block unauthorized unauthenticated sends', async () => {
    const res = await request(app)
      .post('/api/messages/send')
      .send({ connection_id: 1, content: 'test message' });
    
    expect(res.status).toBe(401);
  });
});
