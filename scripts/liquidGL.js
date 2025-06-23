/*
 * liquidGL – Ultra-light glassmorphism for the web
 * -----------------------------------------------------------------------------
 *
 * Author: NaughtyDuk© – https://liquidgl.naughtyduk.com
 * Licence: MIT
 */

(() => {
  "use strict";

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
   *  Shared renderer (one per page)
   * ------------------------------------------------*/
  class LiquidGLRenderer {
    constructor(snapshotSelector) {
      // Canvas that hosts the single WebGL context
      this.canvas = document.createElement("canvas");
      this.canvas.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2;`;
      document.body.appendChild(this.canvas);

      const ctxAttribs = { alpha: true, premultipliedAlpha: true };
      this.gl =
        this.canvas.getContext("webgl2", ctxAttribs) ||
        this.canvas.getContext("webgl", ctxAttribs) ||
        this.canvas.getContext("experimental-webgl", ctxAttribs);
      if (!this.gl) throw new Error("LiquidGL: WebGL unavailable");

      this.lenses = [];
      this.texture = null;
      this.textureWidth = 0;
      this.textureHeight = 0;
      this.scaleFactor = 1;
      this.startTime = Date.now();

      this._initGL();

      this.snapshotTarget =
        document.querySelector(snapshotSelector) || document.body;
      if (!this.snapshotTarget) this.snapshotTarget = document.body;

      const onResize = debounce(() => {
        if (window.visualViewport && window.visualViewport.scale !== 1) {
          return;
        }

        this._resizeCanvas();
        this.lenses.forEach((l) => l.updateMetrics());
        this.captureSnapshot();
      }, 250);
      window.addEventListener("resize", onResize, { passive: true });

      if ("ResizeObserver" in window) {
        new ResizeObserver(onResize).observe(this.snapshotTarget);
      }

      this._resizeCanvas();
      this.captureSnapshot();

      this._pendingReveal = [];

      this.canvas.style.opacity = "0";
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
        precision mediump float;
        varying vec2 v_uv;
        uniform sampler2D u_tex;
        uniform vec2  u_resolution;
        uniform vec4  u_bounds;    // xy = origin, zw = scale in UV
        uniform float u_refraction;
        uniform float u_bevelDepth;
        uniform float u_bevelWidth;
        uniform float u_frost;
        uniform float u_radius;
        uniform float u_time;
        uniform bool  u_specular;
        uniform float u_revealProgress;
        uniform int   u_revealType;

        float udRoundBox( vec2 p, vec2 b, float r ) {
          return length(max(abs(p)-b+r,0.0))-r;
        }
        float edgeFactor(vec2 uv, float radius_px){
          vec2 p_px = (uv - 0.5) * u_resolution;
          vec2 b_px = 0.5 * u_resolution;
          float d = -udRoundBox(p_px, b_px, radius_px);
          float bevel_px = u_bevelWidth * min(u_resolution.x, u_resolution.y);
          return 1.0 - smoothstep(0.0, bevel_px, d);
        }
        void main(){
          vec2 delta = v_uv - 0.5;
          delta.x *= u_resolution.x / u_resolution.y;
          vec2 dir = normalize(delta);
          if (length(delta) == 0.0) dir = vec2(0.0);

          float edge = edgeFactor(v_uv, u_radius);
          float offsetAmt = edge * u_refraction + pow(edge, 10.0) * u_bevelDepth;
          float centreBlend = smoothstep(0.15, 0.45, length(delta));
          vec2 offset = dir * offsetAmt * centreBlend;

          vec2 flippedUV = vec2(v_uv.x, 1.0 - v_uv.y);
          vec2 mapped = u_bounds.xy + flippedUV * u_bounds.zw;
          vec2 refracted = mapped + offset;

          float oob = max(max(-refracted.x, refracted.x - 1.0), max(-refracted.y, refracted.y - 1.0));
          float blend = 1.0 - smoothstep(0.0, 0.01, oob);
          vec2 sampleUV = mix(mapped, refracted, blend);

          vec4 baseCol   = texture2D(u_tex, mapped);      // no refraction
          vec4 refrCol   = texture2D(u_tex, sampleUV);    // with refraction

          // How different are they?  0 = identical, 1 = extreme difference
          float diff = clamp(length(refrCol.rgb - baseCol.rgb) * 4.0, 0.0, 1.0);

          // Blend factor grows only when colours diverge AND we're near the centre
          //    ( we gate it with the same centreBlend already used for offset )
          float antiHalo = (1.0 - centreBlend) * diff;    // 0–15 % radius = 0, fades in by 45 %

          vec4 final    = mix(refrCol, baseCol, antiHalo);

          // Mask pixels outside rounded rect when using global canvas
          vec2 p_px = (v_uv - 0.5) * u_resolution;
          vec2 b_px = 0.5 * u_resolution;
          float dmask = udRoundBox(p_px, b_px, u_radius);
          float inShape = 1.0 - step(0.0, dmask); // 1 inside, 0 outside

          if (u_specular) {
            vec2 lp1 = vec2(sin(u_time*0.2), cos(u_time*0.3))*0.6 + 0.5;
            vec2 lp2 = vec2(sin(u_time*-0.4+1.5), cos(u_time*0.25-0.5))*0.6 + 0.5;
            float h = 0.0;
            h += smoothstep(0.4,0.0,distance(v_uv, lp1))*0.1;
            h += smoothstep(0.5,0.0,distance(v_uv, lp2))*0.08;
            final.rgb += h;
          }

          // Apply reveal fade if requested (same logic as single-lens build)
          if (u_revealType == 1) { // fade
              final.rgb *= u_revealProgress;
              final.a  *= u_revealProgress;
          }

          // Apply rounded-rect mask
          final.rgb *= inShape;
          final.a   *= inShape;

          gl_FragColor = final;
        }`;

      this.program = createProgram(this.gl, vsSource, fsSource);
      const gl = this.gl;
      if (!this.program) throw new Error("LiquidGL: Shader failed");

      const posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW
      );

      const posLoc = gl.getAttribLocation(this.program, "a_position");
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      // Cache uniform locations
      this.u = {
        tex: gl.getUniformLocation(this.program, "u_tex"),
        res: gl.getUniformLocation(this.program, "u_resolution"),
        bounds: gl.getUniformLocation(this.program, "u_bounds"),
        refraction: gl.getUniformLocation(this.program, "u_refraction"),
        bevelDepth: gl.getUniformLocation(this.program, "u_bevelDepth"),
        bevelWidth: gl.getUniformLocation(this.program, "u_bevelWidth"),
        frost: gl.getUniformLocation(this.program, "u_frost"),
        radius: gl.getUniformLocation(this.program, "u_radius"),
        time: gl.getUniformLocation(this.program, "u_time"),
        specular: gl.getUniformLocation(this.program, "u_specular"),
        revealProgress: gl.getUniformLocation(this.program, "u_revealProgress"),
        revealType: gl.getUniformLocation(this.program, "u_revealType"),
      };
    }

    /* ----------------------------- */
    _resizeCanvas() {
      const dpr = Math.min(1, window.devicePixelRatio || 1);
      this.canvas.width = innerWidth * dpr;
      this.canvas.height = innerHeight * dpr;
      this.canvas.style.width = `${innerWidth}px`;
      this.canvas.style.height = `${innerHeight}px`;
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    /* ----------------------------- */
    async captureSnapshot() {
      if (this._capturing || typeof html2canvas === "undefined") return;
      this._capturing = true;
      const ignoreAttr = "data-liquid-ignore";

      this.canvas.style.visibility = "hidden";
      this.lenses.forEach((ln) => ln.el.setAttribute(ignoreAttr, ""));

      try {
        const fullW = this.snapshotTarget.scrollWidth;
        const fullH = this.snapshotTarget.scrollHeight;
        const maxTex = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) || 8192;
        let scale = Math.min(1, maxTex / fullW, maxTex / fullH);
        if (scale > 0.5) scale = 0.5;
        this.scaleFactor = scale;

        const isXOrigin = (src) => {
          try {
            const u = new URL(src, document.baseURI);
            return u.origin !== location.origin;
          } catch {
            return false;
          }
        };

        const h2cOpts = {
          allowTaint: false,
          useCORS: true,
          backgroundColor: null,
          removeContainer: true,
          width: fullW,
          height: fullH,
          scrollX: 0,
          scrollY: 0,
          scale: scale,
          ignoreElements: (el) => {
            if (el.hasAttribute(ignoreAttr)) return true;
            if (el.tagName === "CANVAS") return true;
            if (el.tagName === "IMG" && isXOrigin(el.src)) return true;
            return false;
          },
        };
        const snapCanvas = await html2canvas(this.snapshotTarget, h2cOpts);
        this._uploadTexture(snapCanvas);
      } catch (e) {
        console.error("LiquidGL snapshot failed", e);
      } finally {
        this.canvas.style.visibility = "visible";
        this.lenses.forEach((ln) => ln.el.removeAttribute(ignoreAttr));
        this._capturing = false;
      }
    }

    /* ----------------------------- */
    _uploadTexture(srcCanvas) {
      if (!srcCanvas) return;
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
        srcCanvas
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this.textureWidth = srcCanvas.width;
      this.textureHeight = srcCanvas.height;

      this.render();

      if (this._pendingReveal.length) {
        this._pendingReveal.forEach((ln) => ln._reveal());
        this._pendingReveal.length = 0;
      }
    }

    /* ----------------------------- */
    addLens(element, options) {
      const lens = new LiquidGLLens(this, element, options);
      this.lenses.push(lens);
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

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(this.u.tex, 0);

      const time = (Date.now() - this.startTime) / 1000;
      gl.uniform1f(this.u.time, time);

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

      const dpr = Math.min(1, window.devicePixelRatio || 1);
      this.lenses.forEach((ln) => {
        if (ln._mirrorActive && ln.rectPx) {
          const { left, top, width, height } = ln.rectPx;
          const expand = 2;
          const x = Math.max(0, Math.round(left * dpr) - expand);
          const y = Math.max(
            0,
            Math.round(this.canvas.height - (top + height) * dpr) - expand
          );
          const w = Math.min(
            this.canvas.width - x,
            Math.round(width * dpr) + expand * 2
          );
          const h = Math.min(
            this.canvas.height - y,
            Math.round(height * dpr) + expand * 2
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

      const dpr = Math.min(1, window.devicePixelRatio || 1);
      const x = rect.left * dpr;
      const y = this.canvas.height - (rect.top + rect.height) * dpr;
      const w = rect.width * dpr;
      const h = rect.height * dpr;
      if (w <= 0 || h <= 0) return;

      gl.viewport(x, y, w, h);
      gl.uniform2f(this.u.res, w, h);

      const docX = rect.left - this.snapshotTarget.getBoundingClientRect().left;
      const docY = rect.top - this.snapshotTarget.getBoundingClientRect().top;
      const leftUV = (docX * this.scaleFactor) / this.textureWidth;
      const topUV = (docY * this.scaleFactor) / this.textureHeight;
      const wUV = (rect.width * this.scaleFactor) / this.textureWidth;
      const hUV = (rect.height * this.scaleFactor) / this.textureHeight;
      gl.uniform4f(this.u.bounds, leftUV, topUV, wUV, hUV);

      gl.uniform1f(this.u.refraction, lens.options.refraction);
      gl.uniform1f(this.u.bevelDepth, lens.options.bevelDepth);
      gl.uniform1f(this.u.bevelWidth, lens.options.bevelWidth);
      gl.uniform1f(this.u.frost, lens.options.frost);
      gl.uniform1f(this.u.radius, lens.radiusPx);
      gl.uniform1i(this.u.specular, lens.options.specular ? 1 : 0);
      gl.uniform1f(this.u.revealProgress, lens._revealProgress || 1.0);
      gl.uniform1i(this.u.revealType, lens.revealTypeIndex || 0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  /* --------------------------------------------------
   *  Per-element lens wrapper
   * ------------------------------------------------*/
  class LiquidGLLens {
    constructor(renderer, element, options) {
      this.renderer = renderer;
      this.el = element;
      this.options = options;
      this.rectPx = null;
      this.radiusPx = 0;
      this.revealTypeIndex = this.options.reveal === "fade" ? 1 : 0;
      this._revealProgress = this.revealTypeIndex === 0 ? 1 : 0;

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
      const rect = this.el.getBoundingClientRect();
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
      const dpr = Math.min(1, window.devicePixelRatio || 1);
      const maxAllowed = Math.min(rect.width, rect.height) * dpr * 0.5;
      this.radiusPx = Math.min(brPx * dpr, maxAllowed);

      if (this._shadowSyncFn) {
        this._shadowSyncFn();
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
        const r = this.el.getBoundingClientRect();
        this._shadowEl.style.left = `${r.left}px`;
        this._shadowEl.style.top = `${r.top}px`;
        this._shadowEl.style.width = `${r.width}px`;
        this._shadowEl.style.height = `${r.height}px`;
        this._shadowEl.style.borderRadius = `${this.radiusPx}px`;
      };

      if (enabled) {
        this.el.style.boxShadow = SHADOW_VAL;

        if (!this._shadowEl) {
          this._shadowEl = document.createElement("div");
          Object.assign(this._shadowEl.style, {
            position: "fixed",
            pointerEvents: "none",
            zIndex: parseInt(this.renderer.canvas.style.zIndex || 2) - 1 || 1,
            boxShadow: SHADOW_VAL,
            willChange: "transform, width, height",
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
        this._revealProgress = 1;
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
          if (ln._bgColorComponents) {
            const { r, g, b, a } = ln._bgColorComponents;
            ln.el.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${
              a * progress
            })`;
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
          });
        }
      };

      requestAnimationFrame(animate);
    }

    /* ----------------------------- */

    _bindTiltHandlers() {
      if (this._tiltHandlersBound) return;

      const getMaxTilt = () =>
        Number.isFinite(this.options.tiltFactor) ? this.options.tiltFactor : 5;

      const applyTilt = (clientX, clientY) => {
        if (!this._tiltInteracting) {
          this._tiltInteracting = true;
          this.el.style.transition =
            "transform 0.12s cubic-bezier(0.33,1,0.68,1)";
          this._createMirrorCanvas();
          if (this._mirror) {
            this._mirror.style.transition =
              "transform 0.12s cubic-bezier(0.33,1,0.68,1)";
          }
          if (this._shadowEl) {
            this._shadowEl.style.transition =
              "transform 0.12s cubic-bezier(0.33,1,0.68,1)";
          }
        }
        const rect = this.el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        this._pivotOrigin = `${cx}px ${cy}px`;

        const pctX = (clientX - cx) / (rect.width / 2);
        const pctY = (clientY - cy) / (rect.height / 2);
        const maxTilt = getMaxTilt();
        const rotY = pctX * maxTilt;
        const rotX = -pctY * maxTilt;
        const transformStr = `perspective(800px) rotateX(${rotX}deg) rotateY(${rotY}deg)`;

        this.el.style.transform = transformStr;

        if (this._mirror) {
          this._mirror.style.transformOrigin = this._pivotOrigin;
          this._mirror.style.transform = transformStr;
        }

        if (this._shadowEl) {
          this._shadowEl.style.transformOrigin = "50% 50%";
          this._shadowEl.style.transform = transformStr;
        }

        this.renderer.render();
      };

      this._onMouseEnter = () => {
        this._tiltInteracting = false;
        this._createMirrorCanvas();
      };
      this._onMouseMove = (e) => applyTilt(e.clientX, e.clientY);
      const smoothReset = () => {
        this.el.style.transition = "transform 0.4s cubic-bezier(0.33,1,0.68,1)";
        this.el.style.transform =
          "perspective(800px) rotateX(0deg) rotateY(0deg)";
        if (this._mirror) {
          this._mirror.style.transition =
            "transform 0.4s cubic-bezier(0.33, 1, 0.68, 1)";
          this._mirror.style.transformOrigin = this._pivotOrigin || "50% 50%";
          this._mirror.style.transform =
            "perspective(800px) rotateX(0deg) rotateY(0deg)";
          const clean = () => this._destroyMirrorCanvas();
          this._mirror.addEventListener("transitionend", clean, {
            once: true,
          });
          setTimeout(clean, 350);
        }

        if (this._shadowEl) {
          this._shadowEl.style.transition =
            "transform 0.4s cubic-bezier(0.33,1,0.68,1)";
          this._shadowEl.style.transformOrigin = "50% 50%";
          this._shadowEl.style.transform =
            "perspective(800px) rotateX(0deg) rotateY(0deg)";
        }
      };
      this._onMouseLeave = () => {
        smoothReset();
      };

      this._onTouchStart = (e) => {
        this._tiltInteracting = false;
        this._createMirrorCanvas();
        if (e.touches && e.touches.length === 1) {
          const t = e.touches[0];
          applyTilt(t.clientX, t.clientY);
        }
      };
      this._onTouchMove = (e) => {
        if (e.touches && e.touches.length === 1) {
          const t = e.touches[0];
          applyTilt(t.clientX, t.clientY);
        }
      };
      this._onTouchEnd = () => {
        smoothReset();
      };

      this.el.addEventListener("mouseenter", this._onMouseEnter, {
        passive: true,
      });
      this.el.addEventListener("mousemove", this._onMouseMove, {
        passive: true,
      });
      this.el.addEventListener("mouseleave", this._onMouseLeave, {
        passive: true,
      });
      this.el.addEventListener("touchstart", this._onTouchStart, {
        passive: true,
      });
      this.el.addEventListener("touchmove", this._onTouchMove, {
        passive: true,
      });
      this.el.addEventListener("touchend", this._onTouchEnd, {
        passive: true,
      });

      this._tiltHandlersBound = true;
    }

    _unbindTiltHandlers() {
      if (!this._tiltHandlersBound) return;
      this.el.removeEventListener("mouseenter", this._onMouseEnter);
      this.el.removeEventListener("mousemove", this._onMouseMove);
      this.el.removeEventListener("mouseleave", this._onMouseLeave);
      this.el.removeEventListener("touchstart", this._onTouchStart);
      this.el.removeEventListener("touchmove", this._onTouchMove);
      this.el.removeEventListener("touchend", this._onTouchEnd);
      this._tiltHandlersBound = false;
      this.el.style.transform = "";
      this.renderer.render();
    }

    _createMirrorCanvas() {
      if (this._mirror) return;
      this._mirror = document.createElement("canvas");
      Object.assign(this._mirror.style, {
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: parseInt(this.renderer.canvas.style.zIndex || 2) + 1,
        willChange: "transform",
      });
      this._mirrorCtx = this._mirror.getContext("2d");
      document.body.appendChild(this._mirror);

      const updateClip = () => {
        const r = this.el.getBoundingClientRect();
        const radius = `${this.radiusPx}px`;
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

      this._mirrorActive = false;
    }
  }

  /* --------------------------------------------------
   *  Public API
   * ------------------------------------------------*/
  window.LiquidGL = function (userOptions = {}) {
    const defaults = {
      target: ".menu-wrap",
      snapshot: "body",
      refraction: 0.01,
      bevelDepth: 0.08,
      bevelWidth: 0.15,
      frost: 0,
      shadow: true,
      specular: true,
      reveal: "fade",
      tilt: false,
      tiltFactor: 5,
    };
    const options = { ...defaults, ...userOptions };

    if (typeof window.__LiquidGLNoWebGL__ === "undefined") {
      const testCanvas = document.createElement("canvas");
      const testCtx =
        testCanvas.getContext("webgl2") ||
        testCanvas.getContext("webgl") ||
        testCanvas.getContext("experimental-webgl");
      window.__LiquidGLNoWebGL__ = !testCtx;
    }

    const noWebGL = window.__LiquidGLNoWebGL__;

    if (noWebGL) {
      console.warn(
        "LiquidGL: WebGL not available – falling back to CSS backdrop-filter."
      );
      const fallbackNodes = document.querySelectorAll(options.target);
      return fallbackNodes.length === 1
        ? fallbackNodes[0]
        : Array.from(fallbackNodes);
    }

    let renderer = window.__LiquidGLRenderer__;
    if (!renderer) {
      renderer = new LiquidGLRenderer(options.snapshot);
      window.__LiquidGLRenderer__ = renderer;
    }

    const nodeList = document.querySelectorAll(options.target);
    if (!nodeList || nodeList.length === 0) {
      console.warn(
        `LiquidGL: Target element(s) '${options.target}' not found.`
      );
      return;
    }

    const instances = Array.from(nodeList).map((el) =>
      renderer.addLens(el, options)
    );

    if (!renderer._rafId) {
      const loop = () => {
        renderer.render();
        renderer._rafId = requestAnimationFrame(loop);
      };
      renderer._rafId = requestAnimationFrame(loop);
    }

    return instances.length === 1 ? instances[0] : instances;
  };
})();
