/*
 * liquidGL – Ultra-light glassmorphism for the web
 * -----------------------------------------------------------------------------
 *
 * Author: NaughtyDuk© – https://liquidgl.naughtyduk.com
 * Licence: MIT
 * Version: v2.0.1
 */

const liquidGL = (() => {
  "use strict";

  const RECAPTURE_INTERVAL_MS = 250;

  /* --------------------------------------------------
   *  Utilities
   * ------------------------------------------------*/
  function debounce(fn, wait) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, a), wait);
    };
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

    function loadImage(src) {
      if (!src) return null;
      if (imageCache.has(src)) return imageCache.get(src);
      const img = new Image();
      const entry = { img, ready: false, failed: false };
      imageCache.set(src, entry);
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
      const signature = `${el.outerHTML.length}|${el.childElementCount}|${Math.round(r.width)}x${Math.round(r.height)}|${el.className}`;
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

    function paint(plan, canvas) {
      const ctx = prepareCanvas(plan, canvas);
      const painter = new Painter(ctx, plan.base);
      painter.run(plan.ops, 0, 0);
      painter.release();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return canvas;
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

    return { measure, paint, paintChunked, rasterise, rasteriseAsync };
  })();

  /* --------------------------------------------------
   *  Shared renderer (one per page)
   * ------------------------------------------------*/
  class liquidGLRenderer {
    constructor(snapshotSelector, snapshotResolution = 1.0) {
      this._naughtyQueued = false;
      this.canvas = document.createElement("canvas");
      this.canvas.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;`;
      this.canvas.setAttribute("data-liquid-ignore", "");
      document.body.appendChild(this.canvas);

      const ctxAttribs = {
        alpha: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
      };
      this.gl =
        this.canvas.getContext("webgl2", ctxAttribs) ||
        this.canvas.getContext("webgl", ctxAttribs) ||
        this.canvas.getContext("experimental-webgl", ctxAttribs);
      if (!this.gl) throw new Error("liquidGL: WebGL unavailable");

      this.lenses = [];
      this.texture = null;
      this.textureWidth = 0;
      this.textureHeight = 0;
      this.scaleFactor = 1;
      this.startTime = Date.now();
      this._scrollUpdateCounter = 0;

      this._initGL();

      this.snapshotTarget =
        document.querySelector(snapshotSelector) || document.body;
      if (!this.snapshotTarget) this.snapshotTarget = document.body;

      this._isScrolling = false;
      let lastScrollY = window.scrollY;
      let scrollTimeout;
      const scrollCheck = () => {
        if (window.scrollY !== lastScrollY) {
          this._isScrolling = true;
          lastScrollY = window.scrollY;
          clearTimeout(scrollTimeout);
          scrollTimeout = setTimeout(() => {
            this._isScrolling = false;
          }, 200);
        }
        requestAnimationFrame(scrollCheck);
      };
      requestAnimationFrame(scrollCheck);

      const onResize = debounce(() => {
        if (this._capturing || this._isScrolling) return;

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
      window.addEventListener("resize", onResize, { passive: true });

      if ("ResizeObserver" in window) {
        new ResizeObserver(onResize).observe(this.snapshotTarget);
      }

      /* --------------------------------------------------
       *  Dynamic DOM elements (non-video, e.g. animating text)
       * ------------------------------------------------*/
      this._dynamicNodes = [];
      this._dynMeta = new WeakMap();
      this._lastDynamicUpdate = 0;

      const styleEl = document.createElement("style");
      styleEl.id = "liquid-gl-dynamic-styles";
      document.head.appendChild(styleEl);
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
        this._dynWorker = new Worker(URL.createObjectURL(blob), {
          type: "module",
        });

        this._dynJobs = new Map();

        this._dynWorker.onmessage = (e) => {
          const { id, bmp } = e.data;
          const meta = this._dynJobs.get(id);
          if (!meta) return;
          this._dynJobs.delete(id);

          const { x, y, w, h } = meta;
          const gl = this.gl;
          gl.bindTexture(gl.TEXTURE_2D, this.texture);
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            x,
            y,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            bmp,
          );
        };
      }
    }

    /* ----------------------------- */
    _initGL() {
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

        float edgeFactor(vec2 p_px, vec2 b_px, float radius_px){
          float d = -udRoundBox(p_px, b_px, radius_px);
          float bevel_px = u_bevelWidth * min(u_boxSize.x, u_boxSize.y);
          return 1.0 - smoothstep(0.0, bevel_px, d);
        }
        void main(){
          vec2 p = v_uv - 0.5;
          p.x *= u_resolution.x / u_resolution.y;

          vec2 p_px = v_uv * u_resolution - u_subpixel - 0.5 * u_boxSize;
          vec2 b_px = 0.5 * u_boxSize;

          float edge = edgeFactor(p_px, b_px, u_radius);
          float min_dimension = min(u_resolution.x, u_resolution.y);
          float offsetAmt = (edge * u_refraction + pow(edge, 10.0) * u_bevelDepth);
          float centreBlend = smoothstep(0.15, 0.45, length(p));
          vec2 refractDir = cornerNormal(p_px, b_px, u_radius, normalize(p));
          vec2 offset = refractDir * offsetAmt * centreBlend;

          float tiltRefractionScale = 0.05;
          vec2 tiltOffset = vec2(tan(radians(u_tiltY)), -tan(radians(u_tiltX))) * tiltRefractionScale;

          vec2 localUV = (v_uv - 0.5) / u_magnify + 0.5;
          vec2 flippedUV = vec2(localUV.x, 1.0 - localUV.y);
          vec2 mapped = u_bounds.xy + flippedUV * u_bounds.zw;
          vec2 refracted = mapped + offset - tiltOffset;

          float oob = max(max(-refracted.x, refracted.x - 1.0), max(-refracted.y, refracted.y - 1.0));
          float blend = 1.0 - smoothstep(0.0, 0.01, oob);
          vec2 sampleUV = mix(mapped, refracted, blend);

          vec4 baseCol   = texture2D(u_tex, mapped);

          vec2 texel = 1.0 / u_textureResolution;
          vec4 refrCol;

          if (u_frost > 0.0) {
              float radius = u_frost * 4.0;
              vec4 sum = vec4(0.0);
              const int SAMPLES = 16;

              for (int i = 0; i < SAMPLES; i++) {
                  float angle = random(v_uv + float(i)) * 6.283185;
                  float dist = sqrt(random(v_uv - float(i))) * radius;
                  vec2 offset = vec2(cos(angle), sin(angle)) * texel * dist;
                  sum += texture2D(u_tex, sampleUV + offset);
              }
              refrCol = sum / float(SAMPLES);
          } else {
              refrCol = texture2D(u_tex, sampleUV);
              refrCol += texture2D(u_tex, sampleUV + vec2( texel.x, 0.0));
              refrCol += texture2D(u_tex, sampleUV + vec2(-texel.x, 0.0));
              refrCol += texture2D(u_tex, sampleUV + vec2(0.0,  texel.y));
              refrCol += texture2D(u_tex, sampleUV + vec2(0.0, -texel.y));
              refrCol /= 5.0;
          }

          if (u_aberration > 0.0) {
              vec2 chroma = offset * u_aberration;
              refrCol.r = texture2D(u_tex, sampleUV - chroma).r;
              refrCol.b = texture2D(u_tex, sampleUV + chroma).b;
          }

          if (refrCol.a < 0.1) {
              refrCol = baseCol;
          }

          float diff = clamp(length(refrCol.rgb - baseCol.rgb) * 4.0, 0.0, 1.0);

          float antiHalo = (1.0 - centreBlend) * diff;

          vec4 final    = refrCol;

          float dmask = udRoundBox(p_px, b_px, u_radius);
          float inShape = 1.0 - smoothstep(-0.5, 0.5, dmask);

          if (u_specular) {
            vec2 lp1 = vec2(sin(u_time*0.2), cos(u_time*0.3))*0.6 + 0.5;
            vec2 lp2 = vec2(sin(u_time*-0.4+1.5), cos(u_time*0.25-0.5))*0.6 + 0.5;
            float h = 0.0;
            h += smoothstep(0.4,0.0,distance(v_uv, lp1))*0.1;
            h += smoothstep(0.5,0.0,distance(v_uv, lp2))*0.08;
            final.rgb += h;
          }

          if (u_revealType == 1) {
              final.rgb *= u_revealProgress;
              final.a  *= u_revealProgress;
          }

          final.rgb *= inShape;
          final.a   *= inShape;

          gl_FragColor = final;
        }`;

      this.program = createProgram(this.gl, vsSource, fsSource);
      const gl = this.gl;
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
      };
    }

    /* ----------------------------- */
    _resizeCanvas() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = innerWidth * dpr;
      this.canvas.height = innerHeight * dpr;
      this.canvas.style.width = `${innerWidth}px`;
      this.canvas.style.height = `${innerHeight}px`;
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    /* ----------------------------- */
    async captureSnapshot() {
      if (this._capturing) return;
      this._capturing = true;

      const undos = [];

      const attemptCapture = async (
        attempt = 1,
        maxAttempts = 3,
        delayMs = 500,
      ) => {
        try {
          const fullW = this.snapshotTarget.scrollWidth;
          const fullH = this.snapshotTarget.scrollHeight;
          const maxTex = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) || 8192;
          const MAX_MOBILE_DIM = 4096;
          const isMobileSafari = /iPad|iPhone|iPod/.test(navigator.userAgent);

          let scale = Math.min(
            this._snapshotResolution,
            maxTex / fullW,
            maxTex / fullH,
          );

          if (isMobileSafari) {
            const over = (Math.max(fullW, fullH) * scale) / MAX_MOBILE_DIM;
            if (over > 1) scale = scale / over;
          }

          const maxArea = isMobileSafari ? 4096 * 4096 : 16384 * 16384;
          if (fullW * fullH * scale * scale > maxArea) {
            scale = Math.sqrt(maxArea / (fullW * fullH));
            console.warn(
              `liquidGL: snapshot area capped, resolution reduced to ${scale.toFixed(
                3,
              )} for a ${fullW}x${fullH} document.`,
            );
          }

          this.scaleFactor = Math.max(0.1, scale);

          this.canvas.style.visibility = "hidden";
          undos.push(() => (this.canvas.style.visibility = "visible"));

          const lensElements = this.lenses
            .flatMap((lens) => [lens.el, lens._shadowEl])
            .filter(Boolean);

          lensElements.forEach((el) => {
            el.setAttribute("data-liquidgl-hide", "");
            undos.push(() => {
              el.removeAttribute("data-liquidgl-hide");
            });
          });

          const ignoreElementsFunc = (element) => {
            if (!element || !element.hasAttribute) return false;
            if (element === this.canvas) {
              return true;
            }
            const style = window.getComputedStyle(element);
            if (style.position === "fixed") {
              return true;
            }
            return (
              element.hasAttribute("data-liquid-ignore") ||
              element.closest("[data-liquid-ignore]")
            );
          };

          const naughtyIgnore = (el) =>
            ignoreElementsFunc(el) ||
            (el.hasAttribute && el.hasAttribute("data-liquidgl-hide"));

          const snapCanvas = await NaughtyDOM.rasteriseAsync(
            this.snapshotTarget,
            {
              width: fullW,
              height: fullH,
              scale: scale,
              ignoreElements: naughtyIgnore,
            },
          );

          if (!this._uploadTexture(snapCanvas)) {
            throw new Error("liquidGL: snapshot could not be uploaded.");
          }
          return true;
        } catch (e) {
          console.error("liquidGL snapshot failed on attempt " + attempt, e);
          if (attempt < maxAttempts) {
            console.log(
              `Retrying snapshot capture (${attempt + 1}/${maxAttempts})...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return await attemptCapture(attempt + 1, maxAttempts, delayMs);
          } else {
            console.error("liquidGL: All snapshot attempts failed.", e);
            return false;
          }
        } finally {
          for (let i = undos.length - 1; i >= 0; i--) {
            undos[i]();
          }
          this._capturing = false;
        }
      };

      return await attemptCapture();
    }

    /* ----------------------------- */
    _uploadTexture(srcCanvas) {
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

      this.textureWidth = srcCanvas.width;
      this.textureHeight = srcCanvas.height;

      if (this._videoFrameState) this._videoFrameState = new WeakMap();

      this._vFboTexture = null;

      this.render();

      if (this._pendingReveal.length) {
        this._pendingReveal.forEach((ln) => ln._reveal());
        this._pendingReveal.length = 0;
      }

      return true;
    }

    /* ----------------------------- */
    addLens(element, options) {
      const lens = new liquidGLLens(this, element, options);
      this.lenses.push(lens);

      const maxZ = this._getMaxLensZ();
      if (maxZ > 0) {
        this.canvas.style.zIndex = maxZ - 1;
      }

      if (!this.texture) {
        this._pendingReveal.push(lens);
      } else {
        lens._reveal();
      }
      return lens;
    }

    /* ----------------------------- */
    render() {
      const gl = this.gl;
      if (!this.texture) return;

      if (this._isScrolling) {
        this._scrollUpdateCounter++;
      }

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(this.u.tex, 0);

      const time = (Date.now() - this.startTime) / 1000;
      gl.uniform1f(this.u.time, time);

      this._updateDynamicVideos();

      this._updateDynamicNodes();

      this._frameSnapRect = this.snapshotTarget.getBoundingClientRect();

      this.lenses.forEach((lens) => {
        lens.updateMetrics();
        if (lens._mirrorActive && lens._mirrorClipUpdater) {
          lens._mirrorClipUpdater();
        }
        this._renderLens(lens);
      });

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
          ln._mirrorCtx.drawImage(this.canvas, 0, 0);
        }
      });

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.lenses.forEach((ln) => {
        if (ln._mirrorActive && ln.rectPx) {
          const { left, top, width, height } = ln.rectPx;
          const expand = 2;
          const x = Math.max(0, Math.round(left * dpr) - expand);
          const y = Math.max(
            0,
            Math.round(this.canvas.height - (top + height) * dpr) - expand,
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
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(x, y, w, h);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.disable(gl.SCISSOR_TEST);
          }
        }
      });
    }

    /* ----------------------------- */
    _renderLens(lens) {
      const gl = this.gl;
      const rect = lens.rectPx;
      if (!rect) return;

      const dpr = Math.min(2, window.devicePixelRatio || 1);

      let overscrollY = 0;
      let overscrollX = 0;

      const vv = window.visualViewport;
      if (vv && Math.abs(vv.scale - 1) < 0.01) {
        overscrollX = vv.offsetLeft;
        overscrollY = vv.offsetTop;
      }

      const leftPx = (rect.left + overscrollX) * dpr;
      const topPx = (rect.top + overscrollY) * dpr;
      const x = Math.round(leftPx);
      const yTop = Math.round(topPx);
      const w = Math.round(leftPx + rect.width * dpr) - x;
      const h = Math.round(topPx + rect.height * dpr) - yTop;
      const y = this.canvas.height - (yTop + h);

      gl.viewport(x, y, w, h);
      gl.uniform2f(this.u.res, w, h);
      gl.uniform2f(this.u.subpixel, leftPx - x, topPx - yTop);
      gl.uniform2f(this.u.boxSize, rect.width * dpr, rect.height * dpr);

      const snapRect =
        this._frameSnapRect || this.snapshotTarget.getBoundingClientRect();
      const docX = rect.left - snapRect.left;
      const docY = rect.top - snapRect.top;
      const leftUV = (docX * this.scaleFactor) / this.textureWidth;
      const topUV = (docY * this.scaleFactor) / this.textureHeight;
      const wUV = (rect.width * this.scaleFactor) / this.textureWidth;
      const hUV = (rect.height * this.scaleFactor) / this.textureHeight;
      gl.uniform4f(this.u.bounds, leftUV, topUV, wUV, hUV);

      gl.uniform2f(
        this.u.textureResolution,
        this.textureWidth,
        this.textureHeight,
      );
      gl.uniform1f(this.u.refraction, lens.options.refraction);
      gl.uniform1f(this.u.aberration, lens.options.aberration || 0);
      gl.uniform1f(this.u.bevelDepth, lens.options.bevelDepth);
      gl.uniform1f(this.u.bevelWidth, lens.options.bevelWidth);
      gl.uniform1f(this.u.frost, lens.options.frost);
      gl.uniform1f(this.u.radius, lens.radiusGl);
      gl.uniform1i(this.u.specular, lens.options.specular ? 1 : 0);
      gl.uniform1f(this.u.revealProgress, lens._revealProgress || 1.0);
      gl.uniform1i(this.u.revealType, lens.revealTypeIndex || 0);

      const mag = Math.max(
        0.001,
        Math.min(
          3.0,
          lens.options.magnify !== undefined ? lens.options.magnify : 1.0,
        ),
      );
      gl.uniform1f(this.u.magnify, mag);

      gl.uniform1f(this.u.tiltX, lens.tiltX || 0);
      gl.uniform1f(this.u.tiltY, lens.tiltY || 0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
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
        void main(){
          gl_FragColor = texture2D(u_src, u_srcRect.xy + v_uv * u_srcRect.zw);
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

    _blitVideoToTexture(vid, dstX, dstY, dstW, dstH, srcRect) {
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
          vid,
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
      gl.uniform4f(
        this._vU.srcRect,
        srcRect.u,
        srcRect.v,
        srcRect.uw,
        srcRect.vh,
      );

      gl.viewport(dstX, dstY, dstW, dstH);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._restoreLensProgramState();

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

    /* ----------------------------- */
    _updateDynamicVideos() {
      if (this._isScrolling && this._scrollUpdateCounter % 2 !== 0) return;
      if (
        !this.texture ||
        !this.staticSnapshotCanvas ||
        !this._videoNodes.length
      )
        return;
      const gl = this.gl;

      const snapRect = this.snapshotTarget.getBoundingClientRect();

      const maxLensZ = this._getMaxLensZ();

      this._videoNodes.forEach((vid) => {
        if (effectiveZ(vid) >= maxLensZ) {
          return;
        }

        if (this._isIgnored(vid) || vid.readyState < 2) return;

        const rect = vid.getBoundingClientRect();
        const texX = (rect.left - snapRect.left) * this.scaleFactor;
        const texY = (rect.top - snapRect.top) * this.scaleFactor;
        const texW = rect.width * this.scaleFactor;
        const texH = rect.height * this.scaleFactor;

        const drawW = Math.round(texW);
        const drawH = Math.round(texH);

        if (drawW <= 0 || drawH <= 0) return;

        const geomKey =
          Math.round(texX) + "," + Math.round(texY) + "," + drawW + "," + drawH;
        const prevState = this._videoFrameState.get(vid);
        if (
          prevState &&
          prevState.time === vid.currentTime &&
          prevState.geom === geomKey
        ) {
          return;
        }
        this._videoFrameState.set(vid, {
          time: vid.currentTime,
          geom: geomKey,
        });

        const drawX = Math.round(texX);
        const drawY = Math.round(texY);

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
          this._initVideoBlit() &&
          this._videoIsOpaque(vid) &&
          this._blitVideoToTexture(vid, dstX, dstY, updW, updH, {
            u: srcX / drawW,
            v: srcY / drawH,
            uw: updW / drawW,
            vh: updH / drawH,
          })
        ) {
          return;
        }

        if (
          this._tmpCanvas.width !== drawW ||
          this._tmpCanvas.height !== drawH
        ) {
          this._tmpCanvas.width = drawW;
          this._tmpCanvas.height = drawH;
        }

        try {
          this._tmpCtx.save();
          this._tmpCtx.clearRect(0, 0, drawW, drawH);

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

          this._tmpCtx.drawImage(vid, 0, 0, drawW, drawH);
          this._tmpCtx.restore();
        } catch (e) {
          console.warn("liquidGL: Error drawing video frame", e);
          return;
        }

        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          dstX,
          dstY,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          this._tmpCanvas,
        );
      });
    }

    /* ----------------------------- */
    _updateDynamicNodes() {
      if (this._isScrolling && this._scrollUpdateCounter % 2 !== 0) return;
      const gl = this.gl;
      if (!this.texture || !this._dynMeta) return;
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

      const compositeVideos = (compositeCtx, dynamicElRect) => {
        this._videoNodes.forEach((vid) => {
          if (effectiveZ(vid) >= maxLensZ) return;
          const vidRect = vid.getBoundingClientRect();

          if (
            dynamicElRect.left < vidRect.right &&
            dynamicElRect.right > vidRect.left &&
            dynamicElRect.top < vidRect.bottom &&
            dynamicElRect.bottom > vidRect.top
          ) {
            const xInComposite =
              (vidRect.left - dynamicElRect.left) * this.scaleFactor;
            const yInComposite =
              (vidRect.top - dynamicElRect.top) * this.scaleFactor;
            const wInComposite = vidRect.width * this.scaleFactor;
            const hInComposite = vidRect.height * this.scaleFactor;
            compositeCtx.drawImage(
              vid,
              xInComposite,
              yInComposite,
              wInComposite,
              hInComposite,
            );
          }
        });
      };

      this._dynamicNodes.forEach((node) => {
        const el = node.el;
        const meta = this._dynMeta.get(el);
        if (!meta) return;

        if (meta.needsRecapture && !meta._capturing && !this._isScrolling) {
          meta._capturing = true;

          const ignoreDynamic = (n) =>
            n.tagName === "CANVAS" || n.hasAttribute("data-liquid-ignore");

          if (this._naughtyQueued) {
            meta._capturing = false;
          } else {
            this._naughtyQueued = true;
            const capture = () => {
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
                  meta.needsRecapture = false;
                }
              } catch (e) {
                console.error("liquidGL: Dynamic element capture failed.", e);
              }
              meta._capturing = false;
            };
            if (typeof requestIdleCallback === "function") {
              requestIdleCallback(capture, { timeout: 100 });
            } else {
              setTimeout(capture, 0);
            }
          }
        }

        if (meta.lastCapture) {
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
              gl.bindTexture(gl.TEXTURE_2D, this.texture);
              gl.texSubImage2D(
                gl.TEXTURE_2D,
                0,
                x,
                y,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                eraseCanvas,
              );
            }
          }

          const rect = el.getBoundingClientRect();
          if (
            effectiveZ(el) >= maxLensZ ||
            !document.contains(el) ||
            rect.width === 0 ||
            rect.height === 0
          ) {
            meta.prevDrawRect = null;
            return;
          }

          if (!lensRects.some((lr) => rectsIntersect(rect, lr))) {
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
          compositeVideos(this._compositeCtx, rect);

          const style = window.getComputedStyle(el);
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

          gl.bindTexture(gl.TEXTURE_2D, this.texture);
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            dstX,
            dstY,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            compositeCanvas,
          );

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
    _getMaxLensZ() {
      let maxZ = 0;
      this.lenses.forEach((ln) => {
        const z = effectiveZ(ln.el);
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
      if (!el.getBoundingClientRect) return;
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
          requestAnimationFrame(() => this.render());
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

      el.addEventListener(
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

      el.addEventListener("mouseleave", handleLeave, { passive: true });
      el.addEventListener("transitionend", setDirty, { passive: true });

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

      el.addEventListener("transitionrun", transitionRunHandler, {
        passive: true,
      });
      el.addEventListener("transitionstart", transitionRunHandler, {
        passive: true,
      });
      el.addEventListener(
        "animationstart",
        () => {
          const m = this._dynMeta.get(el);
          if (m) m._heavyAnim = true;
          startRealtime();
        },
        { passive: true },
      );

      el.addEventListener(
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

      el.addEventListener("transitionend", stopRealtime, { passive: true });
      el.addEventListener("transitioncancel", stopRealtime, { passive: true });
      el.addEventListener("animationend", stopRealtime, { passive: true });
      el.addEventListener("animationcancel", stopRealtime, { passive: true });

      /* --------------------------------------------------
       *  Removal clean-up
       * --------------------------------------------------*/
      if (typeof MutationObserver !== "undefined") {
        const removalObserver = new MutationObserver(() => {
          if (!document.contains(el)) {
            handleLeave();
            removalObserver.disconnect();
            this._dynamicNodes = this._dynamicNodes.filter((n) => n.el !== el);
            this._dynMeta.delete(el);
          }
        });
        removalObserver.observe(document.body, {
          childList: true,
          subtree: true,
        });
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

      this.originalShadow = this.el.style.boxShadow;
      this.originalOpacity = this.el.style.opacity;
      this.originalTransition = this.el.style.transition;
      this.el.style.transition = "none";
      this.el.style.opacity = 0;

      this.el.style.position =
        this.el.style.position === "static"
          ? "relative"
          : this.el.style.position;

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

      this.el.style.pointerEvents = "none";

      this.updateMetrics();
      this.setShadow(this.options.shadow);
      if (this.options.tilt) this._bindTiltHandlers();

      if (typeof ResizeObserver !== "undefined" && !this._sizeObs) {
        this._sizeObs = new ResizeObserver(() => {
          this.updateMetrics();
          this.renderer.render();
        });
        this._sizeObs.observe(this.el);
      }
    }

    /* ----------------------------- */
    updateMetrics() {
      const rect =
        this._mirrorActive && this._baseRect
          ? this._baseRect
          : this.el.getBoundingClientRect();

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
      this.options.tilt = !!enabled;
      if (this.options.tilt) {
        this._bindTiltHandlers();
      } else {
        this._unbindTiltHandlers();
      }
    }

    /* ----------------------------- */
    setShadow(enabled) {
      this.options.shadow = !!enabled;

      const SHADOW_VAL =
        "0 10px 30px rgba(0,0,0,0.1), 0 0 0 0.5px rgba(0,0,0,0.05)";

      const syncShadow = () => {
        if (!this._shadowEl) return;
        const r =
          this._mirrorActive && this._baseRect
            ? this._baseRect
            : this.el.getBoundingClientRect();
        this._shadowEl.style.left = `${r.left}px`;
        this._shadowEl.style.top = `${r.top}px`;
        this._shadowEl.style.width = `${r.width}px`;
        this._shadowEl.style.height = `${r.height}px`;
        this._shadowEl.style.borderRadius = `${this.radiusCss}px`;
      };

      if (enabled) {
        this.el.style.boxShadow = SHADOW_VAL;

        if (!this._shadowEl) {
          this._shadowEl = document.createElement("div");
          Object.assign(this._shadowEl.style, {
            position: "fixed",
            pointerEvents: "none",
            zIndex: effectiveZ(this.el) - 2,
            boxShadow: SHADOW_VAL,
            willChange: "transform, width, height",
            opacity: this.revealTypeIndex === 1 ? 0 : 1,
          });
          document.body.appendChild(this._shadowEl);

          this._shadowSyncFn = syncShadow;
          window.addEventListener("resize", this._shadowSyncFn, {
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
    }

    /* ----------------------------- */
    _reveal() {
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

      const animate = () => {
        const progress = Math.min(1, (performance.now() - start) / dur);

        this.renderer.lenses.forEach((ln) => {
          ln._revealProgress = progress;
          ln.el.style.opacity = (ln.originalOpacity || 1) * progress;
          if (ln._shadowEl) {
            ln._shadowEl.style.opacity = progress;
          }
        });

        this.renderer.canvas.style.opacity = String(progress);

        this.renderer.render();

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          this.renderer._revealAnimating = false;
          this.renderer.lenses.forEach((ln) => {
            ln.el.style.transition = ln.originalTransition || "";
            ln._TriggerInit();
          });
        }
      };

      requestAnimationFrame(animate);
    }

    /* ----------------------------- */
    _bindTiltHandlers() {
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

      const TILT_TRACK_MS = 120;

      const setTiltTransition = (ms) => {
        const value = `transform ${ms}ms cubic-bezier(0.33,1,0.68,1)`;
        this.el.style.transition = value;
        if (this._mirror) this._mirror.style.transition = value;
        if (this._shadowEl) this._shadowEl.style.transition = value;
      };

      this._clearTiltEnterTimer = () => {
        if (this._tiltEnterTimer) {
          clearTimeout(this._tiltEnterTimer);
          this._tiltEnterTimer = null;
        }
      };

      this._applyTilt = (clientX, clientY) => {
        if (!this._tiltInteracting) {
          this._tiltInteracting = true;
          this._createMirrorCanvas();

          const enterMs = getTiltEase();
          setTiltTransition(enterMs);

          this._tiltEntering = enterMs > 0;
          this._clearTiltEnterTimer();
          if (this._tiltEntering) {
            this._tiltEnterTimer = setTimeout(() => {
              this._tiltEntering = false;
              this._tiltEnterTimer = null;
              setTiltTransition(TILT_TRACK_MS);
            }, enterMs);
          }
        }

        const r = this._baseRect || this._measureBaseRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;

        this._pivotOrigin = `${cx}px ${cy}px`;

        const pctX = (clientX - cx) / (r.width / 2);
        const pctY = (clientY - cy) / (r.height / 2);
        const maxTilt = getMaxTilt();
        const rotY = pctX * maxTilt;
        const rotX = -pctY * maxTilt;
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

        if (this._tiltEntering) {
          this._easeTiltTo(rotX, rotY, getTiltEase());
        } else {
          this._cancelTiltEase();
          this.tiltX = rotX;
          this.tiltY = rotY;
        }

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

      this._easeTiltTo = (toX, toY, duration) => {
        this._cancelTiltEase();

        const fromX = this.tiltX;
        const fromY = this.tiltY;
        if (fromX === toX && fromY === toY) return;

        if (!duration || duration <= 0) {
          this.tiltX = toX;
          this.tiltY = toY;
          this.renderer.render();
          return;
        }

        const start =
          typeof performance !== "undefined" ? performance.now() : Date.now();

        const step = (now) => {
          const elapsed =
            (typeof now === "number"
              ? now
              : typeof performance !== "undefined"
                ? performance.now()
                : Date.now()) - start;
          const t = Math.min(1, elapsed / duration);
          const eased = 1 - Math.pow(1 - t, 3);

          this.tiltX = fromX + (toX - fromX) * eased;
          this.tiltY = fromY + (toY - fromY) * eased;
          this.renderer.render();

          if (t < 1) {
            this._tiltEaseRaf = requestAnimationFrame(step);
          } else {
            this._tiltEaseRaf = null;
            this.tiltX = toX;
            this.tiltY = toY;
            this.renderer.render();
          }
        };

        this._tiltEaseRaf = requestAnimationFrame(step);
      };

      this._smoothReset = () => {
        const restMs = getTiltEase();
        setTiltTransition(restMs);
        this.el.style.transformOrigin = `50% 50%`;
        const baseRest =
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

        this.el.style.transform = `${overscrollCompensation}${baseRest}perspective(800px) rotateX(0deg) rotateY(0deg)`;

        this._tiltEntering = false;
        this._clearTiltEnterTimer();
        this._easeTiltTo(0, 0, getTiltEase());

        if (this._mirror) {
          this._mirror.style.transformOrigin = this._pivotOrigin || "50% 50%";
          this._mirror.style.transform = `${baseRest}perspective(800px) rotateX(0deg) rotateY(0deg)`;
          const clean = () => {
            this._destroyMirrorCanvas();
            this._resetCleanupTimer = null;
          };
          this._mirror.addEventListener("transitionend", clean, {
            once: true,
          });
          this._resetCleanupTimer = setTimeout(clean, restMs + 50);
        }

        if (this._shadowEl) {
          this._shadowEl.style.transformOrigin = `50% 50%`;
          this._shadowEl.style.transform = `${baseRest}perspective(800px) rotateX(0deg) rotateY(0deg)`;
        }
      };

      this._onMouseEnter = (e) => {
        if (this._resetCleanupTimer) {
          clearTimeout(this._resetCleanupTimer);
          this._resetCleanupTimer = null;
          this._destroyMirrorCanvas();
          this.el.style.transition = "none";
          this.el.style.transform = this._savedTransform || "";
          void this.el.offsetHeight;
        }

        this._tiltInteracting = false;
        this._createMirrorCanvas();

        const r = this._baseRect || this._measureBaseRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;

        this._applyTilt(cx, cy);

        if (e && typeof e.clientX === "number") {
          requestAnimationFrame(() => {
            this._applyTilt(e.clientX, e.clientY);
          });
        }

        document.addEventListener("mousemove", this._boundCheckLeave, {
          passive: true,
        });
      };

      this._onMouseMove = (e) => this._applyTilt(e.clientX, e.clientY);

      this._onTouchStart = (e) => {
        this._tiltInteracting = false;
        this._createMirrorCanvas();
        if (e.touches && e.touches.length === 1) {
          const t = e.touches[0];
          this._applyTilt(t.clientX, t.clientY);
        }
      };
      this._onTouchMove = (e) => {
        if (e.touches && e.touches.length === 1) {
          const t = e.touches[0];
          this._applyTilt(t.clientX, t.clientY);
        }
      };
      this._onTouchEnd = () => {
        this._smoothReset();
      };

      this.el.addEventListener("mouseenter", this._onMouseEnter.bind(this), {
        passive: true,
      });
      this.el.addEventListener("mousemove", this._onMouseMove.bind(this), {
        passive: true,
      });
      this.el.addEventListener("touchstart", this._onTouchStart.bind(this), {
        passive: true,
      });
      this.el.addEventListener("touchmove", this._onTouchMove.bind(this), {
        passive: true,
      });
      this.el.addEventListener("touchend", this._onTouchEnd.bind(this), {
        passive: true,
      });

      /* ----------------------------- */
      this._tiltActive = false;

      this._docPointerMove = (e) => {
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

      document.addEventListener("pointermove", this._docPointerMove, {
        passive: true,
      });

      this._tiltHandlersBound = true;
    }

    _unbindTiltHandlers() {
      if (!this._tiltHandlersBound) return;
      if (this._cancelTiltEase) this._cancelTiltEase();
      if (this._clearTiltEnterTimer) this._clearTiltEnterTimer();
      this._tiltEntering = false;
      this.tiltX = 0;
      this.tiltY = 0;
      this.el.removeEventListener("mouseenter", this._onMouseEnter.bind(this));
      this.el.removeEventListener("mousemove", this._onMouseMove.bind(this));
      document.removeEventListener("mousemove", this._boundCheckLeave);
      this.el.removeEventListener("touchstart", this._onTouchStart.bind(this));
      this.el.removeEventListener("touchmove", this._onTouchMove.bind(this));
      this.el.removeEventListener("touchend", this._onTouchEnd.bind(this));

      if (this._docPointerMove) {
        document.removeEventListener("pointermove", this._docPointerMove);
        this._docPointerMove = null;
      }
      this._tiltHandlersBound = false;

      this.el.style.transform = this._savedTransform || "";
      this.el.style.transformStyle = this._savedTransformStyle || "";

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
      this._mirror = document.createElement("canvas");
      Object.assign(this._mirror.style, {
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: effectiveZ(this.el) - 1,
        willChange: "transform",
      });
      this._mirrorCtx = this._mirror.getContext("2d");
      document.body.appendChild(this._mirror);

      const updateClip = () => {
        if (this._mirrorActive) {
          this._baseRect = this._baseRect || this._measureBaseRect();
        }
        const r = this._baseRect || this._measureBaseRect();
        const radius = `${this.radiusCss}px`;
        this._mirror.style.clipPath = `inset(${r.top}px ${
          innerWidth - r.right
        }px ${innerHeight - r.bottom}px ${r.left}px round ${radius})`;
        this._mirror.style.webkitClipPath = this._mirror.style.clipPath;
      };
      updateClip();
      this._mirrorClipUpdater = updateClip;
      window.addEventListener("resize", updateClip, { passive: true });

      this._mirrorActive = true;
    }

    _destroyMirrorCanvas() {
      if (!this._mirror) return;
      window.removeEventListener("resize", this._mirrorClipUpdater);
      this._mirror.remove();
      this._mirror = this._mirrorCtx = null;
      this._baseRect = null;
      this._mirrorActive = false;
    }

    _TriggerInit() {
      if (this._initCalled) return;
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
      magnify: 1,
      on: {},
    };
    const options = { ...defaults, ...userOptions };

    if (typeof window.__liquidGLNoWebGL__ === "undefined") {
      const testCanvas = document.createElement("canvas");
      const testCtx =
        testCanvas.getContext("webgl2") ||
        testCanvas.getContext("webgl") ||
        testCanvas.getContext("experimental-webgl");
      window.__liquidGLNoWebGL__ = !testCtx;
    }

    const noWebGL = window.__liquidGLNoWebGL__;

    if (noWebGL) {
      console.warn(
        "liquidGL: WebGL not available – falling back to CSS backdrop-filter.",
      );
      const fallbackNodes = document.querySelectorAll(options.target);
      fallbackNodes.forEach((node) => {
        Object.assign(node.style, {
          background: "rgba(255, 255, 255, 0.07)",
          backdropFilter: "blur(12px)",
          webkitBackdropFilter: "blur(12px)",
        });
      });
      return fallbackNodes.length === 1
        ? fallbackNodes[0]
        : Array.from(fallbackNodes);
    }

    let renderer = window.__liquidGLRenderer__;
    if (!renderer) {
      renderer = new liquidGLRenderer(options.snapshot, options.resolution);
      window.__liquidGLRenderer__ = renderer;
    }

    const nodeList = document.querySelectorAll(options.target);
    if (!nodeList || nodeList.length === 0) {
      console.warn(
        `liquidGL: Target element(s) '${options.target}' not found.`,
      );
      return;
    }

    const instances = Array.from(nodeList).map((el) =>
      renderer.addLens(el, options),
    );

    if (!renderer._rafId && !renderer.useExternalTicker) {
      const loop = () => {
        renderer.render();
        renderer._rafId = requestAnimationFrame(loop);
      };
      renderer._rafId = requestAnimationFrame(loop);
    }

    return instances.length === 1 ? instances[0] : instances;
  };

  /* --------------------------------------------------
   *  Public helper: register elements that need live updates
   * ------------------------------------------------*/
  window.liquidGL.registerDynamic = function (elements) {
    const renderer = window.__liquidGLRenderer__;
    if (!renderer || !renderer.addDynamicElement) return;
    renderer.addDynamicElement(elements);
    if (renderer.captureSnapshot) {
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

    const G = config.gsap === false ? null : config.gsap || window.gsap;
    const L = window.Lenis;
    const LS = window.LocomotiveScroll;
    const ST = G ? config.ScrollTrigger || G.ScrollTrigger : null;

    let lenis = config.lenis;
    let loco = config.locomotiveScroll;
    const useGSAP = config.gsap !== false && G && ST;

    if (config.lenis !== false && L && !lenis) {
      lenis = new L();
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
    }

    if (useGSAP && ST) {
      if (loco) {
        loco.on("scroll", ST.update);
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
        ST.addEventListener("refresh", () => loco.update());
        ST.refresh();
      } else if (lenis) {
        lenis.on("scroll", ST.update);
      }
    }

    if (renderer._rafId) {
      cancelAnimationFrame(renderer._rafId);
      renderer._rafId = null;
    }
    renderer.useExternalTicker = true;

    if (useGSAP) {
      G.ticker.add((time) => {
        if (lenis) lenis.raf(time * 1000);
        renderer.render();
      });
      G.ticker.lagSmoothing(0);
    } else {
      const loop = (time) => {
        if (lenis) lenis.raf(time);
        if (loco) loco.update();
        renderer.render();
        renderer._rafId = requestAnimationFrame(loop);
      };
      renderer._rafId = requestAnimationFrame(loop);
    }

    return { lenis, locomotiveScroll: loco };
  };
  return window.liquidGL;
})();

export default liquidGL;
