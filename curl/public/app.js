const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const curlInput = $('#curlInput');
const runBtn = $('#runBtn');
const clearBtn = $('#clearBtn');
const shareBtn = $('#shareBtn');
const copyCurlBtn = $('#copyCurlBtn');
const sampleBtn = $('#sampleBtn');
const generateBtn = $('#generateBtn');
const historyList = $('#historyList');
const historySearch = $('#historySearch');
const clearHistoryBtn = $('#clearHistoryBtn');
const uaStatus = $('#uaStatus');
const themeToggle = $('#themeToggle');
const errorBox = $('#errorBox');
const statusMetric = $('#statusMetric');
const durationMetric = $('#durationMetric');
const sizeMetric = $('#sizeMetric');
const bodyView = $('#bodyView');
const rawView = $('#rawView');
const headersView = $('#headersView');
const cookiesView = $('#cookiesView');
const htmlPreviewBtn = $('#htmlPreviewBtn');
const imagePreviewBtn = $('#imagePreviewBtn');
const copyResultBtn = $('#copyResultBtn');
const previewDialog = $('#previewDialog');
const previewHost = $('#previewHost');
const previewTitle = $('#previewTitle');
const closePreviewBtn = $('#closePreviewBtn');

const HISTORY_KEY = 'curl-web-runner-history';
const THEME_KEY = 'curl-web-runner-theme';
const MAX_HISTORY = 200;

const userAgents = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  macos: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1'
};

let lastResult = null;
let activeTab = 'body';

function shellQuote(value) {
  if (value === '') return "''";
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveHistory(command, result) {
  if (hasSensitiveParts(command)) return;
  const item = {
    command,
    status: result?.response?.status || '-',
    url: result?.request?.url || command,
    at: new Date().toISOString()
  };
  const next = [item, ...getHistory().filter((entry) => entry.command !== command)].slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  renderHistory();
}

function hasSensitiveParts(command) {
  return /(?:^|\s)(?:-u|--user|--cookie)(?:\s|=)/i.test(command) ||
    /(?:^|\s)-H\s+(['"]?)(?:authorization|cookie)\s*:/i.test(command);
}

function renderHistory() {
  const history = getHistory();
  const query = historySearch.value.trim().toLowerCase();
  const indexedHistory = history.map((entry, index) => ({ entry, index }));
  const visibleHistory = query
    ? indexedHistory.filter(({ entry }) => [entry.command, entry.url, entry.status, entry.at].some((value) => String(value || '').toLowerCase().includes(query)))
    : indexedHistory;
  if (!history.length) {
    historyList.innerHTML = '<p class="muted">No history yet.</p>';
    return;
  }
  if (!visibleHistory.length) {
    historyList.innerHTML = '<p class="muted">No matching history.</p>';
    return;
  }
  historyList.innerHTML = visibleHistory.map(({ entry, index }) => `
    <button class="history-item" type="button" data-index="${index}">
      <strong>${escapeHtml(entry.url)}</strong>
      <span>${escapeHtml(String(entry.status))} · ${new Date(entry.at).toLocaleString()}</span>
    </button>
  `).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  themeToggle.checked = theme === 'light';
  localStorage.setItem(THEME_KEY, theme);
}

function applyUserAgent(kind) {
  const ua = userAgents[kind];
  const command = curlInput.value.trim() || 'curl https://example.com';
  const header = `-H ${shellQuote(`User-Agent: ${ua}`)}`;
  const hasHeader = /(?:^|\s)-H\s+(['"])User-Agent:\s*[\s\S]*?\1/i.test(command);
  const hasLongUa = /(?:^|\s)(?:-A|--user-agent)(?:\s+|=)(['"]?)[^\s'"]+\1/i.test(command);
  let next = command;
  if (hasHeader) {
    next = next.replace(/(?:^|\s)-H\s+(['"])User-Agent:\s*[\s\S]*?\1/i, ` ${header}`);
  } else if (hasLongUa) {
    next = next.replace(/(?:^|\s)(?:-A|--user-agent)(?:\s+|=)(['"]?)[^\s'"]+\1/i, ` -A ${shellQuote(ua)}`);
  } else {
    next = `${next} ${header}`;
  }
  curlInput.value = next.trim();
  uaStatus.textContent = `Applied Chrome / ${kind}`;
  $$('.ua-strip button').forEach((button) => button.classList.toggle('active', button.dataset.ua === kind));
}

function buildCurlFromForm() {
  const method = $('#methodField').value;
  const url = $('#urlField').value.trim();
  const headers = $('#headersField').value.split('\n').map((line) => line.trim()).filter(Boolean);
  const body = $('#bodyField').value;
  if (!url) {
    showError('INVALID_INPUT', 'URLを入力してください。');
    return;
  }
  const parts = ['curl'];
  if (method && method !== 'GET') parts.push('-X', method);
  parts.push(shellQuote(url));
  for (const header of headers) parts.push('-H', shellQuote(header));
  if (body) parts.push('-d', shellQuote(body));
  curlInput.value = parts.join(' ');
  hideError();
}

function showError(code, message) {
  errorBox.hidden = false;
  errorBox.textContent = `${code}: ${message}`;
}

function hideError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

function renderResult(data) {
  lastResult = data;
  const response = data.response;
  statusMetric.textContent = `${response.status} ${response.statusText || ''}`.trim();
  durationMetric.textContent = `${response.durationMs} ms`;
  sizeMetric.textContent = formatBytes(response.size);

  let body = response.body || '';
  if (response.bodyType === 'json' && body) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {}
  }
  if (response.bodyType === 'binary') {
    body = `binary response (${formatBytes(response.size)})`;
  }
  if (response.bodyType === 'image') {
    body = `image response (${formatBytes(response.size)})`;
  }
  bodyView.textContent = body || '(empty body)';

  headersView.innerHTML = renderHeadersTable(response.headers);
  rawView.textContent = buildRaw(data);
  cookiesView.innerHTML = renderCookies(response.headers);

  htmlPreviewBtn.disabled = response.bodyType !== 'html';
  imagePreviewBtn.disabled = response.bodyType !== 'image' || !response.bodyBase64;
}

function renderHeadersTable(headers) {
  const entries = Object.entries(headers || {});
  if (!entries.length) return '<p class="muted">No headers.</p>';
  return `<table>
    <thead><tr><th>Header Name</th><th>Value</th></tr></thead>
    <tbody>${entries.map(([name, value]) => `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody>
  </table>`;
}

function buildRaw(data) {
  const response = data.response;
  const lines = [`HTTP ${response.status} ${response.statusText || ''}`.trim()];
  for (const [name, value] of Object.entries(response.headers || {})) {
    lines.push(`${name}: ${value}`);
  }
  lines.push('', response.bodyType === 'image' ? `[image response: ${formatBytes(response.size)}]` : (response.body || ''));
  return lines.join('\n');
}

function renderCookies(headers) {
  const setCookie = Object.entries(headers || {}).filter(([name]) => name.toLowerCase() === 'set-cookie').flatMap(([, value]) => splitSetCookie(value));
  if (!setCookie.length) return '<p class="muted">No Set-Cookie headers.</p>';
  const rows = setCookie.map((cookie) => {
    const parsed = parseCookie(cookie);
    return `<tr>
      <td>${escapeHtml(parsed.name)}</td>
      <td>${escapeHtml(parsed.value)}</td>
      <td>${escapeHtml(parsed.domain)}</td>
      <td>${escapeHtml(parsed.path)}</td>
      <td>${escapeHtml(parsed.expires)}</td>
      <td>${parsed.secure ? 'yes' : ''}</td>
      <td>${parsed.httponly ? 'yes' : ''}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr><th>Name</th><th>Value</th><th>Domain</th><th>Path</th><th>Expires</th><th>Secure</th><th>HttpOnly</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function splitSetCookie(value) {
  return String(value).split(/,\s*(?=[^;,]+=)/);
}

function parseCookie(value) {
  const parts = value.split(';').map((part) => part.trim());
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf('=');
  const parsed = {
    name: eq >= 0 ? nameValue.slice(0, eq) : nameValue,
    value: eq >= 0 ? nameValue.slice(eq + 1) : '',
    domain: '',
    path: '',
    expires: '',
    secure: false,
    httponly: false
  };
  for (const attr of attrs) {
    const [rawKey, ...rawValue] = attr.split('=');
    const key = rawKey.toLowerCase();
    const attrValue = rawValue.join('=');
    if (key === 'domain') parsed.domain = attrValue;
    else if (key === 'path') parsed.path = attrValue;
    else if (key === 'expires') parsed.expires = attrValue;
    else if (key === 'secure') parsed.secure = true;
    else if (key === 'httponly') parsed.httponly = true;
  }
  return parsed;
}

async function runCurl() {
  const command = curlInput.value.trim();
  if (!command) {
    showError('INVALID_INPUT', 'curlコマンドを入力してください。');
    return;
  }
  runBtn.disabled = true;
  runBtn.textContent = 'Running...';
  hideError();
  try {
    const response = await fetch('/api/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ curl: command })
    });
    const data = await response.json();
    if (!data.ok) {
      showError(data.error.code, data.error.message);
      return;
    }
    renderResult(data);
    saveHistory(command, data);
  } catch (error) {
    showError('NETWORK_ERROR', error.message);
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = 'Run';
  }
}

function setActiveTab(tab) {
  activeTab = tab;
  $$('.tabs button').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  $$('.tab-page').forEach((page) => page.classList.remove('active'));
  $(`#${tab}Tab`).classList.add('active');
}

async function copyText(value) {
  await navigator.clipboard.writeText(value);
}

function openHtmlPreview() {
  if (!lastResult) return;
  previewTitle.textContent = 'HTML Preview';
  previewHost.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', '');
  iframe.srcdoc = lastResult.response.body || '';
  previewHost.append(iframe);
  previewDialog.showModal();
}

function openImagePreview() {
  if (!lastResult) return;
  const contentType = lastResult.response.headers['content-type'] || 'image/*';
  previewTitle.textContent = 'Image Preview';
  previewHost.innerHTML = '';
  const img = document.createElement('img');
  img.alt = 'Response image preview';
  img.src = `data:${contentType};base64,${lastResult.response.bodyBase64}`;
  previewHost.append(img);
  previewDialog.showModal();
}

function loadSharedCommand() {
  const params = new URLSearchParams(location.search);
  const shared = params.get('q');
  if (!shared) return;
  try {
    curlInput.value = decodeURIComponent(escape(atob(shared)));
  } catch {
    curlInput.value = shared;
  }
}

function createShareUrl() {
  const encoded = btoa(unescape(encodeURIComponent(curlInput.value)));
  const url = new URL(location.href);
  url.searchParams.set('q', encoded);
  return url.toString();
}

runBtn.addEventListener('click', runCurl);
clearBtn.addEventListener('click', () => {
  curlInput.value = '';
  lastResult = null;
  uaStatus.textContent = 'No preset applied';
  $$('.ua-strip button').forEach((button) => button.classList.remove('active'));
  hideError();
  statusMetric.textContent = '-';
  durationMetric.textContent = '-';
  sizeMetric.textContent = '-';
  bodyView.textContent = 'Run a request to see the response body.';
  rawView.textContent = '';
  headersView.innerHTML = '';
  cookiesView.innerHTML = '';
  htmlPreviewBtn.disabled = true;
  imagePreviewBtn.disabled = true;
});
shareBtn.addEventListener('click', async () => {
  if (hasSensitiveParts(curlInput.value) && !confirm('Authorization、Cookie、Basic認証などが共有URLに含まれる可能性があります。続行しますか？')) {
    return;
  }
  await copyText(createShareUrl());
  shareBtn.textContent = 'Copied';
  setTimeout(() => { shareBtn.textContent = 'Share URL'; }, 900);
});
copyCurlBtn.addEventListener('click', () => copyText(curlInput.value));
copyResultBtn.addEventListener('click', () => {
  const text = activeTab === 'body' ? bodyView.textContent : activeTab === 'raw' ? rawView.textContent : document.querySelector(`#${activeTab}Tab`).innerText;
  copyText(text || '');
});
sampleBtn.addEventListener('click', () => {
  curlInput.value = "curl -L -H 'Accept: application/json' https://httpbin.org/json";
});
generateBtn.addEventListener('click', buildCurlFromForm);
clearHistoryBtn.addEventListener('click', () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});
historySearch.addEventListener('input', renderHistory);
historyList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-index]');
  if (!button) return;
  const item = getHistory()[Number(button.dataset.index)];
  if (item) curlInput.value = item.command;
});
$$('.ua-strip button').forEach((button) => button.addEventListener('click', () => applyUserAgent(button.dataset.ua)));
$$('.tabs button').forEach((button) => button.addEventListener('click', () => setActiveTab(button.dataset.tab)));
htmlPreviewBtn.addEventListener('click', openHtmlPreview);
imagePreviewBtn.addEventListener('click', openImagePreview);
closePreviewBtn.addEventListener('click', () => previewDialog.close());
themeToggle.addEventListener('change', () => applyTheme(themeToggle.checked ? 'light' : 'dark'));

applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
loadSharedCommand();
renderHistory();
