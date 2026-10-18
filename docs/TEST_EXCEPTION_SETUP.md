# Saurabh Test Client Exception Setup Guide

## Overview

This guide explains how to set up and manage the **Saurabh Test** client exemption from freemium limits. This allows the test client to:

- ✅ Create unlimited reports without hitting the 1-per-user free limit
- ✅ All users in this client can view each other's reports
- ✅ Access premium features without requiring `is_premium = true`
- ✅ Easily enable/disable via a single database flag

## Architecture

### How It Works

1. **Clients Table Addition**: New `exempt_from_freemium` boolean column marks test/demo clients
2. **Profile Enhancement**: `AuthContext.jsx` now fetches client information along with user profiles
3. **Freemium Guard**: IntelligenceDashboard checks both `is_premium` AND client exemption before blocking
4. **Premium Functions**: New `premiumUtils.js` provides utility functions for premium status calculation

### Key Files Modified

| File | Changes |
|------|---------|
| `schema.sql` | Added `exempt_from_freemium` column to clients table |
| `src/context/AuthContext.jsx` | Now fetches client info with profile |
| `src/components/IntelligenceDashboard.jsx` | Updated freemium guard and premium status check |
| `src/components/ReportViewer.jsx` | Updated to use premium utility function |
| `src/utils/premiumUtils.js` | New utility functions for premium status |

## Setup Instructions

### Option 1: Using Supabase Dashboard (Recommended for One-Time Setup)

1. **Add Column to Clients Table** (if not already done):
   ```sql
   ALTER TABLE public.clients 
   ADD COLUMN IF NOT EXISTS exempt_from_freemium boolean DEFAULT false;
   ```

2. **Create/Update Saurabh Test Client**:
   ```sql
   INSERT INTO public.clients (name, domain, status, exempt_from_freemium)
   VALUES (
     'Saurabh Test',
     'sjtest.com',
     'active',
     true
   )
   ON CONFLICT(domain) DO UPDATE SET
     exempt_from_freemium = true
   RETURNING id, name, domain, exempt_from_freemium;
   ```

3. **Associate Test Users** (run for each test user):
   ```sql
   -- Associate by specific user ID
   UPDATE public.profiles 
   SET client_id = (SELECT id FROM public.clients WHERE domain = 'sjtest.com')
   WHERE id = 'USER_UUID_HERE';

   -- OR associate by email pattern
   UPDATE public.profiles 
   SET client_id = (SELECT id FROM public.clients WHERE domain = 'sjtest.com')
   WHERE email LIKE '%@sjtest.com'
      OR email LIKE '%test%';

   -- OR associate all users with a specific email
   UPDATE public.profiles 
   SET client_id = (SELECT id FROM public.clients WHERE domain = 'sjtest.com')
   WHERE email = 'founder@example.com';
   ```

### Option 2: Using the Setup Script

From the project root:

```bash
# Ensure environment variables are set
export VITE_SUPABASE_URL="https://your-project.supabase.co"
export VITE_SUPABASE_ANON_KEY="your-anon-key"

# Run the setup script
node scripts/setup-test-client.mjs
```

### Option 3: Raw SQL Migration

Execute [scripts/setup_test_exception.sql](scripts/setup_test_exception.sql) in your Supabase SQL editor.

## Verification

### Check Client Setup

```sql
SELECT id, name, domain, exempt_from_freemium, status 
FROM public.clients 
WHERE domain = 'sjtest.com';
```

Expected output:
```
id                 | name           | domain    | exempt_from_freemium | status
uuid-here          | Saurabh Test   | sjtest.com| true                 | active
```

### Check User Association

```sql
SELECT p.id, p.full_name, p.email, c.name, c.exempt_from_freemium
FROM public.profiles p
LEFT JOIN public.clients c ON p.client_id = c.id
WHERE c.domain = 'sjtest.com';
```

## Testing

### Step 1: Sign In Test User

Log in with a user associated with the 'sjtest.com' client.

### Step 2: Create Multiple Reports

Users should be able to create unlimited reports without hitting the "You've reached your free limit" error, even though `is_premium = false`.

### Step 3: Verify Premium Features

Test users should have access to premium features:
- ✅ Unlimited Q&A interactions with Bahirjee
- ✅ Able to add notes and comments without restrictions
- ✅ Full access to all premium UI elements

### Step 4: View Client Reports

All users in the test client should be able to view reports created by other users in the same client.

## Disable or Revoke Test Exception

To temporarily or permanently disable the test exemption:

```sql
UPDATE public.clients 
SET exempt_from_freemium = false 
WHERE domain = 'sjtest.com';
```

To remove the test client entirely:

```sql
DELETE FROM public.clients 
WHERE domain = 'sjtest.com';

-- Note: This will cascade delete all associated reports and interactions
```

## Code Implementation Details

### Freemium Guard (IntelligenceDashboard.jsx)

```javascript
// Check if user is exempt from freemium limits (e.g., test client)
const clientExempt = profile?.client?.exempt_from_freemium || false;
if (profile && !profile.is_premium && !clientExempt && profile.run_count >= 1) {
    setPhase('error');
    setStatusMsg("You've reached your free limit. Upgrade to Premium to run more analyses.");
    return;
}
```

### Premium Status Check (premiumUtils.js)

```javascript
export function isPremiumOrExempt(profile) {
  if (!profile) return false;
  
  // Direct premium flag takes priority
  if (profile.is_premium) return true;
  
  // Check if their client is exempt from freemium
  if (profile.client?.exempt_from_freemium) return true;
  
  return false;
}
```

## Important Notes

1. **Client-Wide Exemption**: ALL users in an exempt client get unlimited reports and premium features
2. **Cascading**: If you delete the client, all associated reports and interactions are deleted
3. **Real-Time**: Changes to `exempt_from_freemium` take effect immediately on next user login
4. **Backward Compatible**: Non-exempt clients continue to use the standard 1 free report limit
5. **Test Data**: Consider creating sample reports for the test client using appropriate test data

## Troubleshooting

### Users still getting "Reached free limit" error

1. Verify the client is marked as `exempt_from_freemium = true`
2. Verify the user's `client_id` is correctly set to the test client's ID
3. Have users sign out and back in to refresh profile data
4. Check browser console for any client-side errors

### Profile not loading client data

1. Verify AuthContext is properly fetching client data
2. Check Supabase RLS policies allow reading client data
3. Ensure the client relationship exists in the database

### SQL Errors

1. Ensure the `exempt_from_freemium` column exists: 
   ```sql
   ALTER TABLE public.clients 
   ADD COLUMN IF NOT EXISTS exempt_from_freemium boolean DEFAULT false;
   ```
2. Check for any foreign key constraint issues
3. Verify the domain is unique if using INSERT

## Related Files

- **Schema**: [schema.sql](../schema.sql)
- **Setup SQL**: [scripts/setup_test_exception.sql](setup_test_exception.sql)
- **Setup Script**: [scripts/setup-test-client.mjs](setup-test-client.mjs)
- **Auth Context**: [src/context/AuthContext.jsx](../src/context/AuthContext.jsx)
- **Premium Utils**: [src/utils/premiumUtils.js](../src/utils/premiumUtils.js)
- **Dashboard**: [src/components/IntelligenceDashboard.jsx](../src/components/IntelligenceDashboard.jsx)

## Next Steps

1. ✅ Run the setup script or execute SQL to create the Saurabh Test client
2. ✅ Associate your test users with the client
3. ✅ Test unlimited report creation
4. ✅ Verify premium features work without `is_premium = true`
5. ✅ Document your test users and their associated client for team reference
