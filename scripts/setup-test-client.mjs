#!/usr/bin/env node

/**
 * Setup script for Saurabh Test client exception
 * 
 * Usage: node scripts/setup-test-client.mjs
 * 
 * This script:
 * 1. Ensures the exempt_from_freemium column exists in clients table
 * 2. Creates/updates the Saurabh Test client with exemption enabled
 * 3. Provides instructions for associating test users
 */

import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client with service role key for admin operations
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing VITE_SUPABASE_URL or service role key environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function setupTestClient() {
  try {
    console.log('🚀 Setting up Saurabh Test client exception...\n');

    // Step 1: Create or update the client record
    console.log('1️⃣  Creating/updating Saurabh Test client...');
    
    const { data: clientData, error: clientError } = await supabase
      .from('clients')
      .upsert(
        {
          name: 'Saurabh Test',
          domain: 'sjtest.com',
          status: 'active',
          exempt_from_freemium: true
        },
        { onConflict: 'domain' }
      )
      .select();

    if (clientError) {
      console.error('❌ Error creating client:', clientError);
      process.exit(1);
    }

    const client = clientData?.[0];
    console.log(`✅ Client created/updated successfully!`);
    console.log(`   ID: ${client.id}`);
    console.log(`   Name: ${client.name}`);
    console.log(`   Domain: ${client.domain}`);
    console.log(`   Exempt from Freemium: ${client.exempt_from_freemium}\n`);

    // Step 2: Provide instructions for user association
    console.log('2️⃣  Associate test users with this client:');
    console.log(`
    To associate a specific user with the test client, run this SQL in the Supabase dashboard:

    UPDATE public.profiles 
    SET client_id = '${client.id}'
    WHERE id = 'USER_ID_HERE';

    Or associate by email pattern:

    UPDATE public.profiles 
    SET client_id = '${client.id}'
    WHERE email LIKE '%@sjtest.com' OR email LIKE '%test%';
    `);

    // Step 3: Verification
    console.log('3️⃣  Verifying setup...');
    
    const { data: verifyData, error: verifyError } = await supabase
      .from('clients')
      .select('*')
      .eq('domain', 'sjtest.com')
      .single();

    if (verifyError) {
      console.error('❌ Verification failed:', verifyError);
      process.exit(1);
    }

    console.log('✅ Verification successful!');
    console.log(`   Client will be treated as exempt from freemium limits`);
    console.log(`   All users associated with this client can create unlimited reports\n`);

    console.log('🎉 Setup complete! The Saurabh Test client is now configured.');
    console.log('\n📝 NEXT STEPS:');
    console.log('   1. Update user profiles to associate them with sjtest.com domain');
    console.log('   2. They will now have unlimited report creation without is_premium');
    console.log('   3. They can view all reports created by their client');

  } catch (err) {
    console.error('❌ Unexpected error:', err);
    process.exit(1);
  }
}

// Run the setup
setupTestClient();
