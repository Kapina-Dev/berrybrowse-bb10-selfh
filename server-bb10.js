'use strict';

/**
 * BerryBrowse BB10 — Self-hosted server
 *
 * Stripped from production v0.6.5:
 * + No database, accounts, Stripe, email, tiers, slots, queue
 * + No profile encryption, rate limiting, admin, Telegram
 * + Single persistent profile, single session, optional password
 *
 * Install: npm install
 * Run:     npm start
 */

require('dotenv').config();

var express   = require('express');
var http      = require('http');
var WebSocket = require('ws');
var puppeteer = require('puppeteer-core');
var path      = require('path');
var fs        = require('fs');
var crypto    = require('crypto');
var spawn     = require('child_process').spawn;

// ── Config ─────────────────────────────────────────────────────────────────────

var PASSWORD      = process.env.PASSWORD      || '';
var PORT          = parseInt(process.env.PORT  || '3000', 10);
var CHROMIUM_PATH = process.env.CHROMIUM_PATH  || '/usr/bin/chromium-browser';
var START_URL     = process.env.START_URL       || 'https://duckduckgo.com';
var IDLE_TIMEOUT  = parseInt(process.env.IDLE_TIMEOUT || '300', 10) * 1000; // seconds → ms, 0 = disabled
var UPLOAD_LIMIT  = parseInt(process.env.UPLOAD_LIMIT || String(500 * 1024 * 1024), 10);

var VIEWPORT = { width: 800, height: 720 };

var PRESETS = {
  low:    { quality: 65, interval: 200 },
  medium: { quality: 80, interval: 150 },
  high:   { quality: 92, interval: 100 },
  max:    { quality: 95, interval:  50 },
};

var UA_MOBILE  = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.75 Mobile Safari/537.36';
var UA_DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.75 Safari/537.36';

var AUDIO_ENABLED     = (process.env.AUDIO || 'true').toLowerCase() !== 'false';
var AUDIO_BITRATE     = process.env.AUDIO_BITRATE || '128k';
var AUDIO_SAMPLE_RATE = parseInt(process.env.AUDIO_SAMPLE_RATE || '44100', 10);
var PULSE_SERVER      = process.env.PULSE_SERVER || 'unix:/var/run/pulse/native';
var AUDIO_SINK_NAME   = 'bb_sink';

var ZOOM_MIN  = 25;
var ZOOM_MAX  = 200;
var ZOOM_STEP = 25;
var MAX_HISTORY = 20;

var PROFILE_DIR   = path.join(__dirname, 'profile-bb10');
var DOWNLOADS_DIR = path.join(__dirname, 'downloads-bb10');
var UPLOADS_DIR   = path.join(__dirname, 'uploads-bb10');
var LOCK_FILE     = path.join(__dirname, '.bb10.lock');

// ── Directories ────────────────────────────────────────────────────────────────

[PROFILE_DIR, DOWNLOADS_DIR, UPLOADS_DIR].forEach(function(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Singleton lock ─────────────────────────────────────────────────────────────

if (fs.existsSync(LOCK_FILE)) {
  console.log('[lock] Stale lock found — clearing');
  try { fs.unlinkSync(LOCK_FILE); } catch(e) {}
}
fs.writeFileSync(LOCK_FILE, String(process.pid));

// ── Auth ───────────────────────────────────────────────────────────────────────

var sessions = new Set();

function parseCookies(header) {
  var out = {};
  (header || '').split(';').forEach(function(pair) {
    var i = pair.indexOf('=');
    if (i < 0) return;
    out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  return out;
}

function requireAuth(req, res, next) {
  if (!PASSWORD) return next();
  var token = parseCookies(req.headers.cookie).session;
  if (token && sessions.has(token)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

// ── State ──────────────────────────────────────────────────────────────────────

var activeSession    = null;
var pendingDownloads = {};

setInterval(function() {
  var now = Date.now();
  for (var token in pendingDownloads) {
    if (pendingDownloads[token].expires < now) {
      try { fs.unlinkSync(pendingDownloads[token].filePath); } catch(e) {}
      delete pendingDownloads[token];
    }
  }
}, 60000);

// ── Input Queue ────────────────────────────────────────────────────────────────

function InputQueue() { this._q = []; this._running = false; }

InputQueue.prototype.push = function(fn) {
  this._q.push(fn);
  if (!this._running) this._flush();
};

InputQueue.prototype.clear = function() { this._q = []; };

InputQueue.prototype._flush = async function() {
  this._running = true;
  while (this._q.length > 0) {
    try { await this._q.shift()(); }
    catch(e) { console.error('[queue]', e.message); }
  }
  this._running = false;
};

// ── BrowserSession ─────────────────────────────────────────────────────────────

function BrowserSession(ws) {
  this.ws             = ws;
  this.browser        = null;
  this.page           = null;
  this.closed         = false;
  this.navigating     = false;
  this.navDeadline    = 0;
  this.loopTimer      = null;
  this.idleTimer      = null;
  this.loadingTimer   = null;
  this.queue          = new InputQueue();
  this.history        = [];
  this.preset         = PRESETS.max;
  this.currentPreset  = 'max';
  this.desktopMode    = false;
  this.zoomLevel      = 100;
  this.chooserPendingPage = null;
  this.chooserTimeout = null;
  this.cdpSession     = null;
  this.pendingDlNames = {};
  this.disconnected   = false;
  this.graceTimer     = null;
  this.audioProcess   = null;
  this.audioClients   = [];
  this.audioSinkMod   = null;
  this.audioSinkInterval = null;
  // Multi-tab
  this.pages           = [];
  this.activePageIdx   = 0;
  this.page2Cdp        = null;
  this._pendingScroll  = null;
  this.forceScreenshot = false;
}

BrowserSession.prototype._sendJSON = function(obj) {
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
  try { this.ws.send(JSON.stringify(obj)); } catch(e) {}
};

BrowserSession.prototype._resetIdle = function() {
  var self = this;
  if (this.idleTimer) clearTimeout(this.idleTimer);
  if (IDLE_TIMEOUT <= 0) return;
  this.idleTimer = setTimeout(function() {
    console.log('[session] Idle timeout');
    self._sendJSON({ type: 'toast', message: 'Session ended due to inactivity.' });
    self.close();
  }, IDLE_TIMEOUT);
};

BrowserSession.prototype._setLoading = function(active) {
  var self = this;
  if (this.loadingTimer) { clearTimeout(this.loadingTimer); this.loadingTimer = null; }
  this._sendJSON({ type: 'status', loading: active });
  if (active) {
    this.loadingTimer = setTimeout(function() {
      self.loadingTimer = null;
      self._sendJSON({ type: 'status', loading: false });
    }, 8000);
  }
};

BrowserSession.prototype._setupPage = async function() {
  await this.page.setViewport({ width: VIEWPORT.width, height: VIEWPORT.height, hasTouch: true, isMobile: true });
  await this.page.setUserAgent(this.desktopMode ? UA_DESKTOP : UA_MOBILE);
  await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  var self = this;
  this.page.on('request', function(req) {
    if (self.closed) return;
    try {
      if (req.isNavigationRequest() && req.frame() === self.page.mainFrame()) {
        self.navigating = true;
        self.navDeadline = Date.now() + 8000;
      }
    } catch(e) {}
  });
  this.page.on('framenavigated', function(frame) {
    if (self.closed) return;
    try {
      if (frame === self.page.mainFrame()) {
        self._sendJSON({ type: 'nav', url: self.page.url() });
        self._setLoading(true);
      }
    } catch(e) {}
  });
  this.page.on('load', function() {
    self.navigating = false;
    self._setLoading(false);
    self._sendNavWithTitle();
  });
  this.page.on('domcontentloaded', function() {
    self.navigating = false;
    self._setLoading(false);
    self._sendNavWithTitle();
  });
  var bbFiScript = 'if(!window.__bbFI){window.__bbFI=true;' +
    'var _oc=HTMLInputElement.prototype.click;' +
    'HTMLInputElement.prototype.click=function(){' +
    'if(this.type==="file"){window.__bb_fi=this;' +
    'if(typeof window.__bbFileChooser==="function")window.__bbFileChooser();}' +
    'else{_oc.call(this);}' +
    '};}';
  try {
    await this.page.exposeFunction('__bbFileChooser', function() {
      if (self.closed) return;
      if (self.chooserTimeout) { clearTimeout(self.chooserTimeout); self.chooserTimeout = null; }
      self.chooserPendingPage = self.pages[0];
      self.chooserTimeout = setTimeout(function() { self.chooserPendingPage = null; }, 30000);
      self._sendJSON({ type: 'fileChooser' });
    });
  } catch(e) {}
  await this.page.evaluateOnNewDocument(bbFiScript);
  try { await this.page.evaluate(bbFiScript); } catch(e) {}
};

BrowserSession.prototype._sendNavWithTitle = async function() {
  try {
    var ap = this.pages[this.activePageIdx];
    var url = ap.url();
    var title = await ap.title();
    title = title || url;
    this._sendJSON({ type: 'nav', url: url, title: title });
    var last = this.history.length > 0 ? this.history[this.history.length - 1] : null;
    if (!last || last.url !== url) {
      this.history.push({ url: url, title: title, timestamp: Date.now() });
      if (this.history.length > MAX_HISTORY) this.history.shift();
    } else if (last && last.url === url && title !== url) {
      last.title = title;
    }
  } catch(e) {}
};

BrowserSession.prototype._startXvfb = function() {
  var self = this;
  return new Promise(function(resolve) {
    // Find a free display number
    var display = 99;
    var proc = spawn('Xvfb', [':' + display, '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], {
      detached: false,
      stdio: 'ignore',
    });
    proc.on('error', function(e) { console.error('[xvfb] Failed to start:', e.message); resolve(null); });
    self.xvfbProc = proc;
    self.xvfbDisplay = ':' + display;
    // Give Xvfb ~300ms to initialize before Chromium connects
    setTimeout(function() { resolve(':' + display); }, 300);
  });
};

BrowserSession.prototype.init = async function() {
  console.log('[session] Starting...');

  // Start virtual display so headless:false Chromium has a display for audio without showing a window
  var display = await this._startXvfb();
  console.log('[session] Xvfb display:', display || '(failed, using $DISPLAY)');

  // Create PulseAudio null sink BEFORE launching Chromium so PULSE_SINK=bb_sink is valid at connect time
  if (AUDIO_ENABLED) await this._createSink();

  // Clean up Chromium singleton locks from a previous crash
  ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach(function(f) {
    var p = path.join(PROFILE_DIR, f);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch(e) {} }
  });

  this.browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    userDataDir:    PROFILE_DIR,
    headless:       false,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-extensions', '--no-first-run',
      '--disable-background-networking', '--disable-default-apps', '--disable-sync',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--disable-software-rasterizer',
      '--enable-features=AudioServiceOutOfProcess',
    ],
    env: Object.assign({}, process.env, {
      DISPLAY:      display || process.env.DISPLAY || ':0',
      PULSE_SERVER: PULSE_SERVER,
      PULSE_SINK:   AUDIO_SINK_NAME,
    }),
  });

  var pages = await this.browser.pages();
  this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();
  this.pages = [this.page];
  await this._setupPage();

  // CDP download events
  var self = this;
  try {
    var cdp = await this.browser.target().createCDPSession();
    this.cdpSession = cdp;
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName', downloadPath: DOWNLOADS_DIR, eventsEnabled: true,
    });
    cdp.on('Browser.downloadWillBegin', function(params) {
      if (self.closed) return;
      self.pendingDlNames[params.guid] = params.suggestedFilename || 'download';
    });
    cdp.on('Browser.downloadProgress', function(params) {
      if (self.closed) return;
      if (params.state === 'completed') {
        var filename = self.pendingDlNames[params.guid] || 'download';
        delete self.pendingDlNames[params.guid];
        self._handleDownloadComplete(params.guid, filename);
      } else if (params.state === 'canceled') {
        delete self.pendingDlNames[params.guid];
      }
    });
  } catch(e) { console.error('[session] CDP download setup:', e.message); }

  this._sendJSON({ type: 'init', desktopMode: this.desktopMode, zoomLevel: this.zoomLevel, preset: this.currentPreset, audioEnabled: AUDIO_ENABLED });
  this._startLoop();
  if (AUDIO_ENABLED) this._startAudio();
  await this.navigate(START_URL);
  this._resetIdle();
  console.log('[session] Ready');
};

BrowserSession.prototype._handleDownloadComplete = function(guid, filename) {
  var filePath = path.join(DOWNLOADS_DIR, guid);
  if (!fs.existsSync(filePath)) return;
  var stat; try { stat = fs.statSync(filePath); } catch(e) { return; }
  var token = crypto.randomBytes(16).toString('hex');
  pendingDownloads[token] = { filePath: filePath, filename: filename, expires: Date.now() + 300000 };
  this._sendJSON({ type: 'download', filename: filename, size: stat.size, token: token });
};

BrowserSession.prototype._startLoop = function() {
  var self = this;
  var consecutiveErrors   = 0;
  var consecutiveTimeouts = 0;
  var recovering          = false;
  var recoveryCount       = 0;
  var pendingScreenshot   = null;
  var pendingScreenshotIdx = -1;

  var tick = async function() {
    if (self.closed) return;
    if (self.navigating) {
      if (self.navDeadline && Date.now() > self.navDeadline) {
        console.log('[session] Navigation deadlock detected, resetting');
        self.navigating = false;
        self.navDeadline = 0;
      } else {
        pendingScreenshot = null;
        self.loopTimer = setTimeout(tick, 100);
        return;
      }
    }
    try {
      // Discard pending screenshot if active tab changed or forced refresh
      if (pendingScreenshot && (pendingScreenshotIdx !== self.activePageIdx || self.forceScreenshot)) {
        pendingScreenshot = null;
      }
      self.forceScreenshot = false;
      if (!pendingScreenshot) {
        pendingScreenshotIdx = self.activePageIdx;
        pendingScreenshot = self.pages[self.activePageIdx].screenshot({ type: 'jpeg', quality: self.preset.quality });
      }
      var buf = await Promise.race([
        pendingScreenshot,
        new Promise(function(_, reject) { setTimeout(function() { reject(new Error('screenshot timeout')); }, 5000); }),
      ]);
      pendingScreenshot = null;
      if (!self.closed && self.ws.readyState === WebSocket.OPEN) self.ws.send(buf, { binary: true });
      consecutiveErrors = 0;
      consecutiveTimeouts = 0;
      recoveryCount = 0;
    } catch(err) {
      var isTimeout  = err.message === 'screenshot timeout';
      var isDetached = err.message && (err.message.indexOf('Not attached') !== -1 || err.message.indexOf('No target with given id') !== -1);
      if (!isTimeout) {
        pendingScreenshot = null;
        consecutiveTimeouts = 0;
      } else {
        consecutiveTimeouts++;
      }
      consecutiveErrors++;
      if (!self.closed && !recovering) {
        if (isDetached && consecutiveErrors >= 3) {
          recovering = true; recoveryCount++;
          var ok = await self._recoverPage(recoveryCount > 1);
          recovering = false;
          if (ok) { consecutiveErrors = 0; consecutiveTimeouts = 0; }
          else if (consecutiveErrors >= 15) { self._sendJSON({ type: 'toast', message: 'Connection lost. Please refresh.' }); self.close(); return; }
        } else if (isTimeout && consecutiveTimeouts >= 3) {
          pendingScreenshot = null;
          console.log('[session] Screenshot stuck after 3 timeouts, recovering');
          recovering = true; recoveryCount++;
          var ok;
          if (self.activePageIdx === 1 && self.pages[1]) {
            try {
              var tab2url = self.pages[1].url();
              var recoverUrl = (recoveryCount > 1 || !tab2url || tab2url === 'about:blank') ? START_URL : tab2url;
              console.log('[session] Recovering tab 2 to', recoverUrl);
              await self.pages[1].goto(recoverUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
              ok = true;
            } catch(e) {
              console.error('[session] Tab 2 recovery failed:', e.message);
              ok = false;
            }
          } else {
            ok = await self._recoverPage(recoveryCount > 1, true);
          }
          recovering = false;
          if (ok) { consecutiveErrors = 0; consecutiveTimeouts = 0; }
          else if (consecutiveErrors >= 15) { self._sendJSON({ type: 'toast', message: 'Connection lost. Please refresh.' }); self.close(); return; }
        } else if (!isTimeout && consecutiveErrors >= 8) {
          recovering = true; recoveryCount++;
          var ok = await self._recoverPage(recoveryCount > 1);
          recovering = false;
          if (ok) { consecutiveErrors = 0; consecutiveTimeouts = 0; }
          else if (consecutiveErrors >= 15) { self._sendJSON({ type: 'toast', message: 'Connection lost. Please refresh.' }); self.close(); return; }
        } else if (consecutiveErrors <= 3) {
          console.error('[session] Screenshot:', err.message);
        }
      }
    }
    if (!self.closed) self.loopTimer = setTimeout(tick, self.preset.interval);
  };
  tick();
};

BrowserSession.prototype._recoverPage = async function(useStartUrl, alwaysNavigate) {
  console.log('[session] Recovering page' + (useStartUrl ? ' (start URL)' : alwaysNavigate ? ' (last page)' : ''));
  this.queue.clear(); // Discard stale input events — they'd re-freeze the recovered page
  try {
    var oldPage = this.page;
    var pages = await this.browser.pages();
    this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();
    this.pages[0] = this.page;
    var pageChanged = this.page !== oldPage;
    if (pageChanged) await this._setupPage();
    if (pageChanged || useStartUrl || alwaysNavigate) {
      var targetUrl = useStartUrl
        ? START_URL
        : (this.history.length > 0 ? this.history[this.history.length - 1].url : START_URL);
      await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    if (this.zoomLevel !== 100) {
      await this.page.evaluate(function(z) { document.body.style.zoom = (z / 100).toString(); }, this.zoomLevel);
    }
    this.navigating = false;
    console.log('[session] Page recovered' + (pageChanged ? ' (new page)' : ' (same page)'));
    return true;
  } catch(e) {
    console.error('[session] Recovery failed:', e.message);
    try { await this.page.goto('about:blank', { timeout: 5000 }); } catch(e2) {}
    this.navigating = false;
    return false;
  }
};

BrowserSession.prototype.navigate = async function(url) {
  if (!url || !url.trim()) return;
  url = url.trim();
  if (url.indexOf('http://') !== 0 && url.indexOf('https://') !== 0) {
    url = (url.indexOf('.') !== -1 && url.indexOf(' ') === -1)
      ? 'https://' + url
      : 'https://www.google.com/search?q=' + encodeURIComponent(url);
  }
  this.navigating = true;
  this._setLoading(true);
  try {
    await this.pages[this.activePageIdx].goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch(err) {
    console.log('[session] Navigate:', err.message);
  } finally {
    this.navigating = false;
    this._setLoading(false);
  }
  this._sendNavWithTitle();
  if (this.zoomLevel !== 100) {
    try { await this.pages[this.activePageIdx].evaluate(function(z) { document.body.style.zoom = (z / 100).toString(); }, this.zoomLevel); } catch(e) {}
  }
};

BrowserSession.prototype.queueNavigate = function(url) {
  this._resetIdle();
  var self = this;
  this.queue.push(async function() { await self.navigate(url); });
};

BrowserSession.prototype.queueClick = function(x, y) {
  this._resetIdle();
  var self = this;
  this.queue.push(async function() {
    try {
      var page = self.pages[self.activePageIdx];
      // Mobile UA pages need touch events; desktop pages need mouse events
      if (!self.desktopMode && self.activePageIdx === 0) {
        await page.touchscreen.tap(x, y);
      } else {
        await page.mouse.click(x, y, { delay: 80 });
      }
    }
    catch(e) { console.error('[session] Click:', e.message); }
  });
};

BrowserSession.prototype.queueScroll = function(x, y, dx, dy) {
  this._resetIdle();
  var self = this;
  if (self._pendingScroll) {
    self._pendingScroll.dx += dx;
    self._pendingScroll.dy += dy;
    self._pendingScroll.x = x;
    self._pendingScroll.y = y;
    return;
  }
  var acc = { x: x, y: y, dx: dx, dy: dy };
  self._pendingScroll = acc;
  this.queue.push(async function() {
    var a = self._pendingScroll;
    self._pendingScroll = null;
    try {
      await self.pages[self.activePageIdx].evaluate(function(px, py, ddx, ddy) {
        var el = document.elementFromPoint(px, py);
        while (el && el !== document.body && el !== document.documentElement) {
          var style = window.getComputedStyle(el);
          var overflowY = style.overflowY; var overflowX = style.overflowX;
          var canScrollY = (overflowY === 'scroll' || overflowY === 'auto') && el.scrollHeight > el.clientHeight;
          var canScrollX = (overflowX === 'scroll' || overflowX === 'auto') && el.scrollWidth > el.clientWidth;
          if ((ddy !== 0 && canScrollY) || (ddx !== 0 && canScrollX)) { el.scrollBy(ddx, ddy); return; }
          el = el.parentElement;
        }
        window.scrollBy(ddx, ddy);
      }, a.x, a.y, a.dx, a.dy);
    } catch(e) { console.error('[session] Scroll:', e.message); }
  });
};

BrowserSession.prototype.queueDragStart = function(x, y) {
  this._resetIdle();
  var self = this;
  this.queue.push(async function() {
    try { await self.pages[self.activePageIdx].mouse.move(x, y); await self.pages[self.activePageIdx].mouse.down(); }
    catch(e) { console.error('[session] DragStart:', e.message); }
  });
};

BrowserSession.prototype.queueDragMove = function(x, y) {
  this._resetIdle();
  var self = this;
  this.queue.push(async function() {
    try { await self.pages[self.activePageIdx].mouse.move(x, y); }
    catch(e) { console.error('[session] DragMove:', e.message); }
  });
};

BrowserSession.prototype.queueDragEnd = function(x, y) {
  this._resetIdle();
  var self = this;
  this.queue.push(async function() {
    try { await self.pages[self.activePageIdx].mouse.move(x, y); await self.pages[self.activePageIdx].mouse.up(); }
    catch(e) { console.error('[session] DragEnd:', e.message); }
  });
};

BrowserSession.prototype.queueType = function(text) {
  this._resetIdle();
  var self = this;
  this.queue.push(async function() {
    try {
      var kb = self.pages[self.activePageIdx].keyboard;
      for (var i = 0; i < text.length; i++) {
        await kb.sendCharacter(text[i]);
        if (i < text.length - 1) await new Promise(function(r) { setTimeout(r, 15); });
      }
    } catch(e) { console.error('[session] Type:', e.message); }
  });
};

BrowserSession.prototype.queueKey = function(key, modifiers) {
  this._resetIdle();
  var self = this;
  this.queue.push(async function() {
    try {
      var kb = self.pages[self.activePageIdx].keyboard;
      var mods = modifiers || [];
      for (var i = 0; i < mods.length; i++) await kb.down(mods[i] === 'ctrl' ? 'Control' : mods[i]);
      await kb.press(key);
      for (var i = 0; i < mods.length; i++) await kb.up(mods[i] === 'ctrl' ? 'Control' : mods[i]);
    } catch(e) { console.error('[session] Key:', e.message); }
  });
};

BrowserSession.prototype.queueBack = function() {
  this._resetIdle();
  var self = this;
  this.queue.push(async function() {
    var ap = self.pages[self.activePageIdx];
    self.navigating = true;
    self._setLoading(true);
    try {
      await ap.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch(err) {
      if (err.message && (err.message.indexOf('Not attached') !== -1 || err.message.indexOf('No target with given id') !== -1)) {
        console.log('[session] Back detach — recovering to start URL');
        try {
          if (self.activePageIdx === 0) {
            var bpages = await self.browser.pages();
            self.page = bpages.length > 0 ? bpages[0] : await self.browser.newPage();
            self.pages[0] = self.page;
            await self._setupPage();
            await self.page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
          } else {
            await self.pages[1].goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
          }
        } catch(e2) { console.error('[session] Back recovery failed:', e2.message); }
      } else if (err.message && err.message.indexOf('timeout') !== -1) {
        console.log('[session] Back timeout — continuing');
      } else {
        console.log('[session] Back:', err.message);
      }
    } finally {
      self.navigating = false;
      self._setLoading(false);
      try {
        var cur = self.pages[self.activePageIdx];
        var url = cur.url();
        var title = await cur.title();
        self._sendJSON({ type: 'nav', url: url, title: title || url });
        var last = self.history.length > 0 ? self.history[self.history.length - 1] : null;
        if (!last || last.url !== url) {
          self.history.push({ url: url, title: title || url, timestamp: Date.now() });
          if (self.history.length > MAX_HISTORY) self.history.shift();
        }
      } catch(e) {}
    }
  });
};

BrowserSession.prototype.queueForward = function() {
  this._resetIdle();
  var self = this;
  this.queue.push(async function() {
    var ap = self.pages[self.activePageIdx];
    self.navigating = true;
    self._setLoading(true);
    try {
      await ap.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch(err) {
      if (err.message && (err.message.indexOf('Not attached') !== -1 || err.message.indexOf('No target with given id') !== -1)) {
        console.log('[session] Forward detach — recovering to start URL');
        try {
          if (self.activePageIdx === 0) {
            var bpages = await self.browser.pages();
            self.page = bpages.length > 0 ? bpages[0] : await self.browser.newPage();
            self.pages[0] = self.page;
            await self._setupPage();
            await self.page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
          } else {
            await self.pages[1].goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
          }
        } catch(e2) { console.error('[session] Forward recovery failed:', e2.message); }
      } else if (err.message && err.message.indexOf('timeout') !== -1) {
        console.log('[session] Forward timeout — continuing');
      } else {
        console.log('[session] Forward:', err.message);
      }
    } finally {
      self.navigating = false;
      self._setLoading(false);
      try {
        var cur = self.pages[self.activePageIdx];
        var url = cur.url();
        var title = await cur.title();
        self._sendJSON({ type: 'nav', url: url, title: title || url });
        var last = self.history.length > 0 ? self.history[self.history.length - 1] : null;
        if (!last || last.url !== url) {
          self.history.push({ url: url, title: title || url, timestamp: Date.now() });
          if (self.history.length > MAX_HISTORY) self.history.shift();
        }
      } catch(e) {}
    }
  });
};

BrowserSession.prototype.queueRefresh = function() {
  this._resetIdle();
  var self = this;
  this.queue.push(async function() {
    self.navigating = true;
    self._setLoading(true);
    try { await self.pages[self.activePageIdx].reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch(e) { console.log('[session] Refresh:', e.message); }
    finally {
      self.navigating = false;
      self._setLoading(false);
      self._sendNavWithTitle();
    }
  });
};

BrowserSession.prototype.setPreset = function(name) {
  var p = PRESETS[name];
  if (!p) return;
  this.preset = p;
  this.currentPreset = name;
  this._sendJSON({ type: 'quality', preset: name });
};

BrowserSession.prototype.setDesktopMode = function(enabled) {
  this.desktopMode = enabled;
  var self = this;
  this.queue.push(async function() {
    var ap = self.pages[self.activePageIdx];
    self.navigating = true;
    self._setLoading(true);
    try {
      await ap.setUserAgent(enabled ? UA_DESKTOP : UA_MOBILE);
      self._sendJSON({ type: 'desktopMode', enabled: enabled });
      await ap.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch(e) { console.error('[session] setDesktopMode:', e.message); }
    finally {
      self.navigating = false;
      self._setLoading(false);
      self._sendNavWithTitle();
    }
  });
};

BrowserSession.prototype.setZoom = function(direction) {
  var nz = this.zoomLevel;
  if      (direction === 'in')    nz = Math.min(ZOOM_MAX, nz + ZOOM_STEP);
  else if (direction === 'out')   nz = Math.max(ZOOM_MIN, nz - ZOOM_STEP);
  else if (direction === 'reset') nz = 100;
  if (nz === this.zoomLevel) return;
  this.zoomLevel = nz;
  var self = this;
  this.queue.push(async function() {
    try {
      await self.pages[self.activePageIdx].evaluate(function(z) { document.body.style.zoom = (z / 100).toString(); }, self.zoomLevel);
      self._sendJSON({ type: 'zoom', level: self.zoomLevel });
    } catch(e) { console.error('[session] Zoom:', e.message); }
  });
};

BrowserSession.prototype.getHistory = function() { return this.history.slice().reverse(); };

BrowserSession.prototype.queueSwitchTab = function() {
  var self = this;
  this.queue.push(async function() {
    try {
      if (!self.pages[1]) {
        // Lazy create tab 2 on first switch
        self._sendJSON({ type: 'tabState', active: 0, count: 1, opening: true });
        var page2 = await self.browser.newPage();
        await page2.setViewport({ width: VIEWPORT.width, height: VIEWPORT.height, hasTouch: true, isMobile: true });
        await page2.setUserAgent(UA_DESKTOP); // page 2 defaults to desktop — media sites (Spotify etc.) require non-mobile UA
        await page2.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        self.pages[1] = page2;

        // Event listeners for tab 2 — only fire when tab 2 is active
        page2.on('request', function(req) {
          if (self.closed || self.activePageIdx !== 1) return;
          try {
            if (req.isNavigationRequest() && req.frame() === page2.mainFrame()) {
              self.navigating = true;
              self.navDeadline = Date.now() + 8000;
            }
          } catch(e) {}
        });
        page2.on('framenavigated', function(frame) {
          if (self.closed || self.activePageIdx !== 1) return;
          try {
            if (frame === page2.mainFrame()) {
              self._sendJSON({ type: 'nav', url: page2.url() });
              self._setLoading(true);
            }
          } catch(e) {}
        });
        page2.on('load', function() {
          if (self.activePageIdx !== 1) return;
          self.navigating = false;
          self._setLoading(false);
          try {
            var url = page2.url();
            page2.title().then(function(title) {
              if (self.activePageIdx === 1) self._sendJSON({ type: 'nav', url: url, title: title || url });
            }).catch(function() {});
          } catch(e) {}
        });
        page2.on('domcontentloaded', function() {
          if (self.activePageIdx === 1) self.navigating = false;
        });

        var bbFiScript2 = 'if(!window.__bbFI){window.__bbFI=true;' +
          'var _oc=HTMLInputElement.prototype.click;' +
          'HTMLInputElement.prototype.click=function(){' +
          'if(this.type==="file"){window.__bb_fi=this;' +
          'if(typeof window.__bbFileChooser==="function")window.__bbFileChooser();}' +
          'else{_oc.call(this);}' +
          '};}';
        try {
          await page2.exposeFunction('__bbFileChooser', function() {
            if (self.closed || self.activePageIdx !== 1) return;
            if (self.chooserTimeout) { clearTimeout(self.chooserTimeout); self.chooserTimeout = null; }
            self.chooserPendingPage = page2;
            self.chooserTimeout = setTimeout(function() { self.chooserPendingPage = null; }, 30000);
            self._sendJSON({ type: 'fileChooser' });
          });
        } catch(e) {}
        await page2.evaluateOnNewDocument(bbFiScript2);
        try { await page2.evaluate(bbFiScript2); } catch(e) {}

        await page2.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        try { self.page2Cdp = await page2.target().createCDPSession(); } catch(e) {}
        self.activePageIdx = 1;
      } else {
        self.activePageIdx = self.activePageIdx === 0 ? 1 : 0;
      }

      // Only throttle page 2 — throttling page 1 breaks screenshots
      try {
        if (!self.page2Cdp && self.pages[1]) self.page2Cdp = await self.pages[1].target().createCDPSession();
        if (self.page2Cdp) {
          var p2rate = self.activePageIdx === 1 ? 1 : 9;
          self.page2Cdp.send('Emulation.setCPUThrottlingRate', { rate: p2rate }).catch(function() {});
        }
      } catch(e) { console.error('[session] Throttle:', e.message); }

      var ap = self.pages[self.activePageIdx];
      var url = ap.url();
      var title; try { title = await ap.title(); } catch(e) { title = url; }
      self._sendJSON({ type: 'tabState', active: self.activePageIdx, count: self.pages.length });
      self._sendJSON({ type: 'nav', url: url, title: title || url });
      self.forceScreenshot = true;
      console.log('[session] Switched to tab', self.activePageIdx);
    } catch(e) {
      console.error('[session] SwitchTab:', e.message);
      self._sendJSON({ type: 'toast', message: 'Failed to open media tab.' });
    }
  });
};

// ── Audio streaming (PulseAudio → ffmpeg → MP3 HTTP stream) ───────────────────

BrowserSession.prototype._createSink = function() {
  var self = this;
  var pulseEnv = Object.assign({}, process.env, { PULSE_SERVER: PULSE_SERVER });
  return new Promise(function(resolve) {
    var proc = spawn('pactl', [
      'load-module', 'module-null-sink',
      'sink_name=' + AUDIO_SINK_NAME,
      'sink_properties=device.description=BerryBrowse_BB10',
      'rate=' + AUDIO_SAMPLE_RATE,
    ], { env: pulseEnv });
    var out = '';
    proc.stdout.on('data', function(d) { out += d.toString(); });
    proc.on('close', function(code) {
      if (code !== 0) { console.error('[audio] Failed to create PulseAudio sink'); }
      else { self.audioSinkMod = out.trim(); console.log('[audio] Sink created, module:', self.audioSinkMod); }
      resolve();
    });
  });
};

BrowserSession.prototype._startAudio = function() {
  if (this.audioProcess) return;
  var self = this;

  if (!this.audioSinkMod) {
    this._createSink().then(function() {
      if (self.closed) return;
      setTimeout(function() { if (!self.closed) self._moveBrowserToSink(); }, 5000);
      _spawnFfmpeg();
    });
    return;
  }
  _spawnFfmpeg();

  function _spawnFfmpeg() {
    setTimeout(function() {
      if (self.closed) return;
      var pulseEnv = Object.assign({}, process.env, { PULSE_SERVER: PULSE_SERVER });
      self.audioProcess = spawn('ffmpeg', [
        '-f', 'pulse',
        '-fragment_size', '3528',
        '-probesize', '32',
        '-analyzeduration', '0',
        '-i', AUDIO_SINK_NAME + '.monitor',
        '-ac', '1',
        '-ar', String(AUDIO_SAMPLE_RATE),
        '-b:a', AUDIO_BITRATE,
        '-f', 'mp3',
        '-write_xing', '0',
        '-id3v2_version', '0',
        '-fflags', '+nobuffer',
        '-flush_packets', '1',
        '-avioflags', 'direct',
        'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'], env: pulseEnv });

      self.audioProcess.on('error', function(err) { console.error('[audio] ffmpeg error:', err.message); });

      var ffmpegStderr = '';
      self.audioProcess.stderr.on('data', function(d) {
        ffmpegStderr += d.toString();
        if (ffmpegStderr.length > 2048) { console.log('[audio] ffmpeg stderr:\n' + ffmpegStderr); ffmpegStderr = ''; }
      });
      self.audioProcess.on('close', function(code) {
        if (ffmpegStderr) console.log('[audio] ffmpeg stderr:\n' + ffmpegStderr);
        console.log('[audio] ffmpeg exited with code', code);
        self.audioProcess = null;
      });
      self.audioProcess.stdout.on('data', function(chunk) {
        if (self.closed) return;
        for (var i = self.audioClients.length - 1; i >= 0; i--) {
          try { self.audioClients[i].write(chunk); }
          catch(e) { self.audioClients.splice(i, 1); }
        }
      });
      console.log('[audio] ffmpeg streaming started');
    }, 1500);
  }
};

BrowserSession.prototype._moveBrowserToSink = function() {
  var self = this;
  if (!self.browser || !self.browser.process()) return;
  var pid = String(self.browser.process().pid);
  var pulseEnv = Object.assign({}, process.env, { PULSE_SERVER: PULSE_SERVER });
  var list = spawn('pactl', ['list', 'sink-inputs'], { env: pulseEnv });
  var out = '';
  list.stdout.on('data', function(d) { out += d.toString(); });
  list.on('close', function() {
    var blocks = out.split(/(?=Sink Input #)/);
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var indexMatch = block.match(/Sink Input #(\d+)/);
      if (!indexMatch) continue;
      if (block.indexOf('application.process.id = "' + pid + '"') !== -1) {
        spawn('pactl', ['move-sink-input', indexMatch[1], AUDIO_SINK_NAME], { env: pulseEnv });
      }
    }
  });
  if (!self.audioSinkInterval) {
    self.audioSinkInterval = setInterval(function() {
      if (self.closed) { clearInterval(self.audioSinkInterval); self.audioSinkInterval = null; return; }
      self._moveBrowserToSink();
    }, 5000);
  }
};

BrowserSession.prototype.addAudioClient = function(res) {
  this.audioClients.push(res);
  var self = this;
  res.on('close', function() {
    for (var i = 0; i < self.audioClients.length; i++) {
      if (self.audioClients[i] === res) { self.audioClients.splice(i, 1); break; }
    }
  });
};

BrowserSession.prototype._stopAudio = function() {
  if (this.audioSinkInterval) { clearInterval(this.audioSinkInterval); this.audioSinkInterval = null; }
  for (var i = 0; i < this.audioClients.length; i++) { try { this.audioClients[i].end(); } catch(e) {} }
  this.audioClients = [];
  if (this.audioProcess) { try { this.audioProcess.kill('SIGTERM'); } catch(e) {} this.audioProcess = null; }
  if (this.audioSinkMod) {
    var pulseEnv = Object.assign({}, process.env, { PULSE_SERVER: PULSE_SERVER });
    try { spawn('pactl', ['unload-module', this.audioSinkMod], { env: pulseEnv }); } catch(e) {}
    this.audioSinkMod = null;
    console.log('[audio] Sink cleaned up');
  }
};

BrowserSession.prototype.detach = function() {
  if (this.closed || this.disconnected) return;
  this.disconnected = true;
  if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  var self = this;
  this.graceTimer = setTimeout(function() {
    self.graceTimer = null;
    if (self.disconnected && !self.closed) {
      console.log('[session] Grace period expired — closing');
      self.close();
    }
  }, 30000);
  console.log('[session] Detached — 30s grace period started');
};

BrowserSession.prototype.reattach = function(ws) {
  if (this.closed) return false;
  if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
  this.ws = ws;
  this.disconnected = false;
  this._resetIdle();
  this._sendJSON({ type: 'init', desktopMode: this.desktopMode, zoomLevel: this.zoomLevel, preset: this.currentPreset, audioEnabled: AUDIO_ENABLED });
  this._sendNavWithTitle();
  console.log('[session] Reattached');
  return true;
};

BrowserSession.prototype.close = function() {
  if (this.closed) return;
  this.closed = true;
  this.disconnected = false;
  if (this.graceTimer)   clearTimeout(this.graceTimer);
  if (this.loopTimer)    clearTimeout(this.loopTimer);
  if (this.idleTimer)    clearTimeout(this.idleTimer);
  if (this.loadingTimer) clearTimeout(this.loadingTimer);
  if (this.chooserPendingPage) { this.chooserPendingPage = null; }
  if (this.chooserTimeout) { clearTimeout(this.chooserTimeout); this.chooserTimeout = null; }
  this._stopAudio();
  if (this.pages[1]) try { this.pages[1].close(); } catch(e) {}
  if (this.page)     try { this.page.close(); }    catch(e) {}
  if (this.browser)  this.browser.close().catch(function() {});
  if (this.xvfbProc) { try { this.xvfbProc.kill(); } catch(e) {} this.xvfbProc = null; }
  if (activeSession === this) activeSession = null;
  console.log('[session] Closed');
};

// ── Message binding ────────────────────────────────────────────────────────────

function bindMessages(ws, session) {
  ws.on('message', function(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    if (session.closed) return;
    switch (msg.type) {
      case 'navigate':    session.queueNavigate(msg.url);                          break;
      case 'click':       session.queueClick(msg.x, msg.y);                        break;
      case 'scroll':      session.queueScroll(msg.x, msg.y, msg.dx||0, msg.dy||0); break;
      case 'dragStart':   session.queueDragStart(msg.x, msg.y);                    break;
      case 'dragMove':    session.queueDragMove(msg.x, msg.y);                     break;
      case 'dragEnd':     session.queueDragEnd(msg.x, msg.y);                      break;
      case 'type':        session.queueType(msg.text);                             break;
      case 'key':         session.queueKey(msg.key, msg.modifiers);                break;
      case 'back':        session.queueBack();                                     break;
      case 'forward':     session.queueForward();                                  break;
      case 'refresh':     session.queueRefresh();                                  break;
      case 'quality':     session.setPreset(msg.preset);                           break;
      case 'desktopMode': session.setDesktopMode(msg.enabled);                     break;
      case 'zoom':        session.setZoom(msg.direction);                          break;
      case 'switchTab':   session.queueSwitchTab();                                break;
      case 'ping':        session._sendJSON({ type: 'pong', id: msg.id });         break;
      case 'history':     session._sendJSON({ type: 'history', entries: session.getHistory() }); break;
    }
  });
  ws.on('close', function() {
    console.log('[ws] Disconnected');
    session.detach();
  });
  ws.on('error', function(err) {
    if (err.message && err.message.indexOf('invalid UTF-8') !== -1) return;
    console.error('[ws]', err.message);
  });
}

// ── Express ────────────────────────────────────────────────────────────────────

var app    = express();
var server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/login', function(req, res) { res.sendFile(path.join(__dirname, 'login-bb10.html')); });

app.post('/login', function(req, res) {
  if (!PASSWORD || (req.body.password || '').trim() === PASSWORD) {
    var token = crypto.randomBytes(16).toString('hex');
    sessions.add(token);
    res.setHeader('Set-Cookie', 'session=' + token + '; Path=/; HttpOnly');
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.get('/logout', function(req, res) {
  sessions.delete(parseCookies(req.headers.cookie).session);
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/login');
});

app.get('/', requireAuth, function(req, res) {
  res.sendFile(path.join(__dirname, 'browser-bb10.html'));
});

app.get('/download/:token', requireAuth, function(req, res) {
  var entry = pendingDownloads[req.params.token];
  if (!entry || entry.expires < Date.now()) return res.status(404).send('Download not found or expired');
  delete pendingDownloads[req.params.token];
  res.setHeader('Content-Disposition', 'attachment; filename="' + entry.filename.replace(/"/g, '') + '"');
  res.setHeader('Content-Type', 'application/octet-stream');
  var stream = fs.createReadStream(entry.filePath);
  stream.on('close', function() { try { fs.unlinkSync(entry.filePath); } catch(e) {} });
  stream.on('error', function() { try { fs.unlinkSync(entry.filePath); } catch(e) {} });
  stream.pipe(res);
});

app.put('/api/upload', requireAuth,
  express.raw({ type: function() { return true; }, limit: UPLOAD_LIMIT }),
  function(req, res) {
    try {
      if (!req.body || !req.body.length) return res.status(400).json({ error: 'No file data' });
      var session = activeSession;
      if (!session || !session.chooserPendingPage) return res.status(400).json({ error: 'No file chooser pending' });
      var rawName  = req.headers['x-filename'] || 'upload';
      var filename = path.basename(decodeURIComponent(rawName)).replace(/[^\w.\-\s]/g, '_') || 'upload';
      var tempPath = path.join(UPLOADS_DIR, Date.now() + '_' + filename);
      fs.writeFileSync(tempPath, req.body);
      var chooserPage = session.chooserPendingPage;
      session.chooserPendingPage = null;
      if (session.chooserTimeout) { clearTimeout(session.chooserTimeout); session.chooserTimeout = null; }
      chooserPage.evaluateHandle(function() { return window.__bb_fi; })
        .then(function(handle) {
          var el = handle.asElement ? handle.asElement() : handle;
          return el.uploadFile(tempPath).then(function() { return handle.dispose(); });
        })
        .then(function() { setTimeout(function() { try { fs.unlinkSync(tempPath); } catch(e) {} }, 10000); })
        .catch(function() { try { fs.unlinkSync(tempPath); } catch(e) {} });
      res.json({ ok: true });
    } catch(err) {
      console.error('[upload]', err.message);
      res.status(500).json({ error: 'Upload failed' });
    }
  }
);

app.get('/api/audio/stream', requireAuth, function(req, res) {
  if (!AUDIO_ENABLED) return res.status(403).send('Audio disabled');
  if (!activeSession || activeSession.closed) return res.status(404).send('No active session');
  if (!activeSession.audioProcess) return res.status(503).send('Audio not ready');
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'keep-alive',
    'icy-name': 'BerryBrowse Audio',
  });
  var session = activeSession;
  session.addAudioClient(res);
  console.log('[audio] HTTP client connected | clients:', session.audioClients.length);
});

app.post('/api/upload/cancel', requireAuth, function(req, res) {
  var session = activeSession;
  if (session && session.chooserPendingPage) {
    session.chooserPendingPage = null;
    if (session.chooserTimeout) { clearTimeout(session.chooserTimeout); session.chooserTimeout = null; }
  }
  res.json({ ok: true });
});

// ── WebSocket ──────────────────────────────────────────────────────────────────

var wss = new WebSocket.Server({ noServer: true, skipUTF8Validation: true });

server.on('upgrade', function(req, socket, head) {
  if (PASSWORD) {
    var token = parseCookies(req.headers.cookie).session;
    if (!token || !sessions.has(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy(); return;
    }
  }
  wss.handleUpgrade(req, socket, head, function(ws) { wss.emit('connection', ws, req); });
});

wss.on('connection', async function(ws) {
  console.log('[ws] Connected');

  // Reattach to session in grace period
  if (activeSession && !activeSession.closed && activeSession.disconnected) {
    activeSession.reattach(ws);
    bindMessages(ws, activeSession);
    return;
  }

  // Close any stale session
  if (activeSession && !activeSession.closed) {
    activeSession.close();
  }

  // Start fresh session
  activeSession = new BrowserSession(ws);
  try {
    await activeSession.init();
  } catch(err) {
    console.error('[ws] Session init failed:', err.message);
    try { ws.send(JSON.stringify({ type: 'toast', message: 'Failed to start browser: ' + err.message })); } catch(e) {}
    ws.close(); return;
  }
  bindMessages(ws, activeSession);
});

// ── Boot ───────────────────────────────────────────────────────────────────────

server.listen(PORT, function() {
  console.log('');
  console.log('BerryBrowse BB10 Self-Hosted');
  console.log('Port:     ' + PORT);
  console.log('Password: ' + (PASSWORD ? 'set' : 'none (open access)'));
  console.log('Profile:  ' + PROFILE_DIR);
  console.log('Idle:     ' + (IDLE_TIMEOUT > 0 ? IDLE_TIMEOUT / 1000 + 's' : 'disabled'));
  console.log('Audio:    ' + (AUDIO_ENABLED ? AUDIO_BITRATE + ' / ' + AUDIO_SAMPLE_RATE + 'Hz' : 'disabled'));
  console.log('');
});

process.on('SIGINT', function() {
  try { fs.unlinkSync(LOCK_FILE); } catch(e) {}
  if (activeSession) activeSession.close();
  process.exit(0);
});
