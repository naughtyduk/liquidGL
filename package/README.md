# liquidGL – Ultra-light glassmorphism for the web

<a href="https://liquidgl.naughtyduk.com"><img src="https://raw.githubusercontent.com/naughtyduk/liquidGL/main/assets/liquidGL-npm-preview.gif" alt="liquidGL" width="100%" height="auto"/></a>

**v2.0.0**

> [!NOTE]
> `liquidGL` is free to use for both non-commercial and commercial purposes. _BETA_ has now ended and the library is now ready for production use.

> [!WARNING]
> **v2.0.0 changes tilt behaviour.** The tilt interaction now eases symmetrically over the new `tiltEase` option (default `400`ms) in both directions, replacing the previous hard-coded `0.12s` ease-in and `0.4s` ease-out. If you depended on the old timing, set `tiltEase` explicitly. All other defaults are unchanged and existing configurations render identically.

`liquidGL` turns any fixed-position element into a perfectly refracted, glossy "glass pane" rendered in WebGL.

<a href="https://liquidgl.naughtyduk.com" target="_blank" rel="noopener noreferrer"><img src="https://raw.githubusercontent.com/naughtyduk/liquidGL/main/assets/try-it-out-npm.png" alt="Try It Out" width="120"></a>

<a href="https://liquidgl.naughtyduk.com/demos/demo-1.html" target="_blank" rel="noopener noreferrer"><strong>DEMO 1</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/demo-2.html" target="_blank" rel="noopener noreferrer"><strong>DEMO 2</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/demo-3.html" target="_blank" rel="noopener noreferrer"><strong>DEMO 3</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/demo-4.html" target="_blank" rel="noopener noreferrer"><strong>DEMO 4</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/demo-5.html" target="_blank" rel="noopener noreferrer"><strong>DEMO 5</strong></a>

---

## What's new in v2.0.0

**New features**

- **Chromatic aberration** — the new `aberration` option disperses the red and blue channels either side of the refraction vector, blue displaced further than red, matching the way real glass disperses shorter wavelengths more strongly. Dispersion scales with the refraction offset, so it concentrates at the bevelled edge and vanishes at the flat centre. Defaults to `0` (off).
- **Configurable tilt easing** — the new `tiltEase` option sets the settle duration, in milliseconds, of the tilt on both hover-in and hover-out.

**Bug fixes**

- **Refraction drift caused by ignored elements** — elements marked `data-liquid-ignore` were removed from the snapshot entirely, collapsing them out of layout and shifting every element below them. Ignored elements now retain their layout box, so the refraction stays aligned with the live page.
- **Lens and content diverging during tilt** — the pane could separate from its content mid-tilt because the element was being measured while transformed. Metrics are now taken from the untilted box.
- **Tilt snapping on hover** — the refraction jumped straight to its new angle on hover-in while easing on hover-out. Both directions now share a single curve and duration, and cursor movement during entry retargets the in-flight ease rather than snapping.
- **Displacement while pinch-zoomed** — the pane drifted diagonally away from its element when the page was pinch-zoomed, because `visualViewport` offsets were applied twice. Offset compensation is now correctly gated.

**Performance**

- Video frames are no longer re-composited or re-uploaded when neither the frame time nor the destination region has changed. Paused, ended and unmoved videos now cost nothing per frame.
- The snapshot bounding box is read once per frame and shared across every lens, instead of twice per lens per frame, removing repeated forced layout from the render loop.

---

## Install from npm

```sh
npm install liquid-gl
```

```js
import liquidGL from "liquid-gl";

const glassEffect = liquidGL({
  target: ".liquidGL",
  snapshot: "body",
});
```

> `html2canvas` is installed automatically as a package dependency, so there is nothing else to add. `liquidGL` renders with raw WebGL and has no other runtime dependencies.

---

## Overview

`liquidGL` recreates Apple's "Liquid Glass" aesthetic in the browser with an ultra-light WebGL shader. It turns any DOM element into a beautiful, refracting glass pane. To overcome WebGL's security limitations on reading live screen pixels, `liquidGL` uses an innovative offscreen rendering technique. This allows it to refract dynamic content like videos, text animations, and more in real-time, delivering a smooth and interactive experience.

### Key Features

| Feature                                | Supported | Feature                          | Supported |
| :------------------------------------- | :-------: | :------------------------------- | :-------: |
| Real-time Refraction (static content)  |    ✅     | Magnification Control            |    ✅     |
| Real-time Refraction (video)           |    ✅     | Dynamic Element Support          |    ✅     |
| Real-time Refraction (text animations) |    ✅     | GSAP-Ready Animations            |    ✅     |
| Real-time Refraction (CSS animations)  |    ❌     | Lightweight & Performant         |    ✅     |
| Adjustable Bevel                       |    ✅     | Seamless Scroll Sync             |    ✅     |
| Frosted Glass Effect                   |    ✅     | Auto-Resize Handling             |    ✅     |
| Dynamic Shadows                        |    ✅     | Auto Video Refraction            |    ✅     |
| Specular Highlights                    |    ✅     | Animate Lenses                   |    ✅     |
| Interactive Tilt Effect `[UPDATED]`    |    ✅     | `on.init` Callback               |    ✅     |
| Chromatic Aberration `[NEW]`           |    ✅     | Configurable Tilt Easing `[NEW]` |    ✅     |

---

## Quick start

Set up your HTML structure first. You will have a `target` element that will receive the glass effect, and a child element for your content (excluded from glass effect).

```html
<body>
  <div class="liquidGL">
    <div class="content">
      <img src="example.svg" alt="Alt Text" />
      <p>This example text content will appear on top of the glass.</p>
    </div>
  </div>
</body>
```

> Make sure that your `target` element has a high z-index so that it sits over your page content. Any content with a higher z-index than the `target` will be excluded from the lens, i.e a modal video player that you don't want to stain the lens.

Next, initialise the library with the selector for your target element.

```js
import liquidGL from "liquid-gl";

const glassEffect = liquidGL({
  snapshot: "body",
  target: ".liquidGL",
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
  on: {
    init(instance) {
      console.log("liquidGL ready!", instance);
    },
  },
});
```

---

## Dynamic Rendering

`liquidGL` can refract dynamic content like animations in real-time. To make this work, you must "register" any dynamic elements that will intersect with your glass pane. This tells `liquidGL` to monitor them and update the texture when they change.

> **Note:** Videos are automatically detected and do not need to be registered.

Register dynamic elements _after_ initialising `liquidGL()` but _before_ calling `liquidGL.syncWith()` (if used). You can register elements using a CSS selector string or by passing an array of DOM elements.

```js
const glassEffect = liquidGL({
  target: ".liquidGL",
});

liquidGL.registerDynamic(".my-animated-element");

const mySplitText = SplitText.create(".my-text", { type: "lines" });
liquidGL.registerDynamic(mySplitText.lines);
```

---

## Optionally sync with Smooth Scrolling Libraries

`liquidGL` includes a `syncWith()` helper to automatically integrate with popular smooth-scrolling libraries like Lenis and Locomotive Scroll. It handles the render loop synchronization for you.

> Simply call `liquidGL.syncWith()` after initialising `liquidGL`.

When installed from npm, pass your libraries in directly. Imported modules are not attached to `window`, so the helper cannot auto-detect them the way it does with browser script tags.

```js
import liquidGL from "liquid-gl";
import Lenis from "lenis";
import gsap from "gsap";
import ScrollTrigger from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const glassEffect = liquidGL({
  target: ".liquidGL",
});

const lenis = new Lenis();

liquidGL.syncWith({ gsap, lenis });
```

Passing `gsap` lets `liquidGL` drive its render loop from the GSAP ticker and keep `ScrollTrigger` updating on scroll. `ScrollTrigger` is read from the `gsap` object once registered, or you can pass it explicitly as `ScrollTrigger`.

| Option             | Type   | Description                                                                            |
| ------------------ | ------ | -------------------------------------------------------------------------------------- |
| `gsap`             | object | The `gsap` module. Enables ticker-driven rendering and `ScrollTrigger` sync.           |
| `ScrollTrigger`    | object | Optional. Only needed if `ScrollTrigger` has not been registered on the `gsap` object. |
| `lenis`            | object | An existing `Lenis` instance.                                                          |
| `locomotiveScroll` | object | An existing `LocomotiveScroll` instance.                                               |

> `syncWith()` must be called **after** `liquidGL()`. Passing `gsap: false` opts out of the GSAP ticker and uses a `requestAnimationFrame` loop instead.

---

## Parameters

| Option       | Type     | Default       | Description                                                                                                                                                           |
| ------------ | -------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`     | string   | `'.liquidGL'` | **Required.** CSS selector for the element(s) to glassify.                                                                                                            |
| `snapshot`   | string   | `'body'`      | CSS selector for the element to snapshot.                                                                                                                             |
| `resolution` | number   | `2.0`         | Resolution of the background snapshot (clamped 0.1–3.0). Higher is sharper but uses more memory.                                                                      |
| `refraction` | number   | `0.01`        | Base refraction offset applied across the pane (0–1).                                                                                                                 |
| `aberration` | number   | `0`           | Chromatic aberration strength (0–1). Scales with the refraction offset, so dispersion is strongest at the bevel. `0` disables it and skips the extra texture samples. |
| `bevelDepth` | number   | `0.08`        | Additional refraction on the edge to simulate depth (0–1).                                                                                                            |
| `bevelWidth` | number   | `0.15`        | Width of the bevel zone as a fraction of the shortest side (0–1).                                                                                                     |
| `frost`      | number   | `0`           | Blur radius in pixels for a frosted look. `0` is clear.                                                                                                               |
| `shadow`     | boolean  | `true`        | Toggles a subtle drop-shadow under the pane.                                                                                                                          |
| `specular`   | boolean  | `true`        | Enables animated specular highlights that move with time.                                                                                                             |
| `reveal`     | string   | `'fade'`      | Reveal animation.<br>- `'none'`: Renders immediately.<br>- `'fade'`: Smoothly fades in.                                                                               |
| `tilt`       | boolean  | `false`       | Enables 3D tilt interaction on cursor movement.                                                                                                                       |
| `tiltFactor` | number   | `5`           | Depth of the tilt in degrees (0–25 recommended).                                                                                                                      |
| `tiltEase`   | number   | `400`         | Duration in ms for the tilt to settle, applied symmetrically on hover-in and hover-out. `0` applies the tilt instantly.                                               |
| `magnify`    | number   | `1`           | Magnification factor of the lens (clamped 0.001–3.0). `1` is no magnification.                                                                                        |
| `on.init`    | function | `—`           | Callback that runs once the first render completes. Receives the lens instance.                                                                                       |

> The `target` parameter is required; all others are optional.

---

## Presets

| Name        | Settings                                                                                               | Purpose                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Default** | `{ refraction: 0, bevelDepth: 0.052, bevelWidth: 0.211, frost: 2, shadow: true, specular: true }`      | Balanced default used in the demo.                      |
| **Alien**   | `{ refraction: 0.073, bevelDepth: 0.2, bevelWidth: 0.156, frost: 2, shadow: true, specular: false }`   | Strong refraction & deep bevel for a sci-fi look.       |
| **Pulse**   | `{ refraction: 0.03, bevelDepth: 0, bevelWidth: 0.273, frost: 0, shadow: false, specular: false }`     | Flat pane with wide bevel—great for pulsing UI effects. |
| **Frost**   | `{ refraction: 0, bevelDepth: 0.035, bevelWidth: 0.119, frost: 0.9, shadow: true, specular: true }`    | Softly diffused, privacy-glass style.                   |
| **Edge**    | `{ refraction: 0.047, bevelDepth: 0.136, bevelWidth: 0.076, frost: 2, shadow: true, specular: false }` | Thin bevel and bright rim highlights.                   |

---

## FAQ

| Question                                                                 | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| :----------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is there a resize handler?                                               | Yes resize is handled in the library and debounced to 250ms for performance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Does the effect work on mobile?                                          | Yes the library handles all 3 versions of WebGL and provides a frosted CSS `backdrop-filter` as a backup for older devices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| I have a preloader, how should I initialise `liquidGL()`?                | Add the `data-liquid-ignore` attribute to your preloader's top-level container to exclude it from the snapshot. You can then call `liquidGL()` inside a `DOMContentLoaded` listener as you normally would.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| What is the correct way to use `liquidGL` with page animations?          | Lets say you have a preloader, above the fold intro animations and scroll animations on your page. You would:<br><br>1) set the `data-liquid-ignore` attribute on your preloader<br>2) animate your preloader and set up your initial animation states<br>3) then call `liquidGL();`<br>4) optionally, in the `on.init();` callback, you can run post snapshot scripts, such as animating the `target` element                                                                                                                                                                                                                                                                                                                                                           |
| Can I use `liquidGL` on multiple elements?                               | Yes, any element which has the class declared as your `target` will be glassified. Note **all elements must use the same `z-index`** due to shared canvas optimisations, if you use different `z-index` values for multiple targets, the highest value will be used by `liquidGL`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Will the library exceed WebGL contexts or have other performance issues? | No, the library uses a shared canvas for all instances, we have tested up to 30 elements on one page and we were not able to cause performance problems or crashes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Are there any animation limitations?                                     | It depends on what you're trying to do, rotation and scale are expensive CPU/GPU processes, additionally `shadow` `specular` and `tilt` should be used with care when you have lots of instances or complex animations as they can clog the render pipeline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Why does `liquidGL` still use `html2canvas` rather than `snapdom`?       | We evaluated `snapdom` and chose not to adopt it. It is faster at capture in isolation, but it rasterises through `foreignObject`, which introduces correctness problems that matter for a full-page background snapshot: CSS `background-image` does not paint inside `foreignObject` on WebKit, Chromium clips the output beyond the first viewport on long pages, and only in-viewport content is rasterised, so off-screen dynamic elements need re-capturing. Working around each of those needs image shims, output validation and an `html2canvas` fallback regardless, which adds weight and failure modes. The capture happens once on load and is not part of the per-frame budget, so the reliability of `html2canvas` outweighs a negligible practical gain. |

---

## Important Notes

- For dynamic content to be refracted in real-time, you must register the element(s) with `liquidGL.registerDynamic()`. It is crucial to set the initial state of your animations **before** calling `liquidGL()` to ensure they are captured correctly.
- The library ignores `fixed` position elements, this is to prevent a known bug between html2canvas and mobile browsers from surfacing which can prevent the snapshot from running. This is a safety net that shouldn't interfere with your use of the library.
- You can have multiple instances on one page **but they must share the same `z-index` value**. If you specify different `z-index` values, `liquidGL` will use the highest `z-index` for all elements with the `target` selector. This is because the effect uses a shared canvas to prevent WebGL context issues, there is no work around to this unfortunately.
- To improve performance on complex pages, you can snapshot a smaller, specific element like a background container instead of the whole page. Use the `snapshot` option with a CSS selector (e.g., `snapshot: '.my-background'`). This reduces texture memory and improves performance.
- The initial capture is asynchronous. Call `liquidGL()` inside a `DOMContentLoaded` or `load` handler to ensure content is available to the snapshot.
- Extremely long documents can exceed GPU texture limits, causing memory or performance issues. Consider segmenting very long pages (see source) or reducing the `resolution` parameter.
- The `shadow` and `tilt` effects create new stacking layers behind the `target` element. The `shadow` is placed at `z-index - 2` and the `tilt` helper canvas is placed at `z-index - 1`. Ensure your `z-index` values leave room for these layers to prevent clipping or overflow issues.
- As with all WebGL effects, any **image** content inside the `target` element must have permissive `Access-Control-Allow-Origin` headers set to prevent CORS issues.

---

## Browser Support

The `liquidGL` library is compatible with all WebGL enabled browsers on desktop, tablet and mobile devices.

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
