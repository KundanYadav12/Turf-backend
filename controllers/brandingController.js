const brandingService = require('../services/brandingService');

/**
 * GET /api/branding (Public)
 * Fetch current application branding (app name, tagline, logo, favicon)
 */
async function getPublicBranding(req, res, next) {
  try {
    const branding = await brandingService.getBranding();
    res.json({ success: true, data: branding });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/admin/branding (Superadmin / Admin)
 * Fetch current application branding with full administration details
 */
async function getAdminBranding(req, res, next) {
  try {
    const branding = await brandingService.getBranding(true);
    res.json({ success: true, data: branding });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/admin/branding (Superadmin / Admin)
 * Update application name, tagline, logo, or favicon
 */
async function updateBranding(req, res, next) {
  try {
    const { appName, appTagline, removeLogo, removeFavicon, contactEmail } = req.body;
    const logoFile = req.files?.logo?.[0] || null;
    const faviconFile = req.files?.favicon?.[0] || null;

    const updated = await brandingService.updateBranding({
      appName,
      appTagline,
      logoFile,
      faviconFile,
      removeLogo,
      removeFavicon,
      contactEmail,
      user: req.user,
      ipAddress: req.ip || req.headers['x-forwarded-for'] || null
    });

    res.json({
      success: true,
      message: 'Application branding updated successfully.',
      data: updated
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/admin/branding/reset (Superadmin / Admin)
 * Reset application name and logo to default system branding
 */
async function resetBranding(req, res, next) {
  try {
    const reset = await brandingService.resetBranding({
      user: req.user,
      ipAddress: req.ip || req.headers['x-forwarded-for'] || null
    });

    res.json({
      success: true,
      message: 'Application branding reset to defaults successfully.',
      data: reset
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/admin/branding/audit-logs (Superadmin / Admin)
 * View audit history of who modified branding and when
 */
async function getAuditLogs(req, res, next) {
  try {
    const logs = await brandingService.getAuditLogs(req.query.limit || 30);
    res.json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getPublicBranding,
  getAdminBranding,
  updateBranding,
  resetBranding,
  getAuditLogs
};

