// ═══════════════════════════════════════
// AWS Account Checker - Frontend Logic
// Session-Persistent, Auto-Reconnect
// ═══════════════════════════════════════

// ═══ Session ID management ═══
function generateSessionId() {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
}

function getOrCreateSessionId() {
  let sessionId = sessionStorage.getItem('checker-session-id');
  if (!sessionId) {
    sessionId = generateSessionId();
    sessionStorage.setItem('checker-session-id', sessionId);
  }
  return sessionId;
}

const currentSessionId = getOrCreateSessionId();

// ═══ Socket.IO with auto-reconnect ═══
const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,   // Never stop trying
  reconnectionDelay: 1000,           // Start at 1s
  reconnectionDelayMax: 10000,       // Max 10s between retries
  timeout: 60000,                    // Connection timeout 60s
  transports: ['websocket', 'polling'],
  upgrade: true,
  forceNew: false,
});

// State
let results = [];
let currentFilter = 'all';
let isRunning = false;
let reconnectCount = 0;
let heartbeatInterval = null;
let connectionStatusEl = null;

// DOM Elements
const emailInput = document.getElementById('email-input');
const proxyInput = document.getElementById('proxy-input');
const captchaKey = document.getElementById('captcha-key');
const threadsInput = document.getElementById('threads');
const delayInput = document.getElementById('delay');
const proxyRotateInput = document.getElementById('proxy-rotate');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnClearEmails = document.getElementById('btn-clear-emails');
const btnRemoveDupes = document.getElementById('btn-remove-dupes');
const btnClearLog = document.getElementById('btn-clear-log');
const fileUpload = document.getElementById('file-upload');
const emailCount = document.getElementById('email-count');
const logContainer = document.getElementById('log-container');
const resultsList = document.getElementById('results-list');
const resultsEmpty = document.getElementById('results-empty');
const progressSection = document.getElementById('progress-section');
const progressText = document.getElementById('progress-text');
const progressPercent = document.getElementById('progress-percent');
const progressFill = document.getElementById('progress-fill');
const exportSection = document.getElementById('export-section');

// ═══ Connection status indicator ═══
function createConnectionStatus() {
  connectionStatusEl = document.getElementById('connection-status');
  if (!connectionStatusEl) return;
  updateConnectionStatus('connecting');
}

function updateConnectionStatus(status, detail) {
  if (!connectionStatusEl) return;
  
  const dot = connectionStatusEl.querySelector('.conn-dot');
  const text = connectionStatusEl.querySelector('.conn-text');
  
  if (!dot || !text) return;
  
  // Remove all status classes
  dot.className = 'conn-dot';
  
  switch(status) {
    case 'connected':
      dot.classList.add('conn-connected');
      text.textContent = 'Đã kết nối';
      break;
    case 'disconnected':
      dot.classList.add('conn-disconnected');
      text.textContent = detail || 'Mất kết nối — đang thử lại...';
      break;
    case 'reconnecting':
      dot.classList.add('conn-reconnecting');
      text.textContent = detail || 'Đang kết nối lại...';
      break;
    case 'connecting':
      dot.classList.add('conn-reconnecting');
      text.textContent = 'Đang kết nối...';
      break;
  }
}

// ═══ Heartbeat — keeps connection alive ═══
function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (socket.connected) {
      socket.emit('heartbeat', { sessionId: currentSessionId, timestamp: Date.now() });
    }
  }, 25000); // Every 25s
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ═══ Email count updater ═══
function updateEmailCount() {
  const emails = getEmails();
  emailCount.textContent = emails.length;
}

function getEmails() {
  return emailInput.value
    .split('\n')
    .map(e => e.trim())
    .filter(e => e && e.includes('@'));
}

emailInput.addEventListener('input', updateEmailCount);

// ═══ File upload ═══
fileUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (event) => {
    const existing = emailInput.value.trim();
    emailInput.value = existing 
      ? existing + '\n' + event.target.result 
      : event.target.result;
    updateEmailCount();
    addLog('info', `Đã tải ${file.name}`);
  };
  reader.readAsText(file);
  fileUpload.value = '';
});

// ═══ Clear emails ═══
btnClearEmails.addEventListener('click', () => {
  emailInput.value = '';
  updateEmailCount();
});

// ═══ Remove duplicates ═══
btnRemoveDupes.addEventListener('click', () => {
  const emails = getEmails();
  const unique = [...new Set(emails)];
  emailInput.value = unique.join('\n');
  updateEmailCount();
  const removed = emails.length - unique.length;
  if (removed > 0) {
    addLog('info', `Đã loại bỏ ${removed} email trùng lặp`);
  } else {
    addLog('info', 'Không có email trùng lặp');
  }
});

// ═══ Clear log ═══
btnClearLog.addEventListener('click', () => {
  logContainer.innerHTML = '';
});

// ═══ Start checking ═══
btnStart.addEventListener('click', () => {
  const emails = getEmails();
  if (emails.length === 0) {
    addLog('error', 'Vui lòng nhập ít nhất 1 email hợp lệ');
    return;
  }

  const proxies = proxyInput.value
    .split('\n')
    .map(p => p.trim())
    .filter(p => p);

  // Generate new session for new check
  const newSessionId = generateSessionId();
  sessionStorage.setItem('checker-session-id', newSessionId);

  const data = {
    emails,
    proxies,
    captchaKey: captchaKey.value.trim(),
    threads: parseInt(threadsInput.value) || 1,
    delay: parseInt(delayInput.value) || 2000,
    proxyRotateInterval: parseInt(proxyRotateInput.value) || 240,
    tmproxyKeys: document.getElementById('tmproxy-keys').value.trim(),
    tmproxyLocation: parseInt(document.getElementById('tmproxy-location').value) || 0,
    tmproxyIsp: parseInt(document.getElementById('tmproxy-isp').value) || 0,
    sessionId: newSessionId,
  };

  // Reset state
  results = [];
  currentFilter = 'all';
  updateResults();
  updateStats(0, 0, 0, 0);
  
  // Show progress
  progressSection.style.display = 'block';
  updateProgress(0, emails.length);
  
  // Update UI state
  setRunning(true);
  
  // Register session first, then start check
  socket.emit('register-session', newSessionId);
  socket.emit('start-check', data);
  addLog('info', `Bắt đầu kiểm tra ${emails.length} email... (Session: ${newSessionId.slice(-8)})`);
});

// ═══ Stop checking ═══
btnStop.addEventListener('click', () => {
  socket.emit('stop-check', { sessionId: sessionStorage.getItem('checker-session-id') });
  setRunning(false);
  addLog('warn', 'Đã gửi yêu cầu dừng');
});

// ═══════════════════════════════════════
// Socket.IO Connection Events
// ═══════════════════════════════════════

socket.on('connect', () => {
  reconnectCount = 0;
  updateConnectionStatus('connected');
  startHeartbeat();
  
  // Register session on every connect/reconnect
  const sessionId = sessionStorage.getItem('checker-session-id');
  if (sessionId) {
    socket.emit('register-session', sessionId);
  }
  
  addLog('info', 'Đã kết nối đến server ✓');
});

socket.on('disconnect', (reason) => {
  updateConnectionStatus('disconnected', `Mất kết nối (${reason}) — đang thử lại...`);
  stopHeartbeat();
  
  // DON'T set isRunning = false here! The checker is still running on server.
  // Only show a warning to the user.
  if (isRunning) {
    addLog('warn', `⚠ Mất kết nối tạm thời (${reason}). Checker vẫn đang chạy trên server. Đang tự kết nối lại...`);
  } else {
    addLog('warn', `Mất kết nối (${reason}). Đang tự kết nối lại...`);
  }
});

socket.on('reconnect_attempt', (attemptNumber) => {
  reconnectCount = attemptNumber;
  updateConnectionStatus('reconnecting', `Đang kết nối lại... (lần ${attemptNumber})`);
});

socket.on('reconnect', (attemptNumber) => {
  updateConnectionStatus('connected');
  addLog('success', `Đã kết nối lại thành công! (sau ${attemptNumber} lần thử)`);
});

socket.on('reconnect_error', (error) => {
  updateConnectionStatus('disconnected', `Lỗi kết nối — thử lại...`);
});

socket.on('reconnect_failed', () => {
  updateConnectionStatus('disconnected', 'Không thể kết nối lại');
  addLog('error', 'Không thể kết nối lại server. Vui lòng tải lại trang.');
});

// ═══ Session events ═══
socket.on('session-restored', (data) => {
  addLog('success', `✓ Đã khôi phục session (${data.results.length} kết quả)`);
  
  // Restore results
  results = data.results || [];
  updateResults();
  
  // Restore progress
  if (data.progress) {
    updateProgress(data.progress.checked, data.progress.total);
    updateStats(data.progress.checked, data.progress.live, data.progress.dead, data.progress.error);
    progressSection.style.display = 'block';
  }
  
  // Restore running state
  if (data.status === 'running') {
    setRunning(true);
    addLog('info', 'Checker vẫn đang chạy trên server. Tiếp tục nhận kết quả...');
  } else if (data.status === 'completed') {
    setRunning(false);
    addLog('success', 'Session đã hoàn thành trước đó.');
    if (results.length > 0) {
      exportSection.style.display = 'flex';
    }
  }
  
  // Replay recent logs
  if (data.recentLogs && data.recentLogs.length > 0) {
    addLog('info', `--- Replay ${data.recentLogs.length} log gần nhất ---`);
    // Only replay last 20 logs to not overwhelm UI
    const logsToReplay = data.recentLogs.slice(-20);
    logsToReplay.forEach(log => addLog(log.type, log.message));
  }
});

socket.on('session-new', (data) => {
  // New session, nothing to restore
});

socket.on('heartbeat-ack', (data) => {
  // Heartbeat acknowledged — connection is alive
});

// ═══ Data events ═══
socket.on('result', (data) => {
  results.push(data);
  updateResults();
});

socket.on('progress', (data) => {
  updateProgress(data.checked, data.total);
  updateStats(data.checked, data.live, data.dead, data.error);
});

socket.on('log', (data) => {
  addLog(data.type, data.message);
});

socket.on('error', (data) => {
  addLog('error', data.message);
  setRunning(false);
});

socket.on('complete', (data) => {
  setRunning(false);
  updateProgress(data.checked, data.total);
  updateStats(data.checked, data.live, data.dead, data.error);
  addLog('success', `═══ HOÀN THÀNH ═══ Live: ${data.live} | Dead: ${data.dead} | Error: ${data.error}`);
  
  // Show export buttons
  if (results.length > 0) {
    exportSection.style.display = 'flex';
  }
});

// ═══ UI Update functions ═══
function setRunning(running) {
  isRunning = running;
  btnStart.disabled = running;
  btnStop.disabled = !running;
  emailInput.disabled = running;
  proxyInput.disabled = running;
  captchaKey.disabled = running;
  threadsInput.disabled = running;
  delayInput.disabled = running;
  proxyRotateInput.disabled = running;
  document.getElementById('tmproxy-keys').disabled = running;
  document.getElementById('tmproxy-location').disabled = running;
  document.getElementById('tmproxy-isp').disabled = running;
  
  if (running) {
    btnStart.innerHTML = `<span class="running-indicator"></span> Đang chạy...`;
  } else {
    btnStart.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Bắt đầu kiểm tra`;
  }
}

function updateProgress(checked, total) {
  const percent = total > 0 ? Math.round((checked / total) * 100) : 0;
  progressText.textContent = `${checked} / ${total}`;
  progressPercent.textContent = `${percent}%`;
  progressFill.style.width = `${percent}%`;
}

function updateStats(total, live, dead, error) {
  // Header stats
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-live').textContent = live;
  document.getElementById('stat-dead').textContent = dead;
  
  // Card stats
  document.getElementById('card-total').textContent = total;
  document.getElementById('card-live').textContent = live;
  document.getElementById('card-dead').textContent = dead;
  document.getElementById('card-error').textContent = error;
}

function updateResults() {
  const filtered = currentFilter === 'all' 
    ? results 
    : results.filter(r => r.status === currentFilter);
  
  if (filtered.length === 0) {
    resultsEmpty.style.display = 'flex';
    const items = resultsList.querySelectorAll('.result-item');
    items.forEach(item => item.remove());
    return;
  }
  
  resultsEmpty.style.display = 'none';
  
  // Clear existing results
  const items = resultsList.querySelectorAll('.result-item');
  items.forEach(item => item.remove());
  
  // Add filtered results
  filtered.forEach((result, index) => {
    const item = document.createElement('div');
    item.className = `result-item ${result.status}`;
    
    const statusLabel = result.status === 'live' ? 'LIVE' : 
                        result.status === 'dead' ? 'DEAD' : 'ERROR';
    
    item.innerHTML = `
      <div class="result-status"></div>
      <span class="result-email">${escapeHtml(result.email)}</span>
      <span class="result-badge">${statusLabel}</span>
    `;
    
    item.style.animationDelay = `${index * 0.03}s`;
    resultsList.appendChild(item);
  });
}

function addLog(type, message) {
  const time = new Date().toLocaleTimeString('vi-VN');
  const badgeClass = `log-badge-${type}`;
  const badgeText = type.toUpperCase();
  
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-badge ${badgeClass}">${badgeText}</span>
    <span class="log-msg">${escapeHtml(message)}</span>
  `;
  
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
  
  // Limit log entries to prevent memory issues on long runs
  while (logContainer.children.length > 1000) {
    logContainer.removeChild(logContainer.firstChild);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ═══ Tabs ═══
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentFilter = tab.dataset.tab;
    updateResults();
  });
});

// ═══ Export functions ═══
document.getElementById('btn-export-all')?.addEventListener('click', () => exportResults('all'));
document.getElementById('btn-export-live')?.addEventListener('click', () => exportResults('live'));
document.getElementById('btn-export-dead')?.addEventListener('click', () => exportResults('dead'));

function exportResults(filter) {
  const data = filter === 'all' 
    ? results 
    : results.filter(r => r.status === filter);
  
  if (data.length === 0) {
    addLog('warn', `Không có kết quả ${filter} để export`);
    return;
  }
  
  const content = data.map(r => r.email).join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `aws_${filter}_${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  
  addLog('success', `Đã export ${data.length} kết quả ${filter}`);
}

// ═══ Load saved settings from localStorage ═══
function loadSettings() {
  try {
    const saved = localStorage.getItem('aws-checker-settings');
    if (saved) {
      const settings = JSON.parse(saved);
      if (settings.captchaKey) captchaKey.value = settings.captchaKey;
      if (settings.threads) threadsInput.value = settings.threads;
      if (settings.delay) delayInput.value = settings.delay;
      if (settings.proxies) proxyInput.value = settings.proxies;
      if (settings.proxyRotate) proxyRotateInput.value = settings.proxyRotate;
      if (settings.tmproxyKeys) document.getElementById('tmproxy-keys').value = settings.tmproxyKeys;
      if (settings.tmproxyLocation) document.getElementById('tmproxy-location').value = settings.tmproxyLocation;
      if (settings.tmproxyIsp) document.getElementById('tmproxy-isp').value = settings.tmproxyIsp;
    }
  } catch (e) {}
  updateTMProxyKeyCount();
}

function saveSettings() {
  try {
    const settings = {
      captchaKey: captchaKey.value,
      threads: threadsInput.value,
      delay: delayInput.value,
      proxies: proxyInput.value,
      proxyRotate: proxyRotateInput.value,
      tmproxyKeys: document.getElementById('tmproxy-keys').value,
      tmproxyLocation: document.getElementById('tmproxy-location').value,
      tmproxyIsp: document.getElementById('tmproxy-isp').value
    };
    localStorage.setItem('aws-checker-settings', JSON.stringify(settings));
  } catch (e) {}
}

// TMProxy key count updater + auto-thread logic
function updateTMProxyKeyCount() {
  const keys = document.getElementById('tmproxy-keys').value
    .split('\n').map(k => k.trim()).filter(k => k);
  const countEl = document.getElementById('tmproxy-key-count');
  if (countEl) countEl.textContent = keys.length;
  
  // Auto-set threads = number of API keys
  const autoBadge = document.getElementById('threads-auto-badge');
  if (keys.length > 0) {
    threadsInput.value = keys.length;
    threadsInput.disabled = true;
    if (autoBadge) autoBadge.style.display = 'inline-flex';
  } else {
    threadsInput.disabled = false;
    if (autoBadge) autoBadge.style.display = 'none';
  }
}

// Auto-save settings on change
const savableElements = [captchaKey, threadsInput, delayInput, proxyInput, proxyRotateInput];
const tmproxyElements = ['tmproxy-keys', 'tmproxy-location', 'tmproxy-isp'].map(id => document.getElementById(id));
[...savableElements, ...tmproxyElements].forEach(el => {
  if (el) {
    el.addEventListener('change', () => { saveSettings(); updateTMProxyKeyCount(); });
    el.addEventListener('input', () => { saveSettings(); updateTMProxyKeyCount(); });
  }
});

// ═══ Prevent accidental page close while running ═══
window.addEventListener('beforeunload', (e) => {
  if (isRunning) {
    e.preventDefault();
    e.returnValue = 'Checker đang chạy! Bạn có chắc muốn rời trang? (Checker sẽ tiếp tục chạy trên server trong 5 phút)';
    return e.returnValue;
  }
});

// ═══ Visibility change — reconnect when tab becomes visible ═══
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket.connected) {
    addLog('info', 'Tab đang hoạt động lại — kết nối lại...');
    socket.connect();
  }
});

// Load on start
loadSettings();
createConnectionStatus();
