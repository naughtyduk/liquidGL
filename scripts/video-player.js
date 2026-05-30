/**
 * Video Player Module
 * Handles fullscreen video player controls, play icon animations, and custom controls
 */

document.addEventListener('DOMContentLoaded', () => {
  const videoTrigger = document.querySelector('.video-hover-area');
  const playIcon = document.querySelector('.play-icon');
  const fullscreenPlayer = document.querySelector('.fullscreen-player');
  const closeBtn = document.querySelector('.close-btn');
  const customControls = document.querySelector('.custom-controls');
  const playPauseBtn = document.querySelector('.play-pause-btn');
  const progressBarContainer = document.querySelector('.progress-bar-container');
  const progressBarFill = document.querySelector('.progress-bar-fill');

  // Check if all required elements exist
  if (!videoTrigger || !playIcon || !fullscreenPlayer || !closeBtn || 
      !customControls || !playPauseBtn || !progressBarContainer || !progressBarFill) {
    console.warn('Video player: Missing required elements');
    return;
  }

  const fullscreenVideo = fullscreenPlayer.querySelector('video');
  if (!fullscreenVideo) {
    console.warn('Video player: Video element not found');
    return;
  }

  videoTrigger.style.cursor = 'pointer';

  // Initialize play icon
  gsap.set(playIcon, {
    scale: 0,
    autoAlpha: 0,
    xPercent: -50,
    yPercent: -50,
  });

  // Initialize fullscreen player
  gsap.set(fullscreenPlayer, {
    xPercent: -100,
    visibility: 'hidden',
  });

  let inactivityTimer;

  const hideControls = () => {
    if (!fullscreenVideo.paused) {
      fullscreenPlayer.classList.add('inactive');
    }
  };

  const resetInactivityTimer = () => {
    fullscreenPlayer.classList.remove('inactive');
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(hideControls, 3000);
  };

  fullscreenPlayer.addEventListener('mousemove', resetInactivityTimer);
  fullscreenPlayer.addEventListener('touchstart', resetInactivityTimer);

  const togglePlayPause = () => {
    if (fullscreenVideo.paused) {
      fullscreenVideo.play();
      playPauseBtn.classList.add('playing');
      playPauseBtn.setAttribute('aria-label', 'Pause video');
      resetInactivityTimer();
    } else {
      fullscreenVideo.pause();
      playPauseBtn.classList.remove('playing');
      playPauseBtn.setAttribute('aria-label', 'Play video');
      clearTimeout(inactivityTimer);
    }
  };

  playPauseBtn.addEventListener('click', togglePlayPause);
  fullscreenVideo.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === fullscreenVideo) {
      togglePlayPause();
    }
  });

  fullscreenVideo.addEventListener('timeupdate', () => {
    const progress =
      (fullscreenVideo.currentTime / fullscreenVideo.duration) * 100;
    gsap.to(progressBarFill, {
      width: `${progress}%`,
      duration: 0.1,
      ease: 'linear',
    });
  });

  progressBarContainer.addEventListener('click', (e) => {
    const rect = progressBarContainer.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const width = rect.width;
    const newTime = (clickX / width) * fullscreenVideo.duration;
    fullscreenVideo.currentTime = newTime;
  });

  fullscreenVideo.addEventListener('ended', () => {
    playPauseBtn.classList.remove('playing');
    playPauseBtn.setAttribute('aria-label', 'Play video');
    fullscreenPlayer.classList.remove('inactive');
    clearTimeout(inactivityTimer);
  });

  videoTrigger.addEventListener('mouseenter', (e) => {
    gsap.set(playIcon, { x: e.clientX, y: e.clientY });
    gsap.to(playIcon, { autoAlpha: 1, scale: 1, duration: 0.3 });
  });

  videoTrigger.addEventListener('mouseleave', () => {
    gsap.to(playIcon, { autoAlpha: 0, scale: 0, duration: 0.3 });
  });

  videoTrigger.addEventListener('mousemove', (e) => {
    gsap.to(playIcon, {
      x: e.clientX,
      y: e.clientY,
      duration: 0.4,
      ease: 'power3.out',
    });
  });

  videoTrigger.addEventListener('click', () => {
    gsap.to(fullscreenPlayer, {
      xPercent: 0,
      visibility: 'visible',
      duration: 0.8,
      ease: 'expo.inOut',
      onComplete: () => {
        fullscreenVideo.play();
        playPauseBtn.classList.add('playing');
        playPauseBtn.setAttribute('aria-label', 'Pause video');
        resetInactivityTimer();
      },
    });
  });

  const closePlayer = () => {
    gsap.to(fullscreenVideo, {
      volume: 0,
      duration: 0.5,
      ease: 'linear',
      onComplete: () => {
        fullscreenVideo.pause();
        gsap.to(fullscreenPlayer, {
          xPercent: -100,
          duration: 0.8,
          ease: 'expo.inOut',
          onComplete: () => {
            gsap.set(fullscreenPlayer, { visibility: 'hidden' });
            fullscreenVideo.currentTime = 0;
            fullscreenVideo.volume = 1; // Reset for next time
            playPauseBtn.classList.remove('playing');
            playPauseBtn.setAttribute('aria-label', 'Play video');
            gsap.set(progressBarFill, { width: '0%' });
          },
        });
      },
    });
  };

  closeBtn.addEventListener('click', closePlayer);
  closeBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      closePlayer();
    }
  });
});
