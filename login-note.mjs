// login-note.mjs (ふるさとくん用)
// note.com に手動でログインし、ログイン状態(Cookie等)をファイルに保存するスクリプト。
// 実行: node login-note.mjs [保存するファイル名]
//   例) node login-note.mjs                      → note-state-furusato.json に保存
//   例) node login-note.mjs note-state-xxx.json   → 指定した名前で保存
// ブラウザが開いたら、★ふるさとくんのnoteアカウント★で、自分の手でログインしてください。
// ログインが完了したら、ターミナルに戻って Enter キーを押すと保存されます。
//
// 保存されたファイルの中身を、GitHubの Secrets「NOTE_STATE_JSON」に登録します。
// (ファイルはログイン情報そのものです。GitHubにコミットしないでください)

import { chromium } from 'playwright';
import readline from 'readline';

// 他のアカウント(たびくん・じたんくん)のファイルを上書きしないよう、既定の名前をアカウントごとに分ける
const STATE_PATH = process.argv[2] || './note-state-furusato.json';

function waitForEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

(async () => {
  // 投稿スクリプト(post-note.mjs)と同じ Chrome・同じ設定で開く(ログイン状態の食い違いを防ぐ)
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'ja-JP',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  await page.goto('https://note.com/login');

  console.log('');
  console.log('ブラウザが開きました。');
  console.log('★ふるさとくんのnoteアカウント★で、note.com にログインしてください。');
  console.log('(メールアドレス/パスワード、またはGoogle/Twitterログイン等)');
  console.log('ログインが完了して note のマイページ/ホームが表示されたら、');
  await waitForEnter('このターミナルに戻って Enter キーを押してください... ');

  // ログインできているかの確認(まだログイン画面のままなら、保存せずに終了する)
  if (page.url().includes('/login')) {
    console.error('');
    console.error('まだログイン画面のままです。ログインが完了してから、もう一度実行してください。');
    console.error('(ログイン状態は保存していません)');
    await browser.close();
    process.exit(1);
  }

  // どのアカウントでログインしたかを表示する(取れなくても保存は続ける)
  try {
    const me = await page.evaluate(async () => {
      const res = await fetch('https://note.com/api/v2/current_user', { credentials: 'include' });
      if (!res.ok) return null;
      const json = await res.json();
      return json && json.data ? { urlname: json.data.urlname, nickname: json.data.nickname } : null;
    });
    if (me) {
      console.log('');
      console.log(`ログイン中のアカウント: ${me.nickname || '(不明)'} (ID: ${me.urlname || '(不明)'})`);
      console.log('↑ ふるさとくんのアカウントになっているか確認してください。違う場合は Ctrl+C で中止してください。');
    }
  } catch (e) {
    // アカウント名が取れなくても問題ない
  }

  // ログイン状態(Cookie, localStorage等)を保存
  await context.storageState({ path: STATE_PATH });

  console.log('');
  console.log(`ログイン状態を ${STATE_PATH} に保存しました。`);
  console.log('このファイルの中身を、GitHubの Secrets「NOTE_STATE_JSON」に登録してください。');
  console.log('このファイルは他人に渡さず、GitHubにもコミットしないでください（ログイン情報そのものです）。');

  await browser.close();
})();
