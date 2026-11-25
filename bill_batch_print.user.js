// ==UserScript==
// @name         HRMS Bill Batch PDF Printer
// @namespace    http://tampermonkey.net/
// @version      1.1.1
// @description  Fetches HRMS bill report PDFs or date-range LOV bills inside mainFrame, merges them in memory, and triggers printing or Save As.
// @author       You
// @match        https://www.wbifms.gov.in/*
// @match        https://wbifms.gov.in/*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      wbifms.gov.in
// @connect      *
// ==/UserScript==

/* global PDFLib */

(function () {
    'use strict';

    // Skip <frameset> wrapper pages and LOV popup windows
    if (!document.body || document.body.tagName === 'FRAMESET' || document.body.classList.contains('lovbody')) {
        return;
    }

    // Skip top/left navigation panes
    const currentFrameName = (window.name || '').toLowerCase();
    if (currentFrameName === 'topframe' || currentFrameName === 'leftframe') {
        return;
    }

    const rootWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // -------------------------------------------------------------------------
    // Report definitions in exact print order with default copy counts
    // -------------------------------------------------------------------------
    const REPORT_CONFIGS = [
        {
            key: 'tr_18',
            label: 'TR 18 Details',
            copies: 1,
            selector: '#report_link_tr_18',
            textMatch: 'TR 18 Details',
        },
        {
            key: 'tr_10',
            label: 'TR 10 Details',
            copies: 1,
            selector: 'a[onclick*="openReport_tr_10"]',
            textMatch: 'TR 10 Details',
        },
        {
            key: 'tr_12',
            label: 'TR 12 Details',
            copies: 2,
            selector: 'a[onclick*="openReport_tr_12"]',
            textMatch: 'TR 12 Details',
        },
        {
            key: 'tr_46',
            label: 'TR 46 Details',
            copies: 2,
            selector: 'a[onclick*="openReport_tr_46"]',
            textMatch: 'TR 46 Details',
        },
        {
            key: 'tr_47',
            label: 'TR 47 Details',
            copies: 1,
            selector: 'a[onclick*="openReport_tr_47"]',
            textMatch: 'TR 47 Details',
        },
        {
            key: 'tr_53',
            label: 'TR 53 Details',
            copies: 1,
            selector: 'a[onclick*="openReport_tr_53"]',
            textMatch: 'TR 53 Details',
        },
        {
            key: 'tr_55',
            label: 'TR 55 Details',
            copies: 2,
            selector: 'a[onclick*="openReport_tr_55"]',
            textMatch: 'TR 55 Details',
        },
        {
            key: 'benf_list',
            label: 'Beneficiary List',
            copies: 1,
            selector: '#BENF_LIST_Ucm',
            textMatch: 'Benefically List',
        },
        {
            key: 'bill_wise_ss',
            label: 'Bill Wise Sanction Strength',
            copies: 1,
            selector: 'a[onclick*="openReport_bill_wise_ss"]',
            textMatch: 'Bill Wise Sanction Strength',
        },
    ];

    const CAPTURE_TIMEOUT_MS = 20000;
    const LOV_LOAD_TIMEOUT_MS = 20000;

    let isBusy = false;
    let stopRequested = false;
    let lastMergedBlobUrl = null;
    let lastPrintIframeBlobUrl = null;
    let printIframe = null;

    // Date-range LOV batch state
    let lovBills = [];
    let lastLovMergedBytes = null;
    let lastLovSuggestedName = 'merged_bills.pdf';
    const lovPdfCache = new Map(); // key: refNo -> Uint8Array

    const reportStates = REPORT_CONFIGS.map((cfg) => ({
        ...cfg,
        enabled: true,
        found: false,
        element: null,
        targetWin: null,
        status: 'Waiting',
        statusType: 'muted', // muted | ok | working | err | warn
    }));

    // -------------------------------------------------------------------------
    // General & Logging helpers
    // -------------------------------------------------------------------------
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const logLines = [];
    function log(msg) {
        const ts = new Date().toLocaleTimeString();
        const line = `[${ts}] ${msg}`;
        logLines.push(line);
        if (logLines.length > 300) logLines.shift();
        const logEl = document.getElementById('hrms-bp-log');
        if (logEl) {
            logEl.textContent = logLines.join('\n');
            logEl.scrollTop = logEl.scrollHeight;
        }
        console.log('[HRMS Bill Printer]', msg);
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // -------------------------------------------------------------------------
    // Recursive frame discovery (finds mainFrame or any nested same-origin frame)
    // -------------------------------------------------------------------------
    function getAccessibleWindows(win = rootWin, list = []) {
        list.push(win);
        try {
            const iframes = win.document.querySelectorAll('iframe, frame');
            for (const frame of iframes) {
                try {
                    const cw = frame.contentWindow;
                    if (cw && cw.document) {
                        getAccessibleWindows(cw, list);
                    }
                } catch (_) {
                    // Cross-origin frame, ignore
                }
            }
        } catch (_) {
            // Ignore access errors
        }
        return list;
    }

    function findDateRangeContext() {
        const wins = getAccessibleWindows(rootWin);
        for (const w of wins) {
            try {
                const doc = w.document;
                const fromEl = doc.getElementById('bilDate');
                const toEl = doc.getElementById('bilToDate');
                const lovBtn = doc.getElementById('lovRefPayment');
                if (fromEl && toEl && lovBtn) {
                    return {
                        win: w,
                        doc,
                        fromEl,
                        toEl,
                        lovBtn,
                        printBtn: doc.getElementById('print'),
                    };
                }
            } catch (_) {
                // Ignore
            }
        }
        return null;
    }

    function findLinkInWindow(win, cfg) {
        const doc = win.document;
        if (!doc) return null;

        if (cfg.selector) {
            const el = doc.querySelector(cfg.selector);
            if (el) return el;
        }

        if (cfg.textMatch) {
            const needle = cfg.textMatch.trim().toLowerCase();
            const links = doc.querySelectorAll('a.link_text, a');
            for (const a of links) {
                const txt = (a.textContent || '').trim().toLowerCase();
                if (txt === needle || txt.includes(needle)) {
                    return a;
                }
            }
        }
        return null;
    }

    function scanLinks(resetStatus = false) {
        const wins = getAccessibleWindows(rootWin);
        let foundCount = 0;

        for (const st of reportStates) {
            const wasFound = st.found;
            st.found = false;
            st.element = null;
            st.targetWin = null;

            for (const w of wins) {
                const el = findLinkInWindow(w, st);
                if (el) {
                    st.found = true;
                    st.element = el;
                    st.targetWin = w;
                    foundCount++;
                    break;
                }
            }

            if (!isBusy) {
                const isBasicStatus =
                    st.status === 'Waiting' || st.status === 'Found' || st.status === 'Not found';
                if (resetStatus || isBasicStatus || wasFound !== st.found) {
                    st.status = st.found ? 'Found' : 'Not found';
                    st.statusType = st.found ? 'ok' : 'muted';
                }
            }
        }

        updateDateRangeDetector();
        updateUI(foundCount);
        return foundCount;
    }

    function updateDateRangeDetector() {
        const ctx = findDateRangeContext();
        const pill = document.getElementById('hrms-bp-dr-detect');
        if (pill) {
            if (ctx) {
                pill.textContent = 'Form Ready';
                pill.className = 'hrms-bp-pill ok';
            } else {
                pill.textContent = 'Form Not Found';
                pill.className = 'hrms-bp-pill muted';
            }
        }
    }

    // -------------------------------------------------------------------------
    // PDF validation & network fetching
    // -------------------------------------------------------------------------
    function toLocalUint8Array(data) {
        if (!data) {
            throw new Error('Empty binary response');
        }
        if (data instanceof Uint8Array && data.buffer instanceof ArrayBuffer) {
            return data;
        }
        if (ArrayBuffer.isView(data)) {
            const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const copy = new Uint8Array(view.byteLength);
            copy.set(view);
            return copy;
        }
        const view = new Uint8Array(data);
        const copy = new Uint8Array(view.byteLength);
        copy.set(view);
        return copy;
    }

    function isPdfBytes(data) {
        if (!data || data.byteLength < 5) return false;
        const bytes = toLocalUint8Array(data);
        const view = bytes.subarray(0, Math.min(1024, bytes.byteLength));
        const header = String.fromCharCode(...view);
        return header.includes('%PDF-');
    }

    function fetchArrayBuffer(win, url, options = {}) {
        const method = (options.method || 'GET').toUpperCase();
        const headers = options.headers || {};
        const body = options.body || undefined;

        const fetchOpts = {
            method,
            credentials: 'include',
            headers,
        };
        if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
            fetchOpts.body = body;
        }

        return win.fetch(url, fetchOpts)
            .then(async (res) => {
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status} ${res.statusText}`);
                }
                const contentType = res.headers.get('content-type') || '';
                const buf = toLocalUint8Array(await res.arrayBuffer());
                return { buf, contentType, finalUrl: res.url || url };
            })
            .catch((fetchErr) => {
                if (typeof GM_xmlhttpRequest !== 'function') {
                    throw fetchErr;
                }
                log(`window.fetch failed (${fetchErr.message}); retrying via GM_xmlhttpRequest...`);
                return new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method,
                        url,
                        headers,
                        data: body instanceof URLSearchParams ? body.toString() : body,
                        responseType: 'arraybuffer',
                        onload: (resp) => {
                            if (resp.status >= 200 && resp.status < 300) {
                                const ctMatch = (resp.responseHeaders || '').match(/content-type:\s*([^\r\n]+)/i);
                                resolve({
                                    buf: toLocalUint8Array(resp.response),
                                    contentType: ctMatch ? ctMatch[1] : '',
                                    finalUrl: resp.finalUrl || url,
                                });
                            } else {
                                reject(new Error(`GM HTTP ${resp.status}`));
                            }
                        },
                        onerror: () => reject(new Error('GM_xmlhttpRequest network error')),
                        ontimeout: () => reject(new Error('GM_xmlhttpRequest timeout')),
                    });
                });
            });
    }

    async function fetchPdfWithHtmlFallback(win, url, options = {}, depth = 0) {
        const { buf, contentType, finalUrl } = await fetchArrayBuffer(win, url, options);

        if (isPdfBytes(buf)) {
            return buf;
        }

        if (depth < 2 && (/html|text/i.test(contentType) || !contentType)) {
            const html = new TextDecoder('utf-8').decode(buf);

            // 1. Inline base64 PDF
            const b64Match = html.match(/data:application\/pdf;base64,([A-Za-z0-9+/=\s]+)/i);
            if (b64Match) {
                const raw = atob(b64Match[1].replace(/\s+/g, ''));
                const bytes = new Uint8Array(raw.length);
                for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                if (isPdfBytes(bytes)) return bytes;
            }

            // 2. Embedded iframe/embed/object pointing to PDF
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const embedEl = doc.querySelector('iframe[src], embed[src], object[data]');
            if (embedEl) {
                const innerSrc = embedEl.getAttribute('src') || embedEl.getAttribute('data');
                if (innerSrc && innerSrc !== 'about:blank') {
                    const resolved = new URL(innerSrc, finalUrl).href;
                    log(`Following embedded PDF URL: ${resolved}`);
                    return fetchPdfWithHtmlFallback(win, resolved, { method: 'GET' }, depth + 1);
                }
            }

            // 3. Meta refresh redirect
            const metaRefresh = doc.querySelector('meta[http-equiv="refresh" i]');
            if (metaRefresh) {
                const content = metaRefresh.getAttribute('content') || '';
                const urlMatch = content.match(/url\s*=\s*['"]?([^'";]+)['"]?/i);
                if (urlMatch) {
                    const resolved = new URL(urlMatch[1].trim(), finalUrl).href;
                    log(`Following meta refresh: ${resolved}`);
                    return fetchPdfWithHtmlFallback(win, resolved, { method: 'GET' }, depth + 1);
                }
            }

            // 4. JS location redirect
            const locMatch = html.match(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i);
            if (locMatch) {
                const resolved = new URL(locMatch[1], finalUrl).href;
                log(`Following JS redirect: ${resolved}`);
                return fetchPdfWithHtmlFallback(win, resolved, { method: 'GET' }, depth + 1);
            }

            const snippet = html.replace(/\s+/g, ' ').slice(0, 160);
            throw new Error(`Response was not a PDF (${contentType || 'unknown'}): "${snippet}"`);
        }

        throw new Error(`Response was not a valid PDF (Content-Type: ${contentType || 'unknown'})`);
    }

    // -------------------------------------------------------------------------
    // Capture a report request from either direct href or onclick/button click
    // -------------------------------------------------------------------------
    function buildFormRequest(form, win) {
        const rawAction =
            typeof form.action === 'string' && form.action
                ? form.action
                : form.getAttribute('action') || '';
        const actionUrl = new URL(rawAction || win.location.href, win.location.href).href;
        const rawMethod =
            typeof form.method === 'string' && form.method
                ? form.method
                : form.getAttribute('method') || 'GET';
        const method = rawMethod.toUpperCase();
        const rawEnctype =
            typeof form.enctype === 'string' && form.enctype
                ? form.enctype
                : form.getAttribute('enctype') || 'application/x-www-form-urlencoded';
        const enctype = rawEnctype.toLowerCase();

        const fd = new win.FormData(form);
        if (method === 'GET') {
            const u = new URL(actionUrl);
            for (const [k, v] of fd.entries()) {
                u.searchParams.append(k, String(v));
            }
            return { url: u.href, options: { method: 'GET' } };
        }

        if (enctype.includes('multipart/form-data')) {
            return { url: actionUrl, options: { method, body: fd } };
        }

        const params = new URLSearchParams();
        for (const [k, v] of fd.entries()) {
            params.append(k, String(v));
        }
        return {
            url: actionUrl,
            options: {
                method,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: params,
            },
        };
    }

    async function captureReportRequest(state) {
        const el = state.element;
        const win = state.targetWin;
        if (!el || !win) {
            throw new Error('Trigger element not found');
        }

        // Case A: Direct href link (only for <a> without onclick)
        if (el.tagName === 'A') {
            const rawHref = (el.getAttribute('href') || '').trim();
            const hasOnclick = Boolean(el.getAttribute('onclick'));
            if (rawHref && rawHref !== '#' && !rawHref.toLowerCase().startsWith('javascript:') && !hasOnclick) {
                const url = new URL(rawHref, win.location.href).href;
                log(`[${state.label}] Direct href: ${url}`);
                return { url, options: { method: 'GET' } };
            }
        }

        // Case B: onclick handler (e.g., openReport_*() or getRpt())
        return new Promise((resolve, reject) => {
            let settled = false;
            const origOpen = win.open;
            const origRootOpen = rootWin && rootWin !== win ? rootWin.open : null;
            const origFormSubmit = win.HTMLFormElement.prototype.submit;
            const origAnchorClick = win.HTMLAnchorElement.prototype.click;

            const cleanup = () => {
                clearTimeout(timer);
                win.open = origOpen;
                if (origRootOpen) rootWin.open = origRootOpen;
                win.HTMLFormElement.prototype.submit = origFormSubmit;
                win.HTMLAnchorElement.prototype.click = origAnchorClick;
                win.document.removeEventListener('submit', onDocSubmit, true);
            };

            const finish = (req) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(req);
            };

            const fail = (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            };

            const handleUrl = (rawUrl, source) => {
                if (!rawUrl) return;
                const str = String(rawUrl).trim();
                if (!str || str === '#' || str === 'about:blank' || str.toLowerCase().startsWith('javascript:')) {
                    return;
                }
                const resolved = new URL(str, win.location.href).href;
                log(`[${state.label}] Captured via ${source}: ${resolved}`);
                finish({ url: resolved, options: { method: 'GET' } });
            };

            const onDocSubmit = (evt) => {
                if (evt.target && evt.target.tagName === 'FORM') {
                    evt.preventDefault();
                    evt.stopImmediatePropagation();
                    const req = buildFormRequest(evt.target, win);
                    log(`[${state.label}] Captured via submit event (${req.options.method}): ${req.url}`);
                    finish(req);
                }
            };

            const mockOpenFn = function (url) {
                if (url) {
                    handleUrl(url, 'window.open()');
                }
                const mockLocation = {
                    _href: '',
                    get href() { return this._href; },
                    set href(v) { this._href = v; handleUrl(v, 'popup.location.href'); },
                    assign(v) { handleUrl(v, 'popup.location.assign'); },
                    replace(v) { handleUrl(v, 'popup.location.replace'); },
                };
                return {
                    closed: false,
                    focus() {},
                    blur() {},
                    close() {},
                    print() {},
                    location: mockLocation,
                    document: {
                        open() {},
                        write(html) {
                            const m = String(html || '').match(/(?:src|href|action)\s*=\s*['"]([^'"]+)['"]/i);
                            if (m) handleUrl(m[1], 'popup.document.write');
                        },
                        close() {},
                    },
                };
            };

            win.document.addEventListener('submit', onDocSubmit, true);

            win.HTMLFormElement.prototype.submit = function () {
                const req = buildFormRequest(this, win);
                log(`[${state.label}] Captured via form.submit() (${req.options.method}): ${req.url}`);
                finish(req);
            };

            win.HTMLAnchorElement.prototype.click = function () {
                if (this === el) {
                    return origAnchorClick.apply(this, arguments);
                }
                const href = this.getAttribute('href') || this.href;
                if (href && href !== '#') {
                    handleUrl(href, 'anchor.click()');
                    return;
                }
                return origAnchorClick.apply(this, arguments);
            };

            win.open = mockOpenFn;
            if (origRootOpen) rootWin.open = mockOpenFn;

            const timer = setTimeout(() => {
                fail(new Error(`Timed out (${CAPTURE_TIMEOUT_MS / 1000}s) waiting for PDF trigger`));
            }, CAPTURE_TIMEOUT_MS);

            try {
                if (el.tagName === 'A') {
                    origAnchorClick.call(el);
                } else {
                    el.click();
                }
            } catch (err) {
                fail(new Error(`Click error: ${err.message}`));
            }
        });
    }

    // -------------------------------------------------------------------------
    // Feature 1: HRMS Bill Reports (9-report workflow)
    // -------------------------------------------------------------------------
    async function fetchAllSelectedPdfs() {
        const results = [];
        for (const st of reportStates) {
            if (!st.enabled) {
                st.status = 'Skipped';
                st.statusType = 'muted';
                updateUI();
                continue;
            }
            if (!st.found || !st.element) {
                st.status = 'Not found';
                st.statusType = 'warn';
                updateUI();
                continue;
            }
            const copies = Math.max(0, parseInt(st.copies, 10) || 0);
            if (copies === 0) {
                st.status = '0 copies';
                st.statusType = 'muted';
                updateUI();
                continue;
            }

            st.status = 'Capturing...';
            st.statusType = 'working';
            updateUI();

            try {
                const req = await captureReportRequest(st);
                st.status = 'Downloading...';
                updateUI();

                const pdfBytes = await fetchPdfWithHtmlFallback(st.targetWin, req.url, req.options);
                results.push({ state: st, copies, pdfBytes });

                st.status = `Ready (${(pdfBytes.byteLength / 1024).toFixed(0)} KB × ${copies})`;
                st.statusType = 'ok';
                updateUI();
            } catch (err) {
                log(`[${st.label}] ERROR: ${err.message}`);
                st.status = `Error: ${err.message.slice(0, 32)}`;
                st.statusType = 'err';
                updateUI();
            }
        }
        return results;
    }

    // -------------------------------------------------------------------------
    // Merge PDFs using pdf-lib
    // -------------------------------------------------------------------------
    function uint8ToBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    async function loadPdfDocSafely(pdfBytes) {
        const localBytes = toLocalUint8Array(pdfBytes);
        try {
            return await PDFLib.PDFDocument.load(localBytes, { ignoreEncryption: true });
        } catch (loadErr) {
            if (/must be of type/.test(String(loadErr && loadErr.message))) {
                return await PDFLib.PDFDocument.load(uint8ToBase64(localBytes), { ignoreEncryption: true });
            }
            throw loadErr;
        }
    }

    async function buildMergedPdf(fetchedItems, duplexPad) {
        if (typeof PDFLib === 'undefined') {
            throw new Error('pdf-lib failed to load. Check network/Tampermonkey @require cache.');
        }

        const mergedDoc = await PDFLib.PDFDocument.create();
        let totalPages = 0;

        for (const item of fetchedItems) {
            const { state, copies, pdfBytes } = item;
            const srcDoc = await loadPdfDocSafely(pdfBytes);
            const pageIndices = srcDoc.getPageIndices();
            const pageCount = pageIndices.length;

            for (let c = 0; c < copies; c++) {
                const copiedPages = await mergedDoc.copyPages(srcDoc, pageIndices);
                for (const p of copiedPages) {
                    mergedDoc.addPage(p);
                    totalPages++;
                }

                if (duplexPad && pageCount % 2 === 1) {
                    const lastPage = copiedPages[copiedPages.length - 1];
                    const { width, height } = lastPage.getSize();
                    mergedDoc.addPage([width, height]);
                    totalPages++;
                }
            }

            if (state) {
                state.status = `${pageCount}p × ${copies} merged`;
                state.statusType = 'ok';
                log(`[${state.label}] Added ${pageCount} page(s) × ${copies} copy(ies)`);
                updateUI();
            }
        }

        const mergedBytes = await mergedDoc.save();
        log(`Merged PDF ready: ${totalPages} total pages (${(mergedBytes.byteLength / 1024).toFixed(1)} KB)`);
        return { mergedBytes, totalPages };
    }

    // -------------------------------------------------------------------------
    // Save-As & Download helpers
    // -------------------------------------------------------------------------
    function triggerBrowserDownload(pdfBytes, filename) {
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    async function saveMergedPdfWithPrompt(pdfBytes, suggestedName) {
        const safeName = suggestedName.toLowerCase().endsWith('.pdf')
            ? suggestedName
            : `${suggestedName}.pdf`;

        // Native Save As dialog (choose exact folder + filename)
        if (typeof window.showSaveFilePicker === 'function') {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: safeName,
                    types: [
                        {
                            description: 'PDF Document',
                            accept: { 'application/pdf': ['.pdf'] },
                        },
                    ],
                });
                const writable = await handle.createWritable();
                await writable.write(pdfBytes);
                await writable.close();
                log(`Merged PDF saved via Save As dialog: ${handle.name}`);
                return { saved: true, cancelled: false, needsGesture: false };
            } catch (err) {
                if (err && err.name === 'AbortError') {
                    log('Save As dialog cancelled by user.');
                    return { saved: false, cancelled: true, needsGesture: false };
                }
                if (err && (err.name === 'SecurityError' || err.name === 'NotAllowedError')) {
                    log('Save As dialog needs a direct button click (user gesture expired).');
                    return { saved: false, cancelled: false, needsGesture: true };
                }
                log(`showSaveFilePicker error (${err.message}); falling back to filename prompt.`);
            }
        }

        // Fallback: ask for filename and trigger browser download
        const chosen = prompt('Enter file name for the merged PDF:', safeName);
        if (!chosen) {
            return { saved: false, cancelled: true, needsGesture: false };
        }
        const finalName = chosen.trim().toLowerCase().endsWith('.pdf')
            ? chosen.trim()
            : `${chosen.trim()}.pdf`;
        triggerBrowserDownload(pdfBytes, finalName);
        log(`Merged PDF downloaded as: ${finalName}`);
        return { saved: true, cancelled: false, needsGesture: false };
    }

    // -------------------------------------------------------------------------
    // Feature 2: Date-Range LOV Bill Fetcher & Merger (in-memory, merged save only)
    // -------------------------------------------------------------------------
    function setDatepickerValue(win, inputEl, isoDateStr) {
        const match = String(isoDateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) {
            throw new Error(`Invalid date: ${isoDateStr}`);
        }
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const dateObj = new Date(year, month - 1, day);
        const dd = String(day).padStart(2, '0');
        const mm = String(month).padStart(2, '0');
        const fallbackFormatted = `${dd}/${mm}/${year}`;

        const jq = win.jQuery || win.$;
        let usedDatepicker = false;

        if (jq && typeof jq === 'function') {
            try {
                const $el = jq(inputEl);
                if (typeof $el.datepicker === 'function' && $el.hasClass('hasDatepicker')) {
                    $el.datepicker('setDate', dateObj);
                    $el.trigger('change');
                    usedDatepicker = Boolean(inputEl.value && inputEl.value.trim());
                }
            } catch (e) {
                log(`jQuery datepicker setDate warning: ${e.message}`);
            }
        }

        if (!usedDatepicker) {
            const wasReadonly = inputEl.hasAttribute('readonly');
            if (wasReadonly) inputEl.removeAttribute('readonly');
            inputEl.value = fallbackFormatted;
            if (wasReadonly) inputEl.setAttribute('readonly', 'readonly');
            inputEl.dispatchEvent(new win.Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new win.Event('change', { bubbles: true }));
            inputEl.dispatchEvent(new win.Event('blur', { bubbles: true }));
        }

        log(`Set #${inputEl.id} = "${inputEl.value}" (from ${isoDateStr})`);
        return inputEl.value;
    }

    async function openLovPopupAndWait(ctx) {
        const { win, lovBtn } = ctx;
        const targets = [win];
        if (rootWin && rootWin !== win) {
            targets.push(rootWin);
        }

        const capturedWin = await new Promise((resolve, reject) => {
            let settled = false;
            const originals = targets.map((t) => ({ win: t, open: t.open }));

            const cleanup = () => {
                clearTimeout(timer);
                for (const item of originals) {
                    item.win.open = item.open;
                }
            };

            const finish = (popup) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(popup);
            };

            const fail = (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            };

            for (const item of originals) {
                item.win.open = function () {
                    const popup = item.open.apply(this, arguments);
                    if (!popup) {
                        fail(new Error('LOV popup was blocked by the browser.'));
                        return popup;
                    }
                    finish(popup);
                    return popup;
                };
            }

            const timer = setTimeout(() => {
                fail(new Error(`Timed out (${LOV_LOAD_TIMEOUT_MS / 1000}s) waiting for LOV popup to open.`));
            }, LOV_LOAD_TIMEOUT_MS);

            try {
                lovBtn.click();
            } catch (err) {
                fail(new Error(`Failed to click LOV icon: ${err.message}`));
            }
        });

        const start = Date.now();
        while (Date.now() - start < LOV_LOAD_TIMEOUT_MS) {
            if (capturedWin.closed) {
                throw new Error('LOV popup closed unexpectedly before loading.');
            }
            try {
                const pDoc = capturedWin.document;
                if (
                    pDoc &&
                    pDoc.readyState === 'complete' &&
                    pDoc.getElementById('tab1') &&
                    pDoc.querySelector('select[name="tab1_length"]')
                ) {
                    return capturedWin;
                }
            } catch (_) {
                // Popup still navigating/loading
            }
            await sleep(200);
        }

        throw new Error('Timed out waiting for LOV popup table (#tab1) to load.');
    }

    async function showAllLovEntries(lovWin) {
        const pDoc = lovWin.document;
        const lengthSel = pDoc.querySelector('select[name="tab1_length"]');
        if (!lengthSel) return;

        if (lengthSel.value !== '-1') {
            lengthSel.value = '-1';
            const jq = lovWin.jQuery || lovWin.$;
            if (jq && typeof jq === 'function') {
                jq(lengthSel).val('-1').trigger('change');
            } else {
                lengthSel.dispatchEvent(new lovWin.Event('change', { bubbles: true }));
            }
        }

        const expectedEl = pDoc.getElementById('hdnCountValue');
        const expectedCount = expectedEl ? parseInt(expectedEl.value, 10) || 0 : 0;

        const start = Date.now();
        let lastCount = -1;
        let stableTicks = 0;

        while (Date.now() - start < 8000) {
            const rows = pDoc.querySelectorAll('#tab1 tbody tr');
            const count = rows.length;
            if (expectedCount > 0 && count >= expectedCount) {
                await sleep(150);
                return;
            }
            if (count === lastCount && count > 0) {
                stableTicks++;
                if (stableTicks >= 3) return;
            } else {
                stableTicks = 0;
                lastCount = count;
            }
            await sleep(150);
        }
    }

    function readBillsFromLovTable(lovWin) {
        const pDoc = lovWin.document;
        const rows = pDoc.querySelectorAll('#tab1 tbody tr');
        const list = [];

        rows.forEach((tr) => {
            const tds = tr.querySelectorAll('td');
            if (tds.length < 2) return;
            const refNo = (tds[0].textContent || '').trim();
            const billNo = (tds[1].textContent || '').trim();
            if (!refNo && !billNo) return;
            const hiddenInput = tr.querySelector('input[type="hidden"]');
            list.push({
                refNo,
                billNo,
                billDate: tds[2] ? (tds[2].textContent || '').trim() : '',
                grossAmt: tds[3] ? (tds[3].textContent || '').trim() : '',
                netAmt: tds[4] ? (tds[4].textContent || '').trim() : '',
                tokenNo: tds[5] ? (tds[5].textContent || '').trim() : '',
                tokenDate: tds[6] ? (tds[6].textContent || '').trim() : '',
                rawVal: hiddenInput ? hiddenInput.value : '',
                selected: true,
                status: 'Pending',
                statusType: 'muted',
                error: '',
            });
        });

        return list;
    }

    async function loadBillsFromDateRange() {
        if (isBusy) return;
        const ctx = findDateRangeContext();
        if (!ctx) {
            alert('Could not find the Bill Date / LOV form (#bilDate, #bilToDate, #lovRefPayment) inside mainFrame.');
            return;
        }

        const fromInput = document.getElementById('hrms-bp-from-date');
        const toInput = document.getElementById('hrms-bp-to-date');
        const fromIso = fromInput ? fromInput.value : '';
        const toIso = toInput ? toInput.value : '';

        if (!fromIso || !toIso) {
            alert('Please select both From Date and To Date first.');
            return;
        }

        isBusy = true;
        setButtonsDisabled(true);
        setDrSummary('Loading bill list from LOV popup...', 'working');

        let lovWin = null;
        try {
            setDatepickerValue(ctx.win, ctx.fromEl, fromIso);
            setDatepickerValue(ctx.win, ctx.toEl, toIso);
            await sleep(250);

            log('Opening LOV popup to fetch all bill numbers...');
            lovWin = await openLovPopupAndWait(ctx);
            await showAllLovEntries(lovWin);

            lovBills = readBillsFromLovTable(lovWin);
            lovPdfCache.clear();
            lastLovMergedBytes = null;
            lastLovSuggestedName = `Merged_Bills_${fromIso}_to_${toIso}.pdf`;

            log(`Fetched ${lovBills.length} bill(s) from LOV table.`);
            if (lovBills.length === 0) {
                setDrSummary('No bills found for the selected date range.', 'warn');
            } else {
                setDrSummary(`Loaded ${lovBills.length} bill(s). Ready to fetch & merge.`, 'ok');
            }
            renderLovBillRows();
        } catch (err) {
            log(`LOV load ERROR: ${err.message}`);
            setDrSummary(`Error: ${err.message}`, 'err');
            alert(`Failed to load bills: ${err.message}`);
        } finally {
            if (lovWin && !lovWin.closed) {
                try { lovWin.close(); } catch (_) {}
            }
            isBusy = false;
            setButtonsDisabled(false);
            updateDrButtons();
        }
    }

    async function selectBillInLovPopup(lovWin, bill) {
        const pDoc = lovWin.document;

        await showAllLovEntries(lovWin);

        // Use search box to filter, then verify exact Ref No + Bill No match
        const searchInput = pDoc.querySelector('#tab1_filter input[type="text"], input[aria-controls="tab1"]');
        if (searchInput) {
            searchInput.value = bill.billNo;
            const jq = lovWin.jQuery || lovWin.$;
            if (jq && typeof jq === 'function') {
                jq(searchInput).val(bill.billNo).trigger('keyup').trigger('input');
            } else {
                searchInput.dispatchEvent(new lovWin.Event('input', { bubbles: true }));
                searchInput.dispatchEvent(new lovWin.KeyboardEvent('keyup', { bubbles: true }));
            }
            await sleep(250);
        }

        const findExactRow = () => {
            const rows = pDoc.querySelectorAll('#tab1 tbody tr');
            for (const tr of rows) {
                const tds = tr.querySelectorAll('td');
                if (tds.length < 2) continue;
                const rRef = (tds[0].textContent || '').trim();
                const rBill = (tds[1].textContent || '').trim();
                const hidden = tr.querySelector('input[type="hidden"]');
                if (bill.rawVal && hidden && hidden.value === bill.rawVal) {
                    return tr;
                }
                if (rRef === bill.refNo && rBill === bill.billNo) {
                    return tr;
                }
            }
            return null;
        };

        let targetRow = findExactRow();

        // Fallback: clear filter and scan full table if needed
        if (!targetRow && searchInput) {
            searchInput.value = '';
            const jq = lovWin.jQuery || lovWin.$;
            if (jq && typeof jq === 'function') {
                jq(searchInput).val('').trigger('keyup').trigger('input');
            } else {
                searchInput.dispatchEvent(new lovWin.Event('input', { bubbles: true }));
                searchInput.dispatchEvent(new lovWin.KeyboardEvent('keyup', { bubbles: true }));
            }
            await sleep(250);
            targetRow = findExactRow();
        }

        if (!targetRow) {
            throw new Error(`Exact row not found in LOV table for Bill "${bill.billNo}" (Ref ${bill.refNo})`);
        }

        if (typeof lovWin.selectAndClose === 'function') {
            lovWin.selectAndClose(targetRow);
        } else {
            targetRow.click();
            await sleep(100);
            const selBtn = pDoc.getElementById('select');
            if (selBtn) {
                selBtn.click();
            } else if (typeof lovWin.selectval === 'function') {
                lovWin.selectval();
            } else {
                targetRow.dispatchEvent(new lovWin.MouseEvent('dblclick', { bubbles: true }));
            }
        }

        const closeStart = Date.now();
        while (!lovWin.closed && Date.now() - closeStart < 5000) {
            await sleep(150);
        }
        if (!lovWin.closed) {
            try { lovWin.close(); } catch (_) {}
        }
    }

    async function runDateRangeBatch(onlyFailed = false) {
        if (isBusy) return;
        const ctx = findDateRangeContext();
        if (!ctx) {
            alert('Bill Date / LOV form is not visible in mainFrame.');
            return;
        }
        if (!ctx.printBtn) {
            alert('Show Report button (#print) not found in mainFrame.');
            return;
        }

        const targets = lovBills.filter((b) =>
            onlyFailed ? b.statusType === 'err' : b.selected
        );
        if (targets.length === 0) {
            alert(onlyFailed ? 'No failed bills to retry.' : 'No bills selected.');
            return;
        }

        const duplexEl = document.getElementById('hrms-bp-dr-duplex');
        const duplexPad = Boolean(duplexEl && duplexEl.checked);

        isBusy = true;
        stopRequested = false;
        setButtonsDisabled(true);
        const stopBtn = document.getElementById('hrms-bp-dr-stop');
        if (stopBtn) stopBtn.disabled = false;

        log(
            onlyFailed
                ? `Retrying ${targets.length} failed bill(s) (keeping ${lovPdfCache.size} previously succeeded PDF(s))...`
                : `Starting Date-Range batch for ${targets.length} bill(s)...`
        );

        for (let i = 0; i < targets.length; i++) {
            if (stopRequested) {
                log('Batch stopped by user.');
                break;
            }

            const bill = targets[i];

            // On a normal run, skip bills already fetched & cached in memory
            if (!onlyFailed && lovPdfCache.has(bill.refNo)) {
                const cached = lovPdfCache.get(bill.refNo);
                bill.status = `Cached (${(cached.byteLength / 1024).toFixed(0)} KB)`;
                bill.statusType = 'ok';
                renderLovBillRows();
                continue;
            }

            // Ensure retried bills are included in the final merge
            if (onlyFailed) {
                bill.selected = true;
            }

            bill.status = 'Opening LOV...';
            bill.statusType = 'working';
            bill.error = '';
            setDrSummary(
                `${onlyFailed ? 'Retrying' : 'Processing'} ${i + 1}/${targets.length}: Bill ${bill.billNo}`,
                'working'
            );
            renderLovBillRows();

            let lovWin = null;
            try {
                const liveCtx = findDateRangeContext();
                if (!liveCtx || !liveCtx.printBtn) {
                    throw new Error('Form or #print button disappeared from mainFrame.');
                }

                lovWin = await openLovPopupAndWait(liveCtx);
                bill.status = 'Selecting...';
                renderLovBillRows();

                await selectBillInLovPopup(lovWin, bill);
                await sleep(350);

                bill.status = 'Fetching PDF...';
                renderLovBillRows();

                const req = await captureReportRequest({
                    label: `Bill ${bill.billNo}`,
                    element: liveCtx.printBtn,
                    targetWin: liveCtx.win,
                });

                const pdfBytes = await fetchPdfWithHtmlFallback(liveCtx.win, req.url, req.options);
                lovPdfCache.set(bill.refNo, pdfBytes);

                bill.status = `Ready (${(pdfBytes.byteLength / 1024).toFixed(0)} KB)`;
                bill.statusType = 'ok';
                log(`[Bill ${bill.billNo}] PDF fetched in memory (${(pdfBytes.byteLength / 1024).toFixed(1)} KB).`);
            } catch (err) {
                bill.status = 'Failed';
                bill.statusType = 'err';
                bill.error = err.message;
                log(`[Bill ${bill.billNo}] FAILED: ${err.message}`);
            } finally {
                if (lovWin && !lovWin.closed) {
                    try { lovWin.close(); } catch (_) {}
                }
            }

            renderLovBillRows();
            await sleep(400);
        }

        // Collect ALL succeeded PDFs (previous successes + newly fetched/retried) in original table order
        const itemsToMerge = [];
        for (const b of lovBills) {
            if (b.selected && lovPdfCache.has(b.refNo)) {
                itemsToMerge.push({
                    state: null,
                    copies: 1,
                    pdfBytes: lovPdfCache.get(b.refNo),
                });
            }
        }

        const failedBills = lovBills.filter((b) => b.selected && b.statusType === 'err');

        try {
            if (itemsToMerge.length > 0) {
                setDrSummary(`Merging ${itemsToMerge.length} PDF(s)...`, 'working');
                const { mergedBytes, totalPages } = await buildMergedPdf(itemsToMerge, duplexPad);
                lastLovMergedBytes = mergedBytes;

                const saveRes = await saveMergedPdfWithPrompt(mergedBytes, lastLovSuggestedName);
                if (saveRes.saved) {
                    setDrSummary(
                        `Saved merged PDF: ${itemsToMerge.length} bill(s) (${totalPages} pages). Failed: ${failedBills.length}.`,
                        failedBills.length ? 'warn' : 'ok'
                    );
                } else if (saveRes.needsGesture) {
                    setDrSummary(
                        `Merged ${itemsToMerge.length} bill(s) (${totalPages}p)! Click "Save Merged PDF As..." to save.`,
                        'warn'
                    );
                } else {
                    setDrSummary(
                        `Merged ${itemsToMerge.length} bill(s) (${totalPages}p). Click "Save Merged PDF As..." anytime.`,
                        'ok'
                    );
                }
            } else {
                setDrSummary('No PDFs were generated.', 'err');
            }

            if (failedBills.length > 0) {
                const failList = failedBills
                    .map((b) => `• Bill ${b.billNo} (Ref ${b.refNo}): ${b.error || 'Unknown error'}`)
                    .join('\n');
                alert(
                    `Completed with ${failedBills.length} failed bill(s):\n\n${failList}\n\n` +
                    `Successfully merged: ${itemsToMerge.length} bill(s).\n` +
                    `Click "Retry Failed" to fetch only the failed ones and merge them with the ${itemsToMerge.length} already succeeded PDF(s).`
                );
            } else if (itemsToMerge.length > 0) {
                log(`All ${itemsToMerge.length} selected bill(s) merged with 0 failures.`);
            }
        } catch (err) {
            log(`Merge/Save ERROR: ${err.message}`);
            setDrSummary(`Merge Error: ${err.message}`, 'err');
            alert(`Merge Error: ${err.message}`);
        } finally {
            isBusy = false;
            stopRequested = false;
            setButtonsDisabled(false);
            updateDrButtons();
        }
    }

    // -------------------------------------------------------------------------
    // Printing / Opening / Downloading helpers (Feature 1)
    // -------------------------------------------------------------------------
    function printPdfBytesViaIframe(pdfBytes) {
        return new Promise((resolve) => {
            if (lastPrintIframeBlobUrl) {
                URL.revokeObjectURL(lastPrintIframeBlobUrl);
            }
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const blobUrl = URL.createObjectURL(blob);
            lastPrintIframeBlobUrl = blobUrl;

            if (printIframe && printIframe.parentNode) {
                printIframe.parentNode.removeChild(printIframe);
            }

            const iframe = document.createElement('iframe');
            iframe.style.position = 'fixed';
            iframe.style.right = '0';
            iframe.style.bottom = '0';
            iframe.style.width = '1px';
            iframe.style.height = '1px';
            iframe.style.opacity = '0.01';
            iframe.style.pointerEvents = 'none';
            iframe.style.border = '0';
            iframe.src = blobUrl;

            iframe.onload = () => {
                setTimeout(() => {
                    try {
                        iframe.contentWindow.focus();
                        iframe.contentWindow.print();
                    } catch (err) {
                        log(`Iframe print blocked (${err.message}); opening in new tab instead.`);
                        window.open(blobUrl, '_blank');
                    }
                    resolve(blobUrl);
                }, 600);
            };

            document.body.appendChild(iframe);
            printIframe = iframe;
        });
    }

    async function runMergedAction(mode) {
        if (isBusy) return;
        isBusy = true;
        setButtonsDisabled(true);
        scanLinks();

        try {
            const duplexEl = document.getElementById('hrms-bp-duplex');
            const duplexPad = Boolean(duplexEl && duplexEl.checked);
            log(`Starting batch (${mode}, duplexPad=${duplexPad})...`);
            const fetched = await fetchAllSelectedPdfs();

            if (fetched.length === 0) {
                alert('No PDFs could be fetched. Check the status/log in the Bill Printer panel.');
                return;
            }

            const { mergedBytes } = await buildMergedPdf(fetched, duplexPad);

            if (lastMergedBlobUrl) {
                URL.revokeObjectURL(lastMergedBlobUrl);
            }
            const blob = new Blob([mergedBytes], { type: 'application/pdf' });
            lastMergedBlobUrl = URL.createObjectURL(blob);

            if (mode === 'download') {
                await saveMergedPdfWithPrompt(
                    mergedBytes,
                    `bill_reports_${new Date().toISOString().slice(0, 10)}.pdf`
                );
            } else if (mode === 'tab') {
                window.open(lastMergedBlobUrl, '_blank');
            } else {
                await printPdfBytesViaIframe(mergedBytes);
            }
        } catch (err) {
            log(`FATAL: ${err.message}`);
            alert(`Bill Batch Print Error: ${err.message}`);
        } finally {
            isBusy = false;
            setButtonsDisabled(false);
            updateDrButtons();
        }
    }

    async function runSequentialPrint() {
        if (isBusy) return;
        isBusy = true;
        setButtonsDisabled(true);
        scanLinks();

        try {
            log('Starting sequential individual print...');
            const fetched = await fetchAllSelectedPdfs();
            if (fetched.length === 0) {
                alert('No PDFs could be fetched. Check the log in the Bill Printer panel.');
                return;
            }

            for (const item of fetched) {
                for (let copyNum = 1; copyNum <= item.copies; copyNum++) {
                    item.state.status = `Printing ${copyNum}/${item.copies}...`;
                    item.state.statusType = 'working';
                    updateUI();

                    log(`Printing [${item.state.label}] copy ${copyNum}/${item.copies}`);
                    await printPdfBytesViaIframe(item.pdfBytes);

                    const isLast =
                        item === fetched[fetched.length - 1] && copyNum === item.copies;
                    if (!isLast) {
                        const cont = confirm(
                            `Finished printing "${item.state.label}" (Copy ${copyNum} of ${item.copies}).\n\nClick OK to print the next report, or Cancel to stop.`
                        );
                        if (!cont) {
                            log('Sequential print stopped by user.');
                            return;
                        }
                    }
                }
                item.state.status = `Printed × ${item.copies}`;
                item.state.statusType = 'ok';
                updateUI();
            }
        } catch (err) {
            log(`FATAL: ${err.message}`);
            alert(`Sequential Print Error: ${err.message}`);
        } finally {
            isBusy = false;
            setButtonsDisabled(false);
            updateDrButtons();
        }
    }

    // -------------------------------------------------------------------------
    // Draggable utility (works for both panel header and launcher pill)
    // -------------------------------------------------------------------------
    function makeDraggable(targetEl, handleEl, onDragEnd) {
        let dragging = false;
        let moved = false;
        let startX = 0;
        let startY = 0;
        let origLeft = 0;
        let origTop = 0;

        handleEl.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target.closest('button') && handleEl !== targetEl) return;

            const rect = targetEl.getBoundingClientRect();
            dragging = true;
            moved = false;
            startX = e.clientX;
            startY = e.clientY;
            origLeft = rect.left;
            origTop = rect.top;

            targetEl.style.left = `${origLeft}px`;
            targetEl.style.top = `${origTop}px`;
            targetEl.style.right = 'auto';
            targetEl.style.bottom = 'auto';
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
                moved = true;
            }
            const maxLeft = Math.max(0, window.innerWidth - targetEl.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - targetEl.offsetHeight);
            const nextLeft = Math.min(maxLeft, Math.max(0, origLeft + dx));
            const nextTop = Math.min(maxTop, Math.max(0, origTop + dy));
            targetEl.style.left = `${nextLeft}px`;
            targetEl.style.top = `${nextTop}px`;
        });

        window.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            if (onDragEnd) onDragEnd(moved);
        });
    }

    // -------------------------------------------------------------------------
    // Floating UI Panel
    // -------------------------------------------------------------------------
    function injectStyles() {
        if (document.getElementById('hrms-bp-styles')) return;
        const style = document.createElement('style');
        style.id = 'hrms-bp-styles';
        style.textContent = `
            #hrms-bp-launcher {
                position: fixed;
                bottom: 16px;
                right: 16px;
                z-index: 2147483640;
                background: #1e40af;
                color: #fff;
                border: none;
                border-radius: 999px;
                padding: 10px 16px;
                font: 600 13px/1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
                cursor: grab;
                user-select: none;
                box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #hrms-bp-launcher:hover { background: #1d4ed8; }
            #hrms-bp-launcher .badge {
                background: rgba(255,255,255,0.22);
                padding: 2px 7px;
                border-radius: 999px;
                font-size: 11px;
            }
            #hrms-bp-panel {
                position: fixed;
                bottom: 64px;
                right: 16px;
                width: 470px;
                max-width: calc(100vw - 24px);
                max-height: calc(100vh - 80px);
                overflow-y: auto;
                z-index: 2147483641;
                background: #ffffff;
                color: #111827;
                border: 1px solid #d1d5db;
                border-radius: 10px;
                box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
                font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
                display: none;
            }
            #hrms-bp-panel.open { display: block; }
            .hrms-bp-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 14px;
                background: #1e3a8a;
                color: #fff;
                border-radius: 9px 9px 0 0;
                font-weight: 600;
                cursor: move;
                user-select: none;
            }
            .hrms-bp-header button {
                background: transparent;
                border: none;
                color: #fff;
                cursor: pointer;
                font-size: 18px;
                line-height: 1;
            }
            .hrms-bp-tabs {
                display: flex;
                border-bottom: 1px solid #e5e7eb;
                background: #f9fafb;
            }
            .hrms-bp-tab {
                flex: 1;
                padding: 8px 10px;
                border: none;
                background: transparent;
                font: 600 12px/1.2 system-ui, sans-serif;
                color: #4b5563;
                cursor: pointer;
                border-bottom: 2px solid transparent;
            }
            .hrms-bp-tab.active {
                color: #1e40af;
                background: #ffffff;
                border-bottom-color: #1e40af;
            }
            .hrms-bp-pane { display: none; }
            .hrms-bp-pane.active { display: block; }
            .hrms-bp-body { padding: 12px 14px; }
            .hrms-bp-table {
                width: 100%;
                border-collapse: collapse;
                margin-bottom: 10px;
                font-size: 12px;
            }
            .hrms-bp-table th, .hrms-bp-table td {
                padding: 5px 4px;
                border-bottom: 1px solid #f3f4f6;
                text-align: left;
                vertical-align: middle;
            }
            .hrms-bp-table input[type="number"] {
                width: 44px;
                padding: 2px 4px;
                border: 1px solid #d1d5db;
                border-radius: 4px;
                text-align: center;
            }
            .hrms-bp-scroll {
                max-height: 210px;
                overflow-y: auto;
                border: 1px solid #e5e7eb;
                border-radius: 6px;
                margin-bottom: 10px;
            }
            .hrms-bp-scroll .hrms-bp-table { margin-bottom: 0; }
            .hrms-bp-scroll thead th {
                position: sticky;
                top: 0;
                background: #f9fafb;
                z-index: 1;
            }
            .hrms-bp-dates {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 8px;
                margin-bottom: 8px;
            }
            .hrms-bp-dates label {
                display: flex;
                flex-direction: column;
                gap: 3px;
                font-size: 11px;
                font-weight: 600;
                color: #374151;
            }
            .hrms-bp-dates input[type="date"] {
                padding: 5px 6px;
                border: 1px solid #d1d5db;
                border-radius: 5px;
                font: 12px system-ui, sans-serif;
            }
            .hrms-bp-dr-bar {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;
                margin-bottom: 8px;
                font-size: 12px;
            }
            .hrms-bp-summary {
                padding: 6px 8px;
                border-radius: 6px;
                font-size: 12px;
                margin-bottom: 8px;
                background: #f3f4f6;
                color: #374151;
            }
            .hrms-bp-summary.ok      { background: #dcfce7; color: #166534; }
            .hrms-bp-summary.working { background: #dbeafe; color: #1e40af; }
            .hrms-bp-summary.warn    { background: #fef3c7; color: #92400e; }
            .hrms-bp-summary.err     { background: #fee2e2; color: #991b1b; }
            .hrms-bp-pill {
                display: inline-block;
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 11px;
                font-weight: 500;
                white-space: nowrap;
            }
            .hrms-bp-pill.muted   { background: #f3f4f6; color: #6b7280; }
            .hrms-bp-pill.ok      { background: #dcfce7; color: #166534; }
            .hrms-bp-pill.working { background: #dbeafe; color: #1e40af; }
            .hrms-bp-pill.warn    { background: #fef3c7; color: #92400e; }
            .hrms-bp-pill.err     { background: #fee2e2; color: #991b1b; }
            .hrms-bp-opt {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 12px;
                color: #374151;
                margin-bottom: 8px;
            }
            .hrms-bp-actions {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px;
                margin-bottom: 8px;
            }
            .hrms-bp-btn {
                padding: 8px 10px;
                border-radius: 6px;
                border: 1px solid #d1d5db;
                background: #f9fafb;
                color: #111827;
                font: 600 12px/1.2 system-ui, sans-serif;
                cursor: pointer;
            }
            .hrms-bp-btn:hover:not(:disabled) { background: #f3f4f6; }
            .hrms-bp-btn.primary {
                grid-column: 1 / -1;
                background: #1e40af;
                color: #fff;
                border-color: #1e40af;
            }
            .hrms-bp-btn.primary:hover:not(:disabled) { background: #1d4ed8; }
            .hrms-bp-btn.danger {
                background: #fee2e2;
                color: #991b1b;
                border-color: #fca5a5;
            }
            .hrms-bp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
            #hrms-bp-log {
                background: #111827;
                color: #e5e7eb;
                font: 11px/1.35 Consolas, monospace;
                padding: 8px;
                border-radius: 6px;
                max-height: 120px;
                overflow-y: auto;
                white-space: pre-wrap;
                word-break: break-all;
                margin-top: 6px;
            }
        `;
        document.head.appendChild(style);
    }

    function setDrSummary(text, type = 'muted') {
        const el = document.getElementById('hrms-bp-dr-summary');
        if (!el) return;
        el.textContent = text;
        el.className = `hrms-bp-summary ${type}`;
    }

    function renderLovBillRows() {
        const tbody = document.getElementById('hrms-bp-dr-rows');
        if (!tbody) return;

        if (lovBills.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#6b7280;padding:12px;">Select dates and click "Fetch Bill List"</td></tr>`;
            updateDrButtons();
            return;
        }

        tbody.innerHTML = lovBills
            .map(
                (b, idx) => `
                <tr title="Ref: ${escapeHtml(b.refNo)} | Date: ${escapeHtml(b.billDate)} | Net: ${escapeHtml(b.netAmt)}${b.error ? ' | Error: ' + escapeHtml(b.error) : ''}">
                    <td><input type="checkbox" class="hrms-bp-dr-chk" data-idx="${idx}" ${b.selected ? 'checked' : ''} /></td>
                    <td><strong>${escapeHtml(b.billNo)}</strong><br><span style="font-size:10px;color:#6b7280;">${escapeHtml(b.refNo)}</span></td>
                    <td>${escapeHtml(b.billDate)}</td>
                    <td><span class="hrms-bp-pill ${b.statusType}">${escapeHtml(b.status)}</span></td>
                </tr>`
            )
            .join('');

        updateDrButtons();
    }

    function updateDrButtons() {
        const selectedCount = lovBills.filter((b) => b.selected).length;
        const failedCount = lovBills.filter((b) => b.statusType === 'err').length;

        const runBtn = document.getElementById('hrms-bp-dr-run');
        if (runBtn) {
            runBtn.textContent = `📥 Fetch & Merge Selected (${selectedCount})`;
            runBtn.disabled = isBusy || selectedCount === 0;
        }

        const retryBtn = document.getElementById('hrms-bp-dr-retry');
        if (retryBtn) {
            retryBtn.textContent = `🔁 Retry Failed (${failedCount})`;
            retryBtn.disabled = isBusy || failedCount === 0;
        }

        const saveBtn = document.getElementById('hrms-bp-dr-save');
        if (saveBtn) {
            saveBtn.disabled = isBusy || !lastLovMergedBytes;
        }

        const stopBtn = document.getElementById('hrms-bp-dr-stop');
        if (stopBtn) {
            stopBtn.disabled = !isBusy;
        }
    }

    function createUI() {
        if (document.getElementById('hrms-bp-launcher')) return;
        injectStyles();

        const launcher = document.createElement('button');
        launcher.id = 'hrms-bp-launcher';
        launcher.title = 'Click to open, drag to move';
        launcher.innerHTML = `<span>🖨️ Bill Print</span><span class="badge" id="hrms-bp-badge">0/${REPORT_CONFIGS.length}</span>`;

        let launcherWasDragged = false;
        makeDraggable(launcher, launcher, (moved) => {
            launcherWasDragged = moved;
            if (moved) {
                setTimeout(() => { launcherWasDragged = false; }, 100);
            }
        });

        launcher.addEventListener('click', () => {
            if (launcherWasDragged) return;
            const panel = document.getElementById('hrms-bp-panel');
            panel.classList.toggle('open');
            if (panel.classList.contains('open')) {
                scanLinks();
            }
        });

        const panel = document.createElement('div');
        panel.id = 'hrms-bp-panel';
        panel.innerHTML = `
            <div class="hrms-bp-header" id="hrms-bp-drag-handle" title="Drag to move panel">
                <span>⋮⋮ HRMS Bill Batch Printer</span>
                <button id="hrms-bp-close" title="Close">&times;</button>
            </div>
            <div class="hrms-bp-tabs">
                <button class="hrms-bp-tab active" data-tab="hrms">HRMS Reports</button>
                <button class="hrms-bp-tab" data-tab="daterange">Date-Range Bills</button>
            </div>
            <div class="hrms-bp-body">
                <!-- TAB 1: Existing HRMS 9-Report Batch Printer -->
                <div class="hrms-bp-pane active" id="hrms-bp-pane-hrms">
                    <table class="hrms-bp-table">
                        <thead>
                            <tr>
                                <th></th>
                                <th>Report</th>
                                <th>Copies</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody id="hrms-bp-rows"></tbody>
                    </table>
                    <label class="hrms-bp-opt">
                        <input type="checkbox" id="hrms-bp-duplex" />
                        Duplex padding (add blank page after odd-page copies)
                    </label>
                    <div class="hrms-bp-actions">
                        <button class="hrms-bp-btn primary" id="hrms-bp-print">🖨️ Merge &amp; Print All</button>
                        <button class="hrms-bp-btn" id="hrms-bp-download">💾 Save Merged PDF</button>
                        <button class="hrms-bp-btn" id="hrms-bp-tab">📄 Open Merged in Tab</button>
                        <button class="hrms-bp-btn" id="hrms-bp-seq">📑 Print One-by-One</button>
                        <button class="hrms-bp-btn" id="hrms-bp-rescan">🔄 Rescan Links</button>
                    </div>
                </div>

                <!-- TAB 2: Date-Range LOV Bill Fetcher & Merger -->
                <div class="hrms-bp-pane" id="hrms-bp-pane-daterange">
                    <div class="hrms-bp-dr-bar">
                        <span><strong>LOV Bill Range</strong></span>
                        <span class="hrms-bp-pill muted" id="hrms-bp-dr-detect">Checking...</span>
                    </div>
                    <div class="hrms-bp-dates">
                        <label>From Date
                            <input type="date" id="hrms-bp-from-date" />
                        </label>
                        <label>To Date
                            <input type="date" id="hrms-bp-to-date" />
                        </label>
                    </div>
                    <div class="hrms-bp-actions">
                        <button class="hrms-bp-btn primary" id="hrms-bp-dr-fetch">🔍 Fetch Bill List from LOV</button>
                    </div>
                    <div class="hrms-bp-summary" id="hrms-bp-dr-summary">
                        Pick From &amp; To dates, then click Fetch Bill List.
                    </div>
                    <div class="hrms-bp-scroll">
                        <table class="hrms-bp-table">
                            <thead>
                                <tr>
                                    <th><input type="checkbox" id="hrms-bp-dr-all" checked title="Select / Deselect All" /></th>
                                    <th>Bill No / Ref</th>
                                    <th>Date</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody id="hrms-bp-dr-rows">
                                <tr><td colspan="4" style="text-align:center;color:#6b7280;padding:12px;">Select dates and click "Fetch Bill List"</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <label class="hrms-bp-opt">
                        <input type="checkbox" id="hrms-bp-dr-duplex" />
                        Duplex padding in merged PDF
                    </label>
                    <div class="hrms-bp-actions">
                        <button class="hrms-bp-btn primary" id="hrms-bp-dr-run" disabled>📥 Fetch &amp; Merge Selected (0)</button>
                        <button class="hrms-bp-btn" id="hrms-bp-dr-save" disabled>💾 Save Merged PDF As...</button>
                        <button class="hrms-bp-btn" id="hrms-bp-dr-retry" disabled>🔁 Retry Failed (0)</button>
                        <button class="hrms-bp-btn danger" id="hrms-bp-dr-stop" disabled>⏹ Stop</button>
                    </div>
                </div>

                <details>
                    <summary style="font-size:12px;cursor:pointer;color:#4b5563;">Debug Log</summary>
                    <pre id="hrms-bp-log"></pre>
                </details>
            </div>
        `;

        document.body.appendChild(launcher);
        document.body.appendChild(panel);

        makeDraggable(panel, document.getElementById('hrms-bp-drag-handle'));

        // Tab switching
        panel.querySelectorAll('.hrms-bp-tab').forEach((tabBtn) => {
            tabBtn.addEventListener('click', () => {
                panel.querySelectorAll('.hrms-bp-tab').forEach((b) => b.classList.remove('active'));
                panel.querySelectorAll('.hrms-bp-pane').forEach((p) => p.classList.remove('active'));
                tabBtn.classList.add('active');
                const targetPane = document.getElementById(`hrms-bp-pane-${tabBtn.dataset.tab}`);
                if (targetPane) targetPane.classList.add('active');
                scanLinks();
            });
        });

        // Populate Tab 1 rows
        const tbody = document.getElementById('hrms-bp-rows');
        reportStates.forEach((st, idx) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><input type="checkbox" data-idx="${idx}" class="hrms-bp-chk" ${st.enabled ? 'checked' : ''} /></td>
                <td>${st.label}</td>
                <td><input type="number" min="0" max="20" value="${st.copies}" data-idx="${idx}" class="hrms-bp-copies" /></td>
                <td><span class="hrms-bp-pill muted" id="hrms-bp-st-${idx}">Waiting</span></td>
            `;
            tbody.appendChild(tr);
        });

        tbody.addEventListener('change', (e) => {
            const idx = Number(e.target.dataset.idx);
            if (e.target.classList.contains('hrms-bp-chk')) {
                reportStates[idx].enabled = e.target.checked;
                updatePrintButtonLabel();
            } else if (e.target.classList.contains('hrms-bp-copies')) {
                reportStates[idx].copies = Math.max(0, parseInt(e.target.value, 10) || 0);
                updatePrintButtonLabel();
            }
        });

        // Tab 2 row selection handlers
        document.getElementById('hrms-bp-dr-all').addEventListener('change', (e) => {
            const checked = e.target.checked;
            lovBills.forEach((b) => { b.selected = checked; });
            renderLovBillRows();
        });

        document.getElementById('hrms-bp-dr-rows').addEventListener('change', (e) => {
            if (e.target.classList.contains('hrms-bp-dr-chk')) {
                const idx = Number(e.target.dataset.idx);
                if (lovBills[idx]) {
                    lovBills[idx].selected = e.target.checked;
                    updateDrButtons();
                }
            }
        });

        // Wire buttons
        document.getElementById('hrms-bp-close').addEventListener('click', () => {
            panel.classList.remove('open');
        });
        document.getElementById('hrms-bp-print').addEventListener('click', () => runMergedAction('print'));
        document.getElementById('hrms-bp-download').addEventListener('click', () => runMergedAction('download'));
        document.getElementById('hrms-bp-tab').addEventListener('click', () => runMergedAction('tab'));
        document.getElementById('hrms-bp-seq').addEventListener('click', () => runSequentialPrint());
        document.getElementById('hrms-bp-rescan').addEventListener('click', () => scanLinks(true));

        document.getElementById('hrms-bp-dr-fetch').addEventListener('click', () => loadBillsFromDateRange());
        document.getElementById('hrms-bp-dr-run').addEventListener('click', () => runDateRangeBatch(false));
        document.getElementById('hrms-bp-dr-retry').addEventListener('click', () => runDateRangeBatch(true));
        document.getElementById('hrms-bp-dr-stop').addEventListener('click', () => {
            stopRequested = true;
            setDrSummary('Stopping after current bill...', 'warn');
        });
        document.getElementById('hrms-bp-dr-save').addEventListener('click', async () => {
            if (!lastLovMergedBytes) return;
            await saveMergedPdfWithPrompt(lastLovMergedBytes, lastLovSuggestedName);
        });

        updatePrintButtonLabel();
        updateDrButtons();
    }

    function updatePrintButtonLabel() {
        const totalCopies = reportStates.reduce(
            (sum, st) => sum + (st.enabled && st.found ? (parseInt(st.copies, 10) || 0) : 0),
            0
        );
        const btn = document.getElementById('hrms-bp-print');
        if (btn) {
            btn.textContent = `🖨️ Merge & Print All (${totalCopies} ${totalCopies === 1 ? 'copy' : 'copies'})`;
        }
    }

    function setButtonsDisabled(disabled) {
        document.querySelectorAll('#hrms-bp-panel .hrms-bp-btn').forEach((b) => {
            b.disabled = disabled;
        });
    }

    function updateUI(foundCountOverride) {
        const foundCount =
            typeof foundCountOverride === 'number'
                ? foundCountOverride
                : reportStates.filter((s) => s.found).length;

        const badge = document.getElementById('hrms-bp-badge');
        if (badge) {
            badge.textContent = `${foundCount}/${REPORT_CONFIGS.length}`;
        }

        reportStates.forEach((st, idx) => {
            const pill = document.getElementById(`hrms-bp-st-${idx}`);
            if (pill) {
                pill.textContent = st.status;
                pill.className = `hrms-bp-pill ${st.statusType}`;
            }
        });

        updatePrintButtonLabel();
    }

    // -------------------------------------------------------------------------
    // Watch mainFrame navigation
    // -------------------------------------------------------------------------
    function attachFrameWatchers() {
        const mainFrame = document.getElementById('mainFrame');
        if (mainFrame) {
            mainFrame.addEventListener('load', () => {
                setTimeout(() => scanLinks(true), 400);
            });
        }
        setInterval(() => {
            if (!isBusy && !document.hidden) scanLinks();
        }, 2500);
    }

    function hasAncestorLauncher() {
        let w = window;
        try {
            while (w && w !== w.parent) {
                w = w.parent;
                if (w.document && w.document.getElementById('hrms-bp-launcher')) {
                    return true;
                }
            }
        } catch (_) {
            // Cross-origin ancestor
        }
        return false;
    }

    function init() {
        if (hasAncestorLauncher()) return;
        const hasMainFrame = Boolean(document.getElementById('mainFrame'));
        const isTopBody = window === window.top;
        const isMainFrame = currentFrameName === 'mainframe';

        if (!hasMainFrame && !isTopBody && !isMainFrame) {
            if (scanLinks() === 0 && !findDateRangeContext()) return;
        }

        createUI();
        attachFrameWatchers();
        scanLinks();
    }

    if (window !== window.top && !document.getElementById('mainFrame')) {
        setTimeout(init, 300);
    } else {
        init();
    }
})();
