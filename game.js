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
    return Object.assign({ size: 3, door: "S", wallColor: "#eeeeee", roofColor: "#888888" }, b);
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

    // 建物（壁2面＋屋根＋看板）
    isoBuilding: function (ctx, b) {
      const shape = buildingShape(b);
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
      ctx.font = "bold 16px " + FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const w = ctx.measureText(text).width + 20, h = 26;
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
      const body = [                                    // 壁と屋根をまとめた外わく
        s.L, s.F, s.R, { x: s.R.x, y: s.R.y - BUILD.wallH }, s.rR, s.rB, s.rL, { x: s.L.x, y: s.L.y - BUILD.wallH }
      ];
      const onSign = Math.abs(q.x - s.apex.x) < 40 && q.y > s.apex.y - 32 && q.y < s.apex.y;   // 看板
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
    SOLIDS.push({ key: b.x + b.y + b.size, draw: function () { Art.isoBuilding(ctx, b); } });
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
    for (let i = 0; i < items.length; i++) items[i].draw();
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
