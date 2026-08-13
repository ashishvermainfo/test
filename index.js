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
 * Cron → turant response, tracking + WP webhook background mein
 */
async function delhiveryTrackingJob(ordersIn, type) {
  console.log('[dehlivery_tracking] bg start', type, 'orders=', ordersIn.length);
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

const WP_AMAZON_HOOK = 'https://restinfoot.com/wp-json/appcron/v1/amazon_tracking';
const WP_XPRESSBEE_HOOK = 'https://restinfoot.com/wp-json/appcron/v1/xpressbee_tracking';

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

const WP_SEND_MAIL_HOOK = 'https://restinfoot.com/wp-json/appcron/v1/send_mail';
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
  const orderId = Number(row.order_id || 0);
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
        order_id: Number(row.order_id || 0),
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
let isProcessingGmail = false;
let pendingMailQueue = [];
let mailFlushTimer = null;
let isFlushingMail = false;

function queueMailMessagesForWordPress(newMessages, emailAddress, newestHistoryId) {
  if (!Array.isArray(newMessages) || !newMessages.length) return;

  const existingIds = new Set(pendingMailQueue.map((m) => m.msg_id));
  for (const msg of newMessages) {
    if (msg && msg.msg_id && !existingIds.has(msg.msg_id)) {
      pendingMailQueue.push(msg);
      existingIds.add(msg.msg_id);
    }
  }

  // Schedule 1-minute batch flush to restinfoot WordPress webhook
  if (!mailFlushTimer && pendingMailQueue.length > 0) {
    mailFlushTimer = setTimeout(() => {
      mailFlushTimer = null;
      runInBackground(flushMailQueueToWordPress(emailAddress, newestHistoryId));
    }, 60000);
  }
}

async function flushMailQueueToWordPress(emailAddress, newestHistoryId) {
  if (isFlushingMail || !pendingMailQueue.length) return;
  isFlushingMail = true;

  const messagesToSend = [...pendingMailQueue];
  pendingMailQueue = [];

  try {
    console.log(`[gmailwebhook] Flushing batch of ${messagesToSend.length} mail messages to WordPress...`);
    const wpRes = await fetch(WP_HOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        source: 'node-gmail',
        emailAddress: emailAddress || MY_EMAIL,
        historyId: newestHistoryId || lastHistoryId,
        messages: messagesToSend,
      }),
    });
    const wpText = await wpRes.text();
    console.log(`[gmailwebhook] WordPress response status: ${wpRes.status}, body: ${wpText.substring(0, 200)}`);
  } catch (wpErr) {
    console.error('[gmailwebhook] wp hook error:', wpErr.message);
    // Re-queue un-sent messages if request failed
    pendingMailQueue.unshift(...messagesToSend);
  } finally {
    isFlushingMail = false;
    if (pendingMailQueue.length > 0 && !mailFlushTimer) {
      mailFlushTimer = setTimeout(() => {
        mailFlushTimer = null;
        runInBackground(flushMailQueueToWordPress(emailAddress, newestHistoryId));
      }, 60000);
    }
  }
}

async function processGmailWebhook(historyId, emailAddress) {
  if (isProcessingGmail) {
    console.log('[gmailwebhook] Already processing a history batch, skipping concurrent run');
    return;
  }
  isProcessingGmail = true;

  try {
    const gmail = getGmailClient();

    if (!lastHistoryId) {
      const profile = await gmail.users.getProfile({ userId: 'me' });
      lastHistoryId = String((profile.data && profile.data.historyId) || historyId);
      console.log('[gmailwebhook] Seeded lastHistoryId:', lastHistoryId);
      return;
    }

    const startId = lastHistoryId;
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
      const isNotFound =
        e.code === 404 ||
        e.code === '404' ||
        e.status === 404 ||
        (e.response && e.response.status === 404) ||
        (e.message && e.message.includes('Requested entity was not found'));
      if (isNotFound) {
        const profile = await gmail.users.getProfile({ userId: 'me' });
        lastHistoryId = String((profile.data && profile.data.historyId) || historyId);
        console.log('[gmailwebhook] History ID expired/not found, reset historyId to latest:', lastHistoryId);
        return;
      }
      throw e;
    }

    lastHistoryId = newestHistoryId;
    if (!msgIds.size) {
      console.log('[gmailwebhook] No new messages found in history range');
      return;
    }

    const messages = [];
    for (const id of msgIds) {
      let full;
      try {
        full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      } catch (getErr) {
        console.warn(`[gmailwebhook] Skipping message ${id} (not found or deleted):`, getErr.message);
        continue;
      }
      const msg = full ? full.data : null;
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

    if (messages.length) {
      queueMailMessagesForWordPress(messages, emailAddress, newestHistoryId);
    }
  } catch (err) {
    console.error('[gmailwebhook] error', err.message);
  } finally {
    isProcessingGmail = false;
  }
}

// Pub/Sub → Gmail → Queue in Node → restinfoot POST every 1 min → Pub/Sub gets 200 OK immediately
app.post('/gmailwebhook', (req, res) => {
  try {
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

    // 1) Google Pub/Sub ko turant 200 OK return karo
    res.status(200).json({ success: true, message: 'accepted', historyId });

    // 2) Background worker me Gmail history check & 1-minute batch queue me insert karo
    runInBackground(processGmailWebhook(historyId, emailAddress));
  } catch (err) {
    console.error('[gmailwebhook] express error', err.message);
    if (!res.headersSent) {
      res.status(200).json({ success: false, message: err.message });
    }
  }
});

// Call Log Queue with Smart 2-Min Idle Debounce & 5-Min Max Cap Flush
const WP_CALL_LOG_HOOK = 'https://restinfoot.com/wp-json/call-log/v1/node-webhook';
let callLogQueue = [];
let callLogDebounceTimer = null; // 2 min idle timer
let callLogMaxTimer = null;      // 5 min max cap timer

async function sendCallLogsToWP() {
  if (callLogDebounceTimer) { clearTimeout(callLogDebounceTimer); callLogDebounceTimer = null; }
  if (callLogMaxTimer) { clearTimeout(callLogMaxTimer); callLogMaxTimer = null; }

  if (!callLogQueue.length) return;
  const logs = [...callLogQueue];
  callLogQueue = [];
  try {
    const res = await fetch(WP_CALL_LOG_HOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ source: 'node-call-log', logs }),
    });
    const text = await res.text();
    console.log('[calllogwebhook] Sent batch of', logs.length, 'logs to WP, status:', res.status, text.substring(0, 100));
    if (!res.ok) {
      callLogQueue.unshift(...logs);
    }
  } catch (err) {
    console.error('[calllogwebhook] error', err.message, err.cause ? (err.cause.message || err.cause) : '');
    callLogQueue.unshift(...logs);
  }
}

function normalizePhone(val) {
  const digits = String(val || '').replace(/\D+/g, '');
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
}

app.post(['/calllogwebhook'], (req, res) => {
  res.status(200).json({ success: true, message: 'accepted' });

  runInBackground(
    Promise.resolve().then(() => {
      const data = req.body || {};
      const spUser = normalizePhone(data.user || data.salesperson_number);
      const list = Array.isArray(data.calls) ? data.calls : Array.isArray(data.logs) ? data.logs : [data];

      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const user = normalizePhone(item.user) || spUser;
        const number = normalizePhone(item.number || item.customer_number);
        const timestamp = Number(item.timestamp || item.call_timestamp || 0);
        if (user && number && timestamp) {
          callLogQueue.push({
            user,
            number,
            status: String(item.status || item.type || 'unknown'),
            duration: Number(item.duration || 0),
            timestamp,
          });
        }
      }

      if (callLogQueue.length > 0) {
        // 1) 2 min idle (debounce) timer — jab bhi naye hit aayenge ye reset hoga
        if (callLogDebounceTimer) clearTimeout(callLogDebounceTimer);
        callLogDebounceTimer = setTimeout(() => runInBackground(sendCallLogsToWP()), 120000);

        // 2) 5 min max cap timer — agar continuous hits aate rahein to max 5 min me bhej dega
        if (!callLogMaxTimer) {
          callLogMaxTimer = setTimeout(() => runInBackground(sendCallLogsToWP()), 300000);
        }
      }
    })
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server is running on http://localhost:' + PORT);
});
