import express from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { authenticate } from '../middleware/auth.js';
import config from '../config/config.js';

const router = express.Router();

const getRazorpayClient = () => {
  const { keyId, keySecret } = config.razorpay || {};
  if (!keyId || !keySecret) {
    throw new Error('Razorpay keys are not configured');
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

router.post('/create-order', authenticate, async (req, res) => {
  try {
    const { amount, receipt } = req.body;
    const parsedAmount = Number(amount);

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    const razorpay = getRazorpayClient();
    const order = await razorpay.orders.create({
      amount: Math.round(parsedAmount),
      currency: 'INR',
      receipt: receipt || `rcpt_${Date.now()}`
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      keyId: config.razorpay.keyId
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

router.post('/verify-payment', authenticate, async (req, res) => {
  try {
    const { razorpay_signature, razorpay_payment_id, razorpay_order_id } = req.body;

    if (!razorpay_signature || !razorpay_payment_id || !razorpay_order_id) {
      return res.status(400).json({ error: 'Payment verification fields are required' });
    }

    const { keySecret } = config.razorpay || {};
    if (!keySecret) {
      return res.status(500).json({ error: 'Razorpay keys are not configured' });
    }

    const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto.createHmac('sha256', keySecret).update(payload).digest('hex');
    const verified = expectedSignature === razorpay_signature;

    if (!verified) {
      return res.status(400).json({ verified: false, error: 'Invalid signature' });
    }

    res.json({ verified: true });
  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

export default router;
