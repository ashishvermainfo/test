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
    const out = await solveAltchaToken();
    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

async function solveAltchaToken() {
  const response = await fetch('https://altcha-api.xbees.in/v1/challenge', {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });
  const data = await response.json();
  if (!response.ok) {
    const err = new Error('Challenge HTTP ' + response.status);
    err.data = data;
    throw err;
  }
  if (!data || !data.challenge || !data.salt) {
    throw new Error('Invalid challenge response');
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
  return {
    success: true,
    token: Buffer.from(JSON.stringify(payload)).toString('base64'),
    number: payload.number,
    took: payload.took,
    payload,
    challenge: data,
  };
}

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

/**
 * Store chat message → Firestore
 * POST /storechat
 * body: { doc_id|firestore_doc_id, history_id, msg, url, send_id, send_type, date_time|created_at }
 * path: app_chat/{docId}/chat/{history_id}
 */
app.post('/storechat', async (req, res) => {
  try {
    const b = req.body || {};
    const docId = String(b.doc_id || b.firestore_doc_id || b.docId || '').trim();
    const historyId = b.history_id != null ? Number(b.history_id) : NaN;
    if (!docId || !Number.isFinite(historyId) || historyId <= 0) {
      return res.status(400).json({ success: false, message: 'doc_id and history_id required' });
    }

    const dt = String(b.date_time || b.created_at || b.updated_at || '').trim();
    const row = {
      history_id: historyId,
      msg: b.msg != null ? String(b.msg) : '',
      url: b.url != null ? String(b.url) : '',
      send_id: String(b.send_id != null ? b.send_id : ''),
      send_type: b.send_type != null ? String(b.send_type) : 'admin',
      date_time: dt,
    };
    if (dt) {
      row.created_at = dt;
      row.updated_at = dt;
    }

    const hid = String(historyId);
    await firestore.collection('app_chat').doc(docId).collection('chat').doc(hid).set(row, { merge: true });

    return res.status(200).json({ success: true, doc_id: docId, history_id: historyId });
  } catch (error) {
    console.error('[storechat] error', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

const WP_DELHIVERY_HOOK = 'https://restinfoot.com/wp-json/appcron/v1/delhivery_tracking';

/** Same as appcron copy: status + tracking_states + edd */
async function delhiveryFetchAwb(awb) {
  const url = 'https://dlv-api.delhivery.com/v3/unified-tracking?wbn=' + encodeURIComponent(awb);
  const res = await fetch(url, {
    method: 'GET',
    headers: { origin: 'https://www.delhivery.com', Accept: 'application/json' },
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.data || !data.data[0] || !data.data[0].status) {
    return { awb, status: '', tracking_states: [], edd: '', error: 'Invalid API response' };
  }
  const row = data.data[0];
  return {
    awb,
    status: String((row.status && row.status.status) || ''),
    tracking_states: Array.isArray(row.trackingStates) ? row.trackingStates : [],
    edd: String(row.promiseDeliveryDate || ''),
  };
}

/**
 * Cron → Delhivery API → WP webhook → phir response
 * Vercel: res.json() KE BAAD code kill ho sakta hai — pehle kaam, phir response.
 */
app.post('/dehlivery_tracking', async (req, res) => {
  const body = req.body || {};
  const ordersIn = Array.isArray(body.orders) ? body.orders : [];
  const type = String(body.type || 'b2c');

  try {
    console.log('[dehlivery_tracking] start', type, 'orders=', ordersIn.length);
    const out = [];
    for (const row of ordersIn) {
      if (!row || typeof row !== 'object') continue;
      const orderId = Number(row.order_id || 0);
      let awbs = Array.isArray(row.awb) ? row.awb : Array.isArray(row.awbs) ? row.awbs : [];
      awbs = awbs.map((a) => String(a || '').trim()).filter(Boolean);
      if (!orderId || !awbs.length) continue;

      const awbResults = [];
      for (const awb of awbs) {
        try {
          awbResults.push(await delhiveryFetchAwb(awb));
        } catch (e) {
          awbResults.push({
            awb,
            status: '',
            tracking_states: [],
            edd: '',
            error: e.message || 'fetch failed',
          });
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      out.push({ order_id: orderId, awbs: awbResults });
    }

    let wpStatus = 0;
    let wpBody = '';
    if (out.length) {
      const wpRes = await fetch(WP_DELHIVERY_HOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ orders: out, type }),
      });
      wpStatus = wpRes.status;
      wpBody = (await wpRes.text()).slice(0, 300);
      console.log('[dehlivery_tracking]', type, 'wp', wpStatus, wpBody);
    }

    return res.status(200).json({
      success: true,
      message: 'done',
      count: ordersIn.length,
      tracked: out.length,
      type,
      wp_status: wpStatus,
    });
  } catch (err) {
    console.error('[dehlivery_tracking] error', err.message);
    return res.status(200).json({ success: false, message: err.message, type });
  }
});

const WP_AMAZON_HOOK = 'https://restinfoot.com/wp-json/appcron/v1/amazon_tracking';
const WP_XPRESSBEE_HOOK = 'https://restinfoot.com/wp-json/appcron/v1/xpressbee_tracking';

/** Same as appcron copy amazon_api_get_tracker_status → status + edd */
async function amazonFetchAwb(awb) {
  const url = 'https://track.amazon.in/api/tracker/' + encodeURIComponent(awb);
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
      Origin: 'https://track.amazon.in',
    },
  });
  const data = await res.json().catch(() => null);
  if (!data || data.eventHistory == null) {
    return { awb, status: '', edd: '', error: 'Invalid response' };
  }

  let eventHistory = null;
  try {
    eventHistory = typeof data.eventHistory === 'string'
      ? JSON.parse(data.eventHistory)
      : data.eventHistory;
  } catch (_) {
    return { awb, status: '', edd: '', error: 'Could not parse eventHistory' };
  }
  if (!eventHistory || typeof eventHistory !== 'object') {
    return { awb, status: '', edd: '', error: 'Could not parse eventHistory' };
  }

  const summaryStatus = String((eventHistory.summary && eventHistory.summary.status) || '').trim();
  const events = Array.isArray(eventHistory.eventHistory) ? eventHistory.eventHistory : [];

  let promised = '';
  let progress = null;
  try {
    if (data.progressTracker != null) {
      progress = typeof data.progressTracker === 'string'
        ? JSON.parse(data.progressTracker)
        : data.progressTracker;
    }
  } catch (_) {
    progress = null;
  }
  if (!progress && eventHistory.progressTracker) progress = eventHistory.progressTracker;

  const metaBlocks = [];
  if (progress && progress.summary && Array.isArray(progress.summary.metadata)) {
    metaBlocks.push(progress.summary.metadata);
  }
  if (eventHistory.summary && Array.isArray(eventHistory.summary.metadata)) {
    metaBlocks.push(eventHistory.summary.metadata);
  }
  for (const meta of metaBlocks) {
    const expected = String((meta.expectedDeliveryDate && meta.expectedDeliveryDate.date) || '').trim();
    if (expected) {
      promised = expected;
      break;
    }
    const fallback = String((meta.promisedDeliveryDate && meta.promisedDeliveryDate.date) || '').trim();
    if (fallback && !promised) promised = fallback;
  }

  let resolved = summaryStatus;
  if (events.length) {
    const last = events[events.length - 1];
    const localisedId = String((last && last.statusSummary && last.statusSummary.localisedStringId) || '');
    const summaryInTransitOrOfd = ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'OFD'].includes(summaryStatus);
    if (localisedId === 'swa_rex_arrived_at_final_hub' && summaryInTransitOrOfd) {
      resolved = 'REACH_DEST_FINAL_HUB';
    }
  }

  return { awb, status: resolved, edd: promised };
}

app.post('/amazon-tracking', async (req, res) => {
  const ordersIn = Array.isArray((req.body || {}).orders) ? req.body.orders : [];

  try {
    console.log('[amazon-tracking] start orders=', ordersIn.length);
    const out = [];
    for (const row of ordersIn) {
      if (!row || typeof row !== 'object') continue;
      const orderId = Number(row.order_id || 0);
      let awbs = Array.isArray(row.awb) ? row.awb : Array.isArray(row.awbs) ? row.awbs : [];
      awbs = awbs.map((a) => String(a || '').trim()).filter(Boolean);
      if (!orderId || !awbs.length) continue;

      const awbResults = [];
      for (const awb of awbs) {
        try {
          awbResults.push(await amazonFetchAwb(awb));
        } catch (e) {
          awbResults.push({ awb, status: '', edd: '', error: e.message || 'fetch failed' });
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      out.push({ order_id: orderId, awbs: awbResults });
    }

    let wpStatus = 0;
    if (out.length) {
      const wpRes = await fetch(WP_AMAZON_HOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ orders: out }),
      });
      wpStatus = wpRes.status;
      console.log('[amazon-tracking] wp', wpStatus, (await wpRes.text()).slice(0, 300));
    }

    return res.status(200).json({
      success: true,
      message: 'done',
      count: ordersIn.length,
      tracked: out.length,
      wp_status: wpStatus,
    });
  } catch (err) {
    console.error('[amazon-tracking] error', err.message);
    return res.status(200).json({ success: false, message: err.message });
  }
});

/** Same as appcron copy xpressbee_api → status + edd */
async function xpressbeeFetchAwb(awb, token) {
  const res = await fetch('https://www.xpressbees.com/api/tracking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ awbNo: awb, altchaPayload: token }),
  });
  const raw = await res.text();
  if (res.status < 200 || res.status >= 300) {
    return { awb, status: '', edd: '', error: 'HTTP ' + res.status + ': ' + raw.slice(0, 200) };
  }
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (_) {
    return { awb, status: '', edd: '', error: 'Invalid JSON' };
  }

  let status = '';
  let edd = '';
  if (data && data.domestic && data.domestic[0]) {
    status = String(data.domestic[0].status || '');
    edd = String(data.domestic[0].EDD || data.domestic[0].edd || '');
  } else if (data && data.international && data.international[0]) {
    status = String(data.international[0].status || '');
    edd = String(data.international[0].EDD || data.international[0].edd || '');
  }
  return { awb, status, edd };
}

app.post('/xpressbee-tracking', async (req, res) => {
  const ordersIn = Array.isArray((req.body || {}).orders) ? req.body.orders : [];

  try {
    console.log('[xpressbee-tracking] start orders=', ordersIn.length);
    const ch = await solveAltchaToken();
    const token = String(ch.token || '');
    if (!token) {
      return res.status(200).json({ success: false, message: 'no altcha token' });
    }

    const out = [];
    for (const row of ordersIn) {
      if (!row || typeof row !== 'object') continue;
      const orderId = Number(row.order_id || 0);
      let awbs = Array.isArray(row.awb) ? row.awb : Array.isArray(row.awbs) ? row.awbs : [];
      awbs = awbs.map((a) => String(a || '').trim()).filter(Boolean);
      if (!orderId || !awbs.length) continue;

      const awbResults = [];
      for (const awb of awbs) {
        try {
          awbResults.push(await xpressbeeFetchAwb(awb, token));
        } catch (e) {
          awbResults.push({ awb, status: '', edd: '', error: e.message || 'fetch failed' });
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      out.push({ order_id: orderId, awbs: awbResults });
    }

    let wpStatus = 0;
    if (out.length) {
      const wpRes = await fetch(WP_XPRESSBEE_HOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ orders: out }),
      });
      wpStatus = wpRes.status;
      console.log('[xpressbee-tracking] wp', wpStatus, (await wpRes.text()).slice(0, 300));
    }

    return res.status(200).json({
      success: true,
      message: 'done',
      count: ordersIn.length,
      tracked: out.length,
      wp_status: wpStatus,
    });
  } catch (err) {
    console.error('[xpressbee-tracking] error', err.message);
    return res.status(200).json({ success: false, message: err.message });
  }
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
      const to = hdr('To');
      const subject = hdr('Subject') || '(no subject)';
      const labels = Array.isArray(msg.labelIds) ? msg.labelIds : [];
      const fromLow = from.toLowerCase();
      const skipCheck = (from + ' ' + subject + ' ' + to).toLowerCase();

      // Outbound / own mailbox — restinfoot API pe mat bhejo
      const isOut =
        labels.includes('SENT') ||
        fromLow.includes(MY_EMAIL.toLowerCase());
      if (isOut) continue;

      // Razorpay mails — restinfoot API pe mat bhejo
      if (skipCheck.includes('razorpay')) continue;

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
        mail_to: to,
        mail_cc: hdr('Cc'),
        mail_bcc: hdr('Bcc'),
        subject,
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

    // 6) restinfoot webhook — fail ho to bhi Pub/Sub ko 200
    let wpStatus = 0;
    let wpData = null;
    try {
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
      wpStatus = wpRes.status;
      const wpText = await wpRes.text();
      try {
        wpData = wpText ? JSON.parse(wpText) : null;
      } catch (_) {
        wpData = { raw: wpText };
      }
    } catch (wpErr) {
      console.error('[gmailwebhook] wp hook error', wpErr.message);
      wpData = { success: false, message: wpErr.message };
    }

    return res.status(200).json({
      success: true,
      count: messages.length,
      historyId: newestHistoryId,
      wp_status: wpStatus,
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
