-- Schema for the self-hosted "family" backend (Postgres).
-- Mirrors the table/column names the frontend already expects (carried
-- over from the previous Supabase-backed version) so index.html only needs
-- its data-access layer swapped, not its data shapes.

create extension if not exists pgcrypto;

create table if not exists homeapp_members (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  emoji text not null default '🙂',
  color text not null default '#6C63FF',
  created_at timestamptz not null default now(),
  gender text not null default 'm',
  location_sharing boolean not null default true,
  is_home boolean,
  last_lat double precision,
  last_lng double precision,
  last_location_at timestamptz,
  home_status text,
  pin_hash text,
  birthday date,
  birthday_gift_poll_year integer,
  birthday_wish_year integer
);

create table if not exists homeapp_action_types (
  id uuid primary key default gen_random_uuid(),
  emoji text not null,
  label text not null,
  verb_template text not null,
  allows_note boolean not null default false,
  sort_order integer not null default 0,
  is_custom boolean not null default false,
  created_at timestamptz not null default now(),
  verb_template_f text,
  creates_poll boolean not null default false
);

create table if not exists homeapp_events (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references homeapp_members(id),
  action_type_id uuid references homeapp_action_types(id),
  note text,
  created_at timestamptz not null default now(),
  system_emoji text,
  system_text text,
  hidden_from_member_id uuid
);
create index if not exists homeapp_events_created_at_idx on homeapp_events(created_at desc);

create table if not exists homeapp_notifications (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references homeapp_events(id),
  recipient_member_id uuid not null references homeapp_members(id),
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists homeapp_notifications_recipient_idx on homeapp_notifications(recipient_member_id, is_read);

create table if not exists homeapp_polls (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references homeapp_events(id),
  question text not null,
  created_at timestamptz not null default now()
);

create table if not exists homeapp_poll_responses (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references homeapp_polls(id),
  member_id uuid not null references homeapp_members(id),
  response text not null,
  created_at timestamptz not null default now(),
  unique(poll_id, member_id)
);

create table if not exists homeapp_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references homeapp_members(id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table if not exists homeapp_member_location (
  member_id uuid primary key references homeapp_members(id),
  lat double precision,
  lng double precision,
  updated_at timestamptz not null default now()
);

create table if not exists homeapp_settings (
  key text primary key,
  value text not null
);
