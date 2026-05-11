require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.urlencoded({ extended: false }));

// ── CLIENTS ──────────────────────────────────────────────────
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── SEND DAILY CHECK-IN MESSAGE ─────────────────────────────
async function sendCheckins() {
  const { data: family, error } = await supabase
    .from('family_members')
    .select('*');

  if (error) {
    console.error('Error fetching family members:', error);
    return;
  }

  for (const member of family) {
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: member.phone,
      body: `Good morning ${member.name} 🌅\n\nThis is your daily check-in from Tend.\n\nReply *YES* to let your family abroad know you're okay.\n\nThey care about you. 🇳🇬`,
    });

    console.log(`✅ Check-in sent to ${member.name}`);
  }
}

// ── HANDLE REPLIES FROM FAMILY ───────────────────────────────
app.post('/webhook', async (req, res) => {
const from   = req.body.From.trim().replace(/"/g, '');
console.log('Received from:', from);
  const body   = req.body.Body?.trim().toUpperCase();

  // Find family member in Supabase
  console.log('Looking up:', from, 'length:', from.length);
const { data: members, error } = await supabase
    .from('family_members')
    .select('*')
    .eq('phone', from);
console.log('Found members:', members, 'Error:', error);

  if (error || !members || members.length === 0) {
    console.log(`Unknown number: ${from}`);
    return res.sendStatus(200);
  }

  const member = members[0];

  if (body === 'YES') {
    // Save check-in to Supabase
    const { error: checkinError } = await supabase
      .from('checkins')
      .insert({
        family_member_id: member.id,
        phone: from,
        status: 'checked_in',
      });

    if (checkinError) {
      console.error('Error saving check-in:', checkinError);
    } else {
      console.log(`✅ ${member.name} checked in and saved to database`);
    }

    // Reply to family member
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to:   from,
      body: `Thank you ${member.name} ❤️\n\nYour family has been notified that you're okay. Have a wonderful day!`,
    });

    // Alert diaspora user
    if (member.diaspora_phone) {
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to:   member.diaspora_phone,
        body: `✅ TEND UPDATE\n\n${member.name} has checked in and is okay. 🇳🇬❤️`,
      });
    }

  } else {
    // Reply to family member
await client.messages.create({
  from: process.env.TWILIO_WHATSAPP_NUMBER,
  to:   from,
  contentSid: 'HXc430351bdf8cfeec96207e65db20d5d5',
  contentVariables: JSON.stringify({ "1": member.name }),
});
  }

  res.sendStatus(200);
});

// ── CHECK FOR MISSED CHECK-INS ───────────────────────────────
async function checkMissed() {
  const today = new Date().toISOString().split('T')[0];

  const { data: family } = await supabase
    .from('family_members')
    .select('*');

  for (const member of family) {
    // Check if they checked in today
    const { data: checkins } = await supabase
      .from('checkins')
      .select('*')
      .eq('phone', member.phone)
      .gte('checked_in_at', `${today}T00:00:00`)
      .lte('checked_in_at', `${today}T23:59:59`);

    if (!checkins || checkins.length === 0) {
      console.log(`⚠️ ${member.name} has NOT checked in today`);

      // Save alert to Supabase
      await supabase
        .from('alerts')
        .insert({
          family_member_id: member.id,
          phone: member.phone,
          alert_type: 'missed_checkin',
        });

      // Alert diaspora user
      if (member.diaspora_phone) {
        await client.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to:   member.diaspora_phone,
          body: `⚠️ TEND ALERT\n\n${member.name} has not checked in today.\n\nPlease try to reach them directly.`,
        });
      }
    }
  }
}

// ── SCHEDULE ─────────────────────────────────────────────────
cron.schedule('0 7 * * *', sendCheckins, {
  timezone: 'Africa/Lagos'
});

cron.schedule('0 11 * * *', checkMissed, {
  timezone: 'Africa/Lagos'
});

// ── START SERVER ─────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
 console.log('\nTend bot is running on port ' + PORT);
  console.log('Webhook: http://localhost:' + PORT + '/webhook');
  console.log('Database: Supabase connected');
});