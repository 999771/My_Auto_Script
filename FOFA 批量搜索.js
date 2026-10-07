// ==UserScript==
// @name         FOFA 批量搜索
// @namespace    https://github.com/fofa-batch-extractor
// @version      2.3.0
// @description  批量提取 ip:port、ASN 列表导入、提取数据上传到GitHub 仓库
// @author       fofa-helper
// @match        https://fofa.info/*
// @match        https://*.fofa.info/*
// @match        https://fofa.com/*
// @match        https://*.fofa.com/*
// @match        https://fofa.so/*
// @match        https://*.fofa.so/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      ip.cwo.de5.net
// @connect      api.github.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 常量与配置 ====================
  const ASN_URL_DEFAULT = '*****';  //网络搜索
  const KEYS = {
    batch: 'fofa_batch_state_v1',
    results: 'fofa_batch_results_v1',
    config: 'fofa_config_v1'
  };
  const RESULT_WAIT_MAX_MS = 30000;  // 单次等待结果加载的最长时间
  const RESULT_STABLE_CHECKS = 1;    // 连续多少次结果数不变视为加载完成（1=检测到即提取）
  const POLL_INTERVAL_MS = 300;      // 轮询间隔（毫秒），缩短以加速检测
  const POLL_INITIAL_DELAY_MS = 500; // 首次检测延迟（毫秒），缩短以加速检测

  // ===== 内存优化相关常量 =====
  const DEBUG = false;                       // 调试日志开关；生产环境关闭可大幅降低浏览器 DevTools 内存
  const RESULTS_FLUSH_EVERY = 5;             // 每提取 N 个 ASN 才把内存结果回写一次 GM 存储（暂停/停止/完成时也会回写）
  const TEXTAREA_MAX_CHARS = 200000;         // textarea 显示文本的最大字符数，超过则只显示尾部（避免浏览器为巨长字符串分配渲染内存）

  // 轻量级日志函数：DEBUG=false 时直接 no-op，避免 console 历史堆积占用内存
  function log() { if (DEBUG) console.log.apply(console, arguments); }
  function logWarn() { if (DEBUG) console.warn.apply(console, arguments); }
  function logErr() { if (DEBUG) console.error.apply(console, arguments); }

  // ==================== 工具函数 ====================

  // 将查询语句编码为 FOFA URL 所需的 qbase64 参数
  function encodeQuery(query) {
    const utf8Bytes = new TextEncoder().encode(query);
    let binary = '';
    utf8Bytes.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // 解析 ASN2.txt 文本，返回 [{asn, remark}, ...]
  function parseASNList(text) {
    const lines = (text || '').split(/\r?\n/);
    const result = [];
    const seen = new Set();
    for (let raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;

      let parts;
      if (line.includes('\t')) {
        parts = line.split('\t');
      } else if (line.includes('|')) {
        parts = line.split('|');
      } else if (/^(?:AS)?\d+\s*,/.test(line)) {
        parts = line.split(',');
      } else {
        const m = line.match(/^((?:AS)?\d+)\s*(.*)$/);
        if (m) {
          parts = [m[1], m[2]];
        } else {
          continue;
        }
      }

      let asn = (parts[0] || '').trim().replace(/^AS/i, '').replace(/[^0-9].*$/, '');
      let remark = parts.slice(1).join(' ').trim().replace(/^["'\s,|]+|["'\s,|]+$/g, '');

      if (asn && /^\d+$/.test(asn) && !seen.has(asn)) {
        seen.add(asn);
        result.push({ asn, remark: remark || '' });
      }
    }
    return result;
  }

  function replaceASNInSyntax(syntax, newASN) {
    const hasASN = /asn\s*=\s*"?(\d+)"?/i.test(syntax);
    if (hasASN) {
      return syntax.replace(/asn\s*=\s*"?(\d+)"?/gi, `asn="${newASN}"`);
    }
    const trimmed = (syntax || '').trim();
    if (!trimmed) return `asn="${newASN}"`;
    if (/\s*(&&|\|\|)\s*$/.test(trimmed)) {
      return trimmed + ` asn="${newASN}"`;
    }
    return trimmed + ' && ' + `asn="${newASN}"`;
  }

  // ==================== FOFA 搜索框交互 ====================
  function findFOFASearchTextarea() {
    const selectors = [
      '[data-testid="result-search-input-textarea"]',
      '.fofa-search-input-textarea textarea',
      '.fofa-search-input-container textarea',
      '.header-search textarea.el-textarea__inner',
      'textarea[placeholder="Search..."]',
      'textarea[placeholder*="搜索"]'
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (el && el.offsetParent !== null && !el.readOnly && !el.disabled) {
          const batchPane = el.closest('#pane-batch-search, .batch-search-dialog, [aria-labelledby="tab-batch-search"]');
          if (batchPane) continue;
          return el;
        }
      }
    }
    const allTextareas = document.querySelectorAll('textarea');
    let best = null, bestArea = 0;
    for (const ta of allTextareas) {
      if (ta.offsetParent === null || ta.readOnly || ta.disabled) continue;
      const batchPane = ta.closest('#pane-batch-search, .batch-search-dialog, [aria-labelledby="tab-batch-search"]');
      if (batchPane) continue;
      if (ta.closest('#fbp-panel')) continue;
      const rect = ta.getBoundingClientRect();
      if (rect.top > 200) continue;
      const area = rect.width * rect.height;
      if (area > bestArea) { bestArea = area; best = ta; }
    }
    return best;
  }

  function findFOFASearchSubmitButton() {
    const selectors = [
      '[data-testid="result-search-submit"] button',
      '[data-testid="result-search-submit"]',
      '.fofa-search-input-container .icon-search',
      '.header-search .icon-search'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        if (el.tagName === 'I') {
          const btn = el.closest('button');
          if (btn) return btn;
        }
        return el;
      }
    }
    return null;
  }

  function setSearchTextareaValue(textarea, value) {
    textarea.focus();
    try {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      if (nativeSetter) {
        nativeSetter.call(textarea, value);
      } else {
        textarea.value = value;
      }
    } catch (e) {
      textarea.value = value;
    }
    try {
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    } catch (e) {
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEnterOn(el) {
    el.focus();
    const events = ['keydown', 'keypress', 'keyup'];
    events.forEach(type => {
      let event;
      try {
        event = new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          charCode: 0,
          bubbles: true,
          cancelable: true
        });
      } catch (e) {
        event = new Event(type, { bubbles: true, cancelable: true });
      }
      try {
        Object.defineProperty(event, 'keyCode', { get: () => 13, configurable: true });
        Object.defineProperty(event, 'which', { get: () => 13, configurable: true });
      } catch (e) { /* 忽略 */ }
      el.dispatchEvent(event);
    });
  }

  function triggerSearchViaInputBox(query) {
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 15;
      const tryFind = () => {
        attempts++;
        log(`[FBP] triggerSearchViaInputBox: attempt ${attempts}/${maxAttempts}`);
        const textarea = findFOFASearchTextarea();
        if (textarea) {
          let valueSet = false;
          try {
            setSearchTextareaValue(textarea, query);
            valueSet = true;
          } catch (e) {
            logErr('[FBP] setSearchTextareaValue failed:', e);
          }
          setTimeout(() => {
            let triggered = false;
            try {
              const btn = findFOFASearchSubmitButton();
              if (btn) {
                textarea.focus();
                btn.click();
                triggered = true;
                log('[FBP] Submit button clicked');
              } else {
                log('[FBP] No submit button found, will try Enter key');
              }
            } catch (e) {
              logWarn('[FBP] Button click failed:', e);
            }
            if (!triggered) {
              try {
                pressEnterOn(textarea);
                triggered = true;
                log('[FBP] Enter key dispatched');
              } catch (e) {
                logWarn('[FBP] Enter key failed:', e);
              }
            }
            resolve(valueSet || triggered);
          }, 500);
          return;
        }
        if (attempts < maxAttempts) {
          setTimeout(tryFind, 200);
        } else {
          logErr('[FBP] Textarea not found after all attempts');
          resolve(false);
        }
      };
      tryFind();
    });
  }

  // ==================== 日期解析与过滤 ====================
  function parseDatesFromText(text) {
    const results = [];
    const re = /(\d{4})[-\/年.](\d{1,2})[-\/月.](\d{1,2})日?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const d = parseInt(m[3], 10);
      if (y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        results.push(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
      }
    }
    return results;
  }

  function compareDateStr(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function isDateInRange(dateStr, after, before) {
    if (!dateStr) return false;
    if (after && compareDateStr(dateStr, after) < 0) return false;
    if (before && compareDateStr(dateStr, before) > 0) return false;
    return true;
  }

  function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function computeDateFilter(range, customAfter, customBefore) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let after = null, before = null;
    switch (range) {
      case 'today':
        after = today; before = today; break;
      case '1d':
        after = new Date(today.getTime() - 1 * 86400000); before = today; break;
      case '7d':
        after = new Date(today.getTime() - 7 * 86400000); before = today; break;
      case '30d':
        after = new Date(today.getTime() - 30 * 86400000); before = today; break;
      case '90d':
        after = new Date(today.getTime() - 90 * 86400000); before = today; break;
      case '180d':
        after = new Date(today.getTime() - 180 * 86400000); before = today; break;
      case '365d':
        after = new Date(today.getTime() - 365 * 86400000); before = today; break;
      case 'custom':
        if (customAfter) after = new Date(customAfter + 'T00:00:00');
        if (customBefore) before = new Date(customBefore + 'T00:00:00');
        break;
      case 'none':
      default:
        return null;
    }
    const result = {};
    if (after && !isNaN(after.getTime())) result.after = formatDate(after);
    if (before && !isNaN(before.getTime())) result.before = formatDate(before);
    return result;
  }

  // ==================== ip:port 提取与过滤 ====================
  function isValidIpPort(ip, port) {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return false;
      const n = parseInt(p, 10);
      if (n < 0 || n > 255) return false;
    }
    if (!/^\d+$/.test(port)) return false;
    const portNum = parseInt(port, 10);
    return portNum > 0 && portNum <= 65535;
  }

  function isPrivateIP(ip) {
    const parts = ip.split('.').map(p => parseInt(p, 10));
    if (parts.length !== 4 || parts.some(n => isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 0) return true;
    if (a >= 224) return true;
    return false;
  }

  function extractIpPortFromHref(href) {
    if (!href) return null;
    const m = href.match(/^https?:\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d{2,5}))?(?:\/|$)/);
    if (!m) return null;
    const ip = m[1];
    let port = m[2];
    if (!port) {
      port = href.toLowerCase().startsWith('https://') ? '443' : '80';
    }
    if (!isValidIpPort(ip, port)) return null;
    return { ip, port, ipPort: `${ip}:${port}` };
  }

  function extractIpPortFromText(text) {
    const set = new Set();
    const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (isValidIpPort(m[1], m[2])) {
        set.add(`${m[1]}:${m[2]}`);
      }
    }
    return set;
  }

  function findResultItemContainers() {
    const selectors = [
      'tr.el-table__row',
      '.el-table__body-wrapper tbody tr',
      '.hsxa-table .el-table__row',
      '.hsxa-meta-data-list-item',
      '[class*="meta-data-list-item"]',
      '[class*="result-item"]',
      '.el-card'
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        const first = els[0];
        const ipLink = first.querySelector('a[href^="http://"], a[href^="https://"]');
        if (ipLink) {
          const href = ipLink.getAttribute('href') || '';
          if (/^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(href)) {
            return Array.from(els);
          }
        }
        const text = first.textContent || '';
        if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(text)) {
          return Array.from(els);
        }
      }
    }
    return [];
  }

  function extractFromResultItem(container, excludePrivate) {
    const links = container.querySelectorAll('a[href]');
    const ipPortSet = new Set();
    links.forEach(a => {
      const href = a.getAttribute('href') || '';
      const extracted = extractIpPortFromHref(href);
      if (extracted) {
        if (excludePrivate && isPrivateIP(extracted.ip)) return;
        ipPortSet.add(extracted.ipPort);
      }
    });
    if (ipPortSet.size === 0) {
      const text = container.textContent || '';
      extractIpPortFromText(text).forEach(v => {
        const ip = v.split(':')[0];
        if (excludePrivate && isPrivateIP(ip)) return;
        ipPortSet.add(v);
      });
    }
    const ipPorts = Array.from(ipPortSet);
    if (ipPorts.length === 0) return null;
    let date = null;
    const dateSpan = container.querySelector('span.mr18px');
    if (dateSpan) {
      const text = dateSpan.textContent || '';
      const m = text.match(/(\d{4}-\d{2}-\d{2})/);
      if (m) date = m[1];
    }
    if (!date) {
      const text = container.textContent || '';
      const dates = parseDatesFromText(text);
      if (dates.length > 0) date = dates[0];
    }
    return { ipPort: ipPorts[0], date: date, allIpPorts: ipPorts };
  }

  function extractResultsFromPage(dateFilter, excludePrivate) {
    const stats = { total: 0, kept: 0, noDate: 0, outOfRange: 0, privateExcluded: 0 };
    const kept = new Set();
    const containers = findResultItemContainers();
    if (containers.length > 0) {
      for (const c of containers) {
        const item = extractFromResultItem(c, excludePrivate);
        if (!item) continue;
        stats.total++;
        if (!dateFilter) {
          if (!kept.has(item.ipPort)) { kept.add(item.ipPort); stats.kept++; }
          continue;
        }
        if (!item.date) {
          stats.noDate++;
          continue;
        }
        if (!isDateInRange(item.date, dateFilter.after, dateFilter.before)) {
          stats.outOfRange++;
          continue;
        }
        if (!kept.has(item.ipPort)) { kept.add(item.ipPort); stats.kept++; }
      }
      log('[FBP] extractResultsFromPage:', containers.length, 'rows ->', stats);
      return { results: Array.from(kept), stats };
    }
    const containerSelectors = [
      '.el-table__body-wrapper',
      '.hsxa-meta-data-list',
      '.hsxa_search_result_container',
      '[class*="meta-data-list"]',
      '[class*="result-list"]',
      '[class*="search-result"]'
    ];
    let container = null;
    for (const sel of containerSelectors) {
      container = document.querySelector(sel);
      if (container) break;
    }
    container = container || document.body;
    const allText = container.textContent || '';
    let ipPorts = Array.from(extractIpPortFromText(allText));
    if (excludePrivate) {
      ipPorts = ipPorts.filter(v => {
        const ip = v.split(':')[0];
        if (isPrivateIP(ip)) {
          stats.privateExcluded++;
          return false;
        }
        return true;
      });
    }
    stats.total = ipPorts.length;
    if (dateFilter) {
      stats.noDate = ipPorts.length;
      return { results: [], stats };
    }
    ipPorts.forEach(ip => {
      if (!kept.has(ip)) { kept.add(ip); stats.kept++; }
    });
    return { results: Array.from(kept), stats };
  }

  function detectPageError() {
    if (/\/login/i.test(window.location.pathname) || /\/user\/login/i.test(window.location.pathname)) {
      return 'login_required';
    }
    const messageBoxes = document.querySelectorAll('.el-message-box');
    for (const box of messageBoxes) {
      if (box.offsetParent === null) continue;
      const text = (box.textContent || '').toLowerCase();
      if (text.includes('请先登录') || text.includes('please log in') || text.includes('login required')) {
        return 'login_required';
      }
    }
    const captchaSelectors = [
      '.nc-container', '.nc_wrapper', '.slider-container', '.captcha-container',
      '#captcha', '.JNAP_verify', '[class*="captcha-verif"]', '[class*="slider-verif"]', '.sufei-tcaptcha'
    ];
    for (const sel of captchaSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return 'captcha';
    }
    const errorMessages = document.querySelectorAll('.el-message--error, .el-notification');
    for (const msg of errorMessages) {
      if (msg.offsetParent === null) continue;
      const text = (msg.textContent || '').toLowerCase();
      if (text.includes('请求过于频繁') || text.includes('访问过于频繁') ||
          text.includes('rate limit') || text.includes('风控') ||
          text.includes('频率过快') || text.includes('操作太频繁')) {
        return 'rate_limited';
      }
    }
    return null;
  }

  function detectNoResult() {
    const navLeft = document.querySelector('.hsxa-meta-data-list-nav-left');
    if (navLeft) {
      const text = navLeft.textContent || '';
      const m = text.match(/([\d,]+)\s*条匹配结果/);
      if (m) {
        const num = parseInt(m[1].replace(/,/g, ''), 10);
        if (!isNaN(num) && num === 0) return true;
      }
    }
    const emptyText = document.querySelector('.el-table__empty-text, .el-table__empty-block');
    if (emptyText && emptyText.offsetParent !== null) {
      const text = (emptyText.textContent || '').toLowerCase();
      if (text.includes('无数据') || text.includes('no data') || text.includes('暂无数据') || text.includes('空')) {
        return true;
      }
    }
    return false;
  }

  function getResultCountFromPage() {
    const navLeft = document.querySelector('.hsxa-meta-data-list-nav-left');
    if (navLeft) {
      const text = navLeft.textContent || '';
      const m = text.match(/([\d,]+)\s*条匹配结果/);
      if (m) {
        const num = parseInt(m[1].replace(/,/g, ''), 10);
        if (!isNaN(num)) return num;
      }
    }
    return null;
  }

  function waitForResultsLoaded() {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let lastCount = -1;
      let stableCount = 0;
      const check = () => {
        const tableHeader = document.querySelector(
          '.el-table__header-wrapper .hsxa-table-header, ' +
          '.el-table__header-wrapper th, ' +
          '.el-table__header'
        );
        if (tableHeader) {
          if (detectNoResult()) {
            resolve({ ok: true, noResult: true });
            return;
          }
          const rows = document.querySelectorAll('tr.el-table__row');
          if (rows.length > 0) {
            const ipLinks = document.querySelectorAll(
              'tr.el-table__row a[href^="http"], tr.el-table__row a[href^="https"]'
            );
            if (ipLinks.length > 0) {
              let hasIp = false;
              for (const link of ipLinks) {
                const href = link.getAttribute('href') || '';
                if (/^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(href)) {
                  hasIp = true;
                  break;
                }
              }
              if (hasIp) {
                resolve({ ok: true, noResult: false });
                return;
              }
            }
            if (rows.length === lastCount) {
              stableCount++;
              if (stableCount >= RESULT_STABLE_CHECKS) {
                resolve({ ok: true, noResult: false });
                return;
              }
            } else {
              stableCount = 0;
              lastCount = rows.length;
            }
          }
        } else {
          const err = detectPageError();
          if (err) {
            resolve({ ok: false, error: err });
            return;
          }
          if (detectNoResult()) {
            resolve({ ok: true, noResult: true });
            return;
          }
        }
        if (Date.now() - startTime > RESULT_WAIT_MAX_MS) {
          resolve({ ok: true, noResult: false, timeout: true });
          return;
        }
        setTimeout(check, POLL_INTERVAL_MS);
      };
      setTimeout(check, POLL_INITIAL_DELAY_MS);
    });
  }

  // ==================== 状态管理 ====================
  let resultsCount = 0;
  let resultsTextLoaded = null;
  let resultsDirty = false;
  let asnProcessedSinceFlush = 0;

  function getResultsCache() {
    if (resultsCount === 0 && resultsTextLoaded === null) {
      try {
        const text = GM_getValue(KEYS.results, '');
        resultsCount = text ? text.split('\n').filter(l => l.trim()).length : 0;
      } catch (e) {
        resultsCount = 0;
      }
      resultsTextLoaded = '';
    }
    return resultsCount;
  }

  function appendResults(newResults) {
    if (newResults.length === 0) return 0;
    let existingText = '';
    try {
      existingText = GM_getValue(KEYS.results, '') || '';
    } catch (e) {
      existingText = '';
    }
    const newBlock = newResults.join('\n');
    const separator = (existingText && !existingText.endsWith('\n')) ? '\n' : '';
    const mergedText = existingText + separator + newBlock;
    GM_setValue(KEYS.results, mergedText);
    resultsCount += newResults.length;
    resultsDirty = true;
    asnProcessedSinceFlush++;
    return newResults.length;
  }

  function flushResults(force) {
    if (!resultsDirty && !force) return;
    resultsDirty = false;
    asnProcessedSinceFlush = 0;
  }

  function loadBatchState() {
    try {
      return JSON.parse(GM_getValue(KEYS.batch, 'null')) || null;
    } catch (e) { return null; }
  }

  function saveBatchState(state) {
    const cfg = loadConfig();
    const slimState = Object.assign({}, state);
    if (slimState.asnList && cfg.savedAsnList && slimState.asnList.length === cfg.savedAsnList.length) {
      slimState.asnListRef = 'cfg';
      delete slimState.asnList;
    }
    GM_setValue(KEYS.batch, JSON.stringify(slimState));
  }

  function loadBatchStateWithAsnList() {
    const state = loadBatchState();
    if (!state) return state;
    if (state.asnListRef === 'cfg' && !state.asnList) {
      const cfg = loadConfig();
      state.asnList = cfg.savedAsnList || [];
      delete state.asnListRef;
    }
    return state;
  }

  function clearBatchState() {
    GM_deleteValue(KEYS.batch);
  }

  function loadResults() {
    try {
      const text = GM_getValue(KEYS.results, '') || '';
      return text ? text.split('\n').filter(l => l.trim()) : [];
    } catch (e) {
      return [];
    }
  }

  function saveResults(arr) {
    GM_setValue(KEYS.results, arr.join('\n'));
    resultsCount = arr.length;
    resultsDirty = true;
  }

  function mergeResults(newResults) {
    return appendResults(newResults);
  }

  function clearResults() {
    resultsCount = 0;
    resultsTextLoaded = '';
    resultsDirty = false;
    asnProcessedSinceFlush = 0;
    GM_deleteValue(KEYS.results);
  }

  function loadConfig() {
    try {
      return JSON.parse(GM_getValue(KEYS.config, '{}')) || {};
    } catch (e) { return {}; }
  }

  function saveConfig(cfg) {
    GM_setValue(KEYS.config, JSON.stringify(cfg));
  }

  // ==================== UI ====================
  const CSS = `
    #fbp-panel { position: fixed; top: 80px; right: 20px; width: 380px; max-height: 82vh; background: #1e2533; border: 1px solid #3a4252; border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); z-index: 2147483647; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 13px; color: #e4e7ed; display: flex; flex-direction: column; overflow: hidden; }
    #fbp-panel * { box-sizing: border-box; }
    #fbp-panel .fbp-header { background: linear-gradient(135deg, #2a3344, #324054); padding: 10px 14px; cursor: move; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #3a4252; user-select: none; }
    #fbp-panel .fbp-title { font-weight: 600; font-size: 14px; color: #4fc3f7; display: flex; align-items: center; gap: 6px; }
    #fbp-panel .fbp-title::before { content: ''; display: inline-block; width: 8px; height: 8px; background: #67c23a; border-radius: 50%; box-shadow: 0 0 8px #67c23a; }
    #fbp-panel .fbp-header-actions { display: flex; gap: 6px; }
    #fbp-panel .fbp-icon-btn { background: transparent; border: none; color: #909399; cursor: pointer; padding: 2px 6px; font-size: 16px; line-height: 1; border-radius: 4px; }
    #fbp-panel .fbp-icon-btn:hover { background: #3a4252; color: #e4e7ed; }
    #fbp-panel .fbp-body { padding: 12px 14px; overflow-y: auto; flex: 1; }
    #fbp-panel.collapsed .fbp-body { display: none; }
    #fbp-panel .fbp-section { margin-bottom: 14px; }
    #fbp-panel .fbp-section:last-child { margin-bottom: 0; }
    #fbp-panel .fbp-label { display: block; margin-bottom: 5px; font-size: 12px; color: #909399; font-weight: 500; }
    #fbp-panel input[type="text"], #fbp-panel input[type="number"], #fbp-panel input[type="password"], #fbp-panel textarea, #fbp-panel select { width: 100%; background: #2a3344; border: 1px solid #3a4252; border-radius: 5px; padding: 7px 9px; color: #e4e7ed; font-size: 13px; }
    #fbp-panel input:focus, #fbp-panel textarea:focus, #fbp-panel select:focus { outline: none; border-color: #4fc3f7; }
    #fbp-panel textarea { resize: vertical; font-family: "SF Mono", Monaco, Consolas, "Liberation Mono", monospace; min-height: 60px; }
    #fbp-panel select { cursor: pointer; }
    #fbp-panel .fbp-btn { background: #4fc3f7; color: #0d1421; border: none; border-radius: 5px; padding: 7px 12px; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.15s; }
    #fbp-panel .fbp-btn:hover { background: #29b6f6; transform: translateY(-1px); }
    #fbp-panel .fbp-btn:active { transform: translateY(0); }
    #fbp-panel .fbp-btn:disabled { background: #3a4252; color: #606266; cursor: not-allowed; transform: none; }
    #fbp-panel .fbp-btn-secondary { background: #3a4252; color: #e4e7ed; }
    #fbp-panel .fbp-btn-secondary:hover { background: #4a5262; }
    #fbp-panel .fbp-btn-danger { background: #f56c6c; color: #fff; }
    #fbp-panel .fbp-btn-danger:hover { background: #e45555; }
    #fbp-panel .fbp-btn-success { background: #67c23a; color: #fff; }
    #fbp-panel .fbp-btn-success:hover { background: #5daf34; }
    #fbp-panel .fbp-row { display: flex; gap: 8px; }
    #fbp-panel .fbp-row > * { flex: 1; }
    #fbp-panel .fbp-row > .fbp-btn-fixed { flex: 0 0 auto; }
    #fbp-panel .fbp-radio-group { display: flex; gap: 16px; margin-bottom: 8px; }
    #fbp-panel .fbp-radio { display: flex; align-items: center; gap: 5px; cursor: pointer; font-size: 13px; }
    #fbp-panel .fbp-radio input { accent-color: #4fc3f7; }
    #fbp-panel .fbp-status { background: #2a3344; border-radius: 5px; padding: 8px 10px; font-size: 12px; color: #c0c4cc; min-height: 36px; line-height: 1.5; border-left: 3px solid #4fc3f7; word-break: break-all; }
    #fbp-panel .fbp-status.error { border-left-color: #f56c6c; color: #f56c6c; }
    #fbp-panel .fbp-status.success { border-left-color: #67c23a; color: #67c23a; }
    #fbp-panel .fbp-status.warning { border-left-color: #e6a23c; color: #e6a23c; }
    #fbp-panel .fbp-progress { background: #2a3344; border-radius: 4px; height: 6px; overflow: hidden; margin: 6px 0 10px; }
    #fbp-panel .fbp-progress-bar { background: linear-gradient(90deg, #4fc3f7, #67c23a); height: 100%; transition: width 0.4s ease; width: 0%; }
    #fbp-panel .fbp-count { font-size: 12px; color: #909399; margin-bottom: 6px; display: flex; justify-content: space-between; }
    #fbp-panel .fbp-count strong { color: #67c23a; }
    .fbp-collapsed-fab { position: fixed; top: 80px; right: 20px; width: 48px; height: 48px; background: linear-gradient(135deg, #4fc3f7, #29b6f6); border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 2147483647; box-shadow: 0 6px 20px rgba(79, 195, 247, 0.5); font-size: 22px; color: #fff; font-weight: bold; transition: transform 0.2s; }
    .fbp-collapsed-fab:hover { transform: scale(1.1); }
    #fbp-panel .fbp-hint { font-size: 11px; color: #606266; margin-top: 4px; line-height: 1.4; }
    #fbp-panel .fbp-divider { height: 1px; background: #3a4252; margin: 10px 0; }
  `;

  function createPanelHTML() {
    const div = document.createElement('div');
    div.id = 'fbp-panel';
    div.innerHTML = `
      <div class="fbp-header" id="fbp-drag-handle">
        <div class="fbp-title">FOFA 批量提取器</div>
        <div class="fbp-header-actions">
          <button class="fbp-icon-btn" id="fbp-collapse-btn" title="折叠">—</button>
          <button class="fbp-icon-btn" id="fbp-close-btn" title="关闭">×</button>
        </div>
      </div>
      <div class="fbp-body">
        <div class="fbp-section">
          <label class="fbp-label">搜索语法（含 asn="xxx" 占位）</label>
          <textarea id="fbp-syntax" placeholder='server="cloudflare" && asn="8075" && port!="80"'></textarea>
        </div>

        <div class="fbp-section">
          <label class="fbp-label">ASN 来源</label>
          <div class="fbp-radio-group">
            <label class="fbp-radio"><input type="radio" name="fbp-source" value="manual" checked> 手动输入</label>
            <label class="fbp-radio"><input type="radio" name="fbp-source" value="url"> URL 导入</label>
          </div>
          <div id="fbp-manual-box">
            <textarea id="fbp-manual-asn" placeholder="每行一个 ASN，可带备注：&#10;AS8075 Cloudflare&#10;AS13335 Cloudflare CDN&#10;AS15169 Google"></textarea>
          </div>
          <div id="fbp-url-box" style="display:none;">
            <div class="fbp-row">
              <input type="text" id="fbp-url-input" value="${ASN_URL_DEFAULT}" placeholder="ASN 列表 URL">
              <button class="fbp-btn fbp-btn-secondary fbp-btn-fixed" id="fbp-import-btn">导入</button>
            </div>
            <div class="fbp-hint">支持格式：AS8075 Cloudflare / 8075|Cloudflare / 8075&#9;Cloudflare</div>
          </div>
        </div>

        <div class="fbp-section">
          <label class="fbp-label">ASN 列表</label>
          <input type="text" id="fbp-filter" placeholder="输入多个关键词用空格分隔，包含任一即选中...">
          <select id="fbp-asn-select" size="6" style="margin-top:6px; font-family: monospace;">
            <option value="">— 请先导入或输入 ASN —</option>
          </select>
          <div class="fbp-hint" id="fbp-asn-count">共 0 条 ASN</div>
        </div>

        <div class="fbp-section">
          <label class="fbp-label">搜索间隔（秒）</label>
          <input type="number" id="fbp-delay" value="5" min="0" max="120" step="1">
        </div>

        <div class="fbp-section">
          <label class="fbp-label">结果日期过滤</label>
          <div class="fbp-row">
            <select id="fbp-time-range" style="flex:1;">
              <option value="none">不限制</option>
              <option value="today">今天</option>
              <option value="1d">最近 1 天</option>
              <option value="7d">最近 7 天</option>
              <option value="30d">最近 30 天</option>
              <option value="90d">最近 90 天</option>
              <option value="180d">最近半年</option>
              <option value="365d">最近一年</option>
              <option value="custom">自定义...</option>
            </select>
            <input type="date" id="fbp-date-after" style="flex:1; display:none;" title="起始日期（含）">
            <input type="date" id="fbp-date-before" style="flex:1; display:none;" title="结束日期（含）">
          </div>
        </div>

        <div class="fbp-section">
          <div class="fbp-row">
            <button class="fbp-btn fbp-btn-success" id="fbp-start-btn">开始批量</button>
            <button class="fbp-btn fbp-btn-danger" id="fbp-stop-btn" disabled>暂停</button>
          </div>
        </div>

        <div class="fbp-progress"><div class="fbp-progress-bar" id="fbp-progress-bar"></div></div>
        <div class="fbp-status" id="fbp-status">就绪。请配置语法与 ASN 后点击「开始批量」。</div>

        <div class="fbp-divider"></div>

        <div class="fbp-section">
          <div class="fbp-count">
            <span>已提取 ip:port：<strong id="fbp-result-count">0</strong></span>
            <span>当前 ASN：<strong id="fbp-current-asn" style="color:#4fc3f7;">—</strong></span>
          </div>
          <textarea id="fbp-results" readonly placeholder="提取结果将显示在这里..." style="min-height:100px; font-family: monospace;"></textarea>
          <div class="fbp-row" style="margin-top:6px;">
            <button class="fbp-btn" id="fbp-copy-btn">复制结果</button>
            <button class="fbp-btn fbp-btn-secondary" id="fbp-clear-btn">清空结果</button>
          </div>
        </div>

        <div class="fbp-divider"></div>

        <!-- GitHub 仓库上传区块（已移除 Gist） -->
        <div class="fbp-section">
          <label class="fbp-label">GitHub 仓库上传（覆盖写入）</label>
          <div class="fbp-row" style="margin-bottom:6px;">
            <input type="password" id="fbp-github-token" placeholder="GitHub Token (必填)" style="flex:2;">
          </div>
          <div class="fbp-row" style="margin-bottom:6px;">
            <input type="text" id="fbp-github-owner" placeholder="仓库所有者 (owner)" value="999771" style="flex:1;">
            <input type="text" id="fbp-github-repo" placeholder="仓库名 (repo)" value="ipcx" style="flex:1;">
          </div>
          <div class="fbp-row" style="margin-bottom:6px;">
            <input type="text" id="fbp-github-path" placeholder="文件路径 (如 raw.txt)" value="raw.txt" style="flex:2;">
            <input type="text" id="fbp-github-branch" placeholder="分支 (默认 main)" value="main" style="flex:1;">
          </div>
          <div class="fbp-row" style="margin-bottom:6px;">
            <input type="text" id="fbp-github-commit-msg" placeholder="提交信息" value="Update fofa results" style="flex:2;">
            <button class="fbp-btn fbp-btn-secondary fbp-btn-fixed" id="fbp-upload-btn" disabled>上传</button>
          </div>
          <div class="fbp-hint" id="fbp-upload-status">配置 Token 后可上传全部提取结果，将覆盖目标文件。</div>
        </div>
      </div>
    `;
    return div;
  }

  function createCollapsedFab() {
    const fab = document.createElement('div');
    fab.id = 'fbp-fab';
    fab.className = 'fbp-collapsed-fab';
    fab.innerHTML = 'F';
    fab.title = '展开 FOFA 批量提取器';
    fab.style.display = 'none';
    return fab;
  }

  // ==================== 主控制器 ====================
  let panelEl = null;
  let fabEl = null;
  let asnList = [];
  let filteredList = [];
  let uiState = { running: false };

  function setStatus(text, type) {
    const el = document.getElementById('fbp-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'fbp-status' + (type ? ' ' + type : '');
  }

  function updateProgress(current, total) {
    const bar = document.getElementById('fbp-progress-bar');
    if (bar) {
      const pct = total > 0 ? (current / total * 100) : 0;
      bar.style.width = pct + '%';
    }
    const cur = document.getElementById('fbp-current-asn');
    if (cur) cur.textContent = current > 0 ? `${current}/${total}` : '—';
  }

  function updateResultUI(force) {
    getResultsCache();
    const cnt = document.getElementById('fbp-result-count');
    if (cnt) cnt.textContent = String(resultsCount);
    const ta = document.getElementById('fbp-results');
    if (!ta) return;
    if (uiState.running) {
      if (resultsCount === 0) {
        ta.value = '正在提取中...（结果实时累计，完成后可一键复制）';
      } else {
        ta.value = `正在提取中... 已累计 ${resultsCount} 条（完成后可一键复制）`;
      }
      return;
    }
    if (resultsCount === 0) {
      ta.value = '';
    } else {
      let text = '';
      try {
        text = GM_getValue(KEYS.results, '') || '';
      } catch (e) {
        text = '';
      }
      if (text.length > TEXTAREA_MAX_CHARS) {
        text = '...（仅显示尾部 ' + TEXTAREA_MAX_CHARS + ' 字符，完整结果请点「复制结果」）\n'
             + text.slice(-TEXTAREA_MAX_CHARS);
      }
      ta.value = text;
    }
  }

  function renderASNSelect() {
    const sel = document.getElementById('fbp-asn-select');
    const cntEl = document.getElementById('fbp-asn-count');
    if (!sel) return;
    sel.innerHTML = '';
    if (filteredList.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = asnList.length === 0 ? '— 请先导入或输入 ASN —' : '— 无匹配项 —';
      opt.disabled = true;
      opt.selected = true;
      sel.appendChild(opt);
    } else {
      filteredList.forEach((item, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        const remark = item.remark ? ` — ${item.remark}` : '';
        opt.textContent = `AS${item.asn}${remark}`;
        sel.appendChild(opt);
      });
    }
    if (cntEl) cntEl.textContent = `共 ${asnList.length} 条 ASN，筛选后 ${filteredList.length} 条`;
  }

  function applyFilter() {
    const raw = (document.getElementById('fbp-filter')?.value || '').trim();
    if (!raw) {
      filteredList = asnList.slice();
    } else {
      const keywords = raw.split(/\s+/).map(k => k.toLowerCase()).filter(k => k);
      if (keywords.length === 0) {
        filteredList = asnList.slice();
      } else {
        filteredList = asnList.filter(item => {
          const asnLower = item.asn.toLowerCase();
          const remarkLower = (item.remark || '').toLowerCase();
          return keywords.some(kw => asnLower.includes(kw) || remarkLower.includes(kw));
        });
      }
    }
    renderASNSelect();
  }

  function toggleSource() {
    const val = document.querySelector('input[name="fbp-source"]:checked')?.value;
    const manualBox = document.getElementById('fbp-manual-box');
    const urlBox = document.getElementById('fbp-url-box');
    if (val === 'url') {
      manualBox.style.display = 'none';
      urlBox.style.display = '';
    } else {
      manualBox.style.display = '';
      urlBox.style.display = 'none';
    }
  }

  function loadManualASN() {
    const text = document.getElementById('fbp-manual-asn')?.value || '';
    asnList = parseASNList(text);
    filteredList = asnList.slice();
    renderASNSelect();
    const c = loadConfig();
    c.savedAsnList = asnList;
    saveConfig(c);
    setStatus(`已从手动输入解析 ${asnList.length} 条 ASN。`, 'success');
  }

  function importFromURL() {
    const url = document.getElementById('fbp-url-input')?.value?.trim();
    if (!url) {
      setStatus('请输入 ASN 列表 URL。', 'error');
      return;
    }
    setStatus('正在导入 ASN 列表...');
    GM_xmlhttpRequest({
      method: 'GET',
      url: url,
      timeout: 30000,
      onload: function (resp) {
        if (resp.status >= 200 && resp.status < 300) {
          asnList = parseASNList(resp.responseText);
          filteredList = asnList.slice();
          renderASNSelect();
          const c = loadConfig();
          c.savedAsnList = asnList;
          saveConfig(c);
          if (asnList.length > 0) {
            setStatus(`成功导入 ${asnList.length} 条 ASN。`, 'success');
          } else {
            setStatus('导入成功但未解析到任何 ASN，请检查文件格式。', 'warning');
          }
        } else {
          setStatus(`导入失败：HTTP ${resp.status}`, 'error');
        }
      },
      onerror: function () {
        setStatus('导入失败：网络错误，请检查 URL 或 token。', 'error');
      },
      ontimeout: function () {
        setStatus('导入超时，请稍后重试。', 'error');
      }
    });
  }

  function copyResults() {
    getResultsCache();
    let text = '';
    try {
      text = GM_getValue(KEYS.results, '') || '';
    } catch (e) {
      text = '';
    }
    if (!text || resultsCount === 0) {
      setStatus('暂无结果可复制。', 'warning');
      return;
    }
    GM_setClipboard(text);
    setStatus(`已复制 ${resultsCount} 条 ip:port 到剪贴板。`, 'success');
  }

  function clearResultsFn() {
    if (uiState.running) {
      setStatus('批量进行中，无法清空。请先停止。', 'warning');
      return;
    }
    clearResults();
    updateResultUI(true);
    setStatus('结果已清空。');
  }

  function getBatchList() {
    const sel = document.getElementById('fbp-asn-select');
    const startIdx = sel && sel.value ? parseInt(sel.value, 10) : 0;
    return {
      list: filteredList.slice(startIdx),
      startIndex: startIdx
    };
  }

  function syncCustomDateVisibility() {
    const sel = document.getElementById('fbp-time-range');
    const after = document.getElementById('fbp-date-after');
    const before = document.getElementById('fbp-date-before');
    if (!sel || !after || !before) return;
    const isCustom = sel.value === 'custom';
    after.style.display = isCustom ? '' : 'none';
    before.style.display = isCustom ? '' : 'none';
  }

  function readDateFilterFromUI() {
    const sel = document.getElementById('fbp-time-range');
    if (!sel || sel.value === 'none') return null;
    const range = sel.value;
    if (range === 'custom') {
      const after = document.getElementById('fbp-date-after')?.value || '';
      const before = document.getElementById('fbp-date-before')?.value || '';
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      if (!after && !before) return null;
      if (after && !dateRe.test(after)) return { _invalid: true };
      if (before && !dateRe.test(before)) return { _invalid: true };
      if (after && before && after > before) return { _invalid: true };
      const result = {};
      if (after) result.after = after;
      if (before) result.before = before;
      return result;
    }
    return computeDateFilter(range, null, null);
  }

  function restoreDateFilterUI(dateFilter) {
    const sel = document.getElementById('fbp-time-range');
    const after = document.getElementById('fbp-date-after');
    const before = document.getElementById('fbp-date-before');
    if (!sel) return;
    if (!dateFilter) {
      sel.value = 'none';
      if (after) after.value = '';
      if (before) before.value = '';
    } else {
      sel.value = 'custom';
      if (after) after.value = dateFilter.after || '';
      if (before) before.value = dateFilter.before || '';
    }
    syncCustomDateVisibility();
  }

  function setDateFilterDisabled(disabled) {
    const ids = ['fbp-time-range', 'fbp-date-after', 'fbp-date-before'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = disabled;
    });
  }

  function startBatch() {
    const existingState = loadBatchState();
    if (existingState && existingState.status === 'paused') {
      existingState.status = 'running';
      saveBatchState(existingState);
      uiState.running = true;
      const sb = document.getElementById('fbp-start-btn');
      const sp = document.getElementById('fbp-stop-btn');
      if (sb) { sb.disabled = true; sb.textContent = '开始批量'; }
      if (sp) { sp.disabled = false; sp.textContent = '暂停'; }
      setDateFilterDisabled(true);
      setStatus(`从 AS${existingState.currentASN?.asn || ''} 恢复批量搜索...`);
      triggerSearch(existingState);
      return;
    }

    const syntax = document.getElementById('fbp-syntax')?.value?.trim();
    if (!syntax) {
      setStatus('请输入搜索语法。', 'error');
      return;
    }
    if (filteredList.length === 0) {
      setStatus('ASN 列表为空，请先导入或输入。', 'error');
      return;
    }
    const { list, startIndex } = getBatchList();
    if (list.length === 0) {
      setStatus('选中的起点之后没有 ASN 可搜索。', 'error');
      return;
    }
    const delay = parseInt(document.getElementById('fbp-delay')?.value || '5', 10);
    if (isNaN(delay) || delay < 0) {
      setStatus('搜索间隔必须为非负整数。', 'error');
      return;
    }

    const dateFilter = readDateFilterFromUI();
    if (dateFilter && dateFilter._invalid) {
      setStatus('自定义日期过滤无效：起止日期必须为 YYYY-MM-DD 格式且起始 ≤ 结束。', 'error');
      return;
    }
    delete dateFilter?._invalid;

    const excludePrivate = true;

    const cfgForFilter = loadConfig();
    cfgForFilter.dateFilter = dateFilter;
    cfgForFilter.excludePrivate = excludePrivate;
    const filterSel = document.getElementById('fbp-time-range');
    if (filterSel && filterSel.value !== 'custom') {
      cfgForFilter.dateFilterPreset = filterSel.value;
    } else {
      delete cfgForFilter.dateFilterPreset;
    }
    cfgForFilter.savedAsnList = asnList;
    cfgForFilter.savedFilterKeyword = document.getElementById('fbp-filter')?.value || '';
    delete cfgForFilter.savedFilterTags;
    saveConfig(cfgForFilter);

    const state = {
      syntax: syntax,
      asnList: list,
      originalTotal: filteredList.length,
      originalStart: startIndex,
      currentIndex: 0,
      delay: delay,
      dateFilter: dateFilter,
      excludePrivate: excludePrivate,
      status: 'running',
      startedAt: Date.now()
    };
    saveBatchState(state);

    clearResults();
    updateResultUI(true);

    uiState.running = true;
    const sb2 = document.getElementById('fbp-start-btn');
    const sp2 = document.getElementById('fbp-stop-btn');
    if (sb2) { sb2.disabled = true; sb2.textContent = '开始批量'; }
    if (sp2) { sp2.disabled = false; sp2.textContent = '暂停'; }
    document.getElementById('fbp-syntax').disabled = true;
    document.getElementById('fbp-manual-asn').disabled = true;
    document.getElementById('fbp-url-input').disabled = true;
    document.getElementById('fbp-import-btn').disabled = true;
    document.getElementById('fbp-filter').disabled = true;
    setDateFilterDisabled(true);

    triggerSearch(state);
  }

  function stopBatch() {
    const state = loadBatchState();
    const startBtn = document.getElementById('fbp-start-btn');
    const stopBtn = document.getElementById('fbp-stop-btn');
    const syntaxTa = document.getElementById('fbp-syntax');
    const manualTa = document.getElementById('fbp-manual-asn');
    const urlInput = document.getElementById('fbp-url-input');
    const importBtn = document.getElementById('fbp-import-btn');
    const filterInput = document.getElementById('fbp-filter');

    if (state && state.status === 'running') {
      state.status = 'paused';
      saveBatchState(state);
      uiState.running = false;
      if (startBtn) { startBtn.disabled = false; startBtn.textContent = '继续'; }
      if (stopBtn) { stopBtn.disabled = false; stopBtn.textContent = '停止'; }
      if (syntaxTa) syntaxTa.disabled = false;
      if (manualTa) manualTa.disabled = false;
      if (urlInput) urlInput.disabled = false;
      if (importBtn) importBtn.disabled = false;
      if (filterInput) filterInput.disabled = false;
      setDateFilterDisabled(false);
      flushResults(true);
      updateResultUI(true);
      const cacheSize = resultsCount;
      setStatus(`已暂停批量搜索。已提取 ${cacheSize} 条 ip:port 保留中。点击「继续」从当前 ASN 恢复，或点击「停止」彻底结束并清空结果。`, 'warning');
    } else if (state && state.status === 'paused') {
      clearBatchState();
      clearResults();
      uiState.running = false;
      if (startBtn) { startBtn.disabled = false; startBtn.textContent = '开始批量'; }
      if (stopBtn) { stopBtn.disabled = true; stopBtn.textContent = '暂停'; }
      if (syntaxTa) syntaxTa.disabled = false;
      if (manualTa) manualTa.disabled = false;
      if (urlInput) urlInput.disabled = false;
      if (importBtn) importBtn.disabled = false;
      if (filterInput) filterInput.disabled = false;
      setDateFilterDisabled(false);
      updateResultUI(true);
      updateProgress(0, 0);
      setStatus('已停止批量搜索，进度和结果已清空。', 'warning');
    } else {
      uiState.running = false;
      if (startBtn) { startBtn.disabled = false; startBtn.textContent = '开始批量'; }
      if (stopBtn) { stopBtn.disabled = true; stopBtn.textContent = '暂停'; }
    }
  }

  function triggerSearch(state) {
    const currentASN = state.asnList[state.currentIndex];
    if (!currentASN) {
      finishBatch(state);
      return;
    }

    const query = replaceASNInSyntax(state.syntax, currentASN.asn);
    const asnLabel = `AS${currentASN.asn}` + (currentASN.remark ? ` (${currentASN.remark})` : '');
    setStatus(`[${state.currentIndex + 1}/${state.asnList.length}] 正在搜索 ${asnLabel} ...`);
    updateProgress(state.currentIndex, state.asnList.length);

    state.currentASN = currentASN;
    state.currentQuery = query;
    state.triggeredAt = Date.now();
    saveBatchState(state);

    triggerSearchViaInputBox(query).then((ok) => {
      if (!ok) {
        setStatus(`未找到 FOFA 搜索框，无法触发搜索。已暂停于 ${asnLabel}。请确保当前在 FOFA 结果页顶部，然后点击「继续」。`, 'error');
        state.status = 'paused';
        saveBatchState(state);
        uiState.running = false;
        const sb = document.getElementById('fbp-start-btn');
        const sp = document.getElementById('fbp-stop-btn');
        if (sb) { sb.disabled = false; sb.textContent = '继续'; }
        if (sp) sp.disabled = true;
        return;
      }
      const navCheckInterval = 1000;
      const navMaxWait = 12000;
      let navWaited = 0;
      const navChecker = setInterval(() => {
        navWaited += navCheckInterval;
        if (/[?&]qbase64=/.test(window.location.search)) {
          clearInterval(navChecker);
          setTimeout(checkActiveBatch, 800);
          return;
        }
        const latestState = loadBatchState();
        if (!latestState || latestState.status !== 'running') {
          clearInterval(navChecker);
          return;
        }
        if (navWaited >= navMaxWait) {
          clearInterval(navChecker);
          setStatus(`搜索可能未触发（12秒内未跳转到结果页）。已暂停于 ${asnLabel}。请手动按回车键或点击 FOFA 搜索按钮触发搜索，然后点击「继续」。`, 'error');
          state.status = 'paused';
          saveBatchState(state);
          uiState.running = false;
          const sb2 = document.getElementById('fbp-start-btn');
          const sp2 = document.getElementById('fbp-stop-btn');
          if (sb2) { sb2.disabled = false; sb2.textContent = '继续'; }
          if (sp2) sp2.disabled = true;
        }
      }, navCheckInterval);
    });
  }

  function finishBatch(state) {
    clearBatchState();
    uiState.running = false;
    const startBtn = document.getElementById('fbp-start-btn');
    const stopBtn = document.getElementById('fbp-stop-btn');
    const syntaxTa = document.getElementById('fbp-syntax');
    const manualTa = document.getElementById('fbp-manual-asn');
    const urlInput = document.getElementById('fbp-url-input');
    const importBtn = document.getElementById('fbp-import-btn');
    const filterInput = document.getElementById('fbp-filter');
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = '开始批量'; }
    if (stopBtn) { stopBtn.disabled = true; stopBtn.textContent = '暂停'; }
    if (syntaxTa) syntaxTa.disabled = false;
    if (manualTa) manualTa.disabled = false;
    if (urlInput) urlInput.disabled = false;
    if (importBtn) importBtn.disabled = false;
    if (filterInput) filterInput.disabled = false;
    setDateFilterDisabled(false);
    updateProgress(state.asnList.length, state.asnList.length);
    flushResults(true);
    updateResultUI(true);
    const cacheSize = resultsCount;
    setStatus(`批量完成！共搜索 ${state.asnList.length} 个 ASN，提取 ${cacheSize} 条 ip:port。`, 'success');
  }

  let _checkActiveBatchRunning = false;
  function checkActiveBatch() {
    if (_checkActiveBatchRunning) {
      log('[FBP] checkActiveBatch: already running, skipping');
      return;
    }
    _checkActiveBatchRunning = true;
    _checkActiveBatchImpl().finally(() => {
      _checkActiveBatchRunning = false;
    });
  }

  async function _checkActiveBatchImpl() {
    const state = loadBatchStateWithAsnList();
    if (!state) return;

    if (state.status === 'paused') {
      const sb = document.getElementById('fbp-start-btn');
      const sp = document.getElementById('fbp-stop-btn');
      if (sb) { sb.disabled = false; sb.textContent = '继续'; }
      if (sp) { sp.disabled = false; sp.textContent = '停止'; }
      const syntaxTa = document.getElementById('fbp-syntax');
      if (syntaxTa && state.syntax) syntaxTa.value = state.syntax;
      const delayInput = document.getElementById('fbp-delay');
      if (delayInput && state.delay !== undefined) delayInput.value = state.delay;
      restoreDateFilterUI(state.dateFilter);
      setDateFilterDisabled(false);
      asnList = state.asnList || [];
      filteredList = asnList;
      renderASNSelect();
      updateProgress(state.currentIndex, state.asnList.length);
      updateResultUI(true);
      setStatus(`批量已暂停于 AS${state.currentASN?.asn || ''}（第 ${state.currentIndex + 1}/${state.asnList.length} 个）。点击「继续」从当前 ASN 恢复，或点击「停止」彻底结束并清空结果。`, 'warning');
      return;
    }

    if (state.status !== 'running') return;

    if (!/[?&]qbase64=/.test(window.location.search)) {
      return;
    }

    if (state.triggeredAt) {
      const elapsed = Date.now() - state.triggeredAt;
      if (elapsed > 60000) {
        setStatus('检测到页面可能被手动导航，批量已停止。', 'warning');
        stopBatch();
        return;
      }
    }

    uiState.running = true;
    const startBtn = document.getElementById('fbp-start-btn');
    const stopBtn = document.getElementById('fbp-stop-btn');
    const syntaxTa = document.getElementById('fbp-syntax');
    if (startBtn) { startBtn.disabled = true; startBtn.textContent = '开始批量'; }
    if (stopBtn) { stopBtn.disabled = false; stopBtn.textContent = '暂停'; }
    if (syntaxTa) {
      syntaxTa.value = state.syntax;
      syntaxTa.disabled = true;
    }
    const delayInput = document.getElementById('fbp-delay');
    if (delayInput) delayInput.value = state.delay;
    restoreDateFilterUI(state.dateFilter);
    setDateFilterDisabled(true);
    asnList = state.asnList;
    filteredList = state.asnList;
    renderASNSelect();
    updateProgress(state.currentIndex, state.asnList.length);
    updateResultUI(true);

    const asnLabel = state.currentASN ? `AS${state.currentASN.asn}` + (state.currentASN.remark ? ` (${state.currentASN.remark})` : '') : '';
    setStatus(`[${state.currentIndex + 1}/${state.asnList.length}] 等待 ${asnLabel} 结果加载...`);

    const res = await waitForResultsLoaded();
    if (!res.ok) {
      let msg = '未知错误';
      if (res.error === 'login_required') msg = '需要登录 FOFA，已暂停批量。';
      else if (res.error === 'captcha') msg = '触发验证码，已暂停批量。';
      else if (res.error === 'rate_limited') msg = '触发 FOFA 风控，已暂停批量。';
      setStatus(msg, 'error');
      state.status = 'paused';
      saveBatchState(state);
      uiState.running = false;
      const sb = document.getElementById('fbp-start-btn');
      const sp = document.getElementById('fbp-stop-btn');
      if (sb) { sb.disabled = false; sb.textContent = '继续'; }
      if (sp) { sp.disabled = false; sp.textContent = '停止'; }
      return;
    }

    if (res.noResult) {
      setStatus(`[${state.currentIndex + 1}/${state.asnList.length}] ${asnLabel} 无结果，继续下一个。`);
      state.currentIndex += 1;
      saveBatchState(state);
      if (state.currentIndex >= state.asnList.length) {
        finishBatch(state);
        return;
      }
      setStatus(getStatusText() + ` 等待 ${state.delay} 秒后搜索下一个...`);
      setTimeout(() => {
        const latest = loadBatchStateWithAsnList();
        if (!latest || latest.status !== 'running') return;
        triggerSearch(latest);
      }, state.delay * 1000);
      return;
    }

    extractAndProceed(state, res, asnLabel);
  }

  function extractAndProceed(state, res, asnLabel) {
    let newResults = [];
    let extractStats = { total: 0, kept: 0, noDate: 0, outOfRange: 0, privateExcluded: 0 };
    if (!res.noResult) {
      const extractRes = extractResultsFromPage(state.dateFilter, state.excludePrivate);
      newResults = extractRes.results;
      extractStats = extractRes.stats;
    }
    const added = mergeResults(newResults);
    const totalSize = resultsCount;
    updateResultUI(false);
    if (asnProcessedSinceFlush >= RESULTS_FLUSH_EVERY) {
      flushResults(false);
    }
    if (res.noResult) {
      setStatus(`[${state.currentIndex + 1}/${state.asnList.length}] ${asnLabel} 无结果，继续下一个。`);
    } else if (res.timeout) {
      setStatus(`[${state.currentIndex + 1}/${state.asnList.length}] ${asnLabel} 已提取 ${added} 个，共累计 ${totalSize} 个（等待超时）。`, 'warning');
    } else {
      setStatus(`[${state.currentIndex + 1}/${state.asnList.length}] ${asnLabel} 已提取 ${added} 个，共累计 ${totalSize} 个。`);
    }
    state.currentIndex += 1;
    saveBatchState(state);
    if (state.currentIndex >= state.asnList.length) {
      finishBatch(state);
      return;
    }
    setStatus(getStatusText() + ` 等待 ${state.delay} 秒后搜索下一个...`);
    setTimeout(() => {
      const latest = loadBatchStateWithAsnList();
      if (!latest || latest.status !== 'running') return;
      triggerSearch(latest);
    }, state.delay * 1000);
  }

  function getStatusText() {
    const el = document.getElementById('fbp-status');
    return el ? el.textContent : '';
  }

  // ==================== GitHub 仓库上传 ====================
  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    bytes.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary);
  }

  function uploadToRepo() {
    const token = document.getElementById('fbp-github-token')?.value?.trim();
    const owner = document.getElementById('fbp-github-owner')?.value?.trim();
    const repo = document.getElementById('fbp-github-repo')?.value?.trim();
    const path = document.getElementById('fbp-github-path')?.value?.trim();
    const branch = document.getElementById('fbp-github-branch')?.value?.trim() || 'main';
    const commitMsg = document.getElementById('fbp-github-commit-msg')?.value?.trim() || 'Update fofa results';

    if (!token) { setStatus('请先填写 GitHub Token。', 'error'); return; }
    if (!owner || !repo || !path) { setStatus('请填写完整的仓库信息（owner/repo/path）。', 'error'); return; }

    let content = '';
    try { content = GM_getValue(KEYS.results, '') || ''; } catch(e) { content = ''; }
    if (!content.trim()) { setStatus('没有可上传的结果。', 'warning'); return; }

    const btn = document.getElementById('fbp-upload-btn');
    const hint = document.getElementById('fbp-upload-status');
    if (btn) btn.disabled = true;
    if (hint) hint.textContent = '正在上传...';

    const headers = {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };

    // Step 1: Get existing file SHA (if any)
    const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
    GM_xmlhttpRequest({
      method: 'GET',
      url: getUrl,
      headers: headers,
      timeout: 15000,
      onload: function(getResp) {
        let sha = null;
        if (getResp.status === 200) {
          try {
            const existing = JSON.parse(getResp.responseText);
            sha = existing.sha;
          } catch(e) {}
        } else if (getResp.status !== 404) {
          if (btn) btn.disabled = false;
          setStatus(`获取文件信息失败：HTTP ${getResp.status}`, 'error');
          if (hint) hint.textContent = '上传失败';
          return;
        }

        // Step 2: Create or update file
        const payload = {
          message: commitMsg,
          content: utf8ToBase64(content),
          branch: branch
        };
        if (sha) payload.sha = sha;

        const putUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
        GM_xmlhttpRequest({
          method: 'PUT',
          url: putUrl,
          headers: headers,
          data: JSON.stringify(payload),
          timeout: 30000,
          onload: function(putResp) {
            if (btn) btn.disabled = false;
            try {
              const json = JSON.parse(putResp.responseText);
              if (putResp.status >= 200 && putResp.status < 300) {
                const fileUrl = json.content?.html_url || `https://github.com/${owner}/${repo}/blob/${branch}/${path}`;
                setStatus(`上传成功！文件地址：${fileUrl}`, 'success');
                if (hint) hint.textContent = `上次上传：${fileUrl}`;
              } else {
                const msg = json.message || `HTTP ${putResp.status}`;
                setStatus(`上传失败：${msg}`, 'error');
                if (hint) hint.textContent = `上传失败：${msg}`;
              }
            } catch(e) {
              setStatus('上传响应解析失败。', 'error');
              if (hint) hint.textContent = '上传失败';
            }
          },
          onerror: function() {
            if (btn) btn.disabled = false;
            setStatus('上传失败：网络错误或请求被拒绝。', 'error');
            if (hint) hint.textContent = '上传失败：网络错误';
          },
          ontimeout: function() {
            if (btn) btn.disabled = false;
            setStatus('上传超时。', 'error');
            if (hint) hint.textContent = '上传超时';
          }
        });
      },
      onerror: function() {
        if (btn) btn.disabled = false;
        setStatus('获取文件信息失败：网络错误。', 'error');
        if (hint) hint.textContent = '上传失败';
      },
      ontimeout: function() {
        if (btn) btn.disabled = false;
        setStatus('获取文件信息超时。', 'error');
        if (hint) hint.textContent = '上传失败';
      }
    });
  }

  // ==================== 拖拽 & 折叠 ====================
  let _dragHandlers = null;

  function makeDraggable() {
    const handle = document.getElementById('fbp-drag-handle');
    const panel = document.getElementById('fbp-panel');
    if (!handle || !panel) return;
    if (_dragHandlers) {
      handle.removeEventListener('mousedown', _dragHandlers.onMouseDown);
      document.removeEventListener('mousemove', _dragHandlers.onMouseMove);
      document.removeEventListener('mouseup', _dragHandlers.onMouseUp);
    }
    let isDragging = false;
    let startX, startY, startLeft, startTop;
    const onMouseDown = (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.right = 'auto';
      panel.style.left = startLeft + 'px';
      panel.style.top = startTop + 'px';
      e.preventDefault();
    };
    const onMouseMove = (e) => {
      if (!isDragging) return;
      let newLeft = startLeft + (e.clientX - startX);
      let newTop = startTop + (e.clientY - startY);
      const maxLeft = window.innerWidth - panel.offsetWidth;
      const maxTop = window.innerHeight - 40;
      newLeft = Math.max(0, Math.min(newLeft, maxLeft));
      newTop = Math.max(0, Math.min(newTop, maxTop));
      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };
    const onMouseUp = () => {
      isDragging = false;
    };
    handle.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    _dragHandlers = { onMouseDown, onMouseMove, onMouseUp };
  }

  function collapsePanel() {
    const panel = document.getElementById('fbp-panel');
    const fab = document.getElementById('fbp-fab');
    if (panel) panel.style.display = 'none';
    if (fab) fab.style.display = 'flex';
  }

  function expandPanel() {
    const panel = document.getElementById('fbp-panel');
    const fab = document.getElementById('fbp-fab');
    if (panel) panel.style.display = 'flex';
    if (fab) fab.style.display = 'none';
  }

  // ==================== 初始化 ====================
  function init() {
    if (window.__fbpInitialized) {
      setTimeout(checkActiveBatch, 800);
      return;
    }
    window.__fbpInitialized = true;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    panelEl = createPanelHTML();
    document.body.appendChild(panelEl);
    fabEl = createCollapsedFab();
    document.body.appendChild(fabEl);
    makeDraggable();

    const cfg = loadConfig();
    if (cfg.syntax) document.getElementById('fbp-syntax').value = cfg.syntax;
    if (cfg.delay !== undefined) document.getElementById('fbp-delay').value = cfg.delay;
    if (cfg.url) document.getElementById('fbp-url-input').value = cfg.url;
    if (cfg.manualASN) document.getElementById('fbp-manual-asn').value = cfg.manualASN;
    if (cfg.source) {
      const radio = document.querySelector(`input[name="fbp-source"][value="${cfg.source}"]`);
      if (radio) radio.checked = true;
      toggleSource();
    }

    const batchState = loadBatchState();
    if (batchState && (batchState.status === 'running' || batchState.status === 'paused') && batchState.dateFilter !== undefined) {
      restoreDateFilterUI(batchState.dateFilter);
    } else if (cfg.dateFilter) {
      restoreDateFilterUI(cfg.dateFilter);
    } else if (cfg.dateFilterPreset) {
      const sel = document.getElementById('fbp-time-range');
      if (sel) sel.value = cfg.dateFilterPreset;
      syncCustomDateVisibility();
    } else {
      syncCustomDateVisibility();
    }

    // 恢复 GitHub 上传配置
    if (cfg.githubToken) document.getElementById('fbp-github-token').value = cfg.githubToken;
    if (cfg.githubRepoOwner) document.getElementById('fbp-github-owner').value = cfg.githubRepoOwner;
    if (cfg.githubRepoName) document.getElementById('fbp-github-repo').value = cfg.githubRepoName;
    if (cfg.githubRepoPath) document.getElementById('fbp-github-path').value = cfg.githubRepoPath;
    if (cfg.githubRepoBranch) document.getElementById('fbp-github-branch').value = cfg.githubRepoBranch;
    if (cfg.githubCommitMessage) document.getElementById('fbp-github-commit-msg').value = cfg.githubCommitMessage;

    const tokenInput = document.getElementById('fbp-github-token');
    const uploadBtn = document.getElementById('fbp-upload-btn');
    if (tokenInput && uploadBtn) {
      uploadBtn.disabled = !tokenInput.value.trim();
    }

    // 恢复 ASN 列表
    const filterInputEl = document.getElementById('fbp-filter');
    if (filterInputEl && cfg.savedFilterKeyword) {
      filterInputEl.value = cfg.savedFilterKeyword;
    }
    if (batchState && (batchState.status === 'running' || batchState.status === 'paused') && batchState.asnList) {
      asnList = batchState.asnList;
      filteredList = asnList;
      renderASNSelect();
    } else if (cfg.savedAsnList && Array.isArray(cfg.savedAsnList) && cfg.savedAsnList.length > 0) {
      asnList = cfg.savedAsnList;
      applyFilter();
    } else {
      loadManualASN();
    }

    // 事件绑定
    document.getElementById('fbp-collapse-btn').addEventListener('click', collapsePanel);
    document.getElementById('fbp-close-btn').addEventListener('click', collapsePanel);
    fabEl.addEventListener('click', expandPanel);

    document.querySelectorAll('input[name="fbp-source"]').forEach(r => {
      r.addEventListener('change', () => {
        toggleSource();
        if (document.querySelector('input[name="fbp-source"]:checked').value === 'manual') {
          loadManualASN();
        }
      });
    });

    document.getElementById('fbp-manual-asn').addEventListener('blur', () => {
      loadManualASN();
      const c = loadConfig();
      c.savedAsnList = asnList;
      saveConfig(c);
    });
    document.getElementById('fbp-import-btn').addEventListener('click', importFromURL);
    document.getElementById('fbp-filter').addEventListener('input', () => {
      applyFilter();
      const c = loadConfig();
      c.savedFilterKeyword = document.getElementById('fbp-filter').value || '';
      saveConfig(c);
    });
    document.getElementById('fbp-start-btn').addEventListener('click', startBatch);
    document.getElementById('fbp-stop-btn').addEventListener('click', stopBatch);
    document.getElementById('fbp-copy-btn').addEventListener('click', copyResults);
    document.getElementById('fbp-clear-btn').addEventListener('click', clearResultsFn);

    document.getElementById('fbp-time-range').addEventListener('change', () => {
      syncCustomDateVisibility();
      const sel = document.getElementById('fbp-time-range');
      const c = loadConfig();
      if (sel.value === 'custom') {
        c.dateFilter = readDateFilterFromUI();
        delete c.dateFilterPreset;
      } else {
        c.dateFilterPreset = sel.value;
        delete c.dateFilter;
      }
      saveConfig(c);
    });
    document.getElementById('fbp-date-after').addEventListener('change', () => {
      const c = loadConfig(); c.dateFilter = readDateFilterFromUI(); saveConfig(c);
    });
    document.getElementById('fbp-date-before').addEventListener('change', () => {
      const c = loadConfig(); c.dateFilter = readDateFilterFromUI(); saveConfig(c);
    });

    document.getElementById('fbp-syntax').addEventListener('change', () => {
      const c = loadConfig(); c.syntax = document.getElementById('fbp-syntax').value; saveConfig(c);
    });
    document.getElementById('fbp-delay').addEventListener('change', () => {
      const c = loadConfig(); c.delay = parseInt(document.getElementById('fbp-delay').value, 10); saveConfig(c);
    });
    document.getElementById('fbp-url-input').addEventListener('change', () => {
      const c = loadConfig(); c.url = document.getElementById('fbp-url-input').value; saveConfig(c);
    });
    document.getElementById('fbp-manual-asn').addEventListener('change', () => {
      const c = loadConfig(); c.manualASN = document.getElementById('fbp-manual-asn').value; saveConfig(c);
    });
    document.querySelectorAll('input[name="fbp-source"]').forEach(r => {
      r.addEventListener('change', () => {
        const c = loadConfig(); c.source = document.querySelector('input[name="fbp-source"]:checked').value; saveConfig(c);
      });
    });

    // GitHub 上传事件绑定
    document.getElementById('fbp-upload-btn').addEventListener('click', uploadToRepo);
    tokenInput.addEventListener('input', function() {
      if (uploadBtn) uploadBtn.disabled = !this.value.trim();
      const c = loadConfig();
      c.githubToken = this.value;
      saveConfig(c);
    });
    document.getElementById('fbp-github-owner').addEventListener('change', saveGithubField('githubRepoOwner'));
    document.getElementById('fbp-github-repo').addEventListener('change', saveGithubField('githubRepoName'));
    document.getElementById('fbp-github-path').addEventListener('change', saveGithubField('githubRepoPath'));
    document.getElementById('fbp-github-branch').addEventListener('change', saveGithubField('githubRepoBranch'));
    document.getElementById('fbp-github-commit-msg').addEventListener('change', saveGithubField('githubCommitMessage'));

    function saveGithubField(field) {
      return function() {
        const c = loadConfig();
        c[field] = this.value.trim();
        saveConfig(c);
      };
    }

    updateResultUI(true);
    setTimeout(checkActiveBatch, 800);
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
