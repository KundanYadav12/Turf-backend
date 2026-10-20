const crypto = require('crypto');
const db = require('../config/database');
const { getIO } = require('./socketService');

// Verhoeff algorithm tables for 12-digit Aadhaar validation
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];

const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function validateVerhoeff(numStr) {
  if (!numStr || typeof numStr !== 'string') return false;
  const clean = numStr.replace(/\s+/g, '');
  if (!/^\d{12}$/.test(clean)) return false;

  let c = 0;
  const reversed = clean.split('').reverse().map(Number);
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][reversed[i]]];
  }
  return c === 0;
}

// AES-256 Encryption helpers for sensitive data
const ENCRYPTION_KEY = crypto.createHash('sha256')
  .update(process.env.JWT_SECRET || 'super_secret_sports_booking_jwt_key_2026_safe')
  .digest();

function encryptSensitive(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(String(text), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

function decryptSensitive(cipherText) {
  if (!cipherText || !cipherText.includes(':')) return null;
  const [ivHex, encryptedHex] = cipherText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Default field configuration if organizer configures nothing
const DEFAULT_FIELDS_CONFIG = {
  fullName: { status: 'REQUIRED', label: 'Full Name' },
  dateOfBirth: { status: 'REQUIRED', label: 'Date of Birth' },
  age: { status: 'OPTIONAL', label: 'Age (Auto-calculated)' },
  playingHand: { status: 'REQUIRED', label: 'Playing Hand' },
  phone: { status: 'REQUIRED', label: 'Phone Number' },
  email: { status: 'OPTIONAL', label: 'Email Address' },
  address: { status: 'HIDDEN', label: 'Address' },
  aadhaar: { status: 'HIDDEN', label: 'Aadhaar Number (12-Digit)' },
  photo: { status: 'OPTIONAL', label: 'Player Photo' },
  preferredRole: { status: 'OPTIONAL', label: 'Preferred Role / Position' },
  preferredTeam: { status: 'OPTIONAL', label: 'Preferred Team' },
  jerseySize: { status: 'OPTIONAL', label: 'Jersey Size' },
  customFields: []
};

/**
 * Fetch tournament entity helper
 */
async function getTournamentEntity(tournamentId) {
  const isNum = /^\d+$/.test(String(tournamentId).trim());
  const rows = await db.query(
    `SELECT t.*, s.slug as sport_slug, s.name as sport_name, v.owner_id as venue_owner_id
     FROM tournaments t
     LEFT JOIN sports s ON t.sport_id = s.id
     LEFT JOIN venues v ON t.venue_id = v.id
     WHERE t.uuid = ? OR t.id = ?`,
    [String(tournamentId), isNum ? parseInt(tournamentId, 10) : -1]
  );
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * 1. Get Registration Configuration for Tournament
 */
const getRegistrationConfig = async (tournamentPublicId) => {
  const tournament = await getTournamentEntity(tournamentPublicId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found.' };

  const rows = await db.query(
    `SELECT * FROM tournament_player_registration_configs WHERE tournament_id = ?`,
    [tournament.id]
  );

  let config = rows[0] || null;
  let fieldsConfig = DEFAULT_FIELDS_CONFIG;

  if (config && config.fields_config) {
    try {
      fieldsConfig = typeof config.fields_config === 'string'
        ? JSON.parse(config.fields_config)
        : config.fields_config;
    } catch {
      fieldsConfig = DEFAULT_FIELDS_CONFIG;
    }
  }

  // Count active / confirmed registrations
  const countRow = await db.query(
    `SELECT COUNT(*) as registered_count FROM tournament_player_registrations 
     WHERE tournament_id = ? AND status IN ('PENDING', 'APPROVED', 'CONFIRMED')`,
    [tournament.id]
  );
  const registeredCount = Number(countRow[0]?.registered_count || 0);

  return {
    tournament: {
      id: tournament.uuid,
      name: tournament.name,
      sportSlug: tournament.sport_slug,
      sportName: tournament.sport_name,
      startDate: tournament.start_date,
      endDate: tournament.end_date,
      bannerUrl: tournament.banner_url
    },
    isOpen: config ? Boolean(config.is_open) : true,
    registrationDeadline: config ? (config.registration_deadline || null) : (tournament.registration_deadline || null),
    maxPlayers: config?.max_players || 128,
    registeredCount,
    isFull: config?.max_players ? registeredCount >= config.max_players : false,
    minAge: config?.min_age || null,
    maxAge: config?.max_age || null,
    fieldsConfig,
    consentText: config?.consent_text || 'I consent to the collection and verification of my details for this tournament. Sensitive identity data (such as Aadhaar and address) is securely encrypted and accessible only to authorized organizers.'
  };
};

/**
 * 2. Update Registration Configuration (Organizer/Admin only)
 */
const updateRegistrationConfig = async (tournamentPublicId, arg2, arg3) => {
  let user, payload;
  if (arg2 && arg2.id && (arg2.roles || arg2.email || arg2.full_name)) {
    user = arg2;
    payload = arg3 || {};
  } else {
    payload = arg2 || {};
    user = arg3;
  }

  const tournament = await getTournamentEntity(tournamentPublicId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found.' };

  const {
    isOpen = true,
    registrationDeadline = null,
    maxPlayers = null,
    minAge = null,
    maxAge = null,
    fieldsConfig = DEFAULT_FIELDS_CONFIG,
    consentText = null
  } = payload;

  const jsonFields = JSON.stringify(fieldsConfig);

  await db.query(
    `INSERT INTO tournament_player_registration_configs (
      tournament_id, is_open, registration_deadline, max_players, min_age, max_age, fields_config, consent_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      is_open = VALUES(is_open),
      registration_deadline = VALUES(registration_deadline),
      max_players = VALUES(max_players),
      min_age = VALUES(min_age),
      max_age = VALUES(max_age),
      fields_config = VALUES(fields_config),
      consent_text = VALUES(consent_text)`,
    [
      tournament.id,
      isOpen ? 1 : 0,
      registrationDeadline || null,
      maxPlayers ? parseInt(maxPlayers, 10) : null,
      minAge ? parseInt(minAge, 10) : null,
      maxAge ? parseInt(maxAge, 10) : null,
      jsonFields,
      consentText
    ]
  );

  return await getRegistrationConfig(tournament.uuid);
};

/**
 * 3. Player Submits Registration Request
 */
const submitPlayerRegistration = async (tournamentPublicId, arg2, arg3) => {
  let user, data;
  if (arg2 && arg2.id && (arg2.roles || arg2.email || arg2.full_name)) {
    user = arg2;
    data = arg3 || {};
  } else {
    data = arg2 || {};
    user = arg3;
  }

  if (!user || !user.id) throw { statusCode: 401, message: 'Please log in to submit tournament registration.' };

  const tournament = await getTournamentEntity(tournamentPublicId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found.' };

  const config = await getRegistrationConfig(tournament.uuid);
  if (!config.isOpen) {
    throw { statusCode: 400, message: 'Registration for this tournament is currently closed.' };
  }

  if (config.registrationDeadline && new Date() > new Date(config.registrationDeadline)) {
    throw { statusCode: 400, message: 'Registration deadline has passed.' };
  }

  // Prevent duplicate requests per player per tournament
  const existing = await db.query(
    `SELECT id, status FROM tournament_player_registrations WHERE tournament_id = ? AND user_id = ?`,
    [tournament.id, user.id]
  );
  if (existing.length > 0 && existing[0].status !== 'WITHDRAWN') {
    throw { statusCode: 400, message: `You have already submitted a registration for this tournament (Status: ${existing[0].status}).` };
  }

  const {
    fullName,
    phone,
    email,
    dateOfBirth,
    playingHand,
    address,
    aadhaarNumber,
    aadhaar,
    photoUrl,
    preferredRole,
    preferredTeamId,
    jerseySize,
    customFieldsData = {},
    consentAccepted,
    consentAgreed
  } = data;

  const rawAadhaar = aadhaarNumber || aadhaar;
  const hasConsented = consentAccepted !== undefined ? Boolean(consentAccepted) : (consentAgreed !== undefined ? Boolean(consentAgreed) : true);

  const fConf = config.fieldsConfig;

  // Validation
  if (fConf.fullName?.status === 'REQUIRED' && (!fullName || !fullName.trim())) {
    throw { statusCode: 400, message: 'Full name is required.' };
  }
  if (fConf.phone?.status === 'REQUIRED' && (!phone || !phone.trim())) {
    throw { statusCode: 400, message: 'Phone number is required.' };
  }
  if (phone && !/^[0-9+\-\s]{7,16}$/.test(phone.trim())) {
    throw { statusCode: 400, message: 'Please provide a valid contact phone number.' };
  }

  let calculatedAge = null;
  if (dateOfBirth) {
    const dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) throw { statusCode: 400, message: 'Invalid Date of Birth.' };
    const diffMs = Date.now() - dob.getTime();
    calculatedAge = Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000));

    if (config.minAge && calculatedAge < config.minAge) {
      throw { statusCode: 400, message: `Minimum age requirement for this tournament is ${config.minAge} years (Your calculated age: ${calculatedAge}).` };
    }
    if (config.maxAge && calculatedAge > config.maxAge) {
      throw { statusCode: 400, message: `Maximum age requirement for this tournament is ${config.maxAge} years (Your calculated age: ${calculatedAge}).` };
    }
  } else if (fConf.dateOfBirth?.status === 'REQUIRED') {
    throw { statusCode: 400, message: 'Date of birth is required.' };
  }

  // Aadhaar validation with Verhoeff Checksum + Encryption
  let encryptedAadhaar = null;
  let aadhaarLast4 = null;
  if (rawAadhaar) {
    const cleanAadhaar = String(rawAadhaar).replace(/\s+/g, '');
    if (!validateVerhoeff(cleanAadhaar)) {
      throw { statusCode: 400, message: 'Invalid 12-digit Aadhaar number (checksum validation failed).' };
    }
    encryptedAadhaar = encryptSensitive(cleanAadhaar);
    aadhaarLast4 = cleanAadhaar.slice(-4);
  } else if (fConf.aadhaar?.status === 'REQUIRED') {
    throw { statusCode: 400, message: '12-digit Aadhaar number is required.' };
  }

  // Address validation
  if (fConf.address?.status === 'REQUIRED' && (!address || !address.trim())) {
    throw { statusCode: 400, message: 'Address is required.' };
  }

  // Sensitive data consent check
  if ((rawAadhaar || address) && !hasConsented) {
    throw { statusCode: 400, message: 'Consent is required to submit sensitive identity verification details.' };
  }

  // Auto-waitlist if max players limit reached
  let status = 'PENDING';
  if (config.isFull) {
    status = 'WAITLISTED';
  }

  const regUuid = crypto.randomUUID();
  const res = await db.query(
    `INSERT INTO tournament_player_registrations (
      uuid, tournament_id, user_id, full_name, phone, email, date_of_birth, age,
      playing_hand, address, aadhaar_encrypted, aadhaar_last4, photo_url,
      preferred_role, preferred_team_id, jersey_size, custom_fields_data,
      status, consent_accepted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      uuid = VALUES(uuid),
      full_name = VALUES(full_name),
      phone = VALUES(phone),
      email = VALUES(email),
      date_of_birth = VALUES(date_of_birth),
      age = VALUES(age),
      playing_hand = VALUES(playing_hand),
      address = VALUES(address),
      aadhaar_encrypted = VALUES(aadhaar_encrypted),
      aadhaar_last4 = VALUES(aadhaar_last4),
      photo_url = VALUES(photo_url),
      preferred_role = VALUES(preferred_role),
      preferred_team_id = VALUES(preferred_team_id),
      jersey_size = VALUES(jersey_size),
      custom_fields_data = VALUES(custom_fields_data),
      status = VALUES(status),
      consent_accepted = VALUES(consent_accepted)`,
    [
      regUuid,
      tournament.id,
      user.id,
      fullName.trim(),
      phone.trim(),
      email ? email.trim() : null,
      dateOfBirth || null,
      calculatedAge,
      playingHand || null,
      address ? address.trim() : null,
      encryptedAadhaar,
      aadhaarLast4,
      photoUrl || null,
      preferredRole || null,
      preferredTeamId ? parseInt(preferredTeamId, 10) : null,
      jerseySize || null,
      JSON.stringify(customFieldsData || {}),
      status,
      consentAccepted ? 1 : 0
    ]
  );

  // Send in-app notification to player
  try {
    await db.query(
      `INSERT INTO notifications (user_id, title, message, type, action_url)
       VALUES (?, ?, ?, 'TOURNAMENT', ?)`,
      [
        user.id,
        `Registration Submitted: ${tournament.name}`,
        status === 'WAITLISTED'
          ? `Tournament limit reached. Your registration is on the waitlist.`
          : `Your player registration is pending organizer review.`,
        `/tournaments/${tournament.uuid}`
      ]
    );
  } catch (notifErr) {
    console.warn('Failed to insert notification:', notifErr);
  }

  // Socket notification
  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:registrationSubmitted', {
      tournamentId: tournament.uuid,
      registrationUuid: regUuid,
      playerName: fullName
    });
  }

  return {
    success: true,
    message: status === 'WAITLISTED'
      ? 'Registration submitted and added to waitlist (Tournament is currently full).'
      : 'Player registration submitted successfully! Awaiting organizer review.',
    registrationId: regUuid,
    status
  };
};

/**
 * 4. List Registrations for Tournament Organizer
 */
const getTournamentPlayerRegistrations = async (tournamentPublicId, arg2, arg3) => {
  let user, filters;
  if (arg2 && arg2.id && (arg2.roles || arg2.email || arg2.full_name)) {
    user = arg2;
    filters = arg3 || {};
  } else {
    filters = arg2 || {};
    user = arg3;
  }
  const { status, search } = filters;
  const tournament = await getTournamentEntity(tournamentPublicId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found.' };

  const conditions = ['r.tournament_id = ?'];
  const params = [tournament.id];

  if (status && status !== 'ALL') {
    conditions.push('r.status = ?');
    params.push(status);
  }

  if (search && search.trim()) {
    conditions.push('(r.full_name LIKE ? OR r.phone LIKE ? OR r.email LIKE ?)');
    params.push(`%${search.trim()}%`, `%${search.trim()}%`, `%${search.trim()}%`);
  }

  const rows = await db.query(
    `SELECT 
      r.id, r.uuid, r.full_name, r.phone, r.email, r.date_of_birth, r.age,
      r.playing_hand, r.address, r.aadhaar_last4, r.photo_url,
      r.preferred_role, r.preferred_team_id, r.jersey_size, r.custom_fields_data,
      r.status, r.denial_reason, r.assigned_team_id, r.assigned_role,
      r.created_at, r.updated_at,
      u.id as user_id, u.email as account_email,
      tm.name as preferred_team_name,
      atm.name as assigned_team_name
     FROM tournament_player_registrations r
     JOIN users u ON r.user_id = u.id
     LEFT JOIN teams tm ON r.preferred_team_id = tm.id
     LEFT JOIN teams atm ON r.assigned_team_id = atm.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY r.created_at DESC`,
    params
  );

  return rows.map(r => {
    let customFields = {};
    try {
      customFields = typeof r.custom_fields_data === 'string'
        ? JSON.parse(r.custom_fields_data)
        : (r.custom_fields_data || {});
    } catch {}

    return {
      id: r.uuid,
      internalId: r.id,
      fullName: r.full_name,
      phone: r.phone,
      email: r.email,
      dateOfBirth: r.date_of_birth,
      age: r.age,
      playingHand: r.playing_hand,
      address: r.address,
      maskedAadhaar: r.aadhaar_last4 ? `XXXX-XXXX-${r.aadhaar_last4}` : null,
      aadhaarMasked: r.aadhaar_last4 ? `XXXX-XXXX-${r.aadhaar_last4}` : null,
      photoUrl: r.photo_url,
      preferredRole: r.preferred_role,
      preferredTeam: r.preferred_team_id ? { id: r.preferred_team_id, name: r.preferred_team_name } : null,
      jerseySize: r.jersey_size,
      customFields,
      status: r.status,
      denialReason: r.denial_reason,
      assignedTeam: r.assigned_team_id ? { id: r.assigned_team_id, name: r.assigned_team_name } : null,
      assignedRole: r.assigned_role,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  });
};

/**
 * 5. Get current user's registration for this tournament
 */
const getMyTournamentRegistration = async (tournamentPublicId, user) => {
  if (!user || !user.id) return null;

  const tournament = await getTournamentEntity(tournamentPublicId);
  if (!tournament) return null;

  const rows = await db.query(
    `SELECT r.*, tm.name as assigned_team_name
     FROM tournament_player_registrations r
     LEFT JOIN teams tm ON r.assigned_team_id = tm.id
     WHERE r.tournament_id = ? AND r.user_id = ?`,
    [tournament.id, user.id]
  );

  if (!rows || rows.length === 0) return null;
  const r = rows[0];

  return {
    id: r.uuid,
    fullName: r.full_name,
    phone: r.phone,
    email: r.email,
    dateOfBirth: r.date_of_birth,
    age: r.age,
    playingHand: r.playing_hand,
    maskedAadhaar: r.aadhaar_last4 ? `XXXX-XXXX-${r.aadhaar_last4}` : null,
    status: r.status,
    denialReason: r.denial_reason,
    assignedTeam: r.assigned_team_id ? { id: r.assigned_team_id, name: r.assigned_team_name } : null,
    assignedRole: r.assigned_role,
    createdAt: r.created_at
  };
};

/**
 * 6. Withdraw pending registration
 */
const withdrawMyRegistration = async (tournamentPublicId, user) => {
  if (!user || !user.id) throw { statusCode: 401, message: 'Authentication required.' };

  const tournament = await getTournamentEntity(tournamentPublicId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found.' };

  const rows = await db.query(
    `SELECT id, status FROM tournament_player_registrations WHERE tournament_id = ? AND user_id = ?`,
    [tournament.id, user.id]
  );

  if (!rows.length) throw { statusCode: 404, message: 'Registration not found.' };
  if (rows[0].status === 'CONFIRMED') {
    throw { statusCode: 400, message: 'Confirmed registrations cannot be self-withdrawn. Please contact the organizer.' };
  }

  await db.query(
    `UPDATE tournament_player_registrations SET status = 'WITHDRAWN' WHERE id = ?`,
    [rows[0].id]
  );

  return { success: true, message: 'Registration withdrawn successfully.' };
};

/**
 * 7. Update Registration Status (Approve | Deny | Waitlist | Confirm)
 */
const updateRegistrationStatus = async (tournamentPublicId, regPublicId, arg3, arg4) => {
  let user, payload;
  if (arg3 && arg3.id && (arg3.roles || arg3.email || arg3.full_name)) {
    user = arg3;
    payload = arg4 || {};
  } else {
    payload = arg3 || {};
    user = arg4;
  }
  const { status, denialReason, assignedTeamId, assignedRole } = payload;
  const tournament = await getTournamentEntity(tournamentPublicId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found.' };

  const validStatuses = ['PENDING', 'APPROVED', 'DENIED', 'WAITLISTED', 'CONFIRMED'];
  if (!validStatuses.includes(status)) {
    throw { statusCode: 400, message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` };
  }

  const rows = await db.query(
    `SELECT * FROM tournament_player_registrations WHERE (uuid = ? OR id = ?) AND tournament_id = ?`,
    [regPublicId, /^\d+$/.test(String(regPublicId)) ? parseInt(regPublicId, 10) : -1, tournament.id]
  );

  if (!rows.length) throw { statusCode: 404, message: 'Registration record not found.' };
  const reg = rows[0];

  let resolvedTeamId = assignedTeamId ? parseInt(assignedTeamId, 10) : reg.assigned_team_id;

  // If status is CONFIRMED and a team is assigned, auto-insert into team_members squad!
  if (status === 'CONFIRMED' && resolvedTeamId) {
    const existingSquad = await db.query(
      `SELECT id FROM team_members WHERE team_id = ? AND (user_id = ? OR player_name = ?)`,
      [resolvedTeamId, reg.user_id, reg.full_name]
    );

    if (!existingSquad.length) {
      const playerPos = assignedRole || reg.preferred_role || null;
      await db.query(
        `INSERT INTO team_members (team_id, user_id, player_name, role, position, is_captain, is_vice_captain)
         VALUES (?, ?, ?, 'PLAYER', ?, 0, 0)`,
        [resolvedTeamId, reg.user_id, reg.full_name, playerPos]
      );
    }
  }

  await db.query(
    `UPDATE tournament_player_registrations 
     SET status = ?,
         denial_reason = ?,
         assigned_team_id = ?,
         assigned_role = ?
     WHERE id = ?`,
    [
      status,
      status === 'DENIED' ? (denialReason || 'Organizer declined registration.') : null,
      resolvedTeamId || null,
      assignedRole || reg.preferred_role || null,
      reg.id
    ]
  );

  // Send notification to player
  try {
    const statusMsg = {
      APPROVED: `Your registration for "${tournament.name}" has been Approved!`,
      CONFIRMED: `Congratulations! Your spot in "${tournament.name}" is Confirmed.`,
      DENIED: `Your registration for "${tournament.name}" was declined: ${denialReason || 'No reason provided.'}`,
      WAITLISTED: `You have been placed on the waitlist for "${tournament.name}".`
    }[status] || `Your registration status for "${tournament.name}" changed to ${status}.`;

    await db.query(
      `INSERT INTO notifications (user_id, title, message, type, action_url)
       VALUES (?, ?, ?, 'TOURNAMENT', ?)`,
      [
        reg.user_id,
        `Tournament Registration: ${status}`,
        statusMsg,
        `/tournaments/${tournament.uuid}`
      ]
    );
  } catch (nErr) {
    console.warn('Failed to insert status notification:', nErr);
  }

  // Socket notification
  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:registrationUpdated', {
      tournamentId: tournament.uuid,
      registrationUuid: reg.uuid,
      status
    });
  }

  return {
    success: true,
    message: `Registration status updated to ${status}.`,
    registrationId: reg.uuid,
    status
  };
};

/**
 * 8. Bulk Update Status
 */
const bulkUpdateRegistrationStatus = async (tournamentPublicId, arg2, arg3) => {
  let user, payload;
  if (arg2 && arg2.id && (arg2.roles || arg2.email || arg2.full_name)) {
    user = arg2;
    payload = arg3 || {};
  } else {
    payload = arg2 || {};
    user = arg3;
  }
  const { registrationIds = [], status, denialReason } = payload;
  if (!Array.isArray(registrationIds) || registrationIds.length === 0) {
    throw { statusCode: 400, message: 'Please select at least one registration.' };
  }

  let updatedCount = 0;
  for (const regId of registrationIds) {
    try {
      await updateRegistrationStatus(tournamentPublicId, regId, user, { status, denialReason });
      updatedCount++;
    } catch (err) {
      console.warn(`Bulk update failed for ${regId}:`, err);
    }
  }

  return {
    success: true,
    message: `Updated status to ${status} for ${updatedCount} player(s).`,
    updatedCount
  };
};

/**
 * 9. Reveal Sensitive Data (Aadhaar full value) with Access Log
 */
const revealSensitiveData = async (tournamentPublicId, regPublicId, user, ipAddress = '') => {
  const tournament = await getTournamentEntity(tournamentPublicId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found.' };

  const rows = await db.query(
    `SELECT * FROM tournament_player_registrations WHERE (uuid = ? OR id = ?) AND tournament_id = ?`,
    [regPublicId, /^\d+$/.test(String(regPublicId)) ? parseInt(regPublicId, 10) : -1, tournament.id]
  );

  if (!rows.length) throw { statusCode: 404, message: 'Registration not found.' };
  const reg = rows[0];

  // Log access audit
  const userRole = user.role || (Array.isArray(user.roles) ? user.roles[0] : 'ADMIN');
  await db.query(
    `INSERT INTO sensitive_data_access_logs (user_id, user_role, registration_id, accessed_field, ip_address)
     VALUES (?, ?, ?, 'aadhaar', ?)`,
    [user.id, userRole, reg.id, ipAddress || '']
  );

  const decryptedAadhaar = reg.aadhaar_encrypted ? decryptSensitive(reg.aadhaar_encrypted) : null;

  return {
    success: true,
    aadhaar: decryptedAadhaar,
    aadhaarNumber: decryptedAadhaar,
    address: reg.address
  };
};

/**
 * 10. Get all registrations for logged in player
 */
const getMyRegistrationsAcrossTournaments = async (user) => {
  if (!user || !user.id) return [];

  const rows = await db.query(
    `SELECT 
      r.uuid as registration_id, r.status, r.denial_reason, r.created_at,
      t.uuid as tournament_id, t.name as tournament_name, t.start_date, t.end_date, t.banner_url,
      s.name as sport_name,
      tm.name as assigned_team_name,
      r.assigned_role
     FROM tournament_player_registrations r
     JOIN tournaments t ON r.tournament_id = t.id
     LEFT JOIN sports s ON t.sport_id = s.id
     LEFT JOIN teams tm ON r.assigned_team_id = tm.id
     WHERE r.user_id = ?
     ORDER BY r.created_at DESC`,
    [user.id]
  );

  return rows.map(r => ({
    registrationId: r.registration_id,
    status: r.status,
    denialReason: r.denial_reason,
    createdAt: r.created_at,
    tournament: {
      id: r.tournament_id,
      name: r.tournament_name,
      startDate: r.start_date,
      endDate: r.end_date,
      bannerUrl: r.banner_url,
      sportName: r.sport_name
    },
    assignedTeamName: r.assigned_team_name,
    assignedRole: r.assigned_role
  }));
};

module.exports = {
  validateVerhoeff,
  encryptSensitive,
  decryptSensitive,
  getRegistrationConfig,
  updateRegistrationConfig,
  submitPlayerRegistration,
  getTournamentPlayerRegistrations,
  getMyTournamentRegistration,
  withdrawMyRegistration,
  updateRegistrationStatus,
  bulkUpdateRegistrationStatus,
  revealSensitiveData,
  getMyRegistrationsAcrossTournaments
};
