/**
 * Simple file logger that mirrors console.log/error output to a log file.
 *
 * The log file lives at <project-root>/walkie-talkai.log so it's easy to
 * find when the app runs without a terminal (e.g. launched via the
 * Windows shortcut or `electron-builder` package).
 */

import fs from 'node:fs';
import path from 'node:path';
import { getUserDataDir } from './config.js';

const LOG_PATH = path.join(getUserDataDir(), 'walkie-talkai.log');
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB before rotation

let stream = null;

function ensureStream() {
  if (stream) return stream;

  // Rotate if the existing log is too large
  try {
    if (fs.existsSync(LOG_PATH)) {
      const { size } = fs.statSync(LOG_PATH);
      if (size > MAX_BYTES) {
        const rotated = LOG_PATH.replace(/\.log$/, '.prev.log');
        try { fs.unlinkSync(rotated); } catch { /* ignore */ }
        fs.renameSync(LOG_PATH, rotated);
      }
    }
  } catch { /* ignore */ }

  try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); } catch { /* ignore */ }
  stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  stream.on('error', () => { /* swallow write errors (disk full, permissions) */ });
  return stream;
}

function ts() {
  return new Date().toISOString();
}

function format(level, args) {
  const line = args
    .map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ');
  return `[${ts()}] ${level} ${line}\n`;
}

/** Install the logger — hooks console.log / console.error / console.warn. */
export function installLogger() {
  const s = ensureStream();

  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.log = (...args) => {
    try { s.write(format('INFO ', args)); } catch { /* ignore */ }
    origLog(...args);
  };
  console.error = (...args) => {
    try { s.write(format('ERROR', args)); } catch { /* ignore */ }
    origError(...args);
  };
  console.warn = (...args) => {
    try { s.write(format('WARN ', args)); } catch { /* ignore */ }
    origWarn(...args);
  };

  // Log unhandled errors
  process.on('uncaughtException', (err) => {
    try { s.write(format('FATAL', [`uncaughtException: ${err.stack || err.message}`])); } catch { /* ignore */ }
  });
  process.on('unhandledRejection', (reason) => {
    try { s.write(format('FATAL', [`unhandledRejection: ${reason?.stack || reason}`])); } catch { /* ignore */ }
  });

  console.log(`--- walkie-talkai started (${process.platform} node=${process.versions.node} electron=${process.versions.electron || 'n/a'}) ---`);
  console.log(`Log file: ${LOG_PATH}`);
}

export function getLogPath() {
  return LOG_PATH;
}
