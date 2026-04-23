import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const auditLogPath = path.join(__dirname, 'logs', 'audit.log');
const PORT = Number(process.env.PORT || 3000);
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_CURL_CHARS = 100_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_NAME_CHARS = 80;
const MAX_HEADER_VALUE_CHARS = 8 * 1024;
const MAX_URL_CHARS = 8 * 1024;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

const rateLimits = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const FORBIDDEN_OPTIONS = new Set([
  '--proxy',
  '-x',
  '--output',
  '-o',
  '--remote-name',
  '-O',
  '--config',
  '-K',
  '--interface',
  '--resolve',
  '--connect-to',
  '--form',
  '-F',
  '--form-string',
  '--upload-file',
  '-T',
  '--unix-socket'
]);

const UNSUPPORTED_WITH_VALUE = new Set([
  '--url-query',
  '--request-target',
  '--cert',
  '--key',
  '--cacert',
  '--capath',
  '--aws-sigv4'
]);

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const FORBIDDEN_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

const USER_AGENT = 'CurlWebRunner/1.0';

class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...securityHeaders(false)
  });
  res.end(body);
}

function securityHeaders(isHtml = false) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'x-frame-options': 'DENY'
  };
  if (isHtml) {
    headers['content-security-policy'] = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self' about:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join('; ');
  }
  return headers;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const current = rateLimits.get(ip) || { startedAt: now, count: 0 };
  if (now - current.startedAt > RATE_LIMIT_WINDOW_MS) {
    current.startedAt = now;
    current.count = 0;
  }
  current.count += 1;
  rateLimits.set(ip, current);
  if (current.count > RATE_LIMIT_MAX) {
    throw new AppError('RATE_LIMITED', '実行回数が多すぎます。少し待ってから再試行してください。', 429);
  }
}

async function readJson(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new AppError('INVALID_INPUT', 'Content-Type は application/json を指定してください。', 415);
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new AppError('INVALID_INPUT', 'リクエスト本文が大きすぎます。', 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new AppError('INVALID_INPUT', 'JSON形式のリクエストを送信してください。');
  }
}

function tokenizeCurl(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (escaping) {
      if (ch === '\n' || ch === '\r') {
        escaping = false;
        continue;
      }
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (escaping) current += '\\';
  if (quote) throw new AppError('INVALID_CURL', 'クォートが閉じられていません。');
  if (current) tokens.push(current);
  return tokens;
}

function readOptionValue(tokens, index, option) {
  const inline = option.match(/^--[^=]+=([\s\S]*)$/);
  if (inline) return { value: inline[1], nextIndex: index };
  if (index + 1 >= tokens.length || tokens[index + 1].startsWith('-')) {
    throw new AppError('INVALID_CURL', `${option} の値がありません。`);
  }
  return { value: tokens[index + 1], nextIndex: index + 1 };
}

function splitShortOption(token) {
  if (token.length > 2 && /^-[XHduAe]$/.test(token.slice(0, 2))) {
    return [token.slice(0, 2), token.slice(2)];
  }
  return [token, null];
}

function parseHeader(value) {
  const separator = value.indexOf(':');
  if (separator <= 0) throw new AppError('INVALID_CURL', `ヘッダー形式が不正です: ${value}`);
  const name = value.slice(0, separator).trim();
  const headerValue = value.slice(separator + 1).trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new AppError('INVALID_CURL', `ヘッダー名が不正です: ${name}`);
  }
  if (name.length > MAX_HEADER_NAME_CHARS || headerValue.length > MAX_HEADER_VALUE_CHARS) {
    throw new AppError('INVALID_CURL', 'ヘッダーが長すぎます。');
  }
  if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(headerValue)) {
    throw new AppError('INVALID_CURL', 'ヘッダーに改行やNUL文字は利用できません。');
  }
  if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
    throw new AppError('FORBIDDEN_OPTION', `${name} ヘッダーは利用できません。`);
  }
  return [name, headerValue];
}

function rejectFileReference(value) {
  if (value.startsWith('@')) {
    throw new AppError('FORBIDDEN_OPTION', 'ローカルファイル参照（@file）は利用できません。');
  }
}

function parseCurl(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) throw new AppError('INVALID_INPUT', 'curlコマンドを入力してください。');
  if (trimmed.length > MAX_CURL_CHARS) throw new AppError('INVALID_INPUT', 'curlコマンドが長すぎます。', 413);
  const tokens = tokenizeCurl(trimmed);
  if (tokens[0] !== 'curl') throw new AppError('INVALID_CURL', '入力は curl で始めてください。');

  const request = {
    method: 'GET',
    url: '',
    headers: {},
    body: '',
    authBasic: null,
    followRedirects: false,
    headOnly: false,
    insecure: false,
    timeout: TIMEOUT_MS
  };
  const dataParts = [];

  for (let i = 1; i < tokens.length; i += 1) {
    let token = tokens[i];
    let attached = null;
    [token, attached] = splitShortOption(token);

    if (FORBIDDEN_OPTIONS.has(token) || FORBIDDEN_OPTIONS.has(tokens[i].split('=')[0])) {
      throw new AppError('FORBIDDEN_OPTION', `${token} は利用できません。`);
    }
    if (UNSUPPORTED_WITH_VALUE.has(token) || UNSUPPORTED_WITH_VALUE.has(tokens[i].split('=')[0])) {
      throw new AppError('UNSUPPORTED_OPTION', `${token} は未対応です。`);
    }

    if (token === '--compressed') {
      continue;
    }
    if (token === '--location' || token === '-L') {
      request.followRedirects = true;
      continue;
    }
    if (token === '--insecure' || token === '-k') {
      request.insecure = true;
      continue;
    }
    if (token === '-I' || token === '--head') {
      request.headOnly = true;
      request.method = 'HEAD';
      continue;
    }

    if (token === '-X' || token === '--request' || token.startsWith('--request=')) {
      const result = attached == null ? readOptionValue(tokens, i, token) : { value: attached, nextIndex: i };
      request.method = result.value.toUpperCase();
      if (!ALLOWED_METHODS.has(request.method)) {
        throw new AppError('UNSUPPORTED_OPTION', `${request.method} メソッドは利用できません。`);
      }
      i = result.nextIndex;
      continue;
    }

    if (token === '-H' || token === '--header' || token.startsWith('--header=')) {
      const result = attached == null ? readOptionValue(tokens, i, token) : { value: attached, nextIndex: i };
      const [name, value] = parseHeader(result.value);
      if (Object.keys(request.headers).length >= MAX_HEADER_COUNT && !Object.hasOwn(request.headers, name)) {
        throw new AppError('INVALID_CURL', 'ヘッダー数が多すぎます。');
      }
      request.headers[name] = value;
      i = result.nextIndex;
      continue;
    }

    if (
      ['-d', '--data', '--data-raw', '--data-binary'].includes(token) ||
      token.startsWith('--data=') ||
      token.startsWith('--data-raw=') ||
      token.startsWith('--data-binary=')
    ) {
      const result = attached == null ? readOptionValue(tokens, i, token) : { value: attached, nextIndex: i };
      rejectFileReference(result.value);
      if (Buffer.byteLength(result.value) > MAX_BODY_BYTES) {
        throw new AppError('INVALID_INPUT', 'リクエスト本文が大きすぎます。', 413);
      }
      dataParts.push(result.value);
      if (request.method === 'GET' || request.method === 'HEAD') request.method = 'POST';
      i = result.nextIndex;
      continue;
    }

    if (token === '-u' || token === '--user' || token.startsWith('--user=')) {
      const result = readOptionValue(tokens, i, token);
      if (/[\r\n\0]/.test(result.value)) throw new AppError('INVALID_CURL', `${token} に改行やNUL文字は利用できません。`);
      request.authBasic = result.value;
      i = result.nextIndex;
      continue;
    }

    if (token === '-A' || token === '--user-agent' || token.startsWith('--user-agent=')) {
      const result = attached == null ? readOptionValue(tokens, i, token) : { value: attached, nextIndex: i };
      if (/[\r\n\0]/.test(result.value) || result.value.length > MAX_HEADER_VALUE_CHARS) {
        throw new AppError('INVALID_CURL', `${token} の値が不正です。`);
      }
      request.headers['User-Agent'] = result.value;
      i = result.nextIndex;
      continue;
    }

    if (token === '-e' || token === '--referer' || token.startsWith('--referer=')) {
      const result = attached == null ? readOptionValue(tokens, i, token) : { value: attached, nextIndex: i };
      if (/[\r\n\0]/.test(result.value) || result.value.length > MAX_HEADER_VALUE_CHARS) {
        throw new AppError('INVALID_CURL', `${token} の値が不正です。`);
      }
      request.headers.Referer = result.value;
      i = result.nextIndex;
      continue;
    }

    if (token === '--cookie' || token.startsWith('--cookie=')) {
      const result = readOptionValue(tokens, i, token);
      rejectFileReference(result.value);
      if (/[\r\n\0]/.test(result.value) || result.value.length > MAX_HEADER_VALUE_CHARS) {
        throw new AppError('INVALID_CURL', '--cookie の値が不正です。');
      }
      request.headers.Cookie = result.value;
      i = result.nextIndex;
      continue;
    }

    if (token.startsWith('-')) {
      throw new AppError('UNSUPPORTED_OPTION', `${token} は未対応です。`);
    }

    if (!request.url) {
      request.url = token;
      continue;
    }

    throw new AppError('INVALID_CURL', `余分な引数があります: ${token}`);
  }

  if (!request.url) throw new AppError('URL_NOT_FOUND', 'URLが見つかりません。');
  request.body = dataParts.join('&');
  if (Buffer.byteLength(request.body) > MAX_BODY_BYTES) {
    throw new AppError('INVALID_INPUT', 'リクエスト本文が大きすぎます。', 413);
  }
  if (request.authBasic) {
    request.headers.Authorization = `Basic ${Buffer.from(request.authBasic).toString('base64')}`;
  }
  if (!request.headers['User-Agent']) request.headers['User-Agent'] = USER_AGENT;
  return request;
}

function normalizeUrl(url) {
  if (String(url).length > MAX_URL_CHARS) {
    throw new AppError('INVALID_CURL', 'URLが長すぎます。');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('INVALID_CURL', 'URL形式が不正です。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError('FORBIDDEN_HOST', 'http/https 以外のURLは利用できません。');
  }
  if (!parsed.hostname) {
    throw new AppError('INVALID_CURL', 'URLにホスト名がありません。');
  }
  if (parsed.username || parsed.password) {
    throw new AppError('FORBIDDEN_HOST', 'URL内のユーザー情報は利用できません。');
  }
  return parsed;
}

function ipv4ToNumber(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inIpv4Range(ip, cidr, bits) {
  const value = ipv4ToNumber(ip);
  const base = ipv4ToNumber(cidr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function isForbiddenIp(ip) {
  const normalized = normalizeIpForCheck(ip);
  if (net.isIP(normalized) === 4) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
      ['255.255.255.255', 32]
    ].some(([base, bits]) => inIpv4Range(normalized, base, bits));
  }

  const lower = normalized.toLowerCase();
  return lower === '::1' ||
    lower === '::' ||
    lower.startsWith('::ffff:') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    /^fe[89ab]/.test(lower);
}

function normalizeIpForCheck(ip) {
  const lower = String(ip || '').toLowerCase();
  const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  return lower;
}

async function assertSafeUrl(url) {
  const parsed = normalizeUrl(url);
  const host = normalizeHostname(parsed.hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new AppError('FORBIDDEN_HOST', 'localhost にはアクセスできません。');
  }
  if (net.isIP(host)) {
    if (isForbiddenIp(host)) throw new AppError('FORBIDDEN_HOST', 'プライベートIPやローカルIPにはアクセスできません。');
    return { parsed, address: normalizeIpForCheck(host), family: net.isIP(normalizeIpForCheck(host)) };
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: false });
  } catch {
    throw new AppError('NETWORK_ERROR', 'ホスト名を解決できません。');
  }
  if (!addresses.length || addresses.some((entry) => isForbiddenIp(entry.address))) {
    throw new AppError('FORBIDDEN_HOST', 'DNS解決先が禁止されたネットワークです。');
  }
  const selected = addresses[0];
  return { parsed, address: selected.address, family: selected.family };
}

function normalizeHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
}

function classifyBodyType(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('application/json') || type.includes('+json')) return 'json';
  if (type.includes('text/html')) return 'html';
  if (type.includes('xml')) return 'xml';
  if (type.startsWith('text/')) return 'text';
  if (type.startsWith('image/')) return 'image';
  return 'binary';
}

function headersToObject(headers) {
  const output = {};
  if (typeof headers?.forEach === 'function') {
    headers.forEach((value, key) => {
      output[key] = value;
    });
    return output;
  }
  for (const [key, value] of Object.entries(headers || {})) {
    output[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return output;
}

function redactRequest(request) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    headers[name] = ['authorization', 'cookie'].includes(lower) ? '********' : value;
  }
  return {
    method: request.method,
    url: request.url,
    headers,
    followRedirects: request.followRedirects,
    headOnly: request.headOnly,
    insecure: request.insecure
  };
}

function redactCurlForLog(input) {
  let value = String(input || '');
  value = value.replace(/((?:^|\s)-u\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1********');
  value = value.replace(/((?:^|\s)--user(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, '$1********');
  value = value.replace(/((?:^|\s)--cookie(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, '$1********');
  value = value.replace(/((?:^|\s)-H\s+)(['"])(authorization\s*:\s*)[\s\S]*?\2/gi, '$1$2$3********$2');
  value = value.replace(/((?:^|\s)-H\s+)(['"])(cookie\s*:\s*)[\s\S]*?\2/gi, '$1$2$3********$2');
  return value.length > 4000 ? `${value.slice(0, 4000)}...` : value;
}

async function writeAuditLog(entry) {
  const line = `${JSON.stringify(entry)}\n`;
  try {
    await fs.mkdir(path.dirname(auditLogPath), { recursive: true });
    await fs.appendFile(auditLogPath, line, { mode: 0o600 });
  } catch (error) {
    console.error('audit log write failed:', error.message);
  }
}

function requestOnce(url, request, target) {
  const parsed = new URL(url);
  const networkHost = normalizeHostname(parsed.hostname);
  const client = parsed.protocol === 'https:' ? https : http;
  const headers = { ...request.headers };
  if (!headers['Accept-Encoding'] && !headers['accept-encoding']) {
    headers['Accept-Encoding'] = 'identity';
  }

  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol: parsed.protocol,
      hostname: networkHost,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: request.method,
      headers,
      timeout: request.timeout,
      rejectUnauthorized: !request.insecure,
      servername: net.isIP(networkHost) ? undefined : networkHost,
      lookup: (_hostname, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        const lookupOptions = typeof options === 'function' ? {} : options;
        if (lookupOptions?.all) {
          cb(null, [{ address: target.address, family: target.family }]);
          return;
        }
        cb(null, target.address, target.family);
      }
    }, (res) => {
      const chunks = [];
      let size = 0;

      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new AppError('BODY_TOO_LARGE', 'レスポンス本文が大きすぎます。', 413));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', async () => {
        try {
          let buffer = Buffer.concat(chunks);
          const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
          const zlibOptions = { maxOutputLength: MAX_RESPONSE_BYTES };
          if (buffer.length && encoding.includes('br')) buffer = zlib.brotliDecompressSync(buffer, zlibOptions);
          else if (buffer.length && encoding.includes('gzip')) buffer = zlib.gunzipSync(buffer, zlibOptions);
          else if (buffer.length && encoding.includes('deflate')) buffer = zlib.inflateSync(buffer, zlibOptions);
          if (buffer.length > MAX_RESPONSE_BYTES) {
            reject(new AppError('BODY_TOO_LARGE', 'レスポンス本文が大きすぎます。', 413));
            return;
          }
          resolve({
            status: res.statusCode || 0,
            statusText: res.statusMessage || '',
            headers: headersToObject(res.headers),
            buffer,
            size: buffer.length
          });
        } catch (error) {
          reject(new AppError('NETWORK_ERROR', `レスポンスの展開に失敗しました: ${error.message}`, 502));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new AppError('TIMEOUT', 'リクエストがタイムアウトしました。', 504));
    });
    req.on('error', (error) => {
      reject(error instanceof AppError ? error : new AppError('NETWORK_ERROR', `通信に失敗しました: ${error.message}`, 502));
    });

    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
      req.write(request.body);
    }
    req.end();
  });
}

async function executeRequest(request) {
  let currentUrl = request.url;
  const startedAt = performance.now();
  const redirects = [];

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const target = await assertSafeUrl(currentUrl);
    let response;
    try {
      response = await requestOnce(currentUrl, request, target);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('NETWORK_ERROR', `通信に失敗しました: ${error.message}`, 502);
    }

    if (request.followRedirects && [301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) break;
      const nextUrl = new URL(location, currentUrl).toString();
      await assertSafeUrl(nextUrl);
      redirects.push({ status: response.status, location: nextUrl });
      if (response.status === 303 && request.method !== 'HEAD') {
        request.method = 'GET';
        request.body = '';
      }
      currentUrl = nextUrl;
      continue;
    }

    const contentType = response.headers['content-type'] || '';
    const bodyType = classifyBodyType(contentType);
    const buffer = request.headOnly ? Buffer.alloc(0) : response.buffer;
    const isTextLike = ['json', 'html', 'xml', 'text'].includes(bodyType);
    const body = isTextLike ? buffer.toString('utf8') : '';
    const bodyBase64 = bodyType === 'image' ? buffer.toString('base64') : '';

    return {
      finalUrl: currentUrl,
      redirects,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body,
      bodyBase64,
      bodyType,
      size: buffer.length,
      durationMs: Math.round(performance.now() - startedAt)
    };
  }

  throw new AppError('TOO_MANY_REDIRECTS', 'リダイレクト回数が上限を超えました。', 508);
}

async function handleExecute(req, res) {
  const ip = clientIp(req);
  let payload = null;
  let parsedRequest = null;
  checkRateLimit(req);
  try {
    payload = await readJson(req);
    parsedRequest = parseCurl(payload.curl);
    await assertSafeUrl(parsedRequest.url);
    const response = await executeRequest(parsedRequest);
    await writeAuditLog({
      at: new Date().toISOString(),
      ip,
      ok: true,
      curl: redactCurlForLog(payload.curl),
      request: redactRequest(parsedRequest),
      response: {
        status: response.status,
        statusText: response.statusText,
        finalUrl: response.finalUrl,
        bodyType: response.bodyType,
        size: response.size,
        durationMs: response.durationMs
      }
    });
    sendJson(res, 200, {
      ok: true,
      request: redactRequest(parsedRequest),
      response
    });
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'サーバーエラーが発生しました。', 500);
    await writeAuditLog({
      at: new Date().toISOString(),
      ip,
      ok: false,
      curl: redactCurlForLog(payload?.curl),
      request: parsedRequest ? redactRequest(parsedRequest) : null,
      error: {
        code: appError.code,
        message: appError.message
      }
    });
    throw appError;
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let safePath;
  try {
    safePath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', ...securityHeaders(false) });
    res.end('Bad request');
    return;
  }
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${path.sep}`)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', ...securityHeaders(false) });
    res.end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
      ...securityHeaders(ext === '.html')
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...securityHeaders(false) });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/execute') {
      await handleExecute(req, res);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res);
      return;
    }
    sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'サーバーエラーが発生しました。', 500);
    sendJson(res, appError.status, {
      ok: false,
      error: {
        code: appError.code,
        message: appError.message
      }
    });
  }
});

server.listen(PORT, () => {
  console.log(`cURL Web Runner listening on http://localhost:${PORT}`);
});

server.headersTimeout = 10_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;
