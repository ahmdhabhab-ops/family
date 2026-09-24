import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required (postgres connection string to your existing Postgres instance).");
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false
});

export async function query(text, params) {
  return pool.query(text, params);
}

// Applies schema.sql (idempotent: every statement is CREATE ... IF NOT EXISTS)
// then, only if homeapp_members is still empty, loads seed-data.json — the
// one-time carry-over from the previous Supabase-backed instance. Events,
// notifications, polls and poll_responses are deliberately NOT seeded: they
// were always short-lived there (purged after 24h) and would just be stale
// clutter by the time this actually runs.
export async function migrateAndSeed() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);

  const { rows } = await pool.query("select count(*)::int as n from homeapp_members");
  if (rows[0].n > 0) {
    console.log("Seed skipped: homeapp_members already has data.");
    return;
  }

  const seedPath = path.join(__dirname, "seed-data.json");
  if (!fs.existsSync(seedPath)) return;
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));

  const client = await pool.connect();
  try {
    await client.query("begin");

    for (const m of seed.homeapp_members || []) {
      await client.query(
        `insert into homeapp_members
          (id, name, emoji, color, created_at, gender, location_sharing, is_home, pin_hash, birthday, birthday_gift_poll_year, birthday_wish_year)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (id) do nothing`,
        [m.id, m.name, m.emoji, m.color, m.created_at, m.gender, m.location_sharing, m.is_home ?? null,
         m.pin_hash ?? null, m.birthday ?? null, m.birthday_gift_poll_year ?? null, m.birthday_wish_year ?? null]
      );
    }

    for (const a of seed.homeapp_action_types || []) {
      await client.query(
        `insert into homeapp_action_types
          (id, emoji, label, verb_template, verb_template_f, allows_note, sort_order, is_custom, creates_poll, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (id) do nothing`,
        [a.id, a.emoji, a.label, a.verb_template, a.verb_template_f ?? null, a.allows_note, a.sort_order, a.is_custom, a.creates_poll, a.created_at]
      );
    }

    for (const s of seed.homeapp_settings || []) {
      await client.query(
        `insert into homeapp_settings (key, value) values ($1,$2) on conflict (key) do nothing`,
        [s.key, s.value]
      );
    }

    for (const l of seed.homeapp_member_location || []) {
      await client.query(
        `insert into homeapp_member_location (member_id, lat, lng, updated_at) values ($1,$2,$3,$4)
         on conflict (member_id) do nothing`,
        [l.member_id, l.lat, l.lng, l.updated_at]
      );
    }

    for (const p of seed.homeapp_push_subscriptions || []) {
      await client.query(
        `insert into homeapp_push_subscriptions (id, member_id, endpoint, p256dh, auth, created_at)
         values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing`,
        [p.id, p.member_id, p.endpoint, p.p256dh, p.auth, p.created_at]
      );
    }

    await client.query("commit");
    console.log("Seed complete: migrated members/action types/settings/locations/push subscriptions from Supabase.");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
