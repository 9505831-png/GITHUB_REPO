// login-note.mjs
// note.com に手動でログインし、ログイン状態(Cookie等)を note-state.json に保存するスクリプト。
// 実行: node login-note.mjs
// ブラウザが開いたら、自分の手で note.com にログインしてください。
// ログインが完了したら、ターミナルに戻って Enter キーを押すと保存されます。

import { chromium } from 'playwright';
import readline from 'readline';

const STATE_PATH = './note-state.json';

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
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://note.com/login');

  console.log('');
  console.log('ブラウザが開きました。');
  console.log('note.com に、自分のメールアドレス/パスワード（またはGoogle/Twitterログイン等）でログインしてください。');
  console.log('ログインが完了して note のマイページ/ホームが表示されたら、');
  await waitForEnter('このターミナルに戻って Enter キーを押してください... ');

  // ログイン状態(Cookie, localStorage等)を保存
  await context.storageState({ path: STATE_PATH });

  console.log(`ログイン状態を ${STATE_PATH} に保存しました。`);
  console.log('このファイルは他人に渡さないよう厳重に管理してください（ログイン情報そのものです）。');

  await browser.close();
})();