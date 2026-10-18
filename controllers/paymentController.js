const MockPaymentAdapter = require('../services/payment/mockPaymentAdapter');
const mockPaymentAdapter = new MockPaymentAdapter();

const createOrder = async (req, res, next) => {
  try {
    const { bookingId, amount } = req.body;
    if (!amount) {
      return res.status(400).json({ success: false, message: 'Amount is required.' });
    }

    const orderPayload = await mockPaymentAdapter.createOrder({ bookingId, amount });
    res.json({
      success: true,
      data: orderPayload
    });
  } catch (error) {
    next(error);
  }
};

const verifyPayment = async (req, res, next) => {
  try {
    const { transactionReference, paymentDetails } = req.body;
    const verification = await mockPaymentAdapter.verifyPayment({ transactionReference, paymentDetails });
    
    res.json({
      success: verification.success,
      data: verification
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createOrder,
  verifyPayment
};
