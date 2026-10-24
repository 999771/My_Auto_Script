// ==UserScript==
// @name         链接可点击
// @namespace    http://tampermonkey.net/
// @version      2.8
// @description  将纯文本链接转换为可点击链接，清理各大网站跳转链接，移除返利追踪参数，CPS返利链接红色背景标记
// @author       caanyying
// @match        *://*/*
// @grant        none
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='256' height='256' viewBox='0 0 24 24'%3E%3Cpath fill='currentColor' d='M21.92 6.62a1 1 0 0 0-.54-.54A1 1 0 0 0 21 6h-5a1 1 0 0 0 0 2h2.59L13 13.59l-3.29-3.3a1 1 0 0 0-1.42 0l-6 6a1 1 0 0 0 0 1.42a1 1 0 0 0 1.42 0L9 12.41l3.29 3.3a1 1 0 0 0 1.42 0L20 9.41V12a1 1 0 0 0 2 0V7a1 1 0 0 0-.08-.38'/%3E%3C/svg%3E
// ==/UserScript==

(function() {
    'use strict';

    // 用于匹配URL的正则表达式
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
    // 匹配 CPS路径返利链接 /cps/数字
    const cpsPathRegex = /\/cps\/\d+($|\?)/i;

    // 常见返利/推广/追踪参数列表，按需增删
    const TRACK_PARAMS = [
        'aff',
        'ref',
        'referrer',
        'referral',
        'refid',
        'ref_id',
        'affid',
        'aff_id',
        'affiliate',
        'affiliate_id',
        'aid',
        'rid',
        'rcid',
        'promo',
        'promoid',
        'promo_id',
        'campaign',
        'campaign_id',
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_term',
        'utm_content',
        'source',
        'track',
        'trackid',
        'track_id',
        'clickid',
        'click_id',
        'clkid',
        's1',
        's2',
        's3',
        'tag',
        'tid',
        'userid',
        'u_id'
    ];

    /**
     * 工具函数：移除列表内所有追踪返利查询参数
     * @param {string} urlStr
     * @returns {string} 清洗后url
     */
    function stripTrackParams(urlStr) {
        try {
            const urlObj = new URL(urlStr);
            TRACK_PARAMS.forEach(key => {
                urlObj.searchParams.delete(key);
            });
            return urlObj.toString();
        } catch (e) {
            // url解析失败原样返回
            return urlStr;
        }
    }

    /**
     * 核心函数：清理并替换跳转链接
     * @param {HTMLAnchorElement} linkElement - 需要处理的 <a> 标签
     */
    function cleanAndReplaceLink(linkElement) {
        const href = linkElement.href;
        const textContent = linkElement.textContent.trim();

        let realUrl = null;

        // ========== 规则0：CPS返利链接 ==========
        // 分支1：链接文本是URL，优先用文本替换（原有逻辑）
        if(cpsPathRegex.test(href) && textContent.match(urlRegex)){
            realUrl = textContent;
            console.log(`[CPS返利路径] 使用文本URL替换：${href} -> ${realUrl}`);
        }
        // 分支2：链接文本不是URL，红色背景标记，控制台告警
        else if(cpsPathRegex.test(href)){
            console.warn(`[CPS返利告警] 检测到返利跳转链接，无法自动解析重定向目标：${href}`);
            // 增加红色背景标记，加一点内边距方便识别
            linkElement.style.backgroundColor = '#ff4444';
            linkElement.style.color = '#fff';
            linkElement.style.padding = '2px 4px';
            linkElement.style.borderRadius = '3px';
            return;
        }
        // 规则1: 处理贴吧、知道等百度系产品的跳转链接
        else if (textContent.match(urlRegex) && href.includes('jump.bdimg.com')) {
            realUrl = textContent;
        }
        // 规则2: 处理知乎的跳转链接
        else if (href.includes('link.zhihu.com/?target=')) {
            try {
                const urlParams = new URL(href).searchParams;
                realUrl = urlParams.get('target');
            } catch (e) { /* 忽略解析错误 */ }
        }
        // 规则3: 处理B站的跳转链接
        else if (href.includes('bilibili.com/h5/note-app-view')) {
            try {
                const urlParams = new URL(href).searchParams;
                const cParam = urlParams.get('c');
                if (cParam) {
                    const decodedParams = JSON.parse(decodeURIComponent(cParam));
                    if (decodedParams && decodedParams.url) {
                        realUrl = decodedParams.url;
                    }
                }
            } catch (e) { /* 忽略解析错误 */ }
        }
        // 规则4: 通用规则，如果链接文本是URL且href是短链接服务
        else if (textContent.match(urlRegex) && (href.includes('t.cn/') || href.includes('url.cn/') || href.includes('dwz.cn/') || href.includes('j.mp/') || href.includes('bit.ly/'))) {
            realUrl = textContent;
        }

        // 普通a标签，没有跳转，仅清洗查询追踪参数
        if (!realUrl) {
            const cleanedHref = stripTrackParams(href);
            if (cleanedHref !== href) {
                linkElement.href = cleanedHref;
                console.log(`[追踪参数清理] ${href} -> ${cleanedHref}`);
            }
            return;
        }

        // 如果找到了真实URL，则创建一个新链接并替换掉旧的
        if (realUrl && realUrl.startsWith('http')) {
            const cleanRealUrl = stripTrackParams(realUrl);
            const newLink = document.createElement('a');
            newLink.href = cleanRealUrl;
            newLink.textContent = textContent;
            newLink.target = '_blank';
            newLink.rel = 'noopener noreferrer';

            console.log(`[链接清理] 已替换跳转链接: ${href}  ->  ${cleanRealUrl}`);
            linkElement.parentNode.replaceChild(newLink, linkElement);
        }
    }


    /**
     * 遍历DOM节点，处理文本和链接。
     * @param {Node} node - 开始遍历的节点。
     */
    function walk(node) {
        if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'SCRIPT' || node.tagName === 'STYLE')) {
            return;
        }

        let child = node.firstChild;
        while (child) {
            const next = child.nextSibling;

            if (child.nodeType === Node.TEXT_NODE) {
                if (!child.parentElement.closest('a')) {
                    replaceTextWithLinks(child);
                }
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                if (child.tagName === 'A') {
                    cleanAndReplaceLink(child);
                } else {
                    walk(child);
                }
            }
            child = next;
        }
    }

    /**
     * 将文本节点中的URL替换为<a>标签。
     * @param {Text} textNode - 包含URL的文本节点。
     */
    function replaceTextWithLinks(textNode) {
        const text = textNode.nodeValue;
        const matches = text.match(urlRegex);
        if (matches) {
            const fragment = document.createDocumentFragment();
            let lastIndex = 0;
            for (const match of matches) {
                const index = text.indexOf(match, lastIndex);
                if (index > lastIndex) {
                    fragment.appendChild(document.createTextNode(text.slice(lastIndex, index)));
                }
                const a = document.createElement('a');
                a.href = stripTrackParams(match);
                a.textContent = match;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                fragment.appendChild(a);
                lastIndex = index + match.length;
            }
            if (lastIndex < text.length) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
            }
            textNode.parentNode.replaceChild(fragment, textNode);
        }
    }

    // --- 初始化和监听 ---
    walk(document.body);

    const observer = new MutationObserver(function(mutations) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    walk(node);
                }
            }
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

})();
