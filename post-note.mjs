// post-note.mjs (修正版3 / たびくん用)
// スプレッドシートから「生成済み」の記事を取得し、note.comへ自動投稿するスクリプト。
// GitHub Actionsから実行される想定（ローカルでのテスト実行も可能）。
//
// 必要な環境変数:
//   NOTE_STATE_JSON : note.comへのログイン状態（storageState）のJSON文字列
//
// 実行: node post-note.mjs
//
// 主な修正点:
//  - 本文がタイトル欄に混入したら「打ち直して続行」せず、その記事を失敗扱いにする
//  - 保存/公開が本当に成功したことを確認してからステータスを更新する
//  - 公開成功の判定を「記事ページへの遷移」または「シェアダイアログの表示」のどちらかにした
//    （noteは公開後に遷移せず、公開設定画面の上にシェアダイアログを出すことがあるため）
//  - ステータス更新用のWebアプリURLを、記事生成用GASと同じプロジェクトのものに変更した
//  - イベントハンドラは1回だけ登録（記事ごとに増えてログが重複していた）
//  - text_notes APIのエラー本文をログに出す（422の原因特定用）
//  - POST_MODE で「下書き保存のみ」と「公開」を切り替え可能

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 'publish': 公開まで行う（既定）
// 'draft'  : 下書き保存まで行い、公開はしない（環境変数 POST_MODE=draft で切り替え）
// ★初回テストは、下の行の 'publish' を 'draft' に変えて、下書き保存だけで確認する。問題なければ 'publish' に戻す。
const POST_MODE = process.env.POST_MODE || 'publish';

// ★たびくん用の新しいスプレッドシート(articlesシート)
const CSV_URL =
  'https://docs.google.com/spreadsheets/d/1Ef2fgzRaCLf5N-Qwv4Q8_Si4C6qr8Mk2LdGmNFDqKwk/export?format=csv&gid=0';

// ★新しいスプレッドシートのApps Scriptをウェブアプリとしてデプロイして出てきたURL(/exec で終わるもの)に置き換える。
//   置き換えるまでは、誤ってじたんくん用のシートを書き換えないよう、実行時に止まるようにしてある。
const STATUS_UPDATE_URL = 'https://script.google.com/macros/s/AKfycbxCjAHixYdQa31asAdy3LXOptUhVuPy6AHzuYB5B8kyrlozGcVdrQIDvTEmftHc_A3s/exec';

// じたんくん用のWebアプリのURL(うっかり貼ってしまった場合に止めるための目印)
const OLD_JITANKUN_URL_ID = 'AKfycbxkXr1jhY114yuX3Udpc2nuylt1_N9A5XZnXtjbsMsFTdllbtooNaut-sFz42ckmjU9';

// 記事ごとに集める「保存系APIのエラー」（main側のresponseハンドラが書き込む）
let saveErrors = [];

// ---------- CSVパース ----------
function parseCSV(text) {
  const rows = [];
  let row = [],
    cell = '',
    inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cell += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') {
        row.push(cell);
        cell = '';
      } else if (c === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (c === '\r') {
        /* skip */
      } else cell += c;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function fetchTargetRows() {
  const res = await fetch(CSV_URL);
  if (!res.ok) {
    throw new Error(`スプレッドシートの取得に失敗しました: ${res.status}`);
  }
  const csv = (await res.text()).replace(/^\uFEFF/, '');
  const table = parseCSV(csv);
  const keys = table[0];
  const items = table
    .slice(1)
    .map((r, i) => {
      const obj = { rowNumber: i + 2 };
      keys.forEach((k, j) => {
        obj[k] = r[j] || '';
      });
      return obj;
    })
    .filter((o) => o.status === '生成済み');
  return items;
}

async function updateStatus(rowNumber, status) {
  try {
    const res = await fetch(STATUS_UPDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ row: rowNumber, status }),
      redirect: 'follow',
    });
    const text = await res.text();
    console.log(`ステータス更新: row=${rowNumber} status=${status} -> HTTP ${res.status}`, text.slice(0, 200));
  } catch (e) {
    console.error(`ステータス更新に失敗しました: row=${rowNumber}`, e);
  }
}

// ---------- 入力補助 ----------
// 全選択→Backspaceで確実にクリアする
async function clearField(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.focus();
    if (typeof el.setSelectionRange === 'function') {
      el.setSelectionRange(0, el.value.length);
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, selector);
  await page.keyboard.press('Backspace');
}

// 今フォーカスがselector内にあるかだけを返す（クリックはしない）
async function isFocused(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const active = document.activeElement;
    return active === el || el.contains(active);
  }, selector);
}

// フォーカスされるまでクリックし直す（入力を始める前にだけ使う）
async function ensureFocused(page, selector, { maxAttempts = 8, waitMs = 250 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await isFocused(page, selector)) {
      if (attempt > 1) {
        console.log(`[診断] ${attempt}回目のクリックで ${selector} にフォーカスが移りました`);
      }
      return true;
    }
    console.log(`[診断] ${selector} にまだフォーカスが来ていません（${attempt}/${maxAttempts}回目）。クリックし直します`);
    await page.click(selector, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(waitMs);
  }
  return false;
}

async function readTitle(page, selector) {
  return page.evaluate(
    (sel) => document.querySelector(sel)?.value ?? '(要素が見つかりません)',
    selector
  );
}

// ---------- note.comへの投稿処理 ----------
async function postArticle(page, row) {
  saveErrors = []; // この記事用にリセット

  await page.goto('https://note.com/notes/new', { waitUntil: 'domcontentloaded', timeout: 60000 });

  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {
    console.log('networkidle待機がタイムアウトしました（続行します）');
  });

  // ハイドレーション待ち
  await page.waitForTimeout(15000);

  const cookies = await page.context().cookies();
  const editorCookies = cookies.filter((c) => c.domain.includes('editor.note.com'));
  const noteCookies = cookies.filter((c) => c.domain.includes('note.com') && !c.domain.includes('editor'));
  console.log(`Cookie件数: note.com=${noteCookies.length}件, editor.note.com=${editorCookies.length}件`);

  await page.screenshot({ path: path.join(__dirname, 'debug-after-goto.png'), fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => '(HTML取得失敗)');
  fs.writeFileSync(path.join(__dirname, 'debug-after-goto.html'), html, 'utf-8');
  console.log('現在のURL:', page.url());
  console.log('現在のタイトル:', await page.title().catch(() => '(取得失敗)'));

  // ---- タイトルのサニタイズ ----
  const NOTE_TITLE_MAX_LENGTH = 100;
  const rawTitle = (row.title || '').trim();
  const firstLineTitle = rawTitle.split(/\r?\n/)[0];
  const safeTitle =
    firstLineTitle.length > NOTE_TITLE_MAX_LENGTH
      ? firstLineTitle.slice(0, NOTE_TITLE_MAX_LENGTH)
      : firstLineTitle;

  if (!safeTitle) throw new Error('タイトルが空です');
  if (!row.body || !row.body.trim()) throw new Error('本文が空です');

  if (safeTitle !== rawTitle) {
    console.warn(
      `[警告] row=${row.rowNumber} のタイトルが異常でした。元の値: ${JSON.stringify(rawTitle)} → 使用する値: ${JSON.stringify(safeTitle)}`
    );
  }

  const titleSelector = 'textarea[placeholder="記事タイトル"]';
  const bodySelector = 'div.ProseMirror.note-common-styles__textnote-body';

  console.log(`[診断] titleSelectorのマッチ数: ${await page.locator(titleSelector).count()}`);
  console.log(`[診断] bodySelectorのマッチ数: ${await page.locator(bodySelector).count()}`);

  // ---- タイトル入力 ----
  await page.click(titleSelector, { timeout: 15000 });
  if (!(await ensureFocused(page, titleSelector))) {
    throw new Error('タイトル欄にフォーカスが移りませんでした');
  }
  await clearField(page, titleSelector);
  await page.keyboard.type(safeTitle, { delay: 20 });

  const titleAfterType = await readTitle(page, titleSelector);
  console.log(`[診断] タイトル入力直後の実際の値: ${JSON.stringify(titleAfterType)}`);
  if (titleAfterType !== safeTitle) {
    throw new Error(`タイトル入力が想定と異なります: ${JSON.stringify(titleAfterType.slice(0, 80))}`);
  }

  // ---- 本文入力 ----
  // タイトル欄からフォーカスを外し、少し待ってから本文欄へ
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.blur();
  }, titleSelector);
  await page.waitForTimeout(1000);

  await page.click(bodySelector, { timeout: 15000 });
  if (!(await ensureFocused(page, bodySelector))) {
    throw new Error('本文欄にフォーカスが移りませんでした（タイトル欄への混入を防ぐため中止）');
  }
  // フォーカスが安定するまで待って、もう一度確認
  await page.waitForTimeout(1000);
  if (!(await isFocused(page, bodySelector))) {
    throw new Error('本文欄のフォーカスが安定しませんでした');
  }
  // 注意: ここで clearField（全選択→Backspace）はしない。
  // 新規ノートの本文は最初から空で、空の本文でBackspaceを押すと
  // noteはフォーカスをタイトル欄へ戻す。これが「本文がタイトルに混入」の原因だった。

  const bodyLines = row.body.split('\n');
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i]) {
      // 入力の直前に必ずフォーカスを確認。ずれていたら（クリックし直すとカーソル位置が
      // 変わって本文が壊れるため）その場で失敗にする
      if (!(await isFocused(page, bodySelector))) {
        throw new Error(`本文入力中にフォーカスが本文欄から外れました (line ${i + 1})`);
      }
      await page.keyboard.type(bodyLines[i], { delay: 5 });
    }
    if (i < bodyLines.length - 1) {
      await page.keyboard.press('Enter');
    }

    // 1行目を入力した直後に、タイトル欄が汚れていないか確認（早期検出）
    if (i === 0) {
      const t = await readTitle(page, titleSelector);
      if (t !== safeTitle) {
        throw new Error(`本文1行目がタイトル欄に混入しました: ${JSON.stringify(t.slice(0, 80))}`);
      }
    }
  }

  // ---- 入力結果の検証 ----
  const bodyLength = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText.length : -1;
  }, bodySelector);
  console.log(`本文入力後の文字数（画面上）: ${bodyLength}`);

  const bodySnippet = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText.slice(0, 60) : '(要素が見つかりません)';
  }, bodySelector);
  console.log(`[診断] 本文欄の冒頭60文字: ${JSON.stringify(bodySnippet)}`);

  // 本文の最初の行（先頭10文字）が本文欄の冒頭にあること
  const firstBodyLine = (bodyLines.find((l) => l.trim()) || '').trim();
  const probe = firstBodyLine.slice(0, 10);
  if (probe && !bodySnippet.includes(probe)) {
    throw new Error(`本文の冒頭が想定と異なります。想定: ${JSON.stringify(probe)} / 実際: ${JSON.stringify(bodySnippet)}`);
  }

  // 文字数が極端に少ない場合も失敗（入力が途中で止まった等）
  if (bodyLength < row.body.length * 0.8) {
    throw new Error(`本文の文字数が少なすぎます: 画面上=${bodyLength} / 元=${row.body.length}`);
  }

  const titleFinal = await readTitle(page, titleSelector);
  console.log(`[診断] 保存直前のタイトル欄の値: ${JSON.stringify(titleFinal)}`);
  if (titleFinal !== safeTitle) {
    // 以前は打ち直して続行していたが、本文の1行目が失われている可能性があるため失敗にする
    throw new Error(`タイトル欄に本文が混入しています: ${JSON.stringify(titleFinal.slice(0, 80))}`);
  }

  // ---- 保存 / 公開 ----
  if (POST_MODE === 'draft') {
    // 下書き保存ボタンを押し、保存APIの応答を確認する
    const [saveRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/v1/text_notes/') && r.request().method() !== 'GET',
        { timeout: 30000 }
      ),
      page.getByRole('button', { name: '下書き保存' }).click({ timeout: 30000 }),
    ]);
    const saveBody = await saveRes.text().catch(() => '');
    console.log(`[下書き保存] ${saveRes.request().method()} ${saveRes.status()} ${saveBody.slice(0, 300)}`);
    if (!saveRes.ok()) {
      throw new Error(`下書き保存に失敗しました: HTTP ${saveRes.status()}`);
    }
    await page.waitForTimeout(3000);
    return '下書き保存済み';
  }

  // publish
  await page.click("xpath=//button[.//span[contains(text(),'公開に進む')]]", { timeout: 60000 });
  await page.waitForTimeout(3000);
  await page
    .screenshot({ path: path.join(__dirname, 'debug-before-submit.png'), fullPage: true })
    .catch(() => {});

  await page.click("xpath=//button[.//span[contains(text(),'投稿する')]]", { timeout: 60000 });

  // 公開成功の確認:
  //  (a) 記事ページ note.com/<user>/n/n... に遷移する、または
  //  (b) 公開設定画面の上に「シェアしてみましょう」ダイアログが出る
  // のどちらかが起きれば成功とみなす（noteは(b)だけで遷移しないことがある）。
  // Promise.race だと負けた側の失敗が未処理rejectionになるため Promise.any を使う。
  try {
    const how = await Promise.any([
      page
        .waitForURL(/note\.com\/[^/]+\/n\/n[0-9a-f]+/, { timeout: 60000 })
        .then(() => 'url'),
      page
        .getByText('シェアしてみましょう')
        .first()
        .waitFor({ state: 'visible', timeout: 60000 })
        .then(() => 'share-dialog'),
    ]);
    console.log(`[公開確認] 成功 (${how}) URL: ${page.url()}`);
  } catch (e) {
    await page
      .screenshot({ path: path.join(__dirname, `debug-publish-row${row.rowNumber}.png`), fullPage: true })
      .catch(() => {});
    throw new Error('公開の完了を確認できませんでした（記事ページへの遷移もシェアダイアログも出ませんでした）');
  }

  // ダイアログを閉じて、次の記事の処理に影響しないようにする（失敗しても無視）
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(1000);

  if (saveErrors.length > 0) {
    console.warn(`[警告] 公開はできましたが、保存系APIのエラーが${saveErrors.length}件ありました`);
  }
  return '投稿済み';
}

// ---------- メイン処理 ----------
(async () => {
  // 設定ミスの防止: WebアプリのURLが未設定、またはじたんくん用のままなら、何も投稿せずに止める
  if (!STATUS_UPDATE_URL.startsWith('https://script.google.com/')) {
    console.error(
      'STATUS_UPDATE_URL が未設定です。新しいスプレッドシートのWebアプリのURL(/exec で終わるもの)を設定してください。'
    );
    process.exit(1);
  }
  if (STATUS_UPDATE_URL.includes(OLD_JITANKUN_URL_ID)) {
    console.error(
      'STATUS_UPDATE_URL が、じたんくん用のWebアプリのままです。たびくん用のURLに置き換えてください。'
    );
    process.exit(1);
  }

  const stateJson = process.env.NOTE_STATE_JSON;
  if (!stateJson) {
    console.error(
      'NOTE_STATE_JSON 環境変数が設定されていません。GitHub Secretsの設定を確認してください。'
    );
    process.exit(1);
  }

  const tmpStatePath = path.join(__dirname, '.note-state.runtime.json');
  fs.writeFileSync(tmpStatePath, stateJson, 'utf-8');

  console.log(`POST_MODE=${POST_MODE}`);
  const rows = await fetchTargetRows();
  console.log(`投稿対象: ${rows.length}件`);

  if (rows.length === 0) {
    console.log('投稿対象の記事がありません。終了します。');
    fs.unlinkSync(tmpStatePath);
    return;
  }

  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    storageState: tmpStatePath,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'ja-JP',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  // ハンドラは1回だけ登録する（以前は記事ごとに登録され、ログが累積していた）
  // ノイズ（logcollector / recaptcha / pro_coupons）はログに出さない
  const NOISE = ['logcollector.note.com', 'recaptcha', 'pro_coupons', 'pro/coupons'];
  page.on('pageerror', (err) => console.log('[page error]', err.message));
  page.on('dialog', (d) => d.accept().catch(() => {})); // 離脱確認ダイアログ対策
  page.on('response', async (res) => {
    const url = res.url();
    if (res.status() < 400) return;
    if (url.includes('/api/v1/text_notes/')) {
      const body = await res.text().catch(() => '');
      saveErrors.push({ status: res.status(), body });
      console.log(
        `[保存APIエラー] ${res.request().method()} ${res.status()} ${url} ${body.slice(0, 500)}`
      );
    } else if (!NOISE.some((n) => url.includes(n))) {
      console.log('[response error]', res.status(), url);
    }
  });

  for (const row of rows) {
    console.log(`投稿開始: row=${row.rowNumber} title=${row.title}`);
    try {
      const status = await postArticle(page, row);
      await updateStatus(row.rowNumber, status);
      console.log(`投稿完了: row=${row.rowNumber} (${status})`);
    } catch (e) {
      console.error(`投稿失敗: row=${row.rowNumber}`, e);
      await page
        .screenshot({ path: path.join(__dirname, `debug-error-row${row.rowNumber}.png`), fullPage: true })
        .catch(() => {});
      const errHtml = await page.content().catch(() => '(HTML取得失敗)');
      fs.writeFileSync(path.join(__dirname, `debug-error-row${row.rowNumber}.html`), errHtml, 'utf-8');
      await updateStatus(row.rowNumber, '投稿失敗');
    }
  }

  await browser.close();
  fs.unlinkSync(tmpStatePath);
})();
