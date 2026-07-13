const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const crypto = require('crypto');
const { Firestore } = require('@google-cloud/firestore');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const firestore = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT_ID,
  credentials: {
    type: 'service_account',
    project_id: process.env.FIRESTORE_PROJECT_ID,
    client_email: process.env.FIRESTORE_CLIENT_EMAIL,
    private_key: process.env.FIRESTORE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
});

app.post('/webhook', async (req, res) => {
  try {
    const webhookData = req.body;

    const phoneNo = String(webhookData.phone_no || '').replace(/\D+/g, '');
    const smsTo = String(webhookData.sms_to || '').trim();
    const smsBody = String(webhookData.sms_body || '').trim();

    if (phoneNo && smsTo && smsBody) {
      await firestore.collection('users').doc(phoneNo).collection('sendmsg').doc('send').set({
        SmsBody: smsBody,
        SmsTo: smsTo,
        send: 'yes',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Webhook processed successfully'
    });
  } catch (error) {
    return res.status(200).json({
      success: false,
      message: 'Internal Server Error',
      error: error.message
    });
  }
});

/** Solve ALTCHA: find n where hash(salt + n) === challenge */
function solveAltcha(data) {
  const challenge = String(data.challenge || '');
  const salt = String(data.salt || '');
  const max = Number(data.maxnumber) > 0 ? Number(data.maxnumber) : 100000;
  const algoRaw = String(data.algorithm || 'SHA-256').toUpperCase();
  const algo = algoRaw === 'SHA-1' ? 'sha1' : (algoRaw === 'SHA-512' ? 'sha512' : 'sha256');

  const start = Date.now();
  let number = null;
  for (let n = 0; n <= max; n++) {
    const hash = crypto.createHash(algo).update(salt + String(n)).digest('hex');
    if (hash === challenge) {
      number = n;
      break;
    }
  }
  if (number === null) {
    throw new Error('Could not solve challenge within maxnumber=' + max);
  }

  const took = Math.max(1, Date.now() - start);
  const payload = {
    algorithm: data.algorithm || 'SHA-256',
    challenge,
    number,
    salt,
    signature: data.signature || '',
    took,
  };

  return {
    payload,
    token: Buffer.from(JSON.stringify(payload)).toString('base64'),
  };
}

// ALTCHA: fetch challenge → solve → return token
app.get('/challenge', async (req, res) => {
  try {
    const response = await fetch('https://altcha-api.xbees.in/v1/challenge', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }
    if (!data || !data.challenge || !data.salt) {
      return res.status(502).json({ success: false, error: 'Invalid challenge response', data });
    }

    const solved = solveAltcha(data);

    return res.status(200).json({
      success: true,
      token: solved.token,
      number: solved.payload.number,
      took: solved.payload.took,
      payload: solved.payload,
      challenge: data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server is running on http://localhost:' + PORT);
});
