# liquidGL – Liquid Glass Library - WebGPU/WebGL

<a href="https://liquidgl.naughtyduk.com"><img src="/assets/images/liquidGL-readme.gif" alt="liquidGL" width="100%" height="auto"/></a>

### v3.0.0

> [!NOTE]
> `liquidGL` is now available on npm: `npm install liquid-gl`. The `package/` directory contains the [npm package](https://www.npmjs.com/package/liquid-gl) source code, and is not required when using the CDN/browser script.

`liquidGL` turns any fixed or sticky-positioned element into a perfectly refracted, glossy "glass pane" rendered in WebGPU (with automatic fallback to WebGL).

<a href="https://liquidgl.naughtyduk.com" target="_blank" rel="noopener noreferrer"><img src="/assets/images/try-it-out-npm.png" alt="Try it out" height="48"/></a>&nbsp;&nbsp;&nbsp;<a href="https://buy.stripe.com/6oU3cv6oq9cjeZW3tj9sk0f" target="_blank" rel="noopener noreferrer"><img src="/assets/images/support-open-source-readme.png" alt="Support open-source" height="48"/></a>

<a href="https://liquidgl.naughtyduk.com/demos/audio-player.html" target="_blank" rel="noopener noreferrer"><strong>Audio Player</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/menu-bar.html" target="_blank" rel="noopener noreferrer"><strong>Menu Bar</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/ai-search.html" target="_blank" rel="noopener noreferrer"><strong>AI Search</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/multiple-lenses.html" target="_blank" rel="noopener noreferrer"><strong>Multiple Lenses</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/chromatic-aberration.html" target="_blank" rel="noopener noreferrer"><strong>Chromatic Aberration</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/fluid-interaction.html" target="_blank" rel="noopener noreferrer"><strong>Fluid Interaction</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/frost-specular.html" target="_blank" rel="noopener noreferrer"><strong>Frost & Specular</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/tinted-glass.html" target="_blank" rel="noopener noreferrer"><strong>Tinted Glass</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/stacked-lenses.html" target="_blank" rel="noopener noreferrer"><strong>Stacked Lenses</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/true-refraction.html" target="_blank" rel="noopener noreferrer"><strong>True Refraction</strong></a>

---

## What's New

- **Tinted Glass** — the new `tint` option dyes the pane with any CSS colour, using the colour's alpha as the dye strength: `tint: "rgba(8, 10, 20, 0.25)"` gives a dark-glass look, `tint: "rgba(70, 50, 180, 0.35)"` a coloured one. Specular highlights stay clean white on top of the dye. Adjustable per lens at runtime with `lens.setTint("…")`, and honoured by every backend — WebGPU, WebGL and the CSS fallback.

- **Fluid Interaction** — set `interaction: "fluid"` for a viscous, touch-aware surface that displaces and follows the cursor or finger in real time. Tune the effect with `interactionStrength`, `interactionRadius` and `interactionViscosity`.

- **Chromatic Aberration** — the new `aberration` option disperses the red and blue channels either side of the refraction vector, blue displaced further than red, matching the way real glass disperses shorter wavelengths more strongly. Dispersion scales with the refraction offset, so it concentrates at the bevelled edge and vanishes at the flat centre. Defaults to `0` (off).

- **Stacked Lenses** — lenses can now render on top of one another's refracted output, so a lens's glass can itself be refracted by another lens above it. Control stacking order with `zIndex`.

- **Multiple Lenses** — any number of lenses can share a page, each with its own options, all drawn through a single shared canvas for performance.

- **WebGPU** — `liquidGL` now renders with WebGPU where available, with an automatic fallback chain of WebGPU → WebGL2 → WebGL1 → CSS `backdrop-filter`. Nothing to configure, the chain is fully automatic. Choose where the chain starts with the new `engine` option (`'auto'`, `'webgpu'`, `'webgl2'`, `'webgl'`), or test quickly via the URL parameter `?liquidGL-engine=webgl2`.

- **Draggable Lenses** — set `draggable: true` to let users pick up and move a lens with mouse or touch. Fires `on.dragstart`, `on.drag` and `on.dragend` callbacks, and can be toggled at runtime with `lens.setDraggable()`.

- **zIndex Support** — the new `zIndex` option gives explicit control over a lens's stacking position, used to order stacked/multiple lenses and their shadow/tilt layers. Defaults to the element's own effective z-index.

- **Per-lens Destroy Method** — each lens instance now exposes `lens.destroy()`, tearing down just that lens (styles, listeners and GPU resources) without affecting other lenses sharing the same canvas.

---

<a href="https://liquidgl.naughtyduk.com"><img src="/assets/images/liquidGL-carousel-readme.gif" alt="liquidGL examples" width="100%" height="auto"/></a>

---

## Overview

`liquidGL` recreates Apple's "Liquid Glass" aesthetic in the browser with an ultra-light WebGPU/WebGL shader. It turns any DOM element into a beautiful, refracting glass pane. To overcome WebGL's security limitations on reading live screen pixels, `liquidGL` uses an innovative offscreen rendering technique. This allows it to refract dynamic content like videos, text animations, and more in real-time, delivering a smooth and interactive experience.

### Key Features

| Feature                                | Supported | Feature                   | Supported |
| :------------------------------------- | :-------: | :------------------------ | :-------: |
| WebGPU Rendering                       |    ✅     | Multiple & Stacked Lenses |    ✅     |
| Real-time Refraction (static content)  |    ✅     | Magnification Control     |    ✅     |
| Real-time Refraction (video)           |    ✅     | Dynamic Element Support   |    ✅     |
| Real-time Refraction (text animations) |    ✅     | GSAP-Ready Animations     |    ✅     |
| Real-time Refraction (CSS animations)  |    ❌     | Lightweight & Performant  |    ✅     |
| Adjustable Bevel                       |    ✅     | Seamless Scroll Sync      |    ✅     |
| Frosted Glass Effect                   |    ✅     | Auto-Resize Handling      |    ✅     |
| Dynamic Shadows                        |    ✅     | Auto Video Refraction     |    ✅     |
| Specular Highlights                    |    ✅     | Draggable Lenses          |    ✅     |
| Interactive Tilt Effect                |    ✅     | zIndex Control            |    ✅     |
| Chromatic Aberration                   |    ✅     | Configurable Tilt Easing  |    ✅     |
| Tinted / Coloured Glass                |    ✅     | Per-lens Destroy Method   |    ✅     |
| Fluid, Touch-Aware Interaction         |    ✅     | `on.init` Callback        |    ✅     |
| Helper GUI                             |    ✅     | Register Dynamic Elements |    ✅     |

---

## Prerequisites

Add the following script before you initialise `liquidGL()` (normally at the end of the `<body>`):

```html
<!-- liquidGL.js – the library itself -->
<script src="/scripts/liquidGL.js" defer></script>

<!-- Optional: dev helper GUI for `helper: true` (development only) -->
<script src="/scripts/liquidGL-helper.js" defer></script>
```

> `liquidGL` has no runtime dependencies. The high-resolution snapshot of the page background that it refracts is produced by its own built-in rasteriser.

---

## Quick start

Set up your HTML structure first. You will have a `target` element that will receive the glass effect, and a child element for your content (excluded from glass effect).

```html
<!-- Example HTML structure -->
<body>
  <!-- Target (glassified) -->
  <div class="liquidGL">
    <!-- Content -->
    <div class="content">
      <img src="/example.svg" alt="Alt Text" />
      <p>This example text content will appear on top of the glass.</p>
    </div>
  </div>
</body>
```

> Make sure that your `target` element has a high z-index so that it sits over your page content. Any content with a higher z-index than the `target` will be excluded from the lens, i.e a modal video player that you don't want to stain the lens.

Next, initialise the library with the selector for your target element.

```html
<script>
  document.addEventListener("DOMContentLoaded", () => {
    const glassEffect = liquidGL({
      engine: "auto", // Renderer chain: "auto" tries WebGPU then WebGL; force with "webgpu", "webgl2" or "webgl"
      snapshot: "body", // The area used for refraction, <body> recommended and default
      target: ".liquidGL", // CSS selector for the element(s) to glass-ify
      resolution: 2.0, // The quality of the snapshot
      zIndex: undefined, // Explicit stacking order; defaults to the element's own effective z-index
      content: undefined, // CSS selector for a sub-element to render as lens content; defaults to the target itself
      refraction: 0.01, // Base refraction strength (0–1)
      aberration: 0, // Chromatic aberration strength (0–1). 0 = off
      bevelDepth: 0.08, // Intensity of the edge bevel (0–1)
      bevelWidth: 0.15, // Width of the bevel as a proportion of the element (0–1)
      frost: 0, // Subtle blur radius in px. 0 = crystal clear
      shadow: true, // Adds a soft drop-shadow under the pane
      specular: true, // Animated light highlights (slightly more GPU)
      reveal: "fade", // Reveal animation
      tilt: false, // Whether tilt on hover is enabled
      tiltFactor: 5, // If tilt is enabled, how much tilt
      tiltEase: 400, // Tilt settle duration in ms, on hover in and out
      draggable: false, // Whether the lens can be picked up and dragged
      interaction: "none", // Pointer interaction mode: "none" or "fluid"
      interactionStrength: 0.5, // Strength of the fluid displacement (0–1)
      interactionRadius: 0.35, // Radius of the fluid interaction, proportion of the pane (0–1)
      interactionViscosity: 0.65, // How quickly the fluid surface settles (0–1)
      magnify: 1, // Magnification of lens content
      tint: null, // Optional glass dye - any CSS colour; alpha sets dye strength, e.g. "rgba(0, 0, 20, 0.25)"
      helper: false, // Show debug helper - note requires liquidGL-helper.js module
      on: {
        init(instance) {
          // The `init` callback fires once liquidGL has taken its snapshot
          // and rendered the first frame. It's the ideal place to hide or
          // prepare elements for reveal animations (e.g. with GSAP, ScrollTrigger)
          // because it ensures the content is visible to the snapshot before
          // you hide it from the user.
          console.log("liquidGL ready!", instance);
        },
        // dragstart(instance, info), drag(instance, info) and dragend(instance, info)
        // fire when `draggable: true` and the lens is picked up, moved and released.
      },
    });

    // glassEffect.destroy() removes the lens entirely - restores the
    // element's original styles, removes event listeners and releases
    // GPU resources. Other lenses sharing the canvas are unaffected.
  });
</script>
```

---

## Dynamic Rendering

`liquidGL` can refract dynamic content like animations in real-time. To make this work, you must "register" any dynamic elements that will intersect with your glass pane. This tells `liquidGL` to monitor them and update the texture when they change.

> **Note:** Videos are automatically detected and do not need to be registered.

Register dynamic elements _after_ initialising `liquidGL()` but _before_ calling `liquidGL.syncWith()` (if used). You can register elements using a CSS selector string or by passing an array of DOM elements.

```javascript
// After initialising liquidGL...
const glassEffect = liquidGL({
  target: ".liquidGL",
  // ... other options
});

// Register an element by its CSS selector
liquidGL.registerDynamic(".my-animated-element");

// Register multiple elements (e.g., from a GSAP SplitText animation)
const mySplitText = SplitText.create(".my-text", { type: "lines" });
liquidGL.registerDynamic(mySplitText.lines); // Pass the array of line elements
```

---

## Optionally sync with Smooth Scrolling Libraries

`liquidGL` includes a `syncWith()` helper to automatically integrate with popular smooth-scrolling libraries like Lenis and Locomotive Scroll. It handles the render loop synchronization for you.

> Simply call `liquidGL.syncWith()` after initialising `liquidGL`.

```html
<script>
  document.addEventListener("DOMContentLoaded", () => {
    // First, initialise liquidGL
    const glassEffect = liquidGL({
      target: ".liquidGL",
      // ... other options
    });

    // Sync with scrolling libraries. This auto-detects libraries like
    // Lenis or Locomotive Scroll and returns their instances if found.
    const { lenis, locomotiveScroll } = liquidGL.syncWith();

    // You can now use the 'lenis' or 'locomotiveScroll' instances if needed.
  });
</script>
```

> Make sure to include the scroll library scripts (e.g., Lenis, GSAP) before your main script. The `syncWith()` helper must be called **after** `liquidGL()` has been called.

---

## Parameters

| Option                 | Type              | Default       | Description                                                                                                                                                                                                                                              |
| ---------------------- | ----------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine`               | string            | `'auto'`      | Render backend chain: `'auto'` (WebGPU → WebGL2 → WebGL1 → CSS), `'webgpu'` (WebGPU → CSS), `'webgl2'` (WebGL2 → WebGL1 → CSS) or `'webgl'` (WebGL1 → CSS).                                                                                              |
| `snapshot`             | string            | `'body'`      | CSS selector for the element to snapshot.                                                                                                                                                                                                                |
| `target`               | string            | `'.liquidGL'` | **Required.** CSS selector for the element(s) to glassify.                                                                                                                                                                                               |
| `resolution`           | number            | `2.0`         | Resolution of the background snapshot (clamped 0.1–3.0). Higher is sharper but uses more memory.                                                                                                                                                         |
| `zIndex`               | integer           | `undefined`   | Explicit stacking order for the lens, used to order stacked/multiple lenses and their shadow/tilt layers. Defaults to the element's own effective z-index. Instances sharing a canvas must use the same `zIndex`.                                        |
| `content`              | string \| boolean | `undefined`   | CSS selector for the element rendered as the lens's live content, when it differs from `target`. `false` disables the content layer entirely.                                                                                                            |
| `refraction`           | number            | `0.01`        | Base refraction offset applied across the pane (0–1).                                                                                                                                                                                                    |
| `aberration`           | number            | `0`           | Chromatic aberration strength (0–1). Scales with the refraction offset, so dispersion is strongest at the bevel. `0` disables it and skips the extra texture samples.                                                                                    |
| `bevelDepth`           | number            | `0.08`        | Additional refraction on the edge to simulate depth (0–1).                                                                                                                                                                                               |
| `bevelWidth`           | number            | `0.15`        | Width of the bevel zone as a fraction of the shortest side (0–1).                                                                                                                                                                                        |
| `frost`                | number            | `0`           | Blur radius in pixels for a frosted look. `0` is clear.                                                                                                                                                                                                  |
| `shadow`               | boolean           | `true`        | Toggles a subtle drop-shadow under the pane.                                                                                                                                                                                                             |
| `specular`             | boolean           | `true`        | Enables animated specular highlights that move with time.                                                                                                                                                                                                |
| `reveal`               | string            | `'fade'`      | Reveal animation.<br>- `'none'`: Renders immediately.<br>- `'fade'`: Smoothly fades in.                                                                                                                                                                  |
| `tilt`                 | boolean           | `false`       | Enables 3D tilt interaction on cursor movement. Ignored while `draggable` is enabled.                                                                                                                                                                    |
| `tiltFactor`           | number            | `5`           | Depth of the tilt in degrees (0–25 recommended).                                                                                                                                                                                                         |
| `tiltEase`             | number            | `400`         | Duration in ms for the tilt to settle, applied symmetrically on hover-in and hover-out. `0` applies the tilt instantly.                                                                                                                                  |
| `draggable`            | boolean           | `false`       | Lets the pane be picked up and moved with mouse or touch. Fires `on.dragstart`, `on.drag` and `on.dragend`. Runtime-adjustable via `lens.setDraggable()`.                                                                                                |
| `interaction`          | string            | `'none'`      | Pointer interaction mode: `'none'` or `'fluid'`, a viscous surface that displaces toward the cursor/touch point.                                                                                                                                         |
| `interactionStrength`  | number            | `0.5`         | Strength of the fluid displacement (0–1, higher values allow more extreme displacement).                                                                                                                                                                 |
| `interactionRadius`    | number            | `0.35`        | Radius of the fluid interaction, as a proportion of the pane's shortest side (0–1).                                                                                                                                                                      |
| `interactionViscosity` | number            | `0.65`        | How quickly the fluid surface follows and settles after the pointer moves (0–1). Higher is thicker/slower.                                                                                                                                               |
| `magnify`              | number            | `1`           | Magnification factor of the lens (clamped 0.001–3.0). `1` is no magnification.                                                                                                                                                                           |
| `tint`                 | string            | `null`        | Dyes the pane with any CSS colour; the colour's alpha is the dye strength (e.g. `'rgba(0, 0, 20, 0.25)'` for dark glass). The refracted content is multiplied by the colour, specular highlights render on top. Runtime-adjustable via `lens.setTint()`. |
| `helper`               | boolean           | `false`       | Loads the helper GUI for live tweaking of the liquidGL options. Requires `liquidGL-helper.js` to be loaded; logs a console error if missing.                                                                                                             |
| `on.init`              | function          | `—`           | Callback that runs once the first render completes. Receives the lens instance.                                                                                                                                                                          |
| `on.dragstart`         | function          | `—`           | Fires when a `draggable` lens is picked up. Receives the lens instance and a `{ x, y }` info object.                                                                                                                                                     |
| `on.drag`              | function          | `—`           | Fires on every pointer move while dragging. Receives the lens instance and a `{ x, y }` info object.                                                                                                                                                     |
| `on.dragend`           | function          | `—`           | Fires when a dragged lens is released. Receives the lens instance and a `{ x, y }` info object.                                                                                                                                                          |
| `destroy()`            | method            | `—`           | Tears down the lens: restores the element's original styles, removes its event listeners and releases its GPU resources. Other lenses sharing the canvas are unaffected.                                                                                 |

> The `target` parameter is required; all others are optional. Each lens instance also exposes `lens.setTint()`, `lens.setDraggable()` and `lens.destroy()` for runtime control.

---

## Presets

Below are some ready-made configurations you can copy-paste. Feel free to tweak values to suit your design.

| Name        | Settings                                                                                               | Purpose                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Default** | `{ refraction: 0, bevelDepth: 0.052, bevelWidth: 0.211, frost: 2, shadow: true, specular: true }`      | Balanced default used in the demo.                      |
| **Alien**   | `{ refraction: 0.073, bevelDepth: 0.2, bevelWidth: 0.156, frost: 2, shadow: true, specular: false }`   | Strong refraction & deep bevel for a sci-fi look.       |
| **Pulse**   | `{ refraction: 0.03, bevelDepth: 0, bevelWidth: 0.273, frost: 0, shadow: false, specular: false }`     | Flat pane with wide bevel—great for pulsing UI effects. |
| **Frost**   | `{ refraction: 0, bevelDepth: 0.035, bevelWidth: 0.119, frost: 0.9, shadow: true, specular: true }`    | Softly diffused, privacy-glass style.                   |
| **Edge**    | `{ refraction: 0.047, bevelDepth: 0.136, bevelWidth: 0.076, frost: 2, shadow: true, specular: false }` | Thin bevel and bright rim highlights.                   |

---

## FAQ

| Question                                                                 | Answer                                                                                                                                                                                                                                                                                                                                                                                                         |
| :----------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is there a resize handler?                                               | Yes resize is handled in the library and debounced to 250ms for performance.                                                                                                                                                                                                                                                                                                                                   |
| Does the effect work on mobile?                                          | Yes the library uses WebGPU where available, falls back through WebGL2 and WebGL1, and provides a frosted CSS `backdrop-filter` as a backup for older devices.                                                                                                                                                                                                                                                 |
| I have a preloader, how should I initialise `liquidGL()`?                | Add the `data-liquid-ignore` attribute to your preloader's top-level container to exclude it from the snapshot. You can then call `liquidGL()` inside a `DOMContentLoaded` listener as you normally would.                                                                                                                                                                                                     |
| What is the correct way to use `liquidGL` with page animations?          | Lets say you have a preloader, above the fold intro animations and scroll animations on your page. You would:<br><br>1) set the `data-liquid-ignore` attribute on your preloader<br>2) animate your preloader and set up your initial animation states<br>3) then call `liquidGL();`<br>4) optionally, in the `on.init();` callback, you can run post snapshot scripts, such as animating the `target` element |
| Can I use `liquidGL` on multiple elements?                               | Yes, any element which has the class declared as your `target` will be glassified. Note **all elements must use the same effective `zIndex`** due to shared canvas optimisations — set it explicitly with the `zIndex` option, or `liquidGL` will use the highest CSS `z-index` among matched elements.                                                                                                        |
| Will the library exceed WebGL contexts or have other performance issues? | No, the library uses a shared canvas for all instances, we have tested up to 30 elements on one page and we were not able to cause performance problems or crashes.                                                                                                                                                                                                                                            |
| Are there any animation limitations?                                     | It depends on what you're trying to do, rotation and scale are expensive CPU/GPU processes, additionally `shadow` `specular` and `tilt` should be used with care when you have lots of instances or complex animations as they can clog the render pipeline.                                                                                                                                                   |
| How do I tint the glass?                                                 | Set `tint` to any CSS colour, e.g. `tint: "rgba(8, 10, 20, 0.25)"`. The colour's alpha is the dye strength — `0` (or `null`) leaves the glass clear. Adjust it at runtime with `lens.setTint("…")`; it's honoured by every backend, including the CSS fallback.                                                                                                                                                |
| How do I get the viscous "fluid" cursor effect?                          | Set `interaction: "fluid"`, then tune `interactionStrength` (how far it displaces), `interactionRadius` (how wide the effect reaches) and `interactionViscosity` (how slowly it settles). It works with both mouse and touch.                                                                                                                                                                                  |
| How do I add chromatic aberration?                                       | Set `aberration` above `0` (0–1). It disperses red and blue either side of the refraction vector, scaling with `refraction`, so the effect is strongest at the bevel and vanishes at the flat centre.                                                                                                                                                                                                          |
| How do I stack lenses on top of each other?                              | Give the top lens a higher `zIndex` than the one(s) beneath it and initialise both against the same `snapshot`. The upper lens will refract the already-refracted output of the lens(es) below it — see the Stacked Lenses demo.                                                                                                                                                                               |
| How do I put multiple independent lenses on one page?                    | Call `liquidGL()` once per group of elements (or once with a `target` selector matching several elements). All lenses matching the same `snapshot`, anchor and `zIndex` share a single canvas automatically — no extra setup required.                                                                                                                                                                         |
| Do I need to configure WebGPU myself?                                    | No. `engine: 'auto'` (the default) tries WebGPU, then falls back through WebGL2, WebGL1 and finally CSS `backdrop-filter` automatically. Force a specific backend with `engine: 'webgpu' \| 'webgl2' \| 'webgl'`, or test one via `?liquidGL-engine=webgl2` in the URL.                                                                                                                                        |
| How do I make a lens draggable?                                          | Set `draggable: true`, or call `lens.setDraggable(true)` at runtime. This disables `tilt` on that lens and fires `on.dragstart`, `on.drag` and `on.dragend` callbacks with the lens instance and current `{ x, y }` offset.                                                                                                                                                                                    |
| How do I control which lens renders on top?                              | Set the `zIndex` option on each lens. It defaults to the element's own effective CSS z-index, but explicit `zIndex` is recommended once you have stacked or multiple lenses, since it also positions their `shadow` and `tilt` helper layers.                                                                                                                                                                  |
| How do I remove a single lens without affecting the others?              | Call `lens.destroy()` on that lens instance. It restores the element's original styles, removes its listeners and releases its GPU resources, leaving any other lenses sharing the canvas untouched.                                                                                                                                                                                                           |

---

## Important Notes

- For dynamic content to be refracted in real-time, you must register the element(s) with `liquidGL.registerDynamic()`. It is crucial to set the initial state of your animations **before** calling `liquidGL()` to ensure they are captured correctly.
- The library ignores `fixed` position elements, this is to prevent a known snapshotting bug on mobile browsers from surfacing which can prevent the snapshot from running. This is a safety net that shouldn't interfere with your use of the library.
- You can have multiple instances on one page **but they must share the same effective `zIndex`**. Set `zIndex` explicitly, or `liquidGL` will use the highest CSS `z-index` among elements matching the `target` selector. This is because the effect uses a shared canvas to prevent WebGL context issues, there is no work around to this unfortunately.
- To improve performance on complex pages, you can snapshot a smaller, specific element like a background container instead of the whole page. Use the `snapshot` option with a CSS selector (e.g., `snapshot: '.my-background'`). This reduces texture memory and improves performance.
- The initial capture is asynchronous. Call `liquidGL()` inside a `DOMContentLoaded` or `load` handler to ensure content is available to the snapshot.
- Extremely long documents can exceed GPU texture limits, causing memory or performance issues. Consider segmenting very long pages (see source) or reducing the `resolution` parameter.
- The `shadow` and `tilt` effects create new stacking layers behind the `target` element. The `shadow` is placed at `z-index - 2` and the `tilt` helper canvas is placed at `z-index - 1`. Ensure your `z-index` values leave room for these layers to prevent clipping or overflow issues.
- As with all WebGL effects, any **image** content inside the `target` element must have permissive `Access-Control-Allow-Origin` headers set to prevent CORS issues.

---

## Browser Support

The `liquidGL` library is compatible with all modern browsers on desktop, tablet and mobile devices — WebGPU is used when available, with automatic fallback to WebGL (WebGL2 → WebGL1).

> [!NOTE]  
> Performance varies between browsers, specifically Safari can be unstable when the liquid element(s) are more than 50% of the viewport width or height. Practical use issues are rare, but make sure to test on your target devices thoroughly.

| Browser        | Supported |
| :------------- | :-------: |
| Google Chrome  |    Yes    |
| Safari         |    Yes    |
| Firefox        |    Yes    |
| Microsoft Edge |    Yes    |

---

## Other

**Exclude elements**

> You can set elements to be ignored by the refraction using `data-liquid-ignore`. Add this attribute on the parent container of the element you wish to exclude.

**Content Visibility**

> It is recommended to use `z-index: 3;` on the content inside your target element to make it sit on top of the lens. You can also combine this with `mix-blend-mode: difference;` for better legibility.

**Border-radius**

> `liquidGL` automatically inherits the `border-radius` of the `target` element, ensuring the refraction respects rounded corners without any extra configuration. If you animate the `border-radius` of your `target` element i.e on scroll, the bevel will animate in real time to remain in sync.

---

## Contributors

Thank you to the following people for their contributions to `liquidGL`.

<table>
  <tr>
    <td align="center" width="140">
      <a href="https://github.com/codedgar">
        <img src="https://github.com/codedgar.png?size=100" width="100" height="100" alt="Edgar Pérez" /><br />
        <sub><b>Edgar Pérez</b></sub><br />
        <sub>@codedgar</sub>
      </a>
    </td>
    <td align="center" width="140">
      <a href="https://github.com/AbhinavRobinson">
        <img src="https://github.com/AbhinavRobinson.png?size=100" width="100" height="100" alt="Abhinav Robinson" /><br />
        <sub><b>Abhinav Robinson</b></sub><br />
        <sub>@AbhinavRobinson</sub>
      </a>
    </td>
  </tr>
</table>

---

## License

MIT © NaughtyDuk
