const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleId = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleId) {
  console.error("Please ensure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleId, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// The hardcoded UUIDs matching supabase_setup.sql seeding.
const ORG_A_ID = '11111111-1111-1111-1111-111111111111'; // Global Corp
const ORG_B_ID = '22222222-2222-2222-2222-222222222222'; // Startup Inc

const seedUsers = async () => {
  console.log('Seeding Database with Isolated Users...');

  const users = [
    // Global Corp Users
    { email: 'admin@globalcorp.local', pass: 'password123', name: 'Alice Admin', org: ORG_A_ID, role: 'admin' },
    { email: 'employee@globalcorp.local', pass: 'password123', name: 'Bob Employee', org: ORG_A_ID, role: 'employee' },
    // Startup Inc Users
    { email: 'admin@startupinc.local', pass: 'password123', name: 'Charlie CEO', org: ORG_B_ID, role: 'admin' },
    { email: 'employee@startupinc.local', pass: 'password123', name: 'Dave Developer', org: ORG_B_ID, role: 'employee' }
  ];

  for (const u of users) {
    console.log(`Setting up ${u.email}...`);
    
    // 1. Create Auth User (Bypassing Signup Form limitations)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: u.email,
      password: u.pass,
      email_confirm: true, // Auto confirm
      user_metadata: { full_name: u.name }
    });

    if (authError) {
      if (authError.message.includes('already registered')) {
        console.log(`- ${u.email} already exists in Auth, skipping creation.`);
      } else {
        console.error(`- Error creating Auth User for ${u.email}:`, authError.message);
        continue;
      }
    } else {
       // Note: The handle_new_user Postgres Trigger automatically creates the profile row asynchronously.
       // We must wait a brief moment for the trigger to finish before updating it.
       await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Attempting to resolve the UUID if user already existed
    const { data: fetchUser } = await supabase.from('profiles').select('id').eq('email', u.email).single();
    if (!fetchUser) {
        console.error(`- Failed to fetch profile for ${u.email} to finish configuration. The DB trigger might have failed.`);
        continue;
    }

    // 2. Setup Profile manually with Organisation & Role
    const { error: profileError } = await supabase
      .from('profiles')
      .update({
        organisation_id: u.org,
        role: u.role,
        onboarding_complete: true,
        department: 'Engineering',
        location: 'Remote',
        seniority: u.role === 'admin' ? 'senior' : 'mid'
      })
      .eq('id', fetchUser.id);

    if (profileError) {
      console.error(`- Error linking Profile for ${u.email}:`, profileError.message);
    } else {
      console.log(`✅ Successfully provisioned ${u.email} as ${u.role}`);
    }
  }

  console.log('\nSeed Complete!');
};

seedUsers();
