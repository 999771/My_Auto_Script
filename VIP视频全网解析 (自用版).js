// ==UserScript==
// @name VIP视频全网解析 (自用版)
// @version 2.5.0
// @description 💎VIP视频解析 | ★智能线路优选 | 💎免登录免费看 | ⚡极速评估资源 | 🚫插播广告拦截
// @icon data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48Y2lyY2xlIGN4PSI1MCIgY3k9IjUwIiByPSI1MCIgZmlsbD0idXJsKCNncmFkKSIvPjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZCIgeDE9IjAlIiB5MT0iMCUiIHgyPSIxMDAlIiB5Mj0iMTAwJSI+PHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzAwMzM5OSIvPjxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzAwNjZjYyIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjx0ZXh0IHg9IjUwIiB5PSI3MCIgZm9udC1zaXplPSI1MCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0id2hpdGUiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIiBmb250LXdlaWdodD0ibjkwMCI+VklQPC90ZXh0Pjwvc3ZnPg==
// @author Wells
// @noframes
// @match *://*.iqiyi.com/*
// @match *://*.iq.com/*
// @match *://v.qq.com/*
// @match *://*.youku.com/*
// @match *://*.mgtv.com/*
// @match *://*.le.com/*
// @match *://*.letv.com/*
// @match *://tv.sohu.com/*
// @match *://*.fun.tv/*
// @match *://*.funshion.com/*
// @match *://*.wasu.cn/*
// @match *://*.bilibili.com/bangumi/*
// @grant GM_addStyle
// @grant GM_xmlhttpRequest
// @grant GM_setValue
// @grant GM_getValue
// @grant GM_registerMenuCommand
// @run-at document-end
// @connect *
// @antifeature piracy
// @license MIT
// ==/UserScript==
(function () {
    if (window.hasInitVipScript) return;
    window.hasInitVipScript = true;
    'use strict';

    // ===== GM_xmlhttpRequest 手动跟随重定向补丁 (Tampermonkey ≥5.3.2) =====
    const HAS_GM = typeof GM !== 'undefined';
    const NEW_GM = ((scope, GM) => {
        if (typeof GM_info === 'undefined' || GM_info.scriptHandler !== 'Tampermonkey') return;
        const cmp = (v1, v2) => {
            const a = v1.split('.').map(Number), b = v2.split('.').map(Number);
            for (let i = 0; i < Math.max(a.length, b.length); i++) {
                const d = (a[i] || 0) - (b[i] || 0);
                if (d) return d > 0 ? 1 : -1;
            }
            return 0;
        };
        try { if (cmp(GM_info.version, '5.3.2') < 0) return; } catch (e) { return; }

        const orig = GM_xmlhttpRequest;
        const origAlt = GM?.xmlHttpRequest;

        const withRedirect = details => {
            const { onload, onloadend, onerror, onabort, ontimeout, ...rest } = details;
            const go = d => orig({
                ...d,
                redirect: 'manual',
                onload(res) {
                    if (res.status >= 300 && res.status < 400) {
                        const m = res.responseHeaders.match(/Location:\s*(\S+)/i);
                        if (m && m[1]) {
                            try { go({ ...d, url: new URL(m[1], d.url).href }); return; } catch (e) {}
                        }
                    }
                    onload?.call(this, res);
                    onloadend?.call(this, res);
                },
                onerror(res) { onerror?.call(this, res); onloadend?.call(this, res); },
                onabort(res) { onabort?.call(this, res); onloadend?.call(this, res); },
                ontimeout(res) { ontimeout?.call(this, res); onloadend?.call(this, res); }
            });
            return details.redirect !== undefined ? orig(details) : go(rest);
        };

        const withPromise = odetails => {
            let abort;
            const p = new Promise((resolve, reject) => {
                const { onload, ontimeout, onerror, ...send } = odetails;
                send.onerror = r => { if (onerror) { resolve(r); onerror.call(this, r); } else reject(r); };
                send.ontimeout = r => { if (ontimeout) { resolve(r); ontimeout.call(this, r); } else reject(r); };
                send.onload = r => { resolve(r); onload?.call(this, r); };
                const a = withRedirect(send).abort;
                if (abort === true) a(); else abort = a;
            });
            p.abort = () => { if (typeof abort === 'function') abort(); else abort = true; };
            return p;
        };

        GM_xmlhttpRequest = withRedirect;
        scope.GM_xmlhttpRequestOrig = orig;
        if (GM?.xmlHttpRequest) {
            const d = Object.getOwnPropertyDescriptor(GM, 'xmlHttpRequest');
            if (d && d.configurable === false) {
                return { __proto__: GM, xmlHttpRequest: withPromise, xmlHttpRequestOrig: origAlt };
            }
            GM.xmlHttpRequest = withPromise;
            GM.xmlHttpRequestOrig = origAlt;
        }
        return null;
    })(typeof window !== 'undefined' ? window : globalThis, HAS_GM ? GM : {});
    if (HAS_GM && NEW_GM) GM = NEW_GM;

    // DNS 预取提示（仅注入 hint，不做扫描）
    const injectDnsHints = domainList => {
        try {
            const frag = document.createDocumentFragment();
            const base = ['fastly.jsdelivr.net', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'];
            [...new Set([...base, ...domainList])].forEach(d => {
                const link = document.createElement('link');
                link.rel = 'dns-prefetch';
                link.href = '//' + d;
                frag.appendChild(link);
            });
            document.head?.appendChild(frag);
        } catch (e) {}
    };

    const CONFIG = {
        API_TIMEOUT: 3500,
        STUCK_CHECK_TIMEOUT: 7000,
        SEARCH_CONCURRENCY: 16,
        SMART_SORTING: true,
        AUTOPLAY_NEXT_DELAY: 200,
        PANEL_LEAVE_CLOSE_DELAY: 1500,
        SPA_DEBOUNCE: 400,
        STORAGE_KEY_ICON_POSITION: 'vip_icon_pos_v8',
        VIDEO_URL_PATTERNS: [
            /iqiyi\.com\/[vwa]_/, /iq\.com\/play\//, /youku\.com\/v_show\/id_/, /v\.youku\.com\/v_show\/id_/,
            /v\.qq\.com\/(x\/cover|x\/page|tv|play)\//, /mgtv\.com\/b\//, /mgtv\.com\/s\//,
            /bilibili\.com\/(video|bangumi\/play)\//, /b23\.tv\//, /le\.com\/ptv\/vplay\//,
            /tv\.sohu\.com\/v\//, /film\.sohu\.com\/album\//, /pptv\.com\/show\//,
            /acfun\.cn\/v\/ac/, /1905\.com\/play\//, /ixigua\.com\/(video|play)\//,
            /tudou\.com\/(listplay|albumplay|programs\/view)\//,
            /fun\.tv\/(vod-play|player)\//, /funshion\.com\/(play|player)\//,
            /baofeng\.com\/(play\/|play-|player\/)/, /bfeng\.cn\//, /stormsfy\.com\//,
            /migumovie\.hcs\.cmvideo\.cn\/movie/, /miguvideo\.com\/(detail|(v|n|p)\/play|play\/)/,
            /cmvideo\.cn\/((v|n|p)\/play|detail)/,
            /douyin\.com\/video\//,
            /kuaishou\.com\/short-video\//, /hanju\.koudaibaobao\.com\//, /maiduidui\.com\/play\//,
            /rrsp\.tv\/play\//, /vas\.hiaiabc\.com\/play/,
            /wasu\.cn\/([a-z-]+-detail|play)\//
        ],
        MESSAGES: {
            VIDEO_ENDED: 'tm_video_ended',
            PLAY_SUCCESS: 'tm_play_success',
            PLAY_ERROR: 'tm_play_error',
            STREAM_ALIVE: 'tm_stream_alive'
        },
        SELECTORS: {
            PLAYER_ELEMENTS: [
                '#tenvideo_player', '.txp_player_root', '#player-container', '#player',
                '.container-player', '#sohuplayer', '#flashbox', '.iqp-player',
                '#bilibili-player', '.bpx-player-container', '#mgtv-player-wrap',
                '#le_player', '#player_swf', '#pp-player', '#ACPlayer', '#video-player',
                '#xigua-player', '.video-area', '.player-container', '.artplayer-app',
                '#bf-player', '.bf-player', '#baofeng-player', '#bf-video-player',
                '#fun-player', '.fun-player', '#FunPlayer', '#h5player'
            ],
            QUICK_TITLE: ['meta[property="og:title"]', 'h1', '.video-title', '.title', '.vod_title', '.video-info-title'],
            PRECISE_TITLE: {
                'iqiyi.com': '[class*="episodes_playingItem"] [class*="episodes_order"], .qy-episode-item[class*="is-active"] a, .album-list .is-active .title-content, [class*="selected"] .qy-episode-num, #text[style*="IQYHT-Bold"]',
                'youku.com': '.box-anthology-item.active, .anthology-wrap li.active span, .anthology-item.current, .play-panel-item.active',
                'v.qq.com': '.episode-item--select, .playlist-item--current, [class*="selected"] [class*="episode-item-text"], [class*="episode-item"][class*="selected"] .episode-item-text, [class*="episode-item"][class*="current"] .episode-item-text, [class*="episode-item"][class*="active"] .episode-item-text, [class*="numberListItem_select"] [class*="numberListItem_title"], [data-v-db0ab5fa].episode-item-text',
                'bilibili.com': '[class*="EpisodeVirtualList_numberTitle"], [class*="numberListItem_select"] [class*="numberListItem_title"], .ep-list-item.on .ep-item-title, [class*="episode_list"] [class*="selected"]',
                'mgtv.com': '[class*="mgtv-player-aside-number-selector__number"], .episode-list .current a, .episode-series .current',
                'sohu.com': 'li.pane-item.vip.on a, li.pane-item.on a, .player-album-list .on a',
                'le.com': '.js-episode-item.on',
                'pptv.com': '.episode-list .current',
                'acfun.cn': '.active .title-wenzi',
                'miguvideo.com': '[data-v-50548e8b].on span[data-v-50548e8b], [data-v-50548e8b].on, [class*="episodeTitle"][class*="on"]',
                'baofeng.com': '.media-title, .player-album .on, .play-list .on, .episode-list .current, [class*="episode"][class*="active"], [class*="episode"][class*="on"]'
            },
            PRECISE_MAIN_TITLE: {
                'qq.com': '.intro-title[title], .video-title[title], .player-title',
                'iqiyi.com': '[data-ai-entity="视频名称、主标题"], [data-ai-entity*="主标题"], [data-ai-entity*="视频名称"], [class*="meta_title"], [class*="meta_titleNotCloud"], [class*="meta_titleNewLabel"], [class*="episodeTitle"], .album-head-title',
                'iq.com': '[data-ai-entity="视频名称、主标题"], [data-ai-entity*="主标题"], [data-ai-entity*="视频名称"], [class*="meta_title"]',
                'youku.com': '[data-spm-anchor-id*="introduction"] .title, .title[style*="max-width"], .video-title, a[data-pb-txid="pg_playlist_title"][title]',
                'bilibili.com': '[class*="mediaTitle"][title], [class*="mediaTitle"], .media-info-title-t',
                'b23.tv': '[class*="mediaTitle"][title], [class*="mediaTitle"]',
                'sohu.com': 'a[data-pb-txid="pg_playlist_title"][title]',
                'mgtv.com': 'h2[class*="mgtv-player-aside-info__title"][title]',
                'miguvideo.com': '[data-v-50548e8b][title].episodeTitle',
                'le.com': '.j_jujiName, .juji_bar, h1.title, .detail-title, .video-title, [class*="movieName"], [class*="videoName"]',
                'baofeng.com': '.media-title, .video-info h1, .player-title, .detail-title, .movie-title, h1.title, [class*="videoTitle"], [class*="video-title"]'
            }
        },
        MOVIE_KEYWORDS: /^(HD|超清|高清|正片|国语|HD国语|720P|1080P|蓝光|4K|BD|TC|TS|DVD|抢先|高清版|HD高清|国语高清|HD中字)$/i,
        MOVIE_PRIORITY: ['蓝光', '4K', '1080P', '超清', 'HD国语', 'HD', '国语', '高清', '720P', 'BD', '正片', 'HD高清', '国语高清', 'HD中字', 'TC', 'TS', 'DVD', '抢先', '高清版']
    };

    const _TITLE_SPLIT_RE = /[-_\s（(]/;
    const _EP_REMOVE_RE = /第.+[集季部]/;
    const _NUM_ONLY_RE = /^\d+$/;
    const _EP_PATTERNS = [
        /第\s*(\d+)\s*[集话期]/,
        /(?:EP|E)\s*(\d+)/i,
        /第\s*\d+\s*[季部]\s*第\s*(\d+)\s*[集话]/,
        /(\d+)\s*[集话期]/,
        /(?:\[|【|（|\()(\d+)(?:\]|】|）|\))/
    ];

    // 搜索结果缓存 1 小时；升级版本号可作废旧缓存
    const SearchCache = {
        get(key) {
            try {
                const c = JSON.parse(GM_getValue('cache_v7_' + key, 'null'));
                if (c && Date.now() - c.ts < 3600000) return c.data;
            } catch (e) {}
            return null;
        },
        set(key, data) {
            try { GM_setValue('cache_v7_' + key, JSON.stringify({ data, ts: Date.now() })); } catch (e) {}
        }
    };

    // 外部库：多 CDN 回退加载 + 并发预取
    const LibCache = (() => {
        const urls = {
            hls: [
                'https://fastly.jsdelivr.net/npm/hls.js@1.6.11/dist/hls.min.js',
                'https://cdn.jsdelivr.net/npm/hls.js@1.6.11/dist/hls.min.js',
                'https://unpkg.com/hls.js@1.6.11/dist/hls.min.js',
                'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.6.11/hls.min.js'
            ],
            art: [
                'https://fastly.jsdelivr.net/npm/artplayer@5.4.0/dist/artplayer.min.js',
                'https://cdn.jsdelivr.net/npm/artplayer@5.4.0/dist/artplayer.min.js',
                'https://unpkg.com/artplayer@5.4.0/dist/artplayer.min.js',
                'https://cdnjs.cloudflare.com/ajax/libs/artplayer/5.4.0/artplayer.min.js'
            ]
        };
        const state = {};
        const fetchOne = url => new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, timeout: 4000,
                onload: r => (r.status >= 200 && r.status < 400 && r.responseText)
                    ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)),
                onerror: () => reject(new Error('net')),
                ontimeout: () => reject(new Error('timeout'))
            });
        });
        const load = name => {
            if (!state[name]) {
                state[name] = (async () => {
                    for (const u of urls[name]) {
                        try { return await fetchOne(u); } catch (e) {}
                    }
                    return null;
                })().then(code => { state[name] = code; return code; });
            }
            return state[name];
        };
        return {
            preload() { Object.keys(urls).forEach(load); },
            getHls: () => load('hls'),
            getArt: () => load('art')
        };
    })();
    LibCache.preload();

    const ApiStats = {
        _p: {},
        _t: null,
        _priority: new Set(['西瓜', '天堂', '爱奇艺', '天涯', '如意', '茅台', '360']),
        _flush() {
            const p = this._p;
            this._p = {};
            this._t = null;
            for (const [k, v] of Object.entries(p)) GM_setValue(`api_stats_${k}`, v);
        },
        _schedule() { if (!this._t) this._t = setTimeout(() => this._flush(), 2000); },
        get(n) { return this._p[n] || GM_getValue(`api_stats_${n}`) || { s: 0, f: 0, l: 0, r: 0 }; },
        ok(n, lat) { const s = this.get(n); s.s++; s.l += lat; s.r++; this._p[n] = s; this._schedule(); },
        fail(n) { const s = this.get(n); s.f++; s.r++; this._p[n] = s; this._schedule(); },
        score(s, name) {
            if (name && this._priority.has(name)) return 99999;
            if (s.r < 3) return 1000;
            const sr = s.s / s.r;
            if (sr < 0.5) return -1000;
            return sr * 10000 - (s.s ? s.l / s.s : CONFIG.API_TIMEOUT);
        }
    };

    // 解析源列表（URL 经 Base64 编码；天涯重复项已去重）
    const RAW_APIS = [
        { n: "西瓜", u: atob("aHR0cHM6Ly9jYWlqaS54Z3p5YXBpLmNvbS9hcGkucGhwL3Byb3ZpZGUvdm9k") },
        { n: "天堂", u: atob("aHR0cHM6Ly9jYWlqaS5keXR0enlhcGkuY29tL2FwaS5waHAvcHJvdmlkZS92b2Q=") },
        { n: "母鸡", u: atob("aHR0cHM6Ly9tdWppeml5dWFuMDAuY29tL2FwaS5waHAvcHJvdmlkZS92b2Q=") },
        { n: "爱奇艺", u: atob("aHR0cHM6Ly9pcWl5aXp5YXBpLmNvbS9hcGkucGhwL3Byb3ZpZGUvdm9k") },
        { n: "猫眼", u: atob("aHR0cHM6Ly9hcGkubWFveWFuYXBpLnRvcC9hcGkucGhwL3Byb3ZpZGUvdm9k") },
        { n: "天涯", u: atob("aHR0cHM6Ly90eXlzenlhcGkuY29tL2FwaS5waHAvcHJvdmlkZS92b2Q=") },
        { n: "如意", u: atob("aHR0cHM6Ly9jai5yeWNqYXBpLmNvbS9hcGkucGhwL3Byb3ZpZGUvdm9k") },
        { n: "量子", u: atob("aHR0cHM6Ly9jai5semlhcGkuY29tL2FwaS5waHAvcHJvdmlkZS92b2Q=") },
        { n: "非凡", u: atob("aHR0cDovL2FwaS5mZnp5YXBpLmNvbS9hcGkucGhwL3Byb3ZpZGUvdm9k") },
        { n: "茅台", u: atob("aHR0cHM6Ly9jYWlqaS5tYW90YWk5OTkudmlwL2FwaS5waHAvcHJvdmlkZS92b2Q=") },
        { n: "最大", u: atob("aHR0cHM6Ly9hcGkuenVpZGFwaS5jb20vYXBpLnBocC9wcm92aWRlL3ZvZA==") },
        { n: "1080", u: atob("aHR0cHM6Ly9hcGkueXl6eS10di52aXAvaW5jL2FwaWpzb24ucGhw") },
        { n: "新浪", u: atob("aHR0cHM6Ly9hcGkueGlubGFuZ2FwaS5jb20veGlubGFuZ2FwaS5waHAvcHJvdmlkZS92b2Q=") },
        { n: "无尽", u: atob("aHR0cHM6Ly9hcGkud2VqaW5hcGkubWUvYXBpLnBocC9wcm92aWRlL3ZvZA==") },
        { n: "闪电", u: atob("aHR0cHM6Ly94c2Quc2R6eWFwaS5jb20vYXBpLnBocC9wcm92aWRlL3ZvZA==") },
        { n: "U酷", u: atob("aHR0cHM6Ly9hcGkudWt1YXBpODguY29tL2FwaS5waHAvcHJvdmlkZS92b2Q=") },
        { n: "金鹰", u: atob("aHR0cHM6Ly9qeXp5YXBpLmNvbS9wcm92aWRlL3ZvZA==") },
        { n: "索尼", u: atob("aHR0cHM6Ly9zdW9uaWFwaS5jb20vYXBpLnBocC9wcm92aWRlL3ZvZA==") },
        { n: "虎牙", u: atob("aHR0cHM6Ly93d3cuaHV5YWFwaS5jb20vYXBpLnBocC9wcm92aWRlL3ZvZA==") },
        { n: "樱花", u: atob("aHR0cHM6Ly9tM3U4LmFwaXloenl5LmNvbS9hcGkucGhwL3NlYWNtcy92b2Q=") },
        { n: "快车", u: atob("aHR0cHM6Ly9jYWlqaS5rdWFpY2hlenkub3JnL2FwaS5waHAvcHJvdmlkZS92b2Q=") },
        { n: "红牛", u: atob("aHR0cHM6Ly93d3cuaG9uZ25pdXp5Mi5jb20vYXBpLnBocC9wcm92aWRlL3ZvZA==") },
        { n: "极速", u: atob("aHR0cHM6Ly9qc3p5YXBpLmNvbS9hcGkucGhwL3Byb3ZpZGUvdm9k") },
        { n: "光速", u: atob("aHR0cHM6Ly9hcGkuZ3VhbmdzdWFwaS5jb20vYXBpLnBocC9wcm92aWRlL3ZvZA==") },
        { n: "ikun", u: atob("aHR0cHM6Ly9pa3VuenlhcGkuY29tL2FwaS5waHAvcHJvdmlkZS92b2Q=") },
        { n: "牛牛", u: atob("aHR0cHM6Ly9hcGkubml1bml1enkubWUvYXBpLnBocC9wcm92aWRlL3ZvZA==") },
        { n: "鸭鸭", u: atob("aHR0cHM6Ly9jai55YXlhenkubmV0L2FwaS5waHAvcHJvdmlkZS92b2Q=") },
        { n: "速播", u: atob("aHR0cHM6Ly9zdWJvY2FpamkuY29tL2FwaS5waHAvcHJvdmlkZS92b2Q=") },
        { n: "360", u: atob("aHR0cHM6Ly8zNjB6eS5jb20vYXBpLnBocC9wcm92aWRlL3ZvZA==") },
        { n: "暴风", u: atob("aHR0cHM6Ly9iZnp5YXBpLmNvbS9hcGkucGhwL3Byb3ZpZGUvdm9k") },
        { n: "魔都", u: atob("aHR0cHM6Ly93d3cubWR6eWFwaS5jb20vYXBpLnBocC9wcm92aWRlL3ZvZA==") },
        { n: "豪华", u: atob("aHR0cHM6Ly9oaHp5YXBpLmNvbS9hcGkucGhwL3Byb3ZpZGUvdm9k") }
    ];

    const _PRIORITY_ORDER = ['西瓜', '天堂', '爱奇艺', '天涯', '如意', '茅台', '360'];
    const _LOW_PRIORITY = new Set(['暴风', '豪华']);

    const processApis = raw => {
        const m = new Map();
        raw.forEach(a => {
            if (!m.has(a.u)) m.set(a.u, { name: a.n, url: a.u, shortName: a.n });
        });
        const apis = [...m.values()];
        const rank = a => {
            const i = _PRIORITY_ORDER.indexOf(a.shortName);
            return i === -1 ? 999 : i;
        };
        const priority = apis.filter(a => ApiStats._priority.has(a.shortName)).sort((a, b) => rank(a) - rank(b));
        const low = apis.filter(a => _LOW_PRIORITY.has(a.shortName));
        const others = apis.filter(a => !ApiStats._priority.has(a.shortName) && !_LOW_PRIORITY.has(a.shortName));
        if (CONFIG.SMART_SORTING) {
            others.sort((a, b) =>
                ApiStats.score(ApiStats.get(b.shortName), b.shortName) -
                ApiStats.score(ApiStats.get(a.shortName), a.shortName));
        }
        return [...priority, ...others, ...low];
    };

    const UNIQUE_APIS = processApis(RAW_APIS);

    const State = {
        eps: [],
        curUrl: '',
        hiddenEl: null,
        panelOpen: false,
        curURL: location.href,
        dom: {},
        timers: {},
        cache: { key: null, results: [] },
        activeName: null,
        firstAuto: false,
        curEp: null,
        failed: new Set(),
        failedSources: new Set(),
        closed: false,
        searchId: 0,
        playing: false,
        switchCount: 0,
        stuckPending: false,
        isPageLoad: true,
        lastSwitchTime: 0,
        isAutoSwitch: false,
        playGeneration: 0
    };

    const resetFailState = (clearSwitch = true) => {
        if (clearSwitch) State.switchCount = 0;
        State.failed.clear();
        State.failedSources.clear();
    };

    function matchEpisodeEnhanced(epName, targetNum) {
        if (!epName || !targetNum) return false;
        const t = epName.trim();
        if (_NUM_ONLY_RE.test(t) && parseInt(t, 10) === parseInt(targetNum, 10)) return true;
        for (const re of _EP_PATTERNS) {
            const m = t.match(re);
            if (m && m[1] && parseInt(m[1], 10) === parseInt(targetNum, 10)) return true;
        }
        const idx = t.indexOf(targetNum);
        if (idx === -1) return false;
        const before = idx === 0 ? '' : t[idx - 1];
        const after = idx + targetNum.length >= t.length ? '' : t[idx + targetNum.length];
        return (/\D/.test(before) || idx === 0) && (/\D/.test(after) || idx + targetNum.length === t.length);
    }

    const onVideoPage = () => {
        if (CONFIG.VIDEO_URL_PATTERNS.some(p => p.test(location.href))) return true;
        const hn = location.hostname;
        if (/(miguvideo\.com|cmvideo\.cn)/.test(hn) &&
            document.querySelector('#wPlayer, [class*="migu-player"], [class*="commonPlayer"]')) return true;
        if (/(baofeng\.com|fun\.tv|funshion\.com|bfeng\.cn)/.test(hn) &&
            document.querySelector('#player-container, [class*="bf-player"], [class*="fun-player"], [id*="FunPlayer"]')) return true;
        return false;
    };

    // ===== UI =====
    const UI = {
        init() {
            document.getElementById('vip-root')?.remove();
            this._css();
            State.dom.c = this._el('div', { id: 'vip-root' });
            State.dom.btn = this._el('div', { id: 'vip-btn', title: '点击展开/解析VIP视频 (可拖拽)' });
            State.dom.btn.innerHTML = '<div class="vip-btn-inner"><span>VIP</span></div>';

            State.dom.p = this._el('div', { id: 'vip-panel' });
            State.dom.ov = this._el('div', { id: 'vip-overlay' });
            State.dom.ov.innerHTML = '<iframe id="vip-iframe" allow="autoplay; fullscreen; picture-in-picture; encrypted-media; gyroscope; accelerometer" referrerpolicy="no-referrer"></iframe><div id="vip-close" title="退出解析播放">✕</div>';

            document.body.append(State.dom.c, State.dom.ov);
            State.dom.c.append(State.dom.btn, State.dom.p);

            State.dom.ifr = document.getElementById('vip-iframe');
            State.dom.cls = document.getElementById('vip-close');
            State.dom.toast = this._el('div', { id: 'vip-toast' });
            document.body.append(State.dom.toast);

            this._drag();
            State.dom.cls.onclick = () => Player.close();

            State.dom.p.onmouseenter = () => clearTimer('panel_leave');
            State.dom.p.onmouseleave = () => {
                State.timers.panel_leave = setTimeout(() => {
                    if (State.panelOpen && !State.dom.btn.matches(':hover')) hideP();
                }, CONFIG.PANEL_LEAVE_CLOSE_DELAY);
            };

            window.addEventListener('resize', () => {
                clearTimer('resize');
                State.timers.resize = setTimeout(() => Player.repos(), 200);
            }, { passive: true });

            window.addEventListener('message', e => Player.onMsg(e), { passive: true });
        },

        _el: (tag, props = {}) => Object.assign(document.createElement(tag), props),

        _css() {
            GM_addStyle(`
                #vip-root { position: fixed; z-index: 2147483647; user-select: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
                #vip-btn { width: 44px; height: 44px; border-radius: 50%; background: linear-gradient(135deg, #2563eb, #7c3aed); cursor: grab; padding: 3px; box-sizing: border-box; box-shadow: 0 8px 24px rgba(124,58,237,.4), 0 0 0 2px rgba(255,255,255,.2); transition: transform .2s cubic-bezier(.34,1.56,.64,1), box-shadow .2s ease; display: flex; align-items: center; justify-content: center; }
                #vip-btn:hover { transform: scale(1.08); box-shadow: 0 10px 28px rgba(124,58,237,.6), 0 0 0 3px rgba(255,255,255,.4); }
                #vip-btn:active { cursor: grabbing; transform: scale(.95); }
                .vip-btn-inner { width: 100%; height: 100%; border-radius: 50%; background: rgba(15,23,42,.85); display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 800; font-size: 13px; letter-spacing: .5px; backdrop-filter: blur(4px); }
                .vip-btn-inner span { background: linear-gradient(120deg, #60a5fa, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
                #vip-btn.loading .vip-btn-inner span { display: none; }
                #vip-btn.loading .vip-btn-inner::after { content: ""; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.2); border-top-color: #a855f7; border-radius: 50%; animation: vip-spin .8s linear infinite; }
                @keyframes vip-spin { to { transform: rotate(360deg); } }
                #vip-panel { display: none; position: absolute; left: 54px; top: 0; width: 320px; max-height: 75vh; background: rgba(15,23,42,.88); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,.12); border-radius: 16px; padding: 12px; box-sizing: border-box; box-shadow: 0 20px 50px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.05); flex-direction: column; gap: 8px; color: #e2e8f0; will-change: transform; contain: layout style; }
                .vip-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(255,255,255,.06); border-radius: 10px; font-size: 13px; font-weight: 600; color: #93c5fd; }
                .vip-header-btn { cursor: pointer; padding: 2px 8px; border-radius: 6px; background: rgba(59,130,246,.2); border: 1px solid rgba(59,130,246,.3); color: #bfdbfe; font-size: 12px; transition: all .2s; }
                .vip-header-btn:hover { background: rgba(59,130,246,.4); color: #fff; }
                .vip-list-wrap { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; overflow-y: auto; max-height: 52vh; padding-right: 4px; box-sizing: border-box; }
                .vip-list-wrap.ep-mode { grid-template-columns: repeat(4, 1fr); }
                .vip-item-btn { display: flex; align-items: center; justify-content: center; padding: 8px 6px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.06); border-radius: 8px; color: #cbd5e1; font-size: 12px; font-weight: 500; cursor: pointer; transition: transform .15s ease, background .15s ease, border-color .15s ease, color .15s ease, box-shadow .15s ease; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; will-change: transform; contain: layout style; }
                .vip-item-btn:hover { background: rgba(124,58,237,.25); border-color: rgba(168,85,247,.4); color: #fff; transform: translateY(-1px); }
                .vip-item-btn.active { background: linear-gradient(135deg, #2563eb, #7c3aed) !important; border-color: transparent !important; color: #fff !important; box-shadow: 0 4px 12px rgba(124,58,237,.4); font-weight: 600; }
                .vip-item-btn .quality-badge { font-size: 10px; margin-left: 4px; opacity: .8; color: #38bdf8; }
                .vip-list-wrap::-webkit-scrollbar { width: 5px; }
                .vip-list-wrap::-webkit-scrollbar-thumb { background: rgba(255,255,255,.2); border-radius: 4px; }
                #vip-overlay { position: absolute; background: #000; z-index: 2147483646; display: none; border-radius: 4px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,.8); }
                #vip-iframe { width: 100%; height: 100%; border: none; display: block; }
                #vip-close { position: absolute; top: 12px; right: 12px; z-index: 2147483647; width: 32px; height: 32px; border-radius: 50%; background: rgba(15,23,42,.75); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,.2); color: #f1f5f9; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; transition: all .2s ease; }
                #vip-close:hover { background: #ef4444; border-color: #ef4444; color: #fff; transform: scale(1.1); }
                #vip-toast { position: fixed; top: 24px; left: 50%; transform: translateX(-50%) translateY(-20px); background: rgba(15,23,42,.92); backdrop-filter: blur(12px); color: #93c5fd; font-size: 13px; font-weight: 500; padding: 8px 18px; border-radius: 30px; border: 1px solid rgba(59,130,246,.3); box-shadow: 0 10px 30px rgba(0,0,0,.5); pointer-events: none; opacity: 0; z-index: 2147483647; transition: all .3s cubic-bezier(.34,1.56,.64,1); }
                #vip-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
            `);
        },

        _drag() {
            let isDragging = false, hasMoved = false, startX, startY, origLeft, origTop;
            const c = State.dom.c;
            const pos = GM_getValue(CONFIG.STORAGE_KEY_ICON_POSITION, { l: 20, t: 200 });
            c.style.left = `${pos.l}px`;
            c.style.top = `${pos.t}px`;

            const onMove = e => {
                if (!isDragging) return;
                const dx = e.clientX - startX, dy = e.clientY - startY;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
                if (!hasMoved) return;
                c.style.left = Math.max(8, Math.min(innerWidth - 52, origLeft + dx)) + 'px';
                c.style.top = Math.max(8, Math.min(innerHeight - 52, origTop + dy)) + 'px';
            };

            const onUp = () => {
                if (!isDragging) return;
                isDragging = false;
                document.body.style.userSelect = '';
                if (hasMoved) {
                    const rect = c.getBoundingClientRect();
                    const snapLeft = rect.left < innerWidth / 2 ? 14 : innerWidth - 58;
                    c.style.transition = 'left 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
                    c.style.left = `${snapLeft}px`;
                    setTimeout(() => { c.style.transition = ''; }, 300);
                    GM_setValue(CONFIG.STORAGE_KEY_ICON_POSITION, { l: snapLeft, t: rect.top });
                }
                removeEventListener('mousemove', onMove, true);
                removeEventListener('mouseup', onUp, true);
            };

            c.addEventListener('mousedown', e => {
                if (e.button !== 0 || e.target.closest('#vip-panel')) return;
                isDragging = true;
                hasMoved = false;
                startX = e.clientX;
                startY = e.clientY;
                const r = c.getBoundingClientRect();
                origLeft = r.left;
                origTop = r.top;
                document.body.style.userSelect = 'none';
                addEventListener('mousemove', onMove, true);
                addEventListener('mouseup', onUp, true);
            });

            State.dom.btn.onclick = e => {
                e.stopPropagation();
                if (hasMoved) return;
                if (State.panelOpen) {
                    hideP();
                } else if (State.cache.key === location.href && State.cache.results.length) {
                    State.closed = false;
                    showP();
                    renderSrc();
                } else {
                    showP();
                    Search.go();
                }
            };
        },

        _badge(r) {
            const pu = r.data?.vod_play_url || '';
            const cnt = pu.includes('$$$') ? pu.split('$$$').pop().split('#').length : (pu.includes('#') ? pu.split('#').length : 1);
            return r.resolution ? r.resolution + 'P' : cnt + '集';
        },

        _srcBtn(r) {
            const btn = UI._el('div', {
                className: `vip-item-btn ${r.name === State.activeName ? 'active' : ''}`,
                innerHTML: `<span>${r.name}</span><span class="quality-badge">${UI._badge(r)}</span>`,
                onclick() {
                    State.activeName = r.name;
                    UI.epList(r, false, State.curEp);
                }
            });
            btn.dataset.name = r.name;
            return btn;
        },

        addSrc(r) {
            const list = document.querySelector('#vip-list');
            if (!list || !State.panelOpen || list.classList.contains('ep-mode')) return;
            list.querySelector(`[data-name="${CSS.escape(r.name)}"]`)?.remove();
            list.appendChild(this._srcBtn(r));
        },

        epList(src, auto = false, cur = null, clearFailed = true) {
            if (State.closed) return;
            clearAll();
            const panel = State.dom.p;
            panel.innerHTML = '';

            const header = UI._el('div', { className: 'vip-header' });
            header.innerHTML = `<span>${src.name} - 选集</span><div class="vip-header-btn">‹ 返回源列表</div>`;
            header.querySelector('.vip-header-btn').onclick = () => renderSrc();

            const list = UI._el('div', { className: 'vip-list-wrap ep-mode', id: 'vip-list' });
            panel.append(header, list);

            State.eps = [];
            const pu = src.data?.vod_play_url || '';
            if (!pu) {
                header.querySelector('span').textContent = '该源无有效播放地址';
                Player._switchToNextAvailableSource(src.name);
                return;
            }

            const rawEps = pu.includes('$$$') ? pu.split('$$$').pop().split('#') : (pu.includes('#') ? pu.split('#') : [pu]);
            const frag = document.createDocumentFragment();
            let idx = 0;

            rawEps.forEach(epStr => {
                const [nm, uStr] = epStr.split('$');
                const name = (nm || '').trim();
                const url = (uStr || nm || '').trim();
                if (!name && !url) return;
                idx++;
                const finalName = name || `第${idx}集`;
                State.eps.push({ name: finalName, url });

                const btn = UI._el('div', {
                    className: 'vip-item-btn',
                    textContent: finalName,
                    onclick() {
                        const epNum = Utils.epNum(finalName);
                        if (epNum) State.curEp = epNum;
                        if (clearFailed) resetFailState();
                        Player.start(url);
                        UI.highlightPlayingEpisode(url);
                    }
                });
                btn.dataset.url = url;
                btn.dataset.name = finalName;
                frag.appendChild(btn);
            });

            list.appendChild(frag);
            _adjustPanelPosition();

            if (!cur) {
                if (auto && State.eps.length) {
                    const best = _bestMovie(State.eps);
                    if (best) {
                        UI.highlightPlayingEpisode(best.url);
                        if (clearFailed) resetFailState();
                        Player.start(best.url);
                    }
                }
                return;
            }

            const targetNum = String(parseInt(cur, 10));
            const btns = [...list.querySelectorAll('.vip-item-btn')];
            const matchedBtn = btns.find(b => matchEpisodeEnhanced(b.dataset.name, targetNum)) ||
                btns.find(b => b.dataset.name.includes(targetNum));

            if (matchedBtn) {
                matchedBtn.classList.add('active');
                setTimeout(() => matchedBtn.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
                if (auto) {
                    if (clearFailed) resetFailState();
                    Player.start(matchedBtn.dataset.url);
                }
            }
        },

        highlightPlayingEpisode(url) {
            const list = document.querySelector('#vip-list');
            if (!list) return;
            list.querySelectorAll('.vip-item-btn').forEach(b => b.classList.remove('active'));
            const target = list.querySelector(`[data-url="${CSS.escape(url)}"]`);
            if (target) {
                target.classList.add('active');
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        },

        toggleLoading: v => State.dom.btn?.classList.toggle('loading', v),
        toast(msg, time = 3000) {
            const t = State.dom.toast;
            if (!t) return;
            t.textContent = msg;
            t.classList.add('show');
            clearTimeout(State.timers.toast);
            State.timers.toast = setTimeout(() => t.classList.remove('show'), time);
        },
        dismissToast() {
            clearTimeout(State.timers.toast);
            if (State.dom.toast) State.dom.toast.classList.remove('show');
        }
    };

    function _adjustPanelPosition() {
        if (!State.dom.c || !State.dom.p) return;
        const r = State.dom.c.getBoundingClientRect();
        const panel = State.dom.p;
        if (r.right + 340 > innerWidth) {
            panel.style.left = 'auto';
            panel.style.right = '54px';
        } else {
            panel.style.left = '54px';
            panel.style.right = 'auto';
        }
    }

    function renderSrc() {
        const panel = State.dom.p;
        panel.innerHTML = '';
        _adjustPanelPosition();

        const header = UI._el('div', { className: 'vip-header' });
        header.innerHTML = `<span>解析源 (共 ${State.cache.results.length} 个)</span>`;

        const list = UI._el('div', { className: 'vip-list-wrap', id: 'vip-list' });
        panel.append(header, list);

        const frag = document.createDocumentFragment();
        State.cache.results.forEach(r => frag.appendChild(UI._srcBtn(r)));
        list.appendChild(frag);
    }

    function showP() {
        State.dom.p.style.display = 'flex';
        State.panelOpen = true;
        _adjustPanelPosition();
    }

    function hideP() {
        if (State.dom.p) State.dom.p.style.display = 'none';
        State.panelOpen = false;
        clearTimer('panel_leave');
    }

    function _bestMovie(eps) {
        let best = eps[0], bi = Infinity;
        for (const ep of eps) {
            for (let i = 0; i < CONFIG.MOVIE_PRIORITY.length; i++) {
                const kw = CONFIG.MOVIE_PRIORITY[i];
                if (ep.name === kw || ep.name.includes(kw)) {
                    if (i < bi) { bi = i; best = ep; }
                    break;
                }
            }
        }
        return best;
    }

    function clearTimer(t) {
        if (State.timers[t]) {
            clearTimeout(State.timers[t]);
            State.timers[t] = null;
        }
    }

    function clearAll() {
        for (const t in State.timers) {
            if (t !== 'toast') clearTimer(t);
        }
    }

    // ===== 搜索解析源 =====
    const Search = {
        async go() {
            clearAll();
            UI.toggleLoading(true);

            const title = Utils.title();
            if (!title) {
                UI.toast('无法获取视频标题，请在播放页重试');
                UI.toggleLoading(false);
                return;
            }

            const curEp = await Utils.curEp();
            const cacheKey = `${title}_${curEp || 'main'}`;

            if (!State.isPageLoad) {
                const cached = SearchCache.get(cacheKey);
                if (cached?.length) {
                    State.cache = { key: location.href, results: cached };
                    State.activeName = null;
                    State.firstAuto = false;
                    State.closed = false;
                    resetFailState();

                    const best = cached.find(r => r.score >= 50) || cached[0];
                    if (best) {
                        State.activeName = best.name;
                        UI.epList(best, true, curEp);
                        hideP();
                    } else {
                        showP();
                        renderSrc();
                    }
                    UI.toggleLoading(false);
                    return;
                }
            }

            State.isPageLoad = false;
            State.cache = { key: location.href, results: [] };
            State.activeName = null;
            State.firstAuto = false;
            State.closed = false;
            State.searchId = Date.now();
            State.curEp = curEp;

            renderSrc();
            this._search(title, curEp, State.searchId, cacheKey);
        },

        // 从 vod_play_url 中挑出目标播放地址
        _pickUrl(vodPlayUrl, curEp) {
            const eps = vodPlayUrl.split('$$$').pop().split('#');
            let targetUrl = null, isMatch = false, isMovie = false;
            const numEp = curEp ? String(parseInt(curEp, 10)) : null;
            const mEps = [], nmEps = [];

            for (const ep of eps) {
                const [nm] = ep.split('$');
                if (nm && CONFIG.MOVIE_KEYWORDS.test(nm.trim())) mEps.push(ep);
                else nmEps.push(ep);
            }

            const urlOf = ep => {
                const parts = ep.split('$');
                return parts[1] || parts[0];
            };

            if (mEps.length >= 1 && nmEps.length === 0) {
                isMovie = true;
                let pick = mEps[0], bi = Infinity;
                for (const ep of mEps) {
                    const tn = (ep.split('$')[0] || '').trim();
                    for (let i = 0; i < CONFIG.MOVIE_PRIORITY.length; i++) {
                        const kw = CONFIG.MOVIE_PRIORITY[i];
                        if (tn === kw || tn.includes(kw)) {
                            if (i < bi) { bi = i; pick = ep; }
                            break;
                        }
                    }
                }
                targetUrl = urlOf(pick);
            } else if (numEp && nmEps.length) {
                let te = nmEps.find(ep => {
                    const en = Utils.epNum(ep.split('$')[0]);
                    return en && String(parseInt(en, 10)) === numEp;
                });
                if (!te) te = nmEps.find(ep => (ep.split('$')[0] || '').includes(numEp));
                if (te) {
                    targetUrl = urlOf(te);
                    isMatch = true;
                }
            } else if (nmEps.length) {
                targetUrl = urlOf(nmEps[0] || eps[0]);
            } else if (eps[0]?.includes('$')) {
                targetUrl = urlOf(eps[0]);
            }
            return { targetUrl, isMatch, isMovie };
        },

        async _search(title, curEp, id, cacheKey) {
            const insertResult = item => {
                const idx = State.cache.results.findIndex(x => x.name === item.name);
                if (idx > -1) State.cache.results[idx] = item;
                else State.cache.results.push(item);
                State.cache.results.sort((a, b) => b.score - a.score);
                UI.addSrc(item);
            };

            const handleOneApi = async api => {
                if (State.closed || State.searchId !== id) return;
                const res = await this._one(api, title);
                if (!res) {
                    ApiStats.fail(api.name);
                    return;
                }
                ApiStats.ok(api.name, res.latency);
                if (State.closed || State.searchId !== id) return;

                const { targetUrl, isMatch, isMovie } = this._pickUrl(res.data.vod_play_url, curEp);
                if (!targetUrl) {
                    insertResult({ ...res, score: 50, resolution: 0 });
                    return;
                }

                const finalRes = {
                    ...res,
                    score: 50,
                    resolution: 0,
                    evaluatedUrl: targetUrl
                };
                insertResult(finalRes);

                if (!State.firstAuto && (isMovie || isMatch)) {
                    State.firstAuto = true;
                    State.activeName = finalRes.name;
                    resetFailState();
                    UI.epList(finalRes, true, isMovie ? null : State.curEp);
                    hideP();
                    UI.toast(`已自动优选: ${finalRes.name}`);
                }
            };

            const priorityApis = UNIQUE_APIS.filter(a => ApiStats._priority.has(a.shortName));
            const otherApis = UNIQUE_APIS.filter(a => !ApiStats._priority.has(a.shortName));

            await Utils.pool(8, priorityApis, handleOneApi).catch(() => {});
            Utils.pool(CONFIG.SEARCH_CONCURRENCY, otherApis, handleOneApi).then(() => {
                if (State.searchId !== id || State.closed) return;
                UI.toggleLoading(false);
                if (State.cache.results.length > 0) {
                    SearchCache.set(cacheKey, State.cache.results);
                } else {
                    UI.toast('未找到可用解析源，请重试');
                }
            });
        },

        async _one(api, title) {
            try {
                const wd = encodeURIComponent(title);
                const l = await Utils.req(`ac=list&wd=${wd}`, api);
                const items = l.data?.list;
                if (items?.length) {
                    const first = items[0];
                    if (first.vod_play_url) return { name: api.name, data: first, latency: l.latency };
                    const vd = await Utils.req(`ac=detail&ids=${first.vod_id}`, api);
                    const v = vd.data?.list?.[0];
                    if (v?.vod_play_url) return { name: api.name, data: v, latency: l.latency + vd.latency };
                }
                const d = await Utils.req(`ac=detail&wd=${wd}`, api);
                if (d.data?.list?.[0]?.vod_play_url) {
                    return { name: api.name, data: d.data.list[0], latency: d.latency };
                }
                return null;
            } catch (e) {
                return null;
            }
        }
    };

    // ===== 播放器 =====
    const Player = {
        _posRaf: null,
        _pos(attempt = 0) {
            if (State.closed || attempt > 8) return;
            if (this._posRaf) cancelAnimationFrame(this._posRaf);
            this._posRaf = requestAnimationFrame(() => {
                this._posRaf = null;
                let targetRect = null;
                if (!State.hiddenEl) State.hiddenEl = Utils.findPlayer();

                if (!State.hiddenEl) {
                    const v = document.querySelector('video');
                    if (v) {
                        let p = v.parentElement;
                        while (p && p.tagName !== 'BODY' && p.offsetHeight < 300) p = p.parentElement;
                        if (p && p.offsetHeight >= 300) {
                            State.hiddenEl = p;
                            State.hiddenEl.style.opacity = '0';
                        }
                    }
                }

                if (State.hiddenEl) {
                    try { targetRect = State.hiddenEl.getBoundingClientRect(); } catch (e) {}
                }

                if (targetRect && targetRect.width > 200 && targetRect.height > 100) {
                    State.dom.ov.style.cssText = `position:absolute;top:${targetRect.top + scrollY}px;left:${targetRect.left + scrollX}px;width:${targetRect.width}px;height:${targetRect.height}px;display:block;z-index:2147483646;`;
                } else if (State.curUrl && attempt > 4) {
                    State.dom.ov.style.cssText = 'position:fixed;top:50%;left:50%;width:86%;height:80%;transform:translate(-50%,-50%);display:block;z-index:2147483646;box-shadow:0 0 50px rgba(0,0,0,0.8);border-radius:8px;';
                } else {
                    setTimeout(() => this._pos(attempt + 1), 120);
                }
            });
        },

        async start(url) {
            if (State.closed) return;
            clearAll();
            hideP();
            const wasAutoSwitch = State.isAutoSwitch;
            if (!wasAutoSwitch) UI.dismissToast();
            State.curUrl = url;
            State.playGeneration++;
            UI.highlightPlayingEpisode(url);
            State.playing = true;
            this._pauseOrig();
            this._pos(0);
            State.dom.ov.style.display = 'block';
            const resolvedUrl = await Utils.resolveUrl(url);
            this._play(resolvedUrl, wasAutoSwitch);
        },

        async _play(url, wasAutoSwitch = false) {
            if (State.closed) return;
            clearTimer('stuck_watchdog');
            clearTimer('ifr_load');
            State.stuckPending = true;

            const myGeneration = State.playGeneration;
            const stuckTimeout = wasAutoSwitch
                ? CONFIG.STUCK_CHECK_TIMEOUT + 5000
                : CONFIG.STUCK_CHECK_TIMEOUT;

            State.timers.stuck_watchdog = setTimeout(() => {
                if (State.stuckPending && !State.closed && State.playGeneration === myGeneration) {
                    this._switch();
                }
            }, stuckTimeout);

            try {
                const html = await this._html(url, myGeneration);
                if (State.closed || State.playGeneration !== myGeneration) return;
                State.dom.ifr.srcdoc = html;
                State.dom.ifr.onload = () => {
                    if (State.closed || State.playGeneration !== myGeneration) return;
                    setTimeout(() => this.repos(), 100);
                };
            } catch (e) {
                if (!State.closed && State.playGeneration === myGeneration) this._switch();
            }
        },

        _switch() {
            if (State.closed) return;
            clearTimer('stuck_watchdog');
            clearTimer('pre_switch');
            clearTimer('ifr_load');

            const timeSinceLast = Date.now() - State.lastSwitchTime;
            const minInterval = 1500;
            if (timeSinceLast < minInterval) {
                if (!State.timers.pre_switch) {
                    State.timers.pre_switch = setTimeout(() => {
                        State.timers.pre_switch = null;
                        if (!State.closed && State.stuckPending) this._switch();
                    }, minInterval - timeSinceLast + 100);
                }
                return;
            }

            State.lastSwitchTime = Date.now();
            State.stuckPending = false;
            State.isAutoSwitch = true;
            UI.toast('当前线路加载较慢或受限，正在自动换源...');
            this._doSwitch();
        },

        // 在结果中找下一可用源
        _findNextEp(allowAnyEpisode) {
            const epNum = parseInt(State.curEp, 10);
            for (const r of State.cache.results) {
                if (State.failedSources.has(r.name) || !r.data?.vod_play_url) continue;
                const eps = r.data.vod_play_url.split('$$$').pop().split('#');
                let targetEp = null;
                if (!isNaN(epNum)) {
                    targetEp = eps.find(ep => matchEpisodeEnhanced(ep.split('$')[0], String(epNum)));
                }
                if (!targetEp && (allowAnyEpisode || eps.length)) targetEp = eps[0];
                if (targetEp) return { source: r, epStr: targetEp };
            }
            return null;
        },

        _playFromEp(source, epStr) {
            const u = epStr.split('$')[1];
            State.failed.clear();
            if (u) State.failed.add(u);
            State.activeName = source.name;
            UI.epList(source, true, State.curEp, false);
        },

        _doSwitch() {
            try {
                State.switchCount++;
                State.failed.add(State.curUrl);
                if (State.activeName) State.failedSources.add(State.activeName);

                if (State.failedSources.size >= State.cache.results.length) {
                    UI.toast('所有解析源已轮询完毕');
                    State.isAutoSwitch = false;
                    if (State.cache.results.length > 0) {
                        showP();
                        renderSrc();
                    }
                    return;
                }

                const found = this._findNextEp(true);
                if (found) {
                    this._playFromEp(found.source, found.epStr);
                } else {
                    UI.toast('其他解析源均无此集，无法自动切换');
                    State.isAutoSwitch = false;
                    if (State.cache.results.length > State.failedSources.size) {
                        showP();
                        renderSrc();
                    }
                }
            } catch (e) {}
        },

        _switchToNextAvailableSource(currentSourceName) {
            if (!State.cache.results.length) {
                UI.toast('没有可用的解析源');
                return;
            }

            State.failedSources.add(currentSourceName);
            const epNum = parseInt(State.curEp, 10);
            if (isNaN(epNum)) {
                UI.toast('无法识别当前集数，请手动选择集数');
                return;
            }

            const nextSource = State.cache.results.find(r => {
                if (State.failedSources.has(r.name) || !r.data?.vod_play_url) return false;
                const eps = r.data.vod_play_url.split('$$$').pop().split('#');
                return eps.some(ep => {
                    const [nm, u] = ep.split('$');
                    return matchEpisodeEnhanced(nm, String(epNum)) && !State.failed.has(u);
                });
            });

            if (nextSource) {
                UI.toast(`正在切换至线路: ${nextSource.name}`);
                State.activeName = nextSource.name;
                State.isAutoSwitch = true;
                setTimeout(() => {
                    if (!State.closed) UI.epList(nextSource, true, State.curEp, false);
                }, 300);
            } else {
                UI.toast('其他解析源均无此集，无法自动切换');
            }
        },

        async _html(url, generation = 0) {
            const cleanUrl = url.replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const [hlsCode, artCode] = await Promise.all([LibCache.getHls(), LibCache.getArt()]);
            const inline = (code, fallback) => code
                ? '<script>' + code + '<\/script>'
                : '<script src="' + fallback + '"><\/script>';
            const hlsScript = inline(hlsCode, 'https://fastly.jsdelivr.net/npm/hls.js@1.6.11/dist/hls.min.js');
            const artScript = inline(artCode, 'https://fastly.jsdelivr.net/npm/artplayer@5.4.0/dist/artplayer.min.js');
            const M = CONFIG.MESSAGES;

            return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>VIP Play</title>
    <style>
        html, body { width: 100%; height: 100%; margin: 0; padding: 0; background: #000; overflow: hidden; }
        .artplayer-app { width: 100%!important; height: 100%!important; }
        video { width: 100%!important; height: 100%!important; object-fit: contain; }
    </style>
    ${hlsScript}
    ${artScript}
</head>
<body>
    <div class="artplayer-app"></div>
    <script>
        var notifiedAlive = false;
        var _playGen = ${generation};
        function notifyAlive() {
            if (!notifiedAlive) {
                notifiedAlive = true;
                parent.postMessage({ type: '${M.STREAM_ALIVE}', _generation: _playGen }, '*');
            }
        }
        function postMsg(type) {
            parent.postMessage({ type: type, _generation: _playGen }, '*');
        }

        /* ===== 插播广告拦截 ===== */
        function filterAdsFromM3U8(m3u8Content) {
            if (!m3u8Content || typeof m3u8Content !== 'string') return m3u8Content;
            var adKeywords = ['sponsor', '/ad/', '/ads/', 'advert', 'advertisement', '/adjump', 'redtraffic', 'preroll', 'midroll', 'postroll'];
            var lines = m3u8Content.split('\\n');
            var filteredLines = [];
            var i = 0;
            while (i < lines.length) {
                var line = lines[i];
                if (line.indexOf('#EXT-X-DISCONTINUITY') > -1) { i++; continue; }
                if (line.indexOf('#EXTINF:') > -1 && i + 1 < lines.length) {
                    var nextLine = lines[i + 1].toLowerCase();
                    var isAd = adKeywords.some(function(k) { return nextLine.indexOf(k) > -1; });
                    var durMatch = line.match(/#EXTINF:([\\d.]+)/);
                    if (durMatch && parseFloat(durMatch[1]) < 0.5) isAd = true;
                    if (isAd) { i += 2; continue; }
                }
                filteredLines.push(line);
                i++;
            }
            return filteredLines.join('\\n');
        }
        function createAdBlockLoader(HlsLib) {
            var BaseLoader = HlsLib.DefaultConfig.loader;
            if (typeof BaseLoader !== 'function') return null;
            function AdBlockLoader(config) {
                BaseLoader.call(this, config);
                var _self = this;
                var _origLoad = this.load;
                this.load = function(context, cfg, callbacks) {
                    if (context.type === 'manifest' || context.type === 'level') {
                        var origOnSuccess = callbacks.onSuccess;
                        callbacks.onSuccess = function(response, stats, ctx) {
                            try {
                                if (response.data && typeof response.data === 'string') {
                                    response.data = filterAdsFromM3U8(response.data);
                                }
                            } catch (e) {}
                            return origOnSuccess(response, stats, ctx);
                        };
                    }
                    return _origLoad.call(_self, context, cfg, callbacks);
                };
            }
            try {
                AdBlockLoader.prototype = Object.create(BaseLoader.prototype);
                AdBlockLoader.prototype.constructor = AdBlockLoader;
            } catch (e) { return null; }
            return AdBlockLoader;
        }

        var art = new Artplayer({
            container: '.artplayer-app',
            url: '${cleanUrl}',
            autoplay: true,
            muted: false,
            fullscreen: true,
            pip: true,
            screenshot: true,
            setting: true,
            playbackRate: true,
            aspectRatio: true,
            theme: '#7c3aed',
            lang: 'zh-cn',
            miniProgressBar: true,
            moreVideoAttr: {
                playsinline: true,
                'webkit-playsinline': true,
                'x5-video-player-type': 'h5',
                preload: 'auto'
            },
            customType: {
                m3u8: function(video, url) {
                    if (typeof Hls === 'undefined') { postMsg('${M.PLAY_ERROR}'); return; }
                    if (Hls.isSupported()) {
                        var hlsConfig = {
                            enableWorker: true,
                            enableSoftwareAES: true,
                            lowLatencyMode: false,
                            backBufferLength: 30,
                            maxBufferLength: 30,
                            maxMaxBufferLength: 60,
                            maxBufferSize: 60 * 1000 * 1000,
                            manifestLoadingTimeOut: 10000,
                            manifestLoadingMaxRetry: 3,
                            fragLoadingTimeOut: 12000,
                            fragLoadingMaxRetry: 4,
                            appendErrorMaxRetry: 3,
                            startFragPrefetch: true,
                            testBandwidth: false,
                            xhrSetup: function(xhr) { xhr.withCredentials = false; }
                        };
                        try {
                            var AdLoader = createAdBlockLoader(Hls);
                            if (AdLoader) hlsConfig.loader = AdLoader;
                        } catch (e) {}
                        var hls = new Hls(hlsConfig);
                        video._hls = hls;
                        hls.on(Hls.Events.ERROR, function(event, data) {
                            if (data.fatal) {
                                switch (data.type) {
                                    case Hls.ErrorTypes.NETWORK_ERROR:
                                        hls.startLoad();
                                        break;
                                    case Hls.ErrorTypes.MEDIA_ERROR:
                                        hls.recoverMediaError();
                                        break;
                                    default:
                                        postMsg('${M.PLAY_ERROR}');
                                        break;
                                }
                            }
                        });
                        hls.loadSource(url);
                        hls.attachMedia(video);
                        art.on('destroy', function() { hls.destroy(); });
                    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                        video.src = url;
                    } else {
                        postMsg('${M.PLAY_ERROR}');
                    }
                }
            }
        });

        art.on('ready', function() {
            var playPromise = art.play();
            if (playPromise !== undefined) {
                playPromise.catch(function() {
                    art.video.muted = true;
                    art.play();
                });
            }
        });

        document.addEventListener('click', function() {
            if (art.video.muted) art.video.muted = false;
        }, { once: true });

        art.on('video:playing', function() {
            notifyAlive();
            postMsg('${M.PLAY_SUCCESS}');
        });
        art.on('video:timeupdate', function() {
            if (art.video.currentTime > 0.1) {
                notifyAlive();
                postMsg('${M.PLAY_SUCCESS}');
            }
        });
        art.on('error', function() { postMsg('${M.PLAY_ERROR}'); });
        art.on('video:ended', function() { postMsg('${M.VIDEO_ENDED}'); });
    <\/script>
</body>
</html>`;
        },

        onMsg(e) {
            const m = e.data;
            if (!m?.type || State.closed) return;
            if (m._generation !== undefined && m._generation !== State.playGeneration) return;

            if (m.type === CONFIG.MESSAGES.STREAM_ALIVE || m.type === CONFIG.MESSAGES.PLAY_SUCCESS) {
                clearTimer('stuck_watchdog');
                clearTimer('pre_switch');
                clearTimer('ifr_load');
                State.stuckPending = false;
                UI.dismissToast();
            } else if (m.type === CONFIG.MESSAGES.VIDEO_ENDED) {
                if (!State.curUrl || !State.eps.length) return;
                const idx = State.eps.findIndex(x => x.url === State.curUrl);
                if (idx > -1 && idx < State.eps.length - 1) {
                    const nextEp = State.eps[idx + 1];
                    const nextNum = Utils.epNum(nextEp.name);
                    if (nextNum) State.curEp = nextNum;
                    UI.toast(`即将自动播放: ${nextEp.name}`);
                    setTimeout(() => this.start(nextEp.url), CONFIG.AUTOPLAY_NEXT_DELAY);
                } else {
                    UI.toast('全剧已播放完毕');
                }
            } else if (m.type === CONFIG.MESSAGES.PLAY_ERROR) {
                this._switch();
            }
        },

        close() {
            clearAll();
            clearTimer('ifr_load');
            UI.toggleLoading(false);
            State.dom.ifr.src = 'about:blank';
            State.dom.ifr.srcdoc = '';
            State.dom.ov.style.display = 'none';

            if (State.hiddenEl) {
                State.hiddenEl.style.opacity = '';
                State.hiddenEl = null;
            }
            State.curUrl = '';
            State.playing = false;
            State.switchCount = 0;
            State.isAutoSwitch = false;
            resetFailState(false);
            State.stuckPending = false;
            State.closed = true;
        },

        _pauseOrig() {
            document.querySelectorAll('video, audio').forEach(m => {
                try {
                    if (!m.paused) m.pause();
                    m.muted = true;
                } catch (e) {}
            });
            State.hiddenEl = Utils.findPlayer();
            if (State.hiddenEl) State.hiddenEl.style.opacity = '0';
        },

        repos() {
            try {
                if (State.hiddenEl && State.dom.ov.style.display === 'block') {
                    const r = State.hiddenEl.getBoundingClientRect();
                    if (r.width > 50 && r.height > 50) {
                        State.dom.ov.style.cssText = `position:absolute;top:${r.top + scrollY}px;left:${r.left + scrollX}px;width:${r.width}px;height:${r.height}px;display:block;z-index:2147483646;`;
                    }
                }
            } catch (e) {}
        }
    };

    // ===== 工具 =====
    const Utils = {
        async pool(limit, array, iteratorFn) {
            const ret = [];
            const executing = new Set();
            for (const item of array) {
                const p = Promise.resolve().then(() => iteratorFn(item));
                ret.push(p);
                executing.add(p);
                const clean = () => executing.delete(p);
                p.then(clean).catch(clean);
                if (executing.size >= limit) await Promise.race(executing);
            }
            return Promise.all(ret);
        },

        req(param, api, retries = 1) {
            return new Promise((resolve, reject) => {
                const start = Date.now();
                let origin = '';
                try { origin = new URL(api.url).origin; } catch (e) {}

                const attemptReq = count => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: `${api.url}?${param}`,
                        headers: {
                            Referer: origin ? origin + '/' : '',
                            'User-Agent': navigator.userAgent,
                            Accept: 'application/json, text/plain, */*'
                        },
                        timeout: CONFIG.API_TIMEOUT,
                        onload: res => {
                            const latency = Date.now() - start;
                            if (res.status !== 200 || !res.responseText || res.responseText.trim().startsWith('<')) {
                                if (count < retries) return setTimeout(() => attemptReq(count + 1), 200);
                                return reject(new Error('resp_err'));
                            }
                            try {
                                resolve({ data: JSON.parse(res.responseText), latency });
                            } catch (e) {
                                if (count < retries) return setTimeout(() => attemptReq(count + 1), 200);
                                reject(new Error('json_err'));
                            }
                        },
                        onerror: () => {
                            if (count < retries) return setTimeout(() => attemptReq(count + 1), 200);
                            reject(new Error('net_err'));
                        },
                        ontimeout: () => {
                            if (count < retries) return setTimeout(() => attemptReq(count + 1), 200);
                            reject(new Error('timeout'));
                        }
                    });
                };
                attemptReq(0);
            });
        },

        resolveUrl(url) {
            return Promise.resolve(url);
        },

        // 在选择器列表中取第一个非空文本并清洗
        _textFromSelectors(selectors, clean) {
            for (const sel of selectors) {
                try {
                    const el = document.querySelector(sel);
                    if (!el) continue;
                    const t = (el.getAttribute('title') || el.getAttribute('content') || el.textContent || '').trim();
                    if (!t) continue;
                    const out = clean ? this._cleanTitle(t) : t;
                    if (out) return out;
                } catch (e) {}
            }
            return null;
        },

        _cleanTitle(t) {
            return t.split(_TITLE_SPLIT_RE)[0].replace(_EP_REMOVE_RE, '').trim();
        },

        title() {
            const hn = location.hostname;

            // 爱奇艺系
            if (/iqiyi\.com|iq\.com/.test(hn)) {
                const main = this._textFromSelectors([
                    '[data-ai-entity="视频名称、主标题"]',
                    '[data-ai-entity*="主标题"]',
                    '[data-ai-entity*="视频名称"]',
                    '[class*="meta_title"]',
                    '[class*="meta_titleNotCloud"]',
                    '[class*="meta_titleNewLabel"]',
                    '.album-head-title',
                    '[class*="episodeTitle"]'
                ], true);
                if (main) return main;
            }

            // 乐视
            if (/le\.com|letv\.com/.test(hn)) {
                const t = this._textFromSelectors([
                    '.j_jujiName', '.juji_bar', 'h1.title', '.detail-title', '.video-title',
                    '[class*="movieName"]', '[class*="videoName"]'
                ], true);
                if (t) return t;
            }

            // 站点精确主标题
            const matchKey = Object.keys(CONFIG.SELECTORS.PRECISE_MAIN_TITLE).find(k => hn.includes(k));
            if (matchKey) {
                const t = this._textFromSelectors(
                    CONFIG.SELECTORS.PRECISE_MAIN_TITLE[matchKey].split(',').map(s => s.trim()),
                    true
                );
                if (t) return t;
            }

            // 通用 AI / class 标题
            const t1 = this._textFromSelectors([
                '[data-ai-entity*="主标题"]',
                '[data-ai-entity*="视频名称"]',
                '[data-ai-entity*="标题"]',
                '[class*="meta_title"]',
                '[class*="videoTitle"]',
                '[class*="video-title"]',
                '[class*="mediaTitle"]'
            ], true);
            if (t1) return t1;

            // 快速选择器
            const t2 = this._textFromSelectors(CONFIG.SELECTORS.QUICK_TITLE, true);
            if (t2) return t2;

            return this._cleanTitle(document.title);
        },

        // 从字符串/元素文本中提取集数
        _epFromText(text) {
            if (!text) return null;
            const t = text.trim();
            if (_NUM_ONLY_RE.test(t)) return t;
            for (const re of _EP_PATTERNS) {
                const m = t.match(re);
                if (m?.[1]) return m[1];
            }
            const digits = t.match(/\d+/g);
            return digits ? digits[digits.length - 1] : null;
        },

        _epFromSelectors(selectors) {
            for (const sel of selectors) {
                try {
                    const el = document.querySelector(sel);
                    if (!el) continue;
                    const ep = this._epFromText(el.getAttribute('title') || el.textContent);
                    if (ep) return ep;
                } catch (e) {}
            }
            return null;
        },

        _epFromMeta() {
            const titleMatch = document.title.match(/第(\d+)集/);
            if (titleMatch) return titleMatch[1];
            const metas = document.querySelectorAll(
                'meta[property="og:title"], meta[itemprop="name"], meta[name="keywords"]'
            );
            for (const meta of metas) {
                const m = (meta.content || '').match(/第(\d+)集/);
                if (m) return m[1];
            }
            return null;
        },

        async curEp() {
            try {
                const url = location.href;
                const s4Match = url.match(/[?&]s4=(\d+)/i);
                if (s4Match) return s4Match[1];
                const tvnameMatch = url.match(/[?&]tvname=([^&]+)/i);
                if (tvnameMatch) {
                    const epMatch = decodeURIComponent(tvnameMatch[1]).match(/第(\d+)集/);
                    if (epMatch) return epMatch[1];
                }
                const p = new URLSearchParams(location.search || '');
                for (const key of ['s4', 'ep', 'episode', 'index']) {
                    const e = p.get(key);
                    if (e && /^\d+$/.test(e)) return e;
                }
                if (p.has('tvname')) {
                    const e = this.epNum(decodeURIComponent(p.get('tvname')));
                    if (e) return e;
                }
            } catch (e) {}

            const hn = location.hostname;

            // B站
            if (/bilibili\.com|b23\.tv/.test(hn)) {
                const ep = this._epFromMeta() || this._epFromSelectors([
                    '[class*="EpisodeVirtualList_numberTitle"]',
                    '[class*="numberListItem_select"] [class*="numberListItem_title"]',
                    '.ep-list-item.on .ep-item-title',
                    '[class*="episode_list"] [class*="selected"]',
                    '[class*="episode"][class*="active"]',
                    '[class*="ep-item"][class*="on"]',
                    '[class*="list-item"][class*="active"]',
                    '[class*="num-item"][class*="active"]',
                    '[class*="part-item"][class*="active"]'
                ]);
                if (ep) return ep;

                for (const btn of document.querySelectorAll('[class*="ep-item"], [class*="list-item"], [class*="part-item"]')) {
                    if (/active|on|selected|current/.test(btn.className)) {
                        const e = this.epNum(btn.textContent);
                        if (e) return e;
                    }
                }
            }

            // 爱奇艺
            if (/iqiyi\.com|iq\.com/.test(hn)) {
                const ep = this._epFromMeta() || this._epFromSelectors([
                    'span#text[style*="IQYHT-Bold"]',
                    '[class*="episodes"] [class*="active"] span[id="text"]',
                    '.qy-episode-item[class*="is-active"] a',
                    '[class*="selected"] .qy-episode-num',
                    '.album-list .is-active .title-content',
                    '[class*="episode"][class*="active"]',
                    '[class*="episodes_playingItem"] [class*="episodes_order"]'
                ]);
                if (ep) return ep;

                for (const el of document.querySelectorAll('span#text')) {
                    if ((el.getAttribute('style') || '').includes('IQYHT-Bold')) {
                        const t = el.textContent?.trim();
                        if (t && _NUM_ONLY_RE.test(t)) return t;
                    }
                }
            }

            // 芒果
            if (hn.includes('mgtv.com')) {
                const playing = document.querySelector('[class*="number-selector__playing"]');
                if (playing) {
                    const parent = playing.closest('[class*="number-selector__item"]');
                    const numEl = parent?.querySelector('[class*="number-selector__number"]');
                    if (numEl) {
                        const e = this.epNum(numEl.textContent);
                        if (e) return e;
                    }
                }
                const ep = this._epFromSelectors([
                    '[class*="number-selector__item--active"] [class*="number-selector__number"]',
                    '[class*="number-selector__number"][class*="on"]',
                    '[class*="number-selector"] [class*="on"]'
                ]);
                if (ep) return ep;

                for (const el of document.querySelectorAll('[class*="mgtv-player-aside-number-selector__number"]')) {
                    if (el.closest('[class*="active"], [class*="select"]')) {
                        const e = this.epNum(el.textContent);
                        if (e) return e;
                    }
                }
            }

            // 咪咕
            if (/miguvideo\.com|cmvideo\.cn/.test(hn)) {
                const title = document.querySelector('[class*="episodeTitle"][class*="oneline"][class*="on"], [class*="episodeTitle"][class*="on"]');
                if (title?.getAttribute('title')) {
                    const e = this.epNum(title.getAttribute('title').trim());
                    if (e) return e;
                }
                for (const item of document.querySelectorAll('[data-v-50548e8b].on')) {
                    for (const sp of item.querySelectorAll('span[data-v-50548e8b], span')) {
                        const t = sp.textContent.trim();
                        if (_NUM_ONLY_RE.test(t)) return t;
                    }
                    const own = item.textContent.trim();
                    if (_NUM_ONLY_RE.test(own)) return own;
                }
            }

            // 站点精确集数选择器
            const matchKey = Object.keys(CONFIG.SELECTORS.PRECISE_TITLE).find(k => hn.includes(k));
            if (matchKey) {
                const selectors = CONFIG.SELECTORS.PRECISE_TITLE[matchKey].split(',').map(s => s.trim());
                const ep = this._epFromSelectors(selectors);
                if (ep) return ep;
            }

            return this.epNum(document.title);
        },

        epNum(str) {
            if (!str) return null;
            const t = str.trim();
            if (_NUM_ONLY_RE.test(t)) return t;
            for (const re of _EP_PATTERNS) {
                const m = t.match(re);
                if (m?.[1]) return m[1];
            }
            const allDigits = t.match(/\d+/g);
            return allDigits ? allDigits[allDigits.length - 1] : null;
        },

        findPlayer() {
            for (const sel of CONFIG.SELECTORS.PLAYER_ELEMENTS) {
                const el = document.querySelector(sel);
                if (el && el.offsetHeight > 100) return el;
            }
            return null;
        }
    };

    // ===== 启动 =====
    function boot() {
        injectDnsHints([
            'caiji.xgzyapi.com', 'caiji.dyttzyapi.com', 'mujiziyuan00.com', 'iqiyizyapi.com',
            'api.maoyanapi.top', 'tyyszyapi.com', 'cj.rycjapi.com', 'cj.lziapi.com',
            'api.ffzyapi.com', 'caiji.kuaichezy.org', 'www.hongniuzy2.com', 'jszyapi.com',
            'api.guangsuapi.com', 'ikunzyapi.com', 'api.niuniuzy.me', 'cj.yayazy.net',
            'subocaiji.com', '360zy.com', 'bfzyapi.com', 'www.mdzyapi.com', 'hhzyapi.com',
            'fastly.jsdelivr.net', 'cdn.jsdelivr.net'
        ]);

        let initRetries = 0;
        const tryInit = () => {
            if (document.getElementById('vip-root')) return;
            if (onVideoPage()) {
                UI.init();
                setupSpaMonitor();
                return;
            }
            if (initRetries++ < 6) setTimeout(tryInit, 1000);
        };
        setTimeout(tryInit, 300);

        let debounceTimer = null;
        const triggerSpa = () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(handleSpaChange, CONFIG.SPA_DEBOUNCE);
        };

        const handleSpaChange = () => {
            if (State.closed && !onVideoPage()) return;
            const isVideo = onVideoPage();

            if (!isVideo) {
                if (State.dom.c) State.dom.c.style.display = 'none';
                return;
            }
            if (State.dom.c) State.dom.c.style.display = 'block';

            if (location.href !== State.curURL) {
                State.curURL = location.href;
                State.firstAuto = false;
                State.cache = { key: null, results: [] };
                State.isPageLoad = true;
                Player.close();
                hideP();
            }

            if (!document.getElementById('vip-root')) UI.init();
        };

        const setupSpaMonitor = () => {
            handleSpaChange();

            document.addEventListener('click', e => {
                if (State.playing) return;
                if (State.dom.c?.contains(e.target)) return;
                if (State.dom.ov?.contains(e.target)) return;
                if (e.target.closest?.('#vip-root, #vip-overlay, #vip-panel')) return;
                if (e.target.closest?.('a, .item, li, [role="button"]')) triggerSpa();
            }, true);

            window.addEventListener('popstate', triggerSpa, { passive: true });
            window.addEventListener('hashchange', triggerSpa, { passive: true });

            const origPush = history.pushState;
            const origReplace = history.replaceState;
            history.pushState = function () {
                origPush.apply(this, arguments);
                triggerSpa();
            };
            history.replaceState = function () {
                origReplace.apply(this, arguments);
                triggerSpa();
            };
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
