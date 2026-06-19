const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
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

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server is running on http://localhost:' + PORT);
});
