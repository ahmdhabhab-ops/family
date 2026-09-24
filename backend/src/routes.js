import express from "express";
import { pool } from "./db.js";
import { sha256Hex, issueToken, requireAuth } from "./auth.js";
import { sendPush } from "./push.js";

export const router = express.Router();

// ---------------- Auth ----------------
// One endpoint covers both first-time PIN setup and normal login: if the
// member has no pin_hash yet, whatever PIN is sent becomes their PIN.
// Also doubles as "confirm PIN" for switching member / changing PIN, since
// those just need to re-verify a member_id+pin pair.
router.post("/auth/login", async (req, res) => {
  const { member_id, pin } = req.body || {};
  if (!member_id || !pin) return res.status(400).json({ error: "member_id and pin are required" });

  const { rows } = await pool.query("select id, pin_hash from homeapp_members where id = $1", [member_id]);
  if (!rows.length) return res.status(404).json({ error: "Member not found" });
  const member = rows[0];
  const hash = sha256Hex(pin);

  if (!member.pin_hash) {
    await pool.query("update homeapp_members set pin_hash = $1 where id = $2", [hash, member_id]);
  } else if (member.pin_hash !== hash) {
    return res.status(401).json({ error: "Wrong PIN" });
  }

  res.json({ token: issueToken(member_id) });
});

router.post("/auth/change-pin", requireAuth, async (req, res) => {
  const { pin } = req.body || {};
  if (!pin) return res.status(400).json({ error: "pin is required" });
  await pool.query("update homeapp_members set pin_hash = $1 where id = $2", [sha256Hex(pin), req.memberId]);
  res.json({ ok: true });
});

// ---------------- Members ----------------
// Public (no auth): the avatar-grid login screen needs this before anyone
// is authenticated. pin_hash is never returned.
router.get("/members", async (_req, res) => {
  const { rows } = await pool.query(`
    select id, name, emoji, color, created_at, gender, location_sharing, is_home,
           birthday, birthday_gift_poll_year, birthday_wish_year,
           (pin_hash is not null) as has_pin
    from homeapp_members order by created_at asc
  `);
  res.json(rows);
});

router.patch("/members/:id", requireAuth, async (req, res) => {
  const allowed = ["location_sharing", "is_home", "birthday", "birthday_gift_poll_year", "birthday_wish_year", "name", "emoji"];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (key in (req.body || {})) {
      values.push(req.body[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: "No valid fields to update" });
  values.push(req.params.id);
  const { rows } = await pool.query(
    `update homeapp_members set ${sets.join(", ")} where id = $${values.length} returning *`,
    values
  );
  res.json(rows);
});

// ---------------- Action types ----------------
router.get("/action_types", requireAuth, async (_req, res) => {
  const { rows } = await pool.query("select * from homeapp_action_types order by sort_order asc");
  res.json(rows);
});

router.post("/action_types", requireAuth, async (req, res) => {
  const { emoji, label, verb_template, verb_template_f, allows_note, is_custom, sort_order, creates_poll } = req.body || {};
  const { rows } = await pool.query(
    `insert into homeapp_action_types (emoji, label, verb_template, verb_template_f, allows_note, is_custom, sort_order, creates_poll)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [emoji, label, verb_template, verb_template_f ?? null, !!allows_note, !!is_custom, sort_order ?? 99, !!creates_poll]
  );
  res.json(rows);
});

router.patch("/action_types/:id", requireAuth, async (req, res) => {
  const allowed = ["emoji", "label", "verb_template", "verb_template_f"];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (key in (req.body || {})) {
      values.push(req.body[key]);
      sets.push(`${key} = $${values.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: "No valid fields to update" });
  values.push(req.params.id);
  const { rows } = await pool.query(
    `update homeapp_action_types set ${sets.join(", ")} where id = $${values.length} returning *`,
    values
  );
  res.json(rows);
});

router.delete("/action_types/:id", requireAuth, async (req, res) => {
  await pool.query("delete from homeapp_events where action_type_id = $1", [req.params.id]);
  await pool.query("delete from homeapp_action_types where id = $1", [req.params.id]);
  res.json({ ok: true });
});

// ---------------- Events ----------------
router.get("/events", requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const { rows } = await pool.query(`
    select e.id, e.note, e.created_at, e.member_id, e.system_emoji, e.system_text, e.hidden_from_member_id,
      case when e.member_id is not null then
        json_build_object('id', m.id, 'name', m.name, 'emoji', m.emoji, 'color', m.color, 'gender', m.gender)
      end as homeapp_members,
      case when e.action_type_id is not null then
        json_build_object('id', at.id, 'emoji', at.emoji, 'label', at.label, 'verb_template', at.verb_template, 'verb_template_f', at.verb_template_f)
      end as homeapp_action_types
    from homeapp_events e
    left join homeapp_members m on m.id = e.member_id
    left join homeapp_action_types at on at.id = e.action_type_id
    where e.hidden_from_member_id is null or e.hidden_from_member_id <> $1
    order by e.created_at desc
    limit $2
  `, [req.memberId, limit]);
  res.json(rows);
});

router.post("/events", requireAuth, async (req, res) => {
  const { action_type_id, note, system_emoji, system_text, hidden_from_member_id } = req.body || {};
  const { rows } = await pool.query(
    `insert into homeapp_events (member_id, action_type_id, note, system_emoji, system_text, hidden_from_member_id)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [action_type_id ? req.memberId : null, action_type_id ?? null, note ?? null, system_emoji ?? null, system_text ?? null, hidden_from_member_id ?? null]
  );
  res.json(rows);
});

// ---------------- Notifications ----------------
router.get("/notifications/unread", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    select n.id, n.created_at,
      json_build_object(
        'id', e.id, 'note', e.note, 'created_at', e.created_at,
        'homeapp_members', json_build_object('name', m.name, 'emoji', m.emoji, 'gender', m.gender),
        'homeapp_action_types', json_build_object('emoji', at.emoji, 'label', at.label, 'verb_template', at.verb_template, 'verb_template_f', at.verb_template_f)
      ) as homeapp_events
    from homeapp_notifications n
    join homeapp_events e on e.id = n.event_id
    left join homeapp_members m on m.id = e.member_id
    left join homeapp_action_types at on at.id = e.action_type_id
    where n.recipient_member_id = $1 and n.is_read = false
    order by n.created_at desc
  `, [req.memberId]);
  res.json(rows);
});

router.post("/notifications", requireAuth, async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [req.body];
  if (!list.length) return res.json([]);
  const values = [];
  const placeholders = list.map((n, i) => {
    values.push(n.event_id, n.recipient_member_id);
    return `($${values.length - 1}, $${values.length})`;
  }).join(",");
  const { rows } = await pool.query(
    `insert into homeapp_notifications (event_id, recipient_member_id) values ${placeholders} returning *`,
    values
  );
  res.json(rows);
});

router.patch("/notifications/mark-read", requireAuth, async (req, res) => {
  await pool.query("update homeapp_notifications set is_read = true where recipient_member_id = $1 and is_read = false", [req.memberId]);
  res.json({ ok: true });
});

// ---------------- Polls ----------------
router.get("/polls", requireAuth, async (_req, res) => {
  const { rows: polls } = await pool.query("select id, event_id, question, created_at from homeapp_polls order by created_at desc limit 50");
  const pollIds = polls.map(p => p.id);
  let responsesByPoll = {};
  if (pollIds.length) {
    const { rows: responses } = await pool.query(`
      select r.poll_id, r.member_id, r.response,
        json_build_object('name', m.name, 'emoji', m.emoji, 'gender', m.gender) as homeapp_members
      from homeapp_poll_responses r
      join homeapp_members m on m.id = r.member_id
      where r.poll_id = any($1::uuid[])
    `, [pollIds]);
    for (const r of responses) {
      (responsesByPoll[r.poll_id] ||= []).push(r);
    }
  }
  res.json(polls.map(p => ({ ...p, homeapp_poll_responses: responsesByPoll[p.id] || [] })));
});

router.post("/polls", requireAuth, async (req, res) => {
  const { event_id, question } = req.body || {};
  const { rows } = await pool.query(
    "insert into homeapp_polls (event_id, question) values ($1,$2) returning *",
    [event_id, question]
  );
  res.json(rows);
});

router.post("/poll_responses", requireAuth, async (req, res) => {
  const { poll_id, response } = req.body || {};
  const { rows } = await pool.query(
    `insert into homeapp_poll_responses (poll_id, member_id, response) values ($1,$2,$3)
     on conflict (poll_id, member_id) do update set response = excluded.response, created_at = now()
     returning *`,
    [poll_id, req.memberId, response]
  );
  res.json(rows);
});

// ---------------- Settings ----------------
// Public (no auth): family name + home location are shown on the pre-login
// screen and used for geofencing before anyone's logged in.
router.get("/settings", async (_req, res) => {
  const { rows } = await pool.query("select key, value from homeapp_settings");
  res.json(rows);
});

router.patch("/settings/:key", requireAuth, async (req, res) => {
  const { value } = req.body || {};
  const { rows } = await pool.query(
    `insert into homeapp_settings (key, value) values ($1,$2)
     on conflict (key) do update set value = excluded.value
     returning *`,
    [req.params.key, String(value)]
  );
  res.json(rows);
});

// ---------------- Member location ----------------
router.get("/member_locations", requireAuth, async (_req, res) => {
  const { rows } = await pool.query(`
    select l.member_id, l.lat, l.lng, l.updated_at,
      json_build_object('name', m.name, 'emoji', m.emoji, 'location_sharing', m.location_sharing) as homeapp_members
    from homeapp_member_location l
    join homeapp_members m on m.id = l.member_id
  `);
  res.json(rows);
});

router.post("/member_location", requireAuth, async (req, res) => {
  const { lat, lng } = req.body || {};
  const { rows } = await pool.query(
    `insert into homeapp_member_location (member_id, lat, lng, updated_at) values ($1,$2,$3, now())
     on conflict (member_id) do update set lat = excluded.lat, lng = excluded.lng, updated_at = now()
     returning *`,
    [req.memberId, lat, lng]
  );
  res.json(rows);
});

// ---------------- Push ----------------
router.post("/push_subscriptions", requireAuth, async (req, res) => {
  const { endpoint, p256dh, auth } = req.body || {};
  const { rows } = await pool.query(
    `insert into homeapp_push_subscriptions (member_id, endpoint, p256dh, auth) values ($1,$2,$3,$4)
     on conflict (endpoint) do update set member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth
     returning *`,
    [req.memberId, endpoint, p256dh, auth]
  );
  res.json(rows);
});

router.post("/send-push", requireAuth, async (req, res) => {
  const { title, body, recipient_member_ids } = req.body || {};
  const result = await sendPush(title, body, recipient_member_ids || []);
  res.json(result);
});
