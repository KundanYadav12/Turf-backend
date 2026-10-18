const PaymentGatewayInterface = require('./paymentGateway.interface');

class MockPaymentAdapter extends PaymentGatewayInterface {
  async createOrder({ bookingId, amount, currency = 'INR' }) {
    const orderId = `order_mock_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    return {
      success: true,
      provider: 'RAZORPAY_MOCK',
      orderId: orderId,
      amount: amount,
      currency: currency,
      keyId: process.env.RAZORPAY_KEY_ID || 'mock_key_id'
    };
  }

  async verifyPayment({ transactionReference, paymentDetails }) {
    // Mock simulation: Always successful unless transactionReference contains 'fail'
    const isFailed = transactionReference && transactionReference.includes('fail');
    return {
      success: !isFailed,
      status: isFailed ? 'FAILED' : 'SUCCESS',
      transactionReference: transactionReference || `pay_mock_${Date.now()}`,
      gatewayResponse: {
        payment_id: `pay_mock_${Date.now()}`,
        status: isFailed ? 'failed' : 'captured',
        method: paymentDetails?.method || 'UPI',
        email: paymentDetails?.email || 'player@turf.com'
      }
    };
  }

  async processRefund({ paymentId, amount, reason }) {
    return {
      success: true,
      refundId: `rfnd_mock_${Date.now()}`,
      amount: amount,
      status: 'REFUNDED'
    };
  }
}

module.exports = MockPaymentAdapter;
