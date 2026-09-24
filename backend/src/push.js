import webpush from "web-push";
import { pool } from "./db.js";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

const vapidReady = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (vapidReady) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled.");
}

// Sends a real Web Push to every subscription belonging to the given
// member ids, and prunes subscriptions the push service reports as gone
// (404/410 — matches what the old Supabase edge function did).
export async function sendPush(title, body, memberIds) {
  if (!vapidReady) return { ok: false, error: "VAPID keys not configured" };
  if (!memberIds || !memberIds.length) return { ok: true, sent: 0, total: 0 };

  const { rows: subs } = await pool.query(
    `select id, endpoint, p256dh, auth from homeapp_push_subscriptions where member_id = any($1::uuid[])`,
    [memberIds]
  );

  let sent = 0;
  const errors = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body })
      );
      sent++;
    } catch (e) {
      errors.push({ id: s.id, status: e.statusCode });
      if (e.statusCode === 404 || e.statusCode === 410) {
        await pool.query("delete from homeapp_push_subscriptions where id = $1", [s.id]).catch(() => {});
      }
    }
  }));

  return { ok: true, sent, total: subs.length, errors };
}
