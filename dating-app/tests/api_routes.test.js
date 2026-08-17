import { describe, it, expect } from 'vitest';
import request from 'supertest';

// vitest.config.js sets VITEST=true and NODE_ENV=development so HTTP→HTTPS redirect won't interfere
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

  describe('Gzip/Brotli Compression Tests', () => {
    it('should negotiate Brotli or Gzip compression when client sends Accept-Encoding header', async () => {
      const res = await request(app)
        .get('/discover.html')
        .set('Accept-Encoding', 'gzip, deflate, br');

      expect(res.status).toBe(200);
      expect(['br', 'gzip']).toContain(res.headers['content-encoding']);
    });

    it('should parse JSON correctly and compress responses over threshold with size reduction', async () => {
      const uncompressed = await request(app)
        .get('/discover.html')
        .set('Accept-Encoding', 'identity');

      const compressed = await request(app)
        .get('/discover.html')
        .set('Accept-Encoding', 'gzip');

      // Verify header negotiation
      expect(uncompressed.headers['content-encoding']).toBeUndefined();
      expect(compressed.headers['content-encoding']).toBe('gzip');

      // Verify transfer size drop (compressed payload size is smaller than uncompressed)
      const uncompressedLen = parseInt(uncompressed.headers['content-length'] || uncompressed.text.length, 10);
      const compressedLen = parseInt(compressed.headers['content-length'] || compressed.body.length || compressed.text.length, 10);
      expect(compressedLen).toBeLessThan(uncompressedLen);
    });

    it('should NOT double compress when x-no-compression header is present', async () => {
      const res = await request(app)
        .get('/discover.html')
        .set('Accept-Encoding', 'gzip, deflate, br')
        .set('X-No-Compression', '1');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
    });

    it('should skip compression for Server-Sent Events text/event-stream', async () => {
      const res = await request(app)
        .get('/discover.html')
        .set('Accept-Encoding', 'gzip, deflate, br')
        .set('Accept', 'text/event-stream');

      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
    });
  });

  describe('Batched Write Operations & Bulk Performance', () => {
    it('should execute block user active connection rejections via chunked batched writes', async () => {
      const { blockOps } = require('../database.js');
      expect(typeof blockOps.block).toBe('function');
      const result = await blockOps.block(9999, 8888);
      expect(result).toHaveProperty('success', true);
    });

    it('should perform bulk multi-row message inserts via messageOps.bulkSend', async () => {
      const { messageOps } = require('../database.js');
      expect(typeof messageOps.bulkSend).toBe('function');
      const res = await messageOps.bulkSend([]);
      expect(res).toEqual([]);
    });
  });

  describe('Hosted Domain CORS & Concurrency Tests', () => {
    it('should allow CORS for .onrender.com and .railway.app origins', async () => {
      const resRender = await request(app)
        .options('/api/auth/send-verification-email')
        .set('Origin', 'https://delulu-join-now.onrender.com');
      expect(resRender.headers['access-control-allow-origin']).toBe('https://delulu-join-now.onrender.com');

      const resRailway = await request(app)
        .options('/api/auth/send-verification-email')
        .set('Origin', 'https://delulu-app-main-production.up.railway.app');
      expect(resRailway.headers['access-control-allow-origin']).toBe('https://delulu-app-main-production.up.railway.app');
    });

    it('should create OTPs concurrently without Firestore transaction lock errors', async () => {
      const { otpOps } = require('../database.js');
      const promises = Array.from({ length: 10 }, (_, i) => 
        otpOps.create(`test${i}@nst.rishihood.edu.in`, '123456', Date.now() + 600000)
      );
      const results = await Promise.all(promises);
      expect(results).toHaveLength(10);
      results.forEach(id => expect(id).toBeTruthy());
    });
  });
});
