'use strict';

const crypto = require('crypto');
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const { Firestore } = require('@google-cloud/firestore');
const { google } = require('googleapis');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ENV: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (+ FIRESTORE_* already)
const MY_EMAIL = 'restinfootwholesale2024@gmail.com';
const WP_HOOK = 'https://restinfoot.com/wp-json/gmail/v1/webhook';

const firestore = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT_ID,
  credentials: {
    type: 'service_account',
    project_id: process.env.FIRESTORE_PROJECT_ID,
    client_email: process.env.FIRESTORE_CLIENT_EMAIL,
    private_key: String(process.env.FIRESTORE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },
});

app.post('/webhook', async (req, res) => {
  try {
    const phoneNo = String(req.body.phone_no || '').replace(/\D+/g, '');
    const smsTo = String(req.body.sms_to || '').trim();
    const smsBody = String(req.body.sms_body || '').trim();
    if (phoneNo && smsTo && smsBody) {
      await firestore.collection('users').doc(phoneNo).collection('sendmsg').doc('send').set({
        SmsBody: smsBody,
        SmsTo: smsTo,
        send: 'yes',
      });
    }
    return res.status(200).json({ success: true, message: 'Webhook processed successfully' });
  } catch (error) {
    return res.status(200).json({ success: false, message: 'Internal Server Error', error: error.message });
  }
});

app.get('/challenge', async (req, res) => {
  try {
    const response = await fetch('https://altcha-api.xbees.in/v1/challenge', {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    if (!data || !data.challenge || !data.salt) {
      return res.status(502).json({ success: false, error: 'Invalid challenge response', data });
    }

    const challenge = String(data.challenge);
    const salt = String(data.salt);
    const max = Number(data.maxnumber) > 0 ? Number(data.maxnumber) : 100000;
    const algoRaw = String(data.algorithm || 'SHA-256').toUpperCase();
    const algo = algoRaw === 'SHA-1' ? 'sha1' : algoRaw === 'SHA-512' ? 'sha512' : 'sha256';
    const start = Date.now();
    let number = null;
    for (let n = 0; n <= max; n++) {
      if (crypto.createHash(algo).update(salt + String(n)).digest('hex') === challenge) {
        number = n;
        break;
      }
    }
    if (number === null) throw new Error('Could not solve challenge');
    const payload = {
      algorithm: data.algorithm || 'SHA-256',
      challenge,
      number,
      salt,
      signature: data.signature || '',
      took: Math.max(1, Date.now() - start),
    };
    return res.status(200).json({
      success: true,
      token: Buffer.from(JSON.stringify(payload)).toString('base64'),
      number: payload.number,
      took: payload.took,
      payload,
      challenge: data,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// memory mein last historyId (Firebase nahi)
let lastHistoryId = '';

// Pub/Sub → Gmail → restinfoot POST → phir response
app.post('/gmailwebhook', async (req, res) => {
  try {
    // 1) historyId from Pub/Sub
    let historyId = '';
    let emailAddress = MY_EMAIL;
    if (req.body && req.body.message && req.body.message.data) {
      let raw = String(req.body.message.data).replace(/-/g, '+').replace(/_/g, '/');
      while (raw.length % 4) raw += '=';
      const decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
      historyId = String(decoded.historyId || '');
      emailAddress = decoded.emailAddress || MY_EMAIL;
    } else if (req.body && req.body.historyId) {
      historyId = String(req.body.historyId);
    }
    if (!historyId) {
      return res.status(200).json({ success: false, message: 'no historyId' });
    }

    // 2) Gmail client (OAuth)
    const oauth2 = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET
    );
    oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });

    // 3) first time seed
    if (!lastHistoryId) {
      const profile = await gmail.users.getProfile({ userId: 'me' });
      lastHistoryId = String((profile.data && profile.data.historyId) || historyId);
      return res.status(200).json({ success: true, message: 'seeded', historyId: lastHistoryId });
    }

    const startId = lastHistoryId;

    // 4) history → message ids
    const msgIds = new Set();
    let pageToken = '';
    let newestHistoryId = startId;
    try {
      do {
        const histRes = await gmail.users.history.list({
          userId: 'me',
          startHistoryId: startId,
          historyTypes: ['messageAdded'],
          maxResults: 100,
          pageToken: pageToken || undefined,
        });
        const hist = histRes.data || {};
        if (hist.historyId) newestHistoryId = String(hist.historyId);
        for (const h of hist.history || []) {
          if (h.id) newestHistoryId = String(h.id);
          for (const a of h.messagesAdded || []) {
            if (a.message && a.message.id) msgIds.add(String(a.message.id));
          }
        }
        pageToken = hist.nextPageToken || '';
      } while (pageToken);
    } catch (e) {
      if (e.code === 404) {
        const profile = await gmail.users.getProfile({ userId: 'me' });
        lastHistoryId = String((profile.data && profile.data.historyId) || historyId);
        return res.status(200).json({ success: true, message: 'history reset', historyId: lastHistoryId });
      }
      throw e;
    }

    lastHistoryId = newestHistoryId;
    if (!msgIds.size) {
      return res.status(200).json({ success: true, message: 'no new messages', historyId: newestHistoryId });
    }

    // 5) full messages → inbound only
    const messages = [];
    for (const id of msgIds) {
      const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const msg = full.data;
      if (!msg || !msg.id) continue;

      const headers = (msg.payload && msg.payload.headers) || [];
      const hdr = (name) => {
        const n = name.toLowerCase();
        for (const h of headers) {
          if (String(h.name || '').toLowerCase() === n) return String(h.value || '');
        }
        return '';
      };

      let html = '';
      let plain = '';
      const walk = (part) => {
        if (!part) return;
        const mime = String(part.mimeType || '');
        if (part.body && part.body.data) {
          let s = String(part.body.data).replace(/-/g, '+').replace(/_/g, '/');
          while (s.length % 4) s += '=';
          const text = Buffer.from(s, 'base64').toString('utf8');
          if (mime === 'text/html') html = html || text;
          if (mime === 'text/plain') plain = plain || text;
        }
        for (const p of part.parts || []) walk(p);
      };
      walk(msg.payload);

      let body = html || '';
      if (!body && plain) {
        body = plain.includes('<')
          ? plain
          : plain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      }

      const atts = [];
      const walkAtt = (part) => {
        if (!part) return;
        if (part.filename && part.body && part.body.attachmentId) {
          atts.push({
            id: part.body.attachmentId,
            filename: part.filename,
            mimeType: part.mimeType || '',
            size: Number(part.body.size || 0),
          });
        }
        for (const p of part.parts || []) walkAtt(p);
      };
      walkAtt(msg.payload);

      const from = hdr('From');
      const labels = Array.isArray(msg.labelIds) ? msg.labelIds : [];
      const isOut = labels.includes('SENT') || from.toLowerCase().includes(MY_EMAIL.toLowerCase());
      if (isOut) continue;

      const d = new Date(msg.internalDate ? Number(msg.internalDate) : Date.now());
      const pad = (n) => String(n).padStart(2, '0');
      const created =
        d.getFullYear() +
        '-' +
        pad(d.getMonth() + 1) +
        '-' +
        pad(d.getDate()) +
        ' ' +
        pad(d.getHours()) +
        ':' +
        pad(d.getMinutes()) +
        ':' +
        pad(d.getSeconds());

      messages.push({
        thread_id: String(msg.threadId || ''),
        msg_id: String(msg.id || ''),
        rfc_message_id: hdr('Message-ID'),
        mail_from: from,
        mail_to: hdr('To'),
        mail_cc: hdr('Cc'),
        mail_bcc: hdr('Bcc'),
        subject: hdr('Subject') || '(no subject)',
        body,
        direction: 'in',
        mail_type: 'reply',
        is_read: 0,
        attachments_json: JSON.stringify(atts),
        created_at: created,
        updated_at: created,
      });
    }

    if (!messages.length) {
      return res.status(200).json({ success: true, message: 'no inbound', historyId: newestHistoryId });
    }

    // 6) restinfoot webhook — iske baad hi response
    const wpRes = await fetch(WP_HOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        source: 'node-gmail',
        emailAddress,
        historyId: newestHistoryId,
        messages,
      }),
    });
    const wpText = await wpRes.text();
    let wpData = null;
    try {
      wpData = wpText ? JSON.parse(wpText) : null;
    } catch (_) {
      wpData = { raw: wpText };
    }

    return res.status(200).json({
      success: true,
      count: messages.length,
      historyId: newestHistoryId,
      wp_status: wpRes.status,
      wp: wpData,
    });
  } catch (err) {
    console.error('[gmailwebhook] error', err.message);
    return res.status(200).json({ success: false, message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server is running on http://localhost:' + PORT);
});
