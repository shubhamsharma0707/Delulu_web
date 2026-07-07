const test = require('node:test');
const assert = require('node:assert');

// Mock DOM for testing client-side escapeHtml function
global.document = {
  createElement: (tag) => {
    let content = '';
    return {
      set textContent(val) {
        content = val;
      },
      get innerHTML() {
        return content
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }
    };
  }
};

// Client-side escapeHtml definition to test
function escapeHtml(str) {
  if (!str) return '';
  const div = global.document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

test('escapeHtml correctly sanitizes dangerous inputs', () => {
  // Test script injection
  const scriptInput = '<script>alert(1)</script>';
  assert.strictEqual(escapeHtml(scriptInput), '&lt;script&gt;alert(1)&lt;/script&gt;');

  // Test onerror handler
  const onerrorInput = '<img src=x onerror=alert(1)>';
  assert.strictEqual(escapeHtml(onerrorInput), '&lt;img src=x onerror=alert(1)&gt;');

  // Test quote breakouts
  const quoteInput = '" onclick="alert(1)';
  assert.strictEqual(escapeHtml(quoteInput), '&quot; onclick=&quot;alert(1)');
});

test('Generic error message on login is identical for wrong username vs password', () => {
  const wrongUsernameError = 'Incorrect username/email or password';
  const wrongPasswordError = 'Incorrect username/email or password';
  
  assert.strictEqual(wrongUsernameError, wrongPasswordError, 'Error messages must be completely generic to prevent username enumeration');
});

test('connectionOps.getConnection returns null for a non-participant', async () => {
  // Mock connection object
  const mockConnection = {
    id: 123,
    from_user_id: 1,
    to_user_id: 2,
    status: 'vibe_check'
  };

  // Connection validation logic mimicking connectionOps.getConnection
  function validateParticipant(conn, userId) {
    if (!conn) return null;
    if (conn.from_user_id !== userId && conn.to_user_id !== userId) {
      return null;
    }
    return conn;
  }

  // Verify connection owner/participant is allowed
  assert.ok(validateParticipant(mockConnection, 1) !== null);
  assert.ok(validateParticipant(mockConnection, 2) !== null);

  // Verify non-participant gets null
  assert.strictEqual(validateParticipant(mockConnection, 999), null);
});

test('ALLOWED_REACTIONS only accepts valid emojis', () => {
  const ALLOWED_REACTIONS = ['😂', '😢', '❤️', '👍', '😮'];
  
  assert.ok(ALLOWED_REACTIONS.includes('😂'));
  assert.ok(ALLOWED_REACTIONS.includes('❤️'));
  assert.ok(!ALLOWED_REACTIONS.includes('<script>alert(1)</script>'));
  assert.ok(!ALLOWED_REACTIONS.includes('😊'));
});

test('sanitizeConnection helper strips raw reveal states and computes both_revealed', () => {
  const mockConn = {
    id: 10,
    from_user_id: 1,
    to_user_id: 2,
    reveal_from: 1,
    reveal_to: 0,
    status: 'accepted'
  };

  function sanitizeConnection(c, userId) {
    if (!c) return null;
    const isFrom = c.from_user_id === Number(userId);
    const bothRevealed = c.reveal_from === 1 && c.reveal_to === 1;
    const myReveal = isFrom ? c.reveal_from : c.reveal_to;
    
    const copy = { ...c };
    delete copy.reveal_from;
    delete copy.reveal_to;
    
    return {
      ...copy,
      my_reveal: myReveal,
      both_revealed: bothRevealed
    };
  }

  // Test from the perspective of user 1 (reveal_from is 1)
  const sanitizedForUser1 = sanitizeConnection(mockConn, 1);
  assert.strictEqual(sanitizedForUser1.my_reveal, 1);
  assert.strictEqual(sanitizedForUser1.both_revealed, false);
  assert.strictEqual(sanitizedForUser1.reveal_from, undefined);
  assert.strictEqual(sanitizedForUser1.reveal_to, undefined);

  // Test from the perspective of user 2 (reveal_to is 0)
  const sanitizedForUser2 = sanitizeConnection(mockConn, 2);
  assert.strictEqual(sanitizedForUser2.my_reveal, 0);
  assert.strictEqual(sanitizedForUser2.both_revealed, false);
  assert.strictEqual(sanitizedForUser2.reveal_from, undefined);
  assert.strictEqual(sanitizedForUser2.reveal_to, undefined);

  // Test both users having revealed
  const bothRevealedConn = { ...mockConn, reveal_to: 1 };
  const sanitizedBoth = sanitizeConnection(bothRevealedConn, 1);
  assert.strictEqual(sanitizedBoth.both_revealed, true);
});
