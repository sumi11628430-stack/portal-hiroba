// ============================================================
// ポータルサイトのゲーム本体
//
// もくじ
//   1. 基本の値
//   2. 地図（通れるか・建物の入口・設定の点検）
//   3. 道順さがし（A*）と、なめらかな道のり
//   4. 音（効果音。BGMは空の関数だけ）
//   5. 描く部品（★画像に差し替えるときは、ここの関数の中身を替える）
//   6. 主人公（動きの流れ）
//  6b. 動物（★カメラ試作で足した物。絵の置き場 ANIMAL_ART と、動き）
//   7. 画面を描く（全体マップ／移動画面）
//   8. 画面の部品（メッセージ窓・ログ・ボタン）
//   9. 流れ（選ぶ → 向かう → 着く → 入る）
//  10. 起動
//
// 設定（建物・地図・速さ）は config.js にあります。
// ============================================================
(function () {
  "use strict";

  // ------------------------------------------------------------
  // 1. 基本の値
  // ------------------------------------------------------------
  const C = CONFIG;
  const MAP = C.map;
  const ROWS = MAP.length;       // 地図の縦のマス数
  const COLS = MAP[0].length;    // 地図の横のマス数

  // 地図の文字の意味
  const T = { GRASS: ".", ROAD: "=", TREE: "T", POND: "~", FLOWER: "," };

  // 移動画面（斜め見下ろし）の1マスの大きさ
  const TW = 64;                 // 横幅
  const TH = 32;                 // 縦幅

  // 主人公の動きの長さ（秒）
  const T_MOUNT = 0.35;          // 板に乗る
  const T_KICK = 0.5;            // 地面を1回蹴る
  const T_DISMOUNT = 0.5;        // 板から降りる

  const FONT = '"Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo", sans-serif';

  // 建物（書かれていない項目は、ここの値を使う）
  const BUILDINGS = C.buildings.map(function (b) {
    return Object.assign({ size: 3, door: "S", art: "", wallColor: "#eeeeee", roofColor: "#888888" }, b);
  });

  // 木の場所（地図から拾う）
  const TREES = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (MAP[y][x] === T.TREE) TREES.push({ x: x, y: y });
    }
  }

  // いまの状態
  const state = {
    screen: "overview",   // "overview"＝全体マップ ／ "field"＝移動画面
    dest: null,           // 向かっている（着いた）建物
    goal: null,           // 向かっている先のマス（目的地の印を出す場所）
    selected: null,       // 全体マップで選んでいる建物（確認の窓が出ている間）
    time: 0,              // 始まってからの秒数（動きの計算に使う）
    leaving: false,       // 建物に出入りしている途中（暗転の間。ほかの操作を受けつけない）
    inside: null          // いま中に入っている建物（入っていなければ null）
  };

  // ---- 小さな道具 ----
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return t * t * (3 - 2 * t); }               // ゆっくり→速く→ゆっくり

  // 2つの向きの差（-π〜π）
  function angDiff(to, from) {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // マスごとに決まった乱数（0〜1）。草や小石の位置を毎回同じにするため
  function hash(x, y) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // 色を明るく（amt が＋）／暗く（amt が－）する。色は #rrggbb
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const to = amt < 0 ? 0 : 255;
    const k = Math.abs(amt);
    const r = Math.round(lerp((n >> 16) & 255, to, k));
    const g = Math.round(lerp((n >> 8) & 255, to, k));
    const b = Math.round(lerp(n & 255, to, k));
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  // ------------------------------------------------------------
  // 2. 地図（通れるか・建物の入口・設定の点検）
  // ------------------------------------------------------------

  // そのマスの文字（地図の外は null）
  function tileAt(x, y) {
    if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return null;
    return MAP[y][x];
  }

  // そのマスに建っている建物（無ければ null）
  function buildingAt(x, y) {
    for (let i = 0; i < BUILDINGS.length; i++) {
      const b = BUILDINGS[i];
      if (x >= b.x && x < b.x + b.size && y >= b.y && y < b.y + b.size) return b;
    }
    return null;
  }

  // 通れるマスか（木・池・建物・地図の外は通れない）
  function isWalkable(x, y) {
    const t = tileAt(x, y);
    if (t === null || t === T.TREE || t === T.POND) return false;
    return !buildingAt(x, y);
  }

  // 建物の入口の前のマス（主人公が止まる場所）
  function entranceOf(b) {
    const mid = Math.floor(b.size / 2);
    if (b.door === "E") return { x: b.x + b.size, y: b.y + mid };
    return { x: b.x + mid, y: b.y + b.size };
  }

  // 設定の点検（config.js を書き換えたときの書き間違いを見つける）
  function checkConfig() {
    const problems = [];
    MAP.forEach(function (row, y) {
      if (row.length !== COLS) problems.push("地図の y=" + y + " の行の文字数が、ほかの行と違います");
    });
    if (!isWalkable(C.start.x, C.start.y)) problems.push("最初の位置（start）が通れないマスです");
    BUILDINGS.forEach(function (b) {
      if (b.x < 0 || b.y < 0 || b.x + b.size > COLS || b.y + b.size > ROWS) {
        problems.push(b.name + " が地図からはみ出しています");
        return;
      }
      const art = BUILDING_ART[b.art];
      if (b.art && !art) problems.push(b.name + " の art「" + b.art + "」という絵はありません（箱の建物で表示します）");
      if (art && art.door !== b.door) problems.push(b.name + " の絵は入口が \"" + art.door + "\" 向きです（door を \"" + art.door + "\" にしてください）");
      const e = entranceOf(b);
      if (!isWalkable(e.x, e.y)) problems.push(b.name + " の入口の前が通れません");
      else if (!findPath(C.start.x, C.start.y, e.x, e.y)) problems.push(b.name + " への道がつながっていません");
    });
    return problems;
  }

  // ------------------------------------------------------------
  // 3. 道順さがし（A*）と、なめらかな道のり
  // ------------------------------------------------------------

  // (sx,sy) から (gx,gy) までの道順を、通るマスの並びで返す。行けないときは null。
  // 道（=）は1歩＝1、草原は1歩＝grassCost として、合計が小さい道順を選ぶ。
  function findPath(sx, sy, gx, gy) {
    if (!isWalkable(sx, sy) || !isWalkable(gx, gy)) return null;
    const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const TURN = 0.01;                                  // 曲がる回数を少しだけ減らすための上乗せ
    const key = function (x, y) { return y * COLS + x; };
    const best = new Map();                             // そのマスまでの最小の合計
    const from = new Map();                             // どのマスから来たか
    const open = [{ x: sx, y: sy, g: 0, f: 0, dir: -1 }];
    best.set(key(sx, sy), 0);

    while (open.length > 0) {
      // 見込みの合計（f）がいちばん小さいマスを取り出す
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (cur.g > best.get(key(cur.x, cur.y)) + 1e-9) continue;   // もっと良い道が見つかった後の古い候補

      if (cur.x === gx && cur.y === gy) {
        // 着いた。来た道を逆にたどる
        const tiles = [];
        let k = key(gx, gy);
        while (k !== undefined) {
          tiles.push({ x: k % COLS, y: Math.floor(k / COLS) });
          k = from.get(k);
        }
        return tiles.reverse();
      }

      for (let d = 0; d < 4; d++) {
        const nx = cur.x + DIRS[d][0];
        const ny = cur.y + DIRS[d][1];
        if (!isWalkable(nx, ny)) continue;
        const step = (tileAt(nx, ny) === T.ROAD ? 1 : C.grassCost) + (cur.dir !== -1 && cur.dir !== d ? TURN : 0);
        const g = cur.g + step;
        const k = key(nx, ny);
        if (!best.has(k) || g < best.get(k) - 1e-9) {
          best.set(k, g);
          from.set(k, key(cur.x, cur.y));
          open.push({ x: nx, y: ny, g: g, f: g + Math.abs(gx - nx) + Math.abs(gy - ny), dir: d });
        }
      }
    }
    return null;
  }

  // マスの並びを、角を丸めた「なめらかな道のり」にする。
  // 角は、前後のマスの境目どうしを曲線でつなぐ（通るのは道順のマスの中だけ）。
  // startPos を渡すと、そこ（滑っている途中の位置）から始まる道のりにする。
  function buildRoute(tiles, startPos) {
    const P = tiles.map(function (t) { return { x: t.x + 0.5, y: t.y + 0.5 }; });   // マスの中心
    if (startPos) {
      if (P.length === 1) P.unshift(startPos);          // 行き先が同じマスの中 → そのマスの中心へ
      else P[0] = startPos;                             // いまの位置から、次のマスへなめらかにつなぐ
    }
    const n = P.length;
    const pts = [P[0]];
    if (n === 2) {
      pts.push(P[1]);
    } else if (n > 2) {
      const mid = function (i) { return { x: (P[i].x + P[i + 1].x) / 2, y: (P[i].y + P[i + 1].y) / 2 }; };
      pts.push(mid(0));
      for (let i = 1; i < n - 1; i++) {
        const a = mid(i - 1), b = mid(i), c = P[i];
        const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (Math.abs(cross) < 1e-9) {
          pts.push(b);                                  // まっすぐ
        } else {
          for (let k = 1; k <= 8; k++) {                // 角：曲線を8つに刻む
            const t = k / 8, u = 1 - t;
            pts.push({
              x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
              y: u * u * a.y + 2 * u * t * c.y + t * t * b.y
            });
          }
        }
      }
      pts.push(P[n - 1]);
    }
    // 出発点からの道のりの長さ
    const len = [0];
    for (let i = 1; i < pts.length; i++) {
      len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    return { tiles: tiles, pts: pts, len: len, total: len[len.length - 1], cursor: 1 };
  }

  // 道のりを d だけ進んだ所の位置と向き
  function routeAt(route, d) {
    const pts = route.pts, len = route.len;
    if (pts.length < 2) return { x: pts[0].x, y: pts[0].y, ang: 0 };
    let i = route.cursor;
    while (i < len.length - 1 && len[i] < d) i++;
    while (i > 1 && len[i - 1] > d) i--;
    route.cursor = i;
    const a = pts[i - 1], b = pts[i];
    const seg = len[i] - len[i - 1];
    const t = seg > 0 ? clamp((d - len[i - 1]) / seg, 0, 1) : 0;
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), ang: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  // ------------------------------------------------------------
  // 4. 音（効果音。音声ファイルは使わず、ブラウザの中で作る）
  // ------------------------------------------------------------
  const Sound = {
    on: true,          // 音を出すか（♪ボタンで切り替え）
    ctx: null,         // 音を作る本体。最初にボタンを押した時に作る（ブラウザの決まり）
    master: null,
    noise: null,
    rollGain: null,
    rollFilter: null,

    // 最初の「はい」や♪ボタンで呼ぶ。ここで初めて音が出せるようになる
    unlock: function () {
      if (!this.on) return;
      if (!this.ctx) this.build();
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    },

    build: function () {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;                                  // 音を作れないブラウザでは、何もしない
      const ac = new AC();
      this.ctx = ac;
      this.master = ac.createGain();
      this.master.gain.value = C.sound.volume;
      this.master.connect(ac.destination);

      // 「ザーッ」という雑音を2秒ぶん作る（低い音を多めにした雑音）
      const size = ac.sampleRate * 2;
      const buf = ac.createBuffer(1, size, ac.sampleRate);
      const data = buf.getChannelData(0);
      let low = 0;
      for (let i = 0; i < size; i++) {
        const w = Math.random() * 2 - 1;
        low = (low + 0.04 * w) / 1.04;
        data[i] = low * 3.2 + w * 0.22;
      }
      this.noise = buf;

      // 滑走音：雑音をくり返し流し、速さに合わせて大きさと音の高さを変える
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      this.rollFilter = ac.createBiquadFilter();
      this.rollFilter.type = "bandpass";
      this.rollFilter.frequency.value = 600;
      this.rollFilter.Q.value = 0.8;
      this.rollGain = ac.createGain();
      this.rollGain.gain.value = 0;
      src.connect(this.rollFilter);
      this.rollFilter.connect(this.rollGain);
      this.rollGain.connect(this.master);
      src.start();
    },

    // 滑走音の強さを決める。ratio＝いまの速さ÷最高の速さ（0〜1）、onRoad＝道の上か
    setRoll: function (ratio, onRoad) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const vol = this.on ? ratio * (onRoad ? 0.9 : 0.45) : 0;         // 草原ではこもった小さい音
      const freq = (onRoad ? 520 : 260) + ratio * (onRoad ? 1100 : 320);
      this.rollGain.gain.setTargetAtTime(vol, now, 0.06);
      this.rollFilter.frequency.setTargetAtTime(freq, now, 0.06);
    },

    // 短い音を1回鳴らす（雑音を一瞬だけ流す）
    burst: function (type, freq, dur, vol) {
      if (!this.ctx || !this.on) return;
      const ac = this.ctx, now = ac.currentTime;
      const src = ac.createBufferSource();
      src.buffer = this.noise;
      const f = ac.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      const g = ac.createGain();
      g.gain.setValueAtTime(vol, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start(now, Math.random() * 1.5, dur + 0.05);
    },

    kick: function () { this.burst("lowpass", 420, 0.18, 0.9); },      // 地面を蹴る「ザッ」
    clack: function () { this.burst("bandpass", 1900, 0.04, 0.22); },  // 道の継ぎ目の「カタッ」
    brake: function () { this.burst("bandpass", 900, 0.24, 0.55); },   // 止まる「ザザッ」
    step: function () { this.burst("lowpass", 200, 0.08, 0.7); },      // 板から降りる「トン」
    // ★技（config.js の tricks）で足した音
    pop: function () { this.burst("bandpass", 2400, 0.05, 0.85); this.burst("lowpass", 700, 0.06, 0.6); },    // 板の後ろを弾く「パン」
    land: function () { this.burst("lowpass", 520, 0.16, 1.0); this.burst("bandpass", 1500, 0.12, 0.45); },  // 着地の「ガシャッ」

    // ♪ボタン：音の入／切
    toggle: function () {
      this.on = !this.on;
      if (this.on) this.unlock();
      else this.setRoll(0, true);
      return this.on;
    }
  };

  // BGM（今回は鳴らしません。後で足すときは、この2つの関数の中に書きます）
  //   例：const bgm = new Audio("bgm.mp3"); bgm.loop = true; を用意して、
  //       playBgm の中で bgm.play()、stopBgm の中で bgm.pause() を呼ぶ。
  function playBgm() { /* 今は何もしない */ }
  function stopBgm() { /* 今は何もしない */ }

  // ------------------------------------------------------------
  // 5. 描く部品
  //
  // ★画像に差し替えるとき
  //   下の Art の中の関数が、物ごとの「描き方」です。
  //   差し替えたい物の関数の中身を、ctx.drawImage(画像, x, y, 幅, 高さ) に替えます。
  //   ほかの場所は変えなくて済みます。
  //     top〜 ＝ 全体マップ（真上）用      iso〜 ＝ 移動画面（斜め見下ろし）用
  // ------------------------------------------------------------

  // 色（真上・斜めの両方で同じ色を使う）
  const COLORS = {
    sky: "#a9dcf2",
    grassA: "#86cf5c", grassB: "#7fc855", grassTuft: "#5fae3f",
    roadA: "#e6d3a3", roadB: "#dfca97", roadLine: "rgba(120,90,40,0.20)",
    pondA: "#58b2e8", pondB: "#4fa9e2",
    treeDark: "#2f7d32", treeLight: "#4fa94a", trunk: "#7a5230",
    edgeLeft: "#8a6a45", edgeRight: "#735637",
    window: "#bfe3f5", doorWood: "#5b3a22", outline: "rgba(40,30,20,0.55)"
  };

  // 斜め画面：地図の位置 (wx,wy) を、画面の位置に直す
  function iso(wx, wy) {
    return { x: (wx - wy) * TW / 2, y: (wx + wy) * TH / 2 };
  }

  // 点の並びを塗る
  function fillPoly(ctx, pts, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }

  // 角の丸い四角の道すじを作る
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 建物の形（移動画面）。描くときと、押した場所の判定の両方で使う
  const BUILD = {
    wallH: 60,       // 壁の高さ
    roofH: 36,       // 屋根の高さ
    eave: 1.13       // ひさしの出ぐあい（1 で出っぱり無し）
  };
  function buildingShape(b) {
    const s = b.size;
    const Bk = iso(b.x, b.y);                           // 奥の角
    const R = iso(b.x + s, b.y);                        // 右の角
    const F = iso(b.x + s, b.y + s);                    // 手前の角
    const L = iso(b.x, b.y + s);                        // 左の角
    const cx = (Bk.x + F.x) / 2, cy = (Bk.y + F.y) / 2; // 建物の中心（地面）
    const eave = function (P) {
      return { x: cx + (P.x - cx) * BUILD.eave, y: cy + (P.y - cy) * BUILD.eave - BUILD.wallH };
    };
    return {
      Bk: Bk, R: R, F: F, L: L,
      rB: eave(Bk), rR: eave(R), rF: eave(F), rL: eave(L),          // 屋根の四隅
      apex: { x: cx, y: cy - BUILD.wallH - BUILD.roofH }            // 屋根のてっぺん
    };
  }

  // 看板の横幅の半分（文字数で変わる。描くときと、押した場所の判定の両方で使う）。文字の大きさもここで決める
  function signHalfWidth(b) {
    ctx.font = "bold 16px " + FONT;
    return (ctx.measureText(b.sign || b.name).width + 20) / 2;
  }

  // ---- 準備中の建物（config.js の url が空、または書かれていない建物） ----
  // 着くと「準備中」と知らせるだけで、中には入らない。url を書けば、ほかの建物と同じように入れる。
  function isPending(b) {
    return !(b.url && String(b.url).trim());
  }

  // 建物ごとの、看板（＋準備中の小札）の見せ具合（0＝出さない 〜 1＝そのまま）。書かれていない建物は 1。
  // 背中ごしのカメラで、手前の建物にほとんど隠れた奥の看板を消すのに使う（斜め見下ろしでは何も書かないので、いつも 1）
  const signShow = new Map();

  // 看板の下に吊るす「準備中」の小札（移動画面）。(x,y)＝看板の中心、signH＝看板の高さ。
  // 小札の大きさ・位置は、描くときと押した場所の判定の両方で、この関数で決める
  const PENDING_TAG = { text: "準備中", font: 11, h: 17, gap: 5 };
  function pendingTagRect(g, x, y, signH) {
    g.font = "bold " + PENDING_TAG.font + "px " + FONT;
    const w = g.measureText(PENDING_TAG.text).width + 14;
    const top = y + signH / 2 + PENDING_TAG.gap;
    return { x0: x - w / 2, x1: x + w / 2, y0: y + signH / 2, y1: top + PENDING_TAG.h, top: top, w: w };   // y0〜＝吊りひもを含む
  }
  function drawPendingTag(g, b, x, y, signH) {
    const r = pendingTagRect(g, x, y, signH), col = b.roofColor;
    // 吊りひも（看板の下のふちから、小札の両肩へ）
    g.strokeStyle = shade(col, -0.45);
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(x - r.w * 0.3, r.y0); g.lineTo(x - r.w * 0.3, r.top + 2);
    g.moveTo(x + r.w * 0.3, r.y0); g.lineTo(x + r.w * 0.3, r.top + 2);
    g.stroke();
    // 小札（うすい黄色の板＋建物の色のふち）
    g.fillStyle = "#fff0b8";
    roundRectPath(g, r.x0, r.top, r.w, PENDING_TAG.h, 5);
    g.fill();
    g.strokeStyle = shade(col, -0.25);
    g.lineWidth = 1.5;
    g.stroke();
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#5a3d12";
    g.fillText(PENDING_TAG.text, x, r.top + PENDING_TAG.h / 2 + 0.5);
  }

  // ---- テーマ別の建物の絵（移動画面） ----

  // 建物の絵の置き場。config.js の建物に  art: "uranai"  のように書くと、その絵で描く。
  // 1つの絵は、次の3つを持つ：
  //   draw(ctx, b, g, now) … 描く。b＝建物の設定、g＝土台の四隅 { Bk 奥, R 右, F 手前, L 左 }（地面の高さ・斜め画面のpx）、now＝秒
  //   signAt(g)            … 看板の中心の位置 { x, y }（draw の中で看板を出す場所と同じ）
  //   outline(g)           … 建物の輪郭をおおう多角形（点の並び）。押した場所の判定に使う
  const BUILDING_ART = Object.create(null);   // 元からの名前（constructor など）を持たない入れ物

  // 看板の丸い印。絵の名前 → 印の種類
  const SIGN_ICONS = Object.assign(Object.create(null), { uranai: "star", gohan: "meal", ea: "chart", gazou: "sparkle", guild: "shield", tavern: "mug" });

  // 星形の道すじ（n＝角の数、R＝外の半径、r＝内の半径）
  function signStarPath(ctx, x, y, R, r, n) {
    ctx.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const a = -Math.PI / 2 + i * Math.PI / n, q = i % 2 ? r : R;
      const px = x + Math.cos(a) * q, py = y + Math.sin(a) * q;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
  }

  // 看板の大きさ（文字数で変わる）。描くときと、押した場所の判定の両方で使う。文字の大きさもここで決める
  function buildingSignSize(ctx, b) {
    ctx.font = "bold 16px " + FONT;
    const icon = SIGN_ICONS[b.art] ? 22 : 0;
    return { w: ctx.measureText(b.sign || b.name).width + 22 + icon, h: 28, icon: icon };
  }

  // テーマ別の建物の看板（4つとも同じ形：白い板＋建物の色のふち＋丸い印）。
  //   (x,y)＝看板の中心。posts＝支えの柱の足元の点 [{x,y}, …]（柱は看板の下から足元まで、まっすぐ下ろす。無くてもよい）
  function buildingSign(ctx, b, x, y, posts) {
    const show = signShow.has(b) ? signShow.get(b) : 1;   // 手前の建物に隠れた看板は、薄くする・出さない（signShow）
    if (show <= 0.01) return;
    const alpha0 = ctx.globalAlpha;
    ctx.globalAlpha = alpha0 * show;
    const col = b.roofColor, text = b.sign || b.name;
    const s = buildingSignSize(ctx, b), w = s.w, h = s.h;
    if (posts && posts.length) {
      ctx.strokeStyle = shade(col, -0.45);
      ctx.lineWidth = 3;
      ctx.beginPath();
      posts.forEach(function (p) { ctx.moveTo(p.x, y); ctx.lineTo(p.x, p.y); });
      ctx.stroke();
    }
    ctx.fillStyle = "#fffdf6";
    roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 9);
    ctx.fill();
    ctx.strokeStyle = shade(col, -0.25);
    ctx.lineWidth = 2;
    ctx.stroke();
    if (s.icon) {
      const cx = x - w / 2 + 16, cy = y, kind = SIGN_ICONS[b.art];
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(cx, cy, 9.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.7; ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (kind === "star") {
        signStarPath(ctx, cx, cy + 0.5, 7, 3, 5); ctx.fill();
      } else if (kind === "sparkle") {
        signStarPath(ctx, cx - 1.5, cy + 1, 6.5, 2, 4); ctx.fill();
        signStarPath(ctx, cx + 4.5, cy - 4.5, 3, 1, 4); ctx.fill();
      } else if (kind === "meal") {
        ctx.beginPath();
        ctx.moveTo(cx - 3.5, cy - 6); ctx.lineTo(cx - 3.5, cy + 6);
        ctx.moveTo(cx - 5.7, cy - 6); ctx.lineTo(cx - 5.7, cy - 2.5); ctx.lineTo(cx - 1.3, cy - 2.5); ctx.lineTo(cx - 1.3, cy - 6);
        ctx.moveTo(cx + 3.5, cy - 0.5); ctx.lineTo(cx + 3.5, cy + 6);
        ctx.stroke();
        ctx.beginPath(); ctx.ellipse(cx + 3.5, cy - 3.3, 2.4, 3.2, 0, 0, Math.PI * 2); ctx.fill();
      } else if (kind === "chart") {
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - 6, cy + 4.5); ctx.lineTo(cx - 2, cy); ctx.lineTo(cx + 1, cy + 2.5); ctx.lineTo(cx + 5.5, cy - 4);
        ctx.moveTo(cx + 1.5, cy - 4.5); ctx.lineTo(cx + 5.8, cy - 4.5); ctx.lineTo(cx + 5.8, cy - 0.2);
        ctx.stroke();
      } else if (kind === "shield") {
        // 盾（白い盾の中に、建物の色の右肩上がりの線）
        ctx.beginPath();
        ctx.moveTo(cx - 5.8, cy - 6); ctx.lineTo(cx + 5.8, cy - 6); ctx.lineTo(cx + 5.8, cy - 0.5);
        ctx.quadraticCurveTo(cx + 5.4, cy + 4.6, cx, cy + 7); ctx.quadraticCurveTo(cx - 5.4, cy + 4.6, cx - 5.8, cy - 0.5);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = b.roofColor; ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(cx - 3.2, cy + 2.6); ctx.lineTo(cx - 0.8, cy - 0.2); ctx.lineTo(cx + 0.8, cy + 1); ctx.lineTo(cx + 3.4, cy - 2.8);
        ctx.stroke();
      } else if (kind === "mug") {
        // ジョッキ（泡の乗った胴＋右の取っ手）
        ctx.beginPath();
        ctx.moveTo(cx - 1.8, cy - 4.4); ctx.arc(cx - 4.1, cy - 4.4, 2.3, 0, Math.PI * 2);
        ctx.moveTo(cx + 1.6, cy - 5.2); ctx.arc(cx - 1, cy - 5.2, 2.6, 0, Math.PI * 2);
        ctx.moveTo(cx + 4.4, cy - 4.4); ctx.arc(cx + 2.1, cy - 4.4, 2.3, 0, Math.PI * 2);
        ctx.fill();
        roundRectPath(ctx, cx - 6, cy - 4.5, 8.6, 10.5, 1.6); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx + 2.6, cy - 2); ctx.lineTo(cx + 5.6, cy - 2); ctx.lineTo(cx + 5.6, cy + 3.4); ctx.lineTo(cx + 2.6, cy + 3.4);
        ctx.stroke();
        ctx.strokeStyle = col; ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(cx - 3.4, cy - 1.2); ctx.lineTo(cx - 3.4, cy + 3.8);
        ctx.moveTo(cx - 0.6, cy - 1.2); ctx.lineTo(cx - 0.6, cy + 3.8);
        ctx.stroke();
      }
      ctx.lineCap = "butt"; ctx.lineJoin = "miter";
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 16px " + FONT;
    ctx.fillStyle = "#33283a";
    ctx.fillText(text, x + s.icon / 2 - 1, y + 1);
    if (isPending(b)) drawPendingTag(ctx, b, x, y, h);   // 準備中の建物は、看板の下に小札を吊るす
    ctx.globalAlpha = alpha0;
  }

  // ---- 建物ごとの絵（1棟＝1かたまり。3×3マスの土台を前提にした絵） ----

  // 占いルーム：とんがり帽子の丸い塔のある、星の魔法使いの館（紫の急な屋根・三日月・黒猫・丸窓・アーチの入口）
  BUILDING_ART.uranai = (function () {
    // ---- この建物だけで使う色
    const STONE = "#9a90b4", GOLD = "#f6cf5a", GLOW = "#ffe9a0", WOOD = "#43295f", INK = "#2b2233";
    // ---- 寸法。u＝入口の壁にそった横（0〜3マス）、v＝奥(0)→入口側(3)、z＝地面からの高さ(px)
    const U0 = 0.2, U1 = 2.2, V0 = 1.1, V1 = 2.5, VM = 1.8;      // 母屋の壁と、棟（屋根のてっぺんの線）の位置
    const WALL_H = 52, ZE = 48, ZR = 84;                         // 壁の高さ・軒の高さ・棟の高さ
    const RU0 = 0.05, RU1 = 2.35, RV0 = 0.92, RV1 = 2.68;        // 屋根の広がり
    const DOOR_U = 1.5, DOOR_HW = 0.30, DOOR_ZS = 33;            // 入口の扉（高さ＝33＋0.30×36≒44px）
    const TU = 2.4, TV = 0.8, TR = 0.5, TZ = 92;                 // 丸い塔の中心・半径・高さ
    const CR = 0.66, CZ0 = 88, CZ1 = 141, LEAN = 7;              // とんがり帽子（半径・すそ・先・先の右へのかたむき）
    const SIGN_U0 = 0.46, SIGN_U1 = 1.26, SIGN_H = 118;          // 看板の柱の位置（棟の上）と、看板の中心の高さ
    const KZ = 36, KR = 45.25;                                   // 1マスぶんの縦の長さ・円の横幅の係数

    // 設計の座標 (u,v,z) → 画面の位置、を返す関数を作る
    function projector(g) {
      const ax = (g.R.x - g.Bk.x) / 3, ay = (g.R.y - g.Bk.y) / 3, bx = (g.L.x - g.Bk.x) / 3, by = (g.L.y - g.Bk.y) / 3;
      return function (u, v, z) { return { x: g.Bk.x + u * ax + v * bx, y: g.Bk.y + u * ay + v * by - (z || 0) }; };
    }
    function centerOf(g) { return { x: (g.Bk.x + g.F.x) / 2, y: (g.Bk.y + g.F.y) / 2 }; }

    // 4つ角の星（道すじを足すだけ）
    function star4(ctx, x, y, r) {
      ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.28, y - r * 0.28); ctx.lineTo(x + r, y); ctx.lineTo(x + r * 0.28, y + r * 0.28);
      ctx.lineTo(x, y + r); ctx.lineTo(x - r * 0.28, y + r * 0.28); ctx.lineTo(x - r, y); ctx.lineTo(x - r * 0.28, y - r * 0.28); ctx.closePath();
    }

    function draw(ctx, b, g, now) {
      const P = projector(g), OL = COLORS.outline;
      const wall = b.wallColor, roof = b.roofColor;
      const t = now || 0;
      const SV = 0.10, SU = -0.20, RV = 0.06;                    // 左手前の面／右手前の面／屋根の手前の斜面の明るさ

      // ---- 描く道具
      function trace(pts, open) { ctx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); if (!open) ctx.closePath(); }
      function paint(fill, stroke, lw) {
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke !== null) { ctx.strokeStyle = stroke || OL; ctx.lineWidth = lw || 1; ctx.stroke(); }
      }
      function poly(pts, fill, stroke, lw) { ctx.beginPath(); trace(pts); paint(fill, stroke, lw); }
      function lines(segs, color, lw) { ctx.beginPath(); for (let i = 0; i < segs.length; i++) trace(segs[i], true); ctx.strokeStyle = color; ctx.lineWidth = lw || 1; ctx.stroke(); }
      function rV(u0, u1, v, z0, z1) { return [P(u0, v, z0), P(u1, v, z0), P(u1, v, z1), P(u0, v, z1)]; }   // 左手前を向いた四角
      function rU(u, v0, v1, z0, z1) { return [P(u, v0, z0), P(u, v1, z0), P(u, v1, z1), P(u, v0, z1)]; }   // 右手前を向いた四角
      function box(u0, v0, u1, v1, z0, z1, hex) {
        poly(rV(u0, u1, v1, z0, z1), shade(hex, SV)); poly(rU(u1, v0, v1, z0, z1), shade(hex, SU));
        poly([P(u0, v0, z1), P(u1, v0, z1), P(u1, v1, z1), P(u0, v1, z1)], shade(hex, 0.3));
      }
      function circV(uc, zc, r, v) { const a = []; for (let i = 0; i < 14; i++) { const q = i / 14 * Math.PI * 2; a.push(P(uc + r / KZ * Math.cos(q), v, zc + r * Math.sin(q))); } return a; }
      function archV(uc, hw, v, z0, zs) { const a = [P(uc - hw, v, z0)]; for (let i = 0; i <= 8; i++) { const q = Math.PI - i / 8 * Math.PI; a.push(P(uc + hw * Math.cos(q), v, zs + hw * KZ * Math.sin(q))); } a.push(P(uc + hw, v, z0)); return a; }
      function archU(vc, hw, u, z0, zs) { const a = [P(u, vc - hw, z0)]; for (let i = 0; i <= 8; i++) { const q = Math.PI - i / 8 * Math.PI; a.push(P(u, vc + hw * Math.cos(q), zs + hw * KZ * Math.sin(q))); } a.push(P(u, vc + hw, z0)); return a; }
      function tone(x0, x1, hex) {                               // 丸い物の2色塗り（左が明るい・右が暗い）
        const gr = ctx.createLinearGradient(x0, 0, x1, 0), a = shade(hex, 0.10), d = shade(hex, -0.20);
        gr.addColorStop(0, a); gr.addColorStop(0.56, a); gr.addColorStop(0.56, d); gr.addColorStop(1, d); return gr;
      }
      function dot(p, r, fill, stroke, lw) { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); paint(fill, stroke === undefined ? null : stroke, lw); }
      function S(s, k) { return P(RU0 + (RU1 - RU0) * s, RV1 - (RV1 - VM) * k, ZE + (ZR - ZE) * k); }      // 屋根の手前の斜面の上の点

      // ---- 母屋の壁（左手前＝明るい、右手前の妻壁＝暗い）と、石の土台
      poly(rV(U0, U1, V1, 0, WALL_H + 5), shade(wall, SV));
      poly([P(U1, V0, 0), P(U1, V1, 0), P(U1, V1, WALL_H + 4), P(U1, VM, ZR), P(U1, V0, WALL_H + 4)], shade(wall, SU));
      poly(rV(U0, U1, V1, 0, 7), shade(STONE, SV)); poly(rU(U1, V0, V1, 0, 7), shade(STONE, SU));

      // ---- 入口（石のふちのアーチ＋両開きの扉＋金の星）と、玄関の段
      poly(archV(DOOR_U, DOOR_HW + 0.07, V1, 0, DOOR_ZS), shade(STONE, 0.35));
      poly(archV(DOOR_U, DOOR_HW, V1, 0, DOOR_ZS), WOOD);
      lines([[P(DOOR_U, V1, 0), P(DOOR_U, V1, DOOR_ZS + DOOR_HW * KZ)]], "rgba(0,0,0,0.4)", 1);
      ctx.beginPath(); const ds = P(DOOR_U, V1, 30); star4(ctx, ds.x, ds.y, 5.5); paint(GOLD, null);
      ctx.beginPath(); const k1 = P(DOOR_U - 0.07, V1, 17), k2 = P(DOOR_U + 0.07, V1, 17);                 // 取っ手（2つ）
      ctx.arc(k1.x, k1.y, 1.5, 0, Math.PI * 2); ctx.moveTo(k2.x + 1.5, k2.y); ctx.arc(k2.x, k2.y, 1.5, 0, Math.PI * 2); paint(GOLD, null);
      box(1.1, 2.5, 1.9, 2.72, 0, 4, "#b9b0cc");

      // ---- 丸窓・ランタン・妻壁の窓
      poly(circV(0.68, 29, 9, V1), GLOW, roof, 2.5);
      lines([[P(0.68, V1, 20), P(0.68, V1, 38)], [P(0.43, V1, 29), P(0.93, V1, 29)]], roof, 1.5);
      lines([[P(2.0, V1, 40), P(2.0, V1, 34)]], WOOD, 1.5);
      poly(rV(1.93, 2.07, V1, 26, 34), "#ffd766", WOOD, 1.5);
      poly(archU(2.1, 0.2, U1, 18, 34), GLOW, roof, 2.5);

      // ---- 屋根（紫の急な切妻。軒の裏→手前の斜面→かわらの線→ふちの太い線→金の星）
      poly([P(U1, VM, ZR), P(RU1, VM, ZR), P(RU1, RV0, ZE), P(U1, RV0, ZE)], shade(roof, -0.48));
      poly([S(0, 0), S(1, 0), S(1, 1), S(0, 1)], shade(roof, RV));
      lines([[S(0, 0.27), S(1, 0.27)], [S(0, 0.52), S(1, 0.52)], [S(0, 0.77), S(1, 0.77)]], shade(roof, -0.3), 1);
      ctx.lineJoin = "round";
      lines([[P(RU1, RV1, ZE), P(RU1, VM, ZR), P(RU1, RV0, ZE)]], shade(roof, -0.4), 4);
      lines([[S(0, 1), S(1, 1)]], shade(roof, -0.4), 3);
      ctx.lineJoin = "miter";
      ctx.beginPath();
      let q = S(0.2, 0.42); star4(ctx, q.x, q.y, 4); q = S(0.48, 0.66); star4(ctx, q.x, q.y, 3); q = S(0.72, 0.3); star4(ctx, q.x, q.y, 4.5);
      paint(GOLD, null);

      // ---- 棟の上の黒猫（しっぽが小さくゆれる）
      const cat = P(1.92, VM, ZR), sway = Math.sin(t * 1.6) * 1.5;
      ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(cat.x + 4, cat.y - 2); ctx.quadraticCurveTo(cat.x + 12, cat.y - 2, cat.x + 10 + sway, cat.y - 10); ctx.stroke();
      ctx.lineCap = "butt";
      ctx.fillStyle = INK; ctx.beginPath(); ctx.ellipse(cat.x, cat.y - 6, 5, 6.5, 0, 0, Math.PI * 2);
      ctx.moveTo(cat.x + 3, cat.y - 14); ctx.arc(cat.x - 1, cat.y - 14, 4.2, 0, Math.PI * 2);
      ctx.moveTo(cat.x - 5, cat.y - 15); ctx.lineTo(cat.x - 4.5, cat.y - 21); ctx.lineTo(cat.x - 1, cat.y - 17);
      ctx.lineTo(cat.x + 2.5, cat.y - 21); ctx.lineTo(cat.x + 3, cat.y - 15); ctx.fill();
      ctx.fillStyle = GOLD; ctx.fillRect(cat.x - 3.2, cat.y - 15, 1.6, 1.6); ctx.fillRect(cat.x + 0.2, cat.y - 15, 1.6, 1.6);

      // ---- 丸い塔（胴→足もとの石の帯→窓2つ）
      const tc = P(TU, TV, 0), rx = TR * KR, ry = rx / 2, yb = tc.y, yt = tc.y - TZ;
      ctx.beginPath(); ctx.moveTo(tc.x - rx, yt); ctx.lineTo(tc.x - rx, yb); ctx.ellipse(tc.x, yb, rx, ry, 0, Math.PI, 0, true); ctx.lineTo(tc.x + rx, yt); ctx.closePath();
      paint(tone(tc.x - rx, tc.x + rx, wall));
      ctx.beginPath(); ctx.moveTo(tc.x - rx, yb); ctx.lineTo(tc.x - rx, yb - 7); ctx.ellipse(tc.x, yb - 7, rx, ry, 0, Math.PI, 0, true); ctx.lineTo(tc.x + rx, yb); ctx.ellipse(tc.x, yb, rx, ry, 0, 0, Math.PI, false); ctx.closePath();
      paint(tone(tc.x - rx, tc.x + rx, STONE));
      ctx.beginPath(); ctx.ellipse(tc.x - 8, yb - 58, 6, 8.5, 0, 0, Math.PI * 2); paint(GLOW, roof, 2.5);
      lines([[{ x: tc.x - 8, y: yb - 66 }, { x: tc.x - 8, y: yb - 50 }], [{ x: tc.x - 14, y: yb - 58 }, { x: tc.x - 2, y: yb - 58 }]], roof, 1.5);
      ctx.beginPath(); ctx.ellipse(tc.x + 11, yb - 30, 4, 6, 0, 0, Math.PI * 2); paint(shade(GLOW, -0.12), shade(roof, -0.2), 2);

      // ---- とんがり帽子の屋根（先が少し右へかたむく）と、すその太い線
      const crx = CR * KR, cry = crx / 2, cyb = tc.y - CZ0, tip = { x: tc.x + LEAN, y: tc.y - CZ1 };
      ctx.beginPath(); ctx.moveTo(tc.x - crx, cyb); ctx.ellipse(tc.x, cyb, crx, cry, 0, Math.PI, 0, true); ctx.lineTo(tip.x, tip.y); ctx.closePath();
      paint(tone(tc.x - crx, tc.x + crx, roof));
      ctx.beginPath(); ctx.ellipse(tc.x, cyb, crx, cry, 0, 0.12, Math.PI - 0.12); ctx.strokeStyle = shade(roof, -0.4); ctx.lineWidth = 3; ctx.stroke();
      // 帽子の星（またたく）
      const tw = [[-11, 13, 4.5], [7, 19, 3.5], [0, 32, 3]];
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = 0.72 + 0.28 * Math.cos(t * 2.4 + i * 2.1);
        ctx.beginPath(); star4(ctx, tc.x + tw[i][0], cyb - tw[i][1], tw[i][2]); paint(GOLD, null);
      }
      ctx.globalAlpha = 1;
      // てっぺんの三日月
      const mx = tip.x, my = tip.y - 4;
      ctx.beginPath(); ctx.arc(mx, my, 6, 0.25 * Math.PI, 1.75 * Math.PI, false); ctx.arc(mx + 3, my, 4.42, -1.287, 1.287, true); ctx.closePath(); paint(GOLD, "#8a6a1a", 1);

      // ---- 水晶玉（台座つき。まわりの光がゆっくり明るくなったり暗くなったりする）
      box(0.5, 2.66, 0.76, 2.92, 0, 9, STONE);
      const cb = P(0.63, 2.79, 18);
      dot(cb, 11.5, "rgba(200,170,255," + (0.30 + 0.12 * Math.sin(t * 2)).toFixed(3) + ")");
      dot(cb, 8, "#c9ecff", OL, 1);
      ctx.beginPath(); ctx.arc(cb.x + 1, cb.y + 1, 5, 0.2, 2.2); ctx.strokeStyle = "#9a7be0"; ctx.lineWidth = 2; ctx.stroke();
      dot({ x: cb.x - 3, y: cb.y - 3 }, 2, "#ffffff");

      // ---- 看板（共通の看板。棟の上に立てた2本の柱で支える）
      const s = signAt(g);
      buildingSign(ctx, b, s.x, s.y, [P(SIGN_U0, VM, ZR), P(SIGN_U1, VM, ZR)]);
    }

    // 看板の中心（2本の柱のまん中の真上）
    function signAt(g) {
      const P = projector(g), C = centerOf(g);
      return { x: P((SIGN_U0 + SIGN_U1) / 2, VM, 0).x, y: C.y - SIGN_H };
    }

    // 建物の輪郭（母屋・屋根・塔・とんがり帽子・水晶玉をおおう）
    function outline(g) {
      const P = projector(g), tc = P(TU, TV, 0), rx = TR * KR, crx = CR * KR;
      return [
        P(0.25, 2.95, 0),                                   // 水晶玉の台座の左手前
        P(0.25, 2.95, 30),                                  // 水晶玉の左上
        P(RU0, RV1, ZE),                                    // 軒の左はし
        P(RU0, VM, ZR + 2),                                 // 棟の左はし
        P(1.6, VM, ZR + 22),                                // 棟の上（黒猫の頭）
        { x: tc.x - crx - 2, y: tc.y - CZ0 - 2 },           // 帽子のすその左
        { x: tc.x + LEAN - 9, y: tc.y - CZ1 - 11 },         // 三日月の左上
        { x: tc.x + LEAN + 7, y: tc.y - CZ1 - 11 },         // 三日月の右上
        { x: tc.x + crx + 2, y: tc.y - CZ0 + 4 },           // 帽子のすその右
        { x: tc.x + rx + 1, y: tc.y + 4 },                  // 塔の足もとの右
        { x: tc.x, y: tc.y + rx / 2 + 1 },                  // 塔の足もとの手前
        P(U1, V1, 0),                                       // 母屋の手前の角
        P(1.9, 2.74, 0)                                     // 玄関の段の手前
      ];
    }

    return { draw: draw, signAt: signAt, outline: outline, door: "S" };   // door＝この絵の入口の向き
  })();

  // 食事提案処：オレンジと白のしま模様の日よけと、手前にパラソルのテラス席がある街角のビストロ
  BUILDING_ART.gohan = (function () {
    // ---- この建物だけで使う色 ----
    const TRIM = "#fffaf0", GOLD = "#f2c14e", WARM = "#f6dc9a", LINE = COLORS.outline;
    const DEEP = "#b5502b", AWN = "#f08a4b", FLOWER = "#f26a5a";

    // ---- 建物の寸法（x,y＝土台の中の位置 0〜3マス。x＝右の角のほう、y＝左の角のほう。z＝高さpx） ----
    const X0 = 0.2, X1 = 2.65;      // 壁の左はし・右はし
    const Y0 = 0.3, Y1 = 2.5;       // 壁の奥・手前（入口の壁は、土台の手前の端から0.5マス）
    const YM = 1.4;                 // 屋根のむねの位置
    const H = 60, ZR = 90;          // 軒の高さ・むねの高さ
    const OV = 0.12;                // 屋根の軒の出
    const AW_D = 0.42, AW_Z = 60, AW_DROP = 8;   // 日よけの出・付け根の高さ・下がり
    const SIGN_X = [0.7, 1.5];      // 看板の柱が立つ、むねの上の位置
    const CHIM = 2.42;              // 煙突の位置（むねの上）

    function lit(c) { return shade(c, 0.10); }
    function dim(c) { return shade(c, -0.18); }
    function dn(p, d) { return { x: p.x, y: p.y + d }; }

    // 土台の中の位置 → 斜め画面の点を返す関数を作る
    function geo(g) {
      const ex = { x: (g.R.x - g.Bk.x) / 3, y: (g.R.y - g.Bk.y) / 3 };
      const ey = { x: (g.L.x - g.Bk.x) / 3, y: (g.L.y - g.Bk.y) / 3 };
      return function (x, y, z) {
        return { x: g.Bk.x + ex.x * x + ey.x * y, y: g.Bk.y + ex.y * x + ey.y * y - (z || 0) };
      };
    }

    // 看板の中心（むねの上の2本の柱のまん中。高いほうの柱の足元より上に出す）
    function signAt(g) {
      const P = geo(g), a = P(SIGN_X[0], YM, ZR), c = P(SIGN_X[1], YM, ZR);
      return { x: (a.x + c.x) / 2, y: Math.min(a.y, c.y) - 20 };
    }

    // 建物の輪郭（テラス・壁・屋根・煙突をおおう）
    function outline(g) {
      const P = geo(g);
      return [
        P(X0 - 0.12, 2.95, 0), P(2.95, 2.95, 0), P(2.95, Y0, 0),
        P(X1 + 0.07, Y0, H + 4), P(X1 + 0.07, YM, ZR + 16), P(CHIM - 0.2, YM, ZR + 16),
        P(X0, YM, ZR + 3), P(X0 - 0.12, Y1 + AW_D, AW_Z)
      ];
    }

    function draw(ctx, b, g, now) {
      const P = geo(g);
      const wall = b.wallColor || "#fdebc9", roof = b.roofColor || "#e67a45";
      now = now || 0;

      // ---- 補助 ----
      function poly(pts, fill, stroke) { fillPoly(ctx, pts, fill, stroke === undefined ? LINE : stroke); }
      function line(pts, col, w) {
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
      }
      // 壁の面の上で描く（面にそって傾ける）。fn の中は「右が＋x、上が−y」のpx
      function on(side, x, y, z, fn) {
        const p = P(x, y, z);
        ctx.save(); ctx.transform(0.894, side === "S" ? 0.447 : -0.447, 0, 1, p.x, p.y); fn(); ctx.restore();
      }
      // 窓（白いわく＋桟）。box＝花箱を付ける
      function win(side, x, y, z, w, h, glass, box) {
        on(side, x, y, z, function () {
          ctx.fillStyle = TRIM; ctx.strokeStyle = LINE; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.rect(-w / 2 - 2.5, -h - 2.5, w + 5, h + 5); ctx.fill(); ctx.stroke();
          ctx.fillStyle = glass; ctx.fillRect(-w / 2, -h, w, h);
          ctx.strokeStyle = TRIM; ctx.lineWidth = 1.6; ctx.beginPath();
          if (w > 20) { ctx.moveTo(-w / 6, -h); ctx.lineTo(-w / 6, 0); ctx.moveTo(w / 6, -h); ctx.lineTo(w / 6, 0); }
          else { ctx.moveTo(0, -h); ctx.lineTo(0, 0); ctx.moveTo(-w / 2, -h * 0.6); ctx.lineTo(w / 2, -h * 0.6); }
          ctx.stroke();
          if (box) {
            ctx.fillStyle = "#f3e8d6"; ctx.strokeStyle = LINE; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.rect(-w / 2 - 3, 3, w + 6, 5); ctx.fill(); ctx.stroke();
            ctx.fillStyle = COLORS.treeLight; ctx.beginPath();
            for (let fx = -w / 2; fx <= w / 2 + 0.1; fx += w / 3) { ctx.moveTo(fx + 3, 2); ctx.arc(fx, 2, 3, 0, Math.PI * 2); }
            ctx.fill();
            ctx.fillStyle = FLOWER; ctx.beginPath();
            for (let fx = -w / 2 + w / 6; fx < w / 2; fx += w / 3) { ctx.moveTo(fx + 2.2, 0.5); ctx.arc(fx, 0.5, 2.2, 0, Math.PI * 2); }
            ctx.fill();
          }
        });
      }
      // 丸い植木（鉢つき）
      function shrub(x, y, k) {
        const p = P(x, y);
        ctx.fillStyle = "#f1e6d4"; ctx.strokeStyle = LINE; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x - 5 * k, p.y - 8 * k); ctx.lineTo(p.x + 5 * k, p.y - 8 * k); ctx.lineTo(p.x + 4 * k, p.y + 1); ctx.lineTo(p.x - 4 * k, p.y + 1); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = COLORS.treeDark; ctx.beginPath(); ctx.arc(p.x, p.y - 15 * k, 8 * k, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = COLORS.treeLight; ctx.beginPath(); ctx.arc(p.x - 2 * k, p.y - 17 * k, 5 * k, 0, Math.PI * 2); ctx.fill();
      }

      // ---- 敷地（テラスの石だたみ） ----
      poly([P(0.05, 0.05), P(2.95, 0.05), P(2.95, 2.95), P(0.05, 2.95)], "#efe6d6", "rgba(40,30,20,0.25)");

      // ---- 壁（右手前は三角の妻つき＝暗い面、左手前＝明るい面） ----
      poly([P(X1, Y0, 0), P(X1, Y1, 0), P(X1, Y1, H), P(X1, YM, ZR), P(X1, Y0, H)], dim(wall));
      poly([P(X0, Y1, 0), P(X1, Y1, 0), P(X1, Y1, H), P(X0, Y1, H)], lit(wall));
      // 壁のすそ（石の土台）
      poly([P(X0, Y1, 0), P(X1, Y1, 0), P(X1, Y1, 5), P(X0, Y1, 5)], "#ddd5c8", null);
      poly([P(X1, Y0, 0), P(X1, Y1, 0), P(X1, Y1, 5), P(X1, Y0, 5)], "#b9b1a6", null);
      // 板張りの線
      ctx.beginPath();
      for (let z = 13; z < H - 2; z += 8) {
        const a = P(X0, Y1, z), c = P(X1, Y1, z), d = P(X1, Y0, z);
        ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
      }
      ctx.strokeStyle = "rgba(70,50,70,0.11)"; ctx.lineWidth = 1; ctx.stroke();

      // ---- 右手前の壁：小窓・妻の丸窓・料理の並ぶ飾り窓・電球のひも飾り ----
      win("E", X1, 0.78, 20, 15, 20, WARM, false);
      on("E", X1, YM, 74, function () {
        ctx.beginPath(); ctx.arc(0, 0, 6.5, 0, Math.PI * 2); ctx.fillStyle = TRIM; ctx.fill(); ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, 4.2, 0, Math.PI * 2); ctx.fillStyle = WARM; ctx.fill();
      });
      win("E", X1, 1.93, 17, 30, 24, "#ffeeb5", false);
      on("E", X1, 1.93, 17, function () {
        // 皿と料理（赤・緑・赤）
        ctx.fillStyle = "#fff"; ctx.beginPath();
        [-10, 0, 10].forEach(function (px) { ctx.moveTo(px + 4.2, -4); ctx.ellipse(px, -4, 4.2, 2.3, 0, 0, Math.PI * 2); });
        ctx.fill(); ctx.strokeStyle = "rgba(90,60,30,0.5)"; ctx.lineWidth = 0.8; ctx.stroke();
        ctx.fillStyle = "#e2563c"; ctx.beginPath(); ctx.arc(-10, -5.3, 2.5, 0, Math.PI * 2); ctx.arc(10, -5.3, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#7cb342"; ctx.beginPath(); ctx.arc(0, -5.3, 2.5, 0, Math.PI * 2); ctx.fill();
      });
      // 電球のひも飾り（軒の下に、たるませて1本）
      (function () {
        const A = P(X1, Y1 - 0.06, 56), B = P(X1, Y0 + 0.1, 56), n = 6;
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2 + 9;
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.quadraticCurveTo(mx, my, B.x, B.y);
        ctx.strokeStyle = "rgba(60,45,40,0.75)"; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n, u = 1 - t;
          const px = u * u * A.x + 2 * u * t * mx + t * t * B.x, py = u * u * A.y + 2 * u * t * my + t * t * B.y + 2.5;
          const r = 2.9 + 0.6 * Math.sin(now * 3 + i * 1.7);
          ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, Math.PI * 2);
        }
        ctx.fillStyle = "#ffd766"; ctx.fill(); ctx.strokeStyle = "rgba(120,80,20,0.6)"; ctx.stroke();
      })();
      // 右手前の壁ぎわの植木
      shrub(2.84, 1.32, 1.1);

      // ---- 左手前の壁：花箱の窓と、入口の扉 ----
      win("S", 0.68, Y1, 19, 17, 19, "#ffeeb5", true);
      on("S", 1.5, Y1, 0, function () {
        const w = 26, h = 43, r = w / 2;
        const path = function (gr) {
          ctx.beginPath(); ctx.moveTo(-r - gr, 0); ctx.lineTo(-r - gr, -(h - r)); ctx.arc(0, -(h - r), r + gr, Math.PI, 0); ctx.lineTo(r + gr, 0); ctx.closePath();
        };
        ctx.lineWidth = 1; ctx.strokeStyle = LINE;
        path(3); ctx.fillStyle = TRIM; ctx.fill(); ctx.stroke();
        path(0); ctx.fillStyle = DEEP; ctx.fill(); ctx.stroke();
        // 明かり窓・合わせ目・金の取っ手
        ctx.fillStyle = "#fff3c4"; ctx.beginPath(); ctx.arc(0, -(h - r) + 1, r - 4, Math.PI, 0); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.22)"; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -h + r + 1); ctx.stroke();
        ctx.fillStyle = GOLD; ctx.beginPath(); ctx.arc(3.5, -h * 0.42, 1.9, 0, Math.PI * 2); ctx.arc(-3.5, -h * 0.42, 1.9, 0, Math.PI * 2); ctx.fill();
      });
      // 玄関の踏み段
      poly([P(1.02, Y1), P(1.98, Y1), P(1.98, Y1 + 0.15), P(1.02, Y1 + 0.15)], "#e2dacb");

      // ---- 切妻屋根（むねが x 方向。左手前の斜面が見える） ----
      const drop = (ZR - H) * OV / (Y1 - YM), xe = X1 + 0.07;
      const Sl = function (x, t) { return P(x, YM + (Y1 + OV - YM) * t, ZR + (H - drop - ZR) * t); };
      poly([Sl(X0, 0), Sl(xe, 0), Sl(xe, 1), Sl(X0, 1)], shade(roof, 0.06));
      ctx.beginPath();
      [0.25, 0.5, 0.75].forEach(function (t) { const a = Sl(X0, t), c = Sl(xe, t); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); });
      ctx.strokeStyle = "rgba(0,0,0,0.13)"; ctx.lineWidth = 1; ctx.stroke();
      poly([Sl(X0, 1), Sl(xe, 1), dn(Sl(xe, 1), 3), dn(Sl(X0, 1), 3)], shade(roof, -0.3));
      // 妻の白い破風板
      (function () {
        const A = P(xe, Y1 + OV, H - drop), M = P(xe, YM, ZR), B = P(xe, Y0, H);
        poly([A, M, B, dn(B, 5), dn(M, 5.5), dn(A, 5)], shade(TRIM, -0.07));
      })();

      // ---- 白い煙突と湯気 ----
      const c0 = CHIM - 0.13, c1 = CHIM + 0.13, zc0 = ZR - 5, zc1 = ZR + 12;
      poly([P(c0, YM + 0.13, zc0), P(c1, YM + 0.13, zc0), P(c1, YM + 0.13, zc1), P(c0, YM + 0.13, zc1)], lit("#f1e4d2"));
      poly([P(c1, YM - 0.13, zc0), P(c1, YM + 0.13, zc0), P(c1, YM + 0.13, zc1), P(c1, YM - 0.13, zc1)], dim("#f1e4d2"));
      poly([P(c0, YM - 0.13, zc1), P(c1, YM - 0.13, zc1), P(c1, YM + 0.13, zc1), P(c0, YM + 0.13, zc1)], DEEP);
      const ch = P(CHIM, YM, zc1);
      ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const f = (now * 0.35 + i / 3) % 1;
        const px = ch.x + 6 + f * 24 + Math.sin(now * 1.3 + i) * 2, py = ch.y - 5 - f * 18, r = 3 + f * 3;
        ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, Math.PI * 2);
      }
      ctx.fill();

      // ---- しま模様の日よけ（オレンジと白。入口の壁いっぱい） ----
      (function () {
        const a0 = X0 + 0.08, a1 = X1 - 0.05, n = 8;
        const A = function (a, t) { return P(a, Y1 + AW_D * t, AW_Z - AW_DROP * t); };
        const whole = [A(a0, 0), A(a1, 0), A(a1, 1), dn(A(a1, 1), 6), dn(A(a0, 1), 6), A(a0, 1)];
        poly(whole, AWN, null);
        // 白いしま（1本おき）
        ctx.beginPath();
        for (let i = 1; i < n; i += 2) {
          const p0 = a0 + (a1 - a0) * i / n, p1 = a0 + (a1 - a0) * (i + 1) / n;
          const q = [A(p0, 0), A(p1, 0), A(p1, 1), dn(A(p1, 1), 6), dn(A(p0, 1), 6), A(p0, 1)];
          ctx.moveTo(q[0].x, q[0].y);
          for (let k = 1; k < q.length; k++) ctx.lineTo(q[k].x, q[k].y);
          ctx.closePath();
        }
        ctx.fillStyle = TRIM; ctx.fill();
        // 右はしの横の面（暗い面）
        poly([A(a1, 0), A(a1, 1), dn(A(a1, 1), 6), dn(P(a1, Y1, AW_Z - AW_DROP), 6)], shade(AWN, -0.32));
        // ふちの線と、たれの境目
        ctx.beginPath(); ctx.moveTo(whole[0].x, whole[0].y);
        for (let k = 1; k < whole.length; k++) ctx.lineTo(whole[k].x, whole[k].y);
        ctx.closePath(); ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.stroke();
        line([A(a0, 1), A(a1, 1)], "rgba(40,30,20,0.3)", 1);
      })();

      // ---- 看板（むねの上に、足の台を付けて立てる） ----
      const s = signAt(g), feet = [P(SIGN_X[0], YM, ZR), P(SIGN_X[1], YM, ZR)];
      feet.forEach(function (p) {
        ctx.fillStyle = shade(roof, -0.45);
        ctx.beginPath(); ctx.rect(p.x - 4, p.y - 3, 8, 5); ctx.fill();
      });
      buildingSign(ctx, b, s.x, s.y, feet);

      // ---- テラス：黒板の立て看板（左のはし） ----
      const ab = P(0.25, 2.85);
      ctx.beginPath(); ctx.moveTo(ab.x - 8.5, ab.y); ctx.lineTo(ab.x - 6.5, ab.y - 24); ctx.lineTo(ab.x + 6.5, ab.y - 24); ctx.lineTo(ab.x + 8.5, ab.y); ctx.closePath();
      ctx.fillStyle = "#3f4a44"; ctx.fill(); ctx.strokeStyle = "#a57c4f"; ctx.lineWidth = 2.4; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ab.x - 4, ab.y - 18.5); ctx.lineTo(ab.x + 4, ab.y - 18.5);
      ctx.moveTo(ab.x - 4.5, ab.y - 13); ctx.lineTo(ab.x + 4.5, ab.y - 13);
      ctx.moveTo(ab.x - 5, ab.y - 7.5); ctx.lineTo(ab.x + 2, ab.y - 7.5);
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.4; ctx.stroke();

      // ---- テラス：パラソルの席（右のはし。丸いテーブル・いす2つ・しま模様のパラソル） ----
      const t = P(2.45, 2.7), cp = dn(t, -37);
      // いす
      ctx.fillStyle = "#b98a5e"; ctx.strokeStyle = LINE; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.rect(t.x - 17.5, t.y - 8, 7, 7); ctx.rect(t.x + 10.5, t.y - 5, 7, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#d3a676";
      ctx.beginPath(); ctx.ellipse(t.x - 14, t.y - 8, 5, 2.6, 0, 0, Math.PI * 2); ctx.moveTo(t.x + 19, t.y - 5); ctx.ellipse(t.x + 14, t.y - 5, 5, 2.6, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // 柱とテーブル
      line([t, cp], "#6b5442", 2.4);
      ctx.beginPath(); ctx.ellipse(t.x, t.y - 14, 10.5, 5, 0, 0, Math.PI * 2); ctx.fillStyle = "#fffdf6"; ctx.fill(); ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.stroke();
      // かさ
      const dome = function () {
        ctx.beginPath(); ctx.moveTo(cp.x - 19, cp.y + 6);
        ctx.quadraticCurveTo(cp.x - 13, cp.y - 9, cp.x, cp.y - 10); ctx.quadraticCurveTo(cp.x + 13, cp.y - 9, cp.x + 19, cp.y + 6);
        ctx.ellipse(cp.x, cp.y + 6, 19, 5.5, 0, 0, Math.PI); ctx.closePath();
      };
      dome(); ctx.fillStyle = FLOWER; ctx.fill();
      ctx.fillStyle = TRIM; ctx.beginPath();
      ctx.moveTo(cp.x, cp.y - 10); ctx.lineTo(cp.x - 12, cp.y + 10.3); ctx.lineTo(cp.x - 4, cp.y + 11.4); ctx.closePath();
      ctx.moveTo(cp.x, cp.y - 10); ctx.lineTo(cp.x + 5, cp.y + 11.3); ctx.lineTo(cp.x + 13, cp.y + 10); ctx.closePath();
      ctx.fill();
      dome(); ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); ctx.arc(cp.x, cp.y - 11, 2, 0, Math.PI * 2); ctx.fillStyle = GOLD; ctx.fill(); ctx.stroke();
    }

    return { draw: draw, signAt: signAt, outline: outline, door: "S" };   // door＝この絵の入口の向き
  })();

  // EA紹介所：白いロビーの上に青いガラスの高層棟をのせたビル（チャート画面・屋上に金の右肩上がりの矢印）
  BUILDING_ART.ea = (function () {
    const GOLD = "#f2c230", GOLD_DARK = "#8a6410", NAVY = "#16294f", GLASS = "#a9d2f3";
    const UP = "#3ddc97", DOWN = "#ff6b6b";
    const LOBBY_H = 52;                    // ロビーの高さ
    const T_A0 = 0.5, T_A1 = 2.1;          // 高層棟の場所（Bk→R 方向）。右手前にテラスを残すため、左奥へ寄せてある
    const T_B0 = 1.0, T_B1 = 2.6;          // 高層棟の場所（Bk→L 方向）
    const TOWER_H = 122;                   // 高層棟の屋上の高さ
    const DOOR_H = 43;                     // ガラス扉の高さ

    // 土台の上の位置を決める。a＝Bk→R 方向（0〜3マス）、b＝Bk→L 方向（0〜3マス）、h＝高さ
    function pointer(g) {
      const ax = (g.R.x - g.Bk.x) / 3, ay = (g.R.y - g.Bk.y) / 3, bx = (g.L.x - g.Bk.x) / 3, by = (g.L.y - g.Bk.y) / 3;
      return function (a, b, h) { return { x: g.Bk.x + a * ax + b * bx, y: g.Bk.y + a * ay + b * by - (h || 0) }; };
    }

    // 看板の中心。右手前のテラスの上（入口の真上より少し左）。主人公の頭より上、チャート画面より右
    function signAt(g) {
      const d = pointer(g)(3, 1.5, 0);
      return { x: d.x - 8, y: d.y - 80 };
    }

    // 押した場所の判定用の輪郭（ロビー＋高層棟）
    function outline(g) {
      const P = pointer(g);
      const r = P(3, 0.25, LOBBY_H), k = P(0.25, 0.25, LOBBY_H), e = P(T_A1, T_B0, LOBBY_H);
      // ロビーの屋上の奥のふちが、高層棟の右のふちに隠れる点
      const t = (e.x - r.x) / (k.x - r.x);
      return [
        P(0.25, 3, 0), P(3, 3, 0), P(3, 0.25, 0), r,
        { x: e.x, y: lerp(r.y, k.y, t) },
        P(T_A1, T_B0, TOWER_H),
        (function () { const r = P((T_A0 + T_A1) / 2, (T_B0 + T_B1) / 2, TOWER_H); return { x: r.x + 27, y: r.y - 34 }; })(),   // 金の矢印の先
        P(T_A0, T_B0, TOWER_H), P(T_A0, T_B1, TOWER_H),
        P(T_A0, T_B1, LOBBY_H), P(0.1, 3, LOBBY_H + 3)
      ];
    }

    function draw(ctx, b, g, now) {
      const P = pointer(g), OL = COLORS.outline, roof = b.roofColor, wall = b.wallColor;
      // 左手前を向いた面（b が一定）の四角
      function qS(bb, a0, a1, h0, h1, col, st) {
        fillPoly(ctx, [P(a0, bb, h0), P(a1, bb, h0), P(a1, bb, h1), P(a0, bb, h1)], col, st === undefined ? OL : st);
      }
      // 右手前を向いた面（a が一定）の四角
      function qE(aa, b0, b1, h0, h1, col, st) {
        fillPoly(ctx, [P(aa, b0, h0), P(aa, b1, h0), P(aa, b1, h1), P(aa, b0, h1)], col, st === undefined ? OL : st);
      }
      // 上を向いた面
      function qTop(a0, b0, a1, b1, h, col, st) {
        fillPoly(ctx, [P(a0, b0, h), P(a1, b0, h), P(a1, b1, h), P(a0, b1, h)], col, st === undefined ? OL : st);
      }
      // 線をまとめて引く
      function lines(segs, col, lw) {
        ctx.beginPath();
        segs.forEach(function (s) { ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); });
        ctx.strokeStyle = col; ctx.lineWidth = lw || 1; ctx.stroke();
      }

      // ---- ロビー（白い箱）----
      qS(3, 0.25, 3, 0, LOBBY_H, shade(wall, 0.45));
      qE(3, 0.25, 3, 0, LOBBY_H, shade(wall, -0.16));
      qTop(0.25, 0.25, 3, 3, LOBBY_H, shade(wall, 0.62));
      // 左手前の面の大きなガラス窓
      qS(3, 0.5, 2.75, 8, 36, GLASS);
      lines([[P(0.95, 3, 8), P(0.95, 3, 36)], [P(1.4, 3, 8), P(1.4, 3, 36)], [P(1.85, 3, 8), P(1.85, 3, 36)], [P(2.3, 3, 8), P(2.3, 3, 36)]], "rgba(255,255,255,0.8)", 1.5);
      // 右手前の面の窓（入口の両わき）
      qE(3, 0.4, 0.82, 8, 36, shade(GLASS, -0.18));
      qE(3, 2.18, 2.6, 8, 36, shade(GLASS, -0.18));
      // ロビーの上端の電光の帯（点線が流れる）
      qS(3, 0.25, 3, 43, LOBBY_H, NAVY);
      qE(3, 0.25, 3, 43, LOBBY_H, shade(NAVY, -0.25));
      ctx.setLineDash([9, 7]); ctx.lineDashOffset = -now * 14;
      lines([[P(0.35, 3, 47.5), P(2.95, 3, 47.5)]], GOLD, 3);
      lines([[P(3, 2.9, 47.5), P(3, 0.35, 47.5)]], UP, 3);
      ctx.setLineDash([]); ctx.lineDashOffset = 0;

      // ---- 入口（右手前の面の中央。明るい枠＋ガラスの両開き＋金のひさし）----
      qE(3, 0.98, 2.02, 0, 46.5, "#fbfdff");                                  // 明るい枠（暗い面の中で入口を目立たせる）
      qE(3, 1.07, 1.485, 0, DOOR_H, "#d6f0ff"); qE(3, 1.515, 1.93, 0, DOOR_H, "#d6f0ff");   // ガラスの扉 2枚
      qE(3, 1.07, 1.485, 0, 13, "#fff0b8", null); qE(3, 1.515, 1.93, 0, 13, "#fff0b8", null); // 中の明かりが足元にもれる
      lines([[P(3, 1.15, 34), P(3, 1.33, 20)], [P(3, 1.6, 34), P(3, 1.78, 20)]], "rgba(255,255,255,0.95)", 2);      // ガラスの照り
      lines([[P(3, 1.44, 15), P(3, 1.44, 25)], [P(3, 1.56, 15), P(3, 1.56, 25)]], GOLD_DARK, 3.4);                  // 取っ手（ふち）
      lines([[P(3, 1.44, 15), P(3, 1.44, 25)], [P(3, 1.56, 15), P(3, 1.56, 25)]], GOLD, 2);                         // 取っ手
      // 金のひさし（土台の外へ出るのは 0.15マスまで）
      qS(2.03, 3, 3.15, 46.5, 50.5, shade(GOLD, 0.10));
      qE(3.15, 0.97, 2.03, 46.5, 50.5, shade(GOLD, -0.20));
      qTop(3, 0.97, 3.15, 2.03, 50.5, shade(GOLD, 0.35));
      // 入口の両わきの明かり
      [0.9, 2.1].forEach(function (bb) {
        const p = P(3, bb, 30);
        ctx.beginPath(); ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = "#ffe48a"; ctx.fill(); ctx.strokeStyle = OL; ctx.lineWidth = 1; ctx.stroke();
      });

      // ---- 高層棟（青いガラス張り）----
      const h0 = LOBBY_H, h1 = TOWER_H;
      qS(T_B1, T_A0, T_A1, h0, h1, shade(roof, 0.30));
      qE(T_A1, T_B0, T_B1, h0, h1, shade(roof, -0.10));
      // ガラスの照り（斜めの帯）
      fillPoly(ctx, [P(T_A0 + 0.05, T_B1, h0), P(T_A0 + 0.45, T_B1, h0), P(T_A1 - 0.1, T_B1, h1), P(T_A1 - 0.5, T_B1, h1)], "rgba(255,255,255,0.16)");
      // 窓の桟
      const gl = [];
      for (let h = h0 + 14; h < h1; h += 14) {
        gl.push([P(T_A0, T_B1, h), P(T_A1, T_B1, h)]);
        gl.push([P(T_A1, T_B0, h), P(T_A1, T_B1, h)]);
      }
      for (let i = 1; i < 4; i++) {
        const ua = lerp(T_A0, T_A1, i / 4), ub = lerp(T_B0, T_B1, i / 4);
        gl.push([P(ua, T_B1, h0), P(ua, T_B1, h1)]);
        gl.push([P(T_A1, ub, h0), P(T_A1, ub, h1)]);
      }
      lines(gl, "rgba(255,255,255,0.45)", 1);

      // ---- チャート画面（左手前の面。金の枠・緑と赤のローソク足）----
      const c0 = 61, c1 = 115, ca0 = T_A0 + 0.12, ca1 = T_A1 - 0.12;
      fillPoly(ctx, [P(ca0, T_B1, c0), P(ca1, T_B1, c0), P(ca1, T_B1, c1), P(ca0, T_B1, c1)], "#0f1d3a");
      ctx.strokeStyle = GOLD; ctx.lineWidth = 2; ctx.stroke();
      // [始値, 終値, 上げ＝1／下げ＝0]（画面の下端から上端までを 0〜1 とした高さ）
      const candles = [[0.13, 0.32, 1], [0.32, 0.23, 0], [0.26, 0.52, 1], [0.52, 0.42, 0], [0.45, 0.71, 1], [0.68, 0.84, 1]];
      candles.forEach(function (cd, i) {
        const a = ca0 + 0.16 + i * 0.208, col = cd[2] ? UP : DOWN;
        const lo = lerp(c0, c1, Math.min(cd[0], cd[1]));
        // いちばん右の足だけ、先が少し上下する
        const hi = lerp(c0, c1, Math.max(cd[0], cd[1])) + (i === 5 ? Math.sin(now * 3) * 2 : 0);
        lines([[P(a, T_B1, lo - 3.5), P(a, T_B1, hi + 3.5)]], col, 1.2);
        qS(T_B1, a - 0.066, a + 0.066, lo, hi, col, null);
      });

      // ---- 屋上（金のふち）----
      qTop(T_A0, T_B0, T_A1, T_B1, h1, shade(roof, 0.55), GOLD);
      lines([[P(T_A0, T_B1, h1), P(T_A1, T_B1, h1)], [P(T_A1, T_B1, h1), P(T_A1, T_B0, h1)]], GOLD, 2.5);

      // ---- 屋上の金の矢印（右肩上がり）----
      const r = P((T_A0 + T_A1) / 2, (T_B0 + T_B1) / 2, h1);
      const pts = [[-22, -3], [-9, -15], [1, -8], [16, -23]];
      // 支えの柱
      lines([[{ x: r.x - 16, y: r.y + 3 }, { x: r.x - 16, y: r.y - 8 }], [{ x: r.x + 8, y: r.y + 6 }, { x: r.x + 8, y: r.y - 14 }]], GOLD_DARK, 2);
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      [[GOLD_DARK, 7.5], [GOLD, 5]].forEach(function (s) {
        ctx.beginPath();
        pts.forEach(function (p, i) { if (i) ctx.lineTo(r.x + p[0], r.y + p[1]); else ctx.moveTo(r.x + p[0], r.y + p[1]); });
        ctx.strokeStyle = s[0]; ctx.lineWidth = s[1]; ctx.stroke();
      });
      ctx.lineJoin = "miter"; ctx.lineCap = "butt";
      fillPoly(ctx, [{ x: r.x + 24, y: r.y - 31 }, { x: r.x + 21, y: r.y - 16 }, { x: r.x + 9, y: r.y - 27 }], GOLD, GOLD_DARK);

      // ---- 看板（共通の看板。右手前のテラスに柱を立てて掲げる）----
      const s = signAt(g);
      buildingSign(ctx, b, s.x, s.y, [P(2.72, 2.3, LOBBY_H), P(2.72, 1.35, LOBBY_H)]);
    }

    return { draw: draw, signAt: signAt, outline: outline, door: "E" };   // door＝この絵の入口の向き
  })();

  // 画像生成小屋：手前へ下がるピンクの片流れ屋根に大きな天窓と絵筆をのせた、板張りのアトリエ小屋
  BUILDING_ART.gazou = (function () {
    // ---- この建物だけで使う色 ----
    const WOOD = "#e6c193", WOOD_LINE = "rgba(110,70,30,0.30)", CREAM = "#fff6fa", GOLD = "#f2c230";
    const YELLOW = "#ffd23f", CYAN = "#37c8e0", VIOLET = "#9b6bf2", ORANGE = "#ff8a3c", GREEN = "#5cc26a";
    const BRUSH_PAINT = "#12a8c4";   // 絵筆に付いた絵の具の色（空の色より濃い青緑）

    // ---- 寸法（a＝奥→右の向き、b＝奥→左の向き。どちらも 0〜3 マス。高さは px） ----
    const A0 = 0.15, A1 = 2.85, B0 = 0.1, B1 = 2.9;   // 壁の範囲
    const EA0 = -0.1, EA1 = 3.1, EB0 = 0, EB1 = 3.0;  // 屋根の範囲（土台の外へ出るのは 0.1 マスまで）
    const HE = 58, SLOPE = 8, FASCIA = 5;             // 手前の軒の高さ・1マスあたりの上がり・屋根の厚み
    const SIGN_DX = -17, SIGN_H = 104, POST_DX = 36;   // 看板：土台の中心からの横ずれ・高さ・柱の間隔の半分（高くすると、奥の道を通る主人公の足元を隠す）
    const BRUSH_A = 2.95, BRUSH_B = 0.9;               // 絵筆が立っている屋根の上の場所
    const BRUSH_TILT = 0.22, BRUSH_SIZE = 1.2;         // 絵筆の傾き（右へ）と大きさ

    // 絵筆の中の位置（u＝根元からの長さ、v＝横）→ 画面の位置。base＝柄の先が屋根に付く点
    function brushPoint(base, u, v) {
      const sn = Math.sin(BRUSH_TILT) * BRUSH_SIZE, cs = Math.cos(BRUSH_TILT) * BRUSH_SIZE;
      return { x: base.x + u * sn + v * cs, y: base.y - u * cs + v * sn };
    }

    // 屋根の高さ（b が小さい＝奥ほど高い）
    function roofH(bb) { return HE + (EB1 - bb) * SLOPE; }

    // 土台の上の位置を決める道具。P(a, b, h)＝土台の上の点、R(a, b, dh)＝屋根の面の上の点
    function kit(g) {
      const ax = (g.R.x - g.Bk.x) / 3, ay = (g.R.y - g.Bk.y) / 3, bx = (g.L.x - g.Bk.x) / 3, by = (g.L.y - g.Bk.y) / 3;
      function P(a, bb, h) { return { x: g.Bk.x + a * ax + bb * bx, y: g.Bk.y + a * ay + bb * by - (h || 0) }; }
      function R(a, bb, dh) { return P(a, bb, roofH(bb) + (dh || 0)); }
      return { P: P, R: R, C: { x: (g.Bk.x + g.F.x) / 2, y: (g.Bk.y + g.F.y) / 2 } };
    }

    // 左手前の壁（S面）の上の四角
    function quadS(ctx, P, a0, a1, h0, h1, col, st) {
      fillPoly(ctx, [P(a0, B1, h0), P(a1, B1, h0), P(a1, B1, h1), P(a0, B1, h1)], col, st);
    }
    // 右手前の壁（E面）の上の四角
    function quadE(ctx, P, b0, b1, h0, h1, col, st) {
      fillPoly(ctx, [P(A1, b0, h0), P(A1, b1, h0), P(A1, b1, h1), P(A1, b0, h1)], col, st);
    }
    // 線をまとめて1回で引く
    function strokeLines(ctx, segs, col, lw) {
      ctx.beginPath();
      segs.forEach(function (s) { ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); });
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
    }
    // 丸・だ円を塗る
    function blob(ctx, x, y, rx, ry, rot, col) {
      ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    }

    // 看板の中心
    function signAt(g) {
      const k = kit(g);
      return { x: k.C.x + SIGN_DX, y: k.C.y - SIGN_H };
    }

    // 看板の柱の足元（屋根の面の上の2点。看板の中心から左右へ POST_DX）
    function signPosts(g) {
      const k = kit(g), tile = (g.R.x - g.Bk.x) / 3, bL = 1.7, bR = 0.4;
      return [k.R(bL + (SIGN_DX - POST_DX) / tile, bL), k.R(bR + (SIGN_DX + POST_DX) / tile, bR)];
    }

    // 屋根の上の大きな絵筆（base＝柄の先が屋根に付く点。上へ 柄→金具→毛先 の順）
    function drawBrush(ctx, base) {
      const OL = COLORS.outline, tilt = BRUSH_TILT;
      function B(u, v) { return brushPoint(base, u, v); }
      // 毛の形（根元からふくらんで、先が丸くとがる）
      function bristlePath() {
        const p0 = B(40, -7.5), c1 = B(45, -15), c2 = B(57, -11), tip = B(64, 0), c3 = B(57, 11), c4 = B(45, 15), p1 = B(40, 7.5);
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y);
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, tip.x, tip.y);
        ctx.bezierCurveTo(c3.x, c3.y, c4.x, c4.y, p1.x, p1.y);
        ctx.closePath();
      }
      // 柄をつたって屋根に落ちた絵の具
      blob(ctx, base.x + 1, base.y + 1, 8, 4, 0.45, BRUSH_PAINT);
      // 柄（木。下が細く、上が太い。右側に陰、根元に近い所にピンクの帯）
      fillPoly(ctx, [B(0, -3), B(0, 3), B(30, 5.5), B(30, -5.5)], "#c98b4a", OL);
      fillPoly(ctx, [B(0, 0.8), B(0, 3), B(30, 5.5), B(30, 2.4)], "#9f6a35");
      fillPoly(ctx, [B(6, -3.5), B(6, 3.5), B(11, 3.9), B(11, -3.9)], "#d6508f", OL);
      // 金具（銀。横に2本のすじ）
      fillPoly(ctx, [B(30, -6.5), B(30, 6.5), B(40, 7.5), B(40, -7.5)], "#cfd6dd", OL);
      strokeLines(ctx, [[B(33, -6.8), B(33, 6.8)], [B(37, -7.2), B(37, 7.2)]], "rgba(60,70,90,0.55)", 1);
      // 毛（根元は毛の色）
      bristlePath();
      ctx.fillStyle = "#f3e2b8"; ctx.fill();
      strokeLines(ctx, [[B(40.5, -3), B(46, -4.5)], [B(40.5, 3), B(46, 4.5)]], "rgba(120,90,40,0.45)", 1);
      // 毛先にたっぷり付いた絵の具（青緑。下のふちは波形）
      const a0 = B(46.07, -11.27), a1 = B(51.75, -11.97), a2 = B(59.1, -7.7), tp = B(64, 0);
      const a3 = B(59.1, 7.7), a4 = B(51.75, 11.97), a5 = B(46.07, 11.27), w1 = B(49.5, 5), w2 = B(45.5, 0.5), w3 = B(49.5, -5);
      ctx.beginPath(); ctx.moveTo(a0.x, a0.y);
      ctx.bezierCurveTo(a1.x, a1.y, a2.x, a2.y, tp.x, tp.y);
      ctx.bezierCurveTo(a3.x, a3.y, a4.x, a4.y, a5.x, a5.y);
      ctx.lineTo(w1.x, w1.y); ctx.lineTo(w2.x, w2.y); ctx.lineTo(w3.x, w3.y); ctx.closePath();
      ctx.fillStyle = BRUSH_PAINT; ctx.fill();
      const hl = B(54, -5);
      blob(ctx, hl.x, hl.y, 2.2, 5, tilt, "rgba(255,255,255,0.55)");
      // 毛の輪郭
      bristlePath();
      ctx.strokeStyle = OL; ctx.lineWidth = 1; ctx.stroke();
    }

    function draw(ctx, b, g, now) {
      const k = kit(g), P = k.P, R = k.R, OL = COLORS.outline, roof = b.roofColor, t = now || 0;

      // 壁（板張り）。左手前＝明るい、右手前＝暗い。右の壁は奥ほど高い
      quadS(ctx, P, A0, A1, 0, roofH(B1), shade(WOOD, 0.12), OL);
      fillPoly(ctx, [P(A1, B0, 0), P(A1, B1, 0), P(A1, B1, roofH(B1)), P(A1, B0, roofH(B0))], shade(WOOD, -0.20), OL);
      const planks = [];
      for (let h = 14; h < roofH(B0); h += 14) {
        if (h < roofH(B1)) planks.push([P(A0, B1, h), P(A1, B1, h)]);
        planks.push([P(A1, B0, h), P(A1, h > roofH(B1) ? (HE - h) / SLOPE + EB1 : B1, h)]);
      }
      strokeLines(ctx, planks, WOOD_LINE, 1);

      // 左手前の壁：窓2つ
      quadS(ctx, P, 0.3, 0.88, 18, 42, COLORS.window, OL);
      quadS(ctx, P, 2.12, 2.7, 18, 42, COLORS.window, OL);
      strokeLines(ctx, [
        [P(0.59, B1, 18), P(0.59, B1, 42)], [P(2.41, B1, 18), P(2.41, B1, 42)],
        [P(0.3, B1, 30), P(0.88, B1, 30)], [P(2.12, B1, 30), P(2.7, B1, 30)]
      ], "#fff", 1.5);

      // 入口（白い枠＋ピンクの扉＋丸窓＋取っ手）。扉の高さ 46
      quadS(ctx, P, 1.04, 1.96, 0, 49, CREAM, OL);
      quadS(ctx, P, 1.11, 1.89, 0, 46, roof, OL);
      const dw = P(1.5, B1, 31);
      blob(ctx, dw.x, dw.y, 6, 6.5, 0, "#ffe9a0");
      ctx.strokeStyle = CREAM; ctx.lineWidth = 2; ctx.stroke();
      const kb = P(1.78, B1, 19);
      blob(ctx, kb.x, kb.y, 2, 2, 0, GOLD);

      // 右手前の壁：風景画のキャンバス（空・丘・太陽）
      quadE(ctx, P, 0.6, 1.9, 15, 50, "#fffdf5", OL);
      quadE(ctx, P, 0.69, 1.81, 19, 46, "#8fd3ff", null);
      fillPoly(ctx, [P(A1, 0.69, 19), P(A1, 1.81, 19), P(A1, 1.81, 28), P(A1, 1.45, 35), P(A1, 1.1, 27), P(A1, 0.69, 32)], GREEN);
      const sun = P(A1, 0.97, 39);
      blob(ctx, sun.x, sun.y, 4, 4, 0, YELLOW);
      // 右手前の壁に飛んだ絵の具
      [[2.45, 15, YELLOW, 7], [0.38, 11, CYAN, 6], [2.35, 36, VIOLET, 5]].forEach(function (sp) {
        const p = P(A1, sp[0], sp[1]);
        ctx.beginPath(); ctx.ellipse(p.x, p.y, sp[3] * 0.8, sp[3], 0, 0, Math.PI * 2);
        ctx.arc(p.x + sp[3] * 0.9, p.y + sp[3] * 0.9, sp[3] * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = sp[2]; ctx.fill();
      });

      // 屋根（片流れ：手前へ下がる大きな1枚）。上の面＝いちばん明るい、左手前の厚み＝中、右手前の厚み＝暗い
      fillPoly(ctx, [R(EA0, EB1), R(EA1, EB1), R(EA1, EB0), R(EA0, EB0)], shade(roof, 0.12), OL);
      fillPoly(ctx, [R(EA0, EB1), R(EA1, EB1), R(EA1, EB1, -FASCIA), R(EA0, EB1, -FASCIA)], shade(roof, -0.10), OL);
      fillPoly(ctx, [R(EA1, EB1), R(EA1, EB0), R(EA1, EB0, -FASCIA), R(EA1, EB1, -FASCIA)], shade(roof, -0.38), OL);

      // 天窓（白い枠＋ガラス＋光のすじ＋十字の桟）
      fillPoly(ctx, [R(1.25, 2.4), R(2.8, 2.4), R(2.8, 0.7), R(1.25, 0.7)], CREAM, OL);
      fillPoly(ctx, [R(1.36, 2.29), R(2.69, 2.29), R(2.69, 0.81), R(1.36, 0.81)], "#bfe9fb");
      const gx = 1.45 + 0.2 * Math.sin(t * 0.8);
      fillPoly(ctx, [R(gx, 2.29), R(gx + 0.3, 2.29), R(gx + 0.9, 0.81), R(gx + 0.6, 0.81)], "rgba(255,255,255,0.55)");
      strokeLines(ctx, [[R(2.02, 2.29), R(2.02, 0.81)], [R(1.36, 1.55), R(2.69, 1.55)]], CREAM, 2.5);

      // 屋根に飛んだ絵の具（屋根の傾きに合わせた だ円）
      [[0.5, 2.05, YELLOW, 8], [0.72, 1.1, CYAN, 6], [0.28, 2.65, VIOLET, 5], [2.5, 2.72, GREEN, 5]].forEach(function (sp) {
        const p = R(sp[0], sp[1]);
        blob(ctx, p.x, p.y, sp[3] * 1.5, sp[3] * 0.8, -0.3, sp[2]);
      });
      // 手前の軒から垂れる絵の具（扉の上は避ける）
      [[0.12, YELLOW, 10], [0.55, CYAN, 7], [2.3, ORANGE, 7], [2.75, GREEN, 10]].forEach(function (dr) {
        const p = R(dr[0], EB1, -3);
        ctx.fillStyle = dr[1]; roundRectPath(ctx, p.x - 4, p.y - 2, 8, dr[2], 4); ctx.fill();
      });

      // 屋根の上の大きな絵筆（右の奥）
      drawBrush(ctx, R(BRUSH_A, BRUSH_B));

      // 看板（共通の形）。屋根のてっぺんに、2本の柱で立てる
      const s = signAt(g);
      buildingSign(ctx, b, s.x, s.y, signPosts(g));
    }

    // 建物の輪郭（屋根の四隅と、壁の足元。屋根の上の絵筆の頭もふくめる）
    function outline(g) {
      const k = kit(g), P = k.P, R = k.R, base = R(BRUSH_A, BRUSH_B);
      return [
        R(EA0, EB1), R(EA0, EB0),
        brushPoint(base, 36, -10), brushPoint(base, 50, -16), brushPoint(base, 67, 0), brushPoint(base, 50, 16), brushPoint(base, 34, 10),
        R(EA1, EB0), R(EA1, EB0, -FASCIA),
        P(A1, B0, 0), P(A1, B1, 0), P(A0, B1, 0), R(EA0, EB1, -FASCIA)
      ];
    }

    return { draw: draw, signAt: signAt, outline: outline, door: "S" };   // door＝この絵の入口の向き
  })();

  // EAギルド：旗と紋章を掲げた石造りのギルド館（入口の上の三角の壁に金の盾の紋章・左手前に旗の立つ見張り塔・壁に吊った旗・入口の両わきのたいまつ）
  BUILDING_ART.guild = (function () {
    // ---- この建物だけで使う色
    const GOLD = "#f2c230", GOLD_DARK = "#8a6410", WOOD = "#5b3a22", IRON = "#3b3538", GLOW = "#ffd98a", JOINT = "rgba(70,58,40,0.28)";
    // ---- 寸法。u＝奥→右の角の向き（入口の壁は u＝U1）、v＝奥→左の角の向き、z＝地面からの高さ(px)
    const U0 = 0.95, U1 = 2.8, V0 = 0.3, V1 = 2.7, VM = 1.5;        // 母屋の壁と、棟（u の向きに通す＝入口の壁が三角の妻壁になる）
    const WALL_H = 60, ZE = 56, ZR = 90;                            // 壁の高さ・軒の高さ・棟の高さ
    const RU1 = 2.95, RV0 = 0.22, RV1 = 2.85;                       // 屋根の広がり（左はしは塔の右の壁 U0 にそろえる）
    const DOOR_V = 1.5, DOOR_HW = 0.3, DOOR_ZS = 31;                // 入口の扉（高さ＝31＋0.30×36≒42px）
    const TA0 = 0.15, TA1 = 0.95, TB0 = 1.95, TB1 = 2.85, TZ = 112; // 見張り塔（左手前の角）の範囲と高さ
    const POLE_U = 0.55, POLE_V = 2.4, POLE_H = 30;                 // 塔の上の旗ざおの位置と高さ
    const SIGN_U0 = 1.55, SIGN_U1 = 2.85, SIGN_H = 112;             // 看板の柱の位置（棟の上）と、看板の中心の高さ
    const KZ = 36;                                                  // 1マスぶんの縦の長さ

    // 設計の座標 (u,v,z) → 画面の位置、を返す関数を作る
    function projector(g) {
      const ax = (g.R.x - g.Bk.x) / 3, ay = (g.R.y - g.Bk.y) / 3, bx = (g.L.x - g.Bk.x) / 3, by = (g.L.y - g.Bk.y) / 3;
      return function (u, v, z) { return { x: g.Bk.x + u * ax + v * bx, y: g.Bk.y + u * ay + v * by - (z || 0) }; };
    }
    function centerOf(g) { return { x: (g.Bk.x + g.F.x) / 2, y: (g.Bk.y + g.F.y) / 2 }; }

    function draw(ctx, b, g, now) {
      const P = projector(g), OL = COLORS.outline;
      const wall = b.wallColor, roof = b.roofColor;
      const t = now || 0;
      const SV = 0.10, SU = -0.20, RV = 0.04;                      // 左手前の面／右手前の面／屋根の手前の斜面の明るさ

      // ---- 描く道具
      function trace(pts, open) { ctx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); if (!open) ctx.closePath(); }
      function paint(fill, stroke, lw) {
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke !== null) { ctx.strokeStyle = stroke || OL; ctx.lineWidth = lw || 1; ctx.stroke(); }
      }
      function poly(pts, fill, stroke, lw) { ctx.beginPath(); trace(pts); paint(fill, stroke, lw); }
      function lines(segs, color, lw) { ctx.beginPath(); for (let i = 0; i < segs.length; i++) trace(segs[i], true); ctx.strokeStyle = color; ctx.lineWidth = lw || 1; ctx.stroke(); }
      function rV(u0, u1, v, z0, z1) { return [P(u0, v, z0), P(u1, v, z0), P(u1, v, z1), P(u0, v, z1)]; }   // 左手前を向いた四角
      function rU(u, v0, v1, z0, z1) { return [P(u, v0, z0), P(u, v1, z0), P(u, v1, z1), P(u, v0, z1)]; }   // 右手前を向いた四角
      function box(u0, v0, u1, v1, z0, z1, hex) {
        poly(rV(u0, u1, v1, z0, z1), shade(hex, SV)); poly(rU(u1, v0, v1, z0, z1), shade(hex, SU));
        poly([P(u0, v0, z1), P(u1, v0, z1), P(u1, v1, z1), P(u0, v1, z1)], shade(hex, 0.3));
      }
      function archV(uc, hw, v, z0, zs) { const a = [P(uc - hw, v, z0)]; for (let i = 0; i <= 8; i++) { const q = Math.PI - i / 8 * Math.PI; a.push(P(uc + hw * Math.cos(q), v, zs + hw * KZ * Math.sin(q))); } a.push(P(uc + hw, v, z0)); return a; }
      function archU(vc, hw, u, z0, zs) { const a = [P(u, vc - hw, z0)]; for (let i = 0; i <= 8; i++) { const q = Math.PI - i / 8 * Math.PI; a.push(P(u, vc + hw * Math.cos(q), zs + hw * KZ * Math.sin(q))); } a.push(P(u, vc + hw, z0)); return a; }
      // 石積みの目地（左手前の面＝v 一定／右手前の面＝u 一定）。段ごとに縦の目地をずらす
      function jointsV(u0, u1, v, z1) {
        const s = [];
        for (let z = 12, r = 0; z < z1; z += 12, r++) {
          s.push([P(u0, v, z), P(u1, v, z)]);
          for (let u = u0 + (r % 2 ? 0.2 : 0.38); u < u1 - 0.05; u += 0.36) s.push([P(u, v, z), P(u, v, Math.min(z + 12, z1))]);
        }
        lines(s, JOINT, 1);
      }
      function jointsU(u, v0, v1, z1) {
        const s = [];
        for (let z = 12, r = 0; z < z1; z += 12, r++) {
          s.push([P(u, v0, z), P(u, v1, z)]);
          for (let v = v0 + (r % 2 ? 0.2 : 0.38); v < v1 - 0.05; v += 0.36) s.push([P(u, v, z), P(u, v, Math.min(z + 12, z1))]);
        }
        lines(s, JOINT, 1);
      }

      // ==== 見張り塔（左手前の角。母屋より先に描く＝母屋の壁と屋根が、塔の根元の手前に重なる）
      poly(rV(TA0, TA1, TB1, 0, TZ), shade(wall, SV));
      poly(rU(TA1, TB0, TB1, 0, TZ), shade(wall, SU));
      jointsV(TA0, TA1, TB1, TZ); jointsU(TA1, TB0, TB1, TZ);
      poly(rV(TA0, TA1, TB1, 0, 7), shade(wall, -0.18)); poly(rU(TA1, TB0, TB1, 0, 7), shade(wall, -0.35));   // 足もとの石の帯
      // 細長い窓（上が丸い。明かりがゆっくりまたたく）
      const flick = 0.82 + 0.18 * Math.sin(t * 2.3);
      ctx.globalAlpha = flick;
      poly(archV((TA0 + TA1) / 2, 0.09, TB1, 66, 84), GLOW, IRON, 1.5);
      poly(archV((TA0 + TA1) / 2, 0.09, TB1, 30, 46), GLOW, IRON, 1.5);
      poly(archU((TB0 + TB1) / 2, 0.09, TA1, 66, 84), shade(GLOW, -0.12), IRON, 1.5);
      ctx.globalAlpha = 1;
      // 屋上（床＋凸凹の胸壁。奥の凸から順に描く）
      poly([P(TA0, TB0, TZ), P(TA1, TB0, TZ), P(TA1, TB1, TZ), P(TA0, TB1, TZ)], shade(wall, -0.30));
      const M = 0.16, merl = [];
      [[TA0, TA0 + M], [(TA0 + TA1) / 2 - M / 2, (TA0 + TA1) / 2 + M / 2], [TA1 - M, TA1]].forEach(function (a) {
        merl.push([a[0], TB0, a[1], TB0 + M]); merl.push([a[0], TB1 - M, a[1], TB1]);
      });
      [[TB0 + M + 0.12, TB0 + 2 * M + 0.12], [TB1 - 2 * M - 0.12, TB1 - M - 0.12]].forEach(function (c) {
        merl.push([TA0, c[0], TA0 + M, c[1]]); merl.push([TA1 - M, c[0], TA1, c[1]]);
      });
      merl.sort(function (p, q) { return (p[0] + p[1] + p[2] + p[3]) - (q[0] + q[1] + q[2] + q[3]); });
      merl.forEach(function (m) { box(m[0], m[1], m[2], m[3], TZ, TZ + 8, wall); });

      // ---- 塔の上の旗（左へなびく。ギルドの色の地に金のコイン）
      const pb = P(POLE_U, POLE_V, TZ), pt = P(POLE_U, POLE_V, TZ + POLE_H);
      lines([[pb, pt]], IRON, 2.2);
      const FL = 30, FH = 17, N = 8, top = [], bot = [];
      for (let i = 0; i <= N; i++) {
        const k = i / N, dy = Math.sin(t * 3.2 - i * 0.85) * 2.4 * k;
        top.push({ x: pt.x - 1 - FL * k, y: pt.y + 3 + dy });
        bot.push({ x: pt.x - 1 - FL * k, y: pt.y + 3 + FH + dy });
      }
      const tail = { x: bot[N].x + 6, y: (top[N].y + bot[N].y) / 2 };   // 燕尾（先の切れこみ）
      poly(top.concat([tail]).concat(bot.slice().reverse()), roof, shade(roof, -0.45), 1);
      lines([top.slice(0, 3), bot.slice(0, 3)], GOLD, 1.5);                // 根元の金のふち
      const cm = { x: (top[3].x + bot[3].x) / 2, y: (top[3].y + bot[3].y) / 2 };
      ctx.beginPath(); ctx.arc(cm.x, cm.y, 4.6, 0, Math.PI * 2); paint(GOLD, GOLD_DARK, 1);
      lines([[{ x: cm.x - 2.2, y: cm.y + 1.6 }, { x: cm.x, y: cm.y - 0.6 }, { x: cm.x + 2.4, y: cm.y - 2.6 }]], GOLD_DARK, 1.2);
      ctx.beginPath(); ctx.arc(pt.x, pt.y - 1.5, 2.6, 0, Math.PI * 2); paint(GOLD, GOLD_DARK, 1);   // さおの先の金の玉

      // ==== 母屋の壁（左手前＝明るい、右手前の三角の妻壁＝暗い）と、石の土台
      poly(rV(U0, U1, V1, 0, WALL_H), shade(wall, SV));
      poly([P(U1, V0, 0), P(U1, V1, 0), P(U1, V1, WALL_H), P(U1, VM, ZR), P(U1, V0, WALL_H)], shade(wall, SU));
      jointsV(U0, U1, V1, WALL_H); jointsU(U1, V0, V1, WALL_H);
      poly(rV(U0, U1, V1, 0, 7), shade(wall, -0.18)); poly(rU(U1, V0, V1, 0, 7), shade(wall, -0.35));

      // ---- 左手前の壁：上が丸い窓2つ（明かりがまたたく）と、まん中に吊った旗
      ctx.globalAlpha = flick;
      [1.38, 2.4].forEach(function (u) {
        poly(archV(u, 0.16, V1, 14, 30), GLOW, shade(wall, -0.45), 2);
        lines([[P(u, V1, 14), P(u, V1, 30 + 0.16 * KZ)], [P(u - 0.16, V1, 26), P(u + 0.16, V1, 26)]], shade(wall, -0.45), 1.3);
      });
      ctx.globalAlpha = 1;
      const BU = 1.89, BW = 0.19;
      poly([P(BU - BW, V1, 52), P(BU + BW, V1, 52), P(BU + BW, V1, 20), P(BU, V1, 26), P(BU - BW, V1, 20)], roof, shade(roof, -0.45), 1);
      lines([[P(BU - BW - 0.05, V1, 52.5), P(BU + BW + 0.05, V1, 52.5)]], GOLD_DARK, 2.5);   // 旗をさげる棒
      lines([[P(BU - BW + 0.05, V1, 49), P(BU - BW + 0.05, V1, 23)], [P(BU + BW - 0.05, V1, 49), P(BU + BW - 0.05, V1, 23)]], GOLD, 1);
      const bc = P(BU, V1, 39);
      ctx.beginPath(); ctx.arc(bc.x, bc.y, 4, 0, Math.PI * 2); paint(GOLD, GOLD_DARK, 1);

      // ---- 入口（右手前の妻壁の中央。石のふちのアーチ＋鉄の帯の木の扉＋取っ手）と、石の段
      poly(archU(DOOR_V, DOOR_HW + 0.08, U1, 0, DOOR_ZS), shade(wall, 0.25));
      poly(archU(DOOR_V, DOOR_HW, U1, 0, DOOR_ZS), WOOD);
      lines([[P(U1, DOOR_V, 0), P(U1, DOOR_V, DOOR_ZS + DOOR_HW * KZ)]], "rgba(0,0,0,0.45)", 1);
      lines([[P(U1, DOOR_V - DOOR_HW, 10), P(U1, DOOR_V + DOOR_HW, 10)], [P(U1, DOOR_V - DOOR_HW, 27), P(U1, DOOR_V + DOOR_HW, 27)]], IRON, 2.5);
      const k1 = P(U1, DOOR_V - 0.08, 18), k2 = P(U1, DOOR_V + 0.08, 18);
      ctx.beginPath(); ctx.arc(k1.x, k1.y, 2.2, 0, Math.PI * 2); ctx.moveTo(k2.x + 2.2, k2.y); ctx.arc(k2.x, k2.y, 2.2, 0, Math.PI * 2);
      paint(null, GOLD, 1.5);
      box(U1, DOOR_V - 0.45, 3.06, DOOR_V + 0.45, 0, 5, wall);

      // ---- 入口の両わきのたいまつ（炎がゆれる）
      [0.88, 2.12].forEach(function (v, i) {
        const base = P(U1, v, 30), f = 1 + 0.12 * Math.sin(t * 7 + i * 2.1);
        lines([[base, { x: base.x + 4, y: base.y - 3 }]], IRON, 2.5);
        const fx = base.x + 4, fy = base.y - 4;
        ctx.beginPath(); ctx.moveTo(fx, fy - 9 * f); ctx.quadraticCurveTo(fx + 4.5, fy - 2, fx, fy + 1); ctx.quadraticCurveTo(fx - 4.5, fy - 2, fx, fy - 9 * f);
        paint("#ff9a3c", null);
        ctx.beginPath(); ctx.moveTo(fx, fy - 5.5 * f); ctx.quadraticCurveTo(fx + 2.2, fy - 1.5, fx, fy); ctx.quadraticCurveTo(fx - 2.2, fy - 1.5, fx, fy - 5.5 * f);
        paint("#ffe48a", null);
      });

      // ---- 入口の上の紋章（金のふちの盾。中に金の右肩上がりの線）
      function shieldPath(vc, hw, zt, zs, zb) {
        const a = P(U1, vc + hw, zt), b2 = P(U1, vc - hw, zt), c = P(U1, vc - hw, zs), d = P(U1, vc, zb), e = P(U1, vc + hw, zs);
        const c1 = P(U1, vc - hw, zb + 4), c2 = P(U1, vc + hw, zb + 4);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y); ctx.lineTo(c.x, c.y);
        ctx.quadraticCurveTo(c1.x, c1.y, d.x, d.y); ctx.quadraticCurveTo(c2.x, c2.y, e.x, e.y); ctx.closePath();
      }
      shieldPath(DOOR_V, 0.23, 72, 61, 46); paint(GOLD, GOLD_DARK, 1);
      shieldPath(DOOR_V, 0.175, 69.5, 61, 50); paint(roof, null);
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      lines([[P(U1, DOOR_V + 0.11, 55), P(U1, DOOR_V + 0.03, 61), P(U1, DOOR_V - 0.03, 58), P(U1, DOOR_V - 0.11, 66)]], GOLD, 2);
      lines([[P(U1, DOOR_V - 0.04, 66.5), P(U1, DOOR_V - 0.11, 66), P(U1, DOOR_V - 0.11, 62)]], GOLD, 2);
      ctx.lineJoin = "miter"; ctx.lineCap = "butt";

      // ==== 屋根（ギルドの色のスレートの切妻。軒の裏→手前の斜面→スレートの目地→ふちの太い線→金の棟）
      function S(s, k) { return P(U0 + (RU1 - U0) * s, RV1 - (RV1 - VM) * k, ZE + (ZR - ZE) * k); }      // 屋根の手前の斜面の上の点
      poly([P(U1, VM, ZR), P(RU1, VM, ZR), P(RU1, RV0, ZE), P(U1, RV0, ZE)], shade(roof, -0.5));
      poly([S(0, 0), S(1, 0), S(1, 1), S(0, 1)], shade(roof, RV));
      const sl = [];
      [0.25, 0.5, 0.75].forEach(function (k, r) {
        sl.push([S(0, k), S(1, k)]);
        for (let s = r % 2 ? 0.07 : 0.14; s < 1; s += 0.14) sl.push([S(s, k), S(s, Math.min(k + 0.25, 1))]);
      });
      for (let s = 0.07; s < 1; s += 0.14) sl.push([S(s, 0), S(s, 0.25)]);
      lines(sl, shade(roof, -0.28), 1);
      ctx.lineJoin = "round";
      lines([[P(RU1, RV1, ZE), P(RU1, VM, ZR), P(RU1, RV0, ZE)]], shade(roof, -0.42), 4);
      lines([[S(0, 0), S(1, 0)]], shade(roof, -0.42), 3);
      lines([[S(0, 0), S(0, 1)]], shade(roof, -0.42), 2);
      lines([[S(0, 1), S(1, 1)]], GOLD_DARK, 4.5);
      lines([[S(0, 1), S(1, 1)]], GOLD, 2.5);
      ctx.lineJoin = "miter";

      // ---- 看板（共通の看板。棟の上に立てた2本の柱で支える）
      const s = signAt(g);
      buildingSign(ctx, b, s.x, s.y, [P(SIGN_U0, VM, ZR), P(SIGN_U1, VM, ZR)]);
    }

    // 看板の中心（2本の柱のまん中の真上）
    function signAt(g) {
      const P = projector(g), C = centerOf(g);
      return { x: P((SIGN_U0 + SIGN_U1) / 2, VM, 0).x, y: C.y - SIGN_H };
    }

    // 建物の輪郭（塔・塔の旗・看板の柱・屋根・妻壁・石の段をおおう）
    function outline(g) {
      const P = projector(g), pt = P(POLE_U, POLE_V, TZ + POLE_H), s = signAt(g);
      return [
        P(TA0, TB1, 0),                                     // 塔の左手前の足もと
        P(TA0, TB1, TZ + 8),                                // 塔の左手前の上（胸壁）
        { x: pt.x - 36, y: pt.y + 25 },                     // 旗の先の下
        { x: pt.x - 36, y: pt.y - 1 },                      // 旗の先の上
        { x: pt.x + 4, y: pt.y - 6 },                       // さおの先の金の玉
        P(TA1, TB0, TZ + 8),                                // 塔の右奥の上（胸壁）
        { x: P(SIGN_U0, VM, ZR).x, y: s.y },                // 看板の左の柱の上
        { x: P(SIGN_U1, VM, ZR).x, y: s.y },                // 看板の右の柱の上
        P(RU1, VM, ZR),                                     // 屋根の右はしのてっぺん
        P(RU1, RV0, ZE),                                    // 屋根の右奥の軒
        P(U1, V0, 0),                                       // 母屋の右奥の足もと
        P(3.06, DOOR_V - 0.45, 0),                          // 石の段の右
        P(3.06, DOOR_V + 0.45, 0),                          // 石の段の手前
        P(U1, V1, 0),                                       // 母屋の手前の角
        P(TA1, TB1, 0)                                      // 塔の右手前の足もと
      ];
    }

    return { draw: draw, signAt: signAt, outline: outline, door: "E" };   // door＝この絵の入口の向き
  })();

  // 酒場：木組みのしっくい壁に、こげ茶の切妻屋根をのせた町の酒場（入口の真上に棟が来る妻入り。ジョッキの吊り看板・入口わきの樽・明かりのもれる窓・けむりの出る煙突）
  BUILDING_ART.tavern = (function () {
    // ---- この建物だけで使う色 ----
    const BEAM = "#5b3a22", PLANK = "#9a6236", STONE = "#a99f90", BRICK = "#a65d43";
    const GLOW = "#ffcf5c", GLOW_HI = "#fff0b0", FLOWER = "#f2685a", LEAF = "#4f9a3c";
    const BARREL = "#b0723a", HOOP = "#4b4744", BEER = "#f3b02c", FOAM = "#fffaf0", IRON = "#3a302c", GOLD = "#f2c230";

    // ---- 寸法（a＝奥→右の向き、b＝奥→左の向き。どちらも 0〜3 マス。高さは px） ----
    const A0 = 0.25, A1 = 2.8, B0 = 0.3, B1 = 2.7;              // 壁の範囲（入口の壁は a＝A1。右手前の面）
    const VM = 1.5;                                             // 棟（屋根のてっぺんの線）の位置。入口の真上
    const ZE = 50, ZR = 84;                                     // 壁の高さ（軒の高さ）・棟の高さ
    const RA0 = 0.1, RA1 = 2.95, RB0 = 0.1, RB1 = 2.9;          // 屋根の広がり（土台の外へは出さない）
    const FASCIA = 4;                                           // 屋根の厚み
    const DOOR_HW = 0.26, DOOR_ZS = 30, KZ = 36;                // 入口の扉（半分の幅・アーチの始まる高さ）・1マスぶんの縦の長さ
    const SIGN_A0 = 2.2, SIGN_A1 = 2.85, SIGN_H = 144;         // 看板の柱の位置（棟の上）・看板の中心の高さ（土台の手前の角から）
    const CH_A = 1.15, CH_B = 2.05, CH_HW = 0.11, CH_TOP = 110; // 煙突の場所（屋根の手前の斜面）・太さの半分・てっぺんの高さ
    const MUG_B = 2.28, MUG_Z = 47;                             // ジョッキの吊り看板：下がる位置（入口の壁の上、扉の左）・腕木の高さ
    const BARRELS = [[2.5, 2.95], [2.98, 2.5]];                 // 樽の場所（入口の左、手前の角のまわり。入口のマスには置かない）
    const BR = 0.19, BH = 20, KR = 45.25;                       // 樽の半径・高さ・円の横幅の係数

    // 土台の上の位置を決める。a＝Bk→R 方向（0〜3マス）、b＝Bk→L 方向（0〜3マス）、h＝高さ
    function pointer(g) {
      const ax = (g.R.x - g.Bk.x) / 3, ay = (g.R.y - g.Bk.y) / 3, bx = (g.L.x - g.Bk.x) / 3, by = (g.L.y - g.Bk.y) / 3;
      return function (a, b, h) { return { x: g.Bk.x + a * ax + b * bx, y: g.Bk.y + a * ay + b * by - (h || 0) }; };
    }
    // 屋根の面の高さ（棟で ZR、壁の上で ZE。その先の軒はさらに下がる）
    function roofZ(bb) { return ZR - (ZR - ZE) * Math.abs(bb - VM) / (B1 - VM); }

    // 看板の中心（棟の上の2本の柱のまん中の真上）
    function signAt(g) {
      const m = pointer(g)((SIGN_A0 + SIGN_A1) / 2, VM, 0);
      return { x: m.x, y: g.F.y - SIGN_H };
    }

    // 建物の輪郭（屋根・煙突・壁・入口の段・樽をおおう。吊り看板は入口の壁の範囲の中に入っている）
    function outline(g) {
      const P = pointer(g), zE = roofZ(RB1), zB = roofZ(RB0), top = P(CH_A, CH_B, CH_TOP + 4);
      const rx = BR * KR, b1 = P(BARRELS[0][0], BARRELS[0][1], 0), b2 = P(BARRELS[1][0], BARRELS[1][1], 0);
      return [
        P(A0, B1, 0),                                     // 左手前の壁の足もと（奥）
        P(RA0, RB1, zE - FASCIA),                         // 軒の左はし
        P(RA0, VM, ZR + 3),                               // 棟のいちばん奥
        { x: top.x - 9, y: top.y }, { x: top.x + 9, y: top.y },   // 煙突のてっぺん
        P(RA1, VM, ZR + 3),                               // 棟の手前のはし
        P(RA1, RB0, zB), P(RA1, RB0, zB - FASCIA),        // 奥の軒の右はし
        P(A1, B0, 0),                                     // 入口の壁の足もと（奥）
        P(A1 + 0.12, VM - 0.34, 0), P(A1 + 0.12, VM + 0.34, 0),   // 入口の段
        { x: b2.x + rx, y: b2.y }, { x: b2.x, y: b2.y + rx / 2 + 1 },   // 入口わきの樽
        { x: b1.x, y: b1.y + rx / 2 + 1 }, { x: b1.x - rx, y: b1.y }    // 角の樽
      ];
    }

    function draw(ctx, b, g, now) {
      const P = pointer(g), OL = COLORS.outline, wall = b.wallColor, roof = b.roofColor, t = now || 0;
      const zE = roofZ(RB1), zB = roofZ(RB0);
      // 左手前を向いた面（b が一定）の四角
      function qS(bb, a0, a1, h0, h1, col, st) {
        fillPoly(ctx, [P(a0, bb, h0), P(a1, bb, h0), P(a1, bb, h1), P(a0, bb, h1)], col, st === undefined ? OL : st);
      }
      // 右手前を向いた面（a が一定）の四角
      function qE(aa, b0, b1, h0, h1, col, st) {
        fillPoly(ctx, [P(aa, b0, h0), P(aa, b1, h0), P(aa, b1, h1), P(aa, b0, h1)], col, st === undefined ? OL : st);
      }
      // 線をまとめて引く
      function lines(segs, col, lw) {
        ctx.beginPath();
        segs.forEach(function (s) { ctx.moveTo(s[0].x, s[0].y); for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y); });
        ctx.strokeStyle = col; ctx.lineWidth = lw || 1; ctx.stroke();
      }
      // 入口の壁（a が一定）の上のアーチ形
      function archE(aa, bc, hw, z0, zs) {
        const pts = [P(aa, bc - hw, z0)];
        for (let i = 0; i <= 8; i++) { const q = Math.PI - i / 8 * Math.PI; pts.push(P(aa, bc + hw * Math.cos(q), zs + hw * KZ * Math.sin(q))); }
        pts.push(P(aa, bc + hw, z0));
        return pts;
      }
      // 丸い物の2色塗り（左が明るい・右が暗い）
      function tone(x0, x1, hex) {
        const gr = ctx.createLinearGradient(x0, 0, x1, 0), a = shade(hex, 0.12), d = shade(hex, -0.22);
        gr.addColorStop(0, a); gr.addColorStop(0.56, a); gr.addColorStop(0.56, d); gr.addColorStop(1, d); return gr;
      }
      // 明かりのもれる窓。face＝"S"（左手前の壁）か "E"（入口の壁）、c0〜c1＝壁にそった範囲、i＝ゆらぎをずらす番号
      function glowWindow(face, c0, c1, z0, z1, i) {
        const q = face === "S" ? function (c, z) { return P(c, B1, z); } : function (c, z) { return P(A1, c, z); };
        const cm = (c0 + c1) / 2, zm = (z0 + z1) / 2, w = (c1 - c0) * 0.3;
        fillPoly(ctx, [q(c0, z0), q(c1, z0), q(c1, z1), q(c0, z1)], GLOW);
        ctx.globalAlpha = clamp(0.55 + 0.25 * Math.sin(t * 2.3 + i * 1.9) + 0.12 * Math.sin(t * 5.3 + i), 0, 1);   // 中の明かりがゆらぐ
        fillPoly(ctx, [q(cm - w, z0), q(cm + w, z0), q(cm + w, zm + 3), q(cm - w, zm + 3)], GLOW_HI);
        ctx.globalAlpha = 1;
        ctx.beginPath(); const p0 = q(c0, z0), p1 = q(c1, z0), p2 = q(c1, z1), p3 = q(c0, z1);
        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath();
        ctx.strokeStyle = BEAM; ctx.lineWidth = 2.4; ctx.stroke();
        lines([[q(cm, z0), q(cm, z1)], [q(c0, zm), q(c1, zm)]], BEAM, 1.6);
      }
      // 樽（たての円柱。胴が少しふくらむ）
      function barrel(a, bb) {
        const c = P(a, bb, 0), rx = BR * KR, re = rx * 0.88, yb = c.y, yt = c.y - BH, ym = c.y - BH / 2;
        ctx.beginPath();
        ctx.moveTo(c.x - re, yt);
        ctx.quadraticCurveTo(c.x - rx * 1.12, ym, c.x - re, yb);
        ctx.ellipse(c.x, yb, re, re / 2, 0, Math.PI, 0, true);
        ctx.quadraticCurveTo(c.x + rx * 1.12, ym, c.x + re, yt);
        ctx.closePath();
        ctx.fillStyle = tone(c.x - rx, c.x + rx, BARREL); ctx.fill();
        ctx.strokeStyle = OL; ctx.lineWidth = 1; ctx.stroke();
        // たがの鉄の輪（手前の半分）
        [yb - 4, yt + 4].forEach(function (y) {
          ctx.beginPath(); ctx.ellipse(c.x, y, rx * 0.97, rx * 0.97 / 2, 0, 0.1, Math.PI - 0.1);
          ctx.strokeStyle = HOOP; ctx.lineWidth = 2; ctx.stroke();
        });
        // ふた
        ctx.beginPath(); ctx.ellipse(c.x, yt, re, re / 2, 0, 0, Math.PI * 2);
        ctx.fillStyle = shade(BARREL, 0.28); ctx.fill(); ctx.strokeStyle = OL; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.ellipse(c.x, yt, re * 0.62, re * 0.31, 0, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(110,60,20,0.45)"; ctx.stroke();
      }

      // ---- 入口の前の地面にもれる明かり ----
      const lp = P(A1 + 0.35, VM, 0);
      ctx.save();
      ctx.translate(lp.x, lp.y); ctx.scale(1, 0.5);
      const lg = ctx.createRadialGradient(0, 0, 0, 0, 0, 22);
      lg.addColorStop(0, "rgba(255,206,110,0.45)"); lg.addColorStop(1, "rgba(255,206,110,0)");
      ctx.fillStyle = lg; ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      // ---- 屋根の奥の斜面（棟の右に細く見える所。手前の壁と屋根で大部分が隠れる）----
      fillPoly(ctx, [P(RA0, VM, ZR), P(RA1, VM, ZR), P(RA1, RB0, zB), P(RA0, RB0, zB)], shade(roof, -0.28), OL);

      // ---- 壁（しっくい。左手前＝明るい、右手前の妻壁＝暗い）と、石の土台 ----
      qS(B1, A0, A1, 0, ZE, shade(wall, 0.10));
      fillPoly(ctx, [P(A1, B0, 0), P(A1, B1, 0), P(A1, B1, ZE), P(A1, VM, ZR), P(A1, B0, ZE)], shade(wall, -0.18), OL);
      qS(B1, A0, A1, 0, 7, shade(STONE, 0.10));
      qE(A1, B0, B1, 0, 7, shade(STONE, -0.18));

      // ---- 木組み（柱・はり・すじかい）----
      const fr = [];
      [A0 + 0.04, 1.28, 2.32, A1 - 0.03].forEach(function (a) { fr.push([P(a, B1, 7), P(a, B1, ZE)]); });   // 左手前の壁の柱
      fr.push([P(A0, B1, 8), P(A1, B1, 8)], [P(A0, B1, ZE - 2), P(A1, B1, ZE - 2)]);                       // 土台の上のはり・軒のはり
      fr.push([P(2.36, B1, 10), P(2.76, B1, ZE - 4)], [P(2.76, B1, 10), P(2.36, B1, ZE - 4)]);               // すじかい（ばつ印）
      fr.push([P(A1, B0 + 0.04, 7), P(A1, B0 + 0.04, ZE)]);                                                  // 入口の壁の奥の柱
      fr.push([P(A1, B0, 8), P(A1, B1, 8)], [P(A1, B0, ZE), P(A1, B1, ZE)]);                                 // 入口の壁のはり
      fr.push([P(A1, VM - 0.45, ZE), P(A1, VM - 0.45, roofZ(VM - 0.45) - 2)], [P(A1, VM + 0.45, ZE), P(A1, VM + 0.45, roofZ(VM + 0.45) - 2)]);   // 妻壁の束
      lines(fr, BEAM, 3);

      // ---- 窓（明かりがゆらぐ）と、左手前の窓の下の花箱 ----
      glowWindow("S", 0.52, 1.02, 14, 33, 0);
      glowWindow("S", 1.55, 2.05, 14, 33, 1);
      glowWindow("E", 0.55, 1.0, 14, 33, 2);
      [[0.49, 1.05], [1.52, 2.08]].forEach(function (w, i) {
        qS(B1 + 0.1, w[0], w[1], 8, 13, PLANK);
        qE(w[1], B1, B1 + 0.1, 8, 13, shade(PLANK, -0.25));
        for (let k = 0; k < 4; k++) {
          const f = P(lerp(w[0] + 0.06, w[1] - 0.06, k / 3), B1 + 0.06, 15.5);
          ctx.beginPath(); ctx.arc(f.x, f.y + 1.5, 2.6, 0, Math.PI * 2); ctx.fillStyle = LEAF; ctx.fill();
          ctx.beginPath(); ctx.arc(f.x, f.y - 0.5, 1.9, 0, Math.PI * 2); ctx.fillStyle = (k + i) % 2 ? "#ffd23f" : FLOWER; ctx.fill();
        }
      });
      // 妻壁の丸窓
      const rw = []; for (let i = 0; i < 14; i++) { const q = i / 14 * Math.PI * 2; rw.push(P(A1, VM + 6 / KZ * Math.cos(q), 65 + 6 * Math.sin(q))); }
      fillPoly(ctx, rw, GLOW);
      ctx.strokeStyle = BEAM; ctx.lineWidth = 2.4; ctx.stroke();

      // ---- 入口（木の枠＋板の扉＋小窓＋取っ手）と、石の段 ----
      fillPoly(ctx, archE(A1, VM, DOOR_HW + 0.06, 0, DOOR_ZS), BEAM);
      fillPoly(ctx, archE(A1, VM, DOOR_HW, 0, DOOR_ZS), PLANK);
      const pl = [];
      [-0.13, 0, 0.13].forEach(function (d) { pl.push([P(A1, VM + d, 1), P(A1, VM + d, DOOR_ZS + Math.sqrt(DOOR_HW * DOOR_HW - d * d) * KZ - 1)]); });
      lines(pl, "rgba(70,40,20,0.45)", 1);
      lines([[P(A1, VM - DOOR_HW, 10), P(A1, VM + DOOR_HW, 10)], [P(A1, VM - DOOR_HW, 25), P(A1, VM + DOOR_HW, 25)]], IRON, 2);   // 鉄の帯
      const dw = P(A1, VM, 33);
      ctx.beginPath(); ctx.ellipse(dw.x, dw.y, 3.6, 4.2, 0, 0, Math.PI * 2); ctx.fillStyle = GLOW_HI; ctx.fill();
      ctx.strokeStyle = BEAM; ctx.lineWidth = 1.6; ctx.stroke();
      const kb = P(A1, VM + 0.17, 17);
      ctx.beginPath(); ctx.arc(kb.x, kb.y, 1.8, 0, Math.PI * 2); ctx.fillStyle = GOLD; ctx.fill();
      qS(VM + 0.34, A1, A1 + 0.12, 0, 3, shade(STONE, 0.15));
      qE(A1 + 0.12, VM - 0.34, VM + 0.34, 0, 3, shade(STONE, -0.1));
      fillPoly(ctx, [P(A1, VM - 0.34, 3), P(A1 + 0.12, VM - 0.34, 3), P(A1 + 0.12, VM + 0.34, 3), P(A1, VM + 0.34, 3)], shade(STONE, 0.35), OL);

      // ---- 屋根の手前の斜面（こげ茶の板ぶき）と、厚み・ふち・棟 ----
      function S(s, k) { return P(RA0 + (RA1 - RA0) * s, VM + (RB1 - VM) * k, ZR + (zE - ZR) * k); }   // s＝奥(0)→手前(1)、k＝棟(0)→軒(1)
      fillPoly(ctx, [S(0, 0), S(1, 0), S(1, 1), S(0, 1)], shade(roof, 0.10), OL);
      const rows = [0, 0.2, 0.4, 0.6, 0.8, 1], sh = [];
      for (let r = 1; r < rows.length - 1; r++) sh.push([S(0, rows[r]), S(1, rows[r])]);
      lines(sh, shade(roof, -0.28), 1);
      const tk = [];
      for (let r = 0; r < rows.length - 1; r++) {
        for (let s = (r % 2 ? 0.05 : 0.1); s < 0.99; s += 0.1) tk.push([S(s, rows[r]), S(s, rows[r + 1])]);
      }
      lines(tk, "rgba(40,20,10,0.22)", 1);
      fillPoly(ctx, [S(0, 1), S(1, 1), P(RA1, RB1, zE - FASCIA), P(RA0, RB1, zE - FASCIA)], shade(roof, -0.15), OL);       // 軒の厚み
      fillPoly(ctx, [P(RA1, VM, ZR), P(RA1, RB0, zB), P(RA1, RB0, zB - FASCIA), P(RA1, VM, ZR - FASCIA)], shade(roof, -0.48), OL);   // 奥の斜面のふち
      fillPoly(ctx, [P(RA1, VM, ZR), P(RA1, RB1, zE), P(RA1, RB1, zE - FASCIA), P(RA1, VM, ZR - FASCIA)], shade(roof, -0.36), OL);   // 手前の斜面のふち
      ctx.lineCap = "round";
      lines([[P(RA0, VM, ZR + 1), P(RA1, VM, ZR + 1)]], shade(roof, -0.45), 4);   // 棟
      ctx.lineCap = "butt";

      // ---- れんがの煙突（屋根の手前の斜面から立つ）と、けむり ----
      const c0 = CH_A - CH_HW, c1 = CH_A + CH_HW, d0 = CH_B - CH_HW, d1 = CH_B + CH_HW;
      fillPoly(ctx, [P(c0, d1, roofZ(d1)), P(c1, d1, roofZ(d1)), P(c1, d1, CH_TOP), P(c0, d1, CH_TOP)], shade(BRICK, 0.08), OL);
      fillPoly(ctx, [P(c1, d0, roofZ(d0)), P(c1, d1, roofZ(d1)), P(c1, d1, CH_TOP), P(c1, d0, CH_TOP)], shade(BRICK, -0.22), OL);
      lines([[P(c0, d1, CH_TOP - 12), P(c1, d1, CH_TOP - 12), P(c1, d0, CH_TOP - 12)], [P(c0, d1, CH_TOP - 24), P(c1, d1, CH_TOP - 24), P(c1, d0, CH_TOP - 24)]], "rgba(70,30,20,0.35)", 1);
      const e = 0.03;                                                    // てっぺんのふち（少し太い）
      qS(d1 + e, c0 - e, c1 + e, CH_TOP - 4, CH_TOP, shade(BRICK, -0.05));
      qE(c1 + e, d0 - e, d1 + e, CH_TOP - 4, CH_TOP, shade(BRICK, -0.32));
      fillPoly(ctx, [P(c0 - e, d0 - e, CH_TOP), P(c1 + e, d0 - e, CH_TOP), P(c1 + e, d1 + e, CH_TOP), P(c0 - e, d1 + e, CH_TOP)], shade(BRICK, 0.25), OL);
      fillPoly(ctx, [P(c0 + 0.03, d0 + 0.03, CH_TOP), P(c1 - 0.03, d0 + 0.03, CH_TOP), P(c1 - 0.03, d1 - 0.03, CH_TOP), P(c0 + 0.03, d1 - 0.03, CH_TOP)], "#3a2a24");
      const sm = P(CH_A, CH_B, CH_TOP + 2);
      for (let i = 0; i < 3; i++) {                                      // けむり（ゆっくり上って薄くなる）
        const k = (t * 0.35 + i / 3) % 1;
        ctx.globalAlpha = 0.55 * (1 - k);
        ctx.beginPath(); ctx.arc(sm.x - 7 * k + Math.sin(t * 1.3 + i) * 1.5, sm.y - 4 - 16 * k, 3 + 3.5 * k, 0, Math.PI * 2);
        ctx.fillStyle = "#f2efe9"; ctx.fill();
      }
      ctx.globalAlpha = 1;

      // ---- 入口わきの樽（角の樽を先に）----
      barrel(BARRELS[0][0], BARRELS[0][1]);
      barrel(BARRELS[1][0], BARRELS[1][1]);

      // ---- ジョッキの吊り看板（入口の壁から鉄の腕木で下げる。風で少しゆれる）----
      const sw = Math.sin(t * 1.6) * 0.03;
      function M(u, z) { return P(u + sw * (MUG_Z - z) / 26, MUG_B, z); }  // 下ほどゆれが大きい
      lines([[P(A1, MUG_B, MUG_Z), P(3.36, MUG_B, MUG_Z)], [P(A1, MUG_B, MUG_Z - 10), P(3.02, MUG_B, MUG_Z)]], IRON, 2);
      lines([[P(2.96, MUG_B, MUG_Z), M(2.96, 41.5)], [P(3.24, MUG_B, MUG_Z), M(3.24, 41.5)]], IRON, 1);
      ctx.lineJoin = "round";
      // 取っ手（太い線をふち→中の順に）
      [["#6a4316", 4.4], [shade(BEER, 0.25), 2.2]].forEach(function (st) {
        ctx.beginPath(); const h0 = M(3.27, 35), h1 = M(3.39, 34), h2 = M(3.39, 24), h3 = M(3.27, 23);
        ctx.moveTo(h0.x, h0.y); ctx.lineTo(h1.x, h1.y); ctx.lineTo(h2.x, h2.y); ctx.lineTo(h3.x, h3.y);
        ctx.strokeStyle = st[0]; ctx.lineWidth = st[1]; ctx.stroke();
      });
      // 胴（金色のビール）
      fillPoly(ctx, [M(2.88, 39), M(3.28, 39), M(3.26, 19), M(2.9, 19)], BEER);
      ctx.strokeStyle = "#6a4316"; ctx.lineWidth = 1.4; ctx.stroke();
      lines([[M(2.99, 36), M(2.99, 22)], [M(3.17, 36), M(3.17, 22)]], "rgba(255,255,255,0.55)", 1.4);   // ガラスの照り
      // 泡（ふわっと丸く盛り上がる）
      ctx.beginPath();
      [[2.92, 40.5, 3.4], [3.03, 43, 4], [3.15, 42, 3.8], [3.25, 40, 3]].forEach(function (f) {
        const p = M(f[0], f[1]); ctx.moveTo(p.x + f[2], p.y); ctx.arc(p.x, p.y, f[2], 0, Math.PI * 2);
      });
      ctx.fillStyle = FOAM; ctx.fill();
      ctx.strokeStyle = "rgba(106,67,22,0.6)"; ctx.lineWidth = 1; ctx.stroke();
      const fb = [M(2.88, 39), M(3.28, 39), M(3.28, 41), M(2.88, 41)];
      fillPoly(ctx, fb, FOAM);
      ctx.lineJoin = "miter";

      // ---- 看板（共通の看板。棟の上に立てた2本の柱で支える）----
      const s = signAt(g);
      buildingSign(ctx, b, s.x, s.y, [P(SIGN_A0, VM, ZR), P(SIGN_A1, VM, ZR)]);
    }

    return { draw: draw, signAt: signAt, outline: outline, door: "E" };   // door＝この絵の入口の向き
  })();

  // 主人公の体の寸法（px）。数字を変えると体つきが変わる
  const BODY = {
    leg: 11.5,       // もも・すねの長さ
    torso: 14,       // 胴の長さ
    headR: 5.2,      // 頭の半径
    deckLen: 13,     // 板の長さの半分
    deckW: 3.6,      // 板の幅の半分
    deckZ: 4.5,      // 板の高さ
    side: 9,         // 板の横に立つときの、板からの距離
    unit: 36         // 体のpxを地図のマスに直すときの「1マス＝何px」
  };

  // ひざの位置（腰と足先から決める）。sign＝前の足は +1、後ろの足は -1
  function kneeOf(hip, foot, sign) {
    const L = BODY.leg;
    const dA = foot.A - hip.A, dB = foot.B - hip.B, dz = foot.z - hip.z;
    const d = Math.hypot(dA, dB, dz);
    const m = { A: hip.A + dA / 2, B: hip.B + dB / 2, z: hip.z + dz / 2 };
    if (d < 0.001 || d >= L * 2) return m;              // 伸びきっているときは、まっすぐ
    const h = Math.sqrt(L * L - d * d / 4);             // ひざが出る量
    // ひざを出す向き（体の前。少し外側）から、脚の向きの成分を取り除く
    let nA = 0.35 * sign, nB = 0.94, nz = 0;
    const dot = (nA * dA + nB * dB + nz * dz) / d;
    nA -= dot * dA / d; nB -= dot * dB / d; nz -= dot * dz / d;
    const nl = Math.hypot(nA, nB, nz) || 1;
    return { A: m.A + nA / nl * h, B: m.B + nB / nl * h, z: m.z + nz / nl * h };
  }

  // ------------------------------------------------------------
  // ★技（config.js の tricks）：オーリー・キックフリップの体と板の動き
  //   p.trick ＝ { kind: "ollie"｜"kickflip", t: 始めてからの秒数, Tc: しゃがむ秒数, Ta: 空中の秒数, Tl: 着地を受ける秒数,
  //               H: 板の高さ（マス）, Hpx: 同じ高さ（体の px）, flipDir: 回す向き（+1／-1） }
  //   技が無いとき（p.trick が null）は、ここの関数は呼ばれない（今までと同じ姿勢）。
  // ------------------------------------------------------------
  const TRICK_CROUCH = 0.16;     // しゃがむ（ためる）秒数
  const TRICK_LAND = 0.2;        // 着地をひざで受ける秒数

  // 技のいまの段階。crouch しゃがむ／air 空中／land 着地を受ける（k＝その段階の中の進み具合 0〜1）
  function trickPhase(tr) {
    if (tr.t < tr.Tc) return { name: "crouch", k: tr.t / tr.Tc };
    if (tr.t < tr.Tc + tr.Ta) return { name: "air", k: (tr.t - tr.Tc) / tr.Ta };
    return { name: "land", k: clamp((tr.t - tr.Tc - tr.Ta) / tr.Tl, 0, 1) };
  }

  // 板の動き：hb＝板の持ち上がり（px）、pitch＝板の先の上がり（ラジアン）、flip＝長い軸のまわりの回転（ラジアン）
  function trickBoard(tr) {
    const ph = trickPhase(tr), top = tr.kind === "kickflip" ? 0.36 : 0.46;
    let hb = 0, pitch = 0, flip = 0;
    if (ph.name === "crouch") {
      pitch = top * ease(clamp((ph.k - 0.65) / 0.35, 0, 1));            // 最後に、後ろ足で板の後ろを踏み込む
    } else if (ph.name === "air") {
      const u = ph.k;
      hb = tr.Hpx * 4 * u * (1 - u);                                    // 放物線（いちばん高いのは空中の真ん中）
      pitch = u < 0.08 ? top : top * (1 - ease(clamp((u - 0.08) / 0.34, 0, 1)));   // 弾いて先が上がる → 前足で引き上げて水平に
      if (tr.kind === "kickflip") flip = Math.PI * 2 * ease(clamp((u - 0.1) / 0.58, 0, 1)) * tr.flipDir;   // 長い軸のまわりに1回転
    }
    return { hb: hb, pitch: pitch, flip: flip };
  }

  // 板の中の点（前A・右B・上z）を、技の板の動きで動かす。withFlip＝回転も入れるか（足の位置は回転させない）
  function trickBoardPoint(bd, A, B, z, withFlip) {
    if (withFlip && bd.flip) {                          // 長い軸（板の厚みの真ん中）のまわりに回す
      const zc = BODY.deckZ, c = Math.cos(bd.flip), s = Math.sin(bd.flip);
      const b2 = B * c - (z - zc) * s, z2 = zc + B * s + (z - zc) * c;
      B = b2; z = z2;
    }
    if (bd.pitch) {                                     // 後ろの車輪の接地点を支点にして、板の先を上げる
      const pa = -8.5, c = Math.cos(bd.pitch), s = Math.sin(bd.pitch);
      const a2 = pa + (A - pa) * c - z * s, z2 = (A - pa) * s + z * c;
      A = a2; z = z2;
    }
    return { A: A, B: B, z: z + bd.hb };
  }

  function lerpJoint(a, b, k) { return { A: lerp(a.A, b.A, k), B: lerp(a.B, b.B, k), z: lerp(a.z, b.z, k) }; }

  // 技の間の体：しゃがむ → 後ろ足で弾く → 空中で足を引き上げる（板が足についてくる）→ ひざで着地を受ける。
  // c0・f0・footF0・footB0＝ふだんの姿勢の値（しゃがみ始めと、着地のあとは、ここへなめらかにつなぐ）
  function trickBody(p, c0, f0, footF0, footB0) {
    const tr = p.trick, ph = trickPhase(tr), bd = trickBoard(tr);
    const top = BODY.deckZ + 1;
    const onBoard = function (A, B, up) { const q = trickBoardPoint(bd, A, B, top, false); q.z += up || 0; return q; };
    const lift = trickBoardPoint(bd, 0, 0, top, false).z - top;     // 板の真ん中の持ち上がり（体もいっしょに上がる）
    let crouch, fwd, arms, footF, footB;
    if (ph.name === "crouch") {
      const k = ease(ph.k);
      crouch = lerp(c0, 1, k); fwd = lerp(f0, 2.5, k); arms = 1 + 0.2 * k;
      footF = lerpJoint(footF0, onBoard(lerp(6.5, 1.5, k), 0), k);   // 前足は板の真ん中へ
      footB = lerpJoint(footB0, onBoard(lerp(-6.5, -10.5, k), 0), k);   // 後ろ足は板の後ろの端（テール）へ
    } else if (ph.name === "air") {
      const u = ph.k;
      crouch = u < 0.15 ? 1 - 0.45 * Math.sin(Math.PI * u / 0.15) : (u < 0.7 ? 1 : lerp(1, 0.8, (u - 0.7) / 0.3));   // 弾く瞬間だけ脚が伸び、すぐ引き上げる
      fwd = 2; arms = 1.25;
      const kick = tr.kind === "kickflip" ? Math.sin(Math.PI * clamp((u - 0.05) / 0.3, 0, 1)) : 0;    // キックフリップ：前足で板の横をはらう
      const up = tr.kind === "kickflip" ? 5 * Math.sin(Math.PI * clamp((u - 0.08) / 0.62, 0, 1)) : 0;  // 回っている間は、足を板から少し離す
      const aF = u < 0.3 ? lerp(1.5, 7, ease(u / 0.3)) : lerp(7, 6.5, ease(clamp((u - 0.3) / 0.5, 0, 1)));   // 前足を板の先へすべらせる
      const aB = lerp(-10.5, -6.5, ease(clamp(u / 0.5, 0, 1)));
      footF = onBoard(aF, 4 * kick, up);
      footB = onBoard(aB, 0, up);
    } else {
      const k = ease(ph.k);
      crouch = lerp(1, c0, k); fwd = lerp(2, f0, k); arms = lerp(1.25, 1, k);
      footF = lerpJoint(onBoard(6.5, 0), footF0, k);
      footB = lerpJoint(onBoard(-6.5, 0), footB0, k);
    }
    return { crouch: crouch, fwd: fwd, arms: arms, footF: footF, footB: footB, lift: lift };
  }

  // 主人公の姿勢を決める。
  // 体の中の点は「前へ A・右へ B・上へ z」（px）で表す。板の中心が A=0, B=0。
  //   p.mode ＝ idle 立っている／mount 乗る／push 蹴る／glide 滑る／brake 減速／dismount 降りる
  //   p.off  ＝ 0 板の上 〜 1 板の横に立っている
  //   p.lean ＝ 曲がるときの体の傾き（-1〜1）
  function playerPose(p, now) {
    const off = p.off, lean = p.lean;
    const deckTop = BODY.deckZ + 1;
    let crouch = 0.28;     // ひざの曲げ具合（0 まっすぐ 〜 1 深く曲げる）
    let fwd = 0;           // 上体を前へ倒す量（－は後ろ）
    let arms = 1;          // 腕の開き（0 下ろす 〜 1 広げる）
    let hipA = 0;
    let footB = { A: -6.5, B: 0, z: deckTop };          // 後ろの足（板の上）
    let footF = { A: 6.5, B: 0, z: deckTop };           // 前の足（板の上）

    if (p.mode === "idle") {
      crouch = 0; arms = 0;
    } else if (p.mode === "mount" || p.mode === "dismount") {
      crouch = 0.2 * (1 - off); arms = 1 - off;
    } else if (p.mode === "push") {
      // 出発：前の足は板の上。後ろの足で地面を後ろへ蹴る
      crouch = 0.95; fwd = 3; hipA = 2;
      const no = Math.floor(p.t / T_KICK);
      const ph = (p.t - no * T_KICK) / T_KICK;
      if (ph < 0.55) {
        const s = ph / 0.55;                            // 蹴っている間（足は地面）
        footB = { A: 4 - 11 * s, B: 4.5, z: 0 };
      } else {
        const r = (ph - 0.55) / 0.45;                   // 足を戻す間（足は浮いている）
        const last = no >= p.kicks - 1;                 // 最後の1回は、板の上へ戻す
        footB = {
          A: lerp(-7, last ? -6.5 : 4, r),
          B: lerp(4.5, last ? 0 : 4.5, r),
          z: lerp(0, last ? deckTop : 0, r) + Math.sin(Math.PI * r) * 5
        };
      }
    } else if (p.mode === "glide") {
      crouch = 0.28 + Math.sin(now * 7) * 0.02;         // 少しひざを曲げて、スーッと滑る
    } else if (p.mode === "brake") {
      const r = p.vmax > 0 ? clamp(p.speed / p.vmax, 0, 1) : 0;
      crouch = 0.15 + 0.3 * r; fwd = -3.5 * r;          // 体を後ろへ引いて減速
    }

    // 乗り降り：片足ずつ動かす（降りるときは後ろの足→前の足。乗るときはその逆）
    const oB = clamp(off * 2, 0, 1);
    const oF = clamp(off * 2 - 1, 0, 1);
    const arc = function (o) { return Math.sin(Math.PI * o) * 5; };
    footF = { A: lerp(footF.A, 2.4, oF), B: lerp(footF.B, BODY.side, oF), z: lerp(footF.z, 0, oF) + arc(oF) };
    footB = { A: lerp(footB.A, -2.4, oB), B: lerp(footB.B, BODY.side, oB), z: lerp(footB.z, 0, oB) + arc(oB) };

    // ★技（オーリー・キックフリップ）の間は、ひざ・上体・腕・足を技の動きに替え、体ごと持ち上げる（技が無いときは何もしない）
    let lift = 0;
    if (p.trick) {
      const tb = trickBody(p, crouch, fwd, footF, footB);
      crouch = tb.crouch; fwd = tb.fwd; arms = tb.arms; footF = tb.footF; footB = tb.footB; lift = tb.lift;
    }

    const hipRide = deckTop + 21.5 * (1 - 0.3 * crouch);
    const hipStand = 22.6 + Math.sin(now * 2.2) * 0.3;  // 立っているときは、ゆっくり呼吸
    const hip = { A: hipA * (1 - off), B: BODY.side * ease(off) + lean * 2, z: lerp(hipRide, hipStand, off) + lift };
    const neck = { A: hip.A + fwd, B: hip.B + lean * 5, z: hip.z + BODY.torso };
    const head = { A: neck.A + fwd * 0.3, B: neck.B + lean * 1.5, z: neck.z + BODY.headR + 1.2 };
    const sh = { A: neck.A, B: neck.B, z: neck.z - 1.5 };
    const handF = { A: sh.A + lerp(3.6, 8.5, arms), B: sh.B + lerp(0, 2, arms) + lean * 3 * arms, z: sh.z - lerp(12.5, 5, arms) };
    const handB = { A: sh.A - lerp(3.6, 8.5, arms), B: sh.B - lerp(0, 1, arms) + lean * 3 * arms, z: sh.z - lerp(12.5, 6, arms) };
    return {
      hip: hip, neck: neck, head: head, sh: sh,
      footF: footF, footB: footB, kneeF: kneeOf(hip, footF, 1), kneeB: kneeOf(hip, footB, -1),
      handF: handF, handB: handB
    };
  }

  const Art = {

    // ========== 全体マップ（真上）用 ==========

    // 地面1マス。(px,py)＝マスの左上、s＝1マスの大きさ
    topGround: function (ctx, t, px, py, s, tx, ty) {
      const odd = (tx + ty) % 2 === 1;
      if (t === T.ROAD) {
        ctx.fillStyle = odd ? COLORS.roadA : COLORS.roadB;
        ctx.fillRect(px, py, s + 0.5, s + 0.5);
      } else if (t === T.POND) {
        ctx.fillStyle = odd ? COLORS.pondA : COLORS.pondB;
        ctx.fillRect(px, py, s + 0.5, s + 0.5);
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = Math.max(1, s * 0.06);
        ctx.beginPath();
        ctx.moveTo(px + s * 0.25, py + s * (0.35 + hash(tx, ty) * 0.3));
        ctx.lineTo(px + s * 0.6, py + s * (0.35 + hash(tx, ty) * 0.3));
        ctx.stroke();
      } else {
        ctx.fillStyle = odd ? COLORS.grassA : COLORS.grassB;
        ctx.fillRect(px, py, s + 0.5, s + 0.5);
        if (t === T.FLOWER) {
          const cols = ["#ff8fb3", "#fff2a8", "#ffffff"];
          for (let i = 0; i < 3; i++) {
            ctx.fillStyle = cols[i];
            ctx.beginPath();
            ctx.arc(px + s * (0.25 + 0.25 * i), py + s * (0.3 + 0.4 * hash(tx + i, ty)), Math.max(1.5, s * 0.09), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    },

    // 木。(cx,cy)＝マスの中心
    topTree: function (ctx, cx, cy, s, tx, ty) {
      const r = s * (0.40 + hash(tx, ty) * 0.08);
      ctx.fillStyle = "rgba(0,0,0,0.15)";
      ctx.beginPath(); ctx.arc(cx + s * 0.06, cy + s * 0.08, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS.treeDark;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS.treeLight;
      ctx.beginPath(); ctx.arc(cx - r * 0.2, cy - r * 0.22, r * 0.6, 0, Math.PI * 2); ctx.fill();
    },

    // 入口の前のマット。(px,py)＝マスの左上
    topMat: function (ctx, b, px, py, s) {
      ctx.fillStyle = shade(b.roofColor, 0.35);
      roundRectPath(ctx, px + s * 0.2, py + s * 0.2, s * 0.6, s * 0.6, s * 0.12);
      ctx.fill();
    },

    // 建物。(px,py)＝建物の左上、selected＝選ばれているか
    topBuilding: function (ctx, b, px, py, s, selected) {
      const w = b.size * s;
      const m = s * 0.14;                               // 壁の見える幅
      ctx.fillStyle = "rgba(0,0,0,0.20)";
      roundRectPath(ctx, px + s * 0.12, py + s * 0.16, w, w, 4); ctx.fill();
      ctx.fillStyle = shade(b.wallColor, -0.08);
      roundRectPath(ctx, px, py, w, w, 4); ctx.fill();
      ctx.fillStyle = b.roofColor;
      roundRectPath(ctx, px + m, py + m, w - m * 2, w - m * 2, 3); ctx.fill();
      // 屋根の折れ目（とんがり屋根を真上から見た線）
      ctx.strokeStyle = shade(b.roofColor, 0.28);
      ctx.lineWidth = Math.max(1, s * 0.06);
      ctx.beginPath();
      ctx.moveTo(px + m, py + m); ctx.lineTo(px + w - m, py + w - m);
      ctx.moveTo(px + w - m, py + m); ctx.lineTo(px + m, py + w - m);
      ctx.stroke();
      // 入口の印
      ctx.fillStyle = COLORS.doorWood;
      if (b.door === "E") ctx.fillRect(px + w - m - 1, py + w / 2 - s * 0.22, m + 1, s * 0.44);
      else ctx.fillRect(px + w / 2 - s * 0.22, py + w - m - 1, s * 0.44, m + 1);
      // 選んでいるときの白い枠
      if (selected) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = Math.max(3, s * 0.16);
        roundRectPath(ctx, px - 2, py - 2, w + 4, w + 4, 6); ctx.stroke();
      }
    },

    // 名前ラベル。(cx,cy)＝ラベルの中心
    topLabel: function (ctx, text, cx, cy, fontPx, dark) {
      ctx.font = "bold " + fontPx + "px " + FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const w = ctx.measureText(text).width + fontPx * 0.9;
      const h = fontPx * 1.6;
      ctx.fillStyle = dark ? "rgba(26,36,82,0.92)" : "rgba(255,255,255,0.94)";
      roundRectPath(ctx, cx - w / 2, cy - h / 2, w, h, h / 2); ctx.fill();
      ctx.fillStyle = dark ? "#ffffff" : "#1b2440";
      ctx.fillText(text, cx, cy + fontPx * 0.04);
    },

    // 「準備中」の小さな札（名前ラベルのすぐ下）。(cx,cy)＝札の中心、w・h＝札の大きさ
    topPendingTag: function (ctx, cx, cy, w, h, fontPx) {
      ctx.fillStyle = "#fff0b8";
      roundRectPath(ctx, cx - w / 2, cy - h / 2, w, h, h / 2); ctx.fill();
      ctx.strokeStyle = "rgba(120,84,20,0.75)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.font = "bold " + fontPx + "px " + FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#5a3d12";
      ctx.fillText(PENDING_TAG.text, cx, cy + fontPx * 0.04);
    },

    // 現在地の印。(cx,cy)＝マスの中心
    topPlayer: function (ctx, cx, cy, s, now) {
      const k = (now * 0.9) % 1;                        // 広がる輪
      ctx.strokeStyle = "rgba(255,80,50," + (1 - k) + ")";
      ctx.lineWidth = Math.max(2, s * 0.1);
      ctx.beginPath(); ctx.arc(cx, cy, s * (0.35 + 0.65 * k), 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#ff5032";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = Math.max(2, s * 0.1);
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.32, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    },

    // ========== 移動画面（斜め見下ろし）用 ==========

    // 地面のふち（手前側に見える、地面の厚み）
    isoEdge: function (ctx) {
      const d = 18;
      const L = iso(0, ROWS), F = iso(COLS, ROWS), R = iso(COLS, 0);
      fillPoly(ctx, [L, F, { x: F.x, y: F.y + d }, { x: L.x, y: L.y + d }], COLORS.edgeLeft);
      fillPoly(ctx, [F, R, { x: R.x, y: R.y + d }, { x: F.x, y: F.y + d }], COLORS.edgeRight);
    },

    // 地面1マス（ひし形）
    isoGround: function (ctx, t, tx, ty, now) {
      const p = iso(tx, ty);                            // ひし形の上の角
      const odd = (tx + ty) % 2 === 1;
      let col;
      if (t === T.ROAD) col = odd ? COLORS.roadA : COLORS.roadB;
      else if (t === T.POND) col = odd ? COLORS.pondA : COLORS.pondB;
      else col = odd ? COLORS.grassA : COLORS.grassB;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + TW / 2, p.y + TH / 2);
      ctx.lineTo(p.x, p.y + TH);
      ctx.lineTo(p.x - TW / 2, p.y + TH / 2);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = t === T.ROAD ? COLORS.roadLine : col;   // 道は継ぎ目の線、ほかはすき間うめ
      ctx.lineWidth = 1;
      ctx.stroke();

      const cy = p.y + TH / 2;                          // マスの中心の高さ
      if (t === T.POND) {
        // 水面のゆらぎ
        const k = (now * 0.35 + hash(tx, ty)) % 1;
        ctx.strokeStyle = "rgba(255,255,255," + (0.55 * Math.sin(k * Math.PI)).toFixed(3) + ")";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(p.x + (hash(ty, tx) - 0.5) * 18, cy, 5 + k * 9, 2.5 + k * 4.5, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (t === T.FLOWER) {
        const cols = ["#ff8fb3", "#fff2a8", "#ffffff"];
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = cols[i];
          ctx.beginPath();
          ctx.arc(p.x - 12 + 12 * i, cy - 3 + 6 * hash(tx + i, ty), 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (t === T.ROAD) {
        if (hash(tx, ty) > 0.55) {                      // 小石
          ctx.fillStyle = "rgba(120,90,40,0.28)";
          ctx.beginPath();
          ctx.arc(p.x + (hash(ty, tx) - 0.5) * 24, cy + (hash(tx + 7, ty) - 0.5) * 8, 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (hash(tx, ty) > 0.6) {                  // 草のしげみ
        const gx = p.x + (hash(ty, tx) - 0.5) * 26, gy = cy + (hash(tx + 3, ty) - 0.5) * 8;
        ctx.strokeStyle = COLORS.grassTuft;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(gx - 3, gy); ctx.lineTo(gx - 1, gy - 5);
        ctx.moveTo(gx, gy); ctx.lineTo(gx + 1, gy - 6);
        ctx.moveTo(gx + 3, gy); ctx.lineTo(gx + 4, gy - 4);
        ctx.stroke();
      }
    },

    // 入口の前のマット（建物の屋根の色）
    isoMat: function (ctx, b, tx, ty) {
      const c = iso(tx + 0.5, ty + 0.5);
      const w = TW * 0.3, h = TH * 0.3;
      fillPoly(ctx, [{ x: c.x, y: c.y - h }, { x: c.x + w, y: c.y }, { x: c.x, y: c.y + h }, { x: c.x - w, y: c.y }],
        shade(b.roofColor, 0.35), shade(b.roofColor, -0.1));
    },

    // 目的地の印（入口の前で、白い輪が広がる）
    isoGoal: function (ctx, tx, ty, now) {
      const c = iso(tx + 0.5, ty + 0.5);
      const k = (now * 0.9) % 1;
      ctx.strokeStyle = "rgba(255,255,255," + (1 - k).toFixed(3) + ")";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, TW * (0.2 + 0.3 * k), TH * (0.2 + 0.3 * k), 0, 0, Math.PI * 2);
      ctx.stroke();
    },

    // 木
    isoTree: function (ctx, tx, ty) {
      const c = iso(tx + 0.5, ty + 0.5);                // 根元
      const k = 0.9 + hash(tx, ty) * 0.25;              // 木ごとに大きさを少し変える
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.beginPath(); ctx.ellipse(c.x, c.y, 17 * k, 8 * k, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS.trunk;
      ctx.fillRect(c.x - 3 * k, c.y - 18 * k, 6 * k, 18 * k);
      ctx.fillStyle = COLORS.treeDark;
      ctx.beginPath(); ctx.arc(c.x, c.y - 28 * k, 16 * k, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(c.x - 9 * k, c.y - 22 * k, 11 * k, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(c.x + 9 * k, c.y - 22 * k, 11 * k, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS.treeLight;
      ctx.beginPath(); ctx.arc(c.x - 4 * k, c.y - 33 * k, 10 * k, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(c.x + 6 * k, c.y - 26 * k, 7 * k, 0, Math.PI * 2); ctx.fill();
    },

    // 建物。now＝秒（絵の中の小さな動きに使う）
    // ★建物の絵を差し替えるとき：config.js の art で選んだ絵（BUILDING_ART）で描いている。絵を足す・替えるのは BUILDING_ART の側。
    isoBuilding: function (ctx, b, now) {
      const shape = buildingShape(b);
      const art = BUILDING_ART[b.art];
      if (art) { art.draw(ctx, b, shape, now || 0); return; }

      // ここから下は、絵が決まっていない建物の描き方（壁2面＋とんがり屋根＋看板）
      const hW = BUILD.wallH;
      const R = shape.R, F = shape.F, L = shape.L;      // 右・手前・左の角（地面）
      const up = function (P, h) { return { x: P.x, y: P.y - h }; };

      // 壁2面（左手前は明るく、右手前は暗く）
      fillPoly(ctx, [L, F, up(F, hW), up(L, hW)], shade(b.wallColor, 0.10), COLORS.outline);
      fillPoly(ctx, [F, R, up(R, hW), up(F, hW)], shade(b.wallColor, -0.20), COLORS.outline);

      // 壁の上の点を決める道具：u＝壁の横方向（0〜1）、v＝地面からの高さ
      const face = function (P0, P1) {
        return function (u, v) { return { x: lerp(P0.x, P1.x, u), y: lerp(P0.y, P1.y, u) - v }; };
      };
      const fS = face(L, F), fE = face(R, F);
      const panel = function (f, u0, u1, v0, v1, col) {
        fillPoly(ctx, [f(u0, v0), f(u1, v0), f(u1, v1), f(u0, v1)], col, COLORS.outline);
      };
      const doorFace = b.door === "E" ? fE : fS;
      const sideFace = b.door === "E" ? fS : fE;
      panel(doorFace, 0.37, 0.63, 0, 42, COLORS.doorWood);          // 入口
      panel(doorFace, 0.09, 0.28, 22, 43, COLORS.window);           // 入口の両わきの窓
      panel(doorFace, 0.72, 0.91, 22, 43, COLORS.window);
      panel(sideFace, 0.16, 0.40, 22, 43, COLORS.window);           // もう一方の壁の窓
      panel(sideFace, 0.60, 0.84, 22, 43, COLORS.window);

      // 屋根（とんがり屋根。ひさしの分だけ外へ広げる）
      const rB = shape.rB, rR = shape.rR, rF = shape.rF, rL = shape.rL, apex = shape.apex;
      fillPoly(ctx, [rB, rL, apex], shade(b.roofColor, 0.22), COLORS.outline);   // 奥の2面
      fillPoly(ctx, [rB, rR, apex], shade(b.roofColor, 0.08), COLORS.outline);
      fillPoly(ctx, [rL, rF, apex], b.roofColor, COLORS.outline);               // 手前の2面
      fillPoly(ctx, [rF, rR, apex], shade(b.roofColor, -0.22), COLORS.outline);

      // 看板（屋根のてっぺんに立てる）
      const text = b.sign || b.name;
      const w = signHalfWidth(b) * 2, h = 26;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const sx = apex.x, sy = apex.y - 17;                          // 看板の中心
      ctx.strokeStyle = shade(b.roofColor, -0.45);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(sx - w * 0.28, sy); ctx.lineTo(sx - w * 0.28, apex.y + 9);
      ctx.moveTo(sx + w * 0.28, sy); ctx.lineTo(sx + w * 0.28, apex.y + 9);
      ctx.stroke();
      ctx.fillStyle = "#fffbe8";
      roundRectPath(ctx, sx - w / 2, sy - h / 2, w, h, 5); ctx.fill();
      ctx.lineWidth = 2.5; ctx.stroke();
      ctx.fillStyle = "#3a2a1a";
      ctx.fillText(text, sx, sy + 1);
      if (isPending(b)) drawPendingTag(ctx, b, sx, sy, h);   // 準備中の建物は、看板の下に小札を吊るす
    },

    // 主人公（棒人間＋スケボー）。p＝主人公の状態（位置・向き・動き）
    // ★別のキャラ画像に差し替えるときは、この関数の中身を替える。
    //   使える情報：p.x, p.y（地図の位置）／p.heading（向き）／p.mode（動きの種類）／
    //               p.t（その動きが始まってからの秒数）／p.lean（傾き）／p.speed（速さ）
    //   画面の位置は iso(p.x, p.y) で出せる。
    isoPlayer: function (ctx, p, now) {
      const k = C.player.scale;
      const fx = Math.cos(p.heading), fy = Math.sin(p.heading);     // 前の向き
      const rx = -fy, ry = fx;                                      // 右の向き
      const base = iso(p.x, p.y);
      // 体の中の点（前A・右B・上z）を、画面の位置に直す
      const P = function (A, B, z) {
        const wx = (A * fx + B * rx) / BODY.unit, wy = (A * fy + B * ry) / BODY.unit;
        return { x: base.x + (wx - wy) * TW / 2 * k, y: base.y + ((wx + wy) * TH / 2 - z) * k };
      };
      const pose = playerPose(p, now);

      // 影
      const s1 = P(0, 0, 0), s2 = P(pose.hip.A, pose.hip.B, 0);
      ctx.fillStyle = "rgba(0,0,0,0.20)";
      ctx.beginPath(); ctx.ellipse(s1.x, s1.y, 13 * k, 6 * k, 0, 0, Math.PI * 2); ctx.fill();
      if (p.off > 0.05) { ctx.beginPath(); ctx.ellipse(s2.x, s2.y, 8 * k, 4 * k, 0, 0, Math.PI * 2); ctx.fill(); }

      // 板の横に立っていて、体のほうが奥にあるときだけ、体を先に描く
      Art.figure(ctx, p, pose, P, k, p.off > 0.5 && rx + ry < 0);
    },

    // 主人公の体と板（斜め見下ろし・背中ごしの両方で使う）。
    //   pose＝playerPose の結果、P(A, B, z)＝体の中の点（前A・右B・上z）を画面の位置に直す関数、
    //   k＝線の太さなどの倍率、bodyFirst＝体を板より先に描くか
    figure: function (ctx, p, pose, P, k, bodyFirst) {
      const J = {};
      Object.keys(pose).forEach(function (name) { J[name] = P(pose[name].A, pose[name].B, pose[name].z); });

      // スケボー（板＋車輪）。向きに合わせて、斜め画面の傾きで描く
      const drawBoard = function () {
        const roll = p.lean * 1.3 * (1 - p.off);                    // 曲がるとき、板も少し傾く
        const zAt = function (A, B) {
          return BODY.deckZ - roll * (B / BODY.deckW) + (Math.abs(A) > BODY.deckLen - 3 ? 1.2 : 0);   // 先と後ろは少し反る
        };
        // ★技の間は、板の点を技の動き（持ち上がり・先の上がり・回転）で動かしてから写す（技が無いときは P のまま）
        const bd = p.trick ? trickBoard(p.trick) : null;
        const Pb = bd ? function (A, B, z) { const q = trickBoardPoint(bd, A, B, z, true); return P(q.A, q.B, q.z); } : P;
        const upside = bd ? Math.cos(bd.flip) < 0 : false;          // 裏返っている間は、車輪が上（板の後に描く）・板は裏の色
        // 車輪
        const wheels = function () {
          ctx.fillStyle = "#f4efe2";
          ctx.strokeStyle = "#2a2a2a";
          ctx.lineWidth = 1.2 * k;
          [[8.5, 3.4], [8.5, -3.4], [-8.5, 3.4], [-8.5, -3.4]].forEach(function (w) {
            const q = Pb(w[0], w[1], 1.9);
            ctx.beginPath(); ctx.arc(q.x, q.y, 2.2 * k, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          });
        };
        if (!upside) wheels();
        // 板（両はしが丸い形）
        const out = [];
        const cA = BODY.deckLen - BODY.deckW;
        for (let i = 0; i <= 6; i++) {                              // 前の丸み
          const a = -Math.PI / 2 + Math.PI * i / 6;
          out.push([cA + Math.cos(a) * BODY.deckW, Math.sin(a) * BODY.deckW]);
        }
        for (let i = 0; i <= 6; i++) {                              // 後ろの丸み
          const a = Math.PI / 2 + Math.PI * i / 6;
          out.push([-cA + Math.cos(a) * BODY.deckW, Math.sin(a) * BODY.deckW]);
        }
        const pts = out.map(function (o) { return Pb(o[0], o[1], zAt(o[0], o[1])); });
        fillPoly(ctx, pts, upside ? shade(C.player.boardColor, -0.45) : C.player.boardColor);
        ctx.strokeStyle = "#2a2a2a"; ctx.lineWidth = 1.3 * k; ctx.stroke();
        if (upside) wheels();
      };

      // 棒人間（線と円）
      const drawBody = function () {
        const limbs = function () {
          ctx.beginPath();
          ctx.moveTo(J.hip.x, J.hip.y); ctx.lineTo(J.kneeB.x, J.kneeB.y); ctx.lineTo(J.footB.x, J.footB.y);   // 後ろの脚
          ctx.moveTo(J.hip.x, J.hip.y); ctx.lineTo(J.kneeF.x, J.kneeF.y); ctx.lineTo(J.footF.x, J.footF.y);   // 前の脚
          ctx.moveTo(J.hip.x, J.hip.y); ctx.lineTo(J.neck.x, J.neck.y);                                       // 胴
          ctx.moveTo(J.sh.x, J.sh.y); ctx.lineTo(J.handB.x, J.handB.y);                                       // 後ろの腕
          ctx.moveTo(J.sh.x, J.sh.y); ctx.lineTo(J.handF.x, J.handF.y);                                       // 前の腕
          ctx.stroke();
        };
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "rgba(255,255,255,0.85)";     // 白いふち（背景に埋もれないように）
        ctx.lineWidth = 5.4 * k;
        limbs();
        ctx.beginPath(); ctx.arc(J.head.x, J.head.y, (BODY.headR + 1.3) * k, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.fill();
        ctx.strokeStyle = C.player.color;
        ctx.lineWidth = 2.8 * k;
        limbs();
        ctx.beginPath(); ctx.arc(J.head.x, J.head.y, BODY.headR * k, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff"; ctx.fill();
        ctx.lineWidth = 2.5 * k; ctx.stroke();
        ctx.lineCap = "butt";
        ctx.lineJoin = "miter";
      };

      if (bodyFirst) { drawBody(); drawBoard(); }
      else { drawBoard(); drawBody(); }
    }
  };

  // ------------------------------------------------------------
  // 6. 主人公（動きの流れ）
  //    立つ → 板に乗る → 蹴る（1〜2回）→ 滑る → 減速 → 降りる → 立つ
  // ------------------------------------------------------------
  const player = {
    x: C.start.x + 0.5,    // 位置（マスの中心は ○.5）
    y: C.start.y + 0.5,
    heading: Math.PI / 4,  // 向き（最初は画面の手前向き）
    lean: 0,               // 曲がるときの傾き（-1〜1）
    speed: 0,              // いまの速さ（マス／秒）
    vmax: 0,               // 今回の移動の最高の速さ
    mode: "idle",          // 動きの種類
    t: 0,                  // その動きが始まってからの秒数
    off: 1,                // 0＝板の上 〜 1＝板の横に立っている
    offFrom: 1,            // 乗り降りを始めた時の off（途中からでも、なめらかに続けるため）
    route: null,           // なめらかな道のり
    dist: 0,               // 道のりを進んだ長さ
    kicks: 2,              // 蹴る回数
    kickNo: -1,            // いま何回目の蹴りか
    onArrive: null,        // 着いたときに呼ぶ処理
    trick: null,           // ★いま出している技（オーリー・キックフリップ。無ければ null）
    carve: null,           // ★カーブでよけている道のり（道のりからの横のずれの予定。無ければ null）
    carveOx: 0,            // ★カーブで、道のりから横へずれている量（地図の x・y。カメラが使う）
    carveOy: 0,
    carveYaw: 0            // ★カーブで、道のりの向きから体の向きがずれている量（ラジアン。カメラが使う）
  };

  function setMode(mode) { player.mode = mode; player.t = 0; }
  function playerTile() { return { x: Math.floor(player.x), y: Math.floor(player.y) }; }
  function isMoving() { return player.mode !== "idle"; }

  // 移動を始める。tiles＝通るマスの並び、onArrive＝着いたときに呼ぶ処理（無くてもよい）
  // すでに滑っている途中なら、板から降りずに、いまの位置から新しい道のりへつなぐ。
  function startTrip(tiles, onArrive) {
    const p = player;
    const riding = p.mode === "push" || p.mode === "glide" || p.mode === "brake";
    const route = buildRoute(tiles, riding ? { x: p.x, y: p.y } : null);
    const full = C.walkSpeed * C.skateMultiplier;       // いちばん速いときの速さ
    p.onArrive = onArrive || null;

    if (!riding && route.total < 0.01) {                // もう着いている（いま居る場所を選んだ）
      p.route = null;
      if (p.mode === "idle") {
        p.onArrive = null;
        if (onArrive) onArrive();
      } else {                                          // 乗りかけ・降りかけの途中なら、降りてから着いた扱いにする
        p.offFrom = p.off;
        setMode("dismount");
      }
      return;
    }

    p.route = route;
    p.dist = 0;
    if (p.carve) trickEndCarve(p);                       // ★新しい道のりは、いまの位置（カーブでずれた所）から始まるので、カーブの予定は消す

    if (riding) {
      // 滑っている途中の行き先変更
      p.vmax = full;
      if (route.total > 0.01) {
        const turn = Math.abs(angDiff(routeAt(route, 0).ang, p.heading));
        if (turn > 2.0) p.speed *= 0.3;                 // ほぼ逆向き：速さを大きく落として向きを変える
        else if (turn > 1.0) p.speed *= 0.6;            // 横向き：少し落とす
      }
      if (p.speed < full * 0.8) {                       // 遅くなっていたら、もう一度蹴って加速する
        p.kicks = p.speed < full * 0.4 ? 2 : 1;
        p.kickNo = -1;
        setMode("push");
      } else {
        setMode("glide");
      }
      return;
    }

    // 立っている所から出発
    const short = route.total <= 2.5;                   // 近いときは、蹴るのは1回・速さも控えめ
    p.kicks = short ? 1 : 2;
    p.kickNo = -1;
    p.speed = 0;
    p.vmax = full * (short ? 0.6 : 1);
    p.offFrom = p.off;
    setMode("mount");
  }

  // 移動を途中でやめる（「全体マップ」を押したとき）
  function cancelTrip() {
    const p = player;
    if (isMoving()) {
      const t = playerTile();                           // いま居るマスの中心で止まる
      p.x = t.x + 0.5;
      p.y = t.y + 0.5;
    }
    p.route = null;
    p.onArrive = null;
    p.speed = 0;
    p.lean = 0;
    p.off = 1;
    p.trick = null;                                     // ★技・カーブも、途中でやめる
    if (p.carve) trickEndCarve(p);
    setMode("idle");
    Sound.setRoll(0, true);
  }

  function updatePlayer(dt) {
    const p = player;
    p.t += dt;

    if (p.mode === "idle") {
      p.lean *= Math.exp(-dt * 8);
      return;
    }

    if (p.mode === "mount") {                           // 板に乗る（進む向きへ体を向ける）
      const k = clamp(p.t / T_MOUNT, 0, 1);
      const a0 = routeAt(p.route, 0).ang;
      p.off = p.offFrom * (1 - ease(k));
      p.heading += angDiff(a0, p.heading) * (1 - Math.exp(-dt * 14));
      if (k >= 1) { p.off = 0; p.heading = a0; setMode("push"); }
      return;
    }

    if (p.mode === "dismount") {                        // 板から降りる
      const k = clamp(p.t / T_DISMOUNT, 0, 1);
      p.off = lerp(p.offFrom, 1, ease(k));
      p.lean *= Math.exp(-dt * 8);
      if (k >= 1) {
        const done = p.onArrive;
        p.off = 1;
        p.route = null;
        p.onArrive = null;
        setMode("idle");
        Sound.step();
        if (done) done();
      }
      return;
    }

    // ---- ここから下は、進んでいる間（push 蹴る／glide 滑る／brake 減速） ----

    if (p.mode === "push") {
      const no = Math.floor(p.t / T_KICK);
      if (no >= p.kicks) {
        setMode("glide");
      } else {
        if (no !== p.kickNo) { p.kickNo = no; Sound.kick(); }
        const ph = (p.t - no * T_KICK) / T_KICK;
        // 蹴るたびに速くなる（蹴っている間だけ加速する）
        const target = p.vmax * (no + ease(clamp(ph / 0.55, 0, 1))) / p.kicks;
        if (target > p.speed) p.speed = target;
      }
    }

    // 目的地までの残りに合わせて、速さの上限を下げる（＝減速して止まる）
    const remain = Math.max(0, p.route.total - p.dist);
    const cap = Math.sqrt(2 * C.brakeDecel * remain) + 0.3;
    if (p.speed > cap) {
      p.speed = cap;
      if (p.mode === "glide") setMode("brake");
    }

    // ★技（tricks.enabled のときだけ）：技の時間を進め、通り道の動物を見て、跳ぶ／カーブでよけるを決める
    if (TRK.on) trickUpdate(p, dt);

    // 進む
    p.dist = Math.min(p.route.total, p.dist + p.speed * dt);
    const q = routeAt(p.route, p.dist);
    let nx = q.x, ny = q.y, qa = q.ang;
    if (p.carve) {                                      // ★カーブでよけている間は、道のりから横へずらす（向きも、ずれの変わり方に合わせる）
      const o = trickCarveAt(p.carve, p.dist);
      p.carveOx = -Math.sin(q.ang) * o.off; p.carveOy = Math.cos(q.ang) * o.off; p.carveYaw = Math.atan(o.slope);
      nx += p.carveOx; ny += p.carveOy; qa += p.carveYaw;
      if (p.dist >= p.carve.s3) trickEndCarve(p);
    }
    if (Math.floor(nx) !== Math.floor(p.x) || Math.floor(ny) !== Math.floor(p.y)) Sound.clack();   // マスの境目で「カタッ」
    p.x = nx;
    p.y = ny;

    // 向きは道のりの向きを少し遅れて追いかける。その遅れ（＝曲がり具合）で体を傾ける
    const lag = p.route.total > 0.01 ? angDiff(qa, p.heading) : 0;
    p.heading += lag * (1 - Math.exp(-dt * 16));
    const leanTo = clamp(lag * 2.6, -1, 1) * clamp(p.speed / (p.vmax * 0.5), 0, 1);
    const rate = Math.abs(leanTo) > Math.abs(p.lean) ? 14 : 4.5;     // 傾くのは速く、戻るのはゆっくり
    p.lean += (leanTo - p.lean) * (1 - Math.exp(-dt * rate));

    Sound.setRoll(trickInAir(p) ? 0 : p.speed / (C.walkSpeed * C.skateMultiplier), tileAt(Math.floor(p.x), Math.floor(p.y)) === T.ROAD);   // ★跳んでいる間は滑走音を止める

    // 着いた
    if (p.route.total - p.dist <= 0.002) {
      const end = p.route.pts[p.route.pts.length - 1];
      p.trick = null;                                   // ★技・カーブの途中でも、ここで終える（ふつうは着く前に終わっている）
      if (p.carve) trickEndCarve(p);
      p.dist = p.route.total;
      p.x = end.x;
      p.y = end.y;
      p.speed = 0;
      Sound.setRoll(0, true);
      Sound.brake();
      p.offFrom = 0;
      setMode("dismount");
    }
  }

  // ------------------------------------------------------------
  // 6a. ★スケボーの技で動物をよける（config.js の tricks）
  //    進んでいる間（push 蹴る・glide 滑る・brake 減速）に、これから通る道のりの上に地面の動物
  //    （猫・ウサギ・地面にいるスズメ・柴犬）がいれば、オーリー／キックフリップで飛び越えるか、体を傾けてカーブでよける。
  //    ・跳ぶ：いちばん高い所で動物の真上を通るように、始める時を速さから逆算する（柴犬・遅い時・着く直前は跳ばない）
  //    ・カーブ：動物と反対側へふくらみ、横を carveGap マス以上あけて通り、着く前に道のりへ戻る（ふくらむ先が通れなければ反対側、両側とも通れなければオーリー）
  //    ・跳ぶこともカーブもできない時（行き先の入口の前に座っている など）は、動物のほうが横へよける（スズメは群れで飛び立つ）
  //    ・歩いている時・止まっている時は、動物のほうが主人公から約0.5マスの中へ入らない（止まる・押しのけられる）
  //    判断の乱数は決まった種（tricks.seed）から作るので、同じ step の進め方なら毎回同じになる。
  //    tricks.enabled が false なら、ここは何もしない（今までと同じ動き）。空を飛ぶスズメ・ちょうちょ・池のアヒルは、よける対象にしない。
  // ------------------------------------------------------------
  const TRK = Object.assign({ seed: 1, kickflipRate: 1 / 3, minJumpSpeed: 1.6, carveGap: 0.6 }, C.tricks || {});
  TRK.on = !!(C.tricks && C.tricks.enabled === true);
  const TRICK_H = 1 / 60;        // 先読みの刻み（秒）
  const TRICK_AHEAD = 1.6;       // 先読みする長さ（秒）
  const TRICK_NEAR = 0.5;        // 道のりがこれより動物に近づくなら、よける（マス）
  const TRICK_CLEAR = 0.45;      // 跳ぶとき、踏み切りと着地の位置で動物からあける距離（マス）
  const TRICK_KEEP = 0.5;        // 歩いている・止まっている主人公から、動物があける距離（マス）
  const TRICK_KEEP_RIDE = 0.42;  // 滑っている主人公から、動物があける最後の守り（技・カーブでよけきれなかった時だけ押しのける）
  const trickRand = makeRand(Number(TRK.seed) || 1);
  // 技の回数の記録（確かめ用。PORTAL_DEBUG.trickStats）
  const trickStats = { ollie: 0, kickflip: 0, forcedOllie: 0, carve: 0, yield: 0, pushRiding: 0, pushWalking: 0, pushIdle: 0, stopped: 0, log: [] };
  function trickLog(what, a) {
    trickStats.log.push({ t: +state.time.toFixed(2), what: what, animal: a ? a.kind : "", at: a ? [+a.x.toFixed(2), +a.y.toFixed(2)] : null });
    if (trickStats.log.length > 200) trickStats.log.shift();
  }

  // よける対象の動物か（地面にいる猫・ウサギ・柴犬・スズメ）
  function trickTarget(a) {
    if (a.kind === "cat" || a.kind === "rabbit" || a.kind === "shiba") return true;
    return a.kind === "sparrow" && !a.air;
  }

  // t 秒後の動物の位置の見込み（いま向かっている先へ、いまの速さで進むとする）。飛び立った後なら null
  function trickAnimalAt(a, t) {
    if (a.kind === "sparrow" && a.delay >= 0 && t > a.delay) return null;
    if (!a.hold && (a.state === "walk" || a.state === "run" || a.state === "hop")) {
      const dx = a.tx - a.x, dy = a.ty - a.y, dist = Math.hypot(dx, dy);
      if (dist > 0.01) { const m = Math.min(dist, a.spd * t) / dist; return { x: a.x + dx * m, y: a.y + dy * m }; }
    }
    return { x: a.x, y: a.y };
  }

  // 技の空中か／板の底の高さ（マス）
  function trickInAir(p) { return !!p.trick && trickPhase(p.trick).name === "air"; }
  function trickAir(p) {
    if (!p.trick) return 0;
    const ph = trickPhase(p.trick);
    return ph.name === "air" ? p.trick.H * 4 * ph.k * (1 - ph.k) : 0;
  }

  // 飛び越える高さ（マス）：動物の絵の高さ（耳・しっぽの上まで）＋0.12（猫・ウサギ 約0.5。柴犬なら肩 約0.33マスより十分高い上限 0.55）
  // 確かめ後の手直し：前は「絵の高さの8割＋0.1」で、猫・ウサギの真上の余裕が約0.02マス（約1px）しかなかった
  const TRICK_HMAX = 0.55;       // 板の高さの上限（マス）
  function trickJumpHeight(a) {
    return clamp(trickArtH(a) + 0.12, 0.25, TRICK_HMAX);
  }
  // 動物の絵の高さ（マス）
  function trickArtH(a) {
    const art = ANIMAL_ART[a.kind];
    return art ? art.size.h / ART_PX : 0.3;
  }

  // これからの道のりの見込み（TRICK_H 秒ごと）。速さは、いまの速さのまま（行き先が近づけば、減速の上限で下がる）。カーブ中は横のずれも入れる
  function trickForecast(p, n) {
    const route = p.route, cur = route.cursor, out = [];
    let s = p.speed, d = p.dist;
    for (let i = 0; i <= n; i++) {
      if (i > 0) {
        const cap = Math.sqrt(2 * C.brakeDecel * Math.max(0, route.total - d)) + 0.3;
        if (s > cap) s = cap;
        d = Math.min(route.total, d + s * TRICK_H);
      }
      const q = routeAt(route, d);
      let x = q.x, y = q.y;
      if (p.carve) { const o = trickCarveAt(p.carve, d).off; x += -Math.sin(q.ang) * o; y += Math.cos(q.ang) * o; }   // カーブ中は、横のずれも入れる
      out.push({ d: d, v: s, x: x, y: y, ang: q.ang });
    }
    route.cursor = cur;                                 // 道のりの読み位置を元に戻す
    return out;
  }

  // カーブの横のずれ（右が＋）と、その変わり方（ずれ÷道のり）。s＝道のりの位置
  function trickCarveAt(c, s) {
    if (s <= c.s0 || s >= c.s3) return { off: 0, slope: 0 };
    if (s < c.s1) { const u = (s - c.s0) / (c.s1 - c.s0); return { off: c.O * ease(u), slope: c.O * 6 * u * (1 - u) / (c.s1 - c.s0) }; }
    if (s <= c.s2) return { off: c.O, slope: 0 };
    const u = (s - c.s2) / (c.s3 - c.s2);
    return { off: c.O * (1 - ease(u)), slope: -c.O * 6 * u * (1 - u) / (c.s3 - c.s2) };
  }
  function trickEndCarve(p) { p.carve = null; p.carveOx = 0; p.carveOy = 0; p.carveYaw = 0; }

  // カーブの道すじが、ずっと通れるマスの上か（体の幅のぶん、左右も見る）
  function trickCarveClear(route, c) {
    const cur = route.cursor;
    let ok = true;
    for (let s = c.s0; s <= c.s3 + 1e-6 && ok; s += 0.08) {
      const q = routeAt(route, s), o = trickCarveAt(c, s).off;
      const rx = -Math.sin(q.ang), ry = Math.cos(q.ang);
      for (let w = -1; w <= 1 && ok; w++) {
        const x = q.x + rx * (o + w * 0.18), y = q.y + ry * (o + w * 0.18);
        if (!isWalkable(Math.floor(x), Math.floor(y))) ok = false;
      }
    }
    route.cursor = cur;
    return ok;
  }

  // カーブの予定を作る（動物と反対側へふくらむ。通れなければ反対側。どちらも通れなければ null）
  function trickCarvePlan(p, fc, th, others, ths) {
    const a = th.a;
    // 確かめ後の手直し：すぐ先（2.5マス以内）にも道のりの上の動物がいれば、まとめて同じ側でよける（1回のふくらみで両方の横を通る）
    const list = [th];
    (ths || []).forEach(function (u) { if (u !== th && fc[u.i].d - fc[th.i].d <= 2.5) list.push(u); });
    const ps = list.map(function (u) {
      const f = fc[u.i], q = trickAnimalAt(u.a, u.i * TRICK_H);
      const dx = Math.cos(f.ang), dy = Math.sin(f.ang);
      return { sA: f.d + (q.x - f.x) * dx + (q.y - f.y) * dy,     // 動物の横を通る、道のりの位置
               lat: -(q.x - f.x) * dy + (q.y - f.y) * dx,         // 動物の、道のりからの横のずれ（右が＋）
               G: TRK.carveGap + ANIMAL_KIND[u.a.kind].margin };  // 体の中心どうしであける距離（動物の体の幅の半分を足す）
    });
    const lat = ps[0].lat;
    const sAmin = Math.min.apply(null, ps.map(function (u) { return u.sA; })), sAmax = Math.max.apply(null, ps.map(function (u) { return u.sA; }));
    const total = p.route.total;
    const sides = lat > 0 ? [-1, 1] : [1, -1];
    for (let n = 0; n < 2; n++) {
      const O = sides[n] < 0 ? Math.min.apply(null, ps.map(function (u) { return u.lat - u.G; })) : Math.max.apply(null, ps.map(function (u) { return u.lat + u.G; }));
      const L = clamp(Math.abs(O) * 1.8, 0.8, 1.6);
      let s1 = Math.min.apply(null, ps.map(function (u) { return u.sA - u.G - 0.15; })), s0 = s1 - L;
      let s2 = Math.max.apply(null, ps.map(function (u) { return u.sA + u.G + 0.15; })), s3 = s2 + L;
      if (s0 < p.dist) { s0 = p.dist; if (s1 < s0 + 0.5) s1 = s0 + 0.5; }   // ふくらみ始めが遅れたときは、短く寄る
      if (s3 > total - 0.1) { s3 = total - 0.1; if (s2 > s3 - 0.4) s2 = s3 - 0.4; }   // 着く前に、道のりへ戻り切る
      if (s2 < s1 || s1 > sAmin - 0.25 || s2 < sAmax + 0.25) continue;   // 動物の横を、ふくらみ切って通れない（間に合わない・着く直前）
      const plan = { s0: s0, s1: s1, s2: s2, s3: s3, O: O, target: a, group: list.map(function (u) { return u.a; }) };
      if (trickCarveClear(p.route, plan) && trickCarveFree(fc, plan, others)) return plan;
    }
    return null;
  }

  // 確かめ後の手直し：カーブの道すじが、よける相手のほかの地面の動物にも近づかないか（0.5マス＋その動物の体の幅の半分）
  // 前は、よける相手1匹しか見ず、並んで座っている別の動物に、カーブの先で0.14〜0.26マスまで近づくことがあった
  function trickCarveFree(fc, c, others) {
    for (let n = 0; n < others.length; n++) {
      const b = others[n];
      if (c.group.indexOf(b) >= 0) continue;
      const G = TRICK_NEAR + ANIMAL_KIND[b.kind].margin;
      for (let i = 0; i < fc.length; i += 2) {
        const f = fc[i];
        if (f.d < c.s0 || f.d > c.s3) continue;
        const q = trickAnimalAt(b, i * TRICK_H);
        if (!q) continue;
        const o = trickCarveAt(c, f.d).off;
        if (Math.hypot(f.x - Math.sin(f.ang) * o - q.x, f.y + Math.cos(f.ang) * o - q.y) < G) return false;
      }
    }
    return true;
  }

  // 技を始める
  function trickStart(p, a, H, Ta, forced, group) {
    const kind = trickRand() < TRK.kickflipRate ? "kickflip" : "ollie";
    p.trick = { kind: kind, t: 0, Tc: TRICK_CROUCH, Ta: Ta, Tl: TRICK_LAND, H: H, Hpx: H * ART_PX / C.player.scale, flipDir: 1, target: a, popped: false, landed: false,
                targets: group || [a] };                 // 確かめ後の手直し：飛び越える動物の全部（着地まで逃げずに身をすくめ、着地のあとで驚いて逃げる）
    if (p.mode === "push") setMode("glide");            // 蹴っている途中なら、蹴るのをやめて板に両足を乗せる
    trickStats[kind]++;
    if (forced) trickStats.forcedOllie++;
    trickLog(kind + (forced ? "（両側とも通れず）" : ""), a);
  }

  // 確かめ後の手直し：跳ぶ相手に決めた動物は、着地するまで逃げない（その場で身をすくめる）。
  // 前は、猫が逃げ出す距離（2マス）と技を始める距離がほぼ同じで、跳んだ時には猫が逃げていて真上を越えないことが半分あった。
  // braceT＝跳ぶと決めて待っている間の印（毎回のばす。跳ばないことになれば、すぐ切れて、ふだんの反応に戻る）
  function trickBraced(a) {
    if (!TRK.on) return false;
    if ((a.braceT || 0) > state.time) return true;
    const tr = player.trick;
    return !!tr && !tr.landed && tr.targets.indexOf(a) >= 0;
  }
  function trickBrace(list) {
    list.forEach(function (a) { a.braceT = state.time + 0.25; });
  }
  // 確かめ後の手直し：スズメの群れが降りる所として、主人公のそば（2マス）と、これから通る道のり（1.8マス）のそばを選ばない。
  // 前は、空中にいる間に板の真下へ降りてきたり、止まっている主人公の0.5マスの所へ降りて押しのけで一瞬で動いたりした
  function trickLandBad(x, y) {
    const p = player;
    if (Math.hypot(x - p.x, y - p.y) < 2) return true;
    if (!p.route) return false;
    const cur = p.route.cursor;
    let bad = false;
    for (let s = p.dist; s <= p.route.total + 1e-6 && !bad; s += 0.5) {
      const q = routeAt(p.route, s);
      if (Math.hypot(x - q.x, y - q.y) < 1.8) bad = true;
    }
    p.route.cursor = cur;                               // 道のりの読み位置を元に戻す
    return bad;
  }

  // 板を弾いたとき：跳ぶ相手にしたスズメの群れは、弾いた音（パン）で飛び立つ
  function trickPopTakeoff(tr) {
    tr.targets.forEach(function (a) {
      if (a.kind === "sparrow" && a.flock && !a.air && a.delay < 0) flockTakeoff(a.flock, { x: player.x, y: player.y });
    });
  }

  // 着地のとき：飛び越えた猫・ウサギが、まだ逃げていなければ驚いて逃げる
  function trickStartle(a) {
    if (!a || a.hold || (a.kind !== "cat" && a.kind !== "rabbit") || a.react === "flee") return;
    const t = animalFleeTarget(a, rndIn(a.rnd, 1.6, 2.6));
    if (t) { a.react = "flee"; animalGo(a, t, ANIMAL_KIND[a.kind].run, a.kind === "cat" ? "run" : "hop"); }
  }

  // 跳ぶこともカーブもできないとき（行き先の入口の前に座っている など）：動物のほうが、道のりから横へよける
  // （猫・ウサギは小走りで、柴犬は歩いて、道のりから0.75マス以上離れた所へ。スズメは群れで飛び立つ）
  function trickYield(a, fc) {
    if (a.hold || (a.yieldT || 0) > state.time) return false;
    if (a.kind === "sparrow") {
      if (!a.flock || a.delay >= 0) return false;
      a.cool = 0; flockTakeoff(a.flock, { x: player.x, y: player.y });
      a.yieldT = state.time + 1;
      trickStats.yield++; trickLog("yield（飛び立つ）", a);
      return true;
    }
    let best = null, bestScore = Infinity;
    for (let k = 0; k < 16; k++) {
      const ang = k / 16 * Math.PI * 2;
      for (let r = 0.7; r <= 1.71; r += 0.5) {
        const x = a.x + Math.cos(ang) * r, y = a.y + Math.sin(ang) * r;
        let dm = Infinity;
        for (let i = 0; i < fc.length; i += 2) dm = Math.min(dm, Math.hypot(fc[i].x - x, fc[i].y - y));
        if (dm < 0.75) continue;
        if (!animalOk(a, x, y) || !animalLineOk(a, a.x, a.y, x, y)) continue;
        const score = r - Math.min(dm, 1.5) * 0.3;        // 近くで、道のりから離れた所
        if (score < bestScore) { bestScore = score; best = { x: x, y: y }; }
      }
    }
    if (!best) return false;
    const K = ANIMAL_KIND[a.kind];
    a.yieldT = state.time + 1.5;
    if (a.kind === "shiba") { a.react = null; a.cool = Math.max(a.cool, 2); animalGo(a, best, K.walk * 2, "walk"); }
    else { a.react = "flee"; animalGo(a, best, K.run, a.kind === "cat" ? "run" : "hop"); }
    trickStats.yield++; trickLog("yield（横へよける）", a);
    return true;
  }

  // 板を弾いたとき：着地する所へ向かって動いている動物（逃げる向きが道の先だった猫など）は、音に驚いて横へよける
  function trickClearLanding(p, tr) {
    const fc = trickForecast(p, Math.round((tr.Ta + 0.3) / TRICK_H));
    const iDown = Math.min(fc.length - 1, Math.round(tr.Ta / TRICK_H));
    animals.forEach(function (a) {
      if (!trickTarget(a) || Math.hypot(a.x - p.x, a.y - p.y) > 4) return;
      if (tr.targets.indexOf(a) >= 0) return;            // 飛び越える相手は、その場で身をすくめたまま
      for (let i = iDown; i < fc.length; i += 3) {
        const q = trickAnimalAt(a, i * TRICK_H);
        if (q && Math.hypot(fc[i].x - q.x, fc[i].y - q.y) < TRICK_KEEP) { trickYield(a, fc.slice(iDown)); return; }
      }
    });
  }

  // 進んでいる間に毎回呼ぶ：技の時間を進め、空中でなければ、通り道の動物を見て決める
  // （跳ぶ → カーブ → 両側とも通れなければオーリー → どれもできなければ動物のほうがよける。カーブ中は、跳ぶか動物がよけるだけ）
  function trickUpdate(p, dt) {
    if (p.trick) {
      const tr = p.trick;
      tr.t += dt;
      if (!tr.popped && tr.t >= tr.Tc) { tr.popped = true; Sound.pop(); trickPopTakeoff(tr); trickClearLanding(p, tr); }   // 後ろ足で板を弾く「パン」
      if (!tr.landed && tr.t >= tr.Tc + tr.Ta) { tr.landed = true; Sound.land(); tr.targets.forEach(trickStartle); }   // 着地の「ガシャッ」
      if (tr.t >= tr.Tc + tr.Ta + tr.Tl) {
        p.trick = null;
        // 蹴っている途中で跳んだときは、着地のあと、もう1回蹴って速さを戻す（着く時間が遅れないように）
        if (p.mode === "glide" && p.speed < p.vmax - 0.05 && p.route.total - p.dist > 3) { p.kicks = 1; p.kickNo = -1; setMode("push"); }
      }
      else if (!tr.landed) return;                        // 空中の間は、次を決めない（着地を受けている間は、次の技・カーブを始めてよい）
    }
    if (p.speed < 0.05) return;
    const reach = p.speed * TRICK_AHEAD + 2;
    const near = animals.filter(function (a) { return trickTarget(a) && Math.hypot(a.x - p.x, a.y - p.y) < reach; });
    if (!near.length) return;
    const fc = trickForecast(p, Math.round(TRICK_AHEAD / TRICK_H));

    // 道のりが近づく動物（いちばん近づく時の順）
    const ths = [];
    near.forEach(function (a) {
      let mi = -1, md = Infinity;
      for (let i = 0; i < fc.length; i++) {
        const q = trickAnimalAt(a, i * TRICK_H);
        if (!q) break;
        const d = Math.hypot(fc[i].x - q.x, fc[i].y - q.y);
        if (d < md) { md = d; mi = i; }
      }
      if (mi > 0 && md < TRICK_NEAR) ths.push({ a: a, i: mi, d: md });   // いちばん近いのが「いま」なら、もう横を過ぎている
    });
    if (!ths.length) return;
    ths.sort(function (u, v) { return u.i - v.i; });
    const th = ths[0], a = th.a;
    // 行き先の入口（止まる所）のすぐそばにいる動物は、跳んでもカーブでもよけきれないので、動物のほうがよける
    const end = p.route.pts[p.route.pts.length - 1], qa = trickAnimalAt(a, th.i * TRICK_H);
    if (Math.hypot(qa.x - end.x, qa.y - end.y) < 0.8) {
      if (th.i * TRICK_H <= 0.9 || Math.hypot(a.x - p.x, a.y - p.y) < 2) trickYield(a, fc);
      return;
    }

    // 跳ぶ：続けて並んでいる動物（空中で越えられる間隔）は、まとめて1回で越える。いちばん高い所を、その真ん中に合わせる
    const half0 = Math.round(clamp(0.42 + trickJumpHeight(a) * 0.3, 0.45, 0.6) / 2 / TRICK_H);
    let last = th.i;
    ths.forEach(function (u) { if (u.i - th.i <= half0 * 1.1) last = Math.max(last, u.i); });
    // 跳びの予定（lastI＝まとめて越える最後の動物の位置、big＝高さ・空中の時間を上限にする）
    const mkPlan = function (lastI, big) {
      let H = trickJumpHeight(a);
      ths.forEach(function (u) { if (u.i <= lastI) H = Math.max(H, trickJumpHeight(u.a)); });
      const pk = Math.round((th.i + lastI) / 2);
      // 動物も同じ向きへ逃げている時など、近づく速さが遅いときは、真上の前後（0.35マス）で板が低くならないように、
      // 空中の時間を延ばし（0.6秒まで）、それでも足りなければ高さを上限（TRICK_HMAX）にする
      let Ta = clamp(0.42 + H * 0.3, 0.45, 0.6);
      if (pk - 6 >= 0 && pk + 6 < fc.length) {
        const q1 = trickAnimalAt(a, (pk - 6) * TRICK_H), q2 = trickAnimalAt(a, (pk + 6) * TRICK_H);
        if (q1 && q2) {
          const vc = (Math.hypot(fc[pk - 6].x - q1.x, fc[pk - 6].y - q1.y) + Math.hypot(fc[pk + 6].x - q2.x, fc[pk + 6].y - q2.y)) / (12 * TRICK_H);
          const need = 0.35 / Math.max(vc, 0.1) / 0.18;
          if (need > Ta) { Ta = Math.min(0.6, need); if (need > 0.6) H = TRICK_HMAX; }
        }
      }
      if (big) { H = TRICK_HMAX; Ta = 0.6; }
      const half = Math.round(Ta / 2 / TRICK_H), tPeak = TRICK_CROUCH + Ta / 2;   // 始めてから、いちばん高くなるまで
      const tNow = pk * TRICK_H;                         // いまから、動物の真上（いちばん近い所）を通るまで
      return { H: H, Ta: Ta, pk: pk, tPeak: tPeak, tNow: tNow, iUp: pk - half, iDown: pk + half, s0: Math.max(0, Math.round((tNow - tPeak) / TRICK_H)) };
    };
    // 確かめ後の手直し：空中で、どの動物の上でも板（車輪の下）が動物の高さより上にあるか（真上で＋0.08マス、前後0.45マスで＋0.02マス）。
    // 板と動物が上から見て重なる範囲（進む向きに前後0.45マス・横0.23マス＝板の幅の半分0.11＋動物の体の幅の半分）で調べる。
    // 前は、2匹をまとめて越えると1匹目の真上で板が低く、猫・ウサギに食い込むことがあった
    const clearOk = function (pl) {
      for (let i = pl.s0; i < fc.length; i++) {
        const k = ((i - pl.s0) * TRICK_H - TRICK_CROUCH) / pl.Ta;
        if (k > 1) break;
        const h = k > 0 ? pl.H * 4 * k * (1 - k) : 0;
        const ux = Math.cos(fc[i].ang), uy = Math.sin(fc[i].ang);
        for (let n = 0; n < near.length; n++) {
          const q = trickAnimalAt(near[n], i * TRICK_H);
          if (!q) continue;
          const along = Math.abs((q.x - fc[i].x) * ux + (q.y - fc[i].y) * uy), side = Math.abs(-(q.x - fc[i].x) * uy + (q.y - fc[i].y) * ux);
          if (along < 0.45 && side < 0.23 && h < trickArtH(near[n]) + 0.02 + 0.06 * (1 - along / 0.45)) return false;
        }
      }
      return true;
    };
    let pl = mkPlan(last, false);
    if (!clearOk(pl)) pl = mkPlan(last, true);
    if (!clearOk(pl) && last > th.i) {                   // まとめて越えられない間隔：1匹目だけを越える予定にする
      last = th.i; pl = mkPlan(last, false);
      if (!clearOk(pl)) pl = mkPlan(last, true);
    }
    const clear = clearOk(pl);
    const H = pl.H, Ta = pl.Ta, pk = pl.pk, tPeak = pl.tPeak, tNow = pl.tNow, iUp = pl.iUp, iDown = pl.iDown;
    const group = ths.filter(function (u) { return u.i <= last; }).map(function (u) { return u.a; });
    const dist = function (f, q) { return Math.hypot(f.x - q.x, f.y - q.y); };
    const jumpable = function (force) {
      if (!clear) return false;                                                     // 空中で、動物の上を板が十分高く通れない
      if (iDown >= fc.length || fc[iDown].d > p.route.total - 0.6) return false;   // 着地が、行き先の手前に収まらない
      if (!force && fc[pk].v < TRK.minJumpSpeed) return false;                     // 遅すぎて、跳んでも越えきれない
      // 確かめ後の手直し：着地のすぐ後（0.5秒以内）に道のりの上の次の動物が来るときは跳ばない（カーブで、まとめてよける）
      if (!force && ths.some(function (u) { return u.i > last && u.i <= iDown + Math.round(0.5 / TRICK_H); })) return false;
      for (let n = 0; n < near.length; n++) {                                       // 踏み切る所・着地する所に、動物がいない
        const qu = iUp >= 0 ? trickAnimalAt(near[n], iUp * TRICK_H) : null, qd = trickAnimalAt(near[n], iDown * TRICK_H);
        if (qu && dist(fc[iUp], qu) < TRICK_CLEAR) return false;
        if (qd && dist(fc[iDown], qd) < TRICK_CLEAR) return false;
      }
      return true;
    };
    const shibaIn = ths.some(function (u) { return u.i <= last && u.a.kind === "shiba"; });
    if (!shibaIn && jumpable(false)) {
      if (tNow >= tPeak - 0.12) trickBrace(group);        // 跳ぶ相手は、逃げずに身をすくめて待つ
      if (tNow > tPeak + TRICK_H * 0.5) return;           // まだ早い（いちばん高い所で真上を通るように、始める時を待つ）
      if (tNow >= tPeak - 0.12) { trickStart(p, a, H, Ta, false, group); return; }
    }
    if (p.carve) {                                        // カーブ中に、ほかの動物（または動いた動物）が道すじに入った：跳べなければ、動物のほうがよける
      if (th.i * TRICK_H <= 0.9) trickYield(a, fc);
      return;
    }
    // カーブでよける（動物の横を通る所の前後を、ふくらんだまま通れる予定のときだけ）
    const plan = trickCarvePlan(p, fc, th, near, ths);
    if (plan) {
      if (plan.s0 > p.dist + p.speed * TRICK_H * 1.5) return;   // まだ早い（ふくらみ始める所まで待つ）
      p.carve = plan;
      trickStats.carve++;
      trickLog("carve", a);
      return;
    }
    if (jumpable(true)) {                                 // 両側とも通れない：オーリーで越える
      if (tNow >= tPeak - 0.12) trickBrace(group);
      if (tNow > tPeak + TRICK_H * 0.5) return;
      if (tNow >= tPeak - 0.12) { trickStart(p, a, Math.max(H, 0.4), Ta, true, group); return; }
    }
    if (th.i * TRICK_H <= 0.9) trickYield(a, fc);          // どれもできない：動物のほうが横へよける
  }

  // ★動物が、主人公の近くへ歩いて入らない（止まる）。(nx,ny)＝動物が次に進む位置
  function trickKeepOut(a, nx, ny) {
    if (!trickTarget(a) || trickInAir(player)) return false;
    const dn = Math.hypot(nx - player.x, ny - player.y);
    return dn < TRICK_KEEP && dn < Math.hypot(a.x - player.x, a.y - player.y);
  }

  // ★主人公のすぐそばにいる動物を、押しのける（歩いている・止まっている時は約0.5マス、滑っている時は最後の守りとして0.42マス）
  function trickPushAway(a) {
    if (!trickTarget(a) || a.hold) return;
    const p = player;
    if (trickInAir(p)) return;                          // 真上を飛び越えている間は、そのまま
    const riding = p.mode === "push" || p.mode === "glide" || p.mode === "brake";
    const keep = riding ? TRICK_KEEP_RIDE : TRICK_KEEP;
    const dx = a.x - p.x, dy = a.y - p.y, d = Math.hypot(dx, dy);
    // 降りたばかり（まだ反応しない間）のスズメも、滑ってくる主人公が1.2マスまで来たら、群れで飛び立つ
    if (a.kind === "sparrow" && riding && a.delay < 0 && a.flock && d < 1.2 && !trickBraced(a)) {
      flockTakeoff(a.flock, { x: p.x, y: p.y });
      if (a.delay > 0) a.delay = 0;
      trickStats.yield++; trickLog("yield（飛び立つ）", a);
      if (d >= keep) return;                            // すぐそばに降りてきたときは、飛び立つ前に下の押しのけも行う
    }
    if (d >= keep) { if (d > keep + 0.2) a.pushed = false; return; }
    const ang = d > 1e-4 ? Math.atan2(dy, dx) : a.heading + Math.PI;
    const turns = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2.2, -2.2];
    for (let i = 0; i < turns.length; i++) {
      const x = p.x + Math.cos(ang + turns[i]) * keep, y = p.y + Math.sin(ang + turns[i]) * keep;
      if (animalOk(a, x, y)) {
        a.x = x; a.y = y;
        if (!a.pushed) {
          a.pushed = true;
          if (riding) trickStats.pushRiding++; else if (p.mode === "idle") trickStats.pushIdle++; else trickStats.pushWalking++;
          trickLog("push（" + p.mode + " 速さ" + p.speed.toFixed(2) + (p.trick ? " " + p.trick.kind : "") + (p.carve ? " carve" : "") + " 残り" + (p.route ? (p.route.total - p.dist).toFixed(2) : "-") + "）", a);
        }
        return;
      }
    }
  }

  // ------------------------------------------------------------
  // 6b. 動物（★カメラ試作で足した物。config.js の animals）
  //    歩き回る動物を置き、主人公が近づくと反応させる。
  //    描くのは移動画面の背中ごし（renderFollow）と斜め見下ろし（renderField）だけ。全体マップには出さない。
  //    この節＝絵の置き場（ANIMAL_ART）と、動き（位置・状態・向き）。描く所は 7. の両方の画面から呼ぶ。
  //    animals.enabled が false なら、動物は1匹も作らず、どの画面も今までと同じに描く。
  // ------------------------------------------------------------

  // 動物の絵の置き場。決まりの形：
  //   ANIMAL_ART.<種類> = {
  //     size: { w: 横幅px, h: 高さpx },   // 斜め見下ろしの絵の物差し（ART_PX＝45px が1マス）。右向きの横向きで、足元から頭（耳・しっぽ）の上まで
  //     states: ["idle", "walk", ...],    // 描ける状態（無い状態を頼まれたときは、仕組みの側で近い状態に置き換える。ANIMAL_STATE_FALLBACK）
  //     draw: function (ctx, s) { ... }   // ctx の原点＝足元の中心（地面に触れる所）。上が −y。右向きの横向きが基本
  //   };
  //   s ＝ { state: 状態, phase: 0〜1（歩く・羽ばたくなどの周期の中の位置）, t: 秒, view: "side" | "front" | "back",
  //          seed: 0〜1（個体ごとの値）, variant: 種類の中の毛色の名前 }
  //   左向きは、仕組みの側で ctx.scale(-1, 1) をかけてから draw を呼ぶ（絵の側で左右反転はしない）。
  //   影（地面の楕円）は仕組みの側で描く（絵の側では描かない）。飛んでいる時の高さも仕組みの側で上へずらす。
  //   種類の名前：sparrow（スズメ）・shiba（柴犬）・cat（猫）・butterfly（ちょうちょ）・rabbit（ウサギ）・duck（アヒル）
  //   variant：sparrow＝"suzume"／shiba＝"aka"／cat＝"chatora"｜"mike"｜"hachiware"／butterfly＝"monshiro"｜"ageha"／rabbit＝"nousagi"／duck＝"ahiru"
  const ANIMAL_ART = Object.create(null);   // 元からの名前（constructor など）を持たない入れ物

  // ============================================================
  // ★動物の絵（ここから）
  //   3人の絵の担当が描いた絵（スズメ・ちょうちょ／柴犬・猫／ウサギ・アヒル）。
  //   差し替えるときは「★動物の絵（ここから）」〜「★動物の絵（ここまで）」を丸ごと入れ替える（ANIMAL_ART の決まりの形を守れば、ほかは変えなくて済む）。
  //   組み込みのときに変えた所には「組み込みで」と書いてある。
  // ============================================================

  // ------------------------------------------------------------
  // 動物の絵：スズメ（sparrow）
  //   中の寸法は「本物の mm」で描き、最後に MM（1mm＝何px）をかけて斜め見下ろしの px にする。
  //   本物の比率（主人公＝約1.6m＝1.4マス）だと小さすぎて見えないので、2倍の大きさにしてある。
  //   高さはそのまま上へ、奥行きは半分（斜め見下ろしの地面のつぶれ）で画面に出す。
  // ------------------------------------------------------------
  ANIMAL_ART.sparrow = (function () {
    const MM = 2 * 45 * 1.4 / 1600;           // 1mm＝何px（2倍の大きさ。45px＝1マス、1.6m＝1.4マス）
    const OL = "rgba(40,30,20,0.55)";         // 輪郭の色（COLORS.outline と同じ）
    const PAL = {
      cap: "#9a6038",        // 頭のてっぺん（栗色）
      cheek: "#f4f0e6",      // 白いほお
      black: "#2a221c",      // ほおの黒い点・のどの黒
      back: "#a8784a",       // 背中の茶
      streak: "#4a3322",     // 背中の黒いまだら
      edge: "#d6b282",       // 羽のふちの明るい色
      wing: "#9c6b40",       // 羽（雨おおい）
      bar: "#f2ecdf",        // 羽の白い帯
      prim: "#55402e",       // 風切り羽（黒っぽい茶）
      belly: "#ddd5c7",      // おなか（明るい灰色）
      flank: "#c7b8a2",      // わき腹（少し茶色がかった灰色）
      under: "#d3cabd",      // 羽の裏
      tail: "#6b4e36",       // 尾
      beak: "#2c2826",       // くちばし
      leg: "#b48e78",        // 足
      eye: "#1a1410"
    };

    // 0〜1 の決まった乱数（同じ値からは毎回同じ答え）
    function rnd(a, b) {
      const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
      return s - Math.floor(s);
    }
    function ease(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }
    // 色を明るく（k＞0）・暗く（k＜0）する
    function tone(hex, k) {
      const n = parseInt(hex.slice(1), 16);
      const f = function (c) { return Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k)); };
      return "rgb(" + f(n >> 16) + "," + f((n >> 8) & 255) + "," + f(n & 255) + ")";
    }
    // 輪郭の太さ（mm）。画面上で約0.8pxになるようにし、体に対して太くなりすぎないよう上下を決める
    function lineMM(ctx) {
      let sc = MM;
      if (ctx.getTransform) { const m = ctx.getTransform(); sc = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || MM; }
      return Math.max(1.4, Math.min(4, 0.8 / sc));
    }
    function ell(ctx, x, y, rx, ry, rot) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot || 0, 0, Math.PI * 2); }

    // 体の中の点（前 f・左 l・上 z。mm）を画面に直す。view ごとに奥行きの向きが変わる
    function proj(view, f, l, z) {
      if (view === "front") return { x: l, y: -z + f * 0.5 };
      if (view === "back") return { x: -l, y: -z - f * 0.5 };
      return { x: f, y: -z - l * 0.5 };
    }

    // 状態から姿勢を決める
    function poseOf(s) {
      const ph = s.phase || 0, t = s.t || 0, sd = s.seed || 0;
      const p = { lift: 0, pitch: 0, neck: 0, dip: 0, yaw: 0, tilt: 0, legs: "stand", tail: 0, fly: false, theta: 0, blink: false };
      const bt = (t + sd * 7.3) % 3.7;
      p.blink = bt < 0.11;
      if (s.state === "walk") {                          // 小さく跳ねながら進む（スズメは地面を両足で跳ねて歩く）
        const u = Math.sin(Math.PI * ph);
        p.lift = 5 * u; p.pitch = 0.06; p.legs = u > 0.35 ? "tuck" : "bend"; p.tail = 0.06 * u;
      } else if (s.state === "hop") {                    // 大きく両足で跳ねる
        const u = Math.sin(Math.PI * ph);
        p.lift = 18 * u; p.pitch = -0.12 * Math.cos(Math.PI * ph); p.legs = u > 0.25 ? "tuck" : "bend"; p.tail = 0.12 * u;
      } else if (s.state === "peck") {                   // 首を下げて地面をつつく
        const k = ph < 0.42 ? ease(ph / 0.42) : (ph < 0.58 ? 1 : ease((1 - ph) / 0.42));
        const tap = ph > 0.42 && ph < 0.58 ? Math.sin((ph - 0.42) / 0.16 * Math.PI * 2) * 0.05 : 0;
        p.pitch = 0.5 * k + tap; p.neck = 21 * k; p.tilt = 0.6 * k; p.dip = k; p.tail = 0.2 * k; p.legs = "bend";
      } else if (s.state === "fly") {                    // 羽ばたき。phase＝0 で羽が上、0.5 で下
        p.fly = true; p.legs = "fold"; p.pitch = -0.05;
        p.theta = (8 + 57 * Math.cos(Math.PI * 2 * ph)) * Math.PI / 180;
      } else {                                           // idle：きょろきょろ・尾をぴくっと動かす
        const slot = Math.floor(t / 1.15 + sd * 5);
        p.yaw = (rnd(slot, sd) - 0.5) * 1.6;
        p.tilt = (rnd(slot + 3, sd) - 0.5) * 0.25;
        const ft = (t + sd * 3.1) % 2.3;
        p.tail = ft < 0.18 ? Math.sin(ft / 0.18 * Math.PI) * 0.25 : 0;
        p.lift = 0;
      }
      return p;
    }

    // 足（横向き）。x＝付け根の前後位置
    function legSide(ctx, x, mode, lw) {
      ctx.strokeStyle = PAL.leg; ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath();
      if (mode === "tuck") {                             // 跳んでいる間：たたむ
        ctx.moveTo(x, -16); ctx.lineTo(x - 4, -9); ctx.lineTo(x + 4, -7);
      } else if (mode === "bend") {                      // かがむ
        ctx.moveTo(x, -16); ctx.lineTo(x - 3, -7); ctx.lineTo(x + 1, 0);
        ctx.moveTo(x + 1, 0); ctx.lineTo(x + 8, 0); ctx.moveTo(x + 1, 0); ctx.lineTo(x - 5, 0.5);
      } else {
        ctx.moveTo(x, -16); ctx.lineTo(x - 1.5, -8); ctx.lineTo(x + 1, 0);
        ctx.moveTo(x + 1, 0); ctx.lineTo(x + 8, 0); ctx.moveTo(x + 1, 0); ctx.lineTo(x - 5, 0.5);
      }
      ctx.stroke();
    }

    // 羽を広げた形（飛ぶ時）。u＝付け根から先へ、v＝前へ（mm）
    function wingPath(ctx) {
      ctx.beginPath();
      ctx.moveTo(0, 9);
      ctx.bezierCurveTo(18, 13, 40, 12, 58, 3);          // 前のふち
      ctx.lineTo(68, -4);                                 // 羽の先
      ctx.lineTo(63, -10); ctx.lineTo(64, -12);           // 風切り羽のぎざぎざ
      ctx.lineTo(56, -16); ctx.lineTo(57, -18.5);
      ctx.lineTo(48, -21); ctx.lineTo(48.5, -23.5);
      ctx.lineTo(38, -25); ctx.lineTo(37, -27);
      ctx.bezierCurveTo(26, -28, 12, -27, 0, -20);       // 後ろのふち
      ctx.closePath();
    }
    // 広げた羽を1枚描く。root＝付け根（体の中の点）、side＝左 +1／右 −1
    function flapWing(ctx, view, root, side, theta, pitch, lw) {
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const S = { f: -Math.sin(theta) * sp, l: side * Math.cos(theta), z: Math.sin(theta) * cp };   // 羽の先へ向かう向き
      const F = { f: cp, l: 0, z: sp };                                                              // 前の向き
      const a = proj(view, S.f, S.l, S.z), c = proj(view, F.f, F.l, F.z);
      const o0 = proj(view, 0, 0, 0), r = proj(view, root.f, root.l, root.z);
      const ax = a.x - o0.x, ay = a.y - o0.y, cx = c.x - o0.x, cy = c.y - o0.y;
      // 表が見えているか：羽を水平に広げた時（表が上）と、今の向きの裏返りを比べる
      const a0 = proj(view, 0, side, 0);
      const det0 = (a0.x - o0.x) * cy - (a0.y - o0.y) * cx, det = ax * cy - ay * cx;
      const top = det * det0 > 0;
      ctx.save();
      ctx.transform(ax, ay, cx, cy, r.x, r.y);
      wingPath(ctx);
      ctx.restore();
      ctx.fillStyle = top ? PAL.prim : PAL.under; ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      if (top) {
        // 表の模様：付け根側の茶色・白い帯・風切り羽のふち
        ctx.save();
        ctx.transform(ax, ay, cx, cy, r.x, r.y);
        wingPath(ctx); ctx.clip();
        ctx.fillStyle = PAL.wing;
        ctx.beginPath(); ctx.moveTo(-2, 12); ctx.bezierCurveTo(20, 15, 34, 14, 42, 9); ctx.lineTo(30, -8); ctx.bezierCurveTo(20, -14, 8, -14, -2, -10); ctx.closePath(); ctx.fill();
        ctx.fillStyle = PAL.back;
        ctx.beginPath(); ctx.moveTo(-2, 12); ctx.bezierCurveTo(10, 14, 20, 14, 24, 11); ctx.lineTo(16, 0); ctx.lineTo(-2, 0); ctx.closePath(); ctx.fill();
        ctx.fillStyle = PAL.bar;
        ctx.beginPath(); ctx.moveTo(2, -1); ctx.bezierCurveTo(14, -3, 26, -5, 34, -9); ctx.lineTo(32, -12); ctx.bezierCurveTo(24, -9, 13, -6, 2, -4); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = PAL.edge; ctx.lineWidth = 1.6;
        ctx.beginPath();
        [[38, 6, 62, -8], [34, 2, 54, -15], [30, -1, 45, -20], [24, -14, 36, -24], [14, -15, 22, -26]].forEach(function (q) { ctx.moveTo(q[0], q[1]); ctx.lineTo(q[2], q[3]); });
        ctx.stroke();
        ctx.restore();
      }
    }

    // 頭（横向き）。中心 (hx, hy)、yaw＝こちらへ顔を向ける量（−1〜1）
    function headSide(ctx, hx, hy, p, lw) {
      const R = 13.5, yw = Math.max(-0.8, Math.min(0.8, p.yaw));
      ctx.save();
      ctx.translate(hx, hy); ctx.rotate(p.tilt);
      // くちばし（顔をこちらへ向けると短く見える）
      const bl = 12 * Math.cos(yw * 0.9), by = 2 + yw * 2;
      ctx.fillStyle = PAL.beak;
      ctx.beginPath(); ctx.moveTo(R - 2.5, by - 4.2); ctx.quadraticCurveTo(R - 1 + bl * 0.6, by - 3.5, R - 1 + bl, by + 0.3); ctx.lineTo(R - 2.5, by + 3.4); ctx.closePath(); ctx.fill();
      // 頭の丸
      ell(ctx, 0, 0, R, R * 0.95);
      ctx.fillStyle = PAL.cheek; ctx.fill();
      ctx.save(); ctx.clip();
      // 頭のてっぺんの栗色
      ctx.fillStyle = PAL.cap;
      ctx.beginPath(); ctx.moveTo(-R - 2, 3); ctx.bezierCurveTo(-6, -2, 4, -4, R + 2, -1); ctx.lineTo(R + 2, -R - 2); ctx.lineTo(-R - 2, -R - 2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = tone(PAL.cap, 0.18);
      ell(ctx, -1, -8.5, 7, 3.2, -0.15); ctx.fill();
      // 目から くちばしへの黒い線・のどの黒
      ctx.fillStyle = PAL.black;
      ctx.beginPath(); ctx.moveTo(3, -1.5); ctx.lineTo(R + 1, by - 3); ctx.lineTo(R + 1, by + 3); ctx.lineTo(6, 3); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(4, 6); ctx.quadraticCurveTo(9, 4, R + 1, by + 2); ctx.lineTo(R + 2, R + 2); ctx.lineTo(2, R + 2); ctx.closePath(); ctx.fill();
      // ほおの黒い点
      ell(ctx, -3 - yw * 2, 3.5, 3.6, 3.1); ctx.fill();
      // 陰（下と後ろを少し暗く）
      ctx.fillStyle = "rgba(60,40,20,0.12)";
      ell(ctx, -4, 9, 12, 6); ctx.fill();
      ctx.restore();
      ell(ctx, 0, 0, R, R * 0.95);
      ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      // 目
      const ex = 4.5 + yw * 1.5, ey = -1.5;
      if (p.blink) {
        ctx.strokeStyle = PAL.eye; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(ex - 2, ey); ctx.lineTo(ex + 2, ey); ctx.stroke();
      } else {
        ctx.fillStyle = PAL.eye; ell(ctx, ex, ey, 2.2, 2.3); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.9)"; ell(ctx, ex + 0.7, ey - 0.8, 0.7, 0.7); ctx.fill();
      }
      ctx.restore();
    }

    // 背中のまだら（体の形で切り抜いた中に描く）
    //   rot＝まだらの向き（横向きは体にそって横、後ろ・正面は縦）
    function streaks(ctx, sd, x0, x1, y0, y1, n, rot) {
      const r = rot === undefined ? -0.15 : rot, cr = Math.cos(r), sr = Math.sin(r);
      for (let i = 0; i < n; i++) {
        const x = x0 + (x1 - x0) * ((i + rnd(i, sd) * 0.6) / n);
        const y = y0 + (y1 - y0) * rnd(i + 9, sd);
        const rr = r + (rnd(i + 4, sd) - 0.5) * 0.3;
        ctx.fillStyle = PAL.streak;
        ell(ctx, x, y, 5.5, 1.6, rr); ctx.fill();
        ctx.fillStyle = "rgba(214,178,130,0.75)";
        ell(ctx, x - 2.2 * sr - 1.2 * cr, y + 2.2 * cr - 1.2 * sr, 4.2, 1, rr); ctx.fill();
      }
    }

    // 横向き（右向き）
    function drawSide(ctx, p, sd, lw) {
      ctx.translate(0, -p.lift);
      const shoulder = { f: 10, l: 0, z: 40 };
      if (p.fly) flapWing(ctx, "side", { f: shoulder.f, l: 6, z: shoulder.z }, 1, p.theta, p.pitch, lw);   // 向こう側の羽
      if (p.legs !== "fold") { legSide(ctx, -5, p.legs, lw); legSide(ctx, 3, p.legs, lw); }
      ctx.save();
      ctx.translate(0, -16); ctx.rotate(p.pitch); ctx.translate(0, 16);   // 腰を中心に体を前へ倒す
      // 尾
      ctx.save();
      ctx.translate(-28, -32); ctx.rotate(-0.1 - p.tail);
      ctx.beginPath(); ctx.moveTo(4, -7); ctx.lineTo(-38, -10); ctx.lineTo(-42, -8); ctx.lineTo(-40.5, -5.5); ctx.lineTo(-43, -2); ctx.lineTo(-38, -0.5); ctx.lineTo(2, 7); ctx.closePath();
      ctx.fillStyle = PAL.tail; ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      ctx.strokeStyle = tone(PAL.tail, 0.35); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-6, -2); ctx.lineTo(-40, -5); ctx.stroke();
      ctx.restore();
      // 胴
      const bodyPath = function () { ell(ctx, -3, -33, 31, 20.5, -0.2); };
      bodyPath(); ctx.fillStyle = PAL.belly; ctx.fill();
      ctx.save(); bodyPath(); ctx.clip();
      ctx.fillStyle = PAL.flank; ell(ctx, -10, -24, 26, 9, -0.2); ctx.fill();
      ctx.fillStyle = PAL.back;
      ctx.beginPath(); ctx.moveTo(-40, -30); ctx.bezierCurveTo(-20, -36, 0, -40, 26, -43); ctx.lineTo(26, -60); ctx.lineTo(-40, -60); ctx.closePath(); ctx.fill();
      streaks(ctx, sd, -30, 14, -48, -40, 6);
      ctx.fillStyle = "rgba(255,250,240,0.22)"; ell(ctx, 8, -38, 14, 7, -0.3); ctx.fill();      // 胸の明るさ
      ctx.fillStyle = "rgba(60,40,20,0.14)"; ell(ctx, -6, -16, 30, 8, -0.2); ctx.fill();         // 下の陰
      ctx.restore();
      bodyPath(); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      // たたんだ羽
      if (!p.fly) {
        const wingPathF = function () {
          ctx.beginPath(); ctx.moveTo(16, -44); ctx.bezierCurveTo(4, -48, -22, -44, -46, -36);
          ctx.quadraticCurveTo(-30, -27, -8, -27); ctx.bezierCurveTo(6, -28, 16, -34, 16, -44); ctx.closePath();
        };
        wingPathF(); ctx.fillStyle = PAL.wing; ctx.fill();
        ctx.save(); wingPathF(); ctx.clip();
        ctx.fillStyle = PAL.prim;                                     // 風切り羽（後ろの先）
        ctx.beginPath(); ctx.moveTo(-6, -40); ctx.lineTo(-50, -38); ctx.lineTo(-20, -24); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = PAL.edge; ctx.lineWidth = 1.3;
        ctx.beginPath();
        [[-8, -36, -42, -35], [-6, -32, -36, -31], [-4, -29, -26, -28]].forEach(function (q) { ctx.moveTo(q[0], q[1]); ctx.lineTo(q[2], q[3]); });
        ctx.stroke();
        for (let i = 0; i < 5; i++) {                                 // 雨おおいの黒い芯と明るいふち
          const x = 12 - i * 6, y = -41 + i * 0.5 + (i % 2) * 1.8;
          ctx.fillStyle = PAL.streak; ell(ctx, x, y, 2.8, 1.5, -0.2); ctx.fill();
          ctx.fillStyle = PAL.edge; ell(ctx, x - 1, y + 1.8, 2.6, 0.8, -0.2); ctx.fill();
        }
        ctx.fillStyle = PAL.bar;                                      // 白い帯
        ctx.beginPath(); ctx.moveTo(14, -37); ctx.quadraticCurveTo(0, -36, -14, -34); ctx.lineTo(-14, -32); ctx.quadraticCurveTo(0, -34, 14, -35); ctx.closePath(); ctx.fill();
        ctx.restore();
        wingPathF(); ctx.strokeStyle = OL; ctx.lineWidth = lw * 0.8; ctx.stroke();
      }
      // 頭（つつく時は首をのばす）
      const hx = 23 + p.neck * 0.6, hy = -50 + p.neck;
      if (p.neck > 1) {                                               // のびた首
        ctx.lineCap = "round";
        ctx.strokeStyle = PAL.belly; ctx.lineWidth = 20;
        ctx.beginPath(); ctx.moveTo(14, -36); ctx.lineTo(hx - 2, hy); ctx.stroke();
        ctx.strokeStyle = PAL.back; ctx.lineWidth = 9;
        ctx.beginPath(); ctx.moveTo(10, -45); ctx.lineTo(hx - 5, hy - 5); ctx.stroke();
        ctx.lineCap = "butt";
      }
      headSide(ctx, hx, hy, p, lw);
      ctx.restore();
      if (p.fly) flapWing(ctx, "side", { f: shoulder.f, l: -6, z: shoulder.z }, -1, p.theta, p.pitch, lw);  // 手前の羽
    }

    // 正面（こちらへ来る）
    function drawFront(ctx, p, sd, lw) {
      const k = p.dip;                                   // つつく深さ（0〜1）
      ctx.translate(0, -p.lift);
      if (p.fly) { flapWing(ctx, "front", { f: 6, l: 7, z: 40 }, 1, p.theta, p.pitch, lw); flapWing(ctx, "front", { f: 6, l: -7, z: 40 }, -1, p.theta, p.pitch, lw); }
      // 尾（体の向こう、上に少し見える）
      const tailY = -64 - 6 * k;
      ctx.fillStyle = PAL.tail;
      ctx.beginPath(); ctx.moveTo(-3, -50); ctx.quadraticCurveTo(-8, -57, -6, tailY); ctx.quadraticCurveTo(0, tailY - 4, 6, tailY); ctx.quadraticCurveTo(8, -57, 3, -50); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      // 足
      if (p.legs !== "fold" && p.legs !== "tuck") {
        ctx.strokeStyle = PAL.leg; ctx.lineWidth = 2.4; ctx.lineCap = "round";
        ctx.beginPath();
        [-5, 5].forEach(function (x) { ctx.moveTo(x, -14); ctx.lineTo(x * 1.1, 0); ctx.moveTo(x * 1.1, 0); ctx.lineTo(x * 1.1 - 2, 3); ctx.moveTo(x * 1.1, 0); ctx.lineTo(x * 1.1 + 2, 3); });
        ctx.stroke();
      }
      // 胴（上に背中の茶色、下に胸の灰色）
      const bodyPath = function () { ell(ctx, 0, -34, 20, 22); };
      bodyPath(); ctx.fillStyle = PAL.belly; ctx.fill();
      ctx.save(); bodyPath(); ctx.clip();
      ctx.fillStyle = PAL.back;
      ell(ctx, 0, -56 + 6 * k, 22, 14 + 8 * k); ctx.fill();
      streaks(ctx, sd, -12, 10, -54, -46 + 4 * k, 4, 1.45);
      ctx.fillStyle = PAL.wing;                                       // 両わきの羽
      ell(ctx, -19, -36, 6, 15, 0.15); ctx.fill(); ell(ctx, 19, -36, 6, 15, -0.15); ctx.fill();
      ctx.fillStyle = PAL.flank; ell(ctx, 0, -14, 18, 7); ctx.fill();
      ctx.fillStyle = "rgba(60,40,20,0.13)"; ell(ctx, 0, -12, 22, 6); ctx.fill();
      ctx.restore();
      bodyPath(); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      // 頭（体の手前。つつく時は下へ）
      const hy = -38 + 24 * k, R = 12.5;
      ctx.save();
      ctx.translate(Math.sin(p.yaw) * 2, hy); ctx.rotate(p.tilt);
      ell(ctx, 0, 0, R, R * 0.92); ctx.fillStyle = PAL.cheek; ctx.fill();
      ctx.save(); ctx.clip();
      const cy = -3 + 11 * k;                            // 頭のてっぺんの見える量（つつく時は頭の上がこちらを向く）
      ctx.fillStyle = PAL.cap;
      ctx.beginPath(); ctx.moveTo(-R - 1, cy); ctx.bezierCurveTo(-6, cy - 3, 6, cy - 3, R + 1, cy); ctx.lineTo(R + 1, -R - 1); ctx.lineTo(-R - 1, -R - 1); ctx.closePath(); ctx.fill();
      ctx.fillStyle = tone(PAL.cap, 0.18); ell(ctx, 0, -9 + 6 * k, 6, 2.6 + 2 * k); ctx.fill();
      ctx.save(); ctx.translate(0, 10 * k);
      ctx.fillStyle = PAL.black;
      ell(ctx, -10.8, 3, 2.4, 2.6); ctx.fill(); ell(ctx, 10.8, 3, 2.4, 2.6); ctx.fill();      // ほおの黒い点（両わき）
      ctx.beginPath(); ctx.moveTo(-3, 3.5); ctx.quadraticCurveTo(0, 2.5, 3, 3.5); ctx.lineTo(2.2, 9.5); ctx.quadraticCurveTo(0, 10.5, -2.2, 9.5); ctx.closePath(); ctx.fill();   // のどの黒
      ctx.restore();
      ctx.restore();
      ell(ctx, 0, 0, R, R * 0.92); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      // 目とくちばし（つつく時は下へずれて、目は頭のかげになる）
      ctx.translate(0, 9 * k);
      if (k > 0.5) { /* 目は見えない */ } else if (p.blink) {
        ctx.strokeStyle = PAL.eye; ctx.lineWidth = 1.2; ctx.beginPath();
        ctx.moveTo(-8.5, -2); ctx.lineTo(-5.5, -2); ctx.moveTo(5.5, -2); ctx.lineTo(8.5, -2); ctx.stroke();
      } else {
        ctx.fillStyle = PAL.eye; ell(ctx, -7, -2.2, 1.6, 1.9); ctx.fill(); ell(ctx, 7, -2.2, 1.6, 1.9); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.9)"; ell(ctx, -6.5, -2.9, 0.5, 0.5); ctx.fill(); ell(ctx, 7.5, -2.9, 0.5, 0.5); ctx.fill();
      }
      ctx.fillStyle = PAL.beak;
      ctx.beginPath(); ctx.moveTo(-3.2, -0.5); ctx.lineTo(3.2, -0.5); ctx.lineTo(0, 6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.35)"; ell(ctx, -0.8, 0.8, 0.8, 1.6); ctx.fill();
      ctx.restore();
    }

    // 後ろ（向こうへ行く）
    function drawBack(ctx, p, sd, lw) {
      const k = p.dip;
      ctx.translate(0, -p.lift);
      // 足（体のかげ。左右の外に少しだけ見える）
      if (p.legs !== "fold" && p.legs !== "tuck") {
        ctx.strokeStyle = PAL.leg; ctx.lineWidth = 2.4; ctx.lineCap = "round";
        ctx.beginPath(); [-6, 6].forEach(function (x) { ctx.moveTo(x, -12); ctx.lineTo(x * 1.1, -1); }); ctx.stroke();
      }
      // 頭（体の向こう。つつく時は体のかげにかくれる）
      const R = 12.5, hy = -60 + 22 * k;
      ctx.save();
      ctx.translate(Math.sin(p.yaw) * 2.5, hy); ctx.rotate(p.tilt);
      ell(ctx, 0, 0, R, R * 0.92); ctx.fillStyle = PAL.cheek; ctx.fill();
      ctx.save(); ctx.clip();
      ctx.fillStyle = PAL.cap;
      ctx.beginPath(); ctx.moveTo(-6.5, R + 2); ctx.bezierCurveTo(-7, 4, -9, -1, -R - 1, -3); ctx.lineTo(-R - 1, -R - 1); ctx.lineTo(R + 1, -R - 1); ctx.lineTo(R + 1, -3); ctx.bezierCurveTo(9, -1, 7, 4, 6.5, R + 2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = tone(PAL.cap, 0.15); ell(ctx, 0, -4, 5, 5); ctx.fill();
      ctx.fillStyle = "rgba(60,40,20,0.15)"; ell(ctx, 0, 9, 10, 4); ctx.fill();
      ctx.restore();
      ell(ctx, 0, 0, R, R * 0.92); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      ctx.restore();
      // 胴（背中のまだら）
      const bodyPath = function () { ell(ctx, 0, -31, 20, 21); };
      bodyPath(); ctx.fillStyle = PAL.back; ctx.fill();
      ctx.save(); bodyPath(); ctx.clip();
      ctx.fillStyle = tone(PAL.back, 0.12); ell(ctx, 0, -44, 12, 7); ctx.fill();         // 首のうしろの明るさ
      streaks(ctx, sd + 0.37, -12, 9, -46, -26, 7, 1.45);
      ctx.restore();
      bodyPath(); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      if (p.fly) { flapWing(ctx, "back", { f: 6, l: 7, z: 40 }, 1, p.theta, p.pitch, lw); flapWing(ctx, "back", { f: 6, l: -7, z: 40 }, -1, p.theta, p.pitch, lw); }
      else {
        // たたんだ羽（左右）
        [-1, 1].forEach(function (sx) {
          ctx.save(); ctx.scale(sx, 1);
          ctx.beginPath(); ctx.moveTo(8, -46); ctx.bezierCurveTo(20, -44, 22, -30, 16, -12); ctx.quadraticCurveTo(9, -22, 7, -34); ctx.closePath();
          ctx.fillStyle = PAL.wing; ctx.fill();
          ctx.strokeStyle = OL; ctx.lineWidth = lw * 0.8; ctx.stroke();
          ctx.fillStyle = PAL.prim; ctx.beginPath(); ctx.moveTo(12, -28); ctx.lineTo(17, -26); ctx.lineTo(15, -12); ctx.closePath(); ctx.fill();
          ctx.restore();
        });
      }
      // 尾（こちらへのびる）
      const tipY = 1 - 20 * k;
      ctx.beginPath(); ctx.moveTo(-5, -17); ctx.lineTo(-10, tipY); ctx.quadraticCurveTo(0, tipY + 3, 10, tipY); ctx.lineTo(5, -17); ctx.closePath();
      ctx.fillStyle = PAL.tail; ctx.fill();
      ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      ctx.strokeStyle = tone(PAL.tail, 0.3); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(0, tipY + 1); ctx.stroke();
    }

    return {
      size: { w: 10, h: 5.5 },
      states: ["idle", "walk", "peck", "hop", "fly"],
      draw: function (ctx, s) {
        const p = poseOf(s), sd = s.seed || 0;
        ctx.save();
        ctx.scale(MM, MM);
        const lw = lineMM(ctx);
        if (s.view === "front") drawFront(ctx, p, sd, lw);
        else if (s.view === "back") drawBack(ctx, p, sd, lw);
        else drawSide(ctx, p, sd, lw);
        ctx.restore();
      }
    };
  })();

  // ------------------------------------------------------------
  // 動物の絵：ちょうちょ（butterfly）  variant＝"monshiro"（モンシロチョウ）｜"ageha"（アゲハ）
  //   羽は「付け根から先へ u・前へ v（mm）」の平らな形で描き、羽ばたきの角度で立体に回して画面に写す。
  //   本物の2倍の大きさ（スズメと同じ物差し）。原点＝体の下（止まっている所）。飛ぶ高さは仕組みの側。
  // ------------------------------------------------------------
  ANIMAL_ART.butterfly = (function () {
    const MM = 2 * 45 * 1.4 / 1600;           // 1mm＝何px（2倍の大きさ）
    const OL = "rgba(40,30,20,0.55)";

    function lineMM(ctx) {
      let sc = MM;
      if (ctx.getTransform) { const m = ctx.getTransform(); sc = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || MM; }
      return Math.max(0.5, Math.min(1.6, 0.7 / sc));
    }
    // ちょうちょは羽が見えるように、本物の斜め見下ろしより少し上から見た形で描く（奥行き 0.7・高さ 0.75）
    function proj(view, f, l, z) {
      if (view === "front") return { x: l, y: -z * 0.75 + f * 0.7 };
      if (view === "back") return { x: -l, y: -z * 0.75 - f * 0.7 };
      return { x: f, y: -z * 0.75 - l * 0.7 };
    }
    function ell(ctx, x, y, rx, ry, rot) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot || 0, 0, Math.PI * 2); }
    function poly(ctx, pts) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); }
    // 点の並びを、なめらかな曲線でつなぐ（角を丸める）
    function smooth(ctx, pts) {
      const n = pts.length;
      ctx.beginPath();
      const mid = function (a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
      let m = mid(pts[n - 1], pts[0]);
      ctx.moveTo(m[0], m[1]);
      for (let i = 0; i < n; i++) { const q = mid(pts[i], pts[(i + 1) % n]); ctx.quadraticCurveTo(pts[i][0], pts[i][1], q[0], q[1]); }
      ctx.closePath();
    }

    // ----- モンシロチョウ -----
    const MON = {
      body: 20, bodyW: 2.2, bodyCol: "#3a3836", hair: "rgba(240,240,232,0.75)",
      fore: [[0, 1.5], [9, 4.2], [20, 4.6], [26.5, 2], [27, -1], [25, -6], [21, -11], [17, -13.5], [9, -11], [2, -5]],
      hind: [[0, -3], [9, -4.2], [17, -7], [20.5, -12], [18.5, -18], [12, -22], [5, -19.5], [1, -11]],
      paint: function (ctx, wing, top, sd) {
        if (wing === "fore") {
          ctx.fillStyle = top ? "#f8f7f0" : "#f6f3dc"; ctx.fillRect(-2, -20, 34, 30);
          ctx.fillStyle = top ? "rgba(120,125,120,0.35)" : "rgba(170,170,120,0.25)"; ell(ctx, 1, -2, 7, 6); ctx.fill();   // 付け根の灰色
          ctx.fillStyle = top ? "#3e3c3a" : "rgba(230,214,120,0.85)";                      // 前羽の先（表＝黒、裏＝黄色っぽい）
          smooth(ctx, [[17, 5.5], [28, 3], [28, -3], [25.5, -4.5], [23.5, -1], [20, 2.5]]); ctx.fill();
          ctx.fillStyle = top ? "#3e3c3a" : "rgba(80,78,74,0.55)";                         // 黒い点
          ell(ctx, 16.5, -5.5, 2.1, 2.3); ctx.fill();
          if (sd > 0.45) { ell(ctx, 13.5, -10.2, 1.6, 1.7); ctx.fill(); }               // めすは点が2つ
        } else {
          ctx.fillStyle = top ? "#f7f6ee" : "#f1ecc8"; ctx.fillRect(-2, -26, 26, 26);
          ctx.fillStyle = top ? "rgba(120,125,120,0.30)" : "rgba(170,160,90,0.25)"; ell(ctx, 1, -6, 6, 6); ctx.fill();
          if (top) { ctx.fillStyle = "#4a4846"; ell(ctx, 11.5, -5, 1.3, 1.1); ctx.fill(); }  // 後ろ羽の前のふちの小さな点
        }
      }
    };

    // ----- アゲハ（ナミアゲハ） -----
    const AGE = {
      body: 30, bodyW: 3.2, bodyCol: "#26221c", hair: "rgba(240,210,90,0.85)",
      fore: [[0, 2], [12, 6.5], [30, 8], [44, 6], [48.5, 2.5], [47, -4], [42, -13], [35, -20], [24, -18], [10, -12], [2, -6]],
      hind: [[0, -4], [14, -6], [27, -11], [34, -19], [34, -27], [31, -31], [31.5, -40], [29.5, -45], [27, -44], [26.5, -34], [19, -35], [10, -32], [5, -27], [3, -18], [0, -10]],
      paint: function (ctx, wing, top, sd) {
        const Y = top ? "#f6dc6c" : "#f4e6a6", K = top ? "#26221c" : "#4a4232";
        if (wing === "fore") {
          ctx.fillStyle = Y; ctx.fillRect(-2, -24, 54, 36);
          ctx.fillStyle = K;
          poly(ctx, [[-2, 4], [14, 9], [12, -16], [-2, -9]]); ctx.fill();                 // 付け根の黒
          ctx.strokeStyle = Y; ctx.lineWidth = 1.1; ctx.beginPath();                      // 付け根の黄色い筋
          [[1, 1, 12, 4], [1, -2, 12, 0.5], [1, -5, 12, -3], [1, -8, 12, -7]].forEach(function (q) { ctx.moveTo(q[0], q[1]); ctx.lineTo(q[2], q[3]); });
          ctx.stroke();
          ctx.fillStyle = K;
          [[17, 3.5], [23, 3.2], [29, 2.8]].forEach(function (c) { poly(ctx, [[c[0] - 2, 9], [c[0] + 2, 9], [c[0] + 1.5, c[1] - 3], [c[0] - 1.5, c[1] - 3]]); ctx.fill(); });   // 前のふちの黒い帯
          // 外のふちの太い黒い帯
          poly(ctx, [[33, 9], [52, 4], [50, -5], [44, -16], [37, -23], [29, -20], [33, -12], [37, -4], [34, 4]]); ctx.fill();
          ctx.fillStyle = Y;                                                               // 帯の中の黄色い点
          [[45, 1, 1.5], [44, -4, 1.4], [42, -9, 1.4], [39, -14, 1.3], [35, -18, 1.2]].forEach(function (c) { ell(ctx, c[0], c[1], c[2] * 1.2, c[2]); ctx.fill(); });
          ctx.strokeStyle = K; ctx.lineWidth = 0.8; ctx.beginPath();                      // 翅脈
          [[10, -6, 34, -14], [10, -4, 37, -6], [12, -1, 38, 1]].forEach(function (q) { ctx.moveTo(q[0], q[1]); ctx.lineTo(q[2], q[3]); });
          ctx.stroke();
        } else {
          ctx.fillStyle = Y; ctx.fillRect(-2, -48, 40, 48);
          ctx.fillStyle = K;
          poly(ctx, [[-2, -2], [6, -5], [8, -14], [4, -24], [-2, -20]]); ctx.fill();       // 付け根の黒
          // ふちの黒い帯と尾
          poly(ctx, [[18, -8], [30, -10], [37, -20], [36, -30], [33, -34], [33, -48], [25, -48], [25, -36], [12, -36], [4, -30], [8, -26], [16, -29], [24, -28], [28, -21], [24, -14]]); ctx.fill();
          ctx.fillStyle = top ? "#5b88cc" : "#7a96bc";                                     // 青い点
          [[27, -26], [22, -30], [16, -31.5], [30, -19]].forEach(function (c) { ell(ctx, c[0], c[1], 1.6, 1.3); ctx.fill(); });
          ctx.fillStyle = Y;                                                               // ふちの黄色い三日月
          [[33, -16], [34, -25], [21, -34.5], [14, -34]].forEach(function (c) { ell(ctx, c[0], c[1], 1.4, 1); ctx.fill(); });
          ctx.fillStyle = "#e8803a";                                                       // だいだいの目玉もよう
          ell(ctx, 8, -30, 2.6, 2.3); ctx.fill();
          ctx.fillStyle = K; ell(ctx, 8.4, -30.4, 1, 0.9); ctx.fill();
        }
      }
    };

    // 羽を1枚描く
    function wing(ctx, view, V, which, root, side, theta, pitch, sweep, lw, sd) {
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      // 羽の先の向き（sweep＝前へ少し振る）と、前の向き
      const cs = Math.cos(sweep), ss = Math.sin(sweep);
      const S0 = { f: ss, l: side * cs * Math.cos(theta), z: cs * Math.sin(theta) };
      const S = { f: S0.f * cp - S0.z * sp, l: S0.l, z: S0.f * sp + S0.z * cp };
      const F0 = { f: cs, l: -side * ss * Math.cos(theta), z: -ss * Math.sin(theta) };
      const F = { f: F0.f * cp - F0.z * sp, l: F0.l, z: F0.f * sp + F0.z * cp };
      const o = proj(view, 0, 0, 0), a = proj(view, S.f, S.l, S.z), c = proj(view, F.f, F.l, F.z), r = proj(view, root.f, root.l, root.z);
      const ax = a.x - o.x, ay = a.y - o.y, cx = c.x - o.x, cy = c.y - o.y;
      const a0 = proj(view, 0, side, 0), c0 = proj(view, 1, 0, 0);
      const det0 = (a0.x - o.x) * (c0.y - o.y) - (a0.y - o.y) * (c0.x - o.x), det = ax * cy - ay * cx;
      const top = det * det0 > 0;                       // 表が見えているか
      const shape = which === "fore" ? V.fore : V.hind;
      ctx.save();
      ctx.transform(ax, ay, cx, cy, r.x, r.y);
      smooth(ctx, shape);
      ctx.save(); ctx.clip();
      V.paint(ctx, which, top, sd);
      ctx.restore();
      smooth(ctx, shape);
      ctx.restore();
      ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
    }

    // 体（頭・胸・腹）と触角
    function body(ctx, view, V, pitch, lw) {
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const P = function (f, z) { return proj(view, f * cp - z * sp, 0, f * sp + z * cp); };
      const L = V.body, head = P(L * 0.28, 0), tail = P(-L * 0.72, 0);
      ctx.lineCap = "round";
      ctx.strokeStyle = OL; ctx.lineWidth = V.bodyW * 2 + lw * 2;
      ctx.beginPath(); ctx.moveTo(head.x, head.y); ctx.lineTo(tail.x, tail.y); ctx.stroke();
      ctx.strokeStyle = V.bodyCol; ctx.lineWidth = V.bodyW * 2;
      ctx.beginPath(); ctx.moveTo(head.x, head.y); ctx.lineTo(tail.x, tail.y); ctx.stroke();
      ctx.strokeStyle = V.hair; ctx.lineWidth = V.bodyW * 0.7;                // 体の毛・アゲハの黄色い筋
      const m = P(-L * 0.1, V.bodyW * 0.4), n = P(-L * 0.62, V.bodyW * 0.4);
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(n.x, n.y); ctx.stroke();
      // 触角（先がふくらむ）
      ctx.strokeStyle = V.bodyCol; ctx.lineWidth = Math.max(0.6, lw * 0.9);
      [1, -1].forEach(function (sx) {
        const b = proj(view, (L * 0.3) * cp, 0, (L * 0.3) * sp);
        const e = proj(view, (L * 0.3 + L * 0.5) * cp - L * 0.35 * sp, sx * L * 0.22, (L * 0.3 + L * 0.5) * sp + L * 0.35 * cp);
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(e.x, e.y); ctx.stroke();
        ctx.fillStyle = V.bodyCol; ell(ctx, e.x, e.y, V.bodyW * 0.45, V.bodyW * 0.45); ctx.fill();
      });
      ctx.lineCap = "butt";
    }

    // 状態から羽の角度と体の傾きを決める
    function poseOf(s) {
      const ph = s.phase || 0, t = s.t || 0, sd = s.seed || 0;
      if (s.state === "idle") {                          // とまって、羽を立てて閉じ、ときどきゆっくり開く
        const o = Math.max(0, Math.sin(t * 0.9 + sd * 6.28));
        return { theta: (78 - 56 * o * o * o) * Math.PI / 180, lag: 0, pitch: 0.05, sweep: 0.05 };
      }
      // flutter（walk も同じ）：羽を大きく打ち下ろす。前羽が先に動き、後ろ羽が少し遅れる
      const c = Math.cos(Math.PI * 2 * ph);
      return { theta: (30 + 56 * c) * Math.PI / 180, lag: 0.12, pitch: 0.35 - 0.12 * c, sweep: 0.12 + 0.08 * c };
    }

    return {
      size: { w: 8, h: 4.5 },
      states: ["idle", "walk", "flutter"],
      draw: function (ctx, s) {
        const V = s.variant === "ageha" ? AGE : MON, view = s.view || "side", sd = s.seed || 0;
        const p = poseOf(s);
        const thH = p.theta + p.lag * (s.state === "idle" ? 0 : -Math.sin(Math.PI * 2 * (s.phase || 0)));   // 後ろ羽の角度
        ctx.save();
        ctx.scale(MM, MM);
        const lw = lineMM(ctx);
        const zb = V.bodyW + 1;                                       // 体の中心の高さ（原点＝とまっている所）
        ctx.translate(0, -zb);
        const rootF = { f: 1, l: V.bodyW * 0.4 }, rootH = { f: -2, l: V.bodyW * 0.4 };
        const drawSide = function (side) {
          wing(ctx, view, V, "hind", { f: rootH.f, l: side * rootH.l, z: 0 }, side, thH, p.pitch, -p.sweep * 0.5, lw, sd);
          wing(ctx, view, V, "fore", { f: rootF.f, l: side * rootF.l, z: 0 }, side, p.theta, p.pitch, p.sweep, lw, sd);
        };
        if (view === "side") {                        // 向こう側の羽→体→手前の羽
          drawSide(1); body(ctx, view, V, p.pitch, lw); drawSide(-1);
        } else if (view === "front") {
          drawSide(1); drawSide(-1); body(ctx, view, V, p.pitch, lw);
        } else {
          body(ctx, view, V, p.pitch, lw); drawSide(1); drawSide(-1);
        }
        ctx.restore();
      }
    };
  })();

  // ------------------------------------------------------------
  // 動物の絵：柴犬（shiba）と猫（cat）
  //   形は「絵の決まり」どおり：原点＝足元の中心（地面に触れる所）、上が −y、右向きの横向きが基本。
  //   物差しは 1マス＝45px（ART_PX）。影・左向きの反転・高さのずらしは仕組みの側で行う。
  //   足の曲げ方・線の太さ・まばたきなどの部品を2種で共有するため、ひとつの囲みの中で2つを代入する
  //   （外に新しい名前は作らない）。
  // ------------------------------------------------------------
  (function () {
    const OL = "rgba(40,30,20,0.55)";          // 輪郭の色（COLORS.outline と同じ）
    const OL_SOFT = "rgba(40,30,20,0.22)";     // 体の中の筋（もも・肩の盛り上がり）の薄い線
    const TAU = Math.PI * 2;

    // 色を明るく（amt が＋）／暗く（amt が－）する。色は #rrggbb
    function shade(hex, amt) {
      const n = parseInt(hex.slice(1), 16);
      const to = amt < 0 ? 0 : 255;
      const k = Math.abs(amt);
      const f = function (v) { return Math.round(v + (to - v) * k); };
      return "rgb(" + f((n >> 16) & 255) + "," + f((n >> 8) & 255) + "," + f(n & 255) + ")";
    }

    // 輪郭の太さ：画面で約1px（大きく拡大しているときだけ少し太く）
    function lineW(ctx) {
      const m = ctx.getTransform();
      const sc = Math.max(0.01, Math.hypot(m.a, m.b));
      return (sc <= 1 ? 0.9 : 0.9 * Math.sqrt(sc)) / sc;
    }

    // 点の並びを通る、なめらかな線（閉じる／閉じない）
    function smooth(ctx, pts, closed) {
      const n = pts.length;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      const last = closed ? n : n - 1;
      for (let i = 0; i < last; i++) {
        const p1 = pts[i], p2 = pts[(i + 1) % n];
        const p0 = closed || i > 0 ? pts[(i - 1 + n) % n] : p1;
        const p3 = closed || i + 2 < n ? pts[(i + 2) % n] : p2;
        ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
          p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
      }
      if (closed) ctx.closePath();
    }

    // 形を塗って輪郭を描く（line が null なら輪郭なし）
    function shape(ctx, pts, fill, lw, line) {
      smooth(ctx, pts, true);
      ctx.fillStyle = fill; ctx.fill();
      if (line !== null) { ctx.strokeStyle = line || OL; ctx.lineWidth = lw; ctx.stroke(); }
    }

    // だ円を塗って輪郭を描く
    function oval(ctx, x, y, rx, ry, rot, fill, lw, line) {
      ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, TAU);
      ctx.fillStyle = fill; ctx.fill();
      if (line !== null) { ctx.strokeStyle = line || OL; ctx.lineWidth = lw; ctx.stroke(); }
    }

    // 形の中だけに模様を描く（clip）。paint(ctx) の中で塗る
    function inside(ctx, pts, paint) {
      ctx.save(); smooth(ctx, pts, true); ctx.clip(); paint(ctx); ctx.restore();
    }

    // 太さが変わる線（足・しっぽ）を、ひとつの形として塗る。ws＝点ごとの太さ
    function limb(ctx, pts, ws, fill, lw, line) {
      const L = [], R = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)];
        let tx = q[0] - o[0], ty = q[1] - o[1];
        const len = Math.hypot(tx, ty) || 1;
        tx /= len; ty /= len;
        const w = ws[i] / 2;
        L.push([p[0] - ty * w, p[1] + tx * w]);
        R.push([p[0] + ty * w, p[1] - tx * w]);
      }
      shape(ctx, L.concat(R.reverse()), fill, lw, line);
    }

    // 2つの骨の関節の位置（a から b へ、長さ l1・l2）。bend＝+1 で関節が前（＋x）へ出る
    function ik(a, b, l1, l2, bend) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const d = Math.min(Math.max(Math.hypot(dx, dy), Math.abs(l1 - l2) + 0.01), l1 + l2 - 0.01);
      const ang = Math.atan2(dy, dx) - bend * Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
      return [a[0] + Math.cos(ang) * l1, a[1] + Math.sin(ang) * l1];
    }

    // 足の運び。p＝周期の中の位置、swing＝足を上げている割合、stride＝前後のふり幅
    //   x＝休みの位置からの前後のずれ、lift＝上げている高さの割合（0〜1）
    function gait(p, swing, stride) {
      p = ((p % 1) + 1) % 1;
      if (p < swing) {
        const u = p / swing;
        return { x: -stride + 2 * stride * u * u * (3 - 2 * u), lift: Math.sin(Math.PI * u) };
      }
      const u = (p - swing) / (1 - swing);
      return { x: stride - 2 * stride * u, lift: 0 };
    }

    // まばたき（個体ごとにずらす）
    function blinking(s) { return ((s.t + s.seed * 7.3) % 3.9) < 0.13; }

    // 0〜1 の決まった乱数（個体の seed から、模様の位置などを作る）
    function rnd(seed, k) {
      const v = Math.sin((seed * 917.13 + k * 71.7) * 12.9898) * 43758.5453;
      return v - Math.floor(v);
    }

    // s の足りない値を補う（phase・t・seed が無くても描けるように）
    function norm(s) {
      return { state: s.state || "idle", phase: s.phase || 0, t: s.t || 0, view: s.view || "side", seed: s.seed || 0, variant: s.variant };
    }

    // 体の向きの変換（傾き rot を pivot のまわりにかけ、(bx,by) ずらす）
    function frame(rot, pivot, bx, by) {
      const c = Math.cos(rot), s = Math.sin(rot);
      return {
        rot: rot,
        pt: function (p) {
          const x = p[0] - pivot[0], y = p[1] - pivot[1];
          return [c * x - s * y + pivot[0] + bx, s * x + c * y + pivot[1] + by];
        },
        apply: function (ctx) {
          ctx.translate(pivot[0] + bx, pivot[1] + by); ctx.rotate(rot); ctx.translate(-pivot[0], -pivot[1]);
        }
      };
    }

    // ------------------------------------------------------------
    // 横向きの4本足の動物（犬・猫で共通の組み立て）
    //   Q＝種類ごとの寸法と描き方、s＝絵の決まりの s
    // ------------------------------------------------------------
    function sidePose(Q, s) {
      const st = s.state, ph = s.phase || 0, t = s.t || 0;
      const P = { rot: 0, bx: 0, by: 0, legs: null, headTilt: 0, headDy: 0, sit: false, earBack: 0, mouth: 0 };
      let g = null;
      if (st === "walk") g = Q.walk;
      if (st === "run") g = Q.run;
      if (g) {
        // 足の順番：歩く＝左後→左前→右後→右前（横から見た4拍子）。走る＝後ろ2本→前2本（ギャロップ）
        const off = st === "run" ? { nH: 0, fH: 0.1, nF: 0.48, fF: 0.6 } : { nH: 0, nF: 0.25, fH: 0.5, fF: 0.75 };
        P.legs = {};
        Object.keys(off).forEach(function (k) { P.legs[k] = gait(ph + off[k], g.swing, g.stride); });
        if (st === "run") {
          P.rot = Math.sin(ph * TAU) * g.pitch;                       // 走るときは体が前後にゆれる
          P.by = -Math.abs(Math.sin(ph * TAU + 0.6)) * g.bob;
          P.headDy = Math.sin(ph * TAU + 1.2) * 0.4;
          P.earBack = Q.runEarBack;
          P.mouth = Q.runMouth;
        } else {
          P.by = -Math.abs(Math.sin(ph * TAU * 2)) * g.bob;            // 歩くときは1歩ごとに少し上下
          P.headDy = Math.sin(ph * TAU * 2 + 0.8) * g.bob * 0.6;
        }
      } else {
        P.legs = { nH: { x: 0, lift: 0 }, fH: { x: 0.25, lift: 0 }, nF: { x: 0, lift: 0 }, fF: { x: -0.25, lift: 0 } };
        P.by = Math.sin(t * 1.7 + s.seed * 5) * 0.12;                 // 息で少し上下
      }
      if (st === "sit" || st === "groom") {
        P.sit = true;
        P.rot = -Q.sitRot;
      }
      return P;
    }

    // 横向きの4本足を描く。parts＝種類ごとの描き方（body / head / tail / pattern など）
    function drawSide(ctx, Q, s, parts) {
      const lw = lineW(ctx);
      const P = sidePose(Q, s);
      const F = P.sit ? frame(P.rot, Q.sitPivot, Q.sitShift[0], Q.sitShift[1]) : frame(P.rot, Q.center, 0, P.by);

      // 足のふりの角度（体の中の見えない支点 pv から見た、足先の向きの、休みの位置からのずれ。前へ出ると＋）
      const swingAng = function (pv, paw, rest) {
        return Math.atan2(paw[0] - pv[0], paw[1] - pv[1]) - Math.atan2(rest[0] - pv[0], rest[1] - pv[1]);
      };
      // 支点 pv から v だけ離れた点を、ふりの角度 th だけ回した位置
      const swingPt = function (pv, v, th) {
        const c = Math.cos(th), n = Math.sin(th);
        return [pv[0] + v[0] * c + v[1] * n, pv[1] - v[0] * n + v[1] * c];
      };
      // 1本の足を組み立てる（体の上の付け根 → 地面の足先）
      // 確かめ後の手直し：Q.swingU があるときは、足の付け根とひじ（後ろ足は、かかとの向き）も、体の中の見えない支点
      // （付け根の swingU px 上。前＝肩、後ろ＝腰）のまわりに足のふりに合わせて回す（本物のように足全体が前後にふれ、大きな歩幅でも足が伸びきらない）
      const frontLeg = function (lg, far) {
        let top = F.pt(far ? [Q.frontTop[0] - 0.6, Q.frontTop[1] + 0.3] : Q.frontTop);
        let elbow = [top[0] + Q.elbow[0], top[1] + Q.elbow[1]];
        const lift = lg.lift * Q.liftF;
        const paw = [Q.frontX + lg.x + (far ? 0.5 : 0) - lg.lift * 0.6, (far ? -Q.farUp : 0) - lift];
        if (Q.swingU) {
          const pv = [top[0], top[1] - Q.swingU[0]];
          const th = swingAng(pv, paw, [Q.frontX + (far ? 0.5 : 0), far ? -Q.farUp : 0]);
          top = swingPt(pv, [0, Q.swingU[0]], th);
          elbow = swingPt(pv, [Q.elbow[0], Q.swingU[0] + Q.elbow[1]], th);
        }
        const wrist = ik(elbow, paw, Q.fl1, Q.fl2, 1);
        return [top, elbow, wrist, paw];
      };
      const hindLeg = function (lg, far) {
        let top = F.pt(far ? [Q.hindTop[0] + 0.5, Q.hindTop[1] + 0.3] : Q.hindTop);
        const lift = lg.lift * Q.liftH;
        const paw = [Q.hindX + lg.x + (far ? 0.5 : 0), (far ? -Q.farUp : 0) - lift];
        let meta = Q.meta;
        if (Q.swingU) {
          const pv = [top[0], top[1] - Q.swingU[1]];
          const th = swingAng(pv, paw, [Q.hindX + (far ? 0.5 : 0), far ? -Q.farUp : 0]);
          top = swingPt(pv, [0, Q.swingU[1]], th);
          meta = swingPt([0, 0], Q.meta, th);
        }
        const hock = [paw[0] + meta[0] + lg.lift * 0.9, paw[1] + meta[1] + lg.lift * 0.4];
        const stifle = ik(top, hock, Q.hl1, Q.hl2, 1);
        return [top, stifle, hock, paw];
      };
      const paintLeg = function (pts, far, hind) {
        const col = far ? Q.c.farFur : Q.c.legFur;
        limb(ctx, pts, hind ? Q.hindW : Q.frontW, col, lw);
        if (parts.leg) parts.leg(ctx, pts, far, hind, lw, s);
        const p = pts[pts.length - 1];
        oval(ctx, p[0] + 0.35, p[1] - Q.pawR * 0.5, Q.pawR * 1.25, Q.pawR * 0.62, 0, far ? Q.c.farPaw : Q.c.paw, lw);
      };

      if (!P.sit) {
        // 立っている・歩く・走る
        const L = P.legs;
        if (parts.tailBehind) parts.tail(ctx, s, F, P, lw);
        paintLeg(hindLeg(L.fH, true), true, true);
        paintLeg(frontLeg(L.fF, true), true, false);
        const nh = hindLeg(L.nH, false), nf = frontLeg(L.nF, false);
        paintLeg(nh, false, true);
        paintLeg(nf, false, false);
        ctx.save(); F.apply(ctx);
        parts.body(ctx, s, P, lw);
        // もも・肩の盛り上がり（薄い筋だけ。足の振りに合わせて少し回す）
        const ha = Math.atan2(nh[1][1] - nh[0][1], nh[1][0] - nh[0][0]) - Q.thighRest - F.rot;
        ctx.strokeStyle = OL_SOFT; ctx.lineWidth = lw;
        ctx.beginPath(); ctx.ellipse(Q.thigh[0], Q.thigh[1], Q.thigh[2], Q.thigh[3], Q.thigh[4] + ha * 0.6, -1.25, 1.2); ctx.stroke();
        const fa = Math.atan2(nf[2][1] - nf[1][1], nf[2][0] - nf[1][0]) - Math.PI / 2 - F.rot;
        ctx.beginPath(); ctx.ellipse(Q.shoulder[0], Q.shoulder[1], Q.shoulder[2], Q.shoulder[3], Q.shoulder[4] + fa * 0.5, 2.4, 3.6); ctx.stroke();
        ctx.restore();
      } else {
        // 座る（体を後ろへ傾けて、おしりを地面に下ろす）
        if (parts.tailBehind) parts.tail(ctx, s, F, P, lw);
        const fl = function (far) {
          const top = F.pt(far ? [Q.frontTop[0] - 0.6, Q.frontTop[1] + 0.3] : Q.frontTop);
          const paw = [top[0] + Q.sitFrontX + (far ? 0.6 : 0), far ? -Q.farUp : 0];   // 前足はほぼまっすぐ下へ
          const mid = ik(top, paw, Q.fl1 + 2.2, Q.fl2 + 1.4, 1);
          return [top, mid, [paw[0] - 0.2, paw[1] - Q.pawR * 1.4], paw];
        };
        // 奥の後ろ足の先
        oval(ctx, Q.sitHindPaw[0] + 0.8, Q.sitHindPaw[1] - Q.farUp - Q.pawR * 0.5, Q.pawR * 1.5, Q.pawR * 0.62, 0, Q.c.farPaw, lw);
        paintLeg(fl(true), true, false);
        let groomPaw = null;
        if (s.state === "groom" && parts.groomPaw) groomPaw = parts.groomPaw(s, F);
        ctx.save(); F.apply(ctx);
        parts.body(ctx, s, P, lw);
        ctx.restore();
        // 手前の後ろ足（たたんだもも＋地面に寝た足先）
        const hp = Q.sitHindPaw;
        limb(ctx, [[hp[0] - Q.sitHock, hp[1] - Q.pawR * 0.9], [hp[0], hp[1] - Q.pawR * 0.6]], [Q.hindW[2] + 0.3, Q.hindW[3]], Q.c.legFur, lw);
        oval(ctx, hp[0] + 0.3, hp[1] - Q.pawR * 0.5, Q.pawR * 1.5, Q.pawR * 0.62, 0, Q.c.paw, lw);
        const th = F.pt(Q.sitThigh);
        oval(ctx, th[0], th[1], Q.thigh[2] * 1.12, Q.thigh[3] * 0.95, -0.35, parts.thighFill || Q.c.fur, lw);
        if (parts.sitThigh) parts.sitThigh(ctx, th, s, lw);
        if (groomPaw) {
          paintLeg(groomPaw, false, false);
        } else {
          paintLeg(fl(false), false, false);
        }
        if (parts.sitFront) parts.sitFront(ctx, s, F, P, lw);
      }

      // 頭（体が傾いても、頭はほぼ水平に保つ）
      const hp = F.pt(Q.headPivot);
      if (P.sit) { hp[0] += Q.sitHead[0]; hp[1] += Q.sitHead[1]; }     // 座ると首をすくめる
      ctx.save();
      ctx.translate(hp[0], hp[1] + P.headDy);
      ctx.rotate(parts.headTilt ? parts.headTilt(s, P) : 0);
      ctx.scale(Q.headScale, Q.headScale);
      parts.head(ctx, s, P, lw);
      ctx.restore();
      if (!parts.tailBehind) parts.tail(ctx, s, F, P, lw);
      if (groomOver(s, parts)) parts.groomOver(ctx, s, F, lw);
    }
    function groomOver(s, parts) { return s.state === "groom" && parts.groomOver; }

    // ------------------------------------------------------------
    // 柴犬（赤毛・裏白・巻き尾・立ち耳）
    //   肩の高さ 約15px（0.33マス）
    // ------------------------------------------------------------
    const SH_C = {
      fur: "#d98a4b", furTop: "#e5a064", furBack: "#c47538", legFur: "#d78a4c",
      farFur: "#b06c39", white: "#fbf2e4", whiteShade: "#ecdcc5",
      paw: "#f6e9d6", farPaw: "#d9c6ab", nose: "#2a201b", eye: "#26170e",
      innerEar: "#f1d2b4", tongue: "#e2707a", mouth: "#4a2a22"
    };
    const SH = {
      c: SH_C,
      center: [0, -11.5],
      frontTop: [5.0, -10.4], elbow: [-0.4, 2.9], fl1: 4.3, fl2: 3.5, frontX: 5.3,
      hindTop: [-6.0, -11.4], hl1: 4.7, hl2: 4.5, meta: [-0.7, -3.3], hindX: -6.6,
      frontW: [3.0, 2.4, 1.8, 1.5], hindW: [3.8, 2.6, 1.75, 1.5], pawR: 1.0,
      farUp: 0.45, liftF: 1.7, liftH: 1.5,
      thigh: [-6.4, -11.0, 3.3, 3.9, 0.25], thighRest: Math.atan2(4, 1.2),
      shoulder: [5.0, -11.5, 2.4, 3.3, -0.2],
      headPivot: [9.5, -17.0],
      // 確かめ後の手直し：歩幅を本物に近づけた（歩く 2.3→3.6・走る 4.4→5.0、走るときは足が地面を離れている時間を長く 0.5→0.6）。
      // 1周期で進む長さ＝2×stride÷(1−swing)＝歩く 11.6px・走る 25px（ANIMAL_KIND の stride・runStride と合わせる）
      walk: { stride: 3.6, swing: 0.38, bob: 0.35 },
      run: { stride: 5.0, swing: 0.6, bob: 1.1, pitch: 0.07 },
      swingU: [4.0, 3.0],              // 足のふりの支点（前＝肩、後ろ＝腰）が、足の付け根の何 px 上にあるか
      runEarBack: 0.6, runMouth: 1,
      // 座る：おしりの下を軸に体を起こす
      sitRot: 0.62, sitPivot: [-7.6, -9.4], sitShift: [2.6, 7.2],
      sitFrontX: 0.5, sitHindPaw: [-0.6, 0], sitHock: 3.6, sitThigh: [-5.6, -11.2], sitHead: [0, 0], headScale: 1.08
    };
    // 胴（首まで含めた形。首の上は頭がおおう）
    const SH_BODY = [[3.0, -15.4], [-1.5, -14.9], [-6.0, -15.1], [-8.9, -13.7], [-9.7, -11.1], [-8.7, -8.6],
      [-5.6, -9.0], [-1.0, -8.7], [3.0, -7.7], [6.6, -8.6], [8.6, -11.4], [10.2, -14.0], [11.0, -16.0],
      [8.6, -18.6], [5.0, -17.4]];
    const SH_BELLY = [[8.8, -12.6], [7.8, -8.2], [3.0, -7.2], [-1.0, -8.3], [-5.9, -8.5], [-6.2, -9.7],
      [-1.0, -9.9], [3.2, -9.5], [6.0, -10.7], [7.2, -13.6]];
    const SH_THROAT = [[10.9, -17.6], [11.2, -15.0], [8.6, -11.4], [7.0, -12.0], [8.2, -14.6], [9.4, -17.4]];
    const SH_HEAD = [[-2.5, 0.3], [-1.9, -2.3], [0.4, -3.0], [2.0, -2.3], [3.9, -1.6], [4.9, -1.0],
      [5.0, -0.1], [4.1, 0.8], [2.5, 1.6], [0.3, 2.4], [-1.8, 1.9]];
    const SH_CHEEK = [[0.5, 0.1], [2.0, -0.9], [4.0, -0.9], [5.2, -0.2], [4.2, 1.0], [2.5, 1.8], [0.3, 2.7], [-1.2, 1.6]];

    // 胴の塗り（上が明るく、下へ少し濃く）
    function furGrad(ctx, y0, y1, top, mid) {
      const g = ctx.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, top); g.addColorStop(1, mid);
      return g;
    }

    // 柴犬の耳（横向き）。back＝後ろへ倒す量（0〜1）
    function shibaEarSide(ctx, far, back, twitch, lw) {
      ctx.save();
      ctx.translate(far ? -1.2 : 0, far ? -2.2 : -2.5);
      ctx.rotate(-back * 0.7 + twitch);
      if (far) {
        shape(ctx, [[-0.9, 0.4], [-0.7, -3.5], [0.9, 0.0]], SH_C.furBack, lw);
      } else {
        shape(ctx, [[-1.1, 0.2], [0.0, -3.9], [1.1, -0.2]], SH_C.fur, lw);
        shape(ctx, [[-0.5, -0.1], [-0.05, -2.7], [0.55, -0.25]], SH_C.innerEar, lw, null);
      }
      ctx.restore();
    }

    // 柴犬の口（開ける＝はぁはぁ）
    function shibaMouthSide(ctx, open, lw) {
      if (open > 0) {
        shape(ctx, [[4.6, 0.5], [2.7, 0.9], [2.3, 1.2], [3.1, 1.9], [4.2, 1.3]], SH_C.mouth, lw);
        shape(ctx, [[3.0, 1.3], [2.6, 2.5], [3.2, 2.9], [3.7, 2.1], [3.8, 1.3]], SH_C.tongue, lw * 0.8);
      } else {
        ctx.beginPath(); ctx.moveTo(4.6, 0.45); ctx.quadraticCurveTo(3.7, 0.95, 2.8, 0.9);
        ctx.strokeStyle = OL; ctx.lineWidth = lw * 0.8; ctx.stroke();
      }
    }

    // 柴犬の巻いたしっぽ（横向き）。w＝振る量（−1〜1）
    function shibaTailSide(ctx, base, w, lw) {
      ctx.save();
      ctx.translate(base[0], base[1]);
      ctx.rotate(w * 0.3);
      ctx.scale(1 - Math.abs(w) * 0.28, 1);
      const curl = [[0.4, 0.6], [-0.9, -1.4], [-0.7, -3.5], [0.9, -4.6], [2.7, -4.1], [3.2, -2.5], [2.4, -1.1]];
      // 外側（毛のふくらみ）→ 内側の白（裏白）
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      oval(ctx, 1.1, -2.5, 1.5, 1.7, 0, SH_C.furBack, lw, null);       // 巻きの内側（すき間を埋める）
      smooth(ctx, curl, false); ctx.strokeStyle = OL; ctx.lineWidth = 2.7 + lw * 2; ctx.stroke();
      smooth(ctx, curl, false); ctx.strokeStyle = SH_C.fur; ctx.lineWidth = 2.7; ctx.stroke();
      smooth(ctx, [[0.0, -1.5], [0.1, -3.2], [1.2, -3.8], [2.4, -3.4]], false);
      ctx.strokeStyle = "rgba(251,242,228,0.7)"; ctx.lineWidth = 0.6; ctx.stroke();
      smooth(ctx, [[-1.3, -1.8], [-1.0, -3.9], [0.8, -5.2]], false);
      ctx.strokeStyle = "rgba(150,80,30,0.45)"; ctx.lineWidth = 0.7; ctx.stroke();     // 背の濃い毛先
      ctx.lineCap = "butt"; ctx.lineJoin = "miter";
      ctx.restore();
    }

    // しっぽを振る量（wag は速く大きく、ふだんはときどき小さく）
    function shibaWag(s) {
      if (s.state === "wag") return Math.sin(s.t * TAU * 3.2);
      if (s.state === "run") return Math.sin(s.phase * TAU) * 0.3;
      return Math.sin(s.t * 1.3 + s.seed * 9) * 0.12;
    }

    // 首をかしげる・耳を動かす（idle）
    function shibaIdle(s) {
      const t = s.t + s.seed * 11;
      const cyc = t % 6.5;
      const tilt = cyc < 2.2 ? Math.sin(cyc / 2.2 * Math.PI) * 0.22 * (rnd(s.seed, Math.floor(t / 6.5)) < 0.5 ? 1 : -1) : 0;
      const tw = (t % 4.3) < 0.18 ? Math.sin((t % 4.3) / 0.18 * Math.PI) * 0.25 : 0;
      return { tilt: tilt, twitch: tw };
    }

    const shibaSideParts = {
      tailBehind: false,
      body: function (ctx, s, P, lw) {
        shape(ctx, SH_BODY, furGrad(ctx, -15.5, -8, SH_C.furTop, SH_C.fur), lw);
        inside(ctx, SH_BODY, function (c) {
          shape(c, SH_BELLY, SH_C.white, lw, null);
          shape(c, SH_THROAT, SH_C.white, lw, null);
          // 首まわりのふさふさの毛
          c.strokeStyle = "rgba(150,80,30,0.25)"; c.lineWidth = 0.35;
          for (let i = 0; i < 3; i++) {
            c.beginPath(); c.moveTo(6.6 + i * 0.9, -15.6 + i * 0.5); c.lineTo(6.0 + i * 0.9, -14.4 + i * 0.5); c.stroke();
          }
          // 背の濃い毛（胡麻のようにうっすら）
          smooth(c, [[3.0, -15.6], [-1.5, -15.1], [-6.0, -15.3], [-8.9, -13.9]], false);
          c.strokeStyle = "rgba(160,85,35,0.35)"; c.lineWidth = 1.3; c.stroke();
          // 毛並みの短い線
          c.strokeStyle = "rgba(150,80,30,0.25)"; c.lineWidth = 0.35;
          for (let i = 0; i < 5; i++) {
            const x = 1.5 - i * 2.1;
            c.beginPath(); c.moveTo(x, -12.4); c.lineTo(x - 0.9, -11.4); c.stroke();
          }
        });
        smooth(ctx, SH_BODY, true); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      },
      headTilt: function (s, P) {
        if (s.state === "idle" || s.state === "sit") return shibaIdle(s).tilt * 0.6;
        if (s.state === "run") return 0.12;
        return 0;
      },
      head: function (ctx, s, P, lw) {
        const id = shibaIdle(s);
        shibaEarSide(ctx, true, P.earBack, 0, lw);
        shape(ctx, SH_HEAD, SH_C.fur, lw);
        inside(ctx, SH_HEAD, function (c) {
          shape(c, SH_CHEEK, SH_C.white, lw, null);
          oval(c, 1.7, -2.0, 0.5, 0.28, -0.2, "rgba(255,245,230,0.75)", lw, null);   // 目の上の白い毛
        });
        smooth(ctx, SH_HEAD, true); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
        // 鼻・目・口
        oval(ctx, 4.8, -0.6, 0.6, 0.45, 0, SH_C.nose, lw, null);
        oval(ctx, 4.9, -0.78, 0.18, 0.1, 0, "rgba(255,255,255,0.55)", lw, null);
        if (blinking(s)) {
          ctx.beginPath(); ctx.moveTo(1.1, -1.2); ctx.lineTo(2.1, -1.25);
          ctx.strokeStyle = SH_C.eye; ctx.lineWidth = lw * 0.9; ctx.stroke();
        } else {
          oval(ctx, 1.6, -1.25, 0.55, 0.4, -0.15, SH_C.eye, lw, null);
          oval(ctx, 1.75, -1.38, 0.16, 0.16, 0, "#ffffff", lw, null);
        }
        shibaMouthSide(ctx, P.mouth || (s.state === "wag" ? 1 : 0), lw);
        ctx.save(); ctx.translate(0, 0);
        shibaEarSide(ctx, false, P.earBack, id.twitch, lw);
        ctx.restore();
      },
      tail: function (ctx, s, F, P, lw) {
        shibaTailSide(ctx, F.pt([-7.8, -14.2]), shibaWag(s), lw);
      },
      sitThigh: function (ctx, th, s, lw) {
        // たたんだももの内側の白
        oval(ctx, th[0] + 1.6, th[1] + 2.2, 1.4, 0.9, -0.3, "rgba(251,242,228,0.9)", lw, null);
      }
    };

    // ---- 柴犬：正面と後ろ ----
    // 正面・後ろの足の上げ下げ（横の歩き方と同じ順番）
    function frontBackLegs(s, g) {
      const st = s.state, ph = s.phase || 0;
      const res = { nH: 0, fH: 0, nF: 0, fF: 0, sway: 0, bob: 0 };
      if (st === "walk" || st === "run") {
        const off = st === "run" ? { nH: 0, fH: 0.1, nF: 0.48, fF: 0.6 } : { nH: 0, nF: 0.25, fH: 0.5, fF: 0.75 };
        Object.keys(off).forEach(function (k) { res[k] = gait(ph + off[k], g.swing, 1).lift; });
        res.sway = st === "run" ? 0 : Math.sin(ph * TAU) * 0.3;
        res.bob = st === "run" ? -Math.abs(Math.sin(ph * TAU + 0.6)) * g.bob : -Math.abs(Math.sin(ph * TAU * 2)) * g.bob;
      } else {
        res.bob = Math.sin((s.t || 0) * 1.7 + s.seed * 5) * 0.12;
      }
      return res;
    }

    // 正面・後ろ向きの1本の足（上 top から足先 y まで、まっすぐ下）
    function straightLeg(ctx, x, top, footY, lift, w0, w1, fill, paw, pawR, lw, foreshort) {
      const fy = footY - lift;
      const kneeY = top + (fy - top) * 0.55;
      limb(ctx, [[x, top], [x + 0.05, kneeY], [x, fy - pawR * 0.6]], [w0, (w0 + w1) / 2, w1], fill, lw);
      oval(ctx, x, fy - pawR * 0.45, pawR * (foreshort ? 0.9 : 1.0), pawR * 0.6, 0, paw, lw);
    }

    function shibaFace(ctx, s, P, lw, back) {
      const id = shibaIdle(s);
      const eb = P.earBack || 0;
      // 耳（左右）
      [-1, 1].forEach(function (d) {
        ctx.save();
        ctx.translate(d * 1.8, -2.2);
        ctx.rotate(d * (0.22 + eb * 0.5) + (d > 0 ? id.twitch : 0));
        shape(ctx, [[-1.0, 0.3], [0.0 + d * 0.15, -3.6 + eb * 0.8], [1.0, 0.3]], back ? SH_C.furBack : SH_C.fur, lw);
        if (!back) shape(ctx, [[-0.5, 0.1], [0.0 + d * 0.1, -2.5 + eb * 0.6], [0.5, 0.1]], SH_C.innerEar, lw, null);
        ctx.restore();
      });
      const head = [[-3.0, 0.4], [-2.8, -1.6], [-1.6, -2.8], [0, -3.0], [1.6, -2.8], [2.8, -1.6], [3.0, 0.4], [2.2, 2.0], [0, 2.7], [-2.2, 2.0]];
      shape(ctx, head, back ? furGrad(ctx, -3, 2.6, SH_C.furTop, SH_C.furBack) : SH_C.fur, lw);
      if (back) {
        // 後頭部の毛の流れ
        ctx.strokeStyle = "rgba(150,80,30,0.3)"; ctx.lineWidth = 0.35;
        ctx.beginPath(); ctx.moveTo(0, -2.6); ctx.lineTo(0, 1.6); ctx.stroke();
        return;
      }
      inside(ctx, head, function (c) {
        shape(c, [[-3.2, 0.3], [-1.5, -0.4], [-0.5, -1.4], [0, -1.1], [0.5, -1.4], [1.5, -0.4], [3.2, 0.3], [2.4, 2.4], [0, 3.0], [-2.4, 2.4]], SH_C.white, lw, null);
        oval(c, -1.4, -1.9, 0.45, 0.25, 0.2, "rgba(255,245,230,0.75)", lw, null);   // 目の上の白い毛
        oval(c, 1.4, -1.9, 0.45, 0.25, -0.2, "rgba(255,245,230,0.75)", lw, null);
      });
      smooth(ctx, head, true); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      // 目
      [-1, 1].forEach(function (d) {
        if (blinking(s)) {
          ctx.beginPath(); ctx.moveTo(d * 0.9, -1.0); ctx.lineTo(d * 1.85, -1.15);
          ctx.strokeStyle = SH_C.eye; ctx.lineWidth = lw * 0.9; ctx.stroke();
        } else {
          oval(ctx, d * 1.35, -1.05, 0.5, 0.37, d * 0.18, SH_C.eye, lw, null);
          oval(ctx, d * 1.35 + 0.14, -1.18, 0.14, 0.14, 0, "#ffffff", lw, null);
        }
      });
      // 鼻すじ・鼻・口
      oval(ctx, 0, 0.75, 1.45, 1.1, 0, "rgba(255,248,238,0.9)", lw, null);
      oval(ctx, 0, 0.25, 0.68, 0.46, 0, SH_C.nose, lw, null);
      oval(ctx, -0.15, 0.1, 0.2, 0.1, 0, "rgba(255,255,255,0.5)", lw, null);
      if (P.mouth || s.state === "wag") {
        shape(ctx, [[-0.9, 1.1], [0.9, 1.1], [0.5, 1.9], [-0.5, 1.9]], SH_C.mouth, lw * 0.8);
        shape(ctx, [[-0.45, 1.4], [0.45, 1.4], [0.4, 2.5], [0, 2.8], [-0.4, 2.5]], SH_C.tongue, lw * 0.7);
      } else {
        ctx.beginPath(); ctx.moveTo(0, 0.7); ctx.lineTo(0, 1.15);
        ctx.moveTo(-0.75, 1.3); ctx.quadraticCurveTo(0, 1.6, 0.75, 1.3);
        ctx.strokeStyle = OL; ctx.lineWidth = lw * 0.7; ctx.stroke();
      }
    }

    // 巻いたしっぽを上から見た形（背中にのった輪）
    function shibaCurlTop(ctx, x, y, rx, ry, w, lw) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(w * 0.25);
      oval(ctx, 0, 0, rx, ry, 0, SH_C.fur, lw);
      oval(ctx, 0.15 * rx, 0.05, rx * 0.45, ry * 0.42, 0, SH_C.white, lw, OL_SOFT);
      ctx.strokeStyle = "rgba(150,80,30,0.4)"; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.ellipse(0, 0, rx * 0.8, ry * 0.8, 0, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
      ctx.restore();
    }

    // 点の並びを上下にずらす
    function lift2(pts, dy) { return pts.map(function (p) { return [p[0], p[1] + dy]; }); }

    // 正面（こちらへ向かう）。少し上から見下ろすので、奥にある背中・後ろ足は上にずれて見える
    function drawShibaFront(ctx, s, lw) {
      const lg = frontBackLegs(s, s.state === "run" ? SH.run : SH.walk);
      const sit = s.state === "sit";
      const lift = s.state === "run" ? 2.6 : 1.6;
      const P = { earBack: s.state === "run" ? 0.6 : 0, mouth: s.state === "run" ? 1 : 0 };
      const b = lg.bob, w = shibaWag(s);
      ctx.save();
      ctx.translate(lg.sway, 0);
      if (!sit) {
        // 奥：後ろ足・背中・巻いたしっぽ
        straightLeg(ctx, -2.5, -10.0 + b, -4.4, lg.fH * lift * 0.7, 2.4, 1.5, SH_C.farFur, SH_C.farPaw, 0.85, lw, true);
        straightLeg(ctx, 2.5, -10.0 + b, -4.4, lg.nH * lift * 0.7, 2.4, 1.5, SH_C.farFur, SH_C.farPaw, 0.85, lw, true);
        shibaCurlTop(ctx, 2.2 + w * 1.2, -19.0 + b, 2.0, 1.5, w, lw);
        shape(ctx, lift2([[-4.7, -12.0], [-4.5, -15.6], [-3.0, -17.8], [0, -18.4], [3.0, -17.8], [4.5, -15.6], [4.7, -12.0],
          [2.8, -9.0], [0, -8.6], [-2.8, -9.0]], b), furGrad(ctx, -18.5 + b, -9 + b, SH_C.furTop, SH_C.fur), lw);
        // 前足
        straightLeg(ctx, -2.1, -9.6 + b, 0, lg.nF * lift, 2.9, 2.0, SH_C.legFur, SH_C.paw, 1.05, lw);
        straightLeg(ctx, 2.1, -9.6 + b, 0, lg.fF * lift, 2.9, 2.0, SH_C.legFur, SH_C.paw, 1.05, lw);
        // 胸の白（裏白）
        shape(ctx, lift2([[-2.9, -12.8], [-2.2, -14.6], [0, -14.8], [2.2, -14.6], [2.9, -12.8], [2.3, -9.6], [0, -8.4], [-2.3, -9.6]], b), SH_C.white, lw);
        ctx.strokeStyle = "rgba(150,110,80,0.25)"; ctx.lineWidth = 0.35;
        ctx.beginPath(); ctx.moveTo(-1.2, -11.0 + b); ctx.lineTo(-0.8, -9.8 + b);
        ctx.moveTo(1.2, -11.0 + b); ctx.lineTo(0.8, -9.8 + b); ctx.moveTo(0, -10.6 + b); ctx.lineTo(0, -9.4 + b); ctx.stroke();
      } else {
        // 座る：後ろ足のももが両わきに出て、胸が高い
        oval(ctx, -3.7, -0.5, 1.2, 0.6, 0, SH_C.paw, lw);
        oval(ctx, 3.7, -0.5, 1.2, 0.6, 0, SH_C.paw, lw);
        oval(ctx, -3.4, -3.4, 2.3, 3.0, 0.2, SH_C.fur, lw);
        oval(ctx, 3.4, -3.4, 2.3, 3.0, -0.2, SH_C.fur, lw);
        shape(ctx, [[-4.0, -3.0], [-4.4, -9.0], [-3.4, -14.5], [0, -16.6], [3.4, -14.5], [4.4, -9.0], [4.0, -3.0], [0, -1.8]],
          furGrad(ctx, -17, -3, SH_C.furTop, SH_C.fur), lw);
        shibaCurlTop(ctx, 4.0 + w * 0.4, -4.6, 1.5, 1.3, w, lw);
        straightLeg(ctx, -1.6, -8.5, 0, 0, 2.3, 1.7, SH_C.legFur, SH_C.paw, 1.0, lw);
        straightLeg(ctx, 1.6, -8.5, 0, 0, 2.3, 1.7, SH_C.legFur, SH_C.paw, 1.0, lw);
        shape(ctx, [[-3.0, -14.0], [0, -15.2], [3.0, -14.0], [3.2, -10.0], [1.8, -7.2], [0, -6.6], [-1.8, -7.2], [-3.2, -10.0]], SH_C.white, lw);
      }
      // 頭
      const hy = sit ? -18.4 : -16.8 + b;
      ctx.save();
      ctx.translate(0, hy);
      ctx.rotate(s.state === "idle" || sit ? shibaIdle(s).tilt : 0);
      ctx.scale(1.12, 1.12);
      shibaFace(ctx, s, P, lw, false);
      ctx.restore();
      ctx.restore();
    }

    // 後ろ（向こうへ行く）。奥にある頭は上にずれ、手前のおしりと後ろ足が大きく見える
    function drawShibaBack(ctx, s, lw) {
      const lg = frontBackLegs(s, s.state === "run" ? SH.run : SH.walk);
      const sit = s.state === "sit";
      const lift = s.state === "run" ? 2.6 : 1.6;
      const P = { earBack: s.state === "run" ? 0.6 : 0 };
      const b = lg.bob, w = shibaWag(s);
      ctx.save();
      ctx.translate(lg.sway, 0);
      // 頭（いちばん奥）
      ctx.save(); ctx.translate(0, sit ? -18.6 : -20.0 + b);
      ctx.rotate(s.state === "idle" || sit ? shibaIdle(s).tilt : 0);
      ctx.scale(1.12, 1.12);
      shibaFace(ctx, s, P, lw, true);
      ctx.restore();
      if (!sit) {
        // 前足（奥）
        straightLeg(ctx, -2.1, -10.0 + b, -4.4, lg.fF * lift * 0.7, 2.2, 1.5, SH_C.farFur, SH_C.farPaw, 0.85, lw, true);
        straightLeg(ctx, 2.1, -10.0 + b, -4.4, lg.nF * lift * 0.7, 2.2, 1.5, SH_C.farFur, SH_C.farPaw, 0.85, lw, true);
        // 後ろ足（手前）。上の端は胴がおおう
        [-1, 1].forEach(function (d) {
          const l = d < 0 ? lg.nH : lg.fH;
          straightLeg(ctx, d * 2.7, -9.0 + b, 0, l * lift, 3.1, 1.9, SH_C.legFur, SH_C.paw, 1.0, lw);
          ctx.strokeStyle = "rgba(251,242,228,0.85)"; ctx.lineWidth = 0.7;      // 足の内側の白
          ctx.beginPath(); ctx.moveTo(d * 1.7, -7.4 + b); ctx.lineTo(d * 2.0, -1.2 - l * lift); ctx.stroke();
        });
        // 胴（背中を後ろ上から）
        const body = lift2([[-4.4, -12.6], [-3.9, -16.4], [-2.8, -18.8], [0, -19.5], [2.8, -18.8], [3.9, -16.4], [4.4, -12.6],
          [4.9, -10.2], [3.8, -7.3], [0, -6.8], [-3.8, -7.3], [-4.9, -10.2]], b);
        shape(ctx, body, furGrad(ctx, -20 + b, -8 + b, SH_C.furTop, SH_C.fur), lw);
        inside(ctx, body, function (c) {
          oval(c, 0, -7.2 + b, 2.2, 2.8, 0, SH_C.white, lw, null);          // おしりの白い毛（裏白）
          c.strokeStyle = "rgba(160,85,35,0.35)"; c.lineWidth = 1.2;         // 背すじの濃い毛
          c.beginPath(); c.moveTo(0, -19.4 + b); c.lineTo(0, -13.0 + b); c.stroke();
          c.strokeStyle = OL_SOFT; c.lineWidth = lw;                          // ももの盛り上がり
          [-1, 1].forEach(function (d) {
            c.beginPath(); c.ellipse(d * 2.4, -9.6 + b, 2.0, 2.9, 0, d < 0 ? 1.6 : -0.3, d < 0 ? 3.4 : 1.5); c.stroke();
          });
        });
        smooth(ctx, body, true); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
        shibaCurlTop(ctx, w * 1.0, -15.2 + b, 2.6, 2.1, w, lw);
      } else {
        // 座る：上の背中 → 地面に広がるおしり
        oval(ctx, -4.2, -0.6, 1.1, 0.55, 0, SH_C.farPaw, lw);
        oval(ctx, 4.2, -0.6, 1.1, 0.55, 0, SH_C.farPaw, lw);
        shape(ctx, [[-3.8, -6.0], [-4.0, -12.0], [-3.0, -16.0], [0, -17.0], [3.0, -16.0], [4.0, -12.0], [3.8, -6.0]],
          furGrad(ctx, -17, -6, SH_C.furTop, SH_C.fur), lw);
        shape(ctx, [[-5.2, -2.0], [-5.0, -6.0], [-3.6, -9.0], [0, -9.6], [3.6, -9.0], [5.0, -6.0], [5.2, -2.0], [3.0, -0.6], [0, -0.4], [-3.0, -0.6]],
          SH_C.fur, lw);
        oval(ctx, 0, -1.4, 2.4, 1.1, 0, SH_C.white, lw, null);
        shibaCurlTop(ctx, w * 0.6, -7.6, 2.4, 2.0, w, lw);
      }
      ctx.restore();
    }

    ANIMAL_ART.shiba = {
      size: { w: 26, h: 24 },
      states: ["idle", "walk", "run", "sit", "wag"],
      draw: function (ctx, s0) {
        const s = norm(s0);
        ctx.save();
        const lw = lineW(ctx);
        if (s.view === "front") drawShibaFront(ctx, s, lw);
        else if (s.view === "back") drawShibaBack(ctx, s, lw);
        else drawSide(ctx, SH, s, shibaSideParts);
        ctx.restore();
      }
    };

    // ------------------------------------------------------------
    // 猫（茶トラ・三毛・ハチワレ）。しなやかな体・長いしっぽ
    //   肩の高さ 約9px（0.2マス）
    // ------------------------------------------------------------
    const CAT_COL = {
      chatora: { base: "#e7a35f", top: "#efb676", dark: "#c27a3a", stripe: "rgba(176,100,40,0.7)", belly: "#f7e6c9", paw: "#f4dcb8", far: "#c6874c", farPaw: "#d9b98f" },
      mike: { base: "#f8f4ee", top: "#fffdf9", dark: "#ddd5c9", orange: "#e39a50", black: "#3b3330", belly: "#f8f4ee", paw: "#f6f0e8", far: "#d8d0c4", farPaw: "#d8d0c4" },
      hachiware: { base: "#3a3431", top: "#4a433f", dark: "#2a2523", belly: "#f7f3ed", paw: "#f7f3ed", far: "#2c2725", farPaw: "#d6d0c8" }
    };
    function catCol(s) { return CAT_COL[s.variant] || CAT_COL.chatora; }

    const CT = {
      c: null,
      center: [0, -7],
      frontTop: [3.1, -6.4], elbow: [-0.3, 2.0], fl1: 2.9, fl2: 1.7, frontX: 3.4,
      hindTop: [-4.6, -7.0], hl1: 3.1, hl2: 3.1, meta: [-0.7, -2.4], hindX: -4.3,
      frontW: [1.7, 1.25, 0.95, 0.85], hindW: [2.3, 1.4, 0.95, 0.85], pawR: 0.62,
      farUp: 0.35, liftF: 1.1, liftH: 1.0,
      thigh: [-4.7, -6.9, 2.3, 2.6, 0.3], thighRest: Math.atan2(3, 1.4),
      shoulder: [3.1, -7.0, 1.6, 2.2, -0.2],
      headPivot: [6.4, -10.3],
      // 確かめ後の手直し：歩幅を本物に近づけた（歩く 1.5→2.4・走る 3.2→4.0、走るときの足を離す時間 0.52→0.62）。
      // 1周期で進む長さ＝2×stride÷(1−swing)＝歩く 8.0px・走る 21.1px（ANIMAL_KIND の stride・runStride と合わせる）
      walk: { stride: 2.4, swing: 0.4, bob: 0.18 },
      run: { stride: 4.0, swing: 0.62, bob: 0.8, pitch: 0.09 },
      swingU: [2.5, 2.5],              // 足のふりの支点（前＝肩、後ろ＝腰）が、足の付け根の何 px 上にあるか
      runEarBack: 0.5, runMouth: 0,
      sitRot: 0.78, sitPivot: [-5.0, -6.0], sitShift: [2.2, 4.4],
      sitFrontX: -0.4, sitHindPaw: [-0.2, 0], sitHock: 2.4, sitThigh: [-4.2, -7.2], sitHead: [-0.6, 1.4], headScale: 1.1
    };
    // 胴（首まで含めた形。首の上は頭がおおう）
    const CAT_BODY = [[2.6, -9.3], [-1.0, -9.7], [-4.4, -9.7], [-6.2, -8.6], [-6.6, -6.8], [-5.4, -5.1],
      [-3.4, -5.4], [0.0, -4.9], [2.8, -5.3], [4.6, -6.8], [6.1, -8.4], [7.1, -9.6], [5.9, -11.2], [3.8, -10.7]];
    const CAT_BELLY = [[5.0, -8.0], [4.4, -6.2], [2.8, -4.8], [0, -4.4], [-3.4, -4.9], [-3.6, -5.8], [0, -6.0], [2.8, -6.4]];
    const CAT_HEAD = [[-1.6, 0.4], [-1.5, -1.4], [-0.2, -2.1], [1.3, -1.9], [2.3, -1.0], [2.8, -0.2],
      [2.7, 0.5], [1.7, 1.1], [0.0, 1.45], [-1.3, 1.2]];

    // しっぽの形（付け根から先へ）。state と時間で曲げる
    function catTailPts(s) {
      const t = s.t || 0, st = s.state;
      const sway = Math.sin(t * 2.1 + s.seed * 7);
      if (st === "sit" || st === "groom") {
        // 足に巻く（地面ぞいに前へ）
        const tip = Math.sin(t * 1.6 + s.seed * 4) * 0.35;
        return [[0, 0], [-0.6, 2.0], [0.6, 3.6], [3.0, 4.2], [5.4, 4.1], [6.8, 3.6 + tip]];
      }
      if (st === "run") {
        return [[0, 0], [-1.8, -0.7], [-3.6, -1.0], [-5.2, -0.8 + Math.sin(s.phase * TAU) * 0.6]];
      }
      if (st === "walk") {
        const w = Math.sin((s.phase || 0) * TAU) * 0.35;
        return [[0, 0], [-1.4, -1.9], [-1.9 + w, -4.6], [-1.4 + w, -7.0], [-0.2 + w * 1.5, -7.9]];
      }
      // idle：立てたしっぽの先だけがゆれる
      return [[0, 0], [-1.4, -1.9], [-1.9, -4.6], [-1.5, -6.9], [-0.4 + sway * 0.9, -7.8 + Math.abs(sway) * 0.2]];
    }

    // しっぽを描く（太さが先へ細くなる）。模様は variant ごと
    function catTail(ctx, s, pts, lw) {
      const C = catCol(s);
      const n = pts.length;
      // なめらかにするため点を増やす
      const dense = [];
      for (let i = 0; i < n - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const p0 = pts[Math.max(i - 1, 0)], p3 = pts[Math.min(i + 2, n - 1)];
        for (let k = 0; k < 4; k++) {
          const u = k / 4, u2 = u * u, u3 = u2 * u;
          const f = function (j) {
            return 0.5 * ((2 * a[j]) + (-p0[j] + b[j]) * u + (2 * p0[j] - 5 * a[j] + 4 * b[j] - p3[j]) * u2 + (-p0[j] + 3 * a[j] - 3 * b[j] + p3[j]) * u3);
          };
          dense.push([f(0), f(1)]);
        }
      }
      dense.push(pts[n - 1]);
      const dw = dense.map(function (p, i) { return 1.55 - 0.6 * i / (dense.length - 1); });
      const base = s.variant === "mike" ? C.orange : (s.variant === "hachiware" ? C.base : C.base);
      limb(ctx, dense, dw, base, lw);
      // 模様
      if (s.variant === "chatora") {
        ctx.strokeStyle = C.stripe; ctx.lineWidth = 0.55;
        for (let i = 3; i < dense.length - 1; i += 3) {
          const p = dense[i], q = dense[i + 1];
          const tx = q[0] - p[0], ty = q[1] - p[1], l = Math.hypot(tx, ty) || 1;
          const w = dw[i] * 0.42;
          ctx.beginPath(); ctx.moveTo(p[0] - ty / l * w, p[1] + tx / l * w); ctx.lineTo(p[0] + ty / l * w, p[1] - tx / l * w); ctx.stroke();
        }
      } else if (s.variant === "mike") {
        // 先が黒
        const m = Math.floor(dense.length * 0.62);
        limb(ctx, dense.slice(m), dw.slice(m), C.black, lw);
      }
    }

    // 猫の耳（横向き）
    function catEarSide(ctx, s, far, back, lw) {
      const C = catCol(s);
      ctx.save();
      ctx.translate(far ? -0.9 : 0.15, far ? -1.5 : -1.7);
      ctx.rotate(-back * 0.8 + (far ? -0.1 : 0));
      let col = far ? C.dark : C.base;
      if (s.variant === "mike") col = far ? shade(C.black, 0.0) : C.orange;
      shape(ctx, [[-0.9, 0.3], [-0.25, -2.4], [0.85, 0.1]], col, lw);
      if (!far) shape(ctx, [[-0.45, 0.05], [-0.2, -1.6], [0.35, -0.05]], "#f2b8b0", lw, null);
      ctx.restore();
    }

    // 猫の体の模様（横向き）。region＝"body" | "neck" | "head"
    function catPatternSide(c, s, region, lw) {
      const C = catCol(s);
      if (s.variant === "chatora") {
        c.strokeStyle = C.stripe; c.lineWidth = 0.6;
        if (region === "body") {
          for (let i = 0; i < 6; i++) {
            const x = 2.2 - i * 1.55;
            c.beginPath(); c.moveTo(x + 0.3, -10.2); c.quadraticCurveTo(x - 0.5, -8.4, x + 0.1, -6.6); c.stroke();
          }
          c.lineWidth = 0.8;
          c.beginPath(); c.moveTo(2.6, -9.6); c.lineTo(-4.6, -9.9); c.stroke();     // 背すじの濃い線
        } else if (region === "neck") {
          c.beginPath(); c.moveTo(3.5, -11.2); c.quadraticCurveTo(4.4, -10.2, 5.6, -10.2); c.stroke();
        } else if (region === "head") {
          c.lineWidth = 0.45;
          c.beginPath(); c.moveTo(0.4, -2.0); c.lineTo(0.7, -1.2); c.moveTo(-0.3, -1.9); c.lineTo(0.0, -1.1);
          c.moveTo(-0.6, 0.0); c.lineTo(0.7, -0.1); c.moveTo(-0.5, 0.6); c.lineTo(0.8, 0.5); c.stroke();
        }
      } else if (s.variant === "mike") {
        if (region === "body") {
          const r1 = rnd(s.seed, 1), r2 = rnd(s.seed, 2);
          shape(c, [[-1.5 + r1, -10.2], [-4.6 + r1, -10.4], [-5.4 + r1, -8.0], [-3.2 + r1, -7.0], [-1.0 + r1, -7.8]], C.orange, lw, null);
          shape(c, [[1.8 + r2, -10.0], [-0.6 + r2, -10.3], [-1.0 + r2, -8.4], [0.6 + r2, -7.6], [2.0 + r2, -8.4]], C.black, lw, null);
          shape(c, [[-5.2, -10.0], [-7.0, -9.0], [-6.8, -6.4], [-5.4, -7.0]], C.black, lw, null);
        } else if (region === "head") {
          shape(c, [[-1.8, -2.4], [0.9, -2.4], [0.6, -0.6], [-0.4, 0.3], [-1.8, 0.4]], C.orange, lw, null);
          shape(c, [[0.3, -2.4], [2.0, -2.0], [1.9, -0.7], [1.0, -0.3], [0.5, -1.0]], C.black, lw, null);
        }
      } else if (s.variant === "hachiware") {
        if (region === "body") shape(c, CAT_BELLY.map(function (p) { return [p[0], p[1] - 0.6]; }), C.belly, lw, null);
        if (region === "neck") shape(c, [[7.0, -10.6], [6.8, -9.0], [4.8, -6.8], [3.8, -7.6], [5.0, -9.6], [6.0, -10.8]], C.belly, lw, null);
        if (region === "head") shape(c, [[1.0, -0.6], [1.6, -1.4], [2.4, -0.6], [3.0, -0.1], [2.8, 0.7], [1.6, 1.3], [0.0, 1.7], [-0.6, 0.8]], C.belly, lw, null);
      }
      if (region === "body" && s.variant !== "hachiware") {
        shape(c, CAT_BELLY, C.belly, lw, null);
      }
    }

    // 猫の目（横向き）
    function catEyeSide(ctx, s, x, y, lw) {
      if (blinking(s) || s.state === "groom" && (s.t % 2.4) < 1.2) {
        ctx.beginPath(); ctx.moveTo(x - 0.45, y + 0.05); ctx.quadraticCurveTo(x, y + 0.25, x + 0.45, y);
        ctx.strokeStyle = "#2a2320"; ctx.lineWidth = lw * 0.8; ctx.stroke();
        return;
      }
      oval(ctx, x, y, 0.46, 0.36, -0.12, "#cdbf44", lw * 0.6, "rgba(40,30,20,0.7)");
      oval(ctx, x + 0.08, y, 0.12, 0.3, 0, "#1f1a17", lw, null);
      oval(ctx, x + 0.18, y - 0.13, 0.08, 0.08, 0, "#ffffff", lw, null);
    }

    // 毛づくろい：周期の中の位置（0〜0.5＝前足をなめる、0.5〜1＝前足で顔をこする）
    function groomPhase(s) { return ((s.t || 0) % 2.4) / 2.4; }

    const catSideParts = {
      tailBehind: true,
      body: function (ctx, s, P, lw) {
        const C = catCol(s);
        shape(ctx, CAT_BODY, furGrad(ctx, -10, -5, C.top, C.base), lw);
        inside(ctx, CAT_BODY, function (c) { catPatternSide(c, s, "body", lw); catPatternSide(c, s, "neck", lw); });
        smooth(ctx, CAT_BODY, true); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      },
      headTilt: function (s, P) {
        if (s.state === "groom") {
          const g = groomPhase(s);
          return g < 0.5 ? 0.55 + Math.sin(g * 2 * TAU * 2) * 0.12 : 0.25 + Math.sin((g - 0.5) * 2 * Math.PI) * 0.25;
        }
        if (s.state === "run") return 0.1;
        if (s.state === "walk") return 0.12;     // 猫は歩くとき頭が少し低い
        return Math.sin((s.t || 0) * 0.5 + s.seed * 6) * 0.06;
      },
      head: function (ctx, s, P, lw) {
        const C = catCol(s);
        catEarSide(ctx, s, true, P.earBack, lw);
        shape(ctx, CAT_HEAD, C.base, lw);
        inside(ctx, CAT_HEAD, function (c) {
          if (s.variant !== "hachiware") oval(c, 1.9, 0.6, 1.3, 0.8, 0, C.belly, lw, null);   // 口のまわりの明るい毛
          catPatternSide(c, s, "head", lw);
        });
        smooth(ctx, CAT_HEAD, true); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
        catEyeSide(ctx, s, 1.35, -0.55, lw);
        oval(ctx, 2.65, -0.15, 0.25, 0.18, 0, "#d98a8a", lw, null);        // 鼻
        ctx.beginPath(); ctx.moveTo(2.6, 0.05); ctx.quadraticCurveTo(2.4, 0.55, 1.9, 0.55);
        ctx.strokeStyle = OL; ctx.lineWidth = lw * 0.6; ctx.stroke();
        // ひげ
        ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 0.18;
        ctx.beginPath();
        ctx.moveTo(2.2, 0.25); ctx.lineTo(4.6, -0.2);
        ctx.moveTo(2.2, 0.4); ctx.lineTo(4.7, 0.5);
        ctx.moveTo(2.1, 0.55); ctx.lineTo(4.3, 1.2);
        ctx.stroke();
        if (s.variant === "hachiware" || s.variant === "mike") {
          ctx.strokeStyle = "rgba(60,50,45,0.5)"; ctx.lineWidth = 0.15; ctx.stroke();
          ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 0.18; ctx.stroke();
        }
        catEarSide(ctx, s, false, P.earBack, lw);
        // 毛づくろいの舌
        if (s.state === "groom" && groomPhase(s) < 0.5 && Math.sin(groomPhase(s) * 2 * TAU * 2) > 0) {
          oval(ctx, 2.3, 0.95, 0.35, 0.25, 0.4, "#e7848c", lw * 0.6);
        }
      },
      tail: function (ctx, s, F, P, lw) {
        const base = F.pt(P.sit ? [-5.6, -6.6] : [-6.0, -8.4]);
        const pts = catTailPts(s).map(function (p) { return [p[0] + base[0], p[1] + base[1]]; });
        if (P.sit) return;       // 座るときのしっぽは、体の前（sitFront）で描く
        catTail(ctx, s, pts, lw);
      },
      sitFront: function (ctx, s, F, P, lw) {
        // 足に巻いたしっぽ（地面ぞい）
        const base = [Math.min(F.pt([-5.6, -6.6])[0], -3.8), -1.2];
        const pts = catTailPts(s).map(function (p, i) { return [p[0] * 0.95 + base[0] + (i === 0 ? 0 : 0), p[1] * 0.25 + base[1]]; });
        catTail(ctx, s, pts, lw);
      },
      leg: function (ctx, pts, far, hind, lw, s) {
        const C = catCol(s);
        // ハチワレの白い靴下・茶トラの足のしま
        if (s.variant === "hachiware") {
          const a = pts[2], b = pts[3];
          limb(ctx, [[a[0] + (b[0] - a[0]) * 0.2, a[1] + (b[1] - a[1]) * 0.2], b], [hind ? 1.0 : 1.0, 0.9], far ? "#d6d0c8" : C.belly, lw);
        } else if (s.variant === "chatora" && !far) {
          ctx.strokeStyle = C.stripe; ctx.lineWidth = 0.45;
          const a = pts[1], b = pts[2];
          for (let k = 1; k <= 2; k++) {
            const u = k / 3, x = a[0] + (b[0] - a[0]) * u, y = a[1] + (b[1] - a[1]) * u;
            ctx.beginPath(); ctx.moveTo(x - 0.5, y); ctx.lineTo(x + 0.5, y - 0.15); ctx.stroke();
          }
        } else if (s.variant === "mike" && hind && !far) {
          limb(ctx, [pts[0], pts[1]], [2.0, 1.2], C.orange, lw, null);
        }
      },
      sitThigh: function (ctx, th, s, lw) {
        const C = catCol(s);
        if (s.variant === "mike") oval(ctx, th[0] - 0.4, th[1] - 0.6, 1.5, 1.4, 0, C.orange, lw, null);
        if (s.variant === "chatora") {
          ctx.strokeStyle = C.stripe; ctx.lineWidth = 0.5;
          ctx.beginPath(); ctx.arc(th[0] + 0.6, th[1] + 0.4, 1.4, Math.PI * 0.9, Math.PI * 1.5); ctx.stroke();
          ctx.beginPath(); ctx.arc(th[0] + 0.6, th[1] + 0.4, 0.6, Math.PI * 0.9, Math.PI * 1.5); ctx.stroke();
        }
      },
      // 毛づくろいの前足（口もとへ上げる → 顔をこする）
      groomPaw: function (s, F) {
        const g = groomPhase(s);
        const top = F.pt(CT.frontTop);
        const hp = F.pt(CT.headPivot);
        hp[0] += CT.sitHead[0]; hp[1] += CT.sitHead[1];
        let paw;
        if (g < 0.5) paw = [hp[0] + 1.8, hp[1] + 2.0];
        else {
          const u = (g - 0.5) * 2;
          paw = [hp[0] + 1.4 - Math.sin(u * Math.PI) * 1.6, hp[1] + 1.2 - Math.sin(u * Math.PI) * 2.2];
        }
        const mid = ik(top, paw, 2.9, 2.4, 1);
        return [top, mid, [paw[0] - 0.3, paw[1] + 0.3], paw];
      }
    };

    // ---- 猫：正面と後ろ ----
    function catFace(ctx, s, lw, back, earBack) {
      const C = catCol(s);
      const head = [[-2.1, 0.3], [-2.0, -1.2], [-1.0, -1.9], [0, -2.0], [1.0, -1.9], [2.0, -1.2], [2.1, 0.3], [1.5, 1.4], [0, 1.8], [-1.5, 1.4]];
      // 耳
      [-1, 1].forEach(function (d) {
        ctx.save(); ctx.translate(d * 1.3, -1.5); ctx.rotate(d * (0.25 + earBack * 0.6));
        let col = back ? C.dark : C.base;
        if (s.variant === "mike") col = d < 0 ? C.orange : C.black;
        shape(ctx, [[-0.95, 0.3], [0, -2.5], [0.95, 0.3]], col, lw);
        if (!back) shape(ctx, [[-0.5, 0.1], [0, -1.6], [0.5, 0.1]], "#f2b8b0", lw, null);
        ctx.restore();
      });
      shape(ctx, head, back ? furGrad(ctx, -2, 1.8, C.top, C.dark) : C.base, lw);
      inside(ctx, head, function (c) {
        if (s.variant === "chatora") {
          c.strokeStyle = C.stripe; c.lineWidth = 0.45;
          if (back) {
            for (let i = 0; i < 3; i++) { c.beginPath(); c.moveTo(-1.6 + i * 1.6, -1.9); c.lineTo(-1.4 + i * 1.4, 0.4); c.stroke(); }
          } else {
            c.beginPath(); c.moveTo(-0.5, -1.9); c.lineTo(-0.3, -1.1); c.moveTo(0, -2.0); c.lineTo(0, -1.0); c.moveTo(0.5, -1.9); c.lineTo(0.3, -1.1);
            c.moveTo(-2.1, -0.2); c.lineTo(-1.3, -0.1); c.moveTo(2.1, -0.2); c.lineTo(1.3, -0.1); c.stroke();
          }
        } else if (s.variant === "mike") {
          shape(c, [[-2.4, -2.2], [0.2, -2.3], [-0.2, -0.6], [-1.3, 0.0], [-2.4, 0.2]], C.orange, lw, null);
          shape(c, [[0.4, -2.3], [2.4, -2.0], [2.4, -0.2], [1.2, -0.4], [0.6, -1.0]], C.black, lw, null);
        } else if (s.variant === "hachiware" && !back) {
          // 鼻すじから下が白い「八の字」
          shape(c, [[0, -1.5], [0.7, -0.6], [2.2, 0.3], [1.6, 1.6], [0, 2.0], [-1.6, 1.6], [-2.2, 0.3], [-0.7, -0.6]], C.belly, lw, null);
        }
        if (!back && s.variant === "chatora") oval(c, 0, 0.9, 1.4, 0.8, 0, C.belly, lw, null);
      });
      smooth(ctx, head, true); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
      if (back) return;
      // 目・鼻・口・ひげ
      [-1, 1].forEach(function (d) {
        if (blinking(s) || s.state === "groom" && groomPhase(s) < 0.5) {
          ctx.beginPath(); ctx.moveTo(d * 0.45, -0.45); ctx.quadraticCurveTo(d * 0.9, -0.25, d * 1.35, -0.5);
          ctx.strokeStyle = "#2a2320"; ctx.lineWidth = lw * 0.8; ctx.stroke();
        } else {
          oval(ctx, d * 0.9, -0.5, 0.48, 0.38, d * 0.15, "#cdbf44", lw * 0.6, "rgba(40,30,20,0.7)");
          oval(ctx, d * 0.9, -0.5, 0.12, 0.32, 0, "#1f1a17", lw, null);
          oval(ctx, d * 0.9 + 0.13, -0.65, 0.08, 0.08, 0, "#ffffff", lw, null);
        }
      });
      shape(ctx, [[-0.32, 0.25], [0.32, 0.25], [0, 0.55]], "#d98a8a", lw * 0.5);
      ctx.beginPath(); ctx.moveTo(0, 0.55); ctx.lineTo(0, 0.8);
      ctx.moveTo(-0.5, 0.95); ctx.quadraticCurveTo(-0.2, 1.05, 0, 0.8); ctx.quadraticCurveTo(0.2, 1.05, 0.5, 0.95);
      ctx.strokeStyle = OL; ctx.lineWidth = lw * 0.55; ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 0.17;
      ctx.beginPath();
      [-1, 1].forEach(function (d) {
        ctx.moveTo(d * 0.7, 0.6); ctx.lineTo(d * 3.0, 0.1);
        ctx.moveTo(d * 0.7, 0.75); ctx.lineTo(d * 3.1, 0.8);
        ctx.moveTo(d * 0.7, 0.9); ctx.lineTo(d * 2.8, 1.5);
      });
      ctx.stroke();
      if (s.variant !== "chatora") {
        ctx.strokeStyle = "rgba(60,50,45,0.35)"; ctx.lineWidth = 0.12; ctx.stroke();
      }
    }

    function drawCatFront(ctx, s, lw) {
      const C = catCol(s);
      const lg = frontBackLegs(s, s.state === "run" ? CT.run : CT.walk);
      const sitLike = s.state === "sit" || s.state === "groom";
      const lift = s.state === "run" ? 1.8 : 1.1;
      ctx.save(); ctx.translate(lg.sway * 0.7, 0);
      const legC = function (far) { return far ? C.far : (s.variant === "mike" ? C.base : C.base); };
      const pawC = function (far) { return far ? C.farPaw : C.paw; };
      if (!sitLike) {
        const b = lg.bob;
        // 奥：後ろ足・立てたしっぽ・背中
        straightLeg(ctx, -1.4, -6.6 + b, -2.8, lg.fH * lift * 0.7, 1.5, 0.95, legC(true), pawC(true), 0.55, lw, true);
        straightLeg(ctx, 1.4, -6.6 + b, -2.8, lg.nH * lift * 0.7, 1.5, 0.95, legC(true), pawC(true), 0.55, lw, true);
        const sway = Math.sin((s.t || 0) * 2.1 + s.seed * 7);
        if (s.state !== "run") {
          const ww = s.state === "walk" ? Math.sin((s.phase || 0) * TAU) * 0.5 : sway * 0.7;
          catTail(ctx, s, [[-0.8, -11.6 + b], [-1.8, -13.6 + b], [-2.2 + ww * 0.5, -15.6 + b], [-1.4 + ww, -16.8 + b]], lw);
        }
        const body = lift2([[-2.9, -7.6], [-2.8, -10.6], [-1.6, -12.6], [0, -13.0], [1.6, -12.6], [2.8, -10.6], [2.9, -7.6],
          [1.8, -5.6], [0, -5.3], [-1.8, -5.6]], b);
        shape(ctx, body, furGrad(ctx, -13 + b, -6 + b, C.top, C.base), lw);
        inside(ctx, body, function (c) {
          if (s.variant === "chatora") {
            c.strokeStyle = C.stripe; c.lineWidth = 0.5;
            for (let i = 0; i < 3; i++) { const y = -12.4 + i * 1.3 + b; c.beginPath(); c.moveTo(-2.8, y + 0.5); c.quadraticCurveTo(0, y - 0.3, 2.8, y + 0.5); c.stroke(); }
          } else if (s.variant === "mike") {
            oval(c, -1.3, -11.4 + b, 1.6, 1.1, 0.3, C.orange, lw, null);
            oval(c, 1.5, -10.0 + b, 1.3, 1.1, -0.2, C.black, lw, null);
          }
        });
        smooth(ctx, body, true); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
        // 前足（ハチワレは足先が白）
        [-1, 1].forEach(function (d) {
          const l = d < 0 ? lg.nF : lg.fF;
          straightLeg(ctx, d * 1.2, -6.0 + b, 0, l * lift, 1.5, 1.05, legC(false), pawC(false), 0.62, lw);
          if (s.variant === "hachiware") limb(ctx, [[d * 1.2, -2.6 - l * lift], [d * 1.2, -0.5 - l * lift]], [1.1, 1.05], C.belly, lw, null);
        });
        // 胸
        oval(ctx, 0, -7.4 + b, 2.0, 2.2, 0, s.variant === "mike" ? C.base : C.belly, lw);
      } else {
        // 座る：しっぽを前足に巻く
        oval(ctx, -2.2, -2.2, 1.6, 2.1, 0.2, C.base, lw);
        oval(ctx, 2.2, -2.2, 1.6, 2.1, -0.2, C.base, lw);
        if (s.variant === "mike") oval(ctx, -2.3, -2.6, 1.0, 1.1, 0, C.orange, lw, null);
        oval(ctx, 0, -6.0, 2.7, 3.7, 0, furGrad(ctx, -10, -2, C.top, C.base), lw);
        if (s.variant === "mike") oval(ctx, 1.2, -7.6, 1.2, 1.0, 0.3, C.black, lw, null);
        oval(ctx, 0, -5.8, 1.7, 2.8, 0, s.variant === "mike" ? C.base : C.belly, lw, null);
        const groomUp = s.state === "groom";
        const g = groomPhase(s);
        straightLeg(ctx, -0.9, -5.4, 0, 0, 1.15, 0.95, legC(false), pawC(false), 0.6, lw);
        if (!groomUp) straightLeg(ctx, 0.9, -5.4, 0, 0, 1.15, 0.95, legC(false), pawC(false), 0.6, lw);
        // しっぽ（前足の前を横切る）
        const tip = Math.sin((s.t || 0) * 1.6 + s.seed * 4) * 0.3;
        const tpts = [[2.8, -1.4], [1.8, -0.5], [0, -0.35], [-1.8, -0.5], [-2.6, -1.0 + tip]];
        limb(ctx, tpts, [1.3, 1.25, 1.15, 1.0, 0.8], s.variant === "mike" ? C.orange : C.base, lw);
        if (s.variant === "mike") limb(ctx, tpts.slice(3), [1.0, 0.8], C.black, lw);
        if (s.variant === "chatora") {
          ctx.strokeStyle = C.stripe; ctx.lineWidth = 0.45;
          [1.2, -0.4, -1.8].forEach(function (x) { ctx.beginPath(); ctx.moveTo(x, -0.95); ctx.lineTo(x - 0.1, 0.15); ctx.stroke(); });
        }
        if (groomUp) {
          // 片方の前足を口もとへ
          const u = g < 0.5 ? 0 : Math.sin((g - 0.5) * 2 * Math.PI);
          const px = 0.6 + u * 0.4, py = -10.0 - u * 1.4;
          limb(ctx, [[0.9, -5.6], [1.3, -7.6], [px, py]], [1.15, 1.0, 0.9], legC(false), lw);
          oval(ctx, px, py, 0.6, 0.5, 0, pawC(false), lw);
        }
      }
      // 頭
      let hy = sitLike ? -10.6 : -10.6 + lg.bob;
      let tilt = Math.sin((s.t || 0) * 0.5 + s.seed * 6) * 0.06;
      if (s.state === "groom") {
        const g = groomPhase(s);
        tilt = g < 0.5 ? 0.25 : 0.25 + Math.sin((g - 0.5) * 2 * Math.PI) * 0.2;
        hy += g < 0.5 ? 0.6 + Math.sin(g * 2 * TAU * 2) * 0.2 : 0.2;
      }
      ctx.save(); ctx.translate(0, hy); ctx.rotate(tilt);
      catFace(ctx, s, lw, false, s.state === "run" ? 0.5 : 0);
      ctx.restore();
      if (s.state === "groom" && groomPhase(s) >= 0.5) {
        // 顔をこする前足は頭の手前
        const u = Math.sin((groomPhase(s) - 0.5) * 2 * Math.PI);
        const px = 0.6 + u * 0.4, py = -10.0 - u * 1.4;
        limb(ctx, [[1.3, -7.6], [px, py]], [1.0, 0.9], legC(false), lw);
        oval(ctx, px, py, 0.6, 0.5, 0, pawC(false), lw);
      }
      ctx.restore();
    }

    function drawCatBack(ctx, s, lw) {
      const C = catCol(s);
      const lg = frontBackLegs(s, s.state === "run" ? CT.run : CT.walk);
      const sitLike = s.state === "sit" || s.state === "groom";
      const lift = s.state === "run" ? 1.8 : 1.1;
      ctx.save(); ctx.translate(lg.sway * 0.7, 0);
      // 頭（奥）
      let hy = sitLike ? -10.8 : -13.9 + lg.bob;
      let tilt = 0;
      if (s.state === "groom") { const g = groomPhase(s); tilt = 0.25; hy += g < 0.5 ? 0.7 : 0.3; }
      ctx.save(); ctx.translate(0, hy); ctx.rotate(tilt);
      catFace(ctx, s, lw, true, s.state === "run" ? 0.5 : 0);
      ctx.restore();
      const bodyPts = function (dy) {
        return lift2([[-2.5, -9.6], [-2.2, -11.6], [-1.4, -12.9], [0, -13.3], [1.4, -12.9], [2.2, -11.6], [2.5, -9.6],
          [3.0, -7.4], [2.2, -5.0], [0, -4.6], [-2.2, -5.0], [-3.0, -7.4]], dy);
      };
      if (!sitLike) {
        const b = lg.bob;
        straightLeg(ctx, -1.2, -6.6 + b, -2.8, lg.fF * lift * 0.7, 1.35, 0.9, C.far, C.farPaw, 0.55, lw, true);
        straightLeg(ctx, 1.2, -6.6 + b, -2.8, lg.nF * lift * 0.7, 1.35, 0.9, C.far, C.farPaw, 0.55, lw, true);
        // 後ろ足（手前）。上の端は胴がおおう
        [-1, 1].forEach(function (d) {
          const l = d < 0 ? lg.nH : lg.fH;
          straightLeg(ctx, d * 1.7, -6.0 + b, 0, l * lift, 1.6, 1.0, C.base, C.paw, 0.62, lw);
          if (s.variant === "hachiware") limb(ctx, [[d * 1.7, -2.2 - l * lift], [d * 1.7, -0.5 - l * lift]], [1.05, 1.0], C.belly, lw, null);
        });
        const bp = bodyPts(b);
        shape(ctx, bp, furGrad(ctx, -13.3 + b, -5 + b, C.top, C.base), lw);
        inside(ctx, bp, function (c) {
          if (s.variant === "chatora") {
            c.strokeStyle = C.stripe; c.lineWidth = 0.55;
            for (let i = 0; i < 5; i++) { const y = -12.6 + i * 1.5 + b; c.beginPath(); c.moveTo(-3.0, y + 0.6); c.quadraticCurveTo(0, y - 0.4, 3.0, y + 0.6); c.stroke(); }
          } else if (s.variant === "mike") {
            oval(c, -1.2, -11.0 + b, 1.7, 1.3, 0.3, C.orange, lw, null);
            oval(c, 1.6, -7.6 + b, 1.4, 1.3, -0.2, C.black, lw, null);
          }
          c.strokeStyle = OL_SOFT; c.lineWidth = lw;                          // ももの盛り上がり
          [-1, 1].forEach(function (d) {
            c.beginPath(); c.ellipse(d * 1.6, -6.6 + b, 1.4, 2.0, 0, d < 0 ? 1.6 : -0.3, d < 0 ? 3.4 : 1.5); c.stroke();
          });
        });
        smooth(ctx, bp, true); ctx.strokeStyle = OL; ctx.lineWidth = lw; ctx.stroke();
        // しっぽ（後ろから見ると上へ立つ）
        const sway = Math.sin((s.t || 0) * 2.1 + s.seed * 7);
        if (s.state === "run") {
          catTail(ctx, s, [[0, -7.0 + lg.bob], [0.3, -6.6 + lg.bob], [0.5, -6.2 + lg.bob]], lw);
        } else {
          const w = s.state === "walk" ? Math.sin((s.phase || 0) * TAU) * 0.6 : sway * 0.8;
          catTail(ctx, s, [[0, -6.0 + lg.bob], [1.0 + w * 0.2, -8.6 + lg.bob], [2.4 + w * 0.6, -11.2 + lg.bob], [2.6 + w * 1.2, -13.6 + lg.bob], [1.8 + w * 1.4, -14.6 + lg.bob]], lw);
        }
      } else {
        // 座る：おしりが洋なしの形に広がる
        oval(ctx, 0, -6.4, 2.6, 3.4, 0, furGrad(ctx, -10, -3, C.top, C.base), lw);
        oval(ctx, 0, -2.8, 3.4, 2.8, 0, C.base, lw);
        inside(ctx, [[-3.4, -2.8], [-2.6, -8.8], [0, -9.8], [2.6, -8.8], [3.4, -2.8], [0, 0]], function (c) {
          if (s.variant === "chatora") {
            c.strokeStyle = C.stripe; c.lineWidth = 0.55;
            for (let i = 0; i < 4; i++) { const y = -8.8 + i * 1.5; c.beginPath(); c.moveTo(-3.4, y + 0.6); c.quadraticCurveTo(0, y - 0.4, 3.4, y + 0.6); c.stroke(); }
          } else if (s.variant === "mike") {
            oval(c, -1.4, -6.8, 1.7, 1.3, 0.3, C.orange, lw, null);
            oval(c, 1.5, -3.6, 1.4, 1.2, -0.2, C.black, lw, null);
          }
        });
        // しっぽ（地面ぞいに横へ）
        const tip = Math.sin((s.t || 0) * 1.6 + s.seed * 4) * 0.4;
        catTail(ctx, s, [[0, -0.9], [2.0, -0.6], [3.6, -0.7], [4.6, -1.4 + tip]], lw);
      }
      ctx.restore();
    }

    ANIMAL_ART.cat = {
      size: { w: 20, h: 17 },
      states: ["idle", "walk", "run", "sit", "groom"],
      draw: function (ctx, s0) {
        const s = norm(s0);
        ctx.save();
        const lw = lineW(ctx);
        const C = catCol(s);
        CT.c = { fur: C.base, legFur: C.base, farFur: C.far, paw: C.paw, farPaw: C.farPaw };
        if (s.view === "front") drawCatFront(ctx, s, lw);
        else if (s.view === "back") drawCatBack(ctx, s, lw);
        else drawSide(ctx, CT, s, catSideParts);
        ctx.restore();
      }
    };
  })();

  // ------------------------------------------------------------
  // 動物の絵：ウサギ（rabbit）・アヒル（duck）
  //   原点＝足元の中心（アヒルが水に浮いているときは、水面の中心）。上が −y。右向きの横向きが基本。
  //   1マス＝45px（ART_PX）の物差しで描く。影は描かない（仕組みの側で描く）。
  // ------------------------------------------------------------

  // ウサギ（野ウサギ風の茶色）。状態：idle／walk／hop／alert
  ANIMAL_ART.rabbit = (function () {
    const OL = "rgba(40,30,20,0.55)";   // 輪郭（COLORS.outline と同じ色）
    let LW = 0.8;                        // 輪郭の太さ（外に見える分）。組み込みで変更：draw のはじめに画面上の倍率で決め直す
    // 組み込みで追加：輪郭の太さを画面上の倍率に合わせる（柴犬・猫と同じ決め方。倍率1で0.8、拡大したときだけ √倍率 で少し太く）
    function outlineW(ctx) {
      const m = ctx.getTransform();
      const sc = Math.max(0.01, Math.hypot(m.a, m.b));
      return (sc <= 1 ? 0.8 : 0.8 * Math.sqrt(sc)) / sc;
    }

    function lerp(a, b, u) { return a + (b - a) * u; }
    function smooth(u) { return u * u * (3 - 2 * u); }
    function ell(ctx, x, y, rx, ry, rot) { const r = rot || 0; ctx.moveTo(x + Math.max(rx, 0.01) * Math.cos(r), y + Math.max(rx, 0.01) * Math.sin(r)); ctx.ellipse(x, y, Math.max(rx, 0.01), Math.max(ry, 0.01), r, 0, Math.PI * 2); }
    function rgb(r, g, b) { return "rgb(" + Math.round(r) + "," + Math.round(g) + "," + Math.round(b) + ")"; }

    // 個体ごとの毛色（背中の茶を少しだけ変える）
    function palette(seed) {
      const d = (seed - 0.5) * 18;
      return {
        backDark: rgb(118 + d, 86 + d * 0.8, 58 + d * 0.5),     // 背中の筋
        back: rgb(156 + d, 118 + d * 0.8, 82 + d * 0.5),        // 背中
        flank: rgb(190 + d, 154 + d * 0.8, 112 + d * 0.5),      // 脇腹
        belly: "#f2ebdf",                                       // 腹
        far: rgb(128 + d, 96 + d * 0.8, 66 + d * 0.5),          // 向こう側の足・耳（陰）
        earIn: "#dcbca4", earTip: "#3f3026",
        eyeRing: "#e2d2b8", eye: "#22160e", nose: "#c49488", tail: "#fbf8f2"
      };
    }

    // 個体ごとに決まる乱数（模様の点の位置など）
    function rnd(seed, i) { const x = Math.sin(seed * 97.13 + i * 12.9898) * 43758.5453; return x - Math.floor(x); }

    // 輪郭つきの線（足）。pts＝点の並び、w＝太さ
    function limb(ctx, pts, w, col) {
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = OL; ctx.lineWidth = w + LW * 2; ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
    }

    // 耳の形（耳の付け根が原点、−y へのびる）
    function earPath(ctx, len, w) {
      ctx.beginPath();
      ctx.moveTo(-w * 0.45, 0);
      ctx.quadraticCurveTo(-w * 0.8, -len * 0.5, -w * 0.28, -len * 0.94);
      ctx.quadraticCurveTo(0, -len * 1.06, w * 0.3, -len * 0.92);
      ctx.quadraticCurveTo(w * 0.7, -len * 0.45, w * 0.42, 0);
      ctx.closePath();
    }
    // 耳を1枚描く。ang＝向き（0＝真上、マイナス＝後ろへ倒す）、inner＝内側の色を見せるか
    function ear(ctx, x, y, ang, len, w, col, c, inner) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      earPath(ctx, len, w);
      ctx.strokeStyle = OL; ctx.lineWidth = LW * 2; ctx.stroke();
      ctx.fillStyle = col; ctx.fill();
      ctx.save(); ctx.clip();
      if (inner) {                                            // 内側（うすいピンクがかったベージュ）
        ctx.fillStyle = c.earIn; ctx.beginPath(); ell(ctx, w * 0.12, -len * 0.5, w * 0.24, len * 0.4); ctx.fill();
      }
      ctx.fillStyle = c.earTip; ctx.fillRect(-w, -len * 1.2, w * 2, len * 0.3);   // 耳の先の黒っぽいふち
      ctx.restore();
      ctx.restore();
    }

    // 目（まばたきつき）
    function eye(ctx, x, y, r, c, blink) {
      ctx.fillStyle = c.eyeRing; ctx.beginPath(); ell(ctx, x, y, r * 1.45, r * 1.35); ctx.fill();
      ctx.fillStyle = c.eye; ctx.beginPath(); ell(ctx, x, y, r, r * (blink ? 0.18 : 1)); ctx.fill();
      if (!blink) { ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.beginPath(); ell(ctx, x - r * 0.35, y - r * 0.35, r * 0.34, r * 0.34); ctx.fill(); }
    }

    // 跳ねる（hop）の流れ：かがむ → 後ろ足でける → 体がのびて宙に → 前足で着く → 後ろ足が前へ → かがむ
    //   s＝体ののび、lift＝浮く高さ、pitch＝体の傾き（マイナス＝頭が上）、hind＝後ろ足（0＝たたむ／1＝後ろへのばす）、
    //   fore＝前足（−1＝後ろ／0＝下／1＝前へ）、ear＝耳の倒れ（0＝立つ／1＝寝る）
    const HOP = [
      [0.00, { s: 0.10, lift: 0.0, pitch: 0.06, hind: 0.00, fore: -0.2, ear: 0.45 }],
      [0.20, { s: 0.55, lift: 0.9, pitch: -0.20, hind: 0.70, fore: 0.10, ear: 0.60 }],
      [0.42, { s: 1.00, lift: 4.0, pitch: -0.04, hind: 1.00, fore: 0.90, ear: 0.80 }],
      [0.62, { s: 0.75, lift: 1.4, pitch: 0.20, hind: 0.75, fore: 0.30, ear: 0.70 }],
      [0.80, { s: 0.30, lift: 0.4, pitch: 0.12, hind: 0.20, fore: -0.3, ear: 0.55 }],
      [1.00, { s: 0.10, lift: 0.0, pitch: 0.06, hind: 0.00, fore: -0.2, ear: 0.45 }]
    ];
    function keyPose(K, ph) {
      ph = ((ph % 1) + 1) % 1;
      for (let i = 0; i < K.length - 1; i++) {
        if (ph >= K[i][0] && ph <= K[i + 1][0]) {
          const u = smooth((ph - K[i][0]) / (K[i + 1][0] - K[i][0])), a = K[i][1], b = K[i + 1][1], o = {};
          Object.keys(a).forEach(function (k) { o[k] = lerp(a[k], b[k], u); });
          return o;
        }
      }
      return K[0][1];
    }

    // 状態ごとの姿勢
    function pose(s) {
      const t = s.t || 0, ph = s.phase || 0, sd = s.seed || 0;
      const p = { s: 0.3, lift: 0, pitch: 0.04, hind: 0, foreN: -0.1, foreF: 0.1, ear: 0.4, earF: 0.4, head: 0, sitUp: 0, nose: 0 };
      if (s.state === "hop") {
        const k = keyPose(HOP, ph);
        p.s = k.s; p.lift = k.lift; p.pitch = k.pitch; p.hind = k.hind;
        p.foreN = k.fore; p.foreF = k.fore - 0.25; p.ear = k.ear; p.earF = k.ear + 0.06;
      } else if (s.state === "walk") {
        // ゆっくり歩く：前足を片方ずつ前へ出し、後ろ足は小さく寄せる
        const a = Math.sin(ph * Math.PI * 2), b = Math.cos(ph * Math.PI * 2);
        p.s = 0.4 + 0.15 * a; p.lift = Math.max(0, -b) * 0.6; p.pitch = 0.05 + 0.04 * b;
        p.hind = 0.15 + 0.15 * Math.max(0, a);
        p.foreN = 0.55 * a; p.foreF = -0.55 * a;
        p.ear = 0.35 + 0.05 * b; p.earF = p.ear + 0.06;
      } else if (s.state === "alert") {
        // 耳をまっすぐ立て、胸を起こして止まる。耳だけ少し向きを変える
        p.s = 0.2; p.pitch = -0.30; p.sitUp = 1; p.hind = 0; p.foreN = 0; p.foreF = 0.1;
        p.ear = 0.02 + 0.03 * Math.sin(t * 1.7 + sd * 6); p.earF = 0.06 + 0.03 * Math.sin(t * 1.3 + sd * 4);
        p.head = -0.12;
      } else {
        // idle：鼻をひくひく、耳と頭がときどき少し動く
        p.ear = 0.42 + 0.06 * Math.sin(t * 0.9 + sd * 6); p.earF = p.ear + 0.08;
        p.head = 0.04 * Math.sin(t * 0.6 + sd * 3);
        p.s = 0.28 + 0.02 * Math.sin(t * 2.4);              // 呼吸
      }
      const tw = (t * 1.0 + sd * 5) % 2.6;                  // 鼻のひくひく（しばらく続いて、少し休む）
      p.nose = tw < 1.4 ? Math.sin(t * 22) * 0.28 : 0;
      p.blink = ((t + sd * 7) % 4.3) < 0.12;
      return p;
    }

    // 横向き（右向き）
    function drawSide(ctx, s, c) {
      const p = pose(s);
      const baseY = -4.3 - p.lift - p.s * 0.4 - p.sitUp * 0.6;   // 体の中心の高さ
      const hx = -3.0 - p.s * 0.9, cx = 1.9 + p.s * 1.5;          // おしり・胸の中心（体の中で）
      const cy = -0.3 - p.sitUp * 1.4;
      const cs = Math.cos(p.pitch), sn = Math.sin(p.pitch);
      const W = function (lx, ly) { return { x: lx * cs - ly * sn, y: baseY + lx * sn + ly * cs }; };   // 体の中の点 → 絵の点
      const ground = 0;

      // 頭の位置（胸の前上）
      const head = W(cx + 2.7 + p.s * 0.5, cy - 3.0 + p.s * 0.8 - p.sitUp * 0.6);
      const hr = p.pitch * 0.6 - 0.25 + p.head;                   // 頭の傾き（鼻先が少し下）

      // 後ろ足（かかと H と つま先 T）
      const J = W(hx + 0.6, 2.0);
      const footAt = function (dx) {
        const hk = { x: lerp(J.x - 3.4, J.x - 3.6, p.hind) + dx, y: lerp(ground - 0.9, J.y + 2.6, p.hind) };
        const toe = { x: lerp(hk.x + 5.0, hk.x - 3.4, p.hind), y: lerp(ground - 0.35, hk.y + 2.0, p.hind) };
        if (toe.y > ground - 0.3) toe.y = ground - 0.3;
        if (hk.y > ground - 0.7) hk.y = ground - 0.7;
        return { H: hk, T: toe };
      };
      // 前足（肩 S から足先まで）
      const S = W(cx + 0.8, 1.6);
      const pawAt = function (f, dx) {
        const reach = f >= 0 ? f : f * 0.7;
        const px = S.x + dx + reach * 3.0;
        const py = Math.min(ground - 0.35, S.y + 4.2 - Math.max(0, f) * 1.2);
        return [S, { x: (S.x + px) / 2 + 0.2, y: (S.y + py) / 2 }, { x: px, y: py }];
      };

      // 1. 向こう側の耳・足（陰の色）
      ctx.save(); ctx.translate(head.x, head.y); ctx.rotate(hr);
      ear(ctx, -1.3, -1.5, -0.15 - p.earF * 1.1, 6.0, 1.5, c.far, c, false);
      ctx.restore();
      const ff = footAt(1.1);
      limb(ctx, [J, ff.H], 1.6, c.far); limb(ctx, [ff.H, ff.T], 1.2, c.far);
      limb(ctx, pawAt(p.foreF, -0.6), 1.0, c.far);
      const fn = footAt(0);
      limb(ctx, [J, fn.H], 1.9, c.flank);                            // 手前の後ろ足のすね（上は胴に隠れる）

      // 2. 胴（おしり・胴・胸を1つの形として、外側だけに輪郭）
      ctx.save(); ctx.translate(0, baseY); ctx.rotate(p.pitch);
      const parts = function () {
        ell(ctx, hx, 0.2, 4.3, 3.9, 0);
        ctx.moveTo((hx + cx) / 2 + (cx - hx) / 2 + 1, -0.4);
        ell(ctx, (hx + cx) / 2, -0.4, (cx - hx) / 2 + 1.2, 3.1, 0);
        ctx.moveTo(cx + 3.2, cy);
        ell(ctx, cx, cy, 3.2, 2.9, 0);
      };
      ctx.beginPath(); parts(); ctx.strokeStyle = OL; ctx.lineWidth = LW * 2; ctx.stroke();
      ctx.beginPath(); parts(); ctx.save(); ctx.clip();
      const g = ctx.createLinearGradient(0, -4.4, 0, 4.2);         // 背中の濃い茶 → 脇腹 → 白っぽい腹
      g.addColorStop(0, c.backDark); g.addColorStop(0.3, c.back); g.addColorStop(0.62, c.flank); g.addColorStop(0.84, c.belly);
      ctx.fillStyle = g; ctx.fillRect(-12, -8, 24, 14);
      ctx.strokeStyle = "rgba(70,48,30,0.35)"; ctx.lineWidth = 0.5;  // もものふくらみ（大きな後ろ足）
      ctx.beginPath(); ctx.arc(hx + 0.4, 0.6, 2.9, Math.PI * 0.55, Math.PI * 1.45); ctx.stroke();
      ctx.fillStyle = "rgba(60,40,25,0.35)";                          // 毛のまだら（背中の細かい点）
      for (let i = 0; i < 9; i++) {
        const u = rnd(s.seed || 0, i);
        ctx.fillRect(lerp(hx - 2, cx + 1, u) , -3.4 + rnd(s.seed || 0, i + 20) * 2.2, 0.5, 0.4);
      }
      ctx.restore();
      ctx.restore();

      // 3. 手前の後ろ足・前足
      limb(ctx, [fn.H, fn.T], 1.25, c.flank);
      ctx.fillStyle = c.belly; ctx.beginPath(); ell(ctx, fn.T.x, fn.T.y, 0.7, 0.4); ctx.fill();    // つま先の白っぽい毛
      limb(ctx, pawAt(p.foreN, 0), 1.05, c.flank);

      // 4. 頭（ほお・目・鼻）
      ctx.save(); ctx.translate(head.x, head.y); ctx.rotate(hr);
      ctx.beginPath(); ell(ctx, 0, 0, 3.0, 2.5, 0); ell(ctx, 1.7, 0.6, 1.5, 1.4, 0);
      ctx.strokeStyle = OL; ctx.lineWidth = LW * 2; ctx.stroke();
      ctx.beginPath(); ell(ctx, 0, 0, 3.0, 2.5, 0); ell(ctx, 1.7, 0.6, 1.5, 1.4, 0);
      ctx.save(); ctx.clip();
      const gh = ctx.createLinearGradient(0, -2.6, 0, 2.4);
      gh.addColorStop(0, c.back); gh.addColorStop(0.55, c.flank); gh.addColorStop(1, c.belly);
      ctx.fillStyle = gh; ctx.fillRect(-4, -3, 8, 6);
      ctx.restore();
      eye(ctx, 0.7, -0.5, 0.75, c, p.blink);
      ctx.fillStyle = c.nose; ctx.beginPath(); ell(ctx, 3.0, 0.5 + p.nose, 0.45, 0.35); ctx.fill();
      ear(ctx, -0.6, -1.7, -0.12 - p.ear * 1.1, 6.2, 1.6, c.back, c, true);
      ctx.restore();

      // 5. しっぽ（白い丸）
      const tp = W(hx - 4.0, -1.4);
      ctx.beginPath(); ell(ctx, tp.x, tp.y, 1.35, 1.25);
      ctx.strokeStyle = OL; ctx.lineWidth = LW * 1.6; ctx.stroke(); ctx.fillStyle = c.tail; ctx.fill();
    }

    // 正面（こちらへ向かう）と後ろ（向こうへ行く）
    function drawFrontBack(ctx, s, c, back) {
      const p = pose(s);
      const lift = p.lift, sy = 1 + (p.s - 0.4) * 0.12 + p.sitUp * 0.12;   // 縦の伸び縮み
      const by = -4.2 - lift;
      // 後ろ足（地面の上の足。跳んでいる間は浮く）
      const hfY = Math.min(-0.5, -0.5 - lift + p.hind * 2.5);
      ctx.save();
      [-1, 1].forEach(function (d) {
        ctx.beginPath(); ell(ctx, d * 2.7, hfY, 1.5, back ? 1.0 : 0.75);
        ctx.strokeStyle = OL; ctx.lineWidth = LW * 2; ctx.stroke();
        ctx.fillStyle = back ? c.belly : c.flank; ctx.fill();
      });
      ctx.restore();
      // 胴（大きく丸いおしりと胸）
      ctx.save(); ctx.translate(0, by); ctx.scale(1, sy);
      const body = function () { ell(ctx, 0, 0.2, 4.3, 4.0); ctx.moveTo(3, -1.2); ell(ctx, 0, -1.2, 3.0, 3.0); };
      ctx.beginPath(); body(); ctx.strokeStyle = OL; ctx.lineWidth = LW * 2; ctx.stroke();
      ctx.beginPath(); body(); ctx.save(); ctx.clip();
      const g = ctx.createLinearGradient(0, -4.2, 0, 4.2);
      g.addColorStop(0, c.backDark); g.addColorStop(0.4, c.back); g.addColorStop(1, c.flank);
      ctx.fillStyle = g; ctx.fillRect(-6, -6, 12, 12);
      if (!back) {                                                        // 胸と腹の白っぽい毛
        ctx.fillStyle = c.belly; ctx.beginPath(); ell(ctx, 0, 1.0, 2.2, 3.0); ctx.fill();
      } else {
        ctx.fillStyle = "rgba(90,62,40,0.35)"; ctx.fillRect(-0.4, -4.2, 0.8, 4.0);   // 背骨の筋
      }
      ctx.restore();
      ctx.restore();
      // 前足（正面だけ見える。歩くときは片方ずつ）
      if (!back) {
        [-1, 1].forEach(function (d) {
          const f = d < 0 ? p.foreN : p.foreF;
          const py = Math.min(-0.4, -0.4 - lift * 0.6 - Math.max(0, f) * 0.8);
          limb(ctx, [{ x: d * 1.1, y: by + 2.4 }, { x: d * 1.15, y: py }], 0.9, c.flank);
        });
      } else {
        // しっぽ（後ろから大きく見える白い丸）
        ctx.beginPath(); ell(ctx, 0, by + 2.0 * sy, 1.7, 1.5);
        ctx.strokeStyle = OL; ctx.lineWidth = LW * 1.6; ctx.stroke(); ctx.fillStyle = c.tail; ctx.fill();
      }
      // 頭と耳
      const hy = by - 4.9 * sy - p.sitUp * 0.6;
      const earLen = 6.2 * (1 - p.ear * 0.55);                          // 後ろへ倒すほど短く見える
      const spread = 0.12 + p.ear * 0.1;
      if (!back) {
        ear(ctx, -1.0, hy - 1.6, -spread, earLen, 1.6, c.back, c, true);
        ear(ctx, 1.0, hy - 1.6, spread, earLen, 1.6, c.back, c, true);
      }
      ctx.beginPath(); ell(ctx, 0, hy, 2.8, 2.5); ell(ctx, 0, hy + 1.0, 2.4, 1.8);
      ctx.strokeStyle = OL; ctx.lineWidth = LW * 2; ctx.stroke();
      ctx.beginPath(); ell(ctx, 0, hy, 2.8, 2.5); ell(ctx, 0, hy + 1.0, 2.4, 1.8);
      ctx.save(); ctx.clip();
      const gh = ctx.createLinearGradient(0, hy - 2.6, 0, hy + 2.8);
      gh.addColorStop(0, back ? c.backDark : c.back); gh.addColorStop(0.6, back ? c.back : c.flank); gh.addColorStop(1, back ? c.flank : c.belly);
      ctx.fillStyle = gh; ctx.fillRect(-4, hy - 3, 8, 7);
      ctx.restore();
      if (!back) {
        eye(ctx, -1.75, hy - 0.4, 0.62, c, p.blink); eye(ctx, 1.75, hy - 0.4, 0.62, c, p.blink);
        ctx.fillStyle = c.belly; ctx.beginPath(); ell(ctx, 0, hy + 1.3, 1.1, 0.8); ctx.fill();   // 口もと
        ctx.fillStyle = c.nose; ctx.beginPath(); ell(ctx, 0, hy + 0.8 + p.nose * 0.6, 0.45, 0.32); ctx.fill();
      } else {
        ear(ctx, -1.0, hy - 1.4, -spread, earLen, 1.6, c.back, c, false);
        ear(ctx, 1.0, hy - 1.4, spread, earLen, 1.6, c.back, c, false);
      }
    }

    return {
      size: { w: 19, h: 17 },          // 横向き・止まっているとき（しっぽ〜鼻先 約19px、耳の先まで 約17px）
      states: ["idle", "walk", "hop", "alert"],
      draw: function (ctx, s) {
        LW = outlineW(ctx);
        const c = palette(s.seed || 0);
        ctx.save();
        if (s.view === "front") drawFrontBack(ctx, s, c, false);
        else if (s.view === "back") drawFrontBack(ctx, s, c, true);
        else drawSide(ctx, s, c);
        ctx.restore();
      }
    };
  })();

  // アヒル（白い家鴨）。状態：idle／walk／swim／dabble
  //   swim・dabble のときは、原点＝水面の中心。水面より下は絵の側で切る（うすく水の中の体と足だけ見せる）。波紋も絵の側で描く。
  ANIMAL_ART.duck = (function () {
    const OL = "rgba(40,30,20,0.55)";
    let LW = 0.8;                        // 組み込みで変更：draw のはじめに画面上の倍率で決め直す
    // 組み込みで追加：輪郭の太さを画面上の倍率に合わせる（柴犬・猫と同じ決め方。倍率1で0.8、拡大したときだけ √倍率 で少し太く）
    function outlineW(ctx) {
      const m = ctx.getTransform();
      const sc = Math.max(0.01, Math.hypot(m.a, m.b));
      return (sc <= 1 ? 0.8 : 0.8 * Math.sqrt(sc)) / sc;
    }
    const C = {
      top: "#fffefa", mid: "#f6f2e8", under: "#d8dde5",      // 白い羽（上・横・陰になる腹）
      wingLine: "rgba(120,118,128,0.5)",
      bill: "#f29a2e", billDark: "#d97a18", nail: "#f6c27a",
      leg: "#f08b26", legFar: "#cf6f17",
      eye: "#1f1a16", water: "rgba(255,255,255,0.75)", deep: "rgba(40,90,140,0.25)"
    };

    function lerp(a, b, u) { return a + (b - a) * u; }
    function smooth(u) { return u * u * (3 - 2 * u); }
    function ell(ctx, x, y, rx, ry, rot) { const r = rot || 0; ctx.moveTo(x + Math.max(rx, 0.01) * Math.cos(r), y + Math.max(rx, 0.01) * Math.sin(r)); ctx.ellipse(x, y, Math.max(rx, 0.01), Math.max(ry, 0.01), r, 0, Math.PI * 2); }

    // 水かきのある足（横から）。x,y＝かかと、lift＝足を上げる量、col＝色
    function footSide(ctx, x, y, lift, col) {
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(x, y - 3.2); ctx.lineTo(x, y - lift);
      ctx.strokeStyle = OL; ctx.lineWidth = 1.0 + LW * 2; ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 1.0; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 0.6, y - lift); ctx.lineTo(x + 2.6, y - lift - 0.1 + lift * 0.3); ctx.lineTo(x + 2.2, y - lift - 0.9); ctx.closePath();
      ctx.strokeStyle = OL; ctx.lineWidth = LW * 1.6; ctx.stroke();
      ctx.fillStyle = col; ctx.fill();
    }

    // 横向きの体（首・頭・体・しっぽを1つの形として描く）。o＝姿勢
    function bodySide(ctx, o, seed) {
      const hx = o.hx, hy = o.hy;                       // 頭の中心
      const shapes = function (forStroke) {
        ctx.beginPath();
        ell(ctx, -0.6, -6.0, 6.8, 3.9, -0.16);          // 体
        ctx.moveTo(5.2, -6.4); ell(ctx, 2.2, -6.4, 3.4, 3.7, 0);   // ふっくらした胸
        ctx.moveTo(-5.0, -8.0);                         // しっぽ（少し上を向いてとがる）
        ctx.lineTo(-8.6 - o.tail * 0.3, -9.6 + o.tail * 0.4); ctx.lineTo(-6.0, -5.6); ctx.closePath();
        ctx.moveTo(hx + 2.6, hy); ell(ctx, hx, hy, 2.6, 2.3, 0);   // 頭
        if (forStroke) { ctx.strokeStyle = OL; ctx.lineWidth = LW * 2; ctx.stroke(); }
      };
      const neck = function (w, col) {                  // 首（太い線）
        ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(2.6, -7.6); ctx.quadraticCurveTo(3.2 + (hx - 5) * 0.3, (hy - 7.6) * 0.5 - 3.5, hx - 0.4, hy + 0.8);
        ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
      };
      neck(3.4 + LW * 2, OL); shapes(true);             // 先に輪郭だけ描き、上から中を塗る（つなぎ目に線が出ない）
      shapes(false); ctx.fillStyle = C.mid; ctx.fill();
      neck(3.4, C.mid);
      // 体の陰（上が明るく、腹側がうすい灰色）
      ctx.save();
      ctx.beginPath(); ell(ctx, -0.6, -6.0, 6.8, 3.9, -0.16); ctx.moveTo(5.2, -6.4); ell(ctx, 2.2, -6.4, 3.4, 3.7, 0); ctx.clip();
      const g = ctx.createLinearGradient(0, -10.2, 0, -2.0);
      g.addColorStop(0, C.top); g.addColorStop(0.5, C.mid); g.addColorStop(1, C.under);
      ctx.fillStyle = g; ctx.fillRect(-9, -11, 18, 10);
      ctx.restore();
      // つばさ（うすい線で輪郭と羽の重なり）
      ctx.strokeStyle = C.wingLine; ctx.lineWidth = 0.55;
      ctx.beginPath(); ctx.moveTo(3.4, -7.6); ctx.quadraticCurveTo(-1.0, -9.4, -6.2, -8.2);
      ctx.quadraticCurveTo(-3.0, -4.6, 2.2, -5.4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-1.0, -6.0); ctx.lineTo(-5.4, -7.6); ctx.moveTo(-0.2, -6.9); ctx.lineTo(-4.4, -8.2); ctx.stroke();
      // 雄の巻き毛（個体によって）
      if (seed > 0.5) {
        ctx.beginPath(); ctx.arc(-7.4, -10.0, 0.8, Math.PI * 0.2, Math.PI * 1.5); ctx.stroke();
      }
      // 頭の陰
      ctx.save(); ctx.beginPath(); ell(ctx, hx, hy, 2.6, 2.3, 0); ctx.clip();
      const gh = ctx.createLinearGradient(0, hy - 2.4, 0, hy + 2.4);
      gh.addColorStop(0, C.top); gh.addColorStop(1, "#e8e9ec");
      ctx.fillStyle = gh; ctx.fillRect(hx - 3, hy - 3, 6, 6);
      ctx.restore();
      // くちばし（平たく、先に爪）
      ctx.beginPath();
      ctx.moveTo(hx + 1.6, hy - 0.6); ctx.quadraticCurveTo(hx + 3.8, hy - 0.4, hx + 5.0, hy + 0.3);
      ctx.quadraticCurveTo(hx + 5.0, hy + 1.0, hx + 4.2, hy + 1.0); ctx.lineTo(hx + 1.8, hy + 1.0); ctx.closePath();
      ctx.strokeStyle = OL; ctx.lineWidth = LW * 1.6; ctx.stroke();
      ctx.fillStyle = C.bill; ctx.fill();
      ctx.strokeStyle = C.billDark; ctx.lineWidth = 0.4;
      ctx.beginPath(); ctx.moveTo(hx + 2.0, hy + 0.55); ctx.lineTo(hx + 4.6, hy + 0.6); ctx.stroke();   // くちばしの合わせ目
      ctx.fillStyle = C.nail; ctx.beginPath(); ell(ctx, hx + 4.6, hy + 0.35, 0.4, 0.3); ctx.fill();
      // 目
      ctx.fillStyle = C.eye; ctx.beginPath(); ell(ctx, hx + 0.6, hy - 0.6, 0.55, o.blink ? 0.1 : 0.55); ctx.fill();
      if (!o.blink) { ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.beginPath(); ell(ctx, hx + 0.45, hy - 0.8, 0.2, 0.2); ctx.fill(); }
    }

    // 正面・後ろの体
    function bodyFB(ctx, o, back) {
      const hx = o.hx, hy = o.hy;
      const shapes = function () {
        ctx.beginPath();
        ell(ctx, 0, -5.3, 5.0, 4.3, 0);                 // 体（正面は胸、後ろはおしり。下がふくらんだ洋なし形）
        ell(ctx, 0, -7.6, 3.5, 3.0, 0);                 // 肩
        ell(ctx, 0, -9.9, 1.9, 2.0, 0);                 // 首
        ell(ctx, hx, hy, 2.25, 2.2, 0);                 // 頭
      };
      shapes(); ctx.strokeStyle = OL; ctx.lineWidth = LW * 2; ctx.stroke();
      shapes(); ctx.fillStyle = C.mid; ctx.fill();
      ctx.save(); ctx.beginPath(); ell(ctx, 0, -5.3, 5.0, 4.3, 0); ell(ctx, 0, -7.6, 3.5, 3.0, 0); ctx.clip();
      const g = ctx.createLinearGradient(0, -10.6, 0, -1.0);
      g.addColorStop(0, C.top); g.addColorStop(0.55, C.mid); g.addColorStop(1, C.under);
      ctx.fillStyle = g; ctx.fillRect(-6, -11, 12, 10);
      ctx.strokeStyle = C.wingLine; ctx.lineWidth = 0.55;              // 両わきのつばさの線
      if (!back) {
        ctx.beginPath(); ctx.moveTo(-3.4, -8.8); ctx.quadraticCurveTo(-2.6, -5.0, -3.8, -2.4);
        ctx.moveTo(3.4, -8.8); ctx.quadraticCurveTo(2.6, -5.0, 3.8, -2.4); ctx.stroke();
      } else {                                                         // 後ろ：たたんだつばさの先が腰の上で重なる
        ctx.beginPath(); ctx.moveTo(-3.6, -8.6); ctx.quadraticCurveTo(-1.6, -5.6, -0.3, -3.0);
        ctx.moveTo(3.6, -8.6); ctx.quadraticCurveTo(1.6, -5.6, 0.3, -3.0); ctx.stroke();
      }
      ctx.restore();
      ctx.save(); ctx.beginPath(); ell(ctx, hx, hy, 2.25, 2.2, 0); ctx.clip();
      const gh = ctx.createLinearGradient(0, hy - 2.4, 0, hy + 2.4);
      gh.addColorStop(0, C.top); gh.addColorStop(1, "#e6e8ec");
      ctx.fillStyle = gh; ctx.fillRect(hx - 3, hy - 3, 6, 6);
      ctx.restore();
      if (!back) {
        // くちばし（こちらを向いて、手前に平たくのびる）
        ctx.beginPath();
        ctx.moveTo(hx - 1.2, hy + 0.1); ctx.quadraticCurveTo(hx, hy - 0.5, hx + 1.2, hy + 0.1);
        ctx.quadraticCurveTo(hx + 1.6, hy + 1.9, hx, hy + 2.3); ctx.quadraticCurveTo(hx - 1.6, hy + 1.9, hx - 1.2, hy + 0.1);
        ctx.strokeStyle = OL; ctx.lineWidth = LW * 1.6; ctx.stroke(); ctx.fillStyle = C.bill; ctx.fill();
        ctx.fillStyle = C.billDark; ctx.fillRect(hx - 0.5, hy + 0.5, 0.25, 0.3); ctx.fillRect(hx + 0.25, hy + 0.5, 0.25, 0.3);   // 鼻の穴
        ctx.fillStyle = C.eye;
        [-1, 1].forEach(function (d) { ctx.beginPath(); ell(ctx, hx + d * 1.6, hy - 0.7, 0.42, o.blink ? 0.08 : 0.45); ctx.fill(); });
      } else {
        // しっぽ（腰の上にとがって立つ。頭と重なるので、うすい線で形だけ見せる）
        ctx.beginPath(); ctx.moveTo(-1.5, -8.0); ctx.lineTo(o.tail * 0.4, -10.4); ctx.lineTo(1.5, -8.0);
        ctx.fillStyle = C.top; ctx.fill(); ctx.strokeStyle = C.wingLine; ctx.lineWidth = 0.6; ctx.stroke();
        // 雄はしっぽの先が巻く
        if (o.curl) {
          ctx.strokeStyle = C.wingLine; ctx.lineWidth = 0.55;
          ctx.beginPath(); ctx.arc(o.tail * 0.4, -10.9, 0.55, Math.PI * 0.6, Math.PI * 2.0); ctx.stroke();
        }
      }
    }

    // 水かき（正面・後ろ）
    function footFB(ctx, x, lift, col, back) {
      ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(x, -3.0); ctx.lineTo(x, -0.6 - lift);
      ctx.strokeStyle = OL; ctx.lineWidth = 1.0 + LW * 2; ctx.stroke(); ctx.strokeStyle = col; ctx.lineWidth = 1.0; ctx.stroke();
      ctx.beginPath();
      if (back) { ell(ctx, x, -0.5 - lift, 1.2, 0.5, 0); }
      else { ctx.moveTo(x, -0.8 - lift); ctx.lineTo(x + 1.5, -0.1 - lift); ctx.lineTo(x - 1.5, -0.1 - lift); ctx.closePath(); }
      ctx.strokeStyle = OL; ctx.lineWidth = LW * 1.6; ctx.stroke(); ctx.fillStyle = col; ctx.fill();
    }

    // 水面の波紋。half＝"back"（奥の半分。体より先に描く）／"front"（手前の半分）
    function ripples(ctx, s, half, strong) {
      const t = s.t || 0, sd = s.seed || 0;
      const a0 = half === "back" ? Math.PI : 0, a1 = a0 + Math.PI;
      ctx.lineWidth = 0.6;
      for (let i = 0; i < 2; i++) {
        const u = ((t * 0.45 + i * 0.5 + sd) % 1 + 1) % 1;
        const rx = 7.5 + u * 6.5;
        ctx.strokeStyle = "rgba(255,255,255," + ((1 - u) * (strong ? 0.7 : 0.45)).toFixed(3) + ")";
        ctx.beginPath(); ctx.ellipse(0, 0, rx, rx * 0.3, 0, a0, a1); ctx.stroke();
      }
      ctx.strokeStyle = C.water; ctx.lineWidth = 0.8;                 // 体のまわりの水ぎわの光
      ctx.beginPath(); ctx.ellipse(0, 0, 7.0, 1.9, 0, a0, a1); ctx.stroke();
    }

    // 水面より上だけ描く／水の中をうすく描く
    function aboveWater(ctx, fn) { ctx.save(); ctx.beginPath(); ctx.rect(-40, -60, 80, 60); ctx.clip(); fn(); ctx.restore(); }
    function underWater(ctx, fn) { ctx.save(); ctx.beginPath(); ctx.rect(-40, 0, 80, 20); ctx.clip(); ctx.globalAlpha = 0.18; fn(); ctx.restore(); }

    // 状態ごとの姿勢
    function pose(s) {
      const t = s.t || 0, ph = s.phase || 0, sd = s.seed || 0, P2 = Math.PI * 2;
      const o = { hx: 5.4, hy: -12.6, rot: 0, bob: 0, tail: 0, legA: 0, legB: 0, liftA: 0, liftB: 0, tip: 0, curl: sd > 0.5 };
      o.blink = ((t + sd * 5) % 3.7) < 0.11;
      if (s.state === "walk") {
        // よちよち：体を左右にゆすり、足を交互に出す
        const a = Math.sin(ph * P2);
        o.rot = 0.07 * a; o.bob = -Math.abs(Math.cos(ph * P2)) * 0.5;
        o.legA = 1.6 * a; o.legB = -1.6 * a;
        o.liftA = Math.max(0, Math.cos(ph * P2)) * 1.0; o.liftB = Math.max(0, -Math.cos(ph * P2)) * 1.0;
        o.hx = 5.6 + 0.4 * Math.cos(ph * P2 * 2); o.hy = -12.5;       // 歩くたびに首が前後に動く
        o.tail = 0.6 * a;
      } else if (s.state === "swim") {
        // 水に浮いて、水の中で足だけ交互にこぐ
        o.bob = Math.sin(t * 2.0 + sd * 6) * 0.25;
        o.legA = 1.8 * Math.sin(ph * P2); o.legB = -o.legA;
        o.hx = 5.0 + 0.3 * Math.sin(t * 0.7 + sd * 3); o.hy = -12.8;
        o.tail = 0.3 * Math.sin(t * 1.5);
      } else if (s.state === "dabble") {
        // 頭を水に入れておしりを上げる：入る → しばらく逆立ち（足をばたばた）→ 戻る
        const u = ((ph % 1) + 1) % 1;
        o.tip = u < 0.18 ? smooth(u / 0.18) : (u < 0.8 ? 1 : 1 - smooth((u - 0.8) / 0.2));
        o.legA = 1.5 * Math.sin(t * 9); o.legB = -o.legA;
        o.tail = 0.6 * Math.sin(t * 6);
      } else {
        // idle：首を少しかしげる・しっぽを振る
        o.hx = 5.3 + 0.35 * Math.sin(t * 0.8 + sd * 4); o.hy = -12.7 + 0.2 * Math.sin(t * 1.1);
        o.tail = Math.max(0, Math.sin(t * 5 + sd * 9)) * (((t + sd * 3) % 5) < 0.7 ? 1 : 0);
      }
      return o;
    }

    // 横向き
    function drawSide(ctx, s) {
      const o = pose(s), water = s.state === "swim" || s.state === "dabble";
      if (!water) {
        footSide(ctx, -1.6 + o.legB, 0, o.liftB, C.legFar);          // 向こう側の足
        ctx.save(); ctx.translate(0, o.bob); ctx.rotate(o.rot);
        bodySide(ctx, o, s.seed || 0);
        ctx.restore();
        footSide(ctx, -0.8 + o.legA, 0, o.liftA, C.leg);              // 手前の足
        return;
      }
      // 水の上：体を水面まで沈める（体の下 −2.2 が水面より下）。dabble は胸の前を中心に前へ倒す
      const sink = 5.0 + o.tip * 5.5;                                // 逆立ちのときは、さらに深く沈む（後ろ半分だけが水面に出る）
      const ang = o.tip * 1.2;
      // 体の中の点 → 絵の点（胸の前 (3.0, −5.6) を中心に前へ倒す）
      const at = function (x, y) {
        const dx = x - 3.0, dy = y + 5.6, c = Math.cos(ang), n = Math.sin(ang);
        return { x: 3.0 + dx * c - dy * n, y: -5.6 + dx * n + dy * c + sink + o.bob };
      };
      const body = function () {
        ctx.save(); ctx.translate(0, sink + o.bob);
        if (ang > 0) { ctx.translate(3.0, -5.6); ctx.rotate(ang); ctx.translate(-3.0, 5.6); }
        bodySide(ctx, o, s.seed || 0);
        ctx.restore();
      };
      const feet = function () {
        if (o.tip < 0.5) {
          footSide(ctx, -1.6 + o.legB, sink, 0, C.legFar); footSide(ctx, -0.8 + o.legA, sink, 0, C.leg);
          return;
        }
        // 逆立ちの間は、腰の後ろで足が水面をばたばたける
        const hip = at(-1.6, -2.6);
        [[o.legA, C.leg], [o.legB, C.legFar]].forEach(function (f) {
          const x = hip.x - 1.2 + f[0] * 0.7, y = Math.min(hip.y, 0.4) - 0.3 - Math.max(0, f[0]) * 0.3;
          ctx.beginPath(); ell(ctx, x, y, 1.3, 0.55, -0.4 + f[0] * 0.2);
          ctx.strokeStyle = OL; ctx.lineWidth = LW * 1.6; ctx.stroke(); ctx.fillStyle = f[1]; ctx.fill();
        });
      };
      const splash = o.tip > 0.05 && o.tip < 0.95;
      // 水の中の体はうすく（逆立ちのときは描かない）。確かめ後の手直し：水の中の足は描かない（灰色の棒に見えて、水の上に立っているように見えたため）
      underWater(ctx, function () { if (o.tip < 0.5) body(); });
      ripples(ctx, s, "back", splash);
      aboveWater(ctx, function () { body(); });
      if (o.tip >= 0.5) feet();
      ripples(ctx, s, "front", splash);
    }

    // 正面・後ろ
    function drawFrontBack(ctx, s, back) {
      const o = pose(s), water = s.state === "swim" || s.state === "dabble";
      o.hx = 0; o.hy = -12.2 + (s.state === "idle" ? 0.2 * Math.sin((s.t || 0) * 1.1) : 0);
      const bodyAt = function () {
        ctx.save(); ctx.translate(0, o.bob);
        ctx.translate(0, 0); ctx.rotate(o.rot * 1.2);                // よちよち（左右にゆれる）
        bodyFB(ctx, o, back);
        ctx.restore();
      };
      if (!water) {
        footFB(ctx, -1.6, o.liftB, back ? C.leg : C.legFar, back);
        footFB(ctx, 1.6, o.liftA, back ? C.legFar : C.leg, back);
        bodyAt();
        return;
      }
      const sink = 5.0;
      if (o.tip > 0.3) {
        // 逆立ち：水面から体の後ろ半分としっぽだけが出る（後ろからは足のばたばたも見える）
        const h = 2.0 + o.tip * 3.2;
        ripples(ctx, s, "back", o.tip < 0.95);
        aboveWater(ctx, function () {
          ctx.beginPath(); ell(ctx, 0, 0.6, 3.6, h, 0); ctx.moveTo(1.0, -h + 0.8); ctx.lineTo(0, -h - 1.6 - o.tail * 0.3); ctx.lineTo(-1.0, -h + 0.8); ctx.closePath();
          ctx.strokeStyle = OL; ctx.lineWidth = LW * 2; ctx.stroke();
          ctx.fillStyle = C.mid; ctx.fill();
          const g = ctx.createLinearGradient(0, -h, 0, 0.6);
          g.addColorStop(0, C.top); g.addColorStop(1, back ? C.under : C.mid);
          ctx.save(); ctx.beginPath(); ell(ctx, 0, 0.6, 3.6, h, 0); ctx.clip(); ctx.fillStyle = g; ctx.fillRect(-4, -h - 1, 8, h + 2);
          if (!back) { ctx.strokeStyle = C.wingLine; ctx.lineWidth = 0.55; ctx.beginPath(); ctx.moveTo(-2.6, 0); ctx.quadraticCurveTo(-1.8, -h * 0.5, 0, -h + 0.6); ctx.moveTo(2.6, 0); ctx.quadraticCurveTo(1.8, -h * 0.5, 0, -h + 0.6); ctx.stroke(); }
          ctx.restore();
          if (back) {                                                // 足のばたばた
            [-1, 1].forEach(function (d, i) {
              const k = i ? o.legA : o.legB;
              ctx.beginPath(); ell(ctx, d * (2.4 + k * 0.4), -0.5 - Math.abs(k) * 0.3, 1.0, 0.55, d * 0.5);
              ctx.strokeStyle = OL; ctx.lineWidth = LW * 1.6; ctx.stroke(); ctx.fillStyle = C.leg; ctx.fill();
            });
          }
        });
        ripples(ctx, s, "front", o.tip < 0.95);
        return;
      }
      const body = function () {
        ctx.save(); ctx.translate(0, sink + o.bob + o.tip * 3); bodyFB(ctx, o, back); ctx.restore();
      };
      // 確かめ後の手直し：水の中の足は描かない（横向きと同じ理由）。水の中の体だけ、うすく描く
      underWater(ctx, body);
      ripples(ctx, s, "back", false);
      aboveWater(ctx, body);
      ripples(ctx, s, "front", false);
    }

    return {
      size: { w: 19, h: 15 },          // 横向き・陸で立つとき（しっぽ〜くちばしの先 約19px、頭の上まで 約15px）
      states: ["idle", "walk", "swim", "dabble"],
      draw: function (ctx, s) {
        LW = outlineW(ctx);
        // 組み込みで追加：アヒルは陸に上がらない。仕組みの側の idle（水に浮いて止まっている）・walk も、水の上の姿（swim）で描く
        if (s.state !== "swim" && s.state !== "dabble") s = Object.assign({}, s, { state: "swim" });
        ctx.save();
        if (s.view === "front") drawFrontBack(ctx, s, false);
        else if (s.view === "back") drawFrontBack(ctx, s, true);
        else drawSide(ctx, s);
        ctx.restore();
      }
    };
  })();
  // ============================================================
  // ★動物の絵（ここまで）
  // ============================================================

  // 絵に無い状態を頼まれたときの置き換え（左の状態が無ければ、右の状態で描く。順にたどる）
  const ANIMAL_STATE_FALLBACK = {
    run: "walk", hop: "walk", swim: "walk", fly: "walk", flutter: "walk",
    groom: "sit", sit: "idle", wag: "idle", alert: "idle", peck: "idle", dabble: "idle", walk: "idle"
  };
  function animalArtState(art, st) {
    const list = art.states || [];
    let s = st;
    for (let n = 0; n < 4 && list.indexOf(s) < 0 && ANIMAL_STATE_FALLBACK[s]; n++) s = ANIMAL_STATE_FALLBACK[s];
    return s;
  }

  // 種類ごとの動きの値。速さはマス／秒（1マス＝約1.15m：主人公の高さ1.4マス≒1.6m）。
  //   walk＝ふだんの速さ、run＝逃げる・走る速さ、stride＝1周期で進む長さ（足の運びの速さを決める）、
  //   step＝ふだん1回に動く長さの上限、margin＝体の幅の半分（通れない所へはみ出さない余白）、turn＝向きを変える速さ（ラジアン／秒）、
  //   react＝反応する距離（マス）
  //   runStride＝走るときの1周期で進む長さ（無ければ stride の1.8倍）。
  //   組み込みで変更：柴犬・猫の stride・runStride は、絵の足の運び（1周期で足先が地面を後ろへ送る長さ＝2×ふり幅÷地面に着いている割合）に
  //   合わせた（足が地面をすべって見えないように）。柴犬 歩く 7.4px・走る 17.6px、猫 歩く 5.0px・走る 13.3px（45px＝1マス）
  //   確かめ後の手直し：足が1秒に6〜10回も回って小走りに見えたので、絵の歩幅を広げ（柴犬 歩く 11.6px・走る 25px、猫 歩く 8.0px・走る 21.1px）、
  //   速さを散歩・小走りの速さに下げた（柴犬 歩く 0.95→0.65・走る 3.2→2.6、猫 歩く 0.75→0.45・走る 2.9→2.2）。
  //   足の周期は1秒に 柴犬 歩く約2.5回・走る約4.7回、猫 歩く約2.5回・走る約4.7回
  const ANIMAL_KIND = {
    sparrow:   { walk: 0.5, run: 0, fly: 3.6, stride: 0.12, step: 0.8, margin: 0.05, turn: 10, react: 2.5, variants: ["suzume"] },
    shiba:     { walk: 0.65, run: 2.6, stride: 0.258, runStride: 0.556, step: 5, margin: 0.14, turn: 3.5, react: 3, variants: ["aka"] },
    cat:       { walk: 0.45, run: 2.2, stride: 0.178, runStride: 0.468, step: 3, margin: 0.12, turn: 4.5, react: 2, variants: ["chatora", "mike", "hachiware"] },
    butterfly: { walk: 0.7, run: 1.1, stride: 0.5, step: 2.2, margin: 0.05, turn: 3, react: 2, variants: ["monshiro", "ageha"] },
    rabbit:    { walk: 1.1, run: 3.3, stride: 0.45, step: 2.5, margin: 0.1, turn: 6, react: 3, variants: ["nousagi"] },
    duck:      { walk: 0.32, run: 0.8, stride: 0.22, step: 4, margin: 0.2, turn: 2.2, react: 1.3, variants: ["ahiru"] }
  };
  // config.js に種類の書き込みが無いときの数と場所
  const ANIMAL_DEFAULT = {
    sparrow: { count: 6, place: "plaza" }, shiba: { count: 2, place: "road" }, cat: { count: 3, place: "town" },
    butterfly: { count: 4, place: "flower" }, rabbit: { count: 2, place: "woods" }, duck: { count: 3, place: "pond" }
  };
  const ANC = C.animals || {};

  // 決まった種（seed）から作る乱数（0〜1）。同じ種なら毎回同じ並びになる
  function makeRand(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rndIn(r, lo, hi) { return lo + (hi - lo) * r(); }

  // まわり（半径 n マスの四角）に、その文字のマスがいくつあるか
  function countTileNear(x, y, ch, n) {
    let k = 0;
    for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) if (tileAt(x + dx, y + dy) === ch) k++;
    return k;
  }
  // まわり（半径 n マスの四角）に、建物があるか
  function buildingNear(x, y, n) {
    for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) if (buildingAt(x + dx, y + dy)) return true;
    return false;
  }

  // そのマスが、place（いる場所）に当てはまるか
  function animalCellFits(place, x, y) {
    const t = tileAt(x, y);
    if (place === "pond") return t === T.POND;
    if (!isWalkable(x, y)) return false;
    if (place === "road") return t === T.ROAD;
    if (place === "plaza") return Math.hypot(x - C.start.x, y - C.start.y) <= 5.5;
    if (place === "town") return t === T.ROAD || buildingNear(x, y, 1);
    if (place === "flower") return countTileNear(x, y, T.FLOWER, 1) > 0;
    if (place === "woods") return t !== T.ROAD && countTileNear(x, y, T.TREE, 1) >= 2;
    return true;
  }

  // その位置（マスの中の小数の位置）に、その動物の体が収まるか（四すみで調べる）
  function animalOk(a, x, y) {
    const m = ANIMAL_KIND[a.kind].margin;
    const at = function (px, py) {
      const tx = Math.floor(px), ty = Math.floor(py);
      if (a.kind === "duck") return a.pond.has(ty * COLS + tx);                   // アヒル：自分の池の上だけ
      if (a.kind === "butterfly") {                                               // ちょうちょ：木と建物の中には入らない（池や道の上は飛べる）
        const t = tileAt(tx, ty);
        return t !== null && t !== T.TREE && !buildingAt(tx, ty);
      }
      return isWalkable(tx, ty);
    };
    return at(x - m, y - m) && at(x + m, y - m) && at(x - m, y + m) && at(x + m, y + m);
  }

  // まっすぐ進む線の上が、ずっと収まるか
  function animalLineOk(a, x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(d / 0.12));
    for (let i = 1; i <= n; i++) if (!animalOk(a, lerp(x0, x1, i / n), lerp(y0, y1, i / n))) return false;
    return true;
  }

  // 池のつながり（"~" のマスを上下左右でたどった、ひとまとまり）。マスの番号（y*COLS+x）の集まり
  function pondGroup(x, y) {
    const set = new Set(), todo = [[x, y]];
    while (todo.length) {
      const p = todo.pop(), k = p[1] * COLS + p[0];
      if (set.has(k) || tileAt(p[0], p[1]) !== T.POND) continue;
      set.add(k);
      todo.push([p[0] + 1, p[1]], [p[0] - 1, p[1]], [p[0], p[1] + 1], [p[0], p[1] - 1]);
    }
    return set;
  }

  // 動物と群れの一覧（animals.enabled が false なら空のまま）
  const animals = [];
  const animalFlocks = [];

  // config.js の animals から、決まった種の乱数で動物を置く
  function createAnimals() {
    if (ANC.enabled !== true) return;
    const seed = Number(ANC.seed) || 1;
    const R = makeRand(seed);
    const sx = C.start.x + 0.5, sy = C.start.y + 0.5;
    ["sparrow", "shiba", "cat", "butterfly", "rabbit", "duck"].forEach(function (kind, ki) {
      const cfg = Object.assign({}, ANIMAL_DEFAULT[kind], ANC[kind] || {});
      const K = ANIMAL_KIND[kind];
      const count = Math.max(0, Math.floor(Number(cfg.count) || 0));
      if (!count) return;
      const area = cfg.area;
      let cells = [];
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          if (area && (x < area.x || y < area.y || x >= area.x + area.w || y >= area.y + area.h)) continue;
          if (animalCellFits(cfg.place, x, y)) cells.push({ x: x, y: y });
        }
      }
      if (!cells.length) return;
      // 住みかの候補：最初の位置から、反応する距離より離れた所（置いたとたんに逃げ出さないように）
      let homes = cells.filter(function (c) { return Math.hypot(c.x + 0.5 - sx, c.y + 0.5 - sy) >= K.react + 1; });
      if (kind === "cat") homes = homes.filter(function (c) { return buildingNear(c.x, c.y, 1); });        // 猫：建物のすぐそば
      if (kind === "butterfly") homes = homes.filter(function (c) { return countTileNear(c.x, c.y, T.FLOWER, 2) >= 3; });   // 花の多い所
      if (kind === "rabbit") homes = homes.filter(function (c) { return c.x >= 3 && c.y >= 3 && c.x <= COLS - 4 && c.y <= ROWS - 4; });   // 外周の林の際は避ける（見える所の林のそば）
      if (!homes.length) homes = cells;
      const flock = kind === "sparrow" ? { cx: 0, cy: 0, rnd: makeRand(seed * 7 + 13), cells: cells } : null;
      const placed = [];
      for (let i = 0; i < count; i++) {
        const r = makeRand(seed * 1000 + ki * 100 + i + 1);
        let home = null;
        if (flock && i > 0) {
          home = { x: flock.cx - 0.5, y: flock.cy - 0.5 };
        } else {
          for (let tries = 0; tries < 40 && !home; tries++) {     // 同じ種類どうしは、なるべく離して置く
            const c = homes[Math.floor(R() * homes.length)];
            const sep = { shiba: 6, cat: 4, rabbit: 5, duck: 1, butterfly: 1.5 }[kind] || 0;
            if (tries < 30 && placed.some(function (p) { return Math.hypot(p.x - c.x, p.y - c.y) < sep; })) continue;
            home = c;
          }
          if (!home) home = homes[0];
          if (flock) { flock.cx = home.x + 0.5; flock.cy = home.y + 0.5; }
        }
        placed.push(home);
        const a = {
          kind: kind, variant: K.variants[i % K.variants.length], seed: r(), rnd: r,
          x: home.x + 0.5, y: home.y + 0.5, h: 0, heading: r() * Math.PI * 2,
          state: "idle", st: 0, dur: rndIn(r, 0.5, 2.5), phase: r(),
          tx: 0, ty: 0, spd: 0, home: { x: home.x + 0.5, y: home.y + 0.5 }, cells: cells,
          react: null, calm: 0, cool: 0, view: "side",
          air: false, fx: 0, fy: 0, fk: 0, fh: 0, delay: -1, lift: 0, hBase: 0.6, landing: 0,
          flock: flock, pond: null, cellSet: null
        };
        if (kind === "duck") a.pond = pondGroup(home.x, home.y);
        // ふだん動き回る範囲：住みかから roam マスの中（アヒルは自分の池の中、スズメは広場全体）
        const roam = { shiba: 8, cat: 4, rabbit: 4, butterfly: 3 }[kind];
        if (kind === "duck") a.cells = cells.filter(function (c) { return a.pond.has(c.y * COLS + c.x); });
        else if (roam) a.cells = cells.filter(function (c) { return Math.hypot(c.x - home.x, c.y - home.y) <= roam; });
        if (!a.cells.length) a.cells = [home];
        a.cellSet = new Set(a.cells.map(function (c) { return c.y * COLS + c.x; }));
        if (flock && i > 0) {                            // 群れ：中心のまわりに散らばる
          for (let t = 0; t < 12; t++) {
            const ang = r() * Math.PI * 2, d = 0.3 + r() * 0.9;
            const x = flock.cx + Math.cos(ang) * d, y = flock.cy + Math.sin(ang) * d;
            if (animalOk(a, x, y)) { a.x = x; a.y = y; break; }
          }
        }
        if (kind === "butterfly") { a.air = true; a.h = 0.6; a.state = "flutter"; a.dur = 99; a.tx = a.x; a.ty = a.y; }
        if (kind === "duck") a.state = "idle";
        animals.push(a);
      }
      if (flock) animalFlocks.push(flock);
    });
  }
  createAnimals();

  function animalSet(a, st, dur) {
    a.state = st; a.st = 0; a.dur = dur;
    if (st === "dabble") a.phase = 0;                   // 組み込みで追加：頭を水に入れる動きは、水面の上の姿（phase 0）から始める
  }

  // ふだん動く先を選ぶ（自分の住みかの場所の中で、まっすぐ行ける所）。見つからなければ null
  function animalPickTarget(a, minD, maxD, cx, cy, within) {
    const r = a.rnd;
    for (let i = 0; i < 14; i++) {
      let x, y;
      if (within) {                                     // 中心 (cx,cy) から within マスの中
        const ang = r() * Math.PI * 2, d = Math.sqrt(r()) * within;
        x = cx + Math.cos(ang) * d; y = cy + Math.sin(ang) * d;
        if (!a.cellSet.has(Math.floor(y) * COLS + Math.floor(x))) continue;   // 住みかの場所（place）の外へは行かない
      } else {
        const c = a.cells[Math.floor(r() * a.cells.length)];
        x = c.x + 0.2 + r() * 0.6; y = c.y + 0.2 + r() * 0.6;
      }
      const d = Math.hypot(x - a.x, y - a.y);
      if (d < minD || (d > maxD && i < 10)) continue;   // 最後の何回かは、遠くても住みかへ戻る道を許す
      if (Math.hypot(x - player.x, y - player.y) < ANIMAL_KIND[a.kind].react + 0.3 && a.kind !== "shiba") continue;   // 主人公のすぐそばへは行かない
      if (a.kind === "duck" && duckCrowded(a, x, y, 0.6)) continue;   // 確かめ後の手直し：ほかのアヒルのそばは選ばない
      if (!animalOk(a, x, y) || !animalLineOk(a, a.x, a.y, x, y)) continue;
      return { x: x, y: y };
    }
    return null;
  }

  // 主人公から離れる向きへ逃げる先（dist マスくらい）。見つからなければ null
  function animalFleeTarget(a, dist) {
    const away = Math.atan2(a.y - player.y, a.x - player.x);
    const turns = [0, 0.45, -0.45, 0.9, -0.9, 1.35, -1.35];
    const first = a.rnd() < 0.5 ? 1 : -1;               // 左右どちらから試すかも乱数で決める
    for (let i = 0; i < turns.length; i++) {
      for (let k = 1; k >= 0.5; k -= 0.25) {
        const ang = away + turns[i] * first, d = dist * k;
        const x = a.x + Math.cos(ang) * d, y = a.y + Math.sin(ang) * d;
        if (animalOk(a, x, y) && animalLineOk(a, a.x, a.y, x, y)) return { x: x, y: y };
      }
    }
    return null;
  }

  // 確かめ後の手直し：アヒルどうしが体ごと重ならないように。(x,y) が、ほかのアヒルの今の位置か泳いで行く先から r マスより近いか
  function duckCrowded(a, x, y, r) {
    for (let i = 0; i < animals.length; i++) {
      const b = animals[i];
      if (b === a || b.kind !== "duck") continue;
      if (Math.hypot(b.x - x, b.y - y) < r) return true;
      if (b.state === "swim" && Math.hypot(b.tx - x, b.ty - y) < r) return true;
    }
    return false;
  }
  // アヒルが (x,y) へ進むと、ほかのアヒルに体の長さ（約0.45マス）より近づきながら寄っていくか
  function duckBumps(a, x, y) {
    for (let i = 0; i < animals.length; i++) {
      const b = animals[i];
      if (b === a || b.kind !== "duck") continue;
      const dn = Math.hypot(b.x - x, b.y - y);
      if (dn < 0.45 && dn < Math.hypot(b.x - a.x, b.y - a.y)) return true;
    }
    return false;
  }

  function animalGo(a, t, spd, st) { a.tx = t.x; a.ty = t.y; a.spd = spd; animalSet(a, st, 99); }

  // 目標 (tx,ty) へ進む。着いたら true。向きを大きく変えるときは、その場で向きを変えてから進む
  function animalMove(a, dt) {
    const dx = a.tx - a.x, dy = a.ty - a.y, dist = Math.hypot(dx, dy);
    if (dist < 0.01) return true;
    const K = ANIMAL_KIND[a.kind];
    const diff = angDiff(Math.atan2(dy, dx), a.heading);
    const turn = K.turn * dt * (a.spd > K.walk * 1.5 ? 2.2 : 1);
    a.heading += clamp(diff, -turn, turn);
    if (Math.abs(diff) > 1.3) return false;
    const v = a.spd * dt * (0.35 + 0.65 * Math.max(0, Math.cos(diff)));
    const k = Math.min(1, v / dist);
    const nx = a.x + dx * k, ny = a.y + dy * k;
    if (!animalOk(a, nx, ny)) { a.tx = a.x; a.ty = a.y; return true; }   // 念のため：収まらない所へは進まない
    if (a.kind === "duck" && duckBumps(a, nx, ny)) { a.tx = a.x; a.ty = a.y; return true; }   // 確かめ後の手直し：ほかのアヒルにぶつかる手前で止まる
    if (TRK.on && trickKeepOut(a, nx, ny)) { a.tx = a.x; a.ty = a.y; trickStats.stopped++; return true; }   // ★主人公の約0.5マスの中へは歩いて入らない（手前で止まる）
    a.x = nx; a.y = ny;
    return k >= 1;
  }

  // 向きを (x,y) のほうへ少しずつ変える
  function animalFace(a, x, y, dt, rate) {
    const diff = angDiff(Math.atan2(y - a.y, x - a.x), a.heading);
    const turn = rate * dt;
    a.heading += clamp(diff, -turn, turn);
  }

  // スズメの群れが飛び立つ。from＝逃げる相手（主人公。null なら気まぐれの引っ越し）
  function flockTakeoff(fl, from) {
    const r = fl.rnd;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 24; i++) {
      const c = fl.cells[Math.floor(r() * fl.cells.length)];
      const x = c.x + 0.5, y = c.y + 0.5;
      const dm = Math.hypot(x - fl.cx, y - fl.cy);
      if (dm < 2.5 || dm > 7) continue;
      if (TRK.on && trickLandBad(x, y)) continue;        // ★主人公のそば・これから通る道のりのそばには降りない
      let score = r();
      if (from) {
        const dp = Math.hypot(x - from.x, y - from.y);
        if (dp < 4.5) continue;
        score += dp * 0.3;
      }
      if (score > bestScore) { bestScore = score; best = { x: x, y: y }; }
    }
    if (!best && from) {                                // 条件に合う所が無い：主人公からいちばん遠い所
      fl.cells.forEach(function (c) {
        const s = Math.hypot(c.x + 0.5 - from.x, c.y + 0.5 - from.y);
        if (s > bestScore) { bestScore = s; best = { x: c.x + 0.5, y: c.y + 0.5 }; }
      });
    }
    if (!best) return;
    fl.cx = best.x; fl.cy = best.y;
    animals.forEach(function (a) {
      if (a.flock !== fl || a.air || a.delay >= 0) return;
      let lx = fl.cx, ly = fl.cy;
      for (let t = 0; t < 10; t++) {                    // 降りる所：群れの中心のまわりに散らばる
        const ang = a.rnd() * Math.PI * 2, d = 0.25 + a.rnd() * 0.9;
        const x = fl.cx + Math.cos(ang) * d, y = fl.cy + Math.sin(ang) * d;
        if (animalOk(a, x, y)) { lx = x; ly = y; break; }
      }
      a.tx = lx; a.ty = ly;
      a.delay = (from ? 0 : 0.3) + a.rnd() * 0.3;       // 1羽ずつ、少しずれて飛び立つ
    });
  }

  // 主人公の位置から、アヒルの池までの距離（池のマスの四角までの近さ）
  function pondDistance(a) {
    let best = Infinity;
    a.pond.forEach(function (k) {
      const x = k % COLS, y = Math.floor(k / COLS);
      const dx = Math.max(x - player.x, 0, player.x - (x + 1)), dy = Math.max(y - player.y, 0, player.y - (y + 1));
      best = Math.min(best, Math.hypot(dx, dy));
    });
    return best;
  }

  // 動物を1匹、dt 秒ぶん動かす
  function animalStep(a, dt) {
    const K = ANIMAL_KIND[a.kind], r = a.rnd;
    if (a.hold) { a.phase = (a.phase + dt * 0.5) % 1; return; }   // ★確かめ用（PORTAL_DEBUG.placeAnimal）：その場から動かさない
    a.st += dt;
    if (a.cool > 0) a.cool -= dt;
    const d = Math.hypot(player.x - a.x, player.y - a.y);

    switch (a.kind) {
      case "sparrow": {
        if (a.air) {                                    // 飛んでいる：弧を描いて、降りる所へ
          a.fk = Math.min(1, a.fk + K.fly * dt / Math.max(0.5, a.fd));
          a.x = lerp(a.fx, a.tx, a.fk); a.y = lerp(a.fy, a.ty, a.fk);
          a.h = 4 * a.fk * (1 - a.fk) * a.fh;
          if (a.fk >= 1) { a.air = false; a.h = 0; a.cool = 1.2; animalSet(a, "idle", rndIn(r, 0.3, 0.8)); }
          break;
        }
        if (a.delay >= 0) {                             // 飛び立つ順番を待っている
          a.delay -= dt;
          if (a.delay < 0) {
            a.air = true; a.fx = a.x; a.fy = a.y; a.fk = 0;
            a.fd = Math.hypot(a.tx - a.x, a.ty - a.y);
            a.fh = clamp(0.7 + a.fd * 0.18, 0.7, 2.0);
            // 確かめ後の手直し：飛ぶ道の下に木のマスがあれば、その上で高さ約2.1マス（木のてっぺんより上）になる弧にする（高さの上限 3.2マス）
            const n = Math.max(2, Math.ceil(a.fd / 0.1));
            for (let i = 1; i < n; i++) {
              const k = i / n;
              if (tileAt(Math.floor(lerp(a.fx, a.tx, k)), Math.floor(lerp(a.fy, a.ty, k))) === T.TREE) a.fh = Math.max(a.fh, Math.min(3.2, 2.1 / (4 * k * (1 - k))));
            }
            a.heading = Math.atan2(a.ty - a.y, a.tx - a.x);
            animalSet(a, "fly", 99);
          }
          break;
        }
        if (d < K.react && a.cool <= 0 && !trickBraced(a)) { flockTakeoff(a.flock, { x: player.x, y: player.y }); break; }   // 群れで飛び立つ（★跳ぶ相手の間は、板を弾く音まで待つ）
        if (a.state === "hop") {
          if (animalMove(a, dt)) animalSet(a, r() < 0.6 ? "peck" : "idle", rndIn(r, 0.4, 1.3));
        } else if (a.st >= a.dur) {
          const q = r();
          if (q < 0.012) { flockTakeoff(a.flock, null); break; }   // ときどき、群れで別の所へ移る
          if (q < 0.5) {
            const t = animalPickTarget(a, 0.15, K.step, a.flock.cx, a.flock.cy, 1.3);
            if (t) { animalGo(a, t, K.walk, "hop"); break; }
          }
          animalSet(a, q < 0.8 ? "peck" : "idle", rndIn(r, 0.4, 1.4));
        }
        break;
      }
      case "shiba": {
        if (a.react === "wag") {                        // 主人公のほうを向いて、しっぽを振る（ついては行かない）
          animalFace(a, player.x, player.y, dt, K.turn);
          a.calm = d < K.react + 0.5 ? 0 : a.calm + dt;
          if (a.calm > 1.5) { a.react = null; a.cool = 2; animalSet(a, "idle", rndIn(r, 1, 2.5)); break; }
          // 確かめ後の手直し：しっぽを振るのは 8〜10秒まで。そのあとは主人公のほうを向いたまま 5〜9秒座り、
          // ふだんの動きに戻る（15秒は、そばにいても、しっぽを振り直さない）
          if (a.state === "wag" && a.st >= a.dur) animalSet(a, "sit", rndIn(r, 5, 9));
          else if (a.state === "sit" && a.st >= a.dur) { a.react = null; a.cool = 15; animalSet(a, "idle", rndIn(r, 1, 2.5)); }
          break;
        }
        if (d < K.react && a.cool <= 0) { a.react = "wag"; a.calm = 0; animalSet(a, "wag", rndIn(r, 8, 10)); break; }
        if (a.state === "walk" || a.state === "run") {
          if (animalMove(a, dt)) animalSet(a, r() < 0.3 ? "sit" : "idle", r() < 0.3 ? rndIn(r, 5, 12) : rndIn(r, 1.5, 4));
        } else if (a.st >= a.dur) {
          const q = r();
          if (q < 0.6) {
            const run = q < 0.08;
            const t = animalPickTarget(a, run ? 3 : 1.2, run ? 6 : K.step, 0, 0, 0);
            if (t) { animalGo(a, t, run ? K.run : K.walk, run ? "run" : "walk"); break; }
          }
          if (a.state === "sit") animalSet(a, "idle", rndIn(r, 1.5, 4));
          else animalSet(a, q < 0.85 ? "sit" : "idle", q < 0.85 ? rndIn(r, 5, 12) : rndIn(r, 2, 4));
        }
        break;
      }
      case "cat": {
        if (a.react === "flee") {                       // 主人公から離れる向きへ少し走って、また座る
          if (animalMove(a, dt)) { a.react = null; a.cool = 2.5; animalSet(a, "sit", rndIn(r, 4, 9)); }
          break;
        }
        if (d < K.react && a.cool <= 0 && !trickBraced(a)) {   // ★跳ぶ相手の間は、着地まで逃げない
          const t = animalFleeTarget(a, rndIn(r, 1.6, 2.6));
          if (t) { a.react = "flee"; animalGo(a, t, K.run, "run"); break; }
          a.cool = 1;
        }
        if (a.state === "walk") {
          if (animalMove(a, dt)) animalSet(a, r() < 0.5 ? "sit" : "idle", rndIn(r, 2, 6));
        } else if (a.st >= a.dur) {
          const q = r();
          if (a.state === "sit" && q < 0.4) { animalSet(a, "groom", rndIn(r, 3, 6)); break; }
          if (a.state === "groom") { animalSet(a, "sit", rndIn(r, 3, 8)); break; }
          if (q < 0.5) {
            const t = animalPickTarget(a, 0.8, K.step, 0, 0, 0);
            if (t) { animalGo(a, t, K.walk, "walk"); break; }
          }
          animalSet(a, q < 0.85 ? "sit" : "idle", q < 0.85 ? rndIn(r, 5, 12) : rndIn(r, 1.5, 4));
        }
        break;
      }
      case "rabbit": {
        if (a.react === "flee") {                       // 跳ねて逃げる
          if (animalMove(a, dt)) { a.react = "alert"; a.calm = 0; animalSet(a, "alert", 99); }
          break;
        }
        if (d < 1.8 && a.cool <= 0 && !trickBraced(a)) {   // ★跳ぶ相手の間は、耳を立てて止まったまま（着地まで逃げない）
          const t = animalFleeTarget(a, rndIn(r, 2.8, 4));
          if (t) { a.react = "flee"; animalGo(a, t, K.run, "hop"); break; }
          a.cool = 0.8;
        }
        if (a.react === "alert") {                      // 耳を立てて止まる（主人公が離れて1秒たつまで）
          a.calm = d < K.react ? 0 : a.calm + dt;
          if (a.calm > 1) { a.react = null; a.cool = 0.5; animalSet(a, "idle", rndIn(r, 1.5, 3)); }
          break;
        }
        if (d < K.react) { a.react = "alert"; a.calm = 0; animalSet(a, "alert", 99); break; }
        if (a.state === "hop") {
          if (animalMove(a, dt)) animalSet(a, "idle", rndIn(r, 1.5, 4));
        } else if (a.st >= a.dur) {
          const q = r();
          if (q < 0.55) {
            const t = animalPickTarget(a, 0.8, K.step, 0, 0, 0);
            if (t) { animalGo(a, t, K.walk, "hop"); break; }
          }
          animalSet(a, q < 0.68 ? "alert" : "idle", q < 0.68 ? rndIn(r, 1, 2) : rndIn(r, 2, 5));
        }
        break;
      }
      case "duck": {
        if (a.react === "flee") {                       // 反対側へ泳ぐ
          if (animalMove(a, dt)) { a.react = null; a.cool = 3; animalSet(a, "idle", rndIn(r, 2, 4)); }
          break;
        }
        if (a.cool <= 0 && d < 6 && pondDistance(a) < K.react) {   // 主人公が池のふちに来た
          let best = null, bd = -1;
          a.pond.forEach(function (k) {
            const x = k % COLS + 0.5, y = Math.floor(k / COLS) + 0.5;
            const s = Math.hypot(x - player.x, y - player.y);
            if (s > bd && animalOk(a, x, y) && !duckCrowded(a, x, y, 0.6) && animalLineOk(a, a.x, a.y, x, y)) { bd = s; best = { x: x, y: y }; }   // 確かめ後の手直し：ほかのアヒルのそばは選ばない
          });
          if (best && Math.hypot(best.x - a.x, best.y - a.y) > 0.6) { a.react = "flee"; animalGo(a, best, K.run, "swim"); break; }
          a.cool = 1.5;
        }
        if (a.state === "swim") {
          if (animalMove(a, dt)) animalSet(a, r() < 0.4 ? "dabble" : "idle", rndIn(r, 1.5, 4));
        } else {
          if (a.state === "idle") a.heading += Math.sin(state.time * 0.4 + a.seed * 9) * 0.15 * dt;   // 浮かんで、ゆっくり向きが変わる
          if (a.st >= a.dur) {
            const q = r();
            if (q < 0.55) {
              const t = animalPickTarget(a, 0.8, K.step, 0, 0, 0);
              if (t) { animalGo(a, t, K.walk, "swim"); break; }
            }
            animalSet(a, q < 0.8 ? "dabble" : "idle", q < 0.8 ? rndIn(r, 1.5, 3) : rndIn(r, 2, 5));
          }
        }
        break;
      }
      case "butterfly": {
        if (d < K.react && a.cool <= 0) {               // 少し高く舞い上がって、離れる
          a.lift = rndIn(r, 2, 3); a.cool = 3.5; a.landing = 0;
          const t = animalFleeTarget(a, rndIn(r, 1.2, 2));
          if (t) { a.tx = t.x; a.ty = t.y; }
          animalSet(a, "flutter", 99);
        }
        if (a.lift > 0) a.lift -= dt;
        let want;
        if (a.state === "idle") {                       // 花にとまる
          want = 0.12;
          if (a.st >= a.dur) { const t = animalPickTarget(a, 0.5, K.step, a.home.x, a.home.y, 2.5); if (t) { a.tx = t.x; a.ty = t.y; } animalSet(a, "flutter", 99); }
        } else if (a.landing > 0) {                     // 確かめ後の手直し：花へ下りる間は羽ばたいたまま。下りきってから羽を閉じる（idle）
          want = 0.12;
          if (a.h < 0.16) { animalSet(a, "idle", a.landing); a.landing = 0; }
        } else {
          want = a.hBase + Math.sin(state.time * 2.1 + a.seed * 7) * 0.12 + (a.lift > 0 ? 0.9 : 0);
          // ひらひら：目標へ向かいながら、向きが揺れる
          const dx = a.tx - a.x, dy = a.ty - a.y, dist = Math.hypot(dx, dy);
          if (dist < 0.2) {
            if (r() < 0.25 && a.lift <= 0 && tileAt(Math.floor(a.x), Math.floor(a.y)) === T.FLOWER) { a.landing = rndIn(r, 2, 5); }   // とまる時間を覚えて、下り始める
            else {
              const t = animalPickTarget(a, 0.5, K.step, a.home.x, a.home.y, 2.5);
              if (t) { a.tx = t.x; a.ty = t.y; a.hBase = rndIn(r, 0.4, 0.9); }
            }
          } else {
            const wob = Math.sin(state.time * 3.3 + a.seed * 11) * 1.1 + Math.sin(state.time * 7.1 + a.seed * 5) * 0.5;
            const diff = angDiff(Math.atan2(dy, dx) + wob * 0.6, a.heading);
            a.heading += clamp(diff, -K.turn * dt * 2, K.turn * dt * 2);
            const v = (a.lift > 0 ? K.run : K.walk) * dt;
            const nx = a.x + Math.cos(a.heading) * v, ny = a.y + Math.sin(a.heading) * v;
            if (animalOk(a, nx, ny)) { a.x = nx; a.y = ny; }
            else { a.heading += Math.PI * 0.5; a.tx = a.home.x; a.ty = a.home.y; }   // 木や建物に当たりそう：向きを変えて住みかへ
          }
        }
        a.h += (want - a.h) * (1 - Math.exp(-dt * 2.5));
        break;
      }
    }

    // 周期（足の運び・羽ばたきなど）を進める
    let rate;
    if (a.state === "fly") rate = 11;
    else if (a.state === "flutter") rate = 7;
    else if (a.state === "walk" || a.state === "run" || a.state === "hop" || a.state === "swim") rate = Math.max(1.2, a.spd / (a.spd > K.walk * 1.5 ? (K.runStride || K.stride * 1.8) : K.stride));
    else if (a.state === "dabble") rate = 1 / Math.max(0.5, a.dur);   // 組み込みで追加：頭を水に入れる→戻るを、続く時間でちょうど1回（絵の決まり：dabble は phase 0〜1 で1回）
    else if (a.state === "wag") rate = 4;
    else if (a.state === "peck") rate = 2.5;
    else if (a.state === "groom") rate = 1.2;
    else rate = 0.5;
    a.phase = (a.phase + dt * rate) % 1;
  }

  // 動物を dt 秒ぶん動かす（大きな dt は 0.05 秒ずつに分ける。同じ step の進め方なら、毎回同じ動きになる）
  function updateAnimals(dt) {
    if (!animals.length) return;
    let left = dt;
    while (left > 1e-9) {
      const h = Math.min(left, 0.05);
      left -= h;
      for (let i = 0; i < animals.length; i++) {
        animalStep(animals[i], h);
        if (TRK.on) trickPushAway(animals[i]);          // ★主人公と重ならないように、すぐそばの動物は押しのける
      }
    }
  }

  // カメラから見た動物の向き。look＝カメラが見ている水平の向き。
  // view＝"side"｜"front"｜"back"（切り替わりの所で絵がちらつかないよう、少しのり代を持たせる）、flip＝左向き（絵を左右反転する）
  function animalFacing(a, look, keep) {
    const rel = angDiff(a.heading, look), ab = Math.abs(rel);
    let v = keep ? a.view : "";
    const stay = v === "back" ? ab < 0.85 : (v === "front" ? ab > 2.29 : (v === "side" ? ab > 0.55 && ab < 2.59 : false));
    if (!stay) v = ab < 0.7 ? "back" : (ab > 2.44 ? "front" : "side");
    if (keep) a.view = v;
    return { view: v, flip: rel < 0 };
  }

  // 動物の絵を1つ描く（x,y＝足元の画面上の位置、s＝絵の拡大率）
  const animalWarned = new Set();
  function drawAnimalSprite(g, a, art, x, y, s, f, now) {
    g.save();
    g.translate(x, y);
    g.scale(f.flip ? -s : s, s);
    try {
      art.draw(g, { state: animalArtState(art, a.state), phase: a.phase, t: now, view: f.view, seed: a.seed, variant: a.variant });
    } catch (e) {                                       // 絵の関数の書き間違いで、ゲーム全体が止まらないようにする（知らせは1回だけ）
      if (!animalWarned.has(a.kind)) { animalWarned.add(a.kind); console.warn("動物の絵（" + a.kind + "）を描けません：" + e); }
    }
    g.restore();
  }

  // 影の大きさ（マス）：体の長さの半分を少し縮めた楕円。高く飛ぶほど小さく・薄く
  function animalShadowSize(a, art) {
    const up = clamp(a.h / 2.5, 0, 0.7);
    const L = art.size.w * 0.42 / ART_PX * (1 - up * 0.4);
    return { L: L, W: L * (a.kind === "butterfly" ? 0.8 : 0.5), alpha: 0.22 * (1 - up) * (a.kind === "butterfly" ? 0.5 : 1) };
  }

  // 斜め見下ろしの画面で、動物を1匹描く（g は斜め画面の座標に合わせてある）
  function drawAnimalIso(g, a, now) {
    const art = ANIMAL_ART[a.kind];
    if (!art) return;
    const p = iso(a.x, a.y);
    if (a.kind !== "duck") {                            // 影（アヒルは水の上なので、影の代わりに絵の側の波紋）
      const sh = animalShadowSize(a, art);
      g.save();
      g.translate(p.x, p.y);
      g.transform(TW / 2, TH / 2, -TW / 2, TH / 2, 0, 0);   // 地図の向き（マス）のまま描く
      g.rotate(a.heading);
      g.beginPath(); g.ellipse(0, 0, sh.L, sh.W, 0, 0, Math.PI * 2);
      g.fillStyle = "rgba(0,0,0," + sh.alpha.toFixed(3) + ")";
      g.fill();
      g.restore();
    }
    drawAnimalSprite(g, a, art, p.x, p.y - a.h * ART_PX, 1, animalFacing(a, ISO_VIEW, true), now);
  }

  // 背中ごしの画面で、動物の絵の位置と拡大率。見えない（カメラのすぐそば・画面の外・遠すぎる）ときは null
  function animalBoxFollow(a) {
    const art = ANIMAL_ART[a.kind];
    if (!art) return null;
    const q = project(a.x, a.y, a.h);
    if (q.z < 0.9 || q.z > 32) return null;
    const s = fcam.f / q.z / ART_PX;
    const w = art.size.w * s, h = art.size.h * s;
    if (q.x + w < 0 || q.x - w > viewW || q.y - h > viewH || q.y + h * 0.3 < 0) return null;
    return { x: q.x, y: q.y, z: q.z, s: s };
  }

  // 背中ごしの画面で、動物を1匹描く（it＝{ animal, bb }）
  function drawAnimalFollow(it, now) {
    const a = it.animal, art = ANIMAL_ART[a.kind], bb = it.bb;
    if (a.kind !== "duck") {                            // 地面の影（体の向きに長い楕円を、地面の上に写す）
      const sh = animalShadowSize(a, art), pts = [];
      const hx = Math.cos(a.heading), hy = Math.sin(a.heading);
      for (let i = 0; i < 12; i++) {
        const t = i / 12 * Math.PI * 2, u = Math.cos(t) * sh.L, v = Math.sin(t) * sh.W;
        pts.push([a.x + hx * u - hy * v, a.y + hy * u + hx * v]);
      }
      if (groundPath(pts)) { ctx.fillStyle = "rgba(0,0,0," + sh.alpha.toFixed(3) + ")"; ctx.fill(); }
    }
    // 組み込みで変更：向きは、カメラの正面の向きではなく「カメラから動物を見る向き」で決める
    // （画面の端の動物は斜めから見えるので、正面の向きで決めると、こちらへ来る動物が横向きの絵になることがある）
    drawAnimalSprite(ctx, a, art, bb.x, bb.y, bb.s, animalFacing(a, Math.atan2(a.y - fcam.ey, a.x - fcam.ex), true), now);
  }

  // 背中ごしの画面：描く物の並び（奥から順）に、動物を入れる。
  // 動物より奥の物＝木・動物・主人公は奥行きで、建物は「カメラから動物への線が、建物の土台を横切らない」もの。
  // 動物は、奥の物のうち最後の物の直後に入れる
  function addAnimalsFollow(items, playerZ) {
    const c = fcam, list = [];
    animals.forEach(function (a) {
      const bb = animalBoxFollow(a);
      if (bb) list.push({ animal: a, bb: bb, z: bb.z });
    });
    list.sort(function (p, q) { return q.z - p.z; });
    list.forEach(function (an) {
      const a = an.animal;
      let at = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        let behind;
        if (it.animal) behind = it.z >= an.z;
        else if (it.player) behind = playerZ >= an.z;
        else if (it.b) behind = rayRectEnter(c.ex, c.ey, a.x - c.ex, a.y - c.ey, it.b.x, it.b.y, it.b.x + it.b.size, it.b.y + it.b.size) >= 1;
        else behind = it.z >= an.z;
        if (behind) at = i + 1;
      }
      items.splice(at, 0, an);
    });
  }

  // ------------------------------------------------------------
  // 7. 画面を描く
  //    同じ地図データ（MAP・BUILDINGS・TREES・player）を、2通りで描く
  // ------------------------------------------------------------
  const canvas = document.getElementById("field");
  const ctx = canvas.getContext("2d");
  let viewW = 1, viewH = 1, dpr = 1;

  // 画面の大きさに合わせる
  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    viewW = Math.max(1, Math.round(r.width));
    viewH = Math.max(1, Math.round(r.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    render();                                           // 大きさを変えると絵が消えるので、すぐ描き直す（一瞬の空白を防ぐ）
  }

  // ---- 全体マップ（真上） ----

  // 1マスの大きさと、地図の左上の位置（画面に全体が収まるように決める）
  function overviewLayout() {
    const pad = 6;
    const s = Math.max(4, Math.floor(Math.min((viewW - pad * 2) / COLS, (viewH - pad * 2) / ROWS)));
    return { s: s, ox: Math.round((viewW - s * COLS) / 2), oy: Math.round((viewH - s * ROWS) / 2) };
  }

  function renderOverview(now) {
    const L = overviewLayout(), s = L.s;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.sky;
    ctx.fillRect(0, 0, viewW, viewH);

    // 地面
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        Art.topGround(ctx, MAP[y][x], L.ox + x * s, L.oy + y * s, s, x, y);
      }
    }
    // 入口のマット
    BUILDINGS.forEach(function (b) {
      const e = entranceOf(b);
      Art.topMat(ctx, b, L.ox + e.x * s, L.oy + e.y * s, s);
    });
    // 木
    TREES.forEach(function (t) {
      Art.topTree(ctx, L.ox + (t.x + 0.5) * s, L.oy + (t.y + 0.5) * s, s, t.x, t.y);
    });
    // 建物
    BUILDINGS.forEach(function (b) {
      Art.topBuilding(ctx, b, L.ox + b.x * s, L.oy + b.y * s, s, b === state.selected);
    });
    // 現在地
    const px = L.ox + player.x * s, py = L.oy + player.y * s;
    Art.topPlayer(ctx, px, py, s, now);
    // 名前ラベル（いちばん上に描く）。準備中の建物は、ラベルの右に「準備中」の札
    overviewLabels(L).forEach(function (r) {
      Art.topLabel(ctx, r.b.name, r.cx, r.cy, r.fontPx, false);
      if (r.tag) Art.topPendingTag(ctx, r.tag.cx, r.tag.cy, r.tag.w, r.tag.h, r.tag.fontPx);
    });
    Art.topLabel(ctx, "現在地", px, py + s * 0.95, clamp(Math.round(s * 0.42), 10, 14), true);
  }

  // 全体マップの名前ラベルの位置と大きさ（描くときと、押した場所の判定の両方で使う）。
  // 文字の大きさは1マスの大きさに合わせる（読める大きさの下限 11px）。
  // 地図が広くてマスが小さいときにラベルどうしが重なったら、後のラベルを下へずらして重ならないようにする
  function overviewLabels(L) {
    const s = L.s;
    const fontPx = clamp(Math.round(s * 0.5), 11, 17);
    const tagPx = Math.max(11, Math.round(fontPx * 0.8));
    const TAG_GAP = 2;                                  // ラベルと「準備中」の札のすき間（px）
    const list = BUILDINGS.map(function (b) {
      ctx.font = "bold " + fontPx + "px " + FONT;
      const w = ctx.measureText(b.name).width + fontPx * 0.9, h = fontPx * 1.6;   // Art.topLabel と同じ大きさ
      const r = { b: b, cx: L.ox + (b.x + b.size / 2) * s, cy: L.oy + (b.y + b.size / 2) * s, w: w, h: h, fontPx: fontPx, tag: null };
      if (isPending(b)) {
        ctx.font = "bold " + tagPx + "px " + FONT;
        r.tag = { w: ctx.measureText(PENDING_TAG.text).width + tagPx * 0.9, h: tagPx * 1.45, fontPx: tagPx, cx: 0, cy: 0 };
        // 札はラベルの右に横並びにする（縦に積むと、マスが小さいとき建物の色がほとんど隠れるため）。
        // ラベル＋札のまとまりが、建物の中心に来るように左へずらす
        r.cx -= (r.tag.w + TAG_GAP) / 2;
      }
      return r;
    });
    // ラベル（＋札）の四角
    const box = function (r) {
      return { x0: r.cx - r.w / 2, x1: r.cx + r.w / 2 + (r.tag ? TAG_GAP + r.tag.w : 0), y0: r.cy - r.h / 2, y1: r.cy + r.h / 2 };
    };
    // 重なりをほどく：上から順に置き、先に置いたラベルと重なったら、その下へずらす
    const order = list.slice().sort(function (a, b) { return a.cy - b.cy || a.cx - b.cx; });
    const placed = [];
    order.forEach(function (r) {
      for (let k = 0; k < 20; k++) {
        const a = box(r);
        const hit = placed.filter(function (q) {
          const c = box(q);
          return a.x0 < c.x1 + 2 && a.x1 > c.x0 - 2 && a.y0 < c.y1 + 2 && a.y1 > c.y0 - 2;
        });
        if (!hit.length) break;
        r.cy = Math.max.apply(null, hit.map(function (q) { return box(q).y1; })) + 3 + r.h / 2;
      }
      placed.push(r);
    });
    list.forEach(function (r) { if (r.tag) { r.tag.cx = r.cx + r.w / 2 + TAG_GAP + r.tag.w / 2; r.tag.cy = r.cy; } r.box = box(r); });
    return list;
  }

  // 全体マップの上の点 (px,py) にある建物（無ければ null）。指で押しやすいよう、少し広めに取る
  function buildingAtPoint(px, py) {
    const L = overviewLayout(), s = L.s, m = s * 0.35;
    for (let i = 0; i < BUILDINGS.length; i++) {
      const b = BUILDINGS[i];
      const x0 = L.ox + b.x * s - m, y0 = L.oy + b.y * s - m, w = b.size * s + m * 2;
      if (px >= x0 && px <= x0 + w && py >= y0 && py <= y0 + w) return b;
    }
    // 建物から外れていても、名前ラベル（と準備中の札）の上なら、その建物（マスが小さい広い地図でも押しやすいように）
    const labels = overviewLabels(L);
    for (let i = 0; i < labels.length; i++) {
      const g = labels[i].box;
      if (px >= g.x0 && px <= g.x1 && py >= g.y0 && py <= g.y1) return labels[i].b;
    }
    return null;
  }

  // ---- 移動画面（斜め見下ろし） ----

  // カメラが見ている地図の位置。free＝手で画面を動かした後（主人公の追いかけを止めている間）
  const cam = { x: player.x, y: player.y, free: false };

  function updateCamera(dt) {
    if (camMode === "follow") { updateFollowCamera(dt); return; }   // 背中ごしのカメラは別の関数で動かす
    if (cam.free) return;                               // 手で動かした後は、次に行き先を選ぶまで追いかけない
    const k = 1 - Math.exp(-dt * 7);                    // 主人公を少し遅れて追いかける
    cam.x += (player.x - cam.x) * k;
    cam.y += (player.y - cam.y) * k;
  }

  // 画面の大きさに合わせた拡大率
  function fieldZoom() {
    return clamp(Math.min(viewW, viewH * 1.25) / 430, 0.85, 1.8);
  }

  // 移動画面の表示の基準：z＝拡大率、(ox,oy)＝地図の原点が来る画面上の位置
  function fieldView() {
    const z = fieldZoom();
    const c = iso(cam.x, cam.y);
    return { z: z, ox: viewW / 2 - c.x * z, oy: viewH * 0.56 - c.y * z };   // カメラの位置を画面の中央（少し下）に合わせる
  }

  // 画面上の点 (px,py) を、斜め画面の座標に直す
  function fieldToIso(px, py) {
    const v = fieldView();
    return { x: (px - v.ox) / v.z, y: (py - v.oy) / v.z };
  }

  // 斜め画面の座標を、地図の位置に直す（iso の逆）
  function isoToWorld(q) {
    return { x: (q.x / (TW / 2) + q.y / (TH / 2)) / 2, y: (q.y / (TH / 2) - q.x / (TW / 2)) / 2 };
  }

  // 画面を手で動かす。(dx,dy)＝見る場所を、画面の上でどれだけ動かすか（px）。地図の外までは行かない
  function panCamera(dx, dy) {
    const z = fieldZoom();
    const d = isoToWorld({ x: dx / z, y: dy / z });
    cam.x = clamp(cam.x + d.x, 0, COLS);
    cam.y = clamp(cam.y + d.y, 0, ROWS);
    cam.free = true;
  }

  // 点が多角形の中にあるか
  function insidePoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  // 移動画面の点 q（斜め画面の座標）にある建物（無ければ null）。重なっていたら手前の建物
  function buildingAtIso(q) {
    let hit = null;
    BUILDINGS.forEach(function (b) {
      if (!buildingHitIso(b, q)) return;
      if (!hit || b.x + b.y + b.size > hit.x + hit.y + hit.size) hit = b;
    });
    return hit;
  }

  // 建物の絵の外わく（斜め画面の座標）。body＝輪郭の多角形、sign＝看板の四角 { x0, y0, x1, y1 }、
  // tag＝準備中の小札の四角（準備中の建物だけ。それ以外は null）
  function buildingHitShape(b) {
    const s = buildingShape(b);
    const art = BUILDING_ART[b.art];
    const tagOf = function (x, y, h) {                  // 小札の四角（ふちの線の分、1 だけ広げる）
      if (!isPending(b)) return null;
      const t = pendingTagRect(ctx, x, y, h);
      return { x0: t.x0 - 1, x1: t.x1 + 1, y0: t.y0, y1: t.y1 + 1 };
    };
    if (art) {                                          // テーマ別の絵：その絵の外わくと、看板の四角
      const at = art.signAt(s), z = buildingSignSize(ctx, b);
      return {
        body: art.outline(s),
        sign: { x0: at.x - z.w / 2 - 1, x1: at.x + z.w / 2 + 1, y0: at.y - z.h / 2 - 1, y1: at.y + z.h / 2 + 1 },   // 1＝ふちの線の分
        tag: tagOf(at.x, at.y, z.h)
      };
    }
    const hw = signHalfWidth(b);                        // 箱の建物：壁と屋根をまとめた外わくと、てっぺんの看板
    return {
      body: [s.L, s.F, s.R, { x: s.R.x, y: s.R.y - BUILD.wallH }, s.rR, s.rB, s.rL, { x: s.L.x, y: s.L.y - BUILD.wallH }],
      sign: { x0: s.apex.x - hw, x1: s.apex.x + hw, y0: s.apex.y - 32, y1: s.apex.y },
      tag: tagOf(s.apex.x, s.apex.y - 17, 26)
    };
  }

  // 斜め画面の点 q が、建物 b の絵（建物か看板。準備中なら小札も）の上にあるか
  function buildingHitIso(b, q) {
    const h = buildingHitShape(b), g = h.sign, t = h.tag;
    return insidePoly(q, h.body) || (q.x > g.x0 && q.x < g.x1 && q.y > g.y0 && q.y < g.y1) ||
      (t !== null && q.x > t.x0 && q.x < t.x1 && q.y > t.y0 && q.y < t.y1);
  }

  // 高さのある物（木・建物）。奥から順に描くための並び順の値（key）を持たせる。
  // key＝その物の中心の「x＋y」。小さいほど奥。
  const SOLIDS = [];
  TREES.forEach(function (t) {
    SOLIDS.push({ key: t.x + t.y + 1, draw: function () { Art.isoTree(ctx, t.x, t.y); }, tree: t });
  });
  BUILDINGS.forEach(function (b) {
    SOLIDS.push({ key: b.x + b.y + b.size, draw: function (now) { Art.isoBuilding(ctx, b, now); }, b: b });
  });

  // 建物の絵が収まる四角（斜め画面の座標）。画面の外の建物を描かないための目安。
  // 絵の外わく・看板・準備中の小札に、広めの余白（煙・旗などの飾りの分）を足す。建物ごとに1回だけ計算して覚えておく
  const BOUND_PAD = 100;
  const boundsCache = new Map();
  function buildingBoundsIso(b) {
    if (boundsCache.has(b)) return boundsCache.get(b);
    const s = buildingShape(b), art = BUILDING_ART[b.art];
    let pts, sx, sy, sw, sh;
    if (art) {
      const at = art.signAt(s), z = buildingSignSize(ctx, b);
      pts = art.outline(s); sx = at.x; sy = at.y; sw = z.w; sh = z.h;
    } else {
      pts = [s.rR, s.rB, s.rL, s.rF, s.apex]; sx = s.apex.x; sy = s.apex.y - 17; sw = signHalfWidth(b) * 2; sh = 26;
    }
    pts = pts.concat([s.Bk, s.R, s.F, s.L,
      { x: sx - sw / 2, y: sy - sh / 2 }, { x: sx + sw / 2, y: sy + sh / 2 + PENDING_TAG.gap + PENDING_TAG.h }]);
    const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    pts.forEach(function (p) {
      r.x0 = Math.min(r.x0, p.x); r.x1 = Math.max(r.x1, p.x);
      r.y0 = Math.min(r.y0, p.y); r.y1 = Math.max(r.y1, p.y);
    });
    r.x0 -= BOUND_PAD; r.x1 += BOUND_PAD; r.y0 -= BOUND_PAD; r.y1 += BOUND_PAD;
    boundsCache.set(b, r);
    return r;
  }

  function renderField(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.sky;
    ctx.fillRect(0, 0, viewW, viewH);

    const v = fieldView();
    const z = v.z, ox = v.ox, oy = v.oy;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * ox, dpr * oy);

    // 画面に入っている範囲（斜め画面の座標）。外のマスは描かない
    const minX = -ox / z - TW, maxX = (viewW - ox) / z + TW;
    const minY = -oy / z - TH * 2, maxY = (viewH - oy) / z + TH;

    // 地面（高さが無いので、順番は気にしなくてよい）
    Art.isoEdge(ctx);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const p = iso(x, y);
        if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
        Art.isoGround(ctx, MAP[y][x], x, y, now);
      }
    }
    BUILDINGS.forEach(function (b) {
      const e = entranceOf(b);
      Art.isoMat(ctx, b, e.x, e.y);
    });
    if (state.goal && isMoving()) Art.isoGoal(ctx, state.goal.x, state.goal.y, now);

    // 高さのある物と主人公を、奥（keyが小さい）から順に描く。
    // こうすると、主人公が建物や木の裏に回ったとき、手前の物に隠れる。
    const items = SOLIDS.filter(function (it) {
      if (it.b) {                                       // 建物：絵の入る四角が画面に入っているときだけ描く
        const r = buildingBoundsIso(it.b);
        return r.x1 > minX && r.x0 < maxX && r.y1 > minY && r.y0 < maxY;
      }
      if (!it.tree) return true;
      const p = iso(it.tree.x, it.tree.y);
      return p.x > minX - 40 && p.x < maxX + 40 && p.y > minY && p.y < maxY + 80;
    });
    animals.forEach(function (a) {                      // 動物（足元の x＋y で、奥から順の並びに入れる。画面の外は描かない）
      const p = iso(a.x, a.y);
      if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY + 40) return;
      items.push({ key: a.x + a.y, draw: function () { drawAnimalIso(ctx, a, now); } });
    });
    items.push({ key: player.x + player.y + 0.001 + (player.trick ? trickAir(player) * 2 : 0), draw: function () { Art.isoPlayer(ctx, player, now); } });   // ★跳んでいる間は、真下の動物より後に描く（上にいるので）
    items.sort(function (a, b) { return a.key - b.key; });
    for (let i = 0; i < items.length; i++) items[i].draw(now);
  }

  // ---- 移動画面（背中ごし：主人公の後ろから追いかけるカメラ。MMORPG風） ----
  //
  // 描き方のあらまし
  //   ・地面のマスを1枚ずつ、遠近法で画面に写して塗る（カメラの後ろへ回るマスは、近い面で切り取る）
  //   ・建物と木は「立て看板」：斜め見下ろし用の絵を、画面上の位置と大きさに合わせてそのまま描く
  //   ・主人公は、体の関節（playerPose）を地図の位置に直してから遠近法で写す（後ろ姿・傾き・蹴る動きがそのまま出る）
  //   ・奥の物から順に描く。主人公を隠す手前の物は、半透明にする

  // カメラの設定（config.js の camera。書かれていない項目は、ここの値を使う）
  const CAMC = Object.assign({
    mode: "iso",
    distance: 4.2, height: 2.3, lookAhead: 1.6, lookHeight: 0.9,
    fov: 55, minWideFov: 58, centerY: 0.46, tallUp: 1.0, tallCenterY: 0.06,
    turnRate: 6, followRate: 10, speedPull: 0.6, speedFov: 4,
    arriveRange: 3, arriveBack: -0.8, arriveUp: 0.3, arriveSide: 0.5, arriveZoom: 0.15,
    fog: 0.45, treeScale: 1.6, buildingScale: 0.9, models: false,
    dragTurn: 0.008, keyTurn: 2.2, returnAfter: 1.2,
    maxTurn: 190, minDistance: 2.2,
    orbitFreeFrom: 10, orbitFreeTo: 40
  }, C.camera || {});
  let camMode = CAMC.mode === "follow" ? "follow" : "iso";   // いまのカメラ

  const ART_PX = 45;             // 斜め見下ろしの絵の「1マス＝何px」（土台の対角 192px ÷ 4.24マス）
  const NEAR = 0.2;              // これよりカメラに近い（または後ろの）物は描かない
  const ISO_VIEW = -Math.PI * 3 / 4;   // 斜め見下ろしの絵が描かれている、見る向き（南東から北西を見る）

  // 背中ごしのカメラ。上の段は「動かす値」、下の段は followFrame が毎回そこから計算する値
  const fcam = {
    px: player.x, py: player.y,  // 追いかけている位置（主人公を少し遅れて追う）
    yaw: player.heading,         // カメラが向く向き（主人公の向きを少し遅れて追う）
    yawVel: 0,                   // 向きが変わっている速さ（ゆっくり回り始めて、ゆっくり止まるために持つ）
    orbit: 0,                    // 手で見回した分（yaw に足す）
    idle: 99,                    // 最後に手で見回してからの秒数
    arr: 0,                      // 到着の構図へどれだけ移ったか（0〜1）
    arrB: null,                  // 到着の構図で見せている建物（行き先を変えても、構図が戻り切るまでは前の建物のまま使う）
    spd: 0,                      // 速さの割合（0〜1。なめらかにした値）
    dist: CAMC.distance,         // 主人公からカメラまでの距離（建物にめり込むときは、縮める）
    bdist: CAMC.distance,        // 建物をよけた距離（見回していない時の距離。なめらかにした値。見回している間は、dist をここから wantedDistance へ寄せる）
    omix: 0,                     // 見回し中の見せ方へ、どれだけ移ったか（0〜1。orbitFree をなめらかにした値）
    ex: 0, ey: 0, ez: 0,         // カメラの位置（地図のマス。ez＝高さ）
    look: 0, pitch: 0,           // 見ている向き（look＝水平の向き、pitch＝見下ろす角度）
    f: 1, cx: 0, cy: 0,          // 遠近法の強さ（px）と、見る先が来る画面上の位置
    horizon: 0,                  // 水平線の高さ（画面上の y）
    rx: 0, ry: 0,                // カメラの右向き
    ux: 0, uy: 0, uz: 1,         // カメラの上向き
    fx: 1, fy: 0, fz: 0          // カメラの前向き
  };

  // 点 (ox,oy) から向き (dx,dy) へ進む線が、四角 (x0,y0)-(x1,y1) に入る所（線の長さを1とした割合）。
  // 始まりが四角の中なら 0、当たらなければ Infinity
  function rayRectEnter(ox, oy, dx, dy, x0, y0, x1, y1) {
    let t0 = 0, t1 = Infinity;
    const axes = [[ox, dx, x0, x1], [oy, dy, y0, y1]];
    for (let i = 0; i < 2; i++) {
      const o = axes[i][0], d = axes[i][1], lo = axes[i][2], hi = axes[i][3];
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) return Infinity;
      } else {
        const a = (lo - o) / d, b = (hi - o) / d;
        t0 = Math.max(t0, Math.min(a, b));
        t1 = Math.min(t1, Math.max(a, b));
        if (t0 > t1) return Infinity;
      }
    }
    return t0;
  }

  // 点 (x,y) から向き ang へ、建物に当たらずに進める距離（最大 max）。m＝建物のまわりに取る余白（マス）
  function freeDistance(x, y, ang, max, m) {
    const dx = Math.cos(ang), dy = Math.sin(ang);
    if (m === undefined) m = 0.35;
    let best = max;
    BUILDINGS.forEach(function (b) {
      const t = rayRectEnter(x, y, dx, dy, b.x - m, b.y - m, b.x + b.size + m, b.y + b.size + m);
      if (t < best) best = t;
    });
    return best;
  }

  // 主人公 (x,y) の後ろへ、カメラの向き yaw のときに下がれる距離（建物にめり込まない距離）。
  // 真後ろの線だけでなく、少し左右に開いた線も調べる（開いた線ほど、その分だけ甘く見る）。
  // こうすると、カメラが回って建物の角に近づくにつれて、距離が少しずつ縮む（急に縮まない）
  const CLEAR_MAX = 8;
  function clearance(x, y, yaw) {
    let best = CLEAR_MAX;
    for (let k = -3; k <= 3; k++) {
      const a = k * 0.12;
      const d = freeDistance(x, y, yaw + Math.PI + a, CLEAR_MAX, 0.2) + Math.abs(a) * 9;
      if (d < best) best = d;
    }
    return best - 0.3;
  }

  // カメラを向けたい向き want に対して、いま目指す向きを返す（need＝後ろに要る距離。cur＝いまのカメラの向き）。
  //   ・want が建物で塞がっているときは、いちばん近い空いている向きを目指す（主人公の横から見る形になる。
  //     主人公が建物から離れて後ろが空けば、背中の後ろへ回り切る）
  //   ・そこまで回る途中に建物があるときは、建物の中を通り抜けない：
  //     大きく回る場面（100度より大きい）で反対回りが空いていれば反対回りで、そうでなければ建物の手前で待つ
  function safeYaw(x, y, want, cur, need) {
    const step = 0.1;
    const ok = function (yaw) { return clearance(x, y, yaw) >= need; };
    let goal = want;
    if (!ok(want)) {
      const sg = angDiff(cur, want) >= 0 ? 1 : -1;      // いまのカメラに近い側を先に見る
      let found = false;
      for (let off = step; off <= Math.PI && !found; off += step) {
        if (ok(want + sg * off)) { goal = want + sg * off; found = true; }
        else if (ok(want - sg * off)) { goal = want - sg * off; found = true; }
      }
      if (!found) return want;
    }
    if (!ok(cur)) return goal;                          // いまの向きが塞がっている：近い回り方で、すぐ抜ける
    const d = angDiff(goal, cur);                       // 近い回り方（符号つき）
    // cur から total だけ回る間に、最初に塞がる所（何歩目か。無ければ -1）
    const firstBlock = function (total) {
      const n = Math.ceil(Math.abs(total) / step);
      for (let i = 1; i < n; i++) if (!ok(cur + total * i / n)) return i;
      return -1;
    };
    const fb = firstBlock(d);
    if (fb < 0) return goal;
    if (Math.abs(d) > 1.75) {
      const dl = d > 0 ? d - Math.PI * 2 : d + Math.PI * 2;         // 反対回り
      if (firstBlock(dl) < 0) return cur + clamp(dl, -1.2, 1.2);   // 反対回りの少し先を目指す（ばねが、そちらへ回る）
    }
    return cur + d * (fb - 1) / Math.ceil(Math.abs(d) / step);     // 建物の手前で待つ
  }

  // 画面を切り替えた直後など、カメラを一気に置くとき用：safeYaw を、向きが落ち着くまでくり返す
  function settledYaw(x, y, want, cur, need) {
    for (let i = 0; i < 8; i++) {
      const next = safeYaw(x, y, want, cur, need);
      if (Math.abs(angDiff(next, cur)) < 0.01) break;
      cur = next;
    }
    return cur;
  }

  // いまの速さ・構図で、カメラを置きたい距離
  function wantedDistance() {
    return CAMC.distance + CAMC.speedPull * fcam.spd + CAMC.arriveBack * ease(clamp(fcam.arr, 0, 1));
  }

  // 手で見回している度合い（0＝ふだんの動き 〜 1＝見回し中の動き）。見回した量が orbitFreeFrom 度までは 0、
  // orbitFreeTo 度で 1（その間は、ゆっくり→速く→ゆっくり移る）。見回し中は、建物があってもカメラを寄せず・上げず
  // （重なる建物は消す）、見る先も見回した向きの前方にする（どの向きでも、ふだんの背中ごしと同じ斜めの角度で見る）
  function orbitFree() {
    const d = Math.abs(fcam.orbit) * 180 / Math.PI;
    return ease(clamp((d - CAMC.orbitFreeFrom) / Math.max(CAMC.orbitFreeTo - CAMC.orbitFreeFrom, 0.001), 0, 1));
  }

  // 画面を切り替えたとき：主人公の真後ろから始める（真後ろが建物なら、空いている向きから）
  function resetFollowCamera() {
    fcam.px = player.x; fcam.py = player.y;
    fcam.yaw = settledYaw(player.x, player.y, player.heading, player.heading, CAMC.minDistance);
    fcam.yawVel = 0;
    fcam.orbit = 0; fcam.idle = 99; fcam.arr = 0; fcam.arrB = null; fcam.spd = 0; fcam.omix = 0;
    fadeNow.clear();                                    // 半透明の具合も、最初から決め直す
    fcam.dist = fcam.bdist = clamp(clearance(fcam.px, fcam.py, fcam.yaw), 1.4, CAMC.distance);
  }

  // 全体マップから出発するとき：進む向きの少し横（建物の無い側）から始めて、背中の後ろへ回り込む。
  // 建物の入口から出るときは、進む向きの真後ろが建物なので、建物にめり込まない向き（主人公の横）から始める
  function startFollowCamera(ang) {
    const left = clearance(player.x, player.y, ang - 0.6);
    const right = clearance(player.x, player.y, ang + 0.6);
    fcam.yaw = settledYaw(player.x, player.y, ang + (right > left ? 0.6 : -0.6), fcam.yaw, CAMC.minDistance);
    fcam.yawVel = 0;
    fcam.dist = fcam.bdist = clamp(clearance(fcam.px, fcam.py, fcam.yaw), 1.4, CAMC.distance);
  }

  // 見回す（＋で右へ、－で左へ）
  function lookAround(rad) {
    fcam.orbit = angDiff(fcam.orbit + rad, 0);
    fcam.idle = 0;
  }

  // 手で見回した分を、カメラの向きそのものへ移す（移動画面で行き先を押したとき）。
  // いま見ている向きから、背中の後ろへ1回で回り込むようになる（主人公の向きの変化に引っぱられて二度回らない）
  function keepLookAsYaw() {
    fcam.yaw = angDiff(fcam.yaw + fcam.orbit, 0);
    fcam.orbit = 0;
    fcam.idle = 99;
  }

  // 到着したときにカメラが向く向き。建物の絵は「南東から見た絵」なので、
  // 主人公から建物を見る向きを、その向きへ少し寄せる（入口が、絵のとおりの側に見える）
  // その向きだとカメラが別の建物にめり込むときは、寄せる量を減らす（または逆へ寄せる）。
  const arriveYawCache = new Map();
  function arriveYaw(b) {
    if (arriveYawCache.has(b)) return arriveYawCache.get(b);
    const e = entranceOf(b), ex = e.x + 0.5, ey = e.y + 0.5;
    const to = Math.atan2(b.y + b.size / 2 - ey, b.x + b.size / 2 - ex);
    const side = clamp(angDiff(ISO_VIEW, to), -CAMC.arriveSide, CAMC.arriveSide);
    const need = CAMC.distance + CAMC.arriveBack + 0.4;
    const tries = [1, 0.5, 0, -0.5, -1];
    let best = to, bestFree = -1;
    for (let i = 0; i < tries.length; i++) {
      const yaw = to + side * tries[i];
      const free = clearance(ex, ey, yaw);
      if (free > bestFree + 0.001) { best = yaw; bestFree = free; }
      if (free >= need) break;
    }
    arriveYawCache.set(b, best);
    return best;
  }

  function updateFollowCamera(dt) {
    const c = fcam, p = player;
    const full = C.walkSpeed * C.skateMultiplier;

    // 位置：主人公を少し遅れて追う
    const k = 1 - Math.exp(-dt * CAMC.followRate);
    if (p.carve) {                                      // ★カーブでよけている間は、横へずれた分の半分だけ追う（カメラが大きく揺れないように）
      c.px += (p.x - p.carveOx * 0.5 - c.px) * k;
      c.py += (p.y - p.carveOy * 0.5 - c.py) * k;
    } else {
      c.px += (p.x - c.px) * k;
      c.py += (p.y - c.py) * k;
    }

    // 速さ（引きと視野の味付けに使う）
    c.spd += (clamp(p.speed / full, 0, 1) - c.spd) * (1 - Math.exp(-dt * 2.2));

    // 行き先の建物が近づいたら、到着の構図へ移る。
    // 構図の途中で行き先が変わったときは、構図が戻り切るまで前の建物のまま使う（見る先が急に飛ばないように）
    let near = false;
    const b = state.dest;
    if (b && (!c.arrB || c.arrB === b)) {
      const e = entranceOf(b);
      const remain = p.route ? p.route.total - p.dist : Math.hypot(e.x + 0.5 - p.x, e.y + 0.5 - p.y);
      near = remain < CAMC.arriveRange;
      if (near) c.arrB = b;
    }
    c.arr += ((near ? 1 : 0) - c.arr) * (1 - Math.exp(-dt * 2.4));
    if (!near && c.arr < 0.01) { c.arr = 0; c.arrB = null; }

    // 向き：主人公の向きを少し遅れて追う（曲がり角で、景色がぐるっと回る）。到着の構図では、建物を見せる向き
    // （板に乗る間は、体の向きが大きく回る。その向きではなく、これから進む向きを追う）
    let face = (p.mode === "mount" && p.route && p.route.total > 0.01) ? routeAt(p.route, 0).ang : p.heading;
    if (p.carve) face -= p.carveYaw;                    // ★カーブでよけている間は、体の向きではなく道のりの向きを追う
    let want = near ? arriveYaw(b) : face;
    want = safeYaw(c.px, c.py, want, c.yaw, CAMC.minDistance);      // 建物にめり込む向きは避ける
    // ばねで引くように追わせる：回り始めと回り終わりがゆるやかになり、カクッと回らない。回る速さには上限を付ける
    const w = CAMC.turnRate, h = Math.min(dt, 0.05), vmax = CAMC.maxTurn * Math.PI / 180;
    c.yawVel += (w * w * angDiff(want, c.yaw) - 2 * w * c.yawVel) * h;
    c.yawVel = clamp(c.yawVel, -vmax, vmax);
    c.yaw = angDiff(c.yaw + c.yawVel * h, 0);

    // 手で見回した分は、移動中は少し待ってから背中の後ろへ戻す（止まっている間は、そのまま）
    c.idle += dt;
    if (isMoving() && c.idle > CAMC.returnAfter) c.orbit *= Math.exp(-dt * 2.5);

    // 距離：速いとき・到着の構図では少し引く。後ろに建物があるときは、めり込まない所まで縮める（主人公へ寄る）
    const dist = clamp(Math.min(wantedDistance(), clearance(c.px, c.py, c.yaw + c.orbit)), 1.4, 99);
    c.bdist += (dist - c.bdist) * (1 - Math.exp(-dt * (dist < c.bdist ? 14 : 3)));   // 縮めるのは速く、戻すのはゆっくり
    // 手で見回している間は、建物があっても寄せない（いつもの距離のまま。カメラと重なる建物は、描く所で消す）。
    // 見回し始めは見回した量のとおりに移る（ただし1秒に 8 までの速さ。速くなぞっても、距離や角度が1コマで大きく動かない）。
    // 戻すときは少しずつ戻す。移動中は、建物をよけた距離（bdist）がいつもの距離へ戻った分だけ戻す（行き先を押すと見回した分は
    // 一気に 0 になるが、カメラの向きは今のまま背中へ回り込むので、回り切って後ろが空くまでは寄せない。その間、重なる建物は描く所で消す）
    const om = orbitFree();
    if (om >= c.omix) c.omix = Math.min(om, c.omix + dt * 8);
    else {
      const rate = isMoving() ? 4 * clamp((c.bdist - 1.4) / Math.max(wantedDistance() - 1.4, 0.1), 0.12, 1) : 4;
      c.omix += (om - c.omix) * (1 - Math.exp(-dt * rate));
      if (c.omix - om < 0.001) c.omix = om;             // 戻り切ったら、ちょうどの値にする（見回しを戻し切ったら、ふだんの動きと同じ計算に戻る）
    }
    c.dist = lerp(c.bdist, wantedDistance(), c.omix);
  }

  // いまのカメラの位置・向き・視野を計算する（描く前・押した場所を調べる前に呼ぶ）
  function followFrame() {
    const c = fcam;
    const yaw = c.yaw + c.orbit;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const a = ease(clamp(c.arr, 0, 1));
    const dist = c.dist;

    // カメラの位置＝主人公の後ろ・少し上
    c.ex = c.px - cs * dist;
    c.ey = c.py - sn * dist;
    const tall = clamp((viewH / viewW - 0.8) / 0.6, 0, 1);          // 縦長の画面か（0＝横長 〜 1＝スマホの縦画面）
    c.ez = CAMC.height + CAMC.arriveUp * a + CAMC.tallUp * tall;    // 縦長の画面では高くから見下ろす（空ばかりにならないように）
    c.ez += clamp(CAMC.distance - dist, 0, 3) * 0.3;                // 建物をよけて主人公へ寄ったときは、その分だけ高くから見る

    // 見る先＝主人公の少し前。到着の構図では、主人公と建物の間（少し高め）。
    // 手で見回している間は、建物へ寄せる量を減らす（見回した向きの前方を見る）
    let tx = c.px + cs * CAMC.lookAhead, ty = c.py + sn * CAMC.lookAhead, tz = CAMC.lookHeight;
    if (player.trick) { const air = trickAir(player); c.ez += air * 0.25; tz += air * 0.3; }   // ★跳んでいる間は、その高さに少しだけついていく
    const ab = a * (1 - c.omix);
    if (ab > 0 && c.arrB) {
      const b = c.arrB;
      tx = lerp(tx, lerp(c.px, b.x + b.size / 2, 0.62), ab);
      ty = lerp(ty, lerp(c.py, b.y + b.size / 2, 0.62), ab);
      tz = lerp(tz, 1.7, ab);
    }
    const dx = tx - c.ex, dy = ty - c.ey, dz = tz - c.ez;
    const dh = Math.hypot(dx, dy) || 0.001;
    c.look = Math.atan2(dy, dx);
    c.pitch = Math.atan2(-dz, dh);

    // 視野：縦の角度で決める。縦長の画面では、横の角度が下限より狭くならないようにする
    const fov = (CAMC.fov + CAMC.speedFov * c.spd) * Math.PI / 180;
    const fTall = (viewH / 2) / Math.tan(fov / 2);
    const fWide = (viewW / 2) / Math.tan(CAMC.minWideFov * Math.PI / 360);
    c.f = Math.min(fTall, fWide) * (1 + CAMC.arriveZoom * a);       // 到着の構図では、少し大きく写す
    c.cx = viewW / 2;
    c.cy = viewH * (CAMC.centerY + CAMC.tallCenterY * tall);

    // 主人公の足元が画面の下へ切れるときは、その分だけ下を向く（主人公を見失わないように）
    const ph = Math.hypot(c.px - c.ex, c.py - c.ey) || 0.001;
    const footAng = Math.atan2(c.ez, ph * Math.cos(Math.atan2(c.py - c.ey, c.px - c.ex) - c.look));   // 足元を見下ろす角度
    const lowest = Math.atan2(viewH * 0.88 - c.cy, c.f);            // 画面の下のふち近くが、見ている向きから何度下か
    if (footAng - c.pitch > lowest) c.pitch = footAng - lowest;

    // カメラの向き（前・右・上）
    const cl = Math.cos(c.look), sl = Math.sin(c.look), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    c.fx = cl * cp; c.fy = sl * cp; c.fz = -sp;
    c.rx = -sl; c.ry = cl;
    c.ux = cl * sp; c.uy = sl * sp; c.uz = cp;
    c.horizon = c.cy - c.f * Math.tan(c.pitch);
  }

  // 地図の位置（wx, wy・高さ wz マス）を、画面の位置に直す。z＝カメラからの奥行き（NEAR より小さければ、見えない）
  function project(wx, wy, wz) {
    const c = fcam;
    const dx = wx - c.ex, dy = wy - c.ey, dz = wz - c.ez;
    const z = dx * c.fx + dy * c.fy + dz * c.fz;
    const zz = z > 0.0001 ? z : 0.0001;
    return {
      x: c.cx + c.f * (dx * c.rx + dy * c.ry) / zz,
      y: c.cy - c.f * (dx * c.ux + dy * c.uy + dz * c.uz) / zz,
      z: z
    };
  }

  // 向きだけ（az＝水平の向き、el＝見上げる角度）を、画面の位置に直す。遠くの雲や島に使う
  function projectDir(az, el) {
    const c = fcam;
    const ce = Math.cos(el), dx = Math.cos(az) * ce, dy = Math.sin(az) * ce, dz = Math.sin(el);
    const z = dx * c.fx + dy * c.fy + dz * c.fz;
    if (z < 0.15) return null;
    return { x: c.cx + c.f * (dx * c.rx + dy * c.ry) / z, y: c.cy - c.f * (dx * c.ux + dy * c.uy + dz * c.uz) / z };
  }

  // 地面の上の多角形（地図の位置の並び [[x,y], …]）の道すじを作る。
  // カメラの後ろへ回る部分は、近い面で切り取る（切り取らないと、絵が裏返って画面いっぱいに広がる）。
  // 見える所が無ければ false。
  function groundPath(pts) {
    const c = fcam, cam3 = [];
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i][0] - c.ex, dy = pts[i][1] - c.ey, dz = -c.ez;
      cam3.push([dx * c.rx + dy * c.ry, dx * c.ux + dy * c.uy + dz * c.uz, dx * c.fx + dy * c.fy + dz * c.fz]);
    }
    return camPath(cam3);
  }

  // カメラから見た点の並び [[右, 上, 奥], …] を、近い面で切り取って、道すじにする
  function camPath(cam3) {
    const c = fcam, out = [];
    for (let i = 0; i < cam3.length; i++) {
      const a = cam3[i], b = cam3[(i + 1) % cam3.length];
      const ain = a[2] >= NEAR, bin = b[2] >= NEAR;
      if (ain) out.push(a);
      if (ain !== bin) {                                // 近い面をまたぐ辺：面との交点を足す
        const t = (NEAR - a[2]) / (b[2] - a[2]);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
      }
    }
    if (out.length < 3) return false;
    ctx.beginPath();
    for (let i = 0; i < out.length; i++) {
      const x = c.cx + c.f * out[i][0] / out[i][2], y = c.cy - c.f * out[i][1] / out[i][2];
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
    return true;
  }

  // 地面に置いた円（中心 wx, wy・半径 r マス）の、画面上のだ円。見えなければ null
  function groundEllipse(wx, wy, r) {
    const c = fcam, q = project(wx, wy, 0);
    if (q.z < NEAR * 2) return null;
    const rx = r * c.f / q.z;
    const d = Math.hypot(wx - c.ex, wy - c.ey, c.ez) || 1;
    return { x: q.x, y: q.y, rx: rx, ry: Math.max(0.5, rx * c.ez / d) };   // 見下ろす角度が浅いほど、つぶれて見える
  }

  // 色（#rrggbb）を数字3つに直す
  function rgbOf(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const HAZE = [214, 236, 246];                         // 遠くをかすませる色（水平線の空の色）
  const GROUND_RGB = {
    grass: [rgbOf(COLORS.grassB), rgbOf(COLORS.grassA)],
    road: [rgbOf(COLORS.roadB), rgbOf(COLORS.roadA)],
    pond: [rgbOf(COLORS.pondB), rgbOf(COLORS.pondA)]
  };
  function hazed(rgb, t) {
    return "rgb(" + Math.round(lerp(rgb[0], HAZE[0], t)) + "," + Math.round(lerp(rgb[1], HAZE[1], t)) + "," + Math.round(lerp(rgb[2], HAZE[2], t)) + ")";
  }
  // 奥行き z の所を、どれだけかすませるか（0〜fog）
  function hazeAt(z) { return clamp((z - 5) / 17, 0, 1) * CAMC.fog; }

  // 遠くの雲と島（向きだけで置く。カメラが回ると、横へ流れる）
  const CLOUDS = [], ISLES = [];
  for (let i = 0; i < 11; i++) {
    CLOUDS.push({ az: i * 0.571 + hash(i, 3) * 0.3, el: 0.10 + hash(i, 7) * 0.30, size: 0.6 + hash(i, 11) * 0.7 });
  }
  for (let i = 0; i < 7; i++) {
    ISLES.push({ az: i * 0.898 + hash(i, 5) * 0.5, w: 0.10 + hash(i, 9) * 0.12, h: 0.018 + hash(i, 13) * 0.022 });
  }

  // 空・遠くの島・海
  function followSky() {
    const c = fcam;
    const hy = clamp(c.horizon, -10, viewH + 10);
    if (hy > 0) {
      const g = ctx.createLinearGradient(0, hy - viewH * 0.75, 0, hy);
      g.addColorStop(0, "#6fbdea");
      g.addColorStop(1, "#d6ecf6");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, viewW, hy);
    }
    // 雲
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    CLOUDS.forEach(function (cl) {
      const q = projectDir(cl.az, cl.el);
      if (!q) return;
      const r = cl.size * 0.085 * c.f;
      if (q.x < -r * 3 || q.x > viewW + r * 3 || q.y < -r * 2) return;
      ctx.beginPath();
      ctx.ellipse(q.x, q.y, r * 1.5, r * 0.42, 0, 0, Math.PI * 2);
      ctx.ellipse(q.x - r * 0.55, q.y - r * 0.22, r * 0.7, r * 0.42, 0, 0, Math.PI * 2);
      ctx.ellipse(q.x + r * 0.45, q.y - r * 0.30, r * 0.85, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    // 遠くの島（下半分は、この後に塗る海で隠れる）
    ctx.fillStyle = "#a9cfd2";
    ISLES.forEach(function (s) {
      const q = projectDir(s.az, 0);
      if (!q) return;
      const w = s.w * c.f, h = s.h * c.f;
      if (q.x < -w * 2 || q.x > viewW + w * 2) return;
      ctx.beginPath();
      ctx.ellipse(q.x, q.y, w, h, 0, 0, Math.PI * 2);
      ctx.ellipse(q.x + w * 0.5, q.y, w * 0.6, h * 1.6, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    // 海（地図の外）
    if (hy < viewH) {
      const g = ctx.createLinearGradient(0, hy, 0, hy + viewH * 0.6);
      g.addColorStop(0, "#a8dcf0");
      g.addColorStop(0.12, "#63bbe6");
      g.addColorStop(1, "#3f9fd8");
      ctx.fillStyle = g;
      ctx.fillRect(0, hy, viewW, viewH - hy);
    }
  }

  // 地面のマスの角を、カメラから見た位置に直した物（毎回、followGround が書き直す）
  const GN = (COLS + 1) * (ROWS + 1);
  const gX = new Float32Array(GN), gY = new Float32Array(GN), gZ = new Float32Array(GN);
  const gSX = new Float32Array(GN), gSY = new Float32Array(GN);

  // 地面（砂浜のふち → マス → 入口のマット）
  function followGround(now) {
    const c = fcam;

    // 砂浜：地図より少し広い四角
    const m = 0.8;
    if (groundPath([[-m, -m], [COLS + m, -m], [COLS + m, ROWS + m], [-m, ROWS + m]])) {
      ctx.fillStyle = "#ecdfb4";
      ctx.fill();
    }

    // マスの角を、まとめて写す
    for (let y = 0, i = 0; y <= ROWS; y++) {
      for (let x = 0; x <= COLS; x++, i++) {
        const dx = x - c.ex, dy = y - c.ey, dz = -c.ez;
        const z = dx * c.fx + dy * c.fy + dz * c.fz;
        gX[i] = dx * c.rx + dy * c.ry;
        gY[i] = dx * c.ux + dy * c.uy + dz * c.uz;
        gZ[i] = z;
        if (z >= NEAR) { gSX[i] = c.cx + c.f * gX[i] / z; gSY[i] = c.cy - c.f * gY[i] / z; }
      }
    }

    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    for (let ty = 0; ty < ROWS; ty++) {
      for (let tx = 0; tx < COLS; tx++) {
        const i0 = ty * (COLS + 1) + tx, i1 = i0 + 1, i3 = i0 + COLS + 1, i2 = i3 + 1;
        const behind = (gZ[i0] < NEAR ? 1 : 0) + (gZ[i1] < NEAR ? 1 : 0) + (gZ[i2] < NEAR ? 1 : 0) + (gZ[i3] < NEAR ? 1 : 0);
        if (behind === 4) continue;                     // 全部カメラの後ろ
        const zc = (gZ[i0] + gZ[i1] + gZ[i2] + gZ[i3]) / 4;
        if (behind === 0) {
          // 画面の外のマスは描かない
          if ((gSX[i0] < 0 && gSX[i1] < 0 && gSX[i2] < 0 && gSX[i3] < 0) ||
              (gSX[i0] > viewW && gSX[i1] > viewW && gSX[i2] > viewW && gSX[i3] > viewW) ||
              (gSY[i0] > viewH && gSY[i1] > viewH && gSY[i2] > viewH && gSY[i3] > viewH) ||
              (gSY[i0] < -2 && gSY[i1] < -2 && gSY[i2] < -2 && gSY[i3] < -2)) continue;   // 画面の上の外（高くから見下ろすとき、遠くのマス）
          ctx.beginPath();
          ctx.moveTo(gSX[i0], gSY[i0]); ctx.lineTo(gSX[i1], gSY[i1]); ctx.lineTo(gSX[i2], gSY[i2]); ctx.lineTo(gSX[i3], gSY[i3]);
          ctx.closePath();
        } else if (!camPath([[gX[i0], gY[i0], gZ[i0]], [gX[i1], gY[i1], gZ[i1]], [gX[i2], gY[i2], gZ[i2]], [gX[i3], gY[i3], gZ[i3]]])) {
          continue;
        }
        const t = MAP[ty][tx], odd = (tx + ty) % 2;
        const kind = t === T.ROAD ? "road" : (t === T.POND ? "pond" : "grass");
        const col = hazed(GROUND_RGB[kind][odd], hazeAt(zc));
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = (kind === "road" && zc < 12) ? COLORS.roadLine : col;   // 道は継ぎ目の線、ほかはすき間うめ
        ctx.stroke();
        if (behind === 0 && zc < 11) followGroundDetail(t, tx, ty, zc, now);
      }
    }
    ctx.lineJoin = "miter";

    // 入口の前のマット（建物の屋根の色）
    BUILDINGS.forEach(function (b) {
      const e = entranceOf(b);
      if (!groundPath([[e.x + 0.2, e.y + 0.2], [e.x + 0.8, e.y + 0.2], [e.x + 0.8, e.y + 0.8], [e.x + 0.2, e.y + 0.8]])) return;
      ctx.fillStyle = shade(b.roofColor, 0.35);
      ctx.fill();
      ctx.strokeStyle = shade(b.roofColor, -0.1);
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // 目的地の印（地面で、白い輪が広がる）
    if (state.goal && isMoving()) {
      const k = (now * 0.9) % 1;
      const g = groundEllipse(state.goal.x + 0.5, state.goal.y + 0.5, 0.3 + 0.45 * k);
      if (g) {
        ctx.strokeStyle = "rgba(255,255,255," + (1 - k).toFixed(3) + ")";
        ctx.lineWidth = clamp(g.rx * 0.12, 1.5, 4);
        ctx.beginPath(); ctx.ellipse(g.x, g.y, g.rx, g.ry, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  // 近くのマスの飾り（花・小石・草のしげみ・水面のゆらぎ）
  function followGroundDetail(t, tx, ty, zc, now) {
    const c = fcam;
    const fade = clamp((11 - zc) / 3, 0, 1);            // 遠くは、だんだん消す
    if (t === T.POND) {
      const k = (now * 0.35 + hash(tx, ty)) % 1;
      const g = groundEllipse(tx + 0.5 + (hash(ty, tx) - 0.5) * 0.5, ty + 0.5, 0.12 + k * 0.22);
      if (!g) return;
      ctx.strokeStyle = "rgba(255,255,255," + (0.6 * Math.sin(k * Math.PI) * fade).toFixed(3) + ")";
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.ellipse(g.x, g.y, g.rx, g.ry, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (t === T.FLOWER) {
      const cols = ["#ff8fb3", "#fff2a8", "#ffffff"];
      ctx.globalAlpha = fade;
      for (let i = 0; i < 3; i++) {
        const q = project(tx + 0.25 + 0.25 * i, ty + 0.3 + 0.4 * hash(tx + i, ty), 0.09);
        if (q.z < NEAR * 2) continue;
        const r = Math.max(1.2, 0.055 * c.f / q.z);
        const g0 = project(tx + 0.25 + 0.25 * i, ty + 0.3 + 0.4 * hash(tx + i, ty), 0);
        ctx.strokeStyle = COLORS.grassTuft;             // くき
        ctx.lineWidth = Math.max(1, r * 0.35);
        ctx.beginPath(); ctx.moveTo(g0.x, g0.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        ctx.fillStyle = cols[i];
        ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (t === T.ROAD) {
      if (hash(tx, ty) > 0.55) {                        // 小石
        const g = groundEllipse(tx + 0.5 + (hash(ty, tx) - 0.5) * 0.6, ty + 0.5 + (hash(tx + 7, ty) - 0.5) * 0.6, 0.035);
        if (!g) return;
        ctx.fillStyle = "rgba(120,90,40," + (0.3 * fade).toFixed(3) + ")";
        ctx.beginPath(); ctx.ellipse(g.x, g.y, g.rx, g.ry, 0, 0, Math.PI * 2); ctx.fill();
      }
    } else if (hash(tx, ty) > 0.6) {                    // 草のしげみ
      const q = project(tx + 0.5 + (hash(ty, tx) - 0.5) * 0.6, ty + 0.5 + (hash(tx + 3, ty) - 0.5) * 0.6, 0);
      if (q.z < NEAR * 2) return;
      const s = c.f / q.z;
      ctx.globalAlpha = fade;
      ctx.strokeStyle = COLORS.grassTuft;
      ctx.lineWidth = clamp(s * 0.03, 1, 3);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(q.x - 0.07 * s, q.y); ctx.lineTo(q.x - 0.03 * s, q.y - 0.11 * s);
      ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + 0.02 * s, q.y - 0.14 * s);
      ctx.moveTo(q.x + 0.07 * s, q.y); ctx.lineTo(q.x + 0.09 * s, q.y - 0.09 * s);
      ctx.stroke();
      ctx.lineCap = "butt";
      ctx.globalAlpha = 1;
    }
  }

  // ---- 立て看板（建物・木）：斜め見下ろしの絵を、そのまま画面の位置と大きさに合わせて描く ----

  // 建物の絵が入る四角（斜め画面の座標。土台の中心を原点にした物）。建物ごとに1回だけ計算して覚えておく
  const boxCache = new Map();
  function buildingBoxIso(b) {
    let box = boxCache.get(b);
    if (box) return box;
    const s = buildingShape(b), h = buildingHitShape(b);
    const cx = (s.Bk.x + s.F.x) / 2, cy = (s.Bk.y + s.F.y) / 2;
    box = { cx: cx, cy: cy, x0: h.sign.x0, x1: h.sign.x1, y0: h.sign.y0, y1: h.sign.y1 };
    const extra = h.tag ? [{ x: h.tag.x0, y: h.tag.y0 }, { x: h.tag.x1, y: h.tag.y1 }] : [];   // 準備中の小札も、四角に入れる
    h.body.concat([s.L, s.F, s.R], extra).forEach(function (p) {
      box.x0 = Math.min(box.x0, p.x); box.x1 = Math.max(box.x1, p.x);
      box.y0 = Math.min(box.y0, p.y); box.y1 = Math.max(box.y1, p.y);
    });
    box.x0 -= cx; box.x1 -= cx; box.y0 -= cy; box.y1 -= cy;
    boxCache.set(b, box);
    return box;
  }

  // 建物の立て看板の、画面上の位置（x, y＝土台の中心）・大きさ（s＝絵の拡大率）・四角（x0〜y1）・奥行き z。
  // カメラに近すぎる・後ろにあるときは null。先に followFrame を呼んでおくこと
  function billboardOf(b) {
    const q = project(b.x + b.size / 2, b.y + b.size / 2, 0);
    if (q.z < 0.6) return null;
    const s = fcam.f / q.z / ART_PX * CAMC.buildingScale;
    const box = buildingBoxIso(b);
    return {
      x: q.x, y: q.y, z: q.z, s: s, cx: box.cx, cy: box.cy,
      x0: q.x + box.x0 * s, x1: q.x + box.x1 * s, y0: q.y + box.y0 * s, y1: q.y + box.y1 * s
    };
  }

  // 木の立て看板（根元が原点）
  function treeBillboard(t) {
    const q = project(t.x + 0.5, t.y + 0.5, 0);
    if (q.z < 0.6) return null;
    const s = fcam.f / q.z / ART_PX * CAMC.treeScale;
    return { x: q.x, y: q.y, z: q.z, s: s, x0: q.x - 24 * s, x1: q.x + 24 * s, y0: q.y - 52 * s, y1: q.y + 10 * s };
  }

  // カメラに近すぎる建物・木を、どれだけ見せるか（0＝消す 〜 1＝そのまま）。
  // 立て看板は、すぐそばで見ると「画面をふさぐ巨大な1枚の絵」になるので、近づいたら消す（押しても当たらない）
  function nearFade(it, bb) {
    const c = fcam;
    if (it.t) return clamp((bb.z - 2.2) / 0.8, 0, 1);       // 半透明の時間は短くする（薄い大きな絵が残らないように）
    const b = it.b;
    if (c.ex > b.x && c.ex < b.x + b.size && c.ey > b.y && c.ey < b.y + b.size) return 0;   // カメラが土台の中
    if (bb.m) {
      // 立体の建物は、すぐそばで見ても画面をふさがない（壁の手前で切り取る）ので、カメラが土台のふちから
      // 0.5マスより近づいた時だけ消し始め、0.15マスで消し切る。
      // 見回し中に、カメラと主人公の間に来ても消さない（立て看板と違い、ポッと消えると目立つ）。
      // 主人公に重なる時は、renderFollow が本体の輪郭で調べて半透明（0.3）にする
      const mx = Math.max(b.x - c.ex, 0, c.ex - (b.x + b.size)), my = Math.max(b.y - c.ey, 0, c.ey - (b.y + b.size));
      return clamp((Math.hypot(mx, my) - 0.15) / 0.35, 0, 1);
    }
    const f = clamp((bb.z - 2.6) / 0.6, 0, 1);
    if (c.omix <= 0) return f;
    // 手で見回している間は、カメラを寄せないので、カメラが建物の土台のすぐそばに来る。
    // 土台まで 1マス以内なら消す（2マス離れていれば、そのまま見せる）。
    // カメラと主人公の間にある建物（主人公を隠す建物）も消す（半透明の大きな絵を画面に残さない）。
    // 見回しに少し移っただけでも（omix が 1/3 で）消し切る
    const gx = Math.max(b.x - c.ex, 0, c.ex - (b.x + b.size)), gy = Math.max(b.y - c.ey, 0, c.ey - (b.y + b.size));
    let v = clamp(Math.hypot(gx, gy) - 1, 0, 1);
    if (rayRectEnter(c.ex, c.ey, player.x - c.ex, player.y - c.ey, b.x, b.y, b.x + b.size, b.y + b.size) < 1) v = 0;
    return Math.min(f, lerp(1, v, clamp(c.omix * 3, 0, 1)));
  }

  // 半透明で描くための、下書き用のキャンバス（絵を1回ここに描いてから、まとめて薄く重ねる。
  // 直接うすく描くと、絵の中の重なりが透けて見えてしまうため）
  let ghost = null, ghostCtx = null;
  function drawGhost(alpha, bb, paint) {
    if (!ghost) { ghost = document.createElement("canvas"); ghostCtx = ghost.getContext("2d"); }
    if (ghost.width !== canvas.width || ghost.height !== canvas.height) { ghost.width = canvas.width; ghost.height = canvas.height; }
    // 絵が入る四角（キャンバスの実際のpx）
    const X0 = Math.max(0, Math.floor(bb.x0 * dpr) - 2), Y0 = Math.max(0, Math.floor(bb.y0 * dpr) - 2);
    const X1 = Math.min(canvas.width, Math.ceil(bb.x1 * dpr) + 2), Y1 = Math.min(canvas.height, Math.ceil(bb.y1 * dpr) + 2);
    if (X1 <= X0 || Y1 <= Y0) return;
    ghostCtx.setTransform(1, 0, 0, 1, 0, 0);
    ghostCtx.clearRect(X0, Y0, X1 - X0, Y1 - Y0);
    ghostCtx.save();
    ghostCtx.beginPath(); ghostCtx.rect(X0, Y0, X1 - X0, Y1 - Y0); ghostCtx.clip();
    ghostCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(ghostCtx);
    ghostCtx.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(ghost, X0, Y0, X1 - X0, Y1 - Y0, X0, Y0, X1 - X0, Y1 - Y0);
    ctx.restore();
  }

  // 立て看板を1つ描く。it＝{ b か t, bb, alpha }
  function paintBillboard(g, it, now) {
    const bb = it.bb;
    if (bb.m) { drawModel(g, it.b, bb, now); return; }  // 立体の形がある建物は、立体で描く
    g.save();
    g.translate(bb.x, bb.y);
    g.scale(bb.s, bb.s);
    if (it.b) {
      g.translate(-bb.cx, -bb.cy);                      // 土台の中心を、画面上の位置に合わせる
      Art.isoBuilding(g, it.b, now);
    } else {
      const r = iso(it.t.x + 0.5, it.t.y + 0.5);        // 根元を、画面上の位置に合わせる
      g.translate(-r.x, -r.y);
      Art.isoTree(g, it.t.x, it.t.y);
    }
    g.restore();
  }

  // ---- 立体の建物（config.js の camera.models が true のとき。形の置き場 BUILDING_MODEL に形がある建物だけ） ----
  //
  // 立て看板は「南東から見た1枚の絵」なので、どの向きから見ても同じ面が見える（建物がカメラについて回って見える）。
  // 形のある建物は、壁・屋根・煙突などを面として遠近法で写して塗る（回り込めば、横や裏の面が見える）。
  //   ・裏を向いた面は描かない。家の本体（4つの壁＋屋根）は、こちらを向いた面を「壁 → 屋根のふち → 屋根」の順に
  //     塗れば正しく重なる（本体は出っぱりの無い形で、カメラはいつも棟より高い所にある）
  //   ・本体から出っぱった物（煙突・樽・吊り看板など）は、付いている面がこちらを向いていれば本体の後に、
  //     向こうを向いていれば本体の前に描く（付いている面が、本体との境目になる）。同じ側の物どうしは、奥から順に描く
  //   ・明るさは、面の向きごとに決まった値（南が明るく、北が暗い。斜め見下ろしの絵の陰影に合わせる）
  //   ・名前の看板と「準備中」の札は、いつもこちらを向ける（名札。大きさは立て看板と同じく、遠いほど小さい）
  //
  // 形の置き場：BUILDING_MODEL.絵の名前 = { build(b) }。build は次の物を返す（位置は地図のマス、高さもマス）
  //   faces   … 本体の面 [{ pts: [[x,y,z], …], col: 色, layer: 0＝壁／1＝屋根のふち／2＝屋根, deco(R): 面に貼る飾り }]
  //   after(R) … 本体を塗った後に描く物（棟など。無くてもよい）
  //   attach  … 出っぱった物 [{ at: [x,y,z]（奥から順に並べるための点）, anchor: 付いている面（faces の1つ。null＝いつも本体の後）, draw(R) }]
  //   ground(R) … 地面の模様（いちばん先に描く。無くてもよい）
  //   sign    … 看板の中心 [x,y,z]
  //   hull    … 輪郭を決める点のまとまり [[[x,y,z], …], …]（まとまりごとの外周を、押した場所の判定と、絵が入る四角に使う）
  //   bound   … 絵が入る四角だけに足す点（煙など。無くてもよい）
  // R は描く道具（modelPen）。R.p＝写す、R.k＝その点での「絵の1px」の大きさ、R.poly＝面を塗る、R.lines＝線を引く、
  // R.box＝箱、R.disc＝面の上の円（点の並び）、R.dot＝こちらを向いた小さな丸、R.t＝秒、R.g＝描く先
  const BUILDING_MODEL = Object.create(null);

  // 地図の位置 [x,y,z] を、カメラから見た位置 [右, 上, 奥] に直す
  function camOf(p) {
    const c = fcam, dx = p[0] - c.ex, dy = p[1] - c.ey, dz = p[2] - c.ez;
    return [dx * c.rx + dy * c.ry, dx * c.ux + dy * c.uy + dz * c.uz, dx * c.fx + dy * c.fy + dz * c.fz];
  }

  // 奥行き z の所で、「絵の1px」が画面の何pxになるか（立て看板の拡大率と同じ）
  function modelK(z) { return fcam.f / Math.max(z, NEAR) / ART_PX * CAMC.buildingScale; }

  // 立体を描く道具（g＝描く先、now＝秒）
  function modelPen(g, now) {
    const c = fcam;
    const R = { g: g, t: now || 0 };
    const sx = function (q) { return c.cx + c.f * q[0] / q[2]; }, sy = function (q) { return c.cy - c.f * q[1] / q[2]; };
    const cut = function (a, b) {                        // 線 a→b が近い面と交わる点
      const t = (NEAR - a[2]) / (b[2] - a[2]);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR];
    };
    R.p = function (p) { return project(p[0], p[1], p[2]); };
    R.k = function (p) { return modelK(R.p(p).z); };
    // 面（点の並び）の道すじを作る。カメラの後ろへ回る部分は、近い面で切り取る。見える所が無ければ 0、あれば奥行きの平均
    R.path = function (pts) {
      const cam3 = pts.map(camOf), out = [];
      for (let i = 0; i < cam3.length; i++) {
        const a = cam3[i], b = cam3[(i + 1) % cam3.length];
        const ain = a[2] >= NEAR, bin = b[2] >= NEAR;
        if (ain) out.push(a);
        if (ain !== bin) out.push(cut(a, b));
      }
      if (out.length < 3) return 0;
      let zs = 0;
      g.beginPath();
      for (let i = 0; i < out.length; i++) {
        if (i) g.lineTo(sx(out[i]), sy(out[i])); else g.moveTo(sx(out[i]), sy(out[i]));
        zs += out[i][2];
      }
      g.closePath();
      return zs / out.length;
    };
    // 面を塗る。stroke＝ふちの線の色（無ければ引かない）、lw＝線の太さ（絵のpx。遠いほど細くなる）
    R.poly = function (pts, fill, stroke, lw) {
      const z = R.path(pts);
      if (!z) return;
      if (fill) { g.fillStyle = fill; g.fill(); }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = Math.max(0.35, (lw || 1) * modelK(z)); g.stroke(); }
    };
    // 線をまとめて引く（segs＝点の並びの並び）。カメラの後ろへ回る所は、近い面で切り取る
    R.lines = function (segs, col, lw) {
      let zs = 0, n = 0;
      g.beginPath();
      segs.forEach(function (s) {
        for (let i = 0; i + 1 < s.length; i++) {
          let a = camOf(s[i]), b = camOf(s[i + 1]);
          if (a[2] < NEAR && b[2] < NEAR) continue;
          if (a[2] < NEAR) a = cut(a, b); else if (b[2] < NEAR) b = cut(b, a);
          g.moveTo(sx(a), sy(a)); g.lineTo(sx(b), sy(b));
          zs += a[2] + b[2]; n += 2;
        }
      });
      if (!n) return;
      g.strokeStyle = col; g.lineWidth = Math.max(0.35, (lw || 1) * modelK(zs / n)); g.stroke();
    };
    // 箱（地図の向きにそろった箱。p0＝西北の下の角、p1＝東南の上の角）。cols の向き（s・n・e・w・top）のうち、こちらを向いた面だけ塗る
    R.box = function (p0, p1, cols, stroke) {
      const st = stroke === undefined ? COLORS.outline : stroke;
      const x0 = p0[0], y0 = p0[1], z0 = p0[2], x1 = p1[0], y1 = p1[1], z1 = p1[2];
      if (cols.n && c.ey < y0) R.poly([[x1, y0, z0], [x0, y0, z0], [x0, y0, z1], [x1, y0, z1]], cols.n, st);
      if (cols.s && c.ey > y1) R.poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], cols.s, st);
      if (cols.w && c.ex < x0) R.poly([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], cols.w, st);
      if (cols.e && c.ex > x1) R.poly([[x1, y1, z0], [x1, y0, z0], [x1, y0, z1], [x1, y1, z1]], cols.e, st);
      if (cols.top && c.ez > z1) R.poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], cols.top, st);
    };
    // 面の上の円（だ円）の点の並び。o＝中心、u・v＝面にそった2つの向き（長さ1）、ru・rv＝それぞれの半径（マス）
    R.disc = function (o, u, v, ru, rv, n) {
      const pts = [];
      for (let i = 0; i < (n || 14); i++) {
        const q = i / (n || 14) * Math.PI * 2, a = Math.cos(q) * ru, b = Math.sin(q) * rv;
        pts.push([o[0] + u[0] * a + v[0] * b, o[1] + u[1] * a + v[1] * b, o[2] + u[2] * a + v[2] * b]);
      }
      return pts;
    };
    // こちらを向いた小さな丸（花・取っ手など）。r＝半径（絵のpx）
    R.dot = function (p, r, col) {
      const q = R.p(p);
      if (q.z < NEAR * 2) return;
      g.beginPath(); g.arc(q.x, q.y, Math.max(0.5, r * modelK(q.z)), 0, Math.PI * 2);
      g.fillStyle = col; g.fill();
    };
    return R;
  }

  // 面の外向きの向き（点の並びから求め、inside＝建物の内側の点から離れる向きにそろえる）
  function faceNormal(pts, inside) {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const p = pts[0];
    if (nx * (p[0] - inside[0]) + ny * (p[1] - inside[1]) + nz * (p[2] - inside[2]) < 0) { nx = -nx; ny = -ny; nz = -nz; }
    return [nx, ny, nz];
  }

  // 面がカメラのほうを向いているか
  function facesCam(f) {
    const c = fcam, p = f.pts[0];
    return (c.ex - p[0]) * f.n[0] + (c.ey - p[1]) * f.n[1] + (c.ez - p[2]) * f.n[2] > 0;
  }

  // 建物の立体の形（建物ごとに1回だけ作って覚えておく）
  const modelCache = new Map();
  function modelOf(b) {
    let m = modelCache.get(b);
    if (m) return m;
    m = BUILDING_MODEL[b.art].build(b);
    const mid = [b.x + b.size / 2, b.y + b.size / 2, 0.3];
    m.faces.forEach(function (f) { f.n = faceNormal(f.pts, f.inside || mid); });
    modelCache.set(b, m);
    return m;
  }

  // 点の並び（画面上）を囲む、いちばん小さい凸の多角形
  function convexHull(pts) {
    const p = pts.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    if (p.length < 3) return p;
    const cross = function (o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); };
    const lo = [], up = [];
    p.forEach(function (q) {
      while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
      lo.push(q);
    });
    for (let i = p.length - 1; i >= 0; i--) {
      const q = p[i];
      while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
      up.push(q);
    }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  // 立体の建物の、画面上の位置（立て看板の billboardOf と同じ役目）。
  //   x, y, z＝土台の中心（画面上の位置と奥行き。奥から並べる順に使う）、x0〜y1＝絵が入る四角、
  //   hulls＝輪郭（まとまりごとに、写した点の外周）、sign・tag＝看板と準備中の小札の四角（見えなければ null）、m＝形。
  // 全部がカメラの後ろなら null
  const SIGN_NEAR = 3.2;                                // 看板の大きさを止める奥行き（立て看板は、これより近いと薄くなり始める）
  function modelBoxOf(b) {
    const m = modelOf(b);
    const q = project(b.x + b.size / 2, b.y + b.size / 2, 0);
    const pts = [], hulls = [];
    let behind = false;
    m.hull.forEach(function (group) {                   // まとまりごとに写して、外周を取る
      const gp = [];
      group.forEach(function (h) {
        const p = project(h[0], h[1], h[2]);
        if (p.z < NEAR) behind = true; else gp.push(p);
      });
      if (gp.length >= 3) hulls.push(convexHull(gp)); else hulls.push(null);
      Array.prototype.push.apply(pts, gp);
    });
    if (!pts.length) return null;
    const bb = { m: m, x: q.x, y: q.y, z: q.z, hulls: hulls, sign: null, tag: null, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const grow = function (x0, y0, x1, y1) {
      bb.x0 = Math.min(bb.x0, x0); bb.y0 = Math.min(bb.y0, y0); bb.x1 = Math.max(bb.x1, x1); bb.y1 = Math.max(bb.y1, y1);
    };
    pts.forEach(function (p) { grow(p.x, p.y, p.x, p.y); });
    (m.bound || []).forEach(function (h) {
      const p = project(h[0], h[1], h[2]);
      if (p.z < NEAR) behind = true; else grow(p.x, p.y, p.x, p.y);
    });
    // 看板（＋準備中の小札）。大きさは立て看板と同じく、土台の中心の奥行きで決める（看板の点の奥行きで決めると、
    // 近い時ほど、ほかの建物の看板より大きくなる）。すぐそばでは、立て看板が見える一番近い所（奥行き SIGN_NEAR）の大きさで止める
    const sp = project(m.sign[0], m.sign[1], m.sign[2]);
    if (sp.z >= NEAR) {
      const k = modelK(Math.max(q.z, SIGN_NEAR)), z = buildingSignSize(ctx, b);
      bb.sign = { x: sp.x, y: sp.y, k: k, x0: sp.x - (z.w / 2 + 1) * k, x1: sp.x + (z.w / 2 + 1) * k, y0: sp.y - (z.h / 2 + 1) * k, y1: sp.y + (z.h / 2 + 1) * k };   // 1＝ふちの線の分
      grow(bb.sign.x0, bb.sign.y0, bb.sign.x1, bb.sign.y1);
      if (isPending(b)) {
        const t = pendingTagRect(ctx, 0, 0, z.h);
        bb.tag = { x0: sp.x + (t.x0 - 1) * k, x1: sp.x + (t.x1 + 1) * k, y0: sp.y + t.y0 * k, y1: sp.y + (t.y1 + 1) * k };
        grow(bb.tag.x0, bb.tag.y0, bb.tag.x1, bb.tag.y1);
      }
    }
    const pad = 4 * modelK(q.z);                        // 線の太さの分
    bb.x0 -= pad; bb.y0 -= pad; bb.x1 += pad; bb.y1 += pad;
    if (behind) {                                       // 一部がカメラの後ろ：写した点では四角が決まらないので、画面全体にする
      bb.x0 = Math.min(bb.x0, 0); bb.y0 = Math.min(bb.y0, 0); bb.x1 = Math.max(bb.x1, viewW); bb.y1 = Math.max(bb.y1, viewH);
    }
    return bb;
  }

  // 画面上の点 (x,y) が、立体の建物（輪郭か看板。準備中なら小札も）の上にあるか。
  // bodyOnly＝本体（最初のまとまり）だけで調べる（主人公を隠しているかの判定用。樽や吊り看板が足元にかかっただけで、建物ごと薄くしない）
  function modelHit(bb, x, y, bodyOnly) {
    const s = bb.sign, t = bb.tag, pt = { x: x, y: y };
    return bb.hulls.some(function (h, i) { return h !== null && (!bodyOnly || i === 0) && insidePoly(pt, h); }) || (s !== null && x > s.x0 && x < s.x1 && y > s.y0 && y < s.y1) ||
      (t !== null && x > t.x0 && x < t.x1 && y > t.y0 && y < t.y1);
  }

  // 建物の画面上の位置：立体の形があれば立体（modelBoxOf）、無ければ立て看板（billboardOf）
  function followBox(b) {
    return (CAMC.models && BUILDING_MODEL[b.art]) ? modelBoxOf(b) : billboardOf(b);
  }

  // 立体の建物を描く（bb＝modelBoxOf の結果）
  function drawModel(g, b, bb, now) {
    const m = bb.m, R = modelPen(g, now);
    if (m.ground) m.ground(R);
    // 出っぱった物を、本体の向こう側（先に描く）と、こちら側（後に描く）に分け、それぞれ奥から並べる
    const back = [], front = [];
    m.attach.forEach(function (a) {
      const it = { a: a, z: project(a.at[0], a.at[1], a.at[2]).z };
      (a.anchor && !facesCam(a.anchor) ? back : front).push(it);
    });
    const farFirst = function (p, q) { return q.z - p.z; };
    back.sort(farFirst); front.sort(farFirst);
    back.forEach(function (it) { it.a.draw(R); });
    // 本体：こちらを向いた面を、壁 → 屋根のふち → 屋根 の順に（面ごとに、貼った飾りもすぐ描く）
    for (let layer = 0; layer < 3; layer++) {
      m.faces.forEach(function (f) {
        if (f.layer !== layer || !facesCam(f)) return;
        R.poly(f.pts, f.col, COLORS.outline, 1);
        if (f.deco) f.deco(R);
      });
    }
    if (m.after) m.after(R);
    front.forEach(function (it) { it.a.draw(R); });
    // 名前の看板（＋準備中の小札）：いつもこちらを向ける
    const s = bb.sign;
    if (s) {
      g.save();
      g.translate(s.x, s.y);
      g.scale(s.k, s.k);
      buildingSign(g, b, 0, 0, null);
      g.restore();
    }
  }

  // 酒場の立体（斜め見下ろしの絵 BUILDING_ART.tavern を、立体に作り直した物）
  BUILDING_MODEL.tavern = (function () {
    // ---- 色（BUILDING_ART.tavern と同じ） ----
    const BEAM = "#5b3a22", PLANK = "#9a6236", STONE = "#a99f90", BRICK = "#a65d43";
    const GLOW = "#ffcf5c", GLOW_HI = "#fff0b0", FLOWER = "#f2685a", LEAF = "#4f9a3c";
    const BARREL = "#b0723a", HOOP = "#4b4744", BEER = "#f3b02c", FOAM = "#fffaf0", IRON = "#3a302c", GOLD = "#f2c230";
    const LOG = "#d9a96a", BARK = "#6b4526";                   // 薪の切り口・皮（立体にして足した薪の山）
    // ---- 寸法（BUILDING_ART.tavern と同じ。a＝西→東、b＝北→南。どちらも土台の西北の角から 0〜3 マス。高さは絵の px） ----
    const A0 = 0.25, A1 = 2.8, B0 = 0.3, B1 = 2.7;              // 壁の範囲（入口は東の妻壁 a＝A1）
    const VM = 1.5, ZE = 50, ZR = 84;                           // 棟の位置（東西に通る）・軒の高さ・棟の高さ
    const RA0 = 0.1, RA1 = 2.95, RB0 = 0.1, RB1 = 2.9, FASCIA = 4;   // 屋根の広がりと厚み
    const DOOR_HW = 0.26, DOOR_ZS = 30, KZ = 36;                // 扉（半分の幅・アーチの始まる高さ）・絵の「1マスぶんの縦の長さ」
    const SIGN_A0 = 2.2, SIGN_A1 = 2.85, SIGN_H = 144;          // 看板の柱の位置（棟の上）・看板の中心の高さ（絵の、土台の手前の角から）
    const CH_A = 1.15, CH_B = 2.05, CH_HW = 0.11, CH_TOP = 110; // 煙突（屋根の南の斜面）
    const MUG_B = 2.28, MUG_Z = 47;                             // ジョッキの吊り看板（東の壁・扉の左）
    const BARRELS = [[2.5, 2.95], [2.98, 2.5]];                 // 樽（南の壁ぞいの東の角・東の壁ぞいの扉の左）
    const BR = 0.19, BH = 20;                                   // 樽の半径（マス）・高さ
    // 看板の中心の高さ（px）。絵では「土台の手前の角から SIGN_H 上」の位置なので、柱のまん中の真上の高さに直す
    const SIGN_Z = ((SIGN_A0 + SIGN_A1) / 2 + VM) * TH / 2 + SIGN_H - 3 * TH;
    // ---- 立体にして足した物（絵に無い北の壁と西の妻壁。控えめに） ----
    const BACK_DOOR = [0.55, 0.95, 36];                         // 北の壁の裏口（a の範囲・高さ）
    const WOOD = [1.3, 2.3, 0.26, 20];                          // 西の妻壁の薪の山（b の範囲・壁からの出っぱり（マス）・高さ）
    function roofZ(bb) { return ZR - (ZR - ZE) * Math.abs(bb - VM) / (B1 - VM); }

    function build(b) {
      const HZ = CAMC.buildingScale / ART_PX;                   // 絵の高さ（px）→ マス（立て看板と同じ大きさになる）
      const W = function (a, bb, h) { return [b.x + a, b.y + bb, (h || 0) * HZ]; };
      const OL = COLORS.outline, wall = b.wallColor, roof = b.roofColor;
      const zE = roofZ(RB1), zB = roofZ(RB0);
      // 壁の上の位置（u＝壁にそった位置、h＝高さ）
      const onS = function (u, h) { return W(u, B1, h); }, onN = function (u, h) { return W(u, B0, h); };
      const onE = function (u, h) { return W(A1, u, h); }, onW = function (u, h) { return W(A0, u, h); };
      const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];

      // 明かりのもれる窓。q＝壁の上の位置を決める関数、c0〜c1＝壁にそった範囲、i＝ゆらぎをずらす番号
      function glowWindow(R, q, c0, c1, z0, z1, i) {
        const cm = (c0 + c1) / 2, zm = (z0 + z1) / 2, w = (c1 - c0) * 0.3;
        R.poly([q(c0, z0), q(c1, z0), q(c1, z1), q(c0, z1)], GLOW);
        R.g.globalAlpha = clamp(0.55 + 0.25 * Math.sin(R.t * 2.3 + i * 1.9) + 0.12 * Math.sin(R.t * 5.3 + i), 0, 1);   // 中の明かりがゆらぐ
        R.poly([q(cm - w, z0), q(cm + w, z0), q(cm + w, zm + 3), q(cm - w, zm + 3)], GLOW_HI);
        R.g.globalAlpha = 1;
        R.poly([q(c0, z0), q(c1, z0), q(c1, z1), q(c0, z1)], null, BEAM, 2.4);
        R.lines([[q(cm, z0), q(cm, z1)], [q(c0, zm), q(c1, zm)]], BEAM, 1.6);
      }
      // 妻壁の木組み（両はしの柱・土台の上のはり・軒のはり・妻の束）と、てっぺんの丸窓。q＝妻壁の上の位置
      function gable(R, q, i) {
        R.lines([[q(B0 + 0.04, 7), q(B0 + 0.04, ZE)], [q(B1 - 0.04, 7), q(B1 - 0.04, ZE)],
          [q(B0, 8), q(B1, 8)], [q(B0, ZE), q(B1, ZE)],
          [q(VM - 0.45, ZE), q(VM - 0.45, roofZ(VM - 0.45) - 2)], [q(VM + 0.45, ZE), q(VM + 0.45, roofZ(VM + 0.45) - 2)]], BEAM, 3);
        const rw = [];
        for (let k = 0; k < 14; k++) { const a = k / 14 * Math.PI * 2; rw.push(q(VM + 6 / KZ * Math.cos(a), 65 + 6 * Math.sin(a))); }
        R.poly(rw, GLOW, BEAM, 2.4);
      }
      // 長い壁（南・北）の木組み（柱・はり・すじかい）。q＝壁の上の位置
      function sideFrame(R, q, posts) {
        const fr = [];
        posts.forEach(function (a) { fr.push([q(a, 7), q(a, ZE)]); });
        fr.push([q(A0, 8), q(A1, 8)], [q(A0, ZE - 2), q(A1, ZE - 2)]);
        fr.push([q(2.36, 10), q(2.76, ZE - 4)], [q(2.76, 10), q(2.36, ZE - 4)]);
        R.lines(fr, BEAM, 3);
      }

      // ---- 本体の壁（しっくい。明るさは南＋0.10・東－0.18（絵と同じ）、西 0・北－0.28） ----
      const wallS = { pts: [onS(A0, 0), onS(A1, 0), onS(A1, ZE), onS(A0, ZE)], col: shade(wall, 0.10), layer: 0, deco: function (R) {
        R.poly([onS(A0, 0), onS(A1, 0), onS(A1, 7), onS(A0, 7)], shade(STONE, 0.10), OL);   // 石の土台
        sideFrame(R, onS, [A0 + 0.04, 1.28, 2.32, A1 - 0.03]);
        glowWindow(R, onS, 0.52, 1.02, 14, 33, 0);
        glowWindow(R, onS, 1.55, 2.05, 14, 33, 1);
      } };
      const wallE = { pts: [onE(B0, 0), onE(B1, 0), onE(B1, ZE), onE(VM, ZR), onE(B0, ZE)], col: shade(wall, -0.18), layer: 0, deco: function (R) {
        R.poly([onE(B0, 0), onE(B1, 0), onE(B1, 7), onE(B0, 7)], shade(STONE, -0.18), OL);
        gable(R, onE);
        glowWindow(R, onE, 0.55, 1.0, 14, 33, 2);
        // 入口（木の枠＋板の扉＋小窓＋取っ手）
        const arch = function (hw) {
          const pts = [onE(VM - hw, 0)];
          for (let i = 0; i <= 8; i++) { const a = Math.PI - i / 8 * Math.PI; pts.push(onE(VM + hw * Math.cos(a), DOOR_ZS + hw * KZ * Math.sin(a))); }
          pts.push(onE(VM + hw, 0));
          return pts;
        };
        R.poly(arch(DOOR_HW + 0.06), BEAM, OL);
        R.poly(arch(DOOR_HW), PLANK, OL);
        const pl = [];
        [-0.13, 0, 0.13].forEach(function (d) { pl.push([onE(VM + d, 1), onE(VM + d, DOOR_ZS + Math.sqrt(DOOR_HW * DOOR_HW - d * d) * KZ - 1)]); });
        R.lines(pl, "rgba(70,40,20,0.45)", 1);
        R.lines([[onE(VM - DOOR_HW, 10), onE(VM + DOOR_HW, 10)], [onE(VM - DOOR_HW, 25), onE(VM + DOOR_HW, 25)]], IRON, 2);   // 鉄の帯
        R.poly(R.disc(onE(VM, 33), Y, Z, 0.1, 4.2 * HZ, 12), GLOW_HI, BEAM, 1.6);   // 明かりの小窓
        R.dot(onE(VM + 0.17, 17), 1.8, GOLD);           // 金の取っ手
      } };
      const wallN = { pts: [onN(A1, 0), onN(A0, 0), onN(A0, ZE), onN(A1, ZE)], col: shade(wall, -0.28), layer: 0, deco: function (R) {
        R.poly([onN(A1, 0), onN(A0, 0), onN(A0, 7), onN(A1, 7)], shade(STONE, -0.28), OL);
        sideFrame(R, onN, [A0 + 0.04, 1.28, 2.32, A1 - 0.04]);
        glowWindow(R, onN, 1.55, 2.05, 14, 33, 3);
        // 裏口（四角い板の扉）
        const d0 = BACK_DOOR[0], d1 = BACK_DOOR[1], dh = BACK_DOOR[2];
        R.poly([onN(d0 - 0.04, 0), onN(d1 + 0.04, 0), onN(d1 + 0.04, dh + 3), onN(d0 - 0.04, dh + 3)], BEAM, OL);
        R.poly([onN(d0, 0), onN(d1, 0), onN(d1, dh), onN(d0, dh)], shade(PLANK, -0.12), OL);
        R.lines([[onN(lerp(d0, d1, 1 / 3), 1), onN(lerp(d0, d1, 1 / 3), dh - 1)], [onN(lerp(d0, d1, 2 / 3), 1), onN(lerp(d0, d1, 2 / 3), dh - 1)]], "rgba(70,40,20,0.45)", 1);
        R.lines([[onN(d0, 10), onN(d1, 10)], [onN(d0, 26), onN(d1, 26)]], IRON, 2);
        R.dot(onN(d0 + 0.07, 17), 1.6, GOLD);
      } };
      const wallW = { pts: [onW(B1, 0), onW(B0, 0), onW(B0, ZE), onW(VM, ZR), onW(B1, ZE)], col: shade(wall, 0), layer: 0, deco: function (R) {
        R.poly([onW(B1, 0), onW(B0, 0), onW(B0, 7), onW(B1, 7)], shade(STONE, 0), OL);
        gable(R, onW);
        glowWindow(R, onW, 0.6, 1.05, 14, 33, 4);
      } };

      // ---- 屋根（こげ茶の板ぶき。南の斜面＝明るい、北の斜面＝暗い（絵と同じ））と、厚み・ふち ----
      const S = function (s, k) { return W(RA0 + (RA1 - RA0) * s, VM + (RB1 - VM) * k, ZR + (zE - ZR) * k); };   // 南の斜面：s＝西(0)→東(1)、k＝棟(0)→軒(1)
      const N = function (s, k) { return W(RA0 + (RA1 - RA0) * s, VM - (VM - RB0) * k, ZR + (zB - ZR) * k); };   // 北の斜面
      const shingles = function (R, F, dark) {          // 板の段（横の線）と、板の継ぎ目（たての短い線）
        const rows = [0, 0.2, 0.4, 0.6, 0.8, 1], sh = [], tk = [];
        for (let r = 1; r < rows.length - 1; r++) sh.push([F(0, rows[r]), F(1, rows[r])]);
        R.lines(sh, dark, 1);
        for (let r = 0; r < rows.length - 1; r++) {
          for (let s = (r % 2 ? 0.05 : 0.1); s < 0.99; s += 0.1) tk.push([F(s, rows[r]), F(s, rows[r + 1])]);
        }
        R.lines(tk, "rgba(40,20,10,0.22)", 1);
      };
      const roofS = { pts: [S(0, 0), S(1, 0), S(1, 1), S(0, 1)], col: shade(roof, 0.10), layer: 2, deco: function (R) { shingles(R, S, shade(roof, -0.28)); } };
      const roofN = { pts: [N(1, 0), N(0, 0), N(0, 1), N(1, 1)], col: shade(roof, -0.28), layer: 2, deco: function (R) { shingles(R, N, shade(roof, -0.48)); } };
      const fascia = [
        { pts: [S(0, 1), S(1, 1), W(RA1, RB1, zE - FASCIA), W(RA0, RB1, zE - FASCIA)], col: shade(roof, -0.15), layer: 1 },   // 南の軒の厚み
        { pts: [N(1, 1), N(0, 1), W(RA0, RB0, zB - FASCIA), W(RA1, RB0, zB - FASCIA)], col: shade(roof, -0.45), layer: 1 },   // 北の軒の厚み
        { pts: [W(RA1, VM, ZR), W(RA1, RB1, zE), W(RA1, RB1, zE - FASCIA), W(RA1, VM, ZR - FASCIA)], col: shade(roof, -0.36), layer: 1 },   // 東のふち（南半分）
        { pts: [W(RA1, VM, ZR), W(RA1, RB0, zB), W(RA1, RB0, zB - FASCIA), W(RA1, VM, ZR - FASCIA)], col: shade(roof, -0.48), layer: 1 },   // 東のふち（北半分）
        { pts: [W(RA0, VM, ZR), W(RA0, RB1, zE), W(RA0, RB1, zE - FASCIA), W(RA0, VM, ZR - FASCIA)], col: shade(roof, -0.22), layer: 1 },   // 西のふち（南半分）
        { pts: [W(RA0, VM, ZR), W(RA0, RB0, zB), W(RA0, RB0, zB - FASCIA), W(RA0, VM, ZR - FASCIA)], col: shade(roof, -0.34), layer: 1 }    // 西のふち（北半分）
      ];

      // ---- 出っぱった物 ----
      const c0 = CH_A - CH_HW, c1 = CH_A + CH_HW, d0 = CH_B - CH_HW, d1 = CH_B + CH_HW, e = 0.03;
      const chimney = { at: W(CH_A, CH_B, 95), anchor: roofS, draw: function (R) {      // れんがの煙突（屋根の南の斜面から立つ）と、けむり
        const c = fcam, mort = "rgba(70,30,20,0.35)";
        const side = function (pts, col, l0, l1) {
          R.poly(pts, col, OL);
          R.lines([[l0(CH_TOP - 12), l1(CH_TOP - 12)], [l0(CH_TOP - 24), l1(CH_TOP - 24)]], mort, 1);   // 目地
        };
        if (c.ey > b.y + d1) side([W(c0, d1, roofZ(d1)), W(c1, d1, roofZ(d1)), W(c1, d1, CH_TOP), W(c0, d1, CH_TOP)], shade(BRICK, 0.08),
          function (h) { return W(c0, d1, h); }, function (h) { return W(c1, d1, h); });
        if (c.ey < b.y + d0) side([W(c1, d0, roofZ(d0)), W(c0, d0, roofZ(d0)), W(c0, d0, CH_TOP), W(c1, d0, CH_TOP)], shade(BRICK, -0.35),
          function (h) { return W(c1, d0, h); }, function (h) { return W(c0, d0, h); });
        if (c.ex > b.x + c1) side([W(c1, d1, roofZ(d1)), W(c1, d0, roofZ(d0)), W(c1, d0, CH_TOP), W(c1, d1, CH_TOP)], shade(BRICK, -0.22),
          function (h) { return W(c1, d1, h); }, function (h) { return W(c1, d0, h); });
        if (c.ex < b.x + c0) side([W(c0, d0, roofZ(d0)), W(c0, d1, roofZ(d1)), W(c0, d1, CH_TOP), W(c0, d0, CH_TOP)], shade(BRICK, -0.05),
          function (h) { return W(c0, d0, h); }, function (h) { return W(c0, d1, h); });
        R.box(W(c0 - e, d0 - e, CH_TOP - 4), W(c1 + e, d1 + e, CH_TOP),             // てっぺんのふち（少し太い）
          { s: shade(BRICK, -0.05), e: shade(BRICK, -0.32), w: shade(BRICK, -0.12), n: shade(BRICK, -0.42), top: shade(BRICK, 0.25) });
        if (c.ez > CH_TOP * HZ) R.poly([W(c0 + 0.03, d0 + 0.03, CH_TOP), W(c1 - 0.03, d0 + 0.03, CH_TOP), W(c1 - 0.03, d1 - 0.03, CH_TOP), W(c0 + 0.03, d1 - 0.03, CH_TOP)], "#3a2a24");
        for (let i = 0; i < 3; i++) {                   // けむり（ゆっくり上って薄くなる。少し北西へ流れる）
          const k = (R.t * 0.35 + i / 3) % 1;
          const q = R.p(W(CH_A - 0.1 * k + Math.sin(R.t * 1.3 + i) * 0.02, CH_B + 0.1 * k, CH_TOP + 6 + 16 * k));
          if (q.z < NEAR * 2) continue;
          R.g.globalAlpha = 0.55 * (1 - k);
          R.g.beginPath(); R.g.arc(q.x, q.y, (3 + 3.5 * k) * modelK(q.z), 0, Math.PI * 2);
          R.g.fillStyle = "#f2efe9"; R.g.fill();
        }
        R.g.globalAlpha = 1;
      } };
      const step = { at: W(A1 + 0.06, VM, 2), anchor: wallE, draw: function (R) {   // 入口の石の段
        R.box(W(A1, VM - 0.34, 0), W(A1 + 0.12, VM + 0.34, 3), { top: shade(STONE, 0.35), e: shade(STONE, -0.1), s: shade(STONE, 0.15), n: shade(STONE, -0.3) });
      } };
      const flowerBoxes = [[0.49, 1.05], [1.52, 2.08]].map(function (w, i) {         // 南の窓の下の花箱
        return { at: W((w[0] + w[1]) / 2, B1 + 0.05, 12), anchor: wallS, draw: function (R) {
          R.box(W(w[0], B1, 8), W(w[1], B1 + 0.1, 13), { s: PLANK, e: shade(PLANK, -0.25), w: shade(PLANK, -0.1), top: shade(PLANK, -0.45) });
          for (let k = 0; k < 4; k++) {
            const u = lerp(w[0] + 0.06, w[1] - 0.06, k / 3);
            R.dot(W(u, B1 + 0.06, 14), 2.6, LEAF);
            R.dot(W(u, B1 + 0.06, 16), 1.9, (k + i) % 2 ? "#ffd23f" : FLOWER);
          }
        } };
      });
      // 樽（たての円柱。丸い物なので、いつもこちらを向いた形で描く）
      function barrel(R, a, bb) {
        const c = fcam, p0 = W(a, bb, 0), p1 = W(a, bb, BH), q0 = R.p(p0), q1 = R.p(p1);
        if (q0.z < NEAR * 2 || q1.z < NEAR * 2) return;
        const g = R.g, rx = BR * c.f / q0.z, rt = BR * c.f / q1.z;
        const sq = function (p) { return clamp((c.ez - p[2]) / (Math.hypot(p[0] - c.ex, p[1] - c.ey, p[2] - c.ez) || 1), 0.05, 1); };   // 見下ろす角度が浅いほど、円がつぶれる
        const s0 = sq(p0), s1 = sq(p1), re = rx * 0.88, rte = rt * 0.88, ym = (q0.y + q1.y) / 2, xm = (q0.x + q1.x) / 2;
        g.beginPath();
        g.moveTo(q1.x - rte, q1.y);
        g.quadraticCurveTo(xm - rx * 1.12, ym, q0.x - re, q0.y);
        g.ellipse(q0.x, q0.y, re, re * s0, 0, Math.PI, 0, true);
        g.quadraticCurveTo(xm + rx * 1.12, ym, q1.x + rte, q1.y);
        g.closePath();
        const gr = g.createLinearGradient(xm - rx, 0, xm + rx, 0), lt = shade(BARREL, 0.12), dk = shade(BARREL, -0.22);
        gr.addColorStop(0, lt); gr.addColorStop(0.56, lt); gr.addColorStop(0.56, dk); gr.addColorStop(1, dk);
        g.fillStyle = gr; g.fill();
        g.strokeStyle = COLORS.outline; g.lineWidth = Math.max(0.35, modelK(q0.z)); g.stroke();
        [4, BH - 4].forEach(function (h) {               // たがの鉄の輪（手前の半分）
          const q = R.p(W(a, bb, h)), r = BR * c.f / q.z * 0.97;
          g.beginPath(); g.ellipse(q.x, q.y, r, r * sq(W(a, bb, h)), 0, 0.1, Math.PI - 0.1);
          g.strokeStyle = HOOP; g.lineWidth = Math.max(0.5, 2 * modelK(q.z)); g.stroke();
        });
        if (c.ez > BH * HZ) {                           // ふた
          g.beginPath(); g.ellipse(q1.x, q1.y, rte, rte * s1, 0, 0, Math.PI * 2);
          g.fillStyle = shade(BARREL, 0.28); g.fill(); g.strokeStyle = COLORS.outline; g.lineWidth = Math.max(0.35, modelK(q1.z)); g.stroke();
          g.beginPath(); g.ellipse(q1.x, q1.y, rte * 0.62, rte * 0.62 * s1, 0, 0, Math.PI * 2);
          g.strokeStyle = "rgba(110,60,20,0.45)"; g.stroke();
        }
      }
      const barrels = [
        { at: W(BARRELS[0][0], BARRELS[0][1], 10), anchor: wallS, draw: function (R) { barrel(R, BARRELS[0][0], BARRELS[0][1]); } },
        { at: W(BARRELS[1][0], BARRELS[1][1], 10), anchor: wallE, draw: function (R) { barrel(R, BARRELS[1][0], BARRELS[1][1]); } }
      ];
      // ジョッキの吊り看板（東の壁から鉄の腕木で下げた板。壁から突き出た板なので、横から見ると薄い。風で少しゆれる）
      const mug = { at: W(3.1, MUG_B, 35), anchor: wallE, draw: function (R) {
        const g = R.g, sw = Math.sin(R.t * 1.6) * 0.03;
        const M = function (u, z) { return W(u + sw * (MUG_Z - z) / 26, MUG_B, z); };   // 下ほどゆれが大きい
        R.lines([[W(A1, MUG_B, MUG_Z), W(3.36, MUG_B, MUG_Z)], [W(A1, MUG_B, MUG_Z - 10), W(3.02, MUG_B, MUG_Z)]], IRON, 2);
        R.lines([[W(2.96, MUG_B, MUG_Z), M(2.96, 41.5)], [W(3.24, MUG_B, MUG_Z), M(3.24, 41.5)]], IRON, 1);
        g.lineJoin = "round"; g.lineCap = "round";
        R.lines([[M(3.27, 35), M(3.39, 34), M(3.39, 24), M(3.27, 23)]], "#6a4316", 4.4);   // 取っ手（太い線をふち→中の順に）
        R.lines([[M(3.27, 35), M(3.39, 34), M(3.39, 24), M(3.27, 23)]], shade(BEER, 0.25), 2.2);
        g.lineCap = "butt";
        R.poly([M(2.88, 39), M(3.28, 39), M(3.26, 19), M(2.9, 19)], BEER, "#6a4316", 1.4);   // 胴（金色のビール）
        R.lines([[M(2.99, 36), M(2.99, 22)], [M(3.17, 36), M(3.17, 22)]], "rgba(255,255,255,0.55)", 1.4);   // ガラスの照り
        [[2.92, 40.5, 3.4], [3.03, 43, 4], [3.15, 42, 3.8], [3.25, 40, 3]].forEach(function (f) {   // 泡（板の面の上の丸）
          R.poly(R.disc(M(f[0], f[1]), X, Z, f[2] * HZ, f[2] * HZ, 10), FOAM, "rgba(106,67,22,0.6)", 1);
        });
        R.poly([M(2.88, 39), M(3.28, 39), M(3.28, 41), M(2.88, 41)], FOAM);
        g.lineJoin = "miter";
      } };
      // 西の妻壁の薪の山（立体にして足した物。切り口を西へ向けて積む）
      const wood = { at: W(A0 - WOOD[2] / 2, (WOOD[0] + WOOD[1]) / 2, WOOD[3] / 2), anchor: wallW, draw: function (R) {
        const x0 = A0 - WOOD[2];
        R.box(W(x0, WOOD[0], 0), W(A0, WOOD[1], WOOD[3]), { w: shade(BARK, -0.1), n: shade(BARK, -0.25), s: shade(BARK, 0.05), top: shade(BARK, 0.18) });
        // 南・北の横の面：積んだ薪の段のすじ（横から見ても薪の山と分かるように）
        const sideB = fcam.ey > b.y + WOOD[1] ? WOOD[1] : (fcam.ey < b.y + WOOD[0] ? WOOD[0] : null);
        if (sideB !== null) {
          R.lines([7, 13].map(function (h) { return [W(x0, sideB, h), W(A0, sideB, h)]; }), "rgba(40,20,10,0.5)", 1.2);
        }
        if (fcam.ex >= b.x + x0) return;                // 切り口は、西から見える時だけ
        for (let r = 0; r < 3; r++) {
          for (let k = 0; k < 6 - (r % 2); k++) {
            const u = WOOD[0] + 0.1 + (r % 2) * 0.08 + k * 0.16;
            R.poly(R.disc(W(x0, u, 4 + r * 6), Y, Z, 0.07, 3.1 * HZ, 10), LOG, "rgba(90,55,25,0.7)", 0.8);
          }
        }
      } };
      // 看板の柱（棟に立てた2本。看板そのものは drawModel が、いつもこちらを向けて描く）
      const posts = { at: W((SIGN_A0 + SIGN_A1) / 2, VM, (ZR + SIGN_Z) / 2), anchor: null, draw: function (R) {
        if (signShow.has(b) && signShow.get(b) <= 0.01) return;   // 看板を隠している間は、柱も出さない
        R.lines([[W(SIGN_A0, VM, ZR), W(SIGN_A0, VM, SIGN_Z)], [W(SIGN_A1, VM, ZR), W(SIGN_A1, VM, SIGN_Z)]], shade(roof, -0.45), 3);
      } };

      // ---- 輪郭を決める点（部品ごとのまとまり。まとまりごとに外周を取る。1つにまとめると、出っぱった物のすき間まで建物になる） ----
      const hull = [
        [W(A0, B0, 0), W(A1, B0, 0), W(A1, B1, 0), W(A0, B1, 0),                                    // 本体（壁・屋根・煙突・入口の段・看板の柱）
          W(RA0, RB0, zB), W(RA1, RB0, zB), W(RA1, RB1, zE), W(RA0, RB1, zE),
          W(RA0, RB0, zB - FASCIA), W(RA1, RB0, zB - FASCIA), W(RA1, RB1, zE - FASCIA), W(RA0, RB1, zE - FASCIA),
          W(RA0, VM, ZR + 3), W(RA1, VM, ZR + 3),
          W(c0 - e, d0 - e, CH_TOP), W(c1 + e, d0 - e, CH_TOP), W(c1 + e, d1 + e, CH_TOP), W(c0 - e, d1 + e, CH_TOP),
          W(A1 + 0.12, VM - 0.34, 0), W(A1 + 0.12, VM + 0.34, 0),
          W(SIGN_A0, VM, SIGN_Z), W(SIGN_A1, VM, SIGN_Z)],
        [W(A1, MUG_B, MUG_Z), W(3.39, MUG_B, MUG_Z), W(3.39, MUG_B, 19), W(2.88, MUG_B, 19), W(A1, MUG_B, MUG_Z - 10)],   // ジョッキの吊り看板
        [W(A0 - WOOD[2], WOOD[0], 0), W(A0 - WOOD[2], WOOD[1], 0), W(A0 - WOOD[2], WOOD[0], WOOD[3]), W(A0 - WOOD[2], WOOD[1], WOOD[3]),   // 薪の山
          W(A0, WOOD[0], WOOD[3]), W(A0, WOOD[1], WOOD[3])]
      ];
      BARRELS.forEach(function (p) {                    // 樽
        const g = [];
        [[BR, 0], [-BR, 0], [0, BR], [0, -BR]].forEach(function (d) { g.push(W(p[0] + d[0], p[1] + d[1], 0), W(p[0] + d[0], p[1] + d[1], BH)); });
        hull.push(g);
      });

      return {
        faces: [wallS, wallE, wallN, wallW].concat(fascia, [roofS, roofN]),
        after: function (R) {                           // 棟
          R.g.lineCap = "round";
          R.lines([[W(RA0, VM, ZR + 1), W(RA1, VM, ZR + 1)]], shade(roof, -0.45), 4);
          R.g.lineCap = "butt";
        },
        attach: [chimney, step, mug, wood, posts].concat(flowerBoxes, barrels),
        ground: function (R) {                          // 入口の前の地面にもれる明かり
          const p = W(A1 + 0.35, VM, 0), q = R.p(p), c = fcam;
          if (q.z < NEAR * 2) return;
          const rx = 0.49 * c.f / q.z, ry = rx * c.ez / (Math.hypot(p[0] - c.ex, p[1] - c.ey, c.ez) || 1);
          const g = R.g;
          g.save();
          g.translate(q.x, q.y); g.scale(1, ry / rx);
          const lg = g.createRadialGradient(0, 0, 0, 0, 0, rx);
          lg.addColorStop(0, "rgba(255,206,110,0.45)"); lg.addColorStop(1, "rgba(255,206,110,0)");
          g.fillStyle = lg; g.beginPath(); g.arc(0, 0, rx, 0, Math.PI * 2); g.fill();
          g.restore();
        },
        sign: W((SIGN_A0 + SIGN_A1) / 2, VM, SIGN_Z),
        hull: hull,
        bound: [W(CH_A - 0.15, CH_B + 0.15, CH_TOP + 30)]
      };
    }

    return { build: build };
  })();

  // 占いルームの立体（斜め見下ろしの絵 BUILDING_ART.uranai を、立体に作り直した物）
  //   母屋（紫の急な切妻屋根）の東北の角に、とんがり帽子の丸い塔が食い込んでいる。
  //   母屋は、塔に食い込まれた所（塔の円の中）を切り取った形にする（塔の中に屋根の角が見えないように）。
  //   塔は母屋から大きく飛び出すので、出っぱった物（attach）として描き、前後は「塔と母屋の境の仮の面」がこちらを向いているかで決める
  BUILDING_MODEL.uranai = (function () {
    // ---- 色（BUILDING_ART.uranai と同じ） ----
    const STONE = "#9a90b4", GOLD = "#f6cf5a", GLOW = "#ffe9a0", WOOD = "#43295f", INK = "#2b2233";
    const LANTERN = "#ffd766", STEP = "#b9b0cc", BALL = "#c9ecff", BALL_LINE = "#9a7be0", MOON_LINE = "#8a6a1a";
    // ---- 寸法（BUILDING_ART.uranai と同じ。u＝西→東、v＝北→南。どちらも土台の西北の角から 0〜3 マス。高さは絵の px） ----
    const U0 = 0.2, U1 = 2.2, V0 = 1.1, V1 = 2.5, VM = 1.8;      // 母屋の壁と、棟（東西に通る）の位置（入口は南の壁 v＝V1）
    const ZE = 48, ZR = 84;                                      // 軒の高さ・棟の高さ
    const RU0 = 0.05, RU1 = 2.35, RV0 = 0.92, RV1 = 2.68, FASCIA = 4;   // 屋根の広がりと厚み
    const DOOR_U = 1.5, DOOR_HW = 0.30, DOOR_ZS = 33;            // 入口の扉（半分の幅・アーチの始まる高さ）
    const TU = 2.4, TV = 0.8, TR = 0.5, TZ = 92;                 // 丸い塔（中心・半径・高さ）
    const CR = 0.66, CZ0 = 88, CZ1 = 141, LEAN = [0.11, -0.11];  // とんがり帽子（半径・すそ・先・先のかたむき（東北へ。絵の「右へ7px」））
    const SIGN_U0 = 0.46, SIGN_U1 = 1.26, SIGN_H = 118;          // 看板の柱の位置（棟の上）・看板の中心の高さ（絵の、土台の中心から）
    const KZ = 36;                                               // 絵の「1マスぶんの縦の長さ」
    const CAT_U = 1.92, CAT_FACE = [0.45, 0.89];                 // 棟の上の黒猫（位置・顔の向き＝南南東）
    const BALL_C = [0.63, 2.79, 18];                             // 水晶玉の中心
    const N_SIDE = 24;                                           // 塔と帽子を、何角形の柱・すいで作るか
    // 看板の中心の高さ（px）。絵では「土台の中心から SIGN_H 上」の位置なので、柱のまん中の真上の高さに直す
    const SIGN_Z = ((SIGN_U0 + SIGN_U1) / 2 + VM) * TH / 2 - 1.5 * TH + SIGN_H;
    // 塔の窓 [向き（ラジアン。0＝東、π/2＝南）, 中心の高さ(px), 横の半径(マス), 縦の半径(px), 十字の桟があるか]（最後の1つは、絵に無い裏の窓）
    const TOWER_WIN = [[1.147, 58, 0.14, 8.5, true], [0.279, 30, 0.1, 6, false], [-1.2, 56, 0.1, 6, false]];
    // 帽子の星 [向き, すそからの高さ(px), 半径(px)]（前の3つは絵と同じ位置。後ろの2つは、絵に無い裏の星）
    const HAT_STARS = [[1.29, 13, 4.5], [0.4, 19, 3.5], [0.785, 32, 3], [3.6, 16, 4], [5.1, 26, 3.5]];

    // 屋根の上の高さ（v の所）
    function roofZ(v) { return ZR - (ZR - ZE) * Math.abs(v - VM) / (RV1 - VM); }
    // 塔の円が、v の線を横切る所の u（西側）・u の線を横切る所の v（南側）
    function towerU(v) { return TU - Math.sqrt(Math.max(0, TR * TR - (v - TV) * (v - TV))); }
    function towerV(u) { return TV + Math.sqrt(Math.max(0, TR * TR - (u - TU) * (u - TU))); }
    // 丸い物の面の明るさ（向き a の面。壁と同じく、南＋0.10・東－0.20・北－0.28・西 0 を、なめらかにつなぐ）
    function sideShade(a) { return -0.09 - 0.11 * Math.cos(a) + 0.19 * Math.sin(a); }

    function build(b) {
      const HZ = CAMC.buildingScale / ART_PX;                   // 絵の高さ（px）→ マス（立て看板と同じ大きさになる）
      const W = function (u, v, h) { return [b.x + u, b.y + v, (h || 0) * HZ]; };
      const OL = COLORS.outline, wall = b.wallColor, roof = b.roofColor;
      const X = [1, 0, 0], Z = [0, 0, 1];
      const IN = W((U0 + U1) / 2, (V0 + V1) / 2, 20);           // 母屋の内側の点（面の外向きを決める）
      const zW = roofZ(V1);                                     // 壁の上（屋根の裏に当たる高さ）
      const uN = towerU(RV0), vE = towerV(RU1);                 // 屋根を塔で切り取る所（北の軒・東のふち）
      const uW = towerU(V0), vW = towerV(U1);                   // 壁を塔で切り取る所（北の壁・東の妻壁）
      // 壁の上の位置（c＝壁にそった位置、h＝高さ）
      const onS = function (c, h) { return W(c, V1, h); }, onN = function (c, h) { return W(c, V0, h); };
      const onE = function (c, h) { return W(U1, c, h); }, onW = function (c, h) { return W(U0, c, h); };
      const add = function (p, d, s) { return [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s]; };
      const T = function (a, r, h) { return W(TU + r * Math.cos(a), TV + r * Math.sin(a), h); };   // 塔のまわりの点（向き a・半径 r）
      const tip = W(TU + LEAN[0], TV + LEAN[1], CZ1);           // 帽子の先

      // 4つ角の星（o＝中心、u・v＝面にそった2つの向き、ru・rv＝それぞれの半径（マス））
      function star4(o, u, v, ru, rv) {
        const k = 0.28, pts = [];
        [[0, 1], [k, k], [1, 0], [k, -k], [0, -1], [-k, -k], [-1, 0], [-k, k]].forEach(function (d) {
          pts.push(add(add(o, u, d[0] * ru), v, d[1] * rv));
        });
        return pts;
      }
      // アーチ（q＝壁の上の位置を決める関数、c＝中心、hw＝半分の幅、z0＝足もと、zs＝丸くなり始める高さ）
      function arch(q, c, hw, z0, zs) {
        const pts = [q(c - hw, z0)];
        for (let i = 0; i <= 8; i++) { const a = Math.PI - i / 8 * Math.PI; pts.push(q(c + hw * Math.cos(a), zs + hw * KZ * Math.sin(a))); }
        pts.push(q(c + hw, z0));
        return pts;
      }
      // 丸窓（十字の桟つき）
      function roundWindow(R, q, c, h) {
        R.poly(circle(q, c, h, 9), GLOW, roof, 2.5);
        R.lines([[q(c, h - 9), q(c, h + 9)], [q(c - 9 / KZ, h), q(c + 9 / KZ, h)]], roof, 1.5);
      }
      function circle(q, c, h, r) {                             // 壁の上の円（横の半径 r/KZ マス、縦の半径 r px）
        const pts = [];
        for (let i = 0; i < 14; i++) { const a = i / 14 * Math.PI * 2; pts.push(q(c + r / KZ * Math.cos(a), h + r * Math.sin(a))); }
        return pts;
      }
      const base = function (R, q, c0, c1, s) { R.poly([q(c0, 0), q(c1, 0), q(c1, 7), q(c0, 7)], shade(STONE, s), OL); };   // 石の土台

      // ---- 母屋の壁（明るさは南＋0.10・東－0.20（絵と同じ）、西 0・北－0.28） ----
      const wallS = { pts: [onS(U0, 0), onS(U1, 0), onS(U1, zW), onS(U0, zW)], col: shade(wall, 0.10), layer: 0, inside: IN, deco: function (R) {
        base(R, onS, U0, U1, 0.10);
        // 入口（石のふちのアーチ＋両開きの扉＋金の星＋取っ手2つ）
        R.poly(arch(onS, DOOR_U, DOOR_HW + 0.07, 0, DOOR_ZS), shade(STONE, 0.35), OL);
        R.poly(arch(onS, DOOR_U, DOOR_HW, 0, DOOR_ZS), WOOD, OL);
        R.lines([[onS(DOOR_U, 0), onS(DOOR_U, DOOR_ZS + DOOR_HW * KZ)]], "rgba(0,0,0,0.4)", 1);
        R.poly(star4(onS(DOOR_U, 30), X, Z, 5.5 / KZ, 5.5 * HZ), GOLD);
        R.dot(onS(DOOR_U - 0.07, 17), 1.5, GOLD);
        R.dot(onS(DOOR_U + 0.07, 17), 1.5, GOLD);
        roundWindow(R, onS, 0.68, 29);
        // ランタン（吊るしひも＋明かり）
        R.lines([[onS(2.0, 40), onS(2.0, 34)]], WOOD, 1.5);
        R.poly([onS(1.93, 26), onS(2.07, 26), onS(2.07, 34), onS(1.93, 34)], LANTERN, WOOD, 1.5);
      } };
      const wallE = { pts: [onE(vW, 0), onE(V1, 0), onE(V1, zW), onE(VM, ZR), onE(vW, roofZ(vW))], col: shade(wall, -0.20), layer: 0, inside: IN, deco: function (R) {
        base(R, onE, vW, V1, -0.20);
        R.poly(arch(onE, 2.1, 0.2, 18, 34), GLOW, roof, 2.5);   // 妻壁のアーチ窓
      } };
      const wallN = { pts: [onN(uW, 0), onN(U0, 0), onN(U0, zW), onN(uW, zW)], col: shade(wall, -0.28), layer: 0, inside: IN, deco: function (R) {
        base(R, onN, U0, uW, -0.28);
        roundWindow(R, onN, 0.7, 29);                           // 立体にして足した窓（裏。控えめに）
        R.poly(arch(onN, 1.5, 0.16, 16, 28), shade(GLOW, -0.08), roof, 2.2);
      } };
      const wallW = { pts: [onW(V1, 0), onW(V0, 0), onW(V0, zW), onW(VM, ZR), onW(V1, zW)], col: shade(wall, 0), layer: 0, inside: IN, deco: function (R) {
        base(R, onW, V0, V1, 0);
        R.poly(arch(onW, VM, 0.2, 18, 34), GLOW, roof, 2.5);    // 立体にして足した窓（東の妻壁と同じ形）
      } };

      // ---- 屋根（紫の急な切妻。南の斜面＝明るい、北の斜面＝暗い）と、厚み・ふち ----
      const S = function (s, k) { return W(RU0 + (RU1 - RU0) * s, RV1 - (RV1 - VM) * k, ZE + (ZR - ZE) * k); };   // 南の斜面：s＝西(0)→東(1)、k＝軒(0)→棟(1)
      const upS = (function () { const d = [0, -(RV1 - VM), (ZR - ZE) * HZ], l = Math.hypot(d[1], d[2]); return [0, d[1] / l, d[2] / l]; })();   // 南の斜面を棟へ上る向き
      const upN = [0, -upS[1], upS[2]];
      const onRoofN = function (u, k) { const v = RV0 + (VM - RV0) * k; return W(u, v, roofZ(v)); };   // 北の斜面：k＝軒(0)→棟(1)
      const roofS = { pts: [S(0, 0), S(1, 0), S(1, 1), S(0, 1)], col: shade(roof, 0.06), layer: 2, inside: IN, deco: function (R) {
        R.lines([0.27, 0.52, 0.77].map(function (k) { return [S(0, k), S(1, k)]; }), shade(roof, -0.3), 1);   // かわらの線
        [[0.2, 0.42, 4], [0.48, 0.66, 3], [0.72, 0.3, 4.5]].forEach(function (s) {   // 金の星
          R.poly(star4(S(s[0], s[1]), X, upS, s[2] / KZ, s[2] / KZ), GOLD);
        });
      } };
      // 北の斜面（東北の角は、塔の円で切り取る）
      const nPts = [W(RU0, VM, ZR), W(RU1, VM, ZR), W(RU1, vE, roofZ(vE))];
      const aE = Math.atan2(vE - TV, RU1 - TU), aN = Math.atan2(RV0 - TV, uN - TU);
      for (let i = 1; i < 8; i++) { const a = lerp(aE, aN, i / 8), v = TV + TR * Math.sin(a); nPts.push(W(TU + TR * Math.cos(a), v, roofZ(v))); }
      nPts.push(W(uN, RV0, ZE), W(RU0, RV0, ZE));
      const roofN = { pts: nPts, col: shade(roof, -0.30), layer: 2, inside: IN, deco: function (R) {
        R.lines([0.23, 0.48, 0.73].map(function (k) {
          const v = RV0 + (VM - RV0) * k, u1 = v < TV + TR ? Math.min(RU1, towerU(v)) : RU1;
          return [onRoofN(RU0, k), onRoofN(u1, k)];
        }), shade(roof, -0.5), 1);
        [[0.55, 0.5, 4], [1.25, 0.72, 3]].forEach(function (s) {   // 立体にして足した星（裏。控えめに）
          R.poly(star4(onRoofN(s[0], s[1]), X, upN, s[2] / KZ, s[2] / KZ), GOLD);
        });
      } };
      const fascia = [
        { pts: [S(0, 0), S(1, 0), W(RU1, RV1, ZE - FASCIA), W(RU0, RV1, ZE - FASCIA)], col: shade(roof, -0.4), layer: 1, inside: IN },    // 南の軒の厚み
        { pts: [W(uN, RV0, ZE), W(RU0, RV0, ZE), W(RU0, RV0, ZE - FASCIA), W(uN, RV0, ZE - FASCIA)], col: shade(roof, -0.52), layer: 1, inside: IN },   // 北の軒の厚み（塔まで）
        { pts: [W(RU1, VM, ZR), W(RU1, RV1, ZE), W(RU1, RV1, ZE - FASCIA), W(RU1, VM, ZR - FASCIA)], col: shade(roof, -0.4), layer: 1, inside: IN },   // 東のふち（南半分）
        { pts: [W(RU1, VM, ZR), W(RU1, vE, roofZ(vE)), W(RU1, vE, roofZ(vE) - FASCIA), W(RU1, VM, ZR - FASCIA)], col: shade(roof, -0.52), layer: 1, inside: IN },   // 東のふち（北半分。塔まで）
        { pts: [W(RU0, VM, ZR), W(RU0, RV1, ZE), W(RU0, RV1, ZE - FASCIA), W(RU0, VM, ZR - FASCIA)], col: shade(roof, -0.3), layer: 1, inside: IN },   // 西のふち（南半分）
        { pts: [W(RU0, VM, ZR), W(RU0, RV0, ZE), W(RU0, RV0, ZE - FASCIA), W(RU0, VM, ZR - FASCIA)], col: shade(roof, -0.42), layer: 1, inside: IN }    // 西のふち（北半分）
      ];

      // ---- 丸い塔＋とんがり帽子＋三日月（母屋から大きく飛び出すので、出っぱった物として描く） ----
      // 塔と母屋の境の仮の面（塔の中心を通り、母屋から離れる向き）。こちらを向いていれば塔が手前（母屋の後に描く）、向こうなら奥（母屋の前に描く）
      const towerSide = { pts: [W(TU, TV, 0)], n: [0.77, -0.64, 0] };
      const tower = { at: W(TU, TV, 60), anchor: towerSide, draw: function (R) {
        const c = fcam, N = N_SIDE, da = Math.PI * 2 / N, g = R.g;
        const faces = function (p, n) { return (c.ex - p[0]) * n[0] + (c.ey - p[1]) * n[1] + (c.ez - p[2]) * n[2] > 0; };
        // 胴（多角形の柱）：こちらを向いた面だけ塗る。面どうしのすき間が出ないよう、同じ色で縁も塗る
        const vis = [], edges = [];
        for (let i = 0; i < N; i++) { const a = (i + 0.5) * da; vis.push(faces(T(a, TR * Math.cos(da / 2), 40), [Math.cos(a), Math.sin(a), 0])); }
        for (let i = 0; i < N; i++) {
          if (!vis[i]) continue;
          const a0 = i * da, a1 = a0 + da, s = sideShade(a0 + da / 2), st = shade(STONE, s), wl = shade(wall, s);
          R.poly([T(a0, TR, 0), T(a1, TR, 0), T(a1, TR, 7), T(a0, TR, 7)], st, st, 0.8);   // 足もとの石の帯
          R.poly([T(a0, TR, 7), T(a1, TR, 7), T(a1, TR, TZ), T(a0, TR, TZ)], wl, wl, 0.8);
          edges.push([T(a0, TR, 0), T(a1, TR, 0)], [T(a0, TR, 7), T(a1, TR, 7)]);
          if (!vis[(i + N - 1) % N]) edges.push([T(a0, TR, 0), T(a0, TR, TZ)]);   // 見える面の、左右のはし（輪郭）
          if (!vis[(i + 1) % N]) edges.push([T(a1, TR, 0), T(a1, TR, TZ)]);
        }
        R.lines(edges, OL, 1);
        // 塔の窓（壁の面の上のだ円。こちらを向いている時だけ）
        TOWER_WIN.forEach(function (w, i) {
          const a = w[0], o = T(a, TR + 0.004, w[1]), u = [-Math.sin(a), Math.cos(a), 0];
          if (!faces(o, [Math.cos(a), Math.sin(a), 0])) return;
          R.poly(R.disc(o, u, Z, w[2], w[3] * HZ, 14), i === 0 ? GLOW : shade(GLOW, -0.12), i === 0 ? roof : shade(roof, -0.2), i === 0 ? 2.5 : 2);
          if (w[4]) R.lines([[add(o, Z, -w[3] * HZ), add(o, Z, w[3] * HZ)], [add(o, u, -w[2]), add(o, u, w[2])]], roof, 1.5);
        });
        // とんがり帽子（多角形のすい。先が少し東北へかたむく）
        const cvis = [], rim = [], sil = [];
        for (let i = 0; i < N; i++) {
          const a0 = i * da, a1 = a0 + da, p0 = T(a0, CR, CZ0), p1 = T(a1, CR, CZ0);
          const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [tip[0] - p0[0], tip[1] - p0[1], tip[2] - p0[2]];
          const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], am = a0 + da / 2;
          if (n[0] * Math.cos(am) + n[1] * Math.sin(am) < 0) { n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2]; }
          cvis.push(faces(p0, n));
        }
        for (let i = 0; i < N; i++) {
          if (!cvis[i]) continue;
          const a0 = i * da, a1 = a0 + da, col = shade(roof, -0.12 - 0.10 * Math.cos(a0 + da / 2) + 0.18 * Math.sin(a0 + da / 2));
          R.poly([T(a0, CR, CZ0), T(a1, CR, CZ0), tip], col, col, 0.8);
          rim.push([T(a0, CR, CZ0), T(a1, CR, CZ0)]);
          if (!cvis[(i + N - 1) % N]) sil.push([T(a0, CR, CZ0), tip]);
          if (!cvis[(i + 1) % N]) sil.push([T(a1, CR, CZ0), tip]);
        }
        R.lines(sil, OL, 1);
        R.lines(rim, shade(roof, -0.4), 3);                     // すその太い線
        // 帽子の星（またたく。こちらを向いている時だけ）
        const H = (CZ1 - CZ0) * HZ;
        HAT_STARS.forEach(function (s, i) {
          const a = s[0], b0 = T(a, CR, CZ0), f = s[1] / (CZ1 - CZ0);
          const o = [lerp(b0[0], tip[0], f), lerp(b0[1], tip[1], f), lerp(b0[2], tip[2], f)];
          if (!faces(o, [Math.cos(a) * H, Math.sin(a) * H, CR])) return;
          const up = [tip[0] - b0[0], tip[1] - b0[1], tip[2] - b0[2]], l = Math.hypot(up[0], up[1], up[2]);
          g.globalAlpha = 0.72 + 0.28 * Math.cos(R.t * 2.4 + i * 2.1);
          R.poly(star4(o, [-Math.sin(a), Math.cos(a), 0], [up[0] / l, up[1] / l, up[2] / l], s[2] / KZ, s[2] / KZ), GOLD);
        });
        g.globalAlpha = 1;
        // てっぺんの三日月（平たい飾りなので、いつもこちらを向けて描く）
        const q = R.p(add(tip, Z, 4 * HZ));
        if (q.z < NEAR * 2) return;
        const k = modelK(q.z);
        g.beginPath();
        g.arc(q.x, q.y, 6 * k, 0.25 * Math.PI, 1.75 * Math.PI, false);
        g.arc(q.x + 3 * k, q.y, 4.42 * k, -1.287, 1.287, true);
        g.closePath();
        g.fillStyle = GOLD; g.fill();
        g.strokeStyle = MOON_LINE; g.lineWidth = Math.max(0.35, k); g.stroke();
      } };

      // ---- そのほかの出っぱった物 ----
      // 棟の上の黒猫（丸い物なので、いつもこちらを向けて描く。しっぽは東北へのばし、目は顔の向きから見える時だけ）
      const cat = { at: W(CAT_U, VM, ZR + 10), anchor: null, draw: function (R) {
        const c = fcam, g = R.g, p = W(CAT_U, VM, ZR), q = R.p(p);
        if (q.z < NEAR * 2) return;
        const k = modelK(q.z), e = R.p(W(CAT_U + 0.1, VM - 0.1, ZR));
        let sx = clamp((e.x - q.x) / (0.1414 * c.f / q.z), -1, 1);   // しっぽの向き（見る向きで、画面の左右が入れかわる）
        sx = (sx < 0 ? -1 : 1) * Math.max(0.3, Math.abs(sx));
        const sway = Math.sin(R.t * 1.6) * 1.5;
        g.save();
        g.translate(q.x, q.y); g.scale(k, k);
        g.strokeStyle = INK; g.lineWidth = 2; g.lineCap = "round";
        g.beginPath(); g.moveTo(4 * sx, -2); g.quadraticCurveTo(12 * sx, -2, (10 + sway) * sx, -10); g.stroke();
        g.lineCap = "butt";
        g.fillStyle = INK; g.beginPath(); g.ellipse(0, -6, 5, 6.5, 0, 0, Math.PI * 2);
        g.moveTo(3, -14); g.arc(-1, -14, 4.2, 0, Math.PI * 2);
        g.moveTo(-5, -15); g.lineTo(-4.5, -21); g.lineTo(-1, -17); g.lineTo(2.5, -21); g.lineTo(3, -15); g.fill();
        if ((c.ex - p[0]) * CAT_FACE[0] + (c.ey - p[1]) * CAT_FACE[1] > 0) {
          g.fillStyle = GOLD; g.fillRect(-3.2, -15, 1.6, 1.6); g.fillRect(0.2, -15, 1.6, 1.6);
        }
        g.restore();
      } };
      // 玄関の段
      const step = { at: W(1.5, 2.61, 2), anchor: wallS, draw: function (R) {
        R.box(W(1.1, V1, 0), W(1.9, 2.72, 4), { s: shade(STEP, 0.10), e: shade(STEP, -0.20), w: shade(STEP, 0), top: shade(STEP, 0.3) });
      } };
      // 水晶玉（石の台座つき。玉は丸い物なので、いつもこちらを向けて描く。まわりの光がゆっくり明るくなったり暗くなったりする）
      const ball = { at: W(BALL_C[0], BALL_C[1], 10), anchor: wallS, draw: function (R) {
        R.box(W(0.5, 2.66, 0), W(0.76, 2.92, 9), { s: shade(STONE, 0.10), e: shade(STONE, -0.20), w: shade(STONE, 0), n: shade(STONE, -0.28), top: shade(STONE, 0.3) });
        const q = R.p(W(BALL_C[0], BALL_C[1], BALL_C[2]));
        if (q.z < NEAR * 2) return;
        const g = R.g, k = modelK(q.z);
        g.beginPath(); g.arc(q.x, q.y, 11.5 * k, 0, Math.PI * 2);
        g.fillStyle = "rgba(200,170,255," + (0.30 + 0.12 * Math.sin(R.t * 2)).toFixed(3) + ")"; g.fill();
        g.beginPath(); g.arc(q.x, q.y, 8 * k, 0, Math.PI * 2);
        g.fillStyle = BALL; g.fill(); g.strokeStyle = OL; g.lineWidth = Math.max(0.35, k); g.stroke();
        g.beginPath(); g.arc(q.x + k, q.y + k, 5 * k, 0.2, 2.2); g.strokeStyle = BALL_LINE; g.lineWidth = Math.max(0.5, 2 * k); g.stroke();
        g.beginPath(); g.arc(q.x - 3 * k, q.y - 3 * k, 2 * k, 0, Math.PI * 2); g.fillStyle = "#ffffff"; g.fill();
      } };
      // 看板の柱（棟に立てた2本。看板そのものは drawModel が、いつもこちらを向けて描く）
      const posts = { at: W((SIGN_U0 + SIGN_U1) / 2, VM, (ZR + SIGN_Z) / 2), anchor: null, draw: function (R) {
        if (signShow.has(b) && signShow.get(b) <= 0.01) return;   // 看板を隠している間は、柱も出さない
        R.lines([[W(SIGN_U0, VM, ZR), W(SIGN_U0, VM, SIGN_Z)], [W(SIGN_U1, VM, ZR), W(SIGN_U1, VM, SIGN_Z)]], shade(roof, -0.45), 3);
      } };

      // ---- 輪郭を決める点（部品ごとのまとまり。最初のまとまり＝母屋） ----
      const hull = [
        [W(U0, V0, 0), W(U1, V0, 0), W(U1, V1, 0), W(U0, V1, 0),                                    // 母屋（壁・屋根・玄関の段・黒猫・看板の柱）
          W(RU0, RV0, ZE), W(RU1, RV0, ZE), W(RU1, RV1, ZE), W(RU0, RV1, ZE),
          W(RU0, RV0, ZE - FASCIA), W(RU1, RV0, ZE - FASCIA), W(RU1, RV1, ZE - FASCIA), W(RU0, RV1, ZE - FASCIA),
          W(RU0, VM, ZR + 3), W(RU1, VM, ZR + 3),
          W(1.1, 2.72, 0), W(1.9, 2.72, 0),
          W(CAT_U - 0.1, VM, ZR + 22), W(CAT_U + 0.1, VM, ZR + 22),
          W(SIGN_U0, VM, SIGN_Z), W(SIGN_U1, VM, SIGN_Z)],
        [tip, W(TU + LEAN[0], TV + LEAN[1], CZ1 + 11)],                                              // 塔・帽子・三日月
        [W(0.5, 2.66, 0), W(0.76, 2.66, 0), W(0.76, 2.92, 0), W(0.5, 2.92, 0),                       // 水晶玉
          W(BALL_C[0] - 0.23, BALL_C[1], BALL_C[2]), W(BALL_C[0] + 0.23, BALL_C[1], BALL_C[2]),
          W(BALL_C[0], BALL_C[1] - 0.23, BALL_C[2]), W(BALL_C[0], BALL_C[1] + 0.23, BALL_C[2]), W(BALL_C[0], BALL_C[1], BALL_C[2] + 11.5)]
      ];
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * Math.PI * 2;
        hull[1].push(T(a, TR, 0), T(a, TR, TZ), T(a, CR, CZ0));
      }

      return {
        faces: [wallS, wallE, wallN, wallW].concat(fascia, [roofS, roofN]),
        after: function (R) {                           // 棟
          R.g.lineCap = "round";
          R.lines([[W(RU0, VM, ZR + 1), W(RU1, VM, ZR + 1)]], shade(roof, -0.45), 4);
          R.g.lineCap = "butt";
        },
        attach: [tower, cat, step, ball, posts],
        sign: W((SIGN_U0 + SIGN_U1) / 2, VM, SIGN_Z),
        hull: hull,
        bound: [W(TU + LEAN[0], TV + LEAN[1], CZ1 + 12)]
      };
    }

    return { build: build };
  })();

  // 食事提案処の立体（斜め見下ろしの絵 BUILDING_ART.gohan を、立体に作り直した物）
  BUILDING_MODEL.gohan = (function () {
    // ---- 色（BUILDING_ART.gohan と同じ） ----
    const TRIM = "#fffaf0", GOLD = "#f2c14e", WARM = "#f6dc9a", GLASS = "#ffeeb5", FANLIGHT = "#fff3c4";
    const DEEP = "#b5502b", AWN = "#f08a4b", FLOWER = "#f26a5a";
    const PAVE = "#efe6d6", SKIRT_S = "#ddd5c8", SKIRT_E = "#b9b1a6", BOARD = "rgba(70,50,70,0.11)";
    const CHIM = "#f1e4d2", STEP = "#e2dacb", POT = "#f1e6d4", BOX = "#f3e8d6";
    const SLATE = "#3f4a44", SLATE_FRAME = "#a57c4f", POLE = "#6b5442", TABLE = "#fffdf6", CHAIR = "#b98a5e", SEAT = "#d3a676";
    const BULB = "#ffd766";
    // ---- 寸法（BUILDING_ART.gohan と同じ。a＝西→東、b＝北→南。どちらも土台の西北の角から 0〜3 マス。高さは絵の px） ----
    const A0 = 0.2, A1 = 2.65, B0 = 0.3, B1 = 2.5;              // 壁の範囲（入口は南の壁 b＝B1）
    const VM = 1.4, ZE = 60, ZR = 90;                           // 棟の位置（東西に通る）・軒の高さ・棟の高さ
    const OV = 0.12, OE = 0.07, FASCIA = 3, BARGE = 5;          // 軒の出（南北）・妻の側の屋根の出（東西）・軒の厚み・白い破風板の幅
    const KZ = 36;                                              // 絵の「1マスぶんの横の長さ」（壁の上の飾りの横の px → マス）
    const DOOR_A = 1.5, DOOR_HW = 13, DOOR_H = 43;              // 入口の扉（中心・半分の幅（px）・高さ）
    const AW_A0 = A0 + 0.08, AW_A1 = A1 - 0.05, AW_D = 0.42, AW_Z = 60, AW_DROP = 8, AW_FALL = 6, AW_N = 8;   // 日よけ（範囲・出・付け根の高さ・下がり・たれ・しまの数）
    const SIGN_A0 = 0.7, SIGN_A1 = 1.5, SIGN_Z = 120;           // 看板の柱の位置（棟の上）・看板の中心の高さ（煙突のてっぺんより上に出す）
    const CH_A = 2.42, CH_HW = 0.13, CH_TOP = 102;              // 白い煙突（棟の上）
    const SLATE_AT = [0.25, 2.85], SLATE_H = 24;                // 黒板の立て看板（テラスの西のはし）
    // パラソルの席（テラスの東のはし）。絵では日よけの前に重ねて描いてあるが、立体では日よけ・壁の角とぶつからないよう、南東の角に置く
    const PARA = [2.78, 2.78], PARA_R = 0.28, PARA_IN = 0.18, PARA_TOP = 47, PARA_MID = 43, PARA_BRIM = 35, TABLE_Z = 14, TABLE_R = 0.13;
    const CHAIRS = [[2.56, 2.76], [2.95, 2.8]], CHAIR_HW = 0.045, CHAIR_H = 8;
    const SHRUB = [2.84, 1.32, 1.1];                            // 東の壁ぎわの植木（位置・大きさ）
    // ---- 立体にして足した物（絵に無い北の壁と西の妻壁。控えめに） ----
    const BACK_DOOR = [2.0, 2.36, 36];                          // 北の壁の勝手口（a の範囲・高さ）
    function roofZ(bb) { return ZR - (ZR - ZE) * Math.abs(bb - VM) / (B1 - VM); }

    function build(b) {
      const HZ = CAMC.buildingScale / ART_PX;                   // 絵の高さ（px）→ マス（立て看板と同じ大きさになる）
      const W = function (a, bb, h) { return [b.x + a, b.y + bb, (h || 0) * HZ]; };
      const OL = COLORS.outline, wall = b.wallColor || "#fdebc9", roof = b.roofColor || "#e67a45";
      const RA0 = A0 - OE, RA1 = A1 + OE, RB0 = B0 - OV, RB1 = B1 + OV, zE = roofZ(RB1), zB = roofZ(RB0);
      // 壁の上の位置（u＝壁にそった位置、h＝高さ）
      const onS = function (u, h) { return W(u, B1, h); }, onN = function (u, h) { return W(u, B0, h); };
      const onE = function (u, h) { return W(A1, u, h); }, onW = function (u, h) { return W(A0, u, h); };
      const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
      // 点 p を通り、向き n の面が、カメラのほうを向いているか
      const sees = function (p, n) { const c = fcam; return (c.ex - p[0]) * n[0] + (c.ey - p[1]) * n[1] + (c.ez - p[2]) * n[2] > 0; };

      // 壁の石の土台と、板張りの横の線。q＝壁の上の位置を決める関数、u0〜u1＝壁にそった範囲
      function skirt(R, q, u0, u1, col) { R.poly([q(u0, 0), q(u1, 0), q(u1, 5), q(u0, 5)], col); }
      function boards(R, q, u0, u1) {
        const segs = [];
        for (let z = 13; z < ZE - 2; z += 8) segs.push([q(u0, z), q(u1, z)]);
        R.lines(segs, BOARD, 1);
      }
      // 窓（白いわく＋ガラス＋桟）。c＝窓の中心（壁にそった位置）、z＝窓の下の高さ、w・h＝幅と高さ（px）
      function win(R, q, c, z, w, h, glass) {
        const hw = w / 2 / KZ, fr = 2.5 / KZ;
        R.poly([q(c - hw - fr, z - 2.5), q(c + hw + fr, z - 2.5), q(c + hw + fr, z + h + 2.5), q(c - hw - fr, z + h + 2.5)], TRIM, OL, 1);
        R.poly([q(c - hw, z), q(c + hw, z), q(c + hw, z + h), q(c - hw, z + h)], glass);
        if (w > 20) R.lines([[q(c - hw / 3, z), q(c - hw / 3, z + h)], [q(c + hw / 3, z), q(c + hw / 3, z + h)]], TRIM, 1.6);
        else R.lines([[q(c, z), q(c, z + h)], [q(c - hw, z + h * 0.6), q(c + hw, z + h * 0.6)]], TRIM, 1.6);
      }
      // 妻の丸窓（白いふち＋明かり）。q＝妻壁の上の位置
      function roundWindow(R, q, u) {
        R.poly(R.disc(q(VM, 74), u, Z, 6.5 / KZ, 6.5 * HZ, 14), TRIM, OL, 1);
        R.poly(R.disc(q(VM, 74), u, Z, 4.2 / KZ, 4.2 * HZ, 14), WARM);
      }
      // 南の窓の下の花箱（壁から少し出た箱＋葉＋花）
      function flowerBox(R, c, z, w) {
        const a0 = c - (w / 2 + 3) / KZ, a1 = c + (w / 2 + 3) / KZ;
        R.box(W(a0, B1, z - 8), W(a1, B1 + 0.1, z - 3), { s: BOX, e: shade(BOX, -0.2), w: shade(BOX, -0.1), top: shade(BOX, -0.12) });
        for (let j = 0; j < 4; j++) R.dot(W(c + (-w / 2 + j * w / 3) / KZ, B1 + 0.05, z - 1), 3, COLORS.treeLight);
        for (let j = 0; j < 3; j++) R.dot(W(c + (-w / 2 + w / 6 + j * w / 3) / KZ, B1 + 0.05, z + 0.5), 2.2, FLOWER);
      }
      // 入口の扉（白いわく＋アーチの扉＋明かり窓＋合わせ目＋金の取っ手）と、玄関の踏み段
      function door(R) {
        const arch = function (r, zc) {
          const pts = [onS(DOOR_A - r / KZ, 0)];
          for (let i = 0; i <= 10; i++) { const a = Math.PI - i / 10 * Math.PI; pts.push(onS(DOOR_A + r * Math.cos(a) / KZ, zc + r * Math.sin(a))); }
          pts.push(onS(DOOR_A + r / KZ, 0));
          return pts;
        };
        R.poly(arch(DOOR_HW + 3, DOOR_H - DOOR_HW), TRIM, OL, 1);
        R.poly(arch(DOOR_HW, DOOR_H - DOOR_HW), DEEP, OL, 1);
        const fl = [], zc = DOOR_H - DOOR_HW + 1, rr = DOOR_HW - 4;
        for (let i = 0; i <= 10; i++) { const a = Math.PI - i / 10 * Math.PI; fl.push(onS(DOOR_A + rr * Math.cos(a) / KZ, zc + rr * Math.sin(a))); }
        R.poly(fl, FANLIGHT);
        R.lines([[onS(DOOR_A, 0), onS(DOOR_A, DOOR_H - DOOR_HW - 1)]], "rgba(0,0,0,0.22)", 1);
        R.dot(onS(DOOR_A - 3.5 / KZ, DOOR_H * 0.42), 1.9, GOLD);
        R.dot(onS(DOOR_A + 3.5 / KZ, DOOR_H * 0.42), 1.9, GOLD);
        R.box(W(1.02, B1, 0), W(1.98, B1 + 0.15, 2), { top: STEP, s: shade(STEP, -0.08), e: shade(STEP, -0.22), w: shade(STEP, -0.12) });
      }
      // しま模様の日よけ（オレンジと白。南の壁いっぱい）。上の面・たれ・両はしの横の面のうち、こちらを向いた面だけ描く
      function awning(R) {
        const c = fcam, zb = AW_Z - AW_DROP - AW_FALL;
        const T = function (a, k) { return W(a, B1 + AW_D * k, AW_Z - AW_DROP * k); };           // 上の面：k＝付け根(0)→先(1)
        const F = function (a, k) { return W(a, B1 + AW_D, AW_Z - AW_DROP - AW_FALL * k); };      // たれ：k＝上(0)→下(1)
        const striped = function (S) {                  // 面を塗って、白いしまを1本おきに重ね、ふちの線を引く
          const all = [S(AW_A0, 0), S(AW_A1, 0), S(AW_A1, 1), S(AW_A0, 1)];
          R.poly(all, AWN);
          for (let i = 1; i < AW_N; i += 2) {
            const p0 = lerp(AW_A0, AW_A1, i / AW_N), p1 = lerp(AW_A0, AW_A1, (i + 1) / AW_N);
            R.poly([S(p0, 0), S(p1, 0), S(p1, 1), S(p0, 1)], TRIM);
          }
          R.poly(all, null, OL, 1);
        };
        if (sees(T(AW_A0, 0), [0, AW_DROP * HZ, AW_D])) striped(T);
        if (c.ey > b.y + B1 + AW_D) striped(F);
        const side = function (a, col) { R.poly([W(a, B1, AW_Z), W(a, B1 + AW_D, AW_Z - AW_DROP), W(a, B1 + AW_D, zb), W(a, B1, zb)], col, OL, 1); };
        if (c.ex > b.x + AW_A1) side(AW_A1, shade(AWN, -0.32));
        if (c.ex < b.x + AW_A0) side(AW_A0, shade(AWN, -0.12));
        R.lines([[T(AW_A0, 1), T(AW_A1, 1)]], "rgba(40,30,20,0.3)", 1);    // 上の面とたれの境目
      }
      // 電球のひも飾り（東の壁の軒の下に、たるませて1本。電球は少しずつ明るさがゆらぐ）
      function stringLights(R) {
        const xa = A1 + 0.03, y0 = B1 - 0.06, y1 = B0 + 0.1, n = 6;
        const L = function (t, dz) { return W(xa, lerp(y0, y1, t), 56 - 9 * 2 * t * (1 - t) - (dz || 0)); };   // 絵と同じ、ゆるい2次曲線
        const wire = [];
        for (let i = 0; i <= 12; i++) wire.push(L(i / 12));
        R.lines([wire], "rgba(60,45,40,0.75)", 1);
        const g = R.g;
        for (let i = 0; i < n; i++) {
          const q = R.p(L((i + 0.5) / n, 2.5));
          if (q.z < NEAR * 2) continue;
          const k = modelK(q.z), r = (2.9 + 0.6 * Math.sin(R.t * 3 + i * 1.7)) * k;
          g.beginPath(); g.arc(q.x, q.y, Math.max(0.5, r), 0, Math.PI * 2);
          g.fillStyle = BULB; g.fill(); g.strokeStyle = "rgba(120,80,20,0.6)"; g.lineWidth = Math.max(0.35, k); g.stroke();
        }
      }

      // ---- 本体の壁（明るさは南＋0.10・東－0.18（絵と同じ）、西 0・北－0.28） ----
      const wallS = { pts: [onS(A0, 0), onS(A1, 0), onS(A1, ZE), onS(A0, ZE)], col: shade(wall, 0.10), layer: 0, deco: function (R) {
        skirt(R, onS, A0, A1, SKIRT_S);
        boards(R, onS, A0, A1);
        win(R, onS, 0.68, 19, 17, 19, GLASS);
        flowerBox(R, 0.68, 19, 17);
        door(R);
        awning(R);                                      // 日よけは、屋根（後で塗る）の軒の下にもぐる形なので、壁の飾りとして描く
      } };
      const wallE = { pts: [onE(B0, 0), onE(B1, 0), onE(B1, ZE), onE(VM, ZR), onE(B0, ZE)], col: shade(wall, -0.18), layer: 0, deco: function (R) {
        skirt(R, onE, B0, B1, SKIRT_E);
        boards(R, onE, B0, B1);
        win(R, onE, 0.78, 20, 15, 20, WARM);            // 小窓
        roundWindow(R, onE, Y);                         // 妻の丸窓
        win(R, onE, 1.93, 17, 30, 24, GLASS);           // 料理の並ぶ飾り窓（皿と料理：赤・緑・赤）
        [-10, 0, 10].forEach(function (d) {
          R.poly(R.disc(onE(1.93 - d / KZ, 21), Y, Z, 4.2 / KZ, 2.3 * HZ, 10), "#fff", "rgba(90,60,30,0.5)", 0.8);
          R.poly(R.disc(onE(1.93 - d / KZ, 22.3), Y, Z, 2.5 / KZ, 2.5 * HZ, 10), d ? "#e2563c" : "#7cb342");
        });
        stringLights(R);
      } };
      const wallN = { pts: [onN(A1, 0), onN(A0, 0), onN(A0, ZE), onN(A1, ZE)], col: shade(wall, -0.28), layer: 0, deco: function (R) {
        skirt(R, onN, A0, A1, shade(SKIRT_S, -0.28));
        boards(R, onN, A0, A1);
        win(R, onN, 0.75, 20, 15, 20, shade(WARM, -0.08));
        win(R, onN, 1.35, 20, 15, 20, shade(WARM, -0.08));
        // 勝手口（白いわく＋板の扉＋金の取っ手）
        const d0 = BACK_DOOR[0], d1 = BACK_DOOR[1], dh = BACK_DOOR[2];
        R.poly([onN(d0 - 0.07, 0), onN(d1 + 0.07, 0), onN(d1 + 0.07, dh + 2.5), onN(d0 - 0.07, dh + 2.5)], TRIM, OL, 1);
        R.poly([onN(d0, 0), onN(d1, 0), onN(d1, dh), onN(d0, dh)], shade(DEEP, -0.12), OL, 1);
        R.poly([onN(d0 + 0.08, dh - 14), onN(d1 - 0.08, dh - 14), onN(d1 - 0.08, dh - 5), onN(d0 + 0.08, dh - 5)], shade(FANLIGHT, -0.08));
        R.dot(onN(d0 + 0.06, 17), 1.6, GOLD);
      } };
      const wallW = { pts: [onW(B1, 0), onW(B0, 0), onW(B0, ZE), onW(VM, ZR), onW(B1, ZE)], col: shade(wall, 0), layer: 0, deco: function (R) {
        skirt(R, onW, B0, B1, shade(SKIRT_S, -0.08));
        boards(R, onW, B0, B1);
        roundWindow(R, onW, Y);
        win(R, onW, VM, 20, 15, 20, WARM);
      } };

      // ---- 屋根（切妻。南の斜面＝明るい、北の斜面＝暗い）と、軒の厚み・妻の白い破風板 ----
      const S = function (s, k) { return W(RA0 + (RA1 - RA0) * s, VM + (RB1 - VM) * k, ZR + (zE - ZR) * k); };   // 南の斜面：s＝西(0)→東(1)、k＝棟(0)→軒(1)
      const N = function (s, k) { return W(RA0 + (RA1 - RA0) * s, VM - (VM - RB0) * k, ZR + (zB - ZR) * k); };   // 北の斜面
      const tiles = function (R, F) {                   // かわらの段（横の線）
        R.lines([0.25, 0.5, 0.75].map(function (k) { return [F(0, k), F(1, k)]; }), "rgba(0,0,0,0.13)", 1);
      };
      const roofS = { pts: [S(0, 0), S(1, 0), S(1, 1), S(0, 1)], col: shade(roof, 0.06), layer: 2, deco: function (R) { tiles(R, S); } };
      const roofN = { pts: [N(1, 0), N(0, 0), N(0, 1), N(1, 1)], col: shade(roof, -0.28), layer: 2, deco: function (R) { tiles(R, N); } };
      const barge = function (a, bb, z, col) {          // 妻の破風板（a＝東か西のはし、bb・z＝軒のはし）
        return { pts: [W(a, VM, ZR), W(a, bb, z), W(a, bb, z - BARGE), W(a, VM, ZR - BARGE - 0.5)], col: col, layer: 1 };
      };
      const fascia = [
        { pts: [S(0, 1), S(1, 1), W(RA1, RB1, zE - FASCIA), W(RA0, RB1, zE - FASCIA)], col: shade(roof, -0.3), layer: 1 },    // 南の軒の厚み
        { pts: [N(1, 1), N(0, 1), W(RA0, RB0, zB - FASCIA), W(RA1, RB0, zB - FASCIA)], col: shade(roof, -0.45), layer: 1 },   // 北の軒の厚み
        barge(RA1, RB1, zE, shade(TRIM, -0.07)), barge(RA1, RB0, zB, shade(TRIM, -0.07)),                                   // 東の破風板（南半分・北半分）
        barge(RA0, RB1, zE, shade(TRIM, -0.02)), barge(RA0, RB0, zB, shade(TRIM, -0.02))                                    // 西の破風板
      ];

      // ---- 出っぱった物 ----
      const c0 = CH_A - CH_HW, c1 = CH_A + CH_HW, d0 = VM - CH_HW, d1 = VM + CH_HW;
      const chimney = { at: W(CH_A, VM, 96), anchor: null, draw: function (R) {   // 白い煙突（棟にまたがって立つ）と、湯気
        const c = fcam;
        if (c.ey > b.y + d1) R.poly([W(c0, d1, roofZ(d1)), W(c1, d1, roofZ(d1)), W(c1, d1, CH_TOP), W(c0, d1, CH_TOP)], shade(CHIM, 0.10), OL);
        if (c.ey < b.y + d0) R.poly([W(c1, d0, roofZ(d0)), W(c0, d0, roofZ(d0)), W(c0, d0, CH_TOP), W(c1, d0, CH_TOP)], shade(CHIM, -0.28), OL);
        if (c.ex > b.x + c1) R.poly([W(c1, d1, roofZ(d1)), W(c1, VM, ZR), W(c1, d0, roofZ(d0)), W(c1, d0, CH_TOP), W(c1, d1, CH_TOP)], shade(CHIM, -0.18), OL);
        if (c.ex < b.x + c0) R.poly([W(c0, d0, roofZ(d0)), W(c0, VM, ZR), W(c0, d1, roofZ(d1)), W(c0, d1, CH_TOP), W(c0, d0, CH_TOP)], shade(CHIM, 0), OL);
        if (c.ez > CH_TOP * HZ) R.poly([W(c0, d0, CH_TOP), W(c1, d0, CH_TOP), W(c1, d1, CH_TOP), W(c0, d1, CH_TOP)], DEEP, OL);
        for (let i = 0; i < 3; i++) {                   // 湯気（上りながら北東へ流れ、終わりぎわに薄くなる）
          const k = (R.t * 0.35 + i / 3) % 1;
          const q = R.p(W(CH_A + 0.08 + 0.3 * k + Math.sin(R.t * 1.3 + i) * 0.03, VM - 0.08 - 0.25 * k, CH_TOP + 5 + 18 * k));
          if (q.z < NEAR * 2) continue;
          R.g.globalAlpha = 0.8 * clamp((1 - k) * 2.5, 0, 1);
          R.g.beginPath(); R.g.arc(q.x, q.y, (3 + 3 * k) * modelK(q.z), 0, Math.PI * 2);
          R.g.fillStyle = "#ffffff"; R.g.fill();
        }
        R.g.globalAlpha = 1;
      } };
      // 看板の柱（棟に立てた2本と、足の台。看板そのものは drawModel が、いつもこちらを向けて描く）
      const posts = { at: W((SIGN_A0 + SIGN_A1) / 2, VM, (ZR + SIGN_Z) / 2), anchor: null, draw: function (R) {
        if (signShow.has(b) && signShow.get(b) <= 0.01) return;   // 看板を隠している間は、柱も出さない
        const dk = shade(roof, -0.45), zf = roofZ(VM + 0.06);
        [SIGN_A0, SIGN_A1].forEach(function (a) { R.box(W(a - 0.11, VM - 0.06, zf), W(a + 0.11, VM + 0.06, ZR + 3), { s: dk, n: dk, e: dk, w: dk, top: dk }, null); });
        R.lines([[W(SIGN_A0, VM, ZR + 3), W(SIGN_A0, VM, SIGN_Z)], [W(SIGN_A1, VM, ZR + 3), W(SIGN_A1, VM, SIGN_Z)]], dk, 3);
      } };
      // 南の壁が向こうを向いている時（東・西・北から見る時）の日よけ（本体の前に描き、本体にかくれる所はかくれる）。
      // こちらを向いている時は、南の壁の飾りとして描く
      const awningBack = { at: W((AW_A0 + AW_A1) / 2, B1 + AW_D / 2, AW_Z - AW_DROP), anchor: wallS, draw: function (R) {
        if (facesCam(wallS)) return;
        awning(R);
      } };
      // 黒板の立て看板（A字に開いた2枚の板。こちらを向いた面に、チョークの字（線））
      const slate = { at: W(SLATE_AT[0], SLATE_AT[1], SLATE_H / 2), anchor: wallS, draw: function (R) {
        const a = SLATE_AT[0], bc = SLATE_AT[1], hb = 8.5 / KZ, ht = 6.5 / KZ, sp = 0.08;
        const on = function (sgn, u, z) { return W(a + u * sgn, bc + sgn * sp * (1 - z / SLATE_H), z); };   // 板の上の位置（u＝横の px、z＝高さ）
        [1, -1].map(function (sgn) {
          return { sgn: sgn, z: R.p(W(a, bc + sgn * sp / 2, SLATE_H / 2)).z };
        }).sort(function (p, q) { return q.z - p.z; }).forEach(function (s) {
          const sgn = s.sgn;
          const pts = [W(a - hb, bc + sgn * sp, 0), W(a + hb, bc + sgn * sp, 0), W(a + ht, bc, SLATE_H), W(a - ht, bc, SLATE_H)];
          R.poly(pts, SLATE, SLATE_FRAME, 2.4);
          if (!sees(pts[0], [0, sgn * SLATE_H * HZ, sp])) return;
          R.lines([[on(sgn, -4 / KZ, 18.5), on(sgn, 4 / KZ, 18.5)], [on(sgn, -4.5 / KZ, 13), on(sgn, 4.5 / KZ, 13)], [on(sgn, -5 / KZ, 7.5), on(sgn, 2 / KZ, 7.5)]],
            "rgba(255,255,255,0.85)", 1.4);
        });
      } };
      // パラソルの席（丸いテーブル・いす2つ・しま模様のかさ。かさは8枚の布（赤と白）を、棟から縁へ2段の面で）
      const parasol = { at: W(PARA[0], PARA[1], 20), anchor: wallS, draw: function (R) {
        const px = PARA[0], py = PARA[1];
        const parts = CHAIRS.map(function (ch) {
          return { z: R.p(W(ch[0], ch[1], CHAIR_H / 2)).z, draw: function () {
            R.box(W(ch[0] - CHAIR_HW, ch[1] - CHAIR_HW, 0), W(ch[0] + CHAIR_HW, ch[1] + CHAIR_HW, CHAIR_H),
              { s: CHAIR, e: shade(CHAIR, -0.18), w: shade(CHAIR, -0.05), n: shade(CHAIR, -0.28), top: SEAT });
          } };
        });
        parts.push({ z: R.p(W(px, py, TABLE_Z)).z, draw: function () {
          R.lines([[W(px, py, 0), W(px, py, TABLE_Z)]], POLE, 2.4);
          if (fcam.ez > TABLE_Z * HZ) R.poly(R.disc(W(px, py, TABLE_Z), X, Y, TABLE_R, TABLE_R, 16), TABLE, OL, 1);
        } });
        parts.sort(function (p, q) { return q.z - p.z; }).forEach(function (p) { p.draw(); });
        R.lines([[W(px, py, TABLE_Z), W(px, py, PARA_TOP)]], POLE, 2.4);
        const ring = function (r, z, i) { const t = (i + 0.5) / 8 * Math.PI * 2; return W(px + Math.cos(t) * r, py + Math.sin(t) * r, z); };
        const apex = W(px, py, PARA_TOP), inside = W(px, py, PARA_BRIM - 8);
        for (let i = 0; i < 8; i++) {
          const col = i % 2 ? TRIM : FLOWER;
          [[apex, ring(PARA_IN, PARA_MID, i), ring(PARA_IN, PARA_MID, i + 1)],
            [ring(PARA_IN, PARA_MID, i), ring(PARA_R, PARA_BRIM, i), ring(PARA_R, PARA_BRIM, i + 1), ring(PARA_IN, PARA_MID, i + 1)]].forEach(function (pts) {
            const n = faceNormal(pts, inside), len = Math.hypot(n[0], n[1], n[2]) || 1;
            if (!sees(pts[0], n)) return;               // かさは上へふくらんだ形なので、こちらを向いた面だけ塗れば重なりは正しい
            R.poly(pts, shade(col, (0.10 * n[1] - 0.18 * n[0]) / len), "rgba(60,40,40,0.35)", 0.8);
          });
        }
        const brim = [];
        for (let i = 0; i <= 8; i++) brim.push(ring(PARA_R, PARA_BRIM, i));
        R.lines([brim], OL, 1);
        R.dot(W(px, py, PARA_TOP + 2), 2, GOLD);
      } };
      // 東の壁ぎわの植木（鉢＋丸い葉。丸い物なので、いつもこちらを向いた形で描く）
      const shrub = { at: W(SHRUB[0], SHRUB[1], 12), anchor: wallE, draw: function (R) {
        const s = SHRUB[2], q = R.p(W(SHRUB[0], SHRUB[1], 0)), t = R.p(W(SHRUB[0], SHRUB[1], 15 * s));
        if (q.z < NEAR * 2 || t.z < NEAR * 2) return;
        const g = R.g, k = modelK(q.z) * s, kt = modelK(t.z) * s;
        g.fillStyle = POT; g.strokeStyle = OL; g.lineWidth = Math.max(0.35, modelK(q.z));
        g.beginPath(); g.moveTo(q.x - 5 * k, q.y - 8 * k); g.lineTo(q.x + 5 * k, q.y - 8 * k); g.lineTo(q.x + 4 * k, q.y + k); g.lineTo(q.x - 4 * k, q.y + k); g.closePath();
        g.fill(); g.stroke();
        g.fillStyle = COLORS.treeDark; g.beginPath(); g.arc(t.x, t.y, 8 * kt, 0, Math.PI * 2); g.fill();
        g.fillStyle = COLORS.treeLight; g.beginPath(); g.arc(t.x - 2 * kt, t.y - 2 * kt, 5 * kt, 0, Math.PI * 2); g.fill();
      } };

      // ---- 輪郭を決める点（部品ごとのまとまり。まとまりごとに外周を取る。1つにまとめると、テラスの物のすき間まで建物になる） ----
      const zb = AW_Z - AW_DROP - AW_FALL, sr = 8 * SHRUB[2] * HZ;
      const hull = [
        [W(A0, B0, 0), W(A1, B0, 0), W(A1, B1, 0), W(A0, B1, 0),                                    // 本体（壁・屋根・煙突・踏み段・日よけ・看板の柱）
          W(RA0, RB0, zB), W(RA1, RB0, zB), W(RA1, RB1, zE), W(RA0, RB1, zE),
          W(RA0, RB0, zB - BARGE), W(RA1, RB0, zB - BARGE), W(RA1, RB1, zE - BARGE), W(RA0, RB1, zE - BARGE),
          W(RA0, VM, ZR + 1), W(RA1, VM, ZR + 1),
          W(c0, d0, CH_TOP), W(c1, d0, CH_TOP), W(c1, d1, CH_TOP), W(c0, d1, CH_TOP),
          W(1.02, B1 + 0.15, 0), W(1.98, B1 + 0.15, 0),
          W(AW_A0, B1 + AW_D, AW_Z - AW_DROP), W(AW_A1, B1 + AW_D, AW_Z - AW_DROP), W(AW_A0, B1 + AW_D, zb), W(AW_A1, B1 + AW_D, zb),
          W(SIGN_A0, VM, SIGN_Z - 15), W(SIGN_A1, VM, SIGN_Z - 15)],
        [W(SLATE_AT[0] - 8.5 / KZ, SLATE_AT[1] - 0.08, 0), W(SLATE_AT[0] + 8.5 / KZ, SLATE_AT[1] - 0.08, 0),    // 黒板の立て看板
          W(SLATE_AT[0] - 8.5 / KZ, SLATE_AT[1] + 0.08, 0), W(SLATE_AT[0] + 8.5 / KZ, SLATE_AT[1] + 0.08, 0),
          W(SLATE_AT[0] - 6.5 / KZ, SLATE_AT[1], SLATE_H), W(SLATE_AT[0] + 6.5 / KZ, SLATE_AT[1], SLATE_H)],
        [W(PARA[0], PARA[1], PARA_TOP + 3)],                                                          // パラソルの席
        [W(SHRUB[0] - 0.12, SHRUB[1], 0), W(SHRUB[0] + 0.12, SHRUB[1], 0), W(SHRUB[0], SHRUB[1] - 0.12, 0), W(SHRUB[0], SHRUB[1] + 0.12, 0),   // 植木
          W(SHRUB[0] - sr, SHRUB[1], 15 * SHRUB[2]), W(SHRUB[0] + sr, SHRUB[1], 15 * SHRUB[2]), W(SHRUB[0], SHRUB[1] - sr, 15 * SHRUB[2]),
          W(SHRUB[0], SHRUB[1] + sr, 15 * SHRUB[2]), W(SHRUB[0], SHRUB[1], 15 * SHRUB[2] + 8 * SHRUB[2])]
      ];
      for (let i = 0; i < 8; i++) {                     // パラソルのかさの縁と、いすの足もと
        const t = (i + 0.5) / 8 * Math.PI * 2;
        hull[2].push(W(PARA[0] + Math.cos(t) * PARA_R, PARA[1] + Math.sin(t) * PARA_R, PARA_BRIM));
      }
      CHAIRS.forEach(function (ch) {
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (d) { hull[2].push(W(ch[0] + d[0] * CHAIR_HW, ch[1] + d[1] * CHAIR_HW, 0)); });
      });

      return {
        faces: [wallS, wallE, wallN, wallW].concat(fascia, [roofS, roofN]),
        attach: [chimney, posts, awningBack, slate, parasol, shrub],
        ground: function (R) {                          // テラスの石だたみ（土台いっぱい）
          R.poly([W(0.05, 0.05, 0), W(2.95, 0.05, 0), W(2.95, 2.95, 0), W(0.05, 2.95, 0)], PAVE, "rgba(40,30,20,0.25)", 1);
        },
        sign: W((SIGN_A0 + SIGN_A1) / 2, VM, SIGN_Z),
        hull: hull,
        bound: [W(CH_A + 0.45, VM - 0.4, CH_TOP + 30)]
      };
    }

    return { build: build };
  })();

  // EA紹介所の立体（斜め見下ろしの絵 BUILDING_ART.ea を、立体に作り直した物）。低い白いロビーの上に、青いガラスの高層棟が立つ。
  //   本体は2つの箱（ロビーと高層棟）。カメラはいつもロビーの屋上より高いので、高層棟がロビーに隠れることは無い。
  //   そこで「ロビーの壁 → ロビーの屋上 → 高層棟の壁と屋上」の順に塗る（layer 0・1・2 をこの順に使う）。
  //   ロビーの屋上に立つ物（看板の柱）と、高層棟の屋上に立つ物（金の矢印）は、高層棟との前後をカメラの位置で決める（twoSides）
  BUILDING_MODEL.ea = (function () {
    // ---- 色（BUILDING_ART.ea と同じ） ----
    const GOLD = "#f2c230", GOLD_DARK = "#8a6410", NAVY = "#16294f", GLASS = "#a9d2f3";
    const UP = "#3ddc97", DOWN = "#ff6b6b";
    // ---- 寸法（BUILDING_ART.ea と同じ。a＝西→東、b＝北→南。どちらも土台の西北の角から 0〜3 マス。高さは絵の px） ----
    const L0 = 0.25, L1 = 3, LOBBY_H = 52;                      // ロビーの範囲（a・b とも L0〜L1）と高さ（入口は東の壁 a＝L1）
    const T_A0 = 0.5, T_A1 = 2.1, T_B0 = 1.0, T_B1 = 2.6;       // 高層棟の範囲（ロビーの上の南西寄り。東にテラスを残す）
    const TOWER_H = 122, DOOR_H = 43;                           // 高層棟の屋上の高さ・ガラス扉の高さ
    const BAND0 = 43, BAND_Z = 47.5;                            // 電光の帯の下端・流れる点線の高さ
    const CH0 = 61, CH1 = 115;                                  // チャート画面の下端・上端（高層棟の南の面）
    const SIGN_A = 2.72, SIGN_B = 1.5, SIGN_H = 104;            // 看板の場所（テラスの上、入口の真上）・看板の中心の高さ（絵の、土台の手前の角から）
    const POST_HW = 0.45;                                       // 看板の柱（2本）の間の半分（マス）
    // 看板の中心の高さ（px）。絵では「土台の手前の角から SIGN_H 上」の位置なので、看板の場所の真上の高さに直す
    const SIGN_Z = (SIGN_A + SIGN_B) * TH / 2 + SIGN_H - 3 * TH;
    // 金の矢印（高層棟の屋上のまん中に立つ板。絵の画面上の形 [横, 縦]（px）を、絵で左右に見える向き（南西→北東）の縦の面に置き直す）
    const ARROW = [[-22, 3], [-9, 15], [1, 8], [16, 23]];       // 矢の線（[横, 屋上からの高さ]）
    const ARROW_HEAD = [[24, 31], [21, 16], [9, 27]];           // 矢じり
    const ARROW_POSTS = [[-16, 8], [8, 14]];                    // 支えの柱（[横, 高さ]。屋上から立てる）
    // ---- 立体にして足した物（絵に無い北と西の面。控えめに） ----
    const BACK_DOOR = [2.25, 2.65, 36];                         // ロビーの北の壁の裏口（a の範囲・高さ）

    function build(b) {
      const HZ = CAMC.buildingScale / ART_PX;                   // 絵の高さ（px）→ マス（立て看板と同じ大きさになる）
      const W = function (a, bb, h) { return [b.x + a, b.y + bb, (h || 0) * HZ]; };
      const OL = COLORS.outline, wall = b.wallColor, roof = b.roofColor;
      const Y = [0, 1, 0], Z = [0, 0, 1];
      // ロビーの壁の上の位置（u＝壁にそった位置、h＝高さ）
      const onS = function (u, h) { return W(u, L1, h); }, onN = function (u, h) { return W(u, L0, h); };
      const onE = function (u, h) { return W(L1, u, h); }, onW = function (u, h) { return W(L0, u, h); };
      // 高層棟の壁の上の位置
      const tS = function (u, h) { return W(u, T_B1, h); }, tN = function (u, h) { return W(u, T_B0, h); };
      const tE = function (u, h) { return W(T_A1, u, h); }, tW = function (u, h) { return W(T_A0, u, h); };
      // 矢印の板の上の位置（x＝絵の横の px、h＝屋上からの高さ px）
      const AM = (T_A0 + T_A1) / 2, BM = (T_B0 + T_B1) / 2;
      const onArrow = function (x, h) { return W(AM + x / TW, BM - x / TW, TOWER_H + h); };

      // 電光の帯（紺の帯＋流れる点線）。q＝壁の上の位置、u0→u1＝点線の流れる向き
      function band(R, q, u0, u1, col, line) {
        R.poly([q(u0, BAND0), q(u1, BAND0), q(u1, LOBBY_H), q(u0, LOBBY_H)], col, OL);
        const k = R.k(q((u0 + u1) / 2, BAND_Z));
        R.g.setLineDash([9 * k, 7 * k]); R.g.lineDashOffset = -R.t * 14 * k;
        R.lines([[q(u0 + (u1 > u0 ? 0.1 : -0.1), BAND_Z), q(u1 - (u1 > u0 ? 0.05 : -0.05), BAND_Z)]], line, 3);
        R.g.setLineDash([]); R.g.lineDashOffset = 0;
      }
      // 横長のガラス窓と、白い桟。q＝壁の上の位置、u0〜u1＝窓の範囲、bars＝桟の位置
      function glassRow(R, q, u0, u1, col, bars) {
        R.poly([q(u0, 8), q(u1, 8), q(u1, 36), q(u0, 36)], col, OL);
        R.lines(bars.map(function (u) { return [q(u, 8), q(u, 36)]; }), "rgba(255,255,255,0.8)", 1.5);
      }
      // 高層棟のガラスの桟（14px ごとの横の線と、4等分のたての線）。q＝壁の上の位置、u0〜u1＝壁の範囲
      function towerGrid(R, q, u0, u1) {
        const gl = [];
        for (let h = LOBBY_H + 14; h < TOWER_H; h += 14) gl.push([q(u0, h), q(u1, h)]);
        for (let i = 1; i < 4; i++) { const u = lerp(u0, u1, i / 4); gl.push([q(u, LOBBY_H), q(u, TOWER_H)]); }
        R.lines(gl, "rgba(255,255,255,0.45)", 1);
      }
      // ガラスの照り（斜めの帯）
      function glare(R, q, u0, u1) {
        R.poly([q(u0 + 0.05, LOBBY_H), q(u0 + 0.45, LOBBY_H), q(u1 - 0.1, TOWER_H), q(u1 - 0.5, TOWER_H)], "rgba(255,255,255,0.16)");
      }

      // ---- ロビーの壁（白。明るさは南＋0.45・東－0.16（絵と同じ）、西＋0.25・北－0.26） ----
      const wallS = { pts: [onS(L0, 0), onS(L1, 0), onS(L1, LOBBY_H), onS(L0, LOBBY_H)], col: shade(wall, 0.45), layer: 0, deco: function (R) {
        glassRow(R, onS, 0.5, 2.75, GLASS, [0.95, 1.4, 1.85, 2.3]);
        band(R, onS, L0, L1, NAVY, GOLD);              // 点線は西→東へ流れる（絵と同じ）
      } };
      const wallE = { pts: [onE(L1, 0), onE(L0, 0), onE(L0, LOBBY_H), onE(L1, LOBBY_H)], col: shade(wall, -0.16), layer: 0, deco: function (R) {
        R.poly([onE(0.4, 8), onE(0.82, 8), onE(0.82, 36), onE(0.4, 36)], shade(GLASS, -0.18), OL);   // 入口の両わきの窓
        R.poly([onE(2.18, 8), onE(2.6, 8), onE(2.6, 36), onE(2.18, 36)], shade(GLASS, -0.18), OL);
        band(R, onE, L1, L0, shade(NAVY, -0.25), UP);   // 点線は南→北へ流れる（絵と同じ）
        // 入口（明るい枠＋ガラスの両開き＋足元にもれる明かり＋照り＋金の取っ手）
        R.poly([onE(0.98, 0), onE(2.02, 0), onE(2.02, 46.5), onE(0.98, 46.5)], "#fbfdff", OL);
        [[1.07, 1.485], [1.515, 1.93]].forEach(function (d) {
          R.poly([onE(d[0], 0), onE(d[1], 0), onE(d[1], DOOR_H), onE(d[0], DOOR_H)], "#d6f0ff", OL);
          R.poly([onE(d[0], 0), onE(d[1], 0), onE(d[1], 13), onE(d[0], 13)], "#fff0b8");
        });
        R.lines([[onE(1.15, 34), onE(1.33, 20)], [onE(1.6, 34), onE(1.78, 20)]], "rgba(255,255,255,0.95)", 2);
        const hd = [[onE(1.44, 15), onE(1.44, 25)], [onE(1.56, 15), onE(1.56, 25)]];
        R.lines(hd, GOLD_DARK, 3.4);
        R.lines(hd, GOLD, 2);
        // 入口の両わきの明かり（壁の上の丸）
        [0.9, 2.1].forEach(function (u) { R.poly(R.disc(onE(u, 30), Y, Z, 3.2 * HZ, 3.2 * HZ, 12), "#ffe48a", OL, 1); });
      } };
      const wallN = { pts: [onN(L1, 0), onN(L0, 0), onN(L0, LOBBY_H), onN(L1, LOBBY_H)], col: shade(wall, -0.26), layer: 0, deco: function (R) {
        glassRow(R, onN, 0.5, 1.95, shade(GLASS, -0.26), [0.98, 1.46]);
        // 裏口（すりガラスの片開き＋取っ手）
        const d0 = BACK_DOOR[0], d1 = BACK_DOOR[1], dh = BACK_DOOR[2];
        R.poly([onN(d0 - 0.04, 0), onN(d1 + 0.04, 0), onN(d1 + 0.04, dh + 3), onN(d0 - 0.04, dh + 3)], shade("#fbfdff", -0.26), OL);
        R.poly([onN(d0, 0), onN(d1, 0), onN(d1, dh), onN(d0, dh)], shade("#d6f0ff", -0.26), OL);
        R.lines([[onN(d0 + 0.06, 15), onN(d0 + 0.06, 23)]], GOLD_DARK, 2.4);
        band(R, onN, L1, L0, shade(NAVY, -0.35), UP);   // 点線は東→西へ流れる（帯をひと回りする向き）
      } };
      const wallW = { pts: [onW(L1, 0), onW(L0, 0), onW(L0, LOBBY_H), onW(L1, LOBBY_H)], col: shade(wall, 0.25), layer: 0, deco: function (R) {
        glassRow(R, onW, 0.5, 2.75, shade(GLASS, -0.06), [0.95, 1.4, 1.85, 2.3]);
        band(R, onW, L0, L1, shade(NAVY, -0.1), GOLD);  // 点線は北→南へ流れる
      } };

      // ---- ロビーの屋上（高層棟の手前に描く物を、ここで描く） ----
      const lobbyTop = { pts: [W(L0, L0, LOBBY_H), W(L1, L0, LOBBY_H), W(L1, L1, LOBBY_H), W(L0, L1, LOBBY_H)], col: shade(wall, 0.62), layer: 1, deco: function (R) {
        twoSides(R, false);
      } };

      // ---- 高層棟（青いガラス張り。明るさは南＋0.30・東－0.10（絵と同じ）、西＋0.12・北－0.22）と、金のふちの屋上 ----
      const TIN = W(AM, BM, (LOBBY_H + TOWER_H) / 2);           // 高層棟の内側の点（面の外向きを決める）
      const towerS = { pts: [tS(T_A0, LOBBY_H), tS(T_A1, LOBBY_H), tS(T_A1, TOWER_H), tS(T_A0, TOWER_H)], col: shade(roof, 0.30), layer: 2, inside: TIN, deco: function (R) {
        glare(R, tS, T_A0, T_A1);
        towerGrid(R, tS, T_A0, T_A1);
        // チャート画面（金の枠・緑と赤のローソク足。いちばん右の足だけ、先が少し上下する）
        const ca0 = T_A0 + 0.12, ca1 = T_A1 - 0.12;
        R.poly([tS(ca0, CH0), tS(ca1, CH0), tS(ca1, CH1), tS(ca0, CH1)], "#0f1d3a", GOLD, 2);
        const candles = [[0.13, 0.32, 1], [0.32, 0.23, 0], [0.26, 0.52, 1], [0.52, 0.42, 0], [0.45, 0.71, 1], [0.68, 0.84, 1]];
        candles.forEach(function (cd, i) {
          const a = ca0 + 0.16 + i * 0.208, col = cd[2] ? UP : DOWN;
          const lo = lerp(CH0, CH1, Math.min(cd[0], cd[1]));
          const hi = lerp(CH0, CH1, Math.max(cd[0], cd[1])) + (i === 5 ? Math.sin(R.t * 3) * 2 : 0);
          R.lines([[tS(a, lo - 3.5), tS(a, hi + 3.5)]], col, 1.2);
          R.poly([tS(a - 0.066, lo), tS(a + 0.066, lo), tS(a + 0.066, hi), tS(a - 0.066, hi)], col);
        });
      } };
      const towerE = { pts: [tE(T_B1, LOBBY_H), tE(T_B0, LOBBY_H), tE(T_B0, TOWER_H), tE(T_B1, TOWER_H)], col: shade(roof, -0.10), layer: 2, inside: TIN, deco: function (R) {
        towerGrid(R, tE, T_B0, T_B1);
      } };
      const towerN = { pts: [tN(T_A1, LOBBY_H), tN(T_A0, LOBBY_H), tN(T_A0, TOWER_H), tN(T_A1, TOWER_H)], col: shade(roof, -0.22), layer: 2, inside: TIN, deco: function (R) {
        towerGrid(R, tN, T_A0, T_A1);
      } };
      const towerW = { pts: [tW(T_B0, LOBBY_H), tW(T_B1, LOBBY_H), tW(T_B1, TOWER_H), tW(T_B0, TOWER_H)], col: shade(roof, 0.12), layer: 2, inside: TIN, deco: function (R) {
        glare(R, tW, T_B0, T_B1);
        towerGrid(R, tW, T_B0, T_B1);
      } };
      const towerTop = { pts: [W(T_A0, T_B0, TOWER_H), W(T_A1, T_B0, TOWER_H), W(T_A1, T_B1, TOWER_H), W(T_A0, T_B1, TOWER_H)], col: shade(roof, 0.55), layer: 2, inside: TIN, deco: function (R) {
        R.poly(towerTop.pts, null, GOLD, 2.5);          // 金のふち
      } };

      // ---- 屋上に立つ物 ----
      // 看板の柱（ロビーの屋上に立てた2本。看板そのものは drawModel が、いつもこちらを向けて描く）
      function signPosts(R) {
        if (signShow.has(b) && signShow.get(b) <= 0.01) return;   // 看板を隠している間は、柱も出さない
        R.lines([[W(SIGN_A, SIGN_B - POST_HW, LOBBY_H), W(SIGN_A, SIGN_B - POST_HW, SIGN_Z)],
          [W(SIGN_A, SIGN_B + POST_HW, LOBBY_H), W(SIGN_A, SIGN_B + POST_HW, SIGN_Z)]], shade(roof, -0.45), 3);
      }
      // 金の矢印（右肩上がり。支えの柱＋太い線＋矢じり）
      function arrow(R) {
        const g = R.g;
        R.lines(ARROW_POSTS.map(function (p) { return [onArrow(p[0], 0), onArrow(p[0], p[1])]; }), GOLD_DARK, 2);
        g.lineJoin = "round"; g.lineCap = "round";
        const segs = [];
        for (let i = 0; i + 1 < ARROW.length; i++) segs.push([onArrow(ARROW[i][0], ARROW[i][1]), onArrow(ARROW[i + 1][0], ARROW[i + 1][1])]);
        R.lines(segs, GOLD_DARK, 7.5);
        R.lines(segs, GOLD, 5);
        g.lineJoin = "miter"; g.lineCap = "butt";
        R.poly(ARROW_HEAD.map(function (p) { return onArrow(p[0], p[1]); }), GOLD, GOLD_DARK, 1);
      }
      // 高層棟との前後で、屋上に立つ物を描く。late＝false：高層棟より先（ロビーの屋上を塗った直後）、true：高層棟の後
      //   看板の柱は高層棟の東にあるので、高層棟の東の面が見える時だけ高層棟の手前になる。
      //   金の矢印は高層棟の屋上にあるので、屋上が見える（カメラが屋上より高い）時だけ高層棟の手前になる。
      //   低い時は先に描き、手前の壁に根元を隠させる
      function twoSides(R, late) {
        const c = fcam, topSeen = facesCam(lobbyTop);
        const postsLate = c.ex > b.x + T_A1, arrowLate = c.ez > TOWER_H * HZ;
        if (late ? (postsLate || !topSeen) : (!postsLate && topSeen)) signPosts(R);
        if (late ? (arrowLate || !topSeen) : (!arrowLate && topSeen)) arrow(R);
      }

      // ---- 出っぱった物 ----
      const canopy = { at: W(L1 + 0.075, 1.5, 48.5), anchor: wallE, draw: function (R) {   // 入口の上の金のひさし（土台の外へ 0.15マス）
        R.box(W(L1, 0.97, 46.5), W(L1 + 0.15, 2.03, 50.5), { s: shade(GOLD, 0.10), e: shade(GOLD, -0.20), n: shade(GOLD, -0.32), top: shade(GOLD, 0.35) });
      } };

      // ---- 輪郭を決める点（まとまりごとに外周を取る。最初のまとまり＝ロビー（主人公を隠す判定に使う）） ----
      const hull = [
        [W(L0, L0, 0), W(L1, L0, 0), W(L1, L1, 0), W(L0, L1, 0),                                       // ロビー（＋金のひさし）
          W(L0, L0, LOBBY_H), W(L1, L0, LOBBY_H), W(L1, L1, LOBBY_H), W(L0, L1, LOBBY_H),
          W(L1 + 0.15, 0.97, 46.5), W(L1 + 0.15, 2.03, 46.5), W(L1 + 0.15, 0.97, 50.5), W(L1 + 0.15, 2.03, 50.5)],
        [W(T_A0, T_B0, LOBBY_H), W(T_A1, T_B0, LOBBY_H), W(T_A1, T_B1, LOBBY_H), W(T_A0, T_B1, LOBBY_H),   // 高層棟（＋金の矢印）
          W(T_A0, T_B0, TOWER_H), W(T_A1, T_B0, TOWER_H), W(T_A1, T_B1, TOWER_H), W(T_A0, T_B1, TOWER_H),
          onArrow(ARROW[0][0], ARROW[0][1]), onArrow(ARROW_HEAD[0][0], ARROW_HEAD[0][1])],
        [W(SIGN_A, SIGN_B - POST_HW, LOBBY_H), W(SIGN_A, SIGN_B + POST_HW, LOBBY_H),                    // 看板の柱
          W(SIGN_A, SIGN_B - POST_HW, SIGN_Z), W(SIGN_A, SIGN_B + POST_HW, SIGN_Z)]
      ];

      return {
        faces: [wallS, wallE, wallN, wallW, lobbyTop, towerS, towerE, towerN, towerW, towerTop],
        after: function (R) { twoSides(R, true); },
        attach: [canopy],
        sign: W(SIGN_A, SIGN_B, SIGN_Z),
        hull: hull
      };
    }

    return { build: build };
  })();

  // EAギルドの立体（斜め見下ろしの絵 BUILDING_ART.guild を、立体に作り直した物）
  //   母屋（石積みの壁＋緑の切妻屋根。入口は東の妻壁）と、西南の角の見張り塔（胸壁つき・旗）の2つの箱でできている。
  //   塔と母屋は「a＝U0 の面」で分かれる（塔は西、母屋は東）。塔は母屋の西の妻壁に付いた物（attach）として描き、
  //   西の妻壁がこちらを向いていれば母屋の後（塔が手前）、向こうなら母屋の前（塔が奥）に描く
  BUILDING_MODEL.guild = (function () {
    // ---- 色（BUILDING_ART.guild と同じ） ----
    const GOLD = "#f2c230", GOLD_DARK = "#8a6410", WOOD = "#5b3a22", IRON = "#3b3538", GLOW = "#ffd98a", JOINT = "rgba(70,58,40,0.28)";
    // ---- 寸法（BUILDING_ART.guild と同じ。a＝西→東、b＝北→南。どちらも土台の西北の角から 0〜3 マス。高さは絵の px） ----
    const U0 = 0.95, U1 = 2.8, V0 = 0.3, V1 = 2.7, VM = 1.5;        // 母屋の壁の範囲（入口は東の妻壁 a＝U1）・棟の位置（東西に通る）
    const ZE = 56, ZR = 90;                                         // 軒の高さ・棟の高さ
    const RU1 = 2.95, RV0 = 0.22, RV1 = 2.85, FASCIA = 4;           // 屋根の広がり（西のはしは塔の東の壁 U0 にそろえる）と厚み
    const DOOR_V = 1.5, DOOR_HW = 0.3, DOOR_ZS = 31;                // 入口の扉（中心・半分の幅・アーチの始まる高さ）
    const TA0 = 0.15, TA1 = 0.95, TB0 = 1.95, TB1 = 2.85, TZ = 112; // 見張り塔（西南の角）の範囲と高さ
    const POLE_U = 0.55, POLE_V = 2.4, POLE_H = 30;                 // 塔の上の旗ざおの位置と高さ
    const SIGN_U0 = 1.55, SIGN_U1 = 2.85, SIGN_H = 112;             // 看板の柱の位置（東西）・看板の中心の高さ（絵の、土台の中心から）
    const SIGN_V = 1.05;                                            // 看板の柱の位置（南北）。絵では棟の上（1.5）だが、入口の前から見て塔の旗に
                                                                    // 重ならないよう、屋根の北の斜面へ寄せる（立体にして変えた所）
    const KZ = 36;                                                  // 絵の「1マスぶんの縦の長さ」
    const MERLON = 0.16, MERLON_H = 8;                              // 胸壁の凸の大きさ・高さ
    const TORCH_V = [0.88, 2.12];                                   // 入口の両わきのたいまつ
    const FLAG_L = 0.66, FLAG_H = 17;                               // 塔の旗の長さ（マス。絵の左へ30px＝西南へ）・幅（px）
    // 看板の中心の高さ（px）。絵では「土台の中心から SIGN_H 上」の位置なので、柱のまん中の真上の高さに直す
    const SIGN_Z = ((SIGN_U0 + SIGN_U1) / 2 + VM) * TH / 2 - 1.5 * TH + SIGN_H;
    // ---- 立体にして足した物（絵に無い北の壁・西の妻壁・塔の北と西の面。控えめに） ----
    const WEST_WIN = 1.0;                                           // 西の妻壁の窓（塔に隠れない北寄り）
    // 屋根の上面の高さ（px）。b＝北→南の位置
    function roofZ(bb) { return ZR - (ZR - ZE) * Math.abs(bb - VM) / (RV1 - VM); }

    function build(b) {
      const HZ = CAMC.buildingScale / ART_PX;                   // 絵の高さ（px）→ マス（立て看板と同じ大きさになる）
      const W = function (a, bb, h) { return [b.x + a, b.y + bb, (h || 0) * HZ]; };
      const OL = COLORS.outline, wall = b.wallColor, roof = b.roofColor;
      const WT = roofZ(V1);                                     // 長い壁（南・北）の高さ（屋根の下の面に合わせる）
      const zS = roofZ(RV1), zN = roofZ(RV0);                   // 南・北の軒の高さ
      // 面ごとの明るさ（南が明るく、北が暗い。南＋0.10・東－0.20 は絵と同じ）と、足もとの石の帯の明るさ
      const SH = { s: 0.10, e: -0.20, w: 0, n: -0.30 }, BAND = { s: -0.18, e: -0.35, w: -0.22, n: -0.45 };
      // 壁の上の位置（c＝壁にそった位置、h＝高さ）。母屋の4面と、塔の4面
      const onS = function (c, h) { return W(c, V1, h); }, onN = function (c, h) { return W(c, V0, h); };
      const onE = function (c, h) { return W(U1, c, h); }, onW = function (c, h) { return W(U0, c, h); };
      const tS = function (c, h) { return W(c, TB1, h); }, tN = function (c, h) { return W(c, TB0, h); };
      const tE = function (c, h) { return W(TA1, c, h); }, tW = function (c, h) { return W(TA0, c, h); };
      const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
      const flick = function (R) { return 0.82 + 0.18 * Math.sin(R.t * 2.3); };   // 窓の明かりのまたたき（絵と同じ）

      // 上が丸いアーチの形。q＝壁の上の位置、c＝中心、hw＝半分の幅、z0＝下、zs＝丸の始まる高さ
      function arch(q, c, hw, z0, zs) {
        const a = [q(c - hw, z0)];
        for (let i = 0; i <= 8; i++) { const r = Math.PI - i / 8 * Math.PI; a.push(q(c + hw * Math.cos(r), zs + hw * KZ * Math.sin(r))); }
        a.push(q(c + hw, z0));
        return a;
      }
      // 石積みの目地（段ごとに縦の目地をずらす）。c0〜c1＝壁にそった範囲、z1＝上のはし
      function joints(R, q, c0, c1, z1) {
        const s = [];
        for (let z = 12, r = 0; z < z1; z += 12, r++) {
          s.push([q(c0, z), q(c1, z)]);
          for (let c = c0 + (r % 2 ? 0.2 : 0.38); c < c1 - 0.05; c += 0.36) s.push([q(c, z), q(c, Math.min(z + 12, z1))]);
        }
        R.lines(s, JOINT, 1);
      }
      // 足もとの石の帯
      function band(R, q, c0, c1, k) { R.poly([q(c0, 0), q(c1, 0), q(c1, 7), q(c0, 7)], shade(wall, BAND[k])); }
      // 上が丸い窓（母屋の窓。明かりがまたたく。たての桟と横の桟）
      function window2(R, q, c) {
        R.g.globalAlpha = flick(R);
        R.poly(arch(q, c, 0.16, 14, 30), GLOW, shade(wall, -0.45), 2);
        R.lines([[q(c, 14), q(c, 30 + 0.16 * KZ)], [q(c - 0.16, 26), q(c + 0.16, 26)]], shade(wall, -0.45), 1.3);
        R.g.globalAlpha = 1;
      }
      // 細長い窓（塔の窓）
      function slit(R, q, c, z0, zs, col) {
        R.g.globalAlpha = flick(R);
        R.poly(arch(q, c, 0.09, z0, zs), col || GLOW, IRON, 1.5);
        R.g.globalAlpha = 1;
      }

      // ---- 母屋の壁（石積み） ----
      const wallS = { pts: [onS(U0, 0), onS(U1, 0), onS(U1, WT), onS(U0, WT)], col: shade(wall, SH.s), layer: 0, deco: function (R) {
        joints(R, onS, U0, U1, WT);
        band(R, onS, U0, U1, "s");
        window2(R, onS, 1.38); window2(R, onS, 2.4);
        // まん中に吊った旗（ギルドの色の地に金のふち・金のコイン）
        const BU = 1.89, BW = 0.19;
        R.poly([onS(BU - BW, 52), onS(BU + BW, 52), onS(BU + BW, 20), onS(BU, 26), onS(BU - BW, 20)], roof, shade(roof, -0.45), 1);
        R.lines([[onS(BU - BW - 0.05, 52.5), onS(BU + BW + 0.05, 52.5)]], GOLD_DARK, 2.5);   // 旗をさげる棒
        R.lines([[onS(BU - BW + 0.05, 49), onS(BU - BW + 0.05, 23)], [onS(BU + BW - 0.05, 49), onS(BU + BW - 0.05, 23)]], GOLD, 1);
        R.poly(R.disc(onS(BU, 39), X, Z, 4 * HZ, 4 * HZ, 12), GOLD, GOLD_DARK, 1);
      } };
      const wallE = { pts: [onE(V0, 0), onE(V1, 0), onE(V1, WT), onE(VM, ZR), onE(V0, WT)], col: shade(wall, SH.e), layer: 0, deco: function (R) {
        joints(R, onE, V0, V1, WT);
        band(R, onE, V0, V1, "e");
        // 入口（石のふちのアーチ＋鉄の帯の木の扉＋金の輪の取っ手）
        R.poly(arch(onE, DOOR_V, DOOR_HW + 0.08, 0, DOOR_ZS), shade(wall, 0.25), OL);
        R.poly(arch(onE, DOOR_V, DOOR_HW, 0, DOOR_ZS), WOOD, OL);
        R.lines([[onE(DOOR_V, 0), onE(DOOR_V, DOOR_ZS + DOOR_HW * KZ)]], "rgba(0,0,0,0.45)", 1);
        R.lines([[onE(DOOR_V - DOOR_HW, 10), onE(DOOR_V + DOOR_HW, 10)], [onE(DOOR_V - DOOR_HW, 27), onE(DOOR_V + DOOR_HW, 27)]], IRON, 2.5);
        R.poly(R.disc(onE(DOOR_V - 0.08, 18), Y, Z, 2.2 * HZ, 2.2 * HZ, 10), null, GOLD, 1.5);
        R.poly(R.disc(onE(DOOR_V + 0.08, 18), Y, Z, 2.2 * HZ, 2.2 * HZ, 10), null, GOLD, 1.5);
        // 入口の上の紋章（金のふちの盾。中に金の右肩上がりの線）
        const shield = function (hw, zt, zs, zb) {
          const pts = [onE(DOOR_V + hw, zt), onE(DOOR_V - hw, zt), onE(DOOR_V - hw, zs)];
          const quad = function (p0, p1, p2) {                // 2次の曲線を点の並びにする（絵の quadraticCurveTo と同じ形）
            for (let i = 1; i <= 6; i++) {
              const t = i / 6, s = 1 - t;
              pts.push(onE(s * s * p0[0] + 2 * s * t * p1[0] + t * t * p2[0], s * s * p0[1] + 2 * s * t * p1[1] + t * t * p2[1]));
            }
          };
          quad([DOOR_V - hw, zs], [DOOR_V - hw, zb + 4], [DOOR_V, zb]);
          quad([DOOR_V, zb], [DOOR_V + hw, zb + 4], [DOOR_V + hw, zs]);
          return pts;
        };
        R.poly(shield(0.23, 72, 61, 46), GOLD, GOLD_DARK, 1);
        R.poly(shield(0.175, 69.5, 61, 50), roof);
        R.g.lineJoin = "round"; R.g.lineCap = "round";
        R.lines([[onE(DOOR_V + 0.11, 55), onE(DOOR_V + 0.03, 61), onE(DOOR_V - 0.03, 58), onE(DOOR_V - 0.11, 66)]], GOLD, 2);
        R.lines([[onE(DOOR_V - 0.04, 66.5), onE(DOOR_V - 0.11, 66), onE(DOOR_V - 0.11, 62)]], GOLD, 2);
        R.g.lineJoin = "miter"; R.g.lineCap = "butt";
      } };
      const wallN = { pts: [onN(U1, 0), onN(U0, 0), onN(U0, WT), onN(U1, WT)], col: shade(wall, SH.n), layer: 0, deco: function (R) {
        joints(R, onN, U0, U1, WT);
        band(R, onN, U0, U1, "n");
        window2(R, onN, 1.38); window2(R, onN, 2.4);
      } };
      // 西の妻壁（南の半分ほどは塔に隠れる。窓は塔に隠れない北寄りに）
      const wallW = { pts: [onW(V1, 0), onW(V0, 0), onW(V0, WT), onW(VM, ZR), onW(V1, WT)], col: shade(wall, SH.w), layer: 0, deco: function (R) {
        joints(R, onW, V0, V1, WT);
        band(R, onW, V0, V1, "w");
        window2(R, onW, WEST_WIN);
        slit(R, onW, VM, 64, 72);
      } };

      // ---- 屋根（ギルドの色のスレートの切妻。南の斜面＝明るい、北の斜面＝暗い）と、厚み・ふち ----
      const S = function (s, k) { return W(U0 + (RU1 - U0) * s, VM + (RV1 - VM) * k, ZR + (zS - ZR) * k); };   // 南の斜面：s＝西(0)→東(1)、k＝棟(0)→軒(1)
      const N = function (s, k) { return W(U0 + (RU1 - U0) * s, VM - (VM - RV0) * k, ZR + (zN - ZR) * k); };   // 北の斜面
      const slates = function (R, F, dark) {            // スレートの段（横の線）と、継ぎ目（たての短い線。段ごとにずらす）
        const sl = [];
        [0.25, 0.5, 0.75].forEach(function (k) { sl.push([F(0, k), F(1, k)]); });
        [0, 0.25, 0.5, 0.75].forEach(function (k, r) {
          for (let s = r % 2 ? 0.14 : 0.07; s < 1; s += 0.14) sl.push([F(s, k), F(s, k + 0.25)]);
        });
        R.lines(sl, dark, 1);
        R.lines([[F(0, 1), F(1, 1)]], shade(roof, -0.42), 3);   // 軒のふちの太い線（絵と同じ）
      };
      const roofS = { pts: [S(0, 0), S(1, 0), S(1, 1), S(0, 1)], col: shade(roof, 0.04), layer: 2, deco: function (R) { slates(R, S, shade(roof, -0.28)); } };
      const roofN = { pts: [N(1, 0), N(0, 0), N(0, 1), N(1, 1)], col: shade(roof, -0.30), layer: 2, deco: function (R) { slates(R, N, shade(roof, -0.50)); } };
      const fascia = [
        { pts: [S(0, 1), S(1, 1), W(RU1, RV1, zS - FASCIA), W(U0, RV1, zS - FASCIA)], col: shade(roof, -0.30), layer: 1 },   // 南の軒の厚み
        { pts: [N(1, 1), N(0, 1), W(U0, RV0, zN - FASCIA), W(RU1, RV0, zN - FASCIA)], col: shade(roof, -0.50), layer: 1 },   // 北の軒の厚み
        { pts: [W(RU1, VM, ZR), W(RU1, RV1, zS), W(RU1, RV1, zS - FASCIA), W(RU1, VM, ZR - FASCIA)], col: shade(roof, -0.42), layer: 1 },   // 東のふち（南半分）
        { pts: [W(RU1, VM, ZR), W(RU1, RV0, zN), W(RU1, RV0, zN - FASCIA), W(RU1, VM, ZR - FASCIA)], col: shade(roof, -0.52), layer: 1 },   // 東のふち（北半分）
        { pts: [W(U0, VM, ZR), W(U0, RV1, zS), W(U0, RV1, zS - FASCIA), W(U0, VM, ZR - FASCIA)], col: shade(roof, -0.34), layer: 1 },    // 西のふち（南半分。西の妻壁の上にのる）
        { pts: [W(U0, VM, ZR), W(U0, RV0, zN), W(U0, RV0, zN - FASCIA), W(U0, VM, ZR - FASCIA)], col: shade(roof, -0.44), layer: 1 }     // 西のふち（北半分）
      ];

      // ---- 見張り塔（西南の角。胸壁つき。上に旗） ----
      // 塔の本体の面（こちらを向いた面だけ）
      function towerWalls(R) {
        const c = fcam;
        if (c.ey > b.y + TB1) {                         // 南
          R.poly([tS(TA0, 0), tS(TA1, 0), tS(TA1, TZ), tS(TA0, TZ)], shade(wall, SH.s), OL);
          joints(R, tS, TA0, TA1, TZ); band(R, tS, TA0, TA1, "s");
          slit(R, tS, (TA0 + TA1) / 2, 66, 84); slit(R, tS, (TA0 + TA1) / 2, 30, 46);
        }
        if (c.ex > b.x + TA1) {                         // 東（下の方は母屋に隠れる）
          R.poly([tE(TB1, 0), tE(TB0, 0), tE(TB0, TZ), tE(TB1, TZ)], shade(wall, SH.e), OL);
          joints(R, tE, TB0, TB1, TZ); band(R, tE, TB0, TB1, "e");
          slit(R, tE, (TB0 + TB1) / 2, 66, 84, shade(GLOW, -0.12));
        }
        if (c.ey < b.y + TB0) {                         // 北（立体にして足した面）
          R.poly([tN(TA1, 0), tN(TA0, 0), tN(TA0, TZ), tN(TA1, TZ)], shade(wall, SH.n), OL);
          joints(R, tN, TA0, TA1, TZ); band(R, tN, TA0, TA1, "n");
          slit(R, tN, (TA0 + TA1) / 2, 66, 84, shade(GLOW, -0.2));
        }
        if (c.ex < b.x + TA0) {                         // 西（立体にして足した面）
          R.poly([tW(TB0, 0), tW(TB1, 0), tW(TB1, TZ), tW(TB0, TZ)], shade(wall, SH.w), OL);
          joints(R, tW, TB0, TB1, TZ); band(R, tW, TB0, TB1, "w");
          slit(R, tW, (TB0 + TB1) / 2, 66, 84); slit(R, tW, (TB0 + TB1) / 2, 30, 46);
        }
      }
      // 胸壁の凸（絵と同じ並び：北と南のふちに3つずつ、西と東のふちに2つずつ）
      const merlons = [];
      [[TA0, TA0 + MERLON], [(TA0 + TA1 - MERLON) / 2, (TA0 + TA1 + MERLON) / 2], [TA1 - MERLON, TA1]].forEach(function (a) {
        merlons.push([a[0], TB0, a[1], TB0 + MERLON]); merlons.push([a[0], TB1 - MERLON, a[1], TB1]);
      });
      [[TB0 + MERLON + 0.12, TB0 + 2 * MERLON + 0.12], [TB1 - 2 * MERLON - 0.12, TB1 - MERLON - 0.12]].forEach(function (v) {
        merlons.push([TA0, v[0], TA0 + MERLON, v[1]]); merlons.push([TA1 - MERLON, v[0], TA1, v[1]]);
      });
      const merlonCols = { s: shade(wall, SH.s), e: shade(wall, SH.e), n: shade(wall, SH.n), w: shade(wall, SH.w), top: shade(wall, 0.3) };
      // 旗の形（さおの先から西南へなびく。なびきは横向きの波（立体）。i＝0（さお）〜8（先））
      const fd = [-Math.SQRT1_2, Math.SQRT1_2], fp = [Math.SQRT1_2, Math.SQRT1_2];   // 旗の向き（西南）・それと直角の横の向き
      function flagPt(R, k, h, i) {
        const w = Math.sin(R.t * 3.2 - i * 0.85) * 0.06 * k;
        return W(POLE_U + fd[0] * FLAG_L * k + fp[0] * w, POLE_V + fd[1] * FLAG_L * k + fp[1] * w, h);
      }
      function flag(R) {
        const N8 = 8, zt = TZ + POLE_H - 3, top = [], bot = [];
        for (let i = 0; i <= N8; i++) { top.push(flagPt(R, i / N8, zt, i)); bot.push(flagPt(R, i / N8, zt - FLAG_H, i)); }
        const tail = flagPt(R, (N8 - 0.55) / N8, zt - FLAG_H / 2, N8);   // 燕尾（先の切れこみ）
        R.poly(top.concat([tail]).concat(bot.slice().reverse()), roof, shade(roof, -0.45), 1);
        R.lines([top.slice(0, 3), bot.slice(0, 3)], GOLD, 1.5);       // 根元の金のふち
        // 金のコイン（旗の面の上の円。中に右肩上がりの線）
        const a = flagPt(R, 2 / N8, zt - FLAG_H / 2, 2), c4 = flagPt(R, 4 / N8, zt - FLAG_H / 2, 4);
        const cm = flagPt(R, 3 / N8, zt - FLAG_H / 2, 3);
        const dl = Math.hypot(c4[0] - a[0], c4[1] - a[1]) || 1, du = [(c4[0] - a[0]) / dl, (c4[1] - a[1]) / dl, 0];
        R.poly(R.disc(cm, du, Z, 4.6 * HZ, 4.6 * HZ, 12), GOLD, GOLD_DARK, 1);
        const on = function (dx, dz) { return [cm[0] - du[0] * dx * HZ, cm[1] - du[1] * dx * HZ, cm[2] + dz * HZ]; };   // dx＝さおの向きへ（px）
        R.lines([[on(-2.2, -1.6), on(0, 0.6), on(2.4, 2.6)]], GOLD_DARK, 1.2);
      }
      function pole(R) {
        R.lines([[W(POLE_U, POLE_V, TZ), W(POLE_U, POLE_V, TZ + POLE_H)]], IRON, 2.2);
        R.dot(W(POLE_U, POLE_V, TZ + POLE_H + 1.5), 2.6, GOLD);   // さおの先の金の玉
      }
      // 塔のすべて。屋上の物（胸壁・さお・旗）は、塔の本体と「屋上の高さ TZ の面」で分かれるので、
      // カメラが屋上より高ければ本体の後、低ければ本体の前に描く。屋上の物どうしは奥から順に
      const tower = { at: W((TA0 + TA1) / 2, (TB0 + TB1) / 2, TZ / 2), anchor: wallW, draw: function (R) {
        const tops = merlons.map(function (m) {
          return { z: R.p(W((m[0] + m[2]) / 2, (m[1] + m[3]) / 2, TZ + MERLON_H / 2)).z, draw: function () { R.box(W(m[0], m[1], TZ), W(m[2], m[3], TZ + MERLON_H), merlonCols); } };
        });
        tops.push({ z: R.p(W(POLE_U, POLE_V, TZ + 10)).z, draw: function () { pole(R); } });
        tops.push({ z: R.p(flagPt(R, 0.5, TZ + POLE_H - 3 - FLAG_H / 2, 4)).z, draw: function () { flag(R); } });
        tops.sort(function (p, q) { return q.z - p.z; });
        const above = fcam.ez > TZ * HZ;
        if (!above) tops.forEach(function (it) { it.draw(); });
        towerWalls(R);
        if (above) {
          R.poly([W(TA0, TB0, TZ), W(TA1, TB0, TZ), W(TA1, TB1, TZ), W(TA0, TB1, TZ)], shade(wall, -0.30), OL);   // 屋上の床
          tops.forEach(function (it) { it.draw(); });
        }
      } };

      // ---- 出っぱった物（母屋） ----
      const step = { at: W(U1 + 0.13, DOOR_V, 2), anchor: wallE, draw: function (R) {   // 入口の石の段
        R.box(W(U1, DOOR_V - 0.45, 0), W(3.06, DOOR_V + 0.45, 5), { top: shade(wall, 0.3), e: shade(wall, SH.e), s: shade(wall, SH.s), n: shade(wall, SH.n) });
      } };
      // 入口の両わきのたいまつ（鉄の腕木は立体。炎は丸い物なので、いつもこちらを向いた形で描く。ゆれる）
      const torches = TORCH_V.map(function (v, i) {
        return { at: W(U1 + 0.08, v, 32), anchor: wallE, draw: function (R) {
          R.lines([[W(U1, v, 27), W(U1 + 0.1, v, 32)]], IRON, 2.5);
          const q = R.p(W(U1 + 0.1, v, 32.5));
          if (q.z < NEAR * 2) return;
          const g = R.g, k = modelK(q.z), f = 1 + 0.12 * Math.sin(R.t * 7 + i * 2.1), fx = q.x, fy = q.y;
          g.beginPath(); g.moveTo(fx, fy - 9 * f * k); g.quadraticCurveTo(fx + 4.5 * k, fy - 2 * k, fx, fy + k); g.quadraticCurveTo(fx - 4.5 * k, fy - 2 * k, fx, fy - 9 * f * k);
          g.fillStyle = "#ff9a3c"; g.fill();
          g.beginPath(); g.moveTo(fx, fy - 5.5 * f * k); g.quadraticCurveTo(fx + 2.2 * k, fy - 1.5 * k, fx, fy); g.quadraticCurveTo(fx - 2.2 * k, fy - 1.5 * k, fx, fy - 5.5 * f * k);
          g.fillStyle = "#ffe48a"; g.fill();
        } };
      });
      // 看板の柱（棟に立てた2本。看板そのものは drawModel が、いつもこちらを向けて描く）
      // 屋根の北の斜面に立つので、北の斜面がこちらを向いていれば本体の後、向こうなら本体の前（棟より上だけが見える）に描く
      const ZP = roofZ(SIGN_V);                                 // 柱の根元の高さ
      const posts = { at: W((SIGN_U0 + SIGN_U1) / 2, SIGN_V, (ZP + SIGN_Z) / 2), anchor: roofN, draw: function (R) {
        if (signShow.has(b) && signShow.get(b) <= 0.01) return;   // 看板を隠している間は、柱も出さない
        R.lines([[W(SIGN_U0, SIGN_V, ZP), W(SIGN_U0, SIGN_V, SIGN_Z)], [W(SIGN_U1, SIGN_V, ZP), W(SIGN_U1, SIGN_V, SIGN_Z)]], shade(roof, -0.45), 3);
      } };

      // ---- 輪郭を決める点（まとまりごとに外周を取る。最初＝母屋。塔は別のまとまり（L字のすき間の地面を建物にしない）） ----
      const hull = [
        [W(U0, V0, 0), W(U1, V0, 0), W(U1, V1, 0), W(U0, V1, 0),                                    // 母屋（壁・屋根・入口の段・たいまつ・看板の柱）
          W(U0, RV0, zN), W(RU1, RV0, zN), W(RU1, RV1, zS), W(U0, RV1, zS),
          W(U0, RV0, zN - FASCIA), W(RU1, RV0, zN - FASCIA), W(RU1, RV1, zS - FASCIA), W(U0, RV1, zS - FASCIA),
          W(U0, VM, ZR + 3), W(RU1, VM, ZR + 3),
          W(3.06, DOOR_V - 0.45, 0), W(3.06, DOOR_V + 0.45, 0),
          W(U1 + 0.1, TORCH_V[0], 42), W(U1 + 0.1, TORCH_V[1], 42),
          W(SIGN_U0, SIGN_V, SIGN_Z), W(SIGN_U1, SIGN_V, SIGN_Z)],
        [W(TA0, TB0, 0), W(TA1, TB0, 0), W(TA1, TB1, 0), W(TA0, TB1, 0),                           // 見張り塔（胸壁・さお・旗まで）
          W(TA0, TB0, TZ + MERLON_H), W(TA1, TB0, TZ + MERLON_H), W(TA1, TB1, TZ + MERLON_H), W(TA0, TB1, TZ + MERLON_H),
          W(POLE_U, POLE_V, TZ + POLE_H + 4),
          W(POLE_U - 0.5, POLE_V + 0.5, TZ + POLE_H - 1), W(POLE_U - 0.5, POLE_V + 0.5, TZ + POLE_H - 5 - FLAG_H)]
      ];

      return {
        faces: [wallS, wallE, wallN, wallW].concat(fascia, [roofS, roofN]),
        after: function (R) {                           // 金の棟
          R.g.lineCap = "round";
          R.lines([[W(U0, VM, ZR + 1), W(RU1, VM, ZR + 1)]], GOLD_DARK, 4.5);
          R.lines([[W(U0, VM, ZR + 1), W(RU1, VM, ZR + 1)]], GOLD, 2.5);
          R.g.lineCap = "butt";
        },
        attach: [tower, step, posts].concat(torches),
        sign: W((SIGN_U0 + SIGN_U1) / 2, SIGN_V, SIGN_Z),
        hull: hull,
        bound: [W(POLE_U - FLAG_L, POLE_V + FLAG_L, TZ + POLE_H)]
      };
    }

    return { build: build };
  })();

  // 画像生成小屋の立体（斜め見下ろしの絵 BUILDING_ART.gazou を、立体に作り直した物）
  BUILDING_MODEL.gazou = (function () {
    // ---- 色（BUILDING_ART.gazou と同じ） ----
    const WOOD = "#e6c193", WOOD_LINE = "rgba(110,70,30,0.30)", CREAM = "#fff6fa", GOLD = "#f2c230";
    const YELLOW = "#ffd23f", CYAN = "#37c8e0", VIOLET = "#9b6bf2", ORANGE = "#ff8a3c", GREEN = "#5cc26a";
    const BRUSH_PAINT = "#12a8c4";                              // 絵筆に付いた絵の具の色（空の色より濃い青緑）
    // ---- 寸法（BUILDING_ART.gazou と同じ。a＝西→東、b＝北→南。どちらも土台の西北の角から 0〜3 マス。高さは絵の px） ----
    const A0 = 0.15, A1 = 2.85, B0 = 0.1, B1 = 2.9;              // 壁の範囲（入口は南の壁 b＝B1）
    const EA0 = -0.1, EA1 = 3.1, EB0 = 0, EB1 = 3.0;             // 屋根の範囲
    const HE = 58, SLOPE = 8, FASCIA = 5;                       // 南の軒の高さ・1マスあたりの上がり（北ほど高い片流れ）・屋根の厚み
    const SIGN_DX = -17, SIGN_H = 104, POST_DX = 36;            // 看板：土台の中心からの横ずれ・高さ（絵の、土台の中心から）・柱の間隔の半分（絵のpx）
    const BRUSH_A = 2.95, BRUSH_B = 0.9;                        // 絵筆が立っている屋根の上の場所
    const BRUSH_TILT = 0.22, BRUSH_SIZE = 1.2;                  // 絵筆の傾き（絵では右へ＝立体では北東へ）と大きさ
    // 看板の中心（絵では、土台の中心から横へ SIGN_DX・上へ SIGN_H の位置。その位置に見える屋根の上の点の真上に直す）
    const SIGN_B = 1.4, SIGN_A = SIGN_B + SIGN_DX / (TW / 2);   // 絵の横ずれ SIGN_DX＝(a－b)×(TW/2)
    const SIGN_Z = (SIGN_A + SIGN_B) * TH / 2 + SIGN_H - 1.5 * TH;
    // ---- 立体にして足した物（絵に無い北の壁と西の壁。控えめに） ----
    const N_WIN = [[0.45, 1.15], [1.85, 2.55]], N_WZ = [34, 58];  // 北の壁の高窓（アトリエの北の明かり取り）
    const W_WIN = [1.1, 1.9], W_WZ = [18, 42];                  // 西の壁の窓
    function roofH(bb) { return HE + (EB1 - bb) * SLOPE; }       // 屋根の上の面の高さ（北ほど高い）

    function build(b) {
      const HZ = CAMC.buildingScale / ART_PX;                   // 絵の高さ（px）→ マス（立て看板と同じ大きさになる）
      const W = function (a, bb, h) { return [b.x + a, b.y + bb, (h || 0) * HZ]; };
      const Rf = function (a, bb, dh) { return W(a, bb, roofH(bb) + (dh || 0)); };   // 屋根の上の面の点（dh＝そこからの高さ）
      const OL = COLORS.outline, roof = b.roofColor;
      const top = function (bb) { return roofH(bb) - FASCIA; }; // 壁の上のふち（屋根の下の面）の高さ
      // 壁の上の位置（u＝壁にそった位置、h＝高さ）
      const onS = function (u, h) { return W(u, B1, h); }, onN = function (u, h) { return W(u, B0, h); };
      const onE = function (u, h) { return W(A1, u, h); }, onW = function (u, h) { return W(A0, u, h); };
      const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
      const SL = (function () { const l = Math.hypot(1, SLOPE * HZ); return [0, 1 / l, -SLOPE * HZ / l]; })();   // 屋根の面にそった、南へ下る向き

      // 壁の上の四角（q＝壁の上の位置を決める関数）
      function quad(R, q, u0, u1, h0, h1, col, st) { R.poly([q(u0, h0), q(u1, h0), q(u1, h1), q(u0, h1)], col, st); }
      // 板張りの横のすじ（14px ごと）。q＝壁、u0〜u1＝壁にそった範囲、hTop(u)＝その位置の壁の上のふち
      function planks(R, q, u0, u1, hTop) {
        const segs = [];
        for (let h = 14; h < Math.max(hTop(u0), hTop(u1)); h += 14) {
          // 壁の上のふちが傾いている所（東・西の壁）は、ふちに届く所まで
          let a = u0, c = u1;
          if (hTop(a) <= h) a = u0 + (u1 - u0) * (h - hTop(u0)) / (hTop(u1) - hTop(u0));
          if (hTop(c) <= h) c = u0 + (u1 - u0) * (h - hTop(u0)) / (hTop(u1) - hTop(u0));
          segs.push([q(a, h), q(c, h)]);
        }
        R.lines(segs, WOOD_LINE, 1);
      }
      // 十字の桟のある窓
      function window4(R, q, u0, u1, h0, h1) {
        quad(R, q, u0, u1, h0, h1, COLORS.window, OL);
        const um = (u0 + u1) / 2, hm = (h0 + h1) / 2;
        R.lines([[q(um, h0), q(um, h1)], [q(u0, hm), q(u1, hm)]], "#fff", 1.5);
      }
      // 壁に飛んだ絵の具（だ円＋小さなしずく）。q＝壁、right＝その壁を外から見て右の向き（壁にそった u の増える向きなら 1、逆なら －1）
      function splat(R, q, u, h, col, s, right) {
        const ax = q(1, 0), o = q(0, 0), du = [ax[0] - o[0], ax[1] - o[1], 0];   // 壁にそった u の向き
        R.poly(R.disc(q(u, h), du, Z, s * 0.8 * HZ, s * HZ, 12), col);
        R.poly(R.disc(q(u + right * s * 0.9 * HZ, h - s * 0.9), du, Z, s * 0.35 * HZ, s * 0.35 * HZ, 8), col);
      }

      // ---- 本体の壁（板張り。明るさは南＋0.12・東－0.20（絵と同じ）、西－0.04・北－0.30） ----
      const wallS = { pts: [onS(A0, 0), onS(A1, 0), onS(A1, top(B1)), onS(A0, top(B1))], col: shade(WOOD, 0.12), layer: 0, deco: function (R) {
        planks(R, onS, A0, A1, function () { return top(B1); });
        window4(R, onS, 0.3, 0.88, 18, 42);
        window4(R, onS, 2.12, 2.7, 18, 42);
        // 入口（白い枠＋ピンクの扉＋丸窓＋取っ手）
        quad(R, onS, 1.04, 1.96, 0, 49, CREAM, OL);
        quad(R, onS, 1.11, 1.89, 0, 46, roof, OL);
        R.poly(R.disc(onS(1.5, 31), X, Z, 6 * HZ, 6.5 * HZ, 14), "#ffe9a0", CREAM, 2);
        R.dot(onS(1.78, 19), 2, GOLD);
      } };
      const wallE = { pts: [onE(B0, 0), onE(B1, 0), onE(B1, top(B1)), onE(B0, top(B0))], col: shade(WOOD, -0.20), layer: 0, deco: function (R) {
        planks(R, onE, B0, B1, top);
        // 風景画のキャンバス（空・丘・太陽）
        quad(R, onE, 0.6, 1.9, 15, 50, "#fffdf5", OL);
        quad(R, onE, 0.69, 1.81, 19, 46, "#8fd3ff", null);
        R.poly([onE(0.69, 19), onE(1.81, 19), onE(1.81, 28), onE(1.45, 35), onE(1.1, 27), onE(0.69, 32)], GREEN);
        R.poly(R.disc(onE(0.97, 39), Y, Z, 4 * HZ, 4 * HZ, 12), YELLOW);
        // 飛んだ絵の具（東の壁を外から見ると、右＝北＝b の減る向き）
        [[2.45, 15, YELLOW, 7], [0.38, 11, CYAN, 6], [2.35, 36, VIOLET, 5]].forEach(function (sp) { splat(R, onE, sp[0], sp[1], sp[2], sp[3], -1); });
      } };
      const wallN = { pts: [onN(A1, 0), onN(A0, 0), onN(A0, top(B0)), onN(A1, top(B0))], col: shade(WOOD, -0.30), layer: 0, deco: function (R) {
        planks(R, onN, A0, A1, function () { return top(B0); });
        N_WIN.forEach(function (w) { window4(R, onN, w[0], w[1], N_WZ[0], N_WZ[1]); });
        // 飛んだ絵の具（北の壁を外から見ると、右＝西＝a の減る向き）
        [[1.5, 14, CYAN, 5], [2.6, 22, YELLOW, 4]].forEach(function (sp) { splat(R, onN, sp[0], sp[1], sp[2], sp[3], -1); });
      } };
      const wallW = { pts: [onW(B1, 0), onW(B0, 0), onW(B0, top(B0)), onW(B1, top(B1))], col: shade(WOOD, -0.04), layer: 0, deco: function (R) {
        planks(R, onW, B0, B1, top);
        window4(R, onW, W_WIN[0], W_WIN[1], W_WZ[0], W_WZ[1]);
        // 飛んだ絵の具（西の壁を外から見ると、右＝南＝b の増える向き）
        [[0.55, 16, ORANGE, 5], [2.4, 26, VIOLET, 4]].forEach(function (sp) { splat(R, onW, sp[0], sp[1], sp[2], sp[3], 1); });
      } };

      // ---- 屋根（片流れ：南へ下がる大きな1枚。上の面＝いちばん明るい）と、厚み（南・東は絵と同じ明るさ） ----
      const roofTop = { pts: [Rf(EA0, EB1), Rf(EA1, EB1), Rf(EA1, EB0), Rf(EA0, EB0)], col: shade(roof, 0.12), layer: 2, deco: function (R) {
        // 天窓（白い枠＋ガラス＋光のすじ＋十字の桟）
        R.poly([Rf(1.25, 2.4), Rf(2.8, 2.4), Rf(2.8, 0.7), Rf(1.25, 0.7)], CREAM, OL);
        R.poly([Rf(1.36, 2.29), Rf(2.69, 2.29), Rf(2.69, 0.81), Rf(1.36, 0.81)], "#bfe9fb");
        const gx = 1.45 + 0.2 * Math.sin(R.t * 0.8);
        R.poly([Rf(gx, 2.29), Rf(gx + 0.3, 2.29), Rf(gx + 0.9, 0.81), Rf(gx + 0.6, 0.81)], "rgba(255,255,255,0.55)");
        R.lines([[Rf(2.02, 2.29), Rf(2.02, 0.81)], [Rf(1.36, 1.55), Rf(2.69, 1.55)]], CREAM, 2.5);
        // 屋根に飛んだ絵の具（屋根の面の上のだ円）
        [[0.5, 2.05, YELLOW, 8], [0.72, 1.1, CYAN, 6], [0.28, 2.65, VIOLET, 5], [2.5, 2.72, GREEN, 5]].forEach(function (sp) {
          R.poly(R.disc(Rf(sp[0], sp[1]), X, SL, sp[3] * 1.3 * HZ, sp[3] * 0.85 * HZ, 12), sp[2]);
        });
      } };
      const fascia = [
        { pts: [Rf(EA0, EB1), Rf(EA1, EB1), Rf(EA1, EB1, -FASCIA), Rf(EA0, EB1, -FASCIA)], col: shade(roof, -0.10), layer: 1, deco: function (R) {
          // 南の軒から垂れる絵の具（扉の上は避ける。上は丸く、下も丸い）
          [[0.12, YELLOW, 10], [0.55, CYAN, 7], [2.3, ORANGE, 7], [2.75, GREEN, 10]].forEach(function (dr) {
            const yb = EB1 + 0.004, z0 = roofH(EB1) - 1, z1 = z0 - dr[2], pts = [];
            for (let i = 0; i <= 6; i++) { const q = Math.PI - i / 6 * Math.PI; pts.push(W(dr[0] + Math.cos(q) * 4 * HZ, yb, z1 + 4 - Math.sin(q) * 4)); }   // 下の丸み
            pts.push(W(dr[0] + 4 * HZ, yb, z0), W(dr[0] - 4 * HZ, yb, z0));
            R.poly(pts, dr[1]);
          });
        } },   // 南の軒の厚み
        { pts: [Rf(EA1, EB1), Rf(EA1, EB0), Rf(EA1, EB0, -FASCIA), Rf(EA1, EB1, -FASCIA)], col: shade(roof, -0.38), layer: 1 },   // 東のふち
        { pts: [Rf(EA1, EB0), Rf(EA0, EB0), Rf(EA0, EB0, -FASCIA), Rf(EA1, EB0, -FASCIA)], col: shade(roof, -0.45), layer: 1 },   // 北の軒の厚み
        { pts: [Rf(EA0, EB0), Rf(EA0, EB1), Rf(EA0, EB1, -FASCIA), Rf(EA0, EB0, -FASCIA)], col: shade(roof, -0.22), layer: 1 }    // 西のふち
      ];

      // ---- 屋根の上の大きな絵筆（柄の向きは立体で、太さはいつもこちらを向いた形で描く。丸い物なので、どこから見ても同じ形） ----
      const BD = [Math.sin(BRUSH_TILT) / Math.SQRT2, -Math.sin(BRUSH_TILT) / Math.SQRT2, Math.cos(BRUSH_TILT)];   // 柄の向き（北東へ傾く）
      const BU = BRUSH_SIZE * HZ, bBase = Rf(BRUSH_A, BRUSH_B);
      const axisAt = function (u) { return [bBase[0] + BD[0] * u * BU, bBase[1] + BD[1] * u * BU, bBase[2] + BD[2] * u * BU]; };   // u＝根元からの長さ（絵のpx）
      const brush = { at: axisAt(32), anchor: roofTop, draw: function (R) {
        const g = R.g, q0 = R.p(axisAt(0)), q1 = R.p(axisAt(64));
        if (q0.z < NEAR * 2 || q1.z < NEAR * 2) return;
        // 柄に付いて屋根に落ちた絵の具（屋根の面の上のだ円）
        R.poly(R.disc(Rf(BRUSH_A - 0.04, BRUSH_B + 0.04), X, SL, 8 * HZ, 6 * HZ, 12), BRUSH_PAINT);
        let dx = q1.x - q0.x, dy = q1.y - q0.y;
        const L = Math.hypot(dx, dy) || 1;
        dx /= L; dy /= L;
        const px = -dy, py = dx, k = modelK(q0.z);           // 柄に直角な向き（画面の上。絵の右＝v の増える向き）
        // 絵筆の中の位置（u＝根元からの長さ、v＝横。絵のpx）→ 画面の位置
        const B = function (u, v) { const q = R.p(axisAt(u)), s = v * BRUSH_SIZE * modelK(q.z); return { x: q.x + px * s, y: q.y + py * s }; };
        const fill = function (pts, col, st) {
          g.beginPath(); pts.forEach(function (p, i) { if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }); g.closePath();
          g.fillStyle = col; g.fill();
          if (st) { g.strokeStyle = st; g.lineWidth = Math.max(0.35, k); g.stroke(); }
        };
        const strokes = function (segs, col, lw) {
          g.beginPath(); segs.forEach(function (s) { g.moveTo(s[0].x, s[0].y); g.lineTo(s[1].x, s[1].y); });
          g.strokeStyle = col; g.lineWidth = Math.max(0.35, lw * k); g.stroke();
        };
        // 毛の形（根元からふくらんで、先が丸くとがる）
        const bristlePath = function () {
          const p0 = B(40, -7.5), c1 = B(45, -15), c2 = B(57, -11), tip = B(64, 0), c3 = B(57, 11), c4 = B(45, 15), p1 = B(40, 7.5);
          g.beginPath(); g.moveTo(p0.x, p0.y);
          g.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, tip.x, tip.y);
          g.bezierCurveTo(c3.x, c3.y, c4.x, c4.y, p1.x, p1.y);
          g.closePath();
        };
        // 柄（木。下が細く、上が太い。片側に陰、根元に近い所にピンクの帯）
        fill([B(0, -3), B(0, 3), B(30, 5.5), B(30, -5.5)], "#c98b4a", COLORS.outline);
        fill([B(0, 0.8), B(0, 3), B(30, 5.5), B(30, 2.4)], "#9f6a35");
        fill([B(6, -3.5), B(6, 3.5), B(11, 3.9), B(11, -3.9)], "#d6508f", COLORS.outline);
        // 金具（銀。横に2本のすじ）
        fill([B(30, -6.5), B(30, 6.5), B(40, 7.5), B(40, -7.5)], "#cfd6dd", COLORS.outline);
        strokes([[B(33, -6.8), B(33, 6.8)], [B(37, -7.2), B(37, 7.2)]], "rgba(60,70,90,0.55)", 1);
        // 毛（根元は毛の色）
        bristlePath();
        g.fillStyle = "#f3e2b8"; g.fill();
        strokes([[B(40.5, -3), B(46, -4.5)], [B(40.5, 3), B(46, 4.5)]], "rgba(120,90,40,0.45)", 1);
        // 毛先にたっぷり付いた絵の具（青緑。下のふちは波形）
        const a0 = B(46.07, -11.27), a1 = B(51.75, -11.97), a2 = B(59.1, -7.7), tp = B(64, 0);
        const a3 = B(59.1, 7.7), a4 = B(51.75, 11.97), a5 = B(46.07, 11.27), w1 = B(49.5, 5), w2 = B(45.5, 0.5), w3 = B(49.5, -5);
        g.beginPath(); g.moveTo(a0.x, a0.y);
        g.bezierCurveTo(a1.x, a1.y, a2.x, a2.y, tp.x, tp.y);
        g.bezierCurveTo(a3.x, a3.y, a4.x, a4.y, a5.x, a5.y);
        g.lineTo(w1.x, w1.y); g.lineTo(w2.x, w2.y); g.lineTo(w3.x, w3.y); g.closePath();
        g.fillStyle = BRUSH_PAINT; g.fill();
        const hl = B(54, -5);
        g.beginPath(); g.ellipse(hl.x, hl.y, 2.2 * k, 5 * k, Math.atan2(py, px), 0, Math.PI * 2);
        g.fillStyle = "rgba(255,255,255,0.55)"; g.fill();
        // 毛の輪郭
        bristlePath();
        g.strokeStyle = COLORS.outline; g.lineWidth = Math.max(0.35, k); g.stroke();
      } };
      // 看板の柱（屋根に立てた2本。看板そのものは drawModel が、いつもこちらを向けて描く）
      const PA0 = SIGN_A - POST_DX * HZ, PA1 = SIGN_A + POST_DX * HZ;   // 柱の位置（絵の柱の間隔をマスに直す）
      const posts = { at: W(SIGN_A, SIGN_B, (roofH(SIGN_B) + SIGN_Z) / 2), anchor: roofTop, draw: function (R) {
        if (signShow.has(b) && signShow.get(b) <= 0.01) return;   // 看板を隠している間は、柱も出さない
        R.lines([[Rf(PA0, SIGN_B), W(PA0, SIGN_B, SIGN_Z)], [Rf(PA1, SIGN_B), W(PA1, SIGN_B, SIGN_Z)]], shade(roof, -0.45), 3);
      } };

      // ---- 輪郭を決める点（本体と、屋根から突き出た絵筆を分ける。1つにまとめると、絵筆の横の空まで建物になる） ----
      const body = [W(A0, B0, 0), W(A1, B0, 0), W(A1, B1, 0), W(A0, B1, 0)];
      [[EA0, EB0], [EA1, EB0], [EA1, EB1], [EA0, EB1]].forEach(function (p) { body.push(Rf(p[0], p[1]), Rf(p[0], p[1], -FASCIA)); });
      body.push(W(PA0, SIGN_B, SIGN_Z), W(PA1, SIGN_B, SIGN_Z));
      const brushHull = [];
      [[0, 4], [30, 7], [45, 15], [58, 12], [66, 3]].forEach(function (s) {   // 柄の向きにそった点と、そのまわりの太さ
        const o = axisAt(s[0]), r = s[1] * BU;
        brushHull.push([o[0] + r, o[1], o[2]], [o[0] - r, o[1], o[2]], [o[0], o[1] + r, o[2]], [o[0], o[1] - r, o[2]]);
      });

      return {
        faces: [wallS, wallE, wallN, wallW].concat(fascia, [roofTop]),
        attach: [brush, posts],
        sign: W(SIGN_A, SIGN_B, SIGN_Z),
        hull: [body, brushHull]
      };
    }

    return { build: build };
  })();

  // 主人公（背中ごし）。体の関節を地図の位置に直してから、遠近法で写す
  function followPlayer(now) {
    const c = fcam, p = player, k = C.player.scale;
    const base = project(p.x, p.y, 0);
    if (base.z < 0.8) return;
    const hx = Math.cos(p.heading), hy = Math.sin(p.heading);       // 前の向き
    const rx = -hy, ry = hx;                                        // 右の向き
    const u = k / ART_PX;                                           // 体のpx → マス
    const P = function (A, B, z) {
      return project(p.x + (A * hx + B * rx) * u, p.y + (A * hy + B * ry) * u, z * u);
    };
    const pose = playerPose(p, now);

    // 影
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    const s1 = groundEllipse(p.x, p.y, 13 * u);
    if (s1) { ctx.beginPath(); ctx.ellipse(s1.x, s1.y, s1.rx, s1.ry, 0, 0, Math.PI * 2); ctx.fill(); }
    const hipG = P(pose.hip.A, pose.hip.B, 0);
    if (p.off > 0.05) {
      const s2 = groundEllipse(p.x + (pose.hip.A * hx + pose.hip.B * rx) * u, p.y + (pose.hip.A * hy + pose.hip.B * ry) * u, 8 * u);
      if (s2) { ctx.beginPath(); ctx.ellipse(s2.x, s2.y, s2.rx, s2.ry, 0, 0, Math.PI * 2); ctx.fill(); }
    }

    // 板の横に立っていて、体のほうが奥にあるときだけ、体を先に描く
    Art.figure(ctx, p, pose, P, u * c.f / base.z, p.off > 0.5 && hipG.z > base.z);
  }

  // 主人公が入る四角（画面上）。手前の物が主人公を隠しているかの判定に使う
  function playerBox() {
    const p = player, c = fcam;
    const foot = project(p.x, p.y, 0), head = project(p.x, p.y, 1.5);
    const w = 0.4 * c.f / Math.max(foot.z, 0.5);
    return { x0: foot.x - w, x1: foot.x + w, y0: head.y, y1: foot.y, z: foot.z };
  }

  // 行き先の目印：入口に立つ光の柱と、その上で弾む矢印。画面の外にあるときは、画面の端に向きの矢印
  function followGoalMark(now) {
    const g = state.goal;
    if (!g || !isMoving()) return;
    const c = fcam;
    const q0 = project(g.x + 0.5, g.y + 0.5, 0), q1 = project(g.x + 0.5, g.y + 0.5, 3.4);
    const col = state.dest ? state.dest.roofColor : "#ffd84a";
    if (q0.z > NEAR * 3 && q0.x > 16 && q0.x < viewW - 16) {
      // 主人公が近づいたら消す（建物が見えているので。光の柱が主人公に重なって白くなるのも防ぐ）
      const a = clamp((Math.hypot(g.x + 0.5 - player.x, g.y + 0.5 - player.y) - 1.5) / 2, 0, 1);
      if (a <= 0) return;
      const w = clamp(0.22 * c.f / q0.z, 2.5, 30);
      const gr = ctx.createLinearGradient(0, q0.y, 0, q1.y);
      gr.addColorStop(0, "rgba(255,255,255," + (0.75 * a).toFixed(3) + ")");
      gr.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gr;
      ctx.fillRect(q0.x - w, q1.y, w * 2, q0.y - q1.y);
      // 矢印（遠くても見える大きさを保つ）
      const s = clamp(0.38 * c.f / q0.z, 9, 26);
      const y = Math.max(s * 0.8 + 6, q1.y - s * 0.4 - Math.abs(Math.sin(now * 4)) * s * 0.5);   // 画面の上へ切れないようにする
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.moveTo(q0.x, y + s); ctx.lineTo(q0.x - s * 0.8, y); ctx.lineTo(q0.x - s * 0.3, y);
      ctx.lineTo(q0.x - s * 0.3, y - s * 0.8); ctx.lineTo(q0.x + s * 0.3, y - s * 0.8); ctx.lineTo(q0.x + s * 0.3, y);
      ctx.lineTo(q0.x + s * 0.8, y);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.lineJoin = "miter";
      ctx.globalAlpha = 1;
      return;
    }
    // 画面の外：左右どちらにあるかを、端の矢印で知らせる
    const dx = g.x + 0.5 - c.ex, dy = g.y + 0.5 - c.ey;
    const side = dx * c.rx + dy * c.ry >= 0 ? 1 : -1;
    const x = side > 0 ? viewW - 22 : 22, y = viewH * 0.42, s = 13 + Math.sin(now * 5) * 2;
    ctx.beginPath();
    ctx.moveTo(x + side * s, y); ctx.lineTo(x - side * s * 0.6, y - s); ctx.lineTo(x - side * s * 0.6, y + s);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.lineJoin = "miter";
    // どの建物へ向かっているかを、矢印の横に名前で出す
    if (state.dest) {
      ctx.font = "bold 13px " + FONT;
      const name = state.dest.name, tw = ctx.measureText(name).width + 18;
      const lx = side > 0 ? x - 20 - tw : x + 20;
      roundRectPath(ctx, lx, y - 13, tw, 26, 13);
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#2a2c3a";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(name, lx + 9, y + 1);
      ctx.textBaseline = "alphabetic";
    }
  }

  // 半透明の具合を、物ごとに覚えておく（急に消えたり出たりしないよう、少しずつ変える）
  const fadeNow = new Map();
  let fadeTime = 0;

  // 奥の建物の看板（＋準備中の小札）が、手前の建物の絵（輪郭・看板・小札）にどれだけ隠れているかを調べ、
  // 3分の1以上隠れていたら、その看板を出さない（signShow を少しずつ 0 へ。隠れなくなったら 1 へ戻す）。
  // 建物が一列に並ぶ道で、隠れた看板の切れはし（「準」の字だけ など）がすき間から見えるのを防ぐ。
  // 絵の決まっていない「箱の建物」は、看板の描き方が別なので対象外（いつも出す）
  const SIGN_HIDE_PART = 1 / 3;
  function followSignShow(items, step) {
    const bs = items.filter(function (it) { return it.b; });
    BUILDINGS.forEach(function (b) {                    // 画面の外の建物は、覚えている値を消す（次に見えたときは、すぐ正しい状態で出す）
      if (!bs.some(function (it) { return it.b === b; })) signShow.delete(b);
    });
    const shapes = new Map();
    const shapeOf = function (b) { if (!shapes.has(b)) shapes.set(b, buildingHitShape(b)); return shapes.get(b); };
    const hitIn = function (h, q) {                     // buildingHitIso と同じ判定（形は1コマに1回だけ作る）
      const g = h.sign, t = h.tag;
      return insidePoly(q, h.body) || (q.x > g.x0 && q.x < g.x1 && q.y > g.y0 && q.y < g.y1) ||
        (t !== null && q.x > t.x0 && q.x < t.x1 && q.y > t.y0 && q.y < t.y1);
    };
    bs.forEach(function (it) {
      const b = it.b, bb = it.bb;
      let want = 1;
      if (BUILDING_ART[b.art] && (!bb.m || bb.sign)) {
        // 看板の中の6点と、小札の中の2点（斜め画面の座標。立体の建物は、画面上の位置）
        const h = bb.m ? bb : shapeOf(b), g = h.sign, pts = [];
        [0.15, 0.5, 0.85].forEach(function (fx) {
          [0.3, 0.7].forEach(function (fy) { pts.push({ x: lerp(g.x0, g.x1, fx), y: lerp(g.y0, g.y1, fy) }); });
        });
        if (h.tag) [0.25, 0.75].forEach(function (fx) { pts.push({ x: lerp(h.tag.x0, h.tag.x1, fx), y: lerp(h.tag.y0, h.tag.y1, 0.7) }); });
        // 手前にある建物（いま見えている物だけ。薄くし始めた建物は、奥が透けて見えるので、隠す側に数えない）
        const near = bs.filter(function (n) {
          return n !== it && n.z < it.z && (fadeNow.has(n.key) ? fadeNow.get(n.key) : 1) > 0.85;
        });
        let hid = 0;
        pts.forEach(function (p) {
          const sx = bb.m ? p.x : bb.x + (p.x - bb.cx) * bb.s, sy = bb.m ? p.y : bb.y + (p.y - bb.cy) * bb.s;   // 画面の位置
          if (near.some(function (n) {
            if (n.bb.m) return modelHit(n.bb, sx, sy);  // 手前が立体の建物：画面上の輪郭で調べる
            return hitIn(shapeOf(n.b), { x: (sx - n.bb.x) / n.bb.s + n.bb.cx, y: (sy - n.bb.y) / n.bb.s + n.bb.cy });
          })) hid++;
        });
        // 出す・消すが細かく入れ替わらないよう、いま消している看板は、隠れている点が1つ少なくなるまで消したままにする
        const cut = Math.ceil(pts.length * SIGN_HIDE_PART), shownNow = !signShow.has(b) || signShow.get(b) >= 0.5;
        if (near.length && hid >= (shownNow ? cut : cut - 1)) want = 0;
      }
      let a = signShow.has(b) ? signShow.get(b) : want;
      a = a < want ? Math.min(want, a + step) : Math.max(want, a - step);
      signShow.set(b, a);
    });
  }

  // 立体の建物どうしの前後を、土台の四角が離れている向きで決め直す（list＝奥から並べた物。並びをその場で直す）。
  // 中心の奥行きで並べると、同じ列に並ぶ建物（EA通りの3棟など）を列の向きから見た時に奥行きがほぼ同じになり、
  // 向きのわずかな差で前後が入れ替わる（奥の酒場が、手前のギルドの塔にかぶる）。
  // 土台どうしは重ならないので、離れている軸で、カメラのいる側の建物を手前にする。
  // 2つの軸の答えが食い違う時と、カメラが2棟の間にいる時は、画面で重ならないので、今の並びのままにする
  function modelOrderFix(list, ex, ey) {
    // 1つの軸で比べる：a が手前なら 1、b が手前なら -1、決まらなければ 0（a0〜a1・b0〜b1＝土台の範囲、e＝カメラ）
    const side = function (a0, a1, b0, b1, e) {
      if (a1 <= b0) return e <= a1 ? 1 : (e >= b0 ? -1 : 0);
      if (b1 <= a0) return e >= a0 ? 1 : (e <= b1 ? -1 : 0);
      return 0;
    };
    const nearer = function (a, b) {
      const sx = side(a.x, a.x + a.size, b.x, b.x + b.size, ex), sy = side(a.y, a.y + a.size, b.y, b.y + b.size, ey);
      return (sx && sy && sx !== sy) ? 0 : (sx || sy);
    };
    // 先に描く物（奥）が手前の建物なら、後の建物をその前へ移す（入れ替えが止まるまで。回数には上限）
    for (let n = 0; n < list.length * list.length; n++) {
      let moved = false;
      for (let i = 0; i < list.length && !moved; i++) {
        const a = list[i];
        if (!a.b || !a.bb.m) continue;
        for (let j = i + 1; j < list.length; j++) {
          const q = list[j];
          if (q.b && q.bb.m && nearer(a.b, q.b) > 0) { list.splice(j, 1); list.splice(i, 0, q); moved = true; break; }
        }
      }
      if (!moved) break;
    }
  }

  function renderFollow(now) {
    followFrame();
    const c = fcam;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    followSky();
    followGround(now);

    // 高さのある物（建物・木）と主人公を集めて、奥から順に描く
    // 主人公より手前か奥かは、木は奥行きで、建物は「カメラから主人公への線が、建物の土台を横切るか」で決める
    // （建物は大きいので、中心の奥行きだけで比べると、横を通るときに前後が入れ替わってしまう）
    const pb = playerBox(), p = player;
    const back = [], front = [];
    BUILDINGS.forEach(function (b) {
      const bb = followBox(b);
      if (!bb || bb.x1 < 0 || bb.x0 > viewW || bb.y0 > viewH) return;
      const inFront = rayRectEnter(c.ex, c.ey, p.x - c.ex, p.y - c.ey, b.x, b.y, b.x + b.size, b.y + b.size) < 1;
      (inFront ? front : back).push({ b: b, key: b, bb: bb, z: bb.z, front: inFront });
    });
    TREES.forEach(function (t) {
      const bb = treeBillboard(t);
      if (!bb || bb.x1 < 0 || bb.x0 > viewW || bb.y0 > viewH) return;
      const inFront = bb.z < pb.z - 0.05;
      (inFront ? front : back).push({ t: t, key: t, bb: bb, z: bb.z, front: inFront });
    });
    const farFirst = function (a, b) { return b.z - a.z; };
    back.sort(farFirst);
    front.sort(farFirst);
    modelOrderFix(back, c.ex, c.ey);                    // 立体の建物どうしは、土台の離れている向きで前後を決め直す
    modelOrderFix(front, c.ex, c.ey);
    const items = back.concat([{ player: true }], front);
    if (animals.length) addAnimalsFollow(items, pb.z);  // 動物を、奥から順の並びに入れる

    // 主人公の体の3点（足元・腰・頭）。手前の建物の絵が、この点に重なっているかを調べる
    const body = [project(p.x, p.y, 0.1), project(p.x, p.y, 0.75), project(p.x, p.y, 1.35)];

    // 到着の構図のとき、行き先の建物の絵（まん中あたり）。手前の木がここに重なったら、木も半透明にする
    let destBox = null;
    if (c.arrB && c.arr > 0.3) {
      const d = followBox(c.arrB);
      if (d) {
        const mx = (d.x1 - d.x0) * 0.2, my = (d.y1 - d.y0) * 0.15;
        destBox = { x0: d.x0 + mx, x1: d.x1 - mx, y0: d.y0 + my, y1: d.y1 - my, z: d.z };
      }
    }

    const step = clamp(now - fadeTime, 0, 0.1) * 6;     // 1回に変える量（約0.15秒で切り替わる）
    fadeTime = now;
    followSignShow(items, step);                        // 手前の建物にほとんど隠れた、奥の建物の看板を出さない
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.player) { followPlayer(now); continue; }
      if (it.animal) { drawAnimalFollow(it, now); continue; }
      // 主人公より手前にあって、主人公に重なる物は、半透明にする。カメラのすぐ前の物も薄くする
      const bb = it.bb;
      let covers = false, hide = false;
      if (it.front && it.b) {
        covers = body.some(function (q) {
          if (bb.m) return modelHit(bb, q.x, q.y, true);   // 立体の建物：画面上の本体の輪郭で調べる
          return buildingHitIso(it.b, { x: (q.x - bb.x) / bb.s + bb.cx, y: (q.y - bb.y) / bb.s + bb.cy });
        });
      } else if (it.front) {
        const m = (bb.x1 - bb.x0) * 0.15;               // 絵のまわりの余白の分、少し内側で判定する
        covers = bb.x0 + m < pb.x1 && bb.x1 - m > pb.x0 && bb.y0 < pb.y1 && bb.y1 > pb.y0;
      }
      if (!covers && it.t && destBox && it.z < destBox.z) {
        const m = (bb.x1 - bb.x0) * 0.15;
        hide = bb.x0 + m < destBox.x1 && bb.x1 - m > destBox.x0 && bb.y0 < destBox.y1 && bb.y1 > destBox.y0;   // 行き先の建物に重なる木は、消す
      }
      const want = hide ? 0 : Math.min(covers ? 0.3 : 1, nearFade(it, bb));
      let a = fadeNow.has(it.key) ? fadeNow.get(it.key) : want;
      a = a < want ? Math.min(want, a + step) : Math.max(want, a - step);
      fadeNow.set(it.key, a);
      if (a <= 0.01) continue;
      if (a >= 0.99) paintBillboard(ctx, it, now);
      else drawGhost(a, bb, function (g) { paintBillboard(g, it, now); });
    }

    followGoalMark(now);
  }

  // 背中ごしの画面の点 (px,py) にある建物（無ければ null）。重なっていたら手前の建物
  function buildingAtFollow(px, py) {
    followFrame();
    let hit = null, hz = Infinity;
    BUILDINGS.forEach(function (b) {
      const bb = followBox(b);
      if (!bb || bb.z >= hz || nearFade({ b: b }, bb) < 0.5) return;   // 近すぎて消えている建物は、押しても当たらない
      if (bb.m) { if (modelHit(bb, px, py)) { hit = b; hz = bb.z; } return; }   // 立体の建物：画面上の輪郭で調べる
      const q = { x: (px - bb.x) / bb.s + bb.cx, y: (py - bb.y) / bb.s + bb.cy };   // 絵の中の位置に戻す
      if (buildingHitIso(b, q)) { hit = b; hz = bb.z; }
    });
    return hit;
  }

  // 背中ごしの画面の点 (px,py) にある、地面の位置（地図のマス）。空や、遠すぎる所は null
  function groundAtFollow(px, py) {
    followFrame();
    const c = fcam;
    const xs = (px - c.cx) / c.f, ys = -(py - c.cy) / c.f;
    const dx = c.rx * xs + c.ux * ys + c.fx, dy = c.ry * xs + c.uy * ys + c.fy, dz = c.uz * ys + c.fz;
    if (dz > -0.0001) return null;                      // 水平線より上
    const t = -c.ez / dz;
    if (t > 60) return null;
    return { x: c.ex + dx * t, y: c.ey + dy * t };
  }

  function render() {
    if (camMode !== "follow" && signShow.size) signShow.clear();   // 斜め見下ろしでは、看板をいつもそのまま出す
    if (state.screen === "overview") renderOverview(state.time);
    else if (camMode === "follow") renderFollow(state.time);
    else renderField(state.time);
  }

  // ------------------------------------------------------------
  // 8. 画面の部品（メッセージ窓・ログ・ボタン）
  // ------------------------------------------------------------
  const el = function (id) { return document.getElementById(id); };
  const ui = {
    dialog: el("dialog"), dialogText: el("dialogText"), btnYes: el("btnYes"), btnNo: el("btnNo"),
    log: el("log"), btnMap: el("btnMap"), btnSound: el("btnSound"), hint: el("hint"),
    fade: el("fade"), siteName: el("siteName"), broken: el("broken"),
    inside: el("inside"), insideBody: el("insideBody"), insideName: el("insideName"), btnExit: el("btnExit")
  };

  // 「はい／いいえ」を聞く窓
  let dialogYes = null, dialogNo = null;
  function ask(text, onYes, onNo) {
    ui.dialogText.textContent = text;
    ui.btnYes.textContent = "はい";                     // 知らせる窓（tell）で変えた文字・ボタンを元に戻す
    ui.btnNo.hidden = false;
    dialogYes = onYes;
    dialogNo = onNo;
    ui.dialog.hidden = false;
    ui.btnYes.focus({ preventScroll: true });
  }
  // 知らせるだけの窓（ボタンは「閉じる」1つ。Esc でも閉じる）
  function tell(text, onClose) {
    ui.dialogText.textContent = text;
    ui.btnYes.textContent = "閉じる";
    ui.btnNo.hidden = true;
    dialogYes = onClose;
    dialogNo = onClose;
    ui.dialog.hidden = false;
    ui.btnYes.focus({ preventScroll: true });
  }
  function isAsking() { return !ui.dialog.hidden; }
  function closeDialog() {
    ui.dialog.hidden = true;
    dialogYes = null;
    dialogNo = null;
  }
  function answer(yes) {
    const f = yes ? dialogYes : dialogNo;
    closeDialog();
    if (f) f();
  }

  // メッセージログ（新しい3行だけ残す）
  const logLines = [];
  function addLog(text) {
    logLines.push(text);
    while (logLines.length > 3) logLines.shift();
    ui.log.textContent = "";
    logLines.forEach(function (line, i) {
      const p = document.createElement("p");
      p.textContent = line;
      if (i < logLines.length - 1) p.className = "old";
      ui.log.appendChild(p);
    });
  }

  // 初回の操作説明（1回見たら、次からは出さない）
  const HINT_KEY = "portal_hint_seen";
  function showHintIfFirst() {
    let seen = false;
    try { seen = localStorage.getItem(HINT_KEY) === "1"; } catch (e) { /* 保存が使えない環境では毎回出す */ }
    if (!seen) ui.hint.hidden = false;
  }
  function hideHint() {
    if (ui.hint.hidden) return;
    ui.hint.hidden = true;
    try { localStorage.setItem(HINT_KEY, "1"); } catch (e) { /* 保存できなくても動きは変わらない */ }
  }

  // ♪ボタンの見た目を、いまの音の入／切に合わせる
  const SOUND_KEY = "portal_sound";
  function showSoundState() {
    ui.btnSound.setAttribute("aria-pressed", Sound.on ? "true" : "false");
    ui.btnSound.title = Sound.on ? "効果音：入" : "効果音：切";
  }

  // ------------------------------------------------------------
  // 9. 流れ（選ぶ → 向かう → 着く → 入る）
  // ------------------------------------------------------------

  let lookHintShown = false;                            // 見回し方の案内を、もう出したか

  // 画面を切り替える
  function showScreen(name) {
    const changed = state.screen !== name;
    state.screen = name;
    ui.btnMap.hidden = name !== "field";               // 「全体マップ」ボタンは移動画面だけ
    canvas.classList.toggle("is-field", name === "field");   // 移動画面では、指でなぞって画面を動かせる（style.css）
    canvas.style.cursor = name === "field" ? "grab" : "default";
    if (name === "field" && changed) { cam.x = player.x; cam.y = player.y; cam.free = false; resetFollowCamera(); }
    if (name === "field" && camMode === "follow" && !lookHintShown) {   // 背中ごし：見回し方を、最初の1回だけ知らせる
      lookHintShown = true;
      addLog("左右になぞる（または ← → キー）と、まわりを見回せます");
    }
  }

  // ページを下へ動かしていたら、ゲームの画面が全部見える位置へ戻す
  function alignStage() {
    const top = el("stage").getBoundingClientRect().top;
    if (Math.abs(top) > 2) window.scrollTo(0, window.scrollY + top);
  }

  // 全体マップで建物を選んだ
  function chooseBuilding(b) {
    hideHint();
    alignStage();
    state.selected = b;
    ask(b.name + "へ向かいますか？",
      function () { state.selected = null; goTo(b); },
      function () { state.selected = null; });
  }

  // 建物へ向かう（全体マップからなら画面2へ切り替えて、移動開始）
  function goTo(b) {
    Sound.unlock();                                     // 押したこの時から、音が出せる
    const from = playerTile();
    const e = entranceOf(b);
    const tiles = findPath(from.x, from.y, e.x, e.y);
    const fromMap = state.screen !== "field";           // 全体マップから来た
    showScreen("field");
    cam.free = false;                                   // 画面を手で動かしていても、主人公を追いかけ直す
    if (!tiles) {
      addLog(b.name + "への道が見つかりません");
      return;
    }
    const sameGoal = state.dest === b && isMoving();    // 同じ行き先を続けて押した
    state.dest = b;
    state.goal = e;
    if (tiles.length === 1 && player.mode === "idle") { // もう入口の前に立っている
      askEnter(b);
      return;
    }
    if (!sameGoal) addLog(b.name + "へ向かっています");
    startTrip(tiles, function () { arrive(b); });
    // 背中ごし：全体マップから出発するときは、進む向きの少し横から始めて、背中の後ろへ回り込む
    if (fromMap && player.route && player.route.total > 0.01) startFollowCamera(routeAt(player.route, 0).ang);
  }

  // 道や草原のマスへ向かう（移動画面で地面を押したとき）
  function goToTile(tx, ty) {
    if (!isWalkable(tx, ty)) return;                    // 木・池・地図の外は、何もしない
    for (let i = 0; i < BUILDINGS.length; i++) {        // 入口の前のマスなら、その建物へ向かう扱いにする
      const e = entranceOf(BUILDINGS[i]);
      if (e.x === tx && e.y === ty) { goTo(BUILDINGS[i]); return; }
    }
    Sound.unlock();
    const from = playerTile();
    const tiles = findPath(from.x, from.y, tx, ty);
    if (!tiles) return;
    cam.free = false;
    state.dest = null;
    state.goal = { x: tx, y: ty };
    startTrip(tiles, null);
  }

  // 移動画面で押した場所へ向かう（建物なら入口へ、道や草原ならそのマスへ）
  function tapField(px, py) {
    if (camMode === "follow") {                         // 背中ごし：見えている建物か、地面の場所
      const fb = buildingAtFollow(px, py);
      const g = fb ? null : groundAtFollow(px, py);
      const ok = fb || (g && isWalkable(Math.floor(g.x), Math.floor(g.y)));
      if (!ok) { if (g) addLog("そこへは行けません（木・池・地図の外）"); return; }
      keepLookAsYaw();                                  // いま見ている向きから、背中の後ろへ回り込む
      if (fb) goTo(fb); else goToTile(Math.floor(g.x), Math.floor(g.y));
      return;
    }
    const q = fieldToIso(px, py);
    const b = buildingAtIso(q);
    if (b) { goTo(b); return; }
    const w = isoToWorld(q);
    goToTile(Math.floor(w.x), Math.floor(w.y));
  }

  // 入口に着いた
  function arrive(b) {
    cam.free = false;
    addLog(b.name + "に到着しました");
    askEnter(b);
  }

  // 「入りますか？」を聞く
  function askEnter(b) {
    if (isPending(b)) {                                 // 準備中（url が無い）：知らせるだけで、中には入らない
      addLog(b.name + "は、ただいま準備中です（まだ入れません）");
      tell(b.name + "は、ただいま準備中です", null);
      return;
    }
    ask(b.name + "に入りますか？",
      function () { enter(b); },
      function () { addLog(b.name + "の前にいます。行き先は、建物を押すか「全体マップ」で選べます"); });
  }

  // 建物に入る（暗転してから、建物の中＝リンク先のサイトを表示する）
  function enter(b) {
    if (isPending(b)) { askEnter(b); return; }          // 準備中の建物には入らない（入り方が "move" でも、ページを移らない）
    const mode = b.open || C.enterMode || "inside";     // 入り方（config.js の enterMode。建物ごとの open が優先）
    if (mode === "newtab") {                            // 新しいタブで開く（ポータルはこのタブに、そのまま残る）
      // 「はい」を押したその場で開く（時間をおいてから開くと、ブラウザに止められるため）。暗転もしない
      const w = window.open(b.url, "_blank");
      if (w) {
        try { w.opener = null; } catch (e) { /* 開いたページから、このページを操作させないため。できなくても開くのは同じ */ }
        addLog(b.name + "を新しいタブで開きました。このタブに戻れば、ここから続けられます");
        return;
      }
      // ブラウザに止められて開けなかったとき：下の流れで、同じタブで移る
    }
    state.leaving = true;
    addLog(b.name + "に入ります");
    stopBgm();
    ui.fade.classList.add("on");
    setTimeout(function () {
      if (mode === "move" || mode === "newtab") {       // 同じタブでサイトそのものへ移る（新しいタブを止められたときも）
        window.location.href = b.url;
        return;
      }
      openInside(b);                                    // このページの上に重ねて表示する
      state.leaving = false;
      ui.fade.classList.remove("on");
    }, 700);
  }

  // 建物の中を開く：リンク先のサイトを、このページの上に重ねて表示する
  function openInside(b) {
    state.inside = b;
    ui.insideName.textContent = b.name;
    const frame = document.createElement("iframe");     // 毎回新しく作る（ブラウザの「戻る」の履歴を増やさないため）
    frame.className = "inside-frame";
    frame.title = b.name;
    frame.setAttribute("allow", "autoplay; clipboard-write; geolocation; fullscreen");   // 音・コピー・現在地・全画面を、中のサイトでも使えるようにする
    frame.src = b.url;
    ui.insideBody.appendChild(frame);
    ui.inside.hidden = false;
    document.documentElement.style.overflow = "hidden"; // 後ろのページが動かないようにする
    // ブラウザやスマホの「戻る」でも外に出られるよう、履歴に印を1つ足す
    try {
      if (!(history.state && history.state.portalInside)) history.pushState({ portalInside: true }, "");
    } catch (e) { /* 履歴が使えなくても、「外に戻る」ボタンで出られる */ }
    ui.btnExit.focus({ preventScroll: true });
  }

  // 建物の外に出る。byBack＝ブラウザの「戻る」で出たとき
  function exitInside(byBack) {
    const b = state.inside;
    if (!b || state.leaving) return;
    state.leaving = true;
    ui.fade.classList.add("on");
    setTimeout(function () {
      const frame = ui.insideBody.querySelector("iframe");
      if (frame) frame.remove();                        // サイトを閉じる（中で鳴っていた音も止まる）
      ui.inside.hidden = true;
      document.documentElement.style.overflow = "";
      state.inside = null;
      state.leaving = false;
      ui.fade.classList.remove("on");
      addLog(b.name + "から出ました");
      playBgm();
      // ボタンで出たときは、入るときに履歴へ足した印を消しておく
      if (!byBack) {
        try { if (history.state && history.state.portalInside) history.back(); } catch (e) { /* 消せなくても動きは変わらない */ }
      }
    }, 450);
  }

  // 「全体マップ」ボタン：いつでも画面1へ戻る
  function backToMap() {
    cancelTrip();
    closeDialog();
    state.dest = null;
    state.goal = null;
    state.selected = null;
    showScreen("overview");
    addLog("行きたい建物を選んでください");
  }

  // ---- 操作 ----

  function pointOf(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  // なぞる操作の記録。moved＝押したまま大きく動かした（マウス6px・指10pxより大きい＝画面を動かす操作になった）
  const drag = { on: false, moved: false, id: -1, x0: 0, y0: 0, x: 0, y: 0 };

  canvas.addEventListener("pointerdown", function (ev) {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;      // マウスは左ボタンだけ
    drag.on = true;
    drag.moved = false;
    drag.id = ev.pointerId;
    drag.x0 = drag.x = ev.clientX;
    drag.y0 = drag.y = ev.clientY;
  });

  canvas.addEventListener("pointermove", function (ev) {
    if (drag.on && ev.pointerType === "mouse" && ev.buttons === 0) drag.on = false;   // 画面の外でボタンを離していた
    if (drag.on && ev.pointerId === drag.id && state.screen === "field") {
      const slop = ev.pointerType === "mouse" ? 6 : 10; // 指は少しぶれるので、広めに「押した」と見なす
      if (!drag.moved && Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) > slop) {
        drag.moved = true;
        try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* 使えなくても動く */ }
      }
      if (drag.moved) {
        if (camMode === "follow") lookAround((drag.x - ev.clientX) * CAMC.dragTurn);   // 背中ごし：左右になぞると見回す
        else panCamera(drag.x - ev.clientX, drag.y - ev.clientY);   // 指やマウスに、地面がついてくる
        drag.x = ev.clientX;
        drag.y = ev.clientY;
        canvas.style.cursor = "grabbing";
        return;
      }
    }
    // パソコン：建物の上にマウスを置いたら、指の形にする
    const pt = pointOf(ev);
    if (state.screen === "overview") canvas.style.cursor = buildingAtPoint(pt.x, pt.y) ? "pointer" : "default";
    else if (camMode === "follow") canvas.style.cursor = buildingAtFollow(pt.x, pt.y) ? "pointer" : "grab";
    else canvas.style.cursor = buildingAtIso(fieldToIso(pt.x, pt.y)) ? "pointer" : "grab";
  });

  canvas.addEventListener("pointerup", function (ev) {
    if (ev.pointerId !== drag.id) return;
    drag.on = false;
    if (state.screen === "field") canvas.style.cursor = "grab";
  });
  canvas.addEventListener("pointercancel", function (ev) {
    if (ev.pointerId !== drag.id) return;
    drag.on = false;
    drag.moved = false;
  });

  // 押した（なぞらずに離した）
  canvas.addEventListener("click", function (ev) {
    if (drag.moved) { drag.moved = false; return; }     // 画面を動かした直後は、押した扱いにしない
    if (state.leaving || isAsking()) return;
    const pt = pointOf(ev);
    if (state.screen === "overview") {
      const b = buildingAtPoint(pt.x, pt.y);
      if (b) chooseBuilding(b);
    } else {
      tapField(pt.x, pt.y);
    }
  });

  ui.btnYes.addEventListener("click", function () { answer(true); });
  ui.btnNo.addEventListener("click", function () { answer(false); });
  ui.btnMap.addEventListener("click", function () { if (!state.leaving) backToMap(); });
  ui.hint.addEventListener("click", hideHint);

  ui.btnSound.addEventListener("click", function () {
    const on = Sound.toggle();
    try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch (e) { /* 保存できなくても動く */ }
    showSoundState();
  });

  // キーボード：窓が出ている間は Esc＝いいえ。移動画面では、矢印キーで画面を動かす
  const PAN_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const PAN_SPEED = 560;                                // 矢印キーで画面が動く速さ（px／秒）
  const keysDown = {};                                  // 押している矢印キー
  window.addEventListener("keydown", function (ev) {
    if (state.inside) return;                           // 建物の中では、キーを横取りしない
    if (isAsking() && ev.key === "Escape") { answer(false); return; }
    if (state.screen === "field" && PAN_KEYS[ev.key] && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
      keysDown[ev.key] = true;
      ev.preventDefault();                              // ページ自体が上下に動くのを止める
    }
  });
  window.addEventListener("keyup", function (ev) { delete keysDown[ev.key]; });
  window.addEventListener("blur", function () {         // ほかの画面へ移ったら、押しっぱなしを解く
    Object.keys(keysDown).forEach(function (k) { delete keysDown[k]; });
  });

  function panByKeys(dt) {
    if (state.screen !== "field") return;
    let dx = 0, dy = 0;
    Object.keys(keysDown).forEach(function (k) { dx += PAN_KEYS[k][0]; dy += PAN_KEYS[k][1]; });
    if (camMode === "follow") {                         // 背中ごし：左右の矢印キーで見回す（上下は使わない）
      if (dx) lookAround(dx * CAMC.keyTurn * dt);
      return;
    }
    if (dx || dy) panCamera(dx * PAN_SPEED * dt, dy * PAN_SPEED * dt);
  }

  // 別のタブへ移ったら、滑走音を止める
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) Sound.setRoll(0, true);
  });

  // 建物の中：「外に戻る」ボタン、またはブラウザやスマホの「戻る」で外に出る
  ui.btnExit.addEventListener("click", function () { exitInside(false); });
  window.addEventListener("popstate", function () { if (state.inside) exitInside(true); });

  // （入り方が "move" のとき）リンク先からブラウザの「戻る」で帰ってきたら、暗転を消して続きから遊べるようにする
  window.addEventListener("pageshow", function () {
    state.leaving = false;
    ui.fade.classList.remove("on");
  });

  // ------------------------------------------------------------
  // 10. 起動
  // ------------------------------------------------------------
  function update(dt) {
    state.time += dt;
    updatePlayer(dt);
    updateAnimals(dt);                                  // 動物（animals.enabled が false なら何もしない）
    panByKeys(dt);
    updateCamera(dt);
  }

  let lastMs = 0;
  function frame(ms) {
    const dt = lastMs ? Math.min(0.05, (ms - lastMs) / 1000) : 0;   // 止まっていた後に飛ばないよう上限を付ける
    lastMs = ms;
    if (!state.inside) {                                // 建物の中にいる間は、後ろのゲームを止めておく（電池の節約）
      update(dt);
      render();
    }
    requestAnimationFrame(frame);
  }

  function start() {
    if (!ctx) throw new Error("このブラウザでは Canvas が使えません");
    document.title = C.siteName;
    ui.siteName.textContent = C.siteName;

    try { if (localStorage.getItem(SOUND_KEY) === "off") Sound.on = false; } catch (e) { /* 保存が使えない環境では「入」で始める */ }
    showSoundState();

    resize();
    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas.parentElement);
    window.addEventListener("resize", resize);

    const problems = checkConfig();
    problems.forEach(function (msg) { console.warn("設定の点検：" + msg); });
    addLog(problems.length ? "設定に問題があります：" + problems[0] : "行きたい建物を選んでください");

    showScreen("overview");
    showHintIfFirst();
    playBgm();
    requestAnimationFrame(frame);
    window.PORTAL_STARTED = true;                       // 始められた印（index.html が見る）
  }

  // 動作確認用の窓口（消しても、ゲームの動きには影響しません）
  window.PORTAL_DEBUG = {
    state: state, player: player, cam: cam, buildings: BUILDINGS, trees: TREES, sound: Sound,
    findPath: findPath, buildRoute: buildRoute, routeAt: routeAt, isWalkable: isWalkable,
    entranceOf: entranceOf, checkConfig: checkConfig,
    step: function (dt) { update(dt); render(); },              // 時間を手で進める
    pointOfBuilding: function (b) {                             // 全体マップで、建物の中心がある画面上の位置
      const L = overviewLayout(), r = canvas.getBoundingClientRect();
      return { x: r.left + L.ox + (b.x + b.size / 2) * L.s, y: r.top + L.oy + (b.y + b.size / 2) * L.s };
    },
    fieldPoint: function (wx, wy, h) {                          // 移動画面で、地図の位置（地面から高さ h）がある画面上の位置
      const v = fieldView(), q = iso(wx, wy), r = canvas.getBoundingClientRect();
      return { x: r.left + v.ox + q.x * v.z, y: r.top + v.oy + (q.y - (h || 0)) * v.z };
    },
    keysDown: keysDown,
    // ---- ここから下は、カメラ試作で足した物 ----
    camera: fcam,                                               // 背中ごしのカメラの状態（位置 ex,ey,ez／向き look・pitch／視野 f など）
    cameraConfig: CAMC,                                         // カメラの設定（config.js の camera に既定値を足した物）
    cameraMode: function () { return camMode; },                // いまのカメラ（"follow" か "iso"）
    setCameraMode: function (m) {                               // カメラを切り替える（試すとき用）
      camMode = m === "follow" ? "follow" : "iso";
      cam.x = player.x; cam.y = player.y; cam.free = false;
      resetFollowCamera();
      render();
      return camMode;
    },
    screenPoint: function (wx, wy, h) {                         // 移動画面で、地図の位置（地面から高さ h マス）がある画面上の位置。いまのカメラに合わせる
      const r = canvas.getBoundingClientRect();
      if (camMode !== "follow") {
        const v = fieldView(), q = iso(wx, wy);
        return { x: r.left + v.ox + q.x * v.z, y: r.top + v.oy + (q.y - (h || 0) * ART_PX) * v.z, depth: 1, visible: true };
      }
      followFrame();
      const q = project(wx, wy, h || 0);
      const ok = q.z > NEAR;
      return { x: r.left + q.x, y: r.top + q.y, depth: q.z, visible: ok && q.x >= 0 && q.x <= viewW && q.y >= 0 && q.y <= viewH };
    },
    groundAt: function (clientX, clientY) {                     // 画面上の位置にある、地図の位置（地面）。空なら null
      const r = canvas.getBoundingClientRect(), px = clientX - r.left, py = clientY - r.top;
      if (camMode === "follow") return groundAtFollow(px, py);
      return isoToWorld(fieldToIso(px, py));
    },
    buildingAtScreen: function (clientX, clientY) {             // 画面上の位置にある建物（移動画面。無ければ null）
      const r = canvas.getBoundingClientRect(), px = clientX - r.left, py = clientY - r.top;
      return camMode === "follow" ? buildingAtFollow(px, py) : buildingAtIso(fieldToIso(px, py));
    },
    buildingBox: function (b) {                                 // 背中ごしの画面で、建物の絵が入る四角（画面上の位置。見えない位置なら null）
      followFrame();
      const bb = followBox(b), r = canvas.getBoundingClientRect();
      if (!bb) return null;
      return { x0: r.left + bb.x0, y0: r.top + bb.y0, x1: r.left + bb.x1, y1: r.top + bb.y1, depth: bb.z };
    },
    lookAround: function (rad) { lookAround(rad); },            // 見回す（＋で右へ、－で左へ。ラジアン）
    animals: function () {                                      // 動物の一覧（種類・毛色・位置・高さ・状態・反応・向き）。向きは、いまのカメラから見た向き
      if (camMode === "follow") followFrame();
      const look = camMode === "follow" ? fcam.look : ISO_VIEW;
      return animals.map(function (a) {
        const f = animalFacing(a, camMode === "follow" ? Math.atan2(a.y - fcam.ey, a.x - fcam.ex) : look, false);   // 組み込みで変更：描く所と同じ決め方
        return { kind: a.kind, variant: a.variant, x: +a.x.toFixed(3), y: +a.y.toFixed(3), h: +a.h.toFixed(3), state: a.state, react: a.react || "", heading: +a.heading.toFixed(3), view: f.view, flip: f.flip,
                 air: !!a.air };                         // ★air＝空を飛んでいるか（技の確かめ用に足した）
      });
    },
    animalArt: ANIMAL_ART,                                      // 動物の絵の置き場（確かめ用）
    buildingAlpha: function (b) {                               // 背中ごしの画面で、建物をどれだけ見せているか（0＝近すぎて消している 〜 1。主人公を隠すときの半透明は含まない）
      followFrame();
      const bb = followBox(b);
      return bb ? nearFade({ b: b }, bb) : 0;
    },
    // ---- ここから下は、技（tricks）で足した物 ----
    tricksOn: function () { return TRK.on; },                  // 技が入っているか（config.js の tricks.enabled）
    trick: function () {                                        // いま出している技（種類・段階・進み具合・板の高さ）と、カーブ
      const p = player, tr = p.trick;
      let t = null, cv = null;
      if (tr) {
        const ph = trickPhase(tr), bd = trickBoard(tr), all = tr.Tc + tr.Ta + tr.Tl;
        t = { kind: tr.kind, phase: ph.name, phaseK: +ph.k.toFixed(3), progress: +clamp(tr.t / all, 0, 1).toFixed(3), t: +tr.t.toFixed(3),
              height: +trickAir(p).toFixed(3), H: +tr.H.toFixed(3), airTime: +tr.Ta.toFixed(3), pitch: +bd.pitch.toFixed(3), flip: +bd.flip.toFixed(3),
              target: tr.target ? tr.target.kind : "" };
      }
      if (p.carve) {
        const o = trickCarveAt(p.carve, p.dist);
        cv = { offset: +o.off.toFixed(3), O: +p.carve.O.toFixed(3), s0: +p.carve.s0.toFixed(2), s3: +p.carve.s3.toFixed(2), target: p.carve.target ? p.carve.target.kind : "" };
      }
      return { trick: t, carve: cv, inAir: trickInAir(p) };
    },
    trickStats: trickStats,                                     // 技の回数の記録（ollie・kickflip・carve・押しのけ など）と、最近の出来事
    placeAnimal: function (which, x, y, opt) {                  // 確かめ用：動物を (x,y) に置く。which＝一覧の番号か種類の名前。opt.hold＝false でなければ、その場から動かさない
      const o = opt || {};
      const a = typeof which === "number" ? animals[which] : animals.filter(function (q) { return q.kind === which; })[o.nth || 0];
      if (!a) return -1;
      a.x = x; a.y = y; a.tx = x; a.ty = y; a.h = 0; a.air = false; a.delay = -1; a.react = null; a.cool = 0;
      if (typeof o.heading === "number") a.heading = o.heading;
      animalSet(a, o.state || (a.kind === "sparrow" ? "peck" : "sit"), 99);
      a.hold = o.hold !== false && !o.goto;
      if (typeof o.cool === "number") a.cool = o.cool;          // opt.cool＝主人公に反応しない秒数
      if (o.goto) animalGo(a, { x: o.goto[0], y: o.goto[1] }, ANIMAL_KIND[a.kind].walk, a.kind === "sparrow" || a.kind === "rabbit" ? "hop" : "walk");   // opt.goto＝[x,y] へ歩かせる
      return animals.indexOf(a);
    },
    releaseAnimal: function (i) { if (animals[i]) { animals[i].hold = false; animals[i].st = 99; } }
  };

  // 始められなかったときは、index.html の最後の処理が案内を出す（下のリンク一覧は使える）
  try {
    start();
  } catch (err) {
    console.error(err);
  }
})();
