import cron from "node-cron";
import { pool } from "./db.js";
import { sendPush } from "./push.js";

async function allMemberIds() {
  const { rows } = await pool.query("select id from homeapp_members");
  return rows.map(r => r.id);
}

async function postEvent({ emoji, text, recipientIds, pushTitle }) {
  const { rows } = await pool.query(
    `insert into homeapp_events (system_emoji, system_text) values ($1,$2) returning id`,
    [emoji, text]
  );
  const eventId = rows[0].id;
  if (recipientIds.length) {
    const values = recipientIds.map((_, i) => `($1, $${i + 2})`).join(",");
    await pool.query(
      `insert into homeapp_notifications (event_id, recipient_member_id) values ${values}`,
      [eventId, ...recipientIds]
    );
  }
  await sendPush(pushTitle, text, recipientIds);
  return eventId;
}

// ---------------- Hourly purge ----------------
// Matches the original: events older than 24h are removed (cascades to
// their notifications/polls/poll_responses via FKs — add ON DELETE CASCADE
// if your Postgres doesn't already have it; see schema.sql).
async function purgeOldEvents() {
  await pool.query(`delete from homeapp_notifications where event_id in (select id from homeapp_events where created_at < now() - interval '24 hours')`);
  await pool.query(`delete from homeapp_poll_responses where poll_id in (select id from homeapp_polls where event_id in (select id from homeapp_events where created_at < now() - interval '24 hours'))`);
  await pool.query(`delete from homeapp_polls where event_id in (select id from homeapp_events where created_at < now() - interval '24 hours')`);
  await pool.query(`delete from homeapp_events where created_at < now() - interval '24 hours'`);
}

// ---------------- Azan safety check ----------------
async function checkAzanSafety() {
  const { rows: members } = await pool.query("select id from homeapp_members");
  if (!members.length) return;

  const { rows: latest } = await pool.query(`
    select m.id,
      (select at.label
       from homeapp_events e
       join homeapp_action_types at on at.id = e.action_type_id
       where e.member_id = m.id and at.label in ('طالع من البيت','وصلت عالبيت')
       order by e.created_at desc limit 1) as latest_label
    from homeapp_members m
  `);
  const allAway = latest.length === members.length && latest.every(r => r.latest_label === "طالع من البيت");

  const { rows: azanRows } = await pool.query(`
    select at.label
    from homeapp_events e
    join homeapp_action_types at on at.id = e.action_type_id
    where at.label in ('تشغيل الأزان','إطفاء الأزان')
    order by e.created_at desc limit 1
  `);
  const azanOn = azanRows[0]?.label === "تشغيل الأزان";

  const { rows: settingRows } = await pool.query("select value from homeapp_settings where key = 'azan_alert_active'");
  const alertActive = settingRows[0]?.value === "true";

  if (allAway && azanOn) {
    if (!alertActive) {
      const text = "الأزان لسا شغّال وما حدا بالبيت! ما تنسوا تطفوه 🔥";
      await postEvent({ emoji: "⚠️", text, recipientIds: members.map(m => m.id), pushTitle: "⚠️ تنبيه!" });
      await pool.query(
        `insert into homeapp_settings (key, value) values ('azan_alert_active','true')
         on conflict (key) do update set value = 'true'`
      );
    }
  } else {
    await pool.query(
      `insert into homeapp_settings (key, value) values ('azan_alert_active','false')
       on conflict (key) do update set value = 'false'`
    );
  }
}

// ---------------- Daily summary ----------------
async function sendDailySummary() {
  const { rows } = await pool.query(`
    select m.emoji || ' ' || m.name || ': ' || count(e.id) || ' نشاط ' ||
           coalesce(string_agg(distinct at.emoji, ' '), '') as line
    from homeapp_members m
    join homeapp_events e on e.member_id = m.id and e.created_at > now() - interval '24 hours'
    join homeapp_action_types at on at.id = e.action_type_id
    group by m.id, m.emoji, m.name
    order by m.name
  `);
  const body = rows.length ? rows.map(r => r.line).join("\n") : "ما صار شي مسجّل اليوم 🌙";
  const memberIds = await allMemberIds();
  await postEvent({ emoji: "🌙", text: "ملخص اليوم: \n" + body, recipientIds: memberIds, pushTitle: "🌙 ملخص اليوم" });
}

// ---------------- Meal asks (breakfast/lunch/dinner) ----------------
async function askMeal(question, emoji) {
  const memberIds = await allMemberIds();
  const eventId = await postEvent({ emoji, text: question, recipientIds: memberIds, pushTitle: emoji + " سؤال اليوم" });
  await pool.query(`insert into homeapp_polls (event_id, question) values ($1,$2)`, [eventId, question]);
}

// ---------------- Coffee rotation (nescafe turn) ----------------
// Deterministic day-of-year rotation (no state needed): settle yesterday's
// turn first — the family VOTES on whether that person made nescafe (their
// own vote doesn't count), and "لأ" winning means a public $10 fine — then
// announce today's turn with a fresh vote.
async function coffeeRotation() {
  const { rows: members } = await pool.query("select id, name, emoji from homeapp_members order by created_at");
  const count = members.length;
  if (!count) return;

  const { rows: dateRows } = await pool.query("select (now() at time zone 'Asia/Beirut')::date as today");
  const today = dateRows[0].today;
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const dayOfYear = (d) => {
    const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.floor((d - start) / 86400000) + 1;
  };

  const idxYesterday = dayOfYear(yesterday) % count;
  const yesterdayMember = members[idxYesterday];

  const { rows: yEvents } = await pool.query(
    `select e.id from homeapp_events e
     where e.system_emoji = '☕' and (e.created_at at time zone 'Asia/Beirut')::date = $1
     order by e.created_at desc limit 1`,
    [yesterday.toISOString().slice(0, 10)]
  );
  if (yEvents.length) {
    const { rows: yPolls } = await pool.query("select id from homeapp_polls where event_id = $1 limit 1", [yEvents[0].id]);
    if (yPolls.length) {
      const { rows: responses } = await pool.query(
        "select member_id, response from homeapp_poll_responses where poll_id = $1",
        [yPolls[0].id]
      );
      let noVotes = 0, yesVotes = 0;
      for (const r of responses) {
        if (r.member_id === yesterdayMember.id) continue;
        const said = (r.response || "").trim();
        if (/^(لا|لأ)/.test(said) || /^no\b/i.test(said)) noVotes++;
        else if (/^(ايه|اه|نعم)/.test(said) || /^y(es)?\b/i.test(said)) yesVotes++;
      }
      if (noVotes > 0 && noVotes > yesVotes) {
        const fineText = `💸 الأكثرية صوتت إنو ${yesterdayMember.name} ما عمل نسكافيه إمبارح، لازم يدفع 10$ لأنه خالف قانون العيلة!`;
        await postEvent({ emoji: "💸", text: fineText, recipientIds: members.map(m => m.id), pushTitle: "💸 غرامة النسكافيه" });
      }
    }
  }

  // `today` comes back from pg as a Date at UTC midnight for that Beirut calendar date.
  const todayDate = new Date(today);
  const idxToday = dayOfYear(todayDate) % count;
  const todayMember = members[idxToday];

  const text = `${todayMember.emoji} ${todayMember.name} الدور عليه اليوم يعمل نسكافيه لأهل البيت ☕`;
  const eventId = await postEvent({ emoji: "☕", text, recipientIds: members.map(m => m.id), pushTitle: "☕ دور النسكافيه" });
  await pool.query(
    `insert into homeapp_polls (event_id, question) values ($1,$2)`,
    [eventId, `صوّتوا: ${todayMember.name} عمل نسكافيه اليوم؟ اكتبوا "ايه" أو "لأ" 👇`]
  );
}

// ---------------- Birthdays (7-day gift poll + day-of wish) ----------------
async function checkBirthdays() {
  const { rows: members } = await pool.query("select id, name, gender, birthday, birthday_gift_poll_year, birthday_wish_year from homeapp_members where birthday is not null");
  const { rows: dateRows } = await pool.query("select (now() at time zone 'Asia/Beirut')::date as today");
  const today = new Date(dateRows[0].today);
  today.setUTCHours(0, 0, 0, 0);
  const year = today.getUTCFullYear();

  for (const m of members) {
    // pg returns `date` columns as JS Date objects (UTC midnight), not strings.
    const bday = new Date(m.birthday);
    const mo = bday.getUTCMonth();
    const da = bday.getUTCDate();
    let next = new Date(Date.UTC(year, mo, da));
    if (next < today) next = new Date(Date.UTC(year + 1, mo, da));
    const days = Math.round((next - today) / 86400000);

    if (days === 7 && m.birthday_gift_poll_year !== year) {
      const claimed = await pool.query(
        `update homeapp_members set birthday_gift_poll_year = $1
         where id = $2 and (birthday_gift_poll_year is null or birthday_gift_poll_year <> $1)
         returning id`,
        [year, m.id]
      );
      if (claimed.rows.length) {
        const others = members.filter(mm => mm.id !== m.id).map(mm => mm.id);
        const text = `🎁 عيد ميلاد ${m.name} بعد أسبوع بالضبط! شو رح ${m.gender === "f" ? "تجيبولها" : "تجيبوله"} هدية؟`;
        const { rows } = await pool.query(
          `insert into homeapp_events (system_emoji, system_text, hidden_from_member_id) values ($1,$2,$3) returning id`,
          ["🎁", text, m.id]
        );
        const eventId = rows[0].id;
        await pool.query(`insert into homeapp_polls (event_id, question) values ($1,$2)`, [eventId, `شو رح تجيبوا هدية لـ ${m.name}؟`]);
        if (others.length) {
          const values = others.map((_, i) => `($1, $${i + 2})`).join(",");
          await pool.query(`insert into homeapp_notifications (event_id, recipient_member_id) values ${values}`, [eventId, ...others]);
        }
        await sendPush(text, text, others);
      }
    } else if (days === 0 && m.birthday_wish_year !== year) {
      const claimed = await pool.query(
        `update homeapp_members set birthday_wish_year = $1
         where id = $2 and (birthday_wish_year is null or birthday_wish_year <> $1)
         returning id`,
        [year, m.id]
      );
      if (claimed.rows.length) {
        const text = `🎉 عيد ميلاد سعيد يا ${m.name}! 🎂`;
        const allIds = members.map(mm => mm.id);
        await postEvent({ emoji: "🎉", text, recipientIds: allIds, pushTitle: text });
      }
    }
  }
}

// ---------------- Missing-birthday nudge (weekly per member) ----------------
async function remindMissingBirthdays() {
  const { rows: members } = await pool.query("select id, name from homeapp_members where birthday is null");
  for (const m of members) {
    const key = `birthday_reminder_${m.id}`;
    const text = `🎂 لسا ما حطّيت تاريخ عيد ميلادك يا ${m.name}! فوت عالإعدادات ⚙️ وحطّو، حتى نحتفل فيك ونجهّزلك مفاجأة 🎁`;
    await postEvent({ emoji: "🎂", text, recipientIds: [m.id], pushTitle: "🎂 عيد ميلادك؟" });
    await pool.query(
      `insert into homeapp_settings (key, value) values ($1, now()::text)
       on conflict (key) do update set value = now()::text`,
      [key]
    );
  }
}

// Exported individually too (not just startCronJobs) so each job can be
// tested directly or triggered manually without waiting for its schedule.
export { purgeOldEvents, checkAzanSafety, sendDailySummary, askMeal, coffeeRotation, checkBirthdays, remindMissingBirthdays };

export function startCronJobs() {
  cron.schedule("0 * * * *", () => purgeOldEvents().catch(e => console.error("purgeOldEvents failed:", e)));
  cron.schedule("*/10 * * * *", () => checkAzanSafety().catch(e => console.error("checkAzanSafety failed:", e)));
  cron.schedule("0 21 * * *", () => sendDailySummary().catch(e => console.error("sendDailySummary failed:", e)));
  cron.schedule("0 4 * * *", () => coffeeRotation().catch(e => console.error("coffeeRotation failed:", e)));
  cron.schedule("0 4 * * *", () => askMeal("شو بدكن ياكلوا عالفطور اليوم؟ 🍳", "🍳").catch(e => console.error("askMeal breakfast failed:", e)));
  cron.schedule("30 10 * * *", () => askMeal("شو بدكن ياكلوا عالغدا اليوم؟ 🍲", "🍲").catch(e => console.error("askMeal lunch failed:", e)));
  cron.schedule("0 16 * * *", () => askMeal("شو بدكن ياكلوا عالعشا اليوم؟ 🍽️", "🍽️").catch(e => console.error("askMeal dinner failed:", e)));
  cron.schedule("0 6 * * *", () => checkBirthdays().catch(e => console.error("checkBirthdays failed:", e)));
  cron.schedule("0 6 * * 1", () => remindMissingBirthdays().catch(e => console.error("remindMissingBirthdays failed:", e)));
  console.log("Cron jobs scheduled.");
}
