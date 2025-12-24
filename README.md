# liquidGL – Ultra-light glassmorphism for the web

<a href="https://liquidgl.naughtyduk.com"><img src="/assets/liquidGlass-promo.gif" alt="liquidGL" style="width: 100%"/></a>

**Release** - `now with real-time support`\*

> [!IMPORTANT]
> `liquidGL` is currently in beta and is not yet ready for production use. It is recommended to use it for prototyping and testing purposes only.
> `liquidGL` turns any fixed-position element into a perfectly refracted, glossy "glass pane" rendered in WebGL.

<a href="https://liquidgl.naughtyduk.com" target="_blank" rel="noopener noreferrer"><strong>TRY IT OUT</strong></a>

<a href="https://liquidgl.naughtyduk.com/demos/demo-1.html" target="_blank" rel="noopener noreferrer"><strong>DEMO 1</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/demo-2.html" target="_blank" rel="noopener noreferrer"><strong>DEMO 2</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/demo-3.html" target="_blank" rel="noopener noreferrer"><strong>DEMO 3</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/demo-4.html" target="_blank" rel="noopener noreferrer"><strong>DEMO 4</strong></a> | <a href="https://liquidgl.naughtyduk.com/demos/demo-5.html" target="_blank" rel="noopener noreferrer"><strong>DEMO 5</strong></a>

## Overview

`liquidGL` recreates Apple's "Liquid Glass" aesthetic in the browser with an ultra-light WebGL shader. It turns any DOM element into a beautiful, refracting glass pane. To overcome WebGL's security limitations on reading live screen pixels, `liquidGL` uses an innovative offscreen rendering technique. This allows it to refract dynamic content like videos, text animations, and more in real-time, delivering a smooth and interactive experience.

### Key Features

| Feature                                | Supported | Feature                  | Supported |
| :------------------------------------- | :-------: | :----------------------- | :-------: |
| Real-time Refraction (static content)  |    ✅     | Magnification Control    |    ✅     |
| Real-time Refraction (video)           |    ✅     | Dynamic Element Support  |    ✅     |
| Real-time Refraction (text animations) |    ✅     | GSAP-Ready Animations    |    ✅     |
| Real-time Refraction (CSS animations)  |    ❌     | Lightweight & Performant |    ✅     |
| Adjustable Bevel                       |    ✅     | Seamless Scroll Sync     |    ✅     |
| Frosted Glass Effect                   |    ✅     | Auto-Resize Handling     |    ✅     |
| Dynamic Shadows                        |    ✅     | Auto Video Refraction    |    ✅     |
| Specular Highlights                    |    ✅     | Animate Lenses           |    ✅     |
| Interactive Tilt Effect                |    ✅     | `on.init` Callback       |    ✅     |

---

## Prerequisites

Add **both** of the following scripts before you initialise `liquidGL()` (normally at the end of the `<body>`):

```html
<!-- html2canvas – DOM snapshotter (required) -->
<script
  src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"
  defer
></script>

<!-- liquidGL.js – the library itself -->
<script src="/scripts/liquidGL.js" defer></script>
```

> `html2canvas` provides the high-resolution snapshot of the page background that `liquidGL` refracts. The library will throw if either dependency is missing.

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
      snapshot: "body", // The area used for refraction, <body> recommended and default
      target: ".liquidGL", // CSS selector for the element(s) to glass-ify
      resolution: 2.0, // The quality of the snapshot
      refraction: 0.01, // Base refraction strength (0–1)
      bevelDepth: 0.08, // Intensity of the edge bevel (0–1)
      bevelWidth: 0.15, // Width of the bevel as a proportion of the element (0–1)
      frost: 0, // Subtle blur radius in px. 0 = crystal clear
      shadow: true, // Adds a soft drop-shadow under the pane
      specular: true, // Animated light highlights (slightly more GPU)
      reveal: "fade", // Reveal animation
      tilt: false, // Whether tilt on hover is enabled
      tiltFactor: 5, // If tilt is enabled, how much tilt
      magnify: 1, // Magnification of lens content
      on: {
        init(instance) {
          // The `init` callback fires once liquidGL has taken its snapshot
          // and rendered the first frame. It's the ideal place to hide or
          // prepare elements for reveal animations (e.g. with GSAP, ScrollTrigger)
          // because it ensures the content is visible to the snapshot before
          // you hide it from the user.
          console.log("liquidGL ready!", instance);
        },
      },
    });
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

| Option       | Type     | Default       | Description                                                                                      |
| ------------ | -------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `target`     | string   | `'.liquidGL'` | **Required.** CSS selector for the element(s) to glassify.                                       |
| `snapshot`   | string   | `'body'`      | CSS selector for the element to snapshot.                                                        |
| `resolution` | number   | `2.0`         | Resolution of the background snapshot (clamped 0.1–3.0). Higher is sharper but uses more memory. |
| `refraction` | number   | `0.01`        | Base refraction offset applied across the pane (0–1).                                            |
| `bevelDepth` | number   | `0.08`        | Additional refraction on the edge to simulate depth (0–1).                                       |
| `bevelWidth` | number   | `0.15`        | Width of the bevel zone as a fraction of the shortest side (0–1).                                |
| `frost`      | number   | `0`           | Blur radius in pixels for a frosted look. `0` is clear.                                          |
| `shadow`     | boolean  | `true`        | Toggles a subtle drop-shadow under the pane.                                                     |
| `specular`   | boolean  | `true`        | Enables animated specular highlights that move with time.                                        |
| `reveal`     | string   | `'fade'`      | Reveal animation.<br>- `'none'`: Renders immediately.<br>- `'fade'`: Smoothly fades in.          |
| `tilt`       | boolean  | `false`       | Enables 3D tilt interaction on cursor movement.                                                  |
| `tiltFactor` | number   | `5`           | Depth of the tilt in degrees (0–25 recommended).                                                 |
| `magnify`    | number   | `1`           | Magnification factor of the lens (clamped 0.001–3.0). `1` is no magnification.                   |
| `on.init`    | function | `—`           | Callback that runs once the first render completes. Receives the lens instance.                  |

> The `target` parameter is required; all others are optional.

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
| Does the effect work on mobile?                                          | Yes the library handles all 3 versions of WebGL and provides a frosted CSS `backdrop-filter` as a backup for older devices.                                                                                                                                                                                                                                                                                    |
| I have a preloader, how should I initialise `liquidGL()`?                | Add the `data-liquid-ignore` attribute to your preloader's top-level container to exclude it from the snapshot. You can then call `liquidGL()` inside a `DOMContentLoaded` listener as you normally would.                                                                                                                                                                                                     |
| What is the correct way to use `liquidGL` with page animations?          | Lets say you have a preloader, above the fold intro animations and scroll animations on your page. You would:<br><br>1) set the `data-liquid-ignore` attribute on your preloader<br>2) animate your preloader and set up your initial animation states<br>3) then call `liquidGL();`<br>4) optionally, in the `on.init();` callback, you can run post snapshot scripts, such as animating the `target` element |
| Can I use `liquidGL` on multiple elements?                               | Yes, any element which has the class declared as your `target` will be glassified. Note **all elements must use the same `z-index`** due to shared canvas optimisations, if you use different `z-index` values for multiple targets, the highest value will be used by `liquidGL`.                                                                                                                             |
| Will the library exceed WebGL contexts or have other performance issues? | No, the library uses a shared canvas for all instances, we have tested up to 30 elements on one page and we were not able to cause performance problems or crashes.                                                                                                                                                                                                                                            |
| Are there any animation limitations?                                     | It depends on what you're trying to do, rotation and scale are expensive CPU/GPU processes, additionally `shadow` `specular` and `tilt` should be used with care when you have lots of instances or complex animations as they can clog the render pipeline.                                                                                                                                                   |

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

## License

MIT © NaughtyDuk
