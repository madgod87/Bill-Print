// ==UserScript==
// @name         HRMS Bill Batch PDF Printer
// @namespace    http://tampermonkey.net/
// @version      1.0.3
// @description  Fetches all bill report PDFs inside mainFrame, duplicates multi-copy reports, merges them in order, and triggers printing.
// @author       You
// @match        https://www.wbifms.gov.in/*
// @match        https://wbifms.gov.in/*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

/* global PDFLib */

(function () {
    'use strict';

    // Skip <frameset> wrapper pages (floating UI cannot render inside a <frameset>)
    if (!document.body || document.body.tagName === 'FRAMESET') {
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

    const CAPTURE_TIMEOUT_MS = 15000;

    let isBusy = false;
    let lastMergedBlobUrl = null;
    let lastPrintIframeBlobUrl = null;
    let printIframe = null;
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
    // Logging helper
    // -------------------------------------------------------------------------
    const logLines = [];
    function log(msg) {
        const ts = new Date().toLocaleTimeString();
        const line = `[${ts}] ${msg}`;
        logLines.push(line);
        if (logLines.length > 200) logLines.shift();
        const logEl = document.getElementById('hrms-bp-log');
        if (logEl) {
            logEl.textContent = logLines.join('\n');
            logEl.scrollTop = logEl.scrollHeight;
        }
        console.log('[HRMS Bill Printer]', msg);
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

    function findLinkInWindow(win, cfg) {
        const doc = win.document;
        if (!doc) return null;

        // 1. Primary CSS selector
        if (cfg.selector) {
            const el = doc.querySelector(cfg.selector);
            if (el) return el;
        }

        // 2. Fallback by visible link text
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

        updateUI(foundCount);
        return foundCount;
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
        // Convert cross-realm ArrayBuffer / TypedArray (e.g. from mainFrame.contentWindow.fetch)
        // into a current-realm Uint8Array so pdf-lib's instanceof checks always pass.
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
                // Fallback to GM_xmlhttpRequest (bypasses CORS if report API is cross-origin)
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

        // Handle HTML wrapper pages that embed/redirect to a PDF
        if (depth < 2 && (/html|text/i.test(contentType) || !contentType)) {
            const html = new TextDecoder('utf-8').decode(buf);

            // 1. Check for inline base64 PDF
            const b64Match = html.match(/data:application\/pdf;base64,([A-Za-z0-9+/=\s]+)/i);
            if (b64Match) {
                const raw = atob(b64Match[1].replace(/\s+/g, ''));
                const bytes = new Uint8Array(raw.length);
                for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                if (isPdfBytes(bytes)) return bytes;
            }

            // 2. Check for embedded iframe/embed/object pointing to PDF
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

            // 3. Check for JS location redirect or meta refresh
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
    // Capture a report request from either direct href or onclick="openReport_*()"
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
            throw new Error('Link element not found');
        }

        // Case A: Direct href link (e.g., report_link_tr_18, BENF_LIST_Ucm)
        const rawHref = (el.getAttribute('href') || '').trim();
        const hasOnclick = Boolean(el.getAttribute('onclick'));
        if (rawHref && rawHref !== '#' && !rawHref.toLowerCase().startsWith('javascript:') && !hasOnclick) {
            const url = new URL(rawHref, win.location.href).href;
            log(`[${state.label}] Direct href: ${url}`);
            return { url, options: { method: 'GET' } };
        }

        // Case B: onclick handler (e.g., openReport_tr_10())
        // Intercept window.open, form.submit, submit events, and synthetic anchor clicks
        return new Promise((resolve, reject) => {
            let settled = false;
            const origOpen = win.open;
            const origFormSubmit = win.HTMLFormElement.prototype.submit;
            const origAnchorClick = win.HTMLAnchorElement.prototype.click;

            const cleanup = () => {
                clearTimeout(timer);
                win.open = origOpen;
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

            win.open = function (url) {
                if (url) {
                    handleUrl(url, 'window.open()');
                }
                // Return a mock window in case the page opens '' and then sets location.href or targets a form at it
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

            const timer = setTimeout(() => {
                fail(new Error(`Timed out (${CAPTURE_TIMEOUT_MS / 1000}s) waiting for PDF trigger`));
            }, CAPTURE_TIMEOUT_MS);

            try {
                // Trigger the link's onclick handler
                origAnchorClick.call(el);
            } catch (err) {
                fail(new Error(`Click error: ${err.message}`));
            }
        });
    }

    // -------------------------------------------------------------------------
    // Fetch all selected reports
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
    // Merge PDFs using pdf-lib (with copy duplication & optional duplex padding)
    // -------------------------------------------------------------------------
    function uint8ToBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    async function buildMergedPdf(fetchedItems, duplexPad) {
        if (typeof PDFLib === 'undefined') {
            throw new Error('pdf-lib failed to load. Check network/Tampermonkey @require cache.');
        }

        const mergedDoc = await PDFLib.PDFDocument.create();
        let totalPages = 0;

        for (const item of fetchedItems) {
            const { state, copies, pdfBytes } = item;
            const localBytes = toLocalUint8Array(pdfBytes);
            let srcDoc;
            try {
                srcDoc = await PDFLib.PDFDocument.load(localBytes, { ignoreEncryption: true });
            } catch (loadErr) {
                if (/must be of type/.test(String(loadErr && loadErr.message))) {
                    srcDoc = await PDFLib.PDFDocument.load(uint8ToBase64(localBytes), { ignoreEncryption: true });
                } else {
                    throw loadErr;
                }
            }
            const pageIndices = srcDoc.getPageIndices();
            const pageCount = pageIndices.length;

            for (let c = 0; c < copies; c++) {
                const copiedPages = await mergedDoc.copyPages(srcDoc, pageIndices);
                for (const p of copiedPages) {
                    mergedDoc.addPage(p);
                    totalPages++;
                }

                // If printing duplex (double-sided), insert a blank page after odd-page copies
                // so the next copy/report starts on a fresh front sheet.
                if (duplexPad && pageCount % 2 === 1) {
                    const lastPage = copiedPages[copiedPages.length - 1];
                    const { width, height } = lastPage.getSize();
                    mergedDoc.addPage([width, height]);
                    totalPages++;
                }
            }

            state.status = `${pageCount}p × ${copies} merged`;
            state.statusType = 'ok';
            log(`[${state.label}] Added ${pageCount} page(s) × ${copies} copy(ies)`);
            updateUI();
        }

        const mergedBytes = await mergedDoc.save();
        log(`Merged PDF ready: ${totalPages} total pages (${(mergedBytes.byteLength / 1024).toFixed(1)} KB)`);
        return { mergedBytes, totalPages };
    }

    // -------------------------------------------------------------------------
    // Printing / Opening / Downloading helpers
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
                const a = document.createElement('a');
                a.href = lastMergedBlobUrl;
                a.download = `bill_reports_${new Date().toISOString().slice(0, 10)}.pdf`;
                document.body.appendChild(a);
                a.click();
                a.remove();
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

                    // Wait for user confirmation before opening the next print dialog
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
        }
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
                cursor: pointer;
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
                width: 430px;
                max-width: calc(100vw - 32px);
                max-height: calc(100vh - 96px);
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
            }
            .hrms-bp-header button {
                background: transparent;
                border: none;
                color: #fff;
                cursor: pointer;
                font-size: 16px;
                line-height: 1;
            }
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
                margin-bottom: 10px;
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
            .hrms-bp-btn:disabled { opacity: 0.55; cursor: not-allowed; }
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

    function createUI() {
        if (document.getElementById('hrms-bp-launcher')) return;
        injectStyles();

        const launcher = document.createElement('button');
        launcher.id = 'hrms-bp-launcher';
        launcher.innerHTML = `<span>🖨️ Bill Print</span><span class="badge" id="hrms-bp-badge">0/${REPORT_CONFIGS.length}</span>`;
        launcher.addEventListener('click', () => {
            const panel = document.getElementById('hrms-bp-panel');
            panel.classList.toggle('open');
            if (panel.classList.contains('open')) {
                scanLinks();
            }
        });

        const panel = document.createElement('div');
        panel.id = 'hrms-bp-panel';
        panel.innerHTML = `
            <div class="hrms-bp-header">
                <span>HRMS Bill Batch Printer</span>
                <button id="hrms-bp-close" title="Close">&times;</button>
            </div>
            <div class="hrms-bp-body">
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
                    <button class="hrms-bp-btn" id="hrms-bp-download">💾 Download Merged PDF</button>
                    <button class="hrms-bp-btn" id="hrms-bp-tab">📄 Open Merged in Tab</button>
                    <button class="hrms-bp-btn" id="hrms-bp-seq">📑 Print One-by-One</button>
                    <button class="hrms-bp-btn" id="hrms-bp-rescan">🔄 Rescan Links</button>
                </div>
                <details>
                    <summary style="font-size:12px;cursor:pointer;color:#4b5563;">Debug Log</summary>
                    <pre id="hrms-bp-log"></pre>
                </details>
            </div>
        `;

        document.body.appendChild(launcher);
        document.body.appendChild(panel);

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

        document.getElementById('hrms-bp-close').addEventListener('click', () => {
            panel.classList.remove('open');
        });
        document.getElementById('hrms-bp-print').addEventListener('click', () => runMergedAction('print'));
        document.getElementById('hrms-bp-download').addEventListener('click', () => runMergedAction('download'));
        document.getElementById('hrms-bp-tab').addEventListener('click', () => runMergedAction('tab'));
        document.getElementById('hrms-bp-seq').addEventListener('click', () => runSequentialPrint());
        document.getElementById('hrms-bp-rescan').addEventListener('click', () => scanLinks(true));

        updatePrintButtonLabel();
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
    // Watch mainFrame navigation so the badge auto-updates when opening a bill
    // -------------------------------------------------------------------------
    function attachFrameWatchers() {
        const mainFrame = document.getElementById('mainFrame');
        if (mainFrame) {
            mainFrame.addEventListener('load', () => {
                setTimeout(() => scanLinks(true), 400);
            });
        }
        // Periodic lightweight scan for AJAX-loaded content inside mainFrame
        setInterval(() => {
            if (!isBusy) scanLinks();
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
            // Cross-origin ancestor; treat as no launcher
        }
        return false;
    }

    function init() {
        if (hasAncestorLauncher()) return;
        const hasMainFrame = Boolean(document.getElementById('mainFrame'));
        const isTopBody = window === window.top;
        const isMainFrame = currentFrameName === 'mainframe';

        // Mount in the layout host (has #mainFrame), top non-frameset page,
        // or inside mainFrame itself if its parent didn't match/mount the script.
        if (!hasMainFrame && !isTopBody && !isMainFrame) {
            // Last check: mount only if this frame directly contains report links
            if (scanLinks() === 0) return;
        }

        createUI();
        attachFrameWatchers();
        scanLinks();
    }

    // Slight delay inside child frames so a parent layout frame mounts first if both match
    if (window !== window.top && !document.getElementById('mainFrame')) {
        setTimeout(init, 300);
    } else {
        init();
    }
})();
