(function glass() {
  if (!(window.Spicetify && Spicetify.Player && Spicetify.Player.addEventListener)) {
    setTimeout(glass, 300);
    return;
  }

  /* ===== Shared helpers and state ===== */
  const currentItem = () => Spicetify.Player.data?.item || Spicetify.Player.data?.track;
  const toUrl = meta => {
    const img = meta?.image_xlarge_url || meta?.image_large_url || meta?.image_url;
    if (!img) return "";
    return img.startsWith("spotify:image:") ? "https://i.scdn.co/image/" + img.split(":")[2] : img;
  };
  const alphaOf = c => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return 0;
    const p = m[1].split(",");
    return p.length > 3 ? parseFloat(p[3]) : 1;
  };
  const brightness = c => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return 0;
    const [r, g, b] = m[1].split(",").map(Number);
    return (r + g + b) / 3;
  };
  const limiter = () => {
    const seen = new WeakMap();
    return el => {
      const n = (seen.get(el) || 0) + 1;
      seen.set(el, n);
      return n <= 3;
    };
  };

  let np = null, npCanvas = null, npCtx = null, lyricsBox = null;

  /* ===== Background: album art blurred once, animated on a tiny canvas ===== */
  const SRC = 96;
  const src = document.createElement("canvas");
  src.width = src.height = SRC;
  const sctx = src.getContext("2d");
  const bg = document.createElement("canvas");
  bg.id = "glass-bg";
  const bctx = bg.getContext("2d");
  let hasArt = false, artUrl = "";

  const sizeCanvas = c => {
    c.width = 160;
    c.height = Math.max(1, Math.round(160 * innerHeight / Math.max(1, innerWidth)));
  };
  sizeCanvas(bg);

  function drawLayer(ctx, c, angle, scale, tx, ty, mirror, alpha) {
    const s = 1.8 * c.width * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingQuality = "high";
    ctx.translate(c.width / 2 + tx, c.height / 2 + ty);
    if (mirror) ctx.scale(-1, 1);
    ctx.rotate(angle);
    ctx.drawImage(src, -s / 2, -s / 2, s, s);
    ctx.restore();
  }

  function drawBg() {
    const W = bg.width, H = bg.height;
    const t = performance.now() / 1000;
    const a = (2 * Math.PI * t) / 60;
    const b = (2 * Math.PI * t) / 85;
    bctx.fillStyle = "#0e0e10";
    bctx.fillRect(0, 0, W, H);
    drawLayer(bctx, bg, a, 1.175 - 0.075 * Math.cos(a),
      0.036 * W * (1 - Math.cos(a)), -0.027 * W * (1 - Math.cos(a)), false, 1);
    drawLayer(bctx, bg, -b, 1.125 + 0.075 * Math.cos(b),
      -0.027 * W * (1 - Math.cos(b)), 0.036 * W * (1 - Math.cos(b)), true, 0.5);
  }

  function drawNpBg() {
    if (!np || !np.classList.contains("on") || !hasArt) return;
    sizeCanvas(npCanvas);
    npCtx.fillStyle = "#0e0e10";
    npCtx.fillRect(0, 0, npCanvas.width, npCanvas.height);
    drawLayer(npCtx, npCanvas, 0, 1.1, 0, 0, false, 1);
  }

  function loadArt() {
    const url = toUrl(currentItem()?.metadata);
    if (!url) return false;
    if (url === artUrl) return true;
    artUrl = url;
    const img = new Image();
    img.onload = () => {
      if (artUrl !== url) return;
      sctx.clearRect(0, 0, SRC, SRC);
      sctx.filter = "blur(4px) saturate(0.6) brightness(0.5)";
      sctx.drawImage(img, -10, -10, SRC + 20, SRC + 20);
      sctx.filter = "none";
      hasArt = true;
      drawBg();
      drawNpBg();
    };
    img.src = url;
    return true;
  }

  function mountBg() {
    const host = document.querySelector(".Root__top-container");
    if (host && !bg.isConnected) host.prepend(bg);
  }

  (function loop() {
    setTimeout(loop, document.hasFocus() ? 50 : 200);
    if (document.hidden || !hasArt || !bg.isConnected) return;
    if (np && np.classList.contains("on")) return;
    drawBg();
  })();

  window.addEventListener("resize", () => {
    sizeCanvas(bg);
    if (hasArt) drawBg();
    drawNpBg();
  });

  let artTries = 0;
  const artTimer = setInterval(() => {
    if (loadArt() || ++artTries > 60) clearInterval(artTimer);
  }, 500);

  /* ===== Lyrics: Spotify first, then LRCLIB, cached per song ===== */
  async function fetchLyricsRaw(id) {
    const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}?format=json&vocalRemoval=false&market=from_token`;
    const fromSpotify = j => {
      const ly = j?.lyrics;
      if (!ly?.lines?.length) return null;
      return {
        synced: ly.syncType === "LINE_SYNCED",
        lines: ly.lines.filter(l => l.words && l.words.trim()).map(l => ({ t: Number(l.startTimeMs), w: l.words }))
      };
    };
    try {
      const token = Spicetify.Platform?.Session?.accessToken
        || Spicetify.Platform?.AuthorizationAPI?.getState?.()?.token?.accessToken;
      if (token) {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "app-platform": "WebPlayer" } });
        if (r.ok) {
          const out = fromSpotify(await r.json());
          if (out) return out;
        }
      }
    } catch (e) {}
    try {
      const out = fromSpotify(await Spicetify.CosmosAsync.get(url));
      if (out) return out;
    } catch (e) {}
    try {
      const m = currentItem()?.metadata || {};
      const q = new URLSearchParams({ track_name: m.title || "", artist_name: m.artist_name || "" });
      const list = await (await fetch(`https://lrclib.net/api/search?${q}`)).json();
      const dur = (Spicetify.Player.getDuration?.() || 0) / 1000; const close = x => !dur || !x.duration || Math.abs(x.duration - dur) <= 3; const good = list.find(x => x.syncedLyrics && close(x)); const plain = list.find(x => x.plainLyrics); const hit = good || (plain ? { plainLyrics: plain.plainLyrics } : null);
      if (hit?.syncedLyrics) {
        const lines = hit.syncedLyrics.split("\n").map(l => {
          const mm = l.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
          return mm && mm[3].trim() ? { t: Math.round((+mm[1] * 60 + +mm[2]) * 1000), w: mm[3] } : null;
        }).filter(Boolean);
        if (lines.length) return { synced: true, lines };
      }
      if (hit?.plainLyrics) {
        return { synced: false, lines: hit.plainLyrics.split("\n").filter(w => w.trim()).map(w => ({ t: 0, w })) };
      }
    } catch (e) {}
    return null;
  }

  const lyricCache = new Map();
  function fetchLyrics(id) {
    if (!lyricCache.has(id)) {
      lyricCache.set(id, fetchLyricsRaw(id));
      if (lyricCache.size > 6) lyricCache.delete(lyricCache.keys().next().value);
    }
    return lyricCache.get(id);
  }

  const activeIndex = lines => {
    const t = Spicetify.Player.getProgress() + 150;
    let i = lines.length - 1;
    while (i >= 0 && lines[i].t > t) i--;
    return i;
  };

  /* ===== Now playing screen ===== */
  const CLOSE = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 3l10 10M13 3L3 13"/></svg>';
  const NP_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1.5" y="3" width="6" height="10" rx="1"/><path d="M10 5h4.5M10 8h4.5M10 11h3"/></svg>';
  let npLyrics = null, npIdx = -1, npTimer = null;

  function npBuild() {
    np = document.createElement("div");
    np.id = "glass-np";
    np.innerHTML =
      '<canvas class="gnp-bg"></canvas>' +
      '<button class="gnp-close" aria-label="Close">' + CLOSE + '</button>' +
      '<div class="gnp-wrap">' +
        '<div class="gnp-left"><img class="gnp-cover" alt=""><div class="gnp-title"></div><div class="gnp-artist"></div></div>' +
        '<div class="gnp-lyrics"></div>' +
      '</div>';
    npCanvas = np.querySelector(".gnp-bg");
    npCtx = npCanvas.getContext("2d");
    lyricsBox = np.querySelector(".gnp-lyrics");
    np.querySelector(".gnp-close").addEventListener("click", npClose);
    lyricsBox.addEventListener("click", e => {
      const p = e.target.closest("[data-ms]");
      if (p && npLyrics?.synced) Spicetify.Player.seek(Number(p.dataset.ms));
    });
    (document.querySelector(".Root__top-container") || document.body).appendChild(np);
  }

  async function npLoad() {
    if (!np) return;
    const item = currentItem();
    if (!item) return;
    const m = item.metadata || {};
    np.querySelector(".gnp-cover").src = toUrl(m);
    np.querySelector(".gnp-title").textContent = m.title || "";
    np.querySelector(".gnp-artist").textContent = m.artist_name || "";
    npLyrics = null; npIdx = -1;
    lyricsBox.innerHTML = "";
    lyricsBox.classList.remove("plain");
    np.classList.remove("no-lyrics");
    const res = await fetchLyrics(item.uri.split(":")[2]);
    if (currentItem()?.uri !== item.uri) return;
    if (!res) { np.classList.add("no-lyrics"); return; }
    npLyrics = res;
    res.lines.forEach((l, i) => {
      const p = document.createElement("p");
      p.textContent = l.w;
      p.dataset.i = i;
      p.dataset.ms = l.t;
      lyricsBox.appendChild(p);
    });
    if (!res.synced) lyricsBox.classList.add("plain");
  }

  function npTick() {
    if (!npLyrics?.synced) return;
    const i = activeIndex(npLyrics.lines);
    if (i === npIdx) return;
    const prev = lyricsBox.querySelector(".on");
    if (prev) prev.classList.remove("on");
    const p = lyricsBox.querySelector(`[data-i="${i}"]`);
    if (p) {
      p.classList.add("on");
      p.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    npIdx = i;
  }

  function npOpen() {
    if (!np) npBuild();
    np.classList.add("on");
    document.body.classList.add("glass-np-open");
    npLoad();
    drawNpBg();
    if (!npTimer) npTimer = setInterval(npTick, 100);
  }
  function npClose() {
    if (!np) return;
    np.classList.remove("on");
    document.body.classList.remove("glass-np-open");
    clearInterval(npTimer);
    npTimer = null;
  }
  const npToggle = () => (np && np.classList.contains("on") ? npClose() : npOpen());

  function injectButtons() {
    if (document.querySelector(".glass-btns")) return;
    const right = document.querySelector(".main-nowPlayingBar-right");
    if (!right) return;
    const wrap = document.createElement("div");
    wrap.className = "glass-btns";
    const b = document.createElement("span");
    b.className = "glass-btn";
    b.setAttribute("role", "button");
    b.setAttribute("tabindex", "0");
    b.setAttribute("aria-label", "Now playing");
    b.title = "Now playing";
    b.innerHTML = NP_ICON;
    b.addEventListener("click", npToggle);
    b.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") npToggle(); });
    wrap.appendChild(b);
    const host = right.firstElementChild || right;
    host.insertBefore(wrap, host.firstChild);
  }

  /* ===== Sidebar lyrics (3 synced lines) ===== */
  let sideUri = null, sideLyrics = null, sideIdx = -2;

  function prepCard(card) {
    const label = [...card.querySelectorAll("h2, h3, h4, p, span, div")].find(
      e => e.childElementCount === 0 && /^lyrics( preview)?$/i.test(e.textContent.trim())
    );
    if (!label) return null;
    let n = label;
    while (n && n !== card) {
      [...n.parentElement.children].forEach(s => {
        if (s !== n && !s.classList.contains("glass-side-lyrics")) s.style.display = "none";
      });
      n = n.parentElement;
    }
    const box = document.createElement("div");
    box.className = "glass-side-lyrics";
    card.appendChild(box);
    card.dataset.glassReady = "1";
    return box;
  }

  function renderSide(box, i) {
    box.classList.remove("swap");
    void box.offsetWidth;
    box.innerHTML = "";
    const synced = sideLyrics.synced;
    box.classList.toggle("plain", !synced);
    const from = synced ? i - 1 : 0;
    for (let k = from; k < from + 3; k++) {
      const p = document.createElement("p");
      p.textContent = sideLyrics.lines[k]?.w || "\u00a0";
      if (synced && k === i) p.className = "on";
      box.appendChild(p);
    }
    box.classList.add("swap");
  }

  setInterval(() => {
    if (document.hidden) return;
    const card = document.querySelector(".glass-lyrics-card");
    if (!card) return;
    let box = card.querySelector(".glass-side-lyrics");
    if (!box) {
      if (card.dataset.glassReady) return;
      box = prepCard(card);
      if (!box) return;
      sideIdx = -2;
    }
    const item = currentItem();
    if (!item) return;
    if (item.uri !== sideUri) {
      sideUri = item.uri;
      sideLyrics = null;
      sideIdx = -2;
      const uri = item.uri;
      fetchLyrics(uri.split(":")[2]).then(res => {
        if (sideUri === uri) { sideLyrics = res; sideIdx = -2; }
      });
      return;
    }
    if (!sideLyrics?.lines?.length) return;
    const i = sideLyrics.synced ? activeIndex(sideLyrics.lines) : 0;
    if (i !== sideIdx || !box.childElementCount) {
      sideIdx = i;
      renderSide(box, i);
    }
  }, 300);

  /* ===== One scanner, only runs when Spotify changes the page ===== */
  const OURS = ["glass-card", "glass-inner", "glass-fade", "glass-clear", "glass-lyrics-card", "glass-tile", "glass-pill"];
  const isOurs = el => OURS.some(c => el.classList.contains(c));
  const trySweep = limiter(), tryPill = limiter(), tryTile = limiter();

  function sweep(root, mode) {
    if (!root) return;
    const minW = root.clientWidth * (mode === "side" ? 0.6 : 0.8);
    root.querySelectorAll("div, section, header, li, a").forEach(el => {
      if (isOurs(el) || el.offsetWidth < minW || !trySweep(el)) return;
      if (el.closest(".glass-side-lyrics") || el.className.toString().includes("os-scrollbar")) return;
      const cs = getComputedStyle(el);
      if (cs.backgroundImage.includes("url(")) return;
      const a = alphaOf(cs.backgroundColor);
      const grad = cs.backgroundImage.includes("gradient");
      if (a < 0.03 && !grad) return;
      const r = parseFloat(cs.borderTopLeftRadius) || parseFloat(cs.borderBottomLeftRadius) || 0;
      if (mode === "side") {
        if (r >= 4) {
          const inCard = el.parentElement && el.parentElement.closest(".glass-card, .glass-lyrics-card");
          el.classList.add(inCard ? "glass-inner" : "glass-card");
        } else {
          el.classList.add("glass-fade");
        }
      } else if (r < 2) {
        el.classList.add("glass-clear");
      }
    });
  }

  function pillsAndTiles() {
    document.querySelectorAll(
      ".Root__main-view button, .Root__main-view a, .Root__main-view [role='checkbox'], .Root__main-view [role='button'], " +
      ".Root__nav-bar button, .Root__nav-bar [role='checkbox'], .Root__globalNav *"
    ).forEach(el => {
      if (el.classList.contains("glass-pill") || el.closest(".glass-btns")) return;
      const h = el.offsetHeight;
      if (h < 24 || h > 56 || !tryPill(el)) return;
      const cs = getComputedStyle(el);
      const r = parseFloat(cs.borderTopLeftRadius) || 0;
      if (r < h / 2 - 2) return;
      const a = alphaOf(cs.backgroundColor);
      if (a < 0.03) return;
      const hasState = el.hasAttribute("aria-checked") || el.hasAttribute("aria-selected") || el.hasAttribute("aria-pressed");
      if (a > 0.6 && brightness(cs.backgroundColor) > 200 && !hasState) return;
      el.classList.add("glass-pill");
    });

    const main = document.querySelector(".Root__main-view");
    if (!main) return;
    const mw = main.clientWidth;
    main.querySelectorAll("div, a").forEach(el => {
      if (el.classList.contains("glass-tile")) return;
      const h = el.offsetHeight, w = el.offsetWidth;
      if (h < 40 || h > 140 || w < mw * 0.2 || w > mw * 0.6 || !tryTile(el)) return;
      if (!el.querySelector("img")) return;
      if (el.parentElement && el.parentElement.closest(".glass-tile")) return;
      const cs = getComputedStyle(el);
      const r = parseFloat(cs.borderTopLeftRadius) || 0;
      if (r < 3 || r > 16) return;
      if (alphaOf(cs.backgroundColor) < 0.03) return;
      el.classList.add("glass-tile");
    });
  }

  function scan() {
    mountBg();
    injectButtons();
    const side = document.querySelector(".Root__right-sidebar");
    const lc = side && side.querySelector('[data-testid="lyrics-npv-section"]:not(.glass-lyrics-card)');
    if (lc) lc.classList.add("glass-lyrics-card");
    sweep(side, "side");
    sweep(document.querySelector(".Root__main-view"), "main");
    pillsAndTiles();
    (window.glassScanHooks || []).forEach(f => { try { f(); } catch (e) {} });
  }

  let scanQueued = false, lastScan = 0;
  function requestScan() {
    if (scanQueued) return;
    scanQueued = true;
    const wait = Math.max(300, 1000 - (Date.now() - lastScan));
    setTimeout(() => {
      scanQueued = false;
      lastScan = Date.now();
      if (!document.hidden) scan();
    }, wait);
  }
  const OWN = "#glass-np, #glass-bg, .glass-side-lyrics, .glass-btns";
  new MutationObserver(muts => {
    for (const m of muts) {
      const t = m.target;
      if (t.nodeType === 1 && t.closest(OWN)) continue;
      requestScan();
      return;
    }
  }).observe(document.body, { childList: true, subtree: true });
  requestScan();

  /* ===== Events ===== */
  document.addEventListener("keydown", e => { if (e.key === "Escape") npClose(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) requestScan(); });
  Spicetify.Player.addEventListener("songchange", () => {
    setTimeout(loadArt, 100);
    if (np && np.classList.contains("on")) npLoad();
  });
  Spicetify.Player.addEventListener("onplaypause", loadArt);
})();

(function glassExtras() {
  window.glassScanHooks = window.glassScanHooks || [];

  /* ----- Search dropdown ----- */
  function tagDropdown() {
    document.querySelectorAll(".Root__globalNav *").forEach(el => {
      if (el.classList.contains("glass-popover")) return;
      if (el.offsetHeight < 150 || el.offsetWidth < 200) return;
      if (el.parentElement && el.parentElement.closest(".glass-popover")) return;
      const pos = getComputedStyle(el).position;
      if (pos === "absolute" || pos === "fixed") el.classList.add("glass-popover");
    });
  }
  document.addEventListener("focusin", e => {
    if (e.target.closest && e.target.closest(".Root__globalNav")) {
      setTimeout(tagDropdown, 60);
      setTimeout(tagDropdown, 300);
    }
  });

  /* ----- Playlist image headers ----- */
  const coverCache = {};
  const heroChecks = {};
  let heroBusy = false;

  async function coverFor(id) {
    if (coverCache[id]) return coverCache[id];
    let url = "";
    try {
      const m = await Spicetify.Platform.PlaylistAPI.getMetadata(`spotify:playlist:${id}`);
      url = m?.images?.[0]?.url || "";
    } catch (e) {}
    if (!url) {
      const im = document.querySelector(`.Root__nav-bar [aria-labelledby*="${id}"] img`);
      url = im?.src || "";
    }
    if (!url) {
      try {
        const token = Spicetify.Platform?.Session?.accessToken
          || Spicetify.Platform?.AuthorizationAPI?.getState?.()?.token?.accessToken;
        const r = await fetch(`https://api.spotify.com/v1/playlists/${id}?fields=images`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (r.ok) url = (await r.json()).images?.[0]?.url || "";
      } catch (e) {}
    }
    if (url.startsWith("spotify:image:")) url = "https://i.scdn.co/image/" + url.split(":")[2];
    coverCache[id] = url;
    return url;
  }

  async function fixHero() {
    if (heroBusy) return;
    const path = Spicetify.Platform?.History?.location?.pathname || "";
    const m = path.match(/^\/playlist\/([A-Za-z0-9]+)/);
    if (!m) return;
    const main = document.querySelector(".Root__main-view");
    if (!main || main.querySelector(".glass-hero-cover")) return;
    if ((heroChecks[path] || 0) > 3 && !main.querySelector(".glass-hero-hide, .glass-hero-nobg, [data-testid='background-image']")) return;
    heroChecks[path] = (heroChecks[path] || 0) + 1;

    heroBusy = true;
    try {
      const mainTop = main.getBoundingClientRect().top;
      const mw = main.clientWidth;
      let found = !!main.querySelector(".glass-hero-hide, .glass-hero-nobg, [data-testid='background-image']");
      main.querySelectorAll("img, video, div").forEach(el => {
        if (el.classList.contains("glass-hero-hide") || el.classList.contains("glass-hero-nobg")) return;
        if (el.offsetWidth < mw * 0.7 || el.offsetHeight < 200) return;
        if (el.getBoundingClientRect().top - mainTop > 400) return;
        if (el.tagName === "IMG" || el.tagName === "VIDEO") {
          el.classList.add("glass-hero-hide");
          found = true;
        } else if (getComputedStyle(el).backgroundImage.includes("url(")) {
          el.classList.add("glass-hero-nobg");
          found = true;
        }
      });
      if (!found) return;

      const h1 = main.querySelector("h1");
      if (!h1) return;
      let block = h1;
      while (block.parentElement && block.parentElement !== main && !/\d+\s+songs?/i.test(block.textContent)) {
        block = block.parentElement;
      }
      if (!/\d+\s+songs?/i.test(block.textContent) || block.parentElement === main) block = h1.parentElement;

      const url = await coverFor(m[1]);
      if (!url || main.querySelector(".glass-hero-cover") || !block.isConnected) return;
      const img = document.createElement("img");
      img.className = "glass-hero-cover";
      img.alt = "";
      img.src = url;
      block.parentElement.classList.add("glass-hero-row");
      block.parentElement.insertBefore(img, block);
    } finally {
      heroBusy = false;
    }
  }

  window.glassScanHooks.push(tagDropdown, fixHero);
})();



(function glassCoverFlow() {
  if (!(window.Spicetify && Spicetify.Player && Spicetify.Player.addEventListener)) {
    setTimeout(glassCoverFlow, 400);
    return;
  }

  const currentItem = () => Spicetify.Player.data?.item || Spicetify.Player.data?.track;
  const toUrl = meta => {
    const img = meta?.image_xlarge_url || meta?.image_large_url || meta?.image_url;
    if (!img) return "";
    return img.startsWith("spotify:image:") ? "https://i.scdn.co/image/" + img.split(":")[2] : img;
  };
  const LYRICS_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 3.5h11M2.5 7h11M2.5 10.5h7"/></svg>';
  const FLOW_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5" y="3" width="6" height="8" rx="1"/><path d="M2.5 4.5v5M13.5 4.5v5"/></svg>';
  const SHOW = 4;

  let mode = "flow", wasOpen = false, timer = null, idleTimer = null;
  let lastSig = "", focus = 0, list = [], wheelAcc = 0;
  let flow = null, stage, metaTitle, metaArtist, modeBtn;
  const items = new Map();
  const host = () => document.getElementById("glass-np");

  function place(el, d, size) {
    const a = Math.abs(d), s = Math.sign(d);
    const x = a === 0 ? 0 : s * (size * 0.7 + (Math.min(a, SHOW + 1) - 1) * size * 0.24);
    const rot = a === 0 ? 0 : -s * 60;
    const z = a === 0 ? 0 : -size * 0.3;
    el.style.transform = `perspective(1200px) translateX(${x}px) translateZ(${z}px) rotateY(${rot}deg)`;
    el.style.zIndex = String(100 - a);
    el.style.opacity = a > SHOW ? "0" : "1";
    el.style.visibility = a > SHOW + 1 ? "hidden" : "visible";
    el.style.filter = a === 0 ? "none" : "brightness(.7)";
    const im = el.firstChild;
    if (im && im.dataset.src) {
      if (a <= SHOW + 1 && !im.getAttribute("src")) im.src = im.dataset.src;
      else if (a > SHOW + 3 && im.getAttribute("src")) im.removeAttribute("src");
    }
  }

  function readQueue() {
    const cur = currentItem();
    if (!cur) return null;
    const q = Spicetify.Queue || {};
    const ok = t => {
      const u = t?.contextTrack?.uri || "";
      return u && !u.startsWith("spotify:delimiter") && toUrl(t.contextTrack.metadata);
    };
    const map = t => ({ uri: t.contextTrack.uri, uid: t.contextTrack.uid, meta: t.contextTrack.metadata });
    const prev = (q.prevTracks || []).filter(ok).slice(-10).map(map);
    const next = (q.nextTracks || []).filter(ok).slice(0, 15).map(map);
    const all = [...prev, { uri: cur.uri, uid: cur.uid, meta: cur.metadata || {} }, ...next];
    const counts = {};
    return all.map((t, i) => {
      counts[t.uri] = (counts[t.uri] || 0) + 1;
      return { ...t, key: t.uri + "|" + counts[t.uri], p: i - prev.length };
    });
  }

  function layout() {
    if (!flow || !list.length) return;
    const minP = list[0].p, maxP = list[list.length - 1].p;
    focus = Math.max(minP, Math.min(maxP, focus));
    const size = stage.offsetHeight;
    const seen = new Set();
    list.forEach(t => {
      seen.add(t.key);
      let el = items.get(t.key);
      if (!el) {
        el = document.createElement("div");
        el.className = "gnp-flow-item";
        const img = document.createElement("img");
        img.alt = "";
        img.dataset.src = toUrl(t.meta);
        el.appendChild(img);
        el.addEventListener("click", e => {
          e.stopPropagation();
          const p = Number(el.dataset.p);
          if (p !== focus) setFocus(p);
          else playAt(p);
        });
        place(el, Math.sign(t.p - focus || 1) * (SHOW + 1), size);
        stage.appendChild(el);
        items.set(t.key, el);
        void el.offsetWidth;
      }
      el.dataset.p = t.p;
      place(el, t.p - focus, size);
    });
    items.forEach((el, key) => {
      if (seen.has(key)) return;
      items.delete(key);
      place(el, Number(el.dataset.p) - focus < 0 ? -(SHOW + 2) : SHOW + 2, size);
      setTimeout(() => el.remove(), 600);
    });
    const f = list.find(t => t.p === focus) || list.find(t => t.p === 0);
    metaTitle.textContent = f?.meta?.title || "";
    metaArtist.textContent = f?.meta?.artist_name || "";
  }

  function refresh(force) {
    const q = readQueue();
    if (!q) return;
    const sig = q.map(t => t.key + "@" + t.p).join(",");
    if (!force && sig === lastSig) return;
    lastSig = sig;
    list = q;
    layout();
  }

  function setFocus(f) {
    focus = f;
    layout();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { focus = 0; layout(); }, 8000);
  }

  function goBack(steps) {
    const restart = Spicetify.Player.getProgress() > 3000 ? 1 : 0;
    for (let k = 0; k < steps + restart; k++) setTimeout(() => Spicetify.Player.back(), k * 200);
  }
  function goNext(steps) {
    for (let k = 0; k < steps; k++) setTimeout(() => Spicetify.Player.next(), k * 200);
  }

  async function playAt(p) {
    if (p === 0) return Spicetify.Player.togglePlay();
    if (p < 0) return goBack(-p);
    const t = list.find(x => x.p === p);
    const api = Spicetify.Platform?.PlayerAPI;
    if (t?.uid && api?.skipTo) {
      try {
        await api.skipTo({ uri: t.uri, uid: t.uid });
        setTimeout(() => { if (currentItem()?.uri !== t.uri) goNext(p); }, 1200);
        return;
      } catch (e) {}
    }
    goNext(p);
  }

  function build(h) {
    flow = document.createElement("div");
    flow.className = "gnp-flow";
    flow.innerHTML =
      '<div class="gnp-stage"></div>' +
      '<div class="gnp-flow-meta"><div class="gnp-flow-title"></div><div class="gnp-flow-artist"></div></div>';
    stage = flow.querySelector(".gnp-stage");
    metaTitle = flow.querySelector(".gnp-flow-title");
    metaArtist = flow.querySelector(".gnp-flow-artist");
    flow.addEventListener("wheel", e => {
      e.preventDefault();
      wheelAcc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      while (Math.abs(wheelAcc) >= 80) {
        const dir = Math.sign(wheelAcc);
        setFocus(focus + dir);
        wheelAcc -= dir * 80;
      }
    }, { passive: false });
    modeBtn = document.createElement("button");
    modeBtn.className = "gnp-mode";
    modeBtn.addEventListener("click", () => setMode(mode === "flow" ? "lyrics" : "flow"));
    h.appendChild(flow);
    h.appendChild(modeBtn);
  }

  function startTimer() {
    if (!timer) timer = setInterval(() => { if (!document.hidden) refresh(false); }, 2000);
  }
  function stopTimer() {
    clearInterval(timer);
    timer = null;
  }

  function setMode(m) {
    mode = m;
    const h = host();
    if (!h || !modeBtn) return;
    h.classList.toggle("mode-flow", m === "flow");
    modeBtn.innerHTML = m === "flow" ? LYRICS_ICON + "<span>Lyrics</span>" : FLOW_ICON + "<span>Albums</span>";
    if (m === "flow") {
      focus = 0;
      refresh(true);
      startTimer();
    } else {
      stopTimer();
    }
  }

  new MutationObserver(() => {
    const open = document.body.classList.contains("glass-np-open");
    if (open === wasOpen) return;
    wasOpen = open;
    if (open) {
      const h = host();
      if (!h) return;
      if (!flow || !flow.isConnected) build(h);
      setMode(mode);
    } else {
      stopTimer();
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  document.addEventListener("keydown", e => {
    if (!wasOpen || mode !== "flow") return;
    if (e.target.closest && e.target.closest("input, textarea")) return;
    if (e.key === "ArrowLeft") setFocus(focus - 1);
    else if (e.key === "ArrowRight") setFocus(focus + 1);
    else if (e.key === "Enter") playAt(focus);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  Spicetify.Player.addEventListener("songchange", () => {
    if (!wasOpen || mode !== "flow") return;
    focus = 0;
    setTimeout(() => refresh(true), 250);
    setTimeout(() => refresh(false), 900);
  });
  window.addEventListener("resize", () => {
    if (wasOpen && mode === "flow") layout();
  });
})();


