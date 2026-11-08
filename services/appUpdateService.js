const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../config/database');
const { getIO } = require('./socketService');

/**
 * Compare two semver strings: v1, v2 (e.g. '1.1.0', '1.0.9')
 * Returns 1 if v1 > v2, -1 if v1 < v2, 0 if v1 === v2
 */
function compareSemver(v1, v2) {
  if (!v1 || !v2) return 0;
  const p1 = String(v1).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const p2 = String(v2).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const maxLen = Math.max(p1.length, p2.length);
  for (let i = 0; i < maxLen; i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

/**
 * Calculate SHA-256 hash of a file on disk
 */
function calculateFileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 1. Check for updates from mobile client
 */
async function checkAppUpdate({ platform = 'android', currentVersion = '1.0.0', buildNumber = 1, deviceId = null, userId = null, ipAddress = null }) {
  const normPlatform = String(platform || 'android').toLowerCase();
  const safeBuild = parseInt(buildNumber, 10) || 1;
  const safeVersion = String(currentVersion || '1.0.0').trim();

  // 1. Record device ping / installation telemetry
  if (deviceId && typeof deviceId === 'string' && deviceId.trim()) {
    try {
      await db.query(`
        INSERT INTO app_device_installations (
          device_id, user_id, platform, current_version, current_build_number, last_seen_at, ip_address
        ) VALUES (?, ?, ?, ?, ?, NOW(), ?)
        ON DUPLICATE KEY UPDATE
          user_id = COALESCE(VALUES(user_id), user_id),
          current_version = VALUES(current_version),
          current_build_number = VALUES(current_build_number),
          last_seen_at = NOW(),
          ip_address = COALESCE(VALUES(ip_address), ip_address)
      `, [deviceId.trim(), userId || null, normPlatform, safeVersion, safeBuild, ipAddress || null]);
    } catch (err) {
      console.warn('[appUpdateService] Telemetry recording error:', err.message);
    }
  }

  // 2. Query the latest PUBLISHED release for this platform (or 'all')
  const releases = await db.query(`
    SELECT * FROM app_releases 
    WHERE status = 'PUBLISHED' 
      AND (platform = ? OR platform = 'all')
    ORDER BY build_number DESC, id DESC
    LIMIT 5
  `, [normPlatform]);

  if (!releases || releases.length === 0) {
    return {
      hasUpdate: false,
      currentVersion: safeVersion,
      currentBuildNumber: safeBuild,
      message: 'Application is up to date.'
    };
  }

  const latest = releases[0];
  const isVersionHigher = compareSemver(latest.version, safeVersion) > 0;
  const isBuildHigher = latest.build_number > safeBuild;
  const isBelowMin = compareSemver(safeVersion, latest.min_app_version || '1.0.0') < 0;

  // An update is available if the latest version is greater OR same version with higher build number
  const hasUpdate = (isVersionHigher || (compareSemver(latest.version, safeVersion) === 0 && isBuildHigher)) || isBelowMin;

  if (!hasUpdate) {
    return {
      hasUpdate: false,
      currentVersion: safeVersion,
      currentBuildNumber: safeBuild,
      latestVersion: latest.version,
      latestBuildNumber: latest.build_number,
      message: 'Application is up to date.'
    };
  }

  // If client's current version is below minimum supported native version,
  // it MUST be a native update and MUST be mandatory!
  const effectiveUpdateType = isBelowMin ? 'NATIVE' : latest.update_type;
  const effectiveMandatory = Boolean(latest.is_mandatory || isBelowMin);

  return {
    hasUpdate: true,
    updateType: effectiveUpdateType, // 'OTA' or 'NATIVE'
    isMandatory: effectiveMandatory,
    currentVersion: safeVersion,
    currentBuildNumber: safeBuild,
    latestVersion: latest.version,
    latestBuildNumber: latest.build_number,
    release: {
      id: latest.id,
      version: latest.version,
      buildNumber: latest.build_number,
      title: latest.title,
      releaseNotes: latest.release_notes,
      updateType: effectiveUpdateType,
      minAppVersion: latest.min_app_version,
      isMandatory: effectiveMandatory,
      bundleUrl: latest.bundle_url,
      apkUrl: latest.apk_url,
      bundleHash: latest.bundle_hash,
      bundleSizeBytes: latest.bundle_size_bytes,
      publishedAt: latest.published_at
    }
  };
}

/**
 * 2. Get Public Update Manifest (for Expo / Self-hosted OTA updates protocol)
 */
async function getPublicManifest({ platform = 'android', runtimeVersion = '1.0.0' } = {}) {
  const normPlatform = String(platform || 'android').toLowerCase();

  const releases = await db.query(`
    SELECT * FROM app_releases 
    WHERE status = 'PUBLISHED' 
      AND update_type = 'OTA'
      AND (platform = ? OR platform = 'all')
    ORDER BY build_number DESC, id DESC
    LIMIT 1
  `, [normPlatform]);

  if (!releases || releases.length === 0 || !releases[0].bundle_url) {
    return null;
  }

  const rel = releases[0];
  const publicBaseUrl = process.env.APP_URL || 'https://playzo.duckdns.org';
  const fullBundleUrl = rel.bundle_url.startsWith('http') 
    ? rel.bundle_url 
    : `${publicBaseUrl}${rel.bundle_url}`;

  return {
    id: `release-${rel.id}-${rel.version}-${rel.build_number}`,
    createdAt: rel.published_at ? new Date(rel.published_at).toISOString() : new Date().toISOString(),
    runtimeVersion: rel.runtime_version || runtimeVersion || '1.0.0',
    launchAsset: {
      key: `bundle-${rel.version}`,
      contentType: 'application/javascript',
      url: fullBundleUrl,
      hash: rel.bundle_hash || null
    },
    assets: [],
    metadata: {
      version: rel.version,
      buildNumber: rel.build_number,
      title: rel.title,
      releaseNotes: rel.release_notes,
      isMandatory: Boolean(rel.is_mandatory)
    }
  };
}

/**
 * 3. Record adoption event telemetry
 */
async function recordAdoptionEvent({ releaseId, deviceId, userId = null, eventType, errorMessage = null, metadata = null }) {
  if (!releaseId || !deviceId) {
    return { success: false, message: 'releaseId and deviceId are required.' };
  }

  const allowedEvents = ['NOTIFIED', 'ACCEPTED', 'DOWNLOADED', 'INSTALLED', 'FAILED', 'DISMISSED_LATER', 'APK_CLICKED'];
  const safeEvent = allowedEvents.includes(eventType) ? eventType : 'NOTIFIED';

  await db.query(`
    INSERT INTO app_update_logs (release_id, device_id, user_id, event_type, error_message, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    releaseId,
    deviceId,
    userId || null,
    safeEvent,
    errorMessage || null,
    metadata ? JSON.stringify(metadata) : null
  ]);

  // If installed successfully, update the device's installed version in registry
  if (safeEvent === 'INSTALLED') {
    const relRows = await db.query('SELECT version, build_number FROM app_releases WHERE id = ?', [releaseId]);
    if (relRows && relRows.length > 0) {
      await db.query(`
        UPDATE app_device_installations 
        SET current_version = ?, current_build_number = ?, installed_release_id = ?, last_seen_at = NOW()
        WHERE device_id = ?
      `, [relRows[0].version, relRows[0].build_number, releaseId, deviceId]);
    }
  }

  return { success: true };
}

/**
 * 4. Get Superadmin Update Analytics & Device Fleet Statistics
 */
async function getUpdateAnalytics() {
  // Total registered devices
  const totalDevRows = await db.query('SELECT COUNT(*) as total FROM app_device_installations');
  const totalDevices = totalDevRows[0]?.total || 0;

  // Active in last 30 days
  const activeDevRows = await db.query(`
    SELECT COUNT(*) as total FROM app_device_installations 
    WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
  `);
  const activeDevices = activeDevRows[0]?.total || 0;

  // Latest published release
  const latestRelRows = await db.query(`
    SELECT * FROM app_releases 
    WHERE status = 'PUBLISHED' 
    ORDER BY build_number DESC, id DESC 
    LIMIT 1
  `);
  const latestRelease = latestRelRows[0] || null;

  // Devices on latest version
  let devicesOnLatest = 0;
  if (latestRelease) {
    const onLatestRows = await db.query(`
      SELECT COUNT(*) as total FROM app_device_installations 
      WHERE current_version = ? OR current_build_number >= ?
    `, [latestRelease.version, latestRelease.build_number]);
    devicesOnLatest = onLatestRows[0]?.total || 0;
  }

  const devicesPendingUpdate = Math.max(0, totalDevices - devicesOnLatest);
  const adoptionPercentage = totalDevices > 0 
    ? Math.round((devicesOnLatest / totalDevices) * 100) 
    : 100;

  // Total downloads & installs from logs
  const logsSummary = await db.query(`
    SELECT 
      SUM(CASE WHEN event_type = 'DOWNLOADED' THEN 1 ELSE 0 END) as totalDownloads,
      SUM(CASE WHEN event_type = 'INSTALLED' THEN 1 ELSE 0 END) as totalInstalls,
      SUM(CASE WHEN event_type = 'FAILED' THEN 1 ELSE 0 END) as totalFailures,
      SUM(CASE WHEN event_type = 'APK_CLICKED' THEN 1 ELSE 0 END) as totalApkClicks
    FROM app_update_logs
  `);

  // Version distribution
  const versionDist = await db.query(`
    SELECT current_version as version, COUNT(*) as deviceCount
    FROM app_device_installations
    GROUP BY current_version
    ORDER BY deviceCount DESC
    LIMIT 8
  `);

  const formattedDist = versionDist.map(v => ({
    version: v.version,
    deviceCount: v.deviceCount,
    percentage: totalDevices > 0 ? Math.round((v.deviceCount / totalDevices) * 100) : 0
  }));

  return {
    totalDevices,
    activeDevices,
    latestRelease,
    devicesOnLatest,
    devicesPendingUpdate,
    adoptionPercentage,
    totalDownloads: parseInt(logsSummary[0]?.totalDownloads, 10) || 0,
    totalInstalls: parseInt(logsSummary[0]?.totalInstalls, 10) || 0,
    totalFailures: parseInt(logsSummary[0]?.totalFailures, 10) || 0,
    totalApkClicks: parseInt(logsSummary[0]?.totalApkClicks, 10) || 0,
    versionDistribution: formattedDist
  };
}

/**
 * 5. Get all releases with adoption stats for Superadmin
 */
async function getAllReleases({ page = 1, limit = 20, status = '', platform = '', search = '' } = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
  const offset = (safePage - 1) * safeLimit;

  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  if (platform) {
    conditions.push('platform = ?');
    params.push(platform);
  }

  if (search) {
    conditions.push('(version LIKE ? OR title LIKE ? OR release_notes LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRows = await db.query(`SELECT COUNT(*) as total FROM app_releases ${whereClause}`, params);
  const total = countRows[0]?.total || 0;

  const releases = await db.query(`
    SELECT 
      r.*,
      (SELECT COUNT(DISTINCT device_id) FROM app_update_logs WHERE release_id = r.id AND event_type = 'INSTALLED') as installCount,
      (SELECT COUNT(DISTINCT device_id) FROM app_update_logs WHERE release_id = r.id AND event_type = 'DOWNLOADED') as downloadCount,
      (SELECT COUNT(DISTINCT device_id) FROM app_update_logs WHERE release_id = r.id AND event_type = 'FAILED') as failureCount
    FROM app_releases r
    ${whereClause}
    ORDER BY r.build_number DESC, r.id DESC
    LIMIT ? OFFSET ?
  `, [...params, safeLimit, offset]);

  return {
    items: releases,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit)
  };
}

/**
 * 6. Create a new Release (Draft or Published)
 */
async function createRelease({
  version,
  buildNumber,
  title,
  releaseNotes,
  updateType = 'OTA',
  minAppVersion = '1.0.0',
  isMandatory = false,
  status = 'DRAFT',
  platform = 'android',
  bundleUrl = null,
  apkUrl = null,
  bundleHash = null,
  bundleSizeBytes = null,
  runtimeVersion = '1.0.0',
  user = null
}) {
  if (!version || !String(version).trim()) {
    throw { statusCode: 400, message: 'Version name (e.g. 1.2.0) is required.' };
  }
  if (!buildNumber || isNaN(parseInt(buildNumber, 10))) {
    throw { statusCode: 400, message: 'Valid integer build number is required.' };
  }
  if (!title || !String(title).trim()) {
    throw { statusCode: 400, message: 'Release title is required.' };
  }
  if (!releaseNotes || !String(releaseNotes).trim()) {
    throw { statusCode: 400, message: 'Release notes are required.' };
  }

  const normVersion = String(version).trim();
  const safeBuild = parseInt(buildNumber, 10);
  const safeType = updateType === 'NATIVE' ? 'NATIVE' : 'OTA';
  const safeMandatory = Boolean(isMandatory) ? 1 : 0;
  const safeStatus = ['PUBLISHED', 'DRAFT'].includes(status) ? status : 'DRAFT';

  // Check uniqueness of version + build_number for platform
  const existing = await db.query(
    'SELECT id FROM app_releases WHERE version = ? AND build_number = ? AND platform = ?',
    [normVersion, safeBuild, platform]
  );
  if (existing && existing.length > 0) {
    throw { statusCode: 400, message: `Release version ${normVersion} (Build ${safeBuild}) already exists for ${platform}.` };
  }

  const publishedAt = safeStatus === 'PUBLISHED' ? new Date() : null;

  const result = await db.query(`
    INSERT INTO app_releases (
      version, build_number, title, release_notes, update_type,
      min_app_version, is_mandatory, status, platform,
      bundle_url, apk_url, bundle_hash, bundle_size_bytes,
      runtime_version, created_by, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    normVersion,
    safeBuild,
    title.trim(),
    releaseNotes.trim(),
    safeType,
    minAppVersion || '1.0.0',
    safeMandatory,
    safeStatus,
    platform || 'android',
    bundleUrl || null,
    apkUrl || null,
    bundleHash || null,
    bundleSizeBytes || null,
    runtimeVersion || '1.0.0',
    user?.id || null,
    publishedAt
  ]);

  const createdId = result.insertId;
  const newReleaseRows = await db.query('SELECT * FROM app_releases WHERE id = ?', [createdId]);
  const newRelease = newReleaseRows[0];

  // If published immediately, notify connected devices and users
  if (safeStatus === 'PUBLISHED') {
    broadcastUpdateNotification(newRelease);
  }

  return newRelease;
}

/**
 * 7. Publish a Release
 */
async function publishRelease(id, user = null) {
  const relRows = await db.query('SELECT * FROM app_releases WHERE id = ?', [id]);
  if (!relRows || relRows.length === 0) {
    throw { statusCode: 404, message: 'Release not found.' };
  }

  const rel = relRows[0];

  // If OTA, verify bundle is present
  if (rel.update_type === 'OTA' && !rel.bundle_url) {
    throw { statusCode: 400, message: 'Cannot publish OTA update without an uploaded bundle package.' };
  }

  // If NATIVE, verify download link or APK is present
  if (rel.update_type === 'NATIVE' && !rel.apk_url) {
    throw { statusCode: 400, message: 'Cannot publish Native release without an APK file or download URL.' };
  }

  await db.query(`
    UPDATE app_releases 
    SET status = 'PUBLISHED', published_at = NOW() 
    WHERE id = ?
  `, [id]);

  const updatedRows = await db.query('SELECT * FROM app_releases WHERE id = ?', [id]);
  const publishedRel = updatedRows[0];

  // Broadcast real-time update alerts to all connected mobile clients
  broadcastUpdateNotification(publishedRel);

  return publishedRel;
}

/**
 * 8. Rollback Release to previous working release
 */
async function rollbackRelease(id, user = null) {
  const relRows = await db.query('SELECT * FROM app_releases WHERE id = ?', [id]);
  if (!relRows || relRows.length === 0) {
    throw { statusCode: 404, message: 'Release not found.' };
  }

  const targetRel = relRows[0];

  // Mark current as ROLLED_BACK
  await db.query(`UPDATE app_releases SET status = 'ROLLED_BACK' WHERE id = ?`, [id]);

  // Find previous stable published or eligible release
  const prevRows = await db.query(`
    SELECT * FROM app_releases 
    WHERE id != ? 
      AND status = 'PUBLISHED'
      AND (platform = ? OR platform = 'all')
    ORDER BY build_number DESC, id DESC
    LIMIT 1
  `, [id, targetRel.platform]);

  const fallbackRel = prevRows[0] || null;

  try {
    const io = getIO();
    if (io) {
      io.emit('app:update_rollback', {
        rolledBackReleaseId: id,
        targetVersion: targetRel.version,
        activeRelease: fallbackRel
      });
      if (fallbackRel) {
        io.emit('app:update_published', fallbackRel);
      }
    }
  } catch (err) {
    console.warn('[appUpdateService] Socket rollback broadcast error:', err.message);
  }

  return {
    success: true,
    message: `Release v${targetRel.version} successfully rolled back.`,
    rolledBackRelease: targetRel,
    activeRelease: fallbackRel
  };
}

/**
 * 9. Delete Release (Only DRAFT or ARCHIVED)
 */
async function deleteRelease(id) {
  const relRows = await db.query('SELECT * FROM app_releases WHERE id = ?', [id]);
  if (!relRows || relRows.length === 0) {
    throw { statusCode: 404, message: 'Release not found.' };
  }

  if (relRows[0].status === 'PUBLISHED') {
    throw { statusCode: 400, message: 'Cannot delete an active published release. Please roll back or archive it first.' };
  }

  await db.query('DELETE FROM app_releases WHERE id = ?', [id]);
  return { success: true, message: 'Release deleted successfully.' };
}

/**
 * Internal: Broadcast real-time Socket.IO and User notifications on publish
 */
async function broadcastUpdateNotification(release) {
  try {
    const io = getIO();
    if (io) {
      io.emit('app:update_published', {
        id: release.id,
        version: release.version,
        buildNumber: release.build_number,
        title: release.title,
        releaseNotes: release.release_notes,
        updateType: release.update_type,
        minAppVersion: release.min_app_version,
        isMandatory: Boolean(release.is_mandatory),
        bundleUrl: release.bundle_url,
        apkUrl: release.apk_url,
        bundleHash: release.bundle_hash,
        publishedAt: release.published_at
      });
    }

    // Insert broadcast notification into notifications table for active mobile app users
    const notifTitle = `Turf App Update v${release.version} Available`;
    const notifMessage = `${release.title} - ${release.update_type === 'OTA' ? 'Instant Update Ready' : 'New APK Release Available'}`;
    const metadata = JSON.stringify({
      releaseId: release.id,
      version: release.version,
      updateType: release.update_type,
      isMandatory: Boolean(release.is_mandatory)
    });

    // Notify recent users
    const activeUsers = await db.query(`
      SELECT DISTINCT user_id FROM app_device_installations WHERE user_id IS NOT NULL LIMIT 500
    `);

    for (const u of activeUsers) {
      await db.query(`
        INSERT INTO notifications (user_id, title, message, type, metadata, action_url)
        VALUES (?, ?, ?, 'APP_UPDATE', ?, '/app-update')
      `, [u.user_id, notifTitle, notifMessage, metadata]);
    }
  } catch (err) {
    console.warn('[appUpdateService] Broadcast notification warning:', err.message);
  }
}

module.exports = {
  compareSemver,
  calculateFileHash,
  checkAppUpdate,
  getPublicManifest,
  recordAdoptionEvent,
  getUpdateAnalytics,
  getAllReleases,
  createRelease,
  publishRelease,
  rollbackRelease,
  deleteRelease
};

