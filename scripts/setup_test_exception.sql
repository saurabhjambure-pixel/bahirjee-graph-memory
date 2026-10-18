-- Migration: Setup Saurabh Test Client Exception
-- This script creates a test exception for the "Saurabh Test" client
-- It exempts this client from freemium limits and enables unlimited reports

-- Step 1: Add exempt_from_freemium column if it doesn't exist
alter table public.clients 
add column if not exists exempt_from_freemium boolean default false;

-- Step 2: Create the Saurabh Test client (bypasses freemium limits)
insert into public.clients (name, domain, status, exempt_from_freemium)
values (
  'Saurabh Test',
  'sjtest.com',
  'active',
  true
)
on conflict(domain) do update set
  exempt_from_freemium = true
returning id, name, domain, exempt_from_freemium;

-- Step 3: Note - Associate test users with this client by updating their profile:
-- UPDATE public.profiles 
-- SET client_id = (SELECT id FROM public.clients WHERE domain = 'sjtest.com')
-- WHERE email LIKE '%test%' OR email = 'your-test-email@example.com';

-- Benefits of this approach:
-- 1. The Saurabh Test client can create unlimited reports
-- 2. All users in this client can view all reports created within the client
-- 3. No need to set is_premium = true for test users
-- 4. Easy to disable later by setting exempt_from_freemium = false
-- 5. Database-driven, no code changes needed to revoke access
