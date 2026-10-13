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

  // ---- テーマ別の建物の絵（移動画面） ----

  // 建物の絵の置き場。config.js の建物に  art: "uranai"  のように書くと、その絵で描く。
  // 1つの絵は、次の3つを持つ：
  //   draw(ctx, b, g, now) … 描く。b＝建物の設定、g＝土台の四隅 { Bk 奥, R 右, F 手前, L 左 }（地面の高さ・斜め画面のpx）、now＝秒
  //   signAt(g)            … 看板の中心の位置 { x, y }（draw の中で看板を出す場所と同じ）
  //   outline(g)           … 建物の輪郭をおおう多角形（点の並び）。押した場所の判定に使う
  const BUILDING_ART = Object.create(null);   // 元からの名前（constructor など）を持たない入れ物

  // 看板の丸い印。絵の名前 → 印の種類
  const SIGN_ICONS = Object.assign(Object.create(null), { uranai: "star", gohan: "meal", ea: "chart", gazou: "sparkle" });

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
      }
      ctx.lineCap = "butt"; ctx.lineJoin = "miter";
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 16px " + FONT;
    ctx.fillStyle = "#33283a";
    ctx.fillText(text, x + s.icon / 2 - 1, y + 1);
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

    const hipRide = deckTop + 21.5 * (1 - 0.3 * crouch);
    const hipStand = 22.6 + Math.sin(now * 2.2) * 0.3;  // 立っているときは、ゆっくり呼吸
    const hip = { A: hipA * (1 - off), B: BODY.side * ease(off) + lean * 2, z: lerp(hipRide, hipStand, off) };
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
      const J = {};
      Object.keys(pose).forEach(function (name) { J[name] = P(pose[name].A, pose[name].B, pose[name].z); });

      // 影
      const s1 = P(0, 0, 0), s2 = P(pose.hip.A, pose.hip.B, 0);
      ctx.fillStyle = "rgba(0,0,0,0.20)";
      ctx.beginPath(); ctx.ellipse(s1.x, s1.y, 13 * k, 6 * k, 0, 0, Math.PI * 2); ctx.fill();
      if (p.off > 0.05) { ctx.beginPath(); ctx.ellipse(s2.x, s2.y, 8 * k, 4 * k, 0, 0, Math.PI * 2); ctx.fill(); }

      // スケボー（板＋車輪）。向きに合わせて、斜め画面の傾きで描く
      const drawBoard = function () {
        const roll = p.lean * 1.3 * (1 - p.off);                    // 曲がるとき、板も少し傾く
        const zAt = function (A, B) {
          return BODY.deckZ - roll * (B / BODY.deckW) + (Math.abs(A) > BODY.deckLen - 3 ? 1.2 : 0);   // 先と後ろは少し反る
        };
        // 車輪
        ctx.fillStyle = "#f4efe2";
        ctx.strokeStyle = "#2a2a2a";
        ctx.lineWidth = 1.2 * k;
        [[8.5, 3.4], [8.5, -3.4], [-8.5, 3.4], [-8.5, -3.4]].forEach(function (w) {
          const q = P(w[0], w[1], 1.9);
          ctx.beginPath(); ctx.arc(q.x, q.y, 2.2 * k, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        });
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
        const pts = out.map(function (o) { return P(o[0], o[1], zAt(o[0], o[1])); });
        fillPoly(ctx, pts, C.player.boardColor);
        ctx.strokeStyle = "#2a2a2a"; ctx.lineWidth = 1.3 * k; ctx.stroke();
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

      // 板の横に立っていて、体のほうが奥にあるときだけ、体を先に描く
      if (p.off > 0.5 && rx + ry < 0) { drawBody(); drawBoard(); }
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
    onArrive: null         // 着いたときに呼ぶ処理
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

    // 進む
    p.dist = Math.min(p.route.total, p.dist + p.speed * dt);
    const q = routeAt(p.route, p.dist);
    if (Math.floor(q.x) !== Math.floor(p.x) || Math.floor(q.y) !== Math.floor(p.y)) Sound.clack();   // マスの境目で「カタッ」
    p.x = q.x;
    p.y = q.y;

    // 向きは道のりの向きを少し遅れて追いかける。その遅れ（＝曲がり具合）で体を傾ける
    const lag = p.route.total > 0.01 ? angDiff(q.ang, p.heading) : 0;
    p.heading += lag * (1 - Math.exp(-dt * 16));
    const leanTo = clamp(lag * 2.6, -1, 1) * clamp(p.speed / (p.vmax * 0.5), 0, 1);
    const rate = Math.abs(leanTo) > Math.abs(p.lean) ? 14 : 4.5;     // 傾くのは速く、戻るのはゆっくり
    p.lean += (leanTo - p.lean) * (1 - Math.exp(-dt * rate));

    Sound.setRoll(p.speed / (C.walkSpeed * C.skateMultiplier), tileAt(Math.floor(p.x), Math.floor(p.y)) === T.ROAD);

    // 着いた
    if (p.route.total - p.dist <= 0.002) {
      const end = p.route.pts[p.route.pts.length - 1];
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
    // 名前ラベル（いちばん上に描く）
    const fontPx = clamp(Math.round(s * 0.5), 11, 17);
    BUILDINGS.forEach(function (b) {
      Art.topLabel(ctx, b.name, L.ox + (b.x + b.size / 2) * s, L.oy + (b.y + b.size / 2) * s, fontPx, false);
    });
    Art.topLabel(ctx, "現在地", px, py + s * 0.95, clamp(Math.round(s * 0.42), 10, 14), true);
  }

  // 全体マップの上の点 (px,py) にある建物（無ければ null）。指で押しやすいよう、少し広めに取る
  function buildingAtPoint(px, py) {
    const L = overviewLayout(), s = L.s, m = s * 0.35;
    for (let i = 0; i < BUILDINGS.length; i++) {
      const b = BUILDINGS[i];
      const x0 = L.ox + b.x * s - m, y0 = L.oy + b.y * s - m, w = b.size * s + m * 2;
      if (px >= x0 && px <= x0 + w && py >= y0 && py <= y0 + w) return b;
    }
    return null;
  }

  // ---- 移動画面（斜め見下ろし） ----

  // カメラが見ている地図の位置。free＝手で画面を動かした後（主人公の追いかけを止めている間）
  const cam = { x: player.x, y: player.y, free: false };

  function updateCamera(dt) {
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
      const s = buildingShape(b);
      const art = BUILDING_ART[b.art];
      let body, onSign;
      if (art) {                                        // テーマ別の絵：その絵の外わくと、看板の四角
        const at = art.signAt(s), z = buildingSignSize(ctx, b);
        body = art.outline(s);
        onSign = Math.abs(q.x - at.x) < z.w / 2 + 1 && Math.abs(q.y - at.y) < z.h / 2 + 1;   // ＋1＝ふちの線の分
      } else {                                          // 箱の建物：壁と屋根をまとめた外わくと、てっぺんの看板
        body = [
          s.L, s.F, s.R, { x: s.R.x, y: s.R.y - BUILD.wallH }, s.rR, s.rB, s.rL, { x: s.L.x, y: s.L.y - BUILD.wallH }
        ];
        onSign = Math.abs(q.x - s.apex.x) < signHalfWidth(b) && q.y > s.apex.y - 32 && q.y < s.apex.y;
      }
      if (!insidePoly(q, body) && !onSign) return;
      if (!hit || b.x + b.y + b.size > hit.x + hit.y + hit.size) hit = b;
    });
    return hit;
  }

  // 高さのある物（木・建物）。奥から順に描くための並び順の値（key）を持たせる。
  // key＝その物の中心の「x＋y」。小さいほど奥。
  const SOLIDS = [];
  TREES.forEach(function (t) {
    SOLIDS.push({ key: t.x + t.y + 1, draw: function () { Art.isoTree(ctx, t.x, t.y); }, tree: t });
  });
  BUILDINGS.forEach(function (b) {
    SOLIDS.push({ key: b.x + b.y + b.size, draw: function (now) { Art.isoBuilding(ctx, b, now); } });
  });

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
      if (!it.tree) return true;
      const p = iso(it.tree.x, it.tree.y);
      return p.x > minX - 40 && p.x < maxX + 40 && p.y > minY && p.y < maxY + 80;
    });
    items.push({ key: player.x + player.y + 0.001, draw: function () { Art.isoPlayer(ctx, player, now); } });
    items.sort(function (a, b) { return a.key - b.key; });
    for (let i = 0; i < items.length; i++) items[i].draw(now);
  }

  function render() {
    if (state.screen === "overview") renderOverview(state.time);
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
    dialogYes = onYes;
    dialogNo = onNo;
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

  // 画面を切り替える
  function showScreen(name) {
    const changed = state.screen !== name;
    state.screen = name;
    ui.btnMap.hidden = name !== "field";               // 「全体マップ」ボタンは移動画面だけ
    canvas.classList.toggle("is-field", name === "field");   // 移動画面では、指でなぞって画面を動かせる（style.css）
    canvas.style.cursor = name === "field" ? "grab" : "default";
    if (name === "field" && changed) { cam.x = player.x; cam.y = player.y; cam.free = false; }
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
    ask(b.name + "に入りますか？",
      function () { enter(b); },
      function () { addLog(b.name + "の前にいます。行き先は、建物を押すか「全体マップ」で選べます"); });
  }

  // 建物に入る（暗転してから、建物の中＝リンク先のサイトを表示する）
  function enter(b) {
    const mode = b.open || C.enterMode || "inside";     // 入り方（config.js の enterMode。建物ごとの open が優先）
    state.leaving = true;
    addLog(b.name + "に入ります");
    stopBgm();
    ui.fade.classList.add("on");
    setTimeout(function () {
      if (mode === "move") {                            // 同じタブでサイトそのものへ移る
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
        panCamera(drag.x - ev.clientX, drag.y - ev.clientY);        // 指やマウスに、地面がついてくる
        drag.x = ev.clientX;
        drag.y = ev.clientY;
        canvas.style.cursor = "grabbing";
        return;
      }
    }
    // パソコン：建物の上にマウスを置いたら、指の形にする
    const pt = pointOf(ev);
    if (state.screen === "overview") canvas.style.cursor = buildingAtPoint(pt.x, pt.y) ? "pointer" : "default";
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
    keysDown: keysDown
  };

  // 始められなかったときは、index.html の最後の処理が案内を出す（下のリンク一覧は使える）
  try {
    start();
  } catch (err) {
    console.error(err);
  }
})();
