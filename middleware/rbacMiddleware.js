const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized access.'
      });
    }

    const userRole = req.user.role;
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden. Role '${userRole}' does not have required permission.`
      });
    }

    next();
  };
};

module.exports = {
  authorizeRoles
};
