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
const WP_HOOK = 'https://api.restinfoot.com/webhook/gmail-hook.php';

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

const WP_DELHIVERY_HOOK = 'https://api.restinfoot.com/webhook/delhivery-hook.php';

/** Same as appcron copy: status + tracking_states + edd */
async function delhiveryFetchAwb(awb) {
  const url = 'https://dlv-api.delhivery.com/v3/unified-tracking?wbn=' + encodeURIComponent(awb);
  const res = await fetch(url, {
    method: 'GET',
    headers: { origin: 'https://www.delhivery.com', Accept: 'application/json' },
  });
  const data = await res.json().catch(() => null);
  if (!data || !data.data || !data.data[0] || (!data.data[0].status && !data.data[0].hqStatus)) {
    return { awb, status: '', tracking_states: [], edd: '', error: 'Invalid API response' };
  }
  const row = data.data[0];
  let status = String(
    (row.status && typeof row.status === 'object' && row.status.status) ||
    (typeof row.status === 'string' && row.status) ||
    row.hqStatus ||
    (row.status && (row.status.instructions || row.status.statusType)) ||
    ''
  ).trim();

  if (/^in[\s_-]?transit$/i.test(status)) {
    status = 'IN_TRANSIT';
  } else if (/^(out[\s_-]?for[\s_-]?delivery|out[\s_-]?delivery|ofd)$/i.test(status)) {
    status = 'OUT_DELIVERY';
  } else if (/^delivered$/i.test(status)) {
    status = 'DELIVERED';
  } else if (/^(reached[\s_-]?dest|reached[\s_-]?destination)/i.test(status)) {
    status = 'REACHED_DEST_CITY';
  }

  return {
    awb,
    status,
    tracking_states: Array.isArray(row.trackingStates) ? row.trackingStates : [],
    edd: String(row.promiseDeliveryDate || ''),
  };
}

/**
 * Cron → turant response, tracking + WP webhook background mein
 */
async function delhiveryTrackingJob(ordersIn, type) {
  console.log('[dehlivery_tracking] bg start', type, 'orders=', ordersIn.length);
  const out = [];
  for (const row of ordersIn) {
    if (!row || typeof row !== 'object') continue;
    const orderId = String(row.order_id || '').trim();
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

  if (!out.length) {
    console.log('[dehlivery_tracking] bg nothing to post', type);
    return;
  }

  const wpRes = await fetch(WP_DELHIVERY_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ orders: out, type }),
  });
  const wpBody = (await wpRes.text()).slice(0, 300);
  console.log('[dehlivery_tracking] bg done', type, 'tracked=', out.length, 'wp', wpRes.status, wpBody);
}

function runInBackground(promise) {
  const p = Promise.resolve(promise).catch((err) => {
    console.error('[bg] error', err && err.message ? err.message : err);
  });
  try {
    // Vercel: response ke baad process alive rakho
    const { waitUntil } = require('@vercel/functions');
    if (typeof waitUntil === 'function') {
      waitUntil(p);
      return;
    }
  } catch (_) { }
  // Local / long-running node
}

app.post('/dehlivery_tracking', (req, res) => {
  const body = req.body || {};
  const ordersIn = Array.isArray(body.orders) ? body.orders : [];
  const type = String(body.type || 'b2c');

  // Turant response — tracking baad mein
  res.status(200).json({
    success: true,
    message: 'accepted',
    count: ordersIn.length,
    type,
  });

  runInBackground(delhiveryTrackingJob(ordersIn, type));
});

const WP_AMAZON_HOOK = 'https://api.restinfoot.com/webhook/amazon-hook.php';
const WP_XPRESSBEE_HOOK = 'https://api.restinfoot.com/webhook/xpressbee-hook.php';

/** Same as appcron copy amazon_api_get_tracker_status → status + edd */
function amazonParseJsonMaybe(val) {
  if (val == null) return null;
  if (typeof val === 'object') return val;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function amazonPickEddFromMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return '';
  // expectedDeliveryDate first, else promisedDeliveryDate (same as PHP)
  const expected = String(
    (meta.expectedDeliveryDate && (meta.expectedDeliveryDate.date || meta.expectedDeliveryDate.dateString)) || ''
  ).trim();
  if (expected) return expected;
  return String(
    (meta.promisedDeliveryDate && (meta.promisedDeliveryDate.date || meta.promisedDeliveryDate.dateString)) || ''
  ).trim();
}

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

  const eventHistory = amazonParseJsonMaybe(data.eventHistory);
  if (!eventHistory || typeof eventHistory !== 'object') {
    return { awb, status: '', edd: '', error: 'Could not parse eventHistory' };
  }

  const summaryStatus = String((eventHistory.summary && eventHistory.summary.status) || '').trim();
  const events = Array.isArray(eventHistory.eventHistory) ? eventHistory.eventHistory : [];

  // EDD: progressTracker.summary.metadata OR eventHistory.summary.metadata
  // NOTE: metadata is OBJECT (not array) — PHP is_array() true for assoc, JS Array.isArray false
  let progress = amazonParseJsonMaybe(data.progressTracker);
  if (!progress) {
    progress = amazonParseJsonMaybe(eventHistory.progressTracker);
  }

  let promised = '';
  const metaBlocks = [];
  if (progress && progress.summary && progress.summary.metadata && typeof progress.summary.metadata === 'object') {
    metaBlocks.push(progress.summary.metadata);
  }
  if (eventHistory.summary && eventHistory.summary.metadata && typeof eventHistory.summary.metadata === 'object') {
    metaBlocks.push(eventHistory.summary.metadata);
  }
  for (const meta of metaBlocks) {
    const edd = amazonPickEddFromMeta(meta);
    if (edd) {
      promised = edd;
      break;
    }
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

async function amazonTrackingJob(ordersIn) {
  console.log('[amazon-tracking] bg start orders=', ordersIn.length);
  const out = [];
  for (const row of ordersIn) {
    if (!row || typeof row !== 'object') continue;
    const orderId = String(row.order_id || '').trim();
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

  if (!out.length) {
    console.log('[amazon-tracking] bg nothing to post');
    return;
  }

  const wpRes = await fetch(WP_AMAZON_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ orders: out }),
  });
  console.log('[amazon-tracking] bg done tracked=', out.length, 'wp', wpRes.status, (await wpRes.text()).slice(0, 300));
}

app.post('/amazon-tracking', (req, res) => {
  const ordersIn = Array.isArray((req.body || {}).orders) ? req.body.orders : [];
  res.status(200).json({
    success: true,
    message: 'accepted',
    count: ordersIn.length,
  });
  runInBackground(amazonTrackingJob(ordersIn));
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

async function xpressbeeTrackingJob(ordersIn) {
  console.log('[xpressbee-tracking] bg start orders=', ordersIn.length);
  const ch = await solveAltchaToken();
  const token = String(ch.token || '');
  if (!token) {
    console.error('[xpressbee-tracking] bg no altcha token');
    return;
  }

  const out = [];
  for (const row of ordersIn) {
    if (!row || typeof row !== 'object') continue;
    const orderId = String(row.order_id || '').trim();
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

  if (!out.length) {
    console.log('[xpressbee-tracking] bg nothing to post');
    return;
  }

  const wpRes = await fetch(WP_XPRESSBEE_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ orders: out }),
  });
  console.log('[xpressbee-tracking] bg done tracked=', out.length, 'wp', wpRes.status, (await wpRes.text()).slice(0, 300));
}

app.post('/xpressbee-tracking', (req, res) => {
  const ordersIn = Array.isArray((req.body || {}).orders) ? req.body.orders : [];
  res.status(200).json({
    success: true,
    message: 'accepted',
    count: ordersIn.length,
  });
  runInBackground(xpressbeeTrackingJob(ordersIn));
});

const WP_SEND_MAIL_HOOK = 'https://api.restinfoot.com/webhook/send-mail-hook.php';
const MAIL_FROM_NAME = 'vivek agarwal';

function getGmailClient() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

function parseMailList(raw) {
  const out = [];
  for (const part of String(raw || '').split(/[,;]+/)) {
    const e = part.trim().toLowerCase();
    if (e && e.includes('@')) out.push(e);
  }
  return [...new Set(out)];
}

function encodeMailHeader(v) {
  const s = String(v || '');
  return /[^\x20-\x7E]/.test(s) ? '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=' : s;
}

function toBase64Url(data) {
  return Buffer.from(data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function gmailHdr(headers, name) {
  const n = String(name || '').toLowerCase();
  for (const h of headers || []) {
    if (String(h.name || '').toLowerCase() === n) return String(h.value || '');
  }
  return '';
}

/**
 * One mail via Gmail API (new | reply). Same idea as PHP send_mail_dispatch.
 */
async function sendOneGmail(gmail, row) {
  const orderId = String(row.order_id || '').trim();
  const toList = parseMailList(row.to);
  const ccList = parseMailList(row.cc);
  const bccList = parseMailList(row.bcc);
  const subject = String(row.subject || '').trim();
  const body = String(row.body || '');
  let mailType = String(row.mail_type || 'new').toLowerCase();
  if (!['new', 'reply', 'forward'].includes(mailType)) mailType = 'new';
  let threadId = String(row.thread_id || '').trim();
  const courier = String(row.courier || '').trim();
  const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
  const irt = String(row.in_reply_to || '').trim();
  const refs = String(row.references || '').trim();

  const base = {
    order_id: orderId,
    courier,
    meta,
    mail_type: mailType,
    subject,
    body,
    mail_to: toList.join(', '),
    mail_cc: ccList.join(', '),
    mail_bcc: bccList.join(', '),
    mail_from: MY_EMAIL,
  };

  if (!orderId || !toList.length || !subject || !body.replace(/<[^>]*>/g, '').trim()) {
    return { ...base, ok: false, thread_id: threadId, msg_id: '', rfc_message_id: '', error: 'order_id/to/subject/body required' };
  }

  const hdr = [
    'From: ' + encodeMailHeader(MAIL_FROM_NAME) + ' <' + MY_EMAIL + '>',
    'To: ' + toList.join(', '),
    'Subject: ' + encodeMailHeader(subject),
    'MIME-Version: 1.0',
  ];
  if (ccList.length) hdr.push('Cc: ' + ccList.join(', '));
  if (bccList.length) hdr.push('Bcc: ' + bccList.join(', '));
  if (irt) {
    hdr.push('In-Reply-To: ' + irt);
    hdr.push('References: ' + (refs || irt));
  }
  hdr.push('Content-Type: text/html; charset=UTF-8');
  hdr.push('Content-Transfer-Encoding: base64');

  const b64body = Buffer.from(body, 'utf8').toString('base64');
  const raw = hdr.join('\r\n') + '\r\n\r\n' + (b64body.match(/.{1,76}/g) || [b64body]).join('\r\n');

  const payload = { raw: toBase64Url(raw) };
  if (mailType === 'reply' && threadId) payload.threadId = threadId;

  const sent = await gmail.users.messages.send({ userId: 'me', requestBody: payload });
  const msgId = String((sent.data && sent.data.id) || '');
  threadId = String((sent.data && sent.data.threadId) || threadId);
  if (!msgId) {
    return { ...base, ok: false, thread_id: threadId, msg_id: '', rfc_message_id: '', error: 'No message id from Gmail' };
  }

  let rfc = '';
  try {
    const full = await gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' });
    const headers = (full.data && full.data.payload && full.data.payload.headers) || [];
    rfc = gmailHdr(headers, 'Message-ID');
  } catch (_) { }

  return {
    ...base,
    ok: true,
    thread_id: threadId,
    msg_id: msgId,
    rfc_message_id: rfc,
    error: '',
  };
}

/**
 * Cron → turant accept; Gmail send + WP webhook background
 * body.orders[]: order_id, to, cc, bcc, subject, body, mail_type, thread_id, courier, meta
 */
async function sendMailJob(ordersIn, type) {
  console.log('[send_mail] bg start', type, 'orders=', ordersIn.length);
  const gmail = getGmailClient();
  const out = [];
  for (const row of ordersIn) {
    if (!row || typeof row !== 'object') continue;
    try {
      out.push(await sendOneGmail(gmail, row));
    } catch (e) {
      out.push({
        order_id: String(row.order_id || '').trim(),
        ok: false,
        thread_id: String(row.thread_id || ''),
        msg_id: '',
        rfc_message_id: '',
        courier: String(row.courier || ''),
        meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
        mail_type: String(row.mail_type || 'new'),
        subject: String(row.subject || ''),
        body: String(row.body || ''),
        mail_to: String(row.to || ''),
        mail_cc: String(row.cc || ''),
        mail_bcc: String(row.bcc || ''),
        mail_from: MY_EMAIL,
        error: e.message || 'send failed',
      });
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!out.length) {
    console.log('[send_mail] bg nothing to post', type);
    return;
  }

  const wpRes = await fetch(WP_SEND_MAIL_HOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ orders: out, type }),
  });
  const wpBody = (await wpRes.text()).slice(0, 300);
  console.log('[send_mail] bg done', type, 'sent=', out.length, 'wp', wpRes.status, wpBody);
}

app.post('/send_mail', (req, res) => {
  const body = req.body || {};
  const ordersIn = Array.isArray(body.orders) ? body.orders : [];
  const type = String(body.type || '');

  res.status(200).json({
    success: true,
    message: 'accepted',
    count: ordersIn.length,
    type,
  });

  runInBackground(sendMailJob(ordersIn, type));
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
    const gmail = getGmailClient();

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
      const atts = [];

      const walk = (part) => {
        if (!part) return;
        const mime = String(part.mimeType || '').toLowerCase();
        const headers = Array.isArray(part.headers) ? part.headers : [];
        const getPartHdr = (hName) => {
          const hn = hName.toLowerCase();
          for (const h of headers) {
            if (String(h.name || '').toLowerCase() === hn) return String(h.value || '');
          }
          return '';
        };

        const cidRaw = getPartHdr('Content-ID') || getPartHdr('X-Attachment-Id');
        const cleanCid = cidRaw.replace(/^<|>$/g, '').trim();

        // 1) Text / HTML body extraction
        if (part.body && part.body.data && !part.filename && !cleanCid) {
          let s = String(part.body.data).replace(/-/g, '+').replace(/_/g, '/');
          while (s.length % 4) s += '=';
          const text = Buffer.from(s, 'base64').toString('utf8');
          if (mime === 'text/html') html = html ? (html + '<br>' + text) : text;
          if (mime === 'text/plain') plain = plain ? (plain + '\n' + text) : text;
        }

        // 2) Attachments & Inline Images extraction
        if (part.filename || (part.body && part.body.attachmentId) || cleanCid) {
          const fn = String(part.filename || cleanCid || 'attachment').trim();
          atts.push({
            id: String((part.body && part.body.attachmentId) || ''),
            filename: fn,
            mimeType: part.mimeType || 'application/octet-stream',
            size: Number((part.body && part.body.size) || 0),
            cid: cleanCid,
          });
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
      console.log(`[gmailwebhook] WordPress response status: ${wpStatus}`);
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

// Call Log & Meta Leads Firestore (mudrafinance-a404e Service Account)
const mudraServiceAccount = {
  type: 'service_account',
  project_id: 'mudrafinance-a404e',
  private_key_id: '32acb338ddfa16da8d433c70a5430480275a525f',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC4ave8YL9/6qpR\nFqo8LF/IEAOL7+nmyPDMPlMGmccWWAJmWPqSkqWHdsOqdVBc3+OM3eQosTUS9s/H\nBv7wcX2Wv0vhjKv9qF+IcD6QWiN3CPwmrSJwsOIm9YEs63KCISk9mTBFsT71Kmd0\ncsVDuTw25w6qSXg0Rq8l+eJ70/zpD4AAvTQN6Sh7ZC23TfBLItUQnp2HNKbMBZU4\nPb1V04Ayu8pvA6epvzxV45ENVUnEReTRN4VDxWEtfzlhM7w3N2umOIIl4L4xhUUp\nxBTNCLo5shL6IbEyNC1kjCicy+usAiKHRaWKRfOF1N9uLR6qUj+wPrkLV2DsCCNT\newUVMKj1AgMBAAECggEADL7r31uqcJtV6SPRYTZJ6mhc7mOG/Xne1qbqExc2wM8V\nX2B/9Phos1uce1//TWP19KrzVXKl8ekYBC/yF8koPm57Ppv72Ry1eZcUY+Ku98+p\nqbymmDZJcxrdsi6Vq/PBx22aff6ZlNU48D3sb1lSlZLTmyZXxfkqqsvCAP/uR2c6\nH93Yr+3ML1A/yogwJKJhiJuiKh1HP4zxb/nfjbg/SPUYqyhsKJnxYygj+nQFsLCP\nBJKOizYvZJ2CBzzuUelJ6xxGul2cEMy336y6KmLte71TNMur1fpoLq8ji4BW7SxC\n9EKTdC3PQzNAvBFXtIUjFOR1SWBYfRl/Ctv3Vpu1QwKBgQDyxSdjdWF3uYaU2JUn\nEIeN/7976Aq6x1nrrWXuMiJiTXf/XzgudAYIAzAHwKu2jRz0LOHSp26ZpZs8VVHT\nah6dF1jKtiUE/jYkl7XJ2WcAE7z80xySbnM+UVhGwpEsWgjcjMOgc0cYDnE0qKix\nxcBtPDdakrIW+Ndeq8j4NnPALwKBgQDCd8AsHJ1GKEfYhaZoXdDuq/oTQIbnBqqI\nV6Xm1/fvHXNnH3H8q5Y4W8VcOIN5O7lN8kT2MQahZGcTIZZ7eats1/DvfqKTnu6r\nN1aPgIbcKbLLJU2Y+irIoypC27vW4z5cIe2BeO1Px9elf0nxEZ+p0JqIY5XIPk3l\nN8Knz53cGwKBgQCKaITQW3e6PnfQHLrMjsv51TlidyTG4CkQCMf4SXT4/pnPaoYp\nVdSqdMbJZLuBVGqRe5Uz+GlCB/y9JReFpRbXERx6VeY9NoG/0w69ickDbj1tFx9P\nDNF/Ufk2Pm9uDdbHhylxLMf3myRHlXC4CbpvjMkyRjhqiGyheOcXPFQ52QKBgCjV\nPjvE8l0l3hgf0BZABLvozoS2Wt0tsCcayFIVbRD/TRkNKEEWwl8pHeLEVw7gtIMi\naMqM9shyrZX9ynw4yv76xLN1EqwOhizbXMibAzY9ZzZyqb2CYfNpF1mci++OHaz4\nzscN3j6PRr+QX7VHrw/YJmqXBn9aXb7Qm4Xi+VGbAoGAAN++TIrR6yANBwGEAvGy\n0648O7A9Eyneur/UZGmtwUhO/751GtTSd+yijfvW1j3NI3Ies1ym8PKvmpJpkyB1\nvNjNVZh8mERrdYBMisFH/BHRGRn7SnMVX5nHVT7AlLzfh9QZ4SpschqPjJYs0FUI\nty3jsM7gFGPyJLK64CRHOHQ=\n-----END PRIVATE KEY-----\n',
  client_email: 'firebase-adminsdk-fbsvc@mudrafinance-a404e.iam.gserviceaccount.com',
};

const mudraFirestore = new Firestore({
  projectId: mudraServiceAccount.project_id,
  credentials: {
    type: mudraServiceAccount.type,
    project_id: mudraServiceAccount.project_id,
    client_email: mudraServiceAccount.client_email,
    private_key: mudraServiceAccount.private_key,
  },
});

const CALL_LOGS_COLLECTION = 'call_logs_queue';
const WP_CALL_LOG_HOOK = 'https://api.restinfoot.com/webhook/call-log-hook.php';

function normalizePhone(val) {
  const digits = String(val || '').replace(/\D+/g, '');
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// 1) POST /calllogwebhook: Data aya -> 0 index ko direct Firestore (mudrafinance-a404e) main save
app.post(['/calllogwebhook'], async (req, res) => {
  try {
    const data = req.body || {};
    const spUser = normalizePhone(data.user || data.salesperson_number);
    const list = Array.isArray(data.calls) ? data.calls : Array.isArray(data.logs) ? data.logs : [data];
    const item = list[0] || {};

    const user = normalizePhone(item.user) || spUser;
    const number = normalizePhone(item.number || item.customer_number);
    const timestamp = Number(item.timestamp || item.call_timestamp || 0);
    const status = String(item.status || item.type || 'unknown').toLowerCase().trim();
    const duration = Number(item.duration || 0);

    // Skip storing outgoing calls with 0 duration
    if (status === 'outgoing' && duration <= 0) {
      return res.status(200).json({ success: true, message: 'skipped (outgoing duration 0)' });
    }

    if (user && number && timestamp) {
      const docId = `${user}_${number}_${timestamp}`;
      await mudraFirestore.collection(CALL_LOGS_COLLECTION).doc(docId).set({
        user,
        number,
        status,
        duration,
        timestamp,
      });
      return res.status(200).json({ success: true, message: 'saved', docId });
    }

    return res.status(200).json({ success: false, message: 'invalid data' });
  } catch (err) {
    console.error('[calllogwebhook] Error:', err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
});

async function flushCallLogsBackground(docs, logs) {
  if (!docs || !docs.length || !logs || !logs.length) return;
  try {
    // Filter out outgoing calls with duration 0 before sending to WordPress
    const validLogs = logs.filter((log) => {
      const status = String(log.status || log.type || '').toLowerCase().trim();
      const duration = Number(log.duration || 0);
      return !(status === 'outgoing' && duration <= 0);
    });

    if (validLogs.length > 0) {
      console.log(`[flushwebhook] Posting ${validLogs.length} call logs (${logs.length - validLogs.length} outgoing 0-dur skipped) to WordPress in background...`);
      const wpRes = await fetch(WP_CALL_LOG_HOOK, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: JSON.stringify({ source: 'node-call-log', logs: validLogs }),
      });

      const wpText = await wpRes.text();
      console.log('[flushwebhook] WordPress status:', wpRes.status, wpText.substring(0, 100));

      if (wpRes.ok) {
        for (const doc of docs) {
          await doc.ref.delete();
        }
        console.log(`[flushwebhook] Deleted ${docs.length} call log docs from Firestore (mudrafinance-a404e)`);
      } else {
        console.error('[flushwebhook] WP post failed:', wpRes.status, wpText);
      }
    } else {
      // All docs in this batch are outgoing with 0 duration: skip WP post, directly delete from Firestore
      console.log(`[flushwebhook] All ${docs.length} call logs are outgoing 0-dur. Deleting directly from Firestore...`);
      for (const doc of docs) {
        await doc.ref.delete();
      }
      console.log(`[flushwebhook] Deleted ${docs.length} call log docs from Firestore (mudrafinance-a404e)`);
    }
  } catch (err) {
    console.error('[flushwebhook] Error in background:', err.message);
  }
}

// 2) GET /flushwebhook & /flushcall: Firestore ki entries get -> Immediate response -> Restinfoot POST & Delete in background
app.get(['/flushwebhook', '/flushcall', '/flushwebhook/:count', '/flushcall/:count'], async (req, res) => {
  try {
    const rawCount = req.query.count ?? req.params.count;
    const parsedCount = parseInt(rawCount, 10);
    const limitCount = Number.isInteger(parsedCount) && parsedCount > 0 ? parsedCount : 20;

    const snapshot = await mudraFirestore.collection(CALL_LOGS_COLLECTION).limit(limitCount).get();
    if (snapshot.empty) {
      return res.status(200).json({ success: true, message: 'empty', count: 0, limit: limitCount });
    }

    const docs = snapshot.docs;
    const logs = docs.map((doc) => doc.data());

    // Immediate response
    res.status(200).json({
      success: true,
      message: 'flushing in background',
      count: docs.length,
      limit: limitCount,
    });

    // Run sync & delete in background
    runInBackground(flushCallLogsBackground(docs, logs));
  } catch (err) {
    console.error('[flushwebhook] Error:', err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
});

// Meta Leads Webhook & Flush Leads (mudrafinance-a404e Firestore)
const META_LEADS_COLLECTION = 'meta_leads_queue';
const WP_META_LEAD_HOOK = 'https://api.restinfoot.com/webhook/meta-lead-hook.php';

function extractLeadItem(raw) {
  if (!raw || typeof raw !== 'object') return null;

  let item = raw;
  if (raw.entry && Array.isArray(raw.entry) && raw.entry[0]?.changes && Array.isArray(raw.entry[0].changes)) {
    item = raw.entry[0].changes[0]?.value || raw;
  }

  // Handle Facebook Lead Ads field_data array if present
  if (Array.isArray(item.field_data)) {
    const fd = {};
    for (const f of item.field_data) {
      if (f && f.name) {
        const val = Array.isArray(f.values) ? f.values[0] : f.value || '';
        fd[String(f.name).toLowerCase()] = val;
      }
    }
    item = { ...item, ...fd };
  }

  const metaId = String(item.meta_id || item.id || item.leadgen_id || item.lead_id || '').trim();
  const name = String(item.name || item.full_name || item.customer_name || '').trim();
  const phoneNo = normalizePhone(item.phone_no || item.phone || item.mobile || item.phone_number || item.contact_no);
  const whatsNo = normalizePhone(item.whats_no || item.whatsapp || item.whatsapp_no || item.whatsapp_number) || phoneNo;
  const store = String(item.store || '').toLowerCase().trim() === 'yes' ? 'yes' : 'no';
  const storeName = String(item.store_name || item.shop_name || item.business_name || '').trim();
  const state = String(item.state || '').trim();
  const city = String(item.city || '').trim();
  const timestamp = item.timestamp || item.created_time || item.created_at || new Date().toISOString();

  if (metaId || phoneNo) {
    return {
      meta_id: metaId || (phoneNo ? `${phoneNo}_${Date.now()}` : `${Date.now()}`),
      name,
      phone_no: phoneNo,
      whats_no: whatsNo,
      store,
      store_name: storeName,
      state,
      city,
      timestamp,
      raw_payload: typeof item === 'object' ? item : {},
    };
  }
  return null;
}

// 1) POST /metaleadwebhook: Lead aayi -> Firestore collection (meta_leads_queue) main save
app.post(['/metaleadwebhook'], async (req, res) => {
  try {
    const data = req.body || {};
    let items = [];

    if (Array.isArray(data)) {
      items = data;
    } else if (Array.isArray(data.leads)) {
      items = data.leads;
    } else if (Array.isArray(data.entry)) {
      items = [data];
    } else {
      items = [data];
    }

    const savedDocs = [];
    for (const raw of items) {
      const lead = extractLeadItem(raw);
      if (lead && lead.meta_id) {
        const docId = String(lead.meta_id);
        await mudraFirestore.collection(META_LEADS_COLLECTION).doc(docId).set(lead);
        savedDocs.push(docId);
      }
    }

    if (savedDocs.length > 0) {
      return res.status(200).json({
        success: true,
        message: 'saved',
        count: savedDocs.length,
        docIds: savedDocs,
      });
    }

    return res.status(200).json({ success: false, message: 'invalid or empty lead data' });
  } catch (err) {
    console.error('[metaleadwebhook] Error:', err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
});

async function flushMetaLeadsBackground(docs, leads) {
  if (!docs || !docs.length || !leads || !leads.length) return;
  try {
    console.log(`[flushlead] Posting ${leads.length} meta leads to WordPress in background...`);
    const wpRes = await fetch(WP_META_LEAD_HOOK, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ source: 'node-meta-lead', leads }),
    });

    const wpText = await wpRes.text();
    console.log('[flushlead] WordPress status:', wpRes.status, wpText.substring(0, 100));

    if (wpRes.ok) {
      for (const doc of docs) {
        await doc.ref.delete();
      }
      console.log(`[flushlead] Deleted ${docs.length} meta lead docs from Firestore (mudrafinance-a404e)`);
    } else {
      console.error('[flushlead] WP post failed:', wpRes.status, wpText);
    }
  } catch (err) {
    console.error('[flushlead] Error in background:', err.message);
  }
}

// 2) GET /flushlead & /flushleads: Firestore ki leads get -> Immediate response -> WordPress meta-lead-hook POST & Delete in background
app.get(['/flushlead', '/flushleads', '/flushlead/:count', '/flushleads/:count'], async (req, res) => {
  try {
    const rawCount = req.query.count ?? req.params.count;
    const parsedCount = parseInt(rawCount, 10);
    const limitCount = Number.isInteger(parsedCount) && parsedCount > 0 ? parsedCount : 20;

    const snapshot = await mudraFirestore.collection(META_LEADS_COLLECTION).limit(limitCount).get();
    if (snapshot.empty) {
      return res.status(200).json({ success: true, message: 'empty', count: 0, limit: limitCount });
    }

    const docs = snapshot.docs;
    const leads = docs.map((doc) => doc.data());

    // Immediate response
    res.status(200).json({
      success: true,
      message: 'flushing in background',
      count: docs.length,
      limit: limitCount,
    });

    // Run sync & delete in background
    runInBackground(flushMetaLeadsBackground(docs, leads));
  } catch (err) {
    console.error('[flushlead] Error:', err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server is running on http://localhost:' + PORT);
});
