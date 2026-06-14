const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');

puppeteer.use(StealthPlugin());

// The console URL redirects to the actual sign-in form
const AWS_SIGNIN_URL = 'https://console.aws.amazon.com/console/home';

// OMOCaptcha API base URL
const OMOCAPTCHA_BASE = 'https://api.omocaptcha.com';

class ProxySlot {
  constructor(apiKey, keyIndex, checker) {
    this.apiKey = apiKey;
    this.keyIndex = keyIndex;
    this.checker = checker;
    this.cachedProxy = null;
    this.cachedProxyTime = 0;
  }

  get label() {
    return `Key #${this.keyIndex + 1}`;
  }

  async getProxy() {
    const now = Date.now();
    const elapsed = now - this.cachedProxyTime;
    const interval = this.checker.proxyRotateInterval;
    const intervalSec = interval / 1000;

    // Reuse cached proxy if not expired
    if (this.cachedProxy && elapsed < interval) {
      const remaining = Math.round((interval - elapsed) / 1000);
      this.checker.log('info', `[${this.label}] Proxy cache: dùng lại IP hiện tại (còn ${remaining}s / ${intervalSec}s)`);
      return this.cachedProxy;
    }

    // Time to get new proxy IP (same API key, new IP)
    if (this.cachedProxy) {
      this.checker.log('info', `[${this.label}] ⟳ Đổi proxy IP mới (đã hết ${intervalSec}s)...`);
      this.checker.log('warn', `[${this.label}] ⏸ Tạm ngưng check — đang đổi IP và xác minh proxy...`);
    }

    // Try to get new proxy and verify it works
    const maxRetries = 5;
    const retryDelay = 10000; // 10s between retries

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (!this.checker.running) return null;

      const proxy = await this.checker.getProxyFromTMProxyForKey(this.apiKey, this.keyIndex);
      if (!proxy) {
        this.checker.log('warn', `[${this.label}] Không lấy được proxy (lần ${attempt}/${maxRetries}), thử lại sau ${retryDelay / 1000}s...`);
        await this.checker.sleep(retryDelay);
        continue;
      }

      // Verify proxy is working
      const isAlive = await this.verifyProxy(proxy);
      if (isAlive) {
        this.cachedProxy = proxy;
        this.cachedProxyTime = Date.now();
        this.checker.log('success', `[${this.label}] ✅ Proxy hoạt động! Tiếp tục check...`);
        return proxy;
      }

      this.checker.log('warn', `[${this.label}] Proxy chưa sẵn sàng (lần ${attempt}/${maxRetries}), đợi ${retryDelay / 1000}s...`);
      await this.checker.sleep(retryDelay);
    }

    // All retries failed — use last proxy anyway (better than nothing)
    this.checker.log('error', `[${this.label}] ⚠ Không xác minh được proxy sau ${maxRetries} lần, dùng proxy hiện tại`);
    // Try get-current-proxy as fallback
    const fallback = await this.checker.getCurrentTMProxy(this.apiKey, this.keyIndex);
    if (fallback) {
      const fbAlive = await this.verifyProxy(fallback);
      if (fbAlive) {
        this.cachedProxy = fallback;
        this.cachedProxyTime = Date.now();
        this.checker.log('success', `[${this.label}] ✅ Fallback proxy hoạt động!`);
        return fallback;
      }
    }

    return this.cachedProxy; // Return old cached if nothing works
  }

  /**
   * Verify a proxy is working by making a test HTTP request through it.
   * Uses a lightweight endpoint (httpbin or AWS itself).
   */
  async verifyProxy(proxyConfig) {
    try {
      const proxyUrl = proxyConfig.server;
      const { HttpsProxyAgent } = require('https-proxy-agent');

      let agentUrl = proxyUrl;
      if (proxyConfig.username && proxyConfig.password) {
        // Insert auth into URL: http://user:pass@host:port
        const parsed = new URL(proxyUrl);
        parsed.username = proxyConfig.username;
        parsed.password = proxyConfig.password;
        agentUrl = parsed.toString();
      }

      const agent = new HttpsProxyAgent(agentUrl);

      const res = await axios.get('https://httpbin.org/ip', {
        httpsAgent: agent,
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      if (res.status === 200 && res.data && res.data.origin) {
        this.checker.log('info', `[${this.label}] Proxy OK — IP: ${res.data.origin}`);
        return true;
      }
      return false;
    } catch (err) {
      this.checker.log('warn', `[${this.label}] Proxy verify failed: ${err.message}`);
      return false;
    }
  }
}

class AWSChecker {
  constructor(options) {
    this.emails = options.emails;
    this.proxies = options.proxies;
    this.captchaKey = options.captchaKey;
    // TMProxy: support multiple API keys (array)
    this.tmproxyKeys = options.tmproxyKeys || [];
    this.tmproxyLocation = options.tmproxyLocation || 1;
    this.tmproxyIsp = options.tmproxyIsp || 0;
    // Proxy IP rotation interval (default 240s = 4 minutes)
    this.proxyRotateInterval = (options.proxyRotateInterval || 240) * 1000;
    // Thread count = number of API keys (or manual override if no TMProxy)
    this.threads = this.tmproxyKeys.length > 0 ? this.tmproxyKeys.length : (options.threads || 1);
    this.delay = options.delay || 2000;
    this.onResult = options.onResult;
    this.onProgress = options.onProgress;
    this.onLog = options.onLog;
    this.onComplete = options.onComplete;
    this.running = false;
    this.results = { live: [], dead: [], error: [] };
    this.checked = 0;
  }

  stop() {
    this.running = false;
    this.log('warn', 'Đang dừng...');
  }

  log(type, message) {
    if (this.onLog) {
      this.onLog({ type, message, time: new Date().toLocaleTimeString() });
    }
  }

  getProxy() {
    if (!this.proxies || this.proxies.length === 0) return null;
    return this.proxies[Math.floor(Math.random() * this.proxies.length)].trim();
  }

  /**
   * Get a fresh proxy from TMProxy API for a specific API key.
   * Each key maintains its own proxy — key doesn't change, only IP rotates.
   */
  async getProxyFromTMProxyForKey(apiKey, keyIndex) {
    try {
      const keyLabel = `Key #${keyIndex + 1}`;
      this.log('info', `[${keyLabel}] TMProxy: Lấy proxy mới [${apiKey.slice(-8)}]...`);
      const res = await axios.post('https://tmproxy.com/api/proxy/get-new-proxy', {
        api_key: apiKey,
        id_location: this.tmproxyLocation,
        id_isp: this.tmproxyIsp
      }, { timeout: 15000 });

      if (res.data && res.data.code === 0 && res.data.data) {
        const d = res.data.data;
        const proxyHost = d.https || d.socks5;
        if (proxyHost) {
          this.log('success', `[${keyLabel}] TMProxy: ${proxyHost} (${d.location_name || ''} - ${d.isp_name || ''})`);
          if (d.username && d.password) {
            return { server: `http://${proxyHost}`, username: d.username, password: d.password };
          }
          return { server: `http://${proxyHost}`, username: null, password: null };
        }
      }

      // If error, try get-current-proxy instead
      const errMsg = res.data?.message || 'Unknown error';
      const nextReq = res.data?.data?.next_request;
      this.log('warn', `[${keyLabel}] TMProxy get-new error: ${errMsg}${nextReq ? ` (chờ ${nextReq}s)` : ''}`);
      
      if (nextReq > 0) {
        return await this.getCurrentTMProxy(apiKey, keyIndex);
      }
      return null;
    } catch (err) {
      this.log('error', `[Key #${keyIndex + 1}] TMProxy API error: ${err.message}`);
      return null;
    }
  }

  /**
   * Get current (already assigned) proxy from TMProxy for a specific key
   */
  async getCurrentTMProxy(apiKey, keyIndex) {
    try {
      const res = await axios.post('https://tmproxy.com/api/proxy/get-current-proxy', {
        api_key: apiKey
      }, { timeout: 15000 });

      if (res.data && res.data.code === 0 && res.data.data) {
        const d = res.data.data;
        const proxyHost = d.https || d.socks5;
        if (proxyHost) {
          this.log('info', `[Key #${keyIndex + 1}] TMProxy (current): ${proxyHost}`);
          if (d.username && d.password) {
            return { server: `http://${proxyHost}`, username: d.username, password: d.password };
          }
          return { server: `http://${proxyHost}`, username: null, password: null };
        }
      }
      return null;
    } catch (err) {
      this.log('error', `[Key #${keyIndex + 1}] TMProxy current error: ${err.message}`);
      return null;
    }
  }

  parseProxy(proxyStr) {
    if (!proxyStr) return null;
    if (proxyStr.includes('://')) {
      try {
        const url = new URL(proxyStr);
        return { server: `${url.protocol}//${url.hostname}:${url.port}`, username: url.username || null, password: url.password || null };
      } catch (e) { return null; }
    }
    const parts = proxyStr.split(':');
    if (parts.length === 2) return { server: `http://${parts[0]}:${parts[1]}`, username: null, password: null };
    if (parts.length === 4) return { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
    return null;
  }

  // ═══════════════════════════════════════════════════════
  // OMOCaptcha Integration (per official docs v2)
  // Base URL: https://api.omocaptcha.com
  // POST /v2/createTask  -> create captcha solving task
  // POST /v2/getTaskResult -> poll for result (exponential backoff)
  // ═══════════════════════════════════════════════════════

  /**
   * Poll getTaskResult with exponential backoff per OMOCaptcha docs:
   * - Initial delay: 2s
   * - Multiply by 1.5x each poll
   * - Cap at 10s
   * - Timeout after 90s
   */
  async pollTaskResult(taskId) {
    const maxWaitMs = 90000;
    const start = Date.now();
    let delay = 2000;

    while (Date.now() - start < maxWaitMs) {
      if (!this.running) {
        this.log('warn', 'Dừng polling captcha do checker bị stop');
        return null;
      }

      await this.sleep(delay);

      try {
        const res = await axios.post(`${OMOCAPTCHA_BASE}/v2/getTaskResult`, {
          clientKey: this.captchaKey,
          taskId: taskId
        }, { timeout: 30000 });

        // Error check
        if (res.data.errorId && res.data.errorId !== 0) {
          const errCode = res.data.errorCode || '';
          const errDesc = res.data.errorDescription || '';
          this.log('error', `OMOCaptcha poll: [${errCode}] ${errDesc}`);
          // Non-recoverable errors
          if (['ERROR_TASK_NOT_FOUND', 'ERROR_TASK_KEY_MISMATCH'].includes(errCode)) {
            return null;
          }
          // Continue for other errors
        }

        const status = res.data.status;
        if (status === 'ready') {
          const elapsed = Math.round((Date.now() - start) / 1000);
          this.log('success', `OMOCaptcha: Solved! (${elapsed}s)`);
          return res.data.solution;
        } else if (status === 'fail') {
          this.log('warn', 'OMOCaptcha: Captcha không giải được — tiền đã hoàn');
          return null;
        } else if (status === 'processing') {
          const elapsed = Math.round((Date.now() - start) / 1000);
          this.log('info', `OMOCaptcha: Đang xử lý... (${elapsed}s, poll ${Math.round(delay/1000)}s)`);
        }
      } catch (err) {
        this.log('error', `OMOCaptcha poll error: ${err.message}`);
      }

      // Exponential backoff, cap at 10s
      delay = Math.min(Math.floor(delay * 1.5), 10000);
    }

    this.log('error', 'OMOCaptcha: Timeout (90s)');
    return null;
  }

  /**
   * Screenshot a DOM element and return base64 PNG (bypasses cross-origin)
   */
  async screenshotElement(page, selector) {
    try {
      const el = await page.$(selector);
      if (!el) return null;
      const buf = await el.screenshot({ encoding: 'base64' });
      return buf;
    } catch (e) {
      this.log('error', `Screenshot error (${selector}): ${e.message}`);
      return null;
    }
  }

  async solveCaptcha(page, siteUrl) {
    if (!this.captchaKey) {
      this.log('warn', 'Không có OMOCaptcha API key, bỏ qua captcha...');
      return null;
    }

    try {
      // Step 1: Detect captcha type on page
      const captchaInfo = await page.evaluate(() => {
        const bodyText = (document.body.innerText || '').toLowerCase();

        // ═══ AWS Custom Captcha ("Making sure its you") ═══
        if (bodyText.includes('making sure') || bodyText.includes('type the characters') || bodyText.includes('verification check')) {
          // Find the text input for captcha answer
          let inputSelector = null;
          let inputRect = null;
          const allInputs = document.querySelectorAll('input[type="text"], input:not([type])');
          for (const inp of allInputs) {
            if (inp.offsetParent === null) continue;
            if (inp.type === 'hidden' || inp.type === 'password' || inp.type === 'email' || inp.type === 'checkbox' || inp.type === 'radio') continue;
            if (inp.id === 'resolving_input' || inp.name === 'email') continue;
            if (inp.id) {
              inputSelector = `#${CSS.escape(inp.id)}`;
            } else if (inp.name) {
              inputSelector = `input[name="${inp.name}"]`;
            } else {
              inputSelector = 'input[type="text"]';
            }
            const rect = inp.getBoundingClientRect();
            inputRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            break;
          }

          // Find the submit button: "I'm not a robot"
          let submitSelector = null;
          const allButtons = document.querySelectorAll('button');
          for (const btn of allButtons) {
            const btnText = (btn.textContent || '').toLowerCase().trim();
            if (btnText.includes('not a robot') || btnText.includes('submit') || btnText.includes('verify')) {
              if (btn.id) {
                submitSelector = `#${btn.id}`;
              }
              break;
            }
          }

          return {
            type: 'aws_captcha',
            inputSelector,
            inputRect,
            submitSelector,
            debug: `input=${inputSelector}, submit=${submitSelector}`
          };
        }

        // ═══ Standard captcha types (fallback) ═══
        const captchaImg = document.querySelector(
          'img#captcha_image, img[alt*="captcha" i], img[src*="captcha" i], ' +
          'img[id*="captcha" i], img[class*="captcha" i]'
        );
        if (captchaImg && captchaImg.offsetParent !== null) {
          const captchaInput = document.querySelector(
            'input#captchaGuess, input[name*="captcha" i], input[id*="captcha" i]'
          );
          return {
            type: 'image',
            imgSelector: captchaImg.id ? `#${captchaImg.id}` : 'img[src*="captcha" i]',
            inputSelector: captchaInput ? (captchaInput.id ? `#${CSS.escape(captchaInput.id)}` : null) : null,
          };
        }

        const fcIframe = document.querySelector('iframe[src*="funcaptcha"], iframe[src*="arkoselabs"]');
        if (fcIframe) {
          return { type: 'funcaptcha_iframe', src: fcIframe.src || '' };
        }

        const recaptcha = document.querySelector('.g-recaptcha, [data-sitekey]:not([data-size="invisible"])');
        if (recaptcha) {
          return { type: 'recaptcha_v2', sitekey: recaptcha.getAttribute('data-sitekey') || '' };
        }

        const hcaptcha = document.querySelector('.h-captcha, [data-hcaptcha-sitekey]');
        if (hcaptcha) {
          return { type: 'hcaptcha', sitekey: hcaptcha.getAttribute('data-sitekey') || '' };
        }

        return null;
      });

      if (!captchaInfo) {
        this.log('info', 'Không phát hiện captcha trên trang');
        return null;
      }

      this.log('info', `Phát hiện captcha: ${captchaInfo.type} | ${captchaInfo.debug || ''}`);

      // Step 2: Build createTask based on captcha type
      let taskPayload = {};
      let captchaContext = {};

      switch (captchaInfo.type) {
        case 'aws_captcha': {
          this.log('info', `AWS Captcha: input=${captchaInfo.inputSelector}`);
          
          let imgBase64 = null;
          
          // Method 1: Find non-logo <img> elements and screenshot them
          this.log('info', 'Tìm captcha image (bỏ qua logo/icon)...');
          const imgs = await page.$$('img');
          for (const img of imgs) {
            const box = await img.boundingBox();
            if (!box) continue;
            
            const imgSrc = await page.evaluate(el => (el.getAttribute('src') || '').toLowerCase(), img);
            // Skip logos, icons, brand images
            if (imgSrc.includes('logo') || imgSrc.includes('icon') || imgSrc.includes('brand') || 
                imgSrc.includes('banner') || imgSrc.includes('favicon') || imgSrc.includes('aws.amazon.com')) {
              this.log('info', `Bỏ qua: ${imgSrc.substring(0, 60)} (logo/icon)`);
              continue;
            }
            
            // Captcha image: 80-500px wide, 25-200px tall
            if (box.width >= 80 && box.width <= 500 && box.height >= 25 && box.height <= 200) {
              imgBase64 = await img.screenshot({ encoding: 'base64' });
              this.log('success', `Chụp captcha img: ${Math.round(box.width)}x${Math.round(box.height)} src=${imgSrc.substring(0, 60)}`);
              break;
            }
          }
          
          // Method 2: Screenshot the region ABOVE the captcha input field
          if (!imgBase64 && captchaInfo.inputRect) {
            this.log('info', 'Chụp vùng captcha bằng clip (vùng phía trên input)...');
            const ir = captchaInfo.inputRect;
            
            // Captcha image is above the input, inside a bordered box
            // Typically 200px above the input, same width
            const clipRegion = {
              x: Math.max(0, ir.x - 10),
              y: Math.max(0, ir.y - 200),
              width: Math.min(ir.width + 80, 450),
              height: 170
            };
            
            this.log('info', `Clip: x=${Math.round(clipRegion.x)} y=${Math.round(clipRegion.y)} w=${Math.round(clipRegion.width)} h=${Math.round(clipRegion.height)}`);
            
            try {
              imgBase64 = await page.screenshot({ encoding: 'base64', clip: clipRegion });
              this.log('success', 'Chụp captcha bằng clip thành công!');
            } catch(clipErr) {
              this.log('error', `Clip error: ${clipErr.message}`);
            }
          }
          
          // Method 3: Screenshot the full captcha container
          if (!imgBase64) {
            this.log('warn', 'Chụp toàn bộ container captcha...');
            try {
              const containerBox = await page.evaluate(() => {
                const els = document.querySelectorAll('div, section, main, form');
                for (const el of els) {
                  const text = (el.innerText || '').toLowerCase();
                  if (text.includes('making sure') && text.includes('type the characters')) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 200 && r.height > 200) {
                      return { x: r.x, y: r.y, width: r.width, height: r.height };
                    }
                  }
                }
                return null;
              });
              
              if (containerBox) {
                imgBase64 = await page.screenshot({
                  encoding: 'base64',
                  clip: { x: Math.max(0, containerBox.x), y: Math.max(0, containerBox.y), width: Math.min(containerBox.width, 500), height: Math.min(containerBox.height, 400) }
                });
                this.log('info', 'Chụp container thành công');
              }
            } catch(e) {
              this.log('error', `Container error: ${e.message}`);
            }
          }
          
          if (!imgBase64) {
            this.log('error', 'AWS Captcha: Không thể chụp ảnh captcha');
            return null;
          }

          taskPayload = { type: 'ImageToTextTask', imageBase64: imgBase64 };
          captchaContext = { 
            inputSelector: captchaInfo.inputSelector, 
            submitSelector: captchaInfo.submitSelector,
            method: 'aws_text' 
          };
          break;
        }

        case 'image': {
          // Use Puppeteer screenshot() to get captcha image (no cross-origin issues)
          this.log('info', `Chụp ảnh captcha: ${captchaInfo.imgSelector}`);
          const imgBase64 = await this.screenshotElement(page, captchaInfo.imgSelector);
          
          if (!imgBase64) {
            // Fallback: try full page screenshot cropped to the captcha area
            this.log('warn', 'Không screenshot được element, thử screenshot vùng captcha...');
            const el = await page.$(captchaInfo.imgSelector);
            if (el) {
              const box = await el.boundingBox();
              if (box) {
                const buf = await page.screenshot({
                  encoding: 'base64',
                  clip: { x: box.x, y: box.y, width: box.width, height: box.height }
                });
                if (buf) {
                  taskPayload = { type: 'ImageToTextTask', imageBase64: buf };
                  captchaContext = { inputSelector: captchaInfo.inputSelector, method: 'text' };
                  break;
                }
              }
            }
            this.log('error', 'Không thể chụp ảnh captcha');
            return null;
          }

          taskPayload = { type: 'ImageToTextTask', imageBase64: imgBase64 };
          captchaContext = { inputSelector: captchaInfo.inputSelector, method: 'text' };
          break;
        }

        case 'funcaptcha_iframe':
        case 'funcaptcha_div': {
          // For FunCaptcha, we need to screenshot the challenge image inside the iframe
          // and get the question text
          this.log('info', 'FunCaptcha: Đang chụp ảnh challenge...');
          
          // Try to access the FunCaptcha iframe content
          let fcImgBase64 = null;
          let questionText = '';
          
          const frames = page.frames();
          for (const frame of frames) {
            const frameUrl = frame.url();
            if (frameUrl.includes('funcaptcha') || frameUrl.includes('arkoselabs')) {
              try {
                // Get the challenge image
                const challengeImg = await frame.$('img.fc-image, .challenge-image img, #challenge-image');
                if (challengeImg) {
                  fcImgBase64 = await challengeImg.screenshot({ encoding: 'base64' });
                }
                // Get question text
                questionText = await frame.evaluate(() => {
                  const q = document.querySelector('.fc-prompt-text, .challenge-prompt, h2');
                  return q ? q.textContent.trim() : '';
                });
              } catch (frameErr) {
                this.log('warn', `FunCaptcha iframe error: ${frameErr.message}`);
              }
              break;
            }
          }

          if (!fcImgBase64) {
            // Fallback: screenshot the entire iframe area
            const iframeEl = await page.$('iframe[src*="funcaptcha"], iframe[src*="arkoselabs"]');
            if (iframeEl) {
              fcImgBase64 = await iframeEl.screenshot({ encoding: 'base64' });
            }
          }

          if (!fcImgBase64) {
            this.log('error', 'FunCaptcha: Không thể chụp ảnh challenge');
            return null;
          }

          taskPayload = {
            type: 'FuncaptchaImageTask',
            imageBase64: fcImgBase64,
            other: questionText || 'Pick the correct image'
          };
          captchaContext = { method: 'funcaptcha_click' };
          break;
        }

        case 'recaptcha_v2':
          taskPayload = {
            type: 'RecaptchaV2TokenTask',
            websiteURL: siteUrl,
            websiteKey: captchaInfo.sitekey,
          };
          captchaContext = { method: 'recaptcha_token' };
          break;

        case 'hcaptcha':
          taskPayload = {
            type: 'HcaptchaImageTask',
            websiteURL: siteUrl,
            websiteKey: captchaInfo.sitekey,
          };
          captchaContext = { method: 'hcaptcha_token' };
          break;

        default:
          this.log('warn', `Captcha type không hỗ trợ: ${captchaInfo.type}`);
          return null;
      }

      // Step 3: Call POST /v2/createTask
      this.log('info', `OMOCaptcha: Tạo task ${taskPayload.type}...`);
      
      const createRes = await axios.post(`${OMOCAPTCHA_BASE}/v2/createTask`, {
        clientKey: this.captchaKey,
        task: taskPayload
      }, { timeout: 30000 });

      if (createRes.data.errorId && createRes.data.errorId !== 0) {
        const errCode = createRes.data.errorCode || '';
        const errDesc = createRes.data.errorDescription || 'Unknown error';
        this.log('error', `OMOCaptcha createTask: [${errCode}] ${errDesc}`);
        if (errCode === 'ERROR_KEY_DOES_NOT_EXIST') this.log('error', 'API key không tồn tại!');
        else if (errCode === 'ERROR_ZERO_BALANCE') this.log('error', 'Hết tiền OMOCaptcha!');
        return null;
      }

      const taskId = createRes.data.taskId;
      if (!taskId) {
        this.log('error', 'OMOCaptcha: Không nhận được taskId');
        return null;
      }
      
      this.log('info', `OMOCaptcha: Task #${taskId} đang giải...`);

      // Step 4: Poll with exponential backoff (2s → 3s → 4.5s → ... cap 10s, timeout 90s)
      const solution = await this.pollTaskResult(taskId);
      if (!solution) return null;

      // Step 5: Apply solution based on captcha type
      this.log('success', `OMOCaptcha: Solution = ${JSON.stringify(solution)}`);

      if (captchaContext.method === 'aws_text' && solution.text) {
        // AWS "Making sure its you" captcha
        this.log('info', `Nhập captcha AWS: "${solution.text}"`);
        
        let inputEl = null;
        
        // Try the detected selector first
        if (captchaContext.inputSelector) {
          inputEl = await page.$(captchaContext.inputSelector);
        }
        
        // Fallback: find the visible text input that's NOT the email field
        if (!inputEl) {
          this.log('info', 'Tìm ô nhập captcha bằng fallback...');
          const inputHandle = await page.evaluateHandle(() => {
            const inputs = document.querySelectorAll('input');
            for (const inp of inputs) {
              if (inp.offsetParent === null) continue;
              if (inp.type === 'hidden' || inp.type === 'password' || inp.type === 'email' || inp.type === 'checkbox') continue;
              if (inp.id === 'resolving_input' || inp.id === 'account' || inp.id === 'username') continue;
              if (inp.name === 'email' || inp.name === 'password') continue;
              return inp;
            }
            return null;
          });
          inputEl = inputHandle.asElement();
        }

        if (inputEl) {
          await inputEl.click({ clickCount: 3 });
          await this.sleep(200);
          await inputEl.type(solution.text, { delay: 40 });
          this.log('success', `Đã nhập captcha: "${solution.text}"`);
          await this.sleep(500);
          
          // Click "I'm not a robot" button
          // Method 1: Find button by text and click using Puppeteer native click
          let submitClicked = false;
          
          const allButtons = await page.$$('button');
          for (const btn of allButtons) {
            const btnText = await page.evaluate(el => (el.textContent || '').toLowerCase().trim(), btn);
            if (btnText.includes('not a robot') || btnText.includes('verify') || btnText.includes('submit')) {
              try {
                await btn.click();
                submitClicked = true;
                this.log('success', `Đã click button: "${btnText}"`);
              } catch(clickErr) {
                this.log('warn', `Click error: ${clickErr.message}, thử evaluate click...`);
                // Method 2: Fallback to evaluate click
                await page.evaluate(el => el.click(), btn);
                submitClicked = true;
                this.log('success', `Đã click button (evaluate): "${btnText}"`);
              }
              break;
            }
          }
          
          if (!submitClicked && captchaContext.submitSelector) {
            const submitBtn = await page.$(captchaContext.submitSelector);
            if (submitBtn) {
              await submitBtn.click();
              submitClicked = true;
              this.log('info', `Clicked submit selector: ${captchaContext.submitSelector}`);
            }
          }
          
          if (!submitClicked) {
            // Method 3: Press Enter as last resort
            await page.keyboard.press('Enter');
            this.log('info', 'Pressed Enter (fallback submit)');
          }
          
          // Wait for page response after clicking "I'm not a robot"
          this.log('info', 'Đợi phản hồi sau khi click "I\'m not a robot"...');
          await this.sleep(3000);
        } else {
          this.log('error', 'AWS Captcha: Không tìm thấy ô nhập');
        }
      }

      if (captchaContext.method === 'text' && solution.text) {
        // Image captcha: type the answer text
        this.log('info', `Nhập captcha text: "${solution.text}"`);
        
        // Find the captcha input field
        let inputSel = captchaContext.inputSelector;
        if (!inputSel) {
          // Try to find automatically
          inputSel = await page.evaluate(() => {
            const candidates = [
              'input#captchaGuess', 'input[name*="captcha" i]', 'input[id*="captcha" i]',
              'input[placeholder*="captcha" i]', 'input[placeholder*="verify" i]',
              'input[placeholder*="characters" i]', 'input[placeholder*="code" i]',
              'input[aria-label*="captcha" i]',
            ];
            for (const sel of candidates) {
              const el = document.querySelector(sel);
              if (el && el.offsetParent !== null) return sel;
            }
            return null;
          });
        }

        if (inputSel) {
          const inputEl = await page.$(inputSel);
          if (inputEl) {
            await inputEl.click({ clickCount: 3 });
            await this.sleep(200);
            await inputEl.type(solution.text, { delay: 50 });
            this.log('success', 'Đã nhập captcha text!');
          }
        } else {
          this.log('warn', 'Không tìm thấy ô nhập captcha');
        }
      }

      if (captchaContext.method === 'funcaptcha_click' && solution.index) {
        // FunCaptcha: click right arrow (index-1) times
        const clicks = solution.index - 1;
        this.log('info', `FunCaptcha: Click mũi tên phải ${clicks} lần (index=${solution.index})`);
        const frames = page.frames();
        for (const frame of frames) {
          if (frame.url().includes('funcaptcha') || frame.url().includes('arkoselabs')) {
            for (let i = 0; i < clicks; i++) {
              const rightBtn = await frame.$('.fc-button-next, .right-arrow, button[aria-label="next"]');
              if (rightBtn) {
                await rightBtn.click();
                await this.sleep(500);
              }
            }
            // Click submit/verify
            const submitBtn = await frame.$('.fc-button-submit, .verify-button, button[type="submit"]');
            if (submitBtn) await submitBtn.click();
            break;
          }
        }
      }

      if (captchaContext.method === 'recaptcha_token' && (solution.token || solution.gRecaptchaResponse)) {
        const token = solution.token || solution.gRecaptchaResponse;
        await page.evaluate((t) => {
          const el = document.querySelector('#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
          if (el) { el.value = t; el.innerHTML = t; }
        }, token);
      }

      return solution;
    } catch (err) {
      this.log('error', `OMOCaptcha error: ${err.message}`);
      return null;
    }
  }

  async checkEmail(email, browser, proxyConfig) {
    let page = null;
    try {
      page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 768 });
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

      // Block heavy resources to speed up page loading significantly
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        const url = req.url().toLowerCase();
        // Block fonts, media, and tracking scripts (not needed for form interaction)
        if (resourceType === 'font' || resourceType === 'media' ||
            (resourceType === 'script' && (url.includes('analytics') || url.includes('tag-manager') || url.includes('gtm.js') || url.includes('tracking') || url.includes('beacon')))) {
          req.abort().catch(() => {});
        } else {
          req.continue().catch(() => {});
        }
      });

      // Apply proxy authentication on THIS page (not just the first tab)
      if (proxyConfig && proxyConfig.username) {
        await page.authenticate({ username: proxyConfig.username, password: proxyConfig.password });
      }

      // Clear cookies/storage to prevent session contamination between checks
      try {
        const client = await page.createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.send('Network.clearBrowserCache');
        await client.detach();
      } catch (cdpErr) {
        this.log('warn', `CDP clear cookies failed (non-critical): ${cdpErr.message}`);
      }

      this.log('info', `Đang kiểm tra: ${email}`);

      // Step 1: Navigate to AWS Console (redirects to sign-in)
      // Use domcontentloaded (faster & more reliable) instead of networkidle2 (often timeouts)
      try {
        await page.goto(AWS_SIGNIN_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
      } catch (navErr) {
        if (navErr.message.includes('timeout') || navErr.message.includes('Timeout')) {
          this.log('warn', 'Navigation timeout với domcontentloaded, thử load strategy...');
          try {
            await page.goto(AWS_SIGNIN_URL, { waitUntil: 'load', timeout: 90000 });
          } catch (navErr2) {
            throw new Error(`Navigation failed: ${navErr2.message}`);
          }
        } else {
          throw navErr;
        }
      }
      // Wait for form elements to actually appear on page
      try {
        await page.waitForSelector('#resolving_input, #account, input[name="email"], input[type="email"]', { visible: true, timeout: 30000 });
      } catch(e) {
        this.log('warn', 'Form chưa xuất hiện sau 30s, tiếp tục thử...');
      }
      await this.sleep(2000);

      const currentUrl = page.url();
      this.log('info', `Trang sign-in: ${currentUrl.substring(0, 80)}...`);

      // Step 2: Switch to Root user form
      // AWS defaults to IAM user form (has #account, #username, #password visible)
      // We MUST click "Sign in using root user email" to get to root user form
      const isOnIAMForm = await page.evaluate(() => {
        return !!(document.querySelector('#account') || document.querySelector('#username'));
      });

      if (isOnIAMForm) {
        this.log('info', 'Đang ở trang IAM, chuyển sang Root user...');
        
        // Try clicking the root user button
        const rootBtn = await page.$('#root_account_signin');
        if (rootBtn) {
          this.log('info', 'Click "Sign in using root user email"...');
          await rootBtn.click();
        } else {
          // Fallback: find button by text
          const clicked = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
              const txt = (btn.textContent || '').toLowerCase();
              if (txt.includes('root user email') || txt.includes('root user sign in')) {
                btn.click();
                return true;
              }
            }
            return false;
          });
          if (!clicked) {
            this.log('warn', 'Không tìm thấy nút Root user!');
          }
        }

        // Wait for the Root user form to load
        // The page may navigate to a new URL or just swap the form
        await this.sleep(2000);
        
        try {
          await page.waitForSelector('#resolving_input', { visible: true, timeout: 15000 });
          this.log('info', 'Form Root user đã load (#resolving_input)');
        } catch(e) {
          // Maybe the page navigated — wait for any email-like input
          this.log('warn', '#resolving_input không tìm thấy, tìm input email khác...');
          await this.sleep(3000);
        }
      } else {
        // Check if we're already on Root user form
        const hasResolvingInput = await page.$('#resolving_input');
        if (hasResolvingInput) {
          this.log('info', 'Đã ở trang Root user form');
        } else {
          this.log('info', 'Trang không phải IAM cũng không phải Root user, thử tiếp...');
          await this.sleep(2000);
        }
      }

      // Step 3: Verify we're on Root user form now (not IAM)
      const postSwitchState = await page.evaluate(() => {
        return {
          url: window.location.href,
          hasAccount: !!document.querySelector('#account'),
          hasUsername: !!document.querySelector('#username'),
          hasResolvingInput: !!document.querySelector('#resolving_input'),
          hasNextButton: !!document.querySelector('#next_button'),
          visibleInputs: Array.from(document.querySelectorAll('input'))
            .filter(i => i.offsetParent !== null)
            .map(i => ({ id: i.id, name: i.name, type: i.type }))
        };
      });
      
      this.log('info', `Post-switch: resolving_input=${postSwitchState.hasResolvingInput}, account=${postSwitchState.hasAccount}, next_button=${postSwitchState.hasNextButton}`);
      this.log('info', `Visible inputs: ${JSON.stringify(postSwitchState.visibleInputs.map(i => i.id || i.name || i.type))}`);

      // SAFETY CHECK: If still on IAM form, something went wrong
      if (postSwitchState.hasAccount && postSwitchState.hasUsername && !postSwitchState.hasResolvingInput) {
        this.log('error', 'Vẫn đang ở IAM form sau khi switch! Thử lại...');
        // One more attempt
        const rootBtn2 = await page.$('#root_account_signin');
        if (rootBtn2) {
          await rootBtn2.click();
          await this.sleep(3000);
          try {
            await page.waitForSelector('#resolving_input', { visible: true, timeout: 10000 });
          } catch(e) {
            throw new Error('Không thể chuyển sang Root user form');
          }
        } else {
          throw new Error('Không tìm thấy nút Root user, vẫn kẹt ở IAM form');
        }
      }

      // Step 4: Find and fill the email input
      const emailSelectors = [
        '#resolving_input', '#email', '#ap_email',
        'input[name="email"]', 'input[type="email"]',
        'input[name="resolving_input"]',
        'input[placeholder*="email" i]', 'input[aria-label*="email" i]',
      ];

      let emailInput = null;
      for (const sel of emailSelectors) {
        const el = await page.$(sel);
        if (el) {
          const isVisible = await page.evaluate(s => {
            const e = document.querySelector(s);
            return e && e.offsetParent !== null;
          }, sel);
          if (isVisible) {
            emailInput = el;
            this.log('info', `Email input found: ${sel}`);
            break;
          }
        }
      }

      // Fallback: try any visible text input that isn't account/username/password
      if (!emailInput) {
        const fallbackSel = await page.evaluate(() => {
          const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])'));
          for (const inp of inputs) {
            if (inp.offsetParent === null) continue;
            if (['account', 'username', 'password'].includes(inp.id)) continue;
            if (['account', 'username', 'password'].includes(inp.name)) continue;
            if (inp.type === 'checkbox' || inp.type === 'radio' || inp.type === 'hidden' || inp.type === 'password') continue;
            return inp.id ? `#${inp.id}` : (inp.name ? `input[name="${inp.name}"]` : null);
          }
          return null;
        });
        if (fallbackSel) {
          emailInput = await page.$(fallbackSel);
          this.log('info', `Email input (fallback): ${fallbackSel}`);
        }
      }

      if (!emailInput) {
        this.log('error', `Không tìm thấy ô email. Inputs: ${JSON.stringify(postSwitchState.visibleInputs)}`);
        throw new Error('Không tìm thấy ô nhập email');
      }

      // Type email
      await emailInput.click({ clickCount: 3 });
      await this.sleep(200);
      await emailInput.type(email, { delay: 30 + Math.random() * 40 });
      this.log('info', `Đã nhập email: ${email}`);
      await this.sleep(500);

      // Step 5: Click Next button (on Root user form it's #next_button)
      const nextSelectors = ['#next_button', 'button[type="submit"]', 'input[type="submit"]'];
      let clicked = false;
      for (const sel of nextSelectors) {
        const btn = await page.$(sel);
        if (btn) {
          const isVisible = await page.evaluate(s => {
            const e = document.querySelector(s);
            return e && e.offsetParent !== null;
          }, sel);
          if (isVisible) {
            await btn.click();
            this.log('info', `Clicked: ${sel}`);
            clicked = true;
            break;
          }
        }
      }
      if (!clicked) {
        // Fallback: find "Next" button by text
        const clickedByText = await page.evaluate(() => {
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            const txt = (btn.textContent || '').trim().toLowerCase();
            if (txt === 'next' || txt === 'tiếp') {
              btn.click();
              return true;
            }
          }
          return false;
        });
        if (clickedByText) {
          this.log('info', 'Clicked Next by text');
          clicked = true;
        }
      }
      if (!clicked) {
        await page.keyboard.press('Enter');
        this.log('info', 'Pressed Enter');
      }

      // Step 6: Wait for response after submitting email
      // After clicking Next on root user form, AWS will either:
      // - Show password page (LIVE) — URL may change, shows "Enter the password for"
      // - Show error message (DEAD) — "does not exist", alert role
      // - Show captcha (need solving)
      this.log('info', 'Chờ phản hồi sau khi submit email...');
      
      try {
        await Promise.race([
          page.waitForNavigation({ timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {}),
          page.waitForSelector('#password_input, input[name="password"][type="password"]', { visible: true, timeout: 30000 }).catch(() => {}),
          page.waitForSelector('[role="alert"]', { visible: true, timeout: 30000 }).catch(() => {}),
          this.sleep(20000)
        ]);
      } catch(e) {
        this.log('warn', `Wait error (non-critical): ${e.message}`);
      }
      
      await this.sleep(3000);

      // Step 6.5: Check for captcha and solve if needed (with retry loop)
      const MAX_CAPTCHA_RETRIES = 3;
      for (let captchaAttempt = 0; captchaAttempt < MAX_CAPTCHA_RETRIES; captchaAttempt++) {
        if (!this.running) break;
        
        const hasCaptcha = await page.evaluate(() => {
          const bodyText = (document.body.innerText || '').toLowerCase();
          if (bodyText.includes('making sure') || bodyText.includes('type the characters') || bodyText.includes('verification check')) {
            return true;
          }
          return !!(
            document.querySelector('iframe[src*="funcaptcha"], iframe[src*="arkoselabs"]') ||
            document.querySelector('.g-recaptcha, [data-sitekey]') ||
            document.querySelector('.h-captcha')
          );
        });

        if (!hasCaptcha) {
          if (captchaAttempt > 0) {
            this.log('success', `Captcha đã vượt qua sau ${captchaAttempt} lần!`);
          }
          break; // No captcha, proceed to result detection
        }

        this.log('warn', `Phát hiện CAPTCHA! Đang giải... (lần ${captchaAttempt + 1}/${MAX_CAPTCHA_RETRIES})`);
        const solution = await this.solveCaptcha(page, page.url());
        
        if (!solution) {
          this.log('warn', 'Không giải được captcha');
          break;
        }
        
        this.log('success', `Captcha đã giải xong: "${solution.text || '?'}"`);
        
        // solveCaptcha() already typed text + clicked "I'm not a robot" + waited 3s
        // Now wait for actual page transition (password page, error, or new captcha)
        this.log('info', 'Chờ page chuyển sau khi submit captcha...');
        
        try {
          await Promise.race([
            page.waitForNavigation({ timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {}),
            page.waitForSelector('#password_input, input[name="password"][type="password"]', { visible: true, timeout: 30000 }).catch(() => {}),
            page.waitForSelector('[role="alert"]', { visible: true, timeout: 30000 }).catch(() => {}),
            page.waitForFunction(() => {
              const text = (document.body.innerText || '').toLowerCase();
              return !text.includes('making sure') && !text.includes('type the characters');
            }, { timeout: 30000 }).catch(() => {}),
            this.sleep(20000)
          ]);
        } catch(e) {}
        
        await this.sleep(3000);
        
        // Check if we're still on captcha page (wrong solution → retry)
        const stillOnCaptcha = await page.evaluate(() => {
          const text = (document.body.innerText || '').toLowerCase();
          return text.includes('making sure') || text.includes('type the characters') || text.includes('verification check');
        });
        
        if (stillOnCaptcha) {
          this.log('warn', `Captcha chưa đúng hoặc cần giải lại (lần ${captchaAttempt + 1})`);
          // Continue loop to retry
        } else {
          this.log('success', 'Đã vượt qua captcha!');
          // Wait a bit more for the result page to fully load
          await this.sleep(3000);
          break;
        }
      }

      // Step 7: Determine result — LIVE vs DEAD vs UNKNOWN
      // CRITICAL: We must distinguish between:
      // - Root user password page (LIVE) — has password field BUT no #account/#username
      // - IAM sign-in page (still on initial page) — has #account, #username, #password
      // - Error page (DEAD) — has error message text
      const result = await page.evaluate(() => {
        const text = (document.body.innerText || '').toLowerCase();
        const url = window.location.href.toLowerCase();
        
        // ═══ Check if still on IAM form (should NOT happen, but safety) ═══
        const hasIAMAccount = !!(document.querySelector('#account'));
        const hasIAMUsername = !!(document.querySelector('#username'));
        const isStillIAMForm = hasIAMAccount && hasIAMUsername;
        
        // If we're still on IAM form, it means the switch didn't work
        if (isStillIAMForm && !text.includes('enter the password for')) {
          return { exists: null, reason: 'Still on IAM form (switch to root failed)' };
        }

        // ═══ 1. LIVE: Root user password prompt ═══
        // The Root user password page shows:
        // - "Enter the password for [email]" text
        // - A password input field
        // - NO #account or #username fields (those are IAM only)
        // - May show "Forgot password?" link
        const pwInputs = Array.from(document.querySelectorAll('input[type="password"]'));
        const visiblePw = pwInputs.filter(i => i.offsetParent !== null);
        
        // Best signal: "Enter the password for" text + visible password field
        if (text.includes('enter the password for') && visiblePw.length > 0) {
          return { exists: true, reason: 'Password prompt (enter the password for...)' };
        }
        
        // Secondary signal: Password field visible + Root user context (no IAM fields)
        if (visiblePw.length > 0 && !isStillIAMForm) {
          // Make sure it's a root user password page, not IAM
          const isRootPasswordPage = (
            text.includes('forgot password') || 
            text.includes('root user sign in') ||
            text.includes('root user') ||
            // Check if the visible password field is NOT the IAM #password field
            visiblePw.every(pw => pw.id !== 'password')
          );
          if (isRootPasswordPage && !text.includes('iam user sign in')) {
            return { exists: true, reason: 'Password field visible (root user page)' };
          }
        }
        
        // MFA = LIVE (only reached after successful email verification)
        if (text.includes('multi-factor') || text.includes('authenticator app') || text.includes('mfa')) {
          return { exists: true, reason: 'MFA verification page' };
        }

        // ═══ 2. DEAD: Error messages ═══
        const deadPatterns = [
          'there is no account associated',
          'does not exist',
          'sign-in information does not exist',
          'try again or create a new account',
          'no aws account found',
          'account not found',
          'an aws account with that sign-in information does not exist',
        ];
        const matchedDead = deadPatterns.find(p => text.includes(p));
        
        if (matchedDead) {
          return { exists: false, reason: matchedDead };
        }
        
        // Check alert elements for error messages
        const alertEls = document.querySelectorAll('[role="alert"], [class*="awsui-alert"], [class*="error"], [class*="Error"]');
        for (const el of alertEls) {
          const t = (el.textContent || '').toLowerCase();
          if (t.includes('does not exist') || t.includes('try again or create') || t.includes('no account') || t.includes('there is no account')) {
            return { exists: false, reason: el.textContent.trim().substring(0, 200) };
          }
        }

        // ═══ 3. Still on input page or captcha ═══
        if (text.includes('making sure') || text.includes('type the characters')) {
          return { exists: null, reason: 'Still on captcha page' };
        }
        
        // Check if still on the Root user email entry page
        const hasResolvingInput = !!document.querySelector('#resolving_input');
        if (hasResolvingInput) {
          return { exists: null, reason: 'Still on root user email entry page' };
        }
        
        // Check if on initial sign-in selection page
        if (text.includes('root user') && text.includes('iam user') && text.includes('email address')) {
          return { exists: null, reason: 'Still on sign-in selection page' };
        }

        return { exists: null, reason: `Unknown state. URL: ${url.substring(0, 100)}` };
      });

      if (result.exists === true) {
        this.log('success', `✓ LIVE: ${email} (${result.reason})`);
        return { email, status: 'live', reason: result.reason };
      } else if (result.exists === false) {
        this.log('info', `✗ DEAD: ${email} (${result.reason})`);
        return { email, status: 'dead', reason: result.reason };
      } else {
        this.log('warn', `? UNKNOWN: ${email} - ${result.reason}`);
        return { email, status: 'error', reason: result.reason };
      }

    } catch (err) {
      this.log('error', `Lỗi: ${email}: ${err.message}`);
      return { email, status: 'error', reason: err.message };
    } finally {
      if (page) try { await page.close(); } catch(e) {}
    }
  }

  /**
   * Worker loop: processes a queue of emails using a specific ProxySlot.
   * Each worker has its own proxy (from its API key), runs sequentially.
   * 
   * Auto-retry: If a check returns 'error', retry up to MAX_RETRIES times
   * with proxy re-verification. This ensures results are only Live or Dead.
   * 
   * Pre-rotation pause: If proxy is about to expire (< 30s remaining),
   * we pause and wait for rotation + verification before starting the next check.
   */
  async workerLoop(slot, emails) {
    const keyLabel = `Key #${slot.keyIndex + 1}`;
    this.log('info', `[${keyLabel}] Worker bắt đầu với ${emails.length} email(s)`);

    const PAUSE_BUFFER_SEC = 30;
    const MAX_RETRIES = 5;
    const MAX_ROUNDS = 10;

    let currentQueue = [...emails];
    let round = 0;

    while (currentQueue.length > 0 && round < MAX_ROUNDS && this.running) {
      round++;
      if (round > 1) {
        this.log('info', `[${keyLabel}] ═══ Retry round ${round}/${MAX_ROUNDS} — ${currentQueue.length} email(s) cần thử lại ═══`);
        await this.sleep(15000);
        slot.cachedProxyTime = 0;
      }
      const retryQueue = [];

    for (const email of currentQueue) {
      if (!this.running) break;

      let finalResult = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (!this.running) break;
        let browser = null;
        try {
          // ═══ Pre-rotation pause ═══
          if (slot.cachedProxy && slot.cachedProxyTime > 0) {
            const now = Date.now();
            const elapsed = now - slot.cachedProxyTime;
            const remaining = Math.round((this.proxyRotateInterval - elapsed) / 1000);

            if (remaining > 0 && remaining <= PAUSE_BUFFER_SEC) {
              this.log('warn', `[${keyLabel}] ⏸ Proxy sắp hết hạn (còn ${remaining}s) — đợi đổi IP...`);
              await this.sleep((remaining + 2) * 1000);
            }
          }

          // Get proxy (cached or rotated+verified)
          const proxyConfig = await slot.getProxy();

          const launchArgs = [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
            '--disable-gpu', '--window-size=1366,768',
            '--disable-blink-features=AutomationControlled',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-hang-monitor',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
          ];
          if (proxyConfig) {
            launchArgs.push(`--proxy-server=${proxyConfig.server}`);
            if (attempt === 1 && round === 1) {
              this.log('info', `[${keyLabel}] Proxy: ${proxyConfig.server}`);
            }
          }

          browser = await puppeteer.launch({ 
            headless: 'new', 
            args: launchArgs, 
            defaultViewport: null,
            protocolTimeout: 180000,
          });

          const result = await this.checkEmail(email, browser, proxyConfig);

          if (result && (result.status === 'live' || result.status === 'dead')) {
            // ✅ Got definitive result — done with this email
            finalResult = result;
            break;
          }

          // Result is 'error' — will retry
          if (result) {
            this.log('warn', `[${keyLabel}] ⟳ ${email}: lỗi "${result.reason}" — retry ${attempt}/${MAX_RETRIES}`);
          }

        } catch (err) {
          this.log('warn', `[${keyLabel}] ⟳ ${email}: lỗi "${err.message}" — retry ${attempt}/${MAX_RETRIES}`);
        } finally {
          if (browser) try { await browser.close(); } catch(e) {}
        }

        // Before retry: verify proxy is still working, if not wait for new one
        if (attempt < MAX_RETRIES && this.running) {
          this.log('info', `[${keyLabel}] Kiểm tra proxy trước retry...`);
          // Force proxy re-check: invalidate cache to trigger fresh verification
          slot.cachedProxyTime = 0;
          await this.sleep(3000);
        }
      }

      // Record the result
      if (finalResult) {
        if (this.results[finalResult.status]) this.results[finalResult.status].push(finalResult);
        this.checked++;
        if (this.onResult) this.onResult(finalResult);
      } else {
        // All retries exhausted this round — queue for next round
        retryQueue.push(email);
        this.log('warn', `[${keyLabel}] ${email}: chưa xác minh — sẽ thử lại`);
      }

      if (this.onProgress) this.onProgress({
        checked: this.checked, total: this.emails.length,
        live: this.results.live.length, dead: this.results.dead.length, error: this.results.error.length
      });

      if (this.running) {
        await this.sleep(this.delay);
      }
    }

    currentQueue = retryQueue;
    }

    // Remaining unresolved emails after all rounds → DEAD
    for (const email of currentQueue) {
      if (!this.running) break;
      this.checked++;
      const deadResult = { email, status: 'dead', reason: `Không thể xác minh sau ${MAX_ROUNDS} rounds` };
      this.results.dead.push(deadResult);
      if (this.onResult) this.onResult(deadResult);
      this.log('warn', `[${keyLabel}] ${email}: không thể xác minh → DEAD`);
      if (this.onProgress) this.onProgress({
        checked: this.checked, total: this.emails.length,
        live: this.results.live.length, dead: this.results.dead.length, error: this.results.error.length
      });
    }

    this.log('info', `[${keyLabel}] Worker hoàn thành`);
  }

  /**
   * Worker loop for static proxy list (no TMProxy).
   * Same auto-retry logic as workerLoop.
   */
  async workerLoopStatic(emails) {
    this.log('info', `Worker (static proxy) bắt đầu với ${emails.length} email(s)`);
    const MAX_RETRIES = 5;
    const MAX_ROUNDS = 10;

    let currentQueue = [...emails];
    let round = 0;

    while (currentQueue.length > 0 && round < MAX_ROUNDS && this.running) {
      round++;
      if (round > 1) {
        this.log('info', `═══ Retry round ${round}/${MAX_ROUNDS} — ${currentQueue.length} email(s) cần thử lại ═══`);
        await this.sleep(15000);
      }
      const retryQueue = [];

    for (const email of currentQueue) {
      if (!this.running) break;

      let finalResult = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (!this.running) break;
        let browser = null;
        try {
          const proxyStr = this.getProxy();
          const proxyConfig = this.parseProxy(proxyStr);

          const launchArgs = [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
            '--disable-gpu', '--window-size=1366,768',
            '--disable-blink-features=AutomationControlled',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-hang-monitor',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
          ];
          if (proxyConfig) {
            launchArgs.push(`--proxy-server=${proxyConfig.server}`);
            if (attempt === 1 && round === 1) this.log('info', `Proxy: ${proxyConfig.server}`);
          }

          browser = await puppeteer.launch({ 
            headless: 'new', 
            args: launchArgs, 
            defaultViewport: null,
            protocolTimeout: 180000,
          });
          const result = await this.checkEmail(email, browser, proxyConfig);

          if (result && (result.status === 'live' || result.status === 'dead')) {
            finalResult = result;
            break;
          }

          if (result) {
            this.log('warn', `⟳ ${email}: lỗi "${result.reason}" — retry ${attempt}/${MAX_RETRIES}`);
          }
        } catch (err) {
          this.log('warn', `⟳ ${email}: lỗi "${err.message}" — retry ${attempt}/${MAX_RETRIES}`);
        } finally {
          if (browser) try { await browser.close(); } catch(e) {}
        }

        if (attempt < MAX_RETRIES && this.running) {
          await this.sleep(3000);
        }
      }

      if (finalResult) {
        if (this.results[finalResult.status]) this.results[finalResult.status].push(finalResult);
        this.checked++;
        if (this.onResult) this.onResult(finalResult);
      } else {
        retryQueue.push(email);
        this.log('warn', `${email}: chưa xác minh — sẽ thử lại`);
      }

      if (this.onProgress) this.onProgress({
        checked: this.checked, total: this.emails.length,
        live: this.results.live.length, dead: this.results.dead.length, error: this.results.error.length
      });

      if (this.running) {
        await this.sleep(this.delay);
      }
    }

    currentQueue = retryQueue;
    }

    // Remaining unresolved → DEAD
    for (const email of currentQueue) {
      if (!this.running) break;
      this.checked++;
      const deadResult = { email, status: 'dead', reason: `Không thể xác minh sau ${MAX_ROUNDS} rounds` };
      this.results.dead.push(deadResult);
      if (this.onResult) this.onResult(deadResult);
      this.log('warn', `${email}: không thể xác minh → DEAD`);
      if (this.onProgress) this.onProgress({
        checked: this.checked, total: this.emails.length,
        live: this.results.live.length, dead: this.results.dead.length, error: this.results.error.length
      });
    }

    this.log('info', `Worker (static) hoàn thành`);
  }

  async start() {
    this.running = true;
    this.checked = 0;
    this.results = { live: [], dead: [], error: [] };

    const proxyS = this.proxyRotateInterval / 1000;
    this.log('info', `Bắt đầu kiểm tra ${this.emails.length} email(s)...`);

    if (this.tmproxyKeys.length > 0) {
      // ═══ TMProxy mode: 1 API key = 1 thread ═══
      const slots = this.tmproxyKeys.map((key, i) => new ProxySlot(key, i, this));
      const threadCount = slots.length;

      this.log('info', `Threads: ${threadCount} (= ${threadCount} API key${threadCount > 1 ? 's' : ''}) | Delay: ${this.delay}ms`);
      this.log('info', `⟳ Đổi Proxy IP: mỗi ${proxyS}s (${proxyS / 60} phút) | Mỗi key giữ proxy riêng`);

      // Distribute emails round-robin across slots
      const emailQueues = Array.from({ length: threadCount }, () => []);
      this.emails.forEach((email, i) => emailQueues[i % threadCount].push(email));

      // Log distribution
      emailQueues.forEach((q, i) => {
        this.log('info', `[Key #${i + 1}] ...${this.tmproxyKeys[i].slice(-8)} → ${q.length} email(s)`);
      });

      // Run all workers in parallel
      await Promise.all(slots.map((slot, idx) => this.workerLoop(slot, emailQueues[idx])));
    } else {
      // ═══ Static proxy mode: use threads setting ═══
      const threadCount = this.threads;
      this.log('info', `Threads: ${threadCount} | Delay: ${this.delay}ms | Proxies: ${this.proxies.length}`);

      if (threadCount <= 1) {
        // Single thread
        await this.workerLoopStatic(this.emails);
      } else {
        // Multiple threads with static proxies
        const emailQueues = Array.from({ length: threadCount }, () => []);
        this.emails.forEach((email, i) => emailQueues[i % threadCount].push(email));
        await Promise.all(emailQueues.map(q => this.workerLoopStatic(q)));
      }
    }

    this.running = false;
    const summary = {
      total: this.emails.length, checked: this.checked,
      live: this.results.live.length, dead: this.results.dead.length, error: this.results.error.length,
      results: this.results
    };
    this.log('info', `═══ KẾT QUẢ ═══`);
    this.log('success', `Live: ${summary.live}`);
    this.log('info', `Dead: ${summary.dead}`);
    this.log('warn', `Error: ${summary.error}`);
    if (this.onComplete) this.onComplete(summary);
    return summary;
  }

  sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}

module.exports = { AWSChecker };
