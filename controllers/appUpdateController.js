const appUpdateService = require('../services/appUpdateService');
const path = require('path');
const fs = require('fs');

/**
 * Client Endpoint: Check for available app update
 * GET /api/mobile-updates/check
 */
async function checkUpdate(req, res, next) {
  try {
    const { platform, version, buildNumber, deviceId } = req.query;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userId = req.user ? req.user.id : null;

    const result = await appUpdateService.checkAppUpdate({
      platform,
      currentVersion: version,
      buildNumber,
      deviceId,
      userId,
      ipAddress
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * Client Endpoint: Get Expo / OTA manifest
 * GET /api/mobile-updates/manifest
 */
async function getManifest(req, res, next) {
  try {
    const { platform, runtimeVersion } = req.query;
    const manifest = await appUpdateService.getPublicManifest({ platform, runtimeVersion });
    if (!manifest) {
      return res.status(404).json({ success: false, message: 'No published OTA manifest available.' });
    }
    res.setHeader('expo-protocol-version', '0');
    res.setHeader('expo-sfv-version', '0');
    res.setHeader('cache-control', 'private, max-age=0');
    res.json(manifest);
  } catch (err) {
    next(err);
  }
}

/**
 * Client Endpoint: Record update telemetry / adoption event
 * POST /api/mobile-updates/adoption
 */
async function recordAdoption(req, res, next) {
  try {
    const { releaseId, deviceId, eventType, errorMessage, metadata } = req.body;
    const userId = req.user ? req.user.id : null;

    const result = await appUpdateService.recordAdoptionEvent({
      releaseId,
      deviceId,
      userId,
      eventType,
      errorMessage,
      metadata
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * Superadmin Endpoint: Get overall update adoption analytics
 * GET /api/admin/mobile-updates/analytics
 */
async function getAnalytics(req, res, next) {
  try {
    const analytics = await appUpdateService.getUpdateAnalytics();
    res.json({ success: true, data: analytics });
  } catch (err) {
    next(err);
  }
}

/**
 * Superadmin Endpoint: List paginated releases
 * GET /api/admin/mobile-updates/releases
 */
async function getReleases(req, res, next) {
  try {
    const { page, limit, status, platform, search } = req.query;
    const result = await appUpdateService.getAllReleases({ page, limit, status, platform, search });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * Superadmin Endpoint: Create release with optional bundle or APK upload
 * POST /api/admin/mobile-updates/releases
 */
async function createRelease(req, res, next) {
  try {
    let bundleUrl = req.body.bundleUrl || null;
    let apkUrl = req.body.apkUrl || null;
    let bundleHash = req.body.bundleHash || null;
    let bundleSizeBytes = null;

    // Check if files were uploaded via multer
    if (req.files) {
      if (req.files.bundle && req.files.bundle[0]) {
        const file = req.files.bundle[0];
        bundleUrl = `/uploads/mobile-updates/${file.filename}`;
        bundleSizeBytes = file.size;
        bundleHash = appUpdateService.calculateFileHash(file.path);
      }
      if (req.files.apk && req.files.apk[0]) {
        const file = req.files.apk[0];
        apkUrl = `/uploads/mobile-updates/${file.filename}`;
      }
    } else if (req.file) {
      const file = req.file;
      if (req.body.updateType === 'OTA') {
        bundleUrl = `/uploads/mobile-updates/${file.filename}`;
        bundleSizeBytes = file.size;
        bundleHash = appUpdateService.calculateFileHash(file.path);
      } else {
        apkUrl = `/uploads/mobile-updates/${file.filename}`;
      }
    }

    const release = await appUpdateService.createRelease({
      version: req.body.version,
      buildNumber: req.body.buildNumber,
      title: req.body.title,
      releaseNotes: req.body.releaseNotes,
      updateType: req.body.updateType,
      minAppVersion: req.body.minAppVersion,
      isMandatory: req.body.isMandatory === 'true' || req.body.isMandatory === true || req.body.isMandatory === 1,
      status: req.body.status || 'DRAFT',
      platform: req.body.platform || 'android',
      bundleUrl,
      apkUrl,
      bundleHash,
      bundleSizeBytes,
      runtimeVersion: req.body.runtimeVersion || '1.0.0',
      user: req.user
    });

    res.status(201).json({
      success: true,
      message: 'Mobile release created successfully!',
      data: release
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Superadmin Endpoint: Update an existing release
 * PUT /api/admin/mobile-updates/releases/:id
 */
async function updateRelease(req, res, next) {
  try {
    let bundleUrl = req.body.bundleUrl;
    let apkUrl = req.body.apkUrl;
    let bundleHash = req.body.bundleHash;
    let bundleSizeBytes = null;

    if (req.files) {
      if (req.files.bundle && req.files.bundle[0]) {
        const file = req.files.bundle[0];
        bundleUrl = `/uploads/mobile-updates/${file.filename}`;
        bundleSizeBytes = file.size;
        bundleHash = appUpdateService.calculateFileHash(file.path);
      }
      if (req.files.apk && req.files.apk[0]) {
        const file = req.files.apk[0];
        apkUrl = `/uploads/mobile-updates/${file.filename}`;
      }
    } else if (req.file) {
      const file = req.file;
      if (req.body.updateType === 'OTA') {
        bundleUrl = `/uploads/mobile-updates/${file.filename}`;
        bundleSizeBytes = file.size;
        bundleHash = appUpdateService.calculateFileHash(file.path);
      } else {
        apkUrl = `/uploads/mobile-updates/${file.filename}`;
      }
    }

    const release = await appUpdateService.updateRelease(req.params.id, {
      ...req.body,
      isMandatory: req.body.isMandatory === 'true' || req.body.isMandatory === true || req.body.isMandatory === 1,
      bundleUrl,
      apkUrl,
      bundleHash,
      bundleSizeBytes
    }, req.user);

    res.json({
      success: true,
      message: `Release v${release.version} updated successfully!`,
      data: release
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Superadmin Endpoint: Publish release
 * POST /api/admin/mobile-updates/releases/:id/publish
 */
async function publishRelease(req, res, next) {
  try {
    const release = await appUpdateService.publishRelease(req.params.id, req.user);
    res.json({
      success: true,
      message: `Release v${release.version} has been published successfully and broadcasted to devices.`,
      data: release
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Superadmin Endpoint: Rollback release
 * POST /api/admin/mobile-updates/releases/:id/rollback
 */
async function rollbackRelease(req, res, next) {
  try {
    const result = await appUpdateService.rollbackRelease(req.params.id, req.user);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * Superadmin Endpoint: Delete draft release
 * DELETE /api/admin/mobile-updates/releases/:id
 */
async function deleteRelease(req, res, next) {
  try {
    const result = await appUpdateService.deleteRelease(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  checkUpdate,
  getManifest,
  recordAdoption,
  getAnalytics,
  getReleases,
  createRelease,
  updateRelease,
  publishRelease,
  rollbackRelease,
  deleteRelease
};

