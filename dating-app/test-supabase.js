/**
 * test-supabase.js — standalone connectivity test, not part of the app.
 * Run: node test-supabase.js
 * Delete the test row from Supabase Table Editor afterwards.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function test() {
  console.log('→ Supabase URL:', process.env.SUPABASE_URL);

  // 1. INSERT a test row (only the columns confirmed to exist in the schema)
  const { data: inserted, error: insertErr } = await supabase
    .from('messages')
    .insert({
      connection_id: -1,           // sentinel value — easy to delete
      sender_id:     -1,
      content:       'Hello from test-supabase.js'
    })
    .select()
    .single();

  if (insertErr) {
    console.error('❌ INSERT failed:', insertErr.message, insertErr.details || '');
    process.exit(1);
  }
  console.log('✅ INSERT succeeded — row id:', inserted.id, '| created_at:', inserted.created_at);

  // 2. SELECT it back (verifies RLS + index)
  const { data: fetched, error: fetchErr } = await supabase
    .from('messages')
    .select('id, connection_id, content, created_at')
    .eq('id', inserted.id)
    .single();

  if (fetchErr) {
    console.error('❌ SELECT failed:', fetchErr.message);
  } else {
    console.log('✅ SELECT succeeded — content:', fetched.content);
  }

  // 3. Tombstone it so the table stays clean
  const { error: deleteErr } = await supabase
    .from('messages')
    .update({ deleted_at: new Date().toISOString(), content: '' })
    .eq('id', inserted.id);

  if (deleteErr) {
    console.warn('⚠️  Could not tombstone test row (id', inserted.id, '):', deleteErr.message);
    console.warn('   Delete it manually from Supabase Table Editor.');
  } else {
    console.log('✅ Test row tombstoned (id', inserted.id, ')');
  }
}

test().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
