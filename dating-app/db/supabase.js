/**
 * db/supabase.js
 * Server-side only Supabase client.
 * Uses the SERVICE_ROLE_KEY — NEVER the anon key.
 * Never import this file in any client-side (public/) code.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getSupabase() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment variables.'
    );
  }

  _client = createClient(url, key, {
    auth: {
      // Service role clients must not auto-refresh or persist sessions
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  });

  return _client;
}

module.exports = { getSupabase };
