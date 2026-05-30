/**
 * Navigation Module
 * Handles global navigation toggle, keyboard controls, and click-outside behavior
 */

document.addEventListener('DOMContentLoaded', () => {
  const navToggle = document.querySelector('.nav-toggle');
  const navContainer = document.querySelector('.nav-container');
  
  if (navToggle && navContainer) {
    // Toggle navigation on button click
    navToggle.addEventListener('click', () => {
      const isExpanded = navContainer.classList.contains('expanded');
      navContainer.classList.toggle('expanded');
      navToggle.setAttribute('aria-expanded', !isExpanded);
    });

    // Close navigation when clicking outside
    document.addEventListener('click', (e) => {
      if (!navContainer.contains(e.target)) {
        navContainer.classList.remove('expanded');
        navToggle.setAttribute('aria-expanded', 'false');
      }
    });

    // Close navigation when pressing Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && navContainer.classList.contains('expanded')) {
        navContainer.classList.remove('expanded');
        navToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }
});
