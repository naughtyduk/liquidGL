/*
 * liquidGL – Liquid Glass - Powered by WebGPU/WebGL
 * -----------------------------------------------------------------------------
 *
 * Author: NaughtyDuk© – https://liquidgl.naughtyduk.com
 * Licence: MIT
 * Version: v3.0.0
 */

const liquidGL = (() => {
  "use strict";

  if (typeof window === "undefined") return;

  const RECAPTURE_INTERVAL_MS = 250;
  const renderers = new Set();
  let lensOrder = 0;
  let rendering = false;
  let renderFrame = 0;
  let renderRaf = null;
  let stopSync = null;
  const renderAll = () => window.__liquidGLRenderer__?.render();
  const startRendering = () => {
    if (renderRaf !== null || stopSync || !renderers.size) return;
    const loop = () => {
      renderRaf = null;
      renderAll();
      startRendering();
    };
    renderRaf = requestAnimationFrame(loop);
  };
  const listen = (owner, target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    (owner._cleanups ||= []).push(() =>
      target.removeEventListener(type, handler, options),
    );
  };
  const restoreStyles = (el, properties) => {
    const original = document.createElement("div").style;
    original.cssText = el.style.cssText;
    const names = new Set(properties);
    for (const name of original) {
      if (properties.some((property) => name.startsWith(`${property}-`))) {
        names.add(name);
      }
    }
    return () => {
      for (const name of names) el.style.removeProperty(name);
      for (const name of original) {
        if (names.has(name)) {
          el.style.setProperty(
            name,
            original.getPropertyValue(name),
            original.getPropertyPriority(name),
          );
        }
      }
    };
  };
  const removeRule = (sheet, style) => {
    for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
      if (sheet.cssRules[i].style === style) sheet.deleteRule(i);
    }
  };
  const releaseEntry = (backend, entry) => {
    if (!entry) return;
    for (const value of Object.values(entry).flat()) {
      if (backend.gl) {
        if (value instanceof WebGLTexture) backend.gl.deleteTexture(value);
        else if (value instanceof WebGLBuffer) backend.gl.deleteBuffer(value);
        else if (value instanceof WebGLFramebuffer)
          backend.gl.deleteFramebuffer(value);
        else if (value instanceof WebGLProgram) backend.gl.deleteProgram(value);
      } else if (
        (typeof GPUTexture !== "undefined" && value instanceof GPUTexture) ||
        (typeof GPUBuffer !== "undefined" && value instanceof GPUBuffer)
      ) {
        value.destroy();
      }
    }
  };
  const releaseCached = (backend, key) => {
    for (const cache of [
      backend._contents,
      backend._shadows?.entries,
      backend._backdrops?.entries,
    ]) {
      releaseEntry(backend, cache?.get(key));
      cache?.delete(key);
    }
    backend._gpuContents?.delete(key);
  };
  const destroyBackend = (backend) => {
    if (!backend) return;
    for (const cache of [
      backend._contents,
      backend._videoContents,
      backend._shadows?.entries,
      backend._backdrops?.entries,
    ]) {
      if (!cache) continue;
      for (const entry of cache.values()) releaseEntry(backend, entry);
      cache.clear();
    }
    backend._gpuContents?.clear();
    releaseEntry(backend, backend._shadows || {});
    releaseEntry(backend, backend._backdrops || {});
    releaseEntry(backend, backend);
    backend.ctx?.unconfigure();
    backend.gl?.getExtension("WEBGL_lose_context")?.loseContext();
  };
  const videoFrames = new Map();
  const videoFrame = (video) => {
    if (!video.requestVideoFrameCallback) return video.currentTime;
    let state = videoFrames.get(video);
    if (!state) {
      state = {
        frame: 0,
        time: video.currentTime,
        callbackTime: performance.now(),
        callbacks: true,
      };
      videoFrames.set(video, state);
      const schedule = () => {
        try {
          state.callbackId = video.requestVideoFrameCallback(update);
        } catch (e) {
          state.callbacks = false;
        }
      };
      const update = () => {
        if (state.stopped) return;
        state.frame++;
        state.time = video.currentTime;
        state.callbackTime = performance.now();
        schedule();
      };
      schedule();
    }
    if (
      video.currentTime !== state.time &&
      (!state.callbacks || performance.now() - state.callbackTime > 250)
    ) {
      state.time = video.currentTime;
      state.frame++;
    }
    return state.frame;
  };
  const videoImages = new Map();
  const videoImage = (video) => {
    const previous = videoImages.get(video);
    if (video.seeking || video.readyState < 2) {
      if (previous) previous.waiting = true;
      return previous?.retained
        ? { ...previous, source: previous.heldSource }
        : null;
    }
    const frame = videoFrame(video);
    if (
      previous &&
      !previous.waiting &&
      previous.frame === frame &&
      previous.url === video.currentSrc &&
      previous.width === video.videoWidth &&
      previous.height === video.videoHeight
    )
      return previous;
    let heldSource = null;
    if (typeof VideoFrame !== "undefined") {
      try {
        heldSource = new VideoFrame(video);
      } catch (e) {}
    }
    const image = {
      source: video,
      heldSource,
      frame,
      url: video.currentSrc,
      width: video.videoWidth,
      height: video.videoHeight,
      version: (previous?.version || 0) + 1,
      retained: !!heldSource,
      waiting: false,
    };
    videoImages.set(video, image);
    if (previous?.heldSource) previous.heldSource.close();
    return image;
  };
  const orderedRenderers = () =>
    Array.from(renderers).sort(
      (a, b) =>
        a._zIndex - b._zIndex || a.lenses[0]._order - b.lenses[0]._order,
    );

  const TINT_OFF = [1, 1, 1, 0];
  const INTERACTION_OFF = [0, 0, 0, 0];
  const unitOption = (value, fallback, max = 1) =>
    Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : fallback;

  const ENGINE_CHAINS = {
    auto: ["webgpu", "webgl2", "webgl", "experimental-webgl"],
    webgpu: ["webgpu"],
    webgl2: ["webgl2", "webgl", "experimental-webgl"],
    webgl: ["webgl", "experimental-webgl"],
  };

  /* --------------------------------------------------
   *  Utilities
   * ------------------------------------------------*/
  function debounce(fn, wait) {
    let t;
    const debounced = (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, a), wait);
    };
    debounced.cancel = () => clearTimeout(t);
    return debounced;
  }

  /* --------------------------------------------------
   *  Helper : Parse any CSS colour (incl. alpha) → [r,g,b] 0–1 + a
   * ------------------------------------------------*/
  let _colorProbe = null;
  function parseTintColor(value) {
    if (typeof value !== "string") return null;
    const v = value.trim();
    if (!v) return null;
    if (
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      !CSS.supports("color", v)
    ) {
      return null;
    }
    if (!_colorProbe) {
      _colorProbe = document.createElement("canvas").getContext("2d");
    }
    const probe = _colorProbe;
    if (!probe) return null;
    probe.fillStyle = "#000000";
    probe.fillStyle = v;
    const norm = probe.fillStyle;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 1;
    if (norm.charAt(0) === "#") {
      let hex = norm.slice(1);
      if (hex.length === 3 || hex.length === 4) {
        hex = hex
          .split("")
          .map((c) => c + c)
          .join("");
      }
      r = parseInt(hex.substr(0, 2), 16);
      g = parseInt(hex.substr(2, 2), 16);
      b = parseInt(hex.substr(4, 2), 16);
      if (hex.length === 8) a = parseInt(hex.substr(6, 2), 16) / 255;
    } else {
      const m = norm.match(/^(?:rgba?|hwb|hsla?)\(([^)]+)\)$/);
      if (!m) return null;
      const parts = m[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(parseFloat);
      if (parts.length < 3 || parts.some(isNaN)) return null;
      r = parts[0];
      g = parts[1];
      b = parts[2];
      if (parts.length > 3) {
        a = m[1].indexOf("%") !== -1 ? parts[3] / 100 : parts[3];
      }
    }
    if ([r, g, b, a].some(isNaN)) return null;
    return [
      Math.min(1, Math.max(0, r / 255)),
      Math.min(1, Math.max(0, g / 255)),
      Math.min(1, Math.max(0, b / 255)),
      Math.min(1, Math.max(0, a)),
    ];
  }

  /* --------------------------------------------------
   *  Helper : Effective z-index (highest stacking context)
   * ------------------------------------------------*/
  function effectiveZ(el) {
    let node = el;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      if (style.position !== "static" && style.zIndex !== "auto") {
        const z = parseInt(style.zIndex, 10);
        if (!isNaN(z)) return z;
      }
      node = node.parentElement;
    }
    return 0;
  }

  /* --------------------------------------------------
   *  WebGL helpers
   * ------------------------------------------------*/
  function compileShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src.trim());
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("Shader error", gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  function createProgram(gl, vsSource, fsSource) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error("Program link error", gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  /* --------------------------------------------------
   *  NaughtyDOM
   * ------------------------------------------------*/
  const NaughtyDOM = (() => {
    const IDENT = [1, 0, 0, 1, 0, 0];
    const CLIP_OVERFLOW = /^(hidden|clip|scroll|auto)$/;

    function mul(m, n) {
      return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
      ];
    }

    function apply(m, x, y) {
      return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    }

    function invertLinear(m) {
      const det = m[0] * m[3] - m[1] * m[2];
      if (!det || !isFinite(det)) return null;
      return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, 0, 0];
    }

    function parseMatrix(str) {
      if (!str || str === "none") return null;
      const open = str.indexOf("(");
      if (open === -1) return null;
      const kind = str.slice(0, open);
      const v = str
        .slice(open + 1, str.lastIndexOf(")"))
        .split(",")
        .map((n) => parseFloat(n));
      if (kind === "matrix" && v.length >= 6) {
        return [v[0], v[1], v[2], v[3], v[4], v[5]];
      }
      if (kind === "matrix3d" && v.length >= 16) {
        return [v[0], v[1], v[4], v[5], v[12], v[13]];
      }
      return null;
    }

    function parseOrigin(str) {
      if (!str) return [0, 0];
      const p = str.split(" ");
      return [parseFloat(p[0]) || 0, parseFloat(p[1]) || 0];
    }

    function isTransparent(color) {
      if (!color || color === "transparent" || color === "none") return true;
      const alpha = color.match(
        /^(?:rgba|hsla|hwb|lab|lch|oklab|oklch|color)\([^)]*[,/]\s*([0-9.]+)%?\s*\)$/,
      );
      return alpha ? parseFloat(alpha[1]) === 0 : false;
    }

    function splitTopLevel(value) {
      const out = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "," && depth === 0) {
          out.push(value.slice(start, i).trim());
          start = i + 1;
        }
      }
      const tail = value.slice(start).trim();
      if (tail) out.push(tail);
      return out;
    }

    function resolveLength(token, basis) {
      if (!token) return 0;
      if (token.indexOf("%") !== -1) {
        return (parseFloat(token) / 100) * basis;
      }
      const n = parseFloat(token);
      return isNaN(n) ? 0 : n;
    }

    function cornerRadius(value, w, h) {
      if (!value) return [0, 0];
      const parts = value.split(" ").filter(Boolean);
      const rx = resolveLength(parts[0], w);
      const ry = parts.length > 1 ? resolveLength(parts[1], h) : rx;
      return [Math.max(0, rx), Math.max(0, ry)];
    }

    function parseRadii(style, w, h) {
      const r = [
        cornerRadius(style.borderTopLeftRadius, w, h),
        cornerRadius(style.borderTopRightRadius, w, h),
        cornerRadius(style.borderBottomRightRadius, w, h),
        cornerRadius(style.borderBottomLeftRadius, w, h),
      ];
      if (!r.some((c) => c[0] > 0 || c[1] > 0)) return null;
      let f = 1;
      const ratio = (sum, len) => (sum > len && sum > 0 ? len / sum : 1);
      f = Math.min(
        f,
        ratio(r[0][0] + r[1][0], w),
        ratio(r[3][0] + r[2][0], w),
        ratio(r[0][1] + r[3][1], h),
        ratio(r[1][1] + r[2][1], h),
      );
      if (f < 1) {
        for (let i = 0; i < 4; i++) {
          r[i][0] *= f;
          r[i][1] *= f;
        }
      }
      return r;
    }

    function insetRadii(radii, top, right, bottom, left) {
      if (!radii) return null;
      return [
        [Math.max(0, radii[0][0] - left), Math.max(0, radii[0][1] - top)],
        [Math.max(0, radii[1][0] - right), Math.max(0, radii[1][1] - top)],
        [Math.max(0, radii[2][0] - right), Math.max(0, radii[2][1] - bottom)],
        [Math.max(0, radii[3][0] - left), Math.max(0, radii[3][1] - bottom)],
      ];
    }

    function invert(m) {
      const det = m[0] * m[3] - m[1] * m[2];
      if (!det || !isFinite(det)) return null;
      return [
        m[3] / det,
        -m[1] / det,
        -m[2] / det,
        m[0] / det,
        (m[2] * m[5] - m[3] * m[4]) / det,
        (m[1] * m[4] - m[0] * m[5]) / det,
      ];
    }

    const imageCache = new Map();
    const svgCache = new WeakMap();
    let pending = [];

    function sameOrigin(src) {
      if (/^data:/.test(src) || /^blob:/.test(src)) return true;
      try {
        return new URL(src, location.href).origin === location.origin;
      } catch (e) {
        return false;
      }
    }

    function loadImage(src, cache = true) {
      if (!src) return null;
      if (cache && imageCache.has(src)) return imageCache.get(src);
      const img = new Image();
      const entry = { img, ready: false, failed: false };
      if (cache) imageCache.set(src, entry);
      if (!sameOrigin(src)) img.crossOrigin = "anonymous";
      const done = new Promise((resolve) => {
        img.onload = () => {
          entry.ready = true;
          resolve();
        };
        img.onerror = () => {
          entry.failed = true;
          resolve();
        };
      });
      img.src = src;
      if (img.complete && img.naturalWidth) {
        entry.ready = true;
      } else {
        pending.push(done);
      }
      return entry;
    }

    const SVG_PAINT = [
      "fill",
      "fill-opacity",
      "fill-rule",
      "stroke",
      "stroke-width",
      "stroke-opacity",
      "stroke-linecap",
      "stroke-linejoin",
      "stroke-dasharray",
      "stroke-dashoffset",
      "opacity",
      "color",
      "stop-color",
      "stop-opacity",
      "font-family",
      "font-size",
      "font-weight",
      "font-style",
      "text-anchor",
      "letter-spacing",
      "display",
      "visibility",
      "transform",
      "transform-origin",
      "mix-blend-mode",
      "clip-path",
      "mask",
      "filter",
      "marker-start",
      "marker-mid",
      "marker-end",
    ];

    function inlineSvgStyles(source, clone) {
      const computed = getComputedStyle(source);
      let css = "";
      for (let i = 0; i < SVG_PAINT.length; i++) {
        const prop = SVG_PAINT[i];
        const value = computed.getPropertyValue(prop);
        if (value) css += `${prop}:${value};`;
      }
      if (css) clone.setAttribute("style", css);
      const sk = source.children;
      const ck = clone.children;
      for (let i = 0; i < sk.length && i < ck.length; i++) {
        inlineSvgStyles(sk[i], ck[i]);
      }
    }

    function svgToImage(el) {
      const r = el.getBoundingClientRect();
      const computed = getComputedStyle(el);
      const paintSig = `${computed.color}|${computed.fill}|${computed.stroke}`;
      const signature = `${el.outerHTML.length}|${el.childElementCount}|${Math.round(r.width)}x${Math.round(r.height)}|${el.className}|${paintSig}`;
      const cached = svgCache.get(el);
      if (cached && cached.signature === signature) return cached.entry;

      const clone = el.cloneNode(true);
      inlineSvgStyles(el, clone);
      let html = new XMLSerializer().serializeToString(clone);
      if (
        !/^<svg[^>]*\swidth=/.test(html) ||
        !/^<svg[^>]*\sheight=/.test(html)
      ) {
        html = html.replace(
          /^<svg/,
          `<svg width="${r.width}" height="${r.height}"`,
        );
      }
      if (!/xmlns=/.test(html)) {
        html = html.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      const entry = loadImage(
        "data:image/svg+xml;charset=utf-8," + encodeURIComponent(html),
        false,
      );
      svgCache.set(el, { signature, entry });
      return entry;
    }

    function usableDomImage(el) {
      return (
        el.complete &&
        el.naturalWidth > 0 &&
        (sameOrigin(el.currentSrc || el.src) || !!el.crossOrigin)
      );
    }

    function layerUrls(value) {
      if (!value || value === "none") return [];
      const out = [];
      splitTopLevel(value).forEach((layer) => {
        const m = layer.match(/^url\((['"]?)(.*?)\1\)$/);
        if (m) out.push(m[2]);
      });
      return out;
    }

    const COLOR_TOKEN =
      /^(rgba?\([^)]*\)|hsla?\([^)]*\)|hwb\([^)]*\)|(?:ok)?lab\([^)]*\)|(?:ok)?lch\([^)]*\)|color\([^)]*\)|color-mix\([^)]*\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/;

    function parseAngle(token) {
      const v = parseFloat(token);
      if (isNaN(v)) return 180;
      if (token.indexOf("turn") !== -1) return v * 360;
      if (token.indexOf("grad") !== -1) return v * 0.9;
      if (token.indexOf("rad") !== -1) return (v * 180) / Math.PI;
      return v;
    }

    function sideAngle(spec, w, h) {
      const has = (k) => spec.indexOf(k) !== -1;
      const diag = (Math.atan2(w, h) * 180) / Math.PI;
      if (has("top") && has("right")) return diag;
      if (has("bottom") && has("right")) return 180 - diag;
      if (has("bottom") && has("left")) return 180 + diag;
      if (has("top") && has("left")) return 360 - diag;
      if (has("top")) return 0;
      if (has("right")) return 90;
      if (has("bottom")) return 180;
      if (has("left")) return 270;
      return 180;
    }

    function parseStops(parts, length) {
      const stops = [];
      parts.forEach((part) => {
        const m = part.match(COLOR_TOKEN);
        if (!m) return;
        const color = m[0];
        const rest = part.slice(color.length).trim();
        const positions = rest ? rest.split(/\s+/) : [];
        if (!positions.length) {
          stops.push({ color, pos: null });
        } else {
          positions.forEach((p) => {
            const pos =
              p.indexOf("%") !== -1
                ? parseFloat(p) / 100
                : length
                  ? parseFloat(p) / length
                  : 0;
            stops.push({ color, pos: isNaN(pos) ? null : pos });
          });
        }
      });
      if (!stops.length) return stops;
      if (stops[0].pos === null) stops[0].pos = 0;
      if (stops[stops.length - 1].pos === null) {
        stops[stops.length - 1].pos = 1;
      }
      let last = 0;
      for (let i = 0; i < stops.length; i++) {
        if (stops[i].pos === null) {
          let next = i;
          while (next < stops.length && stops[next].pos === null) next++;
          const span = stops[next].pos - last;
          for (let k = i; k < next; k++) {
            stops[k].pos = last + (span * (k - i + 1)) / (next - i + 1);
          }
          i = next - 1;
        }
        last = stops[i].pos;
        if (i > 0 && stops[i].pos < stops[i - 1].pos) {
          stops[i].pos = stops[i - 1].pos;
        }
      }
      return stops;
    }

    function repeatStops(stops) {
      if (stops.length < 2) return stops;
      const first = stops[0].pos;
      const period = stops[stops.length - 1].pos - first;
      if (period <= 0.0001) return stops;
      const out = [];
      const cycles = Math.min(Math.ceil(1 / period) + 1, 200);
      for (let c = -1; c < cycles; c++) {
        for (let i = 0; i < stops.length; i++) {
          const pos = stops[i].pos + period * c;
          if (pos < -period || pos > 1 + period) continue;
          out.push({
            color: stops[i].color,
            pos: Math.min(1, Math.max(0, pos)),
          });
        }
      }
      return out.length ? out : stops;
    }

    function resolvePosition(tokens, w, h, iw, ih) {
      let x = "50%";
      let y = "50%";
      if (tokens.length === 1) {
        x = tokens[0];
        y = "50%";
        if (tokens[0] === "top" || tokens[0] === "bottom") {
          y = tokens[0];
          x = "50%";
        }
      } else if (tokens.length >= 2) {
        x = tokens[0];
        y = tokens[1];
      }
      const map = {
        left: "0%",
        top: "0%",
        center: "50%",
        right: "100%",
        bottom: "100%",
      };
      if (map[x] !== undefined) x = map[x];
      if (map[y] !== undefined) y = map[y];
      const px =
        x.indexOf("%") !== -1
          ? (parseFloat(x) / 100) * (w - iw)
          : parseFloat(x) || 0;
      const py =
        y.indexOf("%") !== -1
          ? (parseFloat(y) / 100) * (h - ih)
          : parseFloat(y) || 0;
      return [px, py];
    }

    function makeGradient(ctx, spec, x, y, w, h) {
      const open = spec.indexOf("(");
      const kind = spec.slice(0, open);
      const body = spec.slice(open + 1, spec.lastIndexOf(")"));
      const parts = splitTopLevel(body);
      if (!parts.length) return null;
      const repeating = kind.indexOf("repeating-") === 0;
      const base = kind.replace("repeating-", "");

      if (base === "linear-gradient") {
        let angle = 180;
        if (/^(to\s|[-0-9.]+(deg|grad|rad|turn))/.test(parts[0])) {
          angle =
            parts[0].indexOf("to ") === 0
              ? sideAngle(parts[0], w, h)
              : parseAngle(parts[0]);
          parts.shift();
        }
        const rad = ((angle - 90) * Math.PI) / 180;
        const dx = Math.cos(rad);
        const dy = Math.sin(rad);
        const ar = (angle * Math.PI) / 180;
        const length = Math.abs(w * Math.sin(ar)) + Math.abs(h * Math.cos(ar));
        const cx = x + w / 2;
        const cy = y + h / 2;
        let stops = parseStops(parts, length);
        if (!stops.length) return null;
        if (repeating) stops = repeatStops(stops);
        const g = ctx.createLinearGradient(
          cx - (dx * length) / 2,
          cy - (dy * length) / 2,
          cx + (dx * length) / 2,
          cy + (dy * length) / 2,
        );
        stops.forEach((s) => {
          try {
            g.addColorStop(Math.min(1, Math.max(0, s.pos)), s.color);
          } catch (e) {}
        });
        return { gradient: g };
      }

      if (base === "radial-gradient") {
        let shape = "ellipse";
        let sizing = "farthest-corner";
        let posTokens = [];
        let explicit = [];
        if (!COLOR_TOKEN.test(parts[0]) || /\bat\b/.test(parts[0])) {
          const head = parts[0];
          const atIndex = head.indexOf(" at ");
          const geom = (atIndex === -1 ? head : head.slice(0, atIndex)).trim();
          if (atIndex !== -1) {
            posTokens = head
              .slice(atIndex + 4)
              .trim()
              .split(/\s+/);
          }
          geom.split(/\s+/).forEach((tok) => {
            if (tok === "circle" || tok === "ellipse") shape = tok;
            else if (/closest|farthest/.test(tok)) sizing = tok;
            else if (tok) explicit.push(tok);
          });
          if (geom || atIndex !== -1) parts.shift();
        }
        const cxy = posTokens.length
          ? resolvePosition(posTokens, w, h, 0, 0)
          : [w / 2, h / 2];
        const cx = x + cxy[0];
        const cy = y + cxy[1];
        const lx = cxy[0];
        const ly = cxy[1];
        let rx;
        let ry;
        if (explicit.length) {
          rx = resolveLength(explicit[0], w);
          ry = explicit.length > 1 ? resolveLength(explicit[1], h) : rx;
        } else {
          const dxs = [Math.abs(lx), Math.abs(w - lx)];
          const dys = [Math.abs(ly), Math.abs(h - ly)];
          const near = sizing.indexOf("closest") === 0;
          const sx = near ? Math.min(dxs[0], dxs[1]) : Math.max(dxs[0], dxs[1]);
          const sy = near ? Math.min(dys[0], dys[1]) : Math.max(dys[0], dys[1]);
          if (sizing.indexOf("side") !== -1) {
            rx = sx;
            ry = sy;
          } else {
            rx = Math.sqrt(sx * sx + sy * sy);
            ry = rx;
            if (shape === "ellipse") {
              rx = sx * Math.SQRT2;
              ry = sy * Math.SQRT2;
            }
          }
          if (shape === "circle") {
            rx =
              sizing.indexOf("closest") === 0
                ? Math.min(sx, sy)
                : Math.max(sx, sy);
            if (sizing.indexOf("corner") !== -1)
              rx = Math.sqrt(sx * sx + sy * sy);
            ry = rx;
          }
        }
        rx = Math.max(0.01, rx);
        ry = Math.max(0.01, ry);
        let stops = parseStops(parts, rx);
        if (!stops.length) return null;
        if (repeating) stops = repeatStops(stops);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
        stops.forEach((s) => {
          try {
            g.addColorStop(Math.min(1, Math.max(0, s.pos)), s.color);
          } catch (e) {}
        });
        return { gradient: g, scaleY: ry / rx, cx, cy };
      }

      if (base === "conic-gradient" && ctx.createConicGradient) {
        let from = 0;
        let posTokens = [];
        if (/^(from\s|at\s)/.test(parts[0])) {
          const head = parts[0];
          const atIndex = head.indexOf(" at ");
          const fromPart = atIndex === -1 ? head : head.slice(0, atIndex);
          if (fromPart.indexOf("from") === 0) {
            from = parseAngle(fromPart.replace("from", "").trim());
          }
          if (atIndex !== -1) {
            posTokens = head
              .slice(atIndex + 4)
              .trim()
              .split(/\s+/);
          }
          parts.shift();
        }
        const cxy = posTokens.length
          ? resolvePosition(posTokens, w, h, 0, 0)
          : [w / 2, h / 2];
        let stops = parseStops(parts, 360);
        if (!stops.length) return null;
        if (repeating) stops = repeatStops(stops);
        const g = ctx.createConicGradient(
          ((from - 90) * Math.PI) / 180,
          x + cxy[0],
          y + cxy[1],
        );
        stops.forEach((s) => {
          try {
            g.addColorStop(Math.min(1, Math.max(0, s.pos)), s.color);
          } catch (e) {}
        });
        return { gradient: g };
      }

      return null;
    }

    function boxFor(kind, node, style) {
      let x = node.x;
      let y = node.y;
      let w = node.w;
      let h = node.h;
      let radii = node.radii;
      const bt = parseFloat(style.borderTopWidth) || 0;
      const br = parseFloat(style.borderRightWidth) || 0;
      const bb = parseFloat(style.borderBottomWidth) || 0;
      const bl = parseFloat(style.borderLeftWidth) || 0;
      if (kind === "padding-box" || kind === "content-box") {
        x += bl;
        y += bt;
        w -= bl + br;
        h -= bt + bb;
        radii = insetRadii(radii, bt, br, bb, bl);
        if (kind === "content-box") {
          const pt = parseFloat(style.paddingTop) || 0;
          const pr = parseFloat(style.paddingRight) || 0;
          const pb = parseFloat(style.paddingBottom) || 0;
          const pl = parseFloat(style.paddingLeft) || 0;
          x += pl;
          y += pt;
          w -= pl + pr;
          h -= pt + pb;
          radii = insetRadii(radii, pt, pr, pb, pl);
        }
      }
      return { x, y, w: Math.max(0, w), h: Math.max(0, h), radii };
    }

    function tracePath(ctx, x, y, w, h, radii) {
      if (w <= 0 || h <= 0) return;
      if (!radii) {
        ctx.rect(x, y, w, h);
        return;
      }
      const [tl, tr, br, bl] = radii;
      const HALF = Math.PI / 2;
      ctx.moveTo(x + tl[0], y);
      ctx.lineTo(x + w - tr[0], y);
      if (tr[0] > 0 || tr[1] > 0) {
        ctx.ellipse(x + w - tr[0], y + tr[1], tr[0], tr[1], 0, -HALF, 0);
      }
      ctx.lineTo(x + w, y + h - br[1]);
      if (br[0] > 0 || br[1] > 0) {
        ctx.ellipse(x + w - br[0], y + h - br[1], br[0], br[1], 0, 0, HALF);
      }
      ctx.lineTo(x + bl[0], y + h);
      if (bl[0] > 0 || bl[1] > 0) {
        ctx.ellipse(x + bl[0], y + h - bl[1], bl[0], bl[1], 0, HALF, Math.PI);
      }
      ctx.lineTo(x, y + tl[1]);
      if (tl[0] > 0 || tl[1] > 0) {
        ctx.ellipse(
          x + tl[0],
          y + tl[1],
          tl[0],
          tl[1],
          0,
          Math.PI,
          Math.PI + HALF,
        );
      }
      ctx.closePath();
    }

    function borderBoxSize(el, style) {
      let w = parseFloat(style.width);
      let h = parseFloat(style.height);
      if (isNaN(w) || isNaN(h)) {
        if (typeof el.offsetWidth === "number" && el.offsetWidth) {
          return { w: el.offsetWidth, h: el.offsetHeight };
        }
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      }
      if (style.boxSizing !== "border-box") {
        w +=
          parseFloat(style.paddingLeft) +
          parseFloat(style.paddingRight) +
          parseFloat(style.borderLeftWidth) +
          parseFloat(style.borderRightWidth);
        h +=
          parseFloat(style.paddingTop) +
          parseFloat(style.paddingBottom) +
          parseFloat(style.borderTopWidth) +
          parseFloat(style.borderBottomWidth);
      }
      return { w, h };
    }

    function isStackingContext(el, style) {
      if (style.position !== "static" && style.zIndex !== "auto") return true;
      if (style.position === "fixed" || style.position === "sticky")
        return true;
      if (parseFloat(style.opacity) < 1) return true;
      if (style.transform && style.transform !== "none") return true;
      if (style.filter && style.filter !== "none") return true;
      if (style.isolation === "isolate") return true;
      if (style.mixBlendMode && style.mixBlendMode !== "normal") return true;
      if (/paint|layout|strict|content/.test(style.contain || "")) return true;
      if (style.webkitOverflowScrolling === "touch") return true;
      return false;
    }

    function measureRuns(el, style) {
      const runs = [];
      if (style.visibility !== "visible") return runs;

      const transform = style.textTransform;
      const kids = el.childNodes;
      let range = null;

      for (let i = 0; i < kids.length; i++) {
        const textNode = kids[i];
        if (textNode.nodeType !== 3) continue;
        const raw = textNode.data;
        if (!raw || !raw.trim()) continue;
        if (!range) range = document.createRange();

        const re = /\S+/g;
        let match;
        while ((match = re.exec(raw)) !== null) {
          try {
            range.setStart(textNode, match.index);
            range.setEnd(textNode, match.index + match[0].length);
          } catch (e) {
            continue;
          }
          const rects = range.getClientRects();
          if (!rects.length) continue;

          let text = match[0];
          if (transform === "uppercase") text = text.toUpperCase();
          else if (transform === "lowercase") text = text.toLowerCase();
          else if (transform === "capitalize") {
            text = text.replace(/\b\w/g, (c) => c.toUpperCase());
          }

          if (rects.length === 1) {
            const r = rects[0];
            runs.push({
              text,
              left: r.left,
              top: r.top,
              right: r.right,
              height: r.height,
            });
          } else {
            const per = Math.ceil(text.length / rects.length);
            for (let k = 0; k < rects.length; k++) {
              const slice = text.substr(k * per, per);
              if (!slice) continue;
              const r = rects[k];
              runs.push({
                text: slice,
                left: r.left,
                top: r.top,
                right: r.right,
                height: r.height,
              });
            }
          }
        }
      }

      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        const value = el.value || el.placeholder;
        if (value) runs.push({ text: value, value: true });
      }

      return runs;
    }

    function discoverAssets(el, style) {
      const layers = style.backgroundImage;
      if (layers && layers !== "none") layerUrls(layers).forEach(loadImage);
      const tag = el.tagName;
      if (tag === "IMG") {
        const src = el.currentSrc || el.src;
        if (src && !usableDomImage(el)) loadImage(src);
      } else if (tag === "svg") {
        svgToImage(el);
      }
    }

    function buildNode(el, parent, clips, ignore) {
      if (ignore && ignore(el)) return null;
      const style = getComputedStyle(el);
      if (style.display === "none") return null;

      const size = borderBoxSize(el, style);
      const rect = el.getBoundingClientRect();
      const B = parent ? parent.m : IDENT;
      const Blin = [B[0], B[1], B[2], B[3], 0, 0];
      const own = parseMatrix(style.transform);
      const N = own || IDENT;
      const Nlin = [N[0], N[1], N[2], N[3], 0, 0];
      const BN = mul(Blin, Nlin);

      let x;
      let y;
      let m;
      if (!own && (!parent || parent.untransformed)) {
        x = rect.left;
        y = rect.top;
        m = IDENT;
      } else {
        const o = parseOrigin(style.transformOrigin);
        const no = apply(Nlin, o[0], o[1]);
        const tv = [o[0] - no[0] + N[4], o[1] - no[1] + N[5]];
        const bt = apply(Blin, tv[0], tv[1]);
        const C = [bt[0] + B[4], bt[1] + B[5]];
        let minX = Infinity;
        let minY = Infinity;
        const corners = [
          [0, 0],
          [size.w, 0],
          [0, size.h],
          [size.w, size.h],
        ];
        for (let i = 0; i < corners.length; i++) {
          const p = apply(BN, corners[i][0], corners[i][1]);
          if (p[0] < minX) minX = p[0];
          if (p[1] < minY) minY = p[1];
        }
        const inv = invertLinear(Blin);
        if (!inv) return null;
        const u = apply(inv, rect.left - minX - C[0], rect.top - minY - C[1]);
        x = u[0];
        y = u[1];
        m = [BN[0], BN[1], BN[2], BN[3], C[0], C[1]];
      }

      const radii = parseRadii(style, size.w, size.h);
      const node = {
        el,
        style,
        x,
        y,
        w: size.w,
        h: size.h,
        m,
        radii,
        clips,
        opacity: parseFloat(style.opacity),
        untransformed: !own && (!parent || parent.untransformed),
        children: [],
        runs: measureRuns(el, style),
      };

      discoverAssets(el, style);

      if (
        CLIP_OVERFLOW.test(style.overflowX) ||
        CLIP_OVERFLOW.test(style.overflowY)
      ) {
        const bt = parseFloat(style.borderTopWidth);
        const br = parseFloat(style.borderRightWidth);
        const bb = parseFloat(style.borderBottomWidth);
        const bl = parseFloat(style.borderLeftWidth);
        node.childClips = clips.concat([
          {
            m,
            x: x + bl,
            y: y + bt,
            w: Math.max(0, size.w - bl - br),
            h: Math.max(0, size.h - bt - bb),
            radii: insetRadii(radii, bt, br, bb, bl),
          },
        ]);
      } else {
        node.childClips = clips;
      }

      return node;
    }

    function newStack(node) {
      return {
        node,
        negative: [],
        zeroOrAuto: [],
        positive: [],
        floats: [],
      };
    }

    function collect(node, stack, ignore) {
      if (node.el.tagName === "svg") return;
      const kids = node.el.children;
      for (let i = 0; i < kids.length; i++) {
        const child = buildNode(kids[i], node, node.childClips, ignore);
        if (!child) continue;
        const cs = child.style;
        if (isStackingContext(child.el, cs)) {
          const sub = newStack(child);
          collect(child, sub, ignore);
          const z =
            cs.position !== "static" && cs.zIndex !== "auto"
              ? parseInt(cs.zIndex, 10) || 0
              : 0;
          if (z < 0) stack.negative.push({ z, sub });
          else if (z > 0) stack.positive.push({ z, sub });
          else stack.zeroOrAuto.push(sub);
        } else if (cs.position !== "static") {
          const sub = newStack(child);
          collect(child, sub, ignore);
          stack.zeroOrAuto.push(sub);
        } else if (cs.float !== "none") {
          const sub = newStack(child);
          collect(child, sub, ignore);
          stack.floats.push(sub);
        } else {
          node.children.push(child);
          collect(child, stack, ignore);
        }
      }
    }

    function Painter(ctx, base) {
      this.ctx = ctx;
      this.base = base;
      this.activeClips = null;
      this.alphaStack = [];
    }

    Painter.prototype.space = function (m) {
      const d = mul(this.base, m);
      this.ctx.setTransform(d[0], d[1], d[2], d[3], d[4], d[5]);
    };

    Painter.prototype.setClips = function (clips) {
      if (this.activeClips === clips) return;
      const ctx = this.ctx;
      if (this.activeClips !== null) ctx.restore();
      ctx.save();
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        this.space(c.m);
        ctx.beginPath();
        tracePath(ctx, c.x, c.y, c.w, c.h, c.radii);
        ctx.clip();
      }
      this.activeClips = clips;
    };

    Painter.prototype.release = function () {
      if (this.activeClips !== null) {
        this.ctx.restore();
        this.activeClips = null;
      }
    };

    Painter.prototype.shadows = function (node) {
      const value = node.style.boxShadow;
      if (!value || value === "none") return;
      const ctx = this.ctx;
      const layers = splitTopLevel(value).reverse();
      for (let i = 0; i < layers.length; i++) {
        const raw = layers[i];
        const inset = raw.indexOf("inset") !== -1;
        const body = raw.replace("inset", "").trim();
        const colorMatch = body.match(
          /^(rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+\([^)]*\)|#[0-9a-f]+|[a-z]+)/i,
        );
        if (!colorMatch) continue;
        const color = colorMatch[0];
        if (isTransparent(color)) continue;
        const nums = body
          .slice(color.length)
          .trim()
          .split(/\s+/)
          .map((n) => parseFloat(n) || 0);
        const dx = nums[0] || 0;
        const dy = nums[1] || 0;
        const blur = nums[2] || 0;
        const spread = nums[3] || 0;

        ctx.save();
        this.space(node.m);
        if (inset) {
          ctx.beginPath();
          tracePath(ctx, node.x, node.y, node.w, node.h, node.radii);
          ctx.clip();
          const gx = node.x - node.w - 100;
          const gy = node.y - node.h - 100;
          ctx.beginPath();
          ctx.rect(gx, gy, node.w * 3 + 200, node.h * 3 + 200);
          tracePath(
            ctx,
            node.x + spread,
            node.y + spread,
            node.w - spread * 2,
            node.h - spread * 2,
            insetRadii(node.radii, spread, spread, spread, spread),
          );
          ctx.shadowColor = color;
          ctx.shadowOffsetX = dx;
          ctx.shadowOffsetY = dy;
          ctx.shadowBlur = blur;
          ctx.fillStyle = "#000";
          ctx.fill("evenodd");
        } else {
          ctx.beginPath();
          tracePath(ctx, node.x, node.y, node.w, node.h, node.radii);
          const gx = node.x - node.w - blur * 2 - Math.abs(dx) - spread - 100;
          const gy = node.y - node.h - blur * 2 - Math.abs(dy) - spread - 100;
          ctx.rect(
            gx,
            gy,
            node.w * 3 + blur * 4 + Math.abs(dx) * 2 + spread * 2 + 200,
            node.h * 3 + blur * 4 + Math.abs(dy) * 2 + spread * 2 + 200,
          );
          ctx.clip("evenodd");
          ctx.shadowColor = color;
          ctx.shadowOffsetX = dx;
          ctx.shadowOffsetY = dy;
          ctx.shadowBlur = blur;
          ctx.fillStyle = "#000";
          ctx.beginPath();
          tracePath(
            ctx,
            node.x - spread,
            node.y - spread,
            node.w + spread * 2,
            node.h + spread * 2,
            insetRadii(node.radii, -spread, -spread, -spread, -spread),
          );
          ctx.fill();
        }
        ctx.restore();
      }
    };

    Painter.prototype.background = function (node) {
      const style = node.style;
      const ctx = this.ctx;
      const images = style.backgroundImage;
      const hasImages = images && images !== "none";
      if (isTransparent(style.backgroundColor) && !hasImages) return;

      const clipList = splitTopLevel(style.backgroundClip || "border-box");
      const clipBox = boxFor(clipList[clipList.length - 1], node, style);
      if (clipBox.w <= 0 || clipBox.h <= 0) return;

      if (!isTransparent(style.backgroundColor)) {
        this.space(node.m);
        ctx.beginPath();
        tracePath(
          ctx,
          clipBox.x,
          clipBox.y,
          clipBox.w,
          clipBox.h,
          clipBox.radii,
        );
        ctx.fillStyle = style.backgroundColor;
        ctx.fill();
      }

      if (!hasImages) return;

      const layers = splitTopLevel(images);
      const originList = splitTopLevel(style.backgroundOrigin || "padding-box");
      const sizeList = splitTopLevel(style.backgroundSize || "auto");
      const posList = splitTopLevel(style.backgroundPosition || "0% 0%");
      const repeatList = splitTopLevel(style.backgroundRepeat || "repeat");
      const pick = (list, i) => list[i % list.length];

      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (!layer || layer === "none") continue;
        const lClip = boxFor(pick(clipList, i), node, style);
        const origin = boxFor(pick(originList, i), node, style);
        if (lClip.w <= 0 || lClip.h <= 0) continue;

        ctx.save();
        this.space(node.m);
        ctx.beginPath();
        tracePath(ctx, lClip.x, lClip.y, lClip.w, lClip.h, lClip.radii);
        ctx.clip();

        const urlMatch = layer.match(/^url\((['"]?)(.*?)\1\)$/);
        if (urlMatch) {
          const entry = imageCache.get(urlMatch[2]);
          if (entry && entry.ready) {
            this.tile(
              entry.img,
              origin,
              pick(sizeList, i),
              pick(posList, i),
              pick(repeatList, i),
            );
          }
        } else if (/gradient\(/.test(layer)) {
          try {
            const made = makeGradient(
              ctx,
              layer,
              origin.x,
              origin.y,
              origin.w,
              origin.h,
            );
            if (made) {
              ctx.fillStyle = made.gradient;
              if (made.scaleY && Math.abs(made.scaleY - 1) > 0.001) {
                const inv = 1 / made.scaleY;
                ctx.translate(made.cx, made.cy);
                ctx.scale(1, made.scaleY);
                ctx.translate(-made.cx, -made.cy);
                ctx.fillRect(
                  lClip.x,
                  made.cy + (lClip.y - made.cy) * inv,
                  lClip.w,
                  lClip.h * inv,
                );
              } else {
                ctx.fillRect(lClip.x, lClip.y, lClip.w, lClip.h);
              }
            }
          } catch (e) {}
        }
        ctx.restore();
      }
    };

    Painter.prototype.tile = function (img, area, size, position, repeat) {
      const ctx = this.ctx;
      const nw = img.naturalWidth || img.width;
      const nh = img.naturalHeight || img.height;
      if (!nw || !nh) return;

      let dw;
      let dh;
      const ratio = nw / nh;
      if (size === "cover" || size === "contain") {
        const areaRatio = area.w / area.h;
        const wide = size === "cover" ? areaRatio < ratio : areaRatio > ratio;
        if (wide) {
          dh = area.h;
          dw = dh * ratio;
        } else {
          dw = area.w;
          dh = dw / ratio;
        }
      } else {
        const tokens = (size || "auto").split(/\s+/);
        const sx = tokens[0] || "auto";
        const sy = tokens[1] || "auto";
        if (sx === "auto" && sy === "auto") {
          dw = nw;
          dh = nh;
        } else if (sx === "auto") {
          dh = resolveLength(sy, area.h);
          dw = dh * ratio;
        } else if (sy === "auto") {
          dw = resolveLength(sx, area.w);
          dh = dw / ratio;
        } else {
          dw = resolveLength(sx, area.w);
          dh = resolveLength(sy, area.h);
        }
      }
      if (dw <= 0 || dh <= 0) return;

      const offset = resolvePosition(
        (position || "0% 0%").split(/\s+/),
        area.w,
        area.h,
        dw,
        dh,
      );
      const ox = area.x + offset[0];
      const oy = area.y + offset[1];

      if (repeat === "no-repeat") {
        ctx.drawImage(img, ox, oy, dw, dh);
        return;
      }

      const repeatX = repeat !== "repeat-y";
      const repeatY = repeat !== "repeat-x";
      const mode =
        repeatX && repeatY ? "repeat" : repeatX ? "repeat-x" : "repeat-y";
      const pattern = ctx.createPattern(img, mode);
      if (!pattern) return;

      if (pattern.setTransform && typeof DOMMatrix !== "undefined") {
        pattern.setTransform(new DOMMatrix([dw / nw, 0, 0, dh / nh, ox, oy]));
        ctx.fillStyle = pattern;
        ctx.fillRect(
          repeatX ? area.x : ox,
          repeatY ? area.y : oy,
          repeatX ? area.w : dw,
          repeatY ? area.h : dh,
        );
        return;
      }

      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(dw / nw, dh / nh);
      ctx.fillStyle = pattern;
      ctx.fillRect(
        ((repeatX ? area.x : ox) - ox) / (dw / nw),
        ((repeatY ? area.y : oy) - oy) / (dh / nh),
        (repeatX ? area.w : dw) / (dw / nw),
        (repeatY ? area.h : dh) / (dh / nh),
      );
      ctx.restore();
    };

    Painter.prototype.replaced = function (node) {
      const el = node.el;
      const tag = el.tagName;
      if (tag === "VIDEO" || tag === "IFRAME") return;

      let source = null;
      if (tag === "IMG") {
        if (usableDomImage(el)) {
          source = el;
        } else {
          const entry = imageCache.get(el.currentSrc || el.src);
          if (entry && entry.ready) source = entry.img;
        }
      } else if (tag === "CANVAS") {
        source = el.width && el.height ? el : null;
      } else if (tag === "svg") {
        const cached = svgCache.get(el);
        if (cached && cached.entry.ready) source = cached.entry.img;
      }
      if (!source) return;

      const style = node.style;
      const box = boxFor("content-box", node, style);
      if (box.w <= 0 || box.h <= 0) return;

      const nw = source.naturalWidth || source.width || box.w;
      const nh = source.naturalHeight || source.height || box.h;
      if (!nw || !nh) return;

      const fit = style.objectFit || "fill";
      let dw = box.w;
      let dh = box.h;
      if (fit !== "fill") {
        const ratio = nw / nh;
        const areaRatio = box.w / box.h;
        if (fit === "contain" || fit === "scale-down") {
          if (areaRatio > ratio) {
            dh = box.h;
            dw = dh * ratio;
          } else {
            dw = box.w;
            dh = dw / ratio;
          }
          if (fit === "scale-down" && (dw > nw || dh > nh)) {
            dw = nw;
            dh = nh;
          }
        } else if (fit === "cover") {
          if (areaRatio < ratio) {
            dh = box.h;
            dw = dh * ratio;
          } else {
            dw = box.w;
            dh = dw / ratio;
          }
        } else if (fit === "none") {
          dw = nw;
          dh = nh;
        }
      }

      const offset = resolvePosition(
        (style.objectPosition || "50% 50%").split(/\s+/),
        box.w,
        box.h,
        dw,
        dh,
      );

      const ctx = this.ctx;
      ctx.save();
      this.space(node.m);
      ctx.beginPath();
      tracePath(ctx, box.x, box.y, box.w, box.h, box.radii);
      ctx.clip();
      try {
        ctx.drawImage(source, box.x + offset[0], box.y + offset[1], dw, dh);
      } catch (e) {}
      ctx.restore();
    };

    Painter.prototype.text = function (node) {
      const style = node.style;
      const ctx = this.ctx;
      const strokeWidth = parseFloat(style.webkitTextStrokeWidth) || 0;
      if (isTransparent(style.color) && strokeWidth <= 0) return;

      this.setClips(node.clips);
      this.space(node.m);

      const fontSize = parseFloat(style.fontSize) || 16;
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
      if ("letterSpacing" in ctx) {
        ctx.letterSpacing =
          style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
      }
      if ("wordSpacing" in ctx) {
        ctx.wordSpacing =
          style.wordSpacing === "normal" ? "0px" : style.wordSpacing;
      }
      const rtl = style.direction === "rtl";
      ctx.direction = rtl ? "rtl" : "ltr";
      ctx.textAlign = rtl ? "right" : "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = style.color;

      const strokeColor = style.webkitTextStrokeColor;
      const strokeFirst = (style.paintOrder || "").indexOf("stroke") === 0;

      const shadows = [];
      if (style.textShadow && style.textShadow !== "none") {
        splitTopLevel(style.textShadow).forEach((raw) => {
          const cm = raw.match(COLOR_TOKEN);
          if (!cm || isTransparent(cm[0])) return;
          const nums = raw
            .slice(cm[0].length)
            .trim()
            .split(/\s+/)
            .map((n) => parseFloat(n) || 0);
          shadows.push({
            color: cm[0],
            dx: nums[0] || 0,
            dy: nums[1] || 0,
            blur: nums[2] || 0,
          });
        });
      }

      const inv = node.untransformed ? null : invert(node.m);
      const toLocal = (px, py) => (inv ? apply(inv, px, py) : [px, py]);
      const scaleY = inv ? Math.hypot(inv[2], inv[3]) : 1;

      const decoration = style.textDecorationLine;
      const decorate =
        decoration && decoration !== "none"
          ? {
              color: style.textDecorationColor || style.color,
              under: decoration.indexOf("underline") !== -1,
              through: decoration.indexOf("line-through") !== -1,
              over: decoration.indexOf("overline") !== -1,
            }
          : null;

      const draw = (text, run) => {
        if (!text) return;
        const local = toLocal(run.left, run.top);
        const metrics = ctx.measureText(text);
        const ascent =
          metrics.fontBoundingBoxAscent ||
          metrics.actualBoundingBoxAscent ||
          fontSize * 0.8;
        const descent =
          metrics.fontBoundingBoxDescent ||
          metrics.actualBoundingBoxDescent ||
          fontSize * 0.2;
        const boxH = run.height * scaleY;
        const baseline = local[1] + (boxH - (ascent + descent)) / 2 + ascent;
        const anchor = rtl ? toLocal(run.right, run.top)[0] : local[0];

        for (let s = 0; s < shadows.length; s++) {
          const sh = shadows[s];
          ctx.save();
          ctx.shadowColor = sh.color;
          ctx.shadowOffsetX = sh.dx;
          ctx.shadowOffsetY = sh.dy;
          ctx.shadowBlur = sh.blur;
          ctx.fillText(text, anchor, baseline);
          ctx.restore();
        }

        const strokeIt = () => {
          if (strokeWidth <= 0 || isTransparent(strokeColor)) return;
          ctx.save();
          ctx.lineWidth = strokeWidth * 2;
          ctx.strokeStyle = strokeColor;
          ctx.lineJoin = "round";
          ctx.strokeText(text, anchor, baseline);
          ctx.restore();
        };

        if (strokeFirst) strokeIt();
        ctx.fillText(text, anchor, baseline);
        if (!strokeFirst) strokeIt();

        if (decorate) {
          const width = metrics.width;
          const x0 = rtl ? anchor - width : anchor;
          const thickness = Math.max(1, fontSize / 14);
          ctx.save();
          ctx.fillStyle = decorate.color;
          if (decorate.under) {
            ctx.fillRect(x0, baseline + thickness * 1.5, width, thickness);
          }
          if (decorate.through) {
            ctx.fillRect(x0, baseline - ascent / 3, width, thickness);
          }
          if (decorate.over) {
            ctx.fillRect(x0, baseline - ascent, width, thickness);
          }
          ctx.restore();
        }
      };

      const runs = node.runs;
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        if (run.value) {
          const box = boxFor("content-box", node, style);
          const metrics = ctx.measureText(run.text);
          const ascent = metrics.fontBoundingBoxAscent || fontSize * 0.8;
          const descent = metrics.fontBoundingBoxDescent || fontSize * 0.2;
          const baseline = box.y + (box.h - (ascent + descent)) / 2 + ascent;
          ctx.fillText(run.text, rtl ? box.x + box.w : box.x, baseline);
        } else {
          draw(run.text, run);
        }
      }
    };

    Painter.prototype.borders = function (node) {
      const style = node.style;
      const widths = [
        parseFloat(style.borderTopWidth) || 0,
        parseFloat(style.borderRightWidth) || 0,
        parseFloat(style.borderBottomWidth) || 0,
        parseFloat(style.borderLeftWidth) || 0,
      ];
      const styles = [
        style.borderTopStyle,
        style.borderRightStyle,
        style.borderBottomStyle,
        style.borderLeftStyle,
      ];
      const colors = [
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor,
      ];
      let any = false;
      for (let i = 0; i < 4; i++) {
        if (
          widths[i] > 0 &&
          styles[i] !== "none" &&
          styles[i] !== "hidden" &&
          !isTransparent(colors[i])
        ) {
          any = true;
          break;
        }
      }
      if (!any) return;

      const ctx = this.ctx;
      const inner = insetRadii(
        node.radii,
        widths[0],
        widths[1],
        widths[2],
        widths[3],
      );
      const ix = node.x + widths[3];
      const iy = node.y + widths[0];
      const iw = Math.max(0, node.w - widths[1] - widths[3]);
      const ih = Math.max(0, node.h - widths[0] - widths[2]);

      const uniform =
        colors[0] === colors[1] &&
        colors[1] === colors[2] &&
        colors[2] === colors[3] &&
        styles[0] === styles[1] &&
        styles[1] === styles[2] &&
        styles[2] === styles[3] &&
        styles[0] === "solid";

      this.space(node.m);

      if (uniform) {
        ctx.beginPath();
        tracePath(ctx, node.x, node.y, node.w, node.h, node.radii);
        tracePath(ctx, ix, iy, iw, ih, inner);
        ctx.fillStyle = colors[0];
        ctx.fill("evenodd");
        return;
      }

      const wedges = [
        [
          [node.x, node.y],
          [node.x + node.w, node.y],
          [ix + iw, iy],
          [ix, iy],
        ],
        [
          [node.x + node.w, node.y],
          [node.x + node.w, node.y + node.h],
          [ix + iw, iy + ih],
          [ix + iw, iy],
        ],
        [
          [node.x + node.w, node.y + node.h],
          [node.x, node.y + node.h],
          [ix, iy + ih],
          [ix + iw, iy + ih],
        ],
        [
          [node.x, node.y + node.h],
          [node.x, node.y],
          [ix, iy],
          [ix, iy + ih],
        ],
      ];

      for (let i = 0; i < 4; i++) {
        if (
          widths[i] <= 0 ||
          styles[i] === "none" ||
          styles[i] === "hidden" ||
          isTransparent(colors[i])
        ) {
          continue;
        }
        ctx.save();
        this.space(node.m);
        const wedge = wedges[i];
        ctx.beginPath();
        ctx.moveTo(wedge[0][0], wedge[0][1]);
        for (let p = 1; p < wedge.length; p++) {
          ctx.lineTo(wedge[p][0], wedge[p][1]);
        }
        ctx.closePath();
        ctx.clip();
        ctx.beginPath();
        tracePath(ctx, node.x, node.y, node.w, node.h, node.radii);
        tracePath(ctx, ix, iy, iw, ih, inner);
        ctx.fillStyle = colors[i];
        ctx.fill("evenodd");
        ctx.restore();
      }
    };

    Painter.prototype.node = function (node) {
      if (node.style.visibility !== "visible") return;
      if (node.w <= 0 || node.h <= 0) return;
      this.setClips(node.clips);
      this.shadows(node);
      this.background(node);
      this.borders(node);
      this.replaced(node);
    };

    const OP_BOX = 0;
    const OP_TEXT = 1;
    const OP_ALPHA_PUSH = 2;
    const OP_ALPHA_POP = 3;

    function emitInFlowBoxes(node, out) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        out.push({ t: OP_BOX, node: child });
        emitInFlowBoxes(child, out);
      }
    }

    function emitInFlowText(node, out) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.runs.length) out.push({ t: OP_TEXT, node: child });
        emitInFlowText(child, out);
      }
    }

    function emitStack(stack, out) {
      const alpha = stack.node.opacity;
      const fade = !isNaN(alpha) && alpha < 1;
      if (fade) out.push({ t: OP_ALPHA_PUSH, alpha });

      out.push({ t: OP_BOX, node: stack.node });

      const byZ = (a, b) => a.z - b.z;
      stack.negative.sort(byZ);
      for (let i = 0; i < stack.negative.length; i++) {
        emitStack(stack.negative[i].sub, out);
      }

      emitInFlowBoxes(stack.node, out);

      if (stack.node.runs.length) out.push({ t: OP_TEXT, node: stack.node });
      emitInFlowText(stack.node, out);

      for (let i = 0; i < stack.floats.length; i++) {
        emitStack(stack.floats[i], out);
      }
      for (let i = 0; i < stack.zeroOrAuto.length; i++) {
        emitStack(stack.zeroOrAuto[i], out);
      }
      stack.positive.sort(byZ);
      for (let i = 0; i < stack.positive.length; i++) {
        emitStack(stack.positive[i].sub, out);
      }

      if (fade) out.push({ t: OP_ALPHA_POP });
    }

    Painter.prototype.run = function (ops, from, budgetMs) {
      const ctx = this.ctx;
      const deadline = budgetMs ? performance.now() + budgetMs : 0;
      for (let i = from; i < ops.length; i++) {
        const op = ops[i];
        if (op.t === OP_BOX) {
          this.node(op.node);
        } else if (op.t === OP_TEXT) {
          this.text(op.node);
        } else if (op.t === OP_ALPHA_PUSH) {
          this.release();
          this.alphaStack.push(ctx.globalAlpha);
          ctx.globalAlpha = ctx.globalAlpha * op.alpha;
        } else {
          this.release();
          ctx.globalAlpha = this.alphaStack.pop();
        }
        if (deadline && (i & 63) === 0 && performance.now() > deadline) {
          return i + 1;
        }
      }
      return ops.length;
    };

    function measure(element, options) {
      const opts = options || {};
      const scale = opts.scale || 1;
      const ignore = opts.ignoreElements || null;

      pending = [];
      const root = buildNode(element, null, [], ignore);
      if (!root) return null;
      if (opts.rootOpacity != null) root.opacity = opts.rootOpacity;

      const stack = newStack(root);
      collect(root, stack, ignore);

      const ops = [];
      emitStack(stack, ops);

      let base = [scale, 0, 0, scale, -root.x * scale, -root.y * scale];
      if (!root.untransformed) {
        const rootInv = invert(root.m);
        if (rootInv) base = mul(base, rootInv);
      }

      const assets = pending;
      pending = [];

      return {
        root,
        ops,
        base,
        scale,
        assets,
        width: opts.width != null ? opts.width : root.w,
        height: opts.height != null ? opts.height : root.h,
        backgroundColor: opts.backgroundColor || null,
      };
    }

    function prepareCanvas(plan, canvas) {
      const cw = Math.max(1, Math.round(plan.width * plan.scale));
      const ch = Math.max(1, Math.round(plan.height * plan.scale));
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;

      const ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (plan.backgroundColor) {
        ctx.fillStyle = plan.backgroundColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      return ctx;
    }

    function paint(plan, canvas, region) {
      const ctx = region
        ? canvas.getContext("2d")
        : prepareCanvas(plan, canvas);
      if (region) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.rect(region.x, region.y, region.w, region.h);
        ctx.clip();
        ctx.clearRect(region.x, region.y, region.w, region.h);
        if (plan.backgroundColor) {
          ctx.fillStyle = plan.backgroundColor;
          ctx.fillRect(region.x, region.y, region.w, region.h);
        }
      }
      const painter = new Painter(ctx, plan.base);
      painter.run(plan.ops, 0, 0);
      painter.release();
      if (region) ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return canvas;
    }

    const BOX_PAINT = [
      "visibility",
      "boxShadow",
      "backgroundColor",
      "backgroundImage",
      "backgroundClip",
      "backgroundOrigin",
      "backgroundSize",
      "backgroundPosition",
      "backgroundRepeat",
      "objectFit",
      "objectPosition",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "borderTopStyle",
      "borderRightStyle",
      "borderBottomStyle",
      "borderLeftStyle",
      "borderTopColor",
      "borderRightColor",
      "borderBottomColor",
      "borderLeftColor",
    ];
    const TEXT_PAINT = [
      "color",
      "fontStyle",
      "fontWeight",
      "fontSize",
      "fontFamily",
      "letterSpacing",
      "wordSpacing",
      "direction",
      "textShadow",
      "webkitTextStrokeWidth",
      "webkitTextStrokeColor",
      "paintOrder",
      "textDecorationLine",
      "textDecorationColor",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
    ];

    function paintLayer(plan, canvas, previous, force) {
      const records = [];
      let supported = true;
      const geometry = (box) => {
        const m = mul(plan.base, box.m);
        if (m[0] !== plan.scale || m[1] || m[2] || m[3] !== plan.scale)
          supported = false;
        return [
          box.x * m[0] + m[4],
          box.y * m[3] + m[5],
          box.w * m[0],
          box.h * m[3],
          box.radii,
        ];
      };
      for (const op of plan.ops) {
        const node = op.node;
        if (!node) {
          records.push({ type: op.t, key: op.alpha });
          continue;
        }
        const bounds = geometry(node);
        const clips = node.clips.map(geometry);
        if (!supported) {
          paint(plan, canvas);
          return { records: null, changed: true };
        }
        const inv = op.t === OP_TEXT ? invert(node.m) : null;
        const m = op.t === OP_TEXT ? mul(plan.base, node.m) : null;
        const runs = (op.t === OP_TEXT ? node.runs : []).map((run) => {
          const local =
            inv && !run.value ? apply(inv, run.left, run.top) : [0, 0];
          return [
            run.text,
            run.value,
            local[0] * m[0] + m[4],
            local[1] * m[3] + m[5],
            run.right - run.left,
            run.height,
          ];
        });
        const style = node.style;
        const source = svgCache.get(node.el)?.entry;
        records.push({
          type: op.t,
          el: node.el,
          bounds,
          source,
          volatile:
            op.t === OP_BOX &&
            (node.el.tagName === "IMG" ||
              node.el.tagName === "CANVAS" ||
              style.backgroundImage.includes("url(")),
          bounded:
            op.t === OP_BOX && (!style.boxShadow || style.boxShadow === "none"),
          key: JSON.stringify([
            bounds,
            clips,
            op.t === OP_TEXT ? runs : null,
            (op.t === OP_TEXT ? TEXT_PAINT : BOX_PAINT).map(
              (name) => style[name],
            ),
            source?.ready,
          ]),
        });
      }
      let full =
        force ||
        !supported ||
        !previous?.records ||
        previous.records.length !== records.length ||
        previous.width !== plan.width ||
        previous.height !== plan.height ||
        previous.scale !== plan.scale;
      let left = Infinity,
        top = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      if (!full) {
        for (let i = 0; i < records.length; i++) {
          const next = records[i],
            old = previous.records[i];
          if (next.type !== old.type || next.el !== old.el) {
            full = true;
            break;
          }
          if (
            next.key === old.key &&
            next.source === old.source &&
            !next.volatile
          )
            continue;
          if (!next.bounded || !old.bounded) {
            full = true;
            break;
          }
          for (const record of [old, next]) {
            const [x, y, w, h] = record.bounds;
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x + w);
            bottom = Math.max(bottom, y + h);
          }
        }
      }
      const x = Math.max(0, Math.floor(left) - 2);
      const y = Math.max(0, Math.floor(top) - 2);
      const w = Math.min(canvas.width, Math.ceil(right) + 2) - x;
      const h = Math.min(canvas.height, Math.ceil(bottom) + 2) - y;
      const changed = full || (w > 0 && h > 0);
      if (changed) paint(plan, canvas, full ? null : { x, y, w, h });
      return {
        records: supported ? records : null,
        width: plan.width,
        height: plan.height,
        scale: plan.scale,
        changed,
      };
    }

    function nextTask() {
      return new Promise((resolve) => {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(() => resolve(), { timeout: 32 });
        } else {
          setTimeout(resolve, 0);
        }
      });
    }

    async function paintChunked(plan, canvas, budgetMs) {
      const ctx = prepareCanvas(plan, canvas);
      const painter = new Painter(ctx, plan.base);
      let index = 0;
      while (index < plan.ops.length) {
        index = painter.run(plan.ops, index, budgetMs);
        if (index < plan.ops.length) await nextTask();
      }
      painter.release();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return canvas;
    }

    function rasterise(element, options) {
      const opts = options || {};
      const canvas = opts.canvas || document.createElement("canvas");
      const plan = measure(element, opts);
      if (!plan) {
        canvas.width = Math.max(
          1,
          Math.round((opts.width || 1) * (opts.scale || 1)),
        );
        canvas.height = Math.max(
          1,
          Math.round((opts.height || 1) * (opts.scale || 1)),
        );
        return canvas;
      }
      return paint(plan, canvas);
    }

    async function rasteriseAsync(element, options) {
      const opts = options || {};
      const canvas = opts.canvas || document.createElement("canvas");
      let plan = measure(element, opts);
      if (!plan) {
        canvas.width = Math.max(
          1,
          Math.round((opts.width || 1) * (opts.scale || 1)),
        );
        canvas.height = Math.max(
          1,
          Math.round((opts.height || 1) * (opts.scale || 1)),
        );
        return canvas;
      }
      if (plan.assets.length) {
        await Promise.all(plan.assets);
        plan = measure(element, opts) || plan;
      }
      return paintChunked(plan, canvas, opts.budgetMs || 8);
    }

    return {
      measure,
      paint,
      paintLayer,
      paintChunked,
      rasterise,
      rasteriseAsync,
    };
  })();

  /* --------------------------------------------------
   *  Render backends
   * ------------------------------------------------*/
  class LiquidShadowCache {
    constructor(backend) {
      this.backend = backend;
      this.entries = new Map();
      const glsl = `
        precision highp float;
        varying vec2 uv;
        uniform sampler2D source;
        uniform vec4 a;
        uniform vec4 b;
        uniform vec4 c;
        uniform vec4 d;
        void main() {
          float value = 0.0;
          if (d.z < 0.5) {
            vec2 point = uv * a.xy - b.xy;
            float f = b.w > 0.0 ? 1.0 - smoothstep(0.0, b.w, length(point - c.xy)) : 0.0;
            point -= c.zw * f;
            vec2 q = abs(point - a.zw * 0.5) - a.zw * 0.5 + b.z;
            float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - b.z;
            value = 1.0 - smoothstep(-1.0, 1.0, distance);
          } else {
            float total = 0.0;
            for (int i = -15; i <= 15; i++) {
              float weight = exp(-0.5 * float(i * i) / 25.0);
              value += texture2D(source, uv + d.xy * float(i)).r * weight;
              total += weight;
            }
            value /= total;
          }
          gl_FragColor = vec4(value, 0.0, 0.0, 1.0);
        }`;
      const wgsl = `
        struct Params { a: vec4<f32>, b: vec4<f32>, c: vec4<f32>, d: vec4<f32> };
        @group(0) @binding(0) var source: texture_2d<f32>;
        @group(0) @binding(1) var samp: sampler;
        @group(0) @binding(2) var<uniform> p: Params;
        struct Out { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
        @vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
          let vertices = array<vec2<f32>, 6>(vec2<f32>(-1,-1), vec2<f32>(1,-1), vec2<f32>(-1,1), vec2<f32>(-1,1), vec2<f32>(1,-1), vec2<f32>(1,1));
          var out: Out;
          out.pos = vec4<f32>(vertices[i], 0, 1);
          out.uv = vec2<f32>(vertices[i].x, -vertices[i].y) * 0.5 + vec2<f32>(0.5);
          return out;
        }
        @fragment fn fs(in: Out) -> @location(0) vec4<f32> {
          var value = 0.0;
          if (p.d.z < 0.5) {
            var point = in.uv * p.a.xy - p.b.xy;
            var f = 0.0;
            if (p.b.w > 0.0) { f = 1.0 - smoothstep(0.0, p.b.w, length(point - p.c.xy)); }
            point -= p.c.zw * f;
            let q = abs(point - p.a.zw * 0.5) - p.a.zw * 0.5 + vec2<f32>(p.b.z);
            let distance = length(max(q, vec2<f32>(0))) + min(max(q.x, q.y), 0.0) - p.b.z;
            value = 1.0 - smoothstep(-1.0, 1.0, distance);
          } else {
            var total = 0.0;
            for (var i = -15; i <= 15; i++) {
              let weight = exp(-0.5 * f32(i * i) / 25.0);
              value += textureSampleLevel(source, samp, in.uv + p.d.xy * f32(i), 0.0).r * weight;
              total += weight;
            }
            value /= total;
          }
          return vec4<f32>(value, 0, 0, 1);
        }`;
      if (backend.gl) {
        const gl = backend.gl;
        this.program = createProgram(
          gl,
          `attribute vec2 a_position; varying vec2 uv; void main(){ uv=(a_position+1.0)*0.5; gl_Position=vec4(a_position,0,1); }`,
          glsl,
        );
        this.pos = gl.getAttribLocation(this.program, "a_position");
        this.uniforms = ["a", "b", "c", "d"].map((name) =>
          gl.getUniformLocation(this.program, name),
        );
        this.source = gl.getUniformLocation(this.program, "source");
        this.fbo = gl.createFramebuffer();
      } else {
        const module = backend.device.createShaderModule({ code: wgsl });
        this.pipeline = backend.device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs" },
          fragment: {
            module,
            entryPoint: "fs",
            targets: [{ format: "rgba8unorm" }],
          },
          primitive: { topology: "triangle-list" },
        });
      }
    }

    get(lens, p) {
      const backend = this.backend;
      const gl = backend.gl;
      if (!p.shadow) {
        const old = this.entries.get(lens);
        if (old) {
          old.textures.forEach((t) => (gl ? gl.deleteTexture(t) : t.destroy()));
          if (old.buffer) old.buffer.destroy();
          this.entries.delete(lens);
        }
        p.shadowMapping = INTERACTION_OFF;
        return null;
      }
      const w = p.boxW / p.dpr,
        h = p.boxH / p.dpr;
      const margin = Math.ceil(Math.min(w, h) * 0.6) + 60;
      const tw = Math.ceil((w + margin * 2) / 2),
        th = Math.ceil((h + margin * 2) / 2);
      p.shadowMapping = [
        margin / (tw * 2),
        (margin - 10) / (th * 2),
        w / (tw * 2),
        h / (th * 2),
      ];
      let entry = this.entries.get(lens);
      if (entry && (entry.w !== tw || entry.h !== th)) {
        entry.textures.forEach((t) => (gl ? gl.deleteTexture(t) : t.destroy()));
        if (entry.buffer) entry.buffer.destroy();
        entry = null;
      }
      if (!entry) {
        entry = { w: tw, h: th, textures: [] };
        for (let i = 0; i < 2; i++) {
          if (gl) {
            const texture = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.RGBA,
              tw,
              th,
              0,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              null,
            );
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(
              gl.TEXTURE_2D,
              gl.TEXTURE_WRAP_S,
              gl.CLAMP_TO_EDGE,
            );
            gl.texParameteri(
              gl.TEXTURE_2D,
              gl.TEXTURE_WRAP_T,
              gl.CLAMP_TO_EDGE,
            );
            entry.textures.push(texture);
          } else {
            entry.textures.push(
              backend.device.createTexture({
                size: [tw, th],
                format: "rgba8unorm",
                usage:
                  GPUTextureUsage.TEXTURE_BINDING |
                  GPUTextureUsage.RENDER_ATTACHMENT,
              }),
            );
          }
        }
        if (!gl) {
          entry.buffer = backend.device.createBuffer({
            size: 768,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          entry.groups = [1, 0, 1].map((source, i) =>
            backend.device.createBindGroup({
              layout: this.pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: entry.textures[source].createView() },
                { binding: 1, resource: backend._sampler },
                {
                  binding: 2,
                  resource: { buffer: entry.buffer, offset: i * 256, size: 64 },
                },
              ],
            }),
          );
        }
        this.entries.set(lens, entry);
      }
      const active = p.interactionRadius > 0;
      const data = [
        tw * 2,
        th * 2,
        w,
        h,
        margin,
        margin,
        p.radius / p.dpr,
        p.interactionRadius * Math.min(w, h),
        active ? p.interaction[0] * w : 0,
        active ? p.interaction[1] * h : 0,
        active ? p.interaction[2] * w : 0,
        active ? p.interaction[3] * h : 0,
      ];
      const key = data.join(",");
      if (entry.key === key) return entry;
      entry.key = key;
      if (gl) {
        gl.disable(gl.BLEND);
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, backend._posBuf);
        gl.enableVertexAttribArray(this.pos);
        gl.vertexAttribPointer(this.pos, 2, gl.FLOAT, false, 0, 0);
        gl.uniform1i(this.source, 0);
        for (let j = 0; j < 3; j++)
          gl.uniform4fv(this.uniforms[j], data.slice(j * 4, j * 4 + 4));
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.viewport(0, 0, tw, th);
        for (let i = 0; i < 3; i++) {
          gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            entry.textures[i % 2],
            0,
          );
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, entry.textures[1 - (i % 2)]);
          gl.uniform4f(
            this.uniforms[3],
            i === 1 ? 1.5 / tw : 0,
            i === 2 ? 1.5 / th : 0,
            i ? 1 : 0,
            0,
          );
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        backend._restoreLensProgramState();
      } else {
        const uniforms = new Float32Array(192);
        for (let i = 0; i < 3; i++) {
          uniforms.set(data, i * 64);
          uniforms[i * 64 + 12] = i === 1 ? 1.5 / tw : 0;
          uniforms[i * 64 + 13] = i === 2 ? 1.5 / th : 0;
          uniforms[i * 64 + 14] = i ? 1 : 0;
        }
        backend.device.queue.writeBuffer(entry.buffer, 0, uniforms);
        for (let i = 0; i < 3; i++) {
          const pass = backend._enc.beginRenderPass({
            colorAttachments: [
              {
                view: entry.textures[i % 2].createView(),
                loadOp: "clear",
                storeOp: "store",
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
              },
            ],
          });
          pass.setPipeline(this.pipeline);
          pass.setBindGroup(0, entry.groups[i]);
          pass.draw(6);
          pass.end();
        }
      }
      return entry;
    }
  }

  function backdropFilter(style) {
    const value = style.backdropFilter || style.webkitBackdropFilter || "none";
    if (value === "none") return null;
    let variance = 0;
    let saturation = 1;
    const rest = value.replace(
      /(blur|saturate)\(\s*([\d.]+)(px|%)?\s*\)/g,
      (_, name, number, unit) => {
        const amount = Number(number);
        if (name === "blur" && (unit === "px" || amount === 0))
          variance += amount * amount;
        else if (name === "saturate" && unit !== "px")
          saturation *= amount / (unit === "%" ? 100 : 1);
        else return _;
        return "";
      },
    );
    return rest.trim() ? null : { blur: Math.sqrt(variance), saturation };
  }

  class LiquidBackdropFilter {
    constructor(backend) {
      this.backend = backend;
      this.entries = new Map();
      const glsl = `
        precision highp float;
        varying vec2 uv;
        uniform sampler2D page;
        uniform sampler2D source;
        uniform vec4 area, box, snapshot, screen, filter, radii, view;
        vec4 backdrop(vec2 point) {
          vec4 base = texture2D(page, (point - snapshot.xy) / snapshot.zw);
          vec2 coord = clamp(point / screen.xy, 0.0, 1.0);
          vec4 lower = texture2D(source, vec2(coord.x, 1.0 - coord.y));
          return lower + base * (1.0 - lower.a);
        }
        void main() {
          vec2 point = filter.w < 0.5 ? area.xy + uv * area.zw : view.xy + uv * view.zw;
          vec4 color = vec4(0.0);
          float total = 0.0;
          for (int i = -15; i <= 15; i++) {
            float weight = exp(-0.5 * float(i * i) / 25.0);
            float offset = float(i) * filter.x / 5.0;
            if (filter.w < 0.5) color += backdrop(point + vec2(offset, 0.0)) * weight;
            else {
              vec2 coord = (point + vec2(0.0, offset) - area.xy) / area.zw;
              color += texture2D(source, vec2(coord.x, 1.0 - coord.y)) * weight;
            }
            total += weight;
          }
          color /= total;
          if (filter.w > 0.5) {
            float grey = dot(color.rgb, vec3(0.213, 0.715, 0.072));
            color.rgb = clamp(mix(vec3(grey), color.rgb, filter.y), 0.0, color.a);
            vec2 local = point - box.xy - box.zw * 0.5;
            float radius = local.y < 0.0 ? (local.x < 0.0 ? radii.x : radii.y) : (local.x < 0.0 ? radii.w : radii.z);
            vec2 q = abs(local) - box.zw * 0.5 + radius;
            float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
            color *= (1.0 - smoothstep(-screen.z, screen.z, distance)) * filter.z;
          }
          gl_FragColor = color;
        }`;
      const wgsl = `
        struct Params { area: vec4<f32>, box: vec4<f32>, snapshot: vec4<f32>, screen: vec4<f32>, effect: vec4<f32>, radii: vec4<f32>, view: vec4<f32> };
        @group(0) @binding(0) var page: texture_2d<f32>;
        @group(0) @binding(1) var source: texture_2d<f32>;
        @group(0) @binding(2) var samp: sampler;
        @group(0) @binding(3) var<uniform> p: Params;
        struct Out { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
        @vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
          let vertices = array<vec2<f32>, 6>(vec2<f32>(-1,-1), vec2<f32>(1,-1), vec2<f32>(-1,1), vec2<f32>(-1,1), vec2<f32>(1,-1), vec2<f32>(1,1));
          var out: Out;
          out.pos = vec4<f32>(vertices[i], 0, 1);
          out.uv = vec2<f32>(vertices[i].x, -vertices[i].y) * 0.5 + vec2<f32>(0.5);
          return out;
        }
        fn backdrop(point: vec2<f32>) -> vec4<f32> {
          let base = textureSampleLevel(page, samp, (point - p.snapshot.xy) / p.snapshot.zw, 0.0);
          let lower = textureSampleLevel(source, samp, clamp(point / p.screen.xy, vec2<f32>(0), vec2<f32>(1)), 0.0);
          return lower + base * (1.0 - lower.a);
        }
        @fragment fn fs(in: Out) -> @location(0) vec4<f32> {
          let point = select(p.area.xy + in.uv * p.area.zw, p.view.xy + in.uv * p.view.zw, p.effect.w > 0.5);
          var color = vec4<f32>(0);
          var total = 0.0;
          for (var i = -15; i <= 15; i++) {
            let weight = exp(-0.5 * f32(i * i) / 25.0);
            let offset = f32(i) * p.effect.x / 5.0;
            if (p.effect.w < 0.5) { color += backdrop(point + vec2<f32>(offset, 0)) * weight; }
            else { color += textureSampleLevel(source, samp, (point + vec2<f32>(0, offset) - p.area.xy) / p.area.zw, 0.0) * weight; }
            total += weight;
          }
          color /= total;
          if (p.effect.w > 0.5) {
            let grey = dot(color.rgb, vec3<f32>(0.213, 0.715, 0.072));
            color = vec4<f32>(clamp(mix(vec3<f32>(grey), color.rgb, p.effect.y), vec3<f32>(0), vec3<f32>(color.a)), color.a);
            let local = point - p.box.xy - p.box.zw * 0.5;
            let radius = select(select(p.radii.z, p.radii.w, local.x < 0.0), select(p.radii.y, p.radii.x, local.x < 0.0), local.y < 0.0);
            let q = abs(local) - p.box.zw * 0.5 + vec2<f32>(radius);
            let distance = length(max(q, vec2<f32>(0))) + min(max(q.x, q.y), 0.0) - radius;
            color *= (1.0 - smoothstep(-p.screen.z, p.screen.z, distance)) * p.effect.z;
          }
          return color;
        }`;
      if (backend.gl) {
        const gl = backend.gl;
        this.program = createProgram(
          gl,
          `attribute vec2 a_position; varying vec2 uv; void main(){ uv=vec2(a_position.x,-a_position.y)*0.5+0.5; gl_Position=vec4(a_position,0,1); }`,
          glsl,
        );
        this.pos = gl.getAttribLocation(this.program, "a_position");
        this.uniforms = [
          "area",
          "box",
          "snapshot",
          "screen",
          "filter",
          "radii",
          "view",
        ].map((name) => gl.getUniformLocation(this.program, name));
        this.page = gl.getUniformLocation(this.program, "page");
        this.source = gl.getUniformLocation(this.program, "source");
        this.fbo = gl.createFramebuffer();
      } else {
        const module = backend.device.createShaderModule({ code: wgsl });
        this.pipeline = backend.device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs" },
          fragment: {
            module,
            entryPoint: "fs",
            targets: [
              {
                format: backend.format,
                blend: {
                  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                },
              },
            ],
          },
          primitive: { topology: "triangle-list" },
        });
      }
    }

    draw(content, rect, viewport) {
      const backend = this.backend;
      const gl = backend.gl;
      const renderer = backend.renderer;
      const origin = renderer._frameCanvasRect;
      rect = {
        left: rect.left - origin.left,
        top: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
      };
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const filter = content.backdrop;
      const margin = Math.ceil(filter.blur * 3);
      const area = [
        rect.left - margin,
        rect.top - margin,
        rect.width + margin * 2,
        rect.height + margin * 2,
      ];
      const scale = Math.min(
        dpr,
        filter.blur > 0 ? 5 / filter.blur : dpr,
        backend.maxTextureSize / Math.max(area[2], area[3]),
      );
      const w = Math.max(1, Math.ceil(area[2] * scale));
      const h = Math.max(1, Math.ceil(area[3] * scale));
      let entry = this.entries.get(content);
      if (entry && (entry.w !== w || entry.h !== h)) {
        if (gl) gl.deleteTexture(entry.texture);
        else {
          entry.texture.destroy();
          entry.buffer.destroy();
        }
        entry = null;
      }
      if (!entry) {
        entry = { w, h };
        if (gl) {
          entry.texture = gl.createTexture();
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, entry.texture);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            w,
            h,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            null,
          );
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        } else {
          entry.texture = backend.device.createTexture({
            size: [w, h],
            format: backend.format,
            usage:
              GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.RENDER_ATTACHMENT,
          });
          entry.buffer = backend.device.createBuffer({
            size: 512,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
        }
        this.entries.set(content, entry);
      }
      const snap = renderer.snapshotTarget.getBoundingClientRect();
      const data = [
        ...area,
        rect.left,
        rect.top,
        rect.width,
        rect.height,
        snap.left - origin.left,
        snap.top - origin.top,
        renderer.textureWidth / renderer.scaleFactor,
        renderer.textureHeight / renderer.scaleFactor,
        backend.canvas.width / dpr,
        backend.canvas.height / dpr,
        0.5 / dpr,
        0,
        filter.blur,
        filter.saturation,
        content.opacity,
        0,
        ...content.backdropRadii,
        viewport.x / dpr,
        viewport.y / dpr,
        viewport.w / dpr,
        viewport.h / dpr,
      ];
      if (gl) {
        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, backend._posBuf);
        gl.enableVertexAttribArray(this.pos);
        gl.vertexAttribPointer(this.pos, 2, gl.FLOAT, false, 0, 0);
        gl.uniform1i(this.page, 0);
        gl.uniform1i(this.source, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, backend.texture);
        for (let i = 0; i < 2; i++) {
          data[19] = i;
          this.uniforms.forEach((uniform, j) =>
            gl.uniform4fv(uniform, data.slice(j * 4, j * 4 + 4)),
          );
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(
            gl.TEXTURE_2D,
            i ? entry.texture : backend._compositeTexture,
          );
          if (!i) {
            gl.disable(gl.BLEND);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
            gl.framebufferTexture2D(
              gl.FRAMEBUFFER,
              gl.COLOR_ATTACHMENT0,
              gl.TEXTURE_2D,
              entry.texture,
              0,
            );
            gl.viewport(0, 0, w, h);
          } else {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.bindFramebuffer(gl.FRAMEBUFFER, backend._compositeFbo);
            gl.viewport(
              viewport.x,
              backend.canvas.height - viewport.y - viewport.h,
              viewport.w,
              viewport.h,
            );
          }
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        backend._restoreLensProgramState();
      } else {
        const device = backend.device;
        const uniforms = new Float32Array(128);
        uniforms.set(data);
        uniforms.set(data, 64);
        uniforms[83] = 1;
        device.queue.writeBuffer(entry.buffer, 0, uniforms);
        if (
          entry.page !== backend.texture ||
          entry.composite !== backend._compositeTexture
        ) {
          entry.page = backend.texture;
          entry.composite = backend._compositeTexture;
          entry.groups = [backend._compositeTexture, entry.texture].map(
            (source, i) =>
              device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: backend.texture.createView() },
                  { binding: 1, resource: source.createView() },
                  { binding: 2, resource: backend._sampler },
                  {
                    binding: 3,
                    resource: {
                      buffer: entry.buffer,
                      offset: i * 256,
                      size: 112,
                    },
                  },
                ],
              }),
          );
        }
        for (let i = 0; i < 2; i++) {
          const pass = backend._enc.beginRenderPass({
            colorAttachments: [
              {
                view: (i
                  ? backend._compositeTexture
                  : entry.texture
                ).createView(),
                loadOp: i ? "load" : "clear",
                storeOp: "store",
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
              },
            ],
          });
          pass.setPipeline(this.pipeline);
          pass.setBindGroup(0, entry.groups[i]);
          if (i)
            pass.setViewport(
              viewport.x,
              viewport.y,
              viewport.w,
              viewport.h,
              0,
              1,
            );
          pass.draw(6);
          pass.end();
        }
      }
    }
  }

  function uploadScaledVideo(
    backend,
    video,
    x,
    y,
    width,
    height,
    rect,
    source = video,
  ) {
    const videoWidth = source.displayWidth || video.videoWidth;
    const videoHeight = source.displayHeight || video.videoHeight;
    if (
      videoWidth * videoHeight <=
      (rect.fullWidth ?? width) * (rect.fullHeight ?? height) * 4
    )
      return false;
    const canvas = (backend._scaledVideo ||= document.createElement("canvas"));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    try {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(
        source,
        rect.u * videoWidth,
        rect.v * videoHeight,
        rect.uw * videoWidth,
        rect.vh * videoHeight,
        0,
        0,
        width,
        height,
      );
      backend.uploadRegion(x, y, canvas);
      return true;
    } catch (e) {
      return false;
    }
  }

  class WebGLBackend {
    constructor(canvas, contexts = ["webgl2", "webgl", "experimental-webgl"]) {
      this.kind = "webgl";
      this.canvas = canvas;

      const ctxAttribs = {
        alpha: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
      };
      let gl = null;
      for (const name of contexts) {
        gl = canvas.getContext(name, ctxAttribs);
        if (gl) break;
      }
      if (!gl) throw new Error("liquidGL: WebGL unavailable");

      this.gl = gl;
      this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 8192;
      this.texture = null;

      this._initLensProgram();
    }

    _initLensProgram() {
      const vsSource = `
        attribute vec2 a_position;
        varying vec2 v_uv;
        void main(){
          v_uv = (a_position + 1.0) * 0.5;
          gl_Position = vec4(a_position, 0.0, 1.0);
        }`;

      const fsSource = `
        #ifdef GL_FRAGMENT_PRECISION_HIGH
        precision highp float;
        #else
        precision mediump float;
        #endif
        varying vec2 v_uv;
        uniform sampler2D u_tex;
        uniform vec2  u_resolution;
        uniform vec2  u_textureResolution;
        uniform vec4  u_bounds;
        uniform float u_refraction;
        uniform float u_aberration;
        uniform float u_bevelDepth;
        uniform float u_bevelWidth;
        uniform float u_frost;
        uniform float u_radius;
        uniform float u_time;
        uniform bool  u_specular;
        uniform float u_revealProgress;
        uniform int   u_revealType;
        uniform float u_tiltX;
        uniform float u_tiltY;
        uniform float u_magnify;
        uniform vec2  u_subpixel;
        uniform vec2  u_boxSize;
        uniform vec4  u_tint;
        uniform sampler2D u_stack;
        uniform vec4 u_stackMapping;
        uniform vec4 u_stackRegion;
        uniform vec4 u_interaction;
        uniform float u_interactionRadius;
        uniform sampler2D u_shadow;
        uniform vec4 u_shadowMapping;

        vec4 sampleSource(vec2 uv) {
          vec4 background = texture2D(u_tex, uv);
          vec2 screenUV = u_stackMapping.xy + uv * u_stackMapping.zw;
          if (u_stackRegion.z > 0.0 &&
              all(greaterThanEqual(screenUV, u_stackRegion.xy)) &&
              all(lessThanEqual(screenUV, u_stackRegion.xy + u_stackRegion.zw))) {
            vec4 lower = texture2D(u_stack, vec2(screenUV.x, 1.0 - screenUV.y));
            return lower + background * (1.0 - lower.a);
          }
          return background;
        }

        float udRoundBox( vec2 p, vec2 b, float r ) {
          return length(max(abs(p)-b+r,0.0))-r;
        }

        vec2 cornerNormal( vec2 p, vec2 b, float r, vec2 fallback ) {
          vec2 q = abs(p) - b + r;
          vec2 m = max(q, 0.0);
          float l = length(m);
          if (l <= 0.0) return fallback;
          float w = smoothstep(0.0, max(r * 0.5, 1.0), min(m.x, m.y));
          if (w <= 0.0) return fallback;
          vec2 s = vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
          return normalize(mix(fallback, s * (m / l), w));
        }

        float random(vec2 st) {
          return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
        }

        vec2 deformPoint(vec2 point) {
          if (u_interactionRadius <= 0.0) return point;
          vec2 centre = (vec2(u_interaction.x, 1.0 - u_interaction.y) - 0.5) * u_boxSize;
          float reach = u_interactionRadius * min(u_boxSize.x, u_boxSize.y);
          float influence = 1.0 - smoothstep(0.0, reach, length(point - centre));
          return point - vec2(u_interaction.z, -u_interaction.w) * u_boxSize * influence;
        }

        float edgeFactor(vec2 p_px, vec2 b_px, float radius_px){
          float d = -udRoundBox(p_px, b_px, radius_px);
          float bevel_px = u_bevelWidth * min(u_boxSize.x, u_boxSize.y);
          return 1.0 - smoothstep(0.0, bevel_px, d);
        }
        void main(){
          vec2 lensUV = (v_uv * u_resolution - u_subpixel) / u_boxSize;
          vec2 originalPoint = (lensUV - 0.5) * u_boxSize;
          vec2 p_px = deformPoint(originalPoint);
          vec2 b_px = 0.5 * u_boxSize;
          vec2 p = p_px / u_boxSize.y;
          float dmask = udRoundBox(p_px, b_px, u_radius);
          float inShape = 1.0 - smoothstep(-0.5, 0.5, dmask);
          float shadowAlpha = 0.0;
          if (u_shadowMapping.z > 0.0 && inShape < 1.0) {
            vec2 shadowUV = u_shadowMapping.xy + vec2(lensUV.x, 1.0 - lensUV.y) * u_shadowMapping.zw;
            shadowAlpha = texture2D(u_shadow, shadowUV).r * 0.1 * (1.0 - inShape);
            if (u_revealType == 1) shadowAlpha *= u_revealProgress;
            float noise = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715))));
            shadowAlpha = floor(shadowAlpha * 255.0 + noise) / 255.0;
          }
          if (inShape <= 0.0) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, shadowAlpha);
            return;
          }

          float edge = edgeFactor(p_px, b_px, u_radius);
          float min_dimension = min(u_resolution.x, u_resolution.y);
          float offsetAmt = (edge * u_refraction + pow(edge, 10.0) * u_bevelDepth);
          float centreBlend = smoothstep(0.15, 0.45, length(p));
          vec2 refractDir = cornerNormal(p_px, b_px, u_radius, normalize(p + vec2(0.000001)));
          if (u_interactionRadius > 0.0) {
            vec2 gradient = vec2(
              udRoundBox(deformPoint(originalPoint + vec2(0.5, 0.0)), b_px, u_radius) - udRoundBox(deformPoint(originalPoint - vec2(0.5, 0.0)), b_px, u_radius),
              udRoundBox(deformPoint(originalPoint + vec2(0.0, 0.5)), b_px, u_radius) - udRoundBox(deformPoint(originalPoint - vec2(0.0, 0.5)), b_px, u_radius)
            );
            if (length(gradient) > 0.0001) refractDir = normalize(mix(refractDir, normalize(gradient), min(length(p_px - originalPoint), 1.0)));
          }
          vec2 offset = refractDir * offsetAmt * centreBlend;

          float tiltRefractionScale = 0.05;
          vec2 tiltOffset = vec2(tan(radians(u_tiltY)), -tan(radians(u_tiltX))) * tiltRefractionScale;

          vec2 localUV = (lensUV - 0.5) / u_magnify + 0.5;
          vec2 flippedUV = vec2(localUV.x, 1.0 - localUV.y);
          vec2 mapped = u_bounds.xy + flippedUV * u_bounds.zw;
          vec2 refracted = mapped + offset - tiltOffset;

          float oob = max(max(-refracted.x, refracted.x - 1.0), max(-refracted.y, refracted.y - 1.0));
          float blend = 1.0 - smoothstep(0.0, 0.01, oob);
          vec2 sampleUV = mix(mapped, refracted, blend);

          vec4 baseCol   = sampleSource(mapped);

          vec2 texel = 1.0 / u_textureResolution;
          vec4 refrCol;

          vec2 chroma = offset * u_aberration;

          if (u_frost > 0.0) {
              float radius = u_frost * 4.0;
              vec4 sum = vec4(0.0);
              const int SAMPLES = 16;

              for (int i = 0; i < SAMPLES; i++) {
                  float angle = random(v_uv + float(i)) * 6.283185;
                  float dist = sqrt(random(v_uv - float(i))) * radius;
                  vec2 foff = vec2(cos(angle), sin(angle)) * texel * dist;
                  if (u_aberration > 0.0) {
                      sum.r += sampleSource(sampleUV + foff - chroma).r;
                      sum.g += sampleSource(sampleUV + foff).g;
                      sum.b += sampleSource(sampleUV + foff + chroma).b;
                      sum.a += sampleSource(sampleUV + foff).a;
                  } else {
                      sum += sampleSource(sampleUV + foff);
                  }
              }
              refrCol = sum / float(SAMPLES);
          } else {
              refrCol = sampleSource(sampleUV);
              refrCol += sampleSource(sampleUV + vec2( texel.x, 0.0));
              refrCol += sampleSource(sampleUV + vec2(-texel.x, 0.0));
              refrCol += sampleSource(sampleUV + vec2(0.0,  texel.y));
              refrCol += sampleSource(sampleUV + vec2(0.0, -texel.y));
              refrCol /= 5.0;

              if (u_aberration > 0.0) {
                  refrCol.r = sampleSource(sampleUV - chroma).r;
                  refrCol.b = sampleSource(sampleUV + chroma).b;
              }
          }

          if (refrCol.a < 0.1) {
              refrCol = baseCol;
          }

          float diff = clamp(length(refrCol.rgb - baseCol.rgb) * 4.0, 0.0, 1.0);

          float antiHalo = (1.0 - centreBlend) * diff;

          vec4 final    = refrCol;

          final.rgb = mix(final.rgb, final.rgb * u_tint.rgb, u_tint.a);

          if (u_specular) {
            vec2 lp1 = vec2(sin(u_time*0.2), cos(u_time*0.3))*0.6 + 0.5;
            vec2 lp2 = vec2(sin(u_time*-0.4+1.5), cos(u_time*0.25-0.5))*0.6 + 0.5;
            float h = 0.0;
            h += smoothstep(0.4,0.0,distance((p_px + b_px) / u_boxSize, lp1))*0.1;
            h += smoothstep(0.5,0.0,distance((p_px + b_px) / u_boxSize, lp2))*0.08;
            final.rgb += h;
          }

          if (u_revealType == 1) {
              final.rgb *= u_revealProgress;
              final.a  *= u_revealProgress;
          }

          final.rgb *= inShape;
          final.a = final.a * inShape + shadowAlpha;

          gl_FragColor = final;
        }`;

      const gl = this.gl;
      this.program = createProgram(gl, vsSource, fsSource);
      if (!this.program) throw new Error("liquidGL: Shader failed");

      const posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );

      const posLoc = gl.getAttribLocation(this.program, "a_position");
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      this._posBuf = posBuf;
      this._posLoc = posLoc;

      this.u = {
        tex: gl.getUniformLocation(this.program, "u_tex"),
        res: gl.getUniformLocation(this.program, "u_resolution"),
        textureResolution: gl.getUniformLocation(
          this.program,
          "u_textureResolution",
        ),
        bounds: gl.getUniformLocation(this.program, "u_bounds"),
        refraction: gl.getUniformLocation(this.program, "u_refraction"),
        aberration: gl.getUniformLocation(this.program, "u_aberration"),
        bevelDepth: gl.getUniformLocation(this.program, "u_bevelDepth"),
        bevelWidth: gl.getUniformLocation(this.program, "u_bevelWidth"),
        frost: gl.getUniformLocation(this.program, "u_frost"),
        radius: gl.getUniformLocation(this.program, "u_radius"),
        time: gl.getUniformLocation(this.program, "u_time"),
        specular: gl.getUniformLocation(this.program, "u_specular"),
        revealProgress: gl.getUniformLocation(this.program, "u_revealProgress"),
        revealType: gl.getUniformLocation(this.program, "u_revealType"),
        tiltX: gl.getUniformLocation(this.program, "u_tiltX"),
        tiltY: gl.getUniformLocation(this.program, "u_tiltY"),
        magnify: gl.getUniformLocation(this.program, "u_magnify"),
        subpixel: gl.getUniformLocation(this.program, "u_subpixel"),
        boxSize: gl.getUniformLocation(this.program, "u_boxSize"),
        tint: gl.getUniformLocation(this.program, "u_tint"),
        stack: gl.getUniformLocation(this.program, "u_stack"),
        stackMapping: gl.getUniformLocation(this.program, "u_stackMapping"),
        stackRegion: gl.getUniformLocation(this.program, "u_stackRegion"),
        shadow: gl.getUniformLocation(this.program, "u_shadow"),
        shadowMapping: gl.getUniformLocation(this.program, "u_shadowMapping"),
        interaction: gl.getUniformLocation(this.program, "u_interaction"),
        interactionRadius: gl.getUniformLocation(
          this.program,
          "u_interactionRadius",
        ),
      };
    }

    drawContent(content, rect) {
      const p = contentViewport(
        rect,
        this.canvas,
        this.renderer._frameCanvasRect,
      );
      if (!p || !this._initVideoBlit()) return false;
      if (content.backdrop) {
        this._backdrops ||= new LiquidBackdropFilter(this);
        this._backdrops.draw(content, rect, p);
      }
      const gl = this.gl;
      this._contents ||= new Map();
      let entry = this._contents.get(content);
      if (!entry) {
        entry = { texture: gl.createTexture(), version: -1 };
        this._contents.set(content, entry);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      if (entry.version !== content.version) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          content.canvas,
        );
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        entry.version = content.version;
      }
      gl.useProgram(this._vProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._posBuf);
      gl.enableVertexAttribArray(this._vPosLoc);
      gl.vertexAttribPointer(this._vPosLoc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1i(this._vU.src, 0);
      gl.uniform1f(this._vU.opacity, 1);
      gl.uniform4f(
        this._vU.srcRect,
        p.uv[0],
        p.uv[1] + p.uv[3],
        p.uv[2],
        -p.uv[3],
      );
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._compositeFbo);
      gl.viewport(p.x, this.canvas.height - p.y - p.h, p.w, p.h);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._restoreLensProgramState();
      return true;
    }

    resize() {
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    uploadSnapshot(srcCanvas) {
      const gl = this.gl;
      if (!this.texture) this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        srcCanvas,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._vFboTexture = null;
      this._textureWidth = srcCanvas.width;
      this._textureHeight = srcCanvas.height;
      return true;
    }

    uploadRegion(x, y, source, sx = 0, sy = 0) {
      if (!this.texture || !source) return;
      const w = Math.min(source.width - sx, this._textureWidth - x);
      const h = Math.min(source.height - sy, this._textureHeight - y);
      if (w <= 0 || h <= 0 || x < 0 || y < 0) return;
      if (sx || sy || w !== source.width || h !== source.height) {
        const crop = (this._regionCanvas ||= document.createElement("canvas"));
        if (crop.width !== w) crop.width = w;
        if (crop.height !== h) crop.height = h;
        const ctx = crop.getContext("2d");
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(source, sx, sy, w, h, 0, 0, w, h);
        source = crop;
      }
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        x,
        y,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source,
      );
      this.renderer._invalidateDynamicRegion(x, y, w, h);
    }

    _initVideoBlit() {
      if (this._vBlitReady !== undefined) return this._vBlitReady;

      const gl = this.gl;

      const vs = `
        attribute vec2 a_position;
        varying vec2 v_uv;
        void main(){
          v_uv = (a_position + 1.0) * 0.5;
          gl_Position = vec4(a_position, 0.0, 1.0);
        }`;

      const fs = `
        precision mediump float;
        varying vec2 v_uv;
        uniform sampler2D u_src;
        uniform vec4 u_srcRect;
        uniform float u_opacity;
        void main(){
          gl_FragColor = texture2D(u_src, u_srcRect.xy + v_uv * u_srcRect.zw) * u_opacity;
        }`;

      const prog = createProgram(gl, vs, fs);
      if (!prog) {
        this._vBlitReady = false;
        return false;
      }

      this._vProg = prog;
      this._vPosLoc = gl.getAttribLocation(prog, "a_position");
      this._vU = {
        src: gl.getUniformLocation(prog, "u_src"),
        srcRect: gl.getUniformLocation(prog, "u_srcRect"),
        opacity: gl.getUniformLocation(prog, "u_opacity"),
      };

      this._vTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._vTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);

      this._vFbo = gl.createFramebuffer();
      this._vFboTexture = null;

      this._vBlitReady = true;
      return true;
    }

    _restoreLensProgramState() {
      const gl = this.gl;
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._posBuf);
      gl.enableVertexAttribArray(this._posLoc);
      gl.vertexAttribPointer(this._posLoc, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(this.u.tex, 0);
    }

    blitVideo(vid, dstX, dstY, dstW, dstH, srcRect, source = vid) {
      if (!this.texture) return false;
      if (uploadScaledVideo(this, vid, dstX, dstY, dstW, dstH, srcRect, source))
        return true;
      if (!this._initVideoBlit()) return false;
      const gl = this.gl;

      gl.bindFramebuffer(gl.FRAMEBUFFER, this._vFbo);

      if (this._vFboTexture !== this.texture) {
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          this.texture,
          0,
        );
        if (
          gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE
        ) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          this._vBlitReady = false;
          return false;
        }
        this._vFboTexture = this.texture;
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._vTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

      try {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          source,
        );
      } catch (e) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this._restoreLensProgramState();
        return false;
      }

      gl.useProgram(this._vProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._posBuf);
      gl.enableVertexAttribArray(this._vPosLoc);
      gl.vertexAttribPointer(this._vPosLoc, 2, gl.FLOAT, false, 0, 0);

      gl.uniform1i(this._vU.src, 0);
      gl.uniform1f(this._vU.opacity, 1);
      gl.uniform4f(
        this._vU.srcRect,
        srcRect.u,
        srcRect.v,
        srcRect.uw,
        srcRect.vh,
      );

      gl.viewport(dstX, dstY, dstW, dstH);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.renderer._invalidateDynamicRegion(dstX, dstY, dstW, dstH);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._restoreLensProgramState();

      return true;
    }

    compositeVideo(layers, x, y, width, height) {
      if (this._videoFadeFailed || !this.texture || !this._initVideoBlit())
        return false;
      const gl = this.gl;
      this._videoContents ||= new Map();
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._vFbo);
        if (this._vFboTexture !== this.texture) {
          gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            this.texture,
            0,
          );
          if (
            gl.checkFramebufferStatus(gl.FRAMEBUFFER) !==
            gl.FRAMEBUFFER_COMPLETE
          )
            return false;
          this._vFboTexture = this.texture;
        }
        gl.useProgram(this._vProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._posBuf);
        gl.enableVertexAttribArray(this._vPosLoc);
        gl.vertexAttribPointer(this._vPosLoc, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(this._vU.src, 0);
        gl.uniform4f(this._vU.srcRect, 0, 0, 1, 1);
        gl.viewport(x, y, width, height);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        for (const { content, opacity } of layers) {
          let entry = this._videoContents.get(content);
          if (!entry) {
            entry = { texture: gl.createTexture(), version: -1 };
            this._videoContents.set(content, entry);
            gl.bindTexture(gl.TEXTURE_2D, entry.texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(
              gl.TEXTURE_2D,
              gl.TEXTURE_WRAP_S,
              gl.CLAMP_TO_EDGE,
            );
            gl.texParameteri(
              gl.TEXTURE_2D,
              gl.TEXTURE_WRAP_T,
              gl.CLAMP_TO_EDGE,
            );
          }
          gl.bindTexture(gl.TEXTURE_2D, entry.texture);
          if (entry.version !== content.version) {
            if (entry.width === width && entry.height === height) {
              gl.texSubImage2D(
                gl.TEXTURE_2D,
                0,
                0,
                0,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                content.canvas,
              );
            } else {
              gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                content.canvas,
              );
              entry.width = width;
              entry.height = height;
            }
            entry.version = content.version;
          }
          gl.uniform1f(this._vU.opacity, opacity);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        this.renderer._invalidateDynamicRegion(x, y, width, height);
        return true;
      } catch (e) {
        this._videoFadeFailed = true;
        return false;
      } finally {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this._restoreLensProgramState();
      }
    }

    beginFrame(width, height, time, composite = false) {
      const gl = this.gl;
      this._compositeActive = composite;
      if (composite) {
        if (!this._compositeTexture) {
          this._compositeTexture = gl.createTexture();
          this._compositeFbo = gl.createFramebuffer();
        }
        if (
          this._compositeWidth !== width ||
          this._compositeHeight !== height
        ) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this._compositeTexture);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            width,
            height,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            null,
          );
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.bindFramebuffer(gl.FRAMEBUFFER, this._compositeFbo);
          gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            this._compositeTexture,
            0,
          );
          this._compositeWidth = width;
          this._compositeHeight = height;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._compositeFbo);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(this.u.tex, 0);
      gl.uniform1f(this.u.time, time);
    }

    drawLens(lens, p) {
      const gl = this.gl;
      if (p.shadow && !this._shadows)
        this._shadows = new LiquidShadowCache(this);
      const shadow = this._shadows ? this._shadows.get(lens, p) : null;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, shadow ? shadow.textures[0] : this.texture);
      gl.uniform1i(this.u.shadow, 2);
      gl.uniform4fv(
        this.u.shadowMapping,
        shadow ? p.shadowMapping : INTERACTION_OFF,
      );
      gl.activeTexture(gl.TEXTURE1);
      if (p.stackRegion) {
        if (!this._stackTexture) this._stackTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._stackTexture);
        if (
          this._stackWidth !== this.canvas.width ||
          this._stackHeight !== this.canvas.height
        ) {
          this._stackWidth = this.canvas.width;
          this._stackHeight = this.canvas.height;
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            this._stackWidth,
            this._stackHeight,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            null,
          );
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
        const r = p.stackRegion;
        if (this._compositeActive)
          gl.bindFramebuffer(gl.FRAMEBUFFER, this._compositeFbo);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.x, r.y, r.w, r.h);
        if (this._compositeActive) gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.uniform4f(
          this.u.stackRegion,
          r.x / this.canvas.width,
          (this.canvas.height - r.y - r.h) / this.canvas.height,
          r.w / this.canvas.width,
          r.h / this.canvas.height,
        );
      } else {
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.uniform4f(this.u.stackRegion, 0, 0, 0, 0);
      }
      gl.uniform1i(this.u.stack, 1);
      gl.uniform4fv(this.u.stackMapping, p.stackMapping);
      gl.uniform4fv(this.u.interaction, p.interaction);
      gl.uniform1f(this.u.interactionRadius, p.interactionRadius);
      gl.activeTexture(gl.TEXTURE0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.viewport(p.x, p.y, p.w, p.h);
      gl.uniform2f(this.u.res, p.w, p.h);
      gl.uniform2f(this.u.subpixel, p.subX, p.subY);
      gl.uniform2f(this.u.boxSize, p.boxW, p.boxH);
      gl.uniform4f(
        this.u.bounds,
        p.bounds[0],
        p.bounds[1],
        p.bounds[2],
        p.bounds[3],
      );
      gl.uniform2f(this.u.textureResolution, p.texW, p.texH);
      gl.uniform1f(this.u.refraction, p.refraction);
      gl.uniform1f(this.u.aberration, p.aberration);
      gl.uniform1f(this.u.bevelDepth, p.bevelDepth);
      gl.uniform1f(this.u.bevelWidth, p.bevelWidth);
      gl.uniform1f(this.u.frost, p.frost);
      gl.uniform1f(this.u.radius, p.radius);
      gl.uniform1i(this.u.specular, p.specular);
      gl.uniform1f(this.u.revealProgress, p.revealProgress);
      gl.uniform1i(this.u.revealType, p.revealType);
      gl.uniform1f(this.u.magnify, p.magnify);
      gl.uniform1f(this.u.tiltX, p.tiltX);
      gl.uniform1f(this.u.tiltY, p.tiltY);
      gl.uniform4f(this.u.tint, p.tint[0], p.tint[1], p.tint[2], p.tint[3]);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (this._compositeActive) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._compositeFbo);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    }

    endFrame() {
      this.gl.disable(this.gl.BLEND);
    }

    clearRegions(rects) {
      const gl = this.gl;
      rects.forEach(({ x, y, w, h }) => {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(x, y, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.SCISSOR_TEST);
      });
    }
  }

  /* --------------------------------------------------
   *  WGSL sources (WebGPU backend)
   * ------------------------------------------------*/
  const WEBGPU_LENS_WGSL = `
struct LensUniforms {
  resolution: vec2<f32>,
  textureResolution: vec2<f32>,
  bounds: vec4<f32>,
  subpixel: vec2<f32>,
  boxSize: vec2<f32>,
  refraction: f32,
  aberration: f32,
  bevelDepth: f32,
  bevelWidth: f32,
  frost: f32,
  radius: f32,
  time: f32,
  specular: f32,
  revealProgress: f32,
  revealType: f32,
  tiltX: f32,
  tiltY: f32,
  magnify: f32,
  tint: vec4<f32>,
  stackMapping: vec4<f32>,
  stackRegion: vec4<f32>,
  interaction: vec4<f32>,
  interactionRadius: vec4<f32>,
  shadowMapping: vec4<f32>,
};

@group(0) @binding(0) var u_tex: texture_2d<f32>;
@group(0) @binding(1) var u_samp: sampler;
@group(0) @binding(2) var u_stack: texture_2d<f32>;
@group(0) @binding(3) var u_shadow: texture_2d<f32>;
@group(1) @binding(0) var<uniform> u: LensUniforms;

fn sampleSource(uv: vec2<f32>) -> vec4<f32> {
  let background = textureSampleLevel(u_tex, u_samp, uv, 0.0);
  let screenUV = u.stackMapping.xy + uv * u.stackMapping.zw;
  if (u.stackRegion.z > 0.0 &&
      all(screenUV >= u.stackRegion.xy) &&
      all(screenUV <= u.stackRegion.xy + u.stackRegion.zw)) {
    let lower = textureSampleLevel(u_stack, u_samp, screenUV, 0.0);
    return lower + background * (1.0 - lower.a);
  }
  return background;
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@location(0) a_position: vec2<f32>) -> VSOut {
  var o: VSOut;
  o.uv = (a_position + vec2<f32>(1.0)) * 0.5;
  o.pos = vec4<f32>(a_position, 0.0, 1.0);
  return o;
}

fn udRoundBox(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
  return length(max(abs(p) - b + vec2<f32>(r), vec2<f32>(0.0))) - r;
}

fn cornerNormal(p: vec2<f32>, b: vec2<f32>, r: f32, fb: vec2<f32>) -> vec2<f32> {
  let q = abs(p) - b + vec2<f32>(r);
  let m = max(q, vec2<f32>(0.0));
  let l = length(m);
  if (l <= 0.0) { return fb; }
  let w = smoothstep(0.0, max(r * 0.5, 1.0), min(m.x, m.y));
  if (w <= 0.0) { return fb; }
  let s = vec2<f32>(select(1.0, -1.0, p.x < 0.0), select(1.0, -1.0, p.y < 0.0));
  return normalize(mix(fb, s * (m / l), w));
}

fn random2(st: vec2<f32>) -> f32 {
  return fract(sin(dot(st, vec2<f32>(12.9898, 78.233))) * 43758.5453123);
}

fn deformPoint(point: vec2<f32>) -> vec2<f32> {
  if (u.interactionRadius.x <= 0.0) { return point; }
  let centre = (vec2<f32>(u.interaction.x, 1.0 - u.interaction.y) - vec2<f32>(0.5)) * u.boxSize;
  let reach = u.interactionRadius.x * min(u.boxSize.x, u.boxSize.y);
  let influence = 1.0 - smoothstep(0.0, reach, length(point - centre));
  return point - vec2<f32>(u.interaction.z, -u.interaction.w) * u.boxSize * influence;
}

fn edgeFactor(p_px: vec2<f32>, b_px: vec2<f32>, radius_px: f32) -> f32 {
  let d = -udRoundBox(p_px, b_px, radius_px);
  let bevel_px = u.bevelWidth * min(u.boxSize.x, u.boxSize.y);
  return 1.0 - smoothstep(0.0, bevel_px, d);
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let lensUV = (in.uv * u.resolution - u.subpixel) / u.boxSize;
  let originalPoint = (lensUV - vec2<f32>(0.5)) * u.boxSize;
  let p_px = deformPoint(originalPoint);
  let b_px = 0.5 * u.boxSize;
  let p = p_px / u.boxSize.y;
  let dmask = udRoundBox(p_px, b_px, u.radius);
  let inShape = 1.0 - smoothstep(-0.5, 0.5, dmask);
  var shadowAlpha = 0.0;
  if (u.shadowMapping.z > 0.0 && inShape < 1.0) {
    let shadowUV = u.shadowMapping.xy + vec2<f32>(lensUV.x, 1.0 - lensUV.y) * u.shadowMapping.zw;
    shadowAlpha = textureSampleLevel(u_shadow, u_samp, shadowUV, 0.0).r * 0.1 * (1.0 - inShape);
    if (u.revealType == 1.0) { shadowAlpha *= u.revealProgress; }
    let noise = fract(52.9829189 * fract(dot(floor(in.pos.xy), vec2<f32>(0.06711056, 0.00583715))));
    shadowAlpha = floor(shadowAlpha * 255.0 + noise) / 255.0;
  }
  if (inShape <= 0.0) { return vec4<f32>(0.0, 0.0, 0.0, shadowAlpha); }

  let edge = edgeFactor(p_px, b_px, u.radius);
  let offsetAmt = edge * u.refraction + pow(edge, 10.0) * u.bevelDepth;
  let centreBlend = smoothstep(0.15, 0.45, length(p));
  var refractDir = cornerNormal(p_px, b_px, u.radius, normalize(p + vec2<f32>(0.000001)));
  if (u.interactionRadius.x > 0.0) {
    let gradient = vec2<f32>(
      udRoundBox(deformPoint(originalPoint + vec2<f32>(0.5, 0.0)), b_px, u.radius) - udRoundBox(deformPoint(originalPoint - vec2<f32>(0.5, 0.0)), b_px, u.radius),
      udRoundBox(deformPoint(originalPoint + vec2<f32>(0.0, 0.5)), b_px, u.radius) - udRoundBox(deformPoint(originalPoint - vec2<f32>(0.0, 0.5)), b_px, u.radius)
    );
    if (length(gradient) > 0.0001) { refractDir = normalize(mix(refractDir, normalize(gradient), min(length(p_px - originalPoint), 1.0))); }
  }
  let offset = refractDir * offsetAmt * centreBlend;

  let tiltRefractionScale = 0.05;
  let deg2rad = 0.017453292519943295;
  let tiltOffset = vec2<f32>(tan(u.tiltY * deg2rad), -tan(u.tiltX * deg2rad)) * tiltRefractionScale;

  let localUV = (lensUV - vec2<f32>(0.5)) / vec2<f32>(u.magnify) + vec2<f32>(0.5);
  let flippedUV = vec2<f32>(localUV.x, 1.0 - localUV.y);
  let mapped = u.bounds.xy + flippedUV * u.bounds.zw;
  let refracted = mapped + offset - tiltOffset;

  let oob = max(max(-refracted.x, refracted.x - 1.0), max(-refracted.y, refracted.y - 1.0));
  let blend = 1.0 - smoothstep(0.0, 0.01, oob);
  let sampleUV = mix(mapped, refracted, blend);

  let baseCol = sampleSource(mapped);

  let texel = vec2<f32>(1.0) / u.textureResolution;
  var refrCol: vec4<f32>;

  let chroma = offset * u.aberration;

  if (u.frost > 0.0) {
    let radius = u.frost * 4.0;
    var sum = vec4<f32>(0.0);

    for (var i = 0; i < 16; i = i + 1) {
      let fi = f32(i);
      let angle = random2(in.uv + vec2<f32>(fi)) * 6.283185;
      let dist = sqrt(random2(in.uv - vec2<f32>(fi))) * radius;
      let foff = vec2<f32>(cos(angle), sin(angle)) * texel * dist;
      if (u.aberration > 0.0) {
        let c0 = sampleSource(sampleUV + foff - chroma);
        let c1 = sampleSource(sampleUV + foff);
        let c2 = sampleSource(sampleUV + foff + chroma);
        sum = sum + vec4<f32>(c0.r, c1.g, c2.b, c1.a);
      } else {
        sum = sum + sampleSource(sampleUV + foff);
      }
    }
    refrCol = sum / 16.0;
  } else {
    refrCol = sampleSource(sampleUV);
    refrCol = refrCol + sampleSource(sampleUV + vec2<f32>(texel.x, 0.0));
    refrCol = refrCol + sampleSource(sampleUV + vec2<f32>(-texel.x, 0.0));
    refrCol = refrCol + sampleSource(sampleUV + vec2<f32>(0.0, texel.y));
    refrCol = refrCol + sampleSource(sampleUV + vec2<f32>(0.0, -texel.y));
    refrCol = refrCol / 5.0;

    if (u.aberration > 0.0) {
      let chromaR = sampleSource(sampleUV - chroma).r;
      let chromaB = sampleSource(sampleUV + chroma).b;
      refrCol = vec4<f32>(chromaR, refrCol.g, chromaB, refrCol.a);
    }
  }

  if (refrCol.a < 0.1) {
    refrCol = baseCol;
  }

  var finalCol = refrCol;

  finalCol = vec4<f32>(mix(finalCol.rgb, finalCol.rgb * u.tint.rgb, u.tint.a), finalCol.a);

  if (u.specular > 0.5) {
    let lp1 = vec2<f32>(sin(u.time * 0.2), cos(u.time * 0.3)) * 0.6 + vec2<f32>(0.5);
    let lp2 = vec2<f32>(sin(u.time * -0.4 + 1.5), cos(u.time * 0.25 - 0.5)) * 0.6 + vec2<f32>(0.5);
    var h = 0.0;
    h = h + smoothstep(0.4, 0.0, distance((p_px + b_px) / u.boxSize, lp1)) * 0.1;
    h = h + smoothstep(0.5, 0.0, distance((p_px + b_px) / u.boxSize, lp2)) * 0.08;
    finalCol = vec4<f32>(finalCol.rgb + vec3<f32>(h), finalCol.a);
  }

  if (u.revealType == 1.0) {
    finalCol = vec4<f32>(finalCol.rgb * u.revealProgress, finalCol.a * u.revealProgress);
  }

  finalCol = vec4<f32>(finalCol.rgb * inShape, finalCol.a * inShape + shadowAlpha);

  return finalCol;
}`;

  const WEBGPU_BLIT_WGSL = `
@group(0) @binding(0) var u_src: texture_2d<f32>;
@group(0) @binding(1) var u_samp: sampler;
@group(1) @binding(0) var<uniform> u_srcRect: vec4<f32>;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@location(0) a_position: vec2<f32>) -> VSOut {
  var o: VSOut;
  o.uv = (a_position + vec2<f32>(1.0)) * 0.5;
  o.pos = vec4<f32>(a_position, 0.0, 1.0);
  return o;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
  return textureSample(u_src, u_samp, u_srcRect.xy + uv * u_srcRect.zw);
}

@fragment
fn fs_fade(in: VSOut) -> @location(0) vec4<f32> {
  let uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
  return textureSample(u_src, u_samp, uv) * u_srcRect.x;
}

@fragment
fn fs_unpremultiply(in: VSOut) -> @location(0) vec4<f32> {
  let uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
  let color = textureSample(u_src, u_samp, u_srcRect.xy + uv * u_srcRect.zw);
  if (color.a <= 0.0) { return vec4<f32>(0.0); }
  return vec4<f32>(color.rgb / color.a, color.a);
}`;

  const WEBGPU_VIDEO_WGSL = `
@group(0) @binding(0) var video: texture_external;
@group(0) @binding(1) var videoSampler: sampler;
struct VideoUniforms {
  rect: vec4<f32>,
  opacity: vec4<f32>,
  clip: vec4<f32>,
};
@group(1) @binding(0) var<uniform> u: VideoUniforms;
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs(@location(0) position: vec2<f32>) -> VSOut {
  var out: VSOut;
  out.pos = vec4<f32>(position, 0.0, 1.0);
  out.uv = vec2<f32>(position.x + 1.0, 1.0 - position.y) * 0.5;
  return out;
}
@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let color = textureSampleBaseClampToEdge(video, videoSampler, u.rect.xy + in.uv * u.rect.zw);
  let near = clamp(in.pos.xy + vec2<f32>(0.5) - u.clip.xy, vec2<f32>(0.0), vec2<f32>(1.0));
  let far = clamp(u.clip.xy + u.clip.zw - in.pos.xy + vec2<f32>(0.5), vec2<f32>(0.0), vec2<f32>(1.0));
  return vec4<f32>(color.rgb * color.a, color.a) * u.opacity.x * near.x * near.y * far.x * far.y;
}`;

  const WEBGPU_CLEAR_WGSL = `
@vertex
fn vs(@location(0) a_position: vec2<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(a_position, 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}`;

  const GPU_UNIFORM_FLOATS = 64;

  class WebGPUBackend {
    static async create(canvas) {
      if (typeof navigator === "undefined" || !("gpu" in navigator))
        return null;
      try {
        if (!WebGPUBackend._deviceReady) {
          WebGPUBackend._deviceReady = (async () => {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) return null;
            const device = await adapter.requestDevice();
            device.lost.then(() => {
              WebGPUBackend._deviceReady = null;
            });
            return device;
          })().catch(() => {
            WebGPUBackend._deviceReady = null;
            return null;
          });
        }
        const device = await WebGPUBackend._deviceReady;
        if (!device) {
          WebGPUBackend._deviceReady = null;
          return null;
        }

        const lensModule = device.createShaderModule({
          code: WEBGPU_LENS_WGSL,
        });
        const blitModule = device.createShaderModule({
          code: WEBGPU_BLIT_WGSL,
        });
        const clearModule = device.createShaderModule({
          code: WEBGPU_CLEAR_WGSL,
        });
        const infos = await Promise.all([
          lensModule.getCompilationInfo(),
          blitModule.getCompilationInfo(),
          clearModule.getCompilationInfo(),
        ]);
        const hasError = infos.some((info) =>
          info.messages.some((m) => m.type === "error"),
        );
        if (hasError) return null;

        return new WebGPUBackend(
          canvas,
          device,
          lensModule,
          blitModule,
          clearModule,
        );
      } catch (e) {
        return null;
      }
    }

    constructor(canvas, device, lensModule, blitModule, clearModule) {
      this.kind = "webgpu";
      this.canvas = canvas;
      this.device = device;
      this.maxTextureSize = device.limits.maxTextureDimension2D || 8192;

      this.ctx = canvas.getContext("webgpu");
      if (!this.ctx)
        throw new Error("liquidGL: WebGPU canvas context unavailable");
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.ctx.configure({
        device,
        format: this.format,
        alphaMode: "premultiplied",
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });

      device.lost.then((info) => {
        if (info.reason !== "destroyed") {
          console.warn("liquidGL: WebGPU device lost:", info.message);
        }
      });

      const quad = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
      this._vb = device.createBuffer({
        size: quad.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this._vb, 0, quad);

      this._sampler = device.createSampler({
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });

      this._texSampLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            texture: {},
          },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: {},
          },
        ],
      });
      this._dynamicUniformLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform", hasDynamicOffset: true },
          },
        ],
      });
      this._staticUniformLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" },
          },
        ],
      });

      const quadBufferLayout = {
        arrayStride: 8,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
      };

      this._lensTexLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        ],
      });
      this._lensPipe = device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [this._lensTexLayout, this._dynamicUniformLayout],
        }),
        vertex: {
          module: lensModule,
          entryPoint: "vs",
          buffers: [quadBufferLayout],
        },
        fragment: {
          module: lensModule,
          entryPoint: "fs",
          targets: [
            {
              format: this.format,
              blend: {
                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              },
            },
          ],
        },
        primitive: { topology: "triangle-list" },
      });

      this._blitPipe = device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [this._texSampLayout, this._staticUniformLayout],
        }),
        vertex: {
          module: blitModule,
          entryPoint: "vs",
          buffers: [quadBufferLayout],
        },
        fragment: {
          module: blitModule,
          entryPoint: "fs",
          targets: [{ format: "rgba8unorm" }],
        },
        primitive: { topology: "triangle-list" },
      });

      this._videoResolvePipe = device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [this._texSampLayout, this._staticUniformLayout],
        }),
        vertex: {
          module: blitModule,
          entryPoint: "vs",
          buffers: [quadBufferLayout],
        },
        fragment: {
          module: blitModule,
          entryPoint: "fs_unpremultiply",
          targets: [{ format: "rgba8unorm" }],
        },
        primitive: { topology: "triangle-list" },
      });

      this._videoFadePipe = device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [this._texSampLayout, this._dynamicUniformLayout],
        }),
        vertex: {
          module: blitModule,
          entryPoint: "vs",
          buffers: [quadBufferLayout],
        },
        fragment: {
          module: blitModule,
          entryPoint: "fs_fade",
          targets: [
            {
              format: "rgba8unorm",
              blend: {
                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              },
            },
          ],
        },
        primitive: { topology: "triangle-list" },
      });

      this._contentPipe = device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [this._texSampLayout, this._dynamicUniformLayout],
        }),
        vertex: {
          module: blitModule,
          entryPoint: "vs",
          buffers: [quadBufferLayout],
        },
        fragment: {
          module: blitModule,
          entryPoint: "fs",
          targets: [
            {
              format: this.format,
              blend: {
                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              },
            },
          ],
        },
        primitive: { topology: "triangle-list" },
      });

      this._clearPipe = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [] }),
        vertex: {
          module: clearModule,
          entryPoint: "vs",
          buffers: [quadBufferLayout],
        },
        fragment: {
          module: clearModule,
          entryPoint: "fs",
          targets: [{ format: this.format }],
        },
        primitive: { topology: "triangle-list" },
      });

      this.texture = null;
      this._texBindGroup = null;
      this._videoTex = null;
      this._videoBindGroup = null;
      this._videoTexW = 0;
      this._videoTexH = 0;

      this._blitUniform = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this._blitBindGroup = device.createBindGroup({
        layout: this._staticUniformLayout,
        entries: [{ binding: 0, resource: { buffer: this._blitUniform } }],
      });

      this._uniformBuf = null;
      this._uniformBindGroup = null;
      this._uniformCapacity = 0;

      this._enc = null;
      this._drawQueue = [];
      this._frameTime = 0;
    }

    drawContent(content, rect) {
      const p = contentViewport(
        rect,
        this.canvas,
        this.renderer._frameCanvasRect,
      );
      if (!p) return false;
      const device = this.device;
      if (content.device === device && content.texture) {
        this._gpuContents ||= new Map();
        let entry = this._gpuContents.get(content);
        if (!entry || entry.texture !== content.texture) {
          entry = {
            texture: content.texture,
            bindGroup: device.createBindGroup({
              layout: this._texSampLayout,
              entries: [
                { binding: 0, resource: content.texture.createView() },
                { binding: 1, resource: this._sampler },
              ],
            }),
          };
          this._gpuContents.set(content, entry);
        }
        this._drawQueue.push({
          p,
          content: entry,
          x: p.x,
          y: p.y,
          w: p.w,
          h: p.h,
        });
        return true;
      }
      this._contents ||= new Map();
      let entry = this._contents.get(content);
      if (
        !entry ||
        entry.texture.width !== content.canvas.width ||
        entry.texture.height !== content.canvas.height
      ) {
        if (entry) entry.texture.destroy();
        const texture = device.createTexture({
          size: [content.canvas.width, content.canvas.height],
          format: "rgba8unorm",
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
        });
        entry = {
          texture,
          version: -1,
          bindGroup: device.createBindGroup({
            layout: this._texSampLayout,
            entries: [
              { binding: 0, resource: texture.createView() },
              { binding: 1, resource: this._sampler },
            ],
          }),
        };
        this._contents.set(content, entry);
      }
      if (entry.version !== content.version) {
        device.queue.copyExternalImageToTexture(
          { source: content.canvas },
          { texture: entry.texture, premultipliedAlpha: true },
          [content.canvas.width, content.canvas.height],
        );
        entry.version = content.version;
      }
      this._drawQueue.push({
        p,
        content: entry,
        backdrop: content.backdrop ? { content, rect } : null,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
      });
      return true;
    }

    resize() {}

    _ensureUniformCapacity(lensCount) {
      const need = lensCount * 256;
      if (this._uniformBuf && this._uniformCapacity >= need) return;
      if (this._uniformBuf) this._uniformBuf.destroy();
      const cap = Math.max(need, 256 * 8);
      this._uniformBuf = this.device.createBuffer({
        size: cap,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this._uniformBindGroup = this.device.createBindGroup({
        layout: this._dynamicUniformLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: this._uniformBuf, offset: 0, size: 208 },
          },
        ],
      });
      this._uniformCapacity = cap;
    }

    uploadSnapshot(srcCanvas) {
      const w = srcCanvas.width;
      const h = srcCanvas.height;
      if (
        !this.texture ||
        this.texture.width !== w ||
        this.texture.height !== h
      ) {
        if (this.texture) this.texture.destroy();
        this.texture = this.device.createTexture({
          size: [w, h],
          format: "rgba8unorm",
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this._texBindGroup = this.device.createBindGroup({
          layout: this._texSampLayout,
          entries: [
            { binding: 0, resource: this.texture.createView() },
            { binding: 1, resource: this._sampler },
          ],
        });
      }
      try {
        this.device.queue.copyExternalImageToTexture(
          { source: srcCanvas },
          { texture: this.texture },
          { width: w, height: h },
        );
      } catch (e) {
        console.error("liquidGL: WebGPU snapshot upload failed", e);
        return false;
      }
      return true;
    }

    uploadRegion(x, y, source, sx = 0, sy = 0) {
      if (!this.texture || !source) return;
      const w = Math.min(source.width - sx, this.texture.width - x);
      const h = Math.min(source.height - sy, this.texture.height - y);
      if (w <= 0 || h <= 0 || x < 0 || y < 0) return;
      try {
        this.device.queue.copyExternalImageToTexture(
          { source, origin: [sx, sy] },
          { texture: this.texture, origin: [x, y] },
          { width: w, height: h },
        );
        this.renderer._invalidateDynamicRegion(x, y, w, h);
      } catch (e) {
        console.warn("liquidGL: WebGPU region upload failed", e);
      }
    }

    getExternalVideo(source) {
      const device = this.device;
      if (!device.importExternalTexture) return null;
      try {
        if (!this._externalVideoPipe) {
          const module = device.createShaderModule({ code: WEBGPU_VIDEO_WGSL });
          this._externalVideoLayout = device.createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                externalTexture: {},
              },
              { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            ],
          });
          this._externalVideoPipe = device.createRenderPipeline({
            layout: device.createPipelineLayout({
              bindGroupLayouts: [
                this._externalVideoLayout,
                this._dynamicUniformLayout,
              ],
            }),
            vertex: {
              module,
              entryPoint: "vs",
              buffers: [
                {
                  arrayStride: 8,
                  attributes: [
                    { shaderLocation: 0, offset: 0, format: "float32x2" },
                  ],
                },
              ],
            },
            fragment: {
              module,
              entryPoint: "fs",
              targets: [
                {
                  format: "rgba8unorm",
                  blend: {
                    color: {
                      srcFactor: "one",
                      dstFactor: "one-minus-src-alpha",
                    },
                    alpha: {
                      srcFactor: "one",
                      dstFactor: "one-minus-src-alpha",
                    },
                  },
                },
              ],
            },
            primitive: { topology: "triangle-list" },
          });
        }
        WebGPUBackend._externalFrames ||= new WeakMap();
        let entry = WebGPUBackend._externalFrames.get(source);
        if (!entry || entry.device !== device || entry.frame !== renderFrame) {
          entry = {
            device,
            frame: renderFrame,
            texture: device.importExternalTexture({ source }),
          };
          WebGPUBackend._externalFrames.set(source, entry);
        }
        return {
          bindGroup: device.createBindGroup({
            layout: this._externalVideoLayout,
            entries: [
              { binding: 0, resource: entry.texture },
              { binding: 1, resource: this._sampler },
            ],
          }),
          external: true,
        };
      } catch (e) {
        return null;
      }
    }

    blitVideo(vid, dstX, dstY, dstW, dstH, srcRect, source = vid) {
      if (!this.texture) return false;
      const device = this.device;
      const external = this.getExternalVideo(source);
      if (external) {
        if (!this._externalVideoUniform) {
          this._externalVideoUniform = device.createBuffer({
            size: 48,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          this._externalVideoGroup = device.createBindGroup({
            layout: this._dynamicUniformLayout,
            entries: [
              {
                binding: 0,
                resource: { buffer: this._externalVideoUniform, size: 48 },
              },
            ],
          });
        }
        device.queue.writeBuffer(
          this._externalVideoUniform,
          0,
          new Float32Array([
            srcRect.u,
            srcRect.v,
            srcRect.uw,
            srcRect.vh,
            1,
            0,
            0,
            0,
            dstX,
            dstY,
            dstW,
            dstH,
          ]),
        );
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this.texture.createView(),
              loadOp: "load",
              storeOp: "store",
            },
          ],
        });
        pass.setPipeline(this._externalVideoPipe);
        pass.setVertexBuffer(0, this._vb);
        pass.setBindGroup(0, external.bindGroup);
        pass.setBindGroup(1, this._externalVideoGroup, [0]);
        pass.setViewport(dstX, dstY, dstW, dstH, 0, 1);
        pass.draw(6);
        pass.end();
        device.queue.submit([encoder.finish()]);
        this.renderer._invalidateDynamicRegion(dstX, dstY, dstW, dstH);
        return true;
      }
      if (uploadScaledVideo(this, vid, dstX, dstY, dstW, dstH, srcRect, source))
        return true;
      const vw = source.displayWidth || vid.videoWidth;
      const vh = source.displayHeight || vid.videoHeight;
      if (!vw || !vh) return false;

      try {
        if (!this._vCanvas) {
          this._vCanvas = document.createElement("canvas");
          this._vCtx = this._vCanvas.getContext("2d");
        }
        if (this._vCanvas.width !== vw || this._vCanvas.height !== vh) {
          this._vCanvas.width = vw;
          this._vCanvas.height = vh;
        }
        this._vCtx.drawImage(source, 0, 0, vw, vh);

        if (
          !this._videoTex ||
          this._videoTexW !== vw ||
          this._videoTexH !== vh
        ) {
          if (this._videoTex) this._videoTex.destroy();
          this._videoTex = device.createTexture({
            size: [vw, vh],
            format: "rgba8unorm",
            usage:
              GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.COPY_DST |
              GPUTextureUsage.RENDER_ATTACHMENT,
          });
          this._videoTexW = vw;
          this._videoTexH = vh;
          this._videoBindGroup = device.createBindGroup({
            layout: this._texSampLayout,
            entries: [
              { binding: 0, resource: this._videoTex.createView() },
              { binding: 1, resource: this._sampler },
            ],
          });
        }

        device.queue.copyExternalImageToTexture(
          { source: this._vCanvas },
          { texture: this._videoTex },
          { width: vw, height: vh },
        );
        device.queue.writeBuffer(
          this._blitUniform,
          0,
          new Float32Array([srcRect.u, srcRect.v, srcRect.uw, srcRect.vh]),
        );

        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
          colorAttachments: [
            {
              view: this.texture.createView(),
              loadOp: "load",
              storeOp: "store",
            },
          ],
        });
        pass.setPipeline(this._blitPipe);
        pass.setVertexBuffer(0, this._vb);
        pass.setBindGroup(0, this._videoBindGroup);
        pass.setBindGroup(1, this._blitBindGroup);
        pass.setViewport(
          dstX,
          dstY,
          Math.max(1, dstW),
          Math.max(1, dstH),
          0,
          1,
        );
        pass.draw(6);
        pass.end();
        device.queue.submit([enc.finish()]);
        this.renderer._invalidateDynamicRegion(dstX, dstY, dstW, dstH);
        return true;
      } catch (e) {
        return false;
      }
    }

    compositeVideo(layers, x, y, width, height) {
      if (this._videoFadeFailed || !this.texture) return false;
      const device = this.device;
      this._videoContents ||= new Map();
      try {
        const size = layers.length * 256;
        if (!this._videoFadeUniform || this._videoFadeUniform.size < size) {
          if (this._videoFadeUniform) this._videoFadeUniform.destroy();
          this._videoFadeUniform = device.createBuffer({
            size: Math.max(size, 2048),
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          this._videoFadeGroup = device.createBindGroup({
            layout: this._dynamicUniformLayout,
            entries: [
              {
                binding: 0,
                resource: { buffer: this._videoFadeUniform, size: 48 },
              },
            ],
          });
        }
        const uniforms = new Float32Array(layers.length * 64);
        const entries = layers.map(({ content, opacity }, i) => {
          if (content.external) {
            uniforms.set(content.uv, i * 64);
            uniforms[i * 64 + 4] = opacity;
            uniforms.set(
              [
                content.clip[0],
                content.clip[1],
                content.clip[2],
                content.clip[3],
              ],
              i * 64 + 8,
            );
            return content.external;
          }
          uniforms[i * 64] = opacity;
          let entry = this._videoContents.get(content);
          if (
            !entry ||
            entry.texture.width !== width ||
            entry.texture.height !== height
          ) {
            if (entry) entry.texture.destroy();
            const texture = device.createTexture({
              size: [width, height],
              format: "rgba8unorm",
              usage:
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_DST |
                GPUTextureUsage.RENDER_ATTACHMENT,
            });
            entry = {
              texture,
              version: -1,
              bindGroup: device.createBindGroup({
                layout: this._texSampLayout,
                entries: [
                  { binding: 0, resource: texture.createView() },
                  { binding: 1, resource: this._sampler },
                ],
              }),
            };
            this._videoContents.set(content, entry);
          }
          if (entry.version !== content.version) {
            device.queue.copyExternalImageToTexture(
              { source: content.canvas },
              { texture: entry.texture, premultipliedAlpha: true },
              [width, height],
            );
            entry.version = content.version;
          }
          return entry;
        });
        device.queue.writeBuffer(this._videoFadeUniform, 0, uniforms);
        if (
          !this._videoCompositeTexture ||
          this._videoCompositeTexture.width < width ||
          this._videoCompositeTexture.height < height
        ) {
          const w = Math.max(width, this._videoCompositeTexture?.width || 0);
          const h = Math.max(height, this._videoCompositeTexture?.height || 0);
          if (this._videoCompositeTexture)
            this._videoCompositeTexture.destroy();
          this._videoCompositeTexture = device.createTexture({
            size: [w, h],
            format: "rgba8unorm",
            usage:
              GPUTextureUsage.RENDER_ATTACHMENT |
              GPUTextureUsage.TEXTURE_BINDING,
          });
          this._videoCompositeGroup = device.createBindGroup({
            layout: this._texSampLayout,
            entries: [
              {
                binding: 0,
                resource: this._videoCompositeTexture.createView(),
              },
              { binding: 1, resource: this._sampler },
            ],
          });
        }
        device.queue.writeBuffer(
          this._blitUniform,
          0,
          new Float32Array([
            0,
            0,
            width / this._videoCompositeTexture.width,
            height / this._videoCompositeTexture.height,
          ]),
        );
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this._videoCompositeTexture.createView(),
              loadOp: "clear",
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              storeOp: "store",
            },
          ],
        });
        pass.setPipeline(this._videoFadePipe);
        pass.setVertexBuffer(0, this._vb);
        pass.setViewport(0, 0, width, height, 0, 1);
        entries.forEach((entry, i) => {
          pass.setPipeline(
            entry.external ? this._externalVideoPipe : this._videoFadePipe,
          );
          pass.setBindGroup(0, entry.bindGroup);
          pass.setBindGroup(1, this._videoFadeGroup, [i * 256]);
          pass.draw(6);
        });
        pass.end();
        const resolve = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this.texture.createView(),
              loadOp: "load",
              storeOp: "store",
            },
          ],
        });
        resolve.setPipeline(this._videoResolvePipe);
        resolve.setVertexBuffer(0, this._vb);
        resolve.setBindGroup(0, this._videoCompositeGroup);
        resolve.setBindGroup(1, this._blitBindGroup);
        resolve.setViewport(x, y, width, height, 0, 1);
        resolve.draw(6);
        resolve.end();
        device.queue.submit([encoder.finish()]);
        this.renderer._invalidateDynamicRegion(x, y, width, height);
        return true;
      } catch (e) {
        this._videoFadeFailed = true;
        return false;
      }
    }

    beginFrame(width, height, time, composite = false) {
      this._compositeActive = composite;
      if (
        composite &&
        (!this._compositeTexture ||
          this._compositeTexture.width !== width ||
          this._compositeTexture.height !== height)
      ) {
        if (this._compositeTexture) this._compositeTexture.destroy();
        this._compositeTexture = this.device.createTexture({
          size: [width, height],
          format: this.format,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.TEXTURE_BINDING,
        });
      }
      this._frameTime = time;
      this._drawQueue.length = 0;
      this._enc = this.device.createCommandEncoder();
    }

    drawLens(lens, p) {
      if (p.shadow && !this._shadows)
        this._shadows = new LiquidShadowCache(this);
      const shadow = this._shadows ? this._shadows.get(lens, p) : null;
      p.shadowEntry = shadow;
      const cx = Math.max(0, p.x);
      const cy = Math.max(0, this.canvas.height - p.y - p.h);
      const cw = Math.min(this.canvas.width, p.x + p.w) - cx;
      const ch = Math.min(this.canvas.height, this.canvas.height - p.y) - cy;
      if (cw <= 0 || ch <= 0) return;
      p = {
        ...p,
        w: cw,
        h: ch,
        subX: p.subX - (cx - p.x),
        subY: p.subY - Math.max(0, -p.y),
      };
      this._drawQueue.push({ p, x: cx, y: cy, w: cw, h: ch });
    }

    endFrame() {
      const device = this.device;
      const draws = this._drawQueue;

      this._ensureUniformCapacity(Math.max(1, draws.length));

      if (draws.length) {
        const data = new Float32Array(GPU_UNIFORM_FLOATS * draws.length);
        for (let i = 0; i < draws.length; i++) {
          const p = draws[i].p;
          const o = i * GPU_UNIFORM_FLOATS;
          if (draws[i].content) {
            data.set(p.uv, o);
            continue;
          }
          data[o] = p.w;
          data[o + 1] = p.h;
          data[o + 2] = p.texW;
          data[o + 3] = p.texH;
          data[o + 4] = p.bounds[0];
          data[o + 5] = p.bounds[1];
          data[o + 6] = p.bounds[2];
          data[o + 7] = p.bounds[3];
          data[o + 8] = p.subX;
          data[o + 9] = p.subY;
          data[o + 10] = p.boxW;
          data[o + 11] = p.boxH;
          data[o + 12] = p.refraction;
          data[o + 13] = p.aberration;
          data[o + 14] = p.bevelDepth;
          data[o + 15] = p.bevelWidth;
          data[o + 16] = p.frost;
          data[o + 17] = p.radius;
          data[o + 18] = this._frameTime;
          data[o + 19] = p.specular;
          data[o + 20] = p.revealProgress;
          data[o + 21] = p.revealType;
          data[o + 22] = p.tiltX;
          data[o + 23] = p.tiltY;
          data[o + 24] = p.magnify;
          data[o + 28] = p.tint[0];
          data[o + 29] = p.tint[1];
          data[o + 30] = p.tint[2];
          data[o + 31] = p.tint[3];
          data.set(p.stackMapping, o + 32);
          data.set(p.interaction, o + 40);
          data[o + 44] = p.interactionRadius;
          data.set(p.shadowEntry ? p.shadowMapping : INTERACTION_OFF, o + 48);
          if (p.stackRegion) {
            const r = p.stackRegion;
            data[o + 36] = r.x / this.canvas.width;
            data[o + 37] =
              (this.canvas.height - r.y - r.h) / this.canvas.height;
            data[o + 38] = r.w / this.canvas.width;
            data[o + 39] = r.h / this.canvas.height;
          }
        }
        device.queue.writeBuffer(this._uniformBuf, 0, data);
      }

      if (
        draws.some((d) => d.p.stackRegion) &&
        (!this._stackTexture ||
          this._stackTexture.width !== this.canvas.width ||
          this._stackTexture.height !== this.canvas.height)
      ) {
        if (this._stackTexture) this._stackTexture.destroy();
        this._stackTexture = device.createTexture({
          size: [this.canvas.width, this.canvas.height],
          format: this.format,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this._lensBindGroup = null;
      }
      if (!this._lensBindGroup || this._lensSnapshot !== this.texture) {
        this._lensSnapshot = this.texture;
        this._lensBindGroup = device.createBindGroup({
          layout: this._lensTexLayout,
          entries: [
            { binding: 0, resource: this.texture.createView() },
            { binding: 1, resource: this._sampler },
            {
              binding: 2,
              resource: (this._stackTexture || this.texture).createView(),
            },
            { binding: 3, resource: this.texture.createView() },
          ],
        });
      }
      const presentationTexture = this.ctx.getCurrentTexture();
      if (
        !this._outputTexture ||
        this._outputTexture.width !== this.canvas.width ||
        this._outputTexture.height !== this.canvas.height
      ) {
        if (this._outputTexture) this._outputTexture.destroy();
        this._outputTexture = device.createTexture({
          size: [this.canvas.width, this.canvas.height],
          format: this.format,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.TEXTURE_BINDING,
        });
      }
      const visibleTexture = this._outputTexture;
      const visibleView = visibleTexture.createView();
      const target = this._compositeActive
        ? this._compositeTexture
        : visibleTexture;
      const view = this._compositeActive ? target.createView() : visibleView;
      const beginPass = (loadOp, output = view) => {
        const pass = this._enc.beginRenderPass({
          colorAttachments: [
            {
              view: output,
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp,
              storeOp: "store",
            },
          ],
        });
        pass.setPipeline(this._lensPipe);
        pass.setVertexBuffer(0, this._vb);
        pass.setBindGroup(0, this._lensBindGroup);
        return pass;
      };
      if (this._compositeActive) beginPass("clear", visibleView).end();
      let pass = beginPass("clear");
      for (let i = 0; i < draws.length; i++) {
        const d = draws[i];
        if (d.content) {
          if (d.backdrop) {
            pass.end();
            this._backdrops ||= new LiquidBackdropFilter(this);
            this._backdrops.draw(d.backdrop.content, d.backdrop.rect, d.p);
            pass = beginPass("load");
          }
          pass.setPipeline(this._contentPipe);
          pass.setBindGroup(0, d.content.bindGroup);
          pass.setBindGroup(1, this._uniformBindGroup, [i * 256]);
          pass.setViewport(d.x, d.y, d.w, d.h, 0, 1);
          pass.draw(6);
          pass.setPipeline(this._lensPipe);
          continue;
        }
        const r = d.p.stackRegion;
        if (r) {
          pass.end();
          const origin = [r.x, this.canvas.height - r.y - r.h];
          this._enc.copyTextureToTexture(
            { texture: target, origin },
            { texture: this._stackTexture, origin },
            [r.w, r.h],
          );
          pass = beginPass("load");
        }
        const shadow = d.p.shadowEntry;
        if (
          shadow &&
          (!shadow.lensGroup ||
            shadow.snapshot !== this.texture ||
            shadow.stack !== this._stackTexture)
        ) {
          shadow.snapshot = this.texture;
          shadow.stack = this._stackTexture;
          shadow.lensGroup = device.createBindGroup({
            layout: this._lensTexLayout,
            entries: [
              { binding: 0, resource: this.texture.createView() },
              { binding: 1, resource: this._sampler },
              {
                binding: 2,
                resource: (this._stackTexture || this.texture).createView(),
              },
              { binding: 3, resource: shadow.textures[0].createView() },
            ],
          });
        }
        pass.setBindGroup(0, shadow ? shadow.lensGroup : this._lensBindGroup);
        pass.setViewport(d.x, d.y, d.w, d.h, 0, 1);
        pass.setBindGroup(1, this._uniformBindGroup, [i * 256]);
        pass.draw(6);
        if (this._compositeActive) {
          pass.end();
          const visiblePass = beginPass("load", visibleView);
          visiblePass.setBindGroup(
            0,
            shadow ? shadow.lensGroup : this._lensBindGroup,
          );
          visiblePass.setViewport(d.x, d.y, d.w, d.h, 0, 1);
          visiblePass.setBindGroup(1, this._uniformBindGroup, [i * 256]);
          visiblePass.draw(6);
          visiblePass.end();
          pass = beginPass("load");
        }
      }
      pass.end();

      this._enc.copyTextureToTexture(
        { texture: visibleTexture },
        { texture: presentationTexture },
        [this.canvas.width, this.canvas.height],
      );
      device.queue.submit([this._enc.finish()]);
      this._enc = null;
    }

    clearRegions(rects) {
      if (!rects.length) return;
      const device = this.device;
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: this.ctx.getCurrentTexture().createView(),
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(this._clearPipe);
      pass.setVertexBuffer(0, this._vb);
      rects.forEach(({ x, y, w, h }) => {
        const cx = Math.max(0, Math.min(this.canvas.width, x));
        const cy = Math.max(
          0,
          Math.min(this.canvas.height, this.canvas.height - y - h),
        );
        const cw = Math.max(0, Math.min(this.canvas.width - cx, w));
        const ch = Math.max(0, Math.min(this.canvas.height - cy, h));
        if (cw > 0 && ch > 0) {
          pass.setScissorRect(cx, cy, cw, ch);
          pass.draw(6);
        }
      });
      pass.end();
      device.queue.submit([enc.finish()]);
    }
  }

  /* --------------------------------------------------
   *  Shared renderer (one per page)
   * ------------------------------------------------*/
  class LiquidContentLayer {
    constructor(renderer, lens, el) {
      this.renderer = renderer;
      this.lens = lens;
      this.el = el;
      this.before = el !== lens.el;
      const sheet = renderer._dynamicStyleSheet;
      const index = sheet.insertRule(
        `[data-liquidgl-content="${lens._order}"] {}`,
        sheet.cssRules.length,
      );
      this.maskStyle = sheet.cssRules[index].style;
      this.canvas = document.createElement("canvas");
      this.version = 0;
      this.dirty = true;
      this.lastCapture = -Infinity;
      this.animations = 0;
      this.opacity = parseFloat(getComputedStyle(el).opacity) || 1;
      this.invalidate = () => {
        if (this._destroyed) return;
        this.dirty = true;
        this._forceCapture = true;
      };
      this.observer = new MutationObserver((records) => {
        if (
          records.some(
            (record) =>
              record.attributeName !== "data-liquidgl-content" &&
              record.attributeName !== "data-liquidgl-hide" &&
              !this.ignored(record.target),
          )
        )
          this.dirty = true;
      });
      this.observer.observe(el, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      listen(this, el, "load", this.invalidate, true);
      if (document.fonts)
        listen(this, document.fonts, "loadingdone", this.invalidate);
      listen(this, el, "transitionrun", () => {
        this.animations++;
        this.invalidate();
      });
      listen(this, el, "animationstart", () => {
        this.animations++;
        this.invalidate();
      });
      const finish = () => {
        this.animations = Math.max(0, this.animations - 1);
        this.invalidate();
      };
      for (const event of [
        "transitionend",
        "transitioncancel",
        "animationend",
        "animationcancel",
      ]) {
        listen(this, el, event, finish);
      }
      this.resizeObserver = new ResizeObserver(this.invalidate);
      this.resizeObserver.observe(el);
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this.observer.disconnect();
      this.resizeObserver.disconnect();
      this._cleanups?.splice(0).forEach((cleanup) => cleanup());
      if (
        this.el.getAttribute("data-liquidgl-content") ===
        String(this.lens._order)
      )
        this.el.removeAttribute("data-liquidgl-content");
      this._mask?.parentElement.remove();
      removeRule(this.renderer._dynamicStyleSheet, this.maskStyle);
      for (const renderer of renderers) {
        if (renderer.backend) releaseCached(renderer.backend, this);
      }
      this.canvas.width = this.canvas.height = 0;
      this._paintState = null;
    }

    updateMask() {
      if (this._destroyed) return;
      const rect = this.el.getBoundingClientRect();
      const ordered =
        this.renderer._sceneLenses || this.renderer._orderedLenses;
      const start = ordered.indexOf(this.lens) + (this.before ? 0 : 1);
      const paths = [];
      for (let i = start; i < ordered.length; i++) {
        const lens = ordered[i];
        const metrics = lens.rectPx;
        if (!metrics || !lens.renderer.hasTexture) continue;
        const r = {
          ...metrics,
          right: metrics.left + metrics.width,
          bottom: metrics.top + metrics.height,
        };
        const bounds = lens._fluidDrawRect || r;
        if (
          !r ||
          !bounds ||
          bounds.left >= rect.right ||
          bounds.right <= rect.left ||
          bounds.top >= rect.bottom ||
          bounds.bottom <= rect.top
        )
          continue;
        const radius = Math.min(lens.radiusCss || 0, r.width / 2, r.height / 2);
        const fluid =
          lens.options.interaction === "fluid" && lens._fluid?.value;
        const reach = fluid
          ? unitOption(lens.options.interactionRadius, 0.35, 5) *
            Math.min(r.width, r.height)
          : 0;
        const points = [];
        const corners = [
          [r.left + radius, r.top + radius, Math.PI],
          [r.right - radius, r.top + radius, Math.PI * 1.5],
          [r.right - radius, r.bottom - radius, 0],
          [r.left + radius, r.bottom - radius, Math.PI * 0.5],
        ];
        for (const [cx, cy, angle] of corners) {
          for (let j = 0; j <= 12; j++) {
            const a = angle + (j / 12) * Math.PI * 0.5;
            const bx = cx + Math.cos(a) * radius,
              by = cy + Math.sin(a) * radius;
            let x = bx,
              y = by;
            if (reach > 0) {
              for (let k = 0; k < 6; k++) {
                const t = Math.min(
                  1,
                  Math.hypot(
                    x - r.left - fluid[0] * r.width,
                    y - r.top - fluid[1] * r.height,
                  ) / reach,
                );
                const influence = 1 - t * t * (3 - 2 * t);
                x = bx + fluid[2] * r.width * influence;
                y = by + fluid[3] * r.height * influence;
              }
            }
            points.push(
              `${(x - rect.left).toFixed(2)},${(y - rect.top).toFixed(2)}`,
            );
          }
        }
        paths.push(`M${points.join("L")}Z`);
      }
      const path = paths.length
        ? `M0,0H${rect.width}V${rect.height}H0Z${paths.join("")}`
        : "";
      if (path === this.maskPath) return;
      this.maskPath = path;
      if (!path) {
        this.maskStyle.maskImage = "";
        this.maskStyle.webkitMaskImage = "";
        return;
      }
      if (typeof document.getCSSCanvasContext === "function") {
        const name = `liquidgl-mask-${this.lens._order}`;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const width = Math.ceil(rect.width * dpr);
        const height = Math.ceil(rect.height * dpr);
        const ctx = document.getCSSCanvasContext("2d", name, width, height);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.setTransform(width / rect.width, 0, 0, height / rect.height, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, rect.width, rect.height);
        ctx.globalCompositeOperation = "destination-out";
        ctx.fill(new Path2D(paths.join("")));
        ctx.globalCompositeOperation = "source-over";
        this.maskStyle.webkitMaskImage = `-webkit-canvas(${name})`;
        this.maskStyle.webkitMaskSize = "100% 100%";
        this.maskStyle.webkitMaskRepeat = "no-repeat";
        return;
      }
      if (!this._mask) {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("width", "0");
        svg.setAttribute("height", "0");
        svg.setAttribute("data-liquid-ignore", "");
        svg.style.position = "absolute";
        this._mask = document.createElementNS(ns, "mask");
        this._mask.id = `liquidgl-mask-${this.lens._order}`;
        this._mask.setAttribute("maskUnits", "userSpaceOnUse");
        this._mask.setAttribute("x", "0");
        this._mask.setAttribute("y", "0");
        this._maskBackground = document.createElementNS(ns, "rect");
        this._maskBackground.setAttribute("fill", "white");
        this._maskShape = document.createElementNS(ns, "path");
        this._maskShape.setAttribute("fill", "black");
        this._mask.append(this._maskBackground, this._maskShape);
        svg.appendChild(this._mask);
        document.body.appendChild(svg);
      }
      this._mask.setAttribute("width", rect.width);
      this._mask.setAttribute("height", rect.height);
      this._maskBackground.setAttribute("width", rect.width);
      this._maskBackground.setAttribute("height", rect.height);
      this._maskShape.setAttribute("d", paths.join(""));
      this.maskStyle.maskImage = `url("#${this._mask.id}")`;
    }

    ignored(el) {
      return Array.from(renderers).some((renderer) =>
        renderer.lenses.some(
          (lens) =>
            lens.el !== this.el && (lens.el === el || lens.el.contains(el)),
        ),
      );
    }

    update(now) {
      if (this._updateFrame === renderFrame) return this._frameRect;
      this._updateFrame = renderFrame;
      this._frameRect = null;
      const rect = this.el.getBoundingClientRect();
      const style = window.getComputedStyle(this.el);
      this.backdrop = this.before ? backdropFilter(style) : null;
      this.opacity = Number(style.opacity);
      if (this.backdrop) {
        this.backdropRadii = [
          "borderTopLeftRadius",
          "borderTopRightRadius",
          "borderBottomRightRadius",
          "borderBottomLeftRadius",
        ].map((name) => {
          const value = style[name];
          const radius = parseFloat(value) || 0;
          return Math.min(
            rect.width / 2,
            rect.height / 2,
            value.includes("%")
              ? (radius * Math.min(rect.width, rect.height)) / 100
              : radius,
          );
        });
      }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const scale = Math.min(
        dpr,
        this.renderer.backend.maxTextureSize /
          Math.max(1, rect.width, rect.height),
      );
      const resized =
        this.width !== rect.width ||
        this.height !== rect.height ||
        this.scale !== scale;
      if (rect.width <= 0 || rect.height <= 0) return null;
      if (resized || this.dirty || this.animations) {
        const plan = NaughtyDOM.measure(this.el, {
          scale,
          rootOpacity: this.before
            ? this.opacity
            : parseFloat(this.lens.originalOpacity || "1") *
              (this.lens._revealProgress ?? 1),
          ignoreElements: (el) =>
            el !== this.el &&
            (el.hasAttribute("data-liquid-ignore") || this.ignored(el)),
        });
        if (!plan) return null;
        this._paintState = NaughtyDOM.paintLayer(
          plan,
          this.canvas,
          this._paintState,
          resized || this._forceCapture,
        );
        if (plan.assets.length) Promise.all(plan.assets).then(this.invalidate);
        this.width = rect.width;
        this.height = rect.height;
        this.scale = scale;
        this.dirty = false;
        this._forceCapture = false;
        this.lastCapture = now;
        if (this._paintState.changed) this.version++;
      }
      if (!this.version) return null;
      return (this._frameRect = rect);
    }
  }

  function contentViewport(
    rect,
    canvas,
    origin = canvas.getBoundingClientRect(),
  ) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const left = (rect.left - origin.left) * dpr,
      top = (rect.top - origin.top) * dpr;
    const width = rect.width * dpr,
      height = rect.height * dpr;
    const x = Math.max(0, left),
      y = Math.max(0, top);
    const w = Math.min(canvas.width, left + width) - x;
    const h = Math.min(canvas.height, top + height) - y;
    if (w <= 0 || h <= 0) return null;
    return {
      x,
      y,
      w,
      h,
      uv: [(x - left) / width, (y - top) / height, w / width, h / height],
    };
  }

  class liquidGLRenderer {
    constructor(
      snapshotSelector,
      snapshotResolution = 1.0,
      engine = "auto",
      anchor = document.body,
    ) {
      this._anchor = anchor;
      this._engine = engine;
      this._destroyed = false;
      this._cleanups = [];
      this._naughtyQueued = false;
      this.canvas = document.createElement("canvas");
      this.canvas.style.cssText = `position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;`;
      this.canvas.setAttribute("data-liquid-ignore", "");
      this._anchor.appendChild(this.canvas);

      this.backend = null;
      this._backendFailed = false;
      this._pendingLensActivation = [];

      this.lenses = [];
      this._orderedLenses = [];
      this._contentLayers = [];
      this.hasTexture = false;
      this.textureWidth = 0;
      this.textureHeight = 0;
      this.scaleFactor = 1;
      this.startTime = Date.now();
      this._scrollUpdateCounter = 0;

      this._backendReady = this._selectBackend();

      this.snapshotTarget =
        document.querySelector(snapshotSelector) || document.body;
      if (!this.snapshotTarget) this.snapshotTarget = document.body;

      this._isScrolling = false;
      this._pendingViewportResize = false;
      let lastScrollY = window.scrollY;
      let scrollTimeout;
      const scrollCheck = () => {
        if (this._destroyed) return;
        if (window.scrollY !== lastScrollY) {
          this._isScrolling = true;
          lastScrollY = window.scrollY;
          clearTimeout(scrollTimeout);
          scrollTimeout = setTimeout(() => {
            this._isScrolling = false;
            if (this._pendingViewportResize) {
              this._pendingViewportResize = false;
              onResize();
            }
          }, 200);
        }
        this._scrollRaf = requestAnimationFrame(scrollCheck);
      };
      this._scrollRaf = requestAnimationFrame(scrollCheck);

      const onResize = debounce(() => {
        if (this._destroyed || this._capturing) return;
        if (this._isScrolling) {
          this._pendingViewportResize = true;
          return;
        }
        this._pendingViewportResize = false;

        if (window.visualViewport && window.visualViewport.scale !== 1) {
          return;
        }

        this._dynamicNodes.forEach((node) => {
          const meta = this._dynMeta.get(node.el);
          if (meta) {
            meta.needsRecapture = true;
            meta.prevDrawRect = null;
            meta.lastCapture = null;
          }
        });

        this._resizeCanvas();
        this.lenses.forEach((l) => l.updateMetrics());
        this.captureSnapshot();
      }, RECAPTURE_INTERVAL_MS);
      listen(
        this,
        window,
        "resize",
        () => {
          this._resizeCanvas();
          onResize();
        },
        { passive: true },
      );
      this._cleanups.push(() => {
        clearTimeout(scrollTimeout);
        onResize.cancel();
        cancelAnimationFrame(this._scrollRaf);
      });

      if ("ResizeObserver" in window) {
        const observer = new ResizeObserver(onResize);
        observer.observe(this.snapshotTarget);
        this._cleanups.push(() => observer.disconnect());
      }

      /* --------------------------------------------------
       *  Dynamic DOM elements (non-video, e.g. animating text)
       * ------------------------------------------------*/
      this._dynamicNodes = [];
      this._dynMeta = new Map();
      this._lastDynamicUpdate = 0;

      const styleEl = document.createElement("style");
      styleEl.id = "liquid-gl-dynamic-styles";
      document.head.appendChild(styleEl);
      this._styleEl = styleEl;
      this._dynamicStyleSheet = styleEl.sheet;

      this._snapshotResolution = Math.max(
        0.1,
        Math.min(3.0, snapshotResolution),
      );
      this._pendingReveal = [];

      this._resizeCanvas();
      this.captureSnapshot();

      /* --------------------------------------------------
       *  Dynamic media (video) support
       * ------------------------------------------------*/
      this._videoNodes = Array.from(
        this.snapshotTarget.querySelectorAll("video"),
      );
      this._videoNodes = this._videoNodes.filter((v) => !this._isIgnored(v));
      this._tmpCanvas = document.createElement("canvas");
      this._tmpCtx = this._tmpCanvas.getContext("2d");

      this._videoFrameState = new WeakMap();

      this._videoAlphaState = new WeakMap();

      this.canvas.style.opacity = "0";

      this.useExternalTicker = false;

      /* --------------------------------------------------
       *  Inline worker for heavy dynamic nodes
       * ------------------------------------------------*/
      this._workerEnabled =
        typeof OffscreenCanvas !== "undefined" &&
        typeof Worker !== "undefined" &&
        typeof ImageBitmap !== "undefined";

      if (this._workerEnabled) {
        const workerSrc = `
          /* dynamic-element worker (runs in its own thread) */
          self.onmessage = async (e) => {
            const { id, width, height, snap, dyn } = e.data;
            const off = new OffscreenCanvas(width, height);
            const ctx = off.getContext('2d');

            ctx.drawImage(snap, 0, 0, width, height);
            ctx.drawImage(dyn, 0, 0, width, height);

            const bmp = await off.transferToImageBitmap();
            self.postMessage({ id, bmp }, [bmp]);
          };
        `;
        const blob = new Blob([workerSrc], { type: "application/javascript" });
        this._workerUrl = URL.createObjectURL(blob);
        this._dynWorker = new Worker(this._workerUrl, {
          type: "module",
        });

        this._dynJobs = new Map();

        this._dynWorker.onmessage = (e) => {
          const { id, bmp } = e.data;
          const meta = this._dynJobs.get(id);
          if (meta) {
            this._dynJobs.delete(id);
            const { x, y } = meta;
            if (!this._destroyed && this.backend && this.hasTexture) {
              this.backend.uploadRegion(x, y, bmp);
              this._renderSignature = null;
            }
          }
          bmp.close();
        };
      }
    }

    /* ----------------------------- */
    async _selectBackend() {
      const chain = ENGINE_CHAINS[this._engine] || ENGINE_CHAINS.auto;
      let backend = null;

      if (chain[0] === "webgpu") {
        try {
          backend = await WebGPUBackend.create(this.canvas);
        } catch (e) {
          backend = null;
        }
      }

      if (this._destroyed) {
        destroyBackend(backend);
        return false;
      }
      if (!backend) {
        const glChain = chain.filter((c) => c !== "webgpu");
        if (glChain.length) {
          try {
            backend = new WebGLBackend(this.canvas, glChain);
          } catch (e) {
            backend = null;
          }
        }
      }

      this.backend = backend;

      if (!backend) {
        this._backendFailed = true;
        console.warn(
          "liquidGL: No GPU backend available – lenses will keep their original styles.",
        );
        return false;
      }

      backend.renderer = this;
      const pending = this._pendingLensActivation.splice(0);
      pending.forEach((ln) => ln._activate());
      return true;
    }

    /* ----------------------------- */
    _resizeCanvas() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const viewportWidth = document.documentElement.clientWidth || innerWidth;
      const viewportHeight = Math.max(
        document.documentElement.clientHeight,
        innerHeight,
      );
      const width = Math.trunc(viewportWidth * dpr);
      const height = Math.trunc(viewportHeight * dpr);
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      this.canvas.style.width = `${viewportWidth}px`;
      this.canvas.style.height = `${viewportHeight}px`;
      if (this.backend) this.backend.resize();
    }

    /* ----------------------------- */
    async captureSnapshot() {
      if (this._destroyed || this._capturing) return;
      this._capturing = true;

      const ready = await this._backendReady;
      if (!ready || this._destroyed) {
        this._capturing = false;
        return false;
      }

      const attemptCapture = async (
        attempt = 1,
        maxAttempts = 3,
        delayMs = 500,
      ) => {
        if (this._destroyed) return false;
        const generation = this._captureGeneration || 0;
        try {
          const fullW = this.snapshotTarget.scrollWidth;
          const fullH = this.snapshotTarget.scrollHeight;
          const maxTex = (this.backend && this.backend.maxTextureSize) || 8192;

          let scale = Math.min(
            this._snapshotResolution,
            maxTex / fullW,
            maxTex / fullH,
          );

          const maxArea = maxTex * maxTex;
          if (fullW * fullH * scale * scale > maxArea) {
            scale = Math.sqrt(maxArea / (fullW * fullH));
            console.warn(
              `liquidGL: snapshot area capped, resolution reduced to ${scale.toFixed(
                3,
              )} for a ${fullW}x${fullH} document.`,
            );
          }

          this.scaleFactor = Math.max(0.1, scale);

          const lensElements = new Set(
            Array.from(renderers)
              .flatMap((renderer) => renderer.lenses)
              .flatMap((lens) => [
                lens.el,
                lens._shadowEl,
                lens.options.content && lens._contentRoot,
              ])
              .filter(Boolean),
          );

          const ignoreElementsFunc = (element) => {
            if (!element || !element.hasAttribute) return false;
            if (element === this.canvas) {
              return true;
            }
            return (
              element.hasAttribute("data-liquid-ignore") ||
              element.closest("[data-liquid-ignore]")
            );
          };

          const naughtyIgnore = (el) =>
            ignoreElementsFunc(el) || lensElements.has(el);

          let backgroundColor = null;
          if (
            this.snapshotTarget === document.body ||
            this.snapshotTarget === document.documentElement
          ) {
            const rootStyle = window.getComputedStyle(document.documentElement);
            let color = parseTintColor(rootStyle.backgroundColor);
            if (!color?.[3] && rootStyle.backgroundImage === "none") {
              color = parseTintColor(
                window.getComputedStyle(document.body).backgroundColor,
              );
            }
            const [r, g, b, a] = color || [1, 1, 1, 1];
            backgroundColor = `rgb(${[r, g, b].map((channel) => (channel * a + 1 - a) * 255).join(",")})`;
          }
          const snapCanvas = await NaughtyDOM.rasteriseAsync(
            this.snapshotTarget,
            {
              width: fullW,
              height: fullH,
              scale: scale,
              backgroundColor,
              ignoreElements: naughtyIgnore,
            },
          );

          if (this._destroyed || generation !== (this._captureGeneration || 0))
            return false;
          if (!this._uploadTexture(snapCanvas, !!backgroundColor)) {
            throw new Error("liquidGL: snapshot could not be uploaded.");
          }
          return true;
        } catch (e) {
          if (this._destroyed) return false;
          console.error("liquidGL snapshot failed on attempt " + attempt, e);
          if (attempt < maxAttempts) {
            console.log(
              `Retrying snapshot capture (${attempt + 1}/${maxAttempts})...`,
            );
            await new Promise((resolve) => {
              this._retryResolve = resolve;
              this._retryTimeout = setTimeout(resolve, delayMs);
            });
            this._retryResolve = null;
            return await attemptCapture(attempt + 1, maxAttempts, delayMs);
          } else {
            console.error("liquidGL: All snapshot attempts failed.", e);
            return false;
          }
        } finally {
          this._capturing = false;
          if (!this._destroyed && generation !== (this._captureGeneration || 0))
            this.captureSnapshot();
        }
      };

      return await attemptCapture();
    }

    /* ----------------------------- */
    _uploadTexture(srcCanvas, opaque = false) {
      if (!srcCanvas) {
        console.error("liquidGL: snapshot produced no canvas.");
        return false;
      }

      if (!(srcCanvas instanceof HTMLCanvasElement)) {
        const tmp = document.createElement("canvas");
        tmp.width = srcCanvas.width || 0;
        tmp.height = srcCanvas.height || 0;
        if (tmp.width === 0 || tmp.height === 0) {
          console.error("liquidGL: snapshot canvas has zero dimensions.");
          return false;
        }
        try {
          const ctx = tmp.getContext("2d");
          ctx.drawImage(srcCanvas, 0, 0);
          srcCanvas = tmp;
        } catch (e) {
          console.error(
            "liquidGL: Unable to convert OffscreenCanvas for upload",
            e,
          );
          return false;
        }
      }

      if (srcCanvas.width === 0 || srcCanvas.height === 0) {
        console.error(
          "liquidGL: snapshot canvas has zero dimensions, requested area " +
            `${srcCanvas.width}x${srcCanvas.height} exceeds a browser limit.`,
        );
        return false;
      }
      this.staticSnapshotCanvas = srcCanvas;
      if (!this.backend || !this.backend.uploadSnapshot(srcCanvas)) {
        return false;
      }

      this.hasTexture = true;
      this._snapshotOpaque = opaque;
      this._renderSignature = null;
      this.textureWidth = srcCanvas.width;
      this.textureHeight = srcCanvas.height;
      this._invalidateDynamicRegion(
        0,
        0,
        this.textureWidth,
        this.textureHeight,
      );

      if (this._videoFrameState) this._videoFrameState = new WeakMap();

      this.render();

      if (this._pendingReveal.length) {
        this._pendingReveal.forEach((ln) => ln._reveal());
        this._pendingReveal.length = 0;
      }

      return true;
    }

    /* ----------------------------- */
    removeLens(lens) {
      this.lenses = this.lenses.filter((item) => item !== lens);
      this._orderedLenses = this._orderedLenses.filter((item) => item !== lens);
      this._pendingLensActivation = this._pendingLensActivation.filter(
        (item) => item !== lens,
      );
      this._pendingReveal = this._pendingReveal.filter((item) => item !== lens);
      lens._contentLayer?.destroy();
      this._contentLayers = this._contentLayers.filter(
        (layer) => layer.lens !== lens,
      );
      lens._contentLayer = null;
      for (const renderer of renderers) {
        if (renderer.backend) releaseCached(renderer.backend, lens);
        renderer._sceneLenses = null;
        renderer._renderSignature = null;
        renderer._captureGeneration = (renderer._captureGeneration || 0) + 1;
        for (const layer of renderer._contentLayers) layer.invalidate();
      }
      if (!this.lenses.length) this.destroy();
      else this._updateZIndex();
      renderAll();
      for (const renderer of renderers) renderer.captureSnapshot();
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      renderers.delete(this);
      this._cleanups.splice(0).forEach((cleanup) => cleanup());
      cancelAnimationFrame(this._revealRaf);
      cancelAnimationFrame(this._dirtyRaf);
      if (this._captureIdle != null) cancelIdleCallback(this._captureIdle);
      clearTimeout(this._captureTimeout);
      clearTimeout(this._retryTimeout);
      this._retryResolve?.();
      for (const [el, meta] of this._dynMeta) {
        cancelAnimationFrame(meta._rafId);
        if (meta.hoverClassName) el.classList.remove(meta.hoverClassName);
      }
      this._dynMeta.clear();
      this._dynamicNodes.length = 0;
      this._dynWorker?.terminate();
      if (this._workerUrl) URL.revokeObjectURL(this._workerUrl);
      this._dynJobs?.clear();
      for (const renderer of renderers) {
        if (renderer.backend && this._output)
          releaseCached(renderer.backend, this._output);
      }
      destroyBackend(this.backend);
      this.backend = null;
      this._styleEl.remove();
      this.canvas.remove();
      this.canvas.width = this.canvas.height = 0;
      this._output = this._outputCanvas = this.staticSnapshotCanvas = null;
      this._videoNodes.length = 0;
      this._videoComposites = null;
      if (window.__liquidGLRenderer__ === this)
        window.__liquidGLRenderer__ = renderers.values().next().value;
      if (!renderers.size) {
        cancelAnimationFrame(renderRaf);
        renderRaf = null;
        stopSync?.();
        stopSync = null;
        for (const [video, state] of videoFrames) {
          state.stopped = true;
          video.cancelVideoFrameCallback?.(state.callbackId);
        }
        videoFrames.clear();
        for (const image of videoImages.values()) image.heldSource?.close();
        videoImages.clear();
      } else startRendering();
    }

    _updateZIndex() {
      const maxZ = Math.max(...this.lenses.map((ln) => this._localLensZ(ln)));
      this.canvas.style.zIndex =
        this._anchor !== document.body ||
        this.lenses.some((ln) => ln.options.zIndex != null)
          ? maxZ - 1
          : Math.max(0, maxZ - 1);
    }

    addLens(element, options) {
      const lens = new liquidGLLens(this, element, options);
      lens._contentRoot =
        typeof options.content === "string"
          ? document.querySelector(options.content)
          : element;
      for (const layer of this._contentLayers) layer.invalidate();
      lens._order = lensOrder++;
      this.lenses.push(lens);
      this._orderedLenses = this.lenses
        .slice()
        .sort(
          (a, b) =>
            (a.options.zIndex ?? 0) - (b.options.zIndex ?? 0) ||
            a._order - b._order,
        );

      this._updateZIndex();
      if (element !== this._anchor) {
        let branch = element;
        while (branch.parentElement && branch.parentElement !== this._anchor) {
          branch = branch.parentElement;
        }
        if (
          branch.parentElement === this._anchor &&
          branch.compareDocumentPosition(this.canvas) &
            Node.DOCUMENT_POSITION_FOLLOWING
        ) {
          this._anchor.insertBefore(this.canvas, branch);
        }
      }

      if (this.backend) {
        lens._activate();
      } else {
        this._pendingLensActivation.push(lens);
      }

      if (!this.hasTexture) {
        this._pendingReveal.push(lens);
      } else {
        lens._reveal();
      }
      return lens;
    }

    /* ----------------------------- */
    _prepareContentLayers() {
      for (const lens of this.lenses) {
        if (
          !lens._activated ||
          lens.options.content === false ||
          lens._contentLayer
        )
          continue;
        const root = lens._contentRoot;
        if (
          !root ||
          !root.childElementCount ||
          ((this._sceneLenses || this.lenses).length === 1 &&
            !lens.options.content)
        )
          continue;
        const layer = new LiquidContentLayer(this, lens, root);
        lens._contentLayer = layer;
        this._contentLayers.push(layer);
      }
    }

    _renderContent(lens, before) {
      const layer = lens._contentLayer;
      if (!layer || layer.before !== before) return;
      this._drawContentLayer(layer);
    }

    _drawContentLayer(layer) {
      const lens = layer.lens;
      if (!layer.el.isConnected) {
        layer.el.removeAttribute("data-liquidgl-content");
        return;
      }
      const rect = layer.update(performance.now());
      if (!rect) return;
      if (this.backend.drawContent(layer, rect)) {
        if (!layer.el.hasAttribute("data-liquidgl-content")) {
          layer.el.setAttribute("data-liquidgl-content", String(lens._order));
        }
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        this._frameLensRects.push({
          x: Math.floor((rect.left - this._frameCanvasRect.left) * dpr),
          y: Math.floor(
            this.canvas.height -
              (rect.bottom - this._frameCanvasRect.top) * dpr,
          ),
          w: Math.ceil(rect.width * dpr),
          h: Math.ceil(rect.height * dpr),
        });
      }
    }

    render() {
      if (this._destroyed || this._tearingDown || rendering || document.hidden)
        return;
      rendering = true;
      renderFrame++;
      const tiltMeasurements = [];
      try {
        const ordered = orderedRenderers();
        const lenses = ordered.flatMap((renderer) => renderer._orderedLenses);
        for (const lens of lenses) {
          if (
            lens._mirrorActive &&
            lens._tiltMeasureStyle &&
            lens.renderer.lenses.some(
              (child) => child !== lens && lens.el.contains(child.el),
            )
          ) {
            tiltMeasurements.push(lens);
            lens._tiltMeasureStyle.setProperty(
              "transform",
              lens._tiltBaseTransform,
              "important",
            );
          }
        }
        for (const lens of lenses) lens.updateMetrics();
        for (const renderer of ordered) {
          renderer._sceneLenses = lenses;
          renderer._prepareContentLayers();
        }
        const lower = [];
        const visible = (rect, margin = 0) =>
          rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left < innerWidth + margin &&
          rect.top < innerHeight + margin &&
          rect.left + rect.width > -margin &&
          rect.top + rect.height > -margin;
        for (const renderer of ordered) {
          if (!renderer.backend || !renderer.hasTexture) continue;
          const active =
            renderer.lenses.some((lens) =>
              visible(
                lens.rectPx,
                lens.options.interaction === "fluid"
                  ? (lens.options.shadow ? 70 : 0) +
                      Math.min(
                        lens.rectPx?.width || 0,
                        lens.rectPx?.height || 0,
                      ) *
                        unitOption(lens.options.interactionStrength, 0.5, 5) *
                        0.12
                  : 0,
              ),
            ) ||
            renderer._contentLayers.some((layer) =>
              visible(layer.el.getBoundingClientRect()),
            );
          if (renderer._visible !== active) {
            renderer._visible = active;
            renderer.canvas.style.visibility = active ? "visible" : "hidden";
          }
          if (!active) continue;
          if (renderer._needsFrame(lower)) renderer._renderFrame(lower);
          lower.push(renderer);
        }
      } finally {
        for (const lens of tiltMeasurements) {
          lens._tiltMeasureStyle.removeProperty("transform");
        }
        rendering = false;
      }
    }

    _needsFrame(lower) {
      const state = [
        innerWidth,
        innerHeight,
        window.devicePixelRatio,
        window.scrollX,
        window.scrollY,
      ];
      const rectState = (rect) =>
        state.push(rect?.left, rect?.top, rect?.width, rect?.height);
      rectState(this.canvas.getBoundingClientRect());
      rectState(this.snapshotTarget.getBoundingClientRect());
      let animated = false;
      this._videoSampleAreas = [];
      for (const lens of this._sceneLenses) {
        rectState(lens.rectPx);
        state.push(
          lens.radiusCss,
          lens.tiltX,
          lens.tiltY,
          lens._revealProgress,
          lens._mirrorActive,
          lens._fluid?.value,
        );
        const options = lens.options;
        if (lens.renderer === this)
          state.push(
            options.refraction,
            options.aberration,
            options.bevelDepth,
            options.bevelWidth,
            options.frost,
            options.specular,
            options.magnify,
            options.shadow,
            options.tint,
            options.interaction,
            options.interactionStrength,
            options.interactionRadius,
            options.interactionViscosity,
          );
        if (lens.renderer === this) {
          const rect = lens.rectPx;
          if (rect) {
            const mag = Math.max(0.001, Math.min(3, options.magnify ?? 1));
            const displacement =
              (Math.abs(options.refraction) + Math.abs(options.bevelDepth)) *
              (1 + Math.abs(options.aberration || 0));
            const frost =
              Math.max(1, (options.frost || 0) * 4) /
              Math.min(
                this.scaleFactor,
                Math.min(2, window.devicePixelRatio || 1),
              );
            const fluidReach =
              options.interaction === "fluid"
                ? Math.min(rect.width, rect.height) *
                  0.12 *
                  unitOption(options.interactionStrength, 0.5, 5)
                : 0;
            const dx =
              rect.width / mag / 2 +
              frost +
              ((displacement +
                Math.abs(Math.tan(((lens.tiltY || 0) * Math.PI) / 180)) *
                  0.05) *
                this.textureWidth) /
                this.scaleFactor +
              Math.max(
                fluidReach,
                Math.abs(lens._fluid?.value[2] || 0) * rect.width,
              ) /
                mag;
            const dy =
              rect.height / mag / 2 +
              frost +
              ((displacement +
                Math.abs(Math.tan(((lens.tiltX || 0) * Math.PI) / 180)) *
                  0.05) *
                this.textureHeight) /
                this.scaleFactor +
              Math.max(
                fluidReach,
                Math.abs(lens._fluid?.value[3] || 0) * rect.height,
              ) /
                mag;
            this._videoSampleAreas.push({
              left: rect.left + rect.width / 2 - dx,
              top: rect.top + rect.height / 2 - dy,
              width: dx * 2,
              height: dy * 2,
            });
          }
          animated ||= !!(
            options.specular &&
            rect &&
            rect.left < innerWidth &&
            rect.top < innerHeight &&
            rect.left + rect.width > 0 &&
            rect.top + rect.height > 0
          );
          animated ||= !!lens._fluid?.value?.some(
            (value, i) => i > 1 && Math.abs(value) > 0.00001,
          );
        }
      }
      const pointer = this._fluidPointer;
      state.push(pointer?.active, pointer?.x, pointer?.y, pointer?.time);
      animated ||= !!(
        pointer?.active &&
        (pointer.vx || pointer.vy) &&
        performance.now() - pointer.time < 250
      );
      const now = performance.now();
      for (const renderer of [...lower, this]) {
        if (renderer !== this) state.push(renderer._output?.version);
        for (const layer of renderer._contentLayers) {
          const rect = layer.update(now);
          rectState(rect);
          if (rect && layer.backdrop) {
            const margin = layer.backdrop.blur * 3;
            this._videoSampleAreas.push({
              left: rect.left - margin,
              top: rect.top - margin,
              width: rect.width + margin * 2,
              height: rect.height + margin * 2,
            });
          }
          state.push(layer.version, layer.opacity, layer.backdrop);
          animated ||= !!layer.animations;
        }
      }
      for (const video of this._videoNodes) {
        if (this._isIgnored(video)) continue;
        const rect = video.getBoundingClientRect();
        if (!this._videoRelevant(rect)) continue;
        rectState(rect);
        state.push(
          videoFrame(video),
          video.readyState,
          video.seeking,
          getComputedStyle(video).opacity,
        );
      }
      animated ||= this._dynamicNodes.some(({ el }) => {
        if (
          this._contentLayers.some((layer) => layer.el.contains(el)) ||
          this._isIgnored(el) ||
          effectiveZ(el) >= this._getMaxLensZ() ||
          !this._videoRelevant(el.getBoundingClientRect())
        )
          return false;
        const meta = this._dynMeta.get(el);
        return (
          meta && (meta._animating || meta.needsRecapture || meta._capturing)
        );
      });
      const signature = JSON.stringify(state);
      const changed = signature !== this._renderSignature;
      this._renderSignature = signature;
      return animated || changed;
    }

    _videoRelevant(rect) {
      return (
        !this._videoSampleAreas ||
        this._videoSampleAreas.some(
          (area) =>
            rect.left < area.left + area.width &&
            rect.left + rect.width > area.left &&
            rect.top < area.top + area.height &&
            rect.top + rect.height > area.top,
        )
      );
    }

    _renderFrame(lower) {
      const backend = this.backend;

      const dprNow = Math.min(2, window.devicePixelRatio || 1);
      const bufW = Math.trunc(
        (document.documentElement.clientWidth || innerWidth) * dprNow,
      );
      const bufH = Math.trunc(
        Math.max(document.documentElement.clientHeight, innerHeight) * dprNow,
      );
      if (this.canvas.width !== bufW || this.canvas.height !== bufH) {
        this._resizeCanvas();
      }

      const canvasRect = this.canvas.getBoundingClientRect();
      if (canvasRect.left || canvasRect.top) {
        this.canvas.style.left = `${parseFloat(this.canvas.style.left) - canvasRect.left}px`;
        this.canvas.style.top = `${parseFloat(this.canvas.style.top) - canvasRect.top}px`;
      }
      this._frameCanvasRect = this.canvas.getBoundingClientRect();

      if (this._isScrolling) {
        this._scrollUpdateCounter++;
      }

      const time = (Date.now() - this.startTime) / 1000;

      this._prepareContentLayers();
      backend.beginFrame(
        this.canvas.width,
        this.canvas.height,
        time,
        this._contentLayers.length > 0 || lower.length > 0,
      );

      if (this._updateDynamicVideos() !== false) this._updateDynamicNodes();

      this._frameSnapRect = this.snapshotTarget.getBoundingClientRect();
      this._frameLensRects = [];

      for (const renderer of lower) {
        for (const layer of renderer._contentLayers) {
          if (layer.before) this._drawContentLayer(layer);
        }
        if (backend.drawContent(renderer._output, renderer._frameCanvasRect)) {
          const dx =
            (renderer._frameCanvasRect.left - this._frameCanvasRect.left) *
            dprNow;
          const dy =
            this.canvas.height -
            renderer.canvas.height +
            (this._frameCanvasRect.top - renderer._frameCanvasRect.top) *
              dprNow;
          this._frameLensRects.push(
            ...renderer._ownFrameLensRects.map((rect) => ({
              ...rect,
              x: rect.x + dx,
              y: rect.y + dy,
            })),
          );
        }
        for (const layer of renderer._contentLayers) {
          if (!layer.before) this._drawContentLayer(layer);
        }
      }

      const ownStart = this._frameLensRects.length;
      this._orderedLenses.forEach((lens) => {
        this._renderContent(lens, true);
        this._renderLens(lens);
        this._renderContent(lens, false);
        if (lens._mirrorActive && lens._mirrorClipUpdater) {
          lens._mirrorClipUpdater();
        }
      });

      backend.endFrame();
      this._ownFrameLensRects = this._frameLensRects.slice(ownStart);
      this._output ||= { canvas: this.canvas, version: 0 };
      this._output.device = backend.device;
      this._output.texture = backend._outputTexture;
      this._output.version++;
      if (this.lenses.some((lens) => lens._mirrorActive)) {
        this._outputCanvas ||= document.createElement("canvas");
        this._outputCanvas.width = this.canvas.width;
        this._outputCanvas.height = this.canvas.height;
        this._outputCanvas.getContext("2d").drawImage(this.canvas, 0, 0);
        this._output.canvas = this._outputCanvas;
      } else {
        this._output.canvas = this.canvas;
      }
      this._contentLayers.forEach((layer) => layer.updateMask());

      this.lenses.forEach((ln) => {
        if (ln._mirrorActive && ln._mirrorCtx) {
          const mirror = ln._mirror;
          if (
            mirror.width !== this.canvas.width ||
            mirror.height !== this.canvas.height
          ) {
            mirror.width = this.canvas.width;
            mirror.height = this.canvas.height;
          }
          ln._mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
          ln._mirrorCtx.drawImage(this.canvas, 0, 0);
        }
      });

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const clearRects = [];
      this.lenses.forEach((ln) => {
        if (ln._mirrorActive && ln.rectPx) {
          const { left, top, width, height } = ln._fluidDrawRect || ln.rectPx;
          const expand = 2;
          const x = Math.max(
            0,
            Math.round((left - this._frameCanvasRect.left) * dpr) - expand,
          );
          const y = Math.max(
            0,
            Math.round(
              this.canvas.height -
                (top + height - this._frameCanvasRect.top) * dpr,
            ) - expand,
          );
          const w = Math.min(
            this.canvas.width - x,
            Math.round(width * dpr) + expand * 2,
          );
          const h = Math.min(
            this.canvas.height - y,
            Math.round(height * dpr) + expand * 2,
          );
          if (w > 0 && h > 0) {
            clearRects.push({ x, y, w, h });
          }
        }
      });
      backend.clearRegions(clearRects);
    }

    /* ----------------------------- */
    _updateInteraction(lens, now) {
      const options = lens.options;
      if (options.interaction !== "fluid") {
        lens._fluid = null;
        return INTERACTION_OFF;
      }
      if (!this._fluidPointer) {
        const pointer = (this._fluidPointer = {
          active: false,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          time: 0,
          id: null,
        });
        const stop = () => {
          pointer.active = false;
          pointer.vx = pointer.vy = 0;
        };
        const move = (event) => {
          if (!event.isPrimary) return;
          const time = performance.now();
          const dt = time - pointer.time;
          const continuous =
            pointer.active &&
            pointer.id === event.pointerId &&
            dt > 0 &&
            dt < 100;
          pointer.vx = continuous ? (event.clientX - pointer.x) / dt : 0;
          pointer.vy = continuous ? (event.clientY - pointer.y) / dt : 0;
          pointer.x = event.clientX;
          pointer.y = event.clientY;
          pointer.time = time;
          pointer.id = event.pointerId;
          pointer.active =
            event.pointerType === "mouse" ||
            event.buttons > 0 ||
            event.type === "pointerdown";
        };
        const listenerOptions = { passive: true, capture: true };
        listen(this, window, "pointermove", move, listenerOptions);
        listen(this, window, "pointerdown", move, listenerOptions);
        listen(
          this,
          window,
          "pointerup",
          (event) => {
            if (event.isPrimary && event.pointerType !== "mouse") stop();
          },
          listenerOptions,
        );
        listen(
          this,
          window,
          "pointercancel",
          (event) => {
            if (event.isPrimary) stop();
          },
          listenerOptions,
        );
        listen(
          this,
          window,
          "pointerout",
          (event) => {
            if (!event.relatedTarget && event.isPrimary) stop();
          },
          listenerOptions,
        );
        listen(this, window, "blur", stop);
        listen(this, document, "visibilitychange", () => {
          if (document.hidden) stop();
        });
      }
      const rect = lens.rectPx;
      const pointer = this._fluidPointer;
      const size = Math.min(rect.width, rect.height);
      const x = (pointer.x - rect.left) / rect.width;
      const y = (pointer.y - rect.top) / rect.height;
      const radius = lens.radiusCss || 0;
      const qx = Math.max(
        Math.abs(pointer.x - rect.left - rect.width / 2) -
          rect.width / 2 +
          radius,
        0,
      );
      const qy = Math.max(
        Math.abs(pointer.y - rect.top - rect.height / 2) -
          rect.height / 2 +
          radius,
        0,
      );
      const inside =
        pointer.active &&
        x >= 0 &&
        x <= 1 &&
        y >= 0 &&
        y <= 1 &&
        Math.hypot(qx, qy) <= radius;
      const state =
        lens._fluid ||
        (lens._fluid = { time: now, inside: false, value: [x, y, 0, 0] });
      const value = state.value;
      const dt = Math.max(0, now - state.time);
      state.time = now;
      const viscosity = unitOption(options.interactionViscosity, 0.65);
      const follow = 1 - Math.exp(-dt / (25 + viscosity * 180));
      const settle = 1 - Math.exp(-dt / (80 + viscosity * 620));
      let dx = 0,
        dy = 0;
      if (inside) {
        if (!state.inside && Math.hypot(value[2], value[3]) < 0.0001) {
          value[0] = x;
          value[1] = y;
        }
        value[0] += (x - value[0]) * follow;
        value[1] += (y - value[1]) * follow;
        const speed = Math.hypot(pointer.vx, pointer.vy);
        const amount =
          Math.min(size * 0.12, speed * 45) *
          unitOption(options.interactionStrength, 0.5, 5) *
          Math.exp(-Math.max(0, now - pointer.time) / 70);
        if (speed > 0) {
          dx = ((pointer.vx / speed) * amount) / rect.width;
          dy = ((pointer.vy / speed) * amount) / rect.height;
        }
      }
      const easing =
        Math.hypot(dx, dy) > Math.hypot(value[2], value[3]) ? follow : settle;
      value[2] += (dx - value[2]) * easing;
      value[3] += (dy - value[3]) * easing;
      if (
        unitOption(options.interactionStrength, 0.5, 5) === 0 ||
        Math.hypot(value[2], value[3]) < 0.00001
      )
        value[2] = value[3] = 0;
      state.inside = inside;
      return value;
    }

    _renderLens(lens) {
      const rect = lens.rectPx;
      if (!rect) return;

      const dpr = Math.min(2, window.devicePixelRatio || 1);

      const origin =
        this._frameCanvasRect || this.canvas.getBoundingClientRect();
      const overscrollX = -origin.left;
      const overscrollY = -origin.top;

      if (rect.width <= 0 || rect.height <= 0) return;
      const interaction = this._updateInteraction(lens, performance.now());
      const interactionRadius =
        interaction[2] || interaction[3]
          ? unitOption(lens.options.interactionRadius, 0.35, 5)
          : 0;
      if (lens._syncShadowMode) lens._syncShadowMode();
      const shadow =
        lens.options.interaction === "fluid" && lens.options.shadow;
      const expandX =
        Math.ceil(shadow ? 60 * dpr : 0) +
        (interactionRadius > 0
          ? Math.ceil(Math.abs(interaction[2]) * rect.width * dpr) + 1
          : 0);
      const expandY =
        Math.ceil(shadow ? 70 * dpr : 0) +
        (interactionRadius > 0
          ? Math.ceil(Math.abs(interaction[3]) * rect.height * dpr) + 1
          : 0);
      const leftPx = (rect.left + overscrollX) * dpr;
      const topPx = (rect.top + overscrollY) * dpr;
      const x = Math.round(leftPx) - expandX;
      const yTop = Math.round(topPx) - expandY;
      const w = Math.round(leftPx + rect.width * dpr) + expandX - x;
      const h = Math.round(topPx + rect.height * dpr) + expandY - yTop;
      const y = this.canvas.height - (yTop + h);
      lens._fluidDrawRect =
        expandX || expandY
          ? {
              left: x / dpr + origin.left,
              top: yTop / dpr + origin.top,
              width: w / dpr,
              height: h / dpr,
              right: (x + w) / dpr + origin.left,
              bottom: (yTop + h) / dpr + origin.top,
            }
          : null;

      const snapRect =
        this._frameSnapRect || this.snapshotTarget.getBoundingClientRect();
      const docX = rect.left - snapRect.left;
      const docY = rect.top - snapRect.top;
      const leftUV = (docX * this.scaleFactor) / this.textureWidth;
      const topUV = (docY * this.scaleFactor) / this.textureHeight;
      const wUV = (rect.width * this.scaleFactor) / this.textureWidth;
      const hUV = (rect.height * this.scaleFactor) / this.textureHeight;

      const mag = Math.max(
        0.001,
        Math.min(
          3.0,
          lens.options.magnify !== undefined ? lens.options.magnify : 1.0,
        ),
      );

      if (
        w <= 0 ||
        h <= 0 ||
        x >= this.canvas.width ||
        y >= this.canvas.height ||
        x + w <= 0 ||
        y + h <= 0
      )
        return;
      const stackMapping = [
        ((snapRect.left + overscrollX) * dpr) / this.canvas.width,
        ((snapRect.top + overscrollY) * dpr) / this.canvas.height,
        ((this.textureWidth / this.scaleFactor) * dpr) / this.canvas.width,
        ((this.textureHeight / this.scaleFactor) * dpr) / this.canvas.height,
      ];
      const prior = this._frameLensRects;
      let stackRegion = null;
      if (prior.length) {
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (const r of prior) {
          minX = Math.min(minX, r.x);
          minY = Math.min(minY, r.y);
          maxX = Math.max(maxX, r.x + r.w);
          maxY = Math.max(maxY, r.y + r.h);
        }
        const displacement =
          (Math.abs(lens.options.refraction) +
            Math.abs(lens.options.bevelDepth)) *
          (1 + Math.abs(lens.options.aberration || 0));
        const frost =
          (Math.max(1, (lens.options.frost || 0) * 4) * dpr) / this.scaleFactor;
        const padX =
          (((displacement +
            Math.abs(Math.tan(((lens.tiltY || 0) * Math.PI) / 180)) * 0.05) *
            this.textureWidth) /
            this.scaleFactor) *
            dpr +
          frost +
          Math.abs(interaction[2]) * rect.width * dpr +
          1;
        const padY =
          (((displacement +
            Math.abs(Math.tan(((lens.tiltX || 0) * Math.PI) / 180)) * 0.05) *
            this.textureHeight) /
            this.scaleFactor) *
            dpr +
          frost +
          Math.abs(interaction[3]) * rect.height * dpr +
          1;
        const sx = Math.max(
          0,
          Math.floor(x + w * 0.5 - (w / mag) * 0.5 - padX),
          minX,
        );
        const sy = Math.max(
          0,
          Math.floor(y + h * 0.5 - (h / mag) * 0.5 - padY),
          minY,
        );
        const ex = Math.min(
          this.canvas.width,
          Math.ceil(x + w * 0.5 + (w / mag) * 0.5 + padX),
          maxX,
        );
        const ey = Math.min(
          this.canvas.height,
          Math.ceil(y + h * 0.5 + (h / mag) * 0.5 + padY),
          maxY,
        );
        if (ex > sx && ey > sy)
          stackRegion = { x: sx, y: sy, w: ex - sx, h: ey - sy };
      }
      prior.push({ x, y, w, h });
      this.backend.drawLens(lens, {
        shadow,
        dpr,
        interaction,
        interactionRadius,
        stackMapping,
        stackRegion,
        x,
        y,
        w,
        h,
        subX: leftPx - x,
        subY: this.canvas.height - topPx - rect.height * dpr - y,
        boxW: rect.width * dpr,
        boxH: rect.height * dpr,
        bounds: [leftUV, topUV, wUV, hUV],
        texW:
          this.textureWidth *
          (lens._contentLayer?.before ? dpr / this.scaleFactor : 1),
        texH:
          this.textureHeight *
          (lens._contentLayer?.before ? dpr / this.scaleFactor : 1),
        refraction: lens.options.refraction,
        aberration: lens.options.aberration || 0,
        bevelDepth: lens.options.bevelDepth,
        bevelWidth: lens.options.bevelWidth,
        frost: lens.options.frost,
        radius: lens.radiusGl,
        specular: lens.options.specular ? 1 : 0,
        revealProgress: lens._revealProgress || 1.0,
        revealType: lens.revealTypeIndex || 0,
        magnify: mag,
        tiltX: lens.tiltX || 0,
        tiltY: lens.tiltY || 0,
        tint: lens.options.tint || TINT_OFF,
      });
    }

    /* ----------------------------- */
    _createRoundedRectPath(ctx, w, h, radii) {
      ctx.beginPath();
      ctx.moveTo(radii.tl, 0);
      ctx.lineTo(w - radii.tr, 0);
      ctx.arcTo(w, 0, w, radii.tr, radii.tr);
      ctx.lineTo(w, h - radii.br);
      ctx.arcTo(w, h, w - radii.br, h, radii.br);
      ctx.lineTo(radii.bl, h);
      ctx.arcTo(0, h, 0, h - radii.bl, radii.bl);
      ctx.lineTo(0, radii.tl);
      ctx.arcTo(0, 0, radii.tl, 0, radii.tl);
      ctx.closePath();
    }

    _videoIsOpaque(vid) {
      if (!vid.videoWidth || !vid.videoHeight) return false;

      const key = vid.videoWidth + "x" + vid.videoHeight;
      const cached = this._videoAlphaState.get(vid);
      if (cached && cached.key === key) return cached.opaque;

      let opaque = false;
      try {
        const probe =
          this._alphaProbeCanvas ||
          (this._alphaProbeCanvas = document.createElement("canvas"));
        const size = 32;
        probe.width = size;
        probe.height = size;
        const ctx = probe.getContext("2d", { willReadFrequently: true });
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(vid, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        opaque = true;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] !== 255) {
            opaque = false;
            break;
          }
        }
      } catch (e) {
        opaque = false;
      }

      this._videoAlphaState.set(vid, { key, opaque });
      return opaque;
    }

    /* ----------------------------- */
    _compositeVideoFrame(vid, vidIndex, image, opacity, rect, region) {
      if (
        this._videoFadeFailed ||
        this.backend._videoFadeFailed ||
        (!this.backend._videoResolvePipe &&
          (!this._snapshotOpaque ||
            region.texX < 0 ||
            region.texY < 0 ||
            region.texX + region.texW > this.textureWidth ||
            region.texY + region.texH > this.textureHeight))
      )
        return false;
      this._videoComposites ||= new WeakMap();
      let entry = this._videoComposites.get(vid);
      if (!entry) {
        entry = {
          background: { canvas: document.createElement("canvas"), version: 0 },
          sources: new WeakMap(),
        };
        this._videoComposites.set(vid, entry);
      }
      const {
        texX,
        texY,
        texW,
        texH,
        drawW,
        drawH,
        srcX,
        srcY,
        dstX,
        dstY,
        updW,
        updH,
      } = region;
      const prepare = (content, source, key, draw) => {
        if (content.source === source && content.key === key) return;
        const canvas = content.canvas;
        if (canvas.width !== updW) canvas.width = updW;
        if (canvas.height !== updH) canvas.height = updH;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, updW, updH);
        draw(ctx);
        content.source = source;
        content.key = key;
        content.version++;
      };
      try {
        const key = [
          texX,
          texY,
          texW,
          texH,
          drawW,
          drawH,
          srcX,
          srcY,
          updW,
          updH,
        ].join(",");
        prepare(entry.background, this.staticSnapshotCanvas, key, (ctx) => {
          ctx.drawImage(
            this.staticSnapshotCanvas,
            texX,
            texY,
            texW,
            texH,
            -srcX,
            -srcY,
            drawW,
            drawH,
          );
        });
        const layers = [{ content: entry.background, opacity: 1 }];
        const add = (video, frame, alpha, x, y, w, h) => {
          if (!frame || alpha === 0) return;
          let content = entry.sources.get(video);
          if (!content) {
            content = { canvas: document.createElement("canvas"), version: 0 };
            entry.sources.set(video, content);
          }
          content.external =
            w > 0 && h > 0 && this._videoIsOpaque(video)
              ? this.backend.getExternalVideo?.(frame.source)
              : null;
          if (content.external) {
            content.uv = [(srcX - x) / w, (srcY - y) / h, updW / w, updH / h];
            content.clip = [x - srcX, y - srcY, w, h];
            layers.push({ content, opacity: alpha });
            return;
          }
          const key = [x, y, w, h, srcX, srcY, updW, updH].join(",");
          prepare(content, frame.version, key, (ctx) => {
            ctx.drawImage(frame.source, x - srcX, y - srcY, w, h);
          });
          layers.push({ content, opacity: alpha });
        };
        for (let j = 0; j < vidIndex; j++) {
          const below = this._videoNodes[j];
          if (this._isIgnored(below)) continue;
          const alpha = Math.max(
            0,
            Math.min(1, parseFloat(getComputedStyle(below).opacity) || 0),
          );
          if (alpha === 0) continue;
          const bounds = below.getBoundingClientRect();
          if (
            bounds.left >= rect.right ||
            bounds.right <= rect.left ||
            bounds.top >= rect.bottom ||
            bounds.bottom <= rect.top
          )
            continue;
          add(
            below,
            videoImage(below),
            alpha,
            (bounds.left - rect.left) * this.scaleFactor,
            (bounds.top - rect.top) * this.scaleFactor,
            bounds.width * this.scaleFactor,
            bounds.height * this.scaleFactor,
          );
        }
        add(vid, image, opacity, 0, 0, drawW, drawH);
        return this.backend.compositeVideo(layers, dstX, dstY, updW, updH);
      } catch (e) {
        this._videoFadeFailed = true;
        return false;
      }
    }

    _updateDynamicVideos() {
      if (
        !this.hasTexture ||
        !this.staticSnapshotCanvas ||
        !this._videoNodes.length
      )
        return;

      const snapRect = this.snapshotTarget.getBoundingClientRect();

      const maxLensZ = this._getMaxLensZ();
      if (
        this._videoNodes.some(
          (vid) =>
            this._videoFrameState.has(vid) &&
            !videoImages.get(vid)?.retained &&
            (vid.seeking || vid.readyState < 2) &&
            !this._isIgnored(vid) &&
            this._videoRelevant(vid.getBoundingClientRect()) &&
            effectiveZ(vid) < maxLensZ &&
            parseFloat(window.getComputedStyle(vid).opacity) > 0,
        )
      )
        return false;

      const updatedRects = [];
      this._videoNodes.forEach((vid, vidIndex) => {
        if (effectiveZ(vid) >= maxLensZ) {
          return;
        }

        if (this._isIgnored(vid)) return;

        const vidOpacity = Math.max(
          0,
          Math.min(1, parseFloat(window.getComputedStyle(vid).opacity) || 0),
        );

        const rect = vid.getBoundingClientRect();
        if (!this._videoRelevant(rect)) return;
        const image = videoImage(vid);
        if (!image) return;
        const texX = (rect.left - snapRect.left) * this.scaleFactor;
        const texY = (rect.top - snapRect.top) * this.scaleFactor;
        const texW = rect.width * this.scaleFactor;
        const texH = rect.height * this.scaleFactor;

        const drawW = Math.round(texW);
        const drawH = Math.round(texH);

        if (drawW <= 0 || drawH <= 0) return;

        const drawX = Math.round(texX);
        const drawY = Math.round(texY);
        const minX = Math.max(0, drawX);
        const minY = Math.max(0, drawY);
        const maxX = Math.min(this.textureWidth, drawX + drawW);
        const maxY = Math.min(this.textureHeight, drawY + drawH);
        if (maxX <= minX || maxY <= minY) return;

        let dstX = minX,
          dstY = minY,
          endX = maxX,
          endY = maxY;
        if (this._videoSampleAreas) {
          dstX = maxX;
          dstY = maxY;
          endX = minX;
          endY = minY;
          for (const area of this._videoSampleAreas) {
            const left = Math.max(
              minX,
              Math.floor((area.left - snapRect.left) * this.scaleFactor) - 2,
            );
            const top = Math.max(
              minY,
              Math.floor((area.top - snapRect.top) * this.scaleFactor) - 2,
            );
            const right = Math.min(
              maxX,
              Math.ceil(
                (area.left + area.width - snapRect.left) * this.scaleFactor,
              ) + 2,
            );
            const bottom = Math.min(
              maxY,
              Math.ceil(
                (area.top + area.height - snapRect.top) * this.scaleFactor,
              ) + 2,
            );
            if (right <= left || bottom <= top) continue;
            dstX = Math.min(dstX, left);
            dstY = Math.min(dstY, top);
            endX = Math.max(endX, right);
            endY = Math.max(endY, bottom);
          }
        }
        const srcX = dstX - drawX;
        const srcY = dstY - drawY;
        const updW = endX - dstX;
        const updH = endY - dstY;
        if (updW <= 0 || updH <= 0) return;

        const geomKey = [
          drawX,
          drawY,
          drawW,
          drawH,
          dstX,
          dstY,
          updW,
          updH,
        ].join(",");
        const prevState = this._videoFrameState.get(vid);
        if (
          vidOpacity === 0 &&
          prevState?.opacity === 0 &&
          prevState.geom === geomKey
        )
          return;
        const frame = image.version;
        const unchangedRegion =
          prevState &&
          prevState.geom === geomKey &&
          prevState.opacity === vidOpacity &&
          !updatedRects.some(
            (updated) =>
              updated.left < rect.right &&
              updated.right > rect.left &&
              updated.top < rect.bottom &&
              updated.bottom > rect.top,
          );

        if (unchangedRegion && (vidOpacity === 0 || prevState.time === frame))
          return;
        const frameState = {
          time: frame,
          geom: geomKey,
          opacity: vidOpacity,
        };

        const style = window.getComputedStyle(vid);
        const scaledRadii = {
          tl: parseFloat(style.borderTopLeftRadius) * this.scaleFactor,
          tr: parseFloat(style.borderTopRightRadius) * this.scaleFactor,
          br: parseFloat(style.borderBottomRightRadius) * this.scaleFactor,
          bl: parseFloat(style.borderBottomLeftRadius) * this.scaleFactor,
        };
        const isRounded = Object.values(scaledRadii).some((r) => r > 0);

        if (
          !isRounded &&
          vidOpacity < 1 &&
          this._compositeVideoFrame(vid, vidIndex, image, vidOpacity, rect, {
            texX,
            texY,
            texW,
            texH,
            drawW,
            drawH,
            srcX,
            srcY,
            dstX,
            dstY,
            updW,
            updH,
          })
        ) {
          this._videoFrameState.set(vid, frameState);
          updatedRects.push(rect);
          return;
        }

        if (
          !isRounded &&
          vidOpacity >= 1 &&
          this._videoIsOpaque(vid) &&
          this.backend.blitVideo(
            vid,
            dstX,
            dstY,
            updW,
            updH,
            {
              u: srcX / drawW,
              v: srcY / drawH,
              uw: updW / drawW,
              vh: updH / drawH,
              fullWidth: maxX - minX,
              fullHeight: maxY - minY,
            },
            image.source,
          )
        ) {
          this._videoFrameState.set(vid, frameState);
          updatedRects.push(rect);
          return;
        }

        if (this._tmpCanvas.width !== updW || this._tmpCanvas.height !== updH) {
          this._tmpCanvas.width = updW;
          this._tmpCanvas.height = updH;
        }

        try {
          this._tmpCtx.save();
          this._tmpCtx.clearRect(0, 0, updW, updH);
          this._tmpCtx.translate(-srcX, -srcY);

          if (isRounded) {
            this._createRoundedRectPath(
              this._tmpCtx,
              drawW,
              drawH,
              scaledRadii,
            );
            this._tmpCtx.clip();
          }

          this._tmpCtx.drawImage(
            this.staticSnapshotCanvas,
            texX,
            texY,
            texW,
            texH,
            0,
            0,
            drawW,
            drawH,
          );

          for (let j = 0; j < vidIndex; j++) {
            const below = this._videoNodes[j];
            if (this._isIgnored(below)) continue;
            const belowOpacity = Math.max(
              0,
              Math.min(
                1,
                parseFloat(window.getComputedStyle(below).opacity) || 0,
              ),
            );
            if (belowOpacity === 0) continue;
            const bRect = below.getBoundingClientRect();
            if (
              bRect.left < rect.right &&
              bRect.right > rect.left &&
              bRect.top < rect.bottom &&
              bRect.bottom > rect.top
            ) {
              const belowImage = videoImage(below);
              if (!belowImage) continue;
              this._tmpCtx.globalAlpha = belowOpacity;
              this._tmpCtx.drawImage(
                belowImage.source,
                (bRect.left - rect.left) * this.scaleFactor,
                (bRect.top - rect.top) * this.scaleFactor,
                bRect.width * this.scaleFactor,
                bRect.height * this.scaleFactor,
              );
            }
          }

          this._tmpCtx.globalAlpha = vidOpacity;
          this._tmpCtx.drawImage(image.source, 0, 0, drawW, drawH);
          this._tmpCtx.restore();
        } catch (e) {
          console.warn("liquidGL: Error drawing video frame", e);
          return;
        }

        this.backend.uploadRegion(dstX, dstY, this._tmpCanvas);
        this._videoFrameState.set(vid, frameState);
        updatedRects.push(rect);
      });
    }

    /* ----------------------------- */
    _invalidateDynamicRegion(x, y, w, h) {
      for (const { el } of this._dynamicNodes) {
        const meta = this._dynMeta.get(el);
        const rect = meta?.prevDrawRect;
        if (
          rect &&
          x < rect.x + rect.w &&
          x + w > rect.x &&
          y < rect.y + rect.h &&
          y + h > rect.y
        )
          meta._compositeDirty = true;
      }
    }

    _updateDynamicNodes() {
      if (!this.hasTexture || !this._dynMeta || !this._dynamicNodes.length)
        return;
      const snapRect = this.snapshotTarget.getBoundingClientRect();
      const maxLensZ = this._getMaxLensZ();

      const lensRects = this.lenses.map((ln) => ln.rectPx).filter(Boolean);

      const rectsIntersect = (a, b) =>
        a.left < b.left + b.width &&
        a.left + a.width > b.left &&
        a.top < b.top + b.height &&
        a.top + a.height > b.top;

      if (!this._compositeCtx) {
        this._compositeCtx = document.createElement("canvas").getContext("2d");
      }

      let videoRects;
      const getVideoLayers = (rect) => {
        videoRects ||= this._videoNodes
          .filter((vid) => effectiveZ(vid) < maxLensZ)
          .map((vid) => ({ el: vid, rect: vid.getBoundingClientRect() }));
        const layers = [];
        for (const video of videoRects) {
          if (!rectsIntersect(rect, video.rect)) continue;
          video.opacity ??= Math.max(
            0,
            Math.min(
              1,
              parseFloat(window.getComputedStyle(video.el).opacity) || 0,
            ),
          );
          if (video.opacity === 0) continue;
          video.image ||= videoImage(video.el);
          if (video.image) layers.push(video);
        }
        return layers;
      };

      this._dynamicNodes.forEach((node) => {
        const el = node.el;
        const meta = this._dynMeta.get(el);
        if (!meta) return;
        if (this._contentLayers.some((layer) => layer.el.contains(el))) {
          meta.prevDrawRect = null;
          return;
        }

        if (meta.needsRecapture && !meta._capturing && !this._isScrolling) {
          meta._capturing = true;

          const ignoreDynamic = (n) =>
            n.tagName === "CANVAS" || n.hasAttribute("data-liquid-ignore");

          if (this._naughtyQueued) {
            meta._capturing = false;
          } else {
            this._naughtyQueued = true;
            const capture = () => {
              if (this._destroyed || this._dynMeta.get(el) !== meta) return;
              this._naughtyQueued = false;
              try {
                const cv = NaughtyDOM.rasterise(el, {
                  scale: this.scaleFactor,
                  ignoreElements: ignoreDynamic,
                  canvas: meta.naughtyCanvas,
                });
                meta.naughtyCanvas = cv;
                if (cv.width > 0 && cv.height > 0) {
                  meta.lastCapture = cv;
                  meta._compositeDirty = true;
                  meta.needsRecapture = false;
                  this._renderSignature = null;
                }
              } catch (e) {
                console.error("liquidGL: Dynamic element capture failed.", e);
              }
              meta._capturing = false;
            };
            if (typeof requestIdleCallback === "function") {
              this._captureIdle = requestIdleCallback(capture, {
                timeout: 100,
              });
            } else {
              this._captureTimeout = setTimeout(capture, 0);
            }
          }
        }

        if (meta.lastCapture) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const visible =
            effectiveZ(el) < maxLensZ &&
            document.contains(el) &&
            rect.width > 0 &&
            rect.height > 0 &&
            lensRects.some((lr) => rectsIntersect(rect, lr));
          const media = visible ? getVideoLayers(rect) : [];
          const state = [
            meta.lastCapture,
            this.staticSnapshotCanvas,
            rect.left,
            rect.top,
            rect.width,
            rect.height,
            snapRect.left,
            snapRect.top,
            this.scaleFactor,
            this.textureWidth,
            this.textureHeight,
            style.transform,
            style.opacity,
            visible,
          ];
          for (const video of media) {
            state.push(
              video.el,
              video.image.version,
              video.opacity,
              video.rect.left,
              video.rect.top,
              video.rect.width,
              video.rect.height,
            );
          }
          if (
            meta.prevDrawRect &&
            !meta._compositeDirty &&
            !meta.needsRecapture &&
            !meta._capturing &&
            !(this._workerEnabled && meta._heavyAnim) &&
            meta._compositeState?.length === state.length &&
            state.every((value, i) => value === meta._compositeState[i])
          )
            return;
          meta._compositeState = null;
          if (meta.prevDrawRect && !(this._workerEnabled && meta._heavyAnim)) {
            const { x, y, w, h } = meta.prevDrawRect;
            if (w > 0 && h > 0) {
              const eraseCanvas = this._compositeCtx.canvas;
              if (eraseCanvas.width !== w || eraseCanvas.height !== h) {
                eraseCanvas.width = w;
                eraseCanvas.height = h;
              }
              this._compositeCtx.drawImage(
                this.staticSnapshotCanvas,
                x,
                y,
                w,
                h,
                0,
                0,
                w,
                h,
              );
              this.backend.uploadRegion(x, y, eraseCanvas);
            }
          }

          if (!visible) {
            meta.prevDrawRect = null;
            return;
          }

          const texX = (rect.left - snapRect.left) * this.scaleFactor;
          const texY = (rect.top - snapRect.top) * this.scaleFactor;
          const drawW = Math.round(rect.width * this.scaleFactor);
          const drawH = Math.round(rect.height * this.scaleFactor);
          const drawX = Math.round(texX);
          const drawY = Math.round(texY);

          if (drawW <= 0 || drawH <= 0) return;

          const maxW = this.textureWidth;
          const maxH = this.textureHeight;
          let dstX = drawX;
          let dstY = drawY;
          let srcX = 0,
            srcY = 0,
            updW = drawW,
            updH = drawH;

          if (dstX < 0) {
            srcX = -dstX;
            updW += dstX;
            dstX = 0;
          }
          if (dstY < 0) {
            srcY = -dstY;
            updH += dstY;
            dstY = 0;
          }

          if (dstX + updW > maxW) {
            updW = maxW - dstX;
          }
          if (dstY + updH > maxH) {
            updH = maxH - dstY;
          }

          if (updW <= 0 || updH <= 0) return;

          const compositeCanvas = this._compositeCtx.canvas;
          if (
            compositeCanvas.width !== drawW ||
            compositeCanvas.height !== drawH
          ) {
            compositeCanvas.width = drawW;
            compositeCanvas.height = drawH;
          }
          this._compositeCtx.clearRect(0, 0, drawW, drawH);

          this._compositeCtx.drawImage(
            this.staticSnapshotCanvas,
            texX,
            texY,
            rect.width * this.scaleFactor,
            rect.height * this.scaleFactor,
            0,
            0,
            drawW,
            drawH,
          );
          for (const video of media) {
            this._compositeCtx.globalAlpha = video.opacity;
            this._compositeCtx.drawImage(
              video.image.source,
              (video.rect.left - rect.left) * this.scaleFactor,
              (video.rect.top - rect.top) * this.scaleFactor,
              video.rect.width * this.scaleFactor,
              video.rect.height * this.scaleFactor,
            );
          }
          this._compositeCtx.globalAlpha = 1;

          this._compositeCtx.save();
          this._compositeCtx.translate(drawW / 2, drawH / 2);
          if (style.transform !== "none") {
            this._compositeCtx.transform(
              ...this._parseTransform(style.transform),
            );
          }
          this._compositeCtx.translate(-drawW / 2, -drawH / 2);
          this._compositeCtx.globalAlpha = parseFloat(style.opacity) || 1.0;
          this._compositeCtx.drawImage(meta.lastCapture, 0, 0, drawW, drawH);
          this._compositeCtx.restore();

          this.backend.uploadRegion(dstX, dstY, compositeCanvas, srcX, srcY);

          if (this._workerEnabled && meta._heavyAnim) {
            const jobId = `${Date.now()}_${Math.random()}`;
            this._dynJobs.set(jobId, {
              x: dstX,
              y: dstY,
              w: updW,
              h: updH,
            });

            Promise.all([
              createImageBitmap(
                this.staticSnapshotCanvas,
                dstX,
                dstY,
                updW,
                updH,
              ),
              createImageBitmap(meta.lastCapture),
            ]).then(([snapBmp, dynBmp]) => {
              this._dynWorker.postMessage(
                {
                  id: jobId,
                  width: updW,
                  height: updH,
                  snap: snapBmp,
                  dyn: dynBmp,
                },
                [snapBmp, dynBmp],
              );
            });
            meta.prevDrawRect = { x: dstX, y: dstY, w: updW, h: updH };
            return;
          }

          meta.prevDrawRect = { x: dstX, y: dstY, w: updW, h: updH };
          meta._compositeState = state;
          meta._compositeDirty = false;
        }
      });
    }

    _parseTransform(transform) {
      if (transform === "none") return [1, 0, 0, 1, 0, 0];
      const matrixMatch = transform.match(/matrix\((.+)\)/);
      if (matrixMatch) {
        const values = matrixMatch[1].split(",").map(parseFloat);
        return values;
      }
      const matrix3dMatch = transform.match(/matrix3d\((.+)\)/);
      if (matrix3dMatch) {
        const v = matrix3dMatch[1].split(",").map(parseFloat);
        return [v[0], v[1], v[4], v[5], v[12], v[13]];
      }
      return [1, 0, 0, 1, 0, 0];
    }

    /* ----------------------------- */
    _localLensZ(lens) {
      return (
        (lens.options.zIndex ?? effectiveZ(lens.el)) -
        (this._anchor === document.body ? 0 : effectiveZ(this._anchor))
      );
    }

    _getMaxLensZ() {
      let maxZ = this.lenses.length ? -Infinity : 0;
      this.lenses.forEach((ln) => {
        const z = ln.options.zIndex ?? effectiveZ(ln.el);
        if (z > maxZ) maxZ = z;
      });
      return maxZ;
    }

    /* ----------------------------- */
    addDynamicElement(el) {
      if (!el) return;
      if (typeof el === "string") {
        this.snapshotTarget
          .querySelectorAll(el)
          .forEach((n) => this.addDynamicElement(n));
        return;
      }
      if (NodeList.prototype.isPrototypeOf(el) || Array.isArray(el)) {
        Array.from(el).forEach((n) => this.addDynamicElement(n));
        return;
      }
      if (!el.getBoundingClientRect || !this.snapshotTarget.contains(el))
        return;
      if (el.closest && el.closest("[data-liquid-ignore]")) return;
      if (this._dynamicNodes.some((n) => n.el === el)) return;

      this._dynamicNodes = this._dynamicNodes.filter((n) => !el.contains(n.el));

      const meta = {
        _capturing: false,
        prevDrawRect: null,
        lastCapture: null,
        naughtyCanvas: null,
        needsRecapture: true,
        hoverClassName: null,
        _animating: false,
        _rafId: null,
        _lastCaptureTs: 0,
        _heavyAnim: false,
      };
      this._dynMeta.set(el, meta);

      const setDirty = () => {
        const m = this._dynMeta.get(el);
        if (m && !m.needsRecapture) {
          m.needsRecapture = true;
          cancelAnimationFrame(this._dirtyRaf);
          this._dirtyRaf = requestAnimationFrame(() => this.render());
        }
      };

      const findAppliedHoverStyles = (element) => {
        let cssText = "";
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) {
              if (!rule.selectorText || !rule.selectorText.includes(":hover")) {
                continue;
              }
              const baseSelector = rule.selectorText.split(":hover")[0];
              if (element.matches(baseSelector)) {
                cssText += rule.style.cssText;
              }
            }
          } catch (e) {}
        }
        return cssText;
      };

      const handleLeave = () => {
        const m = this._dynMeta.get(el);
        if (!m || !m.hoverClassName) return;

        el.classList.remove(m.hoverClassName);
        for (let i = this._dynamicStyleSheet.cssRules.length - 1; i >= 0; i--) {
          const rule = this._dynamicStyleSheet.cssRules[i];
          if (rule.selectorText === `.${m.hoverClassName}`) {
            this._dynamicStyleSheet.deleteRule(i);
            break;
          }
        }
        m.hoverClassName = null;
        setDirty();
      };

      listen(
        this,
        el,
        "mouseenter",
        () => {
          const m = this._dynMeta.get(el);
          if (!m) return;
          const hoverCss = findAppliedHoverStyles(el);
          if (hoverCss) {
            const className = `lqgl-h-${Math.random()
              .toString(36)
              .substr(2, 9)}`;
            const rule = `.${className} { ${hoverCss} }`;
            try {
              this._dynamicStyleSheet.insertRule(
                rule,
                this._dynamicStyleSheet.cssRules.length,
              );
              m.hoverClassName = className;
              el.classList.add(className);
            } catch (e) {
              console.error("liquidGL: Failed to insert hover style rule.", e);
            }
          }
          setDirty();
        },
        { passive: true },
      );

      listen(this, el, "mouseleave", handleLeave, { passive: true });
      listen(this, el, "transitionend", setDirty, { passive: true });

      const startRealtime = () => {
        const m = this._dynMeta.get(el);
        if (!m || m._animating) return;
        m._animating = true;

        m._heavyAnim = false;

        const step = (ts) => {
          const meta = this._dynMeta.get(el);
          if (!meta || !meta._animating) return;

          if (
            meta._heavyAnim &&
            !meta._capturing &&
            ts - meta._lastCaptureTs > RECAPTURE_INTERVAL_MS
          ) {
            meta._lastCaptureTs = ts;
            meta.needsRecapture = true;
          }
          if (meta._heavyAnim) {
            meta._rafId = requestAnimationFrame(step);
          } else {
            meta._rafId = null;
          }
        };
        m._rafId = requestAnimationFrame(step);
      };

      const trackProperty = (prop) => {
        const m = this._dynMeta.get(el);
        if (!m) return;
        const low = (prop || "").toLowerCase();
        if (!(low.includes("transform") || low.includes("opacity"))) {
          const wasHeavy = m._heavyAnim;
          m._heavyAnim = true;
          if (m._animating && !wasHeavy && !m._rafId) {
            m._animating = false;
            startRealtime();
          }
        }
      };

      const transitionRunHandler = (e) => {
        trackProperty(e.propertyName);
        startRealtime();
      };

      listen(this, el, "transitionrun", transitionRunHandler, {
        passive: true,
      });
      listen(this, el, "transitionstart", transitionRunHandler, {
        passive: true,
      });
      listen(
        this,
        el,
        "animationstart",
        () => {
          const m = this._dynMeta.get(el);
          if (m) m._heavyAnim = true;
          startRealtime();
        },
        { passive: true },
      );

      listen(
        this,
        el,
        "animationiteration",
        () => {
          const m = this._dynMeta.get(el);
          if (m) {
            m._heavyAnim = true;
            if (!m._animating) startRealtime();
          }
        },
        { passive: true },
      );

      const stopRealtime = () => {
        const m = this._dynMeta.get(el);
        if (!m || !m._animating) return;
        m._animating = false;
        if (m._rafId) {
          cancelAnimationFrame(m._rafId);
          m._rafId = null;
        }
        m._heavyAnim = false;
        setDirty();
      };

      listen(this, el, "transitionend", stopRealtime, { passive: true });
      listen(this, el, "transitioncancel", stopRealtime, { passive: true });
      listen(this, el, "animationend", stopRealtime, { passive: true });
      listen(this, el, "animationcancel", stopRealtime, { passive: true });

      /* --------------------------------------------------
       *  Removal clean-up
       * --------------------------------------------------*/
      if (typeof MutationObserver !== "undefined") {
        const removalObserver = new MutationObserver(() => {
          if (!document.contains(el)) {
            handleLeave();
            cancelAnimationFrame(this._dynMeta.get(el)?._rafId);
            removalObserver.disconnect();
            this._dynamicNodes = this._dynamicNodes.filter((n) => n.el !== el);
            this._dynMeta.delete(el);
          }
        });
        removalObserver.observe(document.body, {
          childList: true,
          subtree: true,
        });
        this._cleanups.push(() => removalObserver.disconnect());
      }

      this._dynamicNodes.push({ el });
    }

    /* ----------------------------- */
    _isIgnored(el) {
      return !!(
        el &&
        typeof el.closest === "function" &&
        el.closest("[data-liquid-ignore]")
      );
    }
  }

  /* --------------------------------------------------
   *  Per-element lens wrapper
   * ------------------------------------------------*/
  class liquidGLLens {
    constructor(renderer, element, options) {
      this.renderer = renderer;
      this.el = element;
      this.options = options;
      this._initCalled = false;
      this.rectPx = null;
      this.radiusGl = 0;
      this.radiusCss = 0;
      this.revealTypeIndex = this.options.reveal === "fade" ? 1 : 0;
      this._revealProgress = this.revealTypeIndex === 0 ? 1 : 0;
      this.tiltX = 0;
      this.tiltY = 0;
      this._activated = false;
      this._destroyed = false;
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      const renderer = this.renderer;
      if (renderer) renderer._tearingDown = true;
      this._sizeObs?.disconnect();
      if (
        this._dragPointerId != null &&
        this.el.hasPointerCapture?.(this._dragPointerId)
      )
        this.el.releasePointerCapture(this._dragPointerId);
      this._unbindDragHandlers();
      this._unbindTiltHandlers();
      this._destroyMirrorCanvas();
      this._cleanups?.splice(0).forEach((cleanup) => cleanup());
      this._shadowEl?.remove();
      this._shadowEl = null;
      if (renderer && this._tiltMeasureStyle)
        removeRule(renderer._dynamicStyleSheet, this._tiltMeasureStyle);
      this._restoreStyles?.();
      if (this._interactionStylesChanged) this._restoreInteractionStyles?.();
      this._restoreStyles = this._restoreInteractionStyles = null;
      this._fluid = null;
      this._activated = false;
      if (renderer) {
        renderer._tearingDown = false;
        renderer.removeLens(this);
      }
      this.renderer = null;
    }

    /* ----------------------------- */
    _activate() {
      if (this._destroyed || this._activated) return;
      this._activated = true;
      this._restoreStyles = restoreStyles(this.el, [
        "background",
        "backdrop-filter",
        "-webkit-backdrop-filter",
        "box-shadow",
        "opacity",
        "transition",
        "position",
        "pointer-events",
      ]);
      this._restoreInteractionStyles = restoreStyles(this.el, [
        "transform",
        "transform-style",
        "transform-origin",
        "cursor",
        "touch-action",
      ]);

      this.originalShadow = this.el.style.boxShadow;
      this.originalOpacity = this.el.style.opacity;
      this.originalTransition = this.el.style.transition;
      this.el.style.transition = "none";
      this.el.style.opacity = 0;

      this.el.style.position =
        this.el.style.position === "static"
          ? "relative"
          : this.el.style.position;

      this._isSticky = /sticky/.test(window.getComputedStyle(this.el).position);

      const bgCol = window.getComputedStyle(this.el).backgroundColor;
      const rgbaMatch = bgCol.match(/rgba?\(([^)]+)\)/);
      this._bgColorComponents = null;
      if (rgbaMatch) {
        const comps = rgbaMatch[1].split(/[ ,]+/).map(parseFloat);
        const [r, g, b, a = 1] = comps;
        this._bgColorComponents = { r, g, b, a };
        this.el.style.backgroundColor = `rgba(${r}, ${g}, ${b}, 0)`;
      }

      this.el.style.backdropFilter = "none";
      this.el.style.webkitBackdropFilter = "none";
      this.el.style.backgroundImage = "none";
      this.el.style.background = "transparent";

      if (this.options.draggable) {
        this._bindDragHandlers();
      } else {
        this.el.style.pointerEvents = "none";
      }

      this.updateMetrics();
      this.setShadow(this.options.shadow);
      if (this.options.tilt && !this.options.draggable)
        this._bindTiltHandlers();

      if (typeof ResizeObserver !== "undefined" && !this._sizeObs) {
        this._sizeObs = new ResizeObserver(() => {
          if (this._destroyed) return;
          this.updateMetrics();
          this.renderer.render();
        });
        this._sizeObs.observe(this.el);
      }
    }

    /* ----------------------------- */
    updateMetrics() {
      if (this._destroyed) return;
      const rect =
        this._mirrorActive && this._baseRect
          ? this._baseRect
          : this.el.getBoundingClientRect();

      const origin = this.renderer.canvas.getBoundingClientRect();
      const vpX = -origin.left;
      const vpY = -origin.top;

      const prev = this.rectPx;
      if (
        prev &&
        rect.left === prev.left &&
        rect.top === prev.top &&
        rect.width === prev.width &&
        rect.height === prev.height &&
        vpX === this._vpOffsetX &&
        vpY === this._vpOffsetY
      ) {
        return;
      }
      this._vpOffsetX = vpX;
      this._vpOffsetY = vpY;

      this.rectPx = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };

      const style = window.getComputedStyle(this.el);
      const brRaw = style.borderTopLeftRadius.split(" ")[0];
      const isPct = brRaw.trim().endsWith("%");
      let brPx;
      if (isPct) {
        const pct = parseFloat(brRaw);
        brPx = (Math.min(rect.width, rect.height) * pct) / 100;
      } else {
        brPx = parseFloat(brRaw);
      }
      const maxAllowedCss = Math.min(rect.width, rect.height) * 0.5;
      this.radiusCss = Math.min(brPx, maxAllowedCss);

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.radiusGl = this.radiusCss * dpr;

      if (this._shadowSyncFn) {
        this._shadowSyncFn();
      }
    }

    /* ----------------------------- */
    _handleOverscrollCompensation() {
      let overscrollY = 0;
      let overscrollX = 0;

      const vv = window.visualViewport;
      if (vv) {
        if (Math.abs(vv.scale - 1) < 0.01) {
          overscrollX = -vv.offsetLeft;
          overscrollY = -vv.offsetTop;
        }
      } else {
        const bodyStyle = window.getComputedStyle(document.body);
        const htmlStyle = window.getComputedStyle(document.documentElement);

        if (bodyStyle.transform && bodyStyle.transform !== "none") {
          const matrix = new DOMMatrix(bodyStyle.transform);
          overscrollX = matrix.m41;
          overscrollY = matrix.m42;
        }

        if (
          overscrollY === 0 &&
          overscrollX === 0 &&
          htmlStyle.transform &&
          htmlStyle.transform !== "none"
        ) {
          const matrix = new DOMMatrix(htmlStyle.transform);
          overscrollX = matrix.m41;
          overscrollY = matrix.m42;
        }
      }

      this._currentOverscrollX = overscrollX;
      this._currentOverscrollY = overscrollY;

      if (overscrollY !== 0 || overscrollX !== 0) {
        const compensationTransform = `translate(${-overscrollX}px, ${-overscrollY}px)`;

        let currentTransform = this.el.style.transform;
        currentTransform = currentTransform
          .replace(/translate\([^)]*\)\s*/g, "")
          .trim();

        this.el.style.transform =
          compensationTransform +
          (currentTransform ? " " + currentTransform : "");

        if (this._shadowEl) {
          let shadowTransform = this._shadowEl.style.transform || "";
          shadowTransform = shadowTransform
            .replace(/translate\([^)]*\)\s*/g, "")
            .trim();
          this._shadowEl.style.transform =
            compensationTransform +
            (shadowTransform ? " " + shadowTransform : "");
        }
      } else if (!this._tiltInteracting) {
        this.el.style.transform = this._savedTransform || "";
        if (this._shadowEl) {
          this._shadowEl.style.transform = "";
        }
      }
    }

    /* ----------------------------- */
    setTilt(enabled) {
      if (this._destroyed) return;
      this.options.tilt = !!enabled;
      if (this.options.tilt) {
        this._bindTiltHandlers();
      } else {
        this._unbindTiltHandlers();
      }
    }

    /* ----------------------------- */
    setTint(value) {
      if (this._destroyed) return;
      this.options.tint = parseTintColor(value);
      return this.options.tint;
    }

    /* ----------------------------- */
    setDraggable(enabled) {
      if (this._destroyed) return;
      this.options.draggable = !!enabled;
      if (this.options.draggable) {
        this._bindDragHandlers();
      } else {
        this._unbindDragHandlers();
        this.el.style.pointerEvents = "none";
      }
    }

    /* ----------------------------- */
    _bindDragHandlers() {
      if (this._destroyed || !this.renderer) return;
      this._interactionStylesChanged = true;
      this.el.style.pointerEvents = "auto";
      if (this._dragHandlersBound) return;
      this._dragHandlersBound = true;

      this._savedCursor = this.el.style.cursor;
      this._savedTouchAction = this.el.style.touchAction;
      this._savedDragTransform = this.el.style.transform;
      this.el.style.cursor = "grab";
      this.el.style.touchAction = "none";

      this._dragX = 0;
      this._dragY = 0;
      this._dragBaseX = 0;
      this._dragBaseY = 0;
      this._dragPointerId = null;

      this._onDragDown = (e) => {
        if (e.button) return;
        if (this._dragPointerId !== null) return;
        this._dragPointerId = e.pointerId;
        this._dragStartX = e.clientX;
        this._dragStartY = e.clientY;
        this.el.style.cursor = "grabbing";
        e.preventDefault();
        if (this.options.on && this.options.on.dragstart) {
          this.options.on.dragstart(this, {
            clientX: e.clientX,
            clientY: e.clientY,
          });
        }
      };

      this._onDragMove = (e) => {
        if (this._dragPointerId === null || e.pointerId !== this._dragPointerId)
          return;
        this._dragX = this._dragBaseX + (e.clientX - this._dragStartX);
        this._dragY = this._dragBaseY + (e.clientY - this._dragStartY);
        this.el.style.transform = `translate3d(${this._dragX}px, ${this._dragY}px, 0)`;
        this.updateMetrics();
        this.renderer.render();
        if (this.options.on && this.options.on.drag) {
          this.options.on.drag(this, {
            clientX: e.clientX,
            clientY: e.clientY,
            x: this._dragX,
            y: this._dragY,
          });
        }
      };

      this._onDragEnd = (e) => {
        if (
          this._dragPointerId === null ||
          (e && e.pointerId !== this._dragPointerId)
        )
          return;
        const info = {
          clientX: e ? e.clientX : undefined,
          clientY: e ? e.clientY : undefined,
          x: this._dragX,
          y: this._dragY,
        };
        this._dragPointerId = null;
        this._dragBaseX = this._dragX;
        this._dragBaseY = this._dragY;
        this.el.style.cursor = "grab";
        if (this.options.on && this.options.on.dragend) {
          this.options.on.dragend(this, info);
        }
      };

      listen(this, this.el, "pointerdown", this._onDragDown);
      listen(this, window, "pointermove", this._onDragMove);
      listen(this, window, "pointerup", this._onDragEnd);
      listen(this, window, "pointercancel", this._onDragEnd);
    }

    _unbindDragHandlers() {
      if (!this._dragHandlersBound) return;
      this.el.removeEventListener("pointerdown", this._onDragDown);
      window.removeEventListener("pointermove", this._onDragMove);
      window.removeEventListener("pointerup", this._onDragEnd);
      window.removeEventListener("pointercancel", this._onDragEnd);
      this._dragPointerId = null;
      this.el.style.cursor = this._savedCursor || "";
      this.el.style.touchAction = this._savedTouchAction || "";
      this.clearDrag();
      this._dragHandlersBound = false;
    }

    clearDrag() {
      if (this._destroyed) return;
      this._dragX = 0;
      this._dragY = 0;
      this._dragBaseX = 0;
      this._dragBaseY = 0;
      this._dragStartX = 0;
      this._dragStartY = 0;
      this.el.style.transform = this._savedDragTransform || "";
      this.updateMetrics();
      this.renderer.render();
    }

    /* ----------------------------- */
    _syncShadowMode(force = false) {
      const fluid = this.options.interaction === "fluid" && this.options.shadow;
      if (!force && this._fluidShadowActive === fluid) return;
      this._fluidShadowActive = fluid;
      if (this._shadowEl) {
        this._shadowEl.style.display = "";
        this._shadowEl.style.boxShadow = fluid ? "none" : this._cssShadow;
      }
      this.el.style.boxShadow = fluid
        ? "none"
        : this.options.shadow
          ? this._cssShadow
          : this.originalShadow;
    }

    setShadow(enabled) {
      if (this._destroyed) return;
      this.options.shadow = !!enabled;

      const SHADOW_VAL =
        "0 10px 30px rgba(0,0,0,0.1), 0 0 0 0.5px rgba(0,0,0,0.05)";
      this._cssShadow = SHADOW_VAL;

      const syncShadow = () => {
        if (!this._shadowEl) return;
        const r =
          this._mirrorActive && this._baseRect
            ? this._baseRect
            : this.el.getBoundingClientRect();
        const origin = this.renderer.canvas.getBoundingClientRect();
        this._shadowEl.style.left = `${r.left - origin.left + parseFloat(this.renderer.canvas.style.left)}px`;
        this._shadowEl.style.top = `${r.top - origin.top + parseFloat(this.renderer.canvas.style.top)}px`;
        this._shadowEl.style.width = `${r.width}px`;
        this._shadowEl.style.height = `${r.height}px`;
        this._shadowEl.style.borderRadius = `${this.radiusCss}px`;
      };

      if (enabled) {
        this.el.style.boxShadow = SHADOW_VAL;

        if (!this._shadowEl) {
          this._shadowEl = document.createElement("div");
          Object.assign(this._shadowEl.style, {
            position: "absolute",
            pointerEvents: "none",
            zIndex: this.renderer._localLensZ(this) - 2,
            boxShadow: SHADOW_VAL,
            willChange: "transform, width, height",
            opacity: this._revealProgress ?? 1,
          });
          this.renderer._anchor.appendChild(this._shadowEl);

          this._shadowSyncFn = syncShadow;
          listen(this, window, "resize", this._shadowSyncFn, {
            passive: true,
          });
        }
        syncShadow();
      } else {
        if (this._shadowEl) {
          window.removeEventListener("resize", this._shadowSyncFn);
          this._shadowEl.remove();
          this._shadowEl = null;
        }
        this.el.style.boxShadow = this.originalShadow;
      }
      this._syncShadowMode(true);
    }

    /* ----------------------------- */
    _reveal() {
      if (this._destroyed || !this._activated) return;
      if (this.revealTypeIndex === 0) {
        this.el.style.opacity = this.originalOpacity || 1;
        this.renderer.canvas.style.opacity = "1";
        this._revealProgress = 1;
        this._TriggerInit();
        return;
      }

      if (this.renderer._revealAnimating) return;

      this.renderer._revealAnimating = true;

      const dur = 1000;
      const start = performance.now();

      const renderer = this.renderer;
      const animate = () => {
        if (renderer._destroyed) return;
        const progress = Math.min(1, (performance.now() - start) / dur);

        renderer.lenses.forEach((ln) => {
          ln._revealProgress = progress;
          ln.el.style.opacity = (ln.originalOpacity || 1) * progress;
          if (ln._shadowEl) {
            ln._shadowEl.style.opacity = progress;
          }
        });

        renderer.canvas.style.opacity = String(progress);

        renderer.render();

        if (progress < 1) {
          renderer._revealRaf = requestAnimationFrame(animate);
        } else {
          renderer._revealAnimating = false;
          renderer.lenses.slice().forEach((ln) => {
            if (ln._destroyed) return;
            ln.el.style.transition = ln.originalTransition || "";
            ln._TriggerInit();
          });
        }
      };

      renderer._revealRaf = requestAnimationFrame(animate);
    }

    /* ----------------------------- */
    _bindTiltHandlers() {
      if (this._destroyed || !this.renderer) return;
      this._interactionStylesChanged = true;
      if (this._tiltHandlersBound) return;

      if (this._savedTransform === undefined) {
        const currentTransform = this.el.style.transform;
        if (currentTransform && currentTransform.includes("translate")) {
          this._savedTransform = currentTransform
            .replace(/translate\([^)]*\)\s*/g, "")
            .trim();
          if (this._savedTransform === "") this._savedTransform = "none";
        } else {
          this._savedTransform = currentTransform;
        }
      }
      if (this._savedTransformStyle === undefined) {
        this._savedTransformStyle = this.el.style.transformStyle;
      }
      this.el.style.transformStyle = "preserve-3d";

      const getMaxTilt = () =>
        Number.isFinite(this.options.tiltFactor) ? this.options.tiltFactor : 5;

      const getTiltEase = () =>
        Number.isFinite(this.options.tiltEase)
          ? Math.max(0, this.options.tiltEase)
          : 400;

      this._savedTiltTransition = this.el.style.transition;
      this._savedTiltOrigin = this.el.style.transformOrigin;

      this._applyTilt = (clientX, clientY) => {
        if (!this._tiltInteracting) {
          this._cancelTiltEase();
          this._tiltInteracting = true;
          this._tiltEnterUntil = performance.now() + getTiltEase();
          if (!this._mirror) this._createMirrorCanvas();
        }
        this._tiltActive = true;
        const r = this._baseRect;
        if (!r || !r.width || !r.height) return;
        const maxTilt = getMaxTilt();
        const rotY =
          ((clientX - r.left - r.width / 2) / (r.width / 2)) * maxTilt;
        const rotX =
          -((clientY - r.top - r.height / 2) / (r.height / 2)) * maxTilt;
        this._easeTiltTo(
          rotX,
          rotY,
          Math.max(0, this._tiltEnterUntil - performance.now()),
        );
      };

      this._drawTilt = () => {
        const r = this._baseRect;
        if (!r) return;
        const origin = this.renderer.canvas.getBoundingClientRect();
        this._pivotOrigin = `${r.left - origin.left + r.width / 2}px ${r.top - origin.top + r.height / 2}px`;
        const rotX = this.tiltX;
        const rotY = this.tiltY;
        this.el.style.transition = "none";
        if (this._mirror) this._mirror.style.transition = "none";
        if (this._shadowEl) this._shadowEl.style.transition = "none";
        const baseTransform =
          this._savedTransform && this._savedTransform !== "none"
            ? this._savedTransform + " "
            : "";

        let overscrollCompensation = "";
        const bodyStyle = window.getComputedStyle(document.body);
        if (bodyStyle.transform && bodyStyle.transform !== "none") {
          const matrix = new DOMMatrix(bodyStyle.transform);
          const overscrollX = matrix.m41;
          const overscrollY = matrix.m42;
          if (overscrollX !== 0 || overscrollY !== 0) {
            overscrollCompensation = `translate(${-overscrollX}px, ${-overscrollY}px) `;
          }
        }

        const transformStr = `${overscrollCompensation}${baseTransform}perspective(800px) rotateX(${rotX}deg) rotateY(${rotY}deg)`;

        this.el.style.transformOrigin = `50% 50%`;
        this.el.style.transform = transformStr;

        if (this._mirror) {
          this._mirror.style.transformOrigin = this._pivotOrigin;
          this._mirror.style.transform = transformStr;
        }

        if (this._shadowEl) {
          this._shadowEl.style.transformOrigin = `50% 50%`;
          this._shadowEl.style.transform = transformStr;
        }

        this.renderer.render();
      };

      this._cancelTiltEase = () => {
        if (this._tiltEaseRaf) {
          cancelAnimationFrame(this._tiltEaseRaf);
          this._tiltEaseRaf = null;
        }
      };

      this._finishTilt = () => {
        this._destroyMirrorCanvas();
        this.el.style.transition = "none";
        this.el.style.transform = this._savedTransform || "";
        this.el.style.transformOrigin = this._savedTiltOrigin;
        if (this._shadowEl) this._shadowEl.style.transform = "";
        this.renderer.render();
      };

      this._easeTiltTo = (toX, toY, duration) => {
        this._tiltTargetX = toX;
        this._tiltTargetY = toY;
        if (this._tiltInteracting && duration > 0 && this._tiltEaseRaf) return;
        this._cancelTiltEase();
        const fromX = this.tiltX;
        const fromY = this.tiltY;
        const start = performance.now();
        const step = (now) => {
          this._tiltEaseRaf = null;
          const t = duration > 0 ? Math.min(1, (now - start) / duration) : 1;
          const eased = 1 - Math.pow(1 - t, 3);
          this.tiltX = fromX + (this._tiltTargetX - fromX) * eased;
          this.tiltY = fromY + (this._tiltTargetY - fromY) * eased;
          this._drawTilt();
          if (t < 1) {
            this._tiltEaseRaf = requestAnimationFrame(step);
          } else if (!this._tiltInteracting) {
            this._finishTilt();
          }
        };
        if (duration <= 0 || (fromX === toX && fromY === toY)) {
          duration = 0;
          step(start);
        } else {
          this._tiltEaseRaf = requestAnimationFrame(step);
        }
      };

      this._smoothReset = () => {
        if (!this._tiltInteracting) return;
        this._tiltInteracting = false;
        this._tiltActive = false;
        this._easeTiltTo(0, 0, getTiltEase());
      };

      this._onMouseEnter = (e) => this._applyTilt(e.clientX, e.clientY);
      this._onMouseMove = (e) => this._applyTilt(e.clientX, e.clientY);

      this._onTouchStart = (e) => {
        if (e.touches && e.touches.length === 1) {
          const t = e.touches[0];
          this._applyTilt(t.clientX, t.clientY);
        }
      };
      this._onTouchMove = (e) => {
        if (this._tiltTouchCancelled) return;
        if (e.touches && e.touches.length === 1) {
          const t = e.touches[0];
          this._applyTilt(t.clientX, t.clientY);
        }
      };
      this._onTouchEnd = () => {
        this._smoothReset();
      };

      listen(this, this.el, "mouseenter", this._onMouseEnter, {
        passive: true,
      });
      listen(this, this.el, "mousemove", this._onMouseMove, {
        passive: true,
      });
      listen(this, this.el, "touchstart", this._onTouchStart, {
        passive: true,
      });
      listen(this, this.el, "touchmove", this._onTouchMove, {
        passive: true,
      });
      listen(this, this.el, "touchend", this._onTouchEnd, {
        passive: true,
      });

      /* ----------------------------- */
      this._tiltActive = false;

      this._docPointerMove = (e) => {
        if (e.pointerType !== "mouse" && this._tiltTouchCancelled) return;
        const x = e.clientX ?? (e.touches && e.touches[0].clientX);
        const y = e.clientY ?? (e.touches && e.touches[0].clientY);
        if (x === undefined || y === undefined) return;

        const r = this.el.getBoundingClientRect();
        const inside =
          x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

        if (inside) {
          if (!this._tiltActive) {
            this._tiltActive = true;
            this._onMouseEnter({ clientX: x, clientY: y });
          } else {
            this._applyTilt(x, y);
          }
        } else if (this._tiltActive) {
          this._tiltActive = false;
          this._smoothReset();
        }
      };

      listen(this, document, "pointermove", this._docPointerMove, {
        passive: true,
      });

      this._onTiltPointerStart = () => {
        this._tiltTouchCancelled = false;
      };
      listen(this, document, "pointerdown", this._onTiltPointerStart, {
        passive: true,
        capture: true,
      });
      this._onTiltScroll = () => {
        this._tiltTouchCancelled = true;
        if (!this._mirrorActive) return;
        this._cancelTiltEase();
        this._tiltInteracting = this._tiltActive = false;
        this.tiltX = this.tiltY = 0;
        this._finishTilt();
      };
      this._onTiltPointerEnd = (event) => {
        if (event.pointerType !== "mouse") this._smoothReset();
      };
      listen(this, document, "scroll", this._onTiltScroll, {
        passive: true,
        capture: true,
      });
      listen(this, document, "pointercancel", this._onTiltScroll);
      listen(this, document, "pointerup", this._onTiltPointerEnd);
      this._tiltHandlersBound = true;
    }

    _unbindTiltHandlers() {
      if (!this._tiltHandlersBound) return;
      if (this._cancelTiltEase) this._cancelTiltEase();
      this._tiltInteracting = false;
      this._tiltActive = false;
      this.tiltX = 0;
      this.tiltY = 0;
      this._finishTilt();
      this.el.removeEventListener("mouseenter", this._onMouseEnter);
      this.el.removeEventListener("mousemove", this._onMouseMove);
      this.el.removeEventListener("touchstart", this._onTouchStart);
      this.el.removeEventListener("touchmove", this._onTouchMove);
      this.el.removeEventListener("touchend", this._onTouchEnd);
      document.removeEventListener(
        "pointerdown",
        this._onTiltPointerStart,
        true,
      );
      document.removeEventListener("scroll", this._onTiltScroll, true);
      document.removeEventListener("pointercancel", this._onTiltScroll);
      document.removeEventListener("pointerup", this._onTiltPointerEnd);

      if (this._docPointerMove) {
        document.removeEventListener("pointermove", this._docPointerMove);
        this._docPointerMove = null;
      }
      this._tiltHandlersBound = false;

      this.el.style.transform = this._savedTransform || "";
      this.el.style.transformStyle = this._savedTransformStyle || "";
      this.el.style.transition = this._savedTiltTransition;

      this.renderer.render();
    }

    _measureBaseRect() {
      const tilted =
        this.tiltX !== 0 || this.tiltY !== 0 || !!this._tiltEaseRaf;
      if (!tilted) return this.el.getBoundingClientRect();

      const prevTransition = this.el.style.transition;
      const prevTransform = this.el.style.transform;

      this.el.style.transition = "none";
      this.el.style.transform = this._savedTransform || "";
      const rect = this.el.getBoundingClientRect();

      this.el.style.transform = prevTransform;
      this.el.style.transition = prevTransition;

      return rect;
    }

    _createMirrorCanvas() {
      this._baseRect = this._measureBaseRect();
      if (this._mirror) return;
      this._tiltBaseTransform = window.getComputedStyle(this.el).transform;
      if (!this._tiltMeasureStyle) {
        const sheet = this.renderer._dynamicStyleSheet;
        const index = sheet.insertRule(
          `[data-liquidgl-tilt="${this._order}"] {}`,
          sheet.cssRules.length,
        );
        this._tiltMeasureStyle = sheet.cssRules[index].style;
      }
      this.el.setAttribute("data-liquidgl-tilt", String(this._order));
      this._mirror = document.createElement("canvas");
      Object.assign(this._mirror.style, {
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: this.renderer.canvas.style.zIndex,
        willChange: "transform",
      });
      this._mirror.setAttribute("data-liquid-ignore", "");
      this._mirrorCtx = this._mirror.getContext("2d");
      this.renderer._anchor.insertBefore(this._mirror, this.renderer.canvas);

      const updateClip = () => {
        if (this._mirrorActive) {
          this._baseRect = this._baseRect || this._measureBaseRect();
        }
        const r =
          this._fluidDrawRect || this._baseRect || this._measureBaseRect();
        const radius = `${this._fluidDrawRect ? 0 : this.radiusCss}px`;
        const origin = this.renderer.canvas.getBoundingClientRect();
        this._mirror.style.left = this.renderer.canvas.style.left;
        this._mirror.style.top = this.renderer.canvas.style.top;
        this._mirror.style.width = this.renderer.canvas.style.width;
        this._mirror.style.height = this.renderer.canvas.style.height;
        this._mirror.style.clipPath = `inset(${r.top - origin.top}px ${
          origin.right - r.right
        }px ${origin.bottom - r.bottom}px ${r.left - origin.left}px round ${radius})`;
        this._mirror.style.webkitClipPath = this._mirror.style.clipPath;
      };
      updateClip();
      this._mirrorClipUpdater = updateClip;
      listen(this, window, "resize", updateClip, { passive: true });

      this._mirrorActive = true;
    }

    _destroyMirrorCanvas() {
      if (!this._mirror) return;
      window.removeEventListener("resize", this._mirrorClipUpdater);
      this.el.removeAttribute("data-liquidgl-tilt");
      this._tiltMeasureStyle.removeProperty("transform");
      this._mirror.remove();
      this._mirror = this._mirrorCtx = null;
      this._baseRect = null;
      this._mirrorActive = false;
    }

    _TriggerInit() {
      if (this._destroyed || this._initCalled) return;
      this._initCalled = true;
      if (this.options.on && this.options.on.init) {
        this.options.on.init(this);
      }
    }
  }

  /* --------------------------------------------------
   *  Public API
   * ------------------------------------------------*/
  window.liquidGL = function (userOptions = {}) {
    const defaults = {
      target: ".liquidGL",
      snapshot: "body",
      resolution: 2.0,
      engine: "auto",
      zIndex: undefined,
      content: undefined,
      refraction: 0.01,
      aberration: 0,
      bevelDepth: 0.08,
      bevelWidth: 0.15,
      frost: 0,
      shadow: true,
      specular: true,
      reveal: "fade",
      tilt: false,
      tiltFactor: 5,
      tiltEase: 400,
      draggable: false,
      interaction: "none",
      interactionStrength: 0.5,
      interactionRadius: 0.35,
      interactionViscosity: 0.65,
      magnify: 1,
      tint: null,
      helper: false,
      on: {},
    };
    const options = { ...defaults, ...userOptions };
    options.tint = parseTintColor(options.tint);
    if (
      options.zIndex != null &&
      (!Number.isInteger(options.zIndex) ||
        Math.abs(options.zIndex) > 2147483646)
    ) {
      throw new TypeError(
        "liquidGL: zIndex must be an integer between -2147483646 and 2147483646.",
      );
    }

    const engineRaw =
      options.engine !== "auto"
        ? options.engine
        : new URLSearchParams(window.location.search).get("liquidGL-engine") ||
          "auto";
    const engineKey = String(engineRaw).toLowerCase();
    if (ENGINE_CHAINS[engineKey]) {
      options.engine = engineKey;
    } else {
      console.warn(`liquidGL: Unknown engine "${engineRaw}" – using "auto".`);
      options.engine = "auto";
    }

    const chain = ENGINE_CHAINS[options.engine];
    const hasWebGPU =
      chain[0] === "webgpu" &&
      typeof navigator !== "undefined" &&
      "gpu" in navigator;
    let hasWebGL = false;
    const glChain = chain.filter((c) => c !== "webgpu");
    if (glChain.length) {
      const testCanvas = document.createElement("canvas");
      for (const name of glChain) {
        if (testCanvas.getContext(name)) {
          hasWebGL = true;
          break;
        }
      }
    }
    const noGPU = !hasWebGPU && !hasWebGL;

    if (window.__liquidGLNoWebGL__ === true || noGPU) {
      console.warn(
        "liquidGL: WebGPU/WebGL not available – falling back to CSS backdrop-filter.",
      );
      const fbTint = options.tint || [1, 1, 1, 0.07];
      const fbBackground = `rgba(${Math.round(fbTint[0] * 255)}, ${Math.round(fbTint[1] * 255)}, ${Math.round(fbTint[2] * 255)}, ${options.tint ? Math.max(fbTint[3], 0.04) : fbTint[3]})`;
      const instances = Array.from(
        document.querySelectorAll(options.target),
        (node) => {
          const lens = new liquidGLLens(null, node, { ...options });
          lens._restoreStyles = restoreStyles(node, [
            "background",
            "backdrop-filter",
            "-webkit-backdrop-filter",
          ]);
          Object.assign(node.style, {
            background: fbBackground,
            backdropFilter: "blur(12px)",
            webkitBackdropFilter: "blur(12px)",
          });
          return lens;
        },
      );
      return instances.length === 1 ? instances[0] : instances;
    }

    const snapshotTarget =
      document.querySelector(options.snapshot) || document.body;
    const nodeList = document.querySelectorAll(options.target);
    if (!nodeList || nodeList.length === 0) {
      console.warn(
        `liquidGL: Target element(s) '${options.target}' not found.`,
      );
      return;
    }

    const instances = Array.from(nodeList).map((el) => {
      const zIndex = options.zIndex ?? effectiveZ(el);
      let anchor = el;
      while (anchor !== document.body && anchor.parentElement) {
        if (/^(fixed|sticky)$/.test(getComputedStyle(anchor).position)) break;
        anchor = anchor.parentElement;
      }
      let renderer = Array.from(renderers).find(
        (candidate) =>
          candidate.snapshotTarget === snapshotTarget &&
          candidate._anchor === anchor &&
          candidate._zIndex === zIndex,
      );
      if (!renderer) {
        renderer = new liquidGLRenderer(
          options.snapshot,
          options.resolution,
          options.engine,
          anchor,
        );
        renderer._zIndex = zIndex;
        renderer.useExternalTicker =
          window.__liquidGLRenderer__?.useExternalTicker || false;
        renderers.add(renderer);
        window.__liquidGLRenderer__ ||= renderer;
      }
      const lens = renderer.addLens(el, options);
      for (const instance of renderers) {
        for (const layer of instance._contentLayers) layer.invalidate();
      }
      return lens;
    });
    startRendering();

    if (options.helper) {
      if (typeof window.__liquidGLHelper__ === "function") {
        window.__liquidGLHelper__(instances, options);
      } else {
        console.error(
          "liquidGL Helper Not Found - ensure liquidGL-helper.js is available in your project",
        );
      }
    }

    return instances.length === 1 ? instances[0] : instances;
  };

  /* --------------------------------------------------
   *  Public helper: register elements that need live updates
   * ------------------------------------------------*/
  window.liquidGL.registerDynamic = function (elements) {
    for (const renderer of renderers.values()) {
      renderer.addDynamicElement(elements);
      renderer.captureSnapshot();
    }
  };

  /* --------------------------------------------------
   *  Public helper: Universal smooth scroll / animation sync
   * ------------------------------------------------*/
  window.liquidGL.syncWith = function (config = {}) {
    const renderer = window.__liquidGLRenderer__;
    if (!renderer) {
      console.warn(
        "liquidGL: Please initialize liquidGL *before* calling syncWith().",
      );
      return;
    }

    stopSync?.();
    cancelAnimationFrame(renderRaf);
    renderRaf = null;
    const cleanups = [];
    let active = true;
    let syncRaf = null;
    stopSync = () => {
      if (!active) return;
      active = false;
      cancelAnimationFrame(syncRaf);
      cleanups.splice(0).forEach((cleanup) => cleanup());
    };

    const G = config.gsap === false ? null : config.gsap || window.gsap;
    const L = window.Lenis;
    const LS = window.LocomotiveScroll;
    const ST = G ? config.ScrollTrigger || G.ScrollTrigger : null;

    let lenis = config.lenis;
    let loco = config.locomotiveScroll;
    const useGSAP = config.gsap !== false && G && ST;

    if (config.lenis !== false && L && !lenis) {
      lenis = new L();
      cleanups.push(() => lenis.destroy?.());
    }

    if (
      config.locomotiveScroll !== false &&
      LS &&
      !loco &&
      document.querySelector("[data-scroll-container]")
    ) {
      loco = new LS({
        el: document.querySelector("[data-scroll-container]"),
        smooth: true,
      });
      cleanups.push(() => loco.destroy?.());
    }

    if (useGSAP && ST) {
      if (loco) {
        const update = () => ST.update();
        loco.on("scroll", update);
        cleanups.unshift(() => loco.off?.("scroll", update));
        ST.scrollerProxy(loco.el, {
          scrollTop(value) {
            return arguments.length
              ? loco.scrollTo(value, { duration: 0, disableLerp: true })
              : loco.scroll.instance.scroll.y;
          },
          getBoundingClientRect() {
            return {
              top: 0,
              left: 0,
              width: window.innerWidth,
              height: window.innerHeight,
            };
          },
          pinType: loco.el.style.transform ? "transform" : "fixed",
        });
        const refresh = () => loco.update();
        ST.addEventListener("refresh", refresh);
        cleanups.unshift(() => {
          ST.removeEventListener("refresh", refresh);
          ST.scrollerProxy(loco.el);
        });
        ST.refresh();
      } else if (lenis) {
        const update = () => ST.update();
        lenis.on("scroll", update);
        cleanups.unshift(() => lenis.off?.("scroll", update));
      }
    }

    for (const instance of renderers.values())
      instance.useExternalTicker = true;

    if (useGSAP) {
      const tick = (time) => {
        if (!active) return;
        if (lenis) lenis.raf(time * 1000);
        renderAll();
      };
      G.ticker.add(tick);
      cleanups.unshift(() => G.ticker.remove(tick));
      G.ticker.lagSmoothing(0);
    } else {
      const loop = (time) => {
        if (!active) return;
        if (lenis) lenis.raf(time);
        if (loco) loco.update();
        renderAll();
        if (active) syncRaf = requestAnimationFrame(loop);
      };
      syncRaf = requestAnimationFrame(loop);
    }

    return { lenis, locomotiveScroll: loco };
  };
  return window.liquidGL;
})();

export default liquidGL;
