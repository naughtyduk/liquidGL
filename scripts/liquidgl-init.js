/**
 * LiquidGL Initialization Module
 * Handles liquidGL setup, GSAP animations, and dynamic element registration
 * Exports: glassEffect (liquidGL instance)
 */

// Global variable to be accessed by other modules
let glassEffect;

// Register GSAP SplitText plugin
gsap.registerPlugin(SplitText);

document.addEventListener('DOMContentLoaded', () => {
  // Wait for fonts to be loaded
  const fontsReady =
    document.fonts && document.fonts.ready
      ? document.fonts.ready
      : Promise.resolve();

  fontsReady.then(() => {
    // 1. PREPARE ANIMATIONS BEFORE INITIALISING LIQUIDGL
    gsap.set('.split', { visibility: 'visible' });
    const allSplitLines = [];

    gsap.utils.toArray('.split').forEach((splitEl) => {
      const split = SplitText.create(splitEl, {
        type: 'lines',
        linesClass: 'line',
        mask: 'lines',
      });

      gsap.from(split.lines, {
        scrollTrigger: {
          trigger: splitEl,
          start: 'top 50%',
          toggleActions: 'play none none reverse',
        },
        duration: 1.2,
        yPercent: 180,
        stagger: 0.1,
        ease: 'expo.out',
      });

      allSplitLines.push(...split.lines);
    });

    // 2. INITIALISE LIQUIDGL
    // Responsive refraction value
    const getRefractionValue = () => {
      return window.innerWidth <= 767 ? 0.011 : 0.026;
    };

    glassEffect = liquidGL({
      target: '.liquidGL',
      snapshot: 'body',
      resolution: 2,
      refraction: getRefractionValue(),
      bevelDepth: 0.119,
      bevelWidth: 0.057,
      frost: 0,
      specular: true,
      shadow: true,
      reveal: 'fade',
      tilt: false,
      tiltFactor: 10,
      magnify: 1,
      on: {
        init: function (intro) {
          // GSAP ANIMATION OF TARGET ELEMENT
          const preloader = document.querySelector('.preloader');
          
          // Preloader Animation
          if (typeof loadingTl !== 'undefined' && loadingTl) {
            loadingTl.eventCallback('onComplete', () => {
              if (preloader) {
                gsap.to(preloader, {
                  yPercent: -100,
                  duration: 1,
                  ease: 'expo.inOut',
                  onComplete: () => {
                    preloader.style.display = 'none';
                  },
                });
              }
              
              // Target Animation
              gsap.to(intro.el, {
                scaleX: 1,
                duration: 1.2,
                ease: 'expo.out',
                delay: 0.5,
              });
            });
          }
        },
      },
    });

    // Handle responsive refraction on window resize
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        const newRefraction = getRefractionValue();
        if (glassEffect && glassEffect.options) {
          glassEffect.options.refraction = newRefraction;
          // Force update if the library has an update method
          if (typeof glassEffect.update === 'function') {
            glassEffect.update();
          }
        }
      }, 250);
    });

    // 3. REGISTER DYNAMIC ELEMENTS
    liquidGL.registerDynamic(allSplitLines);
    liquidGL.registerDynamic('.banner-text-container');

    console.log('liquidGL ready!', glassEffect);

    // 4. UNIVERSAL SCROLL/ANIMATION SYNC
    liquidGL.syncWith();

    // GUI CONTROLS (DEMO ONLY)
    const lensArr = Array.isArray(glassEffect)
      ? glassEffect
      : [glassEffect];
    const first = lensArr[0];

    if (first) {
      const gui = new lil.GUI();
      const folder = gui.addFolder('liquidGL Effect');

      const sync = (key, value) => {
        lensArr.forEach((ln) => {
          if (!ln) return;
          ln.options[key] = value;
          if (key === 'shadow') ln.setShadow(value);
          if (key === 'tilt') ln.setTilt(value);
        });
      };

      folder
        .add(first.options, 'refraction', 0, 0.1, 0.001)
        .onChange((v) => sync('refraction', v));
      folder
        .add(first.options, 'bevelDepth', 0, 0.2, 0.001)
        .onChange((v) => sync('bevelDepth', v));
      folder
        .add(first.options, 'bevelWidth', 0, 0.5, 0.001)
        .onChange((v) => sync('bevelWidth', v));
      folder
        .add(first.options, 'frost', 0, 10, 0.1)
        .onChange((v) => sync('frost', v));
      folder
        .add(first.options, 'magnify', 1, 5, 0.1)
        .onChange((v) => sync('magnify', v));
      folder
        .add(first.options, 'shadow')
        .onChange((v) => sync('shadow', v));
      folder
        .add(first.options, 'specular')
        .onChange((v) => sync('specular', v));
      folder
        .add(first.options, 'tilt')
        .onChange((v) => sync('tilt', v));
      folder
        .add(first.options, 'tiltFactor', 0, 25, 0.1)
        .onChange((v) => sync('tiltFactor', v));
      folder
        .add(first.options, 'reveal', ['none', 'fade'])
        .onChange((v) => sync('reveal', v));
      folder.close();
    }
  });
});
