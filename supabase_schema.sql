
-- Create a table for Public Palettes (accessible by everyone to read, but only owners can edit)
create table public.palettes (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  colors text[] not null, -- Array of HEX codes
  image_url text,         -- Optional link to source image (if you decide to store it string)
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Set up Row Level Security (RLS)
alter table public.palettes enable row level security;

-- Policy: Users can insert their own palettes
create policy "Users can insert their own palettes"
  on public.palettes for insert
  with check (auth.uid() = user_id);

-- Policy: Users can view their own palettes
create policy "Users can view their own palettes"
  on public.palettes for select
  using (auth.uid() = user_id);

-- (Optional) If we want public sharing later:
-- create policy "Anyone can view palettes"
--   on public.palettes for select
--   using (true);
