#!/usr/bin/env node
'use strict';

// Guarded Prolibu API helper for agent skills.
// Guards the host and path, keeps the API key out of output, and refuses
// writes unless the caller passes --confirmed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', '..');
const PROFILE_RE = /^[a-z0-9-]+$/;
const REQUEST_TIMEOUT_MS = 30000;
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
const WRITE_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const NON_PROD_RE = /^(dev\d*|stg|staging|qa|test)$/;
const SECRET_KEYS = new Set(['apikey', 'token', 'accesstoken', 'refreshtoken', 'password', 'secret', 'clientsecret']);

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function parseArgs(argv, rootDir = DEFAULT_ROOT) {
  const positional = [];
  let dataText;
  let dataFile;
  let confirmed = false;
  let profile;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirmed') {
      confirmed = true;
    } else if (arg === '--profile') {
      if (i + 1 >= argv.length) throw new UsageError('Missing value for --profile.');
      i += 1;
      profile = argv[i];
      if (!PROFILE_RE.test(profile)) {
        throw new UsageError('Invalid profile name. Use lowercase letters, digits and hyphens.');
      }
    } else if (arg === '--data' || arg === '--data-file') {
      if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${arg}.`);
      i += 1;
      if (arg === '--data') dataText = argv[i];
      else dataFile = argv[i];
    } else if (arg.startsWith('--')) {
      throw new UsageError(`Unknown option ${arg}.`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 3) {
    throw new UsageError('Usage: prolibu-api.js <domain> <METHOD> <path> [--data \'<json>\' | --data-file <file>] [--profile <name>] [--confirmed]');
  }
  if (dataText !== undefined && dataFile !== undefined) {
    throw new UsageError('Use either --data or --data-file, not both.');
  }
  const [domain, rawMethod, reqPath] = positional;
  const method = rawMethod.toUpperCase();
  if (!METHODS.includes(method)) throw new UsageError(`Unsupported method ${rawMethod}.`);

  if ((dataText !== undefined || dataFile !== undefined) && (method === 'GET' || method === 'DELETE')) {
    throw new UsageError(`${method} requests cannot have a body. Remove --data / --data-file.`);
  }

  let data;
  if (dataFile !== undefined) {
    assertDataFileAllowed(dataFile, rootDir);
    try {
      dataText = fs.readFileSync(dataFile, 'utf8');
    } catch {
      throw new UsageError(`Cannot read --data-file ${dataFile}.`);
    }
  }
  if (dataText !== undefined) {
    try {
      data = JSON.parse(dataText);
    } catch {
      throw new UsageError('Invalid JSON in request body.');
    }
  }
  return { domain, method, path: reqPath, data, confirmed, profile };
}

function hasControlChar(text) {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 0x1f) return true;
  }
  return false;
}

function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(child, dir) {
  return child === dir || child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

// Body files may only come from temp folders: the OS temp dir, $TMPDIR and $CLAUDE_SCRATCHPAD.
function allowedDataDirs() {
  const dirs = [os.tmpdir(), process.env.TMPDIR, process.env.CLAUDE_SCRATCHPAD].filter(Boolean);
  return [...new Set(dirs.flatMap((d) => [path.resolve(d), realOrResolved(d)]))];
}

// A prompt-injected agent could try to send a stored API key or a repo file as a request body.
function assertDataFileAllowed(file, rootDir) {
  const real = realOrResolved(file);
  if (!allowedDataDirs().some((dir) => isInside(real, dir))) {
    throw new UsageError('Refusing --data-file: the file must be in a temp folder. Write the body to a temp file or pass it inline with --data.');
  }
  const candidates = [path.resolve(file)];
  try {
    candidates.push(fs.realpathSync(file));
  } catch {
    // Unreadable files fail later with a clear message.
  }
  let accountsDir = path.resolve(rootDir, 'accounts');
  try {
    accountsDir = fs.realpathSync(accountsDir);
  } catch {
    // No accounts directory: the lexical check below still applies.
  }
  const accountsDirs = new Set([path.resolve(rootDir, 'accounts'), accountsDir]);
  for (const resolved of candidates) {
    const underAccounts = [...accountsDirs].some((dir) => resolved === dir || resolved.startsWith(dir + path.sep));
    if (/^profile.*\.json$/i.test(path.basename(resolved)) || underAccounts) {
      throw new UsageError('Refusing --data-file: profile files and anything under accounts/ cannot be used as a request body.');
    }
  }
}

function validateTarget(domain, reqPath) {
  if (typeof domain !== 'string' || !DOMAIN_RE.test(domain)) {
    throw new UsageError('Invalid domain. Expected something like example.prolibu.com.');
  }
  if (typeof reqPath !== 'string' || !/^\/v2\//.test(reqPath)) {
    throw new UsageError('Invalid path. It must start with /v2/.');
  }
  if (reqPath.includes('..') || reqPath.includes('//') || /[\\\s]|%2e|%2f|%5c/i.test(reqPath) || hasControlChar(reqPath)) {
    throw new UsageError('Invalid path. Traversal, double slashes and encoded separators are not allowed.');
  }
}

function loadApiKey(domain, rootDir, profile) {
  validateTarget(domain, '/v2/');
  const fileName = profile ? `profile.${profile}.json` : 'profile.json';
  const file = path.join(rootDir, 'accounts', domain, fileName);
  let key;
  try {
    key = JSON.parse(fs.readFileSync(file, 'utf8')).apiKey;
  } catch {
    throw new UsageError(`No profile for ${domain}. Expected accounts/${domain}/${fileName} with an apiKey.`);
  }
  if (typeof key !== 'string' || !key) {
    throw new UsageError(`No profile for ${domain}. The ${fileName} file has no apiKey.`);
  }
  return key;
}

function redact(text, secret) {
  if (!secret) return text;
  const variants = new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
  let result = text;
  for (const v of variants) result = result.split(v).join('***');
  return result;
}

// Replaces the value of well-known secret keys in a parsed response, at any depth.
function redactFields(value) {
  if (Array.isArray(value)) return value.map(redactFields);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? '***' : redactFields(v);
    }
    return out;
  }
  return value;
}

function isLikelyProduction(domain) {
  return !NON_PROD_RE.test(String(domain).split('.')[0]);
}

async function run(argv, opts = {}) {
  const rootDir = opts.rootDir || DEFAULT_ROOT;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  let key = '';
  try {
    const args = parseArgs(argv, rootDir);
    validateTarget(args.domain, args.path);
    const isWrite = WRITE_METHODS.includes(args.method);
    if (isWrite && !args.confirmed) {
      throw new UsageError('Refusing to write without --confirmed. Show the user what will change and ask first.');
    }
    key = loadApiKey(args.domain, rootDir, args.profile);
    if (isWrite && isLikelyProduction(args.domain)) {
      stderr.write(`WARNING: ${args.domain} looks like a production account.\n`);
    }
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    const init = {
      method: args.method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (args.data !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(args.data);
    }
    const res = await fetchImpl(`https://${args.domain}${args.path}`, init);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    const printed = { status: res.status, body: redactFields(body) };
    stdout.write(`${redact(JSON.stringify(printed, null, 2), key)}\n`);
    return res.status >= 200 && res.status < 300 ? 0 : 1;
  } catch (e) {
    if (e instanceof UsageError) {
      stderr.write(`${redact(e.message, key)}\n`);
      return 2;
    }
    if (e && e.name === 'TimeoutError') {
      stderr.write(`Request failed: timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.\n`);
      return 1;
    }
    stderr.write(`Request failed: ${redact(String(e && e.message), key)}\n`);
    return 1;
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { parseArgs, validateTarget, loadApiKey, redact, redactFields, isLikelyProduction, run, UsageError };
