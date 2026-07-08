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
   *  Shared renderer (one per page)
   * ------------------------------------------------*/
  class liquidGLRenderer {
    constructor(snapshotSelector, snapshotResolution = 1.0) {
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
      }, 250);
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

      this._resizeCanvas();
      this.captureSnapshot();

      this._pendingReveal = [];

      /* --------------------------------------------------
       *  Dynamic media (video) support
       * ------------------------------------------------*/
      this._videoNodes = Array.from(
        this.snapshotTarget.querySelectorAll("video")
      );
      this._videoNodes = this._videoNodes.filter((v) => !this._isIgnored(v));
      this._tmpCanvas = document.createElement("canvas");
      this._tmpCtx = this._tmpCanvas.getContext("2d");

      this.canvas.style.opacity = "0";

      this._snapshotResolution = Math.max(
        0.1,
        Math.min(3.0, snapshotResolution)
      );

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
            bmp
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
        precision mediump float;
        varying vec2 v_uv;
        uniform sampler2D u_tex;
        uniform vec2  u_resolution;
        uniform vec2  u_textureResolution;
        uniform vec4  u_bounds;
        uniform float u_refraction;
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

        float udRoundBox( vec2 p, vec2 b, float r ) {
          return length(max(abs(p)-b+r,0.0))-r;
        }

        float random(vec2 st) {
          return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
        }

        float edgeFactor(vec2 uv, float radius_px){
          vec2 p_px = (uv - 0.5) * u_resolution;
          vec2 b_px = 0.5 * u_resolution;
          float d = -udRoundBox(p_px, b_px, radius_px);
          float bevel_px = u_bevelWidth * min(u_resolution.x, u_resolution.y);
          return 1.0 - smoothstep(0.0, bevel_px, d);
        }
        void main(){
          vec2 p = v_uv - 0.5;
          p.x *= u_resolution.x / u_resolution.y;

          float edge = edgeFactor(v_uv, u_radius);
          float min_dimension = min(u_resolution.x, u_resolution.y);
          float offsetAmt = (edge * u_refraction + pow(edge, 10.0) * u_bevelDepth);
          float centreBlend = smoothstep(0.15, 0.45, length(p));
          vec2 offset = normalize(p) * offsetAmt * centreBlend;

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

          if (refrCol.a < 0.1) {
              refrCol = baseCol;
          }

          float diff = clamp(length(refrCol.rgb - baseCol.rgb) * 4.0, 0.0, 1.0);

          float antiHalo = (1.0 - centreBlend) * diff;

          vec4 final    = refrCol;

          vec2 p_px = (v_uv - 0.5) * u_resolution;
          vec2 b_px = 0.5 * u_resolution;
          float dmask = udRoundBox(p_px, b_px, u_radius);
          float inShape = 1.0 - step(0.0, dmask);

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
        gl.STATIC_DRAW
      );

      const posLoc = gl.getAttribLocation(this.program, "a_position");
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      this.u = {
        tex: gl.getUniformLocation(this.program, "u_tex"),
        res: gl.getUniformLocation(this.program, "u_resolution"),
        textureResolution: gl.getUniformLocation(
          this.program,
          "u_textureResolution"
        ),
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
        tiltX: gl.getUniformLocation(this.program, "u_tiltX"),
        tiltY: gl.getUniformLocation(this.program, "u_tiltY"),
        magnify: gl.getUniformLocation(this.program, "u_magnify"),
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
      if (this._capturing || typeof html2canvas === "undefined") return;
      this._capturing = true;

      const undos = [];

      const attemptCapture = async (
        attempt = 1,
        maxAttempts = 3,
        delayMs = 500
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
            maxTex / fullH
          );

          if (isMobileSafari) {
            const over = (Math.max(fullW, fullH) * scale) / MAX_MOBILE_DIM;
            if (over > 1) scale = scale / over;
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

          const snapCanvas = await html2canvas(this.snapshotTarget, {
            allowTaint: false,
            useCORS: true,
            backgroundColor: null,
            removeContainer: true,
            width: fullW,
            height: fullH,
            scrollX: 0,
            scrollY: 0,
            scale: scale,
            ignoreElements: ignoreElementsFunc,
            onclone: (clonedDoc) => {
              clonedDoc
                .querySelectorAll("[data-liquidgl-hide]")
                .forEach((el) => {
                  el.style.visibility = "hidden";
                });
            },
          });

          this._uploadTexture(snapCanvas);
          return true;
        } catch (e) {
          console.error("liquidGL snapshot failed on attempt " + attempt, e);
          if (attempt < maxAttempts) {
            console.log(
              `Retrying snapshot capture (${attempt + 1}/${maxAttempts})...`
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
      if (!srcCanvas) return;

      if (!(srcCanvas instanceof HTMLCanvasElement)) {
        const tmp = document.createElement("canvas");
        tmp.width = srcCanvas.width || 0;
        tmp.height = srcCanvas.height || 0;
        if (tmp.width === 0 || tmp.height === 0) return;
        try {
          const ctx = tmp.getContext("2d");
          ctx.drawImage(srcCanvas, 0, 0);
          srcCanvas = tmp;
        } catch (e) {
          console.warn(
            "liquidGL: Unable to convert OffscreenCanvas for upload",
            e
          );
          return;
        }
      }

      if (srcCanvas.width === 0 || srcCanvas.height === 0) return;
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

      const dpr = Math.min(2, window.devicePixelRatio || 1);

      let overscrollY = 0;
      let overscrollX = 0;

      if (window.visualViewport) {
        overscrollX = window.visualViewport.offsetLeft;
        overscrollY = window.visualViewport.offsetTop;
      }

      const x = (rect.left + overscrollX) * dpr;
      const y =
        this.canvas.height - (rect.top + overscrollY + rect.height) * dpr;
      const w = rect.width * dpr;
      const h = rect.height * dpr;

      gl.viewport(x, y, w, h);
      gl.uniform2f(this.u.res, w, h);

      const docX = rect.left - this.snapshotTarget.getBoundingClientRect().left;
      const docY = rect.top - this.snapshotTarget.getBoundingClientRect().top;
      const leftUV = (docX * this.scaleFactor) / this.textureWidth;
      const topUV = (docY * this.scaleFactor) / this.textureHeight;
      const wUV = (rect.width * this.scaleFactor) / this.textureWidth;
      const hUV = (rect.height * this.scaleFactor) / this.textureHeight;
      gl.uniform4f(this.u.bounds, leftUV, topUV, wUV, hUV);

      gl.uniform2f(
        this.u.textureResolution,
        this.textureWidth,
        this.textureHeight
      );
      gl.uniform1f(this.u.refraction, lens.options.refraction);
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
          lens.options.magnify !== undefined ? lens.options.magnify : 1.0
        )
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

          const style = window.getComputedStyle(vid);
          const scaledRadii = {
            tl: parseFloat(style.borderTopLeftRadius) * this.scaleFactor,
            tr: parseFloat(style.borderTopRightRadius) * this.scaleFactor,
            br: parseFloat(style.borderBottomRightRadius) * this.scaleFactor,
            bl: parseFloat(style.borderBottomLeftRadius) * this.scaleFactor,
          };

          if (Object.values(scaledRadii).some((r) => r > 0)) {
            this._createRoundedRectPath(
              this._tmpCtx,
              drawW,
              drawH,
              scaledRadii
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
            drawH
          );

          this._tmpCtx.drawImage(vid, 0, 0, drawW, drawH);
          this._tmpCtx.restore();
        } catch (e) {
          console.warn("liquidGL: Error drawing video frame", e);
          return;
        }

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

        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          dstX,
          dstY,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          this._tmpCanvas
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
              hInComposite
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

          html2canvas(el, {
            backgroundColor: null,
            scale: this.scaleFactor,
            useCORS: true,
            removeContainer: true,
            logging: false,
            ignoreElements: (n) =>
              n.tagName === "CANVAS" || n.hasAttribute("data-liquid-ignore"),
          })
            .then((cv) => {
              if (cv.width > 0 && cv.height > 0) {
                meta.lastCapture = cv;
                meta.needsRecapture = false;
              }
            })
            .catch((e) => {
              console.error("liquidGL: Dynamic element capture failed.", e);
            })
            .finally(() => {
              meta._capturing = false;
            });
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
                h
              );
              gl.bindTexture(gl.TEXTURE_2D, this.texture);
              gl.texSubImage2D(
                gl.TEXTURE_2D,
                0,
                x,
                y,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                eraseCanvas
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
            drawH
          );
          compositeVideos(this._compositeCtx, rect);

          const style = window.getComputedStyle(el);
          this._compositeCtx.save();
          this._compositeCtx.translate(drawW / 2, drawH / 2);
          if (style.transform !== "none") {
            this._compositeCtx.transform(
              ...this._parseTransform(style.transform)
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
            compositeCanvas
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
                updH
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
                [snapBmp, dynBmp]
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
                this._dynamicStyleSheet.cssRules.length
              );
              m.hoverClassName = className;
              el.classList.add(className);
            } catch (e) {
              console.error("liquidGL: Failed to insert hover style rule.", e);
            }
          }
          setDirty();
        },
        { passive: true }
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
            ts - meta._lastCaptureTs > 33
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
        { passive: true }
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
        { passive: true }
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

      if (window.visualViewport) {
        overscrollX = -window.visualViewport.offsetLeft;
        overscrollY = -window.visualViewport.offsetTop;
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

      this._applyTilt = (clientX, clientY) => {
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

        const r = this._baseRect || this.el.getBoundingClientRect();
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

        this.tiltX = rotX;
        this.tiltY = rotY;

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

      this._smoothReset = () => {
        this.el.style.transition = "transform 0.4s cubic-bezier(0.33,1,0.68,1)";
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

        this.tiltX = 0;
        this.tiltY = 0;
        this.renderer.render();

        if (this._mirror) {
          this._mirror.style.transition =
            "transform 0.4s cubic-bezier(0.33, 1, 0.68, 1)";
          this._mirror.style.transformOrigin = this._pivotOrigin || "50% 50%";
          this._mirror.style.transform = `${baseRest}perspective(800px) rotateX(0deg) rotateY(0deg)`;
          const clean = () => {
            this._destroyMirrorCanvas();
            this._resetCleanupTimer = null;
          };
          this._mirror.addEventListener("transitionend", clean, {
            once: true,
          });
          this._resetCleanupTimer = setTimeout(clean, 350);
        }

        if (this._shadowEl) {
          this._shadowEl.style.transition =
            "transform 0.4s cubic-bezier(0.33,1,0.68,1)";
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

        const r = this._baseRect || this.el.getBoundingClientRect();
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

    _createMirrorCanvas() {
      this._baseRect = this.el.getBoundingClientRect();
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
          this._baseRect = this._baseRect || this.el.getBoundingClientRect();
        }
        const r = this._baseRect || this.el.getBoundingClientRect();
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
      bevelDepth: 0.08,
      bevelWidth: 0.15,
      frost: 0,
      shadow: true,
      specular: true,
      reveal: "fade",
      tilt: false,
      tiltFactor: 5,
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
        "liquidGL: WebGL not available – falling back to CSS backdrop-filter."
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
        `liquidGL: Target element(s) '${options.target}' not found.`
      );
      return;
    }

    const instances = Array.from(nodeList).map((el) =>
      renderer.addLens(el, options)
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
        "liquidGL: Please initialize liquidGL *before* calling syncWith()."
      );
      return;
    }

    const G = window.gsap;
    const L = window.Lenis;
    const LS = window.LocomotiveScroll;
    const ST = G ? G.ScrollTrigger : null;

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
})();
