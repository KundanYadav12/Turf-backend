class PaymentGatewayInterface {
  async createOrder({ bookingId, amount, currency }) {
    throw new Error('Method createOrder() must be implemented.');
  }

  async verifyPayment({ transactionReference, paymentDetails }) {
    throw new Error('Method verifyPayment() must be implemented.');
  }

  async processRefund({ paymentId, amount, reason }) {
    throw new Error('Method processRefund() must be implemented.');
  }
}

module.exports = PaymentGatewayInterface;
