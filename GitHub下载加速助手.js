// ==UserScript==
// @name         GitHub下载加速助手
// @namespace    https://github.com/
// @version      2.2.0
// @description  自动为GitHub下载链接添加代理前缀，支持多种加速服务
// @author       GitHub加速助手
// @match        https://github.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // 代理服务器列表
    const proxyServers = [
        { name: 'gh-proxy.org', url: 'https://gh-proxy.org/', default: true },
        { name: 'ghproxy.net', url: 'https://ghproxy.net/' },
        { name: 'gh.llkk.cc', url: 'https://gh.llkk.cc/' },
        { name: 'gh.halonice.com', url: 'http://gh.halonice.com/' },
        { name: 'gh.wsmdn.dpdns.org', url: 'https://gh.wsmdn.dpdns.org/' },
        { name: 'gh.jasonzeng.dev', url: 'https://gh.jasonzeng.dev/' },
        { name: 'github.tbedu.top', url: 'https://github.tbedu.top/' }
    ];

    // 获取当前选择的代理
    let currentProxy = GM_getValue('selectedProxy', proxyServers[0].url);

    // 添加样式
    GM_addStyle(`
        .gh-accelerator-btn {
            position: fixed;
            right: 20px;
            top: 50%;
            transform: translateY(-50%);
            width: 45px;
            height: 45px;
            background: #24292e;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: move;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            z-index: 10000;
            user-select: none;
        }

        .gh-accelerator-btn:hover {
            box-shadow: 0 4px 12px rgba(0,0,0,0.25);
        }

        .gh-accelerator-btn svg {
            width: 20px;
            height: 20px;
            fill: white;
            pointer-events: none;
        }

        .gh-accelerator-panel {
            position: fixed;
            right: 70px;
            top: 50%;
            transform: translateY(-50%);
            background: white;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
            padding: 20px;
            width: 280px;
            z-index: 10001;
            display: none;
        }

        .gh-accelerator-panel.show {
            display: block;
        }

        .gh-accelerator-panel h3 {
            margin: 0 0 15px 0;
            color: #24292e;
            font-size: 16px;
            font-weight: 600;
            border-bottom: 1px solid #e1e4e8;
            padding-bottom: 10px;
        }

        .proxy-option {
            display: flex;
            align-items: center;
            padding: 8px;
            margin: 4px 0;
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.2s;
        }

        .proxy-option:hover {
            background: #f6f8fa;
        }

        .proxy-option input[type="radio"] {
            margin-right: 10px;
        }

        .proxy-option label {
            flex: 1;
            cursor: pointer;
            color: #586069;
            font-size: 14px;
        }

        .proxy-option .proxy-url {
            font-size: 11px;
            color: #959da5;
            margin-top: 2px;
        }

        .panel-footer {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid #e1e4e8;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .toggle-switch {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 14px;
            color: #586069;
        }

        .switch {
            position: relative;
            width: 40px;
            height: 20px;
        }

        .switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: #d1d5da;
            transition: .3s;
            border-radius: 20px;
        }

        .slider:before {
            position: absolute;
            content: "";
            height: 16px;
            width: 16px;
            left: 2px;
            bottom: 2px;
            background-color: white;
            transition: .3s;
            border-radius: 50%;
        }

        input:checked + .slider {
            background-color: #0366d6;
        }

        input:checked + .slider:before {
            transform: translateX(20px);
        }
    `);

    // 创建控制按钮
    function createControlButton() {
        const button = document.createElement('div');
        button.className = 'gh-accelerator-btn';
        button.innerHTML = `
            <svg viewBox="0 0 24 24">
                <path d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z"/>
            </svg>
        `;

        // 拖动功能
        let isDragging = false;
        let currentX;
        let currentY;
        let initialX;
        let initialY;
        let xOffset = 0;
        let yOffset = 0;

        function dragStart(e) {
            if (e.type === "touchstart") {
                initialX = e.touches[0].clientX - xOffset;
                initialY = e.touches[0].clientY - yOffset;
            } else {
                initialX = e.clientX - xOffset;
                initialY = e.clientY - yOffset;
            }

            if (e.target.closest('.gh-accelerator-btn') === button) {
                isDragging = true;
                button.style.cursor = 'grabbing';
            }
        }

        function dragEnd(e) {
            initialX = currentX;
            initialY = currentY;
            isDragging = false;
            button.style.cursor = 'move';
        }

        function drag(e) {
            if (isDragging) {
                e.preventDefault();

                if (e.type === "touchmove") {
                    currentX = e.touches[0].clientX - initialX;
                    currentY = e.touches[0].clientY - initialY;
                } else {
                    currentX = e.clientX - initialX;
                    currentY = e.clientY - initialY;
                }

                xOffset = currentX;
                yOffset = currentY;

                button.style.transform = `translate(${currentX}px, ${currentY}px)`;

                // 更新面板位置
                const panel = document.querySelector('.gh-accelerator-panel');
                if (panel) {
                    const buttonRect = button.getBoundingClientRect();
                    panel.style.right = (window.innerWidth - buttonRect.left + 10) + 'px';
                    panel.style.top = buttonRect.top + 'px';
                    panel.style.transform = 'translateY(0)';
                }
            }
        }

        // 添加拖动事件监听
        button.addEventListener('mousedown', dragStart);
        document.addEventListener('mouseup', dragEnd);
        document.addEventListener('mousemove', drag);

        // 点击展开/收起
        button.addEventListener('click', function(e) {
            if (!isDragging) {
                e.stopPropagation();
                const panel = document.querySelector('.gh-accelerator-panel');
                panel.classList.toggle('show');
            }
        });

        return button;
    }

    // 创建设置面板
    function createSettingsPanel() {
        const panel = document.createElement('div');
        panel.className = 'gh-accelerator-panel';

        let proxyOptionsHTML = '';
        proxyServers.forEach(proxy => {
            const checked = proxy.url === currentProxy ? 'checked' : '';
            proxyOptionsHTML += `
                <div class="proxy-option">
                    <input type="radio" name="proxy" value="${proxy.url}" id="${proxy.name.replace(/\./g, '-')}" ${checked}>
                    <label for="${proxy.name.replace(/\./g, '-')}">
                        <div>${proxy.name}</div>
                        <div class="proxy-url">${proxy.url}</div>
                    </label>
                </div>
            `;
        });

        panel.innerHTML = `
            <h3>⚡ GitHub 加速设置</h3>
            <div class="proxy-options">
                ${proxyOptionsHTML}
            </div>
            <div class="panel-footer">
                <div class="toggle-switch">
                    <span>自动加速</span>
                    <label class="switch">
                        <input type="checkbox" id="autoAccelerate" checked>
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
        `;

        // 绑定代理选择事件
        panel.querySelectorAll('input[name="proxy"]').forEach(input => {
            input.addEventListener('change', function() {
                currentProxy = this.value;
                GM_setValue('selectedProxy', currentProxy);
                // 立即处理页面上的链接
                processDownloadLinks();
            });
        });

        // 绑定自动加速开关
        const autoAccelerateToggle = panel.querySelector('#autoAccelerate');
        autoAccelerateToggle.checked = GM_getValue('autoAccelerate', true);
        autoAccelerateToggle.addEventListener('change', function() {
            GM_setValue('autoAccelerate', this.checked);
            if (this.checked) {
                processDownloadLinks();
            } else {
                // 恢复原始链接
                restoreOriginalLinks();
            }
        });

        return panel;
    }

    // 恢复原始链接
    function restoreOriginalLinks() {
        document.querySelectorAll('a[data-original-href]').forEach(link => {
            link.href = link.dataset.originalHref;
            link.style.color = '';
            link.style.fontWeight = '';
            link.removeAttribute('download');
        });
    }

    // 处理下载链接
    function processDownloadLinks() {
        if (!GM_getValue('autoAccelerate', true)) return;

        // 查找所有可能的下载链接
        const selectors = [
            // Release下载链接
            'a[href*="/releases/download/"]',
            // 仓库归档
            'a[href*="/archive/"]',
            'a[href*=".zip"]',
            'a[href*=".tar.gz"]',
            // 文件下载
            'a[href*=".raw"]',
            // 各种文件格式
            'a[href*=".exe"]',
            'a[href*=".dmg"]',
            'a[href*=".deb"]',
            'a[href*=".rpm"]',
            'a[href*=".msi"]',
            'a[href*=".pkg"]',
            'a[href*=".apk"]',
            'a[href*=".ipa"]',
            // 按钮属性匹配
            'a[data-testid="download-button"]',
            'a[aria-label*="Download"]',
            'a[title*="Download"]'
        ];

        selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(link => {
                const href = link.href;
                // 检查是否是GitHub链接且未处理过
                if (href && href.includes('github.com') && !href.includes(currentProxy) && !link.dataset.processed) {
                    // 标记为已处理
                    link.dataset.processed = 'true';

                    // 保存原始链接
                    if (!link.dataset.originalHref) {
                        link.dataset.originalHref = href;
                    }

                    // 修复：直接在原始链接前面添加加速地址，而不是替换
                    let newHref = currentProxy + href;

                    // 确保直接下载
                    const fileName = href.split('/').pop();
                    if (fileName && (fileName.includes('.') || href.includes('/releases/download/') || href.includes('.raw'))) {
                        link.setAttribute('download', fileName);
                    }

                    // 设置新链接
                    link.href = newHref;

                    // 添加标记样式
                    link.style.color = '#0366d6';
                    link.style.fontWeight = '500';
                }
            });
        });

        // 处理特殊的下载按钮（通过文本内容）
        const downloadButtons = document.querySelectorAll('a, button');
        downloadButtons.forEach(element => {
            const text = element.textContent.trim();
            const href = element.href;

            // 检查是否是下载按钮且未处理过
            if ((text.includes('Download') || text.includes('下载')) &&
                href &&
                href.includes('github.com') &&
                !href.includes(currentProxy) &&
                !element.dataset.processed) {

                // 标记为已处理
                element.dataset.processed = 'true';

                // 保存原始链接
                if (!element.dataset.originalHref) {
                    element.dataset.originalHref = href;
                }

                // 修复：直接在原始链接前面添加加速地址，而不是替换
                let newHref = currentProxy + href;

                // 设置新链接
                element.href = newHref;

                // 添加标记样式
                element.style.color = '#0366d6';
                element.style.fontWeight = '500';
            }
        });
    }

    // 初始化
    function init() {
        // 创建UI元素
        const button = createControlButton();
        const panel = createSettingsPanel();

        document.body.appendChild(button);
        document.body.appendChild(panel);

        // 点击页面其他地方关闭面板
        document.addEventListener('click', function(e) {
            if (!e.target.closest('.gh-accelerator-btn') &&
                !e.target.closest('.gh-accelerator-panel')) {
                panel.classList.remove('show');
            }
        });

        // 初始处理链接
        processDownloadLinks();

        // 监听页面变化
        const observer = new MutationObserver(() => {
            processDownloadLinks();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // 注册菜单命令
        GM_registerMenuCommand('⚙️ 加速设置', function() {
            panel.classList.toggle('show');
        });
    }

    // 等待页面加载完成
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
