const db = require('../config/database');

/**
 * Basic sanitizer to strip unsafe HTML/script tags from markdown/content
 */
function sanitizeContent(text) {
  if (!text) return '';
  return String(text)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/javascript:[^"']*/gi, '');
}

/**
 * 1. Public: Get the currently published Privacy Policy
 */
async function getPublishedPolicy(req, res, next) {
  try {
    const policies = await db.query(`
      SELECT p.id, p.version, p.title, p.content, p.status, p.effective_date, p.published_at, p.updated_at,
             u.full_name as published_by_name
      FROM privacy_policies p
      LEFT JOIN users u ON p.author_id = u.id
      WHERE p.status = 'PUBLISHED'
      ORDER BY p.version DESC, p.id DESC
      LIMIT 1
    `);

    if (policies.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No published Privacy Policy found.'
      });
    }

    const policy = policies[0];
    res.json({
      success: true,
      data: {
        id: policy.id,
        version: policy.version,
        title: policy.title,
        content: policy.content,
        effectiveDate: policy.effective_date,
        publishedAt: policy.published_at,
        updatedAt: policy.updated_at,
        publishedBy: policy.published_by_name || 'Super Admin'
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 2. Super Admin: List all versions and drafts of Privacy Policy
 */
async function getAllPolicyVersions(req, res, next) {
  try {
    const rows = await db.query(`
      SELECT p.id, p.version, p.title, p.content, p.status, p.effective_date, 
             p.change_summary, p.author_id, p.published_at, p.created_at, p.updated_at,
             u.full_name as author_name
      FROM privacy_policies p
      LEFT JOIN users u ON p.author_id = u.id
      ORDER BY p.id DESC
    `);

    const formatted = rows.map(r => ({
      id: r.id,
      version: r.version,
      title: r.title,
      content: r.content,
      status: r.status,
      effectiveDate: r.effective_date,
      changeSummary: r.change_summary,
      publishedAt: r.published_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      authorName: r.author_name || 'Super Admin'
    }));

    res.json({
      success: true,
      data: formatted
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 3. Super Admin: Create or update draft Privacy Policy
 */
async function savePolicyDraft(req, res, next) {
  try {
    const { id, title = 'Official Privacy Policy', content, changeSummary, effectiveDate } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, message: 'Policy content is required.' });
    }

    const cleanContent = sanitizeContent(content);
    const cleanTitle = sanitizeContent(title) || 'Official Privacy Policy';
    const targetEffectiveDate = effectiveDate ? new Date(effectiveDate) : new Date();

    if (id) {
      // Update existing draft
      await db.query(`
        UPDATE privacy_policies 
        SET title = ?, content = ?, change_summary = ?, effective_date = ?, author_id = ?, updated_at = NOW()
        WHERE id = ? AND status = 'DRAFT'
      `, [cleanTitle, cleanContent, changeSummary || null, targetEffectiveDate, req.user.id, id]);

      return res.json({
        success: true,
        message: 'Privacy policy draft updated successfully.',
        data: { id }
      });
    }

    // Determine next version number
    const maxVersionRow = await db.query('SELECT MAX(version) as max_version FROM privacy_policies');
    const nextVersion = (maxVersionRow[0]?.max_version || 0) + 1;

    const result = await db.query(`
      INSERT INTO privacy_policies (version, title, content, status, effective_date, change_summary, author_id)
      VALUES (?, ?, ?, 'DRAFT', ?, ?, ?)
    `, [nextVersion, cleanTitle, cleanContent, targetEffectiveDate, changeSummary || 'Draft update', req.user.id]);

    res.status(201).json({
      success: true,
      message: 'New Privacy Policy draft created.',
      data: {
        id: result.insertId,
        version: nextVersion
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 4. Super Admin: Publish a draft or version
 */
async function publishPolicy(req, res, next) {
  try {
    const { id } = req.params;
    const { effectiveDate, changeSummary } = req.body;

    const policies = await db.query('SELECT * FROM privacy_policies WHERE id = ?', [id]);
    if (policies.length === 0) {
      return res.status(404).json({ success: false, message: 'Privacy policy version not found.' });
    }

    // Archive all previously published policies
    await db.query(`UPDATE privacy_policies SET status = 'ARCHIVED' WHERE status = 'PUBLISHED'`);

    const targetEffectiveDate = effectiveDate ? new Date(effectiveDate) : new Date();

    // Mark this policy as published
    await db.query(`
      UPDATE privacy_policies 
      SET status = 'PUBLISHED', 
          published_at = NOW(), 
          effective_date = ?,
          change_summary = COALESCE(?, change_summary),
          author_id = ?,
          updated_at = NOW()
      WHERE id = ?
    `, [targetEffectiveDate, changeSummary || null, req.user.id, id]);

    res.json({
      success: true,
      message: `Privacy policy version ${policies[0].version} is now officially published.`
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 5. Super Admin: Restore a previous version into a new published version
 */
async function restorePolicyVersion(req, res, next) {
  try {
    const { id } = req.params;

    const oldPolicies = await db.query('SELECT * FROM privacy_policies WHERE id = ?', [id]);
    if (oldPolicies.length === 0) {
      return res.status(404).json({ success: false, message: 'Policy version not found.' });
    }

    const oldPolicy = oldPolicies[0];

    // Archive current published policies
    await db.query(`UPDATE privacy_policies SET status = 'ARCHIVED' WHERE status = 'PUBLISHED'`);

    // Get new version number
    const maxVersionRow = await db.query('SELECT MAX(version) as max_version FROM privacy_policies');
    const nextVersion = (maxVersionRow[0]?.max_version || 0) + 1;

    const summary = `Restored from Version ${oldPolicy.version}`;
    const result = await db.query(`
      INSERT INTO privacy_policies (version, title, content, status, effective_date, change_summary, author_id, published_at)
      VALUES (?, ?, ?, 'PUBLISHED', NOW(), ?, ?, NOW())
    `, [nextVersion, oldPolicy.title, oldPolicy.content, summary, req.user.id]);

    res.json({
      success: true,
      message: `Restored Version ${oldPolicy.version} as newly published Version ${nextVersion}.`,
      data: {
        id: result.insertId,
        version: nextVersion
      }
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getPublishedPolicy,
  getAllPolicyVersions,
  savePolicyDraft,
  publishPolicy,
  restorePolicyVersion
};
