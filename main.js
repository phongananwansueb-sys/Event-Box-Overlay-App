const { app, BrowserWindow, screen, session, ipcMain } = require('electron');
const http = require('http');
const path = require('path');
const fs   = require('fs');

let overlayWin = null;
let currentDisplayIndex = 0;
let _activeTenant = 'default';
let _activeEvent  = 'default';

// ── [เพิ่มใหม่] SERVER URL ──
// - npm start (dev)  → localhost:5000
// - .exe (cloud)     → Render URL
const SERVER = process.env.SERVER_URL || 'https://event-boxsx-se.onrender.com';

// ══════════════════════════════════════════════════════════
// ── CONFIG STORE — เก็บ URL ที่ลูกค้าวางไว้ ──
// บันทึกในไฟล์ config.json ข้างๆ .exe
// ══════════════════════════════════════════════════════════
function getConfigPath() {
  return path.join(app.getPath('userData'), 'overlay-config.json');
}
function loadConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8');
    return JSON.parse(raw);
  } catch(e) { return {}; }
}
function saveConfig(data) {
  try { fs.writeFileSync(getConfigPath(), JSON.stringify(data, null, 2), 'utf-8'); } catch(e) {}
}

// ── แยก tenant + event จาก URL ที่ลูกค้าวาง ──
function parseTenantEvent(urlStr) {
  try {
    const u = new URL(urlStr.trim());
    const tenant = u.searchParams.get('tenant') || 'default';
    const event  = u.searchParams.get('event')  || 'default';
    return { tenant, event, valid: true };
  } catch(e) { return { tenant: 'default', event: 'default', valid: false }; }
}

// ── สร้าง query string จาก tenant/event ──
function tenantParams(tenant, event) {
  const p = [];
  if (tenant !== 'default') p.push('tenant=' + tenant);
  if (event  !== 'default') p.push('event='  + event);
  return p.length ? ('&' + p.join('&')) : '';
}

// ══════════════════════════════════════════════════════════
// ── SETUP WINDOW — popup ถาม URL ลูกค้าครั้งแรก ──
// ══════════════════════════════════════════════════════════
function showSetupWindow(onDone) {
  const win = new BrowserWindow({
    width: 480, height: 320,
    resizable: false, alwaysOnTop: true,
    frame: true, title: 'RealtimeCaption Overlay — ตั้งค่า',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  const cfg = loadConfig();
  const savedUrl = cfg.eventUrl || '';

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', sans-serif; }
  body { background: #0d0d0d; color: #efefef; padding: 28px 24px; }
  h2 { font-size: 1rem; font-weight: 700; margin-bottom: 6px; color: #fff; }
  .sub { font-size: .75rem; color: rgba(255,255,255,.45); margin-bottom: 20px; line-height: 1.5; }
  label { font-size: .72rem; color: rgba(255,255,255,.5); display: block; margin-bottom: 6px; }
  input { width: 100%; padding: 9px 12px; background: #1a1a1a; border: 1px solid rgba(255,255,255,.12);
    border-radius: 8px; color: #efefef; font-size: .85rem; outline: none; }
  input:focus { border-color: rgba(99,179,237,.6); }
  .err { color: #f87171; font-size: .72rem; margin-top: 6px; min-height: 1rem; }
  .row { display: flex; gap: 8px; margin-top: 20px; }
  button { flex: 1; padding: 9px; border-radius: 8px; border: none; font-size: .85rem;
    font-weight: 600; cursor: pointer; }
  .btn-ok  { background: #22c55e; color: #000; }
  .btn-ok:hover { background: #16a34a; }
  .btn-skip { background: #1a1a1a; color: rgba(255,255,255,.5); border: 1px solid rgba(255,255,255,.1); }
  .btn-skip:hover { background: #222; }
</style></head>
<body>
  <h2>วาง URL งานของคุณที่นี่</h2>
  <p class="sub">คัดลอก URL จากหน้าควบคุมงานของคุณแล้ววางลงด้านล่างครับ<br>
  ตัวอย่าง: https://event-boxsx-se.onrender.com/?tenant=TCEB&amp;event=MICE2026</p>
  <label>URL งานของคุณ</label>
  <input id="urlInput" type="text" placeholder="https://..." value="${savedUrl.replace(/"/g, '&quot;')}">
  <div class="err" id="err"></div>
  <div class="row">
    <button class="btn-ok" onclick="submit()">บันทึกและเปิด Overlay</button>
    <button class="btn-skip" onclick="skip()">ข้าม (ใช้ default)</button>
  </div>
<script>
  const { ipcRenderer } = require('electron');
  function submit() {
    const val = document.getElementById('urlInput').value.trim();
    if (!val) { document.getElementById('err').textContent = 'กรุณากรอก URL ครับ'; return; }
    try { new URL(val); } catch(e) {
      document.getElementById('err').textContent = 'URL ไม่ถูกต้อง กรุณาตรวจสอบอีกครั้งครับ'; return;
    }
    ipcRenderer.send('setup-done', { url: val });
  }
  function skip() { ipcRenderer.send('setup-done', { url: '' }); }
  document.getElementById('urlInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') submit();
  });
</script>
</body></html>`;

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.setMenuBarVisibility(false);

  ipcMain.once('setup-done', (event, { url }) => {
    const cfg = loadConfig();
    cfg.eventUrl = url;
    saveConfig(cfg);
    win.close();
    onDone(url);
  });

  win.on('closed', () => {
    // ถ้าปิด window โดยไม่กด button → ใช้ค่าเดิม
    ipcMain.removeAllListeners('setup-done');
    onDone(cfg.eventUrl || '');
  });
}

// ── ดึงรายการจอทั้งหมด ── (เหมือนเดิม 100%)
function getDisplays() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => {
    const scale = d.scaleFactor || 1;
    const physW = Math.round(d.size.width  * scale);
    const physH = Math.round(d.size.height * scale);
    return {
      index:     i,
      id:        d.id,
      label:     `จอที่ ${i + 1}  (${physW}×${physH})${d.id === primary.id ? '  ★ Primary' : ''}`,
      x:         d.bounds.x,
      y:         d.bounds.y,
      width:     d.size.width,
      height:    d.size.height,
      isPrimary: d.id === primary.id,
      scaleFactor: scale,
    };
  });
}

// ── [เพิ่มใหม่] ส่งข้อมูลไปบอก Flask ──
function notifyFlask(path, data) {
  try {
    const url = new URL(SERVER);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? require('https') : require('http');
    const body = JSON.stringify(data);
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = mod.request(options);
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch(e) {}
}

// ── [เพิ่มใหม่] ส่งข้อมูลจอทั้งหมดไปให้ Flask ──
function registerToFlask() {
  const displays = getDisplays();
  const pos = getOverlayPosition();
  notifyFlask('/electron-register', {
    displays,
    currentDisplayIndex,
    position: pos,
  });
}

// ── สร้าง overlay window (โครงเดิม 100%) ──
function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  overlayWin = new BrowserWindow({
    width, height, x: 0, y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'overlay-preload.js'),
    },
  });

  // ✅ ล้าง cache ทุกครั้งก่อนโหลด
  session.defaultSession.clearCache().then(() => {
    const _tp = tenantParams(_activeTenant, _activeEvent);
    overlayWin.loadURL(`${SERVER}/overlay?lang=both${_tp}`, {
      extraHeaders: 'Cache-Control: no-cache, no-store\nPragma: no-cache'
    });
  });

  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.on('closed', () => { overlayWin = null; stopMouseTracking(); });

  // ── แจ้ง Flask ว่า Electron พร้อมแล้ว + keepalive ทุก 30s ──
  setTimeout(() => {
    registerToFlask();
    setInterval(() => registerToFlask(), 30000);
  }, 2000);

  // ── รับ SSE จาก Flask เพื่อย้ายตำแหน่ง ──
  const { net } = require('electron');
  function listenSSE() {
    try {
      const _sp = tenantParams(_activeTenant, _activeEvent);
      const request = net.request(`${SERVER}/stream${_sp ? ('?' + _sp.slice(1)) : ''}`);
      request.on('response', (response) => {
        response.on('data', (chunk) => {
          const lines = chunk.toString().split('\n');
          lines.forEach(line => {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'set-position') {
                  setOverlayPosition(data.x, data.y);
                }
                if (data.type === 'set-display') {
                  moveOverlayToDisplay(parseInt(data.index));
                }
              } catch(e) {}
            }
          });
        });
        response.on('error', () => setTimeout(listenSSE, 3000));
      });
      request.on('error', () => setTimeout(listenSSE, 3000));
      request.end();
    } catch(e) { setTimeout(listenSSE, 3000); }
  }
  listenSSE();
  // ── เริ่ม track เมาส์สำหรับ hover zone ──
  startMouseTracking();
}

// ══════════════════════════════════════════════════════════
// ── HOVER ZONE — มุมขวาบน แสดงปุ่ม "เปลี่ยน URL" ──
// ไม่แตะ logic เดิมใดๆ — เพิ่มเข้ามาใหม่ทั้งหมด
// ══════════════════════════════════════════════════════════
const HOVER_SIZE   = 80;   // px — ขนาด zone มุมซ้ายบน
const POLL_MS      = 100;  // ms — ความถี่ check เมาส์
let   _hoverActive = false;
let   _mouseTimer  = null;

function startMouseTracking() {
  if (_mouseTimer) return;
  _mouseTimer = setInterval(() => {
    if (!overlayWin) return;
    const pt       = screen.getCursorScreenPoint();
    const displays = screen.getAllDisplays();
    const display  = displays[currentDisplayIndex] || displays[0];
    const bounds   = display.bounds;
    // คำนวณตำแหน่งเมาส์บนจอนั้น
    const relX = pt.x - bounds.x;
    const relY = pt.y - bounds.y;
    const inZone = relX <= HOVER_SIZE && relY <= HOVER_SIZE;
    if (inZone && !_hoverActive) {
      _hoverActive = true;
      // เปิดรับ mouse events เฉพาะตอนอยู่ใน zone
      overlayWin.setIgnoreMouseEvents(false);
      overlayWin.webContents.send('hover-zone', true);
    } else if (!inZone && _hoverActive) {
      _hoverActive = false;
      overlayWin.setIgnoreMouseEvents(true, { forward: true });
      overlayWin.webContents.send('hover-zone', false);
    }
  }, POLL_MS);
}

function stopMouseTracking() {
  if (_mouseTimer) { clearInterval(_mouseTimer); _mouseTimer = null; }
}

// ── เปลี่ยน URL จาก hover button ──
function changeUrl() {
  showSetupWindow((url) => {
    if (!url) return;  // กด ข้าม → ไม่ทำอะไร
    const { tenant, event } = parseTenantEvent(url);
    _activeTenant = tenant;
    _activeEvent  = event;
    // reload overlay ด้วย URL ใหม่
    if (overlayWin) {
      session.defaultSession.clearCache().then(() => {
        const _tp = tenantParams(_activeTenant, _activeEvent);
        overlayWin.loadURL(`${SERVER}/overlay?lang=both${_tp}`, {
          extraHeaders: 'Cache-Control: no-cache, no-store\nPragma: no-cache'
        });
      });
    }
  });
}

// expose changeUrl ให้ ipcMain รับได้
ipcMain.on('change-url', () => changeUrl());

// ── ย้าย overlay ไปจอที่ index ── (เหมือนเดิม 100%)
function moveOverlayToDisplay(index) {
  const displays = screen.getAllDisplays();
  if (index < 0 || index >= displays.length) return false;
  const { x, y, width, height } = displays[index].bounds;
  if (overlayWin) {
    overlayWin.setBounds({ x, y, width, height });
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
  }
  currentDisplayIndex = index;
  // ── [เพิ่มใหม่] อัปเดต Flask ──
  registerToFlask();
  return true;
}

// ── ย้าย overlay ไปตำแหน่ง x, y ── (เหมือนเดิม 100%)
function setOverlayPosition(x, y) {
  if (!overlayWin) return false;
  const displays = screen.getAllDisplays();
  const display  = displays[currentDisplayIndex] || displays[0];
  const absX = Math.round(display.bounds.x + x);
  const absY = Math.round(display.bounds.y + y);
  overlayWin.setPosition(absX, absY);
  // ── [เพิ่มใหม่] อัปเดต Flask ──
  registerToFlask();
  return true;
}

// ── ดึงตำแหน่งปัจจุบัน ── (เหมือนเดิม 100%)
function getOverlayPosition() {
  if (!overlayWin) return { x: 0, y: 0, width: 1920, height: 1080 };
  const [absX, absY] = overlayWin.getPosition();
  const [w, h]       = overlayWin.getSize();
  const displays     = screen.getAllDisplays();
  const display      = displays[currentDisplayIndex] || displays[0];
  return {
    x:      absX - display.bounds.x,
    y:      absY - display.bounds.y,
    width:  w,
    height: h,
  };
}

// ══════════════════════════════════════════════════════════
// Internal HTTP server (port 5001) — สำหรับ Flask เรียกกลับ
// (เหมือนเดิม 100%)
// ══════════════════════════════════════════════════════════
const INTERNAL_PORT = 5001;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/displays') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getDisplays()));
    return;
  }

  if (req.method === 'GET' && req.url === '/position') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getOverlayPosition()));
    return;
  }

  const readBody = (cb) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { cb(JSON.parse(body)); }
      catch(e) { res.writeHead(400); res.end(JSON.stringify({ status: 'error' })); }
    });
  };

  if (req.method === 'POST' && req.url === '/set-display') {
    readBody(({ index }) => {
      const ok = moveOverlayToDisplay(parseInt(index));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ok ? 'ok' : 'error', index }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/set-position') {
    readBody(({ x, y }) => {
      const ok = setOverlayPosition(Number(x), Number(y));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ok ? 'ok' : 'error', ...getOverlayPosition() }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/set-draggable') {
    readBody(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    return;
  }

  res.writeHead(404); res.end('Not found');

}).listen(INTERNAL_PORT, '127.0.0.1', () => {
  console.log(`✅ Electron internal server: http://127.0.0.1:${INTERNAL_PORT}`);
});

// ── App lifecycle ──
// เพิ่ม: เช็ค config URL ก่อน ถ้ายังไม่มี → แสดง setup window
// ถ้ามีแล้ว → createOverlay ทันที (เหมือนเดิม)
app.whenReady().then(() => {
  const cfg     = loadConfig();
  const savedUrl = cfg.eventUrl || '';

  function startWithUrl(eventUrl) {
    const { tenant, event } = parseTenantEvent(eventUrl);
    // inject tenant/event เข้า createOverlay ผ่าน closure
    _activeTenant = tenant;
    _activeEvent  = event;
    createOverlay();
  }

  if (!savedUrl) {
    // ครั้งแรก → แสดง setup window
    showSetupWindow((url) => startWithUrl(url));
  } else {
    // มี config แล้ว → เปิด overlay ทันที
    startWithUrl(savedUrl);
  }

  app.on('activate', () => { if (!overlayWin) createOverlay(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
