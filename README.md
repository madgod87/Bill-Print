# HRMS Bill Batch PDF Printer (Tampermonkey Userscript)

A Tampermonkey userscript for WBIFMS / HRMS portals (`wbifms.gov.in`) that automatically locates all bill report PDF links inside `mainFrame`, fetches them using your active logged-in session, duplicates multi-copy reports in exact order using [`pdf-lib`](https://pdf-lib.js.org/), and merges them into a single print job.

---

## Features

- **One-click batch printing:** Combines all 9 bill reports (12 total copies) into a single merged PDF so you only click **Print** once.
- **Exact copy counts & ordering:** Automatically repeats multi-copy reports (`TR 12`, `TR 46`, `TR 55`) in the merged output.
- **Frame-aware detection:** Works cleanly with the HRMS multi-frame layout (`topFrame`, `leftFrame`, `mainFrame`, or outer `<frameset>` wrappers) without duplicating the UI.
- **Handles both link types:**
  - Direct PDF links (`#report_link_tr_18`, `#BENF_LIST_Ucm`) with dynamic `dId`/`cId` query parameters.
  - JavaScript `onclick="openReport_*()"` handlers (intercepts `window.open`, `form.submit()` GET/POST, and dynamic anchor clicks).
- **Duplex (double-sided) padding option:** Optionally inserts a blank page after odd-page copies so consecutive copies/reports always start on a fresh front sheet.
- **Multiple output modes:**
  - **Merge & Print All** — opens the browser Print dialog with the combined PDF.
  - **Download Merged PDF** — saves `bill_reports_YYYY-MM-DD.pdf` locally.
  - **Open Merged in Tab** — opens the merged PDF in a new browser tab.
  - **Print One-by-One** — prints each report individually (useful if your printer driver doesn't auto-rotate mixed portrait/landscape pages).
- **Live status & Debug Log:** Shows which links are detected (`9/9`), editable per-report checkboxes and copy counts, fetch progress, and a collapsible debug log.

---

## Default Report Order & Copy Counts

| # | Report Name | Selector / Trigger | Default Copies |
|---|-------------|--------------------|----------------|
| 1 | TR 18 Details | `#report_link_tr_18` (direct `href`) | **1** |
| 2 | TR 10 Details | `onclick="openReport_tr_10()"` | **1** |
| 3 | TR 12 Details | `onclick="openReport_tr_12()"` | **2** |
| 4 | TR 46 Details | `onclick="openReport_tr_46()"` | **2** |
| 5 | TR 47 Details | `onclick="openReport_tr_47()"` | **1** |
| 6 | TR 53 Details | `onclick="openReport_tr_53()"` | **1** |
| 7 | TR 55 Details | `onclick="openReport_tr_55()"` | **2** |
| 8 | Beneficiary List (`Benefically List`) | `#BENF_LIST_Ucm` (direct `href`) | **1** |
| 9 | Bill Wise Sanction Strength | `onclick="openReport_bill_wise_ss()"` | **1** |
| | **Total** | **9 reports** | **12 copies** |

> Missing links on a given bill are skipped automatically without failing the rest of the batch.

---

## Prerequisites

1. A modern desktop browser (**Google Chrome**, **Microsoft Edge**, or **Mozilla Firefox**).
2. The **[Tampermonkey](https://www.tampermonkey.net/)** browser extension installed and enabled.
3. **Chrome / Edge (Manifest V3) requirement:**
   - Open `chrome://extensions` (or `edge://extensions`).
   - Click **Details** on **Tampermonkey**.
   - Enable **Allow User Scripts** (or toggle **Developer mode** ON in the top-right corner of the extensions page).

---

## Installation

### Option 1: Install manually in Tampermonkey
1. Click the **Tampermonkey** extension icon → **Create a new script...**
2. Select all default template text and delete it.
3. Copy the entire contents of [`bill_batch_print.user.js`](./bill_batch_print.user.js) and paste it into the Tampermonkey editor.
4. Press `Ctrl + S` (or click **File → Save**).
5. Ensure the script toggle is **Enabled** in the Tampermonkey dashboard.

### Option 2: Direct one-click install from GitHub Raw URL
1. Click the direct install link: [**Install `bill_batch_print.user.js`**](https://raw.githubusercontent.com/madgod87/Bill-Print/main/bill_batch_print.user.js)
2. Tampermonkey will automatically detect the `.user.js` extension and prompt you to click **Install**.

---

## Usage

1. Log in to the WBIFMS / HRMS portal (`https://www.wbifms.gov.in`) and open a **Pay Bill Details** page where the report links are listed.
2. Look for the blue **`🖨️ Bill Print`** button in the **bottom-right corner** of the window. Its badge updates automatically as links load (e.g., `9/9`).
3. Click **`🖨️ Bill Print`** to expand the control panel:
   - Check/uncheck individual reports or adjust copy counts if needed.
   - Check **Duplex padding** only if you are printing double-sided and want each copy/report to start on a new sheet.
4. Click **`🖨️ Merge & Print All (12 copies)`**:
   - The script captures and downloads each PDF in order, merges them with the specified copy counts, and opens the browser Print dialog.
   - Leave **Copies** set to **`1`** in the browser Print dialog (multi-copy reports are already duplicated inside the merged PDF) and click **Print**.

### Alternative Actions
- **💾 Download Merged PDF:** Saves the combined PDF to your Downloads folder (handy for archiving or printing from Adobe Acrobat Reader).
- **📄 Open Merged in Tab:** Opens the combined PDF in a new tab where you can preview all pages and press `Ctrl + P`.
- **📑 Print One-by-One:** Prints each report in a separate print dialog if your printer handles mixed portrait/landscape orientations better as individual jobs.
- **🔄 Rescan Links:** Re-scans `mainFrame` if links loaded late via AJAX.

---

## Customization

Open the script in Tampermonkey and edit:

- **Portal URLs (`@match`):**
  ```js
  // @match        https://www.wbifms.gov.in/*
  // @match        https://wbifms.gov.in/*
  ```
  Add additional `@match` lines if your organization accesses HRMS on a different domain or intranet hostname.

- **Default reports & copy counts (`REPORT_CONFIGS`):**
  Edit the `REPORT_CONFIGS` array near the top of `bill_batch_print.user.js` to change default `copies`, reorder reports, or add new report links.

---

## Troubleshooting

| Issue | What to Check |
|-------|---------------|
| **`🖨️ Bill Print` button does not appear** | 1. Check the Tampermonkey toolbar icon—does it show a badge (`1`)? If not, verify your browser URL matches `@match`.<br>2. In Chrome/Edge, ensure **Allow User Scripts** / **Developer mode** is enabled in `chrome://extensions`.<br>3. Open DevTools (`F12` → **Console**) and check for errors. |
| **Badge shows `0/9` even on the bill page** | Click **🔄 Rescan Links** after the page finishes loading, or verify you are on the Pay Bill Details view where the links are visible. |
| **A report shows `Error` or times out** | Expand **Debug Log** at the bottom of the panel to see the exact captured URL/HTTP error. If a specific `openReport_*()` function uses a custom mechanism, check its definition in DevTools. |
| **Print dialog doesn't open automatically** | Click **📄 Open Merged in Tab** and press `Ctrl + P`, or use **💾 Download Merged PDF** and print from your PDF viewer. |
| **Tampermonkey prompts for cross-origin access** | Click **Always allow domain** if `GM_xmlhttpRequest` is used as a fallback for cross-origin report APIs. |

---

## Privacy & Security

- Runs **100% locally in your browser**. No bill data or PDFs are sent to any third-party server.
- The only external resource loaded is `pdf-lib` (`cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js`), which Tampermonkey downloads and caches at script install time via `@require`.
