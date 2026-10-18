/**
 * Platform Commission Calculation Service
 */
const DEFAULT_COMMISSION_PERCENTAGE = 10.0; // 10% default platform fee

const calculatePlatformCommission = (subtotalAmount, commissionPercentage = DEFAULT_COMMISSION_PERCENTAGE) => {
  const amount = parseFloat(subtotalAmount) || 0;
  const percentage = parseFloat(commissionPercentage) || DEFAULT_COMMISSION_PERCENTAGE;
  const commission = (amount * percentage) / 100;
  return parseFloat(commission.toFixed(2));
};

module.exports = {
  calculatePlatformCommission,
  DEFAULT_COMMISSION_PERCENTAGE
};
