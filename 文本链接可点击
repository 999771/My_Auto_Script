// ==UserScript==
// @name         链接可点击
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  将纯文本链接转换为可点击链接，并通过替换元素的方式，强力清理各大网站的跳转链接。
// @author       caanyying
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 用于匹配URL的正则表达式
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

    /**
     * 核心函数：清理并替换跳转链接
     * @param {HTMLAnchorElement} linkElement - 需要处理的 <a> 标签
     */
    function cleanAndReplaceLink(linkElement) {
        const href = linkElement.href;
        const textContent = linkElement.textContent.trim();

        let realUrl = null;

        // 规则1: 处理贴吧、知道等百度系产品的跳转链接
        // 链接文本通常是真实URL
        if (textContent.match(urlRegex) && href.includes('jump.bdimg.com')) {
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

        // 如果找到了真实URL，则创建一个新链接并替换掉旧的
        if (realUrl && realUrl.startsWith('http')) {
            // 创建一个全新的、干净的 <a> 标签
            const newLink = document.createElement('a');
            newLink.href = realUrl;
            newLink.textContent = textContent; // 保持原有文本
            newLink.target = '_blank'; // 在新标签页打开
            newLink.rel = 'noopener noreferrer'; // 安全属性
            newLink.style.color = 'blue'; // 保持链接样式

            console.log(`[链接清理] 已替换跳转链接: ${href}  ->  ${realUrl}`);

            // 用新链接替换旧链接
            linkElement.parentNode.replaceChild(newLink, linkElement);
        }
    }


    /**
     * 遍历DOM节点，处理文本和链接。
     * @param {Node} node - 开始遍历的节点。
     */
    function walk(node) {
        // 跳过脚本和样式标签
        if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'SCRIPT' || node.tagName === 'STYLE')) {
            return;
        }

        let child = node.firstChild;
        while (child) {
            const next = child.nextSibling;

            if (child.nodeType === Node.TEXT_NODE) {
                // 确保不在 <a> 标签内部处理文本
                if (!child.parentElement.closest('a')) {
                    replaceTextWithLinks(child);
                }
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                if (child.tagName === 'A') {
                    cleanAndReplaceLink(child);
                } else {
                    // 递归处理子元素
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
                a.href = match;
                a.textContent = match;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.style.color = 'blue';
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

    // 初始处理整个页面
    walk(document.body);

    // 监听DOM变化，以处理动态加载的内容（例如Ajax加载的评论）
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
