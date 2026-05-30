/**
 * Preloader Module
 * Handles the loading animation and progress bar
 * Exports: loadingTl (GSAP timeline)
 */

// Global variable to be accessed by liquidGL initialization
let loadingTl;

document.addEventListener('DOMContentLoaded', () => {
  const preloader = document.querySelector('.preloader');
  const preloaderProgress = document.querySelector('.preloader-progress');

  if (!preloader || !preloaderProgress) {
    console.warn('Preloader: Missing required elements');
    return;
  }

  let progress = { value: 0 };
  loadingTl = gsap.timeline();
  
  loadingTl.to(progress, {
    value: 100,
    duration: 1.5,
    ease: 'power1.inOut',
    onUpdate: () => {
      gsap.set(preloaderProgress, { width: `${progress.value}%` });
    },
  });
});
