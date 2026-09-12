/*
 * liquidGL Helper – Dev/debug GUI for liquidGL
 * -----------------------------------------------------------------------------
 *
 * Author: NaughtyDuk© – https://liquidgl.naughtyduk.com
 * Licence: MIT
 * Version: v2.2.0
 */

(() => {
  "use strict";

  /* --------------------------------------------------
   *  Helper GUI System
   * ------------------------------------------------*/
  let helperGUIs = [];
  let lilGuiLoaded = false;
  let lilGuiLoadPromise = null;

  function loadLilGui() {
    if (lilGuiLoaded) {
      return Promise.resolve();
    }
    if (lilGuiLoadPromise) {
      return lilGuiLoadPromise;
    }

    lilGuiLoadPromise = new Promise((resolve, reject) => {
      if (typeof lil !== "undefined") {
        lilGuiLoaded = true;
        injectHelperStyles();
        resolve();
        return;
      }

      const script = document.createElement("script");
      script.src =
        "https://cdn.jsdelivr.net/npm/lil-gui@0.19.1/dist/lil-gui.umd.min.js";
      script.integrity =
        "sha384-2eNPNc7Cms+nVcpmQPotBpthLWCwjAGbkp0Y+3MUQqwPbmTpMFmbh2a230Gkns0x";
      script.crossOrigin = "anonymous";
      script.onload = () => {
        lilGuiLoaded = true;
        injectHelperStyles();
        resolve();
      };
      script.onerror = () => {
        reject(new Error("Failed to load lil-gui"));
      };
      document.head.appendChild(script);
    });

    return lilGuiLoadPromise;
  }

  function injectHelperStyles() {
    if (document.getElementById("liquidgl-helper-styles")) return;

    const style = document.createElement("style");
    style.id = "liquidgl-helper-styles";
    style.textContent = `
      @media screen and (max-width: 768px) {
        .lil-gui.root.liquidgl-helper {
          width: 61vw;
        }
      }

      .lil-gui.root.liquidgl-helper,
      .lil-gui.liquidgl-helper .lil-gui {
        --background-color: rgb(9 9 11 / 85%);
        --widget-color: rgb(39 39 42 / 50%);
        --hover-color: rgb(39 39 42 / 70%);
        --focus-color: rgb(39 39 42 / 90%);
        --number-color: #fafafa;
        --string-color: #fafafa;
        --font-size: 13px;
        --input-font-size: 13px;
        --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        --font-family-mono: monospace;
        --padding: 10px;
        --spacing: 10px;
        --widget-height: 28px;
        --title-height: 28px;
        --name-width: 45%;
        --slider-knob-width: 4px;
        --slider-input-width: 27%;
        --color-input-width: 27%;
        --slider-input-min-width: 45px;
        --color-input-min-width: 45px;
        --folder-indent: 8px;
        --widget-padding: 0 10px;
        --widget-border-radius: 4px;
        --checkbox-size: 16px;
        --scrollbar-width: 6px;
      }

      .lil-gui.root.liquidgl-helper {
        border-radius: 12px !important;
        border: 0.5px solid #1e1e20 !important;
        backdrop-filter: blur(16px);
        box-shadow: 0 4px 16px rgb(0 0 0 / 20%) !important;
        position: fixed !important;
        top: 1rem !important;
        right: 1rem !important;
        left: auto !important;
        z-index: 999999999 !important;
      }

      .lil-gui.liquidgl-helper .title {
        background: transparent;
        border-bottom: 0.5px solid #1e1e20;
        border-radius: 12px 12px 0 0 !important;
      }

      .lil-gui.liquidgl-helper .title button {
        padding: 12px 16px !important;
      }

      .lil-gui.liquidgl-helper.closed .title {
        border-radius: 12px !important;
        border-bottom: none;
      }

      .lil-gui.liquidgl-helper .children {
        border-top: 0.5px solid #1e1e20;
      }

      @media (max-width: 768px) {
        .lil-gui.root.liquidgl-helper {
          top: 1rem !important;
          right: 1rem !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function createHelperGUI(lenses, options, instanceIndex) {
    if (typeof lil === "undefined") return;

    const lensList = (Array.isArray(lenses) ? lenses : [lenses]).filter(
      Boolean,
    );
    if (!lensList.length) return;

    const gui = new lil.GUI({
      title: "liquidGL Helper",
      closeFolders: true,
    });
    gui.domElement.classList.add("liquidgl-helper");
    gui.$title.style.cursor = "default";

    const topOffset = 1 + instanceIndex * 3;
    gui.domElement.style.top = `${topOffset}rem`;

    const state = lensList[0].options;

    const applyToLenses = (key, value) => {
      lensList.forEach((ln) => {
        if (!ln) return;
        ln.options[key] = value;
        if (key === "shadow") ln.setShadow(value);
        if (key === "tilt") ln.setTilt(value);
      });
    };

    const refractionFolder = gui.addFolder("Refraction");
    refractionFolder
      .add(state, "refraction", 0, 0.1, 0.001)
      .name("Refraction")
      .onChange((v) => applyToLenses("refraction", v));
    refractionFolder
      .add(state, "aberration", 0, 1, 0.01)
      .name("Aberration")
      .onChange((v) => applyToLenses("aberration", v));
    refractionFolder
      .add(state, "bevelDepth", 0, 0.2, 0.001)
      .name("Bevel Depth")
      .onChange((v) => applyToLenses("bevelDepth", v));
    refractionFolder
      .add(state, "bevelWidth", 0, 0.5, 0.001)
      .name("Bevel Width")
      .onChange((v) => applyToLenses("bevelWidth", v));
    refractionFolder
      .add(state, "magnify", 1, 5, 0.1)
      .name("Magnify")
      .onChange((v) => applyToLenses("magnify", v));

    const surfaceFolder = gui.addFolder("Surface");
    surfaceFolder
      .add(state, "frost", 0, 10, 0.1)
      .name("Frost")
      .onChange((v) => applyToLenses("frost", v));
    surfaceFolder
      .add(state, "specular")
      .name("Specular")
      .onChange((v) => applyToLenses("specular", v));
    surfaceFolder
      .add(state, "shadow")
      .name("Shadow")
      .onChange((v) => applyToLenses("shadow", v));

    const tiltFolder = gui.addFolder("Tilt");
    tiltFolder
      .add(state, "tilt")
      .name("Tilt")
      .onChange((v) => applyToLenses("tilt", v));
    tiltFolder
      .add(state, "tiltFactor", 0, 25, 0.1)
      .name("Tilt Factor")
      .onChange((v) => applyToLenses("tiltFactor", v));
    tiltFolder
      .add(state, "tiltEase", 0, 1000, 10)
      .name("Tilt Ease")
      .onChange((v) => applyToLenses("tiltEase", v));

    const initFolder = gui.addFolder("Initialisation");
    const reinitState = {
      reveal: options.reveal,
      resolution: options.resolution,
    };

    initFolder
      .add(reinitState, "reveal", ["none", "fade"])
      .name("Reveal")
      .onFinishChange((value) => {
        if (
          confirm(
            "Changing reveal applies on the next initialisation. Continue?",
          )
        ) {
          applyToLenses("reveal", value);
        } else {
          reinitState.reveal = options.reveal;
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
        }
      });

    initFolder
      .add(reinitState, "resolution", 0.5, 3, 0.25)
      .name("Resolution")
      .onFinishChange((value) => {
        if (
          confirm(
            "Changing resolution re-captures the page snapshot. Continue?",
          )
        ) {
          applyToLenses("resolution", value);
          const renderer = window.__liquidGLRenderer__;
          if (renderer) {
            renderer._snapshotResolution = Math.max(0.1, Math.min(3.0, value));
            renderer.captureSnapshot();
          }
        } else {
          reinitState.resolution = options.resolution;
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
        }
      });

    const copyButton = {
      copySettings: () => {
        const code = generateInitCode(options);
        const controller = gui.controllers.find(
          (c) => c.property === "copySettings",
        );

        if (!controller) return;

        const originalName = controller._name;
        controller.disable();
        controller.name("✓ Copied");

        const copySuccess = () => {
          setTimeout(() => {
            controller.name(originalName);
            controller.enable();
          }, 1500);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard
            .writeText(code)
            .then(() => {
              copySuccess();
            })
            .catch((err) => {
              console.error("Clipboard error:", err);
              fallbackCopy(code);
            });
        } else {
          fallbackCopy(code);
        }

        function fallbackCopy(text) {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          try {
            document.execCommand("copy");
            copySuccess();
          } catch (err) {
            console.error("Copy failed:", err);
            controller.name(originalName);
            controller.enable();
            prompt("Copy this code manually:", text);
          }
          document.body.removeChild(textarea);
        }
      },
    };
    gui.add(copyButton, "copySettings").name("Copy settings");

    refractionFolder.close();
    surfaceFolder.close();
    tiltFolder.close();
    initFolder.close();

    helperGUIs.push({ gui, lenses: lensList });
    return gui;
  }

  function generateInitCode(options) {
    const lines = ["liquidGL({"];

    lines.push(`  target: "${options.target}",`);
    lines.push(`  snapshot: "${options.snapshot}",`);
    lines.push(`  resolution: ${options.resolution},`);
    lines.push(`  refraction: ${options.refraction},`);
    lines.push(`  aberration: ${options.aberration},`);
    lines.push(`  bevelDepth: ${options.bevelDepth},`);
    lines.push(`  bevelWidth: ${options.bevelWidth},`);
    lines.push(`  frost: ${options.frost},`);
    lines.push(`  shadow: ${options.shadow},`);
    lines.push(`  specular: ${options.specular},`);
    lines.push(`  reveal: "${options.reveal}",`);
    lines.push(`  tilt: ${options.tilt},`);
    lines.push(`  tiltFactor: ${options.tiltFactor},`);
    lines.push(`  tiltEase: ${options.tiltEase},`);
    lines.push(`  magnify: ${options.magnify},`);
    lines.push(`  helper: false,`);
    lines.push(`});`);

    return lines.join("\n");
  }

  /* --------------------------------------------------
   *  Registration
   * ------------------------------------------------*/
  window.__liquidGLHelper__ = (lenses, options) => {
    loadLilGui()
      .then(() => {
        const instanceIndex = helperGUIs.length;
        createHelperGUI(lenses, options, instanceIndex);
      })
      .catch((err) => {
        console.error("liquidGL: Failed to load helper GUI:", err);
      });
  };
})();
