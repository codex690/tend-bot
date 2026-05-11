if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const express = require('express');
const twilio = require('twilio');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.urlencoded({ extended: false }));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function sendCheckins() {
  const { data: family, error } = await supabase
    .from('family_members')
    .select('*');

  if (error) {
    console.error('Error fetching family:', error);
    return;
  }

  for (const member of family) {
    try {
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: member.phone,
        body: 'Good morning ' + member.name + '! This is your daily check-in from Tend. Reply YES to let your family abroad know you are okay.',
      });
      console.log('Check-in sent to ' + member.name);
    } catch (err) {
      console.error('Send error:', err.message);
    }
  }
}

app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body ? req.body.Body.trim().toUpperCase() : '';

  console.log('Message from:', from, '| Body:', body);

  const { data: members, error } = await supabase
    .from('family_members')
    .select('*')
    .eq('phone', from);

  if (error || !members || members.length === 0) {
    console.log('Unknown number:', from);
    return res.sendStatus(200);
  }

  const member = members[0];
  console.log('Found:', member.name);

  if (body === 'YES') {
    const { error: checkinError } = await supabase
      .from('checkins')
      .insert({
        family_member_id: member.id,
        phone: from,
        status: 'checked_in',
      });

    if (checkinError) {
      console.error('Checkin save error:', checkinError);
    } else {
      console.log(member.name + ' checked in and saved');
    }

    try {
      const msg = await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: 'Thank you ' + member.name + '! Your family has been notified that you are okay. Have a wonderful day!',
      });
      console.log('Reply sent:', msg.sid);
    } catch (err) {
      console.error('Reply error:', err.message);
    }

    if (member.diaspora_phone) {
      try {
        const alert = await client.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: member.diaspora_phone,
          body: 'TEND UPDATE: ' + member.name + ' has checked in and is okay!',
        });
        console.log('Diaspora alert sent:', alert.sid);
      } catch (err) {
        console.error('Alert error:', err.message);
      }
    }

  } else {
    try {
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: 'Hi ' + member.name + '! Just reply YES to let your family know you are okay today.',
      });
    } catch (err) {
      console.error('Prompt error:', err.message);
    }
  }

  res.sendStatus(200);
});

async function checkMissed() {
  const today = new Date().toISOString().split('T')[0];

  const { data: family } = await supabase
    .from('family_members')
    .select('*');

  if (!family) return;

  for (const member of family) {
    const { data: checkins } = await supabase
      .from('checkins')
      .select('*')
      .eq('phone', member.phone)
      .gte('checked_in_at', today + 'T00:00:00')
      .lte('checked_in_at', today + 'T23:59:59');

    if (!checkins || checkins.length === 0) {
      console.log(member.name + ' has NOT checked in today');

      await supabase.from('alerts').insert({
        family_member_id: member.id,
        phone: member.phone,
        alert_type: 'missed_checkin',
      });

      if (member.diaspora_phone) {
        try {
          await client.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: member.diaspora_phone,
            body: 'TEND ALERT: ' + member.name + ' has not checked in today. Please try to reach them directly.',
          });
        } catch (err) {
          console.error('Missed alert error:', err.message);
        }
      }
    }
  }
}

cron.schedule('0 7 * * *', sendCheckins, {
  timezone: 'Africa/Lagos'
});

cron.schedule('0 11 * * *', checkMissed, {
  timezone: 'Africa/Lagos'
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log('Tend bot is running on port ' + PORT);
  console.log('Webhook: http://localhost:' + PORT + '/webhook');
  console.log('Database: Supabase connected');
});