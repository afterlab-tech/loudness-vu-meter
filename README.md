# Loudness & VU Meter（Chrome 拡張）

YouTube や HLS 配信など、ブラウザで再生中の `<video>` / `<audio>` の音声を
**プレーヤーの音量・ミュートに影響されずに**計測するサイドパネル型メーターです。

- **VU メーター**（L/R アナログ針、300 ms 弾道、0 VU 基準 −12〜−20 dBFS 切替、PEAK LED = −1 dBTP 超）
- **ラウドネス**（ITU-R BS.1770-4 / EBU R128）
  - Short-term（3 s）・Momentary（400 ms）
  - Integrated（ゲート付き全体ラウドネス）
  - True Peak（4 倍オーバーサンプリング、最大値ホールド）
  - LRA・Max S・ターゲットとの差（−14 / −23 LUFS 切替）
  - Short-term の 60 秒履歴グラフ

## インストール

1. Chrome で `chrome://extensions` を開き、右上の「デベロッパーモード」をオンにします。
2. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選択します。
3. 計測したいページ（YouTube など）を開き（インストール前に開いていたタブは**再読み込み**が必要です）、
   ツールバーのアイコンをクリックするとサイドパネルが開きます。

> 自動再生制限のため、ページ内を一度もクリックしていない場合は「クリック待ち」と表示されます。
> ページをクリック（または再生ボタンを押す）すると計測が始まります。

## 音量に依存しない仕組み

```
<video> ─ MediaElementSource ─┬─ GainNode（プレーヤーの音量/ミュート）─ スピーカー
                              └─ メーター（AudioWorklet）
```

- `src/page-hook.js`（ページの MAIN world で実行）が `HTMLMediaElement.prototype.volume / muted` を
  差し替えます。計測中の要素は実際の音量を常に 1・ミュート解除に固定し、プレーヤーが設定した値は
  「仮想値」として保持します（プレーヤーの UI からは今まで通りの値に見えます）。
- `src/content.js` が仮想値を **メーター分岐の後ろ**の GainNode に反映するので、聞こえ方は従来どおりで、
  メーターには常に音量適用前の信号が入ります。YouTube の「音量の自動調整」の影響も受けません。
- サイドパネルを一度開いたタブだけが対象です。開くまでページの音声経路には一切触れません。

## ファイル構成

| パス | 役割 |
| --- | --- |
| `manifest.json` | MV3 マニフェスト |
| `src/dsp.js` | 計測 DSP（K 特性、ゲーティング、LRA、True Peak、VU 針） |
| `src/worklet.js` | AudioWorklet プロセッサ（DSP をオーディオスレッドで実行） |
| `src/content.js` | 各フレームで音声経路を構築し、サイドパネルへ値を送信 |
| `src/page-hook.js` | プレーヤー音量の仮想化（MAIN world） |
| `src/background.js` | アイコンクリックでサイドパネルを開く |
| `sidepanel/` | メーター UI |
| `test/dsp.test.mjs` | DSP の精度テスト |
| `test/harness/` | ブラウザ上での動作確認用ハーネス |
| `tools/make-icons.py` | アイコン生成 |

## テスト

```bash
node --test test/*.test.mjs
```

EBU Tech 3341（Case 1〜5: M/S/I とゲーティング）・Tech 3342（LRA）相当の信号、True Peak の
サンプル間ピーク（fs/4・45° 位相）、VU の較正（−18 dBFS サイン = 0 VU）と弾道（300 ms で 99%、
オーバーシュート約 1.4%）を検証します。

ブラウザ上での確認（音量・ミュートを変えても値が変わらないこと）:

```bash
python3 test/harness/make-harness.py && python3 -m http.server 8765
```

`http://localhost:8765/test/harness/index.html` を開き、ページをクリックしてから再生します。

実サイトでの E2E（拡張機能を読み込んだ Chromium で、同じ区間を音量 100 / 10 / ミュートで再生し値が一致するか確認）:

```bash
PW_PATH=<playwright モジュールのパス> CHROME_BIN=<Chromium 実行ファイル> node test/e2e/youtube.cjs .
```

`test/e2e/hls.cjs` は hls.js デモページ（MSE による HLS 再生）で同じ確認を行います。

## 制限事項

- CORS ヘッダなしで別オリジンから直接読み込まれたメディア（MSE/HLS.js ではない素の `src`）は、
  ブラウザの仕様により無音として計測されます。YouTube や hls.js 等の MSE 再生は問題ありません。
- ページ自身が既に同じ要素を Web Audio に接続している場合は計測できません（パネルにエラー表示）。
- ページの CSP で AudioWorklet が読み込めない場合は、自動的に互換モード（ScriptProcessor）で計測します。
- 5.1ch 等はステレオにダウンミックスして計測します。
