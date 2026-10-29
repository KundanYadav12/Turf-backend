const readline = require('readline');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables reliably from backend/.env or parent .env
dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env') });

const db = require('../config/database');

let activeSession = null;

/**
 * Initializes a single, managed prompt session for the CLI command lifecycle.
 * Handles interactive TTY terminals (with silent masked password entry)
 * as well as automated piped/CI streams cleanly via line queueing.
 */
function getPromptSession() {
  if (activeSession) return activeSession;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY)
  });

  const isTTY = Boolean(process.stdin.isTTY);
  const lineQueue = [];
  const waitingResolvers = [];

  rl.on('line', (line) => {
    if (waitingResolvers.length > 0) {
      const resolver = waitingResolvers.shift();
      resolver(line.trim());
    } else {
      lineQueue.push(line.trim());
    }
  });

  function promptText(questionText) {
    process.stdout.write(questionText);
    return new Promise((resolve) => {
      if (lineQueue.length > 0) {
        resolve(lineQueue.shift());
      } else {
        waitingResolvers.push(resolve);
      }
    });
  }

  function promptPassword(questionText) {
    if (!isTTY) {
      // In piped/non-interactive streams, read directly without terminal masking
      return promptText(questionText);
    }

    // In interactive TTY, mute terminal stdout during keystrokes
    return new Promise((resolve) => {
      let isMuted = true;
      const originalWrite = rl._writeToOutput;
      rl._writeToOutput = function (stringToWrite) {
        if (isMuted) {
          if (stringToWrite.includes('\r') || stringToWrite.includes('\n')) {
            originalWrite.call(rl, '\n');
          }
        } else {
          originalWrite.call(rl, stringToWrite);
        }
      };

      process.stdout.write(questionText);

      const onLine = (line) => {
        isMuted = false;
        rl._writeToOutput = originalWrite;
        resolve(line.trim());
      };

      if (lineQueue.length > 0) {
        onLine(lineQueue.shift());
      } else {
        waitingResolvers.push(onLine);
      }
    });
  }

  function close() {
    rl.close();
    activeSession = null;
  }

  activeSession = {
    promptText,
    promptPassword,
    close
  };

  return activeSession;
}

/**
 * Convenience wrappers using the singleton prompt session
 */
function promptText(questionText) {
  return getPromptSession().promptText(questionText);
}

function promptPassword(questionText) {
  return getPromptSession().promptPassword(questionText);
}

/**
 * Validate email address format and length
 */
function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    return { valid: false, message: 'Email address is required.' };
  }
  const cleanEmail = email.trim().toLowerCase();
  if (cleanEmail.length > 150) {
    return { valid: false, message: 'Email address cannot exceed 150 characters.' };
  }
  // Standard RFC 5322 compliant email regex
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (!emailRegex.test(cleanEmail)) {
    return { valid: false, message: 'Please enter a valid email address (e.g., admin@example.com).' };
  }
  return { valid: true, email: cleanEmail };
}

/**
 * Validate password according to security policy:
 * - Minimum 8 characters
 * - Maximum 128 characters
 * - At least one letter
 * - At least one digit
 */
function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, message: 'Password is required.' };
  }
  if (password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters long.' };
  }
  if (password.length > 128) {
    return { valid: false, message: 'Password cannot exceed 128 characters.' };
  }
  if (!/[a-zA-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one letter.' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one number.' };
  }
  return { valid: true };
}

/**
 * Derive a unique, normalized username for Superadmin
 */
async function generateUniqueUsername(baseName = 'superadmin', targetEmail = '') {
  let seed = String(baseName || (targetEmail && targetEmail.split('@')[0]) || 'superadmin')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (seed.length < 3) {
    seed = `superadmin_${Date.now().toString().slice(-4)}`;
  }
  seed = seed.slice(0, 30);

  let candidate = seed;
  let counter = 1;

  while (true) {
    const existing = await db.query('SELECT id FROM users WHERE LOWER(username) = ?', [candidate]);
    if (!existing || existing.length === 0) {
      return candidate;
    }
    candidate = `${seed.slice(0, 24)}_${counter++}`;
  }
}

/**
 * Record structured administrative audit log without exposing passwords or hashes
 */
function recordAudit(action, details = {}) {
  const auditEvent = {
    event: 'SUPERADMIN_CLI_AUDIT',
    action,
    timestamp: new Date().toISOString(),
    systemUser: os.userInfo ? os.userInfo().username : 'unknown',
    hostname: os.hostname ? os.hostname() : 'localhost',
    details
  };
  console.log(`\n📋 [AUDIT LOG] ${JSON.stringify(auditEvent)}`);
}

/**
 * Gracefully close prompt session and database pool before exiting
 */
async function cleanupAndExit(code = 0) {
  try {
    if (activeSession) {
      activeSession.close();
    }
  } catch (_) {}

  try {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  } catch (_) {}

  process.exit(code);
}

module.exports = {
  db,
  getPromptSession,
  promptText,
  promptPassword,
  validateEmail,
  validatePassword,
  generateUniqueUsername,
  recordAudit,
  cleanupAndExit
};
